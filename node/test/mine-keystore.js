'use strict';
/* The desktop mining key: what actually protects it, checked rather than claimed.
 * Run: node test/mine-keystore.js
 *
 * WHY THIS FILE IS ADVERSARIAL. Every failure a keystore can have is silent. A
 * wrong passphrase that "works" gives you a different key and mines to an
 * address you do not control. A tampered file that decrypts gives you the same.
 * A cleartext label the app trusts shows you an address that is not the one
 * being paid. A truncated write leaves nothing at all. None of these announce
 * themselves; the user finds out when the money is not there.
 *
 * So the checks below are mostly about things NOT happening, and each one was
 * watched to fail before it was believed — the note on each group says with what
 * mutation. A check that cannot fail is worse than no check, and this repository
 * has shipped several.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KS = require('../src/mine/keystore');
const { keyFrom, loadCoinbaseKey } = require('../src/coinbase');

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
  return assert(re.test(String(e.message)), `${msg} — "${String(e.message).slice(0, 70)}"`);
}
const group = name => console.log('\n• ' + name);

const dirs = [];
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-ks-${tag}-`)); dirs.push(d); return d; };

const PASS = 'correct horse battery staple';

console.log('\nHearth desktop keystore\n');

// ============================================================================
group('it opens with the right passphrase and only the right passphrase');
// Watched to fail by returning `keyFrom(dk)` from decrypt() regardless of the
// GCM tag — the roundtrip check still passed and the wrong-passphrase one did
// not, which is the whole point of having both.
// ============================================================================
{
  const dir = tmpdir('a');
  const made = KS.create(dir, PASS);
  const opened = KS.open(dir, PASS);
  assert(opened.addressHex === made.addressHex, `the key that comes out is the key that went in (${made.addressHex})`);
  assert(opened.privateKey.equals(made.privateKey), 'byte for byte, not merely the same address');
  assert(opened.publicKey.length === 65 && opened.publicKey[0] === 4,
    'and its public key is the 65-byte UNCOMPRESSED form the node requires of a coinbase');

  throws(() => KS.open(dir, PASS + 'x'), /wrong passphrase|altered/i, 'a wrong passphrase is refused');
  throws(() => KS.open(dir, PASS.toUpperCase()), /wrong passphrase|altered/i, 'and so is the right one in the wrong case');
  throws(() => KS.open(dir, ''), /passphrase is required/i, 'an empty passphrase is not a passphrase');
  throws(() => KS.create(tmpdir('empty'), ''), /passphrase is required/i, 'nor may a keystore be created with one');

  // The message a user sees must not carry anything derived from the key.
  let msg = '';
  try { KS.open(dir, 'nope'); } catch (e) { msg = e.message; }
  assert(!msg.includes(made.privateKey.toString('hex')), 'and the refusal does not quote the key it failed to decrypt');
}

// ============================================================================
group('the private key is nowhere in the file');
// Watched to fail by adding `privateKey: '0x'+key.privateKey.toString('hex')`
// to the object encrypt() returns — which is exactly the field the plaintext
// coinbase-key.json has, i.e. the mistake this whole module exists to undo.
// ============================================================================
{
  const dir = tmpdir('b');
  const key = KS.create(dir, PASS);
  const file = KS.keystorePath(dir);
  const text = fs.readFileSync(file, 'utf8');
  const hex = key.privateKey.toString('hex');

  assert(!text.includes(hex), 'the keystore does not contain the private key in hex');
  assert(!text.includes(key.privateKey.toString('base64')), 'nor in base64');
  assert(!fs.readFileSync(file).includes(key.privateKey), 'nor as raw bytes anywhere in the file');

  const ks = JSON.parse(text);
  assert(ks.address === key.addressHex.toLowerCase(),
    'the ADDRESS is in the clear on purpose — the app can say who it pays before you unlock it');
  assert(typeof ks.ciphertext === 'string' && ks.ciphertext.length === 64,
    'the ciphertext is 32 bytes of it and nothing more');
  assert((fs.statSync(file).mode & 0o777) === 0o600, 'and the file is readable only by its owner (mode 600)');
  assert(fs.readdirSync(dir).every(f => !f.endsWith('.tmp')), 'no half-written temporary file is left behind');
}

// ============================================================================
group('what it costs to guess the passphrase');
// Watched to fail by lowering KDF.N to 1<<14. These are the numbers that decide
// whether a stolen file is opened in an afternoon, so they are pinned rather
// than described in a comment nobody re-reads.
// ============================================================================
{
  assert(KS.KDF.name === 'scrypt', 'the derivation is scrypt — memory-hard, so a GPU farm loses its parallelism');
  assert(KS.KDF.N >= 1 << 17, `N is ${KS.KDF.N} (2^${Math.log2(KS.KDF.N)}), at or above the 2^17 floor`);
  assert(KS.KDF.r >= 8 && KS.KDF.p >= 1, `r=${KS.KDF.r}, p=${KS.KDF.p}`);
  assert(KS.KDF.N * KS.KDF.r * 128 >= 128 * 1024 * 1024,
    `so each guess costs ${Math.round(KS.KDF.N * KS.KDF.r * 128 / 1024 / 1024)} MiB of memory`);
  assert(KS.KDF.dkLen === 32 && /^aes-256-/.test(KS.CIPHER), `and derives 32 bytes for ${KS.CIPHER}`);
  assert(/-gcm$/.test(KS.CIPHER),
    'the cipher is AUTHENTICATED (GCM) — a tampered file must fail, not decrypt to some other key');

  const dir = tmpdir('c');
  KS.create(dir, PASS);
  const ks = JSON.parse(fs.readFileSync(KS.keystorePath(dir), 'utf8'));
  assert(/^[0-9a-f]{64}$/.test(ks.kdf.salt), 'the salt is 32 random bytes, stored with the file');
  const other = tmpdir('c2');
  KS.create(other, PASS);
  const ks2 = JSON.parse(fs.readFileSync(KS.keystorePath(other), 'utf8'));
  assert(ks.kdf.salt !== ks2.kdf.salt,
    'and it is fresh per keystore — two files with the same passphrase share no derived key');
  assert(ks.cipher.iv !== ks2.cipher.iv, 'as is the nonce, which GCM reuse would be fatal for');
}

// ============================================================================
group('a tampered keystore fails instead of lying');
// Watched to fail by dropping `d.setAuthTag(...)` — Node then throws anyway on
// final(), so the ciphertext case still passed; it was the ADDRESS case below
// that caught the missing AAD binding when `setAAD` was removed.
// ============================================================================
{
  const mk = () => {
    const dir = tmpdir('t');
    const key = KS.create(dir, PASS);
    return { dir, key, file: KS.keystorePath(dir), read: () => JSON.parse(fs.readFileSync(KS.keystorePath(dir), 'utf8')) };
  };
  const rewrite = (file, ks) => fs.writeFileSync(file, JSON.stringify(ks, null, 2));

  {
    const t = mk();
    const ks = t.read();
    const b = Buffer.from(ks.ciphertext, 'hex'); b[0] ^= 1;
    ks.ciphertext = b.toString('hex');
    rewrite(t.file, ks);
    throws(() => KS.open(t.dir, PASS), /wrong passphrase|altered/i, 'one flipped bit of ciphertext and it will not open');
  }
  {
    /* THE ONE A CARELESS DESIGN GETS WRONG. The address is in the clear so the
     * app can display it locked. If it is not bound into the ciphertext then
     * anyone can edit that line, and the app cheerfully shows an address that is
     * not the one being paid — which is a plausible way to talk somebody into
     * "verifying" a deposit to a stranger. GCM additional data is what stops it. */
    const t = mk();
    const ks = t.read();
    ks.address = '0x' + '11'.repeat(20);
    rewrite(t.file, ks);
    let got = null, threw = null;
    try { got = KS.open(t.dir, PASS); } catch (e) { threw = e; }
    assert(threw !== null, 'editing the cleartext address makes the file refuse to open');
    assert(got === null, 'it does NOT quietly open and pay the original key while displaying the forged address');
  }
  {
    const t = mk();
    const ks = t.read();
    const tag = Buffer.from(ks.cipher.tag, 'hex'); tag[0] ^= 1;
    ks.cipher.tag = tag.toString('hex');
    rewrite(t.file, ks);
    throws(() => KS.open(t.dir, PASS), /wrong passphrase|altered/i, 'a forged authentication tag is refused');
  }
  {
    const t = mk();
    const ks = t.read();
    ks.kdf.N = 1 << 12;                    // cheaper work factor, same salt
    rewrite(t.file, ks);
    throws(() => KS.open(t.dir, PASS), /wrong passphrase|altered/i,
      'and so is a file whose work factor has been dialled down to make guessing cheap');
  }
  {
    const t = mk();
    const ks = t.read();
    ks.version = 99;
    rewrite(t.file, ks);
    throws(() => KS.open(t.dir, PASS), /version/i, 'a keystore from a future version says so rather than half-reading it');
  }
  {
    const dir = tmpdir('t-none');
    throws(() => KS.open(dir, PASS), /no keystore/i, 'and an absent one is a sentence, not a stack trace');
  }
}

