'use strict';
/* RLP — Recursive Length Prefix, the Ethereum yellow paper's serialization.
 *
 * The decoder is deliberately, unfashionably strict. RLP is the input to hashes
 * that are consensus — the transaction hash, every trie node, every receipt —
 * so an encoding is not merely a wire format, it is an identity. If two
 * distinct byte strings decoded to the same value then one object would have
 * two valid encodings and therefore two different roots, and two nodes reading
 * the same block would disagree about state. A permissive decoder is a chain
 * split with a delay fuse.
 *
 * So every non-canonical form throws: a length carrying leading zeros, a long
 * form used where the short form fits, a one-byte string below 0x80 that should
 * have encoded as itself, a length that overruns its buffer, and trailing bytes
 * after the top-level item.
 */

/** Minimal big-endian bytes of a non-negative integer. Zero is the empty string. */
function intToBytes(n) {
  let v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) throw new TypeError('rlp: cannot encode a negative integer');
  const out = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Buffer.from(out);
}

/** Coerce a leaf to bytes. `0x…` strings are hex, other strings UTF-8. */
function toBytes(v) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'bigint') return intToBytes(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError('rlp: numbers must be safe integers — use BigInt');
    return intToBytes(v);
  }
  if (typeof v === 'string') {
    if (!/^0x/i.test(v)) return Buffer.from(v, 'utf8');
    const hex = v.slice(2);
    if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new TypeError('rlp: malformed hex string');
    return Buffer.from(hex, 'hex');
  }
  throw new TypeError('rlp: cannot encode ' + typeof v);
}

/** Length prefix: `base + len` short, `base + 55 + lenOfLen` long. */
function prefix(len, base) {
  if (len <= 55) return Buffer.from([base + len]);
  const l = intToBytes(len);
  return Buffer.concat([Buffer.from([base + 55 + l.length]), l]);
}

/** Encode a Buffer / string / integer / null, or an array of them, recursively. */
function encode(input) {
  if (Array.isArray(input)) {
    const body = Buffer.concat(input.map(encode));
    return Buffer.concat([prefix(body.length, 0xc0), body]);
  }
  const b = toBytes(input);
  if (b.length === 1 && b[0] < 0x80) return Buffer.from(b);
  return Buffer.concat([prefix(b.length, 0x80), b]);
}

function need(b, off, len) {
  if (off + len > b.length) throw new Error('rlp: item runs past the end of the input');
}

/** A copy, not a view, so a decoded value can never alias (or mutate) the input. */
function cut(b, off, len) {
  return Buffer.from(b.subarray(off, off + len));
}

function readLen(b, off, n) {
  if (b[off] === 0) throw new Error('rlp: leading zero in a long-form length');
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + b[off + i];
  if (!Number.isSafeInteger(len)) throw new Error('rlp: length beyond what this decoder can address');
  if (len <= 55) throw new Error('rlp: long form used for a length the short form encodes');
  return len;
}

/** Decode one item at `off`; returns its value and how many bytes it consumed. */
function item(b, off) {
  if (off >= b.length) throw new Error('rlp: input ended mid-item');
  const p = b[off];

  if (p <= 0x7f) return { value: cut(b, off, 1), read: 1 };

  if (p <= 0xb7) {                                    // string, 0–55 bytes
    const len = p - 0x80;
    need(b, off + 1, len);
    if (len === 1 && b[off + 1] <= 0x7f) throw new Error('rlp: single byte < 0x80 must encode as itself');
    return { value: cut(b, off + 1, len), read: 1 + len };
  }

  if (p <= 0xbf) {                                    // string, long form
    const n = p - 0xb7;
    need(b, off + 1, n);
    const len = readLen(b, off + 1, n);
    need(b, off + 1 + n, len);
    return { value: cut(b, off + 1 + n, len), read: 1 + n + len };
  }

  if (p <= 0xf7) {                                    // list, payload 0–55 bytes
    const len = p - 0xc0;
    need(b, off + 1, len);
    return { value: items(b, off + 1, len), read: 1 + len };
  }

  const n = p - 0xf7;                                 // list, long form
  need(b, off + 1, n);
  const len = readLen(b, off + 1, n);
  need(b, off + 1 + n, len);
  return { value: items(b, off + 1 + n, len), read: 1 + n + len };
}

function items(b, off, len) {
  const end = off + len, out = [];
  for (let i = off; i < end;) {
    const it = item(b, i);
    // `item` only bounds-checks against the whole buffer; a nested item can sit
    // inside the buffer yet overrun the list that declared it.
    if (i + it.read > end) throw new Error('rlp: list item overruns its list');
    out.push(it.value);
    i += it.read;
  }
  return out;
}

/**
 * Decode a complete RLP item. Strings come back as Buffers, lists as arrays;
 * integers are the caller's job to read, since RLP does not record the type.
 * Input must be bytes or a `0x…` hex string — a bare string is not accepted,
 * because guessing between hex and UTF-8 on a decode path is how you silently
 * decode the wrong thing.
 */
function decode(input) {
  if (typeof input === 'string' && !/^0x/i.test(input)) throw new TypeError('rlp: decode needs bytes or a 0x-prefixed hex string');
  const b = toBytes(input);
  if (b.length === 0) throw new Error('rlp: empty input');
  const { value, read } = item(b, 0);
  if (read !== b.length) throw new Error('rlp: trailing bytes after the top-level item');
  return value;
}

module.exports = { encode, decode, intToBytes, toBytes };
