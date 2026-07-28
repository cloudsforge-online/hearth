'use strict';
/* JSON-RPC 2.0 dispatch: single calls, batches, notifications, error mapping.
 *
 * This is served alongside the REST API in src/rpc.js, which stays exactly as
 * it is for the explorer and Forge Pay. Nothing here touches it.
 *
 * The transport contract that clients actually depend on, and that is easy to
 * get subtly wrong:
 *
 *   - Every response echoes the request's `id` UNCHANGED, including `null` and
 *     including a string id. Clients match responses to calls by id and hang
 *     forever if it comes back altered — and a batch may come back in any
 *     order, so id is the only thing tying them together.
 *   - A request with NO `id` key is a notification: it gets no response at all,
 *     not even on error. `"id": null` is a request, not a notification.
 *   - A batch is answered with an array of the responses of its non-
 *     notification members. An all-notification batch produces no response
 *     body. An EMPTY batch is an invalid request, per the spec's own examples.
 *   - Transport-level success is independent of RPC-level failure: a JSON-RPC
 *     error still leaves HTTP at 200. A client that sees 500 usually retries
 *     instead of reporting the error the user needs to see.
 *   - Execution reverts are code 3 with the revert payload in `data`. That is
 *     what lets ethers decode a custom error rather than say "unknown error".
 */

const http = require('http');
const { RpcError, CODES } = require('./hex');
const { buildMethods } = require('./methods');

const JSONRPC_VERSION = '2.0';
/** Headroom for a fat Hardhat deployment batch; a single tx is ≤ 100 kB (§3). */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function resultResponse(id, result) {
  // `result` must be present even when it is null — "not found" is a result,
  // and a response with neither result nor error is malformed.
  return { jsonrpc: JSONRPC_VERSION, id, result: result === undefined ? null : result };
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

class JsonRpcServer {
  /**
   * @param {object} options - `chain` is required and is the interface
   *   documented at the top of methods.js. `confirmations`, `maxLogRange`,
   *   `maxLogs`, `clientVersion`, `version` are optional; `logger` gets
   *   ({ msg, ...fields }) for internal errors only.
   */
  constructor(options = {}) {
    this.methods = buildMethods(options);
    this.logger = options.logger || null;
    this.maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  }

  /** True if this server can answer `name` — used when routing. */
  has(name) { return Object.prototype.hasOwnProperty.call(this.methods, name); }

  /**
   * Handle one already-parsed payload (object or batch array).
   * Returns the response value, or null when there is nothing to send.
   */
  async handle(payload) {
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return errorResponse(null, CODES.INVALID_REQUEST, 'invalid request: empty batch');
      }
      const out = [];
      for (const msg of payload) {
        const r = await this._one(msg);
        if (r !== null) out.push(r);
      }
      return out.length ? out : null;
    }
    return this._one(payload);
  }

  /**
   * Handle a raw request body. Returns the JSON text to send, or '' when the
   * request was entirely notifications and the answer is 204/empty.
   */
  async handleRaw(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // A parse error has no recoverable id, so it is always id: null.
      return JSON.stringify(errorResponse(null, CODES.PARSE_ERROR, 'parse error'));
    }
    const res = await this.handle(payload);
    return res === null ? '' : JSON.stringify(res);
  }

  async _one(msg) {
    if (!isPlainObject(msg)) {
      return errorResponse(null, CODES.INVALID_REQUEST, 'invalid request: expected an object');
    }
    // Absent id means notification; present-and-null is a real request whose id
    // happens to be null and must be echoed as null.
    const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id');
    const id = isNotification ? null : msg.id;
    const reply = r => (isNotification ? null : r);

    if (!isNotification && id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return errorResponse(null, CODES.INVALID_REQUEST, 'invalid request: id must be a string, number or null');
    }
    // A wrong version is refused; an absent one is not. Nothing is gained by
    // rejecting the curl-by-hand and older-web3 callers that omit it, and the
    // field carries no information we act on.
    if (msg.jsonrpc !== undefined && msg.jsonrpc !== JSONRPC_VERSION) {
      return reply(errorResponse(id, CODES.INVALID_REQUEST, 'invalid request: jsonrpc must be "2.0"'));
    }
    if (typeof msg.method !== 'string' || msg.method.length === 0) {
      return reply(errorResponse(id, CODES.INVALID_REQUEST, 'invalid request: method must be a string'));
    }
    if (!this.has(msg.method)) {
      return reply(errorResponse(id, CODES.METHOD_NOT_FOUND,
        `the method ${msg.method} does not exist/is not available`));
    }
    let params;
    if (msg.params === undefined || msg.params === null) params = [];
    else if (Array.isArray(msg.params)) params = msg.params;
    else if (isPlainObject(msg.params)) {
      // Ethereum's RPC is positional everywhere; by-name params would have to
      // guess an ordering, and guessing wrong runs a different call.
      return reply(errorResponse(id, CODES.INVALID_PARAMS, 'invalid params: named parameters are not supported'));
    } else {
      return reply(errorResponse(id, CODES.INVALID_PARAMS, 'invalid params: params must be an array'));
    }

    try {
      const result = await this.methods[msg.method](params);
      return reply(resultResponse(id, result));
    } catch (e) {
      if (e instanceof RpcError) {
        return reply(errorResponse(id, e.code, e.message, e.data));
      }
      // Anything else is our bug. Report it internally with the stack, and give
      // the caller the message without one.
      if (this.logger) {
        this.logger({ msg: 'jsonrpc handler threw', method: msg.method, err: String(e && e.message || e), stack: e && e.stack });
      }
      return reply(errorResponse(id, CODES.INTERNAL_ERROR, `internal error: ${String(e && e.message || e)}`));
    }
  }

  /**
   * A Node http request listener, so this can be mounted on its own port or
   * delegated to from the existing server. CORS is open, matching src/rpc.js —
   * a browser wallet talking to a local node needs it.
   */
  httpListener() {
    return (req, res) => { this._serve(req, res); };
  }

  async _serve(req, res) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST,OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST,OPTIONS', ...cors });
      return res.end(JSON.stringify(errorResponse(null, CODES.INVALID_REQUEST, 'JSON-RPC requires POST')));
    }
    let body;
    try {
      body = await readBody(req, this.maxBodyBytes);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(errorResponse(null, CODES.INVALID_REQUEST, 'request body too large')));
      req.destroy();
      return;
    }
    const text = await this.handleRaw(body);
    if (text === '') { res.writeHead(204, cors); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(text);
  }

  listen(port, host) {
    this.server = http.createServer(this.httpListener());
    this.server.listen(port, host);
    return this.server;
  }

  close() { if (this.server) this.server.close(); }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let text = '', bytes = 0, over = false;
    req.on('data', d => {
      if (over) return;
      bytes += d.length;
      if (bytes > limit) { over = true; req.pause(); reject(new Error('body too large')); return; }
      text += d;
    });
    req.on('end', () => { if (!over) resolve(text); });
    req.on('error', reject);
  });
}

module.exports = { JsonRpcServer, JSONRPC_VERSION, MAX_BODY_BYTES, RpcError, CODES };
