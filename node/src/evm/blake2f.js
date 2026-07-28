'use strict';
/* BLAKE2b's compression function F — precompile 0x09, EIP-152.
 *
 * This is not "BLAKE2b as a hash". The precompile exposes exactly one call of the
 * compression function, with the round count, chaining state, message block, byte
 * counter and final-block flag all supplied by the caller. That is deliberate: it
 * lets a contract verify Zcash-style Equihash and interoperate with chains whose
 * headers are BLAKE2b, which needs the *intermediate* state, not a digest.
 *
 * INPUT IS EXACTLY 213 BYTES. Not "at least", not zero-padded — 213, or the call
 * fails. This is the one precompile with no padding rule, because a truncated
 * state block is not a shorter message, it is a different message.
 *
 *     [0,   4)   rounds     uint32   BIG-endian
 *     [4,  68)   h          8 x u64  LITTLE-endian
 *     [68, 196)  m         16 x u64  LITTLE-endian
 *     [196,212)  t          2 x u64  LITTLE-endian
 *     [212,213)  f          1 byte, 0 or 1 — ANY OTHER VALUE FAILS
 *
 * THE ENDIAN MISMATCH IS THE BUG EVERY IMPLEMENTATION WRITES FIRST. The round
 * count is big-endian and everything after it is little-endian, in the same 213
 * bytes. EIP-152 chose it that way — big-endian because that is how the EVM reads
 * a number, little-endian because that is how RFC 7693 defines BLAKE2b's state.
 * Read the whole thing one way and the vectors that use round counts of 0, 1 and
 * 12 will still look plausible while the digest is silently wrong.
 *
 * The rejection of f = 2..255 is equally load-bearing: EIP-152 gives that byte two
 * legal values, and a client that treats "non-zero means final" accepts blocks
 * that Ethereum rejects.
 *
 * Everything runs on 32-bit halves in a Uint32Array rather than BigInt. BLAKE2b is
 * all 64-bit adds, xors and rotations; BigInt would allocate on every one of the
 * ~1,000 operations per round, and the round count is attacker-chosen up to the
 * block gas limit.
 */

/** Gas is one per round, so `rounds` is a denial-of-service knob bounded only by
 *  what the caller can pay. Nothing here allocates per round. */
const OUTPUT_BYTES = 64;
const INPUT_BYTES = 213;

/* IV, as [low, high] pairs of the eight 64-bit words. */
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85,
  0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

/* The message schedule, RFC 7693 §2.7. Ten permutations; BLAKE2b's twelve rounds
 * reuse rows 0 and 1, and EIP-152's arbitrary round count keeps cycling mod 10.
 * Stored pre-doubled because the message words are held as 32-bit halves. */
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const SIGMA2 = SIGMA.map((row) => Uint32Array.from(row, (i) => i * 2));

/* The working vector and the message block, allocated once. Both are fully
 * overwritten at the start of every compression, so reuse is safe and saves two
 * allocations per call; nothing here is re-entrant and nothing here yields. */
const V = new Uint32Array(32);
const M = new Uint32Array(32);

/** v[a] += v[b], on the 64-bit word starting at half-word `a`. */
function add64(a, b) {
  const lo = V[a] + V[b];
  V[a + 1] = V[a + 1] + V[b + 1] + (lo >= 0x100000000 ? 1 : 0);
  V[a] = lo;
}

/** v[a] += (hi:lo). `lo` arrives as a signed int32 from the Uint32Array read. */
function add64c(a, lo, hi) {
  let o = V[a] + lo;
  if (lo < 0) o += 0x100000000;
  V[a + 1] = V[a + 1] + hi + (o >= 0x100000000 ? 1 : 0);
  V[a] = o;
}

/**
 * The G mixing function, RFC 7693 §3.1, on 32-bit halves. The four rotations are
 * 32, 24, 16 and 63; only the 32-rotation is a plain half-word swap, and the other
 * three are why this is written out rather than looped.
 */
