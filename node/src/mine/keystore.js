'use strict';
/* The mining key, encrypted at rest.
 *
 * WHY THIS IS NOT src/coinbase.js. `loadCoinbaseKey` writes the private key in
 * the clear at mode 600, and for a server that is right: a node has to come back
 * up unattended after a reboot, and a passphrase the machine can read by itself
 * is not a passphrase. A desktop application is the opposite case. The file sits
 * in a home directory that gets backed up to a cloud, synced between machines,
 * copied off a stolen laptop and read by anything the user runs. Mode 600 stops
 * the other Unix accounts on a single-user Mac, which is nobody.
 *
 * So the desktop key is a KEYSTORE: scrypt over a passphrase, AES-256-GCM over
 * the key. Same shape as every Ethereum keystore, for the reason that shape won.
 *
 * WHAT PROTECTS WHAT, precisely, because "encrypted" on its own means nothing:
 *
 *   scrypt N=2^18, r=8, p=1 — 256 MiB and about half a second per guess on the
 *   machine this was written on. Memory hardness is the whole point: a GPU farm
 *   gets its advantage from running thousands of cheap guesses in parallel, and
 *   256 MiB per guess is what takes that away. PBKDF2 at any iteration count
 *   would not.
 *
 *   AES-256-GCM — AUTHENTICATED. Not CBC. A tampered ciphertext must FAIL, not
 *   decrypt to a different key, because a key that silently becomes a different
 *   key mines to an address the user does not control and the only symptom is
 *   that the money is somewhere else.
 *
 *   The address is stored in the clear, so the app can show you which address it
 *   pays before you unlock anything — and it is bound in as GCM ADDITIONAL DATA,
 *   so editing that field breaks decryption rather than making the app display a
 *   lie. After decrypting, the address is derived from the key again and
 *   compared; both checks are cheap and the failure they prevent is not.
 *
 * WHAT THE USER BACKS UP: this one file, plus the passphrase they chose. That is
 * deliberately a single artefact. A scheme that splits the secret between a file
 * and the OS keychain is stronger against theft and much weaker against a dead
 * laptop, and the money is lost the same either way. The keychain's job here is
 * only to save retyping (app-desktop/src-tauri/src/keychain.rs) — it never holds
 * the only copy of anything.
 *
 * WHAT THIS FILE NEVER DOES: print, log, throw a private key inside an error
 * message, or return one from anything but `open()` and the deliberate
 * `revealPrivateKey()`. There is no code path here that writes key material to a
 * stream.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { keyFrom, newKey } = require('../coinbase');

const KEYSTORE_FILE = 'coinbase-keystore.json';
const VERSION = 1;

/**
 * scrypt work factors. Raising N later is safe — every keystore carries the
 * parameters it was written with, so old files keep opening — but LOWERING the
 * floor below is not, so the floor is asserted in test/mine-keystore.js rather
 * than left to a reviewer noticing.
 */
const KDF = { name: 'scrypt', N: 1 << 18, r: 8, p: 1, dkLen: 32 };

/** scrypt's 32 MiB default refuses N=2^18 outright; this is the budget, not a target. */
const MAXMEM = 1024 * 1024 * 1024;

const CIPHER = 'aes-256-gcm';

function keystorePath(dir) { return path.join(dir, KEYSTORE_FILE); }

function derive(passphrase, saltHex, kdf) {
  if (kdf.name !== 'scrypt') throw new Error(`unknown key-derivation function ${kdf.name}`);
  return crypto.scryptSync(
    Buffer.from(String(passphrase), 'utf8'),
    Buffer.from(saltHex, 'hex'),
    kdf.dkLen,
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM },
  );
}

