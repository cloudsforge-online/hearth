'use strict';
/* ============================================================================
 * THE INDEX. Two append-only fixed-width files plus one in-memory map.
 * ============================================================================
 *
 * WHY NOT POSTGRES, WHICH IS WHAT THE REST OF THE ESTATE USES
 *
 * Because this process has to be able to run on the same box as a node with
 * nothing installed, and because a wrong storage choice here gets expensive
 * once the chain has history. Three things decided it:
 *
 *   1. ZERO DEPENDENCIES IS A HARD CONSTRAINT in this repository — the node,
 *      the faucet and the RPC layer all hold to it. There is no pure-Node
 *      Postgres driver in the standard library, so "use Postgres" means either
 *      an npm dependency tree or hand-writing the v3 wire protocol. The first
 *      breaks the rule; the second is more novel code than the index itself.
 *
 *   2. THE WORKLOAD IS AN INVERTED INDEX, NOT A RELATION. Every query is
 *      "postings for this key, in block order, paged". That is exactly what an
 *      append-only posting list is, and it is what a relational engine would
 *      build underneath a B-tree anyway. There are no joins, no ad-hoc
 *      predicates and no transactions spanning more than one block.
 *
 *   3. REORGS ARE A TRUNCATION. Postings are appended in strict block order,
 *      so unwinding block N is `ftruncate` to the offset recorded for N-1 —
 *      atomic, O(reorg depth), and impossible to get half-done. In a table you
 *      would be issuing a DELETE over an index whose write amplification is
 *      worst exactly when you most need it to be quick.
 *
 * WHAT IS NOT STORED, AND WHY. The index holds POSTINGS ONLY — (key, block,
 * txIndex, subIndex, kind) — 48 bytes each. It does not copy transactions,
 * receipts or logs. Rows are hydrated from the node when a query asks for them.
 *
 *   - It keeps the index small: ~48 bytes per participation, so a year of
 *     ten-transaction blocks is a few hundred MB rather than tens of GB.
 *   - Every Hearth node is an archive node and nothing prunes
 *     (docs/exchange-integration.md §3), so the source rows are always there.
 *   - It makes it impossible for the index to disagree with the chain about
 *     the CONTENT of a transaction. It can only be wrong about which
 *     transactions exist — which is the one thing it is responsible for and
 *     the one thing the reorg logic guards.
 *
 * THE CEILING, STATED RATHER THAN DISCOVERED. The address → ordinals map is in
 * memory: ~4 bytes per posting plus ~100 bytes per distinct key. A chain with
 * 20 M postings across 1 M addresses is roughly 180 MB resident. Past a few
 * hundred million postings this wants a disk-resident hash index or Postgres,
 * and the migration is mechanical because everything above this file talks
 * through `scan()`. The README says the same thing where an operator will read
 * it.
 *
 * CRASH SAFETY. Postings are written first, then the chain record that names
 * the postings offset. The chain record is therefore the commit marker: a
 * crash between the two leaves orphan postings, and `open()` truncates them.
 * A torn write leaves a partial record, and `open()` truncates that too. There
 * is no state in which the index serves a block it did not finish writing.
 */

const fs = require('fs');
const path = require('path');

const FORMAT_VERSION = 1;

// ---- record layouts --------------------------------------------------------

const CHAIN_REC = 96;
//   0 u32  number         4 u32  txCount        8 [32] hash
//  40 [32] parentHash    72 u64  timestamp     80 u64  postingsEnd
//  88 u32  logCount      92 u32  reserved

const POST_REC = 48;
//   0 [32] key (left-aligned, zero-padded)     32 u32 block
//  36 u16  txIndex       38 u16 subIndex       40 u8  kind
//  41 u8   flags         42 u8  keyLen         43 u8  reserved (+4 tail)

/** Posting kinds. Stable on disk — never renumber, only append. */
const KIND = Object.freeze({
  TX: 1,        // a top-level transaction, keyed by from and by to
  INTERNAL: 2,  // a value-bearing internal call, keyed by from and by to
  TOKEN: 3,     // an ERC-20/721 Transfer participant
  LOG: 4,       // a log, keyed by the emitting contract
  TOPIC: 5,     // a log, keyed by topic0
});

