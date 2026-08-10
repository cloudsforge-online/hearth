'use strict';
/* Where the mining key comes from, and what it refuses to do.
 * Run: node test/coinbase-source.js
 *
 * WHY THIS FILE IS ADVERSARIAL, in the same way test/mine-keystore.js is. Every
 * failure this code can have pays money to somebody else, or to nobody:
 *
 *   A source that silently falls back to the plaintext file mines on the key an
 *   operator is in the middle of retiring, and looks completely healthy.
 *   A generated key where a configured one was expected mines, produces blocks,
 *   reports a hashrate and earns into an account nobody holds. That one is the
 *   worst available outcome and it announces itself with nothing at all.
 *   A key from an env var that stays in the environment is inherited by every
 *   child process for the life of the container.
 *
 * So most of what follows checks that something does NOT happen. Each group
 * names the mutation it was watched to fail under — a check that cannot fail is
 * worse than no check, and this repository has shipped several.
 *
 * NOTHING HERE PRINTS A PRIVATE KEY, including on failure. The assertions
 * compare addresses, which is the same proof the estate's key-backup rehearsal
 * uses (micro-org#206) and for the same reason: an address is public.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CB = require('../src/coinbase');
const KS = require('../src/mine/keystore');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
function throws(fn, re, msg) {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  if (!e) return assert(false, msg + ' (it did not throw)');
  return assert(re.test(String(e.message)), `${msg} — "${String(e.message).slice(0, 78)}"`);
}
const group = name => console.log('\n• ' + name);

const dirs = [];
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-cb-${tag}-`)); dirs.push(d); return d; };

const PASS = 'correct horse battery staple';

/** A key made here, so nothing in this file needs a real one. */
function aKey() { return CB.newKey(); }
const hexOf = k => '0x' + k.privateKey.toString('hex');

/** Write the historical plaintext shape. */
function writePlaintext(dir, key) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CB.KEY_FILE);
  fs.writeFileSync(file, JSON.stringify({
    warning: 'this is a mining key with spendable balance — back it up, do not share it',
    address: key.addressHex,
    privateKey: hexOf(key),
  }, null, 2) + '\n', { mode: 0o600 });
  return file;
}

console.log('\nHearth coinbase key sources\n');

// ============================================================================
group('each source resolves to the key that was put there');
// Watched to fail by having `fromEnvFile` return the env source's name: the
// address assertions all still passed and the provenance ones did not, which is
// why both are here.
// ============================================================================
{
  const key = aKey();

  const envDir = tmpdir('env');
  const env = { HEARTH_COINBASE_KEY: hexOf(key) };
  const r1 = CB.resolveCoinbaseKey(envDir, { env });
  assert(r1.key.addressHex === key.addressHex, `env: HEARTH_COINBASE_KEY derives ${key.addressHex}`);
  assert(r1.source === 'env' && r1.file === null, 'env: reported as the env source, with no file');
  assert(!fs.existsSync(path.join(envDir, CB.KEY_FILE)),
    'env: NOTHING was written to the data directory — the key never touches a disk');

  const fileDir = tmpdir('envfile');
  const secret = path.join(fileDir, 'secret.hex');
  fs.writeFileSync(secret, hexOf(key) + '\n', { mode: 0o600 });
  const r2 = CB.resolveCoinbaseKey(fileDir, { env: { HEARTH_COINBASE_KEY_FILE: secret } });
  assert(r2.key.addressHex === key.addressHex && r2.source === 'env-file', 'env-file: bare hex in a file, trailing newline and all');

  /* The coinbase-key.json shape through the same door, because that is what
   * makes "mount the existing key read-only somewhere else" a one-line first
   * step rather than a conversion. */
  const jsonSecretDir = tmpdir('envfilejson');
  const jsonSecret = path.join(jsonSecretDir, 'coinbase-key.json');
  writePlaintext(jsonSecretDir, key);
  const r3 = CB.resolveCoinbaseKey(tmpdir('empty1'), { env: { HEARTH_COINBASE_KEY_FILE: jsonSecret } });
  assert(r3.key.addressHex === key.addressHex, 'env-file: also takes the { address, privateKey } JSON the miner already writes');

  const ksDir = tmpdir('ks');
  KS.create(ksDir, PASS, hexOf(key));
  const r4 = CB.resolveCoinbaseKey(ksDir, { env: { HEARTH_COINBASE_PASSPHRASE: PASS } });
  assert(r4.key.addressHex === key.addressHex && r4.source === 'keystore', 'keystore: opened with the passphrase from the environment');

  const passFile = path.join(tmpdir('passfile'), 'pass');
  fs.writeFileSync(passFile, PASS + '\n', { mode: 0o600 });
  const r5 = CB.resolveCoinbaseKey(ksDir, { env: { HEARTH_COINBASE_PASSPHRASE_FILE: passFile } });
  assert(r5.key.addressHex === key.addressHex, 'keystore: and with the passphrase from a file, which is what a docker secret is');

  const ptDir = tmpdir('pt');
  writePlaintext(ptDir, key);
  const r6 = CB.resolveCoinbaseKey(ptDir, { env: {} });
  assert(r6.key.addressHex === key.addressHex && r6.source === 'plaintext', 'plaintext: the historical file still works, unchanged');
}

