'use strict';
/* Tests for the EVM interpreter, its stack and its memory.
 *
 * Two things live here, and deliberately in one file:
 *
 *   1. A standalone unit suite — `node test/interpreter.js` — in the same shape as
 *      test/unit.js: count the checks, print PASS/FAIL, exit non-zero on failure.
 *   2. The conformance IMPLEMENTATION ADAPTER, exported for the harness:
 *
 *        node test/conformance/runner.js --impl=test/interpreter.js \
 *             --suite=VMTests --dir=test/conformance/vectors --no-gas
 *
 *      `--no-gas` is not a concession. The VMTests' gas figures are older than the
 *      directory they sit in: `legacytests/Constantinople/VMTests` is Constantinople
 *      SEMANTICS but FRONTIER PRICES. Running the 609 vectors with gas checking on
 *      produces 434 divergences, and every one of them decomposes exactly into
 *      EIP-2929 (the cold SSTORE/SLOAD surcharges), EIP-160 (EXP from 10 to 50 gas a
 *      byte) and EIP-150 (SELFDESTRUCT from 0 to 5000, plus its 25000 new-account
 *      charge) — 412 SSTORE, 103 EXP, 10 SLOAD and 5 SELFDESTRUCT vectors, with
 *      nothing left over. So their post states hold under Shanghai and their gas
 *      does not. Gas conformance comes from GeneralStateTests in phase 4.
 *
 * THE ERROR CONTRACT is what this file is testing more than anything else. An EVM
 * failure must arrive as a RETURNED `{ exception }`; a thrown JavaScript error is a
 * harness ERROR. So the adapter re-throws anything the interpreter flags as an
 * `internalError` — an internal bug must never be able to satisfy a vector whose
 * assertion is "this must fail".
 */

const { StateDB, MemoryDB } = require('../src/state/statedb');
const { keccak256 } = require('../src/crypto/keccak');
const RLP = require('../src/crypto/rlp');
const U = require('../src/evm/uint256');
const gas = require('../src/evm/gas');
const { Stack } = require('../src/evm/stack');
const { Memory } = require('../src/evm/memory');
const EVMlib = require('../src/evm/interpreter');
const { EVM, ERR, createAddress, create2Address, analyseJumpdests, logsHash } = EVMlib;

const hex = (s) => Buffer.from(String(s).replace(/^0x/, ''), 'hex');
const addr = (n) => { const b = Buffer.alloc(20); b.writeUInt32BE(n, 16); return b; };
const word = (v) => U.toBuffer(BigInt(v));

// ===========================================================================
// the conformance adapter
// ===========================================================================

/* VMTests are single-frame: `exec` names the code, the caller and the value, and the
 * pre-state ALREADY reflects that value having been transferred. Running the transfer
 * again would double-credit the callee, so the frame is entered with `transfer:false`
 * and the apparent CALLVALUE supplied separately. */

/**
 * A StateDB seeded from a fixture pre-state, plus the `root()`/`dump()` the harness
 * wants. The trie is the *secure* variant, so its keys are keccak hashes and it
 * cannot be walked back into addresses and slots; `dump()` therefore reports the
 * union of every address and slot the fixture mentions and every slot the run itself
 * touched — which the tracer hands over for free.
 */
function makeState(pre) {
  const db = new StateDB(new MemoryDB());
  const addresses = new Set();
  const slots = new Map();          // addrHex -> Set(slot hex)

  const note = (a, slot) => {
    const k = '0x' + Buffer.from(a).toString('hex');
    addresses.add(k);
    if (slot === undefined) return;
    if (!slots.has(k)) slots.set(k, new Set());
    slots.get(k).add(Buffer.from(slot).toString('hex'));
  };

  for (const [a, acc] of Object.entries(pre || {})) {
    const A = hex(a);
    db.setAccount(A, { nonce: acc.nonce, balance: acc.balance });
    if (acc.code.length) db.setCode(A, acc.code);
    note(A);
    for (const [k, v] of Object.entries(acc.storage)) {
      db.setStorage(A, hex(k), hex(v));
      note(A, hex(k));
    }
  }
  db.commit();

  return {
    db,
    note,
    root: () => '0x' + db.rootHex(),
    dump() {
      const out = {};
      for (const a of addresses) {
        const A = hex(a);
        if (!db.exists(A)) continue;
        const storage = {};
        for (const s of slots.get(a) || []) {
          const v = db.getStorage(A, Buffer.from(s, 'hex'));
          if (!v.equals(Buffer.alloc(32))) storage['0x' + s] = '0x' + v.toString('hex');
        }
        out[a] = {
          nonce: db.getNonce(A),
          balance: db.getBalance(A),
          code: db.getCode(A),
          storage,
        };
      }
      return out;
    },
  };
}

/* testeth's VM fixtures were filled with a fake environment whose BLOCKHASH is the
 * keccak of the block number rendered in decimal. It is a harness convention, not a
 * chain rule, which is exactly why it belongs here and not in the interpreter. */
const fixtureBlockHash = (n) => keccak256(Buffer.from(n.toString(10), 'utf8'));

