'use strict';
/* hearthd — wires chain + mempool + wallet + miner + p2p + rpc together. */

const path = require('path');
const P = require('./params');
const { Chain } = require('./chain');
const { Mempool } = require('./mempool');
const { Wallet } = require('./wallet');
const { Miner } = require('./miner');
const { P2P } = require('./p2p');
const { RPC } = require('./rpc');
const BLOCK = require('./block');

class Node {
  constructor(opts = {}) {
    this.opts = opts;
    this.dataDir = opts.dataDir || path.join(process.cwd(), 'data');
    this.chain = new Chain(this.dataDir).load();
    this.mempool = new Mempool(this.chain);
    this.wallet = new Wallet(this.dataDir).load();
    this.minerAddress = opts.minerAddress || this.wallet.primary;
    this.miner = new Miner(this);
    this.p2p = new P2P(this);
    this.rpc = new RPC(this);
    // keep mempool clean as blocks arrive
    this.chain.on('block', b => this.mempool.removeIncluded(b.txs.slice(1)));
  }

  now() { return Date.now(); }
  log(...a) { if (!this.opts.quiet) console.log('[hearthd]', ...a); }

  start() {
    this.rpc.listen(this.opts.rpcPort || P.DEFAULT_RPC_PORT);
    this.p2p.listen(this.opts.p2pPort || P.DEFAULT_P2P_PORT);
    for (const peer of (this.opts.peers || [])) this.p2p.connect(peer);
    if (this.opts.mine) { this.miner.throttle = this.opts.throttle || 1.0; this.miner.start(); this.log('mining as', this.minerAddress); }
    this.log(`ready · height ${this.chain.height} · ${P.NETWORK}/${P.COIN}`);
  }

  onMinedBlock(block) {
    const r = this.chain.addBlock(block);
    if (r.ok) {
      this.log(`⛏  mined block #${block.header.height} ${BLOCK.blockId(block).slice(0, 12)} · reward ${block.txs[0].outputs[0].amount / P.SPARKS_PER_EMBER} EMBER`);
      this.p2p.broadcast({ t: 'block', block });
    } else {
      this.log('mined block rejected:', r.err);
    }
  }

  submitTx(tx) {
    const r = this.mempool.add(tx);
    if (r.ok) this.p2p.broadcast({ t: 'tx', tx });
    return r;
  }
}

module.exports = { Node };
