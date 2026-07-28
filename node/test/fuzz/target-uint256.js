'use strict';
/* Fuzz target: src/evm/uint256.js — differential against a second reference.
 *
 * Every reference below is written to disagree with the implementation about
 * HOW, so that agreeing about WHAT means something:
 *
 *   - masking is `((x % 2^256) + 2^256) % 2^256`, never `x & MASK256`, because
 *     `&` is the operation under test;
 *   - the two's-complement reads go through the 32-byte big-endian buffer, one
 *     byte at a time, which is how the value is actually laid out on the wire
 *     and is independent of any bit trick;
 *   - SDIV and SMOD are computed from magnitudes and signs separately, so a
 *     rounding-direction mistake cannot cancel out;
 *   - EXP is square-and-multiply from the OTHER end of the exponent.
 *
 * The inputs are drawn hard onto the boundaries where two's complement goes
 * wrong: 0, 1, 2^255 (the most negative int256), 2^255-1, 2^255+1, 2^256-1,
 * and every byte-aligned width in between. `sdiv(MIN_INT256, -1)` — the one
 * signed division whose true result is not representable — is generated on
 * every run rather than left to chance.
 */

const U = require('../../src/evm/uint256');

const name = 'uint256';

const TWO256 = 2n ** 256n;
const TWO255 = 2n ** 255n;

/** Reference mask, by remainder rather than by bitwise-and. */
const M = (x) => ((x % TWO256) + TWO256) % TWO256;

/** Reference two's-complement read, via the 32 big-endian bytes. */
function refSigned(x) {
  const w = M(x);
  const bytes = [];
  let v = w;
  for (let i = 0; i < 32; i++) { bytes.unshift(Number(v % 256n)); v /= 256n; }
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  return bytes[0] >= 0x80 ? n - TWO256 : n;
}

/** Reference: truncate-toward-zero division from magnitudes and signs. */
function refTruncDiv(a, b) {
  if (b === 0n) return 0n;
  const sa = a < 0n ? -1n : 1n, sb = b < 0n ? -1n : 1n;
  const q = (a < 0n ? -a : a) / (b < 0n ? -b : b);
  return sa * sb * q;
}

/** Reference: remainder taking the sign of the dividend. */
function refTruncMod(a, b) {
  if (b === 0n) return 0n;
  const r = (a < 0n ? -a : a) % (b < 0n ? -b : b);
  return a < 0n ? -r : r;
}

/** Reference EXP: square-and-multiply walking the exponent from the top. */
function refExp(base, e) {
  if (e === 0n) return 1n;
  const bits = e.toString(2);
  let r = 1n;
  for (const c of bits) {
    r = M(r * r);
    if (c === '1') r = M(r * M(base));
  }
  return r;
}

/** Reference SIGNEXTEND, done bytewise on the 32-byte layout. */
function refSignextend(k, x) {
  if (k >= 31n) return M(x);
  const bytes = [];
  let v = M(x);
  for (let i = 0; i < 32; i++) { bytes.unshift(Number(v % 256n)); v /= 256n; }
  const at = 31 - Number(k);                      // index of the byte named by k
  const negative = (bytes[at] & 0x80) !== 0;
  for (let i = 0; i < at; i++) bytes[i] = negative ? 0xff : 0x00;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  return n;
}

/** Reference BYTE, bytewise. */
function refByte(i, x) {
  if (i >= 32n) return 0n;
  const bytes = [];
  let v = M(x);
  for (let j = 0; j < 32; j++) { bytes.unshift(Number(v % 256n)); v /= 256n; }
  return BigInt(bytes[Number(i)]);
}

/** Reference SAR: an arithmetic shift is a floor-division by a power of two. */
function refSar(shift, value) {
  const s = refSigned(value);
  if (shift >= 256n) return M(s < 0n ? -1n : 0n);
  const d = 2n ** shift;
  const q = s < 0n ? -((-s + d - 1n) / d) : s / d;    // floor for negatives
  return M(q);
}

// ---------------------------------------------------------------------------