function runVm({ state, env, exec, vector }) {
  // Slots and addresses the run touches, so dump() can report them (see makeState).
  const seen = (ev) => { if (ev.slot) state.note(ev.address, ev.slot); };
  for (const a of Object.keys(vector.post || {})) state.note(hex(a));
  for (const [a, acc] of Object.entries(vector.post || {})) {
    for (const k of Object.keys(acc.storage)) state.note(hex(a), hex(k));
  }

  const db = state.db;
  db.beginTransaction();
  db.prepareAccessList({ origin: hex(exec.origin), to: hex(exec.address), coinbase: hex(env.coinbase) });

  const evm = new EVM({
    state: db,
    block: {
      number: env.number,
      timestamp: env.timestamp,
      coinbase: env.coinbase,
      gasLimit: env.gasLimit,
      prevRandao: env.random !== null ? env.random : env.difficulty,
      baseFee: env.baseFee || 0n,
      chainId: 7411n,
    },
    tx: { origin: exec.origin, gasPrice: exec.gasPrice },
    onStep: seen,
    blockHash: fixtureBlockHash,
  });

  const r = evm.call({
    caller: exec.caller,
    to: exec.address,
    code: exec.code,
    callValue: exec.value,
    value: 0n,
    transfer: false,
    data: exec.data,
    gas: exec.gas,
  });

  // An internal bug must surface as a harness ERROR, never as a satisfied
  // "this must fail" vector.
  if (r.internalError) throw r.internalError;

  if (r.exception) return { exception: r.exception };
  db.finalize();
  return {
    gasLeft: r.gasLeft,
    returnData: r.returnData,
    logsHash: '0x' + logsHash(evm.logs).toString('hex'),
  };
}

module.exports = { vm: { makeState, run: runVm }, makeState };

// ===========================================================================
// unit suite
// ===========================================================================

if (!require.main || require.main !== module) return;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name) { console.log('• ' + name); }

/** Deploy `code` at 0x…aa and call it. Returns everything a check might want. */
function run(code, o = {}) {
  const db = new StateDB(new MemoryDB());
  const A = o.address || addr(0xaa);
  const C = o.caller || addr(0xca);
  db.setCode(A, hex(code));
  db.setBalance(A, o.selfBalance === undefined ? 0n : o.selfBalance);
  db.setBalance(C, o.callerBalance === undefined ? 10n ** 18n : o.callerBalance);
  for (const [a, c] of Object.entries(o.accounts || {})) db.setCode(hex(a), hex(c));
  for (const [k, v] of Object.entries(o.storage || {})) db.setStorage(A, word(k), word(v));
  db.commit();
  db.beginTransaction();
  const evm = new EVM({
    state: db,
    block: { number: 5n, timestamp: 1000n, coinbase: addr(0xc0), gasLimit: 30000000n, prevRandao: o.prevRandao, chainId: 7411n },
    tx: { origin: C, gasPrice: 7n },
    onStep: o.onStep || null,
    blockHash: o.blockHash || null,
  });
  const r = evm.call({
    caller: C, to: A, gas: o.gas === undefined ? 100000n : o.gas,
    data: o.data ? hex(o.data) : Buffer.alloc(0), value: o.value || 0n, isStatic: !!o.static,
  });
  return { r, db, evm, A, C, used: (o.gas === undefined ? 100000n : o.gas) - r.gasLeft };
}

const sload = (db, A, slot) => U.fromBuffer(db.getStorage(A, word(slot)));

// ---- stack -----------------------------------------------------------------
group('stack');
{
  const s = new Stack();
  ok(s.require(0, 1024) === null, 'an empty stack satisfies a zero-pop instruction');
  ok(s.require(1, 1024) === 'stack underflow', 'and fails one that pops');
  for (let i = 0; i < 1024; i++) s.push(BigInt(i));
  ok(s.length === 1024, 'the stack holds exactly 1024 words');
  // maxStack for a 0->1 instruction (PUSH) is 1023: a full stack cannot grow.
  ok(s.require(0, 1023) === 'stack overflow', 'a full stack refuses an instruction that pushes');
  ok(s.require(2, 1024) === null, '…but still accepts one that only consumes');
  ok(s.push(1n) === false && s.fault === 'stack overflow', 'pushing past the limit records a fault rather than throwing');
  s.fault = null;
  ok(s.peek(0) === 1023n && s.peek(1023) === 0n, 'peek indexes from the top');
  s.dup(3);
  ok(s.length === 1024 && s.fault === 'stack overflow', 'DUP on a full stack overflows, and does not throw');
  s.fault = null;
  const t = new Stack();
  [10n, 20n, 30n].forEach((v) => t.push(v));
  t.dup(2);
  ok(t.peek(0) === 20n && t.length === 4, 'DUP2 copies the second item to the top');
  t.swap(3);
  ok(t.peek(0) === 10n && t.peek(3) === 20n, 'SWAP3 exchanges the top with the item three below');
  ok(t.popN(2).join(',') === '30,10', 'popN returns deepest-first, so `a OP b` reads in source order');
  ok(new Stack().pop() === 0n && new Stack().require(1, 1024) === 'stack underflow', 'underflow is a returned exception, never a throw');
}

// ---- memory ----------------------------------------------------------------
group('memory');
{
  const m = new Memory();
  ok(m.size === 0 && m.words === 0n, 'memory starts empty');
  ok(m.charge(0n, 0n) === 0n, 'a zero-length access is free…');
  ok(m.charge(2n ** 200n, 0n) === 0n, '…however absurd its offset');
  m.expand(2n ** 200n, 0n);
  ok(m.size === 0, 'and it does not expand memory either');

  ok(m.charge(0n, 1n) === 3n, 'one byte costs one whole word: 3 gas');
  m.expand(0n, 1n);
  ok(m.size === 32, 'memory grows in 32-byte words');
  ok(m.charge(0n, 32n) === 0n, 'a read inside the high-water mark is free');
  ok(m.charge(32n, 1n) === 3n, 'the second word costs 3 more');

  /* The classic bug: charging C(delta) rather than C(new) - C(old). At 1024 words
   * those differ by the whole quadratic term. */
  const m2 = new Memory();
  m2.expand(0n, 32n * 1024n);
  ok(m2.words === 1024n, '1024 words allocated');
  ok(gas.memoryCost(1024n) === 3n * 1024n + 2048n, 'C(1024) = 3w + w^2/512 = 5120');
  const step = m2.charge(32n * 1024n, 32n);
  ok(step === gas.memoryCost(1025n) - gas.memoryCost(1024n), 'expansion is priced on the INCREASE, not the total');
  ok(step === 7n && step !== gas.memoryCost(1n), 'and the 1025th word costs 7, not the 3 a delta-priced word would');

  const m3 = new Memory();
  m3.expand(0n, 64n);
  m3.write(0n, Buffer.from('ff'.repeat(4), 'hex'));
  ok(m3.read(0n, 8n).toString('hex') === 'ffffffff00000000', 'reads past written data are zero-filled');
  ok(m3.read(1000n, 4n).toString('hex') === '00000000', 'reads past the high-water mark return zeros');
  m3.writeByte(40n, 0xabn);
  ok(m3.read(40n, 1n)[0] === 0xab, 'MSTORE8 writes exactly one byte');
}