/** Posting flags. */
const FLAG = Object.freeze({
  FROM: 1 << 0,
  TO: 1 << 1,
  CREATE: 1 << 2,   // `to` is a contract this transaction created
  NFT: 1 << 3,      // the Transfer had an indexed tokenId — ERC-721, not ERC-20
});

const NO_SUB = 0xffff;

/** A posting whose subIndex is not a log index. */
function keyHexOf(buf, len) {
  return buf.toString('hex', 0, len);
}

/** Growable sorted list of ordinals. Int32Array to keep 20 M of them at 80 MB. */
class Ordinals {
  constructor() {
    this.a = new Int32Array(4);
    this.n = 0;
  }

  push(ord) {
    if (this.n === this.a.length) {
      const next = new Int32Array(this.a.length * 2);
      next.set(this.a);
      this.a = next;
    }
    this.a[this.n++] = ord;
  }

  /** Index of the first ordinal >= v. The list is ascending by construction. */
  lowerBound(v) {
    let lo = 0, hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.a[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  truncateFrom(ord) {
    this.n = this.lowerBound(ord);
  }
}

class Store {
  /**
   * @param {object} o
   * @param {string} o.dir
   * @param {number} o.chainId
   * @param {number} o.startBlock
   */
  constructor(o) {
    this.dir = o.dir;
    this.chainId = o.chainId;
    this.startBlock = o.startBlock >>> 0;
    this.syncEvery = o.syncEvery || 256;
    /** @type {Map<string, Ordinals>} */
    this.index = new Map();
    this.chainCount = 0;      // number of indexed blocks
    this.postCount = 0;       // number of postings
    this.sinceSync = 0;
    this.opened = false;
  }

  // ---- lifecycle -----------------------------------------------------------

  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const manifestPath = path.join(this.dir, 'manifest.json');
    const want = {
      format: FORMAT_VERSION,
      chainId: this.chainId,
      startBlock: this.startBlock,
      chainRecordBytes: CHAIN_REC,
      postingRecordBytes: POST_REC,
    };
    if (fs.existsSync(manifestPath)) {
      const got = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const k of Object.keys(want)) {
        if (got[k] !== want[k]) {
          /* Refuse rather than reinterpret. An index built against another
           * chain id, or another record layout, decodes into plausible
           * nonsense — which is worse than not starting. */
          throw new Error(
            `index at ${this.dir} was built with ${k}=${got[k]}, this process wants ${want[k]}.\n`
            + '  The index is disposable: delete the directory and it will rebuild from the node.',
          );
        }
      }
    } else {
      fs.writeFileSync(manifestPath, JSON.stringify(want, null, 2) + '\n');
    }

    this.chainPath = path.join(this.dir, 'chain.idx');
    this.postPath = path.join(this.dir, 'postings.idx');
    for (const p of [this.chainPath, this.postPath]) {
      if (!fs.existsSync(p)) fs.closeSync(fs.openSync(p, 'w'));
    }
    this.chainFd = fs.openSync(this.chainPath, 'r+');
    this.postFd = fs.openSync(this.postPath, 'r+');

    this._repair();
    this._replay();
    this.opened = true;
    return this;
  }

  close() {
    if (!this.opened) return;
    try { fs.fsyncSync(this.postFd); fs.fsyncSync(this.chainFd); } catch { /* closing anyway */ }
    fs.closeSync(this.chainFd);
    fs.closeSync(this.postFd);
    this.opened = false;
  }

