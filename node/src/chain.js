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
  }

  // ---- lifecycle ----------------------------------------------------------
  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.store = new Map();
    this._addGenesis();
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) this._ingest(JSON.parse(l), /*persist*/ false); // re-validated on replay
    }
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
    this._applyBlock(g, this.utxo);
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

  utxosFor(address) {
    const out = [];
    for (const [k, o] of this.utxo) if (o.address === address) {
      const [txid, vout] = k.split(':');
      out.push({ txid, vout: Number(vout), amount: o.amount });
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
  _validate(block, parent, utxo) {
    const hdr = block.header;
    if (hdr.height !== parent.height + 1) return { ok: false, err: 'bad height' };
    if (!Array.isArray(block.txs) || block.txs.length === 0) return { ok: false, err: 'no txs' };
    if (block.txs.length > P.MAX_BLOCK_TXS) return { ok: false, err: 'block too large' };

    // timestamp bounds (H2)
    const now = Math.floor(Date.now() / 1000);
    if (hdr.timestamp > now + P.MAX_FUTURE_DRIFT_S) return { ok: false, err: 'timestamp too far in future' };
    if (hdr.timestamp <= this._medianTimePast(parent.id)) return { ok: false, err: 'timestamp <= median-time-past' };

    if (hdr.target !== this._nextTarget(parent.id)) return { ok: false, err: 'wrong difficulty target' };

    const pow = BLOCK.verifyPow(block);
    if (!pow.ok) return pow;

    // transactions
    const scratch = new Map(utxo);
    let fees = 0;
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];
      if (i === 0) {
        if (tx.type !== 'coinbase') return { ok: false, err: 'first tx must be coinbase' };
        if (tx.inputs && tx.inputs.length) return { ok: false, err: 'coinbase has inputs' };
        continue;
      }
      if (tx.type === 'coinbase') return { ok: false, err: 'extra coinbase' };
      const r = TX.validateNormal(tx, scratch, hdr.height); // enforces maturity
      if (!r.ok) return r;
      TX.applyToUtxo(tx, scratch, hdr.height);
      fees += r.fee;
    }

    // coinbase reward + anti-inflation (C1)
    const cb = block.txs[0];
    if (cb.outputs.length === 0 || cb.outputs.length > 2) return { ok: false, err: 'bad coinbase output count' };
    for (const o of cb.outputs) {
      if (!Number.isInteger(o.amount) || o.amount < 0 || o.amount > P.MAX_MONEY)
        return { ok: false, err: 'bad coinbase output amount' };
    }
    const burnable = (block.txs.length - 1) * P.BASE_FEE_SPARKS;
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

    // fork: validate against the state at the block's parent
    const parentState = this._stateAt(hdr.prevHash);
    const r = this._validate(block, parent, parentState.utxo);
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
      burned += Math.max(0, e.block.txs.length - 1) * P.BASE_FEE_SPARKS;
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
  }

  _persist(block) { fs.appendFileSync(this.file, JSON.stringify(block) + '\n'); }
}

module.exports = { Chain };
