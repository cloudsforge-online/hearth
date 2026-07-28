/* Legacy (type 0) transactions in the browser — a port of
 * node/src/chain/transaction.js, which is the authority.
 *
 *     [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
 *
 * A transaction carries no sender field. The sender IS whatever public key the
 * signature recovers to over the signing hash, so the encoding and the hash are
 * not a wire format — they are the identity of the payer. For a wallet that is
 * sharper still than for a node: the node only has to agree with the network
 * about what a transaction MEANS, while the wallet decides what it SAYS. A
 * one-field disagreement here does not bounce, it pays the wrong person.
 *
 * So the wallet does something the node has no reason to: after signing, it
 * decodes its own bytes back, recovers the sender from them, and refuses to
 * broadcast unless that sender is the unlocked account. See `signAndCheck`.
 *
 * EIP-155 (spec §3): the signing hash covers the chain id, so a Hearth
 * transaction cannot be replayed on another chain. This wallet ALWAYS signs
 * protected, with chain id 7411. The node also accepts pre-155 unprotected
 * transactions — it must, or Multicall3's keyless deployment is unreachable —
 * but there is no reason for a user's wallet to ever produce one, so it cannot.
 *
 * SCALAR CANONICALITY (spec §5) is enforced in `decode`, exactly as the node
 * does it: RLP is untyped and cannot know that `nonce` is a number carrying no
 * leading zero byte. `0x0001` and `0x01` hash differently. Empty is the
 * canonical encoding of zero; `0x00` is not.
 */

import { keccak256 } from '../explorer/keccak.js';
import * as RLP from './rlp.js';
import * as secp from './secp256k1.js';

/** Chain id, docs/evm-spec.md §1. EIP-155 replay protection binds signatures to it. */
export const CHAIN_ID = 7411;

export const TX_TYPE_LEGACY = 0;

/** node/src/params.js MAX_TX_BYTES. */
export const MAX_TX_BYTES = 100_000;

/* Field bounds, matching the node's. A wallet that widens any of them builds a
 * transaction the network refuses — a better failure than the reverse, but only
 * just, since the user has already been told it was sent. */
export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;

/* Intrinsic gas constants, from node/src/evm/gas.js (the authority; these are
 * cross-checked against it in wallet-selftest.js). They are here rather than in
 * a full gas.js because a wallet needs exactly this much of the schedule: what a
 * transaction owes before a single opcode runs. */
const G = Object.freeze({
  TX: 21000n,
  TX_CREATION: 32000n,
  TX_DATA_ZERO: 4n,
  TX_DATA_NONZERO: 16n,
  INITCODE_WORD: 2n,                 // EIP-3860
  MAX_INITCODE_SIZE: 49152n,         // EIP-3860: 2 * MAX_CODE_SIZE
});

export class TxError extends Error {
  constructor(code, message) {
    super(`transaction: ${message}`);
    this.name = 'TxError';
    this.code = code;
  }
}

// ---- coercions -------------------------------------------------------------

const EMPTY = new Uint8Array(0);

export function toBuf(v, what) {
  if (v === null || v === undefined) return EMPTY;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    const h = v.replace(/^0x/i, '');
    if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new TypeError(`transaction: malformed hex ${what}`);
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new TypeError(`transaction: ${what} must be bytes or 0x-hex`);
}

export function bufToBig(b) {
  let v = 0n;
  for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}

export function toHex(b) {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function big(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new TypeError('transaction: quantity must be a non-negative safe integer or BigInt');
    return BigInt(v);
  }
  if (typeof v === 'string') return BigInt(v);
  if (v === null || v === undefined) return 0n;
  if (v instanceof Uint8Array) return bufToBig(v);
  throw new TypeError('transaction: cannot read a quantity from ' + typeof v);
}

/** A 20-byte address, or null for a creation. */
export function toAddress(v, what = 'to') {
  if (v === null || v === undefined || v === '' || v === '0x') return null;
  const b = toBuf(v, what);
  if (b.length === 0) return null;
  if (b.length !== 20) throw new TxError(b.length > 20 ? 'ADDRESS_TOO_LONG' : 'ADDRESS_TOO_SHORT', `${what} must be 20 bytes or empty, got ${b.length}`);
  return b;
}

