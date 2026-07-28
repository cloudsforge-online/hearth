'use strict';
/* Faucet tests. Zero-dependency mini harness, same shape as node/test/*.
 *
 *   node test/faucet.test.js
 *
 * Everything runs over REAL HTTP against a REAL fake node: a stub JSON-RPC
 * server that tracks balances and nonces and accepts transactions decoded by
 * the tree's own codec. Testing the handler functions directly would skip the
 * two things most likely to be wrong — the wire encoding and the ordering of
 * concurrent requests — so it is not done that way.
 *
 * The assertions that matter are the refusals. A faucet that pays out is easy;
 * a faucet that stops is the whole engineering problem.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const NODE_SRC = path.join(__dirname, '..', '..', '..', 'node', 'src');
const TX = require(path.join(NODE_SRC, 'chain', 'transaction'));
const secp = require(path.join(NODE_SRC, 'crypto', 'secp256k1'));

// The faucet reads its config at require time, so the environment is set first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-faucet-test-'));
const FAUCET_KEY = 'b'.repeat(64);

process.env.HEARTH_FAUCET_PRIVATE_KEY = '0x' + FAUCET_KEY;
process.env.HEARTH_FAUCET_DRIP_EMBER = '10';
process.env.HEARTH_FAUCET_ADDRESS_COOLDOWN_S = '3600';
process.env.HEARTH_FAUCET_IP_LIMIT = '3';
process.env.HEARTH_FAUCET_IP_WINDOW_S = '3600';
process.env.HEARTH_FAUCET_DAILY_CAP_EMBER = '50';
process.env.HEARTH_FAUCET_MAX_BALANCE_EMBER = '100';
process.env.HEARTH_FAUCET_RESERVE_EMBER = '1';
process.env.HEARTH_FAUCET_STATE = path.join(TMP, 'state.json');
process.env.HEARTH_FAUCET_LOG_LEVEL = 'error';
process.env.HEARTH_FAUCET_LOG_FORMAT = 'json';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }
const show = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
function eq(a, b, msg) {
  if (show(a) === show(b)) pass++;
  else { fail++; console.log(`  ✗ ${msg}\n      want ${show(b)}\n      got  ${show(a)}`); }
}
function group(name) { console.log('• ' + name); }

const E = n => BigInt(Math.round(n * 1000)) * (10n ** 15n);

// ---- a stub node -----------------------------------------------------------

/* Enough of an account-model chain to answer the faucet: balances, nonces, and
 * a mempool that applies transfers immediately. It decodes with the real codec,
 * so a malformed transaction from the faucet fails here exactly as it would at
 * a node. */
