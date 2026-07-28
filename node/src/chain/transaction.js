'use strict';
/* Legacy (type 0) transactions — encode, decode, hash, sign, recover.
 *
 *     [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
 *
 * A transaction carries no sender field. The sender IS whatever public key the
 * signature recovers to over the signing hash, so the encoding and the hash are
 * not a wire format — they are the identity of the payer. Every rule below
 * exists because breaking it lets two different byte strings mean the same
 * transaction, or one byte string mean two.
 *
 * WHY BOTH PROTECTED AND UNPROTECTED SIGNATURES ARE ACCEPTED (spec §3). An
 * EIP-155 transaction signs over the chain id, so it cannot be replayed
 * elsewhere; a pre-155 one does not. Ethereum still accepts pre-155, and so do
 * we, because an entire tier of infrastructure is deployed by *keyless*
 * presigned transactions — a made-up signature, broadcast from an address
 * nobody controls, so the contract lands at the same address on every chain.
 * Multicall3 at 0xcA11bde05977b3631167028862bE2a173976CA11 is deployed exactly
 * this way and every front-end assumes that address. Rejecting pre-155 makes it
 * permanently unreachable here. The replay risk sits with the sender, every
 * modern wallet signs with EIP-155, and it is the trade Ethereum itself makes.
 *
 * SCALAR CANONICALITY IS ENFORCED HERE AND NOWHERE ELSE (spec §5). RLP is
 * untyped: it decodes to byte strings and cannot know that `nonce` is a number
 * and must therefore carry no leading zero byte. The yellow paper requires
 * minimal-length scalars, and `0x0001` and `0x01` are different bytes that hash
 * differently — one node would accept a transaction the rest of the network
 * hashes to something else, which is a chain split with no error message
 * anywhere. So the decoder rejects a leading zero on nonce, gasPrice, gasLimit,
 * value, v, r and s. The EMPTY string is the canonical encoding of zero and is
 * valid; `0x00` is not.
 *
 * The upshot, and the property test/transaction.js leans on hardest: for every
 * transaction this module accepts, `encode(decode(raw))` must equal `raw` byte
 * for byte. If it ever does not, the two encodings both exist in the wild.
 *
 * Signature rules, in one place:
 *   - r, s in [1, n).
 *   - LOW-S IS REQUIRED (EIP-2): (r, n-s) verifies over the same message, so
 *     accepting both would give every transaction two hashes. Note that this is
 *     the exact opposite of the `ecrecover` precompile, which must NOT enforce
 *     it — audited contracts (Uniswap V2's `permit`, for one) depend on the
 *     precompile's permissiveness.
 *   - v is `recoveryId + 27` unprotected, or `recoveryId + chainId * 2 + 35`
 *     protected, with recoveryId 0 or 1. Recovery ids 2 and 3 (r wrapped past
 *     the group order) are unrepresentable in a legacy v and are refused when
 *     signing rather than encoded into something another client would misread.
 */

const { keccak256 } = require('../crypto/keccak');
const RLP = require('../crypto/rlp');
const secp = require('../crypto/secp256k1');
const gas = require('../evm/gas');
const P = require('../params');

/**
 * The EIP-155 chain id, spec §1 — 7411 on mainnet, 7412 on the testnet.
 *
 * READ FROM params, NEVER DECLARED HERE. It used to be a literal, and the two
 * networks would then have shared one id: every testnet transaction replayable on
 * mainnet and back, same key, same nonce, the same bytes valid on both. The UTXO
 * scheme this replaces put the network id inside the signed body, so it had that
 * protection structurally; EIP-155 concentrates it into this single number.
 */
const CHAIN_ID = P.CHAIN_ID;

const TX_TYPE_LEGACY = 0;

/* Field bounds. These are not stylistic: the reference tests assert each one,
 * because a client that widens any of them accepts a transaction the rest of
 * the network rejects and forks on the next block.
 *   - nonce and gasLimit are 64-bit (EIP-2681 for the nonce).
 *   - a nonce of exactly 2^64-1 is refused even though it fits: accepting it
 *     would require the account's nonce to become 2^64 afterwards, which has no
 *     encoding, so such a transaction can never be included by anyone.
 *   - gasPrice, value, r and s are 256-bit.
 *   - gasLimit * gasPrice is the maximum fee and must also fit in 256 bits. */
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

class TxError extends Error {
  constructor(code, message) {
    super(`transaction: ${message}`);
    this.name = 'TxError';
    this.code = code;
  }
}

// ---- coercions -------------------------------------------------------------

function toBuf(v, what) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    const h = v.replace(/^0x/i, '');
    if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new TypeError(`transaction: malformed hex ${what}`);
    return Buffer.from(h, 'hex');
  }
  throw new TypeError(`transaction: ${what} must be bytes or 0x-hex`);
}

function bufToBig(b) { return b.length === 0 ? 0n : BigInt('0x' + b.toString('hex')); }

