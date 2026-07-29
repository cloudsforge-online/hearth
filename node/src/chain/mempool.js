'use strict';
/* The account-model mempool: ordered by nonce within a sender, by gas price between them.
 *
 * A UTXO mempool can rank transactions by fee and stop thinking. An account-model
 * one cannot, and the reason is the single hardest thing about this file:
 *
 *   A SENDER'S TRANSACTIONS ARE A CHAIN, NOT A SET. Nonce 5 is invalid until nonce
 *   4 is mined. Sorting the whole pool by gas price and taking the top N therefore
 *   produces a block full of transactions that cannot execute — every one of them
 *   fails `checkTransaction` with NONCE_TOO_HIGH, and a miner that then drops them
 *   silently mines empty blocks while the pool is full.
 *
 * So the pool is a map of per-sender nonce ladders. Selection walks each sender's
 * ladder in order and picks between senders on price: the cheapest correct thing
 * that is also the standard one (geth calls the two halves `pending` and `queued`).
 *
 * WHAT IS POLICY AND WHAT IS CONSENSUS. Everything here is POLICY. A block whose
 * transactions this pool would have refused is still perfectly valid, and this node
 * will accept it from a peer without complaint — the minimum gas price, the
 * per-sender cap, the nonce-gap window and the replacement bump are this node's
 * rules about what it will *relay and mine*, and they are deliberately separate
 * from `chain/statetransition.js`, which is consensus. Confusing the two is how a
 * client ends up rejecting blocks the network accepts.
 *
 * THE BALANCE CHECK IS CUMULATIVE. A sender with 1 EMBER can sign ten transactions
 * that each spend 1 EMBER, and each is individually affordable. Checking them one
 * at a time admits all ten; nine of them can never be mined. So the cost of every
 * pooled transaction with a lower nonce is counted against the balance first, which
 * is also what makes a replacement recompute the whole ladder.
 */

const P = require('../params');
const TX = require('./transaction');

const REJECT = Object.freeze({
  KNOWN: 'ALREADY_KNOWN',
  INVALID: 'INVALID',
  UNDERPRICED: 'UNDERPRICED',
  REPLACEMENT_UNDERPRICED: 'REPLACEMENT_UNDERPRICED',
  NONCE_TOO_LOW: 'NONCE_TOO_LOW',
  NONCE_TOO_HIGH: 'NONCE_TOO_HIGH',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  GAS_LIMIT: 'GAS_LIMIT',
  POOL_FULL: 'POOL_FULL',
  SENDER_FULL: 'SENDER_FULL',
});

/** The wire error strings clients match on, mapped from the codes above. */
const MESSAGES = {
  ALREADY_KNOWN: 'already known',
  UNDERPRICED: 'transaction underpriced',
  REPLACEMENT_UNDERPRICED: 'replacement transaction underpriced',
  NONCE_TOO_LOW: 'nonce too low',
  NONCE_TOO_HIGH: 'nonce too high',
  INSUFFICIENT_FUNDS: 'insufficient funds for gas * price + value',
  GAS_LIMIT: 'exceeds block gas limit',
  POOL_FULL: 'txpool is full',
  SENDER_FULL: 'txpool is full for this sender',
};

/**
 * Admission-journal length — how far back `eth_newPendingTransactionFilter` can
 * see, and the whole memory cost of supporting it.
 *
 * A RING, NOT A QUEUE PER FILTER, and that distinction is the point. geth gives
 * each pending-transaction subscription its own channel and fills it from the
 * pool; a subscription nobody drains is then unbounded growth reachable from an
 * unauthenticated endpoint. Here the pool keeps ONE bounded log of what it
 * admitted and a filter is an integer into it, so a thousand filters cost a
 * thousand integers. A filter that falls further behind than this misses the
 * difference — the honest degradation, and the reason `pendingSince` reports the
 * cursor it actually served from.
 *
 * 8,192 hashes is roughly 0.5 MB of hex and covers a filter polling every two
 * seconds through the fastest burst this pool will accept.
 */
const RECENT_MAX = 8_192;

