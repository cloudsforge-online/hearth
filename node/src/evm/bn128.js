'use strict';
/* alt_bn128 (BN254) — the curve arithmetic behind precompiles 0x06, 0x07 and 0x08.
 *
 * This is the curve every zk verifier on Ethereum is compiled against: Groth16,
 * PLONK, Semaphore, Tornado, every `Pairing.sol` a circuit compiler emits. A chain
 * that wants zk anything needs it bit-for-bit, because a verifier contract that
 * says "proof valid" here and "proof invalid" on mainnet is not a bug, it is two
 * different chains.
 *
 *     G1:  y^2 = x^3 + 3                over  F_p
 *     G2:  y^2 = x^3 + 3/(9 + u)        over  F_p2 = F_p[u]/(u^2 + 1)
 *     GT:  the r-th roots of unity      in    F_p12
 *
 * p and r are both 254 bits; the embedding degree is 12, so the pairing lands in
 * F_p12, which is built as a tower rather than a degree-12 extension because every
 * multiplication then costs three of the layer below instead of 144 of the bottom:
 *
 *     F_p2  = F_p[u]   / (u^2 + 1)          a + b·u
 *     F_p6  = F_p2[v]  / (v^3 - ξ)          ξ = 9 + u
 *     F_p12 = F_p6[w]  / (w^2 - v)          so w^6 = ξ
 *
 * WHAT IS COMPUTED, NOT TRANSCRIBED. The Frobenius constants ξ^(k(p-1)/6) and
 * ξ^(k(p^2-1)/6) are derived at load time from ξ itself rather than pasted in as
 * hex. They are the single easiest thing in a pairing to get wrong — a wrong digit
 * produces a pairing that is self-consistent, passes bilinearity, and disagrees
 * with every other implementation on earth. Deriving them costs two milliseconds
 * once, at require time, and removes the entire class of error.
 *
 * NO INVERSIONS IN THE MILLER LOOP. A modular inverse costs ~10 µs here against
 * ~0.25 µs for a multiplication, so an affine Miller loop would spend more time
 * inverting than pairing. T is therefore carried in homogeneous projective
 * coordinates and every line is scaled by whatever denominator it would have had.
 * That is free: the final exponentiation annihilates any factor drawn from a
 * proper subfield of F_p12, which is the same reason the vertical lines are
 * omitted entirely (denominator elimination, valid because the twist is sextic).
 *
 * THE LINE FUNCTION, derived rather than copied, because the sparse layout depends
 * on the tower above and every library orders it differently. With the twist
 *
 *     ψ(x, y) = (x·w^2, y·w^3)     E'(F_p2) -> E(F_p12)
 *
 * the tangent/chord at ψ(T) has slope λ·w for the λ ∈ F_p2 of the untwisted curve,
 * so evaluating the line at P = (xP, yP) ∈ E(F_p) gives
 *
 *     l(P) = yP  +  (-λ·xP)·w  +  (λ·x_T - y_T)·w^3
 *
 * — three of the twelve F_p coefficients, hence the sparse multiply below.
 *
 * WHAT IS CONSENSUS, AND EASY TO SKIP:
 *   - A coordinate >= p is invalid. Not reduced mod p — invalid.
 *   - (0, 0) is the point at infinity and is VALID input, in both groups.
 *   - G1 has cofactor 1, so on-curve implies in-subgroup and no check is needed.
 *     G2 does NOT: the twist has a large cofactor, so an attacker can hand over a
 *     point that is on E' and not in the r-torsion, and a pairing over it means
 *     nothing. `[r]Q == O` is checked for every G2 input. ethereum/tests carries
 *     `ecpairing_one_point_not_in_subgroup` for exactly this.
 *   - F_p2 elements are encoded IMAGINARY PART FIRST (x_1 then x_0), which is the
 *     opposite order from how they are written.
 *
 * A decoding failure is reported by returning INVALID, never by throwing: a bad
 * point is ordinary untrusted input, and the caller turns it into a failed CALL.
 * An exception escaping this file would be a bug in this file.
 */

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------

/** The field modulus. */
const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
/** The group order of G1, G2 and GT. */
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** y^2 = x^3 + B on G1. */
const B = 3n;

/** The BN parameter. p = 36x^4+36x^3+24x^2+6x+1 and r = 36x^4+36x^3+18x^2+6x+1. */
const BN_X = 4965661367192848881n;
/** The optimal-ate loop length. Positive, so no final conjugation is needed. */
const ATE_LOOP = 6n * BN_X + 2n;

/** Returned by the decoders for input that is not a point. Distinct from `null`,
 *  which is the point at infinity and is perfectly valid. */
