'use strict';
/* HTTP API for wallets, explorers and merchants. Built on Node's http module.
 *   REST:   GET  /info /supply /blocks /block/:id /address/:addr /mempool
 *           GET  /tx/:txid          (one transaction + its confirmation depth)
 *           GET  /records?app=&key= (application records on the active chain)
 *   submit: POST /tx        (broadcast a signed tx)
 *   JSONRPC POST /rpc       ({method, params})
 *   live:   GET  /events    (SSE: new blocks, or ?app= for that app's records)
 * CORS is open so a browser front-end on any origin can talk to it. The static
 * pages that motivated this were deleted in 48bc28a; the setting stays because the
 * estate's own surfaces are separately hosted and are cross-origin by construction. */

const http = require('http');
const P = require('./params');
const C = require('./crypto');
const TX = require('./tx');
const BLOCK = require('./block');
const { openSseStream } = require('./sse');

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(s);
}

function blockSummary(node, b) {
  const id = BLOCK.blockId(b);
  return {
    height: b.header.height,
    id,
    timestamp: b.header.timestamp,
    miner: b.txs[0].outputs[0].address,
    txCount: b.txs.length,
    reward: b.txs[0].outputs[0].amount,
    target: b.header.target,
    hashPreview: id.slice(0, 16),
  };
}

class RPC {
  constructor(node) { this.node = node; this.sseClients = new Set(); }

  listen(port) {
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', e => this.node.error('rpc listen failed', { port, err: String(e && e.message || e) }));
    this.server.listen(port, () => this.node.log(`rpc/http listening on :${port}`, { port }));
    // push new blocks to SSE subscribers
    this.node.chain.on('block', b => {
      this._emit('block', blockSummary(this.node, b), null);
      // An application waiting on its own records should not have to poll every
      // block and diff. Records are pushed as their own event, filterable by
      // namespace and key, so a chat client subscribes to exactly its inbox.
      for (const tx of b.txs) {
        for (const r of TX.txRecords(tx)) {
          this._emit('record', {
            app: r.app, key: r.key, data: r.data, txid: tx.id,
            height: b.header.height, timestamp: b.header.timestamp,
            from: (tx.inputs || []).map(i => i.pub).filter(Boolean)
              .map(pub => C.addressFromPub(pub))[0] || null,
          }, r);
        }
      }
    });
  }

