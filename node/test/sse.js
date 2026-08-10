'use strict';
/* THE /events STREAM IS BOUNDED AND IT BREATHES. Run: node test/sse.js
 *
 * micro-org#236 widened micro-deploy's `cf-api-mining` router to publish
 * `GET /events` on `rpc.<apex>`, because the browser miner subscribes to it to
 * learn the tip moved and had been running on a 45-second fallback timer alone.
 * That widening made two properties of this route load-bearing that had never
 * been tested, because until then the route was not reachable from outside:
 *
 *   1. A CAP. `sseClients` was an unbounded `Set` and a held socket is not a
 *      rate, so the gateway's `cf-mining-throttle` — a `rateLimit` — does not
 *      bound it. One dial is all a subscriber costs.
 *   2. A HEARTBEAT. Nothing was written to an idle stream between blocks, and a
 *      tunnel closes a connection with no bytes on it.
 *
 * WHY THIS ASSERTS OVER REAL SOCKETS. Both properties are about a connection's
 * whole life, and neither is visible in a return value: the cap is about the
 * 257th response's STATUS, and the heartbeat is about bytes arriving on a stream
 * that has already been answered. A unit test on `openSseStream` would pass with
 * the response never written.
 *
 * WHY BOTH NODES. src/rpc.js (UTXO) and src/evmnode.js (account model) each
 * served this route with their own six-line copy, and both copies were missing
 * both properties. They now share src/sse.js; the table below runs against both
 * so a future edit cannot fix one and leave the other.
 *
 * NO FIGURE IS TYPED IN. The cap and the interval are read from params.js.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const P = require('../src/params');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-sse-'));
const bound = server => new Promise((res, rej) => {
  server.once('listening', () => res(server.address().port));
  server.once('error', rej);
});

/**
 * Open `GET /events` and keep it open, collecting the bytes as they arrive.
 *
 * Deliberately `http.request` and not `fetch`: this test is about a response
 * that never ends, and it has to read the status and the headers while the body
 * is still being written. `fetch` would give both too, but nothing in Node's
 * `fetch` lets a test abandon a stream and assert the SERVER noticed — and "the
 * slot is released when the client goes away" is one of the properties here.
 */