function big(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new TypeError('transaction: quantity must be a non-negative safe integer or BigInt');
    return BigInt(v);
  }
  if (typeof v === 'string') return BigInt(v);
  if (v === null || v === undefined) return 0n;
  if (Buffer.isBuffer(v)) return bufToBig(v);
  throw new TypeError('transaction: cannot read a quantity from ' + typeof v);
}

/** A 20-byte address, or null for a creation. */
function toAddress(v, what = 'to') {
  if (v === null || v === undefined || v === '' || v === '0x') return null;
  const b = toBuf(v, what);
  if (b.length === 0) return null;
  if (b.length !== 20) throw new TxError(b.length > 20 ? 'ADDRESS_TOO_LONG' : 'ADDRESS_TOO_SHORT', `${what} must be 20 bytes or empty, got ${b.length}`);
  return b;
}

/** Last 20 bytes of keccak256 over the uncompressed key WITHOUT its 0x04 tag. */
function addressFromPublicKey(pub) {
  const b = toBuf(pub, 'public key');
  const body = b.length === 65 ? b.subarray(1) : b;
  if (body.length !== 64) throw new TypeError('transaction: public key must be 64 or 65 bytes');
  return keccak256(body).subarray(12);
}

// ---- the transaction object ------------------------------------------------

/* A transaction is a plain object with BigInt scalars, a Buffer `to` (or null)
 * and a Buffer `data`. `normalize` is the single door in: everything else in
 * this module assumes it has already run. */
function normalize(tx) {
  const t = {
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
  return t;
}

function isCreation(tx) { return tx.to === null || tx.to === undefined; }

/** The nine RLP fields, in order. `to` empty means creation. */
function fields(tx) {
  return [tx.nonce, tx.gasPrice, tx.gasLimit, tx.to || Buffer.alloc(0), tx.value, tx.data, tx.v, tx.r, tx.s];
}

/** Signed RLP. Every scalar goes through RLP's minimal integer encoding, which
 *  is what makes `encode(decode(raw))` byte-identical to `raw`. */
function encode(tx) {
  const t = tx.type === TX_TYPE_LEGACY && typeof tx.nonce === 'bigint' ? tx : normalize(tx);
  if (t.v === null || t.r === null || t.s === null) throw new TxError('UNSIGNED', 'cannot encode an unsigned transaction');
  return RLP.encode(fields(t));
}

/** The transaction hash: keccak256 over the signed RLP, not over any subset. */
function hash(tx) {
  return keccak256(Buffer.isBuffer(tx) ? tx : encode(tx));
}

/**
 * What the signature is actually over.
 *   protected:   keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]))
 *   unprotected: keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data]))
 * Pass `chainId = null` for the unprotected form. The two differ in more than
 * the trailing fields — the list length changes — so they can never collide.
 */
function signingHash(tx, chainId = CHAIN_ID) {
  const t = typeof tx.nonce === 'bigint' ? tx : normalize(tx);
  const base = [t.nonce, t.gasPrice, t.gasLimit, t.to || Buffer.alloc(0), t.value, t.data];
  if (chainId === null || chainId === undefined) return keccak256(RLP.encode(base));
  return keccak256(RLP.encode([...base, big(chainId), 0, 0]));
}

/** The chain id a v encodes, or null when v is the unprotected 27/28 form. */
function chainIdFromV(v) {
  if (v === 27n || v === 28n) return null;
  if (v < 35n) return undefined;                       // neither form: invalid
  return (v - 35n) >> 1n;
}

// ---- decoding --------------------------------------------------------------

/* One scalar, with the canonicality rule and its width bound. `what` names the
 * field so a rejection says which one, which is the difference between a
 * five-minute and a five-hour debug of a live mempool. */
function scalar(raw, what, maxBytes, code) {
  if (!Buffer.isBuffer(raw)) throw new TxError(`RLP_INVALID_${what}`, `${what.toLowerCase()} is a list, not a scalar`);
  if (raw.length > 0 && raw[0] === 0) throw new TxError(`RLP_LEADING_ZEROS_${what}`, `${what.toLowerCase()} has a leading zero byte — the canonical encoding of zero is empty`);
  if (raw.length > maxBytes) throw new TxError(code, `${what.toLowerCase()} exceeds ${maxBytes * 8} bits`);
  return bufToBig(raw);
}

/**
 * Decode signed RLP into a transaction, rejecting every non-canonical and
 * out-of-range form. This is the structural half of validity: it does not need
 * chain state, and it does not recover the sender (which is ~1000x more
 * expensive — see `recoverSender`). It DOES check the chain id, because a
 * transaction signed for another chain is not a transaction here at all.
 *
 * @throws {TxError} with a `code` naming the rule broken.
 */
function decode(raw, { chainId = CHAIN_ID } = {}) {
  const bytes = toBuf(raw, 'raw transaction');
  if (bytes.length === 0) throw new TxError('RLP_ERROR_SIZE', 'empty input');
  /* EIP-2718 reserved 0x00–0x7f as transaction-type envelopes precisely so
   * that a typed transaction can never be mistaken for the RLP list a legacy
   * one starts with. Hearth v1 is legacy-only (spec §3), so say which type
   * arrived rather than letting RLP fail obscurely three frames down. */
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
    data: Buffer.alloc(0),
    v: 0n,
    r: 0n,
    s: 0n,
  };

  if (!Buffer.isBuffer(to)) throw new TxError('RLP_INVALID_TO', 'to is a list, not an address');
  tx.to = toAddress(to);
  tx.value = scalar(value, 'VALUE', 32, 'VALUE_OVERFLOW');
  if (!Buffer.isBuffer(data)) throw new TxError('RLP_INVALID_DATA', 'data is a list, not a byte string');
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
  /* EIP-2. See the header: the ecrecover precompile must NOT do this. */
  if (tx.s > secp.N_HALF) throw new TxError('INVALID_SIGNATURE_VRS', 's is in the upper half of the group order (EIP-2 requires low-s)');

  return tx;
}

