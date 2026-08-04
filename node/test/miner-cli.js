'use strict';
/* The command-line miner, driven as a user drives it: as a process.
 * Run: node test/miner-cli.js
 *
 * WHAT IT IS. `hearth-mine` is a LIGHT miner. It holds no chain, opens no ports
 * and syncs nothing: it asks a node for work over HTTP (`GET /mining/template`),
 * grinds nonces, signs the winning digest with a key only it holds, and posts
 * the proof back (`POST /mining/submit`). That is the whole program. A full
 * validating node that also mines is still `hearthd --evm --mine`, and the
 * refusal below points at it.
 *
 * WHY HTTP RATHER THAN P2P. It works through the Cloudflare Tunnel the estate is
 * published behind with no new transport, no inbound port on the operator's Mac
 * or PC, and no half-gigabyte of chain on a laptop.
 *
 * THE FAILURES THIS FILE IS ABOUT, and every one of them is silent by nature:
 *
 *   MINING TO A KEY YOU DO NOT CONTROL, or to an address you cannot find out.
 *   The address is printed before any hashing starts, `--address` will tell you
 *   without mining, the key file and its permissions are named so it can be
 *   backed up, and the key itself never reaches a terminal or a log.
 *
 *   MINING WORK THAT IS NOT YOURS. This is new with the light design and it is
 *   the price of not holding the chain: the endpoint chooses the work. It cannot
 *   STEAL a block — the proof is signed by the coinbase key and `verifyPow`
 *   recovers it (src/chain/header.js) — but it can hand out work that pays
 *   someone else, and you would grind for hours and have every submission
 *   refused. So the miner VERIFIES the work before spending a cycle on it: it
 *   recomputes the core hash from the header fields the template carries and
 *   requires it to match the one it was told to grind. Three sections below are
 *   about lying endpoints.
 *
 *   MINING WORK NOTHING WILL ACCEPT. The template carries the proof-of-work
 *   parameters precisely so a miner stops when they change instead of hashing
 *   happily forever (src/chain/miner.js says so). It has to actually stop.
 *
 *   PRINTING NOTHING FOR AN HOUR, which is indistinguishable from a crash.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const HDR = require('../src/chain/header');
const { ember } = require('../src/evmnode');

const BIN = path.join(__dirname, '..', 'bin', 'hearth-mine.js');
const HEARTHD = path.join(__dirname, '..', 'bin', 'hearthd.js');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const dirs = [];
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-mine-${tag}-`)); dirs.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const procs = [];
const servers = [];
function start(cmd, args) {
  const p = spawn(process.execPath, [cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  p.out = '';
  p.stdout.on('data', d => { p.out += d; });
  p.stderr.on('data', d => { p.out += d; });
  return p;
}

function run(args, ms = 25000) {
  return new Promise(res => {
    const p = start(BIN, args);
    const t = setTimeout(() => { p.kill('SIGKILL'); res({ code: null, out: p.out, timedOut: true }); }, ms);
    p.on('exit', code => { clearTimeout(t); res({ code, out: p.out }); });
  });
}

async function until(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(200);
  }
}

const get = url => fetch(url).then(r => r.json());
const listen = srv => new Promise(res => { servers.push(srv); srv.listen(0, '127.0.0.1', () => res(srv.address().port)); });

const ADDR = /0x[0-9a-f]{40}/;

/* A reverse proxy that terminates HTTP and re-issues the request, which is what
 * a Cloudflare Tunnel and Traefik both do. Mining through one is the claim. */
function proxy(to) {
  return listen(http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: to, path: req.url, method: req.method, headers: req.headers },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  }));
}