/**
 * Write `file` without ever leaving a half-written keystore on disk.
 *
 * A truncated keystore is an unrecoverable key. `writeFileSync` truncates first
 * and then writes, so a crash or a full disk in between destroys the old file
 * and produces no new one — which is exactly the moment the money goes. Write a
 * new file beside it, fsync it, then rename: rename is atomic within a
 * directory, so a reader sees the old file or the new one and never neither.
 */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // The mode is set at open() above; re-assert it, because a restrictive umask
  // is the only thing that made it right and a permissive one is not an error.
  fs.chmodSync(file, 0o600);
}

/** Encrypt `key` under `passphrase` and return the keystore object. */
function encrypt(key, passphrase) {
  requirePassphrase(passphrase);
  const salt = crypto.randomBytes(32);
  const kdf = Object.assign({}, KDF, { salt: salt.toString('hex') });
  const dk = derive(passphrase, kdf.salt, kdf);
  const iv = crypto.randomBytes(12);                    // 96 bits, the GCM norm
  const addressHex = key.addressHex.toLowerCase();
  const c = crypto.createCipheriv(CIPHER, dk, iv);
  c.setAAD(Buffer.from(addressHex, 'utf8'));            // binds the cleartext label
  const ct = Buffer.concat([c.update(key.privateKey), c.final()]);
  const tag = c.getAuthTag();
  dk.fill(0);
  return {
    version: VERSION,
    warning: 'this file holds a mining key with a spendable balance. Back it up together with '
      + 'its passphrase — one without the other opens nothing, and losing both loses the coins.',
    address: addressHex,
    kdf,
    cipher: { name: CIPHER, iv: iv.toString('hex'), tag: tag.toString('hex') },
    ciphertext: ct.toString('hex'),
  };
}

/** Decrypt a keystore object. Throws a message fit to show a user; never a key. */
function decrypt(ks, passphrase) {
  if (!ks || typeof ks !== 'object') throw new Error('this is not a Hearth keystore file');
  if (ks.version !== VERSION) throw new Error(`this keystore is version ${ks.version}, and this build reads version ${VERSION}`);
  if (!ks.kdf || !ks.cipher || typeof ks.ciphertext !== 'string') throw new Error('this keystore is missing the fields needed to open it');
  if (ks.cipher.name !== CIPHER) throw new Error(`unknown cipher ${ks.cipher.name}`);
  requirePassphrase(passphrase);

  const dk = derive(passphrase, ks.kdf.salt, ks.kdf);
  const d = crypto.createDecipheriv(CIPHER, dk, Buffer.from(ks.cipher.iv, 'hex'));
  d.setAAD(Buffer.from(String(ks.address).toLowerCase(), 'utf8'));
  d.setAuthTag(Buffer.from(ks.cipher.tag, 'hex'));
  let priv;
  try {
    priv = Buffer.concat([d.update(Buffer.from(ks.ciphertext, 'hex')), d.final()]);
  } catch {
    /* GCM cannot tell a wrong passphrase from a tampered file, and neither can
     * we, so say both. Nothing derived from the attempt is included. */
    throw new Error('wrong passphrase, or this keystore has been altered');
  } finally {
    dk.fill(0);
  }
  if (priv.length !== 32) throw new Error('the decrypted key is not 32 bytes');

  const key = keyFrom(priv);
  /* The AAD already ties the address to the ciphertext. This catches the other
   * direction — a keystore written by something that got the derivation wrong —
   * and costs one point multiplication. */
  if (key.addressHex.toLowerCase() !== String(ks.address).toLowerCase()) {
    throw new Error('the key in this keystore does not derive the address it claims');
  }
  return key;
}

/**
 * A passphrase is required, and empty is not one.
 *
 * The tempting alternative — generate a passphrase, hide it in the OS keychain
 * and never tell the user — makes first run one click and makes a dead laptop
 * an unrecoverable loss. If it is going to be the thing that protects the money
 * then the user has to hold a copy of it.
 */
function requirePassphrase(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('a passphrase is required — it is the only thing standing between this file and your coins');
  }
}

