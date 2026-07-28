'use strict';
/* Block ingestion, and the reorg logic that is the reason this file is not a
 * for-loop.
 *
 * ============================================================================
 * REORGS
 * ============================================================================
 *
 * Hearth's fork choice is heaviest-cumulative-work with NO depth limit, no
 * checkpoint and no finality gadget (docs/exchange-integration.md §4). On a
 * young CPU-mined chain a 1–2 block reorg is a normal Tuesday. An indexer that
 * only appends would keep serving transactions that are no longer in any
 * block, and — worse — would keep serving them silently, because nothing about
 * an orphaned transaction looks wrong in isolation.
 *
 * So every tick does two things in this order:
 *
 *   1. CONFIRM THE TIP WE ALREADY HAVE. Ask the node for the block at our head
 *      height and compare hashes. Cheap (one call), and it is the only thing
 *      that catches a reorg that does not change the height.
 *   2. Only then extend.
 *
 * On a mismatch we walk back one block at a time until our stored hash equals
 * the node's hash at that height, and unwind the index to there. Unwinding is
 * a truncation (store.js), so it either happened or it did not.
 *
 * TWO REFUSALS THAT ARE DELIBERATE:
 *
 *   - Past `maxReorgDepth` the indexer STOPS rather than rewinding. A rewind
 *     of a thousand blocks is either an attack or an operator who pointed this
 *     at a different chain, and in both cases quietly rewriting served history
 *     is the wrong response. It parks and says so.
 *   - A block whose parentHash does not match what we just indexed aborts the
 *     batch. Chaining onto the wrong parent is how an index ends up internally
 *     consistent and wrong.
 */

const { KIND, FLAG } = require('./store');
const { flattenLogs } = require('./hydrate');
const { logger } = require('./log');
const { keccak256 } = require('../../../node/src/crypto/keccak');

/** keccak256("Transfer(address,address,uint256)") — ERC-20 and ERC-721 alike. */
const TRANSFER_TOPIC = '0x' + Buffer.from(
  keccak256(Buffer.from('Transfer(address,address,uint256)', 'utf8')),
).toString('hex');

const hexToBuf = h => Buffer.from(String(h).slice(2), 'hex');
const numOf = h => Number(BigInt(h));

/** A 32-byte topic holding a left-padded address → the 20 address bytes. */
function addressFromTopic(topic) {
  const b = hexToBuf(topic);
  if (b.length !== 32) return null;
  // Anything in the top 12 bytes means this is not an address, it is a number
  // that happens to be indexed. Indexing it as an address would put unrelated
  // transfers on someone's page.
  for (let i = 0; i < 12; i++) if (b[i] !== 0) return null;
  return b.subarray(12);
}

/**
 * Collects postings for one block, deduplicating by (key, kind, tx, sub) and
 * merging flags — so a self-transfer produces ONE row on the address's page
 * with both direction bits, not two.
 */
class PostingSet {
  constructor() {
    this.order = [];
    this.byId = new Map();
  }

  add(key, kind, flags, txIndex, subIndex) {
    if (!key || key.length === 0) return;
    const id = `${key.toString('hex')}:${kind}:${txIndex}:${subIndex === undefined ? -1 : subIndex}`;
    const existing = this.byId.get(id);
    if (existing) { existing.flags |= flags; return; }
    const p = { key, kind, flags, txIndex, subIndex };
    this.byId.set(id, p);
    this.order.push(p);
  }

  get list() { return this.order; }
}

class Indexer {
  constructor({ store, rpc, env }) {
    this.store = store;
    this.rpc = rpc;
    this.env = env;
    this.nodeHead = null;
    this.tracing = false;
    this.stopped = false;
    this.parked = null;          // set to a reason string when we refuse to continue
    this.lastError = null;
    this.reorgs = 0;
    this.deepestReorg = 0;
    this.blocksIndexed = 0;
    this.timer = null;
  }

  /** Blocks between the node's tip and ours. null until we have spoken to a node. */
  get lag() {
    if (this.nodeHead === null) return null;
    const head = this.store.headNumber;
    if (head === null) return Number(this.nodeHead) - this.store.startBlock + 1;
    return Math.max(0, Number(this.nodeHead) - head);
  }

