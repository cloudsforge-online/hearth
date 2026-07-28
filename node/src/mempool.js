'use strict';
/* Mempool: holds valid pending transactions, ordered by tip (fee above the
 * burned base fee) so miners include the most valuable first. */

const P = require('./params');
const TX = require('./tx');

class Mempool {
  constructor(chain) {
    this.chain = chain;
    this.txs = new Map(); // txid -> { tx, fee, size }
    this.bytes = 0;
    // Bumped on every mutation. A block-template builder can cache its selection
    // against (chain tip, this number) instead of redoing it — and redoing it
    // means copying the whole UTXO set, which an anonymous caller must not be
    // able to buy per request. `size` is not a substitute: an eviction plus an
    // admission leaves it unchanged while the selection differs.
    this.version = 0;
  }

  add(tx) {
    if (!tx || !tx.id) return { ok: false, err: 'malformed tx' };
    if (this.txs.has(tx.id)) return { ok: false, err: 'known' };
    if (this.txs.size >= P.MEMPOOL_MAX_TXS) return { ok: false, err: 'mempool full' };
    // Counting transactions bounded nothing once a transaction can carry a
    // payload: 50,000 × 100 KB is 5 GB of "50,000 txs".
    const size = TX.txSize(tx);
    if (this.bytes + size > P.MAX_BLOCK_BYTES * 4) return { ok: false, err: 'mempool byte limit' };
    // validate against current UTXO + already-pooled spends, at the next height
    const scratch = new Map(this.chain.utxo);
    for (const { tx: pooled } of this.txs.values()) TX.applyToUtxo(pooled, scratch);
    const r = TX.validateNormal(tx, scratch, this.chain.height + 1);
    if (!r.ok) return r;
    this.txs.set(tx.id, { tx, fee: r.fee, size });
    this.bytes += size;
    this.version++;
    return { ok: true };
  }

  /**
   * Select txs for a block: highest tip first, stopping at whichever of the
   * count or byte ceiling is reached first. Sorting by total fee would let a
   * large data tx outbid a small payment it is not actually worth more than, so
   * the sort key is tip per byte.
   */
  select(max = 500) {
    const ranked = [...this.txs.values()].sort((a, b) =>
      ((b.fee - TX.requiredFee(b.tx)) / b.size) - ((a.fee - TX.requiredFee(a.tx)) / a.size));
    const out = [];
    let bytes = 0;
    for (const e of ranked) {
      if (out.length >= max) break;
      if (bytes + e.size > P.MAX_BLOCK_BYTES - 100_000) continue; // headroom for the coinbase + header
      out.push(e.tx);
      bytes += e.size;
    }
    return out;
  }

  removeIncluded(txs) {
    for (const t of txs) {
      const e = this.txs.get(t.id);
      if (e) { this.bytes -= e.size; this.txs.delete(t.id); this.version++; }
    }
  }

  list() { return [...this.txs.values()].map(e => ({ id: e.tx.id, fee: e.fee, size: e.size, tx: e.tx })); }
  get size() { return this.txs.size; }
}

module.exports = { Mempool };
