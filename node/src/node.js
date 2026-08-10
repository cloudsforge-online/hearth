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
    /* CONSTRUCTED, NOT LOADED — see the same line in src/evmnode.js and
     * micro-org#349. The replay is an awaited step in `start()` now, because a
     * replay in a constructor is a boot that grows with the chain, blocks the
     * loop for the whole of its length and cannot say a word while it does. */
    this.chain = new Chain(this.dataDir);
    this.chain.on('replay-rejected', ({ rejected, total }) =>
      this.error('blocks on disk failed to replay', { rejected, total }));
    this.mempool = new Mempool(this.chain);
    this.wallet = new Wallet(this.dataDir).load();
    this.minerAddress = opts.minerAddress || this.wallet.primary;
    this.miner = new Miner(this);
    this.templates = new Templates(this);
    this.p2p = new P2P(this);
    this.rpc = new RPC(this);
    // keep mempool clean as blocks arrive. Not while replaying: a block on disk
    // is history rather than news, and the pool is empty at boot anyway.
    this.chain.on('block', b => {
      if (this.chain.replayPending) return;
      this.mempool.removeIncluded(b.txs.slice(1));
    });
  }

  /**
   * True when the chain this node holds is the chain in its data directory.
   *
   * src/rpc.js refuses every route while it is false, for the reason set out at
   * `ready` in src/evmnode.js: a half-replayed chain has a height, a supply and
   * an address balance for everything, and every one of them is wrong.
   */
  get ready() { return !this.chain.replayPending; }

  /** Where the replay has got to, for the refusal body while it runs. */
  startupStatus() {
    const p = this._replay || {};
    return {
      err: 'this node is starting: replaying its chain from disk',
      status: 'starting',
      replayed: p.blocks || 0,
      bytes: p.bytes || 0,
      totalBytes: p.totalBytes || 0,
      elapsedMs: p.elapsedMs || 0,
    };
  }

  /** Replay the data directory. Idempotent; `start()` awaits it. */
  async open() {
    if (!this.chain.replayPending) return this;
    const t0 = Date.now();
    this.log('replaying the chain from disk — this node refuses RPC until it has finished',
      { dataDir: this.dataDir });
    await this.chain.open({
      onProgress: (s) => {
        this._replay = s;
        if (s.done) return;
        const pct = s.totalBytes ? Math.min(100, Math.floor((s.bytes / s.totalBytes) * 100)) : 0;
        this.log(`replaying · ${s.blocks} blocks · height ${s.height} · ${pct}%`,
          { blocks: s.blocks, height: s.height, percent: pct, elapsedMs: s.elapsedMs });
      },
    });
    this.log(`replayed ${this.chain.height} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      { height: this.chain.height, ms: Date.now() - t0 });
    return this;
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

  /**
   * THE ORDER IS THE FIX (micro-org#349): bind, so a cold boot answers
   * "starting" instead of refusing connections; then replay, yielding as it
   * goes; then and only then join the network. Gossip and mining come last
   * because they are the two things that can WRITE — a miner on a half-replayed
   * tip signs a block thousands deep and gossips a fork of the live chain.
   */
  async start() {
    this.rpc.listen(this.opts.rpcPort || P.DEFAULT_RPC_PORT);
    await this.open();
    if (this.opts.p2pPort !== 0) this.p2p.listen(this.opts.p2pPort || P.DEFAULT_P2P_PORT);
    // Off unless asked for. A node behind a Cloudflare Tunnel can only be
    // reached this way — see params.js — but a node on a LAN has no use for it.
    if (this.opts.p2pWsPort) this.p2p.listenWs(this.opts.p2pWsPort);
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