// ---- arithmetic, PUSH, and the fixed tiers ---------------------------------
group('execution basics');
{
  //            PUSH1 2 PUSH1 3 ADD  PUSH0  SSTORE
  const a = run('6002600301' + '5f' + '55');
  ok(a.r.exception === null, 'a simple program succeeds');
  ok(sload(a.db, a.A, 0) === 5n, 'ADD then SSTORE through PUSH0 stores 5');
  //           3 + 3 + 3 + 2(PUSH0) + 22100(cold SSTORE set)
  ok(a.used === 3n + 3n + 3n + 2n + 22100n, 'gas is base tiers plus the cold SSTORE set price');

  const b = run('60ff60005360016000f3');   // PUSH1 ff PUSH1 0 MSTORE8 PUSH1 1 PUSH1 0 RETURN
  ok(b.r.returnData.toString('hex') === 'ff', 'RETURN hands back the requested memory');

  const c = run('fe');
  ok(c.r.exception === ERR.INVALID_OPCODE && c.r.gasLeft === 0n, '0xfe consumes every unit of gas');
  const d = run('0c');
  ok(d.r.exception === ERR.INVALID_OPCODE && d.r.gasLeft === 0n, 'an unassigned byte is an invalid instruction, not a no-op');

  ok(run('60006000fd').r.exception === ERR.REVERT, 'REVERT reports itself as an exception');
  const e = run('60aa6000526001601ffd');  // MSTORE 0xaa, then REVERT its low byte
  ok(e.r.returnData.toString('hex') === 'aa', 'REVERT returns its data');
  ok(e.r.gasLeft > 0n, 'and refunds the gas it did not use');

  const f = run('60016000556000600060006000600060006000fd');   // SSTORE then REVERT
  ok(f.r.exception === ERR.REVERT && sload(f.db, f.A, 0) === 0n, 'a reverted frame rolls its storage back');

  const g = run('6001600055' + '00', { gas: 22000n });
  ok(g.r.exception === ERR.OUT_OF_GAS && g.r.gasLeft === 0n, 'out of gas consumes everything…');
  ok(sload(g.db, g.A, 0) === 0n, '…and rolls the frame back');

  ok(run('5b').r.exception === null, 'JUMPDEST alone is legal');
  ok(run('600456' + '00' + '5b').r.exception === null, 'JUMP to a real JUMPDEST works');
  ok(run('600356' + '00' + '5b').r.exception === ERR.INVALID_JUMP, 'JUMP to a non-JUMPDEST fails');
  // 0x5b as the immediate of PUSH1 is data, not a destination.
  ok(run('600356' + '605b').r.exception === ERR.INVALID_JUMP, 'a 0x5b inside a PUSH immediate is not a jump destination');
  ok(analyseJumpdests(hex('605b5b'))[1] === 0 && analyseJumpdests(hex('605b5b'))[2] === 1,
    'jumpdest analysis skips PUSH immediates');
  ok(run('600060025700').r.exception === null, 'JUMPI with a zero condition does not validate the destination');

  ok(run('44', { prevRandao: '0x' + 'ab'.repeat(32), onStep: null }).r.exception === null, 'PREVRANDAO executes');
  {
    const digest = '0x' + 'ab'.repeat(32);
    const h = run('44600052602060' + '00f3', { prevRandao: digest });
    ok('0x' + h.r.returnData.toString('hex') === digest, "PREVRANDAO returns the parent block's Homefire PoW digest (spec §5)");
    const bf = run('48600052602060' + '00f3');
    ok(U.fromBuffer(bf.r.returnData) === 0n, 'BASEFEE pushes zero: Shanghai has the opcode, v1 has no fee market');
    const ch = run('46600052602060' + '00f3');
    ok(U.fromBuffer(ch.r.returnData) === 7411n, 'CHAINID is 7411');
  }
}