// ============================================================================
group('precedence is the order the header claims, and it is not alphabetical');
// Watched to fail by reordering SOURCES: with four distinct keys in one
// directory the wrong winner is unmissable, which is the only reason to set it
// up this way rather than testing pairs.
// ============================================================================
{
  const dir = tmpdir('prec');
  const kEnv = aKey(), kFile = aKey(), kKs = aKey(), kPt = aKey();
  const secret = path.join(dir, 'secret.hex');
  fs.writeFileSync(secret, hexOf(kFile), { mode: 0o600 });
  KS.create(dir, PASS, hexOf(kKs));
  writePlaintext(dir, kPt);

  const all = () => ({
    HEARTH_COINBASE_KEY: hexOf(kEnv),
    HEARTH_COINBASE_KEY_FILE: secret,
    HEARTH_COINBASE_PASSPHRASE: PASS,
  });

  assert(CB.resolveCoinbaseKey(dir, { env: all() }).source === 'env', 'env beats everything');
  const noEnv = all(); delete noEnv.HEARTH_COINBASE_KEY;
  assert(CB.resolveCoinbaseKey(dir, { env: noEnv }).source === 'env-file', 'env-file beats the keystore');
  const noFile = { HEARTH_COINBASE_PASSPHRASE: PASS };
  assert(CB.resolveCoinbaseKey(dir, { env: noFile }).source === 'keystore', 'the keystore beats the plaintext file');
  assert(CB.resolveCoinbaseKey(dir, { env: noFile }).key.addressHex === kKs.addressHex,
    'and it really is the keystore\'s key, not the plaintext one that sits beside it');
}

// ============================================================================
group('a keystore with no passphrase is an ERROR, never a fall-through');
// THE MOST IMPORTANT CHECK IN THIS FILE. Watched to fail by making fromKeystore
// return null when the passphrase is missing: every other check in this file
// still passed, and a miner mid-migration went straight back to mining on the
// plaintext key its operator believed had been retired, silently.
// ============================================================================
{
  const dir = tmpdir('nopass');
  const kKs = aKey(), kPt = aKey();
  KS.create(dir, PASS, hexOf(kKs));
  writePlaintext(dir, kPt);
  throws(() => CB.resolveCoinbaseKey(dir, { env: {} }), /no passphrase to open it/i,
    'a keystore present with no passphrase refuses rather than using the plaintext key beside it');
}

