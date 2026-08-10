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
 *
 * WHAT ONE REQUEST MAY COST, which is a transport concern and therefore this
 * file's. The node is single-threaded — `eth_call` executes EVM code on the same
 * loop that mines, gossips and answers the healthcheck — so the size of a request
 * is the length of an outage. Three bounds, of which only the first was ever
 * here:
 *
 *   - `maxBodyBytes`.
 *   - `maxBatchSize`. A batch is executed member by member, so a 5 MB body of
 *     `eth_call` objects is one HTTP request that buys tens of thousands of
 *     executions. Measured before any of this: 32 blake2f calls in ONE 14 kB POST
 *     held the process for 359.8 seconds — six minutes of one HTTP request. geth
 *     grew --rpc.batch-request-limit for the same reason.
 *   - `maxInFlightPerIp`, so one client cannot queue an unbounded number of
 *     requests ahead of everybody else's.
 *
 * And one thing that is not a bound but does more than any of them: the batch
 * loop YIELDS to the event loop between members (`setImmediate`, not `await` on
 * a plain value, which only drains microtasks and lets no timer or socket run).
 * With that plus the per-call deadline in chain/rpcadapter.js, a batch is no
 * longer ONE stall of its whole length — it is a stall per member, and the loop
 * turns in between. Measured with a one-second budget, eight members: 26.0 s of
 * unbroken freeze before, and after, 8.0 s of work whose worst missed timer tick
 * is 1.95 s. Not 1.0 s, because the FIRST yield is scheduled from inside the
 * poll phase and so runs in the same loop iteration, putting members one and two
 * back to back; every yield after that costs a full iteration, timers included.
 */

const http = require('http');
const { RpcError, CODES } = require('./hex');
const { buildMethods } = require('./methods');
const { FilterRegistry } = require('./filters');

const JSONRPC_VERSION = '2.0';
/** Headroom for a fat Hardhat deployment batch; a single tx is ≤ 100 kB (§3). */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/* Members in one batch — geth's --rpc.batch-request-limit default, and chosen to
 * match it rather than to be tighter. tools/explorer-api falls back to one batched
 * `eth_getTransactionReceipt` per transaction in a block when a node has no
 * `eth_getBlockReceipts` (its rpc.js `getBlockReceipts`), and MAX_BLOCK_TXS allows
 * 5,000 in a block — this node does implement `eth_getBlockReceipts`, so the
 * estate's own indexer never takes that path here, but a limit in the dozens would
 * break every other client that batches by block. This bound is the backstop; the
 * ones that carry the weight are the per-call deadline and the yield below. */
const MAX_BATCH_SIZE = 1000;
/** Requests one remote address may have open at once. A browser opens six
 *  connections and ethers pipelines on them; this is comfortably above that and
 *  far below what it takes to monopolise the loop. */
