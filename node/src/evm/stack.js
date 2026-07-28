'use strict';
/* Ember EVM — the operand stack: 1024 entries, each one a 256-bit word.
 *
 * Words live as BigInts already reduced to 256 bits by uint256.js, so nothing here
 * masks anything; the stack is storage, not arithmetic. It holds BigInts rather than
 * Buffers because every consumer wants a number and converting on every push would
 * dominate the interpreter's cost.
 *
 * THE ERROR CONTRACT. Underflow and overflow are EVM exceptions, and an EVM exception
 * is a value the interpreter *returns*, never a JavaScript throw — a thrown TypeError
 * from a hot path is indistinguishable, to a conformance harness, from a correctly
 * rejected transaction. So the depth rules are enforced by `require()`, which the
 * interpreter calls once per instruction against `minStack`/`maxStack` out of
 * opcodes.js, before any pop or push happens. After that check every access in the
 * instruction is known to be in range and the accessors do no work of their own.
 *
 * `pop`/`push` past the ends therefore cannot happen from the interpreter. Should
 * some other caller manage it anyway, they record `fault` and carry on rather than
 * throwing, so the failure still arrives as an exception and not as a crash.
 *
 * DUP and SWAP index by DEPTH, one-based: DUP1 duplicates the top, SWAP1 exchanges
 * the top with the item beneath it. The off-by-one between "DUP1" and "index 0" is
 * the classic bug here, so it is spelled out in one place and nowhere else.
 */

const LIMIT = 1024;

const UNDERFLOW = 'stack underflow';
const OVERFLOW = 'stack overflow';

class Stack {
  constructor(limit = LIMIT) {
    this.limit = limit;
    this._items = [];
    this.fault = null;      // set instead of throwing; see the header
  }

  get length() { return this._items.length; }
  get size() { return this._items.length; }

  /**
   * The interpreter's whole-instruction check, run before the opcode executes.
   * `min` is the opcode's `pops`, `max` its `maxStack` (1024 + pops - pushes), so
   * one comparison each covers every access the instruction will make.
   * @returns {string|null} the exception, or null when the instruction may proceed.
   */
  require(min, max) {
    const n = this._items.length;
    if (n < min) return UNDERFLOW;
    if (n > max) return OVERFLOW;
    return null;
  }

  push(word) {
    if (this._items.length >= this.limit) { this.fault = OVERFLOW; return false; }
    this._items.push(word);
    return true;
  }

  pop() {
    if (this._items.length === 0) { this.fault = UNDERFLOW; return 0n; }
    return this._items.pop();
  }

  /** `n` words off the top, deepest first — so `popN(2)` reads as `[a, b]` for `a OP b`. */
  popN(n) {
    const out = new Array(n);
    for (let i = n - 1; i >= 0; i--) out[i] = this.pop();
    return out;
  }

  /** The item `depth` below the top; `peek(0)` is the top. Does not remove it. */
  peek(depth = 0) {
    const i = this._items.length - 1 - depth;
    if (i < 0) { this.fault = UNDERFLOW; return 0n; }
    return this._items[i];
  }

  /** Overwrite in place, `depth` from the top. Used by every unary/binary opcode. */
  poke(depth, word) {
    const i = this._items.length - 1 - depth;
    if (i < 0) { this.fault = UNDERFLOW; return false; }
    this._items[i] = word;
    return true;
  }

  /** DUPn: copy the n-th item from the top back onto the top. n is 1..16. */
  dup(n) {
    const i = this._items.length - n;
    if (i < 0) { this.fault = UNDERFLOW; return false; }
    return this.push(this._items[i]);
  }

  /** SWAPn: exchange the top with the item n below it. n is 1..16. */
  swap(n) {
    const top = this._items.length - 1;
    const other = top - n;
    if (other < 0) { this.fault = UNDERFLOW; return false; }
    const t = this._items[top];
    this._items[top] = this._items[other];
    this._items[other] = t;
    return true;
  }

  /** A copy for the tracer, bottom-first, which is the order every debugger prints. */
  snapshot() { return this._items.slice(); }

  toString() { return '[' + this._items.map((w) => '0x' + w.toString(16)).join(', ') + ']'; }
}

module.exports = { Stack, LIMIT, UNDERFLOW, OVERFLOW };
