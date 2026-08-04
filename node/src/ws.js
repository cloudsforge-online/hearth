'use strict';
/* WebSocket, RFC 6455, client and server, no dependencies.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS NOT `ws`.
 *
 * CloudsForge is published from a home server behind a Cloudflare Tunnel, and
 * the operator has no static IP: every inbound connection arrives through the
 * tunnel or not at all. A tunnel carries HTTP and WebSocket and CANNOT carry raw
 * TCP — so gossip, which is `net.createServer` in src/p2p.js, is the one thing
 * that cannot be published, and a miner that cannot gossip cannot mine.
 *
 * The obvious answer is `npm i ws`. It is rejected, and the reasoning is short
 * enough to check rather than take on trust:
 *
 *   - This node declares no dependencies and has none (package.json), which is
 *     what lets `node/Dockerfile` be `COPY src` with no install step, no
 *     lockfile audit, and no supply-chain surface on a machine that mines. The
 *     project wrote its own EVM, its own secp256k1 and its own keccak; a frame
 *     header is not the place it starts trusting someone else's code.
 *   - The protocol is already newline-delimited JSON, so the adaptation is
 *     total: ONE NDJSON LINE IS ONE WEBSOCKET TEXT MESSAGE, with no re-framing,
 *     no length prefix and no change below src/p2p.js's `_setup`.
 *   - What is actually needed is small and fully specified: the handshake, the
 *     three length forms, client masking, continuation, and ping/pong. It is
 *     ~300 lines, and test/ws.js drives it with frames built by hand from the
 *     RFC — including the RFC's own published vectors — rather than with this
 *     file's own encoder.
 *
 * WHAT IS DELIBERATELY NOT IMPLEMENTED: permessage-deflate (RSV1 is refused,
 * because a peer must not be able to hand us a decompression bomb), subprotocol
 * negotiation, and binary framing on receive is accepted but never sent. None of
 * them is needed to carry a line of JSON.
 *
 * EXPOSURE. A WebSocket endpoint is reachable from any browser on the internet
 * with no preflight and no CORS, which raw TCP is not. Everything here is
 * therefore bounded before it is buffered: a frame is refused from its DECLARED
 * length, before a byte of its payload is read, and the cap applies to the
 * assembled message so that continuation frames are not a way around it.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

/* RFC 6455 §4.2.2 step 5. The one magic constant in the protocol, and the one
 * thing here that cannot be derived from anything else — so test/ws.js checks it
 * against the accept value the RFC publishes rather than against this file. That
 * is not ceremony: the first draft of this line read "…-95CA-5AB0DC85B11F" (a
 * plausible-looking transposition of the real "…-95CA-C5AB0DC85B11"), the client
 * and the server in this file agreed with each other perfectly, every framing
 * test passed, and the handshake would have been rejected by every real
 * WebSocket implementation on earth. A vector from outside the repository is the
 * only kind of check that could have failed. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = key => crypto.createHash('sha1').update(key + GUID).digest('base64');

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const CLOSE = { NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL: 1002, POLICY: 1008, TOO_BIG: 1009 };

const EMPTY = Buffer.alloc(0);
const NEWLINE = Buffer.from('\n');

const DEFAULTS = {
  maxMessageBytes: 4 * 1024 * 1024,
  /* Keepalive is NOT optional here. Cloudflare closes a WebSocket that carries
   * nothing, and a p2p link that dies quietly is the worst possible failure: the
   * miner still shows a peer, still mines, and every block it finds goes nowhere.
   * src/params.js sets the shipped values; these are the fallbacks for an
   * embedder that passes none. */
  pingMs: 20_000,
  idleMs: 70_000,
  handshakeMs: 15_000,
};

const STATUS = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required' };

/** A close frame's 2-byte big-endian status code. */
const closeBody = code => { const b = Buffer.alloc(2); b.writeUInt16BE(code, 0); return b; };

/* Log-only, and untrusted on purpose. Behind a tunnel every peer shares the
 * tunnel's socket address, so without this every log line names the same host
 * and an operator cannot tell two peers apart. Nothing authorises on it — the
 * bounds in src/p2p.js are per-connection, not per-address. */
