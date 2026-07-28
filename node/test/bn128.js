'use strict';
/* Tests for alt_bn128 — precompiles 0x06 ecAdd, 0x07 ecMul and 0x08 ecPairing.
 * Run: node test/bn128.js
 *
 * A pairing has four layers stacked on each other and a bug in any of them
 * produces the same symptom: a number that is not 1. So this file tests them from
 * the bottom up, and each layer is checked against something OUTSIDE itself rather
 * than against its own arithmetic:
 *
 *   F_p2 / F_p6 / F_p12   field axioms, and every optimised routine against the
 *                         slow general one it replaces (f2Sqr vs f2Mul, f6Mul01
 *                         and f12MulLine vs the dense multiply). A sparse multiply
 *                         that is subtly wrong is otherwise invisible: it only
 *                         ever meets sparse arguments.
 *
 *   Frobenius             f12Frob(a) must equal a^p computed by square-and-
 *                         multiply over the whole 254-bit exponent. This is the
 *                         check that matters most in the file. The Frobenius
 *                         constants are the classic place to have a wrong digit,
 *                         and a wrong one still gives a pairing that is internally
 *                         consistent and BILINEAR — it just disagrees with every
 *                         other implementation on earth. Bilinearity cannot see it.
 *                         a^p can.
 *
 *   the groups            r·G = O in both, and — the one that keeps forged proofs
 *                         out — a point that is on the twist and NOT in the
 *                         r-torsion, derived here rather than pasted, which
 *                         `decodeG2` must refuse.
 *
 *   the pairing           non-degeneracy, order r, and bilinearity in both
 *                         arguments.
 *
 * Then the published vectors, which are what conformance actually means:
 * go-ethereum's core/vm/testdata/precompiles/{bn256Add,bn256ScalarMul,
 * bn256Pairing}.json, copied verbatim with their expected gas. Their names —
 * chfast, cdetrio, jeff, ten_point_match — are the ethereum/tests names, because
 * that is where they came from.
 *
 * Finally the ethereum/tests GeneralStateTests corpus itself, when it has been
 * fetched. Those fixtures publish only a post-state ROOT, and Hearth has no
 * state-transition layer yet, so they cannot be executed end to end. What can be
 * done is to lift every precompile input out of them and check the accept/reject
 * decision against what the fixture's own name asserts — `bad_length_191`,
 * `one_point_not_in_subgroup`, `two_point_match_3`, `perturb_g2_by_field_modulus`.
 * That is not a substitute for running them, and it is labelled as what it is.
 */

const fs = require('fs');
const path = require('path');

const bn = require('../src/evm/bn128');
const PRE = require('../src/evm/precompiles');

let pass = 0, fail = 0, skipped = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(actual, expected, msg) {
  if (actual === expected) pass++;
  else { fail++; console.log(`  ✗ ${msg}: expected ${expected}, got ${actual}`); }
}
function group(name) { console.log('• ' + name); }
const buf = (h) => Buffer.from(h, 'hex');
const hex = (b) => (b === null ? '<fail>' : Buffer.from(b).toString('hex'));

const { P, R } = bn;

/* A deterministic stream of field elements. Deterministic on purpose: a test that
 * fails one run in fifty is a test nobody trusts, and the point of the sweep is
 * coverage of shapes, not entropy. */
let seed = 0x2b992ddfa232n;
function rnd() {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  let v = 0n;
  for (let i = 0; i < 4; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    v = (v << 64n) | seed;
  }
  return v % P;
}
const rndF2 = () => [rnd(), rnd()];
const rndF6 = () => [rndF2(), rndF2(), rndF2()];
const rndF12 = () => [rndF6(), rndF6()];

// ---------------------------------------------------------------------------
// the field tower
// ---------------------------------------------------------------------------

group('F_p2 = F_p[u]/(u^2 + 1)');
{
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const a = rndF2(), b = rndF2(), c = rndF2();
    if (!bn.f2Eq(bn.f2Mul(a, b), bn.f2Mul(b, a))) bad++;
    if (!bn.f2Eq(bn.f2Mul(bn.f2Mul(a, b), c), bn.f2Mul(a, bn.f2Mul(b, c)))) bad++;
    if (!bn.f2Eq(bn.f2Mul(a, bn.f2Add(b, c)), bn.f2Add(bn.f2Mul(a, b), bn.f2Mul(a, c)))) bad++;
    if (!bn.f2Eq(bn.f2Sqr(a), bn.f2Mul(a, a))) bad++;              // the optimised path
    if (!bn.f2Eq(bn.f2Mul(a, bn.f2Inv(a)), bn.F2_ONE)) bad++;
    if (!bn.f2Eq(bn.f2MulXi(a), bn.f2Mul(a, [9n, 1n]))) bad++;     // ξ = 9 + u
    if (!bn.f2Eq(bn.f2Add(a, bn.f2Neg(a)), bn.F2_ZERO)) bad++;
  }
  eq(bad, 0, 'commutative, associative, distributive; sqr, inv and mulXi agree with mul');
  eq(bn.f2Mul([0n, 1n], [0n, 1n])[0], P - 1n, 'u^2 = -1');
  // The p-power Frobenius on F_p2 is conjugation. Checked the long way round.
  let frobBad = 0;
  for (let i = 0; i < 5; i++) {
    const a = rndF2();
    if (!bn.f2Eq(bn.f2Pow(a, P), bn.f2Conj(a))) frobBad++;
    if (!bn.f2Eq(bn.f2Pow(a, P * P), a)) frobBad++;
  }
  eq(frobBad, 0, 'a^p is the conjugate and a^(p^2) is a — computed by exponentiation, not asserted');
}

group('F_p6 = F_p2[v]/(v^3 - xi)');
{
  let bad = 0;
  const V = [bn.F2_ZERO, bn.F2_ONE, bn.F2_ZERO];                   // the element v
  for (let i = 0; i < 100; i++) {
    const a = rndF6(), b = rndF6(), c = rndF6();
    if (!bn.f6Eq(bn.f6Mul(a, b), bn.f6Mul(b, a))) bad++;
    if (!bn.f6Eq(bn.f6Mul(bn.f6Mul(a, b), c), bn.f6Mul(a, bn.f6Mul(b, c)))) bad++;
    if (!bn.f6Eq(bn.f6Mul(a, bn.f6Add(b, c)), bn.f6Add(bn.f6Mul(a, b), bn.f6Mul(a, c)))) bad++;
    if (!bn.f6Eq(bn.f6Sqr(a), bn.f6Mul(a, a))) bad++;
    if (!bn.f6Eq(bn.f6Mul(a, bn.f6Inv(a)), bn.F6_ONE)) bad++;
    // The two shortcuts, each against the dense multiply it stands in for.
    if (!bn.f6Eq(bn.f6MulV(a), bn.f6Mul(a, V))) bad++;
    const k = rndF2();
    if (!bn.f6Eq(bn.f6MulF2(a, k), bn.f6Mul(a, [k, bn.F2_ZERO, bn.F2_ZERO]))) bad++;
    const b0 = rndF2(), b1 = rndF2();
    if (!bn.f6Eq(bn.f6Mul01(a, b0, b1), bn.f6Mul(a, [b0, b1, bn.F2_ZERO]))) bad++;
  }
  eq(bad, 0, 'field axioms hold, and mulV / mulF2 / mul01 agree with the dense multiply');
  eq(bn.f6Eq(bn.f6Mul(bn.f6Mul(V, V), V), [bn.XI, bn.F2_ZERO, bn.F2_ZERO]), true, 'v^3 = xi');
}