/** Does a keystore exist in `dir`? Cheap enough to call on every render. */
function exists(dir) { return fs.existsSync(keystorePath(dir)); }

/** Read the keystore's public facts WITHOUT the passphrase: address, kdf, version. */
function peek(dir) {
  const file = keystorePath(dir);
  const ks = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, address: ks.address, version: ks.version, kdf: ks.kdf && ks.kdf.name, N: ks.kdf && ks.kdf.N };
}

/**
 * Create a keystore in `dir` for a fresh random key, or for `privateKey` when
 * one is being brought in from elsewhere. Refuses to overwrite: replacing a
 * keystore that already holds a funded key is how a balance disappears, so it is
 * the caller's job to move the old file aside and mean it.
 */
function create(dir, passphrase, privateKey = null) {
  requirePassphrase(passphrase);
  fs.mkdirSync(dir, { recursive: true });
  const file = keystorePath(dir);
  if (fs.existsSync(file)) {
    throw new Error(`a keystore already exists at ${file} — move it aside before creating another, `
      + 'or you will lose whatever the old key holds');
  }
  const key = privateKey ? keyFrom(normalisePrivate(privateKey)) : newKey();
  writeAtomic(file, JSON.stringify(encrypt(key, passphrase), null, 2) + '\n');
  return key;
}

/** Open the keystore in `dir`. Returns the same shape `keyFrom` does. */
function open(dir, passphrase) {
  const file = keystorePath(dir);
  if (!fs.existsSync(file)) throw new Error(`no keystore at ${file}`);
  return decrypt(JSON.parse(fs.readFileSync(file, 'utf8')), passphrase);
}

/**
 * Change the passphrase, atomically.
 *
 * Opening first is not a formality: it proves the OLD passphrase before the file
 * is touched, so a typo cannot re-encrypt an unknown key under a new secret.
 */
function changePassphrase(dir, oldPassphrase, newPassphrase) {
  const key = open(dir, oldPassphrase);
  requirePassphrase(newPassphrase);
  writeAtomic(keystorePath(dir), JSON.stringify(encrypt(key, newPassphrase), null, 2) + '\n');
  return key;
}

/**
 * Hand back the private key as hex, for a user who is writing it down.
 *
 * A separate, differently-named function from `open` on purpose: every caller of
 * THIS one is a place a key reaches a human, and there should be few enough of
 * them to read in a grep. It takes the passphrase again so a left-open window is
 * not an export.
 */
function revealPrivateKey(dir, passphrase) {
  return '0x' + open(dir, passphrase).privateKey.toString('hex');
}

/** Accept a private key as hex with or without 0x, or as raw bytes. */
function normalisePrivate(v) {
  const buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v).trim().replace(/^0x/i, ''), 'hex');
  if (buf.length !== 32) throw new Error('a private key is 32 bytes — 64 hex characters, optionally 0x-prefixed');
  return buf;
}

/**
 * Import the plaintext `coinbase-key.json` that `hearth-mine` and `hearthd`
 * write, so somebody already mining on the command line keeps their address and
 * their balance instead of starting again at zero.
 *
 * The plaintext file is LEFT WHERE IT IS. Deleting a user's only copy of a key
 * on their behalf, during an import, is not a risk worth taking for tidiness;
 * the app tells them it is still there and in the clear.
 */
function importPlaintext(dir, plaintextFile, passphrase) {
  const raw = JSON.parse(fs.readFileSync(plaintextFile, 'utf8'));
  if (!raw || typeof raw.privateKey !== 'string') {
    throw new Error(`${plaintextFile} does not look like a coinbase-key.json`);
  }
  return create(dir, passphrase, raw.privateKey);
}

module.exports = {
  KEYSTORE_FILE, VERSION, KDF, CIPHER,
  keystorePath, exists, peek, create, open, changePassphrase, revealPrivateKey,
  importPlaintext, encrypt, decrypt, normalisePrivate,
};