const INVALID = Symbol('bn128: not a point');

// ---------------------------------------------------------------------------
// F_p
// ---------------------------------------------------------------------------

const mod = (a) => { const r = a % P; return r < 0n ? r + P : r; };

/**
 * Modular inverse by extended Euclid — ~10 us against ~95 us for Fermat's a^(p-2),
 * and it is called once per ecAdd, once per ecMul and once per pairing, so those
 * microseconds are most of what 0x06 costs.
 *
 * Two departures from the textbook form, both measured: only the coefficient of
 * `a` is carried (the one for p is never read), and the remainder is `hi - q*lo`
 * rather than a second `hi % lo`, because a BigInt division costs several times a
 * BigInt multiplication and V8 does not fuse the two. Together they take the loop
 * from 15.5 us to 10 us.
 */
function fpInv(a) {
  let lo = a % P, hi = P, x = 0n, u = 1n;
  if (lo < 0n) lo += P;
  if (lo === 0n) throw new Error('bn128: division by zero in F_p');
  while (lo !== 0n) {
    const q = hi / lo, r = hi - q * lo;
    const nx = x - u * q;
    hi = lo; lo = r; x = u; u = nx;
  }
  if (hi !== 1n) throw new Error('bn128: value is not invertible in F_p');
  return mod(x);
}

// ---------------------------------------------------------------------------
// F_p2 = F_p[u] / (u^2 + 1),  written [a, b] for a + b·u
// ---------------------------------------------------------------------------

const F2_ZERO = [0n, 0n];
const F2_ONE = [1n, 0n];

const f2Add = (a, b) => [(a[0] + b[0]) % P, (a[1] + b[1]) % P];
const f2Sub = (a, b) => [mod(a[0] - b[0]), mod(a[1] - b[1])];
const f2Neg = (a) => [a[0] === 0n ? 0n : P - a[0], a[1] === 0n ? 0n : P - a[1]];
const f2Conj = (a) => [a[0], a[1] === 0n ? 0n : P - a[1]];
const f2IsZero = (a) => a[0] === 0n && a[1] === 0n;
const f2Eq = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Karatsuba: three F_p products rather than four. */
function f2Mul(a, b) {
  const t0 = a[0] * b[0], t1 = a[1] * b[1];
  const t2 = (a[0] + a[1]) * (b[0] + b[1]);
  return [mod(t0 - t1), mod(t2 - t0 - t1)];
}

/** (a+bu)^2 = (a+b)(a-b) + 2ab·u — two products instead of three. */
function f2Sqr(a) {
  const s = (a[0] + a[1]) % P;
  const d = mod(a[0] - a[1]);
  return [(s * d) % P, (2n * a[0] * a[1]) % P];
}

/** By a scalar already reduced into F_p. */
const f2MulFp = (a, k) => [(a[0] * k) % P, (a[1] * k) % P];

/** (a + bu)^-1 = (a - bu) / (a^2 + b^2). One F_p inverse. */
function f2Inv(a) {
  const t = fpInv((a[0] * a[0] + a[1] * a[1]) % P);
  return [(a[0] * t) % P, mod(-a[1] * t)];
}

/** By ξ = 9 + u, the cubic (and sextic) non-residue the tower is built on. */
const f2MulXi = (a) => [mod(9n * a[0] - a[1]), mod(a[0] + 9n * a[1])];

function f2Pow(a, e) {
  let r = F2_ONE, b = a, k = e;
  while (k > 0n) {
    if (k & 1n) r = f2Mul(r, b);
    k >>= 1n;
    if (k > 0n) b = f2Sqr(b);
  }
  return r;
}

// ---------------------------------------------------------------------------
// F_p6 = F_p2[v] / (v^3 - ξ),  written [c0, c1, c2] for c0 + c1·v + c2·v^2
// ---------------------------------------------------------------------------

const F6_ZERO = [F2_ZERO, F2_ZERO, F2_ZERO];
const F6_ONE = [F2_ONE, F2_ZERO, F2_ZERO];

const f6Add = (a, b) => [f2Add(a[0], b[0]), f2Add(a[1], b[1]), f2Add(a[2], b[2])];
const f6Sub = (a, b) => [f2Sub(a[0], b[0]), f2Sub(a[1], b[1]), f2Sub(a[2], b[2])];
const f6Neg = (a) => [f2Neg(a[0]), f2Neg(a[1]), f2Neg(a[2])];
const f6Eq = (a, b) => f2Eq(a[0], b[0]) && f2Eq(a[1], b[1]) && f2Eq(a[2], b[2]);

