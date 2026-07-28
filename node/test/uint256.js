'use strict';
/* Vector tests for the EVM word type. Zero-dependency mini harness.
 * Run: node test/uint256.js
 *
 * The shift cases are the published EIP-145 test vectors, transcribed verbatim
 * (value pushed first, shift pushed second, so the shift is the top of stack
 * and therefore the first argument here). Everything else is a boundary the
 * yellow paper defines and implementations routinely get wrong: division by
 * zero, the sdiv overflow, the sign of smod, addmod/mulmod reducing after the
 * arbitrary-precision operation rather than before. */

const U = require('../src/evm/uint256');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(got, want, msg) { ok(got === want, `${msg} — got 0x${got.toString(16)}, want 0x${want.toString(16)}`); }
function group(name) { console.log('• ' + name); }

const h = s => BigInt('0x' + s);
const MAX = U.MAX_UINT256;
const MIN_S = U.MIN_INT256;      // -2^255 as a word
const MAX_S = U.MAX_INT256;      //  2^255 - 1
const NEG1 = MAX;                // -1 as a word

// ---- representation --------------------------------------------------------
group('representation');
eq(MAX, (1n << 256n) - 1n, 'MAX_UINT256 is 2^256-1');
eq(MIN_S, 1n << 255n, 'MIN_INT256 is the word 0x8000…0000');
eq(MAX_S, (1n << 255n) - 1n, 'MAX_INT256 is 2^255-1');
eq(U.asSigned(NEG1), -1n, 'all-ones reads as -1');
eq(U.asSigned(MIN_S), -(1n << 255n), 'MIN_INT256 reads as -2^255');
eq(U.asSigned(MAX_S), (1n << 255n) - 1n, 'MAX_INT256 reads as itself');
eq(U.asSigned(0n), 0n, 'zero reads as zero');
eq(U.fromSigned(-1n), MAX, 'signed -1 writes back as all ones');
eq(U.fromSigned(-(1n << 255n)), MIN_S, 'signed -2^255 writes back as MIN_INT256');
eq(U.u256((1n << 256n) + 5n), 5n, 'u256 masks an oversized value');
eq(U.u256(-5n), MAX - 4n, 'u256 masks a negative value into two\'s complement');
ok(U.toBuffer(MAX).equals(Buffer.alloc(32, 0xff)), 'toBuffer of MAX is 32 × 0xff');
ok(U.toBuffer(0n).equals(Buffer.alloc(32)), 'toBuffer of 0 is 32 zero bytes');
eq(U.fromBuffer(U.toBuffer(h('0102030405060708090a0b0c0d0e0f10'))), h('0102030405060708090a0b0c0d0e0f10'), 'toBuffer/fromBuffer roundtrip');
eq(U.fromBuffer(Buffer.from([0xff])), 0xffn, 'fromBuffer left-pads a short buffer');

// ---- add / sub / mul: wrapping ---------------------------------------------
group('add / sub / mul');
eq(U.add(1n, 2n), 3n, 'add basic');
eq(U.add(MAX, 1n), 0n, 'MAX + 1 wraps to 0');
eq(U.add(MAX, 2n), 1n, 'MAX + 2 wraps to 1');
eq(U.add(MAX, MAX), MAX - 1n, 'MAX + MAX wraps to MAX-1');
eq(U.sub(3n, 2n), 1n, 'sub basic');
eq(U.sub(0n, 1n), MAX, '0 - 1 wraps to MAX');
eq(U.sub(0n, MAX), 1n, '0 - MAX wraps to 1');
eq(U.sub(MAX, MAX), 0n, 'MAX - MAX is 0');
eq(U.mul(3n, 4n), 12n, 'mul basic');
eq(U.mul(MAX, 2n), MAX - 1n, 'MAX * 2 wraps');
eq(U.mul(MAX, MAX), 1n, 'MAX * MAX is 1 (that is (-1)*(-1))');
eq(U.mul(MIN_S, 2n), 0n, '2^255 * 2 wraps to 0');
eq(U.mul(0n, MAX), 0n, 'mul by zero');

