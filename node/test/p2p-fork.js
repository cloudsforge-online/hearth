'use strict';
/* Networked fork-sync test: two real Nodes, real TCP sockets, real RPC servers.
 * Partition them, mine competing branches, reconnect, and require that the
 * lighter node reorgs onto the heavier remote tip and that the UTXO set follows.
 * The in-process e2e test cannot catch this: p2p never runs there.
 * Run: node test/p2p-fork.js */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Node } = require('../src/node');
const POW = require('../src/pow');
const BLOCK = require('../src/block');
const C = require('../src/crypto');
const P = require('../src/params');
const TX = require('../src/tx');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}

const tmpdir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `hearth-p2p-${tag}-`));
// Rejects rather than waiting forever: a server that never binds used to leave the
// whole run idle on four open sockets until someone noticed, and a gate that hangs
// instead of failing is a gate that gets muted.
const bound = (server, what) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${what} never bound`)), 10000);
  server.once('listening', () => { clearTimeout(t); res(server.address().port); });
  server.once('error', e => { clearTimeout(t); rej(new Error(`${what} failed to bind: ${e.message}`)); });
});

function wait(fn, ms = 20000) {
  return new Promise(res => {
    const t0 = Date.now();
    (function tick() {
      if (fn()) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(tick, 20);
    })();
  });
}

// brute-force a block onto `parentId` paying `key`, and add it locally
function mine(node, parentId, key) {
  const parent = node.chain.store.get(parentId);
  const height = parent.height + 1;
  const txs = [TX.coinbase(height, key.address, 0)];
  const header = {
    version: 1, prevHash: parentId, merkleRoot: C.merkleRoot(txs.map(t => t.id)), height,
    // pace at the target block time: LWMA then holds difficulty near the genesis
    // target instead of ramping to MIN_TARGET, which keeps this test seconds not minutes
    timestamp: Math.max(Math.floor(Date.now() / 1000), parent.block.header.timestamp + P.TARGET_BLOCK_TIME),
    target: node.chain._nextTarget(parentId), coinbasePub: key.pub, nonce: 0,
  };
  const core = BLOCK.coreHash(header);
  for (;;) {
    const n = header.nonce++;
    const d = POW.homefireHash(POW.powSeed(core, n, header.coinbasePub)).toString('hex');
    if (POW.meetsTarget(d, header.target)) {
      header.nonce = n; header.powDigest = d;
      header.powSig = C.sign(key.priv, Buffer.from(d, 'hex'));
      break;
    }
  }
  const block = { header, txs };
  const r = node.chain.addBlock(block);
  if (!r.ok) throw new Error('mine rejected: ' + r.err);
  return block;
}

(async () => {
  const dirA = tmpdir('a'), dirB = tmpdir('b');
  // fast re-sync tick so the periodic pull is observable inside a test run
  const A = new Node({ dataDir: dirA, quiet: true, resyncMs: 250 });
  const B = new Node({ dataDir: dirB, quiet: true, resyncMs: 250 });
  const keyA = A.wallet.keys[0], keyB = B.wallet.keys[0];

  console.log('\nHearth p2p fork-sync test\n');

  A.p2p.listen(0); B.p2p.listen(0); A.rpc.listen(0); B.rpc.listen(0);
  const ready = [
    bound(A.p2p.server, 'A p2p'), bound(B.p2p.server, 'B p2p'),
    bound(A.rpc.server, 'A rpc'), bound(B.rpc.server, 'B rpc'),
  ];
  const [, portB, rpcA] = await Promise.all(ready);

  const info = await (await fetch(`http://127.0.0.1:${rpcA}/info`)).json();
  assert(info.network === P.NETWORK && info.height === 0, 'rpc server is actually listening and serves /info');

  // ---- 1. connected: normal gossip builds a shared prefix -------------------
  A.p2p.connect('127.0.0.1:' + portB);
  assert(await wait(() => A.p2p.peers.size === 1 && B.p2p.peers.size === 1, 5000), 'two nodes connected over real sockets');

  for (let i = 0; i < 5; i++) A.p2p.broadcast({ t: 'block', block: mine(A, A.chain.tipId, keyA) });
  assert(await wait(() => B.chain.height === 5), 'shared prefix gossiped peer-to-peer (height 5)');
  assert(B.chain.tipId === A.chain.tipId, 'both nodes agree on the pre-fork tip');

  // ---- 2. partition: mine competing branches --------------------------------
  A.p2p.stopped = true; A.p2p.disconnect(); B.p2p.disconnect();
  assert(await wait(() => A.p2p.peers.size === 0 && B.p2p.peers.size === 0, 5000), 'network partitioned');

  for (let i = 0; i < 2; i++) mine(A, A.chain.tipId, keyA);   // A: 6..7
  for (let i = 0; i < 4; i++) mine(B, B.chain.tipId, keyB);   // B: 6..9 (heavier)
  const aForkTip = A.chain.tipId, bTip = B.chain.tipId;
  // the fork point is BELOW the lighter node's tip: getblocks-by-height cannot
  // express this query, which is precisely why the split used to be permanent
  assert(A.chain.height === 7 && B.chain.height === 9 && aForkTip !== bTip, 'branches diverged below both tips');
  const balABefore = A.chain.balance(keyA.address);
  assert(balABefore > 0 && A.chain.balance(keyB.address) === 0, 'lighter node only holds its own branch coins');

  // ---- 3. reconnect: locator negotiation must drive the reorg ---------------
  A.p2p.stopped = false;
  A.p2p.connect('127.0.0.1:' + portB);
  assert(await wait(() => A.chain.tipId === bTip), 'lighter node reorged onto the heavier remote tip');
  assert(A.chain.height === 9, 'height follows the heavier branch');
  assert(A.chain.balance(keyB.address) > 0 && A.chain.balance(keyB.address) === B.chain.balance(keyB.address),
    'utxo set follows the reorg (remote miner balance matches the heavier node)');
  assert(A.chain.balance(keyA.address) < balABefore, 'orphaned-branch coinbases dropped from the utxo set');
  assert(await wait(() => B.chain.store.has(aForkTip), 10000), 'heavier node also fetched the losing side branch');
  assert(B.chain.tipId === bTip, 'heavier node kept its tip');

  // ---- 4. periodic re-sync finds a tip that was never announced -------------
  const silent = BLOCK.blockId(mine(B, B.chain.tipId, keyB));
  assert(await wait(() => A.chain.tipId === silent, 10000), 'periodic re-sync pulled an unannounced block');

  // ---- 5. equal height, different tip: must still exchange branches ----------
  A.p2p.stopped = true; A.p2p.disconnect(); B.p2p.disconnect();
  await wait(() => A.p2p.peers.size === 0 && B.p2p.peers.size === 0, 5000);
  const a11 = BLOCK.blockId(mine(A, A.chain.tipId, keyA));
  const b11 = BLOCK.blockId(mine(B, B.chain.tipId, keyB));
  assert(A.chain.height === B.chain.height && a11 !== b11, 'equal height, competing tips');
  A.p2p.stopped = false;
  A.p2p.connect('127.0.0.1:' + portB);
  assert(await wait(() => A.chain.store.has(b11) && B.chain.store.has(a11), 15000),
    'equal-height fork exchanged both branches (no permanent split)');

  // ---- 6. orphan handling + wire bounds (deterministic, no sockets) ---------
  A.p2p.stopped = true; A.p2p.disconnect(); B.p2p.disconnect();
  await wait(() => A.p2p.peers.size === 0, 5000);

  const replies = [];
  const spy = { write: s => { replies.push(JSON.parse(s)); return true; } };

  A.p2p._onMsg(spy, { t: 'getblocks', locator: new Array(P.P2P_MAX_LOCATOR + 1).fill('a'.repeat(64)) });
  A.p2p._onMsg(spy, { t: 'getblocks', locator: ['not-a-hash'] });
  A.p2p._onMsg(spy, { t: 'getblocks', locator: [] });
  A.p2p._onMsg(spy, { t: 'blocks', blocks: 'nope' });
  A.p2p._onMsg(spy, { t: 'block', block: { header: { height: 1 } } });
  A.p2p._onMsg(spy, { t: 'block' });
  A.p2p._onMsg(spy, null);
  assert(replies.length === 0, 'malformed locator / block messages are ignored without a reply');
  assert(A.p2p._locator().length <= P.P2P_MAX_LOCATOR, 'locator length is capped');

  A.p2p._onMsg(spy, { t: 'getblock', id: aForkTip });
  assert(replies.length === 1 && replies[0].t === 'blocks' && BLOCK.blockId(replies[0].blocks[0]) === aForkTip,
    'a side-branch block is served by hash');

  const c1 = mine(B, b11, keyB), c2 = mine(B, BLOCK.blockId(c1), keyB), c3 = mine(B, BLOCK.blockId(c2), keyB);
  replies.length = 0;
  A.p2p._onMsg(spy, { t: 'block', block: c3 });
  assert(A.p2p.orphans.size === 1, 'parentless block held in the orphan pool');
  assert(replies.some(m => m.t === 'getblock' && m.id === c3.header.prevHash), 'orphan triggers a targeted parent fetch');
  assert(replies.some(m => m.t === 'getblocks' && Array.isArray(m.locator)), 'orphan also triggers locator negotiation');
  A.p2p._onMsg(spy, { t: 'block', block: c2 });
  A.p2p._onMsg(spy, { t: 'block', block: c1 });
  assert(A.p2p.orphans.size === 0, 'orphans drained once the missing ancestor arrived');
  assert(A.chain.tipId === BLOCK.blockId(c3), 'reorged onto the branch completed from the orphan pool');

  for (let i = 0; i < P.P2P_MAX_ORPHANS * 3; i++) {
    const clone = JSON.parse(JSON.stringify(c3));
    clone.header.nonce = 10_000_000 + i;
    A.p2p._orphan(clone);
  }
  assert(A.p2p.orphans.size === P.P2P_MAX_ORPHANS, 'orphan pool is bounded');

  A.p2p.close(); B.p2p.close();
  A.rpc.server.close(); B.rpc.server.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
