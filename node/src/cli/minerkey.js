'use strict';
/* `hearth minerkey` — the mining key's custody, without ever printing one.
 *
 * WHY THIS COMMAND EXISTS. cloudsforge-online/micro-org#206: on 2026-08-09 the
 * mainnet coinbase `0x980d…5b45` held 47,421.445463215 EMBER and its private key
 * was a 240-byte JSON file in the clear, bind-mounted read-write into the miner
 * container. Everything needed to fix that already existed in this repository —
 * src/mine/keystore.js has sealed a mining key under scrypt + AES-256-GCM since
 * app-desktop needed one — and none of it was reachable from a server. This is
 * the reach: four verbs, no network, no daemon.
 *
 *   status   which source would be used, and which address it pays
 *   seal     take the plaintext coinbase-key.json into an encrypted keystore
 *   new      a fresh key that is never written in the clear at all
 *   verify   does the configured key derive the address I expect? exit 0 or 1
 *
 * `hearth wallet` is deliberately NOT where these live even though it also
 * seals secp256k1 keys, and the separation is the point rather than an
 * oversight. A wallet's job is to SPEND; a miner's key must be present on a
 * machine whose job is to hash. Keeping them in two commands, two formats and
 * two directories means the mining host never has a reason to hold a keystore
 * that can pay anybody, and the machine that sweeps never has a reason to hold
 * a mining key. The one place they meet is on paper, in the owner's hands.
 *
 * WHAT NO VERB HERE DOES: print a private key, write one in the clear, put one
 * in an argv, or put one in an error message. `seal` reads a plaintext file it
 * was pointed at and never writes another; `new` generates into the sealed file
 * and the cleartext never exists outside memory. The proof that any of it
 * worked is an ADDRESS COMPARISON — the same proof the estate's key-backup
 * rehearsal uses, for the same reason: an address is public and a key is not,
 * and a check you can run in front of somebody is a check that gets run.
 */

const fs = require('fs');
const path = require('path');

const CB = require('../coinbase');
const KS = require('../mine/keystore');
const args = require('./args');
const ui = require('./ui');

const { c } = ui;

const USAGE = `hearth minerkey — the mining key, encrypted at rest

  hearth minerkey status [--data DIR]
      where the key would come from, and which address it pays. Opens the
      keystore only if it can; never prints a key.

  hearth minerkey seal [--data DIR] [--from FILE]
      encrypt an existing plaintext coinbase-key.json into
      <data>/coinbase-keystore.json. The plaintext file is LEFT WHERE IT IS —
      deleting somebody's only copy of a funded key on their behalf is not a
      tidiness this command is willing to perform.

  hearth minerkey new [--data DIR]
      a brand-new key, generated straight into the keystore. Nothing is ever
      written in the clear. Use this to ROTATE: the miner starts paying the new
      address on its next restart and the old balance stops accruing on a key
      that lives on a mining host.

  hearth minerkey verify --address 0x… [--data DIR]
      exit 0 if the configured key derives that address, 1 if it does not.
      This is the migration's proof, and it needs no key to be shown to anyone.

options
  --data DIR      the miner's data directory   (default $HEARTH_DATA or ./data)
  --from FILE     the plaintext key to seal    (default <data>/coinbase-key.json)
  --address 0x…   the address to check against
  --json          machine-readable output

environment
  HEARTH_COINBASE_PASSPHRASE_FILE   a path holding the keystore passphrase
  HEARTH_COINBASE_PASSPHRASE        the passphrase itself — readable by anything
                                    that can read this process's environment, so
                                    the _FILE form is the one to prefer
  HEARTH_COINBASE_SOURCE            env | env-file | keystore | plaintext
  HEARTH_COINBASE_ADDRESS           the address the key must derive, or refuse

docs/mining-key-custody.md is the runbook these verbs are the steps of.`;

const SPEC = {
  booleans: ['json', 'no-color'],
  strings: ['data', 'from', 'address'],
};

function dataDirOf(flags) {
  if (flags.data) return path.resolve(flags.data);
  if (process.env.HEARTH_DATA) return path.resolve(process.env.HEARTH_DATA);
  return path.join(process.cwd(), 'data');
}

/**
 * The passphrase, from the environment or from the terminal.
 *
 * `promptSecret`'s default env is HEARTH_PASSPHRASE, which belongs to the
 * WALLET. Reusing it here would mean one exported variable unlocking both a
 * mining key and a spending wallet, which is exactly the coupling this file's
 * header says not to have — so the env name is overridden to the coinbase one.
 */
function passphrase(prompt) {
  if (process.env.HEARTH_COINBASE_PASSPHRASE_FILE) {
    const file = process.env.HEARTH_COINBASE_PASSPHRASE_FILE;
    if (!fs.existsSync(file)) throw new Error(`HEARTH_COINBASE_PASSPHRASE_FILE points at ${file}, which does not exist`);
    return Promise.resolve(fs.readFileSync(file, 'utf8').replace(/\r?\n$/, ''));
  }
  return ui.promptSecret(prompt, { env: 'HEARTH_COINBASE_PASSPHRASE' });
}