// ============================================================================
group('it will not overwrite a key that may hold money');
// Watched to fail by removing the fs.existsSync guard in create().
// ============================================================================
{
  const dir = tmpdir('d');
  const first = KS.create(dir, PASS);
  throws(() => KS.create(dir, 'another one'), /already exists/i, 'a second create() on the same directory is refused');
  assert(KS.open(dir, PASS).addressHex === first.addressHex, 'and the original key is still there, still openable');
}

// ============================================================================
group('changing the passphrase proves the old one first');
// Watched to fail by re-encrypting `newKey()` instead of the opened key, which
// leaves the file readable and the address silently different — the last check
// is the one that caught it.
// ============================================================================
{
  const dir = tmpdir('e');
  const key = KS.create(dir, PASS);
  throws(() => KS.changePassphrase(dir, 'wrong', 'new one'), /wrong passphrase|altered/i,
    'a wrong old passphrase cannot re-encrypt an unknown key');
  assert(KS.open(dir, PASS).addressHex === key.addressHex, 'and the file is untouched by the attempt');

  KS.changePassphrase(dir, PASS, 'a different passphrase');
  throws(() => KS.open(dir, PASS), /wrong passphrase|altered/i, 'after the change the old passphrase no longer opens it');
  const after = KS.open(dir, 'a different passphrase');
  assert(after.addressHex === key.addressHex, 'the new one opens THE SAME KEY — the address did not move');
  assert(after.privateKey.equals(key.privateKey), 'byte for byte');
}

