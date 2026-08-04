'use strict';
/* The blockchain.
 *
 * Hardened after the security audit (docs/security-review.md):
 *   - most-cumulative-work FORK CHOICE with reorganization (C2)
 *   - coinbase can mint at most subsidy+tips, ≤2 outputs (C1)
 *   - coinbase maturity (C3)
 *   - timestamp bounds: median-time-past + max future drift (H2)
 *   - block transaction-count limit (H3)
 * plus deterministic integer emission (H7, in params.js) and coinbase-tagged
 * UTXOs for maturity checks.
 *
 * Blocks live in `store` (id -> {block,height,work,id}); the active chain is the
 * branch with the greatest cumulative work. UTXO state tracks the active tip. */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const C = require('./crypto');
const P = require('./params');
const TX = require('./tx');
const { readLines } = require('./lines');
const BLOCK = require('./block');

const TWO256 = 1n << 256n;

class Chain extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'blocks.ndjson');
    this.store = new Map();     // blockId -> { block, height, work(BigInt), id }
    this.chainIndex = [];       // active chain: height -> blockId
    this.tipId = null;
    this.utxo = new Map();      // active UTXO: "txid:vout" -> {address,amount,coinbase,height}
    this.burned = 0;
    // Active-chain indexes. Without these an application cannot find its own
    // transaction except by scanning every block, which is why there was no
    // /tx/:txid route to write.
    this.txIndex = new Map();   // txid -> { height, blockId, index }
    this.recordIndex = new Map(); // "app" and "app:key" -> [{...record hit}]
  }

  // ---- lifecycle ----------------------------------------------------------
  /**
   * Replay the on-disk chain, revalidating every block as if it had arrived from
   * a peer.
   *
   * STREAMED, one line at a time. This read the whole file into a single string
   * and split it, which throws ERR_STRING_TOO_LONG past V8's 536,870,888-byte
   * limit — about 350,000 blocks, or sixty-one days at a 15 s interval — after
   * which the node cannot start and its own chain is unreadable. See
   * src/lines.js for the whole argument and test/chain-replay.js for a chain
   * past that ceiling.
   *
   * AND A CORRUPT LINE NO LONGER KILLS THE PROCESS. `JSON.parse` was called
   * bare, so a single truncated append — a power cut mid-write is exactly that —
   * threw out of the constructor and the node would not boot. It is now counted
   * and skipped, and the count is emitted as `replay-rejected`, which is what
   * the account-model chain already did and what MAP.md §8 records as missing
   * here: a data directory holding an invalid block loads a SHORTER CHAIN, and
   * saying nothing about it leaves an operator to discover a height that went
   * backwards on their own.
   */
  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.store = new Map();
    this._addGenesis();
    if (!fs.existsSync(this.file)) return this;
    let rejected = 0, total = 0;
    readLines(this.file, line => {
      if (!line) return;                            // blank: not a block, not damage
      total++;
      /* Both the parse AND the ingest, because `_ingest` here THROWS on a
       * malformed block rather than returning `{ ok: false }` the way the
       * account model's does — `{"filler":1}` reaches `block.header.version` and
       * dies on undefined. So a line that is valid JSON and is not a block took
       * the node down at boot just as surely as a truncated one did.
       *
       * Caught at this boundary rather than by making `_ingest` defensive: it is
       * also `addBlock`, which is the hot path for peer blocks, and those are
       * already shape-checked by `UTXO_WIRE.isBlock` in src/p2p.js before they
       * reach it. Replay is the caller with untrusted input and no gate. */
      let b;
      try { b = JSON.parse(line); } catch { rejected++; return; }
      let r;
      try { r = this._ingest(b, /* persist */ false); } catch { rejected++; return; }
      if (r && !r.ok && r.err !== 'known') rejected++;
    }, {
      onOversized: () => { total++; rejected++; },
    });
    if (rejected) this.emit('replay-rejected', { rejected, total });
    return this;
  }

  genesis() {
    // Fixed, mined-free genesis. No premine: the coinbase pays a burn address
    // with amount 0, so genesis creates no spendable balance.
    const header = {
      version: 1, prevHash: '0'.repeat(64), height: 0,
      timestamp: 1750000000, target: P.GENESIS_TARGET,
      coinbasePub: '00', nonce: 0, powDigest: '00'.repeat(32), powSig: '00',
    };
    const cb = {
      version: 1, type: 'coinbase', height: 0, inputs: [],
      outputs: [{ address: P.COMMONS_ADDRESS, amount: 0 }],
    };
    cb.id = TX.txid(cb);
    header.merkleRoot = C.merkleRoot([cb.id]);
    return { header, txs: [cb], genesis: true };
  }

  _addGenesis() {
    const g = this.genesis();
    const id = BLOCK.blockId(g);
    this.store.set(id, { block: g, height: 0, work: 0n, id });
    this.tipId = id;
    this.chainIndex = [id];
    this.utxo = new Map();
    this.burned = 0;
    this.txIndex = new Map();
    this.recordIndex = new Map();
    this._applyBlock(g, this.utxo);
    this._index(g, id);
  }

  // ---- indexes ------------------------------------------------------------
  /** Index one block's transactions and records. Active chain only. */
  _index(block, blockId) {
    block.txs.forEach((tx, index) => {
      this.txIndex.set(tx.id, { height: block.header.height, blockId, index });
      for (const r of TX.txRecords(tx)) {
        const hit = {
          app: r.app, key: r.key, data: r.data,
          txid: tx.id, height: block.header.height, blockId,
          // who signed the transaction the record rode in, which is the only
          // authenticated notion of "sender" the chain has
          from: (tx.inputs || []).map(i => i.pub).filter(Boolean)
            .map(pub => C.addressFromPub(pub))[0] || null,
          timestamp: block.header.timestamp,
        };
        for (const k of [r.app, r.app + ':' + r.key]) {
          if (!this.recordIndex.has(k)) this.recordIndex.set(k, []);
          this.recordIndex.get(k).push(hit);
        }
      }
    });
  }

  _reindex(id) {
    this.txIndex = new Map();
    this.recordIndex = new Map();
    for (const e of this._fullChain(id)) this._index(e.block, e.id);
  }

  getTx(txid) {
    const at = this.txIndex.get(txid);
    if (!at) return null;
    const block = this.store.get(at.blockId);
    if (!block) return null;
    return {
      tx: block.block.txs[at.index],
      height: at.height,
      blockId: at.blockId,
      confirmations: this.height - at.height + 1,
    };
  }

  /** Records for an app, or for one key within it, oldest first. */
  getRecords(app, key, { since = 0, limit = 100 } = {}) {
    const hits = this.recordIndex.get(key ? app + ':' + key : app) || [];
    return hits.filter(h => h.height >= since).slice(0, limit);
  }

  /** Sparks a block destroys: every non-coinbase tx burns its required fee. */
  _burnedIn(block) {
    let n = 0;
    for (const tx of block.txs) if (tx.type !== 'coinbase') n += TX.requiredFee(tx);
    return n;
  }

  // ---- accessors ----------------------------------------------------------
  get height() { return this.store.get(this.tipId).height; }
  get tip() { return this.store.get(this.tipId).block; }
  getBlock(h) { const id = this.chainIndex[h]; return id ? this.store.get(id).block : undefined; }
  getById(id) { const e = this.store.get(id); return e ? e.block : null; }

  balance(address) {
    let bal = 0;
    for (const o of this.utxo.values()) if (o.address === address) bal += o.amount;
    return bal;
  }

  /** Every unspent output an address controls, with what a spender needs to
   *  know about it. `coinbase`/`height` used to be dropped here, so the only
   *  caller — the CLI wallet — could not tell a spendable coin from a maturing
   *  one and built transactions the chain then rejected at tx.js. */
  utxosFor(address) {
    const out = [];
    for (const [k, o] of this.utxo) if (o.address === address) {
      const [txid, vout] = k.split(':');
      out.push({ txid, vout: Number(vout), amount: o.amount, coinbase: !!o.coinbase, height: o.height });
    }
    return out;
  }

  supply() {
    let s = 0;
    for (const o of this.utxo.values()) s += o.amount;
    return s;
  }

  // ---- helpers: branch walking --------------------------------------------
  _slice(id, n) {                 // up to n entries ending at id, oldest-first
    const out = [];
    let cur = id;
    while (cur && out.length < n) {
      const e = this.store.get(cur);
      if (!e) break;
      out.push(e);
      if (e.height === 0) break;
      cur = e.block.header.prevHash;
    }
    out.reverse();
    return out;
  }

  _fullChain(id) {                // genesis..id, oldest-first
    const out = [];
    let cur = id;
    while (cur) {
      const e = this.store.get(cur);
      if (!e) break;
      out.push(e);
      if (e.height === 0) break;
      cur = e.block.header.prevHash;
    }
    out.reverse();
    return out;
  }

  _blockWork(targetHex) { return TWO256 / (BigInt('0x' + targetHex) + 1n); }

  _medianTimePast(parentId) {
    const slice = this._slice(parentId, P.MEDIAN_TIME_SPAN);
    const ts = slice.map(e => e.block.header.timestamp).sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  }

  // ---- difficulty (branch-aware LWMA) -------------------------------------
  nextTarget() { return this._nextTarget(this.tipId); }

  _nextTarget(parentId) {
    const parent = this.store.get(parentId);
    if (!parent || parent.height < 2) return P.GENESIS_TARGET;
    const window = Math.min(P.LWMA_WINDOW, parent.height);
    const slice = this._slice(parentId, window + 1); // window solve-times
    let weightedTime = 0, weightSum = 0, targetSum = 0n;
    for (let i = 1; i < slice.length; i++) {
      const dt = slice[i].block.header.timestamp - slice[i - 1].block.header.timestamp;
      const solve = Math.max(1, Math.min(dt, P.TARGET_BLOCK_TIME * 6));
      const w = i;
      weightedTime += solve * w;
      weightSum += w;
      targetSum += BigInt('0x' + slice[i].block.header.target);
    }
    const n = slice.length - 1;
    const avgTarget = targetSum / BigInt(n);
    const avgSolve = weightedTime / weightSum;
    let next = avgTarget * BigInt(Math.round(avgSolve * 1000)) / BigInt(P.TARGET_BLOCK_TIME * 1000);
    const min = BigInt('0x' + P.MIN_TARGET);
    const max = BigInt('0x' + P.MAX_TARGET);
    if (next < min) next = min;
    if (next > max) next = max;
    return next.toString(16).padStart(64, '0');
  }

  // ---- validation ---------------------------------------------------------
  /**
   * Validate a block against `parent` and a UTXO snapshot.
   *
   * The order of the checks below is a DoS property, not a style choice. Cost
   * per check, in round numbers: the header rules are a handful of comparisons
   * and a walk of at most 60 stored headers; `verifyPow` is a full Homefire
   * evaluation (~8,450 sequential SHA-256 rounds, ~5ms of a core); the canonical
   * serialization is up to MAX_BLOCK_BYTES of JSON; the transaction loop is up
   * to MAX_BLOCK_TXS signature verifications. So everything an anonymous peer
   * can make us do is gated behind the proof, and the proof itself is gated
   * behind the checks that cost nothing.
   *
   * `pow` lets a caller that has ALREADY verified the proof hand the result in.
   * The fork path in _ingest does exactly that, and used to pay for a second
   * full Homefire evaluation of the same header for no reason.
   */
  _validate(block, parent, utxo, pow = null) {
    const hdr = block.header;
    if (hdr.height !== parent.height + 1) return { ok: false, err: 'bad height' };
    if (!Array.isArray(block.txs) || block.txs.length === 0) return { ok: false, err: 'no txs' };
    if (block.txs.length > P.MAX_BLOCK_TXS) return { ok: false, err: 'block too large' };

    // timestamp bounds (H2)
    const now = Math.floor(Date.now() / 1000);
    if (hdr.timestamp > now + P.MAX_FUTURE_DRIFT_S) return { ok: false, err: 'timestamp too far in future' };
    if (hdr.timestamp <= this._medianTimePast(parent.id)) return { ok: false, err: 'timestamp <= median-time-past' };

    if (hdr.target !== this._nextTarget(parent.id)) return { ok: false, err: 'wrong difficulty target' };

    if (!pow) pow = BLOCK.verifyPow(block);
    if (!pow.ok) return pow;

    // A count limit is not a size limit. Checked after the proof and before the
    // signature work below, so an oversized block costs one serialization and
    // not 5,000 verifications — and costs an unproven peer nothing at all.
    if (Buffer.byteLength(C.canonical(block)) > P.MAX_BLOCK_BYTES)
      return { ok: false, err: 'block exceeds max bytes' };

    // transactions
    const scratch = new Map(utxo);
    let fees = 0, burnable = 0;
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];
      if (i === 0) {
        if (tx.type !== 'coinbase') return { ok: false, err: 'first tx must be coinbase' };
        if (tx.inputs && tx.inputs.length) return { ok: false, err: 'coinbase has inputs' };
        // A coinbase is not signed by anyone, so a record in one would be an
        // unauthenticated write that the miner alone chooses.
        if (TX.txRecords(tx).length) return { ok: false, err: 'coinbase carries records' };
        continue;
      }
      if (tx.type === 'coinbase') return { ok: false, err: 'extra coinbase' };
      const r = TX.validateNormal(tx, scratch, hdr.height); // enforces maturity
      if (!r.ok) return r;
      TX.applyToUtxo(tx, scratch, hdr.height);
      fees += r.fee;
      burnable += r.required;   // base fee + the data fee, both destroyed
    }

    // coinbase reward + anti-inflation (C1)
    const cb = block.txs[0];
    if (cb.outputs.length === 0 || cb.outputs.length > 2) return { ok: false, err: 'bad coinbase output count' };
    for (const o of cb.outputs) {
      if (!Number.isInteger(o.amount) || o.amount < 0 || o.amount > P.MAX_MONEY)
        return { ok: false, err: 'bad coinbase output amount' };
    }
    const tips = fees - burnable;
    const subsidy = P.subsidy(hdr.height);
    const commons = Math.floor(subsidy * P.COMMONS_SHARE);
    const expectMiner = subsidy - commons + tips;
    if (!cb.outputs[0] || cb.outputs[0].amount !== expectMiner)
      return { ok: false, err: 'bad miner reward' };
    if (commons > 0) {
      const gotCommons = cb.outputs.find(o => o.address === P.COMMONS_ADDRESS);
      if (!gotCommons || gotCommons.amount !== commons) return { ok: false, err: 'bad commons reward' };
    }
    const totalMinted = cb.outputs.reduce((s, o) => s + o.amount, 0);
    if (totalMinted !== subsidy + tips) return { ok: false, err: 'coinbase over-mint' };

    return { ok: true, id: pow.id, fees, burned: burnable };
  }

  // ---- append / fork choice ----------------------------------------------
  addBlock(block) { return this._ingest(block, true); }

  _ingest(block, persist) {
    const id = BLOCK.blockId(block);
    if (this.store.has(id)) return { ok: false, err: 'known' };
    const hdr = block.header;
    const parent = this.store.get(hdr.prevHash);
    if (!parent) return { ok: false, err: 'unknown parent' };

    if (hdr.prevHash === this.tipId) {
      // fast path: extend the active tip
      const r = this._validate(block, parent, this.utxo);
      if (!r.ok) return r;
      this._applyBlock(block, this.utxo);
      this.burned += r.burned;
      const work = parent.work + this._blockWork(hdr.target);
      this.store.set(id, { block, height: hdr.height, work, id });
      this.tipId = id;
      this.chainIndex[hdr.height] = id;
      this._index(block, id);
      if (persist) this._persist(block);
      this.emit('block', block);
      return { ok: true, id };
    }

    // fork: prove the work BEFORE _stateAt, which replays the UTXO set from
    // genesis — otherwise a remote peer buys a full replay with an unproven block
    if (!Array.isArray(block.txs) || block.txs.length === 0) return { ok: false, err: 'no txs' };
    if (hdr.target !== this._nextTarget(hdr.prevHash)) return { ok: false, err: 'wrong difficulty target' };
    const pw = BLOCK.verifyPow(block);
    if (!pw.ok) return pw;

    // fork: validate against the state at the block's parent. The proof is
    // already verified above; hand it in rather than paying for it twice.
    const parentState = this._stateAt(hdr.prevHash);
    const r = this._validate(block, parent, parentState.utxo, pw);
    if (!r.ok) return r;
    const work = parent.work + this._blockWork(hdr.target);
    this.store.set(id, { block, height: hdr.height, work, id });
    if (persist) this._persist(block);

    // most-cumulative-work rule: reorg if this branch now wins
    if (work > this.store.get(this.tipId).work) {
      const from = this.height;
      this._activate(id);
      this.emit('reorg', { from, to: hdr.height, tip: id });
      this.emit('block', block);
    }
    return { ok: true, id };
  }

  _applyBlock(block, utxo) {
    for (const tx of block.txs) {
      if (tx.type !== 'coinbase') for (const inp of tx.inputs) utxo.delete(inp.txid + ':' + inp.vout);
      const coinbase = tx.type === 'coinbase';
      tx.outputs.forEach((o, vout) => {
        if (o.amount > 0) utxo.set(tx.id + ':' + vout,
          { address: o.address, amount: o.amount, coinbase, height: block.header.height });
      });
    }
  }

  _stateAt(id) {
    const chain = this._fullChain(id);
    const utxo = new Map();
    let burned = 0;
    for (const e of chain) {
      this._applyBlock(e.block, utxo);
      burned += this._burnedIn(e.block);
    }
    return { utxo, burned };
  }

  _activate(id) {
    this.tipId = id;
    const chain = this._fullChain(id);
    this.chainIndex = [];
    for (const e of chain) this.chainIndex[e.height] = e.id;
    const st = this._stateAt(id);
    this.utxo = st.utxo;
    this.burned = st.burned;
    // A reorg unwrites records too — a message on an orphaned branch was never
    // sent as far as the chain is concerned.
    this._reindex(id);
  }

  _persist(block) { fs.appendFileSync(this.file, JSON.stringify(block) + '\n'); }
}

module.exports = { Chain };
