#!/usr/bin/env node
'use strict';
/* hearth-mine — mine EMBER from an ordinary machine.
 *
 *   hearth-mine --url https://<host>
 *
 * WHAT THIS IS: A LIGHT MINER. It holds no chain, syncs nothing and opens no
 * ports. It asks a node for work over HTTP, grinds nonces, signs the winning
 * digest with a key only it holds, and posts the proof back:
 *
 *   GET  <url>/mining/template?pub=<65-byte uncompressed secp256k1 key>
 *   POST <url>/mining/submit   { templateId, nonce, powDigest, powSig }
 *
 * That is the whole program. It is deliberately not a node.
 *
 * WHY NOT A NODE. The obvious design is `hearthd --evm --mine --peer …`, and
 * that still exists and is still right for anyone who wants to validate the
 * chain themselves. But for someone who wants to mine on their Mac and their PC
 * it is all cost: half a gigabyte of chain per machine, a full validation of
 * every block, a P2P transport that has to reach them, and — since CloudsForge
 * is published from a home server behind a Cloudflare Tunnel — a transport that
 * a tunnel can carry. This needs none of it. It is HTTPS out, which works
 * through the tunnel today with no inbound port on the operator's machine.
 *
 * WHAT YOU GIVE UP, said plainly because it is the real trade: A LIGHT MINER
 * CANNOT VALIDATE THE CHAIN IT MINES ON. It does not know whether the parent is
 * real, whether the transactions are valid, or whether the endpoint is the
 * network everyone else is on. Point it at a node you trust — for the operator
 * that is their own seed. Run `hearthd` if you want to check for yourself.
 *
 * WHAT IT DOES NOT GIVE UP, because these are cheap and the failures are
 * expensive:
 *
 *   THE ENDPOINT CANNOT STEAL A BLOCK. The proof is signed over the winning
 *   digest by the coinbase key, which never leaves this machine, and
 *   `HDR.verifyPow` recovers that key and compares it to the header's coinbase.
 *   Work issued to you is redeemable only by you.
 *
 *   NOR CAN IT WASTE YOUR ELECTRICITY UNNOTICED. It could hand out work paying
 *   somebody else — every submission would then be refused, which costs you the
 *   same as theft and is much harder to see. So `verify()` below recomputes the
 *   core hash from the header fields the template carries and refuses to grind
 *   anything that does not commit to them, and refuses work that does not pay
 *   this machine's own coinbase.
 *
 *   NOR CAN A RETUNE SILENTLY WASTE IT. The template carries the proof-of-work
 *   parameters. If they are not this build's, the miner stops rather than
 *   producing proofs nothing will accept.
 *
 * AND THE OLDEST FAILURE OF ALL: mining to a key you do not control, or cannot
 * find out. The address is printed before the first hash, `--address` will tell
 * you without mining, the key file and its mode are named so it can be backed
 * up — and the key is never printed.
 */

const fs = require('fs');
const path = require('path');

// ---- arguments, parsed before anything loads chain parameters --------------
// `--network` reaches src/params.js only through the environment, and params
// resolves the chain id at require() time.

function parse(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': case '--node': o.url = next(); break;
      case '--data': o.dataDir = path.resolve(next()); break;
      case '--network': o.network = next(); break;
      case '--throttle': o.throttle = Number(next()); break;
      case '--status-ms': o.statusMs = Number(next()); break;
      case '--address': o.addressOnly = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) o.bad = a;
        else o.url = a;                       // `hearth-mine https://…` also works
    }
  }
  if (!o.url && process.env.HEARTH_MINE_URL) o.url = process.env.HEARTH_MINE_URL;
  if (!o.dataDir && process.env.HEARTH_DATA) o.dataDir = process.env.HEARTH_DATA;
  if (o.throttle === undefined && process.env.HEARTH_THROTTLE) o.throttle = Number(process.env.HEARTH_THROTTLE);
  return o;
}

const opts = parse(process.argv);

const HELP = `hearth-mine — mine EMBER against a Hearth node, over HTTP

  hearth-mine --url https://<host> [options]
  hearth-mine --address              print the address you would be paid at, and exit

Options
  --url URL         the node to take work from. Its REST API — the one that
                    serves /info and /mining/*. Required.
  --data DIR        where the coinbase key lives (default ./data)
  --network NAME    hearth (default, chain 7411) or hearth-testnet (7412)
  --throttle F      0..1, the share of a core to use (default 1.0 — all of it)
  --status-ms N     how often to print progress when stdout is not a terminal
  --quiet           only print blocks found and problems

This is a LIGHT miner: no chain, no sync, no open ports. It cannot validate the
chain it mines on, so point it at a node you trust. For a full validating node
that also mines, use:  hearthd --evm --mine --peer wss://p2p.<apex>/p2p

The reward is paid to the key in <data>/coinbase-key.json, created on first run.
Back that file up. Whoever holds it holds the coins.
`;