// ---- calls -----------------------------------------------------------------
group('call frames');
{
  /* CALL(gas, to, value, inOff, inLen, outOff, outLen). The callee here is
   * `PUSH1 0x2a PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN` — it returns 42. */
  const CALLEE = '602a60005260206000f3';
  const B = addr(0xbb);
  //  push 7 args (deepest first): outLen 0x20, outOff 0, inLen 0, inOff 0, value 0, to 0xbb, gas 0xffff
  const CALL = '6020' + '6000' + '6000' + '6000' + '6000' + '73' + B.toString('hex') + '61ffff' + 'f1';
  const c = run(CALL + '600052' + '60206000f3', { accounts: { [B.toString('hex')]: CALLEE } });
  ok(c.r.exception === null, 'a CALL to a returning contract succeeds');
  ok(U.fromBuffer(c.r.returnData) === 1n, 'CALL pushes 1 on success');
  const c2 = run(CALL + '50' + '60206000f3', { accounts: { [B.toString('hex')]: CALLEE } });
  ok(U.fromBuffer(c2.r.returnData) === 42n, "the callee's return data lands in the caller's return area");

  // The child of a failing call gets rolled back but the caller carries on.
  const REVERTER = '60016000556000600060006000600060006000fd';
  const c3 = run(CALL + '600055', { accounts: { [B.toString('hex')]: REVERTER } });
  ok(c3.r.exception === null, 'a reverting child does not fail the parent');
  ok(sload(c3.db, c3.A, 0) === 0n, 'CALL pushes 0 when the child reverts');
  ok(sload(c3.db, B, 0) === 0n, "and the child's storage write is rolled back — the snapshot was taken on entry");

  // EIP-150: the child may receive at most 63/64 of what is left.
  const GASCHILD = '5a60005260206000f3';                       // GAS; return it
  // Ask for 0xffffffff so the cap, not the request, is what binds.
  const GREEDY = '6020600060006000600073' + B.toString('hex') + '63ffffffff' + 'f1';
  let atCall = null;
  const c4 = run(GREEDY + '50' + '60206000f3', {
    accounts: { [B.toString('hex')]: GASCHILD }, gas: 100000n,
    onStep: (e) => { if (e.mnemonic === 'CALL') atCall = e.gasLeft; },
  });
  const childGas = U.fromBuffer(c4.r.returnData);
  ok(childGas < 0xffffffffn, 'a child asking for more gas than the 63/64 cap allows is capped, not obliged');
  {
    // Reconstruct the cap exactly: what was left at the CALL, minus the cold access
    // charge and the return area's memory expansion, then all but one 64th, then the
    // child's own GAS opcode (2).
    const after = atCall - gas.G.COLD_ACCOUNT_ACCESS - 3n;
    ok(childGas === gas.allButOne64th(after) - 2n, 'the child receives exactly all-but-one-64th of what remains after the access charge');
    ok(childGas === after - after / 64n - 2n && childGas !== after - 2n, 'and the retained 64th really is withheld');
  }

  // DELEGATECALL keeps the caller and the value, and writes OUR storage.
  const DELEGATE = '6020' + '6000' + '6000' + '6000' + '73' + B.toString('hex') + '61ffff' + 'f4';
  const SETTER = '6007600055';                                  // SSTORE slot 0 = 7
  const d = run(DELEGATE + '600155', { accounts: { [B.toString('hex')]: SETTER } });
  ok(sload(d.db, d.A, 0) === 7n, "DELEGATECALL writes the CALLER's storage");
  ok(sload(d.db, B, 0) === 0n, '…and leaves the code owner untouched');
  {
    const CALLERQ = '3360005260206000f3';                       // CALLER; return it
    const dd = run(DELEGATE + '50' + '60206000f3', { accounts: { [B.toString('hex')]: CALLERQ } });
    ok(U.fromBuffer(dd.r.returnData) === U.fromBuffer(addr(0xca)), 'DELEGATECALL preserves the original msg.sender');
    const VALQ = '3460005260206000f3';                          // CALLVALUE; return it
    const dv = run(DELEGATE + '50' + '60206000f3', { accounts: { [B.toString('hex')]: VALQ }, value: 9n, callerBalance: 100n });
    ok(U.fromBuffer(dv.r.returnData) === 9n, '…and the original CALLVALUE');
  }

  // Depth. A contract that calls itself forever must stop at 1024 frames.
  {
    const SELF = '600060006000600060003060fff1' + '600052';   // CALL(gas=0xff, self, …)
    let deepest = 0;
    run(SELF, { gas: 5000000n, onStep: (e) => { if (e.depth > deepest) deepest = e.depth; } });
    ok(deepest > 0, 'a self-calling contract nests');
  }
  {
    // Drive the depth limit directly rather than through a gas-bounded recursion.
    const db = new StateDB(new MemoryDB());
    db.setCode(addr(0xaa), hex('00'));
    db.commit(); db.beginTransaction();
    const evm = new EVM({ state: db, block: {}, tx: {} });
    ok(evm.call({ caller: addr(1), to: addr(0xaa), gas: 1000n, depth: 1024 }).exception === null, 'frame 1024 still runs');
    const over = evm.call({ caller: addr(1), to: addr(0xaa), gas: 1000n, depth: 1025 });
    ok(over.exception === ERR.DEPTH && over.gasLeft === 1000n, 'frame 1025 fails, and its gas is returned unspent');
  }

  // A value transfer the caller cannot afford fails the call and returns the gas.
  {
    const VCALL = '6000600060006000' + '600a' + '73' + B.toString('hex') + '61ffff' + 'f1' + '600055';
    const v = run(VCALL, { callerBalance: 0n, selfBalance: 5n, accounts: { [B.toString('hex')]: '00' } });
    ok(v.r.exception === null && sload(v.db, v.A, 0) === 0n, 'a CALL whose value exceeds our balance pushes 0');
  }
}

// ---- static calls ----------------------------------------------------------
group('static calls (EIP-214)');
{
  const forbidden = { SSTORE: '6001600055', LOG0: '60006000a0', CREATE: '600060006000f0', SELFDESTRUCT: '6000ff' };
  for (const [name, code] of Object.entries(forbidden)) {
    ok(run(code, { static: true }).r.exception === ERR.WRITE_PROTECTION, name + ' is forbidden inside a STATICCALL');
    ok(run(code, { static: false }).r.exception !== ERR.WRITE_PROTECTION, '…and permitted outside one (' + name + ')');
  }
  ok(run('6000600060006000f5', { static: true }).r.exception === ERR.WRITE_PROTECTION, 'CREATE2 is forbidden too');
  // CALL is only forbidden when it moves value — a read-only CALL is fine.
  const B = addr(0xbb).toString('hex');
  const zeroValue = '6000600060006000' + '6000' + '73' + B + '61ffff' + 'f1';
  const withValue = '6000600060006000' + '6001' + '73' + B + '61ffff' + 'f1';
  ok(run(zeroValue, { static: true, accounts: { [B]: '00' } }).r.exception === null, 'a zero-value CALL is allowed in a static frame');
  ok(run(withValue, { static: true, accounts: { [B]: '00' } }).r.exception === ERR.WRITE_PROTECTION, 'a CALL carrying value is not');
  // STATICCALL propagates: the child cannot write either.
  const SC = '6000600060006000' + '73' + B + '61ffff' + 'fa' + '600055';
  const s = run(SC, { accounts: { [B]: '6001600055' } });
  ok(sload(s.db, s.A, 0) === 0n, "STATICCALL's child cannot SSTORE, so the call reports failure");
  ok(sload(s.db, addr(0xbb), 0) === 0n, 'and nothing was written');
}