/**
 * A NEW passphrase, confirmed once.
 *
 * A typo in something you never see is a keystore nobody can ever open, and the
 * money is as gone as if the file had been deleted. So it is typed twice — but
 * only when a human is typing it, since a script supplying it through the
 * environment cannot mistype it twice differently.
 */
async function newPassphrase() {
  const p1 = await passphrase('passphrase for the keystore (this is what protects the key): ');
  if (typeof p1 !== 'string' || p1.length < 8) throw new Error('the passphrase must be at least 8 characters');
  const fromEnv = process.env.HEARTH_COINBASE_PASSPHRASE !== undefined
    || process.env.HEARTH_COINBASE_PASSPHRASE_FILE !== undefined;
  if (!fromEnv && process.stdin.isTTY) {
    const p2 = await ui.promptSecret('confirm: ', { allowEnv: false });
    if (p1 !== p2) throw new Error('the two passphrases do not match');
  }
  return p1;
}

// ---------------------------------------------------------------------------

/**
 * What is where, and what it pays.
 *
 * Opening the resolved source is attempted but never required: a keystore whose
 * passphrase this shell does not have is a perfectly normal thing to be looking
 * at, and reporting the layout is useful on its own. So a failure to open is
 * REPORTED rather than thrown — with one exception, the pinned-address
 * mismatch, which is the one thing an operator ran this command to find out.
 */
function cmdStatus(flags) {
  const dir = dataDirOf(flags);
  const d = CB.describeSources(dir, process.env);

  let resolved = null;
  let problem = null;
  try {
    const r = CB.resolveCoinbaseKey(dir, { create: false });
    resolved = { source: r.source, file: r.file, address: r.key.addressHex };
  } catch (e) {
    problem = String(e && e.message || e);
  }

  if (flags.json) {
    console.log(ui.jsonStringify({
      dataDir: dir,
      pinnedSource: d.pinnedSource,
      expectedAddress: d.expectedAddress,
      sources: d.sources,
      resolved,
      problem,
    }));
    return resolved ? 0 : 1;
  }

  console.log(c.dim(dir));
  for (const s of d.sources) {
    const mark = s.present ? c.green('present') : c.dim('—      ');
    const extra = s.name === 'keystore' && s.present
      ? c.dim(s.passphrase ? `  passphrase from ${s.passphrase}` : '  no passphrase configured')
      : '';
    console.log(`  ${mark}  ${s.name.padEnd(9)}${s.file ? c.dim(' ' + s.file) : ''}${extra}`);
  }
  if (d.pinnedSource) console.log(c.dim(`  HEARTH_COINBASE_SOURCE pins "${d.pinnedSource}" — no other source is consulted`));
  if (d.expectedAddress) console.log(c.dim(`  HEARTH_COINBASE_ADDRESS pins ${d.expectedAddress}`));

  console.log('');
  if (resolved) {
    console.log(`  pays    ${c.bold(resolved.address)}`);
    console.log(`  from    ${resolved.source}${resolved.file ? c.dim(' ' + resolved.file) : ''}`);
  } else {
    console.log(`  ${c.red('cannot resolve a key')} — ${problem}`);
  }

  /* The warning that is the whole reason for micro-org#206. It fires whenever a
   * plaintext key exists, INCLUDING when a keystore has already been made and is
   * in use, because a sealed key beside a cleartext one is not sealed — it is
   * two copies, one of which is readable. */
  const plaintext = d.sources.find(s => s.name === 'plaintext');
  if (plaintext && plaintext.present) {
    console.log('');
    console.log(c.yellow(`  ⚠ ${plaintext.file} holds a private key in the clear.`));
    console.log(c.yellow('    Whoever reads that file can spend everything the address holds, for ever.'));
    console.log(c.dim('    `hearth minerkey seal` encrypts it; remove it only once a backup you have'));
    console.log(c.dim('    RESTORED FROM exists, and never before. docs/mining-key-custody.md.'));
  }
  return resolved ? 0 : 1;
}

/**
 * Plaintext file in, sealed keystore out, address unchanged.
 *
 * ADDRESS UNCHANGED is the entire requirement. The balance lives at an address;
 * only the key that derives it can move it. So this must produce a keystore for
 * the SAME key, and it proves it did by reopening the file it just wrote and
 * comparing addresses — not by trusting that the write worked.
 */