  /**
   * Bring both files to a consistent state. Runs before anything is read.
   *
   * Order matters and is the inverse of the write order: whole records first,
   * then chain records that name postings we do not have, then postings past
   * the last committed block.
   */
  _repair() {
    let chainSize = fs.fstatSync(this.chainFd).size;
    let postSize = fs.fstatSync(this.postFd).size;

    const chainTorn = chainSize % CHAIN_REC;
    if (chainTorn) { chainSize -= chainTorn; fs.ftruncateSync(this.chainFd, chainSize); }
    const postTorn = postSize % POST_REC;
    if (postTorn) { postSize -= postTorn; fs.ftruncateSync(this.postFd, postSize); }

    let count = chainSize / CHAIN_REC;
    const rec = Buffer.alloc(CHAIN_REC);
    // Drop trailing chain records that point past the postings we actually
    // have. Only possible if a postings write was torn; cheap to check.
    while (count > 0) {
      fs.readSync(this.chainFd, rec, 0, CHAIN_REC, (count - 1) * CHAIN_REC);
      if (Number(rec.readBigUInt64LE(80)) <= postSize) break;
      count--;
    }
    if (count * CHAIN_REC !== chainSize) fs.ftruncateSync(this.chainFd, count * CHAIN_REC);

    // Drop postings belonging to a block whose chain record never committed.
    let committed = 0;
    if (count > 0) {
      fs.readSync(this.chainFd, rec, 0, CHAIN_REC, (count - 1) * CHAIN_REC);
      committed = Number(rec.readBigUInt64LE(80));
    }
    if (committed !== postSize) fs.ftruncateSync(this.postFd, committed);

    this.chainCount = count;
    this.postCount = committed / POST_REC;
    this.repaired = { chainTorn: chainTorn > 0, postTorn: postTorn > 0, droppedPostings: (postSize - committed) / POST_REC };
  }

  /** Rebuild the in-memory map by streaming the postings file. */
  _replay() {
    this.index.clear();
    const CHUNK = 1 << 20;                       // 1 MiB, ~21,845 records
    const buf = Buffer.alloc(CHUNK - (CHUNK % POST_REC));
    let ord = 0, offset = 0;
    const total = this.postCount * POST_REC;
    while (offset < total) {
      const want = Math.min(buf.length, total - offset);
      const read = fs.readSync(this.postFd, buf, 0, want, offset);
      if (read <= 0) break;
      const usable = read - (read % POST_REC);
      for (let p = 0; p < usable; p += POST_REC) {
        const keyLen = buf[p + 42];
        const key = buf.toString('hex', p, p + keyLen);
        let list = this.index.get(key);
        if (!list) { list = new Ordinals(); this.index.set(key, list); }
        list.push(ord++);
      }
      offset += usable;
    }
  }

  // ---- chain view ----------------------------------------------------------

  get headNumber() {
    return this.chainCount === 0 ? null : this.startBlock + this.chainCount - 1;
  }

  /** The block this index would ask a node for next. */
  get nextNumber() {
    return this.chainCount === 0 ? this.startBlock : this.startBlock + this.chainCount;
  }

  /** @returns {{number:number, hash:string, parentHash:string, timestamp:number, txCount:number, logCount:number, postingsEnd:number}|null} */
  blockAt(number) {
    const i = number - this.startBlock;
    if (i < 0 || i >= this.chainCount) return null;
    const rec = Buffer.alloc(CHAIN_REC);
    fs.readSync(this.chainFd, rec, 0, CHAIN_REC, i * CHAIN_REC);
    return {
      number: rec.readUInt32LE(0),
      txCount: rec.readUInt32LE(4),
      hash: '0x' + rec.toString('hex', 8, 40),
      parentHash: '0x' + rec.toString('hex', 40, 72),
      timestamp: Number(rec.readBigUInt64LE(72)),
      postingsEnd: Number(rec.readBigUInt64LE(80)),
      logCount: rec.readUInt32LE(88),
    };
  }

  head() { return this.chainCount === 0 ? null : this.blockAt(this.headNumber); }

  /** Timestamp lookup, used to stamp every hydrated row. */
  timestampAt(number) {
    const b = this.blockAt(number);
    return b ? b.timestamp : null;
  }

  // ---- writing -------------------------------------------------------------

