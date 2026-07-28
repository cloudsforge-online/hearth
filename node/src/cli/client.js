'use strict';
/* Talking to a node: JSON-RPC, the REST API, and the SSE event stream.
 *
 * Node 22's global `fetch` does all three, so this file is thin. What it is
 * really for is turning the two failure modes a CLI hits constantly into
 * sentences a person can act on: "nothing is listening on :8645" and "the node
 * answered, but with an error". Those look identical through a raw fetch and
 * they need opposite responses from the user.
 *
 * JSON-RPC errors arrive at HTTP 200 with an `error` member — that is the spec,
 * not a quirk — so a client that only checks `res.ok` reports success on every
 * revert. Code 3 with `data` is an execution revert, and the payload in `data`
 * is what the ABI layer decodes into a reason.
 */

const { hex, toBuf } = require('./ui');

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

class TransportError extends Error {
  constructor(url, cause) {
    super(`cannot reach ${url}: ${cause}`);
    this.name = 'TransportError';
  }
}

const DEFAULT_RPC = process.env.HEARTH_RPC_URL || 'http://127.0.0.1:8645';

class Client {
  /**
   * @param {string} url   base URL; the REST routes and /rpc both hang off it
   * @param {object} [o]   { timeout } in ms
   */
  constructor(url = DEFAULT_RPC, o = {}) {
    this.url = String(url).replace(/\/+$/, '');
    this.timeout = o.timeout === undefined ? 15000 : o.timeout;
    this._id = 0;
  }

  async _fetch(path, init) {
    const ac = new AbortController();
    const timer = this.timeout ? setTimeout(() => ac.abort(), this.timeout) : null;
    try {
      return await fetch(this.url + path, { ...init, signal: ac.signal });
    } catch (e) {
      throw new TransportError(this.url + path, e && e.name === 'AbortError' ? `timed out after ${this.timeout}ms` : String(e && e.message || e));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One JSON-RPC call. Throws RpcError for an `error` member. */
  async rpc(method, params = [], { path = '/' } = {}) {
    const id = ++this._id;
    const res = await this._fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch {
      throw new RpcError(-32700, `${method}: node replied with non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (body && body.error) throw new RpcError(body.error.code, `${method}: ${body.error.message}`, body.error.data);
    if (!res.ok) throw new RpcError(res.status, `${method}: HTTP ${res.status}`);
    return body ? body.result : null;
  }

  /** A REST GET returning parsed JSON. */
  async get(path) {
    const res = await this._fetch(path, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch {
      throw new RpcError(res.status, `GET ${path}: node replied with non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) throw new RpcError(res.status, `GET ${path}: ${body && body.err ? body.err : 'HTTP ' + res.status}`);
    return body;
  }

  async post(path, body) {
    const res = await this._fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // -- eth_* conveniences ----------------------------------------------------

  async chainId() { return BigInt(await this.rpc('eth_chainId', [])); }
  async blockNumber() { return BigInt(await this.rpc('eth_blockNumber', [])); }
  async gasPrice() { return BigInt(await this.rpc('eth_gasPrice', [])); }
  async getBalance(addr, at = 'latest') { return BigInt(await this.rpc('eth_getBalance', [hex(toBuf(addr)), at])); }
  async getNonce(addr, at = 'latest') { return BigInt(await this.rpc('eth_getTransactionCount', [hex(toBuf(addr)), at])); }
  async getCode(addr, at = 'latest') { return toBuf(await this.rpc('eth_getCode', [hex(toBuf(addr)), at])); }
  async getStorageAt(addr, slot, at = 'latest') {
    const raw = await this.rpc('eth_getStorageAt', [hex(toBuf(addr)), hex(toBuf(slot)), at]);
    const b = toBuf(raw);
    return b.length === 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]);
  }
  async call(tx, at = 'latest') { return toBuf(await this.rpc('eth_call', [tx, at])); }
  async estimateGas(tx) { return BigInt(await this.rpc('eth_estimateGas', [tx])); }
  async sendRawTransaction(raw) { return this.rpc('eth_sendRawTransaction', [hex(toBuf(raw))]); }
  async getTransactionByHash(h) { return this.rpc('eth_getTransactionByHash', [hex(toBuf(h))]); }
  async getTransactionReceipt(h) { return this.rpc('eth_getTransactionReceipt', [hex(toBuf(h))]); }
  async getBlockByNumber(n, full = false) {
    const tag = typeof n === 'string' ? n : '0x' + BigInt(n).toString(16);
    return this.rpc('eth_getBlockByNumber', [tag, full]);
  }

  /**
   * Subscribe to the REST SSE stream. Calls `onEvent({event, data})` per frame
   * and resolves when the stream ends or `signal` aborts. SSE is parsed here
   * rather than with a library because the framing is four lines of code and
   * one of them — a blank line terminates a frame — is the whole protocol.
   */
  async events({ query = '', onEvent, signal } = {}) {
    const res = await fetch(this.url + '/events' + query, { headers: { accept: 'text/event-stream' }, signal })
      .catch((e) => { throw new TransportError(this.url + '/events', String(e && e.message || e)); });
    if (!res.ok || !res.body) throw new RpcError(res.status, `/events: HTTP ${res.status}`);

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          // `:` alone is a comment/keep-alive; `id:` and `retry:` are unused here.
        }
        if (dataLines.length === 0) continue;
        let data = dataLines.join('\n');
        try { data = JSON.parse(data); } catch { /* leave it as text */ }
        onEvent({ event, data });
      }
    }
  }
}

module.exports = { Client, RpcError, TransportError, DEFAULT_RPC };