/* Every operation, its arity, the implementation and the reference. Keeping
 * them in one table is what makes it obvious that nothing is untested — the
 * exports of uint256.js and the keys here are compared at the top of `run`. */
const OPS = [
  ['add', 2, U.add, (a, b) => M(a + b)],
  ['sub', 2, U.sub, (a, b) => M(a - b)],
  ['mul', 2, U.mul, (a, b) => M(a * b)],
  ['div', 2, U.div, (a, b) => (b === 0n ? 0n : (a - (a % b)) / b)],
  ['mod', 2, U.mod, (a, b) => (b === 0n ? 0n : M(a) - ((M(a) - (M(a) % M(b))) / M(b)) * M(b))],
  ['sdiv', 2, U.sdiv, (a, b) => M(refTruncDiv(refSigned(a), refSigned(b)))],
  ['smod', 2, U.smod, (a, b) => M(refTruncMod(refSigned(a), refSigned(b)))],
  ['addmod', 3, U.addmod, (a, b, n) => {
    if (n === 0n) return 0n;
    const s = M(a) + M(b);                        // the full 257-bit sum, never truncated
    return s - (s / n) * n;                       // remainder by construction, not by `%`
  }],
  ['mulmod', 3, U.mulmod, (a, b, n) => {
    if (n === 0n) return 0n;
    const p = M(a) * M(b);                        // the full 512-bit product
    return p - (p / n) * n;
  }],
  ['exp', 2, U.exp, (a, b) => refExp(a, b)],
  ['signextend', 2, U.signextend, (k, x) => refSignextend(k, x)],
  ['lt', 2, U.lt, (a, b) => (M(a) < M(b) ? 1n : 0n)],
  ['gt', 2, U.gt, (a, b) => (M(a) > M(b) ? 1n : 0n)],
  ['slt', 2, U.slt, (a, b) => (refSigned(a) < refSigned(b) ? 1n : 0n)],
  ['sgt', 2, U.sgt, (a, b) => (refSigned(a) > refSigned(b) ? 1n : 0n)],
  ['eq', 2, U.eq, (a, b) => (M(a) === M(b) ? 1n : 0n)],
  ['iszero', 1, U.iszero, (a) => (M(a) === 0n ? 1n : 0n)],
  ['and', 2, U.and, (a, b) => M(a & b)],
  ['or', 2, U.or, (a, b) => M(a | b)],
  ['xor', 2, U.xor, (a, b) => M(a ^ b)],
  ['not', 1, U.not, (a) => TWO256 - 1n - M(a)],
  ['byte', 2, U.byte, (i, x) => refByte(i, x)],
  ['shl', 2, U.shl, (s, v) => (s >= 256n ? 0n : M(M(v) * 2n ** s))],
  ['shr', 2, U.shr, (s, v) => (s >= 256n ? 0n : (M(v) - (M(v) % 2n ** s)) / 2n ** s)],
  ['sar', 2, U.sar, (s, v) => refSar(s, v)],
  ['u256', 1, U.u256, (x) => M(x)],
  ['fromSigned', 1, U.fromSigned, (x) => M(x)],
];

/* The values that are always tried, on every run, for every operation that
 * takes them. These are the arguments a reviewer would pick and a uniform
 * generator would never produce. */
const CORNERS = [
  0n, 1n, 2n, 3n, 7n, 255n, 256n, 65535n, 65536n,
  TWO255 - 2n, TWO255 - 1n, TWO255, TWO255 + 1n, TWO255 + 2n,
  TWO256 - 3n, TWO256 - 2n, TWO256 - 1n,
  2n ** 64n - 1n, 2n ** 64n, 2n ** 128n, 2n ** 160n - 1n,
  31n, 32n, 33n, 254n, 257n,
];

