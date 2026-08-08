'use strict';
/* hearthd on the account model — chain + mempool + miner + p2p + two HTTP servers.
 *
 * TWO PORTS, TWO PROTOCOLS, AND THAT IS THE POINT (docs/evm-spec.md §6):
 *
 *   :8545  `POST /`   Ethereum JSON-RPC 2.0. MetaMask's localhost default and what
 *                     every Hardhat and Foundry tutorial assumes, so a developer's
 *                     first guess is right. This is the URL that goes into
 *                     ethereum-lists/chains and gets cached in every wallet, so it
 *                     is fixed. 8546 is RESERVED for the v2 WebSocket endpoint.
 *   :8645  REST       /info /supply /mempool /mining/* /events — the shape the
 *                     existing explorer, faucet and browser miner already speak.
 *
 * They are separate servers rather than one server with a router because
 * `src/rpc.js` already answers `POST /rpc` with the legacy `{method:'getinfo'}`
 * shape. Anything eth_* pointed at that path gets HTTP 200 and a body that is not
 * JSON-RPC 2.0, which every client reports as an empty chain rather than as a
 * misconfiguration — a whole class of support question avoided by not sharing a
 * port at all.
 *
 * WHAT THIS NODE IS NOT. It is not the UTXO node in src/node.js and shares no
 * consensus code with it. Both exist during the transition: the UTXO chain still
 * carries the browser wallet, Forge Pay and the records applications, and the
 * account model carries everything with a 0x in front of it. `bin/hearthd.js --evm`
 * chooses.
 */

const http = require('http');

