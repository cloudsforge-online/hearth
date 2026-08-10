'use strict';
/* Booting a node without stopping it — micro-org#349.
 * Run: node test/boot.js
 *
 * WHAT WAS WRONG, MEASURED RATHER THAN ASSERTED. Both nodes replayed their whole
 * on-disk chain inside their constructor, synchronously. On 2026-08-11, at EMBER
 * mainnet height 11,247 and a 16.1 MB blocks.ndjson, that replay took 90.8 s on
 * an M-series laptop — 8.07 ms a block — with the event loop blocked for every
 * millisecond of it. The live seed is slower and busier: `cf-hearth-seed`'s
 * previous cold start replayed 10,577 blocks in 539 s, from the container's
 * StartedAt to its first log line. Nine minutes in which the process answered
 * nothing, logged nothing, and was indistinguishable from a hang — and the cost
 * is linear in a chain that grows ~5,760 blocks a day, so it has no ceiling.
 *
 * WHAT REPLACED IT. Construction no longer replays. `open()` does, awaited by
 * `start()`, handing the loop back every `P.REPLAY_YIELD_MS`; the HTTP ports are
 * bound BEFORE it and refuse everything until it finishes; gossip and mining are
 * started only AFTER it.
 *
 * THE PROPERTY THAT MATTERS MOST IS NOT SPEED. A replay that yields is a replay
 * during which other code runs, so this file's centre of gravity is what a
 * half-replayed node says when asked. The answer must be "not yet" and never a
 * number: every value a half-replayed chain can produce — a height short by
 * thousands, a balance at a state root it left behind hours ago — is internally
 * consistent, plausible and wrong, and a wallet told that a balance is zero does
 * not ask a second time. `refuses while starting` below asks over real HTTP, on
 * both surfaces, from inside the replay, for an account whose balance IS zero at
 * genesis and is not at the tip: the pre-fix answer to that question is 0x0 with
 * a 200 beside it.
 *
 * MUTATION-PROVED, on 2026-08-11. Each of these was broken on purpose and the
 * named test went red, then it was reverted:
 *   - delete the `await new Promise(r => setImmediate(r))` in `_replayAsync`
 *       → "the event loop turns while the chain replays"
 *   - restore `.load()` in EvmNode's constructor
 *       → "construction reads no chain"
 *   - drop the `if (!this.ready)` guard in EvmNode `_rest`
 *       → "REST refuses every route while replaying"
 *   - drop the `if (!this.ready())` guard in jsonrpc/server.js `_serve`
 *       → "eth_getBalance is refused rather than answered as zero"
 *   - attach the `replay-rejected` listener after the replay instead of before
 *       → "a damaged data directory is reported to the operator"
 *   - start the miner before `await this.open()` in `start()`
 *       → "the miner does not run on a half-replayed tip"
 *   - make `abortReplay()` a no-op
 *       → "a node closed mid-replay never becomes ready"
 *   - skip every tenth line in `_replayAsync`
 *       → "open() and load() reach the same chain" (both chains)
 */

/* Mine on the test network, as every suite here that mines does. It shrinks the
 * Homefire pad and walk and NOTHING else: same targets, same `meetsTarget`, same
 * signature check, same replay. Left on `hearth` this file spent 45 s of its
 * 47 s grinding proofs it was not testing.
 * MUST precede the params require: these are resolved at module load. */
process.env.HEARTH_NETWORK = process.env.HEARTH_NETWORK || 'hearth-test';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');