/** Last 20 bytes of keccak256 over the uncompressed key WITHOUT its 0x04 tag. */
export function addressFromPublicKey(pub) {
  const b = toBuf(pub, 'public key');
  const body = b.length === 65 ? b.subarray(1) : b;
  if (body.length !== 64) throw new TypeError('transaction: public key must be 64 or 65 bytes');
  return keccak256(body).subarray(12);
}

// ---- the transaction object ------------------------------------------------

/* A transaction is a plain object with BigInt scalars, a Uint8Array `to` (or
 * null) and a Uint8Array `data`. `normalize` is the single door in. */
export function normalize(tx) {
  return {
    type: TX_TYPE_LEGACY,
    nonce: big(tx.nonce),
    gasPrice: big(tx.gasPrice),
    gasLimit: big(tx.gasLimit === undefined ? tx.gas : tx.gasLimit),
    to: toAddress(tx.to),
    value: big(tx.value),
    data: toBuf(tx.data === undefined ? tx.input : tx.data, 'data'),
    v: tx.v === undefined || tx.v === null ? null : big(tx.v),
    r: tx.r === undefined || tx.r === null ? null : big(tx.r),
    s: tx.s === undefined || tx.s === null ? null : big(tx.s),
  };
}

export function isCreation(tx) { return tx.to === null || tx.to === undefined; }

/**
 * "Has `normalize` already run?" — and this is the ONE place this file
 * deliberately differs from node/src/chain/transaction.js.
 *
 * The node asks `typeof tx.nonce === 'bigint'` and skips normalising if so,
 * which is safe there because its callers only ever pass decoded transactions.
 * A wallet does not: it builds a draft by hand, with a BigInt nonce and `data`
 * still a hex STRING, because that is what a form produces. Under the node's
 * guard that draft skips normalisation, `data.length` counts hex characters, and
 * every character above '0' counts as a non-zero byte — so a 10-byte payload is
 * charged for 22 and the intrinsic gas comes out wrong. It was wrong here until
 * the cross-check against node/src/evm/gas.js caught it.
 *
 * So the fast path requires every field to be in its normalised form, not just
 * the nonce. `normalize` is idempotent, so the cost of being wrong about this is
 * one extra pass and never a wrong number.
 */
function ready(tx) {
  return typeof tx.nonce === 'bigint' && typeof tx.gasPrice === 'bigint'
    && typeof tx.gasLimit === 'bigint' && typeof tx.value === 'bigint'
    && tx.data instanceof Uint8Array
    && (tx.to === null || tx.to instanceof Uint8Array);
}
const asTx = tx => (ready(tx) ? tx : normalize(tx));

/** The nine RLP fields, in order. `to` empty means creation. */
export function fields(tx) {
  return [tx.nonce, tx.gasPrice, tx.gasLimit, tx.to || EMPTY, tx.value, tx.data, tx.v, tx.r, tx.s];
}

/** Signed RLP. Every scalar goes through RLP's minimal integer encoding, which
 *  is what makes `encode(decode(raw))` byte-identical to `raw`. */
export function encode(tx) {
  const t = asTx(tx);
  if (t.v === null || t.r === null || t.s === null) throw new TxError('UNSIGNED', 'cannot encode an unsigned transaction');
  return RLP.encode(fields(t));
}

/** The transaction hash: keccak256 over the signed RLP, not over any subset. */
export function hash(tx) {
  return keccak256(tx instanceof Uint8Array ? tx : encode(tx));
}

/**
 * What the signature is actually over.
 *   protected:   keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]))
 *   unprotected: keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data]))
 * The two differ in more than the trailing fields — the list length changes — so
 * they can never collide.
 */
export function signingHash(tx, chainId = CHAIN_ID) {
  const t = asTx(tx);
  const base = [t.nonce, t.gasPrice, t.gasLimit, t.to || EMPTY, t.value, t.data];
  if (chainId === null || chainId === undefined) return keccak256(RLP.encode(base));
  return keccak256(RLP.encode([...base, big(chainId), 0, 0]));
}