group('F_p12 = F_p6[w]/(w^2 - v)');
{
  let bad = 0;
  for (let i = 0; i < 60; i++) {
    const a = rndF12(), b = rndF12();
    if (!bn.f12Eq(bn.f12Mul(a, b), bn.f12Mul(b, a))) bad++;
    if (!bn.f12Eq(bn.f12Sqr(a), bn.f12Mul(a, a))) bad++;
    if (!bn.f12Eq(bn.f12Mul(a, bn.f12Inv(a)), bn.F12_ONE)) bad++;
    // The sparse line multiply, against the same element multiplied densely.
    const l0 = rndF2(), l1 = rndF2(), l2 = rndF2();
    const dense = [[l0, bn.F2_ZERO, bn.F2_ZERO], [l1, l2, bn.F2_ZERO]];
    if (!bn.f12Eq(bn.f12MulLine(a, l0, l1, l2), bn.f12Mul(a, dense))) bad++;
  }
  eq(bad, 0, 'field axioms hold, and the sparse line multiply agrees with the dense one');
  // w^2 = v, so w^12 = xi^2 and w^6 = xi.
  const W = [bn.F6_ZERO, bn.F6_ONE];
  eq(bn.f12Eq(bn.f12Pow(W, 6n), [[bn.XI, bn.F2_ZERO, bn.F2_ZERO], bn.F6_ZERO]), true, 'w^6 = xi');
}

group('Frobenius — a^p by table against a^p by exponentiation');
{
  /* This is the check the whole file exists for. The FROB and FROB2 tables are
   * derived from xi at load time rather than transcribed, and this proves the
   * derivation: a^p computed with 254 squarings cannot share a bug with a table
   * lookup. A wrong Frobenius constant survives every bilinearity test there is. */
  let bad = 0;
  for (let i = 0; i < 3; i++) {
    const a = rndF12();
    if (!bn.f12Eq(bn.f12Frob(a), bn.f12Pow(a, P))) bad++;
    if (!bn.f12Eq(bn.f12Frob2(a), bn.f12Pow(a, P * P))) bad++;
    if (!bn.f12Eq(bn.f12Frob(bn.f12Frob(a)), bn.f12Frob2(a))) bad++;
    // Conjugation in F_p12 is the p^6-power map, which is what the easy part of
    // the final exponentiation relies on.
    if (!bn.f12Eq(bn.f12Conj(a), bn.f12Pow(a, P ** 6n))) bad++;
  }
  eq(bad, 0, 'f12Frob = a^p, f12Frob2 = a^(p^2), f12Conj = a^(p^6) — all verified by exponentiation');
  eq(bn.FROB2.every((c) => c[1] === 0n), true,
    'the p^2-Frobenius multipliers are in F_p — an imaginary part there is a wrong exponent');
}

// ---------------------------------------------------------------------------
// the groups
// ---------------------------------------------------------------------------

/** F_p2 square root, complex method (p = 3 mod 4). Used only to manufacture a
 *  point that is on the twist and outside the r-torsion. */
function f2Sqrt(a) {
  const pw = (x, e) => { let r = 1n, b = x % P, k = e; while (k > 0n) { if (k & 1n) r = r * b % P; k >>= 1n; if (k > 0n) b = b * b % P; } return r; };
  const sqrtFp = (x) => { const r = pw(x, (P + 1n) / 4n); return r * r % P === x % P ? r : null; };
  const n = sqrtFp((a[0] * a[0] + a[1] * a[1]) % P);
  if (n === null) return null;
  const inv2 = bn.fpInv(2n);
  for (const cand of [(a[0] + n) % P * inv2 % P, bn.mod(a[0] - n) * inv2 % P]) {
    const x0 = sqrtFp(cand);
    if (x0 === null || x0 === 0n) continue;
    const r = [x0, a[1] * bn.fpInv(2n * x0 % P) % P];
    if (bn.f2Eq(bn.f2Sqr(r), a)) return r;
  }
  return null;
}

const samePoint = (a, b) =>
  (a === null || b === null) ? a === b : (a.x === b.x && a.y === b.y);

/** k·Q on the twist, affine out. Only the tests need this shape. */
function g2Mul(q, k) {
  const t = bn.g2ProjMul(q, k);
  if (bn.f2IsZero(t[2])) return null;
  const zi = bn.f2Inv(t[2]);
  return { x: bn.f2Mul(t[0], zi), y: bn.f2Mul(t[1], zi) };
}

group('G1 and G2');
{
  eq(bn.g1OnCurve(bn.G1.x, bn.G1.y), true, 'the G1 generator (1, 2) is on y^2 = x^3 + 3');
  eq(bn.g2OnCurve(bn.G2.x, bn.G2.y), true, "the G2 generator is on the twist y^2 = x^3 + 3/(9+u)");
  eq(bn.g2InSubgroup(bn.G2), true, 'and is in the r-torsion');
  eq(bn.g1Mul(bn.G1, R), null, 'r·G1 = O');
  eq(g2Mul(bn.G2, R), null, 'r·G2 = O');
  eq(bn.f2Eq(bn.f2Mul(bn.B2, bn.XI), [3n, 0n]), true, "b' · xi = 3, so b' = 3/(9+u)");

  // (r-1)·G = -G, which is the one multiple whose answer can be written down.
  const negG1 = bn.g1Mul(bn.G1, R - 1n);
  ok(negG1.x === bn.G1.x && negG1.y === P - bn.G1.y, '(r-1)·G1 is -G1');

  // Scalar multiplication against repeated addition, and against itself split.
  let bad = 0;
  let acc = null;
  for (let k = 1n; k <= 20n; k++) {
    acc = bn.g1AddAffine(acc, bn.G1);
    const m = bn.g1Mul(bn.G1, k);
    if (m === null || m.x !== acc.x || m.y !== acc.y) bad++;
  }
  eq(bad, 0, 'g1Mul agrees with repeated addition for the first twenty multiples');

  bad = 0;
  for (let i = 0; i < 20; i++) {
    const a = rnd() % R, b = rnd() % R;
    const lhs = bn.g1Mul(bn.G1, (a + b) % R);
    const rhs = bn.g1AddAffine(bn.g1Mul(bn.G1, a), bn.g1Mul(bn.G1, b));
    if (!samePoint(lhs, rhs)) bad++;
  }
  eq(bad, 0, '(a+b)·G = a·G + b·G for random 254-bit scalars');

  // The addition edge cases, which is where an affine formula goes wrong.
  eq(bn.g1AddAffine(null, bn.G1), bn.G1, 'O + P = P');
  eq(bn.g1AddAffine(bn.G1, null), bn.G1, 'P + O = P');
  eq(bn.g1AddAffine(bn.G1, { x: bn.G1.x, y: P - bn.G1.y }), null, 'P + (-P) = O');
  {
    const dbl = bn.g1AddAffine(bn.G1, bn.G1), two = bn.g1Mul(bn.G1, 2n);
    ok(dbl.x === two.x && dbl.y === two.y, 'P + P doubles rather than dividing by zero');
  }
}

