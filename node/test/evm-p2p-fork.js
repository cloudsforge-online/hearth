'use strict';
/* The gate: two real account-model nodes on real TCP sockets, partitioned, mining
 * competing branches, reconnected, and required to reorganise.
 * Run: node test/evm-p2p-fork.js
 *
 * This is the account-model twin of test/p2p-fork.js, and it exists because the
 * in-process suite cannot catch what happens here. Three things are only testable
 * over a real socket, and each of them has broken a chain before:
 *
 *   1. THE BLOCK SURVIVES JSON. Everything crossing the wire is `JSON.stringify`d,
 *      so a header field that is a Buffer or a BigInt in memory arrives as
 *      `{"type":"Buffer"}` or throws. The header is hex strings for exactly this
 *      reason, and this test is what proves it.
 *   2. THE STATE FOLLOWS THE FORK CHOICE. A node can accept the heavier branch,
 *      update its tip, and keep serving balances from the losing one. Here the
 *      balances are asserted after the reorg, on the node that lost.
 *   3. AN EMPTY BLOCK GOSSIPS. The UTXO shape check requires a first transaction;
 *      an account-model block usually has none at all.
 *   4. A PEER ON ANOTHER CHAIN IS HUNG UP ON. Section 8: the handshake compares the
 *      genesis hash and the two consensus values block 0 does not hash, and only a
 *      real socket shows that the connection is actually closed and that nothing
 *      behind the `hello` in the same frame was acted on.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const HDR = require('../src/chain/header');
const TX = require('../src/chain/transaction');
const { EvmNode } = require('../src/evmnode');
const { keccak256 } = require('../src/crypto/keccak');
const C = require('./evm-common');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}

const tmpdir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `hearth-evm-p2p-${tag}-`));

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

async function rpc(port, method, params = []) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

const minerA = C.testKey('p2p-a');
const minerB = C.testKey('p2p-b');
const alice = C.testKey('p2p-alice');

/** Mine one block onto a node's own tip and gossip it, exactly as the miner would. */
function mine(node, key, transactions = []) {
  const block = C.mineOn(node.chain, node.chain.tipId, key, { transactions });
  const r = node.chain.addBlock(block);
  if (!r.ok) throw new Error('mine rejected: ' + r.err);
  return block;
}