// ============================================================================
group('HEARTH_COINBASE_ADDRESS refuses to mine to an address nobody asked for');
// Watched to fail by comparing the two addresses without lowercasing: a
// checksummed pin then "mismatched" against its own key.
// ============================================================================
{
  const dir = tmpdir('pin');
  const key = aKey();
  writePlaintext(dir, key);

  const ok = CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_ADDRESS: key.addressHex } });
  assert(ok.key.addressHex === key.addressHex, 'a pin that matches is simply the key');
  const mixedCase = key.addressHex.slice(0, 2) + key.addressHex.slice(2).toUpperCase();
  assert(CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_ADDRESS: mixedCase } }).key.addressHex === key.addressHex,
    'and case in the pin is not a mismatch');

  const other = aKey();
  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_ADDRESS: other.addressHex } }),
    /pins .*Refusing to mine/is, 'a pin that does not match refuses, naming both addresses');
  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_ADDRESS: '0xnope' } }),
    /not an address/i, 'a pin that is not an address is caught before anything is opened');

  /* THE ACCIDENT THIS WHOLE MECHANISM EXISTS FOR: the mount did not come up, so
   * the data directory is empty. Without the pin a fresh key is created and
   * mined to, and the first symptom is a balance nobody can spend. */
  const empty = tmpdir('empty2');
  throws(() => CB.resolveCoinbaseKey(empty, { env: { HEARTH_COINBASE_ADDRESS: key.addressHex } }),
    /told not to make one/i, 'an EMPTY data directory under a pin refuses instead of generating a key');
  assert(fs.readdirSync(empty).length === 0, 'and it left nothing behind when it refused');
}

// ============================================================================
group('HEARTH_COINBASE_SOURCE consults that source and no other');
// Watched to fail by leaving `firstOf` in place when a source is pinned: the
// plaintext file kept being found and the refusals below all disappeared.
// ============================================================================
{
  const dir = tmpdir('pinned');
  const kPt = aKey();
  writePlaintext(dir, kPt);

  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_SOURCE: 'keystore' } }),
    /there is no keystore at/i, 'source=keystore with only a plaintext file refuses — it does not quietly use it');
  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_SOURCE: 'env' } }),
    /HEARTH_COINBASE_KEY is not set/i, 'source=env with nothing in the environment says exactly which variable is missing');
  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_SOURCE: 'nonsense' } }),
    /is not a source/i, 'a source that does not exist is rejected by name');

  const ks = tmpdir('pinnedks');
  const kKs = aKey();
  KS.create(ks, PASS, hexOf(kKs));
  writePlaintext(ks, kPt);
  const r = CB.resolveCoinbaseKey(ks, { env: { HEARTH_COINBASE_SOURCE: 'keystore', HEARTH_COINBASE_PASSPHRASE: PASS } });
  assert(r.key.addressHex === kKs.addressHex, 'source=keystore uses the keystore even with a plaintext file beside it');

  const fresh = tmpdir('pinnedfresh');
  throws(() => CB.resolveCoinbaseKey(fresh, { env: { HEARTH_COINBASE_SOURCE: 'plaintext' } }),
    /there is no key at/i, 'a pinned source never CREATES a key, not even the plaintext one');
  assert(fs.readdirSync(fresh).length === 0, 'and again, nothing was written');
}

// ============================================================================
group('the key does not stay in the environment it arrived in');
// Watched to fail by removing the `delete`: the variable was still readable
// afterwards, and so would be inherited by anything this process spawned.
// ============================================================================
{
  const key = aKey();
  const env = { HEARTH_COINBASE_KEY: hexOf(key) };
  CB.resolveCoinbaseKey(tmpdir('scrub'), { env });
  assert(env.HEARTH_COINBASE_KEY === undefined,
    'HEARTH_COINBASE_KEY is removed once read, so a child process does not inherit it');
}

// ============================================================================
group('malformed input is refused without saying what it was');
// Watched to fail by interpolating the offending value into the message, which
// is how a key reaches a log: the message named the SOURCE and the check below
// is what keeps it that way.
// ============================================================================
{
  const dir = tmpdir('bad');
  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_KEY: 'not-a-key' } }),
    /not 32 bytes of hex/i, 'a key that is not 32 bytes of hex is refused');
  let msg = '';
  try { CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_KEY: 'deadbeef'.repeat(7) } }); } catch (e) { msg = e.message; }
  assert(!/deadbeef/.test(msg), 'and the refusal does NOT quote the value it rejected');

  const short = path.join(dir, 'short.hex');
  fs.writeFileSync(short, 'abcd');
  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_KEY_FILE: short } }),
    /not 32 bytes of hex/i, 'nor is a truncated key file');
  throws(() => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_KEY_FILE: path.join(dir, 'absent') } }),
    /does not exist/i, 'a configured key file that is not there is an error, not a fall-through');
}

