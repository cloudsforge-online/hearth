'use strict';
/* The JSON-RPC hex codec, and the error type the whole layer throws.
 *
 * Ethereum's JSON-RPC has TWO hex encodings, and every client is strict about
 * which one it expects where. Mixing them up is the single most common defect
 * in a hand-written RPC, and it does not surface as an error — it surfaces as
 * "MetaMask shows the wrong balance", days later, from a user.
 *
 *   QUANTITY — a number. `0x` + the SHORTEST hex, no leading zeros.
 *              0 is "0x0". Never "0x00", never "0x". 65 is "0x41".
 *              Used for: balances, nonces, gas, block numbers, timestamps,
 *              difficulty, log indices, status, v/r/s.
 *
 *   DATA     — a byte string. `0x` + EXACTLY two hex digits per byte, leading
 *              zeros preserved, so the length is fixed by the type. A 32-byte
 *              hash is always 66 characters; an empty byte string is "0x".
 *              Used for: hashes, addresses, code, input, log data, topics,
 *              logsBloom, storage values, extraData, the block nonce.
 *
 * The rule of thumb: if you would ever want to add one to it, it is a QUANTITY.
 *
 * DECODING IS STRICT, on purpose. A leading-zero QUANTITY ("0x01") is rejected
 * rather than coerced, matching go-ethereum's hexutil, because silently
 * accepting it here means we never find out that some caller is generating
 * non-canonical hex — and the same caller will later hand a non-canonical
 * scalar to the transaction decoder, where it is a consensus fault (see
 * docs/evm-spec.md §5, "scalar canonicality"). The one deliberate exception is
 * `decodeStorageKey`, which geth also relaxes; it is documented there.
 *
 * RpcError lives here rather than in server.js because this is the lowest
 * module in the layer — the codec is where most invalid-params errors are
 * raised — and methods.js and server.js both sit above it. A fourth file for
 * one class would be worse.
 */

const CODES = Object.freeze({
  PARSE_ERROR: -32700,      // malformed JSON
  INVALID_REQUEST: -32600,  // valid JSON, not a valid JSON-RPC request object
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,   // wrong arity, wrong type, malformed hex
  INTERNAL_ERROR: -32603,   // a bug in us
  SERVER_ERROR: -32000,     // geth's catch-all: unknown block, nonce too low, …
  EXECUTION_REVERTED: 3,    // EIP-1474; `data` carries the raw revert payload
});

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
  static invalidParams(message) { return new RpcError(CODES.INVALID_PARAMS, message); }
  static invalidRequest(message) { return new RpcError(CODES.INVALID_REQUEST, message); }
  static methodNotFound(message) { return new RpcError(CODES.METHOD_NOT_FOUND, message); }
  static internal(message) { return new RpcError(CODES.INTERNAL_ERROR, message); }
  static server(message, data) { return new RpcError(CODES.SERVER_ERROR, message, data); }
}

// "0x0" or "0x" + a hex string that does not start with 0. Case-insensitive on
// input; everything we emit is lower case.
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
// "0x" (the empty byte string) or an even number of hex digits.
const DATA_RE = /^0x(?:[0-9a-fA-F][0-9a-fA-F])*$/;
const MAX_QUANTITY_DIGITS = 64;   // 256 bits, the widest scalar this chain has

function isBytes(v) { return v instanceof Uint8Array; }

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Truncated for error messages: a caller can send a megabyte of "hex". */
function clip(s) {
  const str = String(s);
  return str.length > 40 ? str.slice(0, 40) + '…' : str;
}