if (opts.help) { process.stdout.write(HELP); process.exit(0); }
if (opts.bad) { process.stderr.write(`hearth-mine: unknown option ${opts.bad}\n\n${HELP}`); process.exit(2); }
if (opts.network) process.env.HEARTH_NETWORK = opts.network;

let P, POW, HDR, loadCoinbaseKey, ember, SLICE_MS, schedule;
try {
  P = require('../src/params');
  POW = require('../src/pow');
  HDR = require('../src/chain/header');
  ({ loadCoinbaseKey, ember } = require('../src/evmnode'));
  ({ SLICE_MS, schedule } = require('../src/minerloop'));
} catch (e) {
  // An unregistered --network is the likely cause, and params.js says so well.
  process.stderr.write(`hearth-mine: ${e && e.message || e}\n`);
  process.exit(2);
}

const dataDir = opts.dataDir || path.join(process.cwd(), 'data');
const keyFile = path.join(dataDir, 'coinbase-key.json');

// ---- presentation ----------------------------------------------------------

const TTY = process.stdout.isTTY && !process.env.HEARTH_NO_TTY;
const C = TTY
  ? { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m` }
  : { dim: s => s, b: s => s, y: s => s, g: s => s, r: s => s };

const say = s => { clear(); process.stdout.write(s + '\n'); };
const num = n => n.toLocaleString('en-US');
function clock(ms) {
  const t = Math.floor(ms / 1000);
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map(v => String(v).padStart(2, '0')).join(':');
}
/** The number a miner watches more than any other. */
function rate(h) {
  if (h >= 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
  if (h >= 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
  if (h >= 1e3) return (h / 1e3).toFixed(2) + ' kH/s';
  return h + ' H/s';
}

// ---- --address: answer the question without mining -------------------------

if (opts.addressOnly) {
  const k = loadCoinbaseKey(dataDir);
  process.stdout.write(`\n  ${C.b(k.addressHex)}\n\n`);
  process.stdout.write(C.dim(`  every block you mine pays this address. The key is in ${keyFile} —\n`));
  process.stdout.write(C.dim('  back it up, and never share it or paste it anywhere.\n\n'));
  process.exit(0);
}

// ---- the refusal -----------------------------------------------------------

if (!opts.url) {
  process.stderr.write(`hearth-mine: no --url given, so there is nowhere to get work from.

  This is a light miner: it takes work from a node over HTTP and posts proofs
  back. It has no chain of its own, so there is nothing for it to mine alone.

      hearth-mine --url https://<host>

  If you want a full node that validates the chain AND mines it, that is a
  different program and it is already here:

      hearthd --evm --mine --peer wss://p2p.<apex>/p2p
`);
  process.exit(2);
}

const base = String(opts.url).replace(/\/+$/, '');
const key = loadCoinbaseKey(dataDir);
const pubHex = key.publicKey.toString('hex');
const throttle = opts.throttle === undefined ? 1.0 : opts.throttle;

// ---- banner ----------------------------------------------------------------

const keyIsNew = Date.now() - fs.statSync(keyFile).mtimeMs < 5000;
say('');
say(`  ${C.b('hearth-mine')} ${C.dim('·')} ${P.NETWORK} ${C.dim('·')} chain ${P.CHAIN_ID} ${C.dim('·')} ${P.COIN}`);
say('');
say(`  paid to    ${C.b(key.addressHex)}`);
say(`  key file   ${keyFile} ${C.dim(keyIsNew ? '(created just now — back it up)' : '(loaded)')}`);
say(`  work from  ${base}`);
say(`  throttle   ${throttle} ${C.dim(throttle >= 1 ? '(one full core)' : `(${Math.round(throttle * 100)}% of a core)`)}`);
say('');
say(C.dim('  a light miner does not validate the chain it mines on. Point it at a node you trust.'));
say('');

// ---- session state ---------------------------------------------------------

const t0 = Date.now();
let found = 0, stale = 0, refused = 0;
let hashes = 0, hashrate = 0, rateStart = Date.now();
let work = null;            // the template being ground
let height = 0;
let earnedWei = 0n;
let stopping = false;
let downSince = null;       // set while the endpoint is unreachable, so it is said once

// ---- the status line -------------------------------------------------------

let drawn = false;
function clear() { if (TTY && drawn) { process.stdout.write('\x1b[2K\r'); drawn = false; } }

function status() {
  if (opts.quiet) return;
  const parts = [
    work ? `hashing #${num(height)}` : C.y('waiting for work'),
    rate(hashrate),
    `found ${found}`,
    `earned ${ember(earnedWei)} ${P.COIN}`,
    clock(Date.now() - t0),
  ];
  if (stale) parts.push(C.dim(`${stale} stale`));
  const line = `  ${work ? '⛏ ' : '· '} ${parts.join(C.dim(' · '))}`;
  if (TTY) { process.stdout.write('\x1b[2K\r' + line); drawn = true; }
  else { process.stdout.write(line + '\n'); }
}