/** The chain id a v encodes, or null when v is the unprotected 27/28 form. */
export function chainIdFromV(v) {
  if (v === 27n || v === 28n) return null;
  if (v < 35n) return undefined;                       // neither form: invalid
  return (v - 35n) >> 1n;
}

// ---- decoding --------------------------------------------------------------

/* One scalar, with the canonicality rule and its width bound. */
function scalar(raw, what, maxBytes, code) {
  if (!RLP.isBytes(raw)) throw new TxError(`RLP_INVALID_${what}`, `${what.toLowerCase()} is a list, not a scalar`);
  if (raw.length > 0 && raw[0] === 0) throw new TxError(`RLP_LEADING_ZEROS_${what}`, `${what.toLowerCase()} has a leading zero byte — the canonical encoding of zero is empty`);
  if (raw.length > maxBytes) throw new TxError(code, `${what.toLowerCase()} exceeds ${maxBytes * 8} bits`);
  return bufToBig(raw);
}

/**
 * Decode signed RLP into a transaction, rejecting every non-canonical and
 * out-of-range form. Structural validity only: it does not need chain state and
 * it does not recover the sender.
 *
 * @throws {TxError} with a `code` naming the rule broken.
 */
export function decode(raw, { chainId = CHAIN_ID } = {}) {
  const bytes = toBuf(raw, 'raw transaction');
  if (bytes.length === 0) throw new TxError('RLP_ERROR_SIZE', 'empty input');
  /* EIP-2718 reserved 0x00–0x7f as transaction-type envelopes precisely so that
   * a typed transaction can never be mistaken for the RLP list a legacy one
   * starts with. Hearth v1 is legacy-only (spec §3). */
  if (bytes[0] <= 0x7f) throw new TxError('TYPE_NOT_SUPPORTED', `transaction type 0x${bytes[0].toString(16)} — v1 accepts legacy (type 0) only`);

  const items = RLP.decode(bytes);                     // strict: rejects non-canonical RLP
  if (!Array.isArray(items)) throw new TxError('RLP_ERROR_SIZE', 'a transaction is a list');
  if (items.length !== 9) throw new TxError('RLP_ERROR_SIZE', `a legacy transaction has 9 fields, got ${items.length}`);

  const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = items;

  const tx = {
    type: TX_TYPE_LEGACY,
    nonce: scalar(nonce, 'NONCE', 8, 'NONCE_OVERFLOW'),
    gasPrice: scalar(gasPrice, 'GASPRICE', 32, 'GASPRICE_OVERFLOW'),
    gasLimit: scalar(gasLimit, 'GASLIMIT', 8, 'GASLIMIT_OVERFLOW'),
    to: null,
    value: 0n,
    data: EMPTY,
    v: 0n,
    r: 0n,
    s: 0n,
  };

  if (!RLP.isBytes(to)) throw new TxError('RLP_INVALID_TO', 'to is a list, not an address');
  tx.to = toAddress(to);
  tx.value = scalar(value, 'VALUE', 32, 'VALUE_OVERFLOW');
  if (!RLP.isBytes(data)) throw new TxError('RLP_INVALID_DATA', 'data is a list, not a byte string');
  tx.data = data;

  if (tx.nonce >= MAX_UINT64) throw new TxError('NONCE_TOO_BIG', 'a nonce of 2^64-1 can never be spent — the account nonce would overflow');
  if (tx.gasPrice * tx.gasLimit > MAX_UINT256) throw new TxError('GASLIMIT_PRICE_PRODUCT_OVERFLOW', 'gasLimit * gasPrice exceeds 256 bits');

  tx.v = scalar(v, 'V', 32, 'INVALID_CHAINID');
  tx.r = scalar(r, 'R', 32, 'INVALID_SIGNATURE_VRS');
  tx.s = scalar(s, 'S', 32, 'INVALID_SIGNATURE_VRS');

  const cid = chainIdFromV(tx.v);
  if (cid === undefined) throw new TxError('INVALID_CHAINID', `v = ${tx.v} is neither 27/28 nor an EIP-155 value`);
  if (cid !== null && cid !== big(chainId)) throw new TxError('INVALID_CHAINID', `v = ${tx.v} encodes chain id ${cid}, not ${chainId}`);
  tx.chainId = cid === null ? null : Number(cid);
  tx.protected = cid !== null;
  tx.recoveryId = cid === null ? Number(tx.v - 27n) : Number((tx.v - 35n) & 1n);

  if (tx.r === 0n || tx.r >= secp.N) throw new TxError('INVALID_SIGNATURE_VRS', 'r is not in [1, n)');
  if (tx.s === 0n || tx.s >= secp.N) throw new TxError('INVALID_SIGNATURE_VRS', 's is not in [1, n)');
  /* EIP-2: (r, n-s) verifies over the same message, so accepting both would give
   * every transaction two hashes. */
  if (tx.s > secp.N_HALF) throw new TxError('INVALID_SIGNATURE_VRS', 's is in the upper half of the group order (EIP-2 requires low-s)');

  return tx;
}

