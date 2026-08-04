'use strict';
/* Encrypted secp256k1 keys at rest, for the Node-side wallet.
 *
 * The self-custody wallet seals its keys under PBKDF2-HMAC-SHA256 then AES-256-GCM,
 * and this is deliberately the same construction with the same parameters so that one
 * threat model covers both and neither has to be reasoned about separately. That wallet
 * is now micro-hearth-wallet-core, and the agreement is CHECKED rather than asserted:
 * its test/oracle-keystore.test.ts seals a record there and opens it with THIS file,
 * and the reverse, in-process. Node's `crypto` rather than WebCrypto, and a
 * 32-byte secp256k1 scalar rather than a PKCS#8 PEM — everything else matches,
 * including the OWASP-2023 iteration floor and the convention that the GCM tag
 * is appended to the ciphertext.
 *
 * Format (`hearth-keystore/1`):
 *   { v: 1, address, created, kdf: {name,hash,iterations,salt}, cipher, iv, ct }
 *
 * `address` is in the clear on purpose: a locked wallet should still be able to
 * tell you which address it holds and what is in it. Nothing else is.
 *
 * WHAT THIS IS NOT. It is not the Web3 Secret Storage format (scrypt + keccak
 * MAC) that geth writes. Reading those is worth doing later; writing a lookalike
 * that another tool would try to open and fail on is worse than being honestly
 * different, so the `v`/`kdf` header says plainly what it is.
 *
 * The passphrase is never stored, never defaulted and never recoverable, and a
 * wrong one fails on the GCM tag rather than by producing a plausible key for
 * some other address.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const secp = require('../crypto/secp256k1');
const { keccak256 } = require('../crypto/keccak');
const { checksumAddress } = require('./ui');

const FORMAT = 'hearth-keystore/1';
const VERSION = 1;
const PBKDF2_ITERATIONS = 600000;      // OWASP 2023 floor for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12;                   // 96 bits, the only GCM nonce size worth using
const TAG_BYTES = 16;
const MIN_PASSPHRASE = 8;

class KeystoreError extends Error {
  constructor(message) { super('keystore: ' + message); this.name = 'KeystoreError'; }
}

/** The default keystore directory. `HEARTH_KEYSTORE` wins; then ~/.hearth/keys. */
function defaultDir() {
  return process.env.HEARTH_KEYSTORE || path.join(os.homedir(), '.hearth', 'keys');
}

/** The 0x address for a private key, EIP-55 checksummed. */
function addressFor(priv) {
  const pub = secp.publicKeyFromPrivate(priv, false);     // 65 bytes, 0x04-tagged
  return checksumAddress(keccak256(Buffer.from(pub.subarray(1))).subarray(12));
}

function deriveKey(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(Buffer.from(String(passphrase), 'utf8'), salt, iterations, 32, 'sha256');
}

/** Seal a 32-byte private key. Returns the record; writes nothing. */
function seal(priv, passphrase, { iterations = PBKDF2_ITERATIONS, created = Date.now(), label = null } = {}) {
  const key = Buffer.isBuffer(priv) ? priv : Buffer.from(String(priv).replace(/^0x/i, ''), 'hex');
  if (key.length !== 32) throw new KeystoreError('a private key is 32 bytes');
  if (!secp.isValidPrivateKey(key)) throw new KeystoreError('private key is not a valid secp256k1 scalar (zero, or at/above the group order)');
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new KeystoreError(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const aes = deriveKey(passphrase, salt, iterations);
  const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const ct = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
  aes.fill(0);
  return {
    format: FORMAT,
    v: VERSION,
    address: addressFor(key),
    label,
    created,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: salt.toString('hex') },
    cipher: 'AES-256-GCM',
    iv: iv.toString('hex'),
    ct: ct.toString('hex'),
  };
}

/** Open a record. Throws `wrong passphrase` on a GCM tag failure. */
function open(rec, passphrase) {
  if (!rec || rec.v !== VERSION || !rec.kdf || rec.kdf.name !== 'PBKDF2' || rec.cipher !== 'AES-256-GCM') {
    throw new KeystoreError('this file is not a keystore in a format this build understands');
  }
  const salt = Buffer.from(rec.kdf.salt, 'hex');
  const iv = Buffer.from(rec.iv, 'hex');
  const all = Buffer.from(rec.ct, 'hex');
  if (all.length <= TAG_BYTES) throw new KeystoreError('ciphertext is too short to carry a GCM tag');
  const aes = deriveKey(passphrase, salt, rec.kdf.iterations);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aes, iv);
  decipher.setAuthTag(all.subarray(all.length - TAG_BYTES));
  let key;
  try {
    key = Buffer.concat([decipher.update(all.subarray(0, all.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new KeystoreError('wrong passphrase');
  } finally {
    aes.fill(0);
  }
  if (key.length !== 32) throw new KeystoreError('decrypted material is not a 32-byte key');
  /* The address is stored in the clear, so it is untrusted input: a file whose
   * label says one address and whose key is another would silently sign from
   * somewhere the user did not expect. */
  if (rec.address && addressFor(key).toLowerCase() !== String(rec.address).toLowerCase()) {
    throw new KeystoreError('the key in this file does not match the address on it');
  }
  return key;
}

// ---- the directory ---------------------------------------------------------

const fileFor = (dir, address) => path.join(dir, address.toLowerCase() + '.json');

/** Write a record. Refuses to clobber; 0600, in a 0700 directory. */
function save(dir, rec, { overwrite = false } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileFor(dir, rec.address);
  if (!overwrite && fs.existsSync(file)) {
    throw new KeystoreError(`${rec.address} is already in this keystore (${file}); pass --overwrite to replace it`);
  }
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** Every record in the directory, oldest first. Unreadable files are reported. */
function list(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(dir, n);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({ file, address: rec.address, label: rec.label || null, created: rec.created || null, ok: rec.v === VERSION });
    } catch (e) {
      out.push({ file, address: null, label: null, created: null, ok: false, error: e.message });
    }
  }
  return out.sort((a, b) => (a.created || 0) - (b.created || 0));
}

/**
 * Find one record by address, by label, or — with no selector at all — the only
 * one there is. Ambiguity is an error: picking "the first" is how a CLI signs
 * from the wrong account.
 */
function find(dir, selector = null) {
  const all = list(dir).filter((e) => e.ok);
  if (all.length === 0) throw new KeystoreError(`no keys in ${dir} — run \`hearth wallet new\` first`);
  if (!selector) {
    if (all.length > 1) throw new KeystoreError(`${all.length} keys in ${dir}; say which with --from <address|label>`);
    return all[0];
  }
  const s = String(selector).toLowerCase();
  const hit = all.filter((e) => (e.address || '').toLowerCase() === s || (e.label || '').toLowerCase() === s);
  if (hit.length === 0) throw new KeystoreError(`no key for "${selector}" in ${dir}`);
  if (hit.length > 1) throw new KeystoreError(`"${selector}" matches ${hit.length} keys; use the address`);
  return hit[0];
}

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

module.exports = {
  FORMAT, VERSION, PBKDF2_ITERATIONS, MIN_PASSPHRASE, KeystoreError,
  defaultDir, addressFor, seal, open, save, list, find, read, fileFor,
};
