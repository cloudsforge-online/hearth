'use strict';
/* HTTP API for wallets, explorers and merchants. Built on Node's http module.
 *   REST:   GET  /info /supply /blocks /block/:id /address/:addr /mempool
 *   submit: POST /tx        (broadcast a signed tx)
 *   JSONRPC POST /rpc       ({method, params})
 *   live:   GET  /events    (Server-Sent Events: new blocks)
 * CORS is open so the static web/ front-ends can talk to it from anywhere. */

const http = require('http');
const P = require('./params');
const BLOCK = require('./block');

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
    this.server.listen(port, () => this.node.log(`rpc/http listening on :${port}`));
    // push new blocks to SSE subscribers
    this.node.chain.on('block', b => {
      const data = 'data: ' + JSON.stringify(blockSummary(this.node, b)) + '\n\n';
      for (const c of this.sseClients) { try { c.write(data); } catch {} }
    });
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'OPTIONS') return json(res, 204, {});

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
      if (p === '/events') return this._sse(req, res);

      if (req.method === 'POST' && (p === '/tx' || p === '/rpc')) {
        const body = await readBody(req);
        if (p === '/tx') {
          const r = this.node.submitTx(body.tx || body);
          return json(res, r.ok ? 200 : 400, r);
        }
        return json(res, 200, this._rpc(body));
      }
      return json(res, 404, { err: 'no route' });
    } catch (e) {
      return json(res, 500, { err: String(e && e.message || e) });
    }
  }

  _sse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': connected\n\n');
    this.sseClients.add(res);
    req.on('close', () => this.sseClients.delete(res));
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
      default: return { err: 'unknown method' };
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => (b += d));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = { RPC, blockSummary };