// ---- div / mod -------------------------------------------------------------
group('div / mod');
eq(U.div(10n, 3n), 3n, 'div truncates');
eq(U.div(MAX, MAX), 1n, 'MAX / MAX is 1');
eq(U.div(1n, 0n), 0n, 'division by zero is 0, not a trap');
eq(U.div(0n, 0n), 0n, '0 / 0 is 0');
eq(U.div(MAX, 0n), 0n, 'MAX / 0 is 0');
eq(U.div(0n, MAX), 0n, '0 / MAX is 0');
eq(U.mod(10n, 3n), 1n, 'mod basic');
eq(U.mod(5n, 0n), 0n, 'modulo by zero is 0');
eq(U.mod(0n, 0n), 0n, '0 mod 0 is 0');
eq(U.mod(MAX, 2n), 1n, 'MAX is odd');

// ---- sdiv / smod -----------------------------------------------------------
group('sdiv / smod');
eq(U.sdiv(10n, 3n), 3n, 'sdiv of two positives');
eq(U.sdiv(U.fromSigned(-10n), 3n), U.fromSigned(-3n), 'sdiv truncates toward zero, not toward -inf');
eq(U.sdiv(10n, NEG1), U.fromSigned(-10n), '10 / -1 is -10');
eq(U.sdiv(NEG1, NEG1), 1n, '-1 / -1 is 1');
eq(U.sdiv(U.fromSigned(-10n), U.fromSigned(-3n)), 3n, 'sdiv of two negatives is positive');
eq(U.sdiv(1n, 0n), 0n, 'sdiv by zero is 0');
eq(U.sdiv(MIN_S, 0n), 0n, 'sdiv MIN_INT256 by zero is 0');
eq(U.sdiv(MIN_S, NEG1), MIN_S, 'sdiv MIN_INT256 / -1 overflows back to MIN_INT256');
eq(U.sdiv(MIN_S, 1n), MIN_S, 'sdiv MIN_INT256 / 1 is itself');
eq(U.sdiv(MAX_S, NEG1), U.fromSigned(-MAX_S), 'sdiv MAX_INT256 / -1 negates');
eq(U.smod(10n, 3n), 1n, 'smod of two positives');
eq(U.smod(U.fromSigned(-10n), 3n), U.fromSigned(-1n), 'smod takes the sign of the dividend');
eq(U.smod(10n, U.fromSigned(-3n)), 1n, 'smod ignores the sign of the divisor');
eq(U.smod(U.fromSigned(-10n), U.fromSigned(-3n)), U.fromSigned(-1n), 'smod of two negatives is negative');
eq(U.smod(5n, 0n), 0n, 'smod by zero is 0');
eq(U.smod(MIN_S, NEG1), 0n, 'smod MIN_INT256 % -1 is 0');
eq(U.mod(U.fromSigned(-10n), 3n), 0n, 'unsigned mod of the same word is NOT smod');

// ---- addmod / mulmod: reduce AFTER, at full precision ----------------------
group('addmod / mulmod');
eq(U.addmod(10n, 10n, 8n), 4n, 'addmod basic');
eq(U.addmod(MAX, 2n, 10n), 7n, 'addmod does not truncate the sum first: (2^256+1) mod 10 = 7');
ok(U.addmod(MAX, 2n, 10n) !== U.mod(U.add(MAX, 2n), 10n), 'addmod differs from add-then-mod, which is the whole point');
eq(U.addmod(MAX, MAX, 3n), 0n, 'addmod MAX+MAX mod 3: 2^257-2 ≡ 0 (mod 3)');
eq(U.addmod(1n, 2n, 0n), 0n, 'addmod by zero modulus is 0');
eq(U.mulmod(10n, 10n, 8n), 4n, 'mulmod basic');
eq(U.mulmod(MIN_S, MIN_S, 7n), (1n << 510n) % 7n, 'mulmod(2^255, 2^255, 7) uses the full 510-bit product');
ok(U.mulmod(MIN_S, MIN_S, 7n) !== U.mod(U.mul(MIN_S, MIN_S), 7n), 'mulmod differs from mul-then-mod, which is the whole point');
eq(U.mulmod(MAX, MAX, 12n), ((1n << 256n) - 1n) ** 2n % 12n, 'mulmod MAX*MAX mod 12');
eq(U.mulmod(5n, 5n, 0n), 0n, 'mulmod by zero modulus is 0');
eq(U.mulmod(MAX, MAX, 1n), 0n, 'anything mod 1 is 0');

