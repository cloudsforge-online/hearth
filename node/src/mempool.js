'use strict';
/* Mempool: holds valid pending transactions, ordered by tip (fee above the
 * burned base fee) so miners include the most valuable first. */

const P = require('./params');
const TX = require('./tx');

/**
 * A copy-on-write view over the chain's UTXO map.
 *
 * WHY THIS EXISTS, AND IT IS NOT A TIDY-UP. `add` used to build its scratch set as
 * `new Map(chain.utxo)` and then replay every pooled transaction into it, BEFORE
 * calling `validateNormal` — whose very first line rejects a transaction with no
 * inputs. So a 39-byte `{"t":"tx","tx":{"id":"…"}}` bought a full copy of the UTXO
 * set: measured at 0.9 ms with 10,000 UTXOs and 354 ms with a million. The p2p read
 * loop drains every newline-delimited message in one synchronous event and a single
 * 4 MiB frame holds about 107,000 of them, so one frame was minutes of blocked
 * event loop from an anonymous peer.
 *
 * A view fixes the shape of the problem rather than the symptom: reads fall through
 * to the live map, writes land in a small overlay, and nothing is ever copied. The
 * base is read through a function because `chain.utxo` is REPLACED on a reorg
 * (`chain.js` `_activate`), and a view holding the old Map would validate against a
 * chain that no longer exists.
 *
 * `validateNormal` only ever calls `get`; `applyToUtxo` calls `delete` and `set`.
 * Those three, plus the tombstone that makes a delete of a base entry visible, are
 * the whole contract.
 */
class UtxoView {
  constructor(base) {
    this.readBase = typeof base === 'function' ? base : () => base;
    this.over = new Map();
    this.gone = new Set();
  }

  get(k) {
    if (this.over.has(k)) return this.over.get(k);
    if (this.gone.has(k)) return undefined;
    return this.readBase().get(k);
  }

  has(k) { return this.get(k) !== undefined; }

  set(k, v) { this.over.set(k, v); this.gone.delete(k); }

  delete(k) { this.over.delete(k); this.gone.add(k); }
}

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
    /* The pooled transactions' effects, applied once as they arrive rather than
     * replayed per admission. Rebuilt when the pool changes underneath it. */
    this.view = new UtxoView(() => this.chain.utxo);
  }

  /** Re-apply every pooled transaction to a fresh view. O(pool), once per block. */
  _rebuildView() {
    this.view = new UtxoView(() => this.chain.utxo);
    for (const { tx } of this.txs.values()) TX.applyToUtxo(tx, this.view);
  }

  add(tx) {
    if (!tx || !tx.id) return { ok: false, err: 'malformed tx' };
    if (this.txs.has(tx.id)) return { ok: false, err: 'known' };
    if (this.txs.size >= P.MEMPOOL_MAX_TXS) return { ok: false, err: 'mempool full' };
    // Counting transactions bounded nothing once a transaction can carry a
    // payload: 50,000 × 100 KB is 5 GB of "50,000 txs".
    const size = TX.txSize(tx);
    if (this.bytes + size > P.MAX_BLOCK_BYTES * 4) return { ok: false, err: 'mempool byte limit' };
    // validate against current UTXO + already-pooled spends, at the next height.
    // `validateNormal` does not mutate, so a rejection leaves the view untouched.
    const r = TX.validateNormal(tx, this.view, this.chain.height + 1);
    if (!r.ok) return r;
    TX.applyToUtxo(tx, this.view, this.chain.height + 1);
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
    let removed = 0;
    for (const t of txs) {
      const e = this.txs.get(t.id);
      if (e) { this.bytes -= e.size; this.txs.delete(t.id); this.version++; removed++; }
    }
    /* The overlay described a pool that no longer exists — and after a reorg the
     * base map has been replaced as well. Rebuilding is O(pool) once per block,
     * against O(UTXO set) per transaction before. */
    if (removed) this._rebuildView();
  }

  /** Drop everything and start again — used when the chain moved under us. */
  reset() {
    this.txs.clear();
    this.bytes = 0;
    this.version++;
    this._rebuildView();
  }

  list() { return [...this.txs.values()].map(e => ({ id: e.tx.id, fee: e.fee, size: e.size, tx: e.tx })); }
  get size() { return this.txs.size; }
}

module.exports = { Mempool, UtxoView };