/** Karatsuba over the three coefficients: six F_p2 products. */
function f6Mul(a, b) {
  const t0 = f2Mul(a[0], b[0]);
  const t1 = f2Mul(a[1], b[1]);
  const t2 = f2Mul(a[2], b[2]);
  const c0 = f2Add(t0, f2MulXi(f2Sub(f2Sub(f2Mul(f2Add(a[1], a[2]), f2Add(b[1], b[2])), t1), t2)));
  const c1 = f2Add(f2Sub(f2Sub(f2Mul(f2Add(a[0], a[1]), f2Add(b[0], b[1])), t0), t1), f2MulXi(t2));
  const c2 = f2Add(f2Sub(f2Sub(f2Mul(f2Add(a[0], a[2]), f2Add(b[0], b[2])), t0), t2), t1);
  return [c0, c1, c2];
}

/** By a bare F_p2 scalar — the b1 = b2 = 0 case, three products. */
const f6MulF2 = (a, k) => [f2Mul(a[0], k), f2Mul(a[1], k), f2Mul(a[2], k)];

/** By b0 + b1·v — the b2 = 0 case, five products. The line function needs it. */
function f6Mul01(a, b0, b1) {
  const t0 = f2Mul(a[0], b0);
  const t1 = f2Mul(a[1], b1);
  const c0 = f2Add(t0, f2MulXi(f2Mul(a[2], b1)));
  const c1 = f2Sub(f2Sub(f2Mul(f2Add(a[0], a[1]), f2Add(b0, b1)), t0), t1);
  const c2 = f2Add(f2Mul(a[2], b0), t1);
  return [c0, c1, c2];
}

/** By v. v^3 = ξ, so the top coefficient wraps into the bottom scaled by ξ. */
const f6MulV = (a) => [f2MulXi(a[2]), a[0], a[1]];

function f6Sqr(a) { return f6Mul(a, a); }

/** Devegili-OhEigeartaigh-Scott-Dahab inversion: one F_p2 inverse, nine products. */
function f6Inv(a) {
  const t0 = f2Sqr(a[0]), t1 = f2Sqr(a[1]), t2 = f2Sqr(a[2]);
  const t3 = f2Mul(a[0], a[1]), t4 = f2Mul(a[0], a[2]), t5 = f2Mul(a[1], a[2]);
  const c0 = f2Sub(t0, f2MulXi(t5));
  const c1 = f2Sub(f2MulXi(t2), t3);
  const c2 = f2Sub(t1, t4);
  const norm = f2Add(f2Mul(a[0], c0), f2MulXi(f2Add(f2Mul(a[2], c1), f2Mul(a[1], c2))));
  const ni = f2Inv(norm);
  return [f2Mul(c0, ni), f2Mul(c1, ni), f2Mul(c2, ni)];
}

// ---------------------------------------------------------------------------
// F_p12 = F_p6[w] / (w^2 - v),  written [c0, c1] for c0 + c1·w
// ---------------------------------------------------------------------------

const F12_ONE = [F6_ONE, F6_ZERO];

const f12Conj = (a) => [a[0], f6Neg(a[1])];
const f12Eq = (a, b) => f6Eq(a[0], b[0]) && f6Eq(a[1], b[1]);

function f12Mul(a, b) {
  const t0 = f6Mul(a[0], b[0]);
  const t1 = f6Mul(a[1], b[1]);
  const c0 = f6Add(t0, f6MulV(t1));
  const c1 = f6Sub(f6Sub(f6Mul(f6Add(a[0], a[1]), f6Add(b[0], b[1])), t0), t1);
  return [c0, c1];
}

/** Complex squaring: (a0 + a1·w)^2 = (a0^2 + v·a1^2) + 2·a0·a1·w, two products. */
function f12Sqr(a) {
  const t = f6Mul(a[0], a[1]);
  const c0 = f6Sub(f6Sub(f6Mul(f6Add(a[0], a[1]), f6Add(a[0], f6MulV(a[1]))), t), f6MulV(t));
  return [c0, f6Add(t, t)];
}

function f12Inv(a) {
  const t = f6Inv(f6Sub(f6Sqr(a[0]), f6MulV(f6Sqr(a[1]))));
  return [f6Mul(a[0], t), f6Neg(f6Mul(a[1], t))];
}

/**
 * Multiply by the sparse element  a + b·w + c·w^3  that a line evaluation
 * produces: 13 F_p2 products against the 18 a dense multiply would cost.
 * In the [F_p6, F_p6] layout that element is [[a,0,0], [b,c,0]].
 */