// ---- exp -------------------------------------------------------------------
group('exp');
eq(U.exp(0n, 0n), 1n, '0^0 is 1');
eq(U.exp(0n, 1n), 0n, '0^1 is 0');
eq(U.exp(5n, 0n), 1n, 'x^0 is 1');
eq(U.exp(2n, 10n), 1024n, 'exp basic');
eq(U.exp(2n, 255n), MIN_S, '2^255 is the sign bit');
eq(U.exp(2n, 256n), 0n, '2^256 wraps to 0');
eq(U.exp(2n, 257n), 0n, '2^257 wraps to 0');
eq(U.exp(3n, 256n), 3n ** 256n & MAX, '3^256 masked');
eq(U.exp(MAX, 1n), MAX, 'MAX^1');
eq(U.exp(MAX, 2n), 1n, 'MAX^2 is 1, since MAX is -1');
eq(U.exp(MAX, MAX), MAX, 'MAX^MAX is MAX (-1 to an odd power) and returns promptly');
eq(U.exp(1n, MAX), 1n, '1 to any power is 1');

// ---- signextend ------------------------------------------------------------
group('signextend');
eq(U.signextend(0n, 0xffn), MAX, 'signextend byte 0 of 0xff fills with ones');
eq(U.signextend(0n, 0x7fn), 0x7fn, 'signextend byte 0 of 0x7f is unchanged');
eq(U.signextend(0n, 0x80n), MAX - 0x7fn, 'signextend byte 0 of 0x80 is -128');
eq(U.signextend(0n, h('ff') ), MAX, 'signextend of a single 0xff byte');
eq(U.signextend(0n, h('123456ff')), MAX, 'signextend discards everything above byte 0');
eq(U.signextend(1n, 0x80ffn), MAX - 0x7f00n, 'signextend byte 1 of 0x80ff');
eq(U.signextend(1n, 0x7fffn), 0x7fffn, 'signextend byte 1 of 0x7fff is unchanged');
eq(U.signextend(31n, MIN_S), MIN_S, 'signextend byte 31 is the identity');
eq(U.signextend(32n, 0xffn), 0xffn, 'signextend past the word is the identity');
eq(U.signextend(MAX, 0xffn), 0xffn, 'signextend with a huge index is the identity');
eq(U.signextend(0n, 0n), 0n, 'signextend of zero is zero');

// ---- comparison ------------------------------------------------------------
group('comparison');
eq(U.lt(1n, 2n), 1n, 'lt true is the word 1');
eq(U.lt(2n, 1n), 0n, 'lt false is the word 0');
eq(U.lt(0n, MAX), 1n, 'unsigned: 0 < MAX');
eq(U.gt(MAX, 0n), 1n, 'unsigned: MAX > 0');
eq(U.lt(MAX, 0n), 0n, 'unsigned: MAX is not < 0');
eq(U.slt(NEG1, 0n), 1n, 'signed: -1 < 0, where unsigned says otherwise');
eq(U.lt(NEG1, 0n), 0n, 'unsigned: the same word is not < 0');
eq(U.sgt(0n, NEG1), 1n, 'signed: 0 > -1');
eq(U.slt(MIN_S, MAX_S), 1n, 'signed: MIN_INT256 < MAX_INT256');
eq(U.sgt(MIN_S, MAX_S), 0n, 'signed: MIN_INT256 is not > MAX_INT256');
eq(U.gt(MIN_S, MAX_S), 1n, 'unsigned: the same two words compare the other way');
eq(U.slt(MIN_S, MIN_S), 0n, 'slt is strict');
eq(U.eq(MAX, MAX), 1n, 'eq true');
eq(U.eq(MAX, 0n), 0n, 'eq false');
eq(U.iszero(0n), 1n, 'iszero of 0');
eq(U.iszero(1n), 0n, 'iszero of 1');
eq(U.iszero(MAX), 0n, 'iszero of MAX');

