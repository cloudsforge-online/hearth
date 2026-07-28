'use strict';
/* The EVM word: a 256-bit integer with wrapping arithmetic.
 *
 * Every value on the EVM stack is exactly 256 bits. JavaScript's BigInt is
 * arbitrary-precision, so nothing here is a formality: an unmasked `a + b`
 * silently produces a 257-bit number the EVM cannot represent, and the
 * divergence surfaces later as a wrong stateRoot — a chain split, or a
 * contract that behaves differently here than where it was audited. So every
 * operation in this file masks its result back to 256 bits, and that is the
 * whole point of the file existing rather than callers writing `a + b`.
 *
 * The signed operations (SDIV, SMOD, SAR, SLT, SGT, SIGNEXTEND) read the very
 * same word as two's complement. There is no separate signed type; the sign is
 * an interpretation applied per-opcode.
 *
 * Contract: arguments are canonical words, 0 <= x < 2^256, because that is all
 * the stack can hold. Results are always canonical. Nothing here throws —
 * division by zero returns 0, as the EVM requires.
 */

const BITS = 256n;
const MASK256 = (1n << BITS) - 1n;      // 2^256 - 1
const TWO256 = 1n << BITS;
const SIGN_BIT = 1n << 255n;

const ZERO = 0n;
const ONE = 1n;
const MAX_UINT256 = MASK256;
const MAX_INT256 = SIGN_BIT - 1n;       // 2^255 - 1
const MIN_INT256 = SIGN_BIT;            // the word 0x8000…0000, i.e. -2^255

/** Reduce any BigInt (including negatives) to a canonical word. */
const u256 = x => x & MASK256;

/** Read a word as two's complement. */
const asSigned = x => (x & SIGN_BIT ? (x & MASK256) - TWO256 : x & MASK256);

/** Write a signed BigInt back as a word. */
const fromSigned = x => x & MASK256;

// ---- arithmetic ------------------------------------------------------------

const add = (a, b) => (a + b) & MASK256;
const sub = (a, b) => (a - b) & MASK256;
const mul = (a, b) => (a * b) & MASK256;

/** DIV. Division by zero is 0 — the EVM has no traps, only defined answers. */
const div = (a, b) => (b === 0n ? 0n : a / b);

/** MOD. Modulo by zero is 0. */
const mod = (a, b) => (b === 0n ? 0n : a % b);

/**
 * SDIV. Truncates toward zero (BigInt `/` already does), and the one overflow
 * case — MIN_INT256 / -1, whose true value 2^255 is not representable — wraps
 * back to MIN_INT256, which is exactly what masking gives.
 */
function sdiv(a, b) {
  const sb = asSigned(b);
  if (sb === 0n) return 0n;
  return (asSigned(a) / sb) & MASK256;
}

/** SMOD. Takes the sign of the dividend, which BigInt `%` also does. */
function smod(a, b) {
  const sb = asSigned(b);
  if (sb === 0n) return 0n;
  return (asSigned(a) % sb) & MASK256;
}

/**
 * ADDMOD / MULMOD are computed at arbitrary precision and reduced afterwards.
 * (a + b) % n is NOT ((a + b) & MASK256) % n: mulmod(2^255, 2^255, 7) is 4,
 * while truncating the product first gives 0.
 */
const addmod = (a, b, n) => (n === 0n ? 0n : (a + b) % n);
const mulmod = (a, b, n) => (n === 0n ? 0n : (a * b) % n);

/**
 * EXP — modular exponentiation over 2^256. Square-and-multiply, because the
 * exponent is a full 256-bit word and `base ** exp` would try to materialise a
 * number with up to 2^256 bits. 0^0 is 1.
 */
function exp(base, e) {
  let result = 1n;
  let b = base & MASK256;
  let k = e;
  while (k > 0n) {
    if (k & 1n) result = (result * b) & MASK256;
    k >>= 1n;
    if (k > 0n) b = (b * b) & MASK256;
  }
  return result;
}

/**
 * SIGNEXTEND(k, x) — sign-extend x from the byte at index k, counting from the
 * LEAST significant end. k >= 31 means the word is already full width.
 */
function signextend(k, x) {
  if (k >= 31n) return x;
  const bit = k * 8n + 7n;              // index of the sign bit being extended
  const lower = (1n << bit) - 1n;       // every bit below it
  return (x >> bit) & 1n ? (x | ~lower) & MASK256 : x & lower;
}

// ---- comparison (results are the words 1 and 0) ----------------------------

const lt = (a, b) => (a < b ? 1n : 0n);
const gt = (a, b) => (a > b ? 1n : 0n);
const slt = (a, b) => (asSigned(a) < asSigned(b) ? 1n : 0n);
const sgt = (a, b) => (asSigned(a) > asSigned(b) ? 1n : 0n);
const eq = (a, b) => (a === b ? 1n : 0n);
const iszero = a => (a === 0n ? 1n : 0n);

// ---- bitwise ---------------------------------------------------------------

const and = (a, b) => a & b;
const or = (a, b) => a | b;
const xor = (a, b) => a ^ b;
const not = a => ~a & MASK256;

/** BYTE(i, x) — i indexes from the MOST significant byte. Out of range is 0. */
const byte = (i, x) => (i >= 32n ? 0n : (x >> (8n * (31n - i))) & 0xffn);

/** SHL. A shift of 256 or more clears the word rather than wrapping. */
const shl = (shift, value) => (shift >= BITS ? 0n : (value << shift) & MASK256);

/** SHR — logical: shifting in zeros regardless of sign. */
const shr = (shift, value) => (shift >= BITS ? 0n : value >> shift);

/**
 * SAR — arithmetic: shifting in copies of the sign bit. A negative value
 * shifted by >= 256 saturates to all ones, where SHR would give zero. BigInt
 * `>>` on a negative is already an arithmetic (floor) shift.
 */
function sar(shift, value) {
  const s = asSigned(value);
  if (shift >= BITS) return s < 0n ? MASK256 : 0n;
  return (s >> shift) & MASK256;
}

// ---- byte conversion -------------------------------------------------------

/** A word as its canonical 32-byte big-endian encoding. */
function toBuffer(x) {
  const out = Buffer.alloc(32);
  let v = x & MASK256;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Big-endian bytes as a word. Accepts fewer than 32 bytes (left-padded). */
function fromBuffer(buf) {
  let v = 0n;
  for (let i = 0; i < buf.length; i++) v = (v << 8n) | BigInt(buf[i]);
  return v & MASK256;
}

module.exports = {
  BITS, MASK256, TWO256, SIGN_BIT,
  ZERO, ONE, MAX_UINT256, MAX_INT256, MIN_INT256,
  u256, asSigned, fromSigned, toBuffer, fromBuffer,
  add, sub, mul, div, sdiv, mod, smod, addmod, mulmod, exp, signextend,
  lt, gt, slt, sgt, eq, iszero,
  and, or, xor, not, byte, shl, shr, sar,
};
