'use strict';
/* Mempool: holds valid pending transactions, ordered by tip (fee above the
 * burned base fee) so miners include the most valuable first. */

const P = require('./params');
const TX = require('./tx');

class Mempool {
  constructor(chain) {
    this.chain = chain;
    this.txs = new Map(); // txid -> { tx, fee }
  }

  add(tx) {
    if (!tx || !tx.id) return { ok: false, err: 'malformed tx' };
    if (this.txs.has(tx.id)) return { ok: false, err: 'known' };
    if (this.txs.size >= P.MEMPOOL_MAX_TXS) return { ok: false, err: 'mempool full' };
    // validate against current UTXO + already-pooled spends, at the next height
    const scratch = new Map(this.chain.utxo);
    for (const { tx: pooled } of this.txs.values()) TX.applyToUtxo(pooled, scratch);
    const r = TX.validateNormal(tx, scratch, this.chain.height + 1);
    if (!r.ok) return r;
    this.txs.set(tx.id, { tx, fee: r.fee });
    return { ok: true };
  }

  /** Select up to `max` txs for a block, highest fee (⇒ highest tip) first. */
  select(max = 500) {
    return [...this.txs.values()]
      .sort((a, b) => b.fee - a.fee)
      .slice(0, max)
      .map(e => e.tx);
  }

  removeIncluded(txs) {
    for (const t of txs) this.txs.delete(t.id);
  }

  list() { return [...this.txs.values()].map(e => ({ id: e.tx.id, fee: e.fee, tx: e.tx })); }
  get size() { return this.txs.size; }
}

module.exports = { Mempool };