function G(a, b, c, d, ix, iy) {
  add64(a, b);
  add64c(a, M[ix], M[ix + 1]);

  let x = V[d] ^ V[a], y = V[d + 1] ^ V[a + 1];      // rotr 32 — swap the halves
  V[d] = y; V[d + 1] = x;

  add64(c, d);

  x = V[b] ^ V[c]; y = V[b + 1] ^ V[c + 1];          // rotr 24
  V[b] = (x >>> 24) ^ (y << 8);
  V[b + 1] = (y >>> 24) ^ (x << 8);

  add64(a, b);
  add64c(a, M[iy], M[iy + 1]);

  x = V[d] ^ V[a]; y = V[d + 1] ^ V[a + 1];          // rotr 16
  V[d] = (x >>> 16) ^ (y << 16);
  V[d + 1] = (y >>> 16) ^ (x << 16);

  add64(c, d);

  x = V[b] ^ V[c]; y = V[b + 1] ^ V[c + 1];          // rotr 63 == rotl 1
  V[b] = (y >>> 31) ^ (x << 1);
  V[b + 1] = (x >>> 31) ^ (y << 1);
}

/**
 * One call of F. `h` and `m` are half-word arrays (16 and 32 entries); `h` is
 * updated in place, which is what the precompile returns.
 *
 * @param {Uint32Array} h    8 x u64 as 16 half-words, modified in place
 * @param {Uint32Array} m   16 x u64 as 32 half-words
 * @param {number[]}    t    [t0lo, t0hi, t1lo, t1hi]
 * @param {boolean}     last the final-block flag
 * @param {number}      rounds
 */
function compress(h, m, t, last, rounds) {
  for (let i = 0; i < 16; i++) { V[i] = h[i]; V[i + 16] = IV[i]; }
  V[24] ^= t[0]; V[25] ^= t[1];                      // v[12] ^= t0
  V[26] ^= t[2]; V[27] ^= t[3];                      // v[13] ^= t1
  if (last) { V[28] = ~V[28]; V[29] = ~V[29]; }      // v[14] = ~v[14]
  M.set(m);

  for (let r = 0; r < rounds; r++) {
    const s = SIGMA2[r % 10];
    G(0, 8, 16, 24, s[0], s[1]);
    G(2, 10, 18, 26, s[2], s[3]);
    G(4, 12, 20, 28, s[4], s[5]);
    G(6, 14, 22, 30, s[6], s[7]);
    G(0, 10, 20, 30, s[8], s[9]);
    G(2, 12, 22, 24, s[10], s[11]);
    G(4, 14, 16, 26, s[12], s[13]);
    G(6, 8, 18, 28, s[14], s[15]);
  }

  for (let i = 0; i < 16; i++) h[i] = h[i] ^ V[i] ^ V[i + 16];
  return h;
}

/**
 * The precompile body. Returns the 64-byte little-endian state, or null when the
 * input is not a valid F invocation — in which case the CALL fails outright and
 * consumes everything forwarded to it, rather than returning empty and succeeding.
 */
function blake2f(input) {
  if (input.length !== INPUT_BYTES) return null;
  const f = input[212];
  if (f !== 0 && f !== 1) return null;

  const rounds = input.readUInt32BE(0);                       // big-endian, alone
  const h = new Uint32Array(16);
  for (let i = 0; i < 16; i++) h[i] = input.readUInt32LE(4 + i * 4);
  const m = new Uint32Array(32);
  for (let i = 0; i < 32; i++) m[i] = input.readUInt32LE(68 + i * 4);
  const t = [
    input.readUInt32LE(196), input.readUInt32LE(200),
    input.readUInt32LE(204), input.readUInt32LE(208),
  ];

  compress(h, m, t, f === 1, rounds);

  const out = Buffer.alloc(OUTPUT_BYTES);
  for (let i = 0; i < 16; i++) out.writeUInt32LE(h[i] >>> 0, i * 4);
  return out;
}

/** The round count, which is also the gas, without validating anything else.
 *  Returns 0 for a malformed length so the caller can charge nothing and fail. */
function rounds(input) {
  return input.length !== INPUT_BYTES ? 0 : input.readUInt32BE(0);
}

module.exports = { blake2f, compress, rounds, IV, SIGMA, INPUT_BYTES, OUTPUT_BYTES };