// ============================================================================
group('bringing a key in, and getting one out to write down');
// Watched to fail by having importPlaintext() ignore its file and mint a fresh
// key: the address comparison went red, which is the check that matters to
// somebody who has already mined to that address.
// ============================================================================
{
  const dir = tmpdir('f');
  const priv = crypto.randomBytes(32);
  const expect = keyFrom(priv);

  const imported = KS.create(dir, PASS, '0x' + priv.toString('hex'));
  assert(imported.addressHex === expect.addressHex, 'a private key brought in as 0x-hex keeps its address');
  assert(KS.open(dir, PASS).privateKey.equals(priv), 'and is what comes back out');

  const dir2 = tmpdir('f2');
  assert(KS.create(dir2, PASS, priv.toString('hex')).addressHex === expect.addressHex, 'the 0x prefix is optional');
  throws(() => KS.create(tmpdir('f3'), PASS, 'abcd'), /32 bytes/, 'a key of the wrong length is refused, not padded');

  // …and the one a command-line miner already has.
  const cliDir = tmpdir('f4');
  const cliKey = loadCoinbaseKey(cliDir);
  const plain = path.join(cliDir, 'coinbase-key.json');
  const appDir = tmpdir('f5');
  const migrated = KS.importPlaintext(appDir, plain, PASS);
  assert(migrated.addressHex === cliKey.addressHex,
    'importing hearth-mine\'s plaintext coinbase-key.json keeps the address it has been mining to');
  assert(fs.existsSync(plain), 'and LEAVES the original where it was — deleting a user\'s only copy of a key is not tidiness');

  const revealed = KS.revealPrivateKey(dir, PASS);
  assert(revealed === '0x' + priv.toString('hex'), 'revealPrivateKey hands the key back for a backup');
  throws(() => KS.revealPrivateKey(dir, 'wrong'), /wrong passphrase|altered/i, 'and asks for the passphrase again to do it');
}

// ============================================================================
group('the app can say who it pays without unlocking anything');
// Watched to fail by having peek() call open() — which cannot work without a
// passphrase, so the group went red immediately.
// ============================================================================
{
  const dir = tmpdir('g');
  assert(KS.exists(dir) === false, 'before first run there is no keystore');
  const key = KS.create(dir, PASS);
  assert(KS.exists(dir) === true, 'after it, there is');
  const seen = KS.peek(dir);
  assert(seen.address === key.addressHex.toLowerCase(), `peek() gives the address with no passphrase (${seen.address})`);
  assert(seen.kdf === 'scrypt' && seen.N === KS.KDF.N, 'and the work factor the file was written with');
  assert(seen.file === KS.keystorePath(dir), 'and where the file is, so it can be backed up');
  assert(!('privateKey' in seen) && !('ciphertext' in seen), 'and nothing else');
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
process.exit(failed === 0 ? 0 : 1);
