'use strict';
/* Polite solo miner. Assembles a candidate block, then searches nonces on a
 * setImmediate loop so the node stays responsive (event loop never blocks).
 * A CPU-throttle knob emulates "polite mining" (mine a fraction of the time). */

const C = require('./crypto');
const P = require('./params');
const TX = require('./tx');
const POW = require('./pow');
const BLOCK = require('./block');

class Miner {
  constructor(node) {
    this.node = node;
    this.running = false;
    this.throttle = 1.0;     // 1.0 = full; 0.35 = polite (~35% duty cycle)
    this.hashes = 0;
    this.hashrate = 0;
    this._rateStart = 0;
  }

  start() { if (!this.running) { this.running = true; this._rateStart = Date.now(); this._mineOne(); } }
  stop() { this.running = false; }

  _candidate() {
    const { chain, mempool, wallet } = this.node;
    const key = wallet.keyForAddress(this.node.minerAddress) || wallet.keys[0];
    const height = chain.height + 1;
    const picked = mempool.select();
    const fees = picked.length * 0; // computed precisely below
    // compute total fees from selected txs
    let totalFee = 0;
    const scratch = new Map(chain.utxo);
    const valid = [];
    for (const tx of picked) {
      const r = TX.validateNormal(tx, scratch, height); // enforce maturity while selecting
      if (!r.ok) continue;
      TX.applyToUtxo(tx, scratch, height);
      totalFee += r.fee;
      valid.push(tx);
    }
    const burnable = valid.length * P.BASE_FEE_SPARKS;
    const tips = totalFee - burnable;
    const coinbase = TX.coinbase(height, key.address, tips);
    const txs = [coinbase, ...valid];
    const header = {
      version: 1,
      prevHash: BLOCK.blockId(chain.tip),
      merkleRoot: C.merkleRoot(txs.map(t => t.id)),
      height,
      // strictly increasing past the parent so it always clears median-time-past
      timestamp: Math.max(Math.floor(this.node.now() / 1000), chain.tip.header.timestamp + 1),
      target: chain.nextTarget(),
      coinbasePub: key.pub,
      nonce: 0,
    };
    return { header, txs, key, coreHash: BLOCK.coreHash(header) };
  }

  _mineOne() {
    if (!this.running) return;
    let cand = this._candidate();
    const BATCH = 150;              // nonces per event-loop turn
    const startHeight = cand.header.height;

    const step = () => {
      if (!this.running) return;
      if (this.node.chain.height + 1 !== startHeight) { // someone mined; rebuild
        return this._mineOne();
      }
      for (let i = 0; i < BATCH; i++) {
        const nonce = cand.header.nonce++;
        const seed = POW.powSeed(cand.coreHash, nonce, cand.header.coinbasePub);
        const digest = POW.homefireHash(seed).toString('hex');
        this.hashes++;
        if (POW.meetsTarget(digest, cand.header.target)) {
          cand.header.nonce = nonce;   // pin the winning nonce (it was post-incremented)
          cand.header.powDigest = digest;
          cand.header.powSig = C.sign(cand.key.priv, Buffer.from(digest, 'hex'));
          const block = { header: cand.header, txs: cand.txs };
          this.node.onMinedBlock(block);
          return this._mineOne();  // start next
        }
      }
      // hashrate bookkeeping
      const dt = (Date.now() - this._rateStart) / 1000;
      if (dt >= 1) { this.hashrate = Math.round(this.hashes / dt); this.hashes = 0; this._rateStart = Date.now(); }
      // polite throttle: idle for part of the duty cycle
      if (this.throttle >= 1) setImmediate(step);
      else setTimeout(step, Math.round((1 - this.throttle) * 12));
    };
    step();
  }
}

module.exports = { Miner };
