'use strict';
/* Ember EVM — precompiled contracts 0x01 to 0x05.
 *
 * Five, self-contained. 0x06-0x09 (bn128, blake2f) are out of scope for v1 and are
 * deliberately absent rather than stubbed: a stub that returns zeros is worse than a
 * missing address, because a missing address is just an account with no code and
 * calling it succeeds trivially, which is exactly what Ethereum does for 0x0a and up.
 *
 * THE FAILURE CONVENTION, which is unlike anything else in the EVM: a precompile that
 * cannot make sense of its input does not throw and does not revert. It returns EMPTY
 * output, the CALL reports success, and the gas is consumed regardless. `ecrecover`
 * with a malformed signature is the case that matters — Solidity's `ecrecover()` maps
 * that empty return to address(0), which is why every `require(signer != address(0))`
 * in every permit implementation exists. Getting this wrong turns those checks into
 * reverts and breaks Uniswap V2's permit path.
 *
 * Each precompile exposes:
 *   gas(input) -> bigint     charged whether or not the call "succeeds"
 *   run(input) -> Buffer     the output; empty on a failure of the kind described above
 *
 * `run` is only reached once `gas` has been paid, so it may assume it is not being
 * asked to do unbounded work. modexp guards that assumption anyway.
 */

const crypto = require('crypto');

const EMPTY = Buffer.alloc(0);

/** secp256k1 group order, for the ecrecover signature-range check. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const big = (x) => (typeof x === 'bigint' ? x : BigInt(x));

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/* Precompile input is conceptually infinite and zero-filled: reading past the end of
 * the supplied calldata yields zero bytes rather than an error. Every one of the five
 * relies on this, so it is worth having exactly one implementation of it. */

/** `size` bytes starting at `offset`, zero-padded wherever the input runs out.
 *  Both arguments may be BigInt and may be absurdly large; the result is still
 *  bounded by `size`, which callers must have already bounded themselves. */
function getData(input, offset, size) {
  const sz = Number(big(size));
  const out = Buffer.alloc(sz);
  const off = big(offset);
  if (off >= BigInt(input.length)) return out;
  const start = Number(off);
  input.copy(out, 0, start, Math.min(input.length, start + sz));
  return out;
}

/** Right-pad to `len` bytes (or return the input untouched if already long enough). */
function rightPad(input, len) {
  if (input.length >= len) return input;
  const out = Buffer.alloc(len);
  input.copy(out, 0);
  return out;
}

/** Big-endian bytes to BigInt. Empty buffer is zero. */
function toBig(buf) {
  if (buf.length === 0) return 0n;
  return BigInt('0x' + buf.toString('hex'));
}

/** BigInt to a big-endian buffer of exactly `len` bytes, left-padded with zeros. */
function toBuf(v, len) {
  const out = Buffer.alloc(len);
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const b = Buffer.from(hex, 'hex');
  if (b.length > len) b.copy(out, 0, b.length - len);   // truncate high bytes
  else b.copy(out, len - b.length);
  return out;
}

/** Number of significant bits in a non-negative BigInt; 0 for zero. */
function bitLength(v) {
  if (v <= 0n) return 0n;
  return BigInt(v.toString(2).length);
}

const words = (n) => (big(n) + 31n) / 32n;

// ---------------------------------------------------------------------------
// 0x01 — ecrecover
// ---------------------------------------------------------------------------

/* Input is 128 bytes, right-padded: hash(32) | v(32) | r(32) | s(32).
 *
 * Validity, matching the reference clients exactly:
 *   - bytes 32..62 of the v word must all be zero, and byte 63 must be 27 or 28.
 *     A "high v" — anything with bits set above the last byte — fails.
 *   - r and s must each be in [1, n-1].
 *   - s is NOT required to be low. This is the trap in this function. EIP-2's low-s
 *     rule constrains TRANSACTION signatures only; it has never applied to the
 *     precompile, and go-ethereum passes homestead=false to ValidateSignatureValues
 *     here on purpose. A client that enforces low-s in ecrecover rejects signatures
 *     that are valid on Ethereum mainnet — and Uniswap V2's `permit` is exactly such
 *     a caller, so the symptom is a DEX that silently refuses valid permits.
 *
 *     node/src/crypto/secp256k1.js defaults `lowS` to true, which is right for
 *     validating transactions and wrong here, so the flag is passed explicitly below.
 *     The go-ethereum `ValidKey` vector in test/precompiles.js happens to carry a
 *     high-s signature, so it is the regression test for precisely this.
 *
 * Output is the recovered address, left-padded to 32 bytes.
 */

const ECRECOVER_GAS = 3000n;

function ecrecoverGas() { return ECRECOVER_GAS; }

