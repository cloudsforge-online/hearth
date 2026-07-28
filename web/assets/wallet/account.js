/* An account: one secp256k1 private key, and the 0x address it controls.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A RENAME (docs/evm-spec.md §2). The old wallet
 * held an Ed25519 seed and an address that was `ember1` + a truncated SHA-256 of
 * the public key. This holds a secp256k1 scalar and an address that is the last
 * twenty bytes of keccak256 over the uncompressed public key with its 0x04 tag
 * removed, rendered with EIP-55 mixed-case checksumming. There is no function
 * from one to the other. A key from the old wallet does not name an account on
 * this chain, and cannot be made to.
 *
 * THE ADDRESS IS DISPLAYED CHECKSUMMED, ALWAYS. EIP-55 casing is the only defence
 * a person has against a mistyped or clipboard-mangled address, and it costs one
 * keccak to check. `parseAddress` below refuses an address that carries a
 * checksum and fails it, rather than lowercasing the problem away — a wallet
 * that accepts a bad checksum is a wallet that sends to a typo.
 *
 * PRIVATE KEYS ARE 32 BYTES, RENDERED AS 0x-PREFIXED HEX. That is what every EVM
 * tool means by "private key" — MetaMask's import box, `cast wallet`, Hardhat's
 * accounts array — so a key made here can be pasted into any of them. The old
 * wallet's PKCS#8 PEM was the right choice when the node stored PEMs; it is the
 * wrong one now.
 */

import * as secp from './secp256k1.js';
import { toChecksumAddress, ADDRESS_RE } from '../explorer/format.js';
import { addressFromPublicKey, toHex, toBuf } from './transaction.js';

export { toChecksumAddress };

/** 32 bytes, as 0x-hex. */
export function privateKeyHex(bytes) { return toHex(bytes); }

/**
 * Build an account from a 32-byte private key.
 * @returns {{priv: Uint8Array, privHex: string, pub: Uint8Array, pubHex: string,
 *            addressBytes: Uint8Array, address: string}}
 *   `address` is EIP-55 checksummed and is the only spelling anything should show.
 */
export function accountFromPrivateKey(priv) {
  const bytes = toBuf(priv, 'private key');
  if (bytes.length !== 32) throw new Error(`a private key is 32 bytes, got ${bytes.length}`);
  if (!secp.isValidPrivateKey(bytes)) {
    // Zero and anything at or above the group order are not keys. Astronomically
    // unlikely from the RNG, entirely likely from a typo in a pasted key.
    throw new Error('that is not a valid secp256k1 private key (it must be in [1, n))');
  }
  const pub = secp.publicKeyFromPrivate(bytes, false);
  const addressBytes = addressFromPublicKey(pub);
  return {
    priv: bytes,
    privHex: toHex(bytes),
    pub,
    pubHex: toHex(pub),
    addressBytes,
    address: toChecksumAddress(toHex(addressBytes)),
  };
}

/** A fresh account from the browser CSPRNG. Nothing is requested from the network. */
export function generateAccount() {
  return accountFromPrivateKey(secp.randomPrivateKey());
}

/** Accept a pasted private key, with or without 0x, and say why if it is refused. */
export function accountFromInput(text) {
  const s = String(text || '').trim().replace(/\s+/g, '');
  if (!s) throw new Error('paste a private key first');
  const h = s.replace(/^0x/i, '');
  if (/-----BEGIN/.test(s)) {
    throw new Error('that is a PEM key from the pre-EVM wallet. This chain uses secp256k1 keys, '
      + 'and a PEM Ed25519 key does not name an account here — see the note above.');
  }
  if (h.length !== 64 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error(`a private key is 64 hex characters (32 bytes); that is ${h.length}`);
  }
  return accountFromPrivateKey('0x' + h);
}

/**
 * Validate a destination address typed by a human.
 * @returns {{ok: true, address: string} | {ok: false, why: string}}
 */
export function parseAddress(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, why: 'enter a destination address' };
  if (/^ember1/.test(s)) {
    return { ok: false, why: 'that is an ember1 address from the pre-EVM chain. Addresses here are 0x… (docs/evm-spec.md §2).' };
  }
  if (!ADDRESS_RE.test(s)) {
    return { ok: false, why: 'an address is 0x followed by 40 hex characters' };
  }
  const hasCase = /[A-F]/.test(s.slice(2)) && /[a-f]/.test(s.slice(2));
  if (hasCase && toChecksumAddress(s) !== s) {
    return { ok: false, why: 'that address fails its EIP-55 checksum — one character is wrong. Check it before sending.' };
  }
  return { ok: true, address: toChecksumAddress(s), checksummed: hasCase };
}

/** True when the address carries a checksum at all (mixed case), rather than being all lower. */
export function carriesChecksum(addr) {
  const body = String(addr || '').slice(2);
  return /[A-F]/.test(body) && /[a-f]/.test(body);
}