function f12MulLine(f, a, b, c) {
  const x = f[0], y = f[1];
  const t0 = f6MulF2(x, a);
  const t1 = f6Mul01(y, b, c);
  const c0 = f6Add(t0, f6MulV(t1));
  const t2 = f6Mul01(f6Add(x, y), f2Add(a, b), c);
  return [c0, f6Sub(f6Sub(t2, t0), t1)];
}

function f12Pow(a, e) {
  let r = F12_ONE, b = a, k = e;
  while (k > 0n) {
    if (k & 1n) r = f12Mul(r, b);
    k >>= 1n;
    if (k > 0n) b = f12Sqr(b);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Frobenius
// ---------------------------------------------------------------------------

/* ξ = 9 + u. The p-power Frobenius moves w to w·ξ^((p-1)/6) and v to v·ξ^((p-1)/3),
 * so every coefficient of a tower element picks up ξ^(k(p-1)/6) for its own k; the
 * p^2-power map is the same with (p^2-1)/6 and no F_p2 conjugation, since x^(p^2) = x
 * for x in F_p2. Both tables are DERIVED here — see the header. */

const XI = [9n, 1n];

function frobTable(exp) {
  const g = f2Pow(XI, exp);
  const t = [F2_ONE];
  for (let k = 1; k < 6; k++) t.push(f2Mul(t[k - 1], g));
  return t;                                     // t[k] = ξ^(k·exp)
}

const FROB = frobTable((P - 1n) / 6n);          // ξ^(k(p-1)/6)
const FROB2 = frobTable((P * P - 1n) / 6n);     // ξ^(k(p^2-1)/6), all in F_p

/** a^p. */
function f12Frob(a) {
  const x = a[0], y = a[1];
  return [
    [f2Conj(x[0]), f2Mul(f2Conj(x[1]), FROB[2]), f2Mul(f2Conj(x[2]), FROB[4])],
    [f2Mul(f2Conj(y[0]), FROB[1]), f2Mul(f2Conj(y[1]), FROB[3]), f2Mul(f2Conj(y[2]), FROB[5])],
  ];
}

/** a^(p^2). */
function f12Frob2(a) {
  const x = a[0], y = a[1];
  return [
    [x[0], f2Mul(x[1], FROB2[2]), f2Mul(x[2], FROB2[4])],
    [f2Mul(y[0], FROB2[1]), f2Mul(y[1], FROB2[3]), f2Mul(y[2], FROB2[5])],
  ];
}

// ---------------------------------------------------------------------------
// G1 — affine {x, y}, or null for the point at infinity
// ---------------------------------------------------------------------------

/* Jacobian internally (x = X/Z^2, y = Y/Z^3) so that a scalar multiplication pays
 * for exactly one inverse, at the end, instead of one per bit. */

const G1_INF = { x: 0n, y: 1n, z: 0n };

function g1Double(p) {
  if (p.z === 0n || p.y === 0n) return G1_INF;
  const A = (p.y * p.y) % P;
  const Bq = (4n * p.x * A) % P;
  const C = (8n * A * A) % P;
  const D = (3n * p.x * p.x) % P;                 // a = 0 drops the a·Z^4 term
  const X3 = mod(D * D - 2n * Bq);
  return { x: X3, y: mod(D * (Bq - X3) - C), z: (2n * p.y * p.z) % P };
}

function g1Add(p, q) {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const Z1Z1 = (p.z * p.z) % P, Z2Z2 = (q.z * q.z) % P;
  const U1 = (p.x * Z2Z2) % P, U2 = (q.x * Z1Z1) % P;
  const S1 = (((p.y * q.z) % P) * Z2Z2) % P;
  const S2 = (((q.y * p.z) % P) * Z1Z1) % P;
  const H = mod(U2 - U1), r = mod(S2 - S1);
  if (H === 0n) return r === 0n ? g1Double(p) : G1_INF;
  const HH = (H * H) % P, HHH = (H * HH) % P;
  const V = (U1 * HH) % P;
  const X3 = mod(r * r - HHH - 2n * V);
  return { x: X3, y: mod(r * (V - X3) - S1 * HHH), z: (((p.z * q.z) % P) * H) % P };
}

function g1Affine(p) {
  if (p.z === 0n) return null;
  const zi = fpInv(p.z), zi2 = (zi * zi) % P;
  return { x: (p.x * zi2) % P, y: (((p.y * zi2) % P) * zi) % P };
}

/** k·P for an affine P (or null). k is NOT reduced — EIP-196 allows any 256-bit
 *  scalar, and reducing it would be indistinguishable here but wrong in principle. */
function g1Mul(pt, k) {
  if (pt === null || k === 0n) return null;
  const base = { x: pt.x, y: pt.y, z: 1n };
  const table = [G1_INF, base];
  for (let i = 2; i < 16; i++) table.push(g1Add(table[i - 1], base));
  let acc = G1_INF;
  const top = k.toString(2).length;
  for (let j = ((top + 3) >> 2) - 1; j >= 0; j--) {
    acc = g1Double(g1Double(g1Double(g1Double(acc))));
    const d = Number((k >> BigInt(4 * j)) & 15n);
    if (d) acc = g1Add(acc, table[d]);
  }
  return g1Affine(acc);
}

/** P + Q for affine points, null being infinity. One inverse. */
function g1AddAffine(p, q) {
  if (p === null) return q;
  if (q === null) return p;
  let lam;
  if (p.x === q.x) {
    if (mod(p.y + q.y) === 0n) return null;       // P + (-P)
    lam = (3n * p.x % P * p.x % P) * fpInv(2n * p.y % P) % P;
  } else {
    lam = mod(q.y - p.y) * fpInv(mod(q.x - p.x)) % P;
  }
  const x3 = mod(lam * lam - p.x - q.x);
  return { x: x3, y: mod(lam * (p.x - x3) - p.y) };
}

const g1OnCurve = (x, y) => (y * y) % P === mod(x * x % P * x + B);

// ---------------------------------------------------------------------------
// G2 — affine {x, y} over F_p2, or null for infinity
// ---------------------------------------------------------------------------

/** b' = 3/(9 + u), the twisted curve's constant. */
const B2 = f2Mul([3n, 0n], f2Inv(XI));

/* Homogeneous projective (x = X/Z, y = Y/Z), which is what the line formulas below
 * want; the same two routines drive the Miller loop and the subgroup check. */

const G2_INF_P = [F2_ZERO, F2_ONE, F2_ZERO];

/** dbl-2007-bl for y^2·z = x^3 + b·z^3 with a = 0. */
function g2ProjDouble(t) {
  if (f2IsZero(t[2])) return G2_INF_P;
  const X = t[0], Y = t[1], Z = t[2];
  const XX = f2Sqr(X);
  const w = f2MulFp(XX, 3n);
  const s = f2MulFp(f2Mul(Y, Z), 2n);
  const ss = f2Sqr(s);
  const sss = f2Mul(s, ss);
  const Rv = f2Mul(Y, s);
  const RR = f2Sqr(Rv);
  const Bv = f2Sub(f2Sub(f2Sqr(f2Add(X, Rv)), XX), RR);
  const h = f2Sub(f2Sqr(w), f2MulFp(Bv, 2n));
  return [f2Mul(h, s), f2Sub(f2Mul(w, f2Sub(Bv, h)), f2MulFp(RR, 2n)), sss];
}

/** add-1998-cmo-2, with the second operand affine. */
function g2ProjAddAffine(t, q) {
  if (f2IsZero(t[2])) return [q.x, q.y, F2_ONE];
  const X1 = t[0], Y1 = t[1], Z1 = t[2];
  const u = f2Sub(f2Mul(q.y, Z1), Y1);
  const v = f2Sub(f2Mul(q.x, Z1), X1);
  if (f2IsZero(v)) return f2IsZero(u) ? g2ProjDouble(t) : G2_INF_P;
  const uu = f2Sqr(u), vv = f2Sqr(v), vvv = f2Mul(v, vv);
  const Rv = f2Mul(vv, X1);
  const A = f2Sub(f2Sub(f2Mul(uu, Z1), vvv), f2MulFp(Rv, 2n));
  return [
    f2Mul(v, A),
    f2Sub(f2Mul(u, f2Sub(Rv, A)), f2Mul(vvv, Y1)),
    f2Mul(vvv, Z1),
  ];
}

/** k·Q, projective in and out. Only ever called with k = r, for the subgroup test. */
function g2ProjMul(q, k) {
  let acc = G2_INF_P;
  let bit = k.toString(2).length - 1;
  for (; bit >= 0; bit--) {
    acc = g2ProjDouble(acc);
    if ((k >> BigInt(bit)) & 1n) acc = g2ProjAddAffine(acc, q);
  }
  return acc;
}

const g2OnCurve = (x, y) => f2Eq(f2Sqr(y), f2Add(f2Mul(f2Sqr(x), x), B2));

/**
 * The check that separates a real implementation from one that verifies forged
 * proofs. E'(F_p2) has order r·c for a large c, so a point can sit happily on the
 * twist and outside the r-torsion; pairing against it is meaningless and, worse,
 * exploitable. G1 needs no equivalent because its cofactor is 1.
 */
const g2InSubgroup = (q) => f2IsZero(g2ProjMul(q, R)[2]);

// ---------------------------------------------------------------------------
// the optimal ate pairing
// ---------------------------------------------------------------------------

/** Non-adjacent form of the loop length, low digit first. Weight ~L/3 rather than
 *  L/2, so a third of the addition steps disappear. */
function naf(k) {
  const d = [];
  let n = k;
  while (n > 0n) {
    if (n & 1n) { const z = 2n - (n % 4n); d.push(Number(z)); n -= z; }
    else d.push(0);
    n >>= 1n;
  }
  return d;
}

const ATE_NAF = naf(ATE_LOOP);

/* The two line evaluations. Both return the three non-zero F_p2 coefficients of
 *     l(P) = a  +  b·w  +  c·w^3
 * already multiplied through by the denominator they would otherwise carry — see
 * the header for why that is free. */

/** Tangent at T, and T doubled. Shares every intermediate with the doubling. */
function doubleStep(t, xP, yP) {
  const X = t[0], Y = t[1], Z = t[2];
  const XX = f2Sqr(X);
  const w = f2MulFp(XX, 3n);
  const s = f2MulFp(f2Mul(Y, Z), 2n);            // 2YZ
  const ss = f2Sqr(s);
  const sss = f2Mul(s, ss);
  const Rv = f2Mul(Y, s);                        // 2Y^2Z
  const RR = f2Sqr(Rv);
  const Bv = f2Sub(f2Sub(f2Sqr(f2Add(X, Rv)), XX), RR);
  const h = f2Sub(f2Sqr(w), f2MulFp(Bv, 2n));
  const next = [f2Mul(h, s), f2Sub(f2Mul(w, f2Sub(Bv, h)), f2MulFp(RR, 2n)), sss];

  // scaled by 2YZ^2:  a = 2YZ^2·yP,  b = -3X^2Z·xP,  c = 3X^3 - 2Y^2Z
  return {
    t: next,
    a: f2MulFp(f2Mul(s, Z), yP),
    b: f2Neg(f2MulFp(f2Mul(w, Z), xP)),
    c: f2Sub(f2Mul(w, X), Rv),
  };
}

/** Chord through T and the affine Q, and T + Q. */
function addStep(t, q, xP, yP) {
  const X1 = t[0], Y1 = t[1], Z1 = t[2];
  const u = f2Sub(f2Mul(q.y, Z1), Y1);           // -(Y - yQ·Z)
  const v = f2Sub(f2Mul(q.x, Z1), X1);           // -(X - xQ·Z)
  if (f2IsZero(v)) {
    // T = ±Q. Unreachable for r-torsion inputs with |6x+2| < r; the vertical line
    // it would need is a denominator and would be eliminated anyway.
    throw new Error('bn128: degenerate addition in the Miller loop');
  }
  const uu = f2Sqr(u), vv = f2Sqr(v), vvv = f2Mul(v, vv);
  const Rv = f2Mul(vv, X1);
  const A = f2Sub(f2Sub(f2Mul(uu, Z1), vvv), f2MulFp(Rv, 2n));
  const next = [f2Mul(v, A), f2Sub(f2Mul(u, f2Sub(Rv, A)), f2Mul(vvv, Y1)), f2Mul(vvv, Z1)];

  // scaled by -(x_Q·Z - X)·Z, i.e. the whole line negated, which the final
  // exponentiation cannot see:  a = v·Z·yP,  b = -u·Z·xP,  c = u·X - v·Y
  return {
    t: next,
    a: f2MulFp(f2Mul(v, Z1), yP),
    b: f2Neg(f2MulFp(f2Mul(u, Z1), xP)),
    c: f2Sub(f2Mul(u, X1), f2Mul(v, Y1)),
  };
}

/** π_p on the twist: x -> ξ^((p-1)/3)·conj(x),  y -> ξ^((p-1)/2)·conj(y). */
const g2Frob = (q) => ({ x: f2Mul(FROB[2], f2Conj(q.x)), y: f2Mul(FROB[3], f2Conj(q.y)) });
/** π_p^2 on the twist. Both multipliers are in F_p, so no conjugation. */
const g2Frob2 = (q) => ({ x: f2Mul(FROB2[2], q.x), y: f2Mul(FROB2[3], q.y) });

/**
 * f_{6x+2, Q}(P), then the two extra lines that turn the ate pairing into the
 * optimal one. Q must be in the r-torsion and neither point may be infinity;
 * `pairingCheck` guarantees both.
 */
function millerLoop(p, q) {
  const xP = p.x, yP = p.y;
  const negQ = { x: q.x, y: f2Neg(q.y) };
  let f = F12_ONE;
  let t = [q.x, q.y, F2_ONE];

  for (let i = ATE_NAF.length - 2; i >= 0; i--) {
    f = f12Sqr(f);
    const d = doubleStep(t, xP, yP);
    t = d.t;
    f = f12MulLine(f, d.a, d.b, d.c);
    const digit = ATE_NAF[i];
    if (digit !== 0) {
      const s = addStep(t, digit > 0 ? q : negQ, xP, yP);
      t = s.t;
      f = f12MulLine(f, s.a, s.b, s.c);
    }
  }

  // f *= l_{T, π(Q)}; T += π(Q);  then f *= l_{T, -π^2(Q)}
  const q1 = g2Frob(q);
  const s1 = addStep(t, q1, xP, yP);
  f = f12MulLine(f, s1.a, s1.b, s1.c);
  const q2 = g2Frob2(q);
  const s2 = addStep(s1.t, { x: q2.x, y: f2Neg(q2.y) }, xP, yP);
  return f12MulLine(f, s2.a, s2.b, s2.c);
}

/**
 * f^((p^12 - 1)/r), in the usual two halves: the easy part f^(p^6-1)(p^2+1), which
 * is two Frobenius maps and one inverse, then the hard part (p^4 - p^2 + 1)/r via
 * the Scott-Benger-Charlemagne-Perez-Kachisa addition chain — three exponentiations
 * by the BN parameter and a fixed sequence of squarings.
 */
function finalExponentiation(input) {
  let f = f12Mul(f12Conj(input), f12Inv(input));
  f = f12Mul(f12Frob2(f), f);

  const fp = f12Frob(f);
  const fp2 = f12Frob2(f);
  const fp3 = f12Frob(fp2);

  const fu = f12Pow(f, BN_X);
  const fu2 = f12Pow(fu, BN_X);
  const fu3 = f12Pow(fu2, BN_X);

  const y0 = f12Mul(f12Mul(fp, fp2), fp3);
  const y1 = f12Conj(f);
  const y2 = f12Frob2(fu2);
  const y3 = f12Conj(f12Frob(fu));
  const y4 = f12Conj(f12Mul(fu, f12Frob(fu2)));
  const y5 = f12Conj(fu2);
  const y6 = f12Conj(f12Mul(fu3, f12Frob(fu3)));

  let t0 = f12Mul(f12Mul(f12Sqr(y6), y4), y5);
  let t1 = f12Mul(f12Mul(y3, y5), t0);
  t0 = f12Mul(t0, y2);
  t1 = f12Mul(f12Sqr(t1), t0);
  t1 = f12Sqr(t1);
  t0 = f12Mul(t1, y1);
  t1 = f12Mul(t1, y0);
  t0 = f12Sqr(t0);
  return f12Mul(t0, t1);
}

/**
 * Whether ∏ e(P_i, Q_i) == 1. One final exponentiation for the whole product,
 * which is why a k-pair check costs far less than k single pairings.
 *
 * A pair with either point at infinity contributes e(O, Q) = e(P, O) = 1 and is
 * skipped — not an error, and the ethereum/tests corpus leans on it hard
 * (`ecpairing_one_point_with_g1_zero` and friends).
 */
function pairingCheck(pairs) {
  let acc = F12_ONE;
  let any = false;
  for (const [p, q] of pairs) {
    if (p === null || q === null) continue;
    acc = f12Mul(acc, millerLoop(p, q));
    any = true;
  }
  if (!any) return true;                          // the empty product is 1
  return f12Eq(finalExponentiation(acc), F12_ONE);
}

/** e(P, Q) as a GT element. Not used by the precompiles; the tests need it to
 *  check bilinearity, which is the only self-contained proof that the tower,
 *  the loop and the final exponentiation all agree. */
function pairing(p, q) {
  if (p === null || q === null) return F12_ONE;
  return finalExponentiation(millerLoop(p, q));
}

// ---------------------------------------------------------------------------
// encoding — EIP-196 and EIP-197
// ---------------------------------------------------------------------------

/** 32 big-endian bytes at `off`, reading past the end of the input as zero — the
 *  zero-padding rule is consensus, not leniency (EIP-196, and `getData` in geth). */
function word(buf, off) {
  if (off >= buf.length) return 0n;
  const end = Math.min(buf.length, off + 32);
  const hex = buf.toString('hex', off, end);
  const v = BigInt('0x' + hex);
  return end - off === 32 ? v : v << BigInt(8 * (32 - (end - off)));
}

function writeWord(out, off, v) {
  let hex = v.toString(16);
  if (hex.length & 1) hex = '0' + hex;
  Buffer.from(hex, 'hex').copy(out, off + 32 - hex.length / 2);
}

/** 64 bytes: x || y. INVALID, or null for (0, 0), or an affine point. */
function decodeG1(buf, off) {
  const x = word(buf, off), y = word(buf, off + 32);
  if (x >= P || y >= P) return INVALID;
  if (x === 0n && y === 0n) return null;
  if (!g1OnCurve(x, y)) return INVALID;
  return { x, y };
}

/** 128 bytes: x_1 || x_0 || y_1 || y_0 — IMAGINARY PART FIRST, per EIP-197. */
function decodeG2(buf, off) {
  const x1 = word(buf, off), x0 = word(buf, off + 32);
  const y1 = word(buf, off + 64), y0 = word(buf, off + 96);
  if (x0 >= P || x1 >= P || y0 >= P || y1 >= P) return INVALID;
  const x = [x0, x1], y = [y0, y1];
  if (f2IsZero(x) && f2IsZero(y)) return null;
  if (!g2OnCurve(x, y)) return INVALID;
  const q = { x, y };
  if (!g2InSubgroup(q)) return INVALID;
  return q;
}

function encodeG1(p) {
  const out = Buffer.alloc(64);
  if (p === null) return out;                     // infinity encodes as (0, 0)
  writeWord(out, 0, p.x);
  writeWord(out, 32, p.y);
  return out;
}

// ---------------------------------------------------------------------------
// the three precompile bodies
// ---------------------------------------------------------------------------

/* Each returns the output bytes, or null meaning "this input is not valid and the
 * CALL must fail". Short input is zero-padded for 0x06 and 0x07 (EIP-196 reads a
 * fixed 128 / 96 bytes); 0x08 is the exception and rejects any length that is not
 * a multiple of 192 outright, which is EIP-197 and is not the same rule. */

/** 0x06 — 128 bytes in, 64 out. */
function ecAdd(input) {
  const a = decodeG1(input, 0);
  if (a === INVALID) return null;
  const b = decodeG1(input, 64);
  if (b === INVALID) return null;
  return encodeG1(g1AddAffine(a, b));
}

/** 0x07 — 96 bytes in (point, then an unreduced 256-bit scalar), 64 out. */
function ecMul(input) {
  const a = decodeG1(input, 0);
  if (a === INVALID) return null;
  return encodeG1(g1Mul(a, word(input, 64)));
}

const PAIRING_TRUE = Buffer.concat([Buffer.alloc(31), Buffer.from([1])]);
const PAIRING_FALSE = Buffer.alloc(32);

/** 0x08 — 192·k bytes in, a 32-byte 1 or 0 out. Empty input is 1. */
function ecPairing(input) {
  if (input.length % 192 !== 0) return null;
  const pairs = [];
  for (let off = 0; off < input.length; off += 192) {
    const p = decodeG1(input, off);
    if (p === INVALID) return null;
    const q = decodeG2(input, off + 64);
    if (q === INVALID) return null;
    pairs.push([p, q]);
  }
  return pairingCheck(pairs) ? PAIRING_TRUE : PAIRING_FALSE;
}

// ---------------------------------------------------------------------------

/** The published generators, for tests and for anyone building on this directly. */
const G1 = { x: 1n, y: 2n };
const G2 = {
  x: [10857046999023057135944570762232829481370756359578518086990519993285655852781n,
    11559732032986387107991004021392285783925812861821192530917403151452391805634n],
  y: [8495653923123431417604973247489272438418190587263600148770280649306958101930n,
    4082367875863433681332203403145435568316851327593401208105741076214120093531n],
};

module.exports = {
  P, R, B, B2, BN_X, ATE_LOOP, ATE_NAF, INVALID, G1, G2, XI, FROB, FROB2,
  // the precompile bodies
  ecAdd, ecMul, ecPairing,
  // pairing internals, exported so each tower layer can be tested before the one
  // above it is trusted
  fpInv, mod,
  f2Add, f2Sub, f2Mul, f2Sqr, f2Neg, f2Inv, f2Conj, f2MulXi, f2Pow, f2Eq, f2IsZero,
  f6Add, f6Sub, f6Mul, f6Sqr, f6Inv, f6MulV, f6Mul01, f6MulF2, f6Eq,
  f12Mul, f12Sqr, f12Inv, f12Conj, f12Pow, f12Frob, f12Frob2, f12MulLine, f12Eq,
  F2_ZERO, F2_ONE, F6_ZERO, F6_ONE, F12_ONE,
  g1AddAffine, g1Mul, g1OnCurve, g2OnCurve, g2InSubgroup, g2Frob, g2Frob2,
  g2ProjMul, g2ProjDouble, g2ProjAddAffine,
  millerLoop, finalExponentiation, pairing, pairingCheck, naf,
  decodeG1, decodeG2, encodeG1, word,
};