function openStream(base, pathname = '/events') {
  const url = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        resolve({
          status: res.statusCode,
          headers: res.headers,
          get text() { return text; },
          /** Resolve once `text` satisfies `pred`, or reject after `ms`. */
          until(pred, ms = 4000) {
            return new Promise((ok, no) => {
              const started = Date.now();
              const poll = setInterval(() => {
                if (pred(text)) { clearInterval(poll); ok(text); }
                else if (Date.now() - started > ms) { clearInterval(poll); no(new Error('timed out waiting on stream: ' + JSON.stringify(text))); }
              }, 10);
            });
          },
          close() { req.destroy(); },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A refusal ends, so it can be read whole. */
function readWhole(base, pathname = '/events') {
  const url = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runTable({ label, base, clients, mineOne }) {
  const open = [];
  const openOne = async (p) => { const s = await openStream(base, p); open.push(s); return s; };

  // ==========================================================================
  group(`${label} — the stream opens and says so before anything has happened`);
  // ==========================================================================
  {
    const s = await openOne();
    assert(s.status === 200, `GET /events answers 200 (got ${s.status})`);
    assert(s.headers['content-type'] === 'text/event-stream',
      `and content-type is text/event-stream (got ${s.headers['content-type']})`);
    assert(s.headers['x-accel-buffering'] === 'no',
      'and asks intermediaries not to buffer — a buffered stream delivers nothing until it fills');
    await s.until(t => t.includes(': connected'));
    assert(true, 'the open frame arrives immediately rather than on the first block');
  }

  // ==========================================================================
  group(`${label} — an idle stream is kept warm, invisibly`);
  // ==========================================================================
  {
    /* THE POINT OF THIS GROUP is not that bytes arrive — it is WHICH bytes. A
     * heartbeat written as `data:` would reach every EventSource's `onmessage`,
     * and network-site's miner refreshes its template on `onmessage`: every
     * browser miner in the world would re-pull work on this interval. An SSE
     * COMMENT reaches neither `onmessage` nor `addEventListener`. */
    const s = await openOne();
    await s.until(t => t.includes(': connected'));
    const atOpen = s.text;
    await s.until(t => t.length > atOpen.length);
    const beat = s.text.slice(atOpen.length);
    assert(beat.startsWith(':'), `the keepalive frame is an SSE comment (got ${JSON.stringify(beat)})`);
    assert(!/(^|\n)data:/.test(beat), 'and carries no data: line, so no client reads it as a block');
    assert(!/(^|\n)event:/.test(beat), 'and no event: line, so it reaches no addEventListener either');
  }

  // ==========================================================================
  group(`${label} — a real block still reaches every subscriber`);
  // ==========================================================================
  {
    /* The control. A cap that refused everybody and a heartbeat that replaced
     * the fan-out would both pass every other group in this file. */
    const s = await openOne();
    await s.until(t => t.includes(': connected'));
    await mineOne();
    await s.until(t => /(^|\n)data:/.test(t));
    const frame = /(?:^|\n)data: (.*)/.exec(s.text)[1];
    const summary = JSON.parse(frame);
    assert(typeof summary.height === 'number', `the block frame is the block summary (height ${summary.height})`);
  }

  // ==========================================================================
  group(`${label} — the cap is the node's, and it refuses rather than evicting`);
  // ==========================================================================
  {
    /* Filling to P.SSE_MAX_CLIENTS from where this suite already is, rather than
     * from zero, because the earlier groups' streams are still attached — which
     * is the situation the cap is actually about. */
    const first = open[0];
    while (clients().size < P.SSE_MAX_CLIENTS) await openOne();
    assert(clients().size === P.SSE_MAX_CLIENTS,
      `${P.SSE_MAX_CLIENTS} streams are attached, which is the configured ceiling`);

    const refused = await readWhole(base);
    assert(refused.status === 503, `the next subscriber is refused with 503 (got ${refused.status})`);
    assert(refused.headers['retry-after'] === '30', 'and is told when to come back');
    const body = JSON.parse(refused.text);
    assert(body.limit === P.SSE_MAX_CLIENTS, 'the body quotes the configured ceiling rather than a literal');

    /* THE ASSERTION THIS GROUP EXISTS FOR. Evicting the oldest subscriber to
     * admit a new one would let anybody disconnect everybody, which is a worse
     * failure than being told to come back. */
    assert(clients().size === P.SSE_MAX_CLIENTS, 'and no existing subscriber was dropped to make room');
    const alive = first.text;
    await mineOne();
    await first.until(t => t.length > alive.length);
    assert(true, 'the stream that was open first is still being written to');
  }

  // ==========================================================================
  group(`${label} — a slot comes back when a client goes away`);
  // ==========================================================================
  {
    const before = clients().size;
    open.pop().close();
    for (let i = 0; i < 200 && clients().size >= before; i++) await sleep(10);
    assert(clients().size === before - 1, `closing one stream frees exactly one slot (${before} → ${clients().size})`);

    const s = await openOne();
    assert(s.status === 200, `and the next subscriber is admitted again (got ${s.status})`);
  }

  for (const s of open) s.close();
  await sleep(50);
}

(async () => {
  console.log('\nHearth GET /events — bounded, heartbeated, and the heartbeat is invisible to a client\n');

  /* Short enough that the suite does not wait on the shipped 20 seconds, and the
   * shipped value is still what every assertion is written against — nothing
   * below names a number. Assigned rather than read from the environment because
   * SSE_HEARTBEAT_MS is deliberately not an operator knob; see params.js. */
  P.SSE_HEARTBEAT_MS = 50;

  // ==========================================================================
  // The account model (src/evmnode.js) — the node this estate runs and the one
  // the browser miner talks to.
  // ==========================================================================
  {
    const HDR = require('../src/chain/header');
    const POW = require('../src/pow');
    const secp = require('../src/crypto/secp256k1');
    const { EvmNode, keyFrom } = require('../src/evmnode');
    const C = require('./evm-common');

    const node = new EvmNode({ dataDir: path.join(dir, 'evm'), quiet: true, genesis: { target: C.EASY_TARGET } });
    node.listenRest(0);
    const port = await bound(node.restServer);
    const key = keyFrom(secp.randomPrivateKey());
    const pub = key.publicKey.toString('hex');

    await runTable({
      label: 'account model',
      base: `http://127.0.0.1:${port}`,
      clients: () => node.sseClients,
      /* Through `templates.submit`, not `chain.addBlock`, because the fan-out
       * hangs off the chain's `block` event and the point is that a real
       * submission reaches a subscriber. */
      async mineOne() {
        const t = node.templates.issue(pub);
        for (let nonce = 0; nonce < 2_000_000; nonce++) {
          const d = POW.homefireHash(POW.powSeed(t.coreHash, nonce, t.coinbasePub)).toString('hex');
          if (POW.meetsTarget(d, t.target)) {
            node.templates.submit({
              templateId: t.templateId, nonce, powDigest: d, powSig: HDR.signProof(d, key.privateKey),
            });
            await sleep(20);
            return;
          }
        }
        throw new Error('no nonce found');
      },
    });

    node.close();
  }

  // ==========================================================================
  // The UTXO node (src/rpc.js). Same module, same guarantees, different node —
  // and its `?app=` record filter has to survive being moved behind src/sse.js,
  // which is why the last group here asks for a filtered stream.
  // ==========================================================================
  {
    const CRYPTO = require('../src/crypto');
    const POW = require('../src/pow');
    const { Node } = require('../src/node');

    const node = new Node({ dataDir: path.join(dir, 'utxo'), quiet: true, p2pPort: 0 });
    node.rpc.listen(0);
    const port = await bound(node.rpc.server);
    const base = `http://127.0.0.1:${port}`;
    const key = node.wallet.keys[0];

    await runTable({
      label: 'utxo',
      base,
      clients: () => node.rpc.sseClients,
      async mineOne() {
        const t = node.templates.issue(key.pub);
        for (let nonce = 0; nonce < 2_000_000; nonce++) {
          const d = POW.homefireHash(POW.powSeed(t.coreHash, nonce, t.coinbasePub)).toString('hex');
          if (POW.meetsTarget(d, t.target)) {
            node.templates.submit({
              templateId: t.templateId, nonce, powDigest: d,
              powSig: CRYPTO.sign(key.priv, Buffer.from(d, 'hex')),
            });
            await sleep(20);
            return;
          }
        }
        throw new Error('no nonce found');
      },
    });

    group('utxo — the ?app= record filter survived the move into src/sse.js');
    {
      const s = await openStream(base, '/events?app=chat&key=ember1abc');
      await s.until(t => t.includes(': connected'));
      const [held] = node.rpc.sseClients;
      assert(held.cfApp === 'chat', `the stream remembers its application filter (got ${held.cfApp})`);
      assert(held.cfKey === 'ember1abc', `and its key filter (got ${held.cfKey})`);
      s.close();
    }

    node.rpc.server.close();
    if (node.p2p && node.p2p.close) node.p2p.close();
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