// ---- gas -------------------------------------------------------------------

/** Intrinsic gas, from the Shanghai schedule — node/src/evm/gas.js is the authority. */
export function intrinsicGas(tx) {
  const t = asTx(tx);
  const bytes = t.data;
  let gas = G.TX;
  if (isCreation(t)) gas += G.TX_CREATION;
  let zero = 0n, nonzero = 0n;
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 0) zero++; else nonzero++; }
  gas += zero * G.TX_DATA_ZERO + nonzero * G.TX_DATA_NONZERO;
  if (isCreation(t)) gas += G.INITCODE_WORD * BigInt(Math.ceil(bytes.length / 32));
  return gas;
}

export function initcodeTooLarge(size) { return BigInt(size) > G.MAX_INITCODE_SIZE; }

/**
 * The stateless gas rules: EIP-3860's initcode cap, and "the gas limit must at
 * least cover what the transaction owes before a single opcode runs".
 */
export function checkGas(tx) {
  const t = asTx(tx);
  if (isCreation(t) && initcodeTooLarge(t.data.length)) {
    throw new TxError('INITCODE_SIZE_EXCEEDED', `initcode is ${t.data.length} bytes, over the EIP-3860 cap of ${G.MAX_INITCODE_SIZE}`);
  }
  const need = intrinsicGas(t);
  if (t.gasLimit < need) throw new TxError('INTRINSIC_GAS_TOO_LOW', `gasLimit ${t.gasLimit} is below the intrinsic cost ${need}`);
  return need;
}

// ---- signing and recovery --------------------------------------------------

/**
 * Sign an unsigned transaction. `chainId: null` produces the pre-155
 * unprotected form; the wallet UI never asks for it, but the function keeps the
 * node's signature so the two can be compared directly in the self-test.
 *
 * @param {Uint8Array|string} privateKey  32 bytes
 */
export function sign(tx, privateKey, { chainId = CHAIN_ID } = {}) {
  const t = normalize(tx);
  const sig = secp.sign(signingHash(t, chainId), privateKey);
  /* recoveryId 2 and 3 mean r wrapped past the group order. A legacy v has no
   * room for that bit, so folding it away would produce a transaction every
   * other client recovers a DIFFERENT sender from. About 1 in 2^128. */
  if (sig.recoveryId > 1) throw new TxError('UNREPRESENTABLE_V', 'recovery id 2/3 cannot be encoded in a legacy v; re-sign');
  t.v = chainId === null || chainId === undefined
    ? BigInt(sig.recoveryId + 27)
    : BigInt(sig.recoveryId) + big(chainId) * 2n + 35n;
  t.r = sig.r;
  t.s = sig.s;
  t.chainId = chainId === null || chainId === undefined ? null : Number(chainId);
  t.protected = t.chainId !== null;
  t.recoveryId = sig.recoveryId;
  return t;
}

/**
 * The sender: whatever public key the signature recovers to. Returns 20 bytes,
 * or null when no key can have produced this signature.
 */
