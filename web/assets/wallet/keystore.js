/* Encrypted key storage for the account-model wallet.
 *
 * Format `hearth.wallet.v3`:
 *   { version: 3, curve: 'secp256k1', chainId: 7411, address, created,
 *     kdf: {name, hash, iterations, salt}, cipher, iv, ct }
 *
 * The sealing construction is unchanged from the Ed25519 wallet's v2 and is not
 * up for revision: PBKDF2-HMAC-SHA256 at 600,000 iterations (OWASP's 2023
 * floor), then AES-256-GCM. WebCrypto only, fresh salt and IV per seal, the
 * passphrase never stored and never recoverable. What is sealed changed — a
 * 32-byte secp256k1 scalar as 0x-hex, where v2 sealed a PKCS#8 Ed25519 PEM — and
 * nothing else did.
 *
 * The address stays in the clear on purpose: a locked wallet should still be
 * able to show you which account it holds and what is in it.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION ABOUT EXISTING Ed25519 KEYSTORES, written down because it becomes
 * impossible to revisit after mainnet.
 *
 * There is no migration path, and there is deliberately no export machinery for
 * one. The reasoning, in order:
 *
 *   1. An Ed25519 key cannot name an account on this chain. An address here is
 *      keccak256 of a secp256k1 public key (spec §2); there is no function from
 *      an Ed25519 seed to a secp256k1 scalar, and inventing one — hashing the
 *      seed into a curve scalar, say — would produce a key whose security story
 *      nobody has analysed and which no other tool could reproduce. "Carrying
 *      the key over" is not a thing that exists.
 *   2. Nobody holds EMBER. The testnet is being reset and there are no balances
 *      to strand, so the usual argument for a migration ramp — that real value
 *      is on the other side of it — does not apply here. Owner's call, and the
 *      reason this file is not twice its length.
 *   3. Deleting someone's key to tidy up is not this page's call. A v1/v2 record
 *      is read by nothing now — web/mine.html moved to this format too, because
 *      a coinbase must be an account the chain can credit — but it is still
 *      somebody's key material. So this wallet neither reads it nor removes it.
 *      It says one sentence about what it is and leaves it where it lies.
 *
 * What the wallet DOES do about it is `peek()` returning `kind: 'pre-evm'`, and
 * one paragraph of UI. Not a decode error, not a silently empty wallet.
 *
 * AND THE THING WHOSE ABSENCE CAUSED THE QUESTION: this format is versioned from
 * its first line. `version: 3` is checked on every open and anything else is
 * refused by name rather than misread. That is what makes the next format change
 * a conversation instead of an archaeology exercise.
 * ---------------------------------------------------------------------------
 */

import { accountFromPrivateKey, generateAccount, accountFromInput } from './account.js';
import { CHAIN_ID } from './transaction.js';

/** This wallet's store. The pre-EVM wallet's two keys are read but never written. */
const V3 = 'hearth.wallet.v3';
const PRE_EVM = ['hearth.wallet.v2', 'hearth.wallet.v1'];

export const VERSION = 3;
export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MIN_PASSPHRASE = 8;

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

/** Seal a private key (0x-hex) under `passphrase`. Returns the v3 record. */
export async function seal(privHex, address, passphrase, created = Date.now()) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE)
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aes = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(privHex)));
  return {
    version: VERSION,
    curve: 'secp256k1',
    chainId: CHAIN_ID,
    address,
    created,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toHex(salt) },
    cipher: 'AES-GCM',
    iv: toHex(iv),
    ct: toHex(ct),
  };
}

/**
 * Open a v3 record. Throws 'wrong passphrase' on a GCM tag failure, and names
 * the version on anything that is not this format.
 */
export async function open(rec, passphrase) {
  if (!rec || typeof rec !== 'object') throw new Error('nothing to open');
  if (rec.version !== VERSION) {
    throw new Error(`stored key is keystore version ${rec.version === undefined ? '(none)' : rec.version}, `
      + `and this wallet reads version ${VERSION}`);
  }
  if (rec.curve !== 'secp256k1') throw new Error(`stored key is for curve "${rec.curve}", not secp256k1`);
  if (rec.kdf?.name !== 'PBKDF2' || rec.kdf?.hash !== 'SHA-256' || rec.cipher !== 'AES-GCM')
    throw new Error('stored key is not sealed in a way this page understands');
  const aes = await deriveAesKey(passphrase, fromHex(rec.kdf.salt), rec.kdf.iterations);
  let privHex;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(rec.iv) }, aes, fromHex(rec.ct),
    );
    privHex = dec.decode(pt);
  } catch {
    // AES-GCM authenticates, so this is the only failure mode: the derived key
    // is wrong, which means the passphrase is.
    throw new Error('wrong passphrase');
  }
  const account = accountFromPrivateKey(privHex);
  /* The address is stored in the clear so a locked wallet can show a balance.
   * That makes it attacker-writable — anything with script access to this origin
   * could rewrite it — so it is checked against the key that actually came out,
   * and the key wins. Otherwise a tampered record could have the wallet display
   * one account while signing for another. */
  if (rec.address && rec.address.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error('the stored address does not match the key it seals — this record has been tampered with');
  }
  return account;
}

/**
 * What is in this browser, without needing the passphrase.
 *   { kind: 'none' }                          nothing stored
 *   { kind: 'locked', address, created }      a sealed v3 key waiting to be opened
 *   { kind: 'unreadable', version }           a record from a format this page does not read
 *   { kind: 'pre-evm', address, store }       an Ed25519 key from the pre-EVM chain
 */
export function peek() {
  const v3 = readJSON(V3);
  if (v3) {
    if (v3.version === VERSION) return { kind: 'locked', address: v3.address, created: v3.created };
    return { kind: 'unreadable', version: v3.version };
  }
  for (const store of PRE_EVM) {
    const old = readJSON(store);
    if (old && (old.ct || old.priv)) return { kind: 'pre-evm', address: old.address, store };
  }
  return { kind: 'none' };
}

/** Open the stored key. */
export async function unlock(passphrase) {
  const rec = readJSON(V3);
  if (!rec) throw new Error('no key stored in this browser');
  return open(rec, passphrase);
}

/** Store `account` sealed under `passphrase`, replacing whatever this wallet had. */
export async function save(account, passphrase) {
  const rec = await seal(account.privHex, account.address, passphrase);
  localStorage.setItem(V3, JSON.stringify(rec));
  /* The pre-EVM records are NOT removed. web/mine.html still reads them, and a
   * wallet quietly deleting another page's key would be the worst kind of
   * helpful. */
  return account;
}

/** Create a fresh account and store it sealed. */
export async function create(passphrase) {
  return save(generateAccount(), passphrase);
}

/** Import a pasted private key and store it sealed. */
export async function adopt(text, passphrase) {
  return save(accountFromInput(text), passphrase);
}

/** Remove this wallet's key from this browser. Leaves the pre-EVM records alone. */
export function forget() {
  localStorage.removeItem(V3);
}

export const STORE_KEY = V3;
export const PRE_EVM_STORE_KEYS = PRE_EVM;