// ============================================================================
group('every refusal is tagged, so a container start prints a line not a stack');
// Watched to fail by dropping the code from one throw: hearthd then rethrew and
// compose showed a stack trace with the operator's answer buried in it.
// ============================================================================
{
  const dir = tmpdir('code');
  const cases = [
    () => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_SOURCE: 'keystore' } }),
    () => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_ADDRESS: '0x' + '11'.repeat(20) } }),
    () => CB.resolveCoinbaseKey(dir, { env: { HEARTH_COINBASE_KEY: 'x' } }),
  ];
  let tagged = 0;
  for (const fn of cases) { try { fn(); } catch (e) { if (e.code === CB.COINBASE_KEY_REFUSED) tagged++; } }
  assert(tagged === cases.length, `all ${cases.length} refusals carry code ${CB.COINBASE_KEY_REFUSED}`);
}

// ============================================================================
group('the historical behaviour still happens when nothing is configured');
// A developer's first `hearth-mine` must still work with no environment at all.
// ============================================================================
{
  const dir = tmpdir('first');
  const r = CB.resolveCoinbaseKey(dir, { env: {} });
  assert(r.created === true && r.source === 'plaintext', 'a first run with nothing configured still creates a key');
  assert(fs.existsSync(path.join(dir, CB.KEY_FILE)), 'in <data>/coinbase-key.json, where it always was');
  assert((fs.statSync(path.join(dir, CB.KEY_FILE)).mode & 0o777) === 0o600, 'at mode 600');
  const again = CB.resolveCoinbaseKey(dir, { env: {} });
  assert(again.key.addressHex === r.key.addressHex && again.created === false, 'and the next start finds the same key');

  const noDir = CB.resolveCoinbaseKey(null, { env: {} });
  assert(noDir.source === 'ephemeral' && noDir.file === null,
    'a caller with no data directory gets a key for this run only, exactly as before');
}

// ============================================================================
group('describeSources reports the layout without opening or leaking anything');
// ============================================================================
{
  const dir = tmpdir('desc');
  const key = aKey();
  KS.create(dir, PASS, hexOf(key));
  writePlaintext(dir, key);
  const d = CB.describeSources(dir, { HEARTH_COINBASE_PASSPHRASE_FILE: '/run/secrets/x', HEARTH_COINBASE_KEY: hexOf(key) });
  const by = n => d.sources.find(s => s.name === n);
  assert(by('keystore').present && by('plaintext').present, 'it sees both files');
  assert(by('keystore').passphrase === 'file', 'and reports WHERE the passphrase comes from');
  assert(JSON.stringify(d).indexOf(key.privateKey.toString('hex')) === -1,
    'and the whole report, serialised, contains no key material — only names and paths');
}

// ============================================================================
group('the sweep arithmetic, which is the one sum nobody should do by hand');
// Watched to fail by using `balance - gasPrice`: the 21000× error is invisible
// at a glance and the transaction is refused after a human has confirmed it.
// ============================================================================
{
  const { sweepValue } = require('../src/cli/wallet');
  const GWEI = 1000000000n;
  // The live numbers from micro-org#206, 2026-08-09: 2 gwei, 21000 gas.
  const balance = 47421445463215000000000n;
  const fee = 21000n * 2n * GWEI;
  assert(sweepValue(balance, 21000n, 2n * GWEI) === balance - fee,
    'a sweep sends the balance less exactly one fee, in integer wei');
  assert(sweepValue(balance, 21000n, 2n * GWEI) + fee === balance,
    'and value + fee is the balance to the wei — no dust left, nothing over-sent');
  throws(() => sweepValue(fee, 21000n, 2n * GWEI), /does not cover/i,
    'a balance exactly equal to the fee is refused rather than sending zero');
  throws(() => sweepValue(0n, 21000n, 2n * GWEI), /does not cover/i, 'and an empty account is refused');
  assert(sweepValue(fee + 1n, 21000n, 2n * GWEI) === 1n, 'one wei over the fee sends one wei');
}