  /**
   * Send one SSE event to every client whose filter accepts it.
   *
   * Block frames stay UNNAMED. An SSE frame with `event:` only reaches
   * addEventListener(name), not onmessage — so naming these would have silently
   * stopped every existing client's live updates, including the explorer's.
   */
  _emit(event, payload, record) {
    const data = (event === 'block' ? '' : `event: ${event}\n`) + `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.sseClients) {
      if (record && c.cfApp && (c.cfApp !== record.app || (c.cfKey && c.cfKey !== record.key))) continue;
      if (!record && c.cfApp) continue;   // a filtered subscriber asked for records, not blocks
      try { c.write(data); } catch { this.sseClients.delete(c); }
    }
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'OPTIONS') return json(res, 204, {});

    /* EVERY ROUTE, WHILE THE CHAIN IS STILL LOADING. This port is bound before
     * the data directory has been replayed (src/node.js `start`), and every
     * answer available in that window — a height, a supply, an address balance,
     * a block by number — is internally consistent and stale by however far the
     * replay has got. 503 is retryable and reads as "not yet"; the body says how
     * far along it is. micro-org#349. */
    if (!this.node.ready) return json(res, 503, this.node.startupStatus());

    const started = Date.now();
    // one record per request, at debug so a busy node does not pay for it by
    // default — but a 5xx below is always reported
    res.on('finish', () => this.node.debug('rpc request', {
      method: req.method, path: p, status: res.statusCode, ms: Date.now() - started,
    }));

    try {
      if (p === '/info') return json(res, 200, this._info());
      if (p === '/supply') return json(res, 200, this._supply());
      if (p === '/blocks') {
        const limit = Math.min(100, Number(url.searchParams.get('limit') || 20));
        const out = [];
        for (let h = this.node.chain.height; h >= 0 && out.length < limit; h--)
          out.push(blockSummary(this.node, this.node.chain.getBlock(h)));
        return json(res, 200, { blocks: out });
      }
      if (p.startsWith('/block/')) {
        const id = p.slice('/block/'.length);
        const b = /^\d+$/.test(id) ? this.node.chain.getBlock(Number(id)) : this.node.chain.getById(id);
        return b ? json(res, 200, b) : json(res, 404, { err: 'not found' });
      }
      if (p.startsWith('/address/')) {
        const a = p.slice('/address/'.length);
        return json(res, 200, this._address(a));
      }
      if (p === '/mempool') return json(res, 200, { size: this.node.mempool.size, txs: this.node.mempool.list() });
      if (p.startsWith('/tx/')) {
        const found = this.node.chain.getTx(p.slice('/tx/'.length));
        return found ? json(res, 200, found) : json(res, 404, { err: 'not found' });
      }
      if (p === '/records') {
        const app = url.searchParams.get('app');
        if (!P.APP_NS_RE.test(app || '')) return json(res, 400, { err: 'app namespace required' });
        const key = url.searchParams.get('key') || '';
        if (key && !P.RECORD_KEY_RE.test(key)) return json(res, 400, { err: 'bad key' });
        const since = Math.max(0, Number(url.searchParams.get('since') || 0));
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        const records = this.node.chain.getRecords(app, key, { since, limit });
        return json(res, 200, { app, key: key || null, height: this.node.chain.height, records });
      }
      if (p === '/mining/template') {
        const pub = (url.searchParams.get('pub') || '').toLowerCase();
        // An SPKI-DER Ed25519 key is 44 bytes; anything else cannot own a
        // coinbase, so refuse before building a candidate for it.
        if (!/^[0-9a-f]{88}$/.test(pub)) return json(res, 400, { err: 'pub must be an 88-char SPKI DER hex Ed25519 key' });
        return json(res, 200, this.node.templates.issue(pub));
      }
      if (p === '/events') return this._sse(req, res, url);

      if (req.method === 'POST' && (p === '/tx' || p === '/rpc' || p === '/mining/submit')) {
        const body = await readBody(req);
        if (p === '/tx') {
          const r = this.node.submitTx(body.tx || body);
          return json(res, r.ok ? 200 : 400, r);
        }
        if (p === '/mining/submit') {
          const r = this.node.templates.submit(body || {});
          if (r.ok) this.node.log('block from a remote miner', { height: r.height, id: r.id });
          // Stale work is 409, not 400: the miner did nothing wrong and should
          // pull a fresh template rather than treat this as a bug in itself.
          // Every way work goes stale — TTL, MAX_TEMPLATES eviction, a moved tip
          // — sets `stale` (src/retiredtemplates.js). What is left on the 400
          // side is a malformed field, or an id this node never issued.
          return json(res, r.ok ? 200 : r.stale ? 409 : 400, r);
        }
        return json(res, 200, this._rpc(body));
      }
      return json(res, 404, { err: 'no route' });
    } catch (e) {
      if (e && e.tooLarge) {
        this.node.warn('rpc body too large', { method: req.method, path: p, limit: MAX_BODY_BYTES });
        json(res, 413, { err: 'request body too large', maxBytes: MAX_BODY_BYTES });
        req.destroy();
        return;
      }
      // this used to be the whole story of a failing RPC: a 500 to the caller
      // and nothing at all on the node
      this.node.error('rpc request failed', {
        method: req.method, path: p, err: String(e && e.message || e), stack: e && e.stack,
      });
      return json(res, 500, { err: String(e && e.message || e) });
    }
  }

  _sse(req, res, url) {
    // Capped and heartbeated — see src/sse.js, which holds the reasoning for
    // both and is shared with src/evmnode.js so the two cannot drift.
    const opened = openSseStream({
      req,
      res,
      clients: this.sseClients,
      // ?app=chat[&key=ember1…] narrows the stream to one application's records.
      // Without a filter the stream stays what it always was: new blocks.
      decorate: (r) => {
        const app = url && url.searchParams.get('app');
        if (app && P.APP_NS_RE.test(app)) {
          r.cfApp = app;
          const key = url.searchParams.get('key');
          if (key && P.RECORD_KEY_RE.test(key)) r.cfKey = key;
        }
      },
    });
    if (!opened) {
      this.node.warn('refused an event subscriber: this node is at its stream limit', {
        limit: P.SSE_MAX_CLIENTS,
      });
    }
  }

  _info() {
    const c = this.node.chain;
    return {
      network: P.NETWORK, coin: P.COIN, height: c.height,
      tip: BLOCK.blockId(c.tip),
      hashrate: this.node.miner ? this.node.miner.hashrate : 0,
      mining: this.node.miner ? this.node.miner.running : false,
      peers: this.node.p2p ? this.node.p2p.peers.size : 0,
      mempool: this.node.mempool.size,
      difficultyTarget: c.nextTarget(),
      minerAddress: this.node.minerAddress,
    };
  }

  // Adds coinbase-maturity info on top of chain.utxosFor(), which omits it —
  // without this a wallet can't tell a spendable coin from a maturing one and
  // can only discover the difference by having a payment rejected.
  _address(a) {
    const c = this.node.chain;
    const spendHeight = c.height + 1;
    const utxos = [];
    let balance = 0, spendable = 0;
    for (const [k, o] of c.utxo) {
      if (o.address !== a) continue;
      const [txid, vout] = k.split(':');
      const matured = !o.coinbase || (o.height != null && (spendHeight - o.height) >= P.COINBASE_MATURITY);
      balance += o.amount;
      if (matured) spendable += o.amount;
      utxos.push({
        txid, vout: Number(vout), amount: o.amount,
        coinbase: !!o.coinbase, height: o.height, spendable: matured,
        maturesAtHeight: o.coinbase ? (o.height + P.COINBASE_MATURITY) : null,
      });
    }
    return { address: a, balance, spendable, immature: balance - spendable, height: c.height, utxos };
  }

  _supply() {
    const c = this.node.chain;
    let commons = c.balance(P.COMMONS_ADDRESS);
    return {
      circulating: c.supply(),
      circulatingEmber: c.supply() / P.SPARKS_PER_EMBER,
      commonsTreasury: commons,
      commonsEmber: commons / P.SPARKS_PER_EMBER,
      burnedTotal: c.burned,
      height: c.height,
      blockReward: P.subsidy(c.height + 1),
    };
  }

  _rpc(body) {
    const { method, params = {} } = body;
    const c = this.node.chain;
    switch (method) {
      case 'getinfo': return this._info();
      case 'getbalance': return { balance: c.balance(params.address) };
      case 'getblockcount': return { count: c.height };
      case 'sendtx': return this.node.submitTx(params.tx);
      default:
        this.node.warn('rpc unknown method', { method: String(method).slice(0, 64) });
        return { err: 'unknown method' };
    }
  }
}

/**
 * The largest POST body this API can legitimately receive is one transaction at
 * MAX_TX_BYTES, wrapped in a `{tx: …}` envelope or a `{method,params}` one. This
 * had no ceiling at all: under `access-control-allow-origin: *`, any page in any
 * browser could stream gigabytes into a node's heap, and so could anyone with
 * curl. Headroom over MAX_TX_BYTES, and nothing more.
 */
const MAX_BODY_BYTES = P.MAX_TX_BYTES + 8_192;

class BodyTooLarge extends Error {
  constructor() { super('request body too large'); this.tooLarge = true; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '', bytes = 0, over = false;
    req.on('data', d => {
      if (over) return;
      bytes += d.length;
      if (bytes > MAX_BODY_BYTES) {
        // Stop accumulating immediately, but leave the socket alive long enough
        // to answer 413 — a caller that is merely wrong deserves to be told so.
        // The handler destroys it once the response is out.
        over = true;
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      b += d;
    });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = { RPC, blockSummary };