(async () => {
  console.log('\nHearth command-line miner\n');

  // ==========================================================================
  group('it tells you which address it mines to, before it mines anything');
  // ==========================================================================
  const dirA = tmpdir('a');
  const first = await run(['--address', '--data', dirA]);
  assert(first.code === 0, '--address exits 0');
  const addr = (first.out.match(ADDR) || [])[0];
  assert(!!addr, `and prints an address (${addr || first.out.trim().slice(0, 80)})`);

  const keyFile = path.join(dirA, 'coinbase-key.json');
  assert(fs.existsSync(keyFile), 'a coinbase key was created in the data directory');
  assert((fs.statSync(keyFile).mode & 0o777) === 0o600, 'readable only by its owner (mode 600)');

  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const priv = String(key.privateKey).replace(/^0x/, '');
  assert(!first.out.includes(priv),
    'AND THE PRIVATE KEY IS NOT PRINTED — not even by the command whose job is to show the key\'s address');
  assert(first.out.includes(keyFile) || first.out.includes('coinbase-key.json'),
    'the output says where the key lives, so it can be backed up');
  assert(key.address.toLowerCase() === addr.toLowerCase(), 'the address printed is the address in the key file');

  const second = await run(['--address', '--data', dirA]);
  assert((second.out.match(ADDR) || [])[0] === addr,
    'a second run prints the SAME address — the key is loaded, not silently regenerated');

  // ==========================================================================
  group('it refuses to mine into nothing');
  // ==========================================================================
  const noUrl = await run(['--data', tmpdir('b')]);
  assert(noUrl.code === 2, 'with no --url it exits 2 rather than starting');
  assert(/--url/.test(noUrl.out), 'and names the option it needs');
  assert(/hearthd/.test(noUrl.out),
    'and points at `hearthd --evm --mine` for the full-node case, so the refusal is not a dead end');

  // ==========================================================================
  group('END TO END: mining a real node through an HTTP proxy');
  // ==========================================================================
  const REST = 19645, JRPC = 19546;
  const dirSeed = tmpdir('seed');
  const seed = start(HEARTHD, ['--evm', '--data', dirSeed, '--p2p', '0',
    '--rpc', String(REST), '--jsonrpc', String(JRPC)]);
  assert(await until(async () => (await get(`http://127.0.0.1:${REST}/info`).catch(() => null)) !== null, 30000),
    'a node is up and serving the REST API');
  const proxyPort = await proxy(REST);

  const dirM = tmpdir('m');
  const miner = start(BIN, ['--url', `http://127.0.0.1:${proxyPort}`, '--data', dirM, '--status-ms', '500']);
  const minerAddr = await until(() => ADDR.test(miner.out), 20000) ? miner.out.match(ADDR)[0] : null;
  assert(!!minerAddr, `the miner prints the address it will be paid at (${minerAddr})`);
  assert(await until(() => miner.out.includes(String(proxyPort)), 10000), 'and the endpoint it is mining against');

  assert(await until(async () => (await get(`http://127.0.0.1:${REST}/info`)).height >= 2, 180000),
    'THE NODE\'S HEIGHT CLIMBS — this machine\'s proofs were accepted over plain HTTP');

  const info = await get(`http://127.0.0.1:${REST}/info`);
  const block = await get(`http://127.0.0.1:${REST}/block/${info.height}`).catch(() => null);
  assert(info.height >= 2, `the node is at height ${info.height}`);
  assert(info.minerAddress.toLowerCase() !== minerAddr.toLowerCase(),
    'and it is NOT the node\'s own coinbase — the node is not mining, we are');

  assert(await until(() => /accepted|found/i.test(miner.out), 20000), 'the miner says what it has found');
  assert(await until(() => /earned|balance/i.test(miner.out), 30000), 'and what it has earned');
  /* …and the figure is what it was PAID, not what the block minted. 10% of every
   * subsidy goes to the Commons, so quoting the subsidy overstates a miner's
   * holdings by a tenth — a number that never reconciles against a wallet. */
  {
    const paid = (miner.out.match(/paid ([0-9.]+) EMBER/) || [])[1];
    const P2 = require('../src/params');
    const expect = [1, 2, 3].map(h => ember(P2.coinbaseRewardWei(h)));
    const subsidies = [1, 2, 3].map(h => ember(P2.subsidyWei(h)));
    assert(!!paid && expect.includes(paid),
      `an accepted block is reported at what the coinbase is PAID (${paid}), not what the block mints`);
    assert(!!paid && !subsidies.includes(paid),
      `and that is a different number from the subsidy (${subsidies[0]}) — the Commons share is not the miner's`);
  }
  const mkey = JSON.parse(fs.readFileSync(path.join(dirM, 'coinbase-key.json'), 'utf8'));
  assert(!miner.out.includes(mkey.privateKey.replace(/^0x/, '')), 'and never prints its private key while running');

  // the whole premise: no listening sockets at all
  const listeners = String(require('child_process').execSync(
    `lsof -nP -a -p ${miner.pid} -iTCP -sTCP:LISTEN 2>/dev/null || true`)).trim();
  assert(listeners === '', 'the miner opens NO listening port — nothing has to reach it');
  void block;

  // ==========================================================================
  group('it keeps talking even when it finds nothing');
  // ==========================================================================
  {
    const before = miner.out.length;
    await sleep(2500);
    const lines = miner.out.slice(before).split('\n').filter(l => /hashing|H\/s/i.test(l)).length;
    assert(lines >= 3, `it printed progress ${lines} times in two and a half seconds`);
  }
  miner.kill('SIGKILL');

  // ==========================================================================
  group('a lying endpoint costs it nothing');
  // ==========================================================================
  /* The price of not holding the chain is that the endpoint chooses the work.
   * It cannot steal a block — the proof is signed by the coinbase key — but it
   * can hand out work that pays somebody else, and a miner that does not check
   * would grind for hours and have every submission refused with no idea why. */
  let doctor = t => t;
  const realWork = async pub => get(`http://127.0.0.1:${REST}/mining/template?pub=${pub}`);
  const liar = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mining/template') {
      const t = doctor(await realWork(url.searchParams.get('pub')));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(t));
    }
    res.writeHead(404).end('{}');
  });
  const liarPort = await listen(liar);

  /** Run the miner against the liar for a moment and return everything it said. */
  async function against(mangle, tag) {
    doctor = mangle;
    const r = await run(['--url', `http://127.0.0.1:${liarPort}`, '--data', tmpdir(tag), '--status-ms', '400'], 12000);
    return r.out;
  }

  {
    // Work whose core hash does not commit to the header it came with. This is
    // the general case: whatever was substituted, the hash no longer matches.
    const out = await against(t => ({ ...t, coreHash: 'ab'.repeat(32) }), 'liar1');
    assert(/core hash|does not match|refus/i.test(out),
      'work whose core hash does not commit to its own header is refused');
    assert(!/H\/s/.test(out) || /refus|stopped/i.test(out), 'and it does not settle in to grind it anyway');
  }
  {
    // Work that pays a different coinbase, with a core hash that is consistent
    // with it — the version a careless check would miss.
    const other = Buffer.from('04' + '11'.repeat(64), 'hex').toString('hex');
    const out = await against(t => {
      const h = {
        version: t.version, prevHash: t.prevHash, height: t.height, timestamp: t.timestamp,
        target: t.target, coinbasePub: other, txRoot: t.txRoot, stateRoot: t.stateRoot,
        receiptsRoot: t.receiptsRoot, logsBloom: t.logsBloom, gasLimit: t.gasLimit,
        gasUsed: t.gasUsed, extraData: t.extraData,
      };
      let coreHash = t.coreHash;
      try { coreHash = HDR.coreHash(h); } catch { /* the point is the coinbase, not the hash */ }
      return { ...t, coinbasePub: other, coinbaseAddress: '0x' + '11'.repeat(20), coreHash };
    }, 'liar2');
    assert(/coinbase|pays|not (our|your|mine)/i.test(out),
      'work whose coinbase is somebody else\'s is refused, even when its core hash is consistent');
  }
  {
    // The template carries the PoW parameters so a miner STOPS when they change
    // rather than hashing happily and producing nothing valid.
    const out = await against(t => ({ ...t, scratchKiB: P.POW_SCRATCH_KIB * 2 }), 'liar3');
    assert(/parameter|scratch|retun|different/i.test(out),
      'work built with different proof-of-work parameters is refused rather than ground');
  }
  {
    /* …and an endpoint that is simply not there is a message, not a stack trace.
     * (`.out`, not the result object: written as `run(...)` this read
     * "[object Object]", so the stack-trace assertion below could not fail and
     * the two after it always did. A check that cannot fail is worse than no
     * check, and this is what one looks like.) */
    const out = (await run(['--url', 'http://127.0.0.1:1', '--data', tmpdir('down'), '--status-ms', '400'], 9000)).out;
    assert(!/at Object\.|at process\./.test(out), 'an unreachable endpoint does not print a stack trace');
    assert(/could not|unreachable|refused|failed/i.test(out), 'it says the endpoint could not be reached');
    assert(/retry|again/i.test(out), 'and that it will keep trying');
  }

  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const s of servers) { try { s.close(); } catch { /* gone */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('\nFAIL —', e);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const s of servers) { try { s.close(); } catch { /* gone */ } }
  process.exit(1);
});
