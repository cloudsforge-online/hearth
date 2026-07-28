/* secp256k1 for the browser — a port of node/src/crypto/secp256k1.js.
 *
 * NODE'S COPY IS THE AUTHORITY. If these two ever disagree, this one is wrong,
 * and the consequence is not a rendering glitch: a wallet that signs differently
 * from the node produces transactions the network rejects, or — far worse —
 * transactions that recover to an address the signer does not control, which
 * sends coins to nobody. wallet-selftest.js therefore does not merely test this
 * file against vectors; it runs both implementations over the same random keys
 * and messages and compares r, s and recoveryId byte for byte.
 *
 * The maths is unchanged from the node's file, deliberately, so the two can be
 * read side by side. Only the platform layer differs:
 *
 *   Buffer                 -> Uint8Array
 *   crypto.createHmac      -> hmacSha256 from ./sha256.js (sync; see that file)
 *   crypto.randomBytes     -> crypto.getRandomValues
 *
 *   y^2 = x^3 + 7  over  F_p,  p = 2^256 - 2^32 - 977
 *
 * Points are Jacobian (x = X/Z^2, y = Y/Z^3) so addition and doubling cost only
 * multiplications; one modular inverse is paid at the end when converting back
 * to affine.
 *
 * Two properties this deliberately has:
 *   - Nonces are RFC 6979 deterministic. A repeated k across two signatures
 *     leaks the private key outright, so the nonce is derived from (key,
 *     message) by HMAC-DRBG rather than trusted to an RNG. In a browser that is
 *     doubly worth having: the same key may be signing in a tab that has been
 *     open for a week.
 *   - `s` in the upper half of the group order is rejected by default (EIP-2).
 *
 * What it does NOT have: constant-time execution. BigInt branches and allocates.
 * The threat that buys is a co-resident page timing this one, which the same
 * origin policy already forbids far more directly; the mitigation that matters
 * here is that the key is sealed at rest and only in memory while unlocked.
 */

import { hmacSha256, concat } from './sha256.js';

// ---- curve parameters ------------------------------------------------------

export const P = (1n << 256n) - (1n << 32n) - 977n;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const N_HALF = N >> 1n;                            // the EIP-2 boundary
const B = 7n;                                             // a = 0, so it never appears below
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
export const G = { x: GX, y: GY };

const INFINITY = { x: 0n, y: 0n, z: 0n };                 // z = 0 marks the identity

// ---- field helpers ---------------------------------------------------------

function fmod(a, m) { const r = a % m; return r < 0n ? r + m : r; }

/** Modular inverse by extended Euclid — ~5x cheaper than Fermat's a^(m-2). */
function invert(a, m) {
  let lo = fmod(a, m), hi = m, x = 0n, y = 1n, u = 1n, v = 0n;
  while (lo !== 0n) {
    const q = hi / lo, r = hi % lo;
    const nx = x - u * q, ny = y - v * q;
    hi = lo; lo = r; x = u; y = v; u = nx; v = ny;
  }
  if (hi !== 1n) throw new Error('secp256k1: value is not invertible');
  return fmod(x, m);
}

function powMod(base, e, m) {
  let r = 1n, b = fmod(base, m), k = e;
  while (k > 0n) {
    if (k & 1n) r = (r * b) % m;
    k >>= 1n;
    if (k > 0n) b = (b * b) % m;
  }
  return r;
}

/** sqrt mod p. p % 4 === 3, so the root is just a^((p+1)/4) — verify it back. */
function sqrtMod(a) {
  const r = powMod(a, (P + 1n) >> 2n, P);
  return (r * r) % P === fmod(a, P) ? r : null;
}

// ---- group arithmetic, Jacobian --------------------------------------------

/** dbl-2009-l */
export function jDouble(p) {
  if (p.z === 0n || p.y === 0n) return INFINITY;
  const { x: X, y: Y, z: Z } = p;
  const A = (Y * Y) % P;
  const Bq = (4n * X * A) % P;
  const C = (8n * A * A) % P;
  const D = (3n * X * X) % P;                             // a = 0 drops a term here
  const X3 = fmod(D * D - 2n * Bq, P);
  const Y3 = fmod(D * (Bq - X3) - C, P);
  const Z3 = (2n * Y * Z) % P;
  return { x: X3, y: Y3, z: Z3 };
}