(async () => {
  const dirA = tmpdir('a'), dirB = tmpdir('b');
  const alloc = { [alice.addressHex]: { balance: (100n * 10n ** 18n).toString() } };
  const gen = { alloc, target: C.EASY_TARGET };
  const A = new EvmNode({ dataDir: dirA, quiet: true, resyncMs: 250, coinbaseKey: minerA, genesis: gen });
  const B = new EvmNode({ dataDir: dirB, quiet: true, resyncMs: 250, coinbaseKey: minerB, genesis: gen });

  console.log('\nHearth account-model p2p fork-sync test\n');

  assert(A.chain.genesisId === B.chain.genesisId, 'both nodes computed the same genesis hash from the same config');

  A.p2p.listen(0); B.p2p.listen(0);
  A.listenJsonRpc(0); B.listenJsonRpc(0);
  A.listenRest(0);
  const [, portB, jsonA] = await Promise.all([
    bound(A.p2p.server, 'A p2p'), bound(B.p2p.server, 'B p2p'),
    bound(A.jsonrpcServer, 'A json-rpc'), bound(B.jsonrpcServer, 'B json-rpc'),
    bound(A.restServer, 'A rest'),
  ]);

  const chainId = await rpc(jsonA, 'eth_chainId');
  assert(chainId.result === '0x1cf3', 'the JSON-RPC server answers eth_chainId with 7411');

  // ---- 1. connected: gossip builds a shared prefix ---------------------------
  A.p2p.connect('127.0.0.1:' + portB);
  assert(await wait(() => A.p2p.peers.size === 1 && B.p2p.peers.size === 1, 5000), 'two nodes connected over real sockets');

  for (let i = 0; i < 4; i++) A.p2p.broadcast({ t: 'block', block: mine(A, minerA) });
  assert(await wait(() => B.chain.height === 4), 'EMPTY blocks gossip and apply (height 4)');
  assert(B.chain.tipId === A.chain.tipId, 'both nodes agree on the pre-fork tip');
  assert(B.chain.stateAtTip().rootHex() === A.chain.stateAtTip().rootHex(),
    'and on the state root — the whole point of validating rather than trusting the header');

  // ---- 2. a transaction crosses the wire and is mined remotely --------------
  const raw = C.signed(alice, { nonce: 0n, to: minerB.address, value: 7n * 10n ** 18n, gasLimit: 21000n });
  const sent = await rpc(jsonA, 'eth_sendRawTransaction', ['0x' + raw.toString('hex')]);
  assert(sent.result === '0x' + keccak256(raw).toString('hex'), 'eth_sendRawTransaction returns the transaction hash');
  assert(await wait(() => B.mempool.size === 1, 5000), 'the transaction gossiped to the other node');

  /* Deployed into the SHARED prefix, so both branches can call it below. Section
   * 3½ needs a contract that logs, on a chain that is about to reorganise. */
  const deploy = C.signed(alice, { nonce: 1n, to: null, data: C.STORAGE_INITCODE, gasLimit: 300_000n });
  const withTx = mine(B, minerB, [raw, deploy]);
  B.p2p.broadcast({ t: 'block', block: withTx });
  assert(await wait(() => A.chain.height === 5, 5000), 'a block carrying it came back');
  assert(A.chain.stateAtTip().getBalance(minerB.address) > 7n * 10n ** 18n, 'and the value moved on the receiving node');
  assert(await wait(() => A.mempool.size === 0, 5000), 'the mined transaction left the sender node mempool');

  const receipt = await rpc(jsonA, 'eth_getTransactionReceipt', ['0x' + keccak256(raw).toString('hex')]);
  assert(receipt.result && receipt.result.status === '0x1', 'and its receipt is served over JSON-RPC');
  assert(receipt.result.blockNumber === '0x5', 'from the right block');

  /* ---- 3½. a log filter, opened before the fork ----------------------------
   *
   * A LOG FILTER IS A CURSOR THAT WALKS FORWARD, so a reorg is the one event it
   * cannot see by walking. Before the fix in jsonrpc/methods.js the poll after
   * the reorg below returned [] — the cursor was already past height 6 and
   * nothing ever went back — which means an ethers listener on this node would
   * have seen the event that was UNDONE and never the one that happened, with
   * no way to tell the difference from a quiet chain. Section 5 asserts the
   * same rule for the transaction itself; this is the rule for its events.
   *
   * It is here rather than in test/jsonrpc.js because a fake chain agrees with
   * whatever its author believed about reorgs. This one is two processes'
   * worth of real proof-of-work disagreeing and one of them losing. */
  const deployReceipt = await rpc(jsonA, 'eth_getTransactionReceipt', ['0x' + keccak256(deploy).toString('hex')]);
  const logger = deployReceipt.result.contractAddress;
  assert(!!logger, 'the log-emitting contract deployed inside the shared prefix');
  const logFilter = (await rpc(jsonA, 'eth_newFilter', [{ address: logger }])).result;
  assert(/^0x[0-9a-f]{32}$/.test(logFilter), 'a log filter is open on the node that is about to lose');
  const word = v => Buffer.from(v.repeat(64), 'hex');
  /* Both spend alice's nonce 2, so at most one of them can ever be canonical —
   * which is exactly what a reorg that replaces a transaction looks like. */
  const callLosing = C.signed(alice, { nonce: 2n, to: Buffer.from(logger.slice(2), 'hex'), data: word('aa') });
  const callWinning = C.signed(alice, { nonce: 2n, to: Buffer.from(logger.slice(2), 'hex'), data: word('bb') });

  // ---- 3. partition: mine competing branches --------------------------------
  A.p2p.stopped = true; A.p2p.disconnect(); B.p2p.disconnect();
  assert(await wait(() => A.p2p.peers.size === 0 && B.p2p.peers.size === 0, 5000), 'network partitioned');

  const forkPoint = A.chain.tipId;
  mine(A, minerA, [callLosing]); mine(A, minerA);       // A: 6..7
  mine(B, minerB, [callWinning]);                       // B: 6..9, heavier
  for (let i = 0; i < 3; i++) mine(B, minerB);
  const aForkTip = A.chain.tipId, bTip = B.chain.tipId;
  assert(A.chain.height === 7 && B.chain.height === 9 && aForkTip !== bTip, 'branches diverged below both tips');

  const aMinerBefore = A.chain.stateAtTip().getBalance(minerA.address);
  assert(aMinerBefore > 0n, 'the lighter node holds its own branch rewards');

  const losingLogs = (await rpc(jsonA, 'eth_getFilterChanges', [logFilter])).result;
  assert(losingLogs.length === 1 && losingLogs[0].data.endsWith('aa'),
    'the filter delivered the log from the branch that is about to lose');

  // ---- 4. reconnect: the reorg ----------------------------------------------
  A.p2p.stopped = false;
  A.p2p.connect('127.0.0.1:' + portB);
  assert(await wait(() => A.chain.tipId === bTip), 'the lighter node reorged onto the heavier remote tip');
  assert(A.chain.height === 9, 'height follows the heavier branch');
  assert(A.chain.stateAtTip().rootHex() === B.chain.stateAtTip().rootHex(), 'STATE follows the reorg, byte for byte');
  assert(A.chain.stateAtTip().getBalance(minerA.address) < aMinerBefore, 'orphaned-branch rewards are gone from the state');
  assert(A.chain.stateAtTip().getBalance(minerB.address) === B.chain.stateAtTip().getBalance(minerB.address),
    'and the winning miner is credited identically on both nodes');
  assert(await wait(() => B.chain.store.has(aForkTip), 10000), 'the heavier node also fetched the losing side branch');
  assert(B.chain.tipId === bTip, 'and kept its tip');

  const head = await rpc(jsonA, 'eth_blockNumber');
  assert(head.result === '0x9', 'the reorged node serves the new height over JSON-RPC');

  const winningLogs = (await rpc(jsonA, 'eth_getFilterChanges', [logFilter])).result;
  assert(winningLogs.length === 1 && winningLogs[0].data.endsWith('bb'),
    'and the open log filter delivers the WINNING branch\'s log — a reorg does not silently swallow an event');
  assert(!!winningLogs[0] && winningLogs[0].blockNumber === '0x6' && winningLogs[0].removed === false,
    '…from the replaced height, tagged with the block hash a client reconciles against');
  assert((await rpc(jsonA, 'eth_getFilterChanges', [logFilter])).result.length === 0,
    'and the settled branch goes quiet rather than re-delivering');

  // ---- 5. a transaction un-mined by a reorg comes back ----------------------
  {
    const dirC = tmpdir('c'), dirD = tmpdir('d');
    const X = new EvmNode({ dataDir: dirC, quiet: true, resyncMs: 250, coinbaseKey: minerA, genesis: gen });
    const Y = new EvmNode({ dataDir: dirD, quiet: true, resyncMs: 250, coinbaseKey: minerB, genesis: gen });
    X.p2p.listen(0); Y.p2p.listen(0);
    const [, portY] = await Promise.all([bound(X.p2p.server, 'X p2p'), bound(Y.p2p.server, 'Y p2p')]);

    const tx = C.signed(alice, { nonce: 0n, to: minerA.address, value: 1n, gasLimit: 21000n });
    const hash = keccak256(tx).toString('hex');
    mine(X, minerA, [tx]);                                  // X mines it
    assert(X.chain.getTransaction(hash) !== null, 'the transaction is mined on the branch that will lose');

    for (let i = 0; i < 3; i++) mine(Y, minerB);             // Y builds a heavier branch without it
    X.p2p.connect('127.0.0.1:' + portY);
    assert(await wait(() => X.chain.tipId === Y.chain.tipId, 20000), 'the branch carrying it is reorged away');
    assert(X.chain.getTransaction(hash) === null, 'so the transaction is no longer mined');
    assert(await wait(() => X.mempool.has(hash), 5000),
      'and it is BACK in the mempool — a reorg must not silently swallow a user transaction');

    X.close(); Y.close();
    fs.rmSync(dirC, { recursive: true, force: true });
    fs.rmSync(dirD, { recursive: true, force: true });
  }

  // ---- 6. hostile input over the wire --------------------------------------
  A.p2p.stopped = true; A.p2p.disconnect(); B.p2p.disconnect();
  await wait(() => A.p2p.peers.size === 0, 5000);

  const replies = [];
  const spy = { write: s => { replies.push(JSON.parse(s)); return true; } };
  A.p2p._onMsg(spy, { t: 'block', block: { header: { height: 1 } } });
  A.p2p._onMsg(spy, { t: 'block', block: { header: { prevHash: 'z'.repeat(64), height: 1 }, txs: [] } });
  A.p2p._onMsg(spy, { t: 'tx', tx: 'not hex' });
  A.p2p._onMsg(spy, { t: 'tx', tx: { id: 'utxo-shaped' } });
  A.p2p._onMsg(spy, null);
  assert(replies.length === 0, 'malformed blocks and transactions are ignored without a reply');
  assert(A.mempool.size === 0, 'and nothing malformed entered the mempool');

  const forged = JSON.parse(JSON.stringify(A.chain.getBlock(9)));
  forged.header.stateRoot = 'ab'.repeat(32);
  const rejected = A.chain.addBlock(forged);
  assert(!rejected.ok, 'a block with a forged state root is refused even from a peer that mined a real proof');

  // ---- 7. persistence across a restart, on a real data directory ------------
  const tipBefore = A.chain.tipId, rootBefore = A.chain.stateAtTip().rootHex();
  A.close();
  const A2 = new EvmNode({ dataDir: dirA, quiet: true, coinbaseKey: minerA });
  // The replay is no longer part of construction (micro-org#349): a restart is
  // `new` and then an awaited `open()`, which is what a node's `start()` does.
  assert(A2.chain.height === 0 && !A2.ready,
    'a node that has not replayed yet holds only genesis, and refuses to answer');
  await A2.open();
  assert(A2.chain.tipId === tipBefore, 'a restarted node replays the reorged chain to the same tip');
  assert(A2.chain.stateAtTip().rootHex() === rootBefore, 'and to the same state root');
  A2.close();

  // ---- 8. a peer on another chain is refused at the handshake, and told why ---
  /* The split this prevents: a consensus value changes, and only some operators wipe
   * their volumes — `genesis.loadOrCreate` keeps the old file, so the two halves run
   * different chains while still calling themselves the same network. `net` matches,
   * so they connect; then every block one mines is `unknown parent` to the other,
   * which the receive path treats as ordinary out-of-order sync traffic and does not
   * even count against the peer. Both halves keep mining, both heights keep climbing,
   * and nothing anywhere says the word GENESIS.
   *
   * Three cases, because two of them are NOT caught by the genesis hash: block 0
   * commits to the alloc, the gas limit, the target, the timestamp and extraData —
   * and not to `chainId` or `commonsAddress`, which are consensus all the same. */
  {
    const dirE = tmpdir('e');
    const E = new EvmNode({ dataDir: dirE, quiet: true, resyncMs: 250, coinbaseKey: minerA, genesis: gen });
    const hello = E.p2p._hello();
    assert(hello.genesis === E.chain.genesisId && hello.chainId === E.chain.chainId
      && hello.commonsAddress === E.chain.config.commonsAddress,
      'the handshake carries the genesis hash, the chain id and the commons address');

    const warned = [];
    E.warn = (msg, fields) => warned.push({ msg, fields });
    E.p2p.listen(0);
    const portE = await bound(E.p2p.server, 'E p2p');

    const spawned = [];
    /** Start a node on `cfg`, point it at E over a real socket, and return the refusal. */
    async function refuse(tag, cfg, needle) {
      const dir = tmpdir(tag);
      const N = new EvmNode({ dataDir: dir, quiet: true, resyncMs: 250, coinbaseKey: minerB, genesis: cfg });
      spawned.push({ N, dir });
      warned.length = 0;
      N.p2p.listen(0);
      await bound(N.p2p.server, `${tag} p2p`);
      N.p2p.connect('127.0.0.1:' + portE);
      await wait(() => warned.some(w => w.msg.includes(needle)), 5000);
      N.p2p.stopped = true;                   // stop the 3s reconnect loop
      return { node: N, warn: warned.find(w => w.msg.includes(needle)) || null };
    }

    const forked = await refuse('e-alloc',
      { ...gen, alloc: { ...alloc, [minerB.addressHex]: { balance: '1' } } }, 'different genesis');
    assert(forked.node.chain.genesisId !== E.chain.genesisId, 'a different alloc is a different genesis hash');
    assert(forked.warn !== null, 'and the peer is dropped for a genesis mismatch rather than accepted');
    assert(forked.warn && forked.warn.fields.theirs === forked.node.chain.genesisId
      && forked.warn.fields.ours === E.chain.genesisId,
      'the log line names BOTH hashes — the thing an operator cannot otherwise find out');

    // the point of hanging up: nothing the other chain mines can reach us at all.
    // Without the check this block arrives, becomes an orphan, and stays one forever.
    forked.node.p2p.broadcast({ t: 'block', block: mine(forked.node, minerB) });
    assert(!(await wait(() => E.chain.height > 0, 500)), 'no block from the refused chain arrives');
    assert(E.p2p.orphans.size === 0 && E.p2p.peers.size === 0,
      'so nothing piles up in the orphan pool and no peer is left connected');

    // …and packing the two into ONE tcp write does not sneak the block past the
    // handshake: the read loop stops draining a frame once we have hung up.
    const stray = forked.node.chain.getBlock(1);
    await new Promise(res => {
      const s = net.connect({ host: '127.0.0.1', port: portE }, () => {
        s.write(JSON.stringify({ ...forked.node.p2p._hello(), height: 1 }) + '\n'
          + JSON.stringify({ t: 'block', block: stray }) + '\n');
        setTimeout(() => { s.destroy(); res(); }, 300);
      });
      s.on('error', () => res());
    });
    assert(E.p2p.orphans.size === 0 && E.chain.height === 0,
      'a hello and a block in one frame: the block behind a refused handshake is never read');

    /* The Commons address is where the 10% share of every subsidy is paid, so it is in
     * the state root of block 1 — but block 0 does not hash it, so these two nodes
     * agree on genesis and still fork at the first block either of them mines. */
    const commons = '0x' + '11'.repeat(20);
    const other = await refuse('e-commons', { ...gen, commonsAddress: commons }, 'different commons address');
    assert(other.node.chain.genesisId === E.chain.genesisId,
      'a different commonsAddress is the SAME genesis hash — block 0 does not commit to it');
    assert(other.warn && other.warn.fields.theirs === commons
      && other.warn.fields.ours === E.chain.config.commonsAddress,
      'so the handshake compares it by name, and the refusal prints both addresses');

    /* Same again for the chain id, where the consequence is sharper: two nodes with one
     * genesis and two chain ids relay each other's transactions, and every one of them
     * is valid on both — exactly what EIP-155 exists to prevent. */
    const wrongId = await refuse('e-chainid', { ...gen, chainId: 7412 }, 'different chain id');
    assert(wrongId.node.chain.genesisId === E.chain.genesisId && wrongId.node.chain.chainId !== E.chain.chainId,
      'the chain id is not covered by the genesis hash either');
    assert(wrongId.warn && String(wrongId.warn.fields.theirs) === '7412'
      && wrongId.warn.fields.ours === E.chain.chainId,
      'and a peer that shares our genesis but not our chain id is refused too');

    // fail closed: a hello that will not name a chain cannot be checked against ours
    warned.length = 0;
    let destroyed = false;
    const mute = { write: () => true, destroy: () => { destroyed = true; } };
    E.p2p._onMsg(mute, { t: 'hello', net: P.NETWORK, height: 9, tip: E.chain.tipId });
    assert(destroyed && warned.some(w => w.msg.includes('no genesis hash')),
      'a hello with no genesis hash at all is dropped rather than trusted');

    E.close();
    fs.rmSync(dirE, { recursive: true, force: true });
    for (const s of spawned) { s.N.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  }

  B.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