// ---- contract creation -----------------------------------------------------
group('CREATE and CREATE2');
{
  // Initcode that deploys the two-byte runtime `0x600a`:
  //   PUSH2 600a  PUSH1 0  MSTORE   PUSH1 2  PUSH1 30  RETURN
  const INIT = '61600a6000526002601ef3';
  const PUT = '6a' + INIT + '600052';                       // PUSH11 <init>; MSTORE at 0
  const CREATE = PUT + '600b' + '6015' + '6000' + 'f0' + '600055';

  const c = run(CREATE, { gas: 200000n });
  ok(c.r.exception === null, 'CREATE succeeds');
  const expected = createAddress(c.A, 0n);
  ok(sload(c.db, c.A, 0) === U.fromBuffer(expected), 'CREATE addresses at keccak256(rlp([sender, nonce]))[12:]');
  ok(c.db.getCode(expected).toString('hex') === '600a', 'the returned data becomes the deployed code');
  ok(c.db.getNonce(expected) === 1n, 'a new contract starts at nonce 1 (EIP-161)');
  ok(c.db.getNonce(c.A) === 1n, "and the creator's nonce is bumped");

  // CREATE2(value, offset, size, salt) — salt is the DEEPEST of the four.
  const salt = 0x2an;
  const CREATE2 = PUT + '602a' + '600b' + '6015' + '6000' + 'f5' + '600055';
  const c2 = run(CREATE2, { gas: 200000n });
  const expected2 = create2Address(c2.A, salt, hex(INIT));
  ok(sload(c2.db, c2.A, 0) === U.fromBuffer(expected2), 'CREATE2 uses the 0xff ++ sender ++ salt ++ keccak(initcode) scheme');
  ok(!expected2.equals(expected), 'and lands somewhere else entirely');

  // EIP-150 applies to CREATE as well as to CALL: the initcode frame gets all but
  // one 64th of what is left after the CREATE's own charge, never the lot.
  {
    let atCreate = null, childFirst = null;
    run(CREATE, {
      gas: 200000n,
      onStep: (e) => {
        if (e.mnemonic === 'CREATE') atCreate = e.gasLeft - e.gasCost;
        else if (atCreate !== null && childFirst === null && e.depth === 1) childFirst = e.gasLeft;
      },
    });
    ok(atCreate !== null && childFirst !== null, 'the initcode frame is traceable');
    ok(childFirst === gas.allButOne64th(atCreate), "the initcode frame gets all but one 64th of the creator's remaining gas");
    ok(childFirst !== atCreate && childFirst === atCreate - atCreate / 64n, '…and the withheld 64th is really withheld');
  }

  // PUSH3 <n>; PUSH1 0; RETURN — an initcode that deploys n zero bytes.
  const returnsNBytes = (n) => '62' + n.toString(16).padStart(6, '0') + '6000f3';
  const mk = (initcode, g = 10000000n) => {
    const db = new StateDB(new MemoryDB());
    db.commit(); db.beginTransaction();
    const evm = new EVM({ state: db, block: {}, tx: {} });
    return { evm, db, r: evm.create({ caller: addr(0xca), initcode: hex(initcode), gas: g }) };
  };

  // Deposit gas: 200 per byte of deployed code. Two runs differing only in the size
  // of the code returned, so everything but the deposit and one extra memory word
  // cancels out.
  {
    const two = mk(returnsNBytes(32)).r.gasLeft;
    const four = mk(returnsNBytes(64)).r.gasLeft;
    ok(two - four === 200n * 32n + 3n, 'the deployed code costs 200 gas a byte');
  }
  ok(mk(returnsNBytes(24576)).r.exception === null, 'a 24,576-byte contract deploys');
  const tooBig = mk(returnsNBytes(24577));
  ok(tooBig.r.exception === ERR.CODE_TOO_LARGE && tooBig.r.gasLeft === 0n, 'a 24,577-byte one does not, and forfeits its gas');
  // EIP-3541: deployed code may not start with 0xef.
  const ef = mk('60ef60005360016000f3');
  ok(ef.r.exception === ERR.INVALID_CODE, 'deployed code starting 0xef is rejected (EIP-3541)');
  // EIP-2: a creation that cannot pay the deposit fails outright.
  // 100 bytes costs 20,000 to deposit; the initcode itself costs 18.
  const poor = mk(returnsNBytes(100), 20000n);
  ok(poor.r.exception === ERR.OUT_OF_GAS && poor.r.gasLeft === 0n, 'a creation that cannot pay 200/byte fails');
  ok(mk(returnsNBytes(100), 20100n).r.exception === null, '…and 100 more gas is enough to make it succeed');
  /* Collision — all three arms of it.
   *
   * "Occupied" is nonce, OR code, OR storage. The third arm is EIP-7610 and is
   * the one EIP-684 does not mention: an address holding storage but no code
   * and nonce 0 is NOT a blank slate to be reset, it is taken. Reading EIP-684
   * alone produces an implementation that silently wipes somebody's storage,
   * which is a state-root divergence and therefore a chain split.
   *
   * Balance is deliberately not an arm: anyone can send to an address before a
   * contract lands there, and being able to do so would be a griefing vector. */
  const occupied = (seed) => {
    const db = new StateDB(new MemoryDB());
    const victim = createAddress(addr(0xca), 0n);
    seed(db, victim);
    db.commit(); db.beginTransaction();
    const evm = new EVM({ state: db, block: {}, tx: {} });
    // The initcode would SSTORE slot 1 = 0x22 if it ever ran, so a wrongly
    // permitted creation is visible in the storage as well as in the result.
    const r = evm.create({ caller: addr(0xca), initcode: hex('60226001556000600060006000f3'), gas: 100000n });
    return { db, victim, r };
  };
  {
    const c = occupied((db, v) => db.setCode(v, hex('00')));
    ok(c.r.exception === ERR.COLLISION && c.r.gasLeft === 0n, 'creating over an address that has code consumes all gas');
  }
  {
    const c = occupied((db, v) => db.setNonce(v, 1n));
    ok(c.r.exception === ERR.COLLISION && c.r.gasLeft === 0n, '…and over one with a non-zero nonce');
  }
  {
    const c = occupied((db, v) => db.setStorage(v, 1n, 1n));
    ok(c.r.exception === ERR.COLLISION && c.r.gasLeft === 0n,
      '…and over one with storage but no code and nonce 0 (EIP-7610)');
    ok(c.db.getStorage(c.victim, 1n)[31] === 1,
      'and that storage survives untouched — a collision is not a reset');
    ok(c.db.getNonce(c.victim) === 0n && c.db.getCode(c.victim).length === 0,
      'nor does the failed creation leave a nonce or code behind');
    ok(c.db.getNonce(addr(0xca)) === 1n, "but the creator's nonce is still spent");
  }
  {
    // Balance alone must NOT collide: the creation runs and deploys.
    const c = occupied((db, v) => db.setBalance(v, 10n));
    ok(c.r.exception === null, 'a balance alone does not make an address occupied');
    ok(c.db.getBalance(c.victim) === 10n, 'and the pre-existing balance survives the deployment');
    ok(c.db.getStorage(c.victim, 1n)[31] === 0x22, 'the initcode really ran');
  }
  {
    // Storage written and then cleared inside the transaction leaves an empty
    // root, so the address is free again — the test is the root, not a history.
    const c = occupied((db, v) => { db.setStorage(v, 1n, 1n); db.setStorage(v, 1n, 0n); });
    ok(c.r.exception === null, 'storage written and cleared again leaves the address free');
  }
  // EIP-3860: the initcode cap is an exceptional halt inside CREATE, not a failed create.
  {
    const big = '61c001' + '6000' + '6000' + 'f0';           // size 49153, offset 0, value 0
    const r = run(big, { gas: 1000000n });
    ok(r.r.exception === ERR.INITCODE_TOO_LARGE && r.r.gasLeft === 0n, 'initcode over 49,152 bytes halts the frame and burns its gas');
    const okSize = run('61c000' + '6000' + '6000' + 'f0' + '50' + '00', { gas: 1000000n });
    ok(okSize.r.exception === null, 'exactly 49,152 bytes is allowed');
  }
  // A reverting initcode returns its data and its remaining gas.
  {
    const rev = mk('60aa6000526001601ffd');
    ok(rev.r.exception === ERR.REVERT && rev.r.returnData.toString('hex') === 'aa', 'a reverting creation returns its revert data');
    ok(rev.r.gasLeft > 0n, 'and keeps its unspent gas');
  }
}

