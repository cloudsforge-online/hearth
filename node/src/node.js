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
const { Templates } = require('./mining');
const BLOCK = require('./block');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/* Containers get pino-shaped JSON because that is what the log aggregator
 * parses; a human at a terminal gets the prose this used to print always. */
const FORMAT = process.env.HEARTH_LOG_FORMAT || (process.stdout.isTTY ? 'text' : 'json');
const MIN_LEVEL = LEVELS[String(process.env.HEARTH_LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

// an Error is neither fields nor JSON: left alone it serializes to `{}`, which
// is the exact failure this logging is meant to end
const isFields = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error);
const text = v => (typeof v === 'string' ? v : v instanceof Error ? v.message : JSON.stringify(v));

class Node {
  constructor(opts = {}) {
    this.opts = opts;
    this.dataDir = opts.dataDir || path.join(process.cwd(), 'data');
    this.chain = new Chain(this.dataDir).load();
    this.mempool = new Mempool(this.chain);
    this.wallet = new Wallet(this.dataDir).load();
    this.minerAddress = opts.minerAddress || this.wallet.primary;
    this.miner = new Miner(this);
    this.templates = new Templates(this);
    this.p2p = new P2P(this);
    this.rpc = new RPC(this);
    // keep mempool clean as blocks arrive
    this.chain.on('block', b => this.mempool.removeIncluded(b.txs.slice(1)));
  }

  now() { return Date.now(); }

  log(...a) { this._log('info', a); }
  debug(...a) { this._log('debug', a); }
  warn(...a) { this._log('warn', a); }
  error(...a) { this._log('error', a); }

  /* A trailing plain object is structured fields rather than prose, so that
   * `error('block rejected', { height })` can be searched on height instead of
   * only matched as text. Everything before it is joined into the message. */
  _log(level, args) {
    if (this.opts.quiet || LEVELS[level] < MIN_LEVEL) return;
    const fields = args.length && isFields(args[args.length - 1]) ? args.pop() : null;
    const msg = args.map(text).join(' ');
    if (FORMAT === 'text') {
      // a field the sentence already states is noise to a human, and the
      // sentences here are written for humans
      const extra = Object.entries(fields || {}).filter(([, v]) => !msg.includes(String(v)));
      const tail = extra.length ? ' · ' + extra.map(([k, v]) => `${k}=${v}`).join(' ') : '';
      return console.log('[hearthd]', level === 'info' ? msg + tail : `${level}: ${msg}${tail}`);
    }
    const rec = { level: LEVELS[level], time: Date.now(), service: 'hearthd', msg };
    for (const k in fields) if (!(k in rec)) rec[k] = fields[k];
    console.log(JSON.stringify(rec));
  }

  start() {
    this.rpc.listen(this.opts.rpcPort || P.DEFAULT_RPC_PORT);
    this.p2p.listen(this.opts.p2pPort || P.DEFAULT_P2P_PORT);
    for (const peer of (this.opts.peers || [])) this.p2p.connect(peer);
    if (this.opts.mine) {
      this.miner.throttle = this.opts.throttle || 1.0;
      this.miner.start();
      this.log(`mining as ${this.minerAddress}`, { minerAddress: this.minerAddress, throttle: this.miner.throttle });
    }
    this.log(`ready · height ${this.chain.height} · ${P.NETWORK}/${P.COIN}`,
      { height: this.chain.height, network: P.NETWORK, coin: P.COIN, mining: this.miner.running });
  }

  onMinedBlock(block) {
    const r = this.chain.addBlock(block);
    const height = block.header.height;
    if (r.ok) {
      const id = BLOCK.blockId(block);
      const reward = block.txs[0].outputs[0].amount / P.SPARKS_PER_EMBER;
      this.log(`⛏  mined block #${height} ${id.slice(0, 12)} · reward ${reward} EMBER`,
        { height, blockId: id, reward, target: block.header.target, txCount: block.txs.length });
      this.p2p.broadcast({ t: 'block', block });
    } else {
      // our own block failing to apply is a bug in us, not a peer misbehaving
      this.error('mined block rejected', { height, err: r.err });
    }
  }

  submitTx(tx) {
    const r = this.mempool.add(tx);
    if (r.ok) this.p2p.broadcast({ t: 'tx', tx });
    else this.warn('tx rejected', { txid: tx && tx.id, err: r.err });
    return r;
  }
}

module.exports = { Node };