// ---- gas -------------------------------------------------------------------

/** Intrinsic gas, straight from the Shanghai schedule — see evm/gas.js. */
function intrinsicGas(tx) {
  const t = typeof tx.nonce === 'bigint' ? tx : normalize(tx);
  return gas.intrinsicGas({ data: t.data, isCreation: isCreation(t) });
}

/**
 * The stateless gas rules: EIP-3860's initcode cap and "the gas limit must at
 * least cover what the transaction owes before a single opcode runs". Both are
 * pure functions of the transaction, so a node can reject on them at the edge
 * of the mempool without touching state.
 */
function checkGas(tx) {
  const t = typeof tx.nonce === 'bigint' ? tx : normalize(tx);
  if (isCreation(t) && gas.initcodeTooLarge(t.data.length)) {
    throw new TxError('INITCODE_SIZE_EXCEEDED', `initcode is ${t.data.length} bytes, over the EIP-3860 cap of ${gas.G.MAX_INITCODE_SIZE}`);
  }
  const need = intrinsicGas(t);
  if (t.gasLimit < need) throw new TxError('INTRINSIC_GAS_TOO_LOW', `gasLimit ${t.gasLimit} is below the intrinsic cost ${need}`);
  return need;
}

// ---- signing and recovery --------------------------------------------------

/**
 * Sign an unsigned transaction. `chainId: null` produces the pre-155
 * unprotected form, which is what a keyless presigned deployment needs.
 */
function sign(tx, privateKey, { chainId = CHAIN_ID } = {}) {
  const t = normalize(tx);
  const sig = secp.sign(signingHash(t, chainId), privateKey);
  /* recoveryId 2 and 3 mean r wrapped past the group order. A legacy v has no
   * room for that bit, so an implementation that folds it away would produce a
   * transaction every other client recovers a DIFFERENT sender from. It needs a
   * key near 2^256/n — about 1 in 2^128 — so refusing is free and honest. */
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
 * The sender: whatever public key the signature recovers to. Returns a 20-byte
 * Buffer, or null when no key can have produced this signature — an
 * unrecoverable transaction is invalid, not an exception on a validation path
 * that is fed arbitrary bytes by strangers.
 */
function recoverSender(tx) {
  const t = typeof tx.nonce === 'bigint' ? tx : normalize(tx);
  /* `decode` and `sign` both leave these behind; a hand-built object has only
   * v. Deriving them here rather than round-tripping through `decode` means
   * recovery never depends on which chain id the caller happens to be using —
   * v alone says whether this signature covers one. */
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
function contractAddress(sender, nonce) {
  const from = toBuf(sender, 'sender');
  if (from.length !== 20) throw new TypeError('transaction: sender must be 20 bytes');
  return keccak256(RLP.encode([from, big(nonce)])).subarray(12);
}

// ---- the composed check ----------------------------------------------------

/**
 * Everything decidable without chain state, in one call: structure,
 * canonicality, signature, gas, size, and the sender.
 *
 * Returns `{ ok: false, code, error }` rather than throwing, because this is
 * the function a mempool and a block validator call on hostile input and
 * neither wants a try/catch around every transaction in a block. What is left
 * for the state transition is exactly three things: the nonce matches the
 * account, the balance covers `value + gasLimit * gasPrice`, and `gasLimit`
 * fits in the block's remaining gas.
 */
function validate(raw, { chainId = CHAIN_ID, maxBytes = P.MAX_TX_BYTES } = {}) {
  try {
    const bytes = Buffer.isBuffer(raw) || typeof raw === 'string' ? toBuf(raw, 'raw transaction') : encode(raw);
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

module.exports = {
  CHAIN_ID, TX_TYPE_LEGACY, MAX_UINT64, MAX_UINT256, TxError,
  normalize, isCreation, fields,
  encode, decode, hash, signingHash, chainIdFromV,
  intrinsicGas, checkGas,
  sign, recoverSender, contractAddress, addressFromPublicKey,
  validate,
};