/** add-2007-bl, with the doubling case folded in. */
export function jAdd(p, q) {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const Z1Z1 = (p.z * p.z) % P, Z2Z2 = (q.z * q.z) % P;
  const U1 = (p.x * Z2Z2) % P, U2 = (q.x * Z1Z1) % P;
  const S1 = (((p.y * q.z) % P) * Z2Z2) % P;
  const S2 = (((q.y * p.z) % P) * Z1Z1) % P;
  const H = fmod(U2 - U1, P), r = fmod(S2 - S1, P);
  if (H === 0n) return r === 0n ? jDouble(p) : INFINITY;   // same x: double, or p + (-p)
  const HH = (H * H) % P, HHH = (H * HH) % P;
  const V = (U1 * HH) % P;
  const X3 = fmod(r * r - HHH - 2n * V, P);
  const Y3 = fmod(r * (V - X3) - S1 * HHH, P);
  const Z3 = (((p.z * q.z) % P) * H) % P;
  return { x: X3, y: Y3, z: Z3 };
}

/** Mixed addition: q is affine (z = 1), which saves four multiplications. */
function jAddAffine(p, q) {
  if (p.z === 0n) return { x: q.x, y: q.y, z: 1n };
  const Z1Z1 = (p.z * p.z) % P;
  const U2 = (q.x * Z1Z1) % P;
  const S2 = (((q.y * p.z) % P) * Z1Z1) % P;
  const H = fmod(U2 - p.x, P), r = fmod(S2 - p.y, P);
  if (H === 0n) return r === 0n ? jDouble(p) : INFINITY;
  const HH = (H * H) % P, HHH = (H * HH) % P;
  const V = (p.x * HH) % P;
  const X3 = fmod(r * r - HHH - 2n * V, P);
  const Y3 = fmod(r * (V - X3) - p.y * HHH, P);
  const Z3 = (p.z * H) % P;
  return { x: X3, y: Y3, z: Z3 };
}

export function toAffine(p) {
  if (p.z === 0n) return null;
  if (p.z === 1n) return { x: p.x, y: p.y };
  const zi = invert(p.z, P);
  const zi2 = (zi * zi) % P;
  return { x: (p.x * zi2) % P, y: (((p.y * zi2) % P) * zi) % P };
}

/** Montgomery's trick: n inversions for the price of one plus 3n products. */
function batchToAffine(points) {
  const prefix = new Array(points.length);
  let acc = 1n;
  for (let i = 0; i < points.length; i++) { prefix[i] = acc; acc = (acc * points[i].z) % P; }
  let inv = invert(acc, P);
  const out = new Array(points.length);
  for (let i = points.length - 1; i >= 0; i--) {
    const zi = (inv * prefix[i]) % P;
    inv = (inv * points[i].z) % P;
    const zi2 = (zi * zi) % P;
    out[i] = { x: (points[i].x * zi2) % P, y: (((points[i].y * zi2) % P) * zi) % P };
  }
  return out;
}

// ---- scalar multiplication -------------------------------------------------

const W = 4;                        // window width
const WINDOWS = 256 / W;            // 64 windows of 4 bits
let TABLE = null;                   // TABLE[j][i] = i * 16^j * G, affine

/**
 * G is fixed forever, so its multiples can be precomputed once: k*G then costs
 * 63 mixed additions and no doublings at all. ~1,150 point operations to build,
 * paid lazily on first use so that merely importing this module — which every
 * page in the wallet does — costs nothing.
 */
function table() {
  if (TABLE) return TABLE;
  const flat = [];
  let base = { x: GX, y: GY, z: 1n };
  for (let j = 0; j < WINDOWS; j++) {
    let acc = base;
    for (let i = 1; i < 16; i++) { flat.push(acc); acc = jAdd(acc, base); }
    for (let k = 0; k < W; k++) base = jDouble(base);    // base *= 16
  }
  const aff = batchToAffine(flat);
  TABLE = [];
  for (let j = 0; j < WINDOWS; j++) TABLE.push([null, ...aff.slice(j * 15, j * 15 + 15)]);
  return TABLE;
}

/** k * G, via the fixed-base window table. */
export function mulG(k) {
  const t = table();
  let acc = INFINITY, rest = k % N;
  if (rest < 0n) rest += N;
  for (let j = 0; j < WINDOWS && rest > 0n; j++) {
    const d = Number(rest & 15n);
    rest >>= 4n;
    if (d) acc = jAddAffine(acc, t[j][d]);
  }
  return acc;
}

