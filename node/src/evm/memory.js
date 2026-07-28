'use strict';
/* Ember EVM — frame-local memory: byte-addressed, word-expanded, zero-filled.
 *
 * Three rules carry all the weight, and each of them is a consensus bug when missed:
 *
 *   1. Memory only ever GROWS, in 32-byte words, and MSIZE reports that high-water
 *      mark rounded up to a word. A read below the mark is free; a read above it
 *      expands memory even though it returns nothing but zeros.
 *   2. Expansion gas is quadratic in the TOTAL size and charged on the INCREASE:
 *      C(new) - C(old), never C(new - old). gas.js owns that arithmetic; this file
 *      only reports the word counts it needs, so the two cannot drift.
 *   3. A zero-length access never expands memory, however absurd its offset. That is
 *      a real rule and not a shortcut — `CALL`s with no return buffer and `LOG0`s
 *      with no data both depend on it.
 *
 * Reads past the end return zeros rather than failing, which is why the interpreter
 * can hand a 32-byte MLOAD straight to uint256 without a bounds branch.
 *
 * `charge()` is the only entry point the interpreter uses to grow memory: it returns
 * the gas owed and does NOT commit the growth, because gas has to be affordable before
 * a single byte is allocated. Otherwise a 2^200-byte offset allocates before it fails.
 */

const gas = require('./gas');

const WORD = 32;
/* Grow the backing buffer in 4 KiB steps. Memory is charged quadratically, so it can
 * never get large enough for the copying to matter; this only avoids reallocating on
 * every MSTORE in a loop. */
const CHUNK = 4096;

const big = (x) => (typeof x === 'bigint' ? x : BigInt(x));

class Memory {
  constructor() {
    this._buf = Buffer.alloc(0);
    this._size = 0;        // the word-aligned high-water mark, in bytes
  }

  /** MSIZE: the high-water mark, always a multiple of 32. */
  get size() { return this._size; }
  /** The same figure in words, which is what the gas schedule is defined over. */
  get words() { return BigInt(this._size / WORD); }

  /**
   * Gas owed to touch `[offset, offset+size)`, without growing anything yet.
   * Both arguments are BigInts straight off the stack and may be enormous; the
   * arithmetic is BigInt throughout so the answer is simply an unaffordable number
   * rather than a wrapped one.
   * @returns {bigint}
   */
  charge(offset, size) {
    return gas.memoryExpansionForRange(this.words, big(offset), big(size));
  }

  /** Gas owed to touch two ranges at once — the CALL family's args and return area. */
  charge2(offA, sizeA, offB, sizeB) {
    const want = this._maxWords(this._maxWords(this.words, offA, sizeA), offB, sizeB);
    return gas.memoryExpansionCost(this.words, want);
  }

  _maxWords(current, offset, size) {
    if (big(size) === 0n) return current;
    const need = gas.wordCount(big(offset) + big(size));
    return need > current ? need : current;
  }

  /**
   * Commit the growth `charge()` priced. Only called once the gas has been paid, so
   * the size is known to be bounded by the block gas limit (30M gas is about 4 MiB).
   */
  expand(offset, size) {
    if (big(size) === 0n) return;
    const end = Number(gas.wordCount(big(offset) + big(size)) * 32n);
    if (end <= this._size) return;
    if (end > this._buf.length) {
      const grown = Buffer.alloc(Math.ceil(end / CHUNK) * CHUNK);
      this._buf.copy(grown, 0, 0, this._size);
      this._buf = grown;
    } else {
      // Bytes between the old mark and the new one must read as zero even if a
      // previous, reverted frame left something there.
      this._buf.fill(0, this._size, end);
    }
    this._size = end;
  }

  /** `size` bytes from `offset`, zero-filled wherever they fall past the high mark. */
  read(offset, size) {
    const sz = Number(big(size));
    const out = Buffer.alloc(sz);
    if (sz === 0) return out;
    const off = Number(big(offset));
    if (off < this._size) this._buf.copy(out, 0, off, Math.min(this._size, off + sz));
    return out;
  }

  /** A 32-byte word at `offset`, for MLOAD. */
  readWord(offset) { return this.read(offset, 32); }

  /** Write `bytes` at `offset`. The caller has already expanded and paid for it. */
  write(offset, bytes) {
    if (bytes.length === 0) return;
    bytes.copy(this._buf, Number(big(offset)));
  }

  /** MSTORE8, and the one place a single byte is written. */
  writeByte(offset, value) {
    this._buf[Number(big(offset))] = Number(value) & 0xff;
  }

  /**
   * Write `bytes` into `[offset, offset+size)`, zero-padding when the source is
   * shorter. Every *COPY opcode has these semantics, including the case where the
   * source offset is past the end of the source entirely.
   */
  writePadded(offset, bytes, size) {
    const sz = Number(big(size));
    if (sz === 0) return;
    const off = Number(big(offset));
    const n = Math.min(bytes.length, sz);
    if (n > 0) bytes.copy(this._buf, off, 0, n);
    if (n < sz) this._buf.fill(0, off + n, off + sz);
  }

  /** The live contents, for tracing. A copy: the tracer must not alias memory. */
  dump() { return Buffer.from(this._buf.subarray(0, this._size)); }
}

module.exports = { Memory, WORD };