const IPISH = /^[0-9a-fA-F:.]{1,45}$/;
function peerAddress(req, socket) {
  const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return h && IPISH.test(h) ? h : socket.remoteAddress;
}

/**
 * One WebSocket connection, presenting the small surface src/p2p.js's `_setup()`
 * already expects of a TCP socket: `on('data'|'close'|'error')`, `write()`,
 * `destroy()`, `destroyed`, `remoteAddress`/`remotePort`, `writableLength`, and
 * arbitrary properties (the per-connection verification budgets) hung off it.
 *
 * That is the whole design: the transport is adapted to the reader, so nothing
 * below `_setup` learns that there are two transports.
 */
class WsConnection extends EventEmitter {
  constructor(socket, opts = {}) {
    super();
    this.role = opts.role === 'client' ? 'client' : 'server';
    this.maxMessageBytes = opts.maxMessageBytes || DEFAULTS.maxMessageBytes;
    this.pingMs = opts.pingMs === undefined ? DEFAULTS.pingMs : opts.pingMs;
    this.idleMs = opts.idleMs === undefined ? DEFAULTS.idleMs : opts.idleMs;
    this.notice = typeof opts.notice === 'function' ? opts.notice : null;

    this.socket = null;
    this.destroyed = false;
    this.remoteAddress = opts.remoteAddress;
    this.remotePort = undefined;
    /** So a caller can tell the transports apart without instanceof. */
    this.isWebSocket = true;

    this._buf = EMPTY;
    this._frag = null;          // { parts: Buffer[], len } while a message is fragmented
    this._last = Date.now();    // anything received; drives the liveness deadline
    this._timer = null;
    this._sentClose = false;
    this._closed = false;
    this._req = null;           // the pending client handshake, if any

    /* An 'error' with no listener THROWS and takes the node down. src/p2p.js
     * attaches its handler in `_setup()`, i.e. only after the handshake — and a
     * handshake that fails is exactly when this fires. Every other listener
     * still runs; this one only guarantees there is one. */
    this.on('error', () => {});

    if (socket) this._attach(socket);
  }

  /** Bytes queued in the kernel/stream — src/p2p.js keeps one getblocks page in flight on it. */
  get writableLength() { return this.socket ? this.socket.writableLength || 0 : 0; }

  get name() { return this.remoteAddress ? `${this.remoteAddress}:${this.remotePort}` : 'closed'; }