function toBuf(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

// ---- QUANTITY --------------------------------------------------------------

/**
 * Encode a non-negative integer as a QUANTITY.
 *
 * Accepts bigint, a safe integer Number, or a Uint8Array (big-endian, leading
 * zeros stripped — a chain that hands us a padded 32-byte balance still gets
 * "0x0" for zero). Anything else is a bug on our side, not the caller's, so it
 * raises INTERNAL_ERROR rather than INVALID_PARAMS.
 */
function encodeQuantity(value, what = 'value') {
  let n;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw RpcError.internal(`${what}: ${value} is not a safe integer`);
    n = BigInt(value);
  } else if (isBytes(value)) {
    n = value.length ? BigInt('0x' + toBuf(value).toString('hex')) : 0n;
  } else {
    throw RpcError.internal(`${what}: cannot encode ${typeName(value)} as a QUANTITY`);
  }
  if (n < 0n) throw RpcError.internal(`${what}: negative quantity ${n}`);
  return '0x' + n.toString(16);   // BigInt#toString never emits leading zeros
}

/** Decode a QUANTITY to a bigint. Rejects leading zeros, "0x", and non-strings. */
function decodeQuantity(value, what = 'value') {
  if (typeof value !== 'string') {
    // JSON numbers are refused deliberately: 2^53 is not big enough for wei,
    // so a client that sends one has already lost precision.
    throw RpcError.invalidParams(`${what}: expected a hex QUANTITY string, got ${typeName(value)}`);
  }
  if (!QUANTITY_RE.test(value)) {
    throw RpcError.invalidParams(
      `${what}: "${clip(value)}" is not a valid hex QUANTITY — 0x-prefixed, no leading zeros, zero is "0x0"`);
  }
  if (value.length - 2 > MAX_QUANTITY_DIGITS) {
    throw RpcError.invalidParams(`${what}: quantity is wider than 256 bits`);
  }
  return BigInt(value);
}

/** Decode a QUANTITY that must fit a JS number (block numbers, indices). */
function decodeQuantityNumber(value, what = 'value') {
  const n = decodeQuantity(value, what);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw RpcError.invalidParams(`${what}: value out of range`);
  return Number(n);
}

// ---- DATA ------------------------------------------------------------------

/** Encode a byte string as DATA, preserving every leading zero byte. */
function encodeData(value, what = 'value') {
  if (!isBytes(value)) throw RpcError.internal(`${what}: cannot encode ${typeName(value)} as DATA`);
  return '0x' + toBuf(value).toString('hex');
}

/**
 * Encode fixed-width DATA — a hash, an address, a bloom, a storage word.
 *
 * Bytes must already be exactly `size` long (a short hash is a bug worth
 * hearing about, not something to pad over); an integer is left-padded, which
 * is how a storage value or a topic arrives when the state layer hands us a
 * 256-bit word rather than a buffer.
 */
function encodeDataFixed(value, size, what = 'value') {
  if (isBytes(value)) {
    if (value.length !== size) {
      throw RpcError.internal(`${what}: expected ${size} bytes, got ${value.length}`);
    }
    return '0x' + toBuf(value).toString('hex');
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    const n = typeof value === 'number' ? BigInt(value) : value;
    if (n < 0n) throw RpcError.internal(`${what}: negative`);
    const hex = n.toString(16);
    if (hex.length > size * 2) throw RpcError.internal(`${what}: does not fit in ${size} bytes`);
    return '0x' + hex.padStart(size * 2, '0');
  }
  throw RpcError.internal(`${what}: cannot encode ${typeName(value)} as ${size}-byte DATA`);
}

const encodeHash = (v, what = 'hash') => encodeDataFixed(v, 32, what);
const encodeAddress = (v, what = 'address') => encodeDataFixed(v, 20, what);
const encodeBloom = (v, what = 'logsBloom') => encodeDataFixed(v, 256, what);

/** Decode DATA to a Buffer. "0x" is valid and means zero bytes. */
function decodeData(value, what = 'value') {
  if (typeof value !== 'string') {
    throw RpcError.invalidParams(`${what}: expected a hex DATA string, got ${typeName(value)}`);
  }
  if (!DATA_RE.test(value)) {
    throw RpcError.invalidParams(
      `${what}: "${clip(value)}" is not valid hex DATA — 0x-prefixed with two hex digits per byte`);
  }
  return Buffer.from(value.slice(2), 'hex');
}

