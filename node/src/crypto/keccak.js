'use strict';
/* Keccak-256 — the hash Ethereum actually uses, which is NOT SHA3-256.
 *
 * Both are the same sponge over the same Keccak-f[1600] permutation at the same
 * rate. They differ in exactly one byte: the domain-separation suffix appended
 * before the pad. Original Keccak — which Ethereum froze on, years before
 * FIPS-202 existed — appends 0x01; SHA3 appends 0x06. So
 * `crypto.createHash('sha3-256')` returns a *different* digest for every input
 * and is useless here. Hence this file, and hence no shortcut.
 *
 * The state is a Uint32Array of 50 words holding lane i as [lo, hi] at 2i and
 * 2i+1. That is precisely the little-endian byte order the sponge absorbs in,
 * so absorbing a block is a plain XOR of 32-bit words with no marshalling, and
 * we avoid BigInt in the inner loop of what will be the node's hottest hash.
 */

const RATE = 136;                        // (1600 - 2*256) / 8 — bytes per block

// Keccak-f[1600] round constants, as (hi, lo) 32-bit halves.
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);

// Lane index is x + 5y. ROT[i] is the rho offset, PI[i] the destination lane
// that lane i moves to under pi (B[y][2x+3y] = A[x][y]).
const ROT = new Uint8Array(25);
const PI = new Uint8Array(25);
{
  const r = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
             [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];   // r[x][y]
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
    ROT[x + 5 * y] = r[x][y];
    PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);
  }
}

// Scratch, hoisted out of the round loop. Safe because nothing here reenters.
const _C = new Uint32Array(10);
const _D = new Uint32Array(10);
const _B = new Uint32Array(50);

/** Keccak-f[1600], in place, over a 50-word (25-lane) state. */
function _permute(s) {
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      let lo = 0, hi = 0;
      for (let y = 0; y < 5; y++) { const j = 2 * (x + 5 * y); lo ^= s[j]; hi ^= s[j + 1]; }
      _C[2 * x] = lo; _C[2 * x + 1] = hi;
    }
    for (let x = 0; x < 5; x++) {
      const p = 2 * ((x + 4) % 5), n = 2 * ((x + 1) % 5);
      _D[2 * x] = _C[p] ^ ((_C[n] << 1) | (_C[n + 1] >>> 31));
      _D[2 * x + 1] = _C[p + 1] ^ ((_C[n + 1] << 1) | (_C[n] >>> 31));
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      const j = 2 * (x + 5 * y);
      s[j] ^= _D[2 * x]; s[j + 1] ^= _D[2 * x + 1];
    }
    // rho (rotate) + pi (move), fused into one pass over the lanes
    for (let i = 0; i < 25; i++) {
      const n = ROT[i], j = 2 * i, d = 2 * PI[i], lo = s[j], hi = s[j + 1];
      if (n === 0) { _B[d] = lo; _B[d + 1] = hi; }
      else if (n < 32) { _B[d] = (lo << n) | (hi >>> (32 - n)); _B[d + 1] = (hi << n) | (lo >>> (32 - n)); }
      else if (n === 32) { _B[d] = hi; _B[d + 1] = lo; }
      else { const m = n - 32; _B[d] = (hi << m) | (lo >>> (32 - m)); _B[d + 1] = (lo << m) | (hi >>> (32 - m)); }
    }
    // chi
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const j = 2 * (x + 5 * y), a = 2 * ((x + 1) % 5 + 5 * y), b = 2 * ((x + 2) % 5 + 5 * y);
      s[j] = _B[j] ^ (~_B[a] & _B[b]);
      s[j + 1] = _B[j + 1] ^ (~_B[a + 1] & _B[b + 1]);
    }
    // iota
    s[0] ^= RC_LO[round]; s[1] ^= RC_HI[round];
  }
  return s;
}

/**
 * The sponge, parameterised by suffix and rate so one body serves Keccak and,
 * in the tests, FIPS-202. `rate` must be a multiple of 4.
 */
function _sponge(msg, suffix, rate, outLen) {
  const s = new Uint32Array(50);
  const words = rate >>> 2;
  let off = 0;
  for (; msg.length - off >= rate; off += rate) {
    for (let i = 0; i < words; i++) s[i] ^= msg.readUInt32LE(off + i * 4);
    _permute(s);
  }
  // The tail block: suffix at the first free byte, 0x80 at the last. When the
  // tail is rate-1 bytes long those are the same byte and the two ORs collapse
  // into 0x81 — the one-byte padding case, and the classic place to get it wrong.
  const last = Buffer.alloc(rate);
  msg.copy(last, 0, off);
  last[msg.length - off] ^= suffix;
  last[rate - 1] ^= 0x80;
  for (let i = 0; i < words; i++) s[i] ^= last.readUInt32LE(i * 4);
  _permute(s);

  const out = Buffer.alloc(outLen);
  for (let done = 0; ;) {
    const n = Math.min(rate, outLen - done);
    for (let j = 0; j < n; j++) out[done + j] = (s[j >>> 2] >>> ((j & 3) * 8)) & 0xff;
    done += n;
    if (done >= outLen) break;
    _permute(s);
  }
  return out;
}

/**
 * Coerce to bytes. A string is UTF-8 unless it is `0x`-prefixed, in which case
 * it is hex — the convention every EVM tool uses, so callers are not surprised.
 */
function toBytes(v) {
  if (Buffer.isBuffer(v)) return v;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') {
    if (!/^0x/i.test(v)) return Buffer.from(v, 'utf8');
    const hex = v.slice(2);
    // Buffer.from(…,'hex') truncates silently at the first bad character, which
    // would hash a prefix of what the caller meant. Reject instead.
    if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new TypeError('keccak256: malformed hex string');
    return Buffer.from(hex, 'hex');
  }
  throw new TypeError('keccak256: expected Buffer, TypedArray or string');
}

/** Keccak-256 of a Buffer, TypedArray, UTF-8 string or `0x…` hex string. */
function keccak256(input) {
  return _sponge(toBytes(input), 0x01, RATE, 32);
}

/** Same digest as bare lowercase hex, no `0x` — matching the rest of the node. */
function keccak256Hex(input) {
  return keccak256(input).toString('hex');
}

module.exports = {
  keccak256, keccak256Hex, RATE,
  // Exported for conformance testing only. `_permute` is pinned directly
  // against the Keccak team's KeccakF-1600 intermediate values, and `_sponge`
  // lets the test drive this same permutation with FIPS-202 padding so it can
  // be diffed against Node's built-in sha3/shake at every length — which is the
  // strongest available check that everything but the suffix byte is right.
  _permute, _sponge, toBytes,
};
