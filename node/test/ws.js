'use strict';
/* RFC 6455 framing — the layer that carries p2p through a Cloudflare Tunnel.
 * Run: node test/ws.js
 *
 * This file exists because src/ws.js is hand-written framing rather than a
 * dependency, and framing is where a hand-written implementation is wrong:
 * masking, the three length forms, continuation, and control frames interleaved
 * inside a fragmented message. Every frame below is BUILT BYTE BY BYTE HERE
 * rather than by calling src/ws.js's own encoder — a decoder tested with its own
 * encoder agrees with itself about a bug, which is exactly the class of check
 * this repository calls "a check that cannot fail".
 *
 * The RFC's own vectors are used where it publishes one (§4.2.2 key/accept, §5.7
 * masked "Hello"), so at least two of these assertions are anchored outside this
 * repository entirely. That is not decoration. The first draft of src/ws.js had
 * the magic GUID subtly wrong; its client and its server agreed with each other,
 * every framing assertion below passed, and no real WebSocket implementation
 * would have completed a handshake with it. The accept vector is the ONLY check
 * here that could have caught that, because it is the only one whose expected
 * value did not come from this repository.
 */

const { EventEmitter } = require('events');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const WS = require('../src/ws');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const sleep = ms => new Promise(r => setTimeout(r, ms));
function wait(fn, ms = 5000) {
  return new Promise(res => {
    const t0 = Date.now();
    (function tick() {
      if (fn()) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(tick, 5);
    })();
  });
}

// ---- a socket that records instead of transmitting -------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.destroyed = false;
    this.writableLength = 0;
    this.remoteAddress = '203.0.113.7';
    this.remotePort = 44321;
  }
  write(b) { this.chunks.push(Buffer.from(b)); return true; }
  destroy() { if (this.destroyed) return; this.destroyed = true; setImmediate(() => this.emit('close')); }
  setNoDelay() {}
  setKeepAlive() {}
  out() { return Buffer.concat(this.chunks); }
  feed(buf) { this.emit('data', Buffer.from(buf)); }
}

// ---- an encoder and a decoder written FOR THIS TEST, from the RFC ----------

/** Build one frame. `mask` masks it the way a client must; `rsv` sets RSV1-3. */
function frame(op, payload, { fin = true, mask = false, rsv = 0, lenForm } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const n = body.length;
  const form = lenForm || (n < 126 ? 7 : n < 65536 ? 16 : 64);
  const head = [];
  head.push((fin ? 0x80 : 0) | (rsv << 4) | op);
  const maskBit = mask ? 0x80 : 0;
  if (form === 7) head.push(maskBit | n);
  else if (form === 16) head.push(maskBit | 126, (n >> 8) & 0xff, n & 0xff);
  else {
    head.push(maskBit | 127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  const parts = [Buffer.from(head)];
  if (mask) {
    const key = mask === true ? crypto.randomBytes(4) : Buffer.from(mask);
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
    parts.push(key, masked);
  } else {
    parts.push(body);
  }
  return Buffer.concat(parts);
}

/** Decode every complete frame in `buf`. Deliberately simple and separate. */
function decode(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const fin = (buf[i] & 0x80) !== 0;
    const op = buf[i] & 0x0f;
    const masked = (buf[i + 1] & 0x80) !== 0;
    let len = buf[i + 1] & 0x7f;
    let off = i + 2;
    if (len === 126) { len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(off)); off += 8; }
    let key = null;
    if (masked) { key = buf.slice(off, off + 4); off += 4; }
    if (off + len > buf.length) break;
    const body = Buffer.from(buf.slice(off, off + len));
    if (key) for (let k = 0; k < body.length; k++) body[k] ^= key[k & 3];
    out.push({ fin, op, masked, payload: body });
    i = off + len;
  }
  return out;
}

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** A server-role connection over a fake socket, with the frames it emitted. */
function server(opts = {}) {
  const sock = new FakeSocket();
  const conn = new WS.WsConnection(sock, { role: 'server', maxMessageBytes: 1024, pingMs: 0, idleMs: 0, ...opts });
  const got = [];
  conn.on('data', d => got.push(d.toString()));
  const closed = [];
  conn.on('close', () => closed.push(true));
  return { sock, conn, got, closed, sent: () => decode(sock.out()) };
}

