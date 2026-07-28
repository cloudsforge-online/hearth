'use strict';
/* A JSON-RPC client, and the only place this service talks to a chain.
 *
 * It is deliberately a superset of tools/faucet/src/rpc.js rather than a
 * shared module: the faucet needs five methods and must stay auditable at a
 * glance, and this needs blocks, receipts and batching. Duplicating ~60 lines
 * is cheaper than a shared abstraction that both have to fit.
 *
 * Hex encoding is strict in both directions (docs/evm-spec.md §6): QUANTITY is
 * minimal-length — `0x0`, never `0x00` — and DATA is fixed-width.
 *
 * BATCHING MATTERS HERE. Indexing a block needs the block plus one receipt per
 * transaction. Serialised, that is N+1 round trips per block and an initial
 * sync that takes days. `eth_getBlockReceipts` (evm-spec §6 adds it to v1)
 * makes it two; where a node does not have it, we fall back to a single JSON-RPC
 * batch of N receipt requests, which is one round trip either way.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** QUANTITY: minimal-length hex, no leading zeros, `0x0` for zero. */
function quantity(n) {
  const v = BigInt(n);
  if (v < 0n) throw new RangeError('quantity cannot be negative');
  return '0x' + v.toString(16);
}

/** Tolerant on the way in: a node that emits `0x00` is wrong, not unusable. */
function big(hex) {
  if (hex === null || hex === undefined) return null;
  if (typeof hex === 'bigint') return hex;
  if (typeof hex === 'number') return BigInt(hex);
  const s = String(hex);
  return s.startsWith('0x') || s.startsWith('0X') ? BigInt(s) : BigInt(s);
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

class Rpc {
  constructor(url, { timeoutMs = 20_000 } = {}) {
    this.url = new URL(url);
    this.timeoutMs = timeoutMs;
    this.transport = this.url.protocol === 'https:' ? https : http;
    this.nextId = 1;
    /* keep-alive: an indexer opens one connection per block otherwise, and the
     * TCP handshake dominates the cost of a small batch. */
    this.agent = new this.transport.Agent({ keepAlive: true, maxSockets: 8 });
    this.calls = 0;
  }

  _post(payload) {
    const body = JSON.stringify(payload);
    this.calls++;
    return new Promise((resolve, reject) => {
      const req = this.transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port,
          path: this.url.pathname + this.url.search,
          method: 'POST',
          agent: this.agent,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: this.timeoutMs,
        },
        res => {
          let text = '';
          res.on('data', d => { text += d; });
          res.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* The most common misconfiguration, and it deserves to be named:
               * Hearth's UTXO-era REST API listens on 8645 and answers an
               * unknown POST with `{"err":…}` at HTTP 200. Pointing this
               * service at it produces "an empty chain" rather than an error
               * unless we say so here. */
              return reject(new RpcError(
                -32603,
                `${this.url.href} did not return JSON-RPC (HTTP ${res.statusCode}): ${text.slice(0, 160)}`,
              ));
            }
            resolve(parsed);
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error(`rpc timeout after ${this.timeoutMs}ms`)); });
      req.on('error', reject);
      req.end(body);
    });
  }

  async call(method, params = []) {
    const payload = await this._post({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (payload && payload.error) {
      throw new RpcError(payload.error.code, payload.error.message, payload.error.data);
    }
    if (!payload || !('result' in payload)) {
      throw new RpcError(
        -32603,
        `${this.url.href} answered without a JSON-RPC result (${JSON.stringify(payload).slice(0, 160)}). `
        + 'If that looks like {"err":…}, this is the UTXO-era REST API on 8645, not the eth_* endpoint on 8545.',
      );
    }
    return payload.result;
  }

  /**
   * One round trip, N results, in request order.
   * @returns {Promise<Array<{ok: true, result: any} | {ok: false, error: object}>>}
   */
  async batch(requests) {
    if (requests.length === 0) return [];
    const ids = [];
    const payload = requests.map(r => {
      const id = this.nextId++;
      ids.push(id);
      return { jsonrpc: '2.0', id, method: r.method, params: r.params || [] };
    });
    const res = await this._post(payload);
    if (!Array.isArray(res)) {
      /* A server that answers a batch with a single object is not speaking
       * JSON-RPC 2.0. Say which one it is rather than throwing on `.find`. */
      throw new RpcError(-32603, `${this.url.href} did not answer a batch with an array`);
    }
    const byId = new Map(res.map(r => [r.id, r]));
    return ids.map(id => {
      const r = byId.get(id);
      if (!r) return { ok: false, error: { code: -32603, message: `no response for id ${id}` } };
      if (r.error) return { ok: false, error: r.error };
      return { ok: true, result: r.result };
    });
  }

  async chainId() { return Number(big(await this.call('eth_chainId'))); }
  async blockNumber() { return big(await this.call('eth_blockNumber')); }
  async getBalance(addr, at = 'latest') { return big(await this.call('eth_getBalance', [addr, at])); }
  async getCode(addr, at = 'latest') { return this.call('eth_getCode', [addr, at]); }
  async ethCall(msg, at = 'latest') { return this.call('eth_call', [msg, at]); }
  async getLogs(filter) { return this.call('eth_getLogs', [filter]); }
  async getTransactionByHash(h) { return this.call('eth_getTransactionByHash', [h]); }
  async getTransactionReceipt(h) { return this.call('eth_getTransactionReceipt', [h]); }

  async getBlockByNumber(n, fullTx = true) {
    return this.call('eth_getBlockByNumber', [typeof n === 'string' ? n : quantity(n), fullTx]);
  }

  async getBlockByHash(h, fullTx = true) {
    return this.call('eth_getBlockByHash', [h, fullTx]);
  }

  /**
   * Receipts for a whole block in one round trip.
   *
   * `eth_getBlockReceipts` is in Hearth's v1 surface (evm-spec §6) but is not
   * universal, so the first METHOD_NOT_FOUND flips a latch and every later
   * block uses the batch path. The latch matters: without it every block pays
   * for a failing call forever.
   */
  async getBlockReceipts(blockNumber, txHashes) {
    if (this._noBlockReceipts !== true) {
      try {
        const r = await this.call('eth_getBlockReceipts', [quantity(blockNumber)]);
        if (Array.isArray(r)) return r;
        // A node that answers null for a block we know exists is not usable
        // for this; fall through to the per-transaction path.
      } catch (e) {
        if (e.code === -32601 || /method .*not (exist|found|available)/i.test(String(e.message))) {
          this._noBlockReceipts = true;
        } else {
          throw e;
        }
      }
    }
    if (!txHashes || txHashes.length === 0) return [];
    const out = await this.batch(txHashes.map(h => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    return out.map((r, i) => {
      if (!r.ok) throw new RpcError(r.error.code, `receipt for ${txHashes[i]}: ${r.error.message}`);
      if (r.result === null) throw new RpcError(-32000, `no receipt for ${txHashes[i]} in a mined block`);
      return r.result;
    });
  }

  /**
   * Does this node expose a call tracer? Asked once, at boot.
   *
   * Internal transactions cannot be derived from blocks and receipts — they
   * need execution traces, and `debug_traceTransaction` is explicitly NOT in
   * Hearth's v1 RPC surface (docs/exchange-integration.md §5.2). So this
   * returns false against every node that exists today, and the answer decides
   * whether `txlistinternal` indexes or refuses. It never guesses.
   */
  async supportsTracing() {
    if (this._tracing !== undefined) return this._tracing;
    try {
      // A hash that cannot exist: a tracer answers "not found", a node without
      // one answers "method not found". Both are errors; only the code differs.
      await this.call('debug_traceTransaction', ['0x' + '00'.repeat(32), { tracer: 'callTracer' }]);
      this._tracing = true;
    } catch (e) {
      this._tracing = !(e.code === -32601 || /method .*not (exist|found|available)/i.test(String(e.message)));
    }
    return this._tracing;
  }

  async traceTransaction(hash) {
    return this.call('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
  }
}

module.exports = { Rpc, RpcError, quantity, big };
