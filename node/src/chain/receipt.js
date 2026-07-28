'use strict';
/* Receipts — what a transaction leaves behind, and what the header commits to.
 *
 *     [status, cumulativeGasUsed, logsBloom, logs]
 *     log = [address, [topic, …], data]
 *
 * `status` is POST-BYZANTIUM: 1 for success, 0 for failure. Before EIP-658 the
 * first field was the intermediate state root, which forced every client to
 * compute a full state root per transaction; the flag replaced it and Hearth
 * starts after that change, so a root here would be simply wrong. Note that
 * "failure" means the transaction reverted or ran out of gas — it still has a
 * receipt, it still paid for its gas, and it still occupies its index.
 *
 * `cumulativeGasUsed` is the running total for the BLOCK, not this
 * transaction's own gas. A per-transaction figure is a plausible-looking value
 * that produces a wrong receiptsRoot on every block with more than one
 * transaction; the last receipt's cumulative figure must equal the header's
 * `gasUsed`. Callers wanting the individual cost subtract the previous receipt.
 *
 * THE RECEIPTS TRIE IS THE NON-SECURE VARIANT, KEYED BY `rlp(index)`. The state
 * and storage tries hash their keys (so an attacker cannot craft a deep path);
 * the transaction and receipt tries do not, because their keys are already
 * small dense integers under our control. Using the secure variant here
 * produces a root that is wrong and stays wrong, silently, since every read
 * still works. Note also that index 0 encodes as `0x80` (RLP's empty string),
 * not as `0x00` — the same scalar-canonicality rule that governs everything
 * else in this layer.
 */

const { keccak256 } = require('../crypto/keccak');
const RLP = require('../crypto/rlp');
const { Trie, MemoryDB, EMPTY_TRIE_ROOT } = require('../state/trie');
const bloom = require('./bloom');

const SUCCESS = 1;
const FAILURE = 0;

// ---- coercions -------------------------------------------------------------

function toBuf(v, what) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    const h = v.replace(/^0x/i, '');
    if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new TypeError(`receipt: malformed hex ${what}`);
    return Buffer.from(h, 'hex');
  }
  throw new TypeError(`receipt: ${what} must be bytes or 0x-hex`);
}

function big(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  if (Buffer.isBuffer(v)) return v.length ? BigInt('0x' + v.toString('hex')) : 0n;
  if (v === null || v === undefined) return 0n;
  throw new TypeError('receipt: cannot read a quantity from ' + typeof v);
}

function toAddress(v) {
  const b = toBuf(v, 'log address');
  if (b.length !== 20) throw new Error('receipt: a log address must be 20 bytes');
  return b;
}

function toTopic(v) {
  const b = toBuf(v, 'topic');
  if (b.length !== 32) throw new Error('receipt: a topic must be 32 bytes');
  return b;
}

// ---- logs ------------------------------------------------------------------

/** `{ address, topics, data }` with Buffers throughout. At most four topics —
 *  LOG0…LOG4 is the whole instruction family, so a fifth cannot be produced. */
function normalizeLog(log) {
  const topics = (log.topics || []).map(toTopic);
  if (topics.length > 4) throw new Error('receipt: a log has at most 4 topics');
  return { address: toAddress(log.address), topics, data: toBuf(log.data, 'log data') };
}

function logFields(log) { return [log.address, log.topics, log.data]; }

/**
 * keccak256(rlp(logs)) — how VMTests and GeneralStateTests publish the expected
 * logs, so the state transition can be checked against the vectors without
 * their having to agree on log ordering or JSON shape.
 */
function logsHash(logs) {
  return keccak256(RLP.encode((logs || []).map(l => logFields(normalizeLog(l)))));
}

// ---- receipts --------------------------------------------------------------

/**
 * `{ status, cumulativeGasUsed, logsBloom, logs }`. The bloom is derived from
 * the logs when it is not supplied — deriving it is the only way it can be
 * right, and a caller passing one in is asserting it already agrees.
 */