function ecrecoverRun(input) {
  // Required lazily and inside the function on purpose: node/src/crypto/secp256k1.js
  // and node/src/crypto/keccak.js are built separately, and this module must load
  // (and its gas functions must be usable) before they exist.
  let recoverPublicKey, keccak256;
  try {
    ({ recoverPublicKey } = require('../crypto/secp256k1'));
    ({ keccak256 } = require('../crypto/keccak'));
  } catch (err) {
    // A missing crypto module is a build error, not a malformed signature. Do not
    // quietly return empty for it — that would turn a broken node into one that
    // silently fails every signature check.
    err.message = 'ecrecover: ' + err.message;
    throw err;
  }

  const d = rightPad(input, 128);

  for (let i = 32; i < 63; i++) if (d[i] !== 0) return EMPTY;
  const v = d[63];
  if (v !== 27 && v !== 28) return EMPTY;

  const r = toBig(d.subarray(64, 96));
  const s = toBig(d.subarray(96, 128));
  if (r === 0n || r >= SECP256K1_N) return EMPTY;
  if (s === 0n || s >= SECP256K1_N) return EMPTY;

  const msgHash = Buffer.from(d.subarray(0, 32));

  let pub;
  try {
    // { lowS: false } is load-bearing, not decoration — see the note above.
    pub = recoverPublicKey(msgHash, { r, s, recoveryId: v - 27 }, { lowS: false });
  } catch {
    // A point that does not recover is a normal, expected outcome for garbage input.
    return EMPTY;
  }
  if (!pub) return EMPTY;

  // Accept either the 65-byte SEC1 uncompressed form (0x04 || X || Y) or the bare
  // 64-byte X || Y. The address is keccak256 of the 64 coordinate bytes.
  let xy = Buffer.from(pub);
  if (xy.length === 65 && xy[0] === 0x04) xy = xy.subarray(1);
  if (xy.length !== 64) return EMPTY;

  const digest = Buffer.from(keccak256(xy));
  if (digest.length !== 32) return EMPTY;

  const out = Buffer.alloc(32);
  digest.copy(out, 12, 12, 32);          // last 20 bytes, left-padded into 32
  return out;
}

// ---------------------------------------------------------------------------
// 0x02 — sha256
// ---------------------------------------------------------------------------

function sha256Gas(input) { return 60n + 12n * words(input.length); }
function sha256Run(input) { return crypto.createHash('sha256').update(input).digest(); }

// ---------------------------------------------------------------------------
// 0x03 — ripemd160
// ---------------------------------------------------------------------------

/* RIPEMD-160 produces 20 bytes; the precompile left-pads them into a 32-byte word.
 * Node's OpenSSL binding provides it, though newer OpenSSL builds move it to the
 * legacy provider — if `createHash('ripemd160')` throws, that is an environment
 * problem and should be loud, not silently an empty return. */

function ripemd160Gas(input) { return 600n + 120n * words(input.length); }
function ripemd160Run(input) {
  const digest = crypto.createHash('ripemd160').update(input).digest();
  const out = Buffer.alloc(32);
  digest.copy(out, 12);
  return out;
}

// ---------------------------------------------------------------------------
// 0x04 — identity (datacopy)
// ---------------------------------------------------------------------------

function identityGas(input) { return 15n + 3n * words(input.length); }
function identityRun(input) { return Buffer.from(input); }

// ---------------------------------------------------------------------------
// 0x05 — modexp (EIP-198 semantics, EIP-2565 pricing)
// ---------------------------------------------------------------------------

/* Input: baseLen(32) | expLen(32) | modLen(32) | base | exp | mod, all big-endian,
 * everything past the end read as zero. Output is exactly modLen bytes.
 *
 * EIP-2565 gas:
 *     multiplication_complexity = ceil(max(baseLen, modLen) / 8) ^ 2
 *     iteration_count           = max(adjusted_exponent_length, 1)
 *     gas                       = max(200, complexity * iteration_count / 3)
 *
 * where the adjusted exponent length uses the HIGH 32 bytes of the exponent:
 *     expLen <= 32 : bitlen(exp) - 1
 *     expLen  > 32 : 8 * (expLen - 32) + bitlen(first 32 bytes of exp) - 1
 *
 * The EIP's own pseudocode writes that second case as `exponent & (2**256 - 1)`,
 * which reads as the LOW 256 bits and is the opposite of what every client does.
 * EIP-198 is unambiguous — "the first 32 bytes" — and go-ethereum reads the head.
 * The head is what is implemented here.
 */

/* An input this large cannot be reached: the gas for it exceeds any block gas limit
 * by many orders of magnitude, so `run` is never called. The guard exists so that a
 * caller which forgets to charge gas gets an exception instead of an allocation that
 * takes the node down. */
const MODEXP_MAX_LEN = 1n << 24n;   // 16 MiB per field