async function cmdSeal(flags) {
  const dir = dataDirOf(flags);
  const from = flags.from ? path.resolve(flags.from) : path.join(dir, CB.KEY_FILE);
  if (!fs.existsSync(from)) throw new Error(`no plaintext key at ${from} — nothing to seal`);
  const target = KS.keystorePath(dir);
  if (fs.existsSync(target)) {
    throw new Error(`a keystore already exists at ${target} — move it aside before writing another, `
      + 'or you will lose whatever the old one holds');
  }

  const pass = await newPassphrase();
  const key = KS.importPlaintext(dir, from, pass);

  // Reopen from disk. `create` returned the key it was given; this is the file.
  const reopened = KS.open(dir, pass);
  if (reopened.addressHex.toLowerCase() !== key.addressHex.toLowerCase()) {
    throw new Error('the keystore just written does not reopen to the same address — refusing to call this sealed');
  }

  if (flags.json) { console.log(ui.jsonStringify({ address: reopened.addressHex, keystore: target, plaintext: from })); return 0; }
  console.log(`${c.green('sealed')} ${c.bold(reopened.addressHex)}`);
  console.log(c.dim(`  from  ${from}`));
  console.log(c.dim(`  to    ${target}`));
  console.log('');
  console.log('  Checked by reopening the file and re-deriving the address, which is the only');
  console.log('  proof that does not involve showing anybody a key.');
  console.log('');
  console.log(c.yellow(`  ${from} is still there and still in the clear.`));
  console.log(c.dim('  Point the miner at the keystore and restart it BEFORE removing anything:'));
  console.log(c.dim('    HEARTH_COINBASE_SOURCE=keystore'));
  console.log(c.dim('    HEARTH_COINBASE_PASSPHRASE_FILE=<a path only this container can read>'));
  console.log(c.dim(`    HEARTH_COINBASE_ADDRESS=${reopened.addressHex}`));
  console.log(c.dim('  Then `hearth minerkey verify --address …` before the plaintext goes anywhere.'));
  return 0;
}

/**
 * A fresh key, straight into the keystore.
 *
 * THIS IS THE ROTATION VERB and it is worth being clear about what rotation can
 * and cannot do here. It cannot move a balance: coins sit at the address that
 * mined them and only that address's key can spend them, so a "rotation" that
 * changed the key would abandon the money, which is why micro-org#206 records
 * the coinbase as unrotatable. What it CAN do is change which address FUTURE
 * blocks pay. Do that and the old balance stops growing on a hot key, the new
 * key has never existed in the clear, and the old key is needed exactly once
 * more — offline, from a backup, to sweep — instead of being resident on a
 * mining host for ever.
 */
async function cmdNew(flags) {
  const dir = dataDirOf(flags);
  const target = KS.keystorePath(dir);
  if (fs.existsSync(target)) {
    throw new Error(`a keystore already exists at ${target} — move it aside before writing another, `
      + 'or you will lose whatever the old one holds');
  }
  const pass = await newPassphrase();
  const key = KS.create(dir, pass);
  const reopened = KS.open(dir, pass);
  if (reopened.addressHex.toLowerCase() !== key.addressHex.toLowerCase()) {
    throw new Error('the keystore just written does not reopen to the same address — refusing to call this sealed');
  }

  if (flags.json) { console.log(ui.jsonStringify({ address: reopened.addressHex, keystore: target })); return 0; }
  console.log(`${c.green('created')} ${c.bold(reopened.addressHex)}`);
  console.log(c.dim(`  sealed in ${target}`));
  console.log('');
  console.log('  This key has never existed in the clear on this machine and never will.');
  console.log(c.yellow('  The passphrase is not recoverable. Without it the file is 240 bytes of noise'));
  console.log(c.yellow('  and every block this address is ever paid is lost with it.'));
  console.log(c.dim('  Back up the file AND the passphrase, separately, and restore from the backup'));
  console.log(c.dim('  once before you let this address earn anything you would miss.'));
  return 0;
}

/**
 * The migration's proof: does the configured key derive the address I expect?
 *
 * Exit code is the answer, so it can be a step in a script, a healthcheck or a
 * pre-deploy gate. Nothing about the key is printed either way.
 */
function cmdVerify(flags) {
  const dir = dataDirOf(flags);
  const want = String(args.need(flags, 'address', 'the address the key must derive')).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) throw new args.UsageError('--address must be 0x followed by 40 hex characters');

  let got = null;
  let problem = null;
  try {
    const r = CB.resolveCoinbaseKey(dir, { create: false });
    got = { address: r.key.addressHex.toLowerCase(), source: r.source, file: r.file };
  } catch (e) {
    problem = String(e && e.message || e);
  }

  const ok = Boolean(got) && got.address === want;
  if (flags.json) { console.log(ui.jsonStringify({ ok, expected: want, got: got && got.address, source: got && got.source, problem })); return ok ? 0 : 1; }
  if (!got) { console.log(`${c.red('FAIL')}  ${want}  ${problem}`); return 1; }
  console.log(`${ok ? c.green('PASS') : c.red('FAIL')}  ${want}  ${ok ? `re-derived from ${got.source}` : `the ${got.source} key derives ${got.address}`}`);
  return ok ? 0 : 1;
}

async function main(argv) {
  const { flags, positional } = args.parse(argv, SPEC);
  if (flags['no-color']) ui.setColour(false);
  const sub = positional.shift();
  if (flags.help || !sub) { console.log(USAGE); return flags.help ? 0 : 2; }

  switch (sub) {
    case 'status': return cmdStatus(flags);
    case 'seal': return cmdSeal(flags);
    case 'new': return cmdNew(flags);
    case 'verify': return cmdVerify(flags);
    default:
      throw new args.UsageError(`unknown minerkey command "${sub}" — try one of: status, seal, new, verify`);
  }
}

module.exports = { main, USAGE, dataDirOf };