  async start() {
    this.tracing = await this.rpc.supportsTracing().catch(() => false);
    if (!this.tracing) {
      logger.info('no debug_traceTransaction on this node: internal transactions will not be indexed, '
        + 'and module=account&action=txlistinternal will say so rather than answer an empty list');
    }
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.syncOnce();
        this.lastError = null;
      } catch (e) {
        this.lastError = String(e.message || e);
        logger.warn('index tick failed', { err: e });
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.env.pollMs).unref();
    };
    await tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.store.flush();
  }

  async syncOnce() {
    if (this.parked) return;
    this.nodeHead = await this.rpc.blockNumber();
    const head = Number(this.nodeHead);

    if (this.store.chainCount > 0) {
      const ok = await this._confirmTip(head);
      if (!ok) return;               // a reorg was handled; extend on the next tick
    }

    let indexed = 0;
    while (indexed < this.env.batchBlocks) {
      const n = this.store.nextNumber;
      if (n > head) break;
      const done = await this._indexBlock(n);
      if (!done) break;
      indexed++;
      this.blocksIndexed++;
    }
    if (indexed) this.store.flush();
    return indexed;
  }

  /**
   * Is the head we already indexed still on the canonical chain?
   * @returns {Promise<boolean>} false when a reorg was found and unwound.
   */
  async _confirmTip(nodeHead) {
    const stored = this.store.head();
    if (stored.number > nodeHead) {
      /* The node is SHORTER than our index. Either a deep reorg or a node that
       * was restored from an older snapshot. Rewind to the node's height and
       * let the hash comparison below sort out the rest. */
      logger.warn('node is behind the index', { nodeHead, indexHead: stored.number });
      this._unwind(nodeHead, stored.number - nodeHead);
      return false;
    }
    const live = await this.rpc.getBlockByNumber(stored.number, false);
    if (live && live.hash.toLowerCase() === stored.hash) return true;

    // Walk back to the fork point.
    let depth = 1;
    for (let n = stored.number - 1; depth <= this.env.maxReorgDepth; n--, depth++) {
      if (n < this.store.startBlock) { this._unwind(this.store.startBlock - 1, depth); return false; }
      const mine = this.store.blockAt(n);
      const theirs = await this.rpc.getBlockByNumber(n, false);
      if (theirs && theirs.hash.toLowerCase() === mine.hash) { this._unwind(n, depth); return false; }
    }
    this.parked = `a reorg deeper than ${this.env.maxReorgDepth} blocks was found at height ${stored.number}; `
      + 'refusing to rewind automatically. Check that this is the chain you meant, then delete the index directory.';
    logger.error('PARKED', { reason: this.parked });
    return false;
  }

  _unwind(keepThrough, depth) {
    const removed = this.store.unwindTo(keepThrough);
    this.reorgs++;
    this.deepestReorg = Math.max(this.deepestReorg, removed);
    const fields = { depth: removed, newHead: keepThrough, indexHead: this.store.headNumber };
    if (removed >= this.env.reorgAlertDepth) {
      /* Exchange guidance is to halt crediting past ~5 blocks
       * (docs/exchange-integration.md §4). This is the line an operator alerts
       * on, so it is an error rather than a warning. */
      logger.error('DEEP REORG — index rewound', fields);
    } else {
      logger.warn('reorg — index rewound', fields);
    }
  }

  /** @returns {Promise<boolean>} false if the block could not be indexed now. */
  async _indexBlock(n) {
    const block = await this.rpc.getBlockByNumber(n, true);
    if (!block) return false;

    const stored = this.store.head();
    if (stored && block.parentHash.toLowerCase() !== stored.hash) {
      /* We are about to chain onto the wrong parent. Do not. The next tick's
       * tip confirmation finds the fork point and unwinds properly. */
      logger.warn('parent mismatch mid-catch-up; deferring to the reorg path', {
        block: n, wantParent: stored.hash, gotParent: block.parentHash,
      });
      await this._confirmTip(Number(this.nodeHead));
      return false;
    }

    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    const full = txs.length > 0 && typeof txs[0] === 'object';
    if (txs.length && !full) {
      throw new Error(`node returned hash-only transactions for block ${n} despite fullTx=true`);
    }
    const receipts = txs.length
      ? await this.rpc.getBlockReceipts(n, txs.map(t => t.hash))
      : [];
    if (receipts.length !== txs.length) {
      throw new Error(`block ${n} has ${txs.length} transactions but ${receipts.length} receipts`);
    }

    const set = new PostingSet();
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const receipt = receipts[i];
      set.add(hexToBuf(tx.from), KIND.TX, FLAG.FROM, i);
      if (tx.to) {
        set.add(hexToBuf(tx.to), KIND.TX, FLAG.TO, i);
      } else if (receipt && receipt.contractAddress) {
        /* A creation has no `to`. Index the created address so that a contract
         * page shows the transaction that produced it — the single most-asked
         * question about a contract after "what does it do". */
        set.add(hexToBuf(receipt.contractAddress), KIND.TX, FLAG.TO | FLAG.CREATE, i);
      }
    }
    // Block-wide log ordinals, derived here rather than taken from the node's
    // `logIndex`. See flattenLogs in hydrate.js for why that distinction is
    // not pedantry.
    for (const { blockLogIndex, txIndex, log } of flattenLogs(receipts)) {
      this._addLogPostings(set, log, txIndex, blockLogIndex);
    }

    if (this.tracing) {
      for (let i = 0; i < txs.length; i++) {
        await this._addInternalPostings(set, txs[i].hash, i);
      }
    }

    this.store.appendBlock({
      number: n,
      hash: block.hash.toLowerCase(),
      parentHash: block.parentHash.toLowerCase(),
      timestamp: numOf(block.timestamp),
      txCount: txs.length,
      postings: set.list,
    });
    return true;
  }

  _addLogPostings(set, log, txIndex, li) {
    set.add(hexToBuf(log.address), KIND.LOG, 0, txIndex, li);
    const topics = log.topics || [];
    if (topics.length) set.add(hexToBuf(topics[0]), KIND.TOPIC, 0, txIndex, li);

    if (topics[0] && topics[0].toLowerCase() === TRANSFER_TOPIC) {
      /* ERC-20 has three topics and a 32-byte data word (the amount).
       * ERC-721 has four, because tokenId is indexed. Anything else calling
       * itself Transfer is not one of those two and is left as a plain log
       * rather than guessed at. */
      const nft = topics.length === 4;
      if (topics.length === 3 || nft) {
        const from = addressFromTopic(topics[1]);
        const to = addressFromTopic(topics[2]);
        const flags = nft ? FLAG.NFT : 0;
        if (from) set.add(from, KIND.TOKEN, flags | FLAG.FROM, txIndex, li);
        if (to) set.add(to, KIND.TOKEN, flags | FLAG.TO, txIndex, li);
      }
    }
  }

  /**
   * Internal transfers, from a call trace. Only reachable on a node that
   * exposes `debug_traceTransaction` — which Hearth's v1 surface does not
   * (docs/exchange-integration.md §5.2). The code is here so that the day
   * tracing lands this is a configuration change rather than a project.
   */
  async _addInternalPostings(set, txHash, txIndex) {
    let trace;
    try {
      trace = await this.rpc.traceTransaction(txHash);
    } catch (e) {
      logger.warn('trace failed; internal transfers for this transaction are not indexed', {
        tx: txHash, err: e,
      });
      return;
    }
    let seq = 0;
    const walk = frame => {
      if (!frame || typeof frame !== 'object') return;
      const value = frame.value ? BigInt(frame.value) : 0n;
      const isCreate = /CREATE/i.test(String(frame.type || ''));
      const isDestruct = /SELFDESTRUCT/i.test(String(frame.type || ''));
      // The top-level frame is the transaction itself and is already indexed.
      if (seq > 0 && (value > 0n || isCreate || isDestruct)) {
        if (frame.from) set.add(hexToBuf(frame.from), KIND.INTERNAL, FLAG.FROM, txIndex, seq);
        if (frame.to) set.add(hexToBuf(frame.to), KIND.INTERNAL, FLAG.TO | (isCreate ? FLAG.CREATE : 0), txIndex, seq);
      }
      seq++;
      for (const c of frame.calls || []) walk(c);
    };
    walk(trace);
  }

  stats() {
    return {
      nodeHead: this.nodeHead === null ? null : Number(this.nodeHead),
      lag: this.lag,
      tracing: this.tracing,
      reorgs: this.reorgs,
      deepestReorg: this.deepestReorg,
      blocksIndexed: this.blocksIndexed,
      parked: this.parked,
      lastError: this.lastError,
    };
  }
}

module.exports = { Indexer, PostingSet, TRANSFER_TOPIC, addressFromTopic };