  _attach(socket) {
    this.socket = socket;
    if (this.remoteAddress === undefined) this.remoteAddress = socket.remoteAddress;
    this.remotePort = socket.remotePort;
    if (socket.setNoDelay) socket.setNoDelay(true);
    if (socket.setTimeout) socket.setTimeout(0);
    socket.on('data', d => this._read(d));
    socket.on('error', e => this.emit('error', e));
    socket.on('close', () => this._done());
    if (this.pingMs > 0) {
      this._timer = setInterval(() => this._tick(), this.pingMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  /* The keepalive, and the liveness deadline it pairs with. A ping alone proves
   * nothing: it is the ABSENCE of anything coming back that has to be acted on,
   * or a half-open link through a tunnel looks connected forever. */
  _tick() {
    if (this.destroyed) return;
    if (this.idleMs > 0 && Date.now() - this._last > this.idleMs) {
      if (this.notice) this.notice('p2p websocket peer stopped answering', { peer: this.name, idleMs: this.idleMs });
      this.destroy(CLOSE.GOING_AWAY);
      return;
    }
    this._frameOut(OP.PING, EMPTY);
  }

  // ---- receive -------------------------------------------------------------

  _read(chunk) {
    if (this.destroyed || !chunk || !chunk.length) return;
    this._last = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
    while (!this.destroyed && this._step()) { /* consume frames until one is short */ }
  }

  /** Consume exactly one frame. Returns false when more bytes are needed, or we hung up. */
  _step() {
    const b = this._buf;
    if (b.length < 2) return false;

    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    // No extension was negotiated, so a reserved bit means either a client that
    // believes we agreed to permessage-deflate or a probe. Neither is a peer.
    if (rsv !== 0) return this._fail(CLOSE.PROTOCOL, 'reserved bits set with no extension negotiated');

    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      // Read the high word rather than trusting a 64-bit value to be small: a
      // length that overflows into something plausible is how a cap gets skipped.
      if (b.readUInt32BE(2) !== 0) return this._fail(CLOSE.TOO_BIG, 'frame length above 2^32');
      len = b.readUInt32BE(6); off = 10;
    }

    const control = (op & 0x8) !== 0;
    if (control && (len > 125 || !fin)) return this._fail(CLOSE.PROTOCOL, 'control frame must be short and unfragmented');
    // RFC 6455 §5.1: a client MUST mask and a server MUST NOT. Both directions
    // are checked, because accepting an unmasked client frame is the standard way
    // a hand-written server ends up parsing a proxy's cached bytes as a message.
    if (this.role === 'server' && !masked) return this._fail(CLOSE.PROTOCOL, 'client frame is not masked');
    if (this.role === 'client' && masked) return this._fail(CLOSE.PROTOCOL, 'server frame is masked');

    // THE BOUND, TAKEN FROM THE HEADER. Nothing below allocates for this frame
    // until it is known to fit, so a peer cannot make us hold memory by
    // announcing a size it never sends.
    if (len > this.maxMessageBytes) return this._fail(CLOSE.TOO_BIG, `frame declares ${len} bytes, cap is ${this.maxMessageBytes}`);

    if (control) {
      if (op !== OP.CLOSE && op !== OP.PING && op !== OP.PONG) return this._fail(CLOSE.PROTOCOL, `unknown control opcode ${op}`);
    } else if (op === OP.CONT) {
      if (!this._frag) return this._fail(CLOSE.PROTOCOL, 'continuation with nothing to continue');
      // …and the same cap ACROSS fragments, which is the way around a per-frame one.
      if (this._frag.len + len > this.maxMessageBytes) return this._fail(CLOSE.TOO_BIG, 'fragments exceed the message cap');
    } else if (op === OP.TEXT || op === OP.BINARY) {
      if (this._frag) return this._fail(CLOSE.PROTOCOL, 'new data frame inside an unfinished message');
    } else {
      return this._fail(CLOSE.PROTOCOL, `unknown opcode ${op}`);
    }

    const start = off + (masked ? 4 : 0);
    if (b.length < start + len) return false;          // wait for the rest

    const payload = Buffer.from(b.subarray(start, start + len));
    if (masked) {
      const key = b.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    const end = start + len;
    // Copy the tail rather than keeping a view: a subarray pins the whole
    // allocation, which turns one 4 MiB frame into 4 MiB held for the connection.
    this._buf = end === b.length ? EMPTY : Buffer.from(b.subarray(end));

    if (op === OP.PING) { this._frameOut(OP.PONG, payload); return true; }
    if (op === OP.PONG) return true;                   // liveness already recorded
    if (op === OP.CLOSE) {
      this._sendClose(payload.length >= 2 ? payload.subarray(0, 2) : closeBody(CLOSE.NORMAL));
      this.destroy(CLOSE.NORMAL);
      return false;
    }

    if (op !== OP.CONT) this._frag = { parts: [], len: 0 };
    this._frag.parts.push(payload);
    this._frag.len += payload.length;
    if (!fin) return true;

    const msg = this._frag.parts.length === 1 ? this._frag.parts[0] : Buffer.concat(this._frag.parts, this._frag.len);
    this._frag = null;
    /* ONE MESSAGE IS ONE NDJSON LINE. src/p2p.js splits its read buffer on '\n'
     * and holds anything after the last one, so a message that arrived without a
     * terminator would sit there until the peer was dropped for an oversized
     * frame. Sending it is this file's own `write()`, which passes the line
     * through verbatim — including the newline p2p already appends — so the
     * terminator is normally present and this only covers a foreign client. */
    this.emit('data', msg.length && msg[msg.length - 1] === 0x0a ? msg : Buffer.concat([msg, NEWLINE]));
    return true;
  }

  // ---- send ----------------------------------------------------------------

  /** Write one line. Verbatim: src/p2p.js appends the newline and nothing here strips it. */
  write(text) {
    if (this.destroyed) return false;
    return this._frameOut(OP.TEXT, Buffer.from(String(text), 'utf8'));
  }

  _frameOut(op, payload) {
    const s = this.socket;
    if (!s || s.destroyed) return false;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const n = body.length;
    const mask = this.role === 'client';
    const extra = n < 126 ? 0 : n < 65536 ? 2 : 8;
    const head = Buffer.alloc(2 + extra + (mask ? 4 : 0));
    head[0] = 0x80 | op;                                // FIN, no RSV
    let i = 2;
    if (n < 126) head[1] = n;
    else if (n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); i = 4; }
    else { head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); i = 10; }
    let out;
    if (mask) {
      head[1] |= 0x80;
      const key = crypto.randomBytes(4);
      key.copy(head, i);
      const masked = Buffer.allocUnsafe(n);
      for (let k = 0; k < n; k++) masked[k] = body[k] ^ key[k & 3];
      out = Buffer.concat([head, masked]);
    } else {
      out = Buffer.concat([head, body]);
    }
    try { return s.write(out); }
    catch (e) { this.emit('error', e); return false; }
  }

  _sendClose(body) {
    if (this._sentClose) return;
    this._sentClose = true;
    this._frameOut(OP.CLOSE, body);
  }

  // ---- teardown ------------------------------------------------------------

  _fail(code, why) {
    if (this.notice) this.notice('p2p websocket protocol error', { peer: this.name, err: why });
    this.emit('error', new Error('websocket: ' + why));
    this.destroy(code);
    return false;
  }

  /** Synchronously dead. src/p2p.js reads `sock.destroyed` mid-frame to stop
   *  draining a peer it has just hung up on, so this cannot be deferred. */
  destroy(code = CLOSE.NORMAL) {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._buf = EMPTY;
    this._frag = null;
    if (this._req) { const r = this._req; this._req = null; try { r.destroy(); } catch { /* already gone */ } }
    const s = this.socket;
    if (s && !s.destroyed) {
      this._sendClose(closeBody(code));
      // Let the close frame leave, then stop waiting on a peer that may never
      // answer. `end()` flushes; `destroy()` on its own would discard the frame.
      try { if (s.end) s.end(); } catch { /* already gone */ }
      setTimeout(() => { try { s.destroy(); } catch { /* already gone */ } }, 100).unref();
    }
    if (!s) this._done();
  }

  _done() {
    if (this._closed) return;
    this._closed = true;
    this.destroyed = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._buf = EMPTY;
    this._frag = null;
    // Async like net.Socket's own 'close', so a caller that attaches a listener
    // right after an 'error' still hears it.
    setImmediate(() => this.emit('close'));
  }
}

// ---- server ----------------------------------------------------------------

/**
 * An `http.Server` that answers ONE path with a WebSocket upgrade and everything
 * else with 426. The caller listens on it, so binding, errors and `close()` stay
 * the caller's, exactly as `net.createServer` is in src/p2p.js.
 *
 * `onRefused(why, fields)` is how a refusal becomes a log line an operator can
 * act on — a tunnel misrouting `/p2p` otherwise looks like a silent network.
 */
function createServer(opts = {}) {
  const pathname = opts.path || '/p2p';
  const onConnection = opts.onConnection || (() => {});
  const onRefused = typeof opts.onRefused === 'function' ? opts.onRefused : null;
  const connOpts = {
    role: 'server',
    maxMessageBytes: opts.maxMessageBytes,
    pingMs: opts.pingMs,
    idleMs: opts.idleMs,
    notice: opts.notice,
  };

  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain', 'connection': 'close', 'upgrade': 'websocket' });
    res.end(`426 Upgrade Required — Hearth p2p speaks WebSocket at ${pathname}\n`);
  });
  // A malformed request line must not be an uncaught exception on a mining node.
  server.on('clientError', (e, socket) => { try { socket.destroy(); } catch { /* already gone */ } });

  server.on('upgrade', (req, socket, head) => {
    const refuse = (code, why) => {
      if (onRefused) onRefused(why, { peer: peerAddress(req, socket), path: String(req.url || '').slice(0, 64) });
      try {
        socket.write(`HTTP/1.1 ${code} ${STATUS[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch { /* the peer may already be gone */ }
      socket.destroy();
    };

    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse(400, 'not a websocket upgrade');
    if (String(req.url || '').split('?')[0] !== pathname) return refuse(404, `wrong path (p2p is at ${pathname})`);
    /* NO BROWSERS. A page on any origin can open a WebSocket to any host with no
     * preflight and no CORS — a raw TCP port cannot be reached that way at all.
     * Without this, an anonymous page's visitors could take every one of
     * P2P_MAX_PEERS slots without their knowledge. Every browser sends `Origin`
     * and no node does, so refusing it costs a real peer nothing. Revisit only
     * when a browser is actually meant to be a peer, and give it its own path. */
    if (req.headers.origin) return refuse(403, 'upgrade carries an Origin header, i.e. it is a browser');
    if (String(req.headers['sec-websocket-version']) !== '13') return refuse(400, 'unsupported websocket version');
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return refuse(400, 'missing or malformed Sec-WebSocket-Key');

    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);

    const conn = new WsConnection(socket, { ...connOpts, remoteAddress: peerAddress(req, socket) });
    onConnection(conn);
    // Bytes the HTTP parser had already read past the handshake. Fed AFTER the
    // caller has its listeners on, or the first `hello` is dropped.
    if (head && head.length) conn._read(head);
  });

  return server;
}

// ---- client ----------------------------------------------------------------

/**
 * Dial `ws://host:port/path` or `wss://…`. Returns immediately with a connection
 * that emits 'open' when the handshake completes and 'error' + 'close' when it
 * does not — the same shape `net.connect` gives src/p2p.js, so the reconnect
 * loop there is one code path for both transports.
 */
function connect(url, opts = {}) {
  const conn = new WsConnection(null, { ...opts, role: 'client' });
  const fail = why => setImmediate(() => conn._fail(CLOSE.PROTOCOL, why));

  let u;
  try { u = new URL(url); } catch { fail(`not a URL: ${String(url).slice(0, 64)}`); return conn; }
  const secure = u.protocol === 'wss:';
  if (!secure && u.protocol !== 'ws:') { fail(`not a websocket URL: ${u.protocol}`); return conn; }

  const key = crypto.randomBytes(16).toString('base64');
  const req = (secure ? https : http).request({
    host: u.hostname,
    port: u.port || (secure ? 443 : 80),
    path: (u.pathname || '/') + (u.search || ''),
    headers: {
      Host: u.host,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
    // Deliberately NO Origin header: it is what createServer above uses to tell
    // a browser from a node, and a node that sent one would refuse itself.
  });
  conn._req = req;

  // A tunnel that accepts the TCP connection and then answers nothing must not
  // leave a "connecting" peer forever — the reconnect loop can only run on a close.
  req.setTimeout(opts.handshakeMs || DEFAULTS.handshakeMs, () => req.destroy(new Error('websocket handshake timed out')));

  req.on('upgrade', (res, socket, head) => {
    conn._req = null;
    if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
      try { socket.destroy(); } catch { /* already gone */ }
      conn._fail(CLOSE.PROTOCOL, 'the accept header does not answer our key');
      return;
    }
    conn._attach(socket);
    conn.emit('open');
    if (head && head.length) conn._read(head);
  });
  // 101 is the only success. Anything else — 403 from the Origin check, 404 from
  // a misrouted tunnel, 502 from a tunnel with no origin behind it — is a refusal.
  req.on('response', res => {
    res.resume();
    conn._req = null;
    conn._fail(CLOSE.PROTOCOL, `handshake refused with HTTP ${res.statusCode}`);
  });
  req.on('error', e => {
    conn._req = null;
    if (conn.destroyed) return;
    conn.emit('error', e);
    conn.destroy(CLOSE.GOING_AWAY);
  });
  req.end();
  return conn;
}

module.exports = { WsConnection, createServer, connect, acceptKey, OP, CLOSE, GUID };