const MAX_IN_FLIGHT_PER_IP = 16;
/** Yield to the macrotask queue: timers, sockets and the miner's tick all run. */
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

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
   *   ({ msg, ...fields }) for internal errors only. `maxBodyBytes`,
   *   `maxBatchSize` and `maxInFlightPerIp` are the request bounds described
   *   in the header.
   */
  constructor(options = {}) {
    /* Built here rather than inside buildMethods so that it is reachable —
     * `close()` clears it, and an operator surface can count what is held. It
     * cannot live on `this.methods`, because `has()` dispatches anything with an
     * own property there and a caller would be able to invoke "filters". */
    this.filters = options.filters || new FilterRegistry(options);
    this.methods = buildMethods({ ...options, filters: this.filters });
    this.logger = options.logger || null;
    this.maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
    this.maxBatchSize = options.maxBatchSize || MAX_BATCH_SIZE;
    this.maxInFlightPerIp = options.maxInFlightPerIp || MAX_IN_FLIGHT_PER_IP;
    /* Whether the chain behind this server may be believed yet. A node binds
     * this port before it has replayed its data directory (src/evmnode.js), so
     * for the first minutes of a cold boot every method here would answer out of
     * a chain that is still loading: a block number short by thousands, a
     * balance at a state root the chain has left behind. Asked per request
     * rather than read once, because it changes exactly once and this is the
     * cheapest way to see it change. Default true — an embedder that hands over
     * a loaded chain owes nothing. */
    this.ready = options.ready || (() => true);
    /* remoteAddress -> open request count. Entries are deleted at zero, so this
     * cannot grow with the number of addresses ever seen; the alternative is a
     * map an attacker fills by reconnecting from a /64. */
    this.inFlight = new Map();
  }

  /** True if this server can answer `name` — used when routing. */
  has(name) { return Object.prototype.hasOwnProperty.call(this.methods, name); }

  /**
   * Handle one already-parsed payload (object or batch array).
   *
   * `ctx` is the per-request context handed to every method — `{ remote }`, the
   * caller's address as this transport saw it. Only the filter methods read it,
   * to key their per-caller cap; no answer depends on it. Every member of a
   * batch shares one, which is right: a batch is one request from one caller.
   *
   * Returns the response value, or null when there is nothing to send.
   */
  async handle(payload, ctx = null) {
    const c = ctx || { remote: 'unknown' };
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return errorResponse(null, CODES.INVALID_REQUEST, 'invalid request: empty batch');
      }
      /* Refused whole, not truncated: answering the first hundred of a
       * two-hundred batch returns a response array a client will line up
       * against the wrong requests. The limit is named so the fix is obvious. */
      if (payload.length > this.maxBatchSize) {
        return errorResponse(null, CODES.INVALID_REQUEST,
          `invalid request: batch of ${payload.length} exceeds the limit of ${this.maxBatchSize}`);
      }
      const out = [];
      for (const msg of payload) {
        const r = await this._one(msg, c);
        if (r !== null) out.push(r);
        // See the header: `_one` is synchronous all the way down to the EVM, so
        // without this the whole batch is one uninterrupted stall.
        await yieldToLoop();
      }
      return out.length ? out : null;
    }
    return this._one(payload, c);
  }

  /**
   * Handle a raw request body. Returns the JSON text to send, or '' when the
   * request was entirely notifications and the answer is 204/empty.
   */
  async handleRaw(text, ctx = null) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // A parse error has no recoverable id, so it is always id: null.
      return JSON.stringify(errorResponse(null, CODES.PARSE_ERROR, 'parse error'));
    }
    const res = await this.handle(payload, ctx);
    return res === null ? '' : JSON.stringify(res);
  }

  async _one(msg, ctx = null) {
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
      const result = await this.methods[msg.method](params, ctx || { remote: 'unknown' });
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
    return (req, res) => {
      /* `_serve` releases an in-flight slot in a `finally`, so a socket that dies
       * mid-request re-throws out of it. Unhandled, that is an unhandled rejection,
       * which since Node 15 takes the whole node down — mining and all — over one
       * dropped connection. */
      this._serve(req, res).catch(e => {
        if (this.logger) this.logger({ msg: 'jsonrpc request failed', err: String(e && e.message || e) });
        try { req.destroy(); } catch { /* already gone */ }
      });
    };
  }

  /**
   * Claim one of `remote`'s in-flight slots, or null if it has none left.
   *
   * A COUNT OF OPEN REQUESTS, NOT A RATE LIMIT. It bounds how much work one
   * address can have queued on the single loop at once; a client that waits for
   * its answers is never touched by it, however many it sends. Keyed on
   * `socket.remoteAddress`, so behind a proxy — the public RPC ingress
   * docs/quickstart.md §9 still lists as pending — every request arrives from one
   * address and this degrades into a global cap. That is the safe direction to
   * degrade in, and it is the reason the real bounds are the gas cap and the
   * per-call deadline rather than this.
   */
  _claim(remote) {
    const n = this.inFlight.get(remote) || 0;
    if (n >= this.maxInFlightPerIp) return null;
    this.inFlight.set(remote, n + 1);
    let released = false;
    return () => {
      if (released) return;                       // one release per claim, ever
      released = true;
      const left = (this.inFlight.get(remote) || 1) - 1;
      if (left <= 0) this.inFlight.delete(remote);
      else this.inFlight.set(remote, left);
    };
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
    /* REFUSED BEFORE THE BODY IS READ, and before a slot is claimed: there is
     * nothing in it this server is willing to act on yet. 503 and not the
     * 200-with-an-error-body the transport contract insists on, for the same
     * reason as the 429 below — this is the transport declining to take the
     * request rather than the RPC layer answering it — and because every
     * mainstream client turns a 5xx into a thrown transport error the caller can
     * retry, while a 200 whose body is an error is reported to the user as a
     * failed call. `id` is null because the body has not been read; the spec
     * requires exactly that when the id cannot be determined. */
    if (!this.ready()) {
      req.resume();                               // discard the body we will not read
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2', ...cors });
      return res.end(JSON.stringify(errorResponse(null, CODES.SERVER_ERROR,
        'this node is starting: replaying its chain from disk')));
    }
    /* Claimed before the body is read, because reading is itself the queue an
     * attacker fills. An HTTP 429 rather than the 200-with-an-error-body the
     * transport contract above insists on, for the same reason the oversized
     * body below is a 413: those are the transport refusing to take the
     * request, not the RPC layer answering it. The body is still a well-formed
     * JSON-RPC error, so a client that only parses bodies still learns why. */
    const remote = req.socket && req.socket.remoteAddress || 'unknown';
    const release = this._claim(remote);
    if (release === null) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', ...cors });
      return res.end(JSON.stringify(errorResponse(null, CODES.SERVER_ERROR,
        `too many concurrent requests from this address (limit ${this.maxInFlightPerIp})`)));
    }
    try {
      let body;
      try {
        body = await readBody(req, this.maxBodyBytes);
      } catch {
        res.writeHead(413, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify(errorResponse(null, CODES.INVALID_REQUEST, 'request body too large')));
        req.destroy();
        return;
      }
      const text = await this.handleRaw(body, { remote });
      if (text === '') { res.writeHead(204, cors); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(text);
    } finally {
      // In a `finally` and not after the writes: a socket that dies mid-request
      // throws out of here, and a slot leaked on every dropped connection is a
      // limiter that eventually refuses everything.
      release();
    }
  }

  listen(port, host) {
    this.server = http.createServer(this.httpListener());
    this.server.listen(port, host);
    return this.server;
  }

  close() {
    if (this.server) this.server.close();
    // Filters outlive individual connections by design, but not the server:
    // an embedder that closes and re-opens should not inherit the old cursors.
    this.filters.clear();
  }
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

module.exports = {
  JsonRpcServer, JSONRPC_VERSION, FilterRegistry,
  MAX_BODY_BYTES, MAX_BATCH_SIZE, MAX_IN_FLIGHT_PER_IP,
  RpcError, CODES,
};
