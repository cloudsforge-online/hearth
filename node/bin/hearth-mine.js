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
 *
 * WHERE THE LOOP LIVES. Not here any more. Everything above describes behaviour
 * that app-desktop needs too, and the only ways to give it that were to scrape
 * this program's status line or to write the loop a second time. So the loop is
 * src/mine/session.js and this file is its terminal: it parses arguments, loads
 * the key, and renders the session's events. The checks, the throttling and the
 * back-off are all still exactly one implementation — test/mine-session.js holds
 * it to them directly, and test/miner-cli.js still drives THIS program as a
 * process, because a status line is a feature and only a user can be its test.
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

let P, loadCoinbaseKey, ember, MineSession;
try {
  P = require('../src/params');
  ({ loadCoinbaseKey, ember } = require('../src/coinbase'));
  ({ MineSession } = require('../src/mine/session'));
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

// ---- session state, and the terminal that renders it ------------------------

/* Everything below is PRESENTATION. The loop, the checks, the back-off and the
 * give-up rule are src/mine/session.js; this file's whole remaining job is to
 * turn its events into the two things a miner actually asks a terminal for —
 * "is it working" and "what have I earned" — and to say plainly when it stops. */

const t0 = Date.now();
const session = new MineSession({ url: base, key, throttle });

let drawn = false;
function clear() { if (TTY && drawn) { process.stdout.write('\x1b[2K\r'); drawn = false; } }

function status() {
  if (opts.quiet) return;
  const s = session.stats();
  const parts = [
    s.working ? `hashing #${num(s.height)}` : C.y('waiting for work'),
    rate(s.hashrate),
    `found ${s.found}`,
    `earned ${ember(BigInt(s.earnedWei))} ${P.COIN}`,
    clock(Date.now() - t0),
  ];
  if (s.stale) parts.push(C.dim(`${s.stale} stale`));
  const line = `  ${s.working ? '⛏ ' : '· '} ${parts.join(C.dim(' · '))}`;
  if (TTY) { process.stdout.write('\x1b[2K\r' + line); drawn = true; }
  else { process.stdout.write(line + '\n'); }
}

session.on('accepted', a => {
  say(`  ${C.g('⛏  accepted')} block #${num(a.height)} ${C.dim(String(a.id).slice(0, 12))}`
    + ` · paid ${ember(BigInt(a.paidWei))} ${P.COIN}`);
});

session.on('unreachable', u => {
  say(C.y(`  ⚠ ${u.err}`));
  say(C.y('    will retry every few seconds. Nothing is being mined until it answers.'));
  if (u.status) say(C.y('    Check that --url points at the REST API, the one that serves /info.'));
});
session.on('reachable', u => say(C.g(`  ✓ ${u.url} is answering again`)));

session.on('throttled', t => {
  if (t.kind === 'submit') say(C.y('  ⚠ the node is rate-limiting proof submissions — retrying'));
});

session.on('lost', l => say(C.y(`  ⚠ ${l.err}`)));
session.on('refused', r => say(C.y(`  ⚠ a proof was refused: ${r.err}`)));

/* The refusal that ends the run. It is worth four lines rather than one: the
 * user is about to stop earning, and the difference between "your node retuned"
 * and "that endpoint is paying somebody else" is the difference between waiting
 * and changing --url. */
session.on('badwork', b => {
  say('');
  say(C.r(`  ✗ refusing this work: ${b.err}`));
  say(C.r('    Not grinding it. A proof made on work like this is refused after the'));
  say(C.r('    electricity has been spent, which costs the same as losing it.'));
  say('');
});
session.on('error', e => say(C.r(`  ✗ ${e.err}`)));

const statusMs = opts.statusMs || (TTY ? 1000 : 30_000);
const tick = setInterval(status, statusMs);
tick.unref();
status();

let said = false;
function bye(reason) {
  if (said) return;
  said = true;
  clearInterval(tick);
  clear();
  const s = session.stats();
  if (reason && /refus/i.test(reason)) say(C.r(`    ${reason}.`));
  say('');
  say(`  stopped after ${clock(Date.now() - t0)} · found ${s.found} · earned ${ember(BigInt(s.earnedWei))} ${P.COIN}`
    + (s.stale ? C.dim(` · ${s.stale} stale`) : ''));
  say(C.dim(`  paid to ${key.addressHex} — the key is in ${keyFile}`));
  say('');
  process.exit(0);
}

session.run().then(bye, e => { say(C.r(`  ✗ ${String(e && e.message || e)}`)); bye('error'); });

/* Ctrl-C asks the loop to wind up rather than killing the process, so the
 * summary is printed from one place whatever ended the run. `run()` resolves
 * within one slice — 25 ms — so this is not a wait anybody notices. */
process.on('SIGINT', () => session.stop('asked to stop'));
process.on('SIGTERM', () => session.stop('asked to stop'));
