'use strict';
/* P2P over WebSocket — two real nodes, a real `wss`-shaped link, a real block.
 * Run: node test/p2p-ws.js
 *
 * WHY THIS TRANSPORT EXISTS. CloudsForge publishes from a home server behind a
 * Cloudflare Tunnel, and the operator has no static IP, so every inbound
 * connection arrives through the tunnel or not at all. A tunnel carries HTTP and
 * WebSocket; it cannot carry raw TCP. Gossip is raw TCP (`net.createServer`,
 * src/p2p.js), so without this the one thing that cannot be published is the one
 * thing a miner needs — a mined block propagates only by `p2p.broadcast`.
 *
 * WHAT THIS FILE HAS TO PROVE, over and above test/ws.js's framing:
 *
 *   1. A block mined on one node reaches the other THROUGH A WEBSOCKET, both ways.
 *   2. The two transports interoperate: a TCP peer and a WebSocket peer of the
 *      same node relay to each other.
 *   3. EVERY BOUND STILL APPLIES. A WebSocket peer is more exposed than a TCP
 *      one, not less — it is reachable from any browser on the internet — so the
 *      peer cap, the read bound, the two verification budgets, the invalid-block
 *      budget and the genesis handshake are all asserted ON THE WEBSOCKET PATH.
 *      A bound that holds only for TCP is a bound that does not hold.
 *   4. The link survives an idle period, because Cloudflare closes idle
 *      WebSockets and a seed that dies quietly looks exactly like a quiet chain.
 *   5. The reconnect loop works for a `ws://` peer, because HEARTH_PEERS now
 *      carries URLs as well as host:port.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const WS = require('../src/ws');
const { EvmNode } = require('../src/evmnode');
const C = require('./evm-common');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const tmpdir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `hearth-p2p-ws-${tag}-`));
const dirs = [];
const nodes = [];
function node(tag, gen, extra = {}) {
  const dir = tmpdir(tag);
  dirs.push(dir);
  const n = new EvmNode({ dataDir: dir, quiet: true, resyncMs: 250, genesis: gen, ...extra });
  nodes.push(n);
  return n;
}

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const minerA = C.testKey('ws-a');
const minerB = C.testKey('ws-b');
const alice = C.testKey('ws-alice');

/** Mine one block on a node's own tip and gossip it, exactly as the miner does. */
function mine(n, key, transactions = []) {
  const block = C.mineOn(n.chain, n.chain.tipId, key, { transactions });
  const r = n.chain.addBlock(block);
  if (!r.ok) throw new Error('mine rejected: ' + r.err);
  return block;
}