  /**
   * Commit one block. `postings` is an array of
   * `{ key: Buffer, kind, flags, txIndex, subIndex }` in the order they should
   * be served (block order — the caller emits them in transaction then log
   * order, and this file preserves that).
   */
  appendBlock({ number, hash, parentHash, timestamp, txCount, postings }) {
    if (number !== this.nextNumber) {
      throw new Error(`out of order append: index wants ${this.nextNumber}, got ${number}`);
    }
    if (this.postCount + postings.length > 0x7fffffff) {
      throw new Error('postings file has exceeded 2^31 records; this index needs a wider ordinal');
    }
    const startOrd = this.postCount;

    if (postings.length) {
      const buf = Buffer.alloc(postings.length * POST_REC);
      for (let i = 0; i < postings.length; i++) {
        const p = postings[i];
        const at = i * POST_REC;
        if (p.key.length > 32) throw new Error('index key longer than 32 bytes');
        p.key.copy(buf, at);
        buf.writeUInt32LE(number, at + 32);
        buf.writeUInt16LE(p.txIndex & 0xffff, at + 36);
        buf.writeUInt16LE(p.subIndex === undefined ? NO_SUB : p.subIndex & 0xffff, at + 38);
        buf[at + 40] = p.kind;
        buf[at + 41] = p.flags || 0;
        buf[at + 42] = p.key.length;
      }
      fs.writeSync(this.postFd, buf, 0, buf.length, startOrd * POST_REC);
    }

    const rec = Buffer.alloc(CHAIN_REC);
    rec.writeUInt32LE(number, 0);
    rec.writeUInt32LE(txCount >>> 0, 4);
    Buffer.from(hash.slice(2), 'hex').copy(rec, 8);
    Buffer.from(parentHash.slice(2), 'hex').copy(rec, 40);
    rec.writeBigUInt64LE(BigInt(timestamp), 72);
    rec.writeBigUInt64LE(BigInt((startOrd + postings.length) * POST_REC), 80);
    rec.writeUInt32LE(postings.filter(p => p.kind === KIND.LOG).length, 88);
    fs.writeSync(this.chainFd, rec, 0, CHAIN_REC, (number - this.startBlock) * CHAIN_REC);

    // Only now is the block visible.
    for (let i = 0; i < postings.length; i++) {
      const key = keyHexOf(postings[i].key, postings[i].key.length);
      let list = this.index.get(key);
      if (!list) { list = new Ordinals(); this.index.set(key, list); }
      list.push(startOrd + i);
    }
    this.postCount = startOrd + postings.length;
    this.chainCount++;

    if (++this.sinceSync >= this.syncEvery) this.flush();
  }

  flush() {
    if (!this.opened) return;
    fs.fsyncSync(this.postFd);
    fs.fsyncSync(this.chainFd);
    this.sinceSync = 0;
  }

  /**
   * Unwind so that `keepThrough` is the new head. Pass `startBlock - 1` to
   * empty the index.
   *
   * This is the whole reorg story and it is three truncations plus a bounded
   * scan of what was removed. Nothing that is still on disk after it has ever
   * been rewritten, so a query racing an unwind sees either the old head or
   * the new one and never a mixture.
   */
  unwindTo(keepThrough) {
    const keepCount = Math.max(0, keepThrough - this.startBlock + 1);
    if (keepCount >= this.chainCount) return 0;
    const removedBlocks = this.chainCount - keepCount;

    const cutoffBytes = keepCount === 0 ? 0 : this.blockAt(this.startBlock + keepCount - 1).postingsEnd;
    const cutoffOrd = cutoffBytes / POST_REC;

    // Which keys lost postings? Read the tail we are about to drop — it is
    // bounded by the reorg depth, which is why this is affordable.
    if (this.postCount > cutoffOrd) {
      const bytes = (this.postCount - cutoffOrd) * POST_REC;
      const buf = Buffer.alloc(bytes);
      fs.readSync(this.postFd, buf, 0, bytes, cutoffBytes);
      const touched = new Set();
      for (let p = 0; p < bytes; p += POST_REC) {
        touched.add(buf.toString('hex', p, p + buf[p + 42]));
      }
      for (const key of touched) {
        const list = this.index.get(key);
        if (!list) continue;
        list.truncateFrom(cutoffOrd);
        if (list.n === 0) this.index.delete(key);
      }
    }

    fs.ftruncateSync(this.postFd, cutoffBytes);
    fs.ftruncateSync(this.chainFd, keepCount * CHAIN_REC);
    this.postCount = cutoffOrd;
    this.chainCount = keepCount;
    this.flush();
    return removedBlocks;
  }