class Mempool {
  /**
   * @param {object}   o
   * @param {function} o.state      () -> a reader with getNonce(addr)/getBalance(addr)
   * @param {function} [o.gasLimit] () -> the block gas limit, as bigint
   * @param {bigint}   [o.minGasPrice]
   */
  constructor({ state, gasLimit, minGasPrice = P.EVM_MIN_GAS_PRICE, chainId = TX.CHAIN_ID } = {}) {
    this.readState = state;
    this.readGasLimit = gasLimit || (() => BigInt(P.EVM_BLOCK_GAS_LIMIT));
    this.minGasPrice = BigInt(minGasPrice);
    this.chainId = chainId;

    this.byHash = new Map();      // hashHex -> entry
    this.bySender = new Map();    // senderHex -> Map(nonce:bigint -> entry)
    this.bytes = 0;
    /* Bumped on every mutation, so a block-template builder can memoize its
     * selection on (tip, version) exactly as the UTXO miner does. `size` is not a
     * substitute: an eviction plus an admission leaves it unchanged. */
    this.version = 0;

    /* The admission journal — see RECENT_MAX. `recentBase` is the sequence
     * number of `recent[0]`, so a cursor survives the ring wrapping and a reader
     * can tell whether it fell off the back. Written in `add` and nowhere else:
     * a transaction that is mined or evicted was still ANNOUNCED, and a client
     * that already saw its hash does not want it withdrawn. */
    this.recent = [];
    this.recentBase = 0;
  }

  /** The sequence number the next admitted transaction will take. */
  get pendingCursor() { return this.recentBase + this.recent.length; }

  /**
   * Transaction hashes admitted since `cursor`, and the cursor to pass next
   * time. A null cursor means "from now", which is what a filter created this
   * instant wants — it must not be handed the whole journal on its first poll.
   *
   * A cursor from the future (a node restarted under a client that kept its
   * filter) is treated as "from now" rather than as an error: the alternative is
   * replaying the entire ring to a client that has already seen it.
   */
  pendingSince(cursor) {
    const end = this.pendingCursor;
    if (cursor === null || cursor === undefined || !Number.isSafeInteger(cursor) || cursor > end) {
      return { cursor: end, hashes: [] };
    }
    const start = Math.max(cursor, this.recentBase);
    return {
      cursor: end,
      hashes: this.recent.slice(start - this.recentBase).map(h => Buffer.from(h, 'hex')),
    };
  }

  /* Trimmed in batches rather than shifted per push: `Array#shift` on an
   * eight-thousand element array, once per admitted transaction, is the kind of
   * quadratic cost that only shows up under the load it is meant to survive. */
  _journal(hashHex) {
    this.recent.push(hashHex);
    if (this.recent.length > RECENT_MAX * 2) {
      const drop = this.recent.length - RECENT_MAX;
      this.recent = this.recent.slice(drop);
      this.recentBase += drop;
    }
  }

  get size() { return this.byHash.size; }

  has(hashHex) { return this.byHash.has(hashHex); }

  get(hashHex) { return this.byHash.get(hashHex) || null; }

  // ---- admission -----------------------------------------------------------