/** Decode DATA of an exact byte length. This is what makes a bad hash an error. */
function decodeDataFixed(value, size, what = 'value') {
  const b = decodeData(value, what);
  if (b.length !== size) {
    throw RpcError.invalidParams(
      `${what}: expected ${size} bytes (${size * 2 + 2} characters), got ${b.length}`);
  }
  return b;
}

const decodeHash = (v, what = 'hash') => decodeDataFixed(v, 32, what);
const decodeAddress = (v, what = 'address') => decodeDataFixed(v, 20, what);

/**
 * A storage slot, decoded leniently — and this leniency is deliberate.
 *
 * The spec calls the position a QUANTITY, real clients send anything from
 * "0x0" to a full 32-byte word, and some send odd-length hex. geth relaxes the
 * rule here (`decodeHash`) and so must we, or `eth_getStorageAt` fails against
 * half the tooling. Everything is left-padded to a 32-byte key.
 */
function decodeStorageKey(value, what = 'position') {
  if (typeof value !== 'string') {
    throw RpcError.invalidParams(`${what}: expected a hex string, got ${typeName(value)}`);
  }
  let hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (hex.length % 2) hex = '0' + hex;
  if (/[^0-9a-fA-F]/.test(hex)) throw RpcError.invalidParams(`${what}: "${clip(value)}" is not hex`);
  if (hex.length > 64) throw RpcError.invalidParams(`${what}: storage key is wider than 32 bytes`);
  return Buffer.from(hex.padStart(64, '0'), 'hex');
}

// ---- block parameters ------------------------------------------------------

/*
 * `safe` and `finalized` came from the merge and mean nothing on a
 * proof-of-work chain — but wallets and indexers ask for them anyway, and a
 * node that errors on them looks broken. Here they mean "the tip minus
 * CONFIRMATIONS blocks", which is the honest proof-of-work analogue: a block
 * that deep is not final, but it is as settled as this chain can say. Both tags
 * resolve to the same height in v1; they are separate names so a later,
 * stronger notion of finality can move `finalized` without touching `safe`.
 */
const BLOCK_TAGS = new Set(['latest', 'earliest', 'pending', 'safe', 'finalized']);

/**
 * Parse a block parameter into one of:
 *   { tag: 'latest' | 'earliest' | 'pending' | 'safe' | 'finalized' }
 *   { number: bigint }
 *   { hash: Buffer(32), requireCanonical: boolean }      (EIP-1898)
 * Absent or null means `latest`, which is what every client assumes.
 */
function parseBlockParam(value, what = 'block') {
  if (value === undefined || value === null) return { tag: 'latest' };
  if (typeof value === 'string') {
    if (BLOCK_TAGS.has(value)) return { tag: value };
    return { number: decodeQuantity(value, what) };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const hasHash = value.blockHash !== undefined && value.blockHash !== null;
    const hasNum = value.blockNumber !== undefined && value.blockNumber !== null;
    if (hasHash && hasNum) {
      throw RpcError.invalidParams(`${what}: cannot specify both blockHash and blockNumber`);
    }
    if (hasHash) {
      return {
        hash: decodeHash(value.blockHash, `${what}.blockHash`),
        requireCanonical: value.requireCanonical === true,
      };
    }
    if (hasNum) {
      if (typeof value.blockNumber === 'string' && BLOCK_TAGS.has(value.blockNumber)) {
        return { tag: value.blockNumber };
      }
      return { number: decodeQuantity(value.blockNumber, `${what}.blockNumber`) };
    }
  }
  throw RpcError.invalidParams(
    `${what}: expected a block number, one of ${[...BLOCK_TAGS].join('/')}, or an EIP-1898 object`);
}

module.exports = {
  CODES, RpcError,
  QUANTITY_RE, DATA_RE, BLOCK_TAGS,
  encodeQuantity, decodeQuantity, decodeQuantityNumber,
  encodeData, encodeDataFixed, encodeHash, encodeAddress, encodeBloom,
  decodeData, decodeDataFixed, decodeHash, decodeAddress, decodeStorageKey,
  parseBlockParam,
};
