'use strict';
/* The in-process EVM harness: real signed transactions through the real state
 * transition, with no chain, no consensus and no RPC above it.
 *
 * This was `dex.js`'s private scaffolding until a second suite needed it. There is
 * nothing DEX-specific in here — it is a StateDB, a transaction signer, `applyBlock`
 * as a stand-in for a block, an `eth_call` that rolls back, and an opcode tracer that
 * replays a failed block so a revert can be read at the instruction that caused it.
 *
 * WHAT IT IS FOR. Compiled Solidity that was written with no knowledge of this
 * interpreter, driven through `chain/statetransition.js` against a fresh StateDB. Every
 * layer below consensus takes part: the transaction codec, secp256k1 recovery,
 * intrinsic gas, the interpreter, the gas schedule, the state trie, receipts and the
 * bloom. Nothing above it does.
 *
 * WHAT IT NEEDS. `contracts/out/*.json`, which needs solc, which is the one dependency
 * `contracts/` has and `node/` does not:
 *
 *     pnpm --dir contracts install && pnpm --dir contracts compile
 *
 * Suites built on it are therefore gates run by hand and by CI against a built
 * `contracts/out`, never part of `npm test` — that suite must keep running with zero
 * installed dependencies.
 */

const fs = require('fs');
const path = require('path');

const { StateDB, MemoryDB } = require('../src/state/statedb');
const { EVM } = require('../src/evm/interpreter');
const secp = require('../src/crypto/secp256k1');
const TX = require('../src/chain/transaction');
const ST = require('../src/chain/statetransition');
const receipt = require('../src/chain/receipt');
const abi = require('../src/cli/abi');
const { OPCODES } = require('../src/evm/opcodes');