  /**
   * Validate a raw signed transaction and pool it.
   *
   * @param {Buffer|string} raw
   * @returns {{ok: true, hash: string, entry: object} | {ok: false, code, error}}
   */
  add(raw) {
    const v = TX.validate(raw, { chainId: this.chainId });
    if (!v.ok) return { ok: false, code: v.code, error: v.error };

    const hashHex = v.hash.toString('hex');
    if (this.byHash.has(hashHex)) return { ok: false, code: REJECT.KNOWN, error: MESSAGES.ALREADY_KNOWN };

    const tx = v.tx;
    const senderHex = v.sender.toString('hex');
    const blockGasLimit = BigInt(this.readGasLimit());

    if (tx.gasPrice < this.minGasPrice) {
      return { ok: false, code: REJECT.UNDERPRICED, error: MESSAGES.UNDERPRICED };
    }
    /* A transaction whose gas limit exceeds the whole block's can never be mined
     * by anyone, so it is refused rather than queued forever. */
    if (tx.gasLimit > blockGasLimit) {
      return { ok: false, code: REJECT.GAS_LIMIT, error: MESSAGES.GAS_LIMIT };
    }

    const state = this.readState();
    const accountNonce = state.getNonce(v.sender);
    if (tx.nonce < accountNonce) {
      return { ok: false, code: REJECT.NONCE_TOO_LOW, error: MESSAGES.NONCE_TOO_LOW };
    }
    if (tx.nonce > accountNonce + BigInt(P.EVM_MEMPOOL_NONCE_GAP)) {
      return { ok: false, code: REJECT.NONCE_TOO_HIGH, error: MESSAGES.NONCE_TOO_HIGH };
    }

    const ladder = this.bySender.get(senderHex) || new Map();
    const existing = ladder.get(tx.nonce) || null;

    /* Replacement. Without the bump a peer can re-broadcast a one-wei-cheaper
     * transaction in a loop and evict the original every time, for free. */
    if (existing) {
      const floor = existing.gasPrice
        + (existing.gasPrice * BigInt(P.EVM_REPLACE_BUMP_PERCENT) + 99n) / 100n;
      if (tx.gasPrice < floor) {
        return { ok: false, code: REJECT.REPLACEMENT_UNDERPRICED, error: MESSAGES.REPLACEMENT_UNDERPRICED };
      }
    } else {
      if (ladder.size >= P.EVM_MEMPOOL_PER_SENDER) {
        return { ok: false, code: REJECT.SENDER_FULL, error: MESSAGES.SENDER_FULL };
      }
      if (this.byHash.size >= P.MEMPOOL_MAX_TXS && !this._evictWorst(tx.gasPrice)) {
        return { ok: false, code: REJECT.POOL_FULL, error: MESSAGES.POOL_FULL };
      }
    }

    const cost = tx.value + tx.gasLimit * tx.gasPrice;
    /* Cumulative, and counting only the transactions this one queues BEHIND —
     * a replacement must be affordable in place of the one it replaces, not on
     * top of it. */
    let committed = 0n;
    for (const [n, e] of ladder) if (n < tx.nonce) committed += e.cost;
    if (state.getBalance(v.sender) < committed + cost) {
      return { ok: false, code: REJECT.INSUFFICIENT_FUNDS, error: MESSAGES.INSUFFICIENT_FUNDS };
    }

    const entry = {
      hash: hashHex,
      raw: v.raw,
      tx,
      sender: v.sender,
      senderHex,
      nonce: tx.nonce,
      gasPrice: tx.gasPrice,
      gasLimit: tx.gasLimit,
      cost,
      size: v.raw.length,
      at: Date.now(),
    };

    if (existing) this._remove(existing);
    ladder.set(tx.nonce, entry);
    this.bySender.set(senderHex, ladder);
    this.byHash.set(hashHex, entry);
    this.bytes += entry.size;
    this.version++;
    this._journal(hashHex);
    return { ok: true, hash: hashHex, entry };
  }

  _remove(entry) {
    if (!this.byHash.delete(entry.hash)) return false;
    this.bytes -= entry.size;
    const ladder = this.bySender.get(entry.senderHex);
    if (ladder) {
      if (ladder.get(entry.nonce) === entry) ladder.delete(entry.nonce);
      if (ladder.size === 0) this.bySender.delete(entry.senderHex);
    }
    this.version++;
    return true;
  }

  /** Drop the cheapest pooled transaction, but only if it is cheaper than the
   *  arrival that wants its slot — otherwise the pool churns for nothing. */
  _evictWorst(incomingPrice) {
    let worst = null;
    for (const e of this.byHash.values()) if (!worst || e.gasPrice < worst.gasPrice) worst = e;
    if (!worst || worst.gasPrice >= incomingPrice) return false;
    this._remove(worst);
    return true;
  }

  // ---- selection -----------------------------------------------------------

  /**
   * The transactions a block should carry, in the order they must be applied.
   *
   * Per sender, the ladder starting at the account's current nonce, unbroken: a
   * gap ends that sender's contribution to this block, because everything past it
   * is unexecutable. Between senders, the highest gas price at the head of the
   * ladder goes first — which is also what makes the ordering deterministic given
   * the same pool, since ties break on the sender's address.
   *
   * @param {object}  o
   * @param {object}  o.state      the state the block will build on
   * @param {bigint}  o.gasLimit
   * @param {number}  [o.maxTxs]
   * @returns {Array} entries, in application order
   */
  select({ state, gasLimit, maxTxs = P.MAX_BLOCK_TXS } = {}) {
    const limit = BigInt(gasLimit === undefined ? this.readGasLimit() : gasLimit);
    const st = state || this.readState();

    // one cursor per sender: the ready ladder, oldest nonce first
    const heads = [];
    for (const [senderHex, ladder] of this.bySender) {
      const sender = Buffer.from(senderHex, 'hex');
      let next = st.getNonce(sender);
      const run = [];
      for (;;) {
        const e = ladder.get(next);
        if (!e) break;
        run.push(e);
        next += 1n;
      }
      if (run.length) heads.push({ senderHex, run, i: 0, balance: st.getBalance(sender), spent: 0n });
    }

    const out = [];
    let gasUsed = 0n;
    for (;;) {
      let best = null;
      for (const h of heads) {
        if (h.i >= h.run.length) continue;
        const e = h.run[h.i];
        if (gasUsed + e.gasLimit > limit) continue;      // does not fit what is left
        if (!best) { best = h; continue; }
        const b = best.run[best.i];
        if (e.gasPrice > b.gasPrice
          || (e.gasPrice === b.gasPrice && h.senderHex < best.senderHex)) best = h;
      }
      if (!best || out.length >= maxTxs) break;
      const e = best.run[best.i];
      /* The cumulative affordability check again, now against the state the block
       * actually starts from — the pool's copy was made against an older tip. A
       * sender who can no longer pay ends here rather than failing in the block. */
      if (best.spent + e.cost > best.balance) { best.i = best.run.length; continue; }
      best.spent += e.cost;
      best.i++;
      gasUsed += e.gasLimit;
      out.push(e);
    }
    return out;
  }