group('the G2 subgroup check — the one that keeps forged proofs out');
{
  /* E'(F_p2) has order r·c for a large cofactor c, so an attacker can hand over a
   * point that sits perfectly on the twist and outside the r-torsion. Pairing
   * against it is meaningless. Here is such a point, derived rather than pasted:
   * x = 1 happens to give an x-coordinate whose curve equation has a square root. */
  const x = [1n, 0n];
  const rhs = bn.f2Add(bn.f2Mul(bn.f2Sqr(x), x), bn.B2);
  const y = f2Sqrt(rhs);
  ok(y !== null, 'x = 1 is the x-coordinate of a point on the twist');
  const rogue = { x, y };
  eq(bn.g2OnCurve(rogue.x, rogue.y), true, '…and that point really is on the curve');
  eq(bn.g2InSubgroup(rogue), false, '…and really is NOT in the r-torsion');
  ok(g2Mul(rogue, R) !== null, 'r·rogue is not the point at infinity');

  // Which is exactly what the decoder has to refuse.
  const enc = Buffer.concat([
    b32(rogue.x[1]), b32(rogue.x[0]), b32(rogue.y[1]), b32(rogue.y[0]),
  ]);
  eq(bn.decodeG2(enc, 0), bn.INVALID, 'decodeG2 rejects an on-curve point outside the subgroup');
  const pairInput = Buffer.concat([b32(bn.G1.x), b32(bn.G1.y), enc]);
  eq(bn.ecPairing(pairInput), null, '…and the pairing precompile fails on it');

  /* The on-curve test has to come BEFORE the subgroup test, and that ordering is
   * not cosmetic. `[r]Q` is a 254-bit scalar multiplication over F_p2 — about a
   * millisecond, a thousand times the cost of checking the curve equation. Drop
   * the on-curve test and garbage still gets REJECTED (the subgroup test catches
   * it), so no output changes and no vector fails; what changes is that 128 bytes
   * of random rubbish now buys a millisecond of work. Mutation testing found this:
   * removing the on-curve check was the one mutant nothing else here noticed.
   * Timing is the only way to see it, so timing is what is asserted. */
  const junk = Buffer.concat([b32(7n), b32(11n), b32(13n), b32(17n)]);
  eq(bn.decodeG2(junk, 0), bn.INVALID, 'four small numbers are not a G2 point');
  {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) bn.decodeG2(junk, 0);
    const perReject = Number(process.hrtime.bigint() - t0) / 200 / 1000;
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) bn.g2InSubgroup(bn.G2);
    const perSubgroup = Number(process.hrtime.bigint() - t1) / 20 / 1000;
    ok(perReject < perSubgroup / 10,
      `an off-curve G2 point is rejected by the curve equation (${perReject.toFixed(1)}us), ` +
      `not by the subgroup multiplication (${perSubgroup.toFixed(0)}us)`);
  }

  // Multiplying it by the cofactor lands it back inside, which proves the rogue
  // point was a real curve point and not nonsense.
  const cofactor = (2n * P - R) % R === 0n ? 1n : (2n * P - R);
  const cleared = g2Mul(rogue, cofactor);
  ok(cleared !== null && bn.g2InSubgroup(cleared),
    'clearing the cofactor maps it into the subgroup, so it was a genuine twist point');
}

function b32(v) {
  const out = Buffer.alloc(32);
  let h = v.toString(16); if (h.length & 1) h = '0' + h;
  Buffer.from(h, 'hex').copy(out, 32 - h.length / 2);
  return out;
}

// ---------------------------------------------------------------------------
// the pairing
// ---------------------------------------------------------------------------