const P = require('../src/params');
const { Blockchain } = require('../src/chain/blockchain');
const { Chain } = require('../src/chain');
const { EvmNode } = require('../src/evmnode');
const POW = require('../src/pow');
const BLOCK = require('../src/block');
const TX = require('../src/tx');
const UC = require('../src/crypto');
const C = require('./evm-common');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const dirs = [];
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-boot-${tag}-`)); dirs.push(d); return d; };

const miner = C.testKey('boot-miner');
const gen = { target: C.EASY_TARGET };

/**
 * A data directory holding `n` mined blocks.
 *
 * The timestamps are laid BACKWARDS from now — `mineOn`'s default walks forward
 * from the parent, which puts a chain of any length past MAX_FUTURE_DRIFT_S and
 * makes it unreplayable — so what is written is a chain that already happened.
 */
function chainOf(n, tag) {
  const dir = tmpdir(tag);
  const chain = new Blockchain({ dataDir: dir, config: gen }).load();
  const t0 = Math.floor(Date.now() / 1000) - (n + 1) * P.TARGET_BLOCK_TIME;
  for (let i = 1; i <= n; i++) {
    const b = C.mineOn(chain, chain.tipId, miner, { timestamp: t0 + i * P.TARGET_BLOCK_TIME });
    const r = chain.addBlock(b);
    if (!r.ok) throw new Error('mine rejected: ' + r.err);
  }
  return {
    dir, tip: chain.tipId, height: chain.height,
    root: chain.stateAtTip().rootHex(),
    balance: chain.stateAtTip().getBalance(miner.address),
  };
}

/**
 * A UTXO data directory holding `n` mined blocks.
 *
 * The retired chain replayed in its constructor too and was fixed the same way,
 * so it is held to the same assertion. Timestamps run backwards from now for the
 * reason given above; the proofs are real, at the shipped GENESIS_TARGET, which
 * is ~256 Homefire evaluations a block and costs a few hundred ms for four.
 */
function utxoChainOf(n) {
  const dir = tmpdir('utxo');
  const chain = new Chain(dir).load();
  const key = UC.generateKeyPair();
  const address = UC.addressFromPub(key.pub);
  const t0 = Math.floor(Date.now() / 1000) - (n + 1) * P.TARGET_BLOCK_TIME;
  for (let h = 1; h <= n; h++) {
    const txs = [TX.coinbase(h, address, 0)];
    const header = {
      version: 1, prevHash: chain.tipId, merkleRoot: UC.merkleRoot(txs.map(t => t.id)),
      height: h, timestamp: t0 + h * P.TARGET_BLOCK_TIME,
      target: chain.nextTarget(), coinbasePub: key.pub, nonce: 0,
    };
    const core = BLOCK.coreHash(header);
    for (let nonce = 0; ; nonce++) {
      const digest = POW.homefireHash(POW.powSeed(core, nonce, header.coinbasePub)).toString('hex');
      if (!POW.meetsTarget(digest, header.target)) continue;
      header.nonce = nonce;
      header.powDigest = digest;
      header.powSig = UC.sign(key.priv, Buffer.from(digest, 'hex'));
      break;
    }
    const r = chain.addBlock({ header, txs });
    if (!r.ok) throw new Error('utxo mine rejected: ' + r.err);
  }
  return dir;
}

/** A port nothing is listening on. */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function request(opts, body) {
  return new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', ...opts }, r => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch { /* left null on purpose */ }
        res({ status: r.statusCode, body: parsed, raw: d });
      });
    });
    q.on('error', rej);
    q.setTimeout(15_000, () => q.destroy(new Error('timeout')));
    q.end(body);
  });
}

const get = (port, p) => request({ port, path: p });
const rpc = (port, method, params) => request(
  { port, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } },
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }));

const listening = server => new Promise(res => {
  if (!server || server.listening) return res();
  server.once('listening', res);
});

(async () => {
  console.log('\nHearth boot — a replay that does not stop the process\n');

  const built = chainOf(24, 'built');
  console.log(`  (a ${built.height}-block data directory, `
    + `${(fs.statSync(path.join(built.dir, 'blocks.ndjson')).size / 1024).toFixed(0)} KB)`);

  // ==========================================================================
  group('construction reads no chain');
  // ==========================================================================
  {
    const node = new EvmNode({ dataDir: built.dir, quiet: true, coinbaseKey: miner, genesis: gen });
    assert(node.chain.height === 0,
      `a constructed node holds genesis and nothing else (height ${node.chain.height})`);
    assert(node.ready === false, 'and says it is not ready, because its chain is not the one on disk');
    await node.open();
    assert(node.chain.height === built.height && node.chain.tipId === built.tip,
      `open() is what reads the chain (height ${node.chain.height})`);
    assert(node.ready === true, 'and readiness follows it');
    node.close();
  }

  // ==========================================================================
  group('open() and load() reach the same chain');
  // ==========================================================================
  {
    /* The whole change rests on this: a replay that yields must produce the
     * chain a replay that does not would have produced. Same directory, both
     * ways, compared on the three things that ARE the chain. */
    const sync = new Blockchain({ dataDir: built.dir, config: gen }).load();
    const async_ = await new Blockchain({ dataDir: built.dir, config: gen }).open();
    assert(async_.height === sync.height, `same height (${async_.height})`);
    assert(async_.tipId === sync.tipId, 'same tip');
    assert(async_.stateAtTip().rootHex() === sync.stateAtTip().rootHex(),
      'and the same state root — the awaits changed nothing about what was executed');
    assert(sync.replayPending === false && async_.replayPending === false,
      'and both end up complete rather than pending');
  }
  {
    // …and on the UTXO chain, which had the same replay in the same place, with
    // a line of damage in the file so both have something to disagree about.
    const dir = utxoChainOf(4);
    fs.appendFileSync(path.join(dir, 'blocks.ndjson'), '{"filler":1}\n');
    const sync = new Chain(dir).load();
    const async_ = await new Chain(dir).open();
    assert(async_.height === sync.height && async_.height === 4,
      `the UTXO chain replays to the same height either way (${async_.height})`);
    assert(async_.tipId === sync.tipId, 'and the same tip');
    assert(async_.supply() === sync.supply() && async_.utxo.size === sync.utxo.size,
      'and the same UTXO set — which on this chain is the state');
  }

  // ==========================================================================
  group('the event loop turns while the chain replays');
  // ==========================================================================
  {
    const chain = new Blockchain({ dataDir: built.dir, config: gen });
    let ticks = 0, heightAtFirstTick = null;
    /* A timer armed BEFORE the replay, for sooner than the replay can finish.
     * Under the old shape it could not run until the replay was over, because
     * there was nowhere for it to run.
     *
     * `yieldEveryMs: 0` yields after every block instead of every 25 ms, so what
     * this asserts does not depend on whether 24 blocks happen to take longer
     * than P.REPLAY_YIELD_MS to read on the machine running it — which on a fast
     * one they do not. The cadence is a number in params.js; the property under
     * test is that control goes back to the loop AT ALL, and that is the same
     * `await new Promise(r => setImmediate(r))` either way. */
    const timer = setTimeout(() => {
      ticks++;
      heightAtFirstTick = chain.height;
    }, 1);
    const t0 = process.hrtime.bigint();
    await chain.open({ yieldEveryMs: 0 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    clearTimeout(timer);
    assert(ticks === 1,
      `a timer armed before the replay ran DURING it (the replay took ${ms.toFixed(0)} ms)`);
    assert(heightAtFirstTick !== null && heightAtFirstTick > 0 && heightAtFirstTick < built.height,
      `and it ran with the chain part-way up, at height ${heightAtFirstTick} of ${built.height}`);
  }

  // ==========================================================================
  group('refuses while starting');
  // ==========================================================================
  {
    /* The assertion the whole ticket turns on, over real HTTP, on both surfaces,
     * asked from inside the replay so there is no race about when it happens.
     * `miner` holds nothing at genesis and 24 block rewards at the tip, so the
     * balance question has a wrong answer available — 0x0 — and something has to
     * refuse to give it. */
    const restPort = await freePort();
    const jsonRpcPort = await freePort();
    const seen = { rest: null, height: null, balance: null, at: null };
    let asked = false;

    const node = new EvmNode({
      dataDir: built.dir, quiet: true, coinbaseKey: miner, genesis: gen,
      rpcPort: restPort, jsonRpcPort, p2pPort: 0,
      // report after every block rather than every 5 s, so the interrogation
      // below happens with the chain part-way up rather than at block zero
      replayYieldMs: 0, replayProgressMs: 0,
      /* Awaited by the replay loop, so the node is provably mid-replay for the
       * whole of this: nothing here can be a race with a replay that finished. */
      onReplayProgress: async (s) => {
        if (asked || !s.blocks) return;
        asked = true;
        seen.at = node.chain.height;
        await listening(node.restServer);
        await listening(node.jsonrpcServer);
        seen.rest = await get(restPort, '/info');
        seen.height = await rpc(jsonRpcPort, 'eth_blockNumber');
        seen.balance = await rpc(jsonRpcPort, 'eth_getBalance', [miner.addressHex, 'latest']);
      },
    });
    const started = node.start();
    await started;

    assert(asked && seen.at > 0 && seen.at < built.height,
      `the node was interrogated part-way through its replay, at height ${seen.at} of ${built.height}`);
    group('  REST refuses every route while replaying');
    assert(seen.rest && seen.rest.status === 503,
      `/info answers 503 rather than a height (${seen.rest && seen.rest.status})`);
    assert(seen.rest && seen.rest.body && seen.rest.body.status === 'starting'
      && seen.rest.body.height === undefined,
      'and the body says it is starting, and carries no height at all');
    group('  eth_getBalance is refused rather than answered as zero');
    assert(seen.height && seen.height.status === 503 && seen.height.body
      && !('result' in seen.height.body) && seen.height.body.error,
      `eth_blockNumber is a JSON-RPC error at 503, not a short height (${seen.height && seen.height.status})`);
    assert(seen.balance && seen.balance.status === 503 && seen.balance.body
      && !('result' in seen.balance.body),
      'and eth_getBalance answers nothing at all rather than 0x0');

    group('  and answers once it has finished');
    const info = await get(restPort, '/info');
    assert(info.status === 200 && info.body.height === built.height,
      `/info now answers 200 at height ${info.body && info.body.height}`);
    const bal = await rpc(jsonRpcPort, 'eth_getBalance', [miner.addressHex, 'latest']);
    assert(bal.status === 200 && BigInt(bal.body.result) === built.balance && built.balance > 0n,
      `and eth_getBalance answers the ${built.balance} wei this account really holds`);
    node.close();
  }

  // ==========================================================================
  group('the miner does not run on a half-replayed tip');
  // ==========================================================================
  {
    /* The sharpest consequence of getting the order wrong. A miner started
     * before the replay builds on a tip thousands of blocks deep, signs it with
     * the coinbase key, and gossips a fork of a live chain. */
    let duringReplay = null;
    const node = new EvmNode({
      dataDir: built.dir, quiet: true, coinbaseKey: miner, genesis: gen,
      rpcPort: 0, jsonRpcPort: 0, p2pPort: 0, mine: true,
      replayYieldMs: 0, replayProgressMs: 0,
      onReplayProgress: async (s) => {
        if (duringReplay === null && s.blocks) {
          duringReplay = { mining: node.miner.running, height: node.chain.height };
        }
      },
    });
    await node.start();
    const after = node.miner.running;
    node.close();
    assert(duringReplay && duringReplay.mining === false && duringReplay.height < built.height,
      `the miner is not running while the chain is still being read (height ${duringReplay && duringReplay.height})`);
    assert(after === true, 'and is running once it is');
  }

  // ==========================================================================
  group('a node closed mid-replay never becomes ready');
  // ==========================================================================
  {
    const node = new EvmNode({
      dataDir: built.dir, quiet: true, coinbaseKey: miner, genesis: gen,
      rpcPort: 0, jsonRpcPort: 0, p2pPort: 0, mine: true,
      replayYieldMs: 0, replayProgressMs: 0,
      onReplayProgress: async (s) => { if (s.blocks) node.close(); },
    });
    await node.start();
    assert(node.ready === false, 'a replay stopped part-way leaves the node not ready, for ever');
    assert(node.chain.replayPending === true && node.chain.height > 0
      && node.chain.height < built.height,
      `because the chain it holds is a prefix of the one on disk (height ${node.chain.height} of ${built.height})`);
    assert(node.miner.running === false, 'and start() does not go on to mine on it');
  }

  // ==========================================================================
  group('a damaged data directory is reported to the operator');
  // ==========================================================================
  {
    /* `replay-rejected` has existed all along and could never fire: it was
     * emitted from inside a constructor, before any caller could hold the object
     * to listen for it. test/chain-replay.js says so in a comment. */
    const dir = tmpdir('forged');
    fs.cpSync(built.dir, dir, { recursive: true });
    const f = path.join(dir, 'blocks.ndjson');
    const ls = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const forged = JSON.parse(ls[2]);
    forged.header.stateRoot = 'ab'.repeat(32);
    fs.writeFileSync(f, [...ls.slice(0, 2), JSON.stringify(forged), ...ls.slice(3)].join('\n') + '\n');

    const node = new EvmNode({ dataDir: dir, quiet: true, coinbaseKey: miner, genesis: gen });
    const errors = [];
    node.error = (msg, fields) => errors.push({ msg, fields });
    await node.open();
    assert(errors.some(e => /failed to replay/.test(e.msg)),
      'the node logs that blocks on disk did not replay — a listener that could never fire before');
    assert(node.chain.height < built.height,
      `and the height it loaded is the shorter one that caused it (${node.chain.height})`);
    node.close();
  }

  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