const P = require('./params');
const { keccak256 } = require('./crypto/keccak');
const { Blockchain } = require('./chain/blockchain');
const { Mempool } = require('./chain/mempool');
const { Miner, Templates } = require('./chain/miner');
const { RpcChain } = require('./chain/rpcadapter');
const HDR = require('./chain/header');
const { P2P } = require('./p2p');
const { JsonRpcServer } = require('./jsonrpc/server');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const FORMAT = process.env.HEARTH_LOG_FORMAT || (process.stdout.isTTY ? 'text' : 'json');
const MIN_LEVEL = LEVELS[String(process.env.HEARTH_LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const isFields = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error);
const text = v => (typeof v === 'string' ? v : v instanceof Error ? v.message : JSON.stringify(v));

/* The coinbase key and `ember()` now live in src/coinbase.js so that a miner or
 * a desktop app can have them without instantiating a chain. Re-exported below,
 * unchanged, so every existing importer of this module still works. */
const { ember, hexBuf, loadCoinbaseKey, keyFrom, newKey } = require('./coinbase');

class EvmNode {
  constructor(opts = {}) {
    this.opts = opts;
    this.dataDir = opts.dataDir || null;
    this.extraData = opts.extraData || '';

    this.chain = new Blockchain({ dataDir: this.dataDir, config: opts.genesis || null }).load();
    this.mempool = new Mempool({
      state: () => this.chain.stateAtTip(),
      gasLimit: () => this.chain.gasLimit,
      chainId: this.chain.chainId,
      minGasPrice: opts.minGasPrice === undefined ? P.EVM_MIN_GAS_PRICE : BigInt(opts.minGasPrice),
    });
    this.coinbaseKey = opts.coinbaseKey || loadCoinbaseKey(this.dataDir);
    this.minerAddress = this.coinbaseKey.addressHex;
    this.miner = new Miner(this);
    this.templates = new Templates(this);

    /* The seam src/p2p.js gossips against. Three functions, no more: an account
     * model block may be EMPTY, which the UTXO shape check would refuse. */
    this.wire = {
      isBlock: (b) => {
        if (!b || typeof b !== 'object' || !b.header || typeof b.header !== 'object') return false;
        const h = b.header;
        if (typeof h.prevHash !== 'string' || !/^[0-9a-f]{64}$/.test(h.prevHash)) return false;
        if (!Number.isInteger(h.height) || h.height < 1) return false;
        return Array.isArray(b.txs) && b.txs.length <= P.MAX_BLOCK_TXS;
      },
      blockId: (b) => { try { return HDR.hashHex(b.header); } catch { return 'x'.repeat(64); } },
      acceptTx: (_node, tx) => {
        if (typeof tx !== 'string' || !/^[0-9a-f]*$/i.test(tx) || tx.length % 2) return { ok: false };
        return this.mempool.add(Buffer.from(tx, 'hex'));
      },
    };
    this.p2p = new P2P(this);

    this.rpcChain = new RpcChain({
      chain: this.chain,
      mempool: this.mempool,
      submit: raw => this.submitRawTransaction(raw),
      gasPrice: opts.gasPrice === undefined ? P.EVM_MIN_GAS_PRICE : BigInt(opts.gasPrice),
      /* The two bounds on what an unauthenticated caller may make this process
       * do — see the note in params.js. Left as options rather than read from
       * params.js down there so that a suite can measure the clamp instead of
       * inferring it, and so an embedder with its own endpoint can widen them. */
      rpcGasCap: opts.rpcGasCap === undefined ? P.EVM_RPC_GAS_CAP : opts.rpcGasCap,
      rpcTimeBudgetMs: opts.rpcTimeBudgetMs === undefined ? P.EVM_RPC_TIME_BUDGET_MS : opts.rpcTimeBudgetMs,
      /* The four facts that belong to the NODE and not to the chain, which is
       * why they arrive as accessors: an adapter built without them leaves
       * net_peerCount / eth_mining / eth_hashrate / eth_coinbase absent rather
       * than answering a confident zero. Every one of them is already public on
       * the REST /info, so serving them over JSON-RPC discloses nothing new — it
       * only stops a node dashboard or an explorer health page from reporting a
       * live network as unreachable because it asked in the standard way. */
      peers: () => this.p2p.peers.size,
      mining: () => this.miner.running,
      hashrate: () => this.miner.hashrate,
      coinbase: () => this.coinbaseKey.address,
    });
    this.jsonrpc = new JsonRpcServer({
      chain: this.rpcChain,
      version: require('../package.json').version,
      logger: f => this.error(f.msg || 'jsonrpc error', f),
      maxBatchSize: opts.maxBatchSize,
      maxInFlightPerIp: opts.maxInFlightPerIp,
      /* OFF unless an operator asks for it — see params.js. This is the one
       * option here that changes WHICH METHODS EXIST, and it does so because on
       * a legacy-only chain the honest answer to eth_feeHistory is worse for
       * every measured client than -32601 is. */
      feeHistory: opts.feeHistory === undefined ? P.EVM_RPC_FEE_HISTORY : opts.feeHistory,
    });

    this.sseClients = new Set();

    /* Per-caller mining budgets, and the global one that is the actual bound.
     * See the long note at MINING_VERIFY_BURST in params.js: the endpoints are
     * unauthenticated on purpose and metered because one of them reaches the
     * same full Homefire evaluation a gossip peer is already metered for. */
    this.miningClients = new Map();          // client -> { verify, template, at }
    this.miningGlobal = {
      verify: { tokens: P.MINING_VERIFY_BURST, at: Date.now() },
      template: { tokens: P.MINING_TEMPLATE_BURST, at: Date.now() },
    };

    this.chain.on('block', (block, entry) => {
      this.mempool.removeIncluded(entry.block.txs.map(t => keccak256(hexBuf(t)).toString('hex')));
      this.mempool.revalidate();
      this._emitBlock(entry);
    });
    /* A reorg un-mines transactions. Putting them back is not politeness: the
     * wallet that sent one stopped watching the moment it saw a receipt, and
     * without this it is simply gone. */
    this.chain.on('reorg', ({ from, to, tip, unwound }) => {
      let restored = 0;
      for (const raw of unwound) if (this.mempool.add(hexBuf(raw)).ok) restored++;
      this.mempool.revalidate();
      this.warn(`reorg ${from} → ${to}`, { from, to, tip, unwound: unwound.length, restored });
    });
    this.chain.on('replay-rejected', ({ rejected, total }) =>
      this.error('blocks on disk failed to replay', { rejected, total }));
  }

  now() { return Date.now(); }

  log(...a) { this._log('info', a); }
  debug(...a) { this._log('debug', a); }
  warn(...a) { this._log('warn', a); }
  error(...a) { this._log('error', a); }

  _log(level, args) {
    if (this.opts.quiet || LEVELS[level] < MIN_LEVEL) return;
    const fields = args.length && isFields(args[args.length - 1]) ? args.pop() : null;
    const msg = args.map(text).join(' ');
    if (FORMAT === 'text') {
      const extra = Object.entries(fields || {}).filter(([, v]) => !msg.includes(String(v)));
      const tail = extra.length ? ' · ' + extra.map(([k, v]) => `${k}=${v}`).join(' ') : '';
      return console.log('[hearthd]', level === 'info' ? msg + tail : `${level}: ${msg}${tail}`);
    }
    const rec = { level: LEVELS[level], time: Date.now(), service: 'hearthd', msg };
    for (const k in fields) if (!(k in rec)) rec[k] = fields[k];
    console.log(JSON.stringify(rec));
  }

  // ---- lifecycle -----------------------------------------------------------

  /* A PORT OF 0 MEANS "DO NOT LISTEN", on all four servers, and not "pick an
   * ephemeral one". The distinction exists because of `bin/hearth-mine.js`: a
   * miner on somebody's laptop dials out and serves nothing, and a listener on a
   * port nobody can be told about is not a feature — it is an open port on a
   * personal machine with no purpose. A suite that wants an ephemeral port calls
   * `listenRest(0)` / `listenJsonRpc(0)` / `p2p.listen(0)` directly, which is
   * what every one of them already does; only this function reads the option. */
  start() {
    if (this.opts.rpcPort !== 0) this.listenRest(this.opts.rpcPort === undefined ? P.DEFAULT_RPC_PORT : this.opts.rpcPort);
    if (this.opts.jsonRpcPort !== 0) this.listenJsonRpc(this.opts.jsonRpcPort === undefined ? P.DEFAULT_JSONRPC_PORT : this.opts.jsonRpcPort);
    /* `--p2p 0` means DO NOT LISTEN, not "pick a port". A miner dialling out to a
     * seed through a tunnel has nothing to serve and no reason to open a port on
     * a laptop; an ephemeral listener nobody can be told about is strictly worse
     * than none. (In-process suites bind 0 by calling p2p.listen directly.) */
    if (this.opts.p2pPort !== 0) this.p2p.listen(this.opts.p2pPort === undefined ? P.DEFAULT_P2P_PORT : this.opts.p2pPort);
    // Off unless asked for. A node behind a Cloudflare Tunnel can only be
    // reached this way — see params.js — but a node on a LAN has no use for it.
    if (this.opts.p2pWsPort) this.p2p.listenWs(this.opts.p2pWsPort);
    for (const peer of (this.opts.peers || [])) this.p2p.connect(peer);
    if (this.opts.mine) {
      this.miner.throttle = this.opts.throttle || 1.0;
      this.miner.start();
      this.log(`mining to ${this.minerAddress}`, { minerAddress: this.minerAddress, throttle: this.miner.throttle });
    }
    this.log(`ready · height ${this.chain.height} · chain ${this.chain.chainId} · ${P.COIN}`, {
      height: this.chain.height, chainId: this.chain.chainId, genesis: this.chain.genesisId,
    });
  }

  close() {
    this.miner.stop();
    this.p2p.close();
    if (this.restServer) this.restServer.close();
    if (this.jsonrpcServer) this.jsonrpcServer.close();
    for (const c of this.sseClients) { try { c.end(); } catch { /* already gone */ } }
    this.sseClients.clear();
  }

  listenJsonRpc(port) {
    this.jsonrpcServer = http.createServer(this.jsonrpc.httpListener());
    keepAlive(this.jsonrpcServer);
    this.jsonrpcServer.on('error', e => this.error('json-rpc listen failed', { port, err: String(e && e.message || e) }));
    this.jsonrpcServer.listen(port, () => this.log(`eth json-rpc listening on :${this.jsonrpcServer.address().port}/`,
      { port: this.jsonrpcServer.address().port }));
    return this.jsonrpcServer;
  }

  // ---- block and transaction flow -----------------------------------------

  onMinedBlock(block) {
    const r = this.acceptOwnBlock(block);
    if (r.ok) {
      const reward = P.subsidyWei(block.header.height);
      this.log(`⛏  mined block #${block.header.height} ${r.id.slice(0, 12)} · ${block.txs.length} tx · reward ${ember(reward)} EMBER`,
        { height: block.header.height, blockId: r.id, txCount: block.txs.length, gasUsed: block.header.gasUsed });
    } else {
      /* Our own block failing to apply is a bug in us, not a peer misbehaving —
       * and on this chain it almost always means the candidate's state root and
       * the validator's disagree, which is the single most important thing to
       * find out loudly. */
      this.error('mined block rejected by our own validator', { height: block.header.height, err: r.err });
    }
    return r;
  }

  acceptOwnBlock(block) {
    const r = this.chain.addBlock(block);
    if (r.ok) this.p2p.broadcast({ t: 'block', block });
    return r;
  }

  /** `eth_sendRawTransaction`: pool it, gossip it, answer with its hash. */
  submitRawTransaction(raw) {
    const r = this.mempool.add(raw);
    if (!r.ok) {
      this.debug('tx rejected', { code: r.code, err: r.error });
      return { ok: false, error: r.error || r.code };
    }
    const hex = Buffer.from(raw).toString('hex');
    this.p2p.broadcast({ t: 'tx', tx: hex });
    return { ok: true, hash: hexBuf(r.hash) };
  }

  // ---- the REST surface ----------------------------------------------------

  _emitBlock(entry) {
    if (!this.sseClients.size) return;
    const payload = JSON.stringify(this._blockSummary(entry));
    for (const c of this.sseClients) {
      try { c.write(`data: ${payload}\n\n`); } catch { this.sseClients.delete(c); }
    }
  }

  _blockSummary(entry) {
    const h = entry.block.header;
    return {
      height: h.height,
      hash: '0x' + entry.id,
      timestamp: h.timestamp,
      miner: h.height === 0 ? null : '0x' + HDR.coinbaseAddress(h.coinbasePub).toString('hex'),
      txCount: entry.block.txs.length,
      gasUsed: h.gasUsed,
      gasLimit: h.gasLimit,
      target: h.target,
      difficulty: HDR.difficulty(h.target).toString(),
      totalDifficulty: entry.work.toString(),
      size: entry.size,
    };
  }

  info() {
    return {
      network: P.NETWORK,
      coin: P.COIN,
      model: 'account',
      chainId: this.chain.chainId,
      height: this.chain.height,
      tip: '0x' + this.chain.tipId,
      genesis: '0x' + this.chain.genesisId,
      /* Consensus, and NOT covered by the genesis hash — block 0 does not commit to
       * where the Commons share is paid, so two nodes can match on `genesis` and
       * still fork at block 1. The p2p handshake compares it (see p2p.js `_binding`);
       * this is how an operator reads the value the refusal is talking about. */
      commonsAddress: this.chain.config.commonsAddress,
      totalDifficulty: this.chain.totalDifficulty.toString(),
      hashrate: this.miner.hashrate,
      mining: this.miner.running,
      peers: this.p2p.peers.size,
      mempool: this.mempool.size,
      difficultyTarget: this.chain.nextTarget(),
      minerAddress: this.minerAddress,
      gasLimit: Number(this.chain.gasLimit),
      /* What an eth_call on this node is actually allowed to do. Published because
       * a caller whose estimate came back clamped, or whose call came back
       * `execution timeout`, otherwise has no way to find out what the limits were
       * — and because an operator who raised them wants to see that it took. */
      rpcGasCap: Number(this.rpcChain.rpcGasCap),
      rpcTimeBudgetMs: this.rpcChain.rpcTimeBudgetMs,
      jsonRpc: `:${this.opts.jsonRpcPort === undefined ? P.DEFAULT_JSONRPC_PORT : this.opts.jsonRpcPort}/`,
    };
  }

  /**
   * Supply, in plain decimal — spec §6 asks for exactly this, because there is no
   * `eth_*` method that can answer it and an aggregator that cannot read a supply
   * figure models one from the emission schedule and drifts.
   *
   * `circulating` excludes the Commons share, which is the honest reading while the
   * Commons address is the zero address and the share is therefore burned.
   */
  supply() {
    const s = this.chain.supply();
    const commonsBalance = this.chain.stateAtTip().getBalance(this.chain.commonsAddress);
    return {
      height: s.height,
      decimals: 18,
      symbol: P.COIN,
      totalSupply: (s.minted).toString(),
      totalSupplyEmber: ember(s.minted),
      circulating: (s.minted - s.commons).toString(),
      circulatingEmber: ember(s.minted - s.commons),
      commonsAddress: this.chain.config.commonsAddress,
      commonsIssued: s.commons.toString(),
      commonsBalance: commonsBalance.toString(),
      commonsIsBurnAddress: /^0x0{40}$/.test(this.chain.config.commonsAddress),
      blockReward: P.subsidyWei(s.height + 1).toString(),
    };
  }

  // ---- mining budgets ------------------------------------------------------

  /**
   * Who to bill. Behind a Cloudflare Tunnel every request arrives from the
   * tunnel's own address, so the forwarded header is the only thing that tells
   * two miners apart — and anything can set it. That is why this is used for
   * FAIRNESS between callers and never as the bound: `_miningSpend` also charges
   * a global bucket, which no header can dodge. Truncated so a caller cannot
   * grow the key space with long junk.
   */
  _miningClient(req) {
    const h = req.headers['cf-connecting-ip']
      || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return String(h || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 45);
  }

  /** The named bucket for a caller, creating it and evicting the oldest if full. */
  _miningBudget(client, kind) {
    let e = this.miningClients.get(client);
    if (e) { this.miningClients.delete(client); }        // re-insert: Map keeps insertion order
    else {
      e = {
        verify: { tokens: P.MINING_VERIFY_BURST, at: Date.now() },
        template: { tokens: P.MINING_TEMPLATE_BURST, at: Date.now() },
      };
      // Oldest-seen out. The cap is the whole reason this is not a leak.
      while (this.miningClients.size >= P.MINING_MAX_CLIENTS) {
        this.miningClients.delete(this.miningClients.keys().next().value);
      }
    }
    this.miningClients.set(client, e);
    return e[kind];
  }

  /** p2p.js `_spend`, to the letter — one implementation of one rule, twice used. */
  _take(bucket, burst, perSecond) {
    const now = Date.now();
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Take a token for `kind` from both the caller's bucket and the global one.
   *
   * Returns a handle whose `refund()` gives both back — called when the outcome
   * shows the work was not wasted, which is what keeps an honest miner off the
   * limiter entirely. Returns null when either bucket is empty.
   */
  _miningSpend(req, kind) {
    const burst = kind === 'verify' ? P.MINING_VERIFY_BURST : P.MINING_TEMPLATE_BURST;
    const perS = kind === 'verify' ? P.MINING_VERIFY_PER_S : P.MINING_TEMPLATE_PER_S;
    const mine = this._miningBudget(this._miningClient(req), kind);
    const all = this.miningGlobal[kind];
    if (!this._take(mine, burst, perS)) return null;
    if (!this._take(all, burst, perS)) { mine.tokens = Math.min(burst, mine.tokens + 1); return null; }
    return {
      refund: () => {
        mine.tokens = Math.min(burst, mine.tokens + 1);
        all.tokens = Math.min(burst, all.tokens + 1);
      },
    };
  }

  listenRest(port) {
    this.restServer = http.createServer((req, res) => this._rest(req, res));
    keepAlive(this.restServer);
    this.restServer.on('error', e => this.error('rest listen failed', { port, err: String(e && e.message || e) }));
    this.restServer.listen(port, () => this.log(`rest/http listening on :${this.restServer.address().port}`,
      { port: this.restServer.address().port }));
    return this.restServer;
  }

  async _rest(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (code, body) => {
      res.writeHead(code, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, {});
    try {
      if (p === '/info') return send(200, this.info());
      if (p === '/supply') return send(200, this.supply());
      if (p === '/mempool') return send(200, { size: this.mempool.size, txs: this.mempool.list() });
      if (p === '/mining/template') {
        const pub = (url.searchParams.get('pub') || '').toLowerCase();
        const budget = this._miningSpend(req, 'template');
        if (!budget) return send(429, { err: 'too many work requests — slow down', retryAfterMs: 1000 });
        try { return send(200, this.templates.issue(pub)); }
        catch (e) {
          // A malformed key is refused before a candidate is built, so it cost
          // nothing and is charged nothing.
          budget.refund();
          return send(400, { err: String(e.message || e) });
        }
      }
      if (p === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-cache',
          connection: 'keep-alive', 'access-control-allow-origin': '*',
        });
        res.write(': connected\n\n');
        this.sseClients.add(res);
        req.on('close', () => this.sseClients.delete(res));
        return undefined;
      }
      if (req.method === 'POST' && p === '/mining/submit') {
        const body = await readJson(req);
        /* The token is taken by `submit` itself, and only around the step that
         * actually hashes — an unknown template, a stale one or a malformed body
         * is refused before Homefire runs and must not be charged for, or a
         * miner whose template merely expired gets throttled for the node's
         * timing rather than its own behaviour. */
        let over = false;
        const r = this.templates.submit(body || {}, {
          spend: () => {
            const b = this._miningSpend(req, 'verify');
            if (!b) { over = true; return null; }
            return b;
          },
        });
        if (over) return send(429, { err: 'too many proofs to verify — slow down', retryAfterMs: 1000 });
        if (r.ok) this.log('block from a remote miner', { height: r.height, id: r.id });
        /* Stale is 409: the miner did nothing wrong and should pull fresh work.
         * That now covers every way work goes stale — TTL, MAX_TEMPLATES
         * eviction and a moved tip all set `stale` (src/retiredtemplates.js).
         * Only two things are left on the 400 side, and both are true faults in
         * the submission: a malformed field, and an id this node never issued. */
        return send(r.ok ? 200 : r.stale ? 409 : 400, r);
      }
      /* A developer who points a wallet at the REST port gets a pointer rather than
       * `{"err":"no route"}`, which is the single most likely first mistake. */
      if (req.method === 'POST') {
        return send(404, {
          err: 'this is the REST API — the Ethereum JSON-RPC endpoint is a different port',
          jsonRpc: `port ${this.opts.jsonRpcPort === undefined ? P.DEFAULT_JSONRPC_PORT : this.opts.jsonRpcPort}, path /`,
        });
      }
      return send(404, { err: 'no route' });
    } catch (e) {
      this.error('rest request failed', { path: p, err: String(e && e.message || e) });
      return send(500, { err: String(e && e.message || e) });
    }
  }
}

/**
 * Node's default idle keep-alive timeout is five seconds, which is SHORTER than
 * every mainstream client's connection-pool idle timeout — ethers, undici and Go's
 * http.Client all hold a socket longer than that. The result is a race nobody can
 * see coming: the server closes an idle pooled socket at the moment the client
 * writes its next request onto it, and the client reports ECONNRESET on a call that
 * never reached us. It surfaces as a wallet that "randomly" fails one poll in
 * twenty. 65 seconds is the usual reverse-proxy figure and puts the server on the
 * safe side of the race; `headersTimeout` must stay above it or it closes first.
 */
function keepAlive(server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

const MAX_REST_BODY = P.MAX_TX_BYTES + 8192;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = '', bytes = 0, over = false;
    req.on('data', d => {
      if (over) return;
      bytes += d.length;
      if (bytes > MAX_REST_BODY) { over = true; req.pause(); reject(new Error('request body too large')); return; }
      b += d;
    });
    req.on('end', () => { if (!over) { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } } });
    req.on('error', reject);
  });
}

module.exports = { EvmNode, loadCoinbaseKey, keyFrom, newKey, ember };