(async () => {
  console.log('\nHearth p2p-over-WebSocket test\n');

  const alloc = { [alice.addressHex]: { balance: (100n * 10n ** 18n).toString() } };
  const gen = { alloc, target: C.EASY_TARGET };

  // ==========================================================================
  group('a block crosses a WebSocket');
  // ==========================================================================
  const A = node('a', gen, { coinbaseKey: minerA });
  const B = node('b', gen, { coinbaseKey: minerB });

  // A is the tunnelled node: it listens on WebSocket only, exactly as it would
  // behind `wss://p2p.<apex>/p2p`, where no raw TCP port is reachable at all.
  A.p2p.listenWs(0);
  const wsPort = await bound(A.p2p.wsServer, 'A p2p ws');
  assert(Number.isInteger(wsPort) && wsPort > 0, 'a node can listen for p2p on a WebSocket port');
  assert(A.p2p.server === null, '…without a TCP listener at all — the tunnel cannot carry one');

  const url = `ws://127.0.0.1:${wsPort}${P.P2P_WS_PATH}`;
  assert(P.P2P_WS_PATH === '/p2p', 'the path is /p2p, as the Cloudflare ingress is being wired to');
  B.p2p.connect(url);
  assert(await wait(() => A.p2p.peers.size === 1 && B.p2p.peers.size === 1, 8000),
    'a peer given a ws:// URL connects — HEARTH_PEERS is no longer host:port only');

  const b1 = mine(A, minerA);
  A.p2p.broadcast({ t: 'block', block: b1 });
  assert(await wait(() => B.chain.height === 1, 8000), 'A MINED BLOCK CROSSES THE WEBSOCKET (A → B)');
  assert(B.chain.tipId === A.chain.tipId, 'and both nodes agree on the tip');

  const b2 = mine(B, minerB);
  B.p2p.broadcast({ t: 'block', block: b2 });
  assert(await wait(() => A.chain.height === 2, 8000), 'and back the other way (B → A) — the link is duplex');
  assert(A.chain.tipId === B.chain.tipId, 'both nodes agree again');

  const raw = C.signed(alice, { nonce: 0n, to: minerB.address, value: 5n * 10n ** 18n, gasLimit: 21000n });
  A.submitRawTransaction(raw);
  assert(await wait(() => B.mempool.size === 1, 8000), 'a transaction gossips over the WebSocket too');

  // ==========================================================================
  group('initial sync, which is where the frames get big');
  // ==========================================================================
  for (let i = 0; i < 6; i++) mine(A, minerA);
  const D = node('d', gen, { coinbaseKey: minerB });
  D.p2p.connect(url);
  assert(await wait(() => D.chain.height === A.chain.height, 20000),
    'a node joining late pulls the whole chain over the WebSocket — a getblocks page is one message');
  assert(D.chain.tipId === A.chain.tipId, 'and lands on the same tip');
  assert(D.chain.stateAtTip().rootHex() === A.chain.stateAtTip().rootHex(), 'and the same state root');

  // ==========================================================================
  group('the two transports are one network');
  // ==========================================================================
  A.p2p.listen(0);
  const tcpPort = await bound(A.p2p.server, 'A p2p tcp');
  const E = node('e', gen, { coinbaseKey: minerA });
  E.p2p.connect('127.0.0.1:' + tcpPort);
  assert(await wait(() => E.chain.height === A.chain.height, 20000), 'a TCP peer still syncs — nothing about it changed');

  const crossed = mine(B, minerB);
  B.p2p.broadcast({ t: 'block', block: crossed });
  assert(await wait(() => E.chain.tipId === B.chain.tipId, 20000),
    'a block mined by a WEBSOCKET peer reaches a TCP peer through the node in the middle');

  // ==========================================================================
  group('every bound still applies on the WebSocket path');
  // ==========================================================================
  {
    const peer = [...A.p2p.peers].find(p => p.isWebSocket);
    assert(!!peer, 'the WebSocket peers are in the same peer set as the TCP ones');
    assert(peer && peer.cfVerify && typeof peer.cfVerify.tokens === 'number' && peer.cfInvalid === 0,
      'a WebSocket peer carries the per-connection PoW verification budget');
    assert(peer && peer.cfTxVerify && typeof peer.cfTxVerify.tokens === 'number' && peer.cfInvalidTx === 0,
      'and the transaction verification budget');
    assert(peer && typeof peer.writableLength === 'number',
      'and writableLength, so "one getblocks page in flight per peer" still holds');
  }

  {
    /* The peer cap. A browser can open a WebSocket to any host with no preflight
     * and no CORS, so without this an anonymous page's visitors take every slot.
     *
     * Every step is asserted separately on purpose. Written as "the second
     * connection closed", this check passes when the FIRST one failed too — any
     * broken link satisfies it — so it has to distinguish "refused because we
     * are at capacity" from "refused, or never established, for some other
     * reason". `dial` below reports which. */
    const real = P.P2P_MAX_PEERS;
    const F = node('f', gen, { coinbaseKey: minerA });
    F.p2p.listenWs(0);
    const fport = await bound(F.p2p.wsServer, 'F p2p ws');
    const furl = `ws://127.0.0.1:${fport}${P.P2P_WS_PATH}`;

    /** Open a connection and report how it went, rather than just that it ended. */
    async function dial() {
      const c = WS.connect(furl, { pingMs: 0, idleMs: 0 });
      const opened = await new Promise(res => {
        c.on('open', () => res(true));
        c.on('error', e => res(String(e && e.message || e)));
        setTimeout(() => res('timed out'), 5000);
      });
      return { c, opened };
    }

    P.P2P_MAX_PEERS = 1;
    try {
      const one = await dial();
      assert(one.opened === true, `the first WebSocket peer completes its handshake (${one.opened})`);
      assert(await wait(() => F.p2p.peers.size === 1, 5000),
        `and is accepted into the peer set (size is ${F.p2p.peers.size})`);

      const two = await dial();
      // The cap lives in `_setup`, i.e. AFTER the upgrade — so the handshake
      // succeeding and the connection then closing is the expected shape, and
      // is what tells this apart from a refusal at the HTTP layer.
      assert(two.opened === true, `the second peer also completes its handshake (${two.opened})`);
      const dropped = await new Promise(res => { two.c.on('close', () => res(true)); setTimeout(() => res(false), 3000); });
      assert(dropped, 'and is then hung up on: P2P_MAX_PEERS is enforced on the WebSocket path');
      assert(F.p2p.peers.size === 1, `and the peer set never grew past the cap (size is ${F.p2p.peers.size})`);
      one.c.destroy(); two.c.destroy();
    } finally { P.P2P_MAX_PEERS = real; }
  }

  {
    // The read bound. On TCP this is "a peer that never sends a newline"; on a
    // WebSocket it is "a peer that announces a message bigger than we will hold".
    const G = node('g', gen, { coinbaseKey: minerA });
    G.p2p.listenWs(0);
    const gport = await bound(G.p2p.wsServer, 'G p2p ws');
    const c = WS.connect(`ws://127.0.0.1:${gport}${P.P2P_WS_PATH}`, { pingMs: 0, idleMs: 0 });
    await new Promise(res => { c.on('open', res); c.on('error', res); });
    await wait(() => G.p2p.peers.size === 1, 5000);
    c.write('x'.repeat(P.P2P_MAX_LINE + 1024) + '\n');
    const dropped = await new Promise(res => { c.on('close', () => res(true)); setTimeout(() => res(false), 5000); });
    assert(dropped, 'a message over P2P_MAX_LINE gets the peer dropped rather than buffered');
    assert(await wait(() => G.p2p.peers.size === 0, 5000), 'and it leaves the peer set');
    c.destroy();
  }

  {
    // The invalid-block budget: sixteen forged blocks and the peer is gone.
    const H = node('h', gen, { coinbaseKey: minerA });
    H.p2p.listenWs(0);
    const hport = await bound(H.p2p.wsServer, 'H p2p ws');
    const real = mine(H, minerA);
    const forged = JSON.parse(JSON.stringify(real));
    forged.header.stateRoot = 'ab'.repeat(32);

    const c = WS.connect(`ws://127.0.0.1:${hport}${P.P2P_WS_PATH}`, { pingMs: 0, idleMs: 0 });
    await new Promise(res => { c.on('open', res); c.on('error', res); });
    await wait(() => H.p2p.peers.size === 1, 5000);
    c.write(JSON.stringify(H.p2p._hello()) + '\n');
    for (let i = 0; i <= P.P2P_MAX_INVALID_BLOCKS; i++) c.write(JSON.stringify({ t: 'block', block: forged }) + '\n');
    const dropped = await new Promise(res => { c.on('close', () => res(true)); setTimeout(() => res(false), 8000); });
    assert(dropped, 'a WebSocket peer feeding forged blocks runs out of its invalid-block budget and is dropped');
    assert(H.chain.height === 1, 'and none of them was applied');
    c.destroy();
  }

  {
    // The handshake. Same shape as test/evm-p2p-fork.js §8, but the "one TCP
    // write carrying a hello and a block behind it" becomes "one WebSocket
    // message carrying two NDJSON lines" — the read loop must still stop the
    // moment the handshake refuses the peer.
    const I = node('i', gen, { coinbaseKey: minerA });
    const other = node('i-other', { ...gen, alloc: { ...alloc, [minerB.addressHex]: { balance: '1' } } },
      { coinbaseKey: minerB });
    assert(other.chain.genesisId !== I.chain.genesisId, 'a different alloc really is a different genesis hash');
    const warned = [];
    I.warn = (msg, fields) => warned.push({ msg, fields });
    I.p2p.listenWs(0);
    const iport = await bound(I.p2p.wsServer, 'I p2p ws');
    const stray = mine(other, minerB);

    const c = WS.connect(`ws://127.0.0.1:${iport}${P.P2P_WS_PATH}`, { pingMs: 0, idleMs: 0 });
    await new Promise(res => { c.on('open', res); c.on('error', res); });
    c.write(JSON.stringify({ ...other.p2p._hello(), height: 1 }) + '\n'
      + JSON.stringify({ t: 'block', block: stray }) + '\n');
    assert(await wait(() => warned.some(w => w.msg.includes('different genesis')), 5000),
      'a peer on another chain is refused at the handshake over WebSocket too');
    await sleep(200);
    assert(I.chain.height === 0 && I.p2p.orphans.size === 0,
      'and the block packed behind the hello IN THE SAME MESSAGE is never read');
    assert(I.p2p.peers.size === 0, 'and no peer is left connected');
    c.destroy();
  }

  // ==========================================================================
  group('the link survives being idle — Cloudflare closes one that is');
  // ==========================================================================
  {
    const J = node('j', gen, { coinbaseKey: minerA });
    const K = node('k', gen, { coinbaseKey: minerB });
    // Timings scaled down from the shipped ones; the shipped values are asserted
    // separately at the end of this block.
    J.p2p.listenWs(0, { pingMs: 60, idleMs: 400 });
    const jport = await bound(J.p2p.wsServer, 'J p2p ws');

    /* A byte counter in the middle, because "the peer is still in the set" is
     * NOT the property that matters. Cloudflare does not consult our peer set;
     * it closes a socket that has carried nothing. So the assertion has to be
     * about BYTES ON THE WIRE during an idle period, in both directions — which
     * is also the only version of this check that goes red when the keepalive is
     * switched off. (It was written the other way first, and disabling the
     * server's ping left it passing, because the client's ping was keeping the
     * server's own liveness clock fresh.) */
    const bytes = { out: 0, back: 0 };
    const proxy = net.createServer(down => {
      const up = net.connect({ host: '127.0.0.1', port: jport });
      down.on('data', d => { bytes.out += d.length; up.write(d); });
      up.on('data', d => { bytes.back += d.length; down.write(d); });
      const bye = () => { down.destroy(); up.destroy(); };
      down.on('error', bye); up.on('error', bye);
      down.on('close', bye); up.on('close', bye);
    });
    const pport = await new Promise(res => proxy.listen(0, '127.0.0.1', () => res(proxy.address().port)));

    K.p2p.connect(`ws://127.0.0.1:${pport}${P.P2P_WS_PATH}`, { pingMs: 60, idleMs: 400 });
    assert(await wait(() => J.p2p.peers.size === 1 && K.p2p.peers.size === 1, 8000), 'connected through a byte counter');

    /* Nothing to mine and nothing to resync, so anything the counter sees from
     * here on is the keepalive and ONLY the keepalive. The running interval has
     * to be cleared, not just re-configured: `_startResync` reads resyncMs when
     * it creates the timer, and setting the field afterwards changes nothing.
     * Without this the counter was measuring `getblocks` traffic and passed with
     * the keepalive switched off entirely — the defect this file is supposed to
     * be incapable of. */
    for (const n of [J, K]) {
      if (n.p2p.timer) { clearInterval(n.p2p.timer); n.p2p.timer = null; }
      n.p2p.resyncMs = 1e9;
    }
    await sleep(200);
    bytes.out = 0; bytes.back = 0;
    await sleep(1200);                                  // twenty ping intervals
    assert(bytes.out > 0 && bytes.back > 0,
      `an idle link still carries traffic BOTH ways (${bytes.out}b out, ${bytes.back}b back) — `
      + 'a WebSocket that carries nothing is one Cloudflare closes');
    assert(J.p2p.peers.size === 1 && K.p2p.peers.size === 1, 'and neither end has given up on the other');

    const late = mine(K, minerB);
    K.p2p.broadcast({ t: 'block', block: late });
    assert(await wait(() => J.chain.height === 1, 8000),
      'a block mined after the idle period still arrives — the link was alive, not merely open');

    /* …and the other half of a heartbeat: acting on silence. Without this a
     * half-open link through a tunnel looks connected forever, which is worse
     * than a dropped one — the miner keeps mining into it.
     *
     * Its own listener, with a deadline measured in seconds rather than in the
     * 400 ms the byte counter above needs. Sharing J's timings made the window
     * in which the mute peer is connected about 400 ms wide, and a CI runner
     * that stalls for half of that reports "never accepted" for a node that
     * accepted and dropped it correctly — a flaky test, which is a defect in
     * the test and was one here. The property is unchanged; only the clock is. */
    const S = node('silence', gen, { coinbaseKey: minerA });
    S.p2p.listenWs(0, { pingMs: 100, idleMs: 2000 });
    const sport = await bound(S.p2p.wsServer, 'S p2p ws');
    const mute = net.connect({ host: '127.0.0.1', port: sport }, () => {
      mute.write(`GET ${P.P2P_WS_PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    mute.on('error', () => {});
    assert(await wait(() => S.p2p.peers.size === 1, 10000), 'a peer that only completes the handshake is accepted');
    assert(await wait(() => S.p2p.peers.size === 0, 15000),
      'and then dropped once it answers no ping — silence is acted on, not waited on forever');
    mute.destroy();
    proxy.close();

    assert(P.P2P_WS_PING_MS > 0 && P.P2P_WS_PING_MS <= 30_000,
      'the shipped ping interval is under 30s — Cloudflare drops a WebSocket idle for ~100s');
    assert(P.P2P_WS_IDLE_MS > 2 * P.P2P_WS_PING_MS,
      'and the liveness deadline allows at least two missed pings before hanging up');
  }

  // ==========================================================================
  group('a ws:// peer reconnects, the way a host:port peer does');
  // ==========================================================================
  {
    const L = node('l', gen, { coinbaseKey: minerA });
    const M = node('m', gen, { coinbaseKey: minerB });
    L.p2p.listenWs(0);
    const lport = await bound(L.p2p.wsServer, 'L p2p ws');
    const lurl = `ws://127.0.0.1:${lport}${P.P2P_WS_PATH}`;
    M.p2p.connect(lurl);
    assert(await wait(() => M.p2p.peers.size === 1, 8000), 'connected to the seed');

    // the seed goes away — a home server rebooting, or the tunnel restarting
    L.p2p.wsServer.close();
    L.p2p.disconnect();
    assert(await wait(() => M.p2p.peers.size === 0, 8000), 'the peer drops when the seed goes away');

    // …and comes back on the same address
    const L2 = node('l2', gen, { coinbaseKey: minerA });
    await new Promise((res, rej) => {
      L2.p2p.listenWs(lport);
      L2.p2p.wsServer.once('listening', res);
      L2.p2p.wsServer.once('error', rej);
    });
    assert(await wait(() => M.p2p.peers.size === 1, 15000),
      'and the ws:// peer reconnects on its own — the retry loop is not TCP-only');

    const back = mine(M, minerB);
    M.p2p.broadcast({ t: 'block', block: back });
    assert(await wait(() => L2.chain.height === 1, 8000), 'and gossip resumes across the new link');
  }

  {
    // an unreachable ws:// seed is reported once, not once every three seconds
    const N = node('n', gen, { coinbaseKey: minerA });
    const seen = [];
    N.warn = (msg, fields) => seen.push({ msg, fields });
    N.p2p.connect('ws://127.0.0.1:1/p2p');
    await sleep(4000);
    const failures = seen.filter(w => w.msg.includes('connect failed'));
    assert(failures.length === 1, 'an unreachable ws:// seed is reported ONCE per outage, not once per retry');
    assert(failures[0] && failures[0].fields.peer === 'ws://127.0.0.1:1/p2p', 'and the log names the URL');
    N.p2p.stopped = true;
  }

  for (const n of nodes) { try { n.close(); } catch { /* already down */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