// ---- bitwise ---------------------------------------------------------------
group('bitwise');
eq(U.and(h('f0'), h('ff')), h('f0'), 'and');
eq(U.and(MAX, 0n), 0n, 'and with zero');
eq(U.or(h('f0'), h('0f')), h('ff'), 'or');
eq(U.or(MAX, 0n), MAX, 'or with zero');
eq(U.xor(h('ff'), h('0f')), h('f0'), 'xor');
eq(U.xor(MAX, MAX), 0n, 'xor with self');
eq(U.not(0n), MAX, 'not 0 is MAX');
eq(U.not(MAX), 0n, 'not MAX is 0');
eq(U.not(U.not(h('dead'))), h('dead'), 'not is an involution');
eq(U.not(1n), MAX - 1n, 'not 1');
eq(U.byte(0n, MIN_S), 0x80n, 'byte 0 is the MOST significant byte');
eq(U.byte(31n, h('ff')), 0xffn, 'byte 31 is the least significant byte');
eq(U.byte(30n, h('ff00')), 0xffn, 'byte 30');
eq(U.byte(32n, MAX), 0n, 'byte 32 is out of range and gives 0');
eq(U.byte(MAX, MAX), 0n, 'a huge byte index gives 0');
eq(U.byte(0n, h('0f')), 0n, 'byte 0 of a small value is 0');

// ---- shl / shr / sar: the EIP-145 vectors ----------------------------------
group('shl / shr / sar (EIP-145)');
const F = 'ff'.repeat(32);
const Z = '00'.repeat(32);
const SB = '80' + '00'.repeat(31);
const HI = '7f' + 'ff'.repeat(31);
const shlVectors = [
  [Z.slice(0, 62) + '01', '00', Z.slice(0, 62) + '01'],
  [Z.slice(0, 62) + '01', '01', Z.slice(0, 62) + '02'],
  [Z.slice(0, 62) + '01', 'ff', SB],
  [Z.slice(0, 62) + '01', '0100', Z],
  [Z.slice(0, 62) + '01', '0101', Z],
  [F, '00', F],
  [F, '01', 'ff'.repeat(31) + 'fe'],
  [F, 'ff', SB],
  [F, '0100', Z],
  [Z, '01', Z],
  [HI, '01', 'ff'.repeat(31) + 'fe'],
];
const shrVectors = [
  [Z.slice(0, 62) + '01', '00', Z.slice(0, 62) + '01'],
  [Z.slice(0, 62) + '01', '01', Z],
  [SB, '01', '40' + '00'.repeat(31)],
  [SB, 'ff', Z.slice(0, 62) + '01'],
  [SB, '0100', Z],
  [SB, '0101', Z],
  [F, '00', F],
  [F, '01', HI],
  [F, 'ff', Z.slice(0, 62) + '01'],
  [F, '0100', Z],
  [Z, '01', Z],
];
const sarVectors = [
  [Z.slice(0, 62) + '01', '00', Z.slice(0, 62) + '01'],
  [Z.slice(0, 62) + '01', '01', Z],
  [SB, '01', 'c0' + '00'.repeat(31)],
  [SB, 'ff', F],
  [SB, '0100', F],
  [SB, '0101', F],
  [F, '00', F],
  [F, '01', F],
  [F, 'ff', F],
  [F, '0100', F],
  [Z, '01', Z],
  ['40' + '00'.repeat(31), 'fe', Z.slice(0, 62) + '01'],
  [HI, 'f8', Z.slice(0, 62) + '7f'],
  [HI, 'fe', Z.slice(0, 62) + '01'],
  [HI, 'ff', Z],
  [HI, '0100', Z],
];
for (const [v, s, want] of shlVectors) eq(U.shl(h(s), h(v)), h(want), `SHL 0x${v} by 0x${s}`);
for (const [v, s, want] of shrVectors) eq(U.shr(h(s), h(v)), h(want), `SHR 0x${v} by 0x${s}`);
for (const [v, s, want] of sarVectors) eq(U.sar(h(s), h(v)), h(want), `SAR 0x${v} by 0x${s}`);
// the one difference that matters: SAR sign-extends where SHR zero-fills
ok(U.sar(300n, MIN_S) === MAX && U.shr(300n, MIN_S) === 0n, 'SAR saturates a negative to all ones where SHR gives zero');
ok(U.sar(300n, MAX_S) === 0n, 'SAR of a positive past the word width is zero');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} uint256 checks`);
process.exit(fail === 0 ? 0 : 1);