group('the optimal ate pairing');
{
  // The loop length, reconstructed from its NAF, because a wrong digit there is a
  // pairing that is wrong by a factor nobody can see.
  let recon = 0n;
  for (let i = bn.ATE_NAF.length - 1; i >= 0; i--) recon = recon * 2n + BigInt(bn.ATE_NAF[i]);
  eq(recon, bn.ATE_LOOP, 'the NAF of 6x+2 reconstructs 6x+2');
  eq(bn.ATE_LOOP, 6n * bn.BN_X + 2n, 'the loop length is 6x+2');
  eq(P, 36n * bn.BN_X ** 4n + 36n * bn.BN_X ** 3n + 24n * bn.BN_X ** 2n + 6n * bn.BN_X + 1n,
    'p = 36x^4 + 36x^3 + 24x^2 + 6x + 1 for the published BN parameter');
  eq(R, 36n * bn.BN_X ** 4n + 36n * bn.BN_X ** 3n + 18n * bn.BN_X ** 2n + 6n * bn.BN_X + 1n,
    'r = 36x^4 + 36x^3 + 18x^2 + 6x + 1');

  // The twist Frobenius has eigenvalue p on G2 — the identity the two extra Miller
  // steps rest on.
  const psi = bn.g2Frob(bn.G2);
  const pQ = g2Mul(bn.G2, P % R);
  ok(bn.f2Eq(psi.x, pQ.x) && bn.f2Eq(psi.y, pQ.y), 'psi(Q) = [p]Q on G2');
  const psi2 = bn.g2Frob2(bn.G2);
  const p2Q = g2Mul(bn.G2, (P * P) % R);
  ok(bn.f2Eq(psi2.x, p2Q.x) && bn.f2Eq(psi2.y, p2Q.y), 'psi^2(Q) = [p^2]Q');

  const e = bn.pairing(bn.G1, bn.G2);
  ok(!bn.f12Eq(e, bn.F12_ONE), 'e(G1, G2) is not 1 — the pairing is non-degenerate');
  ok(bn.f12Eq(bn.f12Pow(e, R), bn.F12_ONE), 'e(G1, G2) has order r — it lands in GT');

  // Bilinearity in each argument separately, then in both at once.
  let bad = 0;
  for (const [a, b] of [[1n, 1n], [2n, 3n], [7n, 11n], [R - 1n, 2n], [12345n, 6789n]]) {
    const lhs = bn.pairing(bn.g1Mul(bn.G1, a), g2Mul(bn.G2, b));
    if (!bn.f12Eq(lhs, bn.f12Pow(e, (a * b) % R))) bad++;
  }
  eq(bad, 0, 'e(aP, bQ) = e(P, Q)^(ab)');

  // …and the same property expressed the way a verifier contract uses it.
  const a = 31337n, b = 271828n;
  ok(bn.pairingCheck([
    [bn.g1Mul(bn.G1, a), g2Mul(bn.G2, b)],
    [bn.g1Mul(bn.G1, R - (a * b) % R), bn.G2],
  ]), 'e(aP, bQ)·e(-abP, Q) = 1');
  ok(!bn.pairingCheck([[bn.G1, bn.G2]]), 'a single non-trivial pairing is not 1');
  ok(bn.pairingCheck([]), 'the empty product is 1');
  ok(bn.pairingCheck([[null, bn.G2], [bn.G1, null]]),
    'a pair with either point at infinity contributes 1 and is skipped, not rejected');
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

group('encoding — EIP-197 puts the IMAGINARY part of an F_p2 element first');
{
  /* This is the byte order every Solidity verifier writes down, straight out of
   * the canonical Pairing.sol: x = [x_1, x_0], y = [y_1, y_0]. Getting it the other
   * way round gives a decoder that rejects every real proof, or worse, accepts a
   * different point. */
  const G2_ENC =
    '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2' +   // x_1
    '1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed' +   // x_0
    '090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b' +   // y_1
    '12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa';    // y_0
  const q = bn.decodeG2(buf(G2_ENC), 0);
  ok(q !== bn.INVALID && q !== null, 'the canonical G2 generator encoding decodes');
  ok(bn.f2Eq(q.x, bn.G2.x) && bn.f2Eq(q.y, bn.G2.y), '…to the G2 generator');

  // Swap the two halves of x and the point leaves the curve. So the order is
  // load-bearing, not a convention nobody would notice.
  const swapped = buf(G2_ENC.slice(64, 128) + G2_ENC.slice(0, 64) + G2_ENC.slice(128));
  eq(bn.decodeG2(swapped, 0), bn.INVALID, 'swapping x_1 and x_0 leaves the curve');

  // G1 is plain (x, y) and needs no such care.
  const g1 = bn.decodeG1(Buffer.concat([b32(1n), b32(2n)]), 0);
  ok(g1.x === 1n && g1.y === 2n, 'G1 decodes as plain big-endian x then y');
  eq(hex(bn.encodeG1(null)), '00'.repeat(64), 'the point at infinity encodes as 64 zero bytes');
  eq(hex(bn.encodeG1(bn.G1)), b32(1n).toString('hex') + b32(2n).toString('hex'), 'and G1 round-trips');
}

group('input rules that are consensus, not validation manners');
{
  // Short input is ZERO-PADDED for 0x06 and 0x07. Not rejected.
  eq(hex(bn.ecAdd(Buffer.alloc(0))), '00'.repeat(64), 'ecAdd of nothing is O + O = O');
  eq(hex(bn.ecAdd(Buffer.concat([b32(1n), b32(2n)]))),
    hex(bn.encodeG1(bn.G1)), 'ecAdd of 64 bytes pads the second point to O, giving P');
  eq(hex(bn.ecMul(Buffer.alloc(0))), '00'.repeat(64), 'ecMul of nothing is 0·O = O');
  eq(hex(bn.ecMul(Buffer.concat([b32(1n), b32(2n)]))), '00'.repeat(64),
    'ecMul with the scalar missing reads it as zero, giving O');

  /* Padding a word that is only PARTLY present, which is the case that separates
   * real zero-extension from "anything incomplete reads as zero". Four bytes of
   * scalar, 0x00000001, occupy the TOP of the 32-byte word and mean 2^224, not 1
   * and not 0. Mutation testing put this here: an implementation that returns zero
   * for any short read passes every other padding check in this file, because the
   * corpus's truncated inputs all happen to cut on a word boundary. */
  {
    const short = Buffer.concat([b32(1n), b32(2n), buf('00000001')]);
    eq(short.length, 68, 'the input stops four bytes into the scalar');
    eq(hex(bn.ecMul(short)), hex(bn.encodeG1(bn.g1Mul(bn.G1, 1n << 224n))),
      'a partial scalar word is zero-extended on the RIGHT: 0x00000001 means 2^224');
    ok(hex(bn.ecMul(short)) !== hex(bn.encodeG1(bn.G1)), '…not 1');
    ok(hex(bn.ecMul(short)) !== '00'.repeat(64), '…and not zero');
    // The same for a coordinate, where a partial word changes which point it is.
    const half = Buffer.concat([b32(1n), b32(2n), buf('01')]);
    eq(bn.ecAdd(half), null,
      'a one-byte x2 zero-extends to 2^248, which is not on the curve — so it fails, ' +
      'rather than being read as the point at infinity');
  }

  // Long input is TRUNCATED, not rejected.
  eq(hex(bn.ecAdd(Buffer.concat([b32(1n), b32(2n), b32(0n), b32(0n), b32(9n)]))),
    hex(bn.encodeG1(bn.G1)), 'ecAdd ignores anything past its 128 bytes');

  // A coordinate at or above the modulus is INVALID, never reduced.
  eq(bn.ecAdd(Buffer.concat([b32(P), b32(2n), b32(0n), b32(0n)])), null, 'x = p is invalid');
  eq(bn.ecAdd(Buffer.concat([b32(P + 1n), b32(2n), b32(0n), b32(0n)])), null, 'x = p+1 is invalid');
  eq(bn.ecAdd(Buffer.concat([b32(1n), b32(P), b32(0n), b32(0n)])), null, 'y = p is invalid');
  ok(bn.ecAdd(Buffer.concat([b32(P - 1n), b32(2n), b32(0n), b32(0n)])) === null,
    'x = p-1 is in the field but not on the curve, so it is invalid for a different reason');

  // A point that is not on the curve is invalid; (0, 0) is infinity and is VALID.
  eq(bn.ecAdd(Buffer.concat([b32(1n), b32(3n), b32(0n), b32(0n)])), null, '(1, 3) is not on the curve');
  ok(bn.ecAdd(Buffer.alloc(128)) !== null, '(0, 0) is the point at infinity and is valid');

  // The scalar for ecMul is NOT reduced and NOT range-checked.
  const big = (1n << 256n) - 1n;
  ok(bn.ecMul(Buffer.concat([b32(1n), b32(2n), b32(big)])) !== null,
    'a scalar of 2^256-1 is accepted, not rejected for exceeding r');
  eq(hex(bn.ecMul(Buffer.concat([b32(1n), b32(2n), b32(big)]))),
    hex(bn.encodeG1(bn.g1Mul(bn.G1, big % R))),
    '…and multiplies by it, which is the same point as the reduced scalar gives');
  eq(hex(bn.ecMul(Buffer.concat([b32(1n), b32(2n), b32(R)]))), '00'.repeat(64), 'r·G = O');

  // 0x08 is the exception: its length rule is exact, not padded.
  eq(bn.ecPairing(Buffer.alloc(191)), null, '191 bytes is not a multiple of 192 — the call fails');
  eq(bn.ecPairing(Buffer.alloc(193)), null, '193 bytes likewise');
  eq(hex(bn.ecPairing(Buffer.alloc(0))), '00'.repeat(31) + '01', 'empty input is TRUE, not an error');
  eq(hex(bn.ecPairing(Buffer.alloc(192))), '00'.repeat(31) + '01',
    'a pair of infinities is TRUE');
}

// ---------------------------------------------------------------------------
// published vectors
// ---------------------------------------------------------------------------

/* Verbatim from go-ethereum core/vm/testdata/precompiles/, with their expected
 * gas. The names are the ethereum/tests names — chfast and cdetrio are the two
 * people who contributed the original bn128 vector sets, jeff is the Groth16
 * verifier trace, and ten_point_match is the only vector long enough to exercise
 * a product of ten Miller loops under one final exponentiation. */
const GETH_ADD = [
  { name: "chfast1", gas: 150n,
    expected: "2243525c5efd4b9c3d3c45ac0ca3fe4dd85e830a4ce6b65fa1eeaee202839703301d1d33be6da8e509df21cc35964723180eed7532537db9ae5e7d48f195c915",
    input:
    "18b18acfb4c2c30276db5411368e7185b311dd124691610c5d3b74034e093dc9" +
    "063c909c4720840cb5134cb9f59fa749755796819658d32efc0d288198f37266" +
    "07c2b7f58a84bd6145f00c9c2bc0bb1a187f20ff2c92963a88019e7c6a014eed" +
    "06614e20c147e940f2d70da3f74c9a17df361706a4485c742bd6788478fa17d7" },
  { name: "chfast2", gas: 150n,
    expected: "2bd3e6d0f3b142924f5ca7b49ce5b9d54c4703d7ae5648e61d02268b1a0a9fb721611ce0a6af85915e2f1d70300909ce2e49dfad4a4619c8390cae66cefdb204",
    input:
    "2243525c5efd4b9c3d3c45ac0ca3fe4dd85e830a4ce6b65fa1eeaee202839703" +
    "301d1d33be6da8e509df21cc35964723180eed7532537db9ae5e7d48f195c915" +
    "18b18acfb4c2c30276db5411368e7185b311dd124691610c5d3b74034e093dc9" +
    "063c909c4720840cb5134cb9f59fa749755796819658d32efc0d288198f37266" },
  { name: "cdetrio1", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    input:
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
  { name: "cdetrio2", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    input:
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
  { name: "cdetrio3", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    input:
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000" },
  { name: "cdetrio4", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    input:"" },
  { name: "cdetrio5", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    input:
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
  { name: "cdetrio6", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002",
    input:
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" },
  { name: "cdetrio7", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002",
    input:
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
  { name: "cdetrio8", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" },
  { name: "cdetrio9", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
  { name: "cdetrio10", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
  { name: "cdetrio11", gas: 150n,
    expected: "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd315ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" },
  { name: "cdetrio12", gas: 150n,
    expected: "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd315ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
  { name: "cdetrio13", gas: 150n,
    expected: "15bf2bb17880144b5d1cd2b1f46eff9d617bffd1ca57c37fb5a49bd84e53cf66049c797f9ce0d17083deb32b5e36f2ea2a212ee036598dd7624c168993d1355f",
    input:
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "01e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c" +
    "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869" +
    "073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98" },
  { name: "cdetrio14", gas: 150n,
    expected: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    input:
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "01e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c" +
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "2e83f8d734803fc370eba25ed1f6b8768bd6d83887b87165fc2434fe11a830cb" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
];

const GETH_MUL = [
  { name: "chfast1", gas: 6000n,
    expected: "070a8d6a982153cae4be29d434e8faef8a47b274a053f5a4ee2a6c9c13c31e5c031b8ce914eba3a9ffb989f9cdd5b0f01943074bf4f0f315690ec3cec6981afc",
    input:
    "2bd3e6d0f3b142924f5ca7b49ce5b9d54c4703d7ae5648e61d02268b1a0a9fb7" +
    "21611ce0a6af85915e2f1d70300909ce2e49dfad4a4619c8390cae66cefdb204" +
    "00000000000000000000000000000000000000000000000011138ce750fa15c2" },
  { name: "chfast2", gas: 6000n,
    expected: "025a6f4181d2b4ea8b724290ffb40156eb0adb514c688556eb79cdea0752c2bb2eff3f31dea215f1eb86023a133a996eb6300b44da664d64251d05381bb8a02e",
    input:
    "070a8d6a982153cae4be29d434e8faef8a47b274a053f5a4ee2a6c9c13c31e5c" +
    "031b8ce914eba3a9ffb989f9cdd5b0f01943074bf4f0f315690ec3cec6981afc" +
    "30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd46" },
  { name: "chfast3", gas: 6000n,
    expected: "14789d0d4a730b354403b5fac948113739e276c23e0258d8596ee72f9cd9d3230af18a63153e0ec25ff9f2951dd3fa90ed0197bfef6e2a1a62b5095b9d2b4a27",
    input:
    "025a6f4181d2b4ea8b724290ffb40156eb0adb514c688556eb79cdea0752c2bb" +
    "2eff3f31dea215f1eb86023a133a996eb6300b44da664d64251d05381bb8a02e" +
    "183227397098d014dc2822db40c0ac2ecbc0b548b438e5469e10460b6c3e7ea3" },
  { name: "cdetrio1", gas: 6000n,
    expected: "2cde5879ba6f13c0b5aa4ef627f159a3347df9722efce88a9afbb20b763b4c411aa7e43076f6aee272755a7f9b84832e71559ba0d2e0b17d5f9f01755e5b0d11",
    input:
    "1a87b0584ce92f4593d161480614f2989035225609f08058ccfa3d0f940febe3" +
    "1a2f3c951f6dadcc7ee9007dff81504b0fcd6d7cf59996efdc33d92bf7f9f8f6" +
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
  { name: "cdetrio2", gas: 6000n,
    expected: "1a87b0584ce92f4593d161480614f2989035225609f08058ccfa3d0f940febe3163511ddc1c3f25d396745388200081287b3fd1472d8339d5fecb2eae0830451",
    input:
    "1a87b0584ce92f4593d161480614f2989035225609f08058ccfa3d0f940febe3" +
    "1a2f3c951f6dadcc7ee9007dff81504b0fcd6d7cf59996efdc33d92bf7f9f8f6" +
    "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000" },
  { name: "cdetrio3", gas: 6000n,
    expected: "1051acb0700ec6d42a88215852d582efbaef31529b6fcbc3277b5c1b300f5cf0135b2394bb45ab04b8bd7611bd2dfe1de6a4e6e2ccea1ea1955f577cd66af85b",
    input:
    "1a87b0584ce92f4593d161480614f2989035225609f08058ccfa3d0f940febe3" +
    "1a2f3c951f6dadcc7ee9007dff81504b0fcd6d7cf59996efdc33d92bf7f9f8f6" +
    "0000000000000000000000000000000100000000000000000000000000000000" },
  { name: "cdetrio4", gas: 6000n,
    expected: "1dbad7d39dbc56379f78fac1bca147dc8e66de1b9d183c7b167351bfe0aeab742cd757d51289cd8dbd0acf9e673ad67d0f0a89f912af47ed1be53664f5692575",
    input:
    "1a87b0584ce92f4593d161480614f2989035225609f08058ccfa3d0f940febe3" +
    "1a2f3c951f6dadcc7ee9007dff81504b0fcd6d7cf59996efdc33d92bf7f9f8f6" +
    "0000000000000000000000000000000000000000000000000000000000000009" },
  { name: "cdetrio5", gas: 6000n,
    expected: "1a87b0584ce92f4593d161480614f2989035225609f08058ccfa3d0f940febe31a2f3c951f6dadcc7ee9007dff81504b0fcd6d7cf59996efdc33d92bf7f9f8f6",
    input:
    "1a87b0584ce92f4593d161480614f2989035225609f08058ccfa3d0f940febe3" +
    "1a2f3c951f6dadcc7ee9007dff81504b0fcd6d7cf59996efdc33d92bf7f9f8f6" +
    "0000000000000000000000000000000000000000000000000000000000000001" },
  { name: "cdetrio6", gas: 6000n,
    expected: "29e587aadd7c06722aabba753017c093f70ba7eb1f1c0104ec0564e7e3e21f6022b1143f6a41008e7755c71c3d00b6b915d386de21783ef590486d8afa8453b1",
    input:
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "01e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c" +
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
  { name: "cdetrio7", gas: 6000n,
    expected: "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa92e83f8d734803fc370eba25ed1f6b8768bd6d83887b87165fc2434fe11a830cb",
    input:
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "01e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c" +
    "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000" },
  { name: "cdetrio8", gas: 6000n,
    expected: "221a3577763877920d0d14a91cd59b9479f83b87a653bb41f82a3f6f120cea7c2752c7f64cdd7f0e494bff7b60419f242210f2026ed2ec70f89f78a4c56a1f15",
    input:
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "01e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c" +
    "0000000000000000000000000000000100000000000000000000000000000000" },
  { name: "cdetrio9", gas: 6000n,
    expected: "228e687a379ba154554040f8821f4e41ee2be287c201aa9c3bc02c9dd12f1e691e0fd6ee672d04cfd924ed8fdc7ba5f2d06c53c1edc30f65f2af5a5b97f0a76a",
    input:
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "01e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c" +
    "0000000000000000000000000000000000000000000000000000000000000009" },
  { name: "cdetrio10", gas: 6000n,
    expected: "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa901e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c",
    input:
    "17c139df0efee0f766bc0204762b774362e4ded88953a39ce849a8a7fa163fa9" +
    "01e0559bacb160664764a357af8a9fe70baa9258e0b959273ffc5718c6d4cc7c" +
    "0000000000000000000000000000000000000000000000000000000000000001" },
  { name: "cdetrio11", gas: 6000n,
    expected: "00a1a234d08efaa2616607e31eca1980128b00b415c845ff25bba3afcb81dc00242077290ed33906aeb8e42fd98c41bcb9057ba03421af3f2d08cfc441186024",
    input:
    "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869" +
    "073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98" +
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
  { name: "cdetrio12", gas: 6000n,
    expected: "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b8692929ee761a352600f54921df9bf472e66217e7bb0cee9032e00acc86b3c8bfaf",
    input:
    "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869" +
    "073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98" +
    "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000" },
  { name: "cdetrio13", gas: 6000n,
    expected: "1071b63011e8c222c5a771dfa03c2e11aac9666dd097f2c620852c3951a4376a2f46fe2f73e1cf310a168d56baa5575a8319389d7bfa6b29ee2d908305791434",
    input:
    "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869" +
    "073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98" +
    "0000000000000000000000000000000100000000000000000000000000000000" },
  { name: "cdetrio14", gas: 6000n,
    expected: "19f75b9dd68c080a688774a6213f131e3052bd353a304a189d7a2ee367e3c2582612f545fb9fc89fde80fd81c68fc7dcb27fea5fc124eeda69433cf5c46d2d7f",
    input:
    "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869" +
    "073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98" +
    "0000000000000000000000000000000000000000000000000000000000000009" },
  { name: "cdetrio15", gas: 6000n,
    expected: "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98",
    input:
    "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869" +
    "073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98" +
    "0000000000000000000000000000000000000000000000000000000000000001" },
  { name: "zeroScalar", gas: 6000n,
    expected: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    input:
    "039730ea8dff1254c0fee9c0ea777d29a9c710b7e616683f194f18c43b43b869" +
    "073a5ffcc6fc7a28c30723d6e58ce577356982d65b833a5a5c15bf9024b43d98" +
    "0000000000000000000000000000000000000000000000000000000000000000" },
];

const GETH_PAIRING = [
  { name: "jeff1", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "1c76476f4def4bb94541d57ebba1193381ffa7aa76ada664dd31c16024c43f59" +
    "3034dd2920f673e204fee2811c678745fc819b55d3e9d294e45c9b03a76aef41" +
    "209dd15ebff5d46c4bd888e51a93cf99a7329636c63514396b4a452003a35bf7" +
    "04bf11ca01483bfa8b34b43561848d28905960114c8ac04049af4b6315a41678" +
    "2bb8324af6cfc93537a2ad1a445cfd0ca2a71acd7ac41fadbf933c2a51be344d" +
    "120a2a4cf30c1bf9845f20c6fe39e07ea2cce61f0c9bb048165fe5e4de877550" +
    "111e129f1cf1097710d41c4ac70fcdfa5ba2023c6ff1cbeac322de49d1b6df7c" +
    "2032c61a830e3c17286de9462bf242fca2883585b93870a73853face6a6bf411" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "jeff2", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "2eca0c7238bf16e83e7a1e6c5d49540685ff51380f309842a98561558019fc02" +
    "03d3260361bb8451de5ff5ecd17f010ff22f5c31cdf184e9020b06fa5997db84" +
    "1213d2149b006137fcfb23036606f848d638d576a120ca981b5b1a5f9300b3ee" +
    "2276cf730cf493cd95d64677bbb75fc42db72513a4c1e387b476d056f80aa75f" +
    "21ee6226d31426322afcda621464d0611d226783262e21bb3bc86b537e986237" +
    "096df1f82dff337dd5972e32a8ad43e28a78a96a823ef1cd4debe12b6552ea5f" +
    "06967a1237ebfeca9aaae0d6d0bab8e28c198c5a339ef8a2407e31cdac516db9" +
    "22160fa257a5fd5b280642ff47b65eca77e626cb685c84fa6d3b6882a283ddd1" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "jeff3", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "0f25929bcb43d5a57391564615c9e70a992b10eafa4db109709649cf48c50dd2" +
    "16da2f5cb6be7a0aa72c440c53c9bbdfec6c36c7d515536431b3a865468acbba" +
    "2e89718ad33c8bed92e210e81d1853435399a271913a6520736a4729cf0d51eb" +
    "01a9e2ffa2e92599b68e44de5bcf354fa2642bd4f26b259daa6f7ce3ed57aeb3" +
    "14a9a87b789a58af499b314e13c3d65bede56c07ea2d418d6874857b70763713" +
    "178fb49a2d6cd347dc58973ff49613a20757d0fcc22079f9abd10c3baee24590" +
    "1b9e027bd5cfc2cb5db82d4dc9677ac795ec500ecd47deee3b5da006d6d049b8" +
    "11d7511c78158de484232fc68daf8a45cf217d1c2fae693ff5871e8752d73b21" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "jeff4", gas: 147000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "2f2ea0b3da1e8ef11914acf8b2e1b32d99df51f5f4f206fc6b947eae860eddb6" +
    "068134ddb33dc888ef446b648d72338684d678d2eb2371c61a50734d78da4b72" +
    "25f83c8b6ab9de74e7da488ef02645c5a16a6652c3c71a15dc37fe3a5dcb7cb1" +
    "22acdedd6308e3bb230d226d16a105295f523a8a02bfc5e8bd2da135ac4c245d" +
    "065bbad92e7c4e31bf3757f1fe7362a63fbfee50e7dc68da116e67d600d9bf68" +
    "06d302580dc0661002994e7cd3a7f224e7ddc27802777486bf80f40e4ca3cfdb" +
    "186bac5188a98c45e6016873d107f5cd131f3a3e339d0375e58bd6219347b008" +
    "122ae2b09e539e152ec5364e7e2204b03d11d3caa038bfc7cd499f8176aacbee" +
    "1f39e4e4afc4bc74790a4a028aff2c3d2538731fb755edefd8cb48d6ea589b5e" +
    "283f150794b6736f670d6a1033f9b46c6f5204f50813eb85c8dc4b59db1c5d39" +
    "140d97ee4d2b36d99bc49974d18ecca3e7ad51011956051b464d9e27d46cc25e" +
    "0764bb98575bd466d32db7b15f582b2d5c452b36aa394b789366e5e3ca5aabd4" +
    "15794ab061441e51d01e94640b7e3084a07e02c78cf3103c542bc5b298669f21" +
    "1b88da1679b0b64a63b7e0e7bfe52aae524f73a55be7fe70c7e9bfc94b4cf0da" +
    "1213d2149b006137fcfb23036606f848d638d576a120ca981b5b1a5f9300b3ee" +
    "2276cf730cf493cd95d64677bbb75fc42db72513a4c1e387b476d056f80aa75f" +
    "21ee6226d31426322afcda621464d0611d226783262e21bb3bc86b537e986237" +
    "096df1f82dff337dd5972e32a8ad43e28a78a96a823ef1cd4debe12b6552ea5f" },
  { name: "jeff5", gas: 147000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "20a754d2071d4d53903e3b31a7e98ad6882d58aec240ef981fdf0a9d22c5926a" +
    "29c853fcea789887315916bbeb89ca37edb355b4f980c9a12a94f30deeed3021" +
    "1213d2149b006137fcfb23036606f848d638d576a120ca981b5b1a5f9300b3ee" +
    "2276cf730cf493cd95d64677bbb75fc42db72513a4c1e387b476d056f80aa75f" +
    "21ee6226d31426322afcda621464d0611d226783262e21bb3bc86b537e986237" +
    "096df1f82dff337dd5972e32a8ad43e28a78a96a823ef1cd4debe12b6552ea5f" +
    "1abb4a25eb9379ae96c84fff9f0540abcfc0a0d11aeda02d4f37e4baf74cb0c1" +
    "1073b3ff2cdbb38755f8691ea59e9606696b3ff278acfc098fa8226470d03869" +
    "217cee0a9ad79a4493b5253e2e4e3a39fc2df38419f230d341f60cb064a0ac29" +
    "0a3d76f140db8418ba512272381446eb73958670f00cf46f1d9e64cba057b53c" +
    "26f64a8ec70387a13e41430ed3ee4a7db2059cc5fc13c067194bcc0cb49a9855" +
    "2fd72bd9edb657346127da132e5b82ab908f5816c826acb499e22f2412d1a2d7" +
    "0f25929bcb43d5a57391564615c9e70a992b10eafa4db109709649cf48c50dd2" +
    "198a1f162a73261f112401aa2db79c7dab1533c9935c77290a6ce3b191f2318d" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "jeff6", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000000",
    input:
    "1c76476f4def4bb94541d57ebba1193381ffa7aa76ada664dd31c16024c43f59" +
    "3034dd2920f673e204fee2811c678745fc819b55d3e9d294e45c9b03a76aef41" +
    "209dd15ebff5d46c4bd888e51a93cf99a7329636c63514396b4a452003a35bf7" +
    "04bf11ca01483bfa8b34b43561848d28905960114c8ac04049af4b6315a41678" +
    "2bb8324af6cfc93537a2ad1a445cfd0ca2a71acd7ac41fadbf933c2a51be344d" +
    "120a2a4cf30c1bf9845f20c6fe39e07ea2cce61f0c9bb048165fe5e4de877550" +
    "111e129f1cf1097710d41c4ac70fcdfa5ba2023c6ff1cbeac322de49d1b6df7c" +
    "103188585e2364128fe25c70558f1560f4f9350baf3959e603cc91486e110936" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "empty_data", gas: 45000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:"" },
  { name: "one_point", gas: 79000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000000",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "two_point_match_2", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec" +
    "1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d" },
  { name: "two_point_match_3", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "203e205db4f19b37b60121b83a7333706db86431c6d835849957ed8c3928ad79" +
    "27dc7234fd11d3e8c36c59277c3e6f149d5cd3cfa9a62aee49f8130962b4b3b9" +
    "195e8aa5b7827463722b8c153931579d3505566b4edf48d498e185f0509de152" +
    "04bb53b8977e5f92a0bc372742c4830944a59b4fe6b1c0466e2a6dad122b5d2e" +
    "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3" +
    "1a76dae6d3272396d0cbe61fced2bc532edac647851e3ac53ce1cc9c7e645a83" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "two_point_match_4", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "105456a333e6d636854f987ea7bb713dfd0ae8371a72aea313ae0c32c0bf1016" +
    "0cf031d41b41557f3e7e3ba0c51bebe5da8e6ecd855ec50fc87efcdeac168bcc" +
    "0476be093a6d2b4bbf907172049874af11e1b6267606e00804d3ff0037ec57fd" +
    "3010c68cb50161b7d1d96bb71edfec9880171954e56871abf3d93cc94d745fa1" +
    "14c059d74e5b6c4ec14ae5864ebe23a71781d86c29fb8fb6cce94f70d3de7a21" +
    "01b33461f39d9e887dbb100f170a2345dde3c07e256d1dfa2b657ba5cd030427" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "1a2c3013d2ea92e13c800cde68ef56a294b883f6ac35d25f587c09b1b3c635f7" +
    "290158a80cd3d66530f74dc94c94adb88f5cdb481acca997b6e60071f08a115f" +
    "2f997f3dbd66a7afe07fe7862ce239edba9e05c5afff7f8a1259c9733b2dfbb9" +
    "29d1691530ca701b4a106054688728c9972c8512e9789e9567aae23e302ccd75" },
  { name: "ten_point_match_1", gas: 385000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec" +
    "1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec" +
    "1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec" +
    "1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec" +
    "1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec" +
    "1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d" },
  { name: "ten_point_match_2", gas: 385000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "203e205db4f19b37b60121b83a7333706db86431c6d835849957ed8c3928ad79" +
    "27dc7234fd11d3e8c36c59277c3e6f149d5cd3cfa9a62aee49f8130962b4b3b9" +
    "195e8aa5b7827463722b8c153931579d3505566b4edf48d498e185f0509de152" +
    "04bb53b8977e5f92a0bc372742c4830944a59b4fe6b1c0466e2a6dad122b5d2e" +
    "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3" +
    "1a76dae6d3272396d0cbe61fced2bc532edac647851e3ac53ce1cc9c7e645a83" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "203e205db4f19b37b60121b83a7333706db86431c6d835849957ed8c3928ad79" +
    "27dc7234fd11d3e8c36c59277c3e6f149d5cd3cfa9a62aee49f8130962b4b3b9" +
    "195e8aa5b7827463722b8c153931579d3505566b4edf48d498e185f0509de152" +
    "04bb53b8977e5f92a0bc372742c4830944a59b4fe6b1c0466e2a6dad122b5d2e" +
    "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3" +
    "1a76dae6d3272396d0cbe61fced2bc532edac647851e3ac53ce1cc9c7e645a83" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "203e205db4f19b37b60121b83a7333706db86431c6d835849957ed8c3928ad79" +
    "27dc7234fd11d3e8c36c59277c3e6f149d5cd3cfa9a62aee49f8130962b4b3b9" +
    "195e8aa5b7827463722b8c153931579d3505566b4edf48d498e185f0509de152" +
    "04bb53b8977e5f92a0bc372742c4830944a59b4fe6b1c0466e2a6dad122b5d2e" +
    "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3" +
    "1a76dae6d3272396d0cbe61fced2bc532edac647851e3ac53ce1cc9c7e645a83" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "203e205db4f19b37b60121b83a7333706db86431c6d835849957ed8c3928ad79" +
    "27dc7234fd11d3e8c36c59277c3e6f149d5cd3cfa9a62aee49f8130962b4b3b9" +
    "195e8aa5b7827463722b8c153931579d3505566b4edf48d498e185f0509de152" +
    "04bb53b8977e5f92a0bc372742c4830944a59b4fe6b1c0466e2a6dad122b5d2e" +
    "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3" +
    "1a76dae6d3272396d0cbe61fced2bc532edac647851e3ac53ce1cc9c7e645a83" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "203e205db4f19b37b60121b83a7333706db86431c6d835849957ed8c3928ad79" +
    "27dc7234fd11d3e8c36c59277c3e6f149d5cd3cfa9a62aee49f8130962b4b3b9" +
    "195e8aa5b7827463722b8c153931579d3505566b4edf48d498e185f0509de152" +
    "04bb53b8977e5f92a0bc372742c4830944a59b4fe6b1c0466e2a6dad122b5d2e" +
    "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3" +
    "1a76dae6d3272396d0cbe61fced2bc532edac647851e3ac53ce1cc9c7e645a83" +
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" +
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" +
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa" },
  { name: "ten_point_match_3", gas: 113000n,
    expected: "0000000000000000000000000000000000000000000000000000000000000001",
    input:
    "105456a333e6d636854f987ea7bb713dfd0ae8371a72aea313ae0c32c0bf1016" +
    "0cf031d41b41557f3e7e3ba0c51bebe5da8e6ecd855ec50fc87efcdeac168bcc" +
    "0476be093a6d2b4bbf907172049874af11e1b6267606e00804d3ff0037ec57fd" +
    "3010c68cb50161b7d1d96bb71edfec9880171954e56871abf3d93cc94d745fa1" +
    "14c059d74e5b6c4ec14ae5864ebe23a71781d86c29fb8fb6cce94f70d3de7a21" +
    "01b33461f39d9e887dbb100f170a2345dde3c07e256d1dfa2b657ba5cd030427" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "1a2c3013d2ea92e13c800cde68ef56a294b883f6ac35d25f587c09b1b3c635f7" +
    "290158a80cd3d66530f74dc94c94adb88f5cdb481acca997b6e60071f08a115f" +
    "2f997f3dbd66a7afe07fe7862ce239edba9e05c5afff7f8a1259c9733b2dfbb9" +
    "29d1691530ca701b4a106054688728c9972c8512e9789e9567aae23e302ccd75" },
];

group('published vectors — go-ethereum core/vm/testdata/precompiles');
{
  const suites = [
    ['bn256Add', 6, GETH_ADD, bn.ecAdd],
    ['bn256ScalarMul', 7, GETH_MUL, bn.ecMul],
    ['bn256Pairing', 8, GETH_PAIRING, bn.ecPairing],
  ];
  let vectors = 0;
  for (const [name, idx, list, fn] of suites) {
    let good = 0;
    for (const v of list) {
      const input = buf(v.input);
      const out = fn(input);
      if (hex(out) === v.expected && PRE.PRECOMPILES[idx].gas(input) === v.gas) good++;
      else {
        console.log(`  ✗ ${name}/${v.name}`);
        if (hex(out) !== v.expected) console.log(`      output expected ${v.expected}\n             got      ${hex(out)}`);
        const g = PRE.PRECOMPILES[idx].gas(input);
        if (g !== v.gas) console.log(`      gas expected ${v.gas}, got ${g}`);
      }
      vectors++;
    }
    eq(good, list.length, `${name}: all ${list.length} vectors match output AND gas`);
  }
  ok(vectors >= 45, `${vectors} published precompile vectors ran`);
  ok(GETH_PAIRING.some((v) => v.name.startsWith('ten_point_match')),
    'the ten-pair vectors are present — they are the only ones that exercise a long product');
}

// ---------------------------------------------------------------------------
// the ethereum/tests corpus
// ---------------------------------------------------------------------------

/* stZeroKnowledge and stZeroKnowledge2 are GeneralStateTests: they publish a
 * post-state ROOT and nothing else, and Hearth has no state-transition layer yet
 * (spec §8 phase 4), so they cannot be executed. What is done instead is stated
 * plainly at the top of this file — lift the precompile input out of every one of
 * them and check the accept/reject/true/false decision against what the fixture's
 * own NAME asserts.
 *
 * Two shapes of fixture. Most wrap the input in an ABI `bytes` argument behind a
 * four-byte selector; `ecpairing_inputs` hands the raw calldata straight through
 * to a forwarding contract. Both are unwrapped below. */

const CORPUS = path.join(__dirname, 'conformance', 'vectors', 'GeneralStateTests');

/** What the fixture name asserts about the outcome, or null when it asserts
 *  nothing this harness can read. */
function expectationFromName(name) {
  if (/^ecpairing_bad_length/.test(name)) return 'reject';
  if (/not_in_subgroup/.test(name)) return 'reject';
  if (/g1_invalid/.test(name)) return 'reject';
  if (/^ecpairing_perturb_/.test(name)) return 'reject';
  if (/^ecpairing_empty_data/.test(name)) return 'true';
  if (/^ecpairing_.*_match(_\d+)?$/.test(name)) return 'true';
  if (/^ecpairing_.*_fail(_\d+)?$/.test(name)) return 'false';
  if (/^ecpairing_one_point_with_g[12]_zero$/.test(name)) return 'true';
  // ec(add|mul) of a point with y = 3 or x = 0, y = 3: not on the curve.
  if (/^ecadd_(0|1)-3_/.test(name) || /^ecadd_.*_(0|1)-3_/.test(name)) return 'reject';
  if (/^ecmul_(0|1)-3_/.test(name)) return 'reject';
  return null;
}

function loadCorpus() {
  const cases = [];
  for (const dir of ['stZeroKnowledge', 'stZeroKnowledge2']) {
    const full = path.join(CORPUS, dir);
    if (!fs.existsSync(full)) return null;
    for (const file of fs.readdirSync(full).sort()) {
      if (!file.endsWith('.json')) continue;
      const doc = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
      for (const [name, t] of Object.entries(doc)) {
        const idx = name.startsWith('ecadd') ? 6 : name.startsWith('ecmul') ? 7
          : name.startsWith('ecpairing') ? 8 : 0;
        if (!idx) continue;                      // pointAdd, pairingTest et al are Solidity
        for (const datum of t.transaction.data) {
          const h = datum.replace(/^0x/, '');
          let body;
          if (h.length >= 136 && BigInt('0x' + h.slice(8, 72)) === 32n) {
            const len = Number(BigInt('0x' + h.slice(72, 136)));
            body = h.slice(136, 136 + len * 2);
            if (body.length !== len * 2) continue;
          } else {
            body = h;                            // ecpairing_inputs: raw calldata
          }
          cases.push({ name, idx, input: Buffer.from(body, 'hex') });
        }
      }
    }
  }
  return cases;
}

group('ethereum/tests GeneralStateTests — every precompile input they carry');
{
  const cases = loadCorpus();
  if (cases === null) {
    skipped++;
    console.log('  … SKIPPED: the corpus is not fetched. Run node/scripts/fetch-vectors.sh.');
    console.log('    Without it the only conformance evidence in this file is the go-ethereum');
    console.log('    vector set above, which does not cover the rejection cases at all.');
  } else {
    const fns = { 6: bn.ecAdd, 7: bn.ecMul, 8: bn.ecPairing };
    const tally = { checked: 0, unasserted: 0, errors: 0, onCurve: 0, commuted: 0 };
    const wrong = [];
    for (const c of cases) {
      let out, threw = null;
      try { out = fns[c.idx](c.input); } catch (err) { threw = err; }
      if (threw) { tally.errors++; wrong.push(`${c.name}: THREW ${threw.message}`); continue; }
      const got = out === null ? 'reject'
        : c.idx === 8 ? (out[31] === 1 ? 'true' : 'false')
          : (out.every((b) => b === 0) ? 'infinity' : 'point');
      /* An invariant that holds for every accepted ec(add|mul) input, whatever the
       * name says, and that a windowing or coordinate-conversion bug cannot satisfy
       * by accident: whatever comes back has to be ON THE CURVE. It is not circular
       * — the curve equation is not consulted anywhere on the arithmetic path. */
      if (c.idx !== 8 && out !== null) {
        tally.onCurve++;
        const x = bn.word(out, 0), y = bn.word(out, 32);
        if (!(x === 0n && y === 0n) && !bn.g1OnCurve(x, y)) {
          wrong.push(`${c.name}: produced a point that is not on the curve`);
        }
      }
      /* …and ecAdd is commutative, checked by handing it the same two points the
       * other way round. Only for full-length inputs, where "the other way round"
       * is unambiguous. */
      if (c.idx === 6 && c.input.length === 128) {
        const swapped = Buffer.concat([c.input.subarray(64), c.input.subarray(0, 64)]);
        if (hex(bn.ecAdd(swapped)) !== hex(out)) wrong.push(`${c.name}: ecAdd is not commutative`);
        tally.commuted++;
      }

      const want = expectationFromName(c.name);
      if (want === null) { tally.unasserted++; continue; }
      tally.checked++;
      if (got !== want) wrong.push(`${c.name}: expected ${want}, got ${got}`);
    }
    console.log(`  ${cases.length} inputs lifted from the corpus: ` +
      `${tally.checked} carry an assertion in their name, ${tally.unasserted} do not`);
    console.log(`  ${tally.onCurve} accepted ec(add|mul) results checked against the curve ` +
      `equation, ${tally.commuted} ecAdd inputs checked for commutativity`);
    eq(tally.errors, 0, 'nothing in the corpus makes the implementation throw');
    for (const w of wrong.slice(0, 20)) console.log('      ' + w);
    eq(wrong.length, 0, `all ${tally.checked} name-asserted corpus cases agree, ` +
      'and every accepted point is on the curve');
    ok(tally.checked > 100, 'the corpus carries a substantial number of readable assertions');

    // The corpus's own truncation cases are the zero-padding rule in the wild:
    // ecadd_..._64 and ecmul_..._80 are deliberately short inputs.
    ok(cases.some((c) => c.idx === 6 && c.input.length === 64),
      'the corpus includes a 64-byte ecAdd — the zero-padding rule, exercised upstream');
    ok(cases.some((c) => c.idx === 7 && c.input.length === 80),
      'and an 80-byte ecMul');
  }
}

// ---------------------------------------------------------------------------

group('performance');
{
  const one = buf(GETH_PAIRING.find((v) => v.name === 'one_point').input);
  const four = Buffer.concat([
    buf(GETH_PAIRING.find((v) => v.name === 'jeff1').input),
    buf(GETH_PAIRING.find((v) => v.name === 'jeff2').input),
  ]);                                             // two vectors of two pairs each
  const ten = buf(GETH_PAIRING.find((v) => v.name === 'ten_point_match_1').input);

  const time = (fn, n) => {
    fn();                                         // warm
    const t = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn();
    return Number(process.hrtime.bigint() - t) / 1e6 / n;
  };

  const addIn = buf(GETH_ADD[0].input), mulIn = buf(GETH_MUL[0].input);
  const tAdd = time(() => bn.ecAdd(addIn), 2000);
  const tMul = time(() => bn.ecMul(mulIn), 300);
  const t1 = time(() => bn.ecPairing(one), 10);
  const t4 = time(() => bn.ecPairing(four), 5);
  const t10 = time(() => bn.ecPairing(ten), 3);

  console.log(`  ecAdd            ${tAdd.toFixed(3)} ms   (150 gas)`);
  console.log(`  ecMul            ${tMul.toFixed(3)} ms   (6,000 gas)`);
  console.log(`  ecPairing  1 pair ${t1.toFixed(1)} ms   (79,000 gas)`);
  console.log(`  ecPairing  4 pair ${t4.toFixed(1)} ms   (181,000 gas)`);
  console.log(`  ecPairing 10 pair ${t10.toFixed(1)} ms   (385,000 gas)`);

  /* What matters is not the absolute time but the time a full block of it buys.
   * At 30M gas a block, a chain is unverifiable if any of these fills a block
   * with more seconds than the block interval. */
  const block = (ms, gas) => (30e6 / gas) * ms / 1000;
  console.log(`  a full 30M-gas block would take: ` +
    `${block(tAdd, 150).toFixed(1)}s of ecAdd, ` +
    `${block(tMul, 6000).toFixed(1)}s of ecMul, ` +
    `${block(t10, 385000).toFixed(1)}s of 10-pair checks`);

  ok(t1 < 1000, 'a single pairing takes well under a second');
  ok(t4 < 2000, 'a four-pair check takes well under two seconds');
  ok(t10 < t1 * 10, 'a ten-pair check shares one final exponentiation, so it is sublinear');
}

const total = pass + fail;
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${total} bn128 checks` +
  (skipped ? ` (${skipped} skipped)` : ''));
process.exit(fail === 0 ? 0 : 1);
