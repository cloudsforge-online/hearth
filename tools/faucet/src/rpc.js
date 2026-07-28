'use strict';
/* A JSON-RPC client in forty lines, because the alternative is a dependency
 * tree. Only the five methods the faucet needs.
 *
 * Hex encoding is strict in both directions (docs/evm-spec.md §6): QUANTITY is
 * minimal-length — `0x0`, never `0x00` — and DATA is fixed-width. Every client
 * library is strict about this and so is Hearth's own decoder, so the encoding
 * lives in one place here rather than being sprinkled through call sites.
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

const toBig = hex => BigInt(hex);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

class Rpc {
  constructor(url, { timeoutMs = 10_000 } = {}) {
    this.url = new URL(url);
    this.timeoutMs = timeoutMs;
    this.transport = this.url.protocol === 'https:' ? https : http;
    this.nextId = 1;
  }

  call(method, params = []) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    return new Promise((resolve, reject) => {
      const req = this.transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port,
          path: this.url.pathname + this.url.search,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: this.timeoutMs,
        },
        res => {
          let text = '';
          res.on('data', d => { text += d; });
          res.on('end', () => {
            let payload;
            try {
              payload = JSON.parse(text);
            } catch {
              /* This is the single most common misconfiguration and it deserves
               * a message that names it: Hearth's REST API (the UTXO-era one)
               * lives on the same default port and answers a POST it does not
               * recognise with `{"err":"no route"}` at HTTP 200. */
              return reject(new RpcError(
                -32603,
                `${this.url.href} did not return JSON-RPC (HTTP ${res.statusCode}): ${text.slice(0, 120)}`,
              ));
            }
            if (payload.error) {
              return reject(new RpcError(payload.error.code, payload.error.message, payload.error.data));
            }
            /* A response with neither `result` nor `error` is not JSON-RPC, and
             * the overwhelmingly likely cause has a name: Hearth's UTXO-era
             * REST API answers `POST /rpc` for ANY unknown method with
             * `{"err":"unknown method"}` at HTTP 200, and `POST /` with
             * `{"err":"no route"}` (node/src/rpc.js). Both parse as JSON, so
             * without this check the faucet reports a confusing
             * "cannot convert undefined to BigInt" instead of "you pointed me
             * at the wrong server". */
            if (!('result' in payload)) {
              return reject(new RpcError(
                -32603,
                `${this.url.href} answered without a JSON-RPC result (${text.slice(0, 120)}). `
                + 'If that looks like {"err":…}, this is the UTXO-era REST API, not the eth_* endpoint.',
              ));
            }
            resolve(payload.result);
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error(`rpc timeout after ${this.timeoutMs}ms`)); });
      req.on('error', reject);
      req.end(body);
    });
  }

  async chainId() { return Number(toBig(await this.call('eth_chainId'))); }
  async blockNumber() { return toBig(await this.call('eth_blockNumber')); }
  async getBalance(addr, at = 'latest') { return toBig(await this.call('eth_getBalance', [addr, at])); }
  /** 'pending' so that a drip already in the mempool is counted. */
  async getNonce(addr, at = 'pending') { return toBig(await this.call('eth_getTransactionCount', [addr, at])); }
  async sendRawTransaction(raw) { return this.call('eth_sendRawTransaction', ['0x' + Buffer.from(raw).toString('hex')]); }
  async getTransactionReceipt(hash) { return this.call('eth_getTransactionReceipt', [hash]); }
}

module.exports = { Rpc, RpcError, quantity };
