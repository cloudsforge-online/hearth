'use strict';
/* Peer-to-peer gossip over plain TCP (no dependencies). Newline-delimited JSON.
 * Handles block/tx propagation and locator-based fork sync: a node that has
 * diverged sends exponentially-spaced hashes back from its best-work branch and
 * the peer answers from the newest one that sits on its own active chain, so
 * two forked nodes find their common ancestor and exchange the competing branch.
 * Every message is bounded — this surface is reachable by anonymous peers. */

const net = require('net');
const BLOCK = require('./block');
const P = require('./params');

const isHash = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

// remoteAddress is gone once the socket is destroyed, so a close/error log
// would otherwise name no peer at all
const peerName = sock => (sock.remoteAddress ? `${sock.remoteAddress}:${sock.remotePort}` : 'closed');

function isBlock(b) {
  if (!b || typeof b !== 'object') return false;
  const h = b.header;
  if (!h || typeof h !== 'object') return false;
  if (!isHash(h.prevHash)) return false;
  if (!Number.isInteger(h.height) || h.height < 1) return false;
  return Array.isArray(b.txs) && b.txs.length > 0 && b.txs.length <= P.MAX_BLOCK_TXS;
}

class P2P {
  constructor(node) {
    this.node = node;
    this.peers = new Set();   // sockets
    this.server = null;
    this.orphans = new Map(); // blockId -> block, capped, oldest evicted first
    this.resyncMs = (node.opts && node.opts.resyncMs) || P.P2P_RESYNC_MS;
    this.timer = null;
    this.stopped = false;
    this._loc = null;         // memoized locator
    this._down = new Set();   // peers we have already reported as unreachable
  }

  listen(port) {
    this.server = net.createServer(sock => this._setup(sock, 'in'));
    this.server.on('error', e => this.node.error('p2p listen failed', { port, err: String(e && e.message || e) }));
    this.server.listen(port, () => this.node.log(`p2p listening on :${port}`, { port }));
  }

  connect(hostport) {
    if (this.stopped) return;
    const [host, port] = hostport.split(':');
    const sock = net.connect({ host, port: Number(port) }, () => {
      this._down.delete(hostport);
      this.node.log(`p2p connected to ${hostport}`, { peer: hostport, dir: 'out', peers: this.peers.size + 1 });
      this._setup(sock, 'out');
    });
    // a seed that is down or moved looks identical to a healthy node otherwise:
    // the retry loop below hides it forever. Said once per outage, since the
    // loop reconnects every 3s and would otherwise fill the log with one peer.
    sock.on('error', e => {
      if (this._down.has(hostport)) return;
      this._down.add(hostport);
      this.node.warn('p2p connect failed', { peer: hostport, err: String(e && e.message || e) });
    });
    sock.on('close', () => {
      if (this.stopped) return;
      setTimeout(() => this.connect(hostport), 3000).unref();
    });
  }

  disconnect() { for (const p of this.peers) p.destroy(); this.peers.clear(); }