function argFor(rng, opName, position) {
  // Shift and index arguments live in a much smaller interesting range.
  const isSmall = (opName === 'signextend' && position === 0)
    || (opName === 'byte' && position === 0)
    || ((opName === 'shl' || opName === 'shr' || opName === 'sar') && position === 0);
  if (isSmall && rng.chance(0.75)) {
    return BigInt(rng.pick([0, 1, 2, 7, 8, 15, 16, 30, 31, 32, 33, 63, 64, 127, 128, 200, 255, 256, 257, 511, 512]));
  }
  return rng.chance(0.45) ? rng.pick(CORNERS) : rng.bigUint(256);
}

function checkOp(t, op, args) {
  const [opName, arity, impl, ref] = op;
  let got, threw = null;
  try { got = impl(...args); } catch (e) { threw = e; }
  const shown = args.map((a) => '0x' + a.toString(16)).join(', ');
  if (threw) {
    // The module's contract says so in one line: "Nothing here throws".
    t.ok(false, `${opName}(${shown}) threw ${threw.constructor.name}: ${threw.message}`, { op: opName, args });
    return;
  }
  const want = ref(...args.slice(0, arity));
  if (!t.ok(got === want, `${opName}(${shown}) = 0x${got.toString(16)}, reference says 0x${want.toString(16)}`, { op: opName, args })) return;
  // Canonicality: an EVM stack word is always 0 <= x < 2^256.
  t.ok(typeof got === 'bigint' && got >= 0n && got < TWO256, `${opName} returns a canonical word`, { op: opName, args });
}

function oneCase(t, rng) {
  const op = rng.pick(OPS);
  const args = [];
  for (let i = 0; i < op[1]; i++) args.push(argFor(rng, op[0], i));
  checkOp(t, op, args);

  // Byte conversion, tested against a hand-rolled big-endian reference.
  if (rng.chance(0.15)) {
    const x = rng.chance(0.4) ? rng.pick(CORNERS) : rng.bigUint(256);
    const buf = U.toBuffer(x);
    let want = '';
    let v = M(x);
    for (let i = 0; i < 32; i++) { want = (v % 256n).toString(16).padStart(2, '0') + want; v /= 256n; }
    t.ok(buf.length === 32 && buf.toString('hex') === want, `toBuffer(0x${x.toString(16)}) is 32 big-endian bytes`, { value: x, got: buf });
    t.ok(U.fromBuffer(buf) === M(x), 'fromBuffer(toBuffer(x)) === x', { value: x });
    const short = buf.subarray(rng.int(32));
    t.ok(U.fromBuffer(short) === U.fromBuffer(Buffer.concat([Buffer.alloc(32 - short.length), short])),
      'fromBuffer left-pads a short buffer', { value: x, short });
  }

  // Algebraic identities, which catch a mistake the reference shares.
  if (rng.chance(0.2)) {
    const a = rng.chance(0.4) ? rng.pick(CORNERS) : rng.bigUint(256);
    const b = rng.chance(0.4) ? rng.pick(CORNERS) : rng.bigUint(256);
    t.ok(U.add(U.sub(a, b), b) === M(a), 'add(sub(a,b),b) === a', { a, b });
    t.ok(U.not(U.not(a)) === M(a), 'not is an involution', { a });
    t.ok(U.slt(a, b) === U.sgt(b, a), 'slt(a,b) === sgt(b,a)', { a, b });
    if (b !== 0n) t.ok(U.add(U.mul(U.div(a, b), b), U.mod(a, b)) === M(a), 'div/mod reconstruct the dividend', { a, b });
    const sh = BigInt(rng.int(257));
    t.ok(U.shr(sh, U.shl(sh, a)) === (sh >= 256n ? 0n : (M(a) % (2n ** (256n - sh)))), 'shl then shr keeps the surviving low bits', { a, shift: sh });
    // SAR of a non-negative value is SHR; of a negative one it is not.
    const nonneg = M(a) % TWO255;
    t.ok(U.sar(sh, nonneg) === U.shr(sh, nonneg), 'sar === shr for a non-negative word', { a: nonneg, shift: sh });
  }
}