  /**
   * The nonce `eth_getTransactionCount(addr, 'pending')` must answer: the account
   * nonce plus every consecutively-pooled transaction above it.
   *
   * This is not cosmetic. A wallet that sends two transactions in a row asks for
   * the pending nonce between them; answering with the mined nonce hands it the
   * nonce it just used, and the second transaction is rejected as a duplicate.
   */
  pendingNonce(addr, accountNonce) {
    const ladder = this.bySender.get(Buffer.from(addr).toString('hex'));
    let n = BigInt(accountNonce);
    if (!ladder) return n;
    while (ladder.has(n)) n += 1n;
    return n;
  }

  // ---- maintenance ---------------------------------------------------------

  /** Forget transactions a block just mined. */
  removeIncluded(hashes) {
    for (const h of hashes) {
      const e = this.byHash.get(typeof h === 'string' ? h : h.toString('hex'));
      if (e) this._remove(e);
    }
  }

  /**
   * Re-check the whole pool against a new tip. Everything below the account's
   * nonce is mined or replaced; everything the account can no longer afford is
   * unmineable. Called after every accepted block and after every reorg — the
   * reorg case is the one that matters, because a transaction that was mined on
   * the losing branch has to come BACK, and the caller re-adds those separately.
   */
  revalidate() {
    const state = this.readState();
    for (const [senderHex, ladder] of [...this.bySender]) {
      const sender = Buffer.from(senderHex, 'hex');
      const accountNonce = state.getNonce(sender);
      const balance = state.getBalance(sender);
      let spent = 0n;
      for (const nonce of [...ladder.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        const e = ladder.get(nonce);
        if (nonce < accountNonce) { this._remove(e); continue; }
        spent += e.cost;
        if (spent > balance) { this._remove(e); spent -= e.cost; }
      }
    }
  }

  /**
   * geth's split of the pool, for `txpool_status`: PENDING is what could be
   * mined right now — a sender's unbroken run upwards from its account nonce —
   * and QUEUED is everything stranded above a gap.
   *
   * The distinction is the only thing that makes the number useful. A wallet
   * whose transaction sits in `queued` is not waiting for a miner, it is waiting
   * for an earlier nonce that may never arrive, and a dashboard that reports one
   * total cannot tell the operator which. Costs one state read per SENDER, which
   * is the same walk `revalidate()` already does after every block.
   */
  status() {
    const state = this.readState();
    let pending = 0;
    for (const [senderHex, ladder] of this.bySender) {
      let n = state.getNonce(Buffer.from(senderHex, 'hex'));
      while (ladder.has(n)) { pending++; n += 1n; }
    }
    return { pending, queued: this.byHash.size - pending };
  }

  /** Everything pooled, newest last — for `/mempool` and for tests. */
  list() {
    return [...this.byHash.values()].map(e => ({
      hash: '0x' + e.hash,
      from: '0x' + e.sender.toString('hex'),
      nonce: e.nonce.toString(),
      gasPrice: e.gasPrice.toString(),
      gas: e.gasLimit.toString(),
      size: e.size,
    }));
  }

  clear() {
    this.byHash.clear();
    this.bySender.clear();
    this.bytes = 0;
    this.version++;
  }
}

module.exports = { Mempool, REJECT, MESSAGES, RECENT_MAX };