const hex = (s) => Buffer.from(String(s).replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const word = (n) => { let h = (BigInt(n) & ((1n << 256n) - 1n)).toString(16); if (h.length % 2) h = '0' + h; return Buffer.concat([Buffer.alloc(32 - h.length / 2), Buffer.from(h, 'hex')]); };
const addrWord = (a) => Buffer.concat([Buffer.alloc(12), Buffer.from(a)]);

const GWEI = 1000000000n;
const ETHER = 10n ** 18n;
const GAS_PRICE = GWEI;

/* 2030-01-01, in SECONDS. The header stores milliseconds today and spec §4 says that is
 * a bug precisely because Router02 compares `deadline` against `block.timestamp`; a
 * millisecond clock makes every deadline in the year 57,000 and every `pair._update` see
 * a 1000x-inflated elapsed time. Seconds here. */
const GENESIS_TS = 1893456000n;

const DEFAULT_COINBASE = hex('c0'.repeat(20));

// ===========================================================================
// the artifacts
// ===========================================================================

const OUT = path.join(__dirname, '..', '..', 'contracts', 'out');

function artifact(name) {
  const f = path.join(OUT, name + '.json');
  if (!fs.existsSync(f)) {
    console.error(`\nFAIL — ${f} is missing.\n`);
    console.error('  This suite runs the *compiled* contracts. Build them first:\n');
    console.error('      pnpm --dir contracts install');
    console.error('      pnpm --dir contracts compile\n');
    process.exit(1);
  }
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { abi: a.abi, code: hex(a.bytecode), deployed: hex(a.deployedBytecode), name };
}

// ===========================================================================
// the simulator: signed transactions through applyBlock, no consensus
// ===========================================================================

class Sim {
  /**
   * @param {object} opts
   * @param {object} opts.keys  `{ name: <32-byte private key Buffer> }`. Every `from:`
   *   in this suite is one of these names, so a suite reads as who did what.
   */
  constructor({ keys, coinbase = DEFAULT_COINBASE, genesisTs = GENESIS_TS } = {}) {
    this.KEY = keys;
    this.ADDR = {};
    for (const [k, priv] of Object.entries(keys)) {
      this.ADDR[k] = TX.addressFromPublicKey(secp.publicKeyFromPrivate(priv, false));
    }
    this.coinbase = coinbase;
    this.state = new StateDB(new MemoryDB());
    this.number = 1n;
    this.timestamp = genesisTs;
    this.gas = new Map();
    this.mined = [];
    /** Replaced by `reporter()`; a bare Sim throws rather than swallowing a bad block. */
    this.fatal = (msg) => { throw new Error(msg); };
  }

  env() {
    return {
      number: this.number,
      timestamp: this.timestamp,
      coinbase: this.coinbase,
      gasLimit: ST.BLOCK_GAS_LIMIT,
      prevRandao: 0x1234n,
      baseFee: 0n,
      chainId: TX.CHAIN_ID,
    };
  }

  fund(addr, wei) {
    this.state.setAccount(addr, { nonce: 0n, balance: wei });
    this.state.commit();
  }

  /** Build one signed legacy transaction. `who` is a key name in `this.KEY`. */
  _sign(who, it, nonce) {
    const signed = TX.sign({
      nonce,
      gasPrice: GAS_PRICE,
      gasLimit: it.gas === undefined ? 1000000n : it.gas,
      to: it.to === undefined ? null : it.to,
      value: it.value === undefined ? 0n : it.value,
      data: it.data === undefined ? Buffer.alloc(0) : it.data,
    }, this.KEY[who]);
    return TX.encode(signed);
  }

  /**
   * Apply a "block": raw signed RLP through `applyBlock`, which decodes, recovers each
   * sender and runs the whole transition. Nothing here is pre-validated, so a bad
   * signature or a stale nonce fails the block, which is what we want — the point is to
   * exercise the real path.
   */
  mine(items) {
    const preRoot = this.state.root();
    const nonces = new Map();
    const raws = items.map((it) => {
      const from = this.ADDR[it.from];
      const k = from.toString('hex');
      const n = nonces.has(k) ? nonces.get(k) : this.state.getNonce(from);
      nonces.set(k, n + 1n);
      return this._sign(it.from, it, n);
    });

    const r = ST.applyBlock({ state: this.state, transactions: raws, block: this.env() });
    r.preRoot = preRoot;
    r.raws = raws;
    r.env = this.env();
    this.mined.push(r);

    if (r.ok) {
      for (let i = 0; i < r.results.length; i++) {
        if (items[i].label) this.gas.set(items[i].label, r.results[i].gasUsed);
      }
    }
    this.number += 1n;
    this.timestamp += 15n;
    return r;
  }

  /** One transaction, one block. Returns the single result. */
  send(item) {
    const r = this.mine([item]);
    if (!r.ok) {
      this.fatal(`block rejected: ${r.code} — ${r.error} (${item.label || 'unlabelled'})`, r, 0);
    }
    const res = r.results[0];
    res.block = r;
    res.label = item.label;
    return res;
  }

  /**
   * An `eth_call`: run against live state and roll back. The warm sets are reset (a read
   * charges no gas anybody keeps) and the journal marker puts everything back, so this
   * is invisible to the next transaction.
   */
  rawCall(to, data, from = null, value = 0n) {
    const caller = from === null ? Object.values(this.ADDR)[0] : from;
    const mark = this.state.snapshot();
    this.state.prepareAccessList({ origin: caller, to, coinbase: this.coinbase, precompiles: ST.WARM_PRECOMPILES });
    const evm = new EVM({ state: this.state, block: this.env(), tx: { origin: caller, gasPrice: 0n } });
    const r = evm.call({ caller, to, value, data, gas: 50000000n });
    this.state.revertTo(mark);
    return r;
  }

  /** `read(to, 'getReserves()', [], ['uint112','uint112','uint32'])`. */
  read(to, sig, args = [], outs = [], from = null) {
    const fn = abi.resolveFunction(null, sig);
    const r = this.rawCall(to, abi.encodeCall(fn, args), from);
    if (r.exception) {
      const why = abi.decodeRevert(r.returnData);
      this.fatal(`eth_call ${sig} on ${hx(to)} failed: ${r.exception}${why ? ' — ' + why.text : ''}`);
    }
    if (outs.length === 0) return r.returnData;
    const v = abi.decodeParameters(outs, r.returnData);
    return outs.length === 1 ? v[0] : v;
  }

  /** The revert reason an `eth_call` produces, or null if it did not revert. */
  readRevert(to, sig, args = [], from = null) {
    const fn = abi.resolveFunction(null, sig);
    const r = this.rawCall(to, abi.encodeCall(fn, args), from);
    if (!r.exception) return null;
    const why = abi.decodeRevert(r.returnData);
    return why ? why.text : '';
  }

  /**
   * Replay a failed block's transaction `i` with an opcode-level tracer. The node store
   * is append-only, so the pre-block root is still resolvable and a fresh StateDB over
   * the same store is an exact replay.
   */
  replay(blockResult, index) {
    const db = new StateDB(this.state.db, blockResult.preRoot);
    const steps = [];
    const v = TX.validate(blockResult.raws[index], { chainId: TX.CHAIN_ID });
    if (!v.ok) return { steps, note: `transaction ${index} does not even decode: ${v.code}` };

    // Replay the transactions before this one so the state matches.
    for (let j = 0; j < index; j++) {
      const p = TX.validate(blockResult.raws[j], { chainId: TX.CHAIN_ID });
      if (p.ok) ST.applyTransaction({ state: db, tx: p.tx, sender: p.sender, block: blockResult.env });
    }
    const r = ST.applyTransaction({
      state: db, tx: v.tx, sender: v.sender, block: blockResult.env,
      onStep: (ev) => {
        steps.push({
          pc: ev.pc, op: OPCODES[ev.op].name, gasLeft: ev.gasLeft, gasCost: ev.gasCost,
          depth: ev.depth, addr: hx(ev.address), err: ev.error || null,
          stack: ev.stack.slice(-6).reverse().map((x) => '0x' + x.toString(16)),
        });
      },
    });
    return { steps, result: r };
  }
}

// ===========================================================================
// reporting — the tracer, used for what it was built for
// ===========================================================================

/**
 * Counters, the three assertion shapes every suite here uses, and a `fatal` that
 * disassembles the failure before giving up. Binds itself to `sim.fatal`, so a block the
 * simulator cannot apply reports at the opcode that broke rather than as a stack trace.
 */
function reporter(sim, { trace = false } = {}) {
  const counts = { pass: 0, fail: 0 };

  function ok(cond, msg) { if (cond) { counts.pass++; } else { counts.fail++; console.log('  ✗ ' + msg); } }
  function group(name) { console.log('• ' + name); }

  function fatal(msg, blockResult = null, index = 0) {
    counts.fail++;
    console.log('  ✗ ' + msg);
    if (blockResult && blockResult.raws && trace) {
      const { steps, result, note } = sim.replay(blockResult, index);
      if (note) console.log('    ' + note);
      if (result) {
        const why = abi.decodeRevert(result.returnData || Buffer.alloc(0));
        console.log(`    exception=${result.exception} gasUsed=${result.gasUsed}${why ? ' revert=' + why.text : ''}`);
      }
      console.log(`    last ${Math.min(60, steps.length)} of ${steps.length} steps:`);
      for (const s of steps.slice(-60)) {
        console.log(`      d${s.depth} ${String(s.pc).padStart(5)} ${s.op.padEnd(12)} gas=${s.gasLeft} cost=${s.gasCost} ${s.addr.slice(0, 10)} [${s.stack.join(' ')}]${s.err ? '  ERR ' + s.err : ''}`);
      }
    } else if (blockResult && blockResult.raws) {
      console.log('    (re-run with --trace for the opcode trace)');
    }
    console.log(`\nFAIL — ${counts.pass}/${counts.pass + counts.fail} checks (stopped early)`);
    process.exit(1);
  }

  /** A transaction that must have been included AND succeeded. */
  function succeeded(res, what) {
    if (res.exception) {
      const why = abi.decodeRevert(res.returnData || Buffer.alloc(0));
      fatal(`${what} reverted: ${res.exception}${why ? ' — ' + why.text : ''}${res.internalError ? '  INTERNAL ERROR: ' + res.internalError : ''}`,
        res.block, res.index === undefined ? 0 : res.index);
    }
    ok(res.status === receipt.SUCCESS, `${what} succeeds`);
    return res;
  }

  /** A transaction that must have been included and REVERTED, with `why` in the reason. */
  function reverted(res, why, what) {
    const reason = abi.decodeRevert(res.returnData || Buffer.alloc(0));
    ok(res.status !== receipt.SUCCESS, `${what} does not succeed`);
    ok(reason !== null && reason.text.includes(why),
      `${what} reverts with "${why}" (got ${reason ? '"' + reason.text + '"' : 'no reason'})`);
    return res;
  }

  sim.fatal = fatal;
  return { counts, ok, group, fatal, succeeded, reverted };
}

module.exports = {
  Sim, reporter, artifact, OUT,
  hex, hx, word, addrWord,
  GWEI, ETHER, GAS_PRICE, GENESIS_TS, DEFAULT_COINBASE,
  abi, TX, ST, receipt, EVM, StateDB, MemoryDB, secp, OPCODES,
};