export function recoverSender(tx) {
  const t = asTx(tx);
  const cid = chainIdFromV(t.v);
  if (cid === undefined) return null;
  const recoveryId = cid === null ? Number(t.v - 27n) : Number((t.v - 35n) & 1n);
  const pub = secp.recoverPublicKey(
    signingHash(t, cid === null ? null : cid),
    { r: t.r, s: t.s, recoveryId },
    { lowS: true },
  );
  return pub === null ? null : addressFromPublicKey(pub);
}

/** The address a creation lands at: keccak256(rlp([sender, nonce]))[12:]. */
export function contractAddress(sender, nonce) {
  const from = toBuf(sender, 'sender');
  if (from.length !== 20) throw new TypeError('transaction: sender must be 20 bytes');
  return keccak256(RLP.encode([from, big(nonce)])).subarray(12);
}

/**
 * Everything decidable without chain state, in one call. Returns
 * `{ ok: false, code, error }` rather than throwing, matching the node's
 * `validate`, so the two can be compared case for case.
 */
export function validate(raw, { chainId = CHAIN_ID, maxBytes = MAX_TX_BYTES } = {}) {
  try {
    const bytes = raw instanceof Uint8Array || typeof raw === 'string' ? toBuf(raw, 'raw transaction') : encode(raw);
    if (maxBytes && bytes.length > maxBytes) throw new TxError('TX_TOO_LARGE', `${bytes.length} bytes, over the ${maxBytes} limit`);
    const tx = decode(bytes, { chainId });
    const intrinsic = checkGas(tx);
    const sender = recoverSender(tx);
    if (sender === null) throw new TxError('EC_RECOVERY_FAIL', 'signature recovers to no public key');
    return { ok: true, tx, sender, hash: keccak256(bytes), intrinsicGas: intrinsic, raw: bytes };
  } catch (e) {
    return { ok: false, code: e.code || 'RLP_ERROR', error: e.message };
  }
}

/**
 * THE WALLET'S OWN CHECK, and the reason this module carries a decoder.
 *
 * Sign, then throw the bytes away and read them back as a stranger would: decode
 * the RLP, recover the sender, re-derive the hash. Only if the recovered sender
 * is the account that was supposed to be spending, and every field survives the
 * round trip, is the transaction handed back for broadcast.
 *
 * It costs one extra recovery — a few milliseconds — and it is the difference
 * between a bug in this file bouncing at the node and a bug in this file
 * emptying an account into an address nobody has the key for.
 *
 * @returns {{tx, raw: Uint8Array, rawHex: string, hash: Uint8Array, hashHex: string,
 *            sender: Uint8Array, intrinsicGas: bigint}}
 */
export function signAndCheck(tx, privateKey, expectedSender, { chainId = CHAIN_ID } = {}) {
  const signed = sign(tx, privateKey, { chainId });
  const raw = encode(signed);

  const check = validate(raw, { chainId });
  if (!check.ok) throw new TxError(check.code, `the wallet signed a transaction it cannot itself validate — ${check.error}`);

  const want = toBuf(expectedSender, 'expected sender');
  if (want.length !== 20) throw new TypeError('transaction: expected sender must be 20 bytes');
  if (toHex(check.sender) !== toHex(want)) {
    throw new TxError('SENDER_MISMATCH',
      `the signature recovers to ${toHex(check.sender)}, not to ${toHex(want)} — refusing to broadcast`);
  }

  // Every field must survive encode -> decode unchanged. A silent coercion in
  // `normalize` would otherwise send a different amount from the one displayed.
  const d = check.tx;
  const same = d.nonce === signed.nonce && d.gasPrice === signed.gasPrice
    && d.gasLimit === signed.gasLimit && d.value === signed.value
    && toHex(d.data) === toHex(signed.data)
    && toHex(d.to || EMPTY) === toHex(signed.to || EMPTY)
    && d.v === signed.v && d.r === signed.r && d.s === signed.s;
  if (!same) throw new TxError('ROUND_TRIP', 'the signed bytes do not decode back to the transaction that was signed');

  return {
    tx: signed,
    raw,
    rawHex: toHex(raw),
    hash: check.hash,
    hashHex: toHex(check.hash),
    sender: check.sender,
    intrinsicGas: check.intrinsicGas,
  };
}