// ============================================================================
group('`hearth minerkey`, driven the way an operator drives it');
// In-process rather than as a subprocess, because the thing worth checking is
// the EXIT CODE and the absence of key material in what it printed, and both
// are easier to hold onto here. test/miner-cli.js covers the other half — that
// a terminal is a feature only a user can test.
// ============================================================================
(async () => {
  const minerkey = require('../src/cli/minerkey');

  /** Run a command with a clean environment, and keep everything it printed. */
  async function run(argv, env = {}) {
    const saved = {};
    const names = ['HEARTH_DATA', 'HEARTH_COINBASE_PASSPHRASE', 'HEARTH_COINBASE_PASSPHRASE_FILE',
      'HEARTH_COINBASE_SOURCE', 'HEARTH_COINBASE_ADDRESS', 'HEARTH_COINBASE_KEY', 'HEARTH_COINBASE_KEY_FILE'];
    for (const n of names) { saved[n] = process.env[n]; delete process.env[n]; }
    Object.assign(process.env, env);
    const out = [];
    const log = console.log;
    console.log = (...a) => out.push(a.join(' '));
    let code;
    try { code = await minerkey.main(argv); }
    finally {
      console.log = log;
      for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    }
    return { code, out: out.join('\n') };
  }

  const key = aKey();
  const dir = tmpdir('cli');
  writePlaintext(dir, key);

  const sealed = await run(['seal', '--data', dir, '--json'], { HEARTH_COINBASE_PASSPHRASE: PASS });
  assert(sealed.code === 0, '`minerkey seal` succeeds against a plaintext key');
  assert(JSON.parse(sealed.out).address === key.addressHex,
    'and the sealed keystore holds the SAME address — which is the whole requirement, since the balance is at it');
  assert(fs.existsSync(path.join(dir, CB.KEYSTORE_FILE)), 'the keystore file is where the miner looks for it');
  assert(fs.existsSync(path.join(dir, CB.KEY_FILE)),
    'and the plaintext file is STILL THERE — deleting the operator\'s only copy of a funded key is not this command\'s call');
  assert(sealed.out.indexOf(key.privateKey.toString('hex')) === -1, 'nothing it printed contains the key');

  /* Sealing twice must refuse. `KS.create` already will not overwrite, and this
   * checks that the CLI does not find some other way to — replacing a keystore
   * that holds a funded key is how a balance disappears with no error at all. */
  let second = null;
  try { await run(['seal', '--data', dir], { HEARTH_COINBASE_PASSPHRASE: PASS }); }
  catch (e) { second = String(e.message); }
  assert(second !== null && /already exists/i.test(second), 'sealing a second time refuses rather than overwriting a funded keystore');

  const pass = await run(['verify', '--data', dir, '--address', key.addressHex],
    { HEARTH_COINBASE_SOURCE: 'keystore', HEARTH_COINBASE_PASSPHRASE: PASS });
  assert(pass.code === 0 && /PASS/.test(pass.out), '`minerkey verify` exits 0 when the keystore re-derives the pinned address');

  const other = aKey();
  const fail = await run(['verify', '--data', dir, '--address', other.addressHex],
    { HEARTH_COINBASE_SOURCE: 'keystore', HEARTH_COINBASE_PASSPHRASE: PASS });
  assert(fail.code === 1 && /FAIL/.test(fail.out), 'and exits 1 when it does not — an exit code, so it can gate a deploy');

  const rotated = tmpdir('rot');
  const made = await run(['new', '--data', rotated, '--json'], { HEARTH_COINBASE_PASSPHRASE: PASS });
  assert(made.code === 0, '`minerkey new` creates a fresh key');
  assert(!fs.existsSync(path.join(rotated, CB.KEY_FILE)),
    'and NO plaintext file is written — a rotated key has never existed in the clear on this machine');
  const rotAddr = JSON.parse(made.out).address;
  const rotCheck = await run(['verify', '--data', rotated, '--address', rotAddr],
    { HEARTH_COINBASE_SOURCE: 'keystore', HEARTH_COINBASE_PASSPHRASE: PASS });
  assert(rotCheck.code === 0, 'and the miner would resolve exactly that address from it');

  const status = await run(['status', '--data', dir, '--json'], { HEARTH_COINBASE_PASSPHRASE: PASS });
  const s = JSON.parse(status.out);
  assert(s.resolved.source === 'keystore' && s.resolved.address === key.addressHex,
    '`minerkey status` reports the keystore as the source in use');
  assert(status.out.indexOf(key.privateKey.toString('hex')) === -1, 'and prints no key material');

  // ---------------------------------------------------------------------------
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a temp dir */ } }
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
