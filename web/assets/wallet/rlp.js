/* RLP for the browser — a port of node/src/crypto/rlp.js, which is the authority.
 *
 * The decoder is deliberately, unfashionably strict, for the same reason it is
 * there: an RLP encoding is not a wire format, it is an identity. The hash of a
 * transaction is the hash of these bytes, so if two distinct byte strings
 * decoded to the same value, one transaction would have two hashes.
 *
 * A wallet needs the DECODER as much as the encoder, which is not obvious. It
 * needs it to check its own work: `decode(encode(tx))` must round-trip, and the
 * signed bytes it is about to broadcast must decode back to exactly the fields
 * the user was shown. That check is the whole defence against a bug in this file
 * silently sending value somewhere else.
 *
 * Leaves are Uint8Array (the node's are Buffer); lists are arrays. Everything
 * else is line-for-line the node's.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function isBytes(v) { return v instanceof Uint8Array; }

export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Minimal big-endian bytes of a non-negative integer. Zero is the empty string. */
export function intToBytes(n) {
  let v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) throw new TypeError('rlp: cannot encode a negative integer');
  const out = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Uint8Array.from(out);
}

/** Coerce a leaf to bytes. `0x…` strings are hex, other strings UTF-8. */
export function toBytes(v) {
  if (v === null || v === undefined) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'bigint') return intToBytes(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError('rlp: numbers must be safe integers — use BigInt');
    return intToBytes(v);
  }
  if (typeof v === 'string') {
    if (!/^0x/i.test(v)) return enc.encode(v);
    const hex = v.slice(2);
    if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new TypeError('rlp: malformed hex string');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new TypeError('rlp: cannot encode ' + typeof v);
}

/** Length prefix: `base + len` short, `base + 55 + lenOfLen` long. */
function prefix(len, base) {
  if (len <= 55) return Uint8Array.of(base + len);
  const l = intToBytes(len);
  return concatBytes([Uint8Array.of(base + 55 + l.length), l]);
}

/** Encode bytes / string / integer / null, or an array of them, recursively. */
export function encode(input) {
  if (Array.isArray(input)) {
    const body = concatBytes(input.map(encode));
    return concatBytes([prefix(body.length, 0xc0), body]);
  }
  const b = toBytes(input);
  if (b.length === 1 && b[0] < 0x80) return Uint8Array.from(b);
  return concatBytes([prefix(b.length, 0x80), b]);
}

function need(b, off, len) {
  if (off + len > b.length) throw new Error('rlp: item runs past the end of the input');
}

/** A copy, not a view, so a decoded value can never alias (or mutate) the input. */
function cut(b, off, len) {
  return Uint8Array.from(b.subarray(off, off + len));
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
 * Decode a complete RLP item. Strings come back as Uint8Array, lists as arrays;
 * integers are the caller's job to read, since RLP does not record the type.
 * Input must be bytes or a `0x…` hex string — a bare string is not accepted,
 * because guessing between hex and UTF-8 on a decode path is how you silently
 * decode the wrong thing.
 */
export function decode(input) {
  if (typeof input === 'string' && !/^0x/i.test(input)) throw new TypeError('rlp: decode needs bytes or a 0x-prefixed hex string');
  const b = toBytes(input);
  if (b.length === 0) throw new Error('rlp: empty input');
  const { value, read } = item(b, 0);
  if (read !== b.length) throw new Error('rlp: trailing bytes after the top-level item');
  return value;
}

export const utf8 = s => enc.encode(s);
export const fromUtf8 = b => dec.decode(b);
