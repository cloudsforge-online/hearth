/* Encrypted key storage for the browser wallet and the browser miner.
 *
 * The spending key used to sit in localStorage as a plaintext PKCS#8 PEM under
 * `hearth.wallet.v1`. localStorage is readable by anything with script access to
 * this origin and by anyone with the browser profile on disk — an extension, a
 * shared machine, a stolen laptop, a backup. For a non-custodial wallet that is
 * the whole security model, so the key is now sealed at rest and the passphrase
 * is the only thing that opens it.
 *
 * Format (`hearth.wallet.v2`):
 *   { v: 2, address, created, kdf: {name, hash, iterations, salt}, cipher, iv, ct }
 *
 * The address stays in the clear on purpose: a locked wallet should still be
 * able to show you which address it holds and what is in it. Nothing else does.
 *
 * PBKDF2-HMAC-SHA256 at OWASP's 2023 floor, then AES-256-GCM. WebCrypto only —
 * no vendored crypto, and the passphrase is never stored, never defaulted and
 * never recoverable. A forgotten passphrase costs the coins, exactly as a lost
 * PEM did; that is why every path through this file keeps export working.
 *
 * v1 is NOT read implicitly. `peek()` reports it, and `migrate()` converts it
 * under a passphrase the user chooses — so an existing wallet is upgraded on
 * purpose rather than silently re-saved into a format its owner did not pick.
 */

import { generateKey, importKey } from './wallet-core.js';

const V2 = 'hearth.wallet.v2';
const V1 = 'hearth.wallet.v1';

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readJSON(k) {
  const raw = localStorage.getItem(k);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function deriveAesKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Seal a PKCS#8 PEM under `passphrase`. Returns the v2 record. */
export async function seal(pem, address, passphrase, created = Date.now()) {
  if (typeof passphrase !== 'string' || passphrase.length < 8)
    throw new Error('passphrase must be at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aes = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(pem)));
  return {
    v: 2,
    address,
    created,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toHex(salt) },
    cipher: 'AES-GCM',
    iv: toHex(iv),
    ct: toHex(ct),
  };
}

/** Open a v2 record. Throws 'wrong passphrase' on a GCM tag failure. */
export async function open(rec, passphrase) {
  if (!rec || rec.v !== 2 || rec.kdf?.name !== 'PBKDF2' || rec.cipher !== 'AES-GCM')
    throw new Error('stored key is not in a format this page understands');
  const aes = await deriveAesKey(passphrase, fromHex(rec.kdf.salt), rec.kdf.iterations);
  let pem;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(rec.iv) }, aes, fromHex(rec.ct),
    );
    pem = dec.decode(pt);
  } catch {
    // AES-GCM authenticates, so this is the only failure mode: the derived key
    // is wrong, which means the passphrase is.
    throw new Error('wrong passphrase');
  }
  return importKey(pem);
}

/**
 * What is in this browser, without needing the passphrase.
 *   { kind: 'none' }                    nothing stored
 *   { kind: 'locked', address, created} a sealed key waiting to be opened
 *   { kind: 'legacy', address, created} a v1 plaintext key that must be migrated
 */
export function peek() {
  const v2 = readJSON(V2);
  if (v2 && v2.v === 2) return { kind: 'locked', address: v2.address, created: v2.created };
  const v1 = readJSON(V1);
  if (v1 && v1.priv) return { kind: 'legacy', address: v1.address, created: v1.created };
  return { kind: 'none' };
}

/** Open the stored key. */
export async function unlock(passphrase) {
  const rec = readJSON(V2);
  if (!rec) throw new Error('no key stored in this browser');
  return open(rec, passphrase);
}

/** Store `key` sealed under `passphrase`, replacing whatever was there. */
export async function save(key, passphrase) {
  localStorage.setItem(V2, JSON.stringify(await seal(key.priv, key.address, passphrase)));
  localStorage.removeItem(V1);
  return key;
}

/** Create a fresh key and store it sealed. */
export async function create(passphrase) {
  return save(await generateKey(), passphrase);
}

/** Import a PEM and store it sealed. */
export async function adopt(pem, passphrase) {
  return save(await importKey(pem), passphrase);
}

/**
 * Convert a v1 plaintext key to v2 under a passphrase the user just chose.
 *
 * The plaintext record is removed only after the sealed one is written and read
 * back successfully — an interrupted migration must never be the reason someone
 * loses a key.
 */
export async function migrate(passphrase) {
  const v1 = readJSON(V1);
  if (!v1 || !v1.priv) throw new Error('nothing to migrate');
  const key = await importKey(v1.priv);
  localStorage.setItem(V2, JSON.stringify(await seal(key.priv, key.address, passphrase, v1.created)));
  await open(readJSON(V2), passphrase);   // prove it opens before dropping the original
  localStorage.removeItem(V1);
  return key;
}

/** Remove every stored key from this browser. */
export function forget() {
  localStorage.removeItem(V2);
  localStorage.removeItem(V1);
}

export const STORE_KEY = V2;
export const LEGACY_STORE_KEY = V1;