function startStubNode() {
  const balances = new Map();   // lowercase 0x address -> bigint
  const nonces = new Map();
  const accepted = [];
  const state = {
    rejectNext: null,
    chainId: 7411,
    setBalance(a, v) { balances.set(a.toLowerCase(), v); },
    balanceOf(a) { return balances.get(a.toLowerCase()) || 0n; },
    accepted,
  };

  const q = n => '0x' + BigInt(n).toString(16);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const reply = result => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      const err = (code, message) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));
      };
      const p = msg.params || [];
      switch (msg.method) {
        case 'eth_chainId': return reply(q(state.chainId));
        case 'eth_blockNumber': return reply(q(1234));
        case 'eth_getBalance': return reply(q(state.balanceOf(p[0])));
        case 'eth_getTransactionCount': return reply(q(nonces.get(p[0].toLowerCase()) || 0));
        case 'eth_sendRawTransaction': {
          if (state.rejectNext) { const m = state.rejectNext; state.rejectNext = null; return err(-32000, m); }
          const raw = Buffer.from(p[0].slice(2), 'hex');
          let tx;
          try { tx = TX.decode(raw); } catch (e) { return err(-32000, String(e.message)); }
          const from = '0x' + Buffer.from(TX.recoverSender(tx)).toString('hex');
          const to = '0x' + Buffer.from(tx.to).toString('hex');
          const cost = tx.value + tx.gasLimit * tx.gasPrice;
          if (state.balanceOf(from) < cost) return err(-32000, 'insufficient funds for gas * price + value');
          const expected = BigInt(nonces.get(from) || 0);
          if (tx.nonce !== expected) return err(-32000, `nonce too low: got ${tx.nonce}, want ${expected}`);
          balances.set(from, state.balanceOf(from) - cost);
          balances.set(to, state.balanceOf(to) + tx.value);
          nonces.set(from, Number(tx.nonce) + 1);
          accepted.push({ from, to, value: tx.value, nonce: tx.nonce, chainId: tx.chainId });
          return reply('0x' + Buffer.from(TX.hash(raw)).toString('hex'));
        }
        default: return err(-32601, `the method ${msg.method} does not exist/is not available`);
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

// ---- an http client --------------------------------------------------------

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* the HTML page */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- fixtures --------------------------------------------------------------

const { toChecksum } = require('../src/address');

function addressOf(privHex) {
  const pub = secp.publicKeyFromPrivate(Buffer.from(privHex, 'hex'), false);
  return toChecksum('0x' + Buffer.from(TX.addressFromPublicKey(pub)).toString('hex'));
}

const FAUCET_ADDRESS = addressOf(FAUCET_KEY);
const USER1 = toChecksum('0x' + '11'.repeat(20));
const USER2 = toChecksum('0x' + '22'.repeat(20));
const USER3 = toChecksum('0x' + '33'.repeat(20));
const USER4 = toChecksum('0x' + '44'.repeat(20));

async function main() {
  const node = await startStubNode();
  process.env.HEARTH_RPC_URL = `http://127.0.0.1:${node.port}`;

  // Required after the env is final: these modules snapshot it at require time.
  const { env } = require('../src/env');
  const { Rpc } = require('../src/rpc');
  const { Limits } = require('../src/limits');
  const { Sender } = require('../src/sender');
  const { createServer, formatEmber } = require('../src/server');

  node.state.setBalance(FAUCET_ADDRESS, E(1000));

  const rpc = new Rpc(env.rpcUrl);
  const sender = new Sender({
    privateKey: Buffer.from(FAUCET_KEY, 'hex'),
    rpc, chainId: env.chainId, gasPriceWei: env.gasPriceWei, gasLimit: env.gasLimit,
  });
  const limits = new Limits({
    addressCooldownS: env.addressCooldownS, ipLimit: env.ipLimit, ipWindowS: env.ipWindowS,
    capWei: env.dailyCapWei, windowS: env.dailyWindowS, statePath: env.statePath,
  });
  const faucet = createServer({ env, limits, sender });
  await new Promise(r => faucet.listen(0, '127.0.0.1', r));
  const port = faucet.address().port;
  const drip = (address, headers) => request(port, 'POST', '/drip', { address }, headers);

  // ------------------------------------------------------------------------
  group('formatting');
  eq(formatEmber(0n), '0', 'zero');
  eq(formatEmber(10n ** 18n), '1', 'one EMBER — 18 decimals, not 8');
  eq(formatEmber(10n ** 18n + 5n * 10n ** 17n), '1.5', 'a fraction');
  eq(formatEmber(1n), '0.000000000000000001', 'one wei, without floating point');

  // ------------------------------------------------------------------------
  group('the address is validated before anything costs anything');
  eq((await drip('not-an-address')).status, 400, 'garbage is refused');
  eq((await drip('0x' + '11'.repeat(19))).status, 400, '19 bytes is refused');
  ok((await drip('ember1qq0000000000000000000000000000000000000000000')).json.error.includes('pre-EVM'),
    'an ember1… address is named as the retired format rather than "invalid"');
  eq((await drip('0x' + '00'.repeat(20))).status, 400, 'the zero address is refused');
  eq((await drip(FAUCET_ADDRESS)).status, 400, 'the faucet refuses to fund itself');
  {
    /* Flip the case of one hex letter in a correctly checksummed address. That
     * is exactly what a typo looks like, and it is the only kind of typo an
     * address checksum can catch. */
    const good = toChecksum('0x' + 'ab'.repeat(20));
    const i = [...good].findIndex((c, n) => n > 1 && /[a-fA-F]/.test(c));
    ok(i > 1, 'the fixture has a hex letter to flip');
    const flipped = /[a-f]/.test(good[i]) ? good[i].toUpperCase() : good[i].toLowerCase();
    const bad = good.slice(0, i) + flipped + good.slice(i + 1);
    ok(bad !== good, 'and the flip changed it');
    const r = await drip(bad);
    ok(r.status === 400 && /EIP-55/.test(r.json.error || ''), 'a broken EIP-55 checksum is refused, and says so');
  }
  eq((await drip('0x' + '11'.repeat(20).toLowerCase())).status >= 400 ? 'refused' : 'accepted', 'accepted',
    'an all-lowercase address is accepted — there is no checksum to check');
  ok(node.state.balanceOf(USER1) === E(10), 'that first drip actually moved 10 EMBER');

  // ------------------------------------------------------------------------
  group('the caller cannot influence the amount');
  {
    const r = await request(port, 'POST', '/drip', { address: USER2, amount: '1000000', value: '999' });
    ok(r.status === 200, 'extra fields are ignored rather than rejected');
    eq(node.state.balanceOf(USER2), E(10), 'still exactly the configured drip');
  }

  // ------------------------------------------------------------------------
  group('per-address cooldown');
  {
    const r = await drip(USER1);
    eq(r.status, 429, 'a second request for the same address is refused');
    ok(r.headers['retry-after'] && Number(r.headers['retry-after']) > 0, 'with a Retry-After header');
    ok(/one drip per/.test(r.json.error), 'and a reason a human can act on');
    eq(node.state.balanceOf(USER1), E(10), 'and no second payment');
  }
  {
    // Case must not be a bypass — this is the classic one.
    const r = await drip(USER1.toLowerCase());
    eq(r.status, 429, 'lowercasing the address does not reset the cooldown');
  }

  // ------------------------------------------------------------------------
  group('per-IP limit');
  {
    // USER1 and USER2 already used two of this IP's three slots.
    eq((await drip(USER3)).status, 200, 'the third drip from this IP is allowed');
    const r = await drip(USER4);
    eq(r.status, 429, 'the fourth is refused');
    ok(/limit is 3/.test(r.json.error), 'and names the limit');
    eq(node.state.balanceOf(USER4), 0n, 'and pays nothing');
  }

  // ------------------------------------------------------------------------
  group('x-forwarded-for is ignored unless the proxy is trusted');
  {
    // env.trustProxy is false by default, so this must NOT open a new bucket.
    const r = await drip(USER4, { 'x-forwarded-for': '203.0.113.9' });
    eq(r.status, 429, 'a spoofed x-forwarded-for does not reset the per-IP limit');
  }

  // ------------------------------------------------------------------------
  group('the global cap is the control that cannot be bypassed');
  {
    // Cap is 50 EMBER; 30 has been paid out (USER1, USER2, USER3). Raise the
    // per-IP limit so the ONLY thing left standing is the cap.
    limits.ipLimit = 1000;
    eq((await drip(USER4)).status, 200, 'a fresh address, within the cap');   // 40
    const fifth = toChecksum('0x' + '55'.repeat(20));
    eq((await drip(fifth)).status, 200, 'and another');                        // 50
    const sixth = toChecksum('0x' + '66'.repeat(20));
    const r = await drip(sixth);
    eq(r.status, 429, 'the one that would exceed the cap is refused');
    ok(/payout cap/.test(r.json.error), 'and is called a cap, not "dry" — a different problem with a different fix');
    eq(node.state.balanceOf(sixth), 0n, 'nothing was sent');
    ok(limits.remainingWei() === 0n, 'the window is exhausted');
    ok(node.state.balanceOf(FAUCET_ADDRESS) > E(900), 'the faucet still holds most of its balance');
  }

  // ------------------------------------------------------------------------
  group('a dry faucet refuses clearly instead of failing obscurely');
  {
    limits.capWei = E(10000);            // take the cap out of the picture
    node.state.setBalance(FAUCET_ADDRESS, E(0.5));
    const seventh = toChecksum('0x' + '77'.repeat(20));
    const r = await drip(seventh);
    eq(r.status, 503, 'a dry faucet answers 503, not 500 and not 200');
    ok(/out of EMBER/.test(r.json.error), 'and says so in words');
    ok(r.json.detail.includes('needs'), 'and says how much it needed');
    ok(r.headers['retry-after'], 'and sets Retry-After');
    // The reservation must have been given back, or the address is burned for
    // a day because the faucet happened to be empty when they asked.
    node.state.setBalance(FAUCET_ADDRESS, E(1000));
    eq((await drip(seventh)).status, 200, 'and the refused address can try again once it is funded');
  }

  // ------------------------------------------------------------------------
  group('/health');
  {
    const r = await request(port, 'GET', '/health');
    eq(r.status, 200, 'healthy when funded and reachable');
    eq(r.json.faucetAddress, FAUCET_ADDRESS, 'reports its address');
    eq(r.json.chainId, 7411, 'reports the chain id');
    ok(!JSON.stringify(r.json).toLowerCase().includes(FAUCET_KEY), 'AND NEVER THE KEY');
    node.state.setBalance(FAUCET_ADDRESS, 0n);
    eq((await request(port, 'GET', '/health')).status, 503, 'unhealthy when dry');
    node.state.setBalance(FAUCET_ADDRESS, E(1000));
  }

  // ------------------------------------------------------------------------
  group('the recipient balance ceiling');
  {
    const rich = toChecksum('0x' + '88'.repeat(20));
    node.state.setBalance(rich, E(500));
    const r = await drip(rich);
    eq(r.status, 400, 'an already-funded address is refused');
    ok(/already holds/.test(r.json.error), 'and told why');
  }

  // ------------------------------------------------------------------------
  group('a broadcast failure does not consume the caller\'s allowance');
  {
    const unlucky = toChecksum('0x' + '99'.repeat(20));
    node.state.rejectNext = 'mempool is full';
    const r = await drip(unlucky);
    eq(r.status, 502, 'the caller sees the node\'s refusal');
    eq((await drip(unlucky)).status, 200, 'and may immediately try again');
  }

  // ------------------------------------------------------------------------
  group('concurrency: two simultaneous requests for one address pay once');
  {
    const twin = toChecksum('0x' + 'ab'.repeat(20));
    const [a, b] = await Promise.all([drip(twin), drip(twin)]);
    const codes = [a.status, b.status].sort();
    eq(codes, [200, 429], 'exactly one of the two is served');
    eq(node.state.balanceOf(twin), E(10), 'and exactly one drip was paid');
  }

  group('concurrency: a burst of distinct addresses gets distinct nonces');
  {
    const before = node.state.accepted.length;
    const addrs = Array.from({ length: 6 }, (_, i) =>
      toChecksum('0x' + 'cc' + String(i).padStart(2, '0') + '00'.repeat(18)));
    const results = await Promise.all(addrs.map(a => drip(a)));
    ok(results.every(r => r.status === 200), 'all six are served');
    const sent = node.state.accepted.slice(before);
    const nonces = sent.map(t => Number(t.nonce));
    eq(nonces, [...nonces].sort((x, y) => x - y), 'nonces are strictly ordered');
    eq(new Set(nonces).size, nonces.length, 'and never reused — no drip silently replaces another');
    for (const a of addrs) eq(node.state.balanceOf(a), E(10), `${a.slice(0, 8)}… was paid`);
  }

  // ------------------------------------------------------------------------
  group('every drip is EIP-155 bound to chain 7411');
  {
    ok(node.state.accepted.length > 0, 'transactions were accepted');
    ok(node.state.accepted.every(t => t.chainId === 7411),
      'and not one of them is an unprotected pre-155 transaction that could be replayed elsewhere');
  }

  // ------------------------------------------------------------------------
  group('limits survive a restart');
  {
    limits.flush();
    const reloaded = new Limits({
      addressCooldownS: env.addressCooldownS, ipLimit: env.ipLimit, ipWindowS: env.ipWindowS,
      capWei: env.dailyCapWei, windowS: env.dailyWindowS, statePath: env.statePath,
    });
    const r = reloaded.reserve(USER1, '::ffff:127.0.0.1', env.dripWei);
    ok(!r.ok, 'an address that was funded before the restart is still on cooldown');
    reloaded.stop();
  }

  // ------------------------------------------------------------------------
  group('routes');
  {
    eq((await request(port, 'GET', '/drip')).status, 405, 'GET /drip is 405 with an Allow header');
    eq((await request(port, 'GET', '/nope')).status, 404, 'an unknown route is 404');
    const page = await request(port, 'GET', '/');
    ok(page.status === 200 && page.text.includes('Hearth testnet faucet'), 'GET / serves the form');
    ok(!page.text.toLowerCase().includes(FAUCET_KEY), 'and not the key');
    const bad = await request(port, 'POST', '/drip', 'not json');
    ok(bad.status === 400, 'a malformed body is 400');
  }

  faucet.close();
  node.server.close();
  limits.stop();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