  close() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.disconnect();
    if (this.server) { this.server.close(); this.server = null; }
  }

  _setup(sock, dir) {
    // cap inbound peers to resist connection flooding
    if (this.peers.size >= P.P2P_MAX_PEERS) {
      this.node.warn('p2p peer refused: at capacity', { peer: peerName(sock), dir, peers: this.peers.size });
      sock.destroy();
      return;
    }
    this.peers.add(sock);
    // Per-connection budget for proof-of-work verification. See the note on
    // P2P_BLOCK_VERIFY_* in params.js: one verification is a full Homefire
    // evaluation, so an unmetered peer buys a core with a stream of junk.
    sock.cfVerify = { tokens: P.P2P_BLOCK_VERIFY_BURST, at: Date.now() };
    sock.cfInvalid = 0;
    // a misbehaving peer must not be able to write the log as fast as it can
    // write the socket, so each fault is reported once per connection
    const said = new Set();
    const once = (key, level, msg, fields) => { if (!said.has(key)) { said.add(key); this.node[level](msg, fields); } };
    let buf = '';
    sock.on('data', d => {
      buf += d.toString();
      // bound the read buffer: a peer that never sends a newline can't exhaust memory
      if (buf.length > P.P2P_MAX_LINE) {
        this.node.warn('p2p peer dropped: oversized frame', { peer: peerName(sock), dir, bytes: buf.length });
        this.peers.delete(sock); sock.destroy(); return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { this._onMsg(sock, JSON.parse(line)); }
        catch (e) {
          once('parse', 'warn', 'p2p malformed message', {
            peer: peerName(sock), dir, err: String(e && e.message || e), bytes: line.length,
          });
        }
      }
    });
    sock.on('error', e => {
      once('err', 'warn', 'p2p peer error', { peer: peerName(sock), dir, err: String(e && e.message || e) });
      this.peers.delete(sock);
    });
    sock.on('close', () => {
      if (this.peers.delete(sock)) this.node.warn('p2p peer disconnected', { peer: peerName(sock), dir, peers: this.peers.size });
    });
    // handshake carries the network id so a testnet node can't corrupt mainnet
    this._send(sock, this._hello());
    this._startResync();
  }

  _send(sock, msg) {
    try { sock.write(JSON.stringify(msg) + '\n'); }
    catch (e) { this.node.debug('p2p send failed', { peer: peerName(sock), t: msg && msg.t, err: String(e && e.message || e) }); }
  }

  broadcast(msg, except) {
    for (const p of this.peers) if (p !== except) this._send(p, msg);
  }

  _hello() {
    const chain = this.node.chain;
    return { t: 'hello', net: P.NETWORK, height: chain.height, tip: chain.tipId };
  }

  // ---- sync ---------------------------------------------------------------
  _startResync() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this._resync(), this.resyncMs);
    this.timer.unref();
  }

  _resync() {
    if (!this.peers.size) return;
    const locator = this._locator();
    for (const p of this.peers) this._send(p, { t: 'getblocks', locator });
  }

  _sync(sock) { this._send(sock, { t: 'getblocks', locator: this._locator() }); }

  /* Exponentially-spaced hashes back from our heaviest *stored* branch — not
   * just the active tip, so a fetch that has not yet won the fork choice still
   * makes progress on the next round trip. Genesis is always last, so a common
   * ancestor is always found. */
  _locator() {
    const chain = this.node.chain;
    // memoized on (tip, store size): building it walks the chain, and a peer
    // spamming hellos with invented tips must not buy an O(chain) walk each time
    const key = chain.tipId + ':' + chain.store.size;
    if (this._loc && this._loc.key === key) return this._loc.val;
    let e = chain.store.get(chain.tipId);
    for (const c of chain.store.values()) if (c.work > e.work) e = c;
    const out = [];
    let step = 1;
    while (e && out.length < P.P2P_MAX_LOCATOR - 1) {
      out.push(e.id);
      if (e.height === 0) break;
      if (out.length > 8) step *= 2;
      for (let i = 0; i < step && e && e.height > 0; i++) e = chain.store.get(e.block.header.prevHash);
    }
    const genesis = chain.chainIndex[0];
    if (out[out.length - 1] !== genesis) out.push(genesis);
    this._loc = { key, val: out };
    return out;
  }

  // ---- orphans ------------------------------------------------------------
  _orphan(b) {
    const id = BLOCK.blockId(b);
    if (this.orphans.has(id)) return;
    if (this.orphans.size >= P.P2P_MAX_ORPHANS) this.orphans.delete(this.orphans.keys().next().value);
    this.orphans.set(id, b);
  }

  _connectOrphans(parentId) {
    const queue = [parentId];
    while (queue.length) {
      const pid = queue.shift();
      for (const [id, b] of this.orphans) {
        if (b.header.prevHash !== pid) continue;
        this.orphans.delete(id);
        const r = this.node.chain.addBlock(b);
        if (r.ok) queue.push(r.id);
      }
    }
  }

  _accept(b) {
    const r = this.node.chain.addBlock(b);
    if (r.ok) this._connectOrphans(r.id);
    else if (r.err === 'unknown parent') this._orphan(b);
    // a peer feeding us invalid blocks is either broken or hostile; either way
    // it is the one failure here that nothing else in the system would show
    else if (r.err !== 'known') this.node.error(`p2p rejected block ${b.header.height}: ${r.err}`,
      { height: b.header.height, prevHash: b.header.prevHash, err: r.err });
    return r;
  }

  /**
   * Accept a block a specific peer sent us, charging that peer for the work.
   *
   * Returns null when the peer is over budget, which the callers read as "stop
   * reading this frame".
   *
   * The budget meters WASTED verification, not verification. A token is taken
   * before the work and given back when the outcome shows the peer did not cost
   * us a proof, or cost us one worth paying:
   *
   *   ok              — the block extended or forked our chain. Producing it
   *                     cost the sender a real proof; we are the beneficiary.
   *   known           — `_ingest` returns this from its first line, before any
   *                     hashing, so nothing was spent.
   *   unknown parent  — likewise, and it is ordinary out-of-order sync traffic.
   *
   * Everything else is a block that made us run Homefire (~8,450 sequential
   * SHA-256, ~5ms of a core) for nothing, and keeps its token.
   *
   * This distinction is the whole point. A flat limit bounds the attack but also
   * throttles initial sync, which is the one time an honest peer legitimately
   * pushes thousands of blocks at us as fast as the wire allows — capping that
   * at P2P_BLOCK_VERIFY_PER_S would turn a long chain into an hours-long sync.
   * Refunding useful work means honest sync never touches the limiter, while a
   * peer sending junk still runs out and is disconnected by the invalid-block
   * budget long before the bucket matters.
   */
  _acceptFrom(sock, b) {
    const v = sock.cfVerify;
    if (v) {
      const now = Date.now();
      v.tokens = Math.min(P.P2P_BLOCK_VERIFY_BURST,
        v.tokens + ((now - v.at) / 1000) * P.P2P_BLOCK_VERIFY_PER_S);
      v.at = now;
      if (v.tokens < 1) {
        if (!v.said) {
          v.said = true;
          this.node.warn('p2p peer throttled: block verification budget exhausted',
            { peer: peerName(sock), invalid: sock.cfInvalid });
        }
        return null;
      }
      v.tokens -= 1;
    }
    const r = this._accept(b);
    const wasted = !r.ok && r.err !== 'known' && r.err !== 'unknown parent';
    if (!wasted) {
      if (v) v.tokens = Math.min(P.P2P_BLOCK_VERIFY_BURST, v.tokens + 1);
      return r;
    }
    if (++sock.cfInvalid >= P.P2P_MAX_INVALID_BLOCKS) {
      this.node.warn('p2p peer dropped: too many invalid blocks',
        { peer: peerName(sock), invalid: sock.cfInvalid });
      this.peers.delete(sock);
      sock.destroy();
      return null;
    }
    return r;
  }

  _onMsg(sock, msg) {
    if (!msg || typeof msg !== 'object') return;
    const chain = this.node.chain;
    switch (msg.t) {
      case 'hello': {
        // refuse peers on a different network (prevents cross-chain contamination)
        if (msg.net && msg.net !== P.NETWORK) {
          this.node.warn('p2p peer dropped: wrong network', { peer: peerName(sock), theirs: String(msg.net).slice(0, 32), ours: P.NETWORK });
          this.peers.delete(sock); sock.destroy(); return;
        }
        // negotiate on ANY tip we don't hold, not just a taller one — an
        // equal-height peer on a different branch is the case that split forever
        const have = isHash(msg.tip) && chain.store.has(msg.tip);
        if (!have || (Number.isInteger(msg.height) && msg.height > chain.height)) this._sync(sock);
        break;
      }
      case 'getblocks': {
        const loc = msg.locator;
        if (!Array.isArray(loc) || !loc.length || loc.length > P.P2P_MAX_LOCATOR || !loc.every(isHash)) break;
        // one page in flight per peer — a pipelined flood can't make us buffer
        if (sock.writableLength) break;
        let from = 1;
        for (const id of loc) {
          const e = chain.store.get(id);
          if (e && chain.chainIndex[e.height] === id) { from = e.height + 1; break; }
        }
        const out = [];
        for (let h = from; h <= chain.height && out.length < P.P2P_MAX_BLOCKS; h++) out.push(chain.getBlock(h));
        this._send(sock, { t: 'blocks', blocks: out });
        break;
      }
      case 'getblock': {
        // by hash, straight out of the store, so a *side* branch block can be
        // fetched at all — getblocks-by-height structurally cannot answer that
        if (!isHash(msg.id)) break;
        const b = chain.getById(msg.id);
        if (b) this._send(sock, { t: 'blocks', blocks: [b] });
        break;
      }
      case 'blocks': {
        const blocks = msg.blocks;
        if (!Array.isArray(blocks) || blocks.length > P.P2P_MAX_BLOCKS) break;
        let progress = false;
        for (const b of blocks) {
          if (!isBlock(b)) continue;
          const r = this._acceptFrom(sock, b);
          if (!r) break;               // over budget, or the peer just got dropped
          if (r.ok) progress = true;
        }
        if (progress) {
          // let the rest of the network pull from us; one tiny message per peer
          this.broadcast(this._hello(), sock);
          // chase the next page only when the peer filled this one, so a peer
          // replaying blocks we already have cannot spin us
          if (blocks.length >= P.P2P_MAX_BLOCKS) this._sync(sock);
        }
        break;
      }
      case 'block': {
        const b = msg.block;
        if (!isBlock(b)) break;
        const r = this._acceptFrom(sock, b);
        if (!r) break;
        if (r.ok) this.broadcast({ t: 'block', block: b }, sock);
        else if (r.err === 'unknown parent') {
          this._send(sock, { t: 'getblock', id: b.header.prevHash });
          this._sync(sock);
        }
        break;
      }
      case 'tx': {
        const tx = msg.tx;
        if (!tx || typeof tx !== 'object' || typeof tx.id !== 'string') break;
        const r = this.node.mempool.add(tx);
        if (r.ok) this.broadcast({ t: 'tx', tx }, sock);
        break;
      }
    }
  }
}

module.exports = { P2P };