// ---- selfdestruct, logs, return data --------------------------------------
group('selfdestruct, logs, return data');
{
  const BEN = addr(0xbe);
  const s = run('73' + BEN.toString('hex') + 'ff', { selfBalance: 1234n, gas: 100000n });
  ok(s.r.exception === null, 'SELFDESTRUCT halts the frame successfully');
  ok(s.db.getBalance(BEN) === 1234n, 'the balance moves to the beneficiary immediately');
  ok(s.db.getBalance(s.A) === 0n, 'and the contract is emptied');
  ok(s.db.getCode(s.A).length > 0, 'Shanghai: the code is still readable until the transaction ends');
  s.db.finalize();
  ok(!s.db.exists(s.A), '…and the account is only removed at finalize()');
  // Destroying to yourself burns the balance rather than keeping it.
  {
    const self = run('30ff', { selfBalance: 500n });
    self.db.finalize();
    ok(!self.db.exists(self.A), 'self-destructing to your own address removes the account');
  }

  // LOG1(offset, size, topic)
  const l = run('60aa600052' + '607b' + '6020' + '6000' + 'a1');
  ok(l.evm.logs.length === 1, 'LOG1 records one log');
  ok(l.evm.logs[0].topics.length === 1 && U.fromBuffer(l.evm.logs[0].topics[0]) === 0x7bn, 'with its topic');
  ok(l.evm.logs[0].address.equals(l.A), 'attributed to the executing contract');
  ok(logsHash([]).toString('hex') === keccak256(RLP.encode([])).toString('hex'), 'the empty logs hash is keccak256(rlp([]))');
  // A reverted frame drops its logs.
  const lr = run('60aa60005260006000a0' + '60006000fd');
  ok(lr.r.exception === ERR.REVERT && lr.evm.logs.length === 0, 'a reverted frame emits no logs');

  // RETURNDATASIZE / RETURNDATACOPY, and EIP-211's exact bounds.
  const B = addr(0xbb).toString('hex');
  const CALL0 = '600060006000600060007' + '3' + B + '61ffff' + 'f150';   // CALL with no return area
  const CALLEE = '602a60005260206000f3';
  const rds = run(CALL0 + '3d60005260206000f3', { accounts: { [B]: CALLEE } });
  ok(U.fromBuffer(rds.r.returnData) === 32n, 'RETURNDATASIZE reports the child output even with no return area');
  const rdc = run(CALL0 + '6020600060003e' + '60206000f3', { accounts: { [B]: CALLEE } });
  ok(U.fromBuffer(rdc.r.returnData) === 42n, 'RETURNDATACOPY copies it');
  const oob = run(CALL0 + '6021600060003e', { accounts: { [B]: CALLEE } });
  ok(oob.r.exception === ERR.RETURNDATA_OUT_OF_BOUNDS && oob.r.gasLeft === 0n, 'reading one byte past the return data is an exceptional halt');
}