/** k * point, for a point known only at runtime. 4-bit window, built per call. */
export function mul(point, k) {
  let rest = k % N;
  if (rest < 0n) rest += N;
  if (rest === 0n || point.z === 0n) return INFINITY;
  const t = [INFINITY, point];
  for (let i = 2; i < 16; i++) t.push(jAdd(t[i - 1], point));
  let acc = INFINITY;
  for (let j = WINDOWS - 1; j >= 0; j--) {
    acc = jDouble(jDouble(jDouble(jDouble(acc))));
    const d = Number((rest >> BigInt(W * j)) & 15n);
    if (d) acc = jAdd(acc, t[d]);
  }
  return acc;
}

// ---- encoding --------------------------------------------------------------

export function bufToBig(buf) {
  let v = 0n;
  for (let i = 0; i < buf.length; i++) v = (v << 8n) | BigInt(buf[i]);
  return v;
}

export function bigToBuf32(v) {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

function hexToBytes(hex) {
  const h = hex.replace(/^0x/i, '');
  if (h.length % 2 || (h.length && /[^0-9a-fA-F]/.test(h))) throw new TypeError('secp256k1: malformed hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Accept a Uint8Array or a hex string (with or without 0x) of the expected length. */
function asBytes(v, len, what) {
  let b = v;
  if (typeof b === 'string') b = hexToBytes(b);
  if (!(b instanceof Uint8Array)) throw new TypeError(`secp256k1: ${what} must be bytes or a hex string`);
  if (len && b.length !== len) throw new TypeError(`secp256k1: ${what} must be ${len} bytes, got ${b.length}`);
  return b;
}

function onCurve(x, y) {
  if (x < 0n || x >= P || y < 0n || y >= P) return false;
  return (y * y) % P === fmod(x * x % P * x + B, P);
}

/**
 * Decode 33-byte compressed, 65-byte uncompressed, or the bare 64-byte X||Y
 * form Ethereum tooling passes around. Returns null for anything not a point.
 */
export function decodePoint(pub) {
  const b = asBytes(pub, 0, 'public key');
  let x, y;
  if (b.length === 33 && (b[0] === 2 || b[0] === 3)) {
    x = bufToBig(b.subarray(1));
    if (x >= P) return null;
    const root = sqrtMod(fmod(x * x % P * x + B, P));
    if (root === null) return null;
    y = (root & 1n) === BigInt(b[0] & 1) ? root : P - root;
  } else if (b.length === 65 && b[0] === 4) {
    x = bufToBig(b.subarray(1, 33)); y = bufToBig(b.subarray(33));
  } else if (b.length === 64) {
    x = bufToBig(b.subarray(0, 32)); y = bufToBig(b.subarray(32));
  } else {
    return null;
  }
  if (!onCurve(x, y)) return null;
  if (x === 0n && y === 0n) return null;
  return { x, y, z: 1n };
}

export function encodePoint(affine, compressed) {
  if (!affine) throw new Error('secp256k1: cannot encode the point at infinity');
  if (compressed) return concat(Uint8Array.of(2 + Number(affine.y & 1n)), bigToBuf32(affine.x));
  return concat(Uint8Array.of(4), bigToBuf32(affine.x), bigToBuf32(affine.y));
}

// ---- keys ------------------------------------------------------------------

export const isValidPrivateKey = priv => {
  try { const d = bufToBig(asBytes(priv, 32, 'private key')); return d > 0n && d < N; }
  catch { return false; }
};

function privateKeyScalar(priv) {
  const d = bufToBig(asBytes(priv, 32, 'private key'));
  if (d === 0n || d >= N) throw new Error('secp256k1: private key out of range');
  return d;
}

/** 65-byte uncompressed by default — the form an address is derived from. */
export function publicKeyFromPrivate(priv, compressed = false) {
  return encodePoint(toAffine(mulG(privateKeyScalar(priv))), !!compressed);
}

export function randomPrivateKey() {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    if (isValidPrivateKey(b)) return b;
  }
}

// ---- RFC 6979 --------------------------------------------------------------

/**
 * HMAC_DRBG(SHA-256) nonce generation, RFC 6979 §3.2. `accept` exists so the
 * caller can reject a candidate that produces r = 0 or s = 0 and get the next
 * one from the same stream — and so the tests can exercise the retry path,
 * which otherwise never runs in a lifetime of signing.
 */
export function rfc6979Nonce(msgHash, priv, accept = () => true) {
  const h1 = asBytes(msgHash, 32, 'message hash');
  const x = bigToBuf32(privateKeyScalar(priv));
  const bh = bigToBuf32(bufToBig(h1) % N);          // bits2octets: reduced mod n
  let v = new Uint8Array(32).fill(1);
  let k = new Uint8Array(32);
  k = hmacSha256(k, v, Uint8Array.of(0), x, bh); v = hmacSha256(k, v);
  k = hmacSha256(k, v, Uint8Array.of(1), x, bh); v = hmacSha256(k, v);
  for (;;) {
    v = hmacSha256(k, v);                           // qlen === hash length, so one pass
    const cand = bufToBig(v);
    if (cand >= 1n && cand < N && accept(cand)) return cand;
    k = hmacSha256(k, v, Uint8Array.of(0)); v = hmacSha256(k, v);
  }
}

// ---- sign / verify / recover ----------------------------------------------

/**
 * Deterministic ECDSA. Returns { r, s, recoveryId } as BigInt / BigInt / number.
 *
 * `recoveryId` is two bits: bit 0 is the parity of R.y, bit 1 says R.x wrapped
 * past the group order (which needs a key near 2^256/n — about 1 in 2^128, but
 * a chain must still encode it). Flipping s to its low form flips bit 0,
 * because negating s reflects R across the x-axis.
 */
export function sign(msgHash, priv) {
  const h = asBytes(msgHash, 32, 'message hash');
  const d = privateKeyScalar(priv);
  const z = bufToBig(h) % N;
  let out = null;
  rfc6979Nonce(h, priv, k => {
    const R = toAffine(mulG(k));
    if (!R) return false;
    const r = R.x % N;
    if (r === 0n) return false;
    let s = (invert(k, N) * (z + r * d)) % N;
    if (s === 0n) return false;
    let recoveryId = Number(R.y & 1n) | (R.x === r ? 0 : 2);
    if (s > N_HALF) { s = N - s; recoveryId ^= 1; }
    out = { r, s, recoveryId };
    return true;
  });
  return out;
}

/**
 * Verify. `lowS` defaults to true because that is the consensus rule for a
 * transaction signature (EIP-2).
 */
export function verify(msgHash, sig, pub, { lowS = true } = {}) {
  const h = asBytes(msgHash, 32, 'message hash');
  const r = typeof sig.r === 'bigint' ? sig.r : bufToBig(asBytes(sig.r, 32, 'r'));
  const s = typeof sig.s === 'bigint' ? sig.s : bufToBig(asBytes(sig.s, 32, 's'));
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
  if (lowS && s > N_HALF) return false;
  const Q = decodePoint(pub);
  if (!Q) return false;
  const z = bufToBig(h) % N;
  const w = invert(s, N);
  const point = jAdd(mulG((z * w) % N), mul(Q, (r * w) % N));
  const R = toAffine(point);
  if (!R) return false;
  return R.x % N === r;
}

/**
 * Recover the signing public key. Returns 65 uncompressed bytes, or null if no
 * key can have produced this signature.
 *
 *   R  = the point with x = r (+ n if recoveryId says it wrapped) and the
 *        y-parity recoveryId gives
 *   Q  = r^-1 (sR - zG)
 *
 * This is the function the wallet uses to prove to itself, before broadcasting,
 * that the transaction it just signed recovers to the address it thinks it is
 * spending from.
 */
export function recoverPublicKey(msgHash, sig, opts = {}) {
  const { lowS = true, compressed = false } = opts;
  const h = asBytes(msgHash, 32, 'message hash');
  const r = typeof sig.r === 'bigint' ? sig.r : bufToBig(asBytes(sig.r, 32, 'r'));
  const s = typeof sig.s === 'bigint' ? sig.s : bufToBig(asBytes(sig.s, 32, 's'));
  const recoveryId = Number(sig.recoveryId);
  if (!Number.isInteger(recoveryId) || recoveryId < 0 || recoveryId > 3) return null;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;
  if (lowS && s > N_HALF) return null;

  const x = recoveryId >= 2 ? r + N : r;
  if (x >= P) return null;                                 // no such x in the field
  const root = sqrtMod(fmod(x * x % P * x + B, P));
  if (root === null) return null;                          // x is not on the curve
  const y = (root & 1n) === BigInt(recoveryId & 1) ? root : P - root;
  const R = { x, y, z: 1n };

  const z = bufToBig(h) % N;
  const rInv = invert(r, N);
  const Q = jAdd(mul(R, (s * rInv) % N), mulG(((N - z) * rInv) % N));
  const aff = toAffine(Q);
  if (!aff) return null;
  return encodePoint(aff, compressed);
}