// ---- talking to the node ---------------------------------------------------

async function api(pathname, init) {
  const res = await fetch(base + pathname, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/**
 * Check a template before spending a single evaluation on it.
 *
 * The endpoint chooses the work, so this is the whole of what a light miner can
 * check for itself. It is not a formality: without it an endpoint can hand out
 * work paying its own coinbase, and the only symptom is that every submission is
 * refused — after the electricity has been spent.
 *
 * Returns an error string, or null when the work is ours to grind.
 */
function verify(t) {
  if (!t || typeof t !== 'object' || typeof t.templateId !== 'string') return 'the response is not a work template';
  if (typeof t.coreHash !== 'string' || !/^[0-9a-f]{64}$/.test(t.coreHash)) return 'the template carries no core hash';

  /* THE PROOF-OF-WORK PARAMETERS TRAVEL WITH THE WORK, and src/chain/miner.js
   * says why: a miner that hardcodes them keeps hashing happily after a retune
   * and produces nothing valid, while one that reads them stops — "which is the
   * failure you want". So stop. */
  if (t.scratchKiB !== undefined && t.scratchKiB !== P.POW_SCRATCH_KIB) {
    return `this node mines with a ${t.scratchKiB} KiB scratch pad and this build uses ${P.POW_SCRATCH_KIB} KiB `
      + '— different proof-of-work parameters, so nothing mined here would be accepted';
  }
  if (t.walkSteps !== undefined && t.walkSteps !== P.POW_WALK_STEPS) {
    return `this node walks ${t.walkSteps} steps and this build walks ${P.POW_WALK_STEPS} `
      + '— different proof-of-work parameters, so nothing mined here would be accepted';
  }

  // …and it must pay US.
  if (t.coinbasePub !== pubHex) return 'the work pays another coinbase key, not ours';
  if (t.coinbaseAddress && t.coinbaseAddress.toLowerCase() !== key.addressHex.toLowerCase()) {
    return `the work pays ${t.coinbaseAddress}, not ${key.addressHex}`;
  }

  /* And the core hash must actually COMMIT to all of that. Without this the two
   * checks above are only the endpoint's word for what it put in the header. */
  const fields = ['version', 'prevHash', 'height', 'timestamp', 'target', 'coinbasePub',
    'txRoot', 'stateRoot', 'receiptsRoot', 'logsBloom', 'gasLimit', 'gasUsed', 'extraData'];
  if (fields.some(f => t[f] === undefined)) {
    return 'the template does not carry the header fields its core hash is made of, '
      + 'so there is no way to check that the work pays us — the node is older than this miner';
  }
  let recomputed;
  const h = {};
  for (const f of fields) h[f] = t[f];
  try { recomputed = HDR.coreHash(h); }
  catch (e) { return `the header in the template is malformed: ${e && e.message || e}`; }
  if (recomputed !== t.coreHash) {
    return 'the core hash does not match the header it came with — the work we would grind is '
      + 'not the work we were shown';
  }
  return null;
}

/** Fetch and check work. Returns a template, or null having already said why. */
async function fetchWork() {
  let r;
  try {
    r = await api(`/mining/template?pub=${pubHex}`);
  } catch (e) {
    if (!downSince) {
      downSince = Date.now();
      say(C.y(`  ⚠ could not reach ${base} — ${String(e && e.message || e)}`));
      say(C.y('    will retry every few seconds. Nothing is being mined until it answers.'));
    }
    return null;
  }
  if (r.status !== 200) {
    if (!downSince) {
      downSince = Date.now();
      say(C.y(`  ⚠ ${base} answered HTTP ${r.status} for work — ${r.body && r.body.err || 'no reason given'}`));
      say(C.y('    will retry. Check that --url points at the REST API, the one that serves /info.'));
    }
    return null;
  }
  if (downSince) { say(C.g(`  ✓ ${base} is answering again`)); downSince = null; }

  const bad = verify(r.body);
  if (bad) {
    say('');
    say(C.r(`  ✗ refusing this work: ${bad}`));
    say(C.r('    Not grinding it. A proof made on work like this is refused after the'));
    say(C.r('    electricity has been spent, which costs the same as losing it.'));
    say('');
    stopping = true;
    return null;
  }
  height = r.body.height;
  return r.body;
}

async function submit(t, nonce, digest) {
  const powSig = HDR.signProof(digest, key.privateKey);
  let r;
  try { r = await api('/mining/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: t.templateId, nonce, powDigest: digest, powSig }),
  }); } catch (e) {
    say(C.y(`  ⚠ found a block but could not submit it — ${String(e && e.message || e)}`));
    return;
  }
  if (r.status === 200 && r.body.ok) {
    found++;
    /* `coinbaseReward`, NOT `reward`. The latter is the full subsidy the block
     * mints, 10% of which goes to the Commons — quoting it here made the running
     * total 10% higher than the coins actually held, which never reconciles
     * against a wallet. Falls back only for a node too old to send it. */
    const paid = BigInt(t.coinbaseReward !== undefined ? t.coinbaseReward : (t.reward || 0));
    earnedWei += paid;
    say(`  ${C.g('⛏  accepted')} block #${num(r.body.height)} ${C.dim(String(r.body.id || '').slice(0, 12))}`
      + ` · paid ${ember(paid)} ${P.COIN}`);
    return;
  }
  if (r.status === 409 || r.body.stale) {
    // Somebody else found this height first. Expected, and not an error.
    stale++;
    return;
  }
  refused++;
  say(C.y(`  ⚠ a proof was refused: ${r.body.err || 'HTTP ' + r.status}`));
  /* Once is bad luck. Repeatedly means the work is not what we think it is, and
   * continuing would burn a core for nothing. */
  if (refused >= 5) {
    say(C.r('    five refusals — stopping rather than mining into a wall.'));
    stopping = true;
  }
}

// ---- the loop --------------------------------------------------------------

/* Grinding yields on a slice of wall clock, exactly as the in-process miners do
 * (src/minerloop.js), because this process still has to run its HTTP calls, its
 * status line and its signal handlers. A fixed batch of nonces is a variable and
 * unbounded amount of blocked event loop when one nonce is a full evaluation. */
async function loop() {
  let nonce = 0;
  for (;;) {
    if (stopping) return;
    if (!work) {
      work = await fetchWork();
      nonce = 0;
      if (!work) { if (stopping) return; await new Promise(r => setTimeout(r, 3000)); continue; }
    }
    if (Date.now() > (work.expiresAt || 0) - 5000) { work = null; continue; }

    const t = work;
    const spent = await new Promise(resolve => {
      const t1 = Date.now();
      do {
        const digest = POW.homefireHash(POW.powSeed(t.coreHash, nonce, t.coinbasePub)).toString('hex');
        hashes++;
        if (POW.meetsTarget(digest, t.target)) {
          const n = nonce;
          nonce++;
          return resolve({ ms: Date.now() - t1, win: { nonce: n, digest } });
        }
        nonce++;
      } while (Date.now() - t1 < SLICE_MS);
      resolve({ ms: Date.now() - t1, win: null });
    });

    const dt = (Date.now() - rateStart) / 1000;
    if (dt >= 1) { hashrate = Math.round(hashes / dt); hashes = 0; rateStart = Date.now(); }

    if (spent.win) {
      await submit(t, spent.win.nonce, spent.win.digest);
      work = null;                             // always take fresh work after a win
      continue;
    }
    await new Promise(r => schedule(r, spent.ms, throttle));
  }
}

const statusMs = opts.statusMs || (TTY ? 1000 : 30_000);
const tick = setInterval(status, statusMs);
tick.unref();
status();

loop().catch(e => { say(C.r(`  ✗ ${String(e && e.message || e)}`)); stopping = true; });

function bye() {
  clearInterval(tick);
  clear();
  say('');
  say(`  stopped after ${clock(Date.now() - t0)} · found ${found} · earned ${ember(earnedWei)} ${P.COIN}`
    + (stale ? C.dim(` · ${stale} stale`) : ''));
  say(C.dim(`  paid to ${key.addressHex} — the key is in ${keyFile}`));
  say('');
  process.exit(0);
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

// A refusal must actually end the process, not leave it idling silently.
setInterval(() => { if (stopping) bye(); }, 250).unref();