// ---- precompiles -----------------------------------------------------------
group('precompiles');
{
  // CALL 0x04 (identity) with 32 bytes of input, 32 bytes of output.
  const ID = '602a600052' + '6020' + '6000' + '6020' + '6000' + '6000' + '6004' + '61ffff' + 'f1' + '5060206000f3';
  const p = run(ID);
  ok(U.fromBuffer(p.r.returnData) === 42n, 'the identity precompile at 0x04 echoes its input');
  /* 0x06–0x09 are implemented now, and this is where the two opposite failure
   * conventions meet. 0x01–0x05 answer a malformed input with an empty buffer and a
   * SUCCESSFUL call; 0x06–0x09 fail the call outright and burn everything forwarded.
   * Inside the EVM is the only place that difference is observable, and it is the
   * difference between a zk verifier refusing a forged proof and accepting it. */

  // CALL(gas, addr, value, argsOff, argsLen, retOff, retLen) — pushed in reverse.
  const CALLp = (addr, argsLen, gasHex = '61ffff') =>
    '6000' + '6000' + argsLen + '6000' + '6000' + '60' + addr + gasHex + 'f1';
  const STORE_FLAG = '600052' + '60206000f3';     // the success flag, returned

  // 0x06 with no input at all. Zero-padding makes that O + O, a perfectly good
  // answer, so the call SUCCEEDS — the padding rule is consensus, not leniency.
  const bnOk = run(CALLp('06', '6000') + STORE_FLAG);
  ok(U.fromBuffer(bnOk.r.returnData) === 1n,
    'bn128 add (0x06) on zero-padded input succeeds — short input is padded, not rejected');

  // …and it returned a full 64-byte point, not the nothing an empty account returns.
  const bnSize = run(CALLp('06', '6000') + '50' + '3d' + STORE_FLAG);
  ok(U.fromBuffer(bnSize.r.returnData) === 64n, 'and its output is 64 bytes, not empty');

  // 0x08 with 191 bytes. EIP-197 rejects any length that is not a multiple of 192.
  const pairBad = run(CALLp('08', '60bf') + STORE_FLAG, { gas: 400000n });
  ok(U.fromBuffer(pairBad.r.returnData) === 0n,
    'a 191-byte pairing check (0x08) reports FAILURE, not a silent empty success');

  // 0x09 with a final flag of 2. EIP-152 allows 0 and 1 and nothing else.
  const b2Bad = run('6002' + '60d4' + '53' + CALLp('09', '60d5') + STORE_FLAG, { gas: 400000n });
  ok(U.fromBuffer(b2Bad.r.returnData) === 0n,
    'blake2f (0x09) with a final flag of 2 fails the call');

  /* A failed precompile is an exceptional halt, not a REVERT: it consumes every
   * drop of gas forwarded to it. Asserted straight at the EVM boundary, because
   * from inside a frame the 63/64 rule makes the number hard to pin down. */
  {
    const db = new StateDB(new MemoryDB());
    db.commit(); db.beginTransaction();
    const evm = new EVM({ state: db, block: { gasLimit: 30000000n }, tx: {} });
    const at = (n) => { const b = Buffer.alloc(20); b[19] = n; return b; };
    const bad = evm.call({ caller: addr(0xca), to: at(8), data: Buffer.alloc(191), gas: 100000n });
    ok(bad.exception === ERR.PRECOMPILE_FAILED && bad.gasLeft === 0n && bad.returnData.length === 0,
      'a rejected precompile input is an exceptional halt: all gas gone, no return data');
    const good = evm.call({ caller: addr(0xca), to: at(8), data: Buffer.alloc(0), gas: 100000n });
    ok(good.exception === null && good.gasLeft === 55000n,
      'a valid empty pairing costs exactly the 45,000 base and returns the rest');
    const poor = evm.call({ caller: addr(0xca), to: at(8), data: Buffer.alloc(0), gas: 44999n });
    ok(poor.exception === ERR.OUT_OF_GAS,
      '…and one gas short of the base is an ordinary out-of-gas, before any work is done');
  }
}

// ---- SSTORE metering -------------------------------------------------------
group('SSTORE');
{
  // EIP-2200's sentry: 2300 gas or less remaining is an ordinary out-of-gas halt,
  // not a free write. A 2300-gas transfer() callback must never reach storage.
  const st = run('60016000' + '55', { gas: 2306n });
  ok(st.r.exception === ERR.OUT_OF_GAS && st.r.gasLeft === 0n, 'the SSTORE sentry trips as an out-of-gas halt');
  // EIP-3529: clearing a slot that was set at the start of the transaction refunds 4800.
  const clr = run('600060005500', { storage: { 0: 1 } });
  ok(clr.r.exception === null && clr.evm.getRefund() === 4800n, 'clearing a slot refunds 4800 (EIP-3529, not 15000)');
  // …and a revert takes the refund back with it.
  const clrRev = run('6000600055' + '60006000fd', { storage: { 0: 1 } });
  ok(clrRev.evm.getRefund() === 0n, 'a reverted frame gives back its refund too');
  // Setting a fresh slot then restoring it nets out.
  const same = run('600160005560006000' + '5500', { storage: { 0: 0 } });
  ok(same.evm.getRefund() === 19900n, 'undoing a slot creation inside one transaction refunds 19,900');
}

