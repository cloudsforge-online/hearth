'use strict';
/* The logs bloom — a 2048-bit filter over every log address and topic.
 *
 * It exists so that `eth_getLogs` can skip a block without reading its
 * receipts: a bloom can say "definitely not here" and nothing else. Every
 * indexer, every subgraph and every wallet's transaction history is built on
 * that one negative answer, and the header commits to it, so it is consensus.
 *
 * THE FAILURE MODE IS SILENCE. A bloom with a bit in the wrong place still
 * encodes to 256 bytes, still ORs, still round-trips, and still answers "no"
 * to every query — so logs simply never match and nothing anywhere throws. It
 * cannot be caught by an assertion at the call site; it can only be caught by
 * comparing against real blooms produced by other clients, which is what
 * test/bloom.js does.
 *
 * The construction (yellow paper's M3:2048) is three bits per item:
 *
 *     h = keccak256(item)
 *     for i in 0, 2, 4:   bit = ((h[i] << 8) | h[i+1]) & 0x7ff
 *
 * Four things in that are easy to get wrong and each is fatal:
 *   - THREE bits, from the first three 16-bit pairs. Not two, not four.
 *   - The pairs are BIG-endian; reading them little-endian gives a different,
 *     perfectly plausible-looking filter.
 *   - The mask is 11 bits (0x7ff), because 2^11 = 2048.
 *   - Bit `b` is numbered from the LEAST significant end of the 2048-bit
 *     big-endian number, so it lives in byte `255 - (b >> 3)` at mask
 *     `1 << (b & 7)`. Numbering from the other end mirrors the whole filter.
 *
 * An item is a log's address (20 bytes) or one of its topics (32 bytes), and
 * both are hashed as raw bytes — the bloom knows nothing about which is which.
 */

const { keccak256 } = require('../crypto/keccak');

/** 2048 bits. The header field, and every receipt, is exactly this wide. */
const BLOOM_BYTES = 256;
const BLOOM_BITS = BLOOM_BYTES * 8;

function empty() { return Buffer.alloc(BLOOM_BYTES); }

/** Accept a Buffer or `0x…` hex, and insist on the exact width. */
function toBloom(b, what = 'bloom') {
  const v = Buffer.isBuffer(b) ? b
    : typeof b === 'string' ? Buffer.from(b.replace(/^0x/i, ''), 'hex')
      : null;
  if (!v || v.length !== BLOOM_BYTES) throw new TypeError(`bloom: ${what} must be ${BLOOM_BYTES} bytes`);
  return v;
}

function toItem(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v.replace(/^0x/i, ''), 'hex');
  throw new TypeError('bloom: an item must be bytes or 0x-hex');
}

/**
 * The three bit positions an item sets, in [0, 2048). Exported because the
 * only way to pin the byte order and the mask is to assert on the indices
 * themselves; asserting on the resulting filter hides which of the four rules
 * above was broken.
 */
function bitsFor(item) {
  const h = keccak256(toItem(item));
  return [
    ((h[0] << 8) | h[1]) & 0x7ff,
    ((h[2] << 8) | h[3]) & 0x7ff,
    ((h[4] << 8) | h[5]) & 0x7ff,
  ];
}

/** Set `item`'s three bits in `bloom`, in place. Returns the same buffer. */
function add(bloom, item) {
  const b = toBloom(bloom);
  for (const bit of bitsFor(item)) b[BLOOM_BYTES - 1 - (bit >> 3)] |= 1 << (bit & 7);
  return b;
}

/** True when every one of `item`'s bits is set — i.e. it MAY be present. */
function contains(bloom, item) {
  const b = toBloom(bloom);
  for (const bit of bitsFor(item)) {
    if ((b[BLOOM_BYTES - 1 - (bit >> 3)] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/** OR any number of blooms into a new one — how a block aggregates receipts. */
function or(...blooms) {
  const out = empty();
  for (const bl of blooms) {
    const b = toBloom(bl);
    for (let i = 0; i < BLOOM_BYTES; i++) out[i] |= b[i];
  }
  return out;
}

/** A log is `{ address, topics }`; its data is deliberately NOT indexed. */
function addLog(bloom, log) {
  const b = toBloom(bloom);
  add(b, log.address);
  for (const t of log.topics || []) add(b, t);
  return b;
}

function fromLogs(logs) {
  const b = empty();
  for (const log of logs || []) addLog(b, log);
  return b;
}

/** A block's bloom is the OR of its receipts', which is also the OR of every
 *  log in the block — the two definitions must agree, and test/bloom.js checks
 *  that they do against a real header. */
function fromReceipts(receipts) {
  return or(...(receipts || []).map(r => (r.logsBloom !== undefined ? r.logsBloom : fromLogs(r.logs))));
}

/* `eth_getLogs` criteria: `address` is absent, one address, or a list meaning
 * "any of these"; `topics` is positional, and each position is absent (any
 * value), one topic, or a list meaning "any of these". A bloom cannot confirm
 * a match — the bits of two unrelated logs can combine into the bits of a
 * third — so this answers only "is it worth opening this block". Erring
 * towards true is a wasted read; erring towards false loses logs forever. */
function anyOf(bloom, v) {
  if (v === null || v === undefined) return true;
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0) return true;
  return list.some(x => x === null || x === undefined || contains(bloom, x));
}

/** True when this bloom cannot rule the filter out. */
function matches(bloom, { address = null, topics = [] } = {}) {
  const b = toBloom(bloom);
  if (!anyOf(b, address)) return false;
  for (const t of topics || []) if (!anyOf(b, t)) return false;
  return true;
}

function toHex(bloom) { return '0x' + toBloom(bloom).toString('hex'); }

module.exports = {
  BLOOM_BYTES, BLOOM_BITS,
  empty, bitsFor, add, contains, or,
  addLog, fromLogs, fromReceipts,
  matches, toBloom, toHex,
};