function normalize(receipt) {
  const logs = (receipt.logs || []).map(normalizeLog);
  const status = Number(big(receipt.status === undefined ? SUCCESS : receipt.status));
  if (status !== SUCCESS && status !== FAILURE) throw new Error('receipt: status is 1 or 0 (post-Byzantium; it is not a state root)');
  return {
    status,
    cumulativeGasUsed: big(receipt.cumulativeGasUsed),
    logsBloom: receipt.logsBloom ? bloom.toBloom(receipt.logsBloom, 'logsBloom') : bloom.fromLogs(logs),
    logs,
  };
}

function fields(r) {
  return [BigInt(r.status), r.cumulativeGasUsed, r.logsBloom, r.logs.map(logFields)];
}

/* Always through `normalize`, never a fast path for an object that merely
 * looks normalised. A half-coerced receipt — Buffer bloom, hex logs — would
 * encode without complaint and produce a wrong root, and the saving would be
 * microseconds on a path that already hashes 256 bytes per receipt. */
function encode(receipt) {
  return RLP.encode(fields(normalize(receipt)));
}

/* The same scalar rule as the transaction decoder, for the same reason: RLP
 * cannot know `status` is a number, so `0x00` would be a second encoding of a
 * failed receipt and a second receiptsRoot for the same block (spec §5). */
function scalar(raw, what) {
  if (!Buffer.isBuffer(raw)) throw new Error(`receipt: ${what} is a list, not a scalar`);
  if (raw.length > 0 && raw[0] === 0) throw new Error(`receipt: ${what} has a leading zero byte — the canonical encoding of zero is empty`);
  return raw.length === 0 ? 0n : BigInt('0x' + raw.toString('hex'));
}

function decode(raw) {
  const items = RLP.decode(toBuf(raw, 'receipt'));
  if (!Array.isArray(items) || items.length !== 4) throw new Error('receipt: a receipt is a 4-item list');
  const [status, cumulative, logsBloom, logs] = items;
  const st = scalar(status, 'status');
  if (st !== 0n && st !== 1n) throw new Error('receipt: status is 1 or 0');
  if (!Array.isArray(logs)) throw new Error('receipt: logs is a list');
  return {
    status: Number(st),
    cumulativeGasUsed: scalar(cumulative, 'cumulativeGasUsed'),
    logsBloom: bloom.toBloom(logsBloom, 'logsBloom'),
    logs: logs.map((l) => {
      if (!Array.isArray(l) || l.length !== 3) throw new Error('receipt: a log is [address, topics, data]');
      if (!Array.isArray(l[1])) throw new Error('receipt: topics is a list');
      return normalizeLog({ address: l[0], topics: l[1], data: l[2] });
    }),
  };
}

// ---- the trie root ---------------------------------------------------------

/**
 * A trie root over a list, keyed by `rlp(index)`. Non-secure — see the header.
 * Exported in its general form because `txRoot` is the identical construction
 * over encoded transactions, and having two copies of it is how the two roots
 * come to disagree.
 */
function trieRoot(encodedItems) {
  const t = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
  encodedItems.forEach((enc, i) => t.put(RLP.encode(i), enc));
  return t.root();
}

/** The header's `receiptsRoot`. */
function receiptsRoot(receipts) {
  return trieRoot(receipts.map(encode));
}

/** The block's `logsBloom`: the OR of every receipt's. */
function receiptsBloom(receipts) {
  return bloom.or(...receipts.map(r => (r.logsBloom ? bloom.toBloom(r.logsBloom, 'logsBloom') : bloom.fromLogs(r.logs))));
}

module.exports = {
  SUCCESS, FAILURE,
  normalize, normalizeLog, fields, logFields, logsHash,
  encode, decode,
  trieRoot, receiptsRoot, receiptsBloom,
};