function modexpLengths(input) {
  return {
    baseLen: toBig(getData(input, 0, 32)),
    expLen: toBig(getData(input, 32, 32)),
    modLen: toBig(getData(input, 64, 32)),
    body: input.length > 96 ? input.subarray(96) : EMPTY,
  };
}

function modexpGas(input) {
  const { baseLen, expLen, modLen, body } = modexpLengths(input);

  // The head 32 bytes of the exponent, or zero when the input does not reach them.
  let expHead = 0n;
  if (BigInt(body.length) > baseLen) {
    const take = expLen > 32n ? 32n : expLen;
    if (take > 0n) expHead = toBig(getData(body, baseLen, take));
  }

  const msb = expHead > 0n ? bitLength(expHead) - 1n : 0n;
  let adjExpLen = expLen > 32n ? 8n * (expLen - 32n) : 0n;
  adjExpLen += msb;

  const maxLen = baseLen > modLen ? baseLen : modLen;
  const complexityWords = (maxLen + 7n) / 8n;
  const complexity = complexityWords * complexityWords;

  const iterations = adjExpLen > 1n ? adjExpLen : 1n;
  const gas = (complexity * iterations) / 3n;
  return gas < 200n ? 200n : gas;
}

/** Square-and-multiply. `exp` may be very large, but its size is what was paid for. */
function modPow(base, exp, mod) {
  if (mod === 0n) return 0n;
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    if (e > 0n) b = (b * b) % mod;
  }
  return result;
}

function modexpRun(input) {
  const { baseLen, expLen, modLen, body } = modexpLengths(input);

  // A zero-length modulus returns zero bytes. Not an error, not a 32-byte zero.
  if (modLen === 0n) return EMPTY;

  if (baseLen > MODEXP_MAX_LEN || expLen > MODEXP_MAX_LEN || modLen > MODEXP_MAX_LEN) {
    throw new RangeError('modexp: operand exceeds the sane bound; gas was not charged');
  }

  const base = toBig(getData(body, 0n, baseLen));
  const exp = toBig(getData(body, baseLen, expLen));
  const mod = toBig(getData(body, baseLen + expLen, modLen));

  // x mod 0 is defined as 0 here, per EIP-198.
  const result = mod === 0n ? 0n : modPow(base, exp, mod);
  return toBuf(result, Number(modLen));
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/* Calldata reaches here as whatever the interpreter's memory happens to hand over.
 * Normalising once at the boundary means none of the five has to care whether it was
 * given a Buffer, a Uint8Array or nothing at all. */
const wrap = (fn) => (input) => fn(Buffer.isBuffer(input) ? input : Buffer.from(input || []));

const entry = (address, name, gas, run) =>
  Object.freeze({ address, name, gas: wrap(gas), run: wrap(run) });

const PRECOMPILES = Object.freeze({
  1: entry(1, 'ecrecover', ecrecoverGas, ecrecoverRun),
  2: entry(2, 'sha256', sha256Gas, sha256Run),
  3: entry(3, 'ripemd160', ripemd160Gas, ripemd160Run),
  4: entry(4, 'identity', identityGas, identityRun),
  5: entry(5, 'modexp', modexpGas, modexpRun),
});

const LOWEST = 1;
const HIGHEST = 5;

/**
 * Normalise an address to its precompile index, or null.
 *
 * Accepts a 20-byte Buffer or a hex string with or without the 0x prefix. An address
 * is a precompile only if its first 19 bytes are zero and the last is 1..5 — checking
 * only the last byte would make 0x...0101 a precompile, which it is not.
 */
function precompileIndex(address) {
  let buf;
  if (Buffer.isBuffer(address)) {
    buf = address;
  } else if (typeof address === 'string') {
    const hex = address.startsWith('0x') || address.startsWith('0X') ? address.slice(2) : address;
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
    buf = Buffer.from(hex, 'hex');
  } else if (typeof address === 'number' || typeof address === 'bigint') {
    const n = Number(address);
    return n >= LOWEST && n <= HIGHEST && Number.isInteger(n) ? n : null;
  } else {
    return null;
  }
  if (buf.length !== 20) return null;
  for (let i = 0; i < 19; i++) if (buf[i] !== 0) return null;
  const idx = buf[19];
  return idx >= LOWEST && idx <= HIGHEST ? idx : null;
}

/** The precompile at an address, or null if the address is an ordinary account. */
function precompileAt(address) {
  const idx = precompileIndex(address);
  return idx === null ? null : PRECOMPILES[idx];
}

/** Whether an address is one of the five. */
function isPrecompile(address) { return precompileIndex(address) !== null; }

module.exports = {
  PRECOMPILES,
  precompileAt,
  precompileIndex,
  isPrecompile,
  SECP256K1_N,
  MODEXP_MAX_LEN,
  // exported for tests and for reuse by the interpreter's own zero-padded reads
  getData,
  modPow,
};
