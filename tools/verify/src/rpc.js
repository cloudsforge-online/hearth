'use strict';
/* A JSON-RPC client with exactly the three methods this service needs.
 *
 * `eth_getCode` is the one that matters: it is the ground truth a verification
 * is checked against. `eth_getTransactionByHash` is used only when a submitter
 * supplies a creation transaction so the constructor arguments can be proven.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

class RpcError extends Error {
  constructor(code, message) { super(message); this.name = 'RpcError'; this.code = code; }
}

class Rpc {
  constructor(url, { timeoutMs = 15_000 } = {}) {
    this.url = new URL(url);
    this.timeoutMs = timeoutMs;
    this.transport = this.url.protocol === 'https:' ? https : http;
    this.nextId = 1;
  }

  call(method, params = []) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    return new Promise((resolve, reject) => {
      const req = this.transport.request({
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        port: this.url.port,
        path: this.url.pathname + this.url.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: this.timeoutMs,
      }, res => {
        let text = '';
        res.on('data', d => { text += d; });
        res.on('end', () => {
          let payload;
          try { payload = JSON.parse(text); } catch {
            return reject(new RpcError(-32603,
              `${this.url.href} did not return JSON-RPC (HTTP ${res.statusCode}): ${text.slice(0, 160)}`));
          }
          if (payload.error) return reject(new RpcError(payload.error.code, payload.error.message));
          if (!('result' in payload)) {
            return reject(new RpcError(-32603,
              `${this.url.href} answered without a result. If that looks like {"err":…}, it is the `
              + 'UTXO-era REST API on 8645, not the eth_* endpoint on 8545.'));
          }
          resolve(payload.result);
        });
      });
      req.on('timeout', () => req.destroy(new Error(`rpc timeout after ${this.timeoutMs}ms`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  async chainId() { return Number(BigInt(await this.call('eth_chainId'))); }
  async getCode(address, at = 'latest') { return this.call('eth_getCode', [address, at]); }
  async getTransactionByHash(hash) { return this.call('eth_getTransactionByHash', [hash]); }
}

module.exports = { Rpc, RpcError };