  // ---- reading -------------------------------------------------------------

  postingAt(ord) {
    const buf = Buffer.alloc(POST_REC);
    fs.readSync(this.postFd, buf, 0, POST_REC, ord * POST_REC);
    const sub = buf.readUInt16LE(38);
    return {
      ordinal: ord,
      block: buf.readUInt32LE(32),
      txIndex: buf.readUInt16LE(36),
      subIndex: sub === NO_SUB ? null : sub,
      kind: buf[40],
      flags: buf[41],
    };
  }

  /** The block number of a posting, without materialising the rest of it. */
  _blockOf(ord) {
    const buf = Buffer.alloc(4);
    fs.readSync(this.postFd, buf, 0, 4, ord * POST_REC + 32);
    return buf.readUInt32LE(0);
  }

  count(keyHex) {
    const list = this.index.get(keyHex);
    return list ? list.n : 0;
  }

  /**
   * Postings for one key.
   *
   * @param {string} keyHex   lowercase hex, no 0x — 40 chars for an address,
   *                          64 for a topic
   * @param {object} opts
   * @param {number[]} [opts.kinds]      restrict to these KIND values
   * @param {number} [opts.fromBlock]
   * @param {number} [opts.toBlock]
   * @param {boolean} [opts.desc]
   * @param {number} [opts.skip]
   * @param {number} [opts.limit]
   * @param {number} [opts.maxScan]      refuse rather than walk forever
   */
  scan(keyHex, opts = {}) {
    const list = this.index.get(keyHex);
    if (!list || list.n === 0) return [];
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    const fromBlock = opts.fromBlock === undefined ? -Infinity : opts.fromBlock;
    const toBlock = opts.toBlock === undefined ? Infinity : opts.toBlock;
    const desc = !!opts.desc;
    const skip = opts.skip || 0;
    const limit = opts.limit === undefined ? Infinity : opts.limit;
    const maxScan = opts.maxScan || 250_000;

    /* Postings are appended in block order, so the ordinal list for a key is
     * ascending in BOTH ordinal and block. That makes the block range a binary
     * search rather than a walk — the difference between paging an address
     * with a million transactions and timing out on it. */
    const lo = fromBlock === -Infinity ? 0 : this._searchByBlock(list, fromBlock);
    const hi = toBlock === Infinity ? list.n : this._searchByBlock(list, toBlock + 1);
    if (hi <= lo) return [];
    if (hi - lo > maxScan) {
      throw new Error(
        `that range covers ${hi - lo} index entries (limit ${maxScan}); narrow startblock/endblock`,
      );
    }

    const out = [];
    let seen = 0;
    for (let i = 0; i < hi - lo; i++) {
      const idx = desc ? hi - 1 - i : lo + i;
      const p = this.postingAt(list.a[idx]);
      if (kinds && !kinds.has(p.kind)) continue;
      if (seen++ < skip) continue;
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** First position in `list` whose posting block is >= `block`. */
  _searchByBlock(list, block) {
    let lo = 0, hi = list.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._blockOf(list.a[mid]) < block) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  stats() {
    return {
      dir: this.dir,
      blocks: this.chainCount,
      startBlock: this.startBlock,
      headBlock: this.headNumber,
      postings: this.postCount,
      keys: this.index.size,
      postingsBytes: this.postCount * POST_REC,
      chainBytes: this.chainCount * CHAIN_REC,
    };
  }
}

module.exports = { Store, KIND, FLAG, CHAIN_REC, POST_REC, FORMAT_VERSION };