(async () => {
  console.log('\nHearth WebSocket framing test\n');

  // ---- 1. the handshake key, against the RFC's own vector -------------------
  group('handshake');
  // RFC 6455 §4.2.2: the key "dGhlIHNhbXBsZSBub25jZQ==" must produce this accept.
  assert(WS.acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'Sec-WebSocket-Accept matches the vector published in RFC 6455 §4.2.2');

  // ---- 2. decoding a client frame, against the RFC's own vector -------------
  group('decoding');
  {
    // RFC 6455 §5.7: a single-frame masked text message carrying "Hello".
    const rfc = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    const s = server();
    s.sock.feed(rfc);
    assert(s.got.length === 1 && s.got[0].startsWith('Hello'),
      'the masked "Hello" frame from RFC 6455 §5.7 decodes to Hello');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.TEXT, '{"t":"hello"}', { mask: true }));
    assert(s.got.length === 1 && s.got[0] === '{"t":"hello"}\n',
      'a message that carries no newline is delivered WITH one — one WS message is one NDJSON line');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.TEXT, '{"t":"hello"}\n', { mask: true }));
    assert(s.got.length === 1 && s.got[0] === '{"t":"hello"}\n',
      'and a message that already ends in a newline is passed through unchanged');
  }
  {
    // fragmented: "Hel" + "lo", the second frame a continuation
    const s = server();
    s.sock.feed(frame(OP.TEXT, 'Hel', { fin: false, mask: true }));
    assert(s.got.length === 0, 'an unfinished fragment delivers nothing yet');
    s.sock.feed(frame(OP.CONT, 'lo', { fin: true, mask: true }));
    assert(s.got.length === 1 && s.got[0] === 'Hello\n', 'and the continuation completes it as ONE message');
  }
  {
    // a control frame is allowed to sit between two fragments (RFC §5.4)
    const s = server();
    s.sock.feed(frame(OP.TEXT, 'Hel', { fin: false, mask: true }));
    s.sock.feed(frame(OP.PING, 'mid', { mask: true }));
    s.sock.feed(frame(OP.CONT, 'lo', { fin: true, mask: true }));
    assert(s.got.length === 1 && s.got[0] === 'Hello\n',
      'a PING interleaved between fragments does not corrupt the message');
    const pong = s.sent().find(f => f.op === OP.PONG);
    assert(pong && pong.payload.toString() === 'mid', 'and it is answered with a PONG carrying the same payload');
  }
  {
    // one frame delivered one byte at a time — the TCP case that has no frame boundaries
    const s = server();
    const bytes = frame(OP.TEXT, '{"t":"getblocks"}', { mask: true });
    for (const b of bytes) s.sock.feed(Buffer.from([b]));
    assert(s.got.length === 1 && s.got[0] === '{"t":"getblocks"}\n',
      'a frame split across single-byte reads reassembles');
  }
  {
    // two frames in one read
    const s = server();
    s.sock.feed(Buffer.concat([frame(OP.TEXT, 'a', { mask: true }), frame(OP.TEXT, 'b', { mask: true })]));
    assert(s.got.join('') === 'a\nb\n', 'two frames arriving in one read are both delivered');
  }
  {
    // 16-bit and 64-bit length forms
    const big = 'x'.repeat(300);
    const s = server();
    s.sock.feed(frame(OP.TEXT, big, { mask: true }));
    assert(s.got.length === 1 && s.got[0] === big + '\n', 'the 16-bit length form decodes');
    const s2 = server();
    s2.sock.feed(frame(OP.TEXT, 'tiny', { mask: true, lenForm: 64 }));
    assert(s2.got.length === 1 && s2.got[0] === 'tiny\n', 'and so does the 64-bit form');
  }

  // ---- 3. what a server must refuse ----------------------------------------
  group('refusals');
  {
    // RFC §5.1: a server MUST close on an unmasked frame from a client.
    const s = server();
    s.sock.feed(frame(OP.TEXT, 'unmasked', { mask: false }));
    assert(s.got.length === 0, 'an UNMASKED frame from a client delivers nothing');
    assert(s.conn.destroyed, 'and the connection is closed, as RFC 6455 §5.1 requires');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.TEXT, 'reserved', { mask: true, rsv: 1 }));
    assert(s.got.length === 0 && s.conn.destroyed, 'a frame with an RSV bit set is refused — no extension was negotiated');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.PING, Buffer.alloc(126), { mask: true }));
    assert(s.got.length === 0 && s.conn.destroyed, 'a control frame over 125 bytes is refused');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.PING, 'x', { mask: true, fin: false }));
    assert(s.conn.destroyed, 'a FRAGMENTED control frame is refused');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.CONT, 'orphan', { mask: true }));
    assert(s.got.length === 0 && s.conn.destroyed, 'a continuation with nothing to continue is refused');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.TEXT, 'one', { fin: false, mask: true }));
    s.sock.feed(frame(OP.TEXT, 'two', { fin: false, mask: true }));
    assert(s.conn.destroyed, 'a new data frame inside an unfinished message is refused');
  }
  {
    const s = server();
    s.sock.feed(frame(0x3, 'unknown opcode', { mask: true }));
    assert(s.conn.destroyed, 'an unknown opcode is refused');
  }

  // ---- 4. the bound that keeps a peer from exhausting memory ----------------
  group('message bound (the WS half of P2P_MAX_LINE)');
  {
    // A single oversized frame is refused FROM ITS HEADER — the payload is never
    // buffered, which is the whole point: a peer must not be able to make us
    // allocate by announcing a length.
    const s = server({ maxMessageBytes: 1024 });
    const head = frame(OP.TEXT, Buffer.alloc(4096), { mask: true }).slice(0, 8);
    s.sock.feed(head);
    assert(s.conn.destroyed, 'a frame DECLARING more than the cap is refused before its payload arrives');
    assert(s.got.length === 0, 'and nothing is delivered');
  }
  {
    // …and the same bound applies across continuation frames, which is the way
    // around a per-frame cap.
    const s = server({ maxMessageBytes: 1024 });
    for (let i = 0; i < 20 && !s.conn.destroyed; i++) {
      s.sock.feed(frame(i === 0 ? OP.TEXT : OP.CONT, Buffer.alloc(100), { fin: false, mask: true }));
    }
    assert(s.conn.destroyed, 'fragments that TOGETHER exceed the cap are refused — the cap is on the message');
    assert(s.got.length === 0, 'and no partial message is delivered');
  }
  {
    // a 64-bit length with the high word set must not overflow into "small"
    const s = server({ maxMessageBytes: 1024 });
    s.sock.feed(Buffer.from([0x81, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]));
    assert(s.conn.destroyed, 'a 64-bit length above 2^32 is refused rather than truncated');
  }

  // ---- 5. what a server writes ---------------------------------------------
  group('encoding');
  {
    const s = server();
    s.conn.write('{"t":"block"}\n');
    const f = s.sent();
    assert(f.length === 1 && f[0].op === OP.TEXT && f[0].fin, 'write() emits one FINal text frame');
    assert(f[0].masked === false, 'a SERVER frame is not masked, as RFC 6455 §5.1 requires');
    assert(f[0].payload.toString() === '{"t":"block"}\n', 'and carries the line verbatim, newline included');
  }
  {
    const s = server();
    s.conn.write('y'.repeat(70000));
    const f = s.sent();
    assert(f.length === 1 && f[0].payload.length === 70000, 'a payload over 64 KiB round-trips through the 64-bit length form');
  }
  {
    const s = server();
    s.sock.feed(frame(OP.CLOSE, Buffer.from([0x03, 0xe8]), { mask: true }));
    assert(s.sent().some(f => f.op === OP.CLOSE), 'a CLOSE is echoed');
    assert(await wait(() => s.conn.destroyed), 'and the connection goes away');
  }
  {
    const s = server();
    s.conn.destroy();
    assert(s.conn.destroyed, 'destroy() marks the connection dead SYNCHRONOUSLY — p2p.js reads sock.destroyed mid-frame');
    assert(s.sent().some(f => f.op === OP.CLOSE), 'and sends a close frame on the way out');
  }

  // ---- 6. the surface p2p.js's _setup() actually uses -----------------------
  group('the socket surface _setup() expects');
  {
    const s = server();
    assert(typeof s.conn.write === 'function' && typeof s.conn.destroy === 'function',
      'write() and destroy() exist');
    assert(s.conn.remoteAddress === '203.0.113.7' && s.conn.remotePort === 44321,
      'remoteAddress/remotePort name the peer, so a log line can');
    assert(typeof s.conn.writableLength === 'number',
      'writableLength exists — p2p.js:467 uses it to keep one getblocks page in flight per peer');
    s.sock.writableLength = 4096;
    assert(s.conn.writableLength === 4096, 'and it follows the underlying socket rather than being a constant 0');
    // A connection object that throws on an unhandled 'error' would take the node
    // down; p2p attaches its handler in _setup, which is AFTER the handshake.
    let threw = false;
    try { s.conn._fail(1002, 'test'); } catch { threw = true; }
    assert(!threw, 'an error with no listener attached does not throw');
  }

  // ---- 7. keepalive: Cloudflare closes an idle WebSocket --------------------
  group('keepalive');
  {
    const s = server({ pingMs: 30, idleMs: 10_000 });
    assert(await wait(() => s.sent().some(f => f.op === OP.PING), 2000),
      'the server pings on its own — without this a tunnelled link dies quietly');
    s.conn.destroy();
  }
  {
    // a peer that answers nothing at all is dropped
    const s = server({ pingMs: 20, idleMs: 60 });
    assert(await wait(() => s.conn.destroyed, 3000), 'a peer that never answers a ping is dropped');
  }
  {
    // …and one that does answer is kept
    const s = server({ pingMs: 20, idleMs: 120 });
    const keep = setInterval(() => s.sock.feed(frame(OP.PONG, '', { mask: true })), 15);
    await sleep(400);
    clearInterval(keep);
    assert(!s.conn.destroyed, 'a peer that answers is kept — the liveness check is not a timer that always fires');
    s.conn.destroy();
  }

  // ---- 8. the real server, over a real socket ------------------------------
  group('over a real socket');
  const listen = (srv) => new Promise(res => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));

  const accepted = [];
  const refused = [];
  const srv = WS.createServer({
    path: '/p2p',
    maxMessageBytes: 4096,
    pingMs: 0,
    idleMs: 0,
    onConnection: c => { accepted.push(c); c.on('data', d => c.write('echo:' + d.toString())); },
    onRefused: (why, fields) => refused.push({ why, fields }),
  });
  const port = await listen(srv);

  /** Do the handshake by hand and return the raw socket plus the response head. */
  function raw(pathname, headers = {}) {
    return new Promise((res, rej) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        const key = crypto.randomBytes(16).toString('base64');
        const lines = [
          `GET ${pathname} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket', 'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
        ];
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        s.write(lines.join('\r\n') + '\r\n\r\n');
        let head = '';
        const onData = d => {
          head += d.toString('latin1');
          if (head.includes('\r\n\r\n')) { s.removeListener('data', onData); res({ s, head, key }); }
        };
        s.on('data', onData);
      });
      s.on('error', rej);
      setTimeout(() => rej(new Error('handshake timed out')), 4000).unref();
    });
  }

  {
    const { s, head, key } = await raw('/p2p');
    assert(head.startsWith('HTTP/1.1 101'), 'a well-formed upgrade on /p2p is accepted');
    assert(head.includes('Sec-WebSocket-Accept: ' + WS.acceptKey(key)), 'and the accept header answers the client key');
    assert(await wait(() => accepted.length === 1), 'the server surfaced the connection');
    const seen = [];
    s.on('data', d => seen.push(d));
    s.write(frame(OP.TEXT, 'ping-me\n', { mask: true }));
    assert(await wait(() => decode(Buffer.concat(seen)).some(f => f.op === OP.TEXT), 3000),
      'a masked frame crosses a real socket and comes back');
    const got = decode(Buffer.concat(seen)).find(f => f.op === OP.TEXT);
    assert(got.payload.toString() === 'echo:ping-me\n' && got.masked === false, 'the reply is unmasked and intact');
    s.destroy();
  }
  {
    const { head } = await raw('/wrong');
    assert(/^HTTP\/1\.1 40[04]/.test(head), 'an upgrade on the wrong path is refused');
    assert(refused.some(r => /path/i.test(r.why)), 'and the refusal is reported to the operator');
  }
  {
    // A browser can open a WebSocket to any host with no preflight, so an
    // anonymous page's visitors could fill P2P_MAX_PEERS. Every browser sends
    // Origin; no node does.
    const { head } = await raw('/p2p', { Origin: 'https://evil.example' });
    assert(/^HTTP\/1\.1 403/.test(head), 'an upgrade carrying an Origin header — i.e. a browser — is refused');
    assert(refused.some(r => /origin/i.test(r.why)), 'and named as such in the log');
  }
  {
    const { head } = await raw('/p2p', { 'Sec-WebSocket-Version': '8' });
    assert(/^HTTP\/1\.1 40/.test(head), 'a client asking for a protocol version we do not speak is refused');
  }
  {
    const body = await new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port, path: '/p2p' }, r => res(r.statusCode)).on('error', rej);
    });
    assert(body === 426, 'a plain GET on the p2p port answers 426 Upgrade Required rather than hanging');
  }

  // ---- 9. client and server, both halves of this file, talking -------------
  group('client to server');
  {
    const got = [];
    const conn = WS.connect(`ws://127.0.0.1:${port}/p2p`, { maxMessageBytes: 4096, pingMs: 0, idleMs: 0 });
    conn.on('data', d => got.push(d.toString()));
    const opened = await new Promise(res => { conn.on('open', () => res(true)); conn.on('error', () => res(false)); });
    assert(opened, 'the client completes the handshake against our own server');
    conn.write('{"t":"hello"}\n');
    assert(await wait(() => got.length === 1, 3000), 'and a line written by the client comes back');
    assert(got[0] === 'echo:{"t":"hello"}\n', 'verbatim');
    assert(conn.remoteAddress === '127.0.0.1', 'the client names its peer too');
    conn.destroy();
    assert(await wait(() => accepted[accepted.length - 1].destroyed, 3000), 'and closing the client closes the server side');
  }
  {
    const conn = WS.connect(`ws://127.0.0.1:${port}/nope`, { pingMs: 0, idleMs: 0 });
    const err = await new Promise(res => { conn.on('error', e => res(e)); conn.on('open', () => res(null)); });
    assert(err instanceof Error, 'a client refused at the handshake reports an error rather than looking connected');
    const closed = await new Promise(res => { conn.on('close', () => res(true)); setTimeout(() => res(false), 2000); });
    assert(closed, 'and then closes — which is what drives p2p.js\'s reconnect loop');
  }
  {
    // The client half must mask, or a conforming server hangs up on us.
    const seen = [];
    const plain = net.createServer(s => s.on('data', d => seen.push(d)));
    const pport = await listen(plain);
    const conn = WS.connect(`ws://127.0.0.1:${pport}/p2p`, { pingMs: 0, idleMs: 0 });
    await wait(() => seen.length > 0, 3000);
    const req = Buffer.concat(seen).toString('latin1');
    assert(/^GET \/p2p HTTP\/1\.1/.test(req), 'the client requests the configured path');
    assert(/\r\nSec-WebSocket-Version: 13\r\n/.test(req) && /\r\nSec-WebSocket-Key: /.test(req),
      'with a version 13 handshake and a key');
    assert(!/\r\nOrigin:/i.test(req), 'and NO Origin header — the thing the server above refuses');
    conn.destroy();
    plain.close();
  }

  srv.close();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