/** The two's-complement cases that must be tried on every single run. */
function alwaysCases(t) {
  t.context(name, -1);
  const MIN = TWO255, NEG1 = TWO256 - 1n;
  t.ok(U.sdiv(MIN, NEG1) === MIN, 'sdiv(MIN_INT256, -1) wraps to MIN_INT256 — the one unrepresentable quotient');
  t.ok(U.smod(MIN, NEG1) === 0n, 'smod(MIN_INT256, -1) is 0');
  t.ok(U.sdiv(MIN, 1n) === MIN, 'sdiv(MIN_INT256, 1) is MIN_INT256');
  t.ok(U.sdiv(7n, NEG1) === M(-7n), 'sdiv truncates toward zero, not toward -infinity');
  t.ok(U.sdiv(M(-7n), 2n) === M(-3n), 'sdiv(-7, 2) is -3, not -4');
  t.ok(U.smod(M(-7n), 2n) === M(-1n), 'smod takes the sign of the dividend');
  t.ok(U.smod(7n, M(-2n)) === 1n, 'smod(7, -2) is +1');
  t.ok(U.sar(1n, NEG1) === NEG1, 'sar(1, -1) is -1');
  t.ok(U.sar(256n, MIN) === NEG1, 'sar past the width saturates a negative to all ones');
  t.ok(U.sar(256n, MIN - 1n) === 0n, 'sar past the width takes a positive to zero');
  t.ok(U.signextend(0n, 0xffn) === NEG1, 'signextend(0, 0xff) is -1');
  t.ok(U.signextend(0n, 0x7fn) === 0x7fn, 'signextend(0, 0x7f) is +127');
  t.ok(U.signextend(31n, NEG1) === NEG1, 'signextend(31, x) is x');
  t.ok(U.signextend(32n, 5n) === 5n, 'signextend past the width is the identity');
  t.ok(U.exp(0n, 0n) === 1n, '0^0 is 1');
  t.ok(U.exp(2n, 256n) === 0n, '2^256 wraps to 0');
  t.ok(U.mulmod(MIN, MIN, 7n) === (TWO255 * TWO255) % 7n, 'mulmod is computed before truncation');
  t.ok(U.div(1n, 0n) === 0n && U.mod(1n, 0n) === 0n && U.sdiv(1n, 0n) === 0n && U.smod(1n, 0n) === 0n,
    'division and modulo by zero are 0, not a trap');
  t.ok(U.addmod(TWO256 - 1n, TWO256 - 1n, 5n) === (2n * (TWO256 - 1n)) % 5n, 'addmod is computed before truncation');
}

function run(t, rng, { cases, deadline }) {
  t.group('uint256 — differential against an independent BigInt reference');
  alwaysCases(t);

  // Nothing in the module may go untested by accident.
  const covered = new Set(OPS.map(([n]) => n));
  const skip = new Set(['BITS', 'MASK256', 'TWO256', 'SIGN_BIT', 'ZERO', 'ONE', 'MAX_UINT256', 'MAX_INT256', 'MIN_INT256',
    'asSigned', 'toBuffer', 'fromBuffer']);
  const uncovered = Object.keys(U).filter((k) => typeof U[k] === 'function' && !covered.has(k) && !skip.has(k));
  t.ok(uncovered.length === 0, `every exported operation is in the differential table (missing: ${uncovered.join(', ')})`);

  // asSigned, checked against the bytewise reference on the corners.
  for (const c of CORNERS) t.ok(U.asSigned(c) === refSigned(c), `asSigned(0x${c.toString(16)}) matches a bytewise two's-complement read`);

  let i = 0;
  for (; i < cases; i++) {
    if ((i & 255) === 0 && Date.now() > deadline) break;
    t.context(name, i);
    oneCase(t, rng);
  }
  return i;
}

function replay(t, entry) {
  t.context(name, entry.case === undefined ? -1 : entry.case);
  const op = OPS.find(([n]) => n === entry.op);
  if (!op) { t.ok(false, `corpus ${entry._file}: no operation named ${entry.op}`); return; }
  checkOp(t, op, (entry.args || []).map((a) => (typeof a === 'bigint' ? a : BigInt(a))));
}

module.exports = { name, run, replay, OPS, CORNERS };