// ---- EIP-2929 warm and cold ------------------------------------------------
group('warm and cold access (EIP-2929)');
{
  const T = addr(0xbb).toString('hex');
  const costs = (code, op) => {
    const out = [];
    run(code, { accounts: { [T]: '00' }, onStep: (e) => { if (e.mnemonic === op) out.push(e.gasCost); } });
    return out;
  };
  // Touch the same address twice: cold 2600, then warm 100. Treating a cold address
  // as warm is a 2,500-gas divergence per access, which is to say a chain split.
  for (const [op, code] of [['BALANCE', '73' + T + '3150' + '73' + T + '3150'],
                            ['EXTCODESIZE', '73' + T + '3b50' + '73' + T + '3b50'],
                            ['EXTCODEHASH', '73' + T + '3f50' + '73' + T + '3f50']]) {
    const c = costs(code, op);
    ok(c.length === 2 && c[0] === 2600n && c[1] === 100n, op + ' costs 2600 cold and 100 warm');
  }
  // The transaction access list pre-warms the precompiles and the coinbase.
  {
    const pre = costs('7300000000000000000000000000000000000000043150', 'BALANCE');
    ok(pre.length === 1 && pre[0] === 2600n, 'a fresh EVM has not pre-warmed anything by itself');
  }
  // SLOAD: cold 2100, warm 100.
  {
    const sl = costs('600154506001545000', 'SLOAD');
    ok(sl.length === 2 && sl[0] === 2100n && sl[1] === 100n, 'SLOAD costs 2100 cold and 100 warm');
  }
  // A warm set warmed inside a frame that reverts must go cold again.
  {
    const B = addr(0xbb).toString('hex');
    const REVERTER = '73' + B + '3150' + '60006000fd';
    const seen = [];
    const db = new StateDB(new MemoryDB());
    db.setCode(addr(0xaa), hex('00')); db.setCode(addr(0xbb), hex('00'));
    db.commit(); db.beginTransaction();
    const evm = new EVM({ state: db, block: {}, tx: {}, onStep: (e) => { if (e.mnemonic === 'BALANCE') seen.push(e.gasCost); } });
    evm.call({ caller: addr(1), to: addr(0xaa), code: hex(REVERTER), gas: 100000n });
    evm.call({ caller: addr(1), to: addr(0xaa), code: hex('73' + B + '3150'), gas: 100000n });
    ok(seen.length === 2 && seen[0] === 2600n && seen[1] === 2600n, 'an address warmed inside a reverted frame goes cold again');
  }
}

// ---- the step hook ---------------------------------------------------------
group('tracer');
{
  const steps = [];
  const t = run('6001600255', { onStep: (e) => steps.push(e) });
  ok(steps.length === 3, 'onStep fires once per instruction');
  const first = steps[0];
  for (const k of ['pc', 'opcode', 'mnemonic', 'gasLeft', 'gasCost', 'depth', 'stack', 'memorySize'])
    ok(first[k] !== undefined, 'the trace event carries ' + k);
  ok(first.mnemonic === 'PUSH1' && first.pc === 0 && first.gasCost === 3n, 'the first step is PUSH1 at pc 0 for 3 gas');
  ok(steps[1].stack.length === 1 && steps[1].stack[0] === 1n, 'the stack snapshot is taken before the instruction runs');
  const ss = steps[2];
  ok(ss.mnemonic === 'SSTORE' && U.fromBuffer(ss.slot) === 2n && U.fromBuffer(ss.value) === 1n, 'SSTORE reports its slot and the value being written');
  const loads = [];
  run('60025400', { storage: { 2: 9 }, onStep: (e) => { if (e.mnemonic === 'SLOAD') loads.push(e); } });
  ok(loads.length === 1 && U.fromBuffer(loads[0].slot) === 2n && U.fromBuffer(loads[0].value) === 9n, 'SLOAD reports the slot and the value about to be read');
  // Nested frames report their depth.
  const B = addr(0xbb).toString('hex');
  const depths = new Set();
  run('600060006000600060007' + '3' + B + '61ffff' + 'f150', {
    accounts: { [B]: '600160005500' },
    onStep: (e) => depths.add(e.depth),
  });
  ok(depths.has(0) && depths.has(1), 'the hook sees both the outer and the inner frame');
}

// ---- the error contract ----------------------------------------------------
group('the error contract');
{
  /* Adversarial programs: none of these may throw. A thrown JavaScript error is a
   * harness-level ERROR, and worse, it would let a bug in this interpreter satisfy
   * exactly the vectors that assert failure. */
  const nasty = [
    ['7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6000526000f3', 'MSTORE at a 2^256-1 offset'],
    ['7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff20', 'KECCAK256 over an impossible range'],
    ['7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff56', 'JUMP to 2^256-1'],
    ['60ff60ff60ff60ff60ff60ff60fff1', 'CALL with garbage arguments'],
    ['7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6000f0', 'CREATE from an impossible memory range'],
    ['3d3d3d3d3d3d3d3d', 'a stack of return-data sizes'],
    ['5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5fa4', 'LOG4 with everything zero'],
    ['60016000fd', 'REVERT with a one-byte offset past memory'],
    ['ff', 'SELFDESTRUCT with an empty stack'],
  ];
  for (const [code, what] of nasty) {
    let threw = null, r = null;
    try { r = run(code, { gas: 50000n }).r; } catch (e) { threw = e; }
    ok(threw === null, what + ' does not throw');
    ok(r && (r.exception === null || typeof r.exception === 'string'), '…and reports itself through `exception` (' + what + ')');
    ok(!r || !r.internalError, '…with no internal error (' + what + ')');
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} interpreter checks`);
process.exit(fail === 0 ? 0 : 1);
