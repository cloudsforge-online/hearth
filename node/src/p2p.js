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
  }

  listen(port) {
    this.server = net.createServer(sock => this._setup(sock, 'in'));
    this.server.listen(port, () => this.node.log(`p2p listening on :${port}`));
  }

  connect(hostport) {
    if (this.stopped) return;
    const [host, port] = hostport.split(':');
    const sock = net.connect({ host, port: Number(port) }, () => {
      this.node.log(`p2p connected to ${hostport}`);
      this._setup(sock, 'out');
    });
    sock.on('error', () => {/* retry loop below */});
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
    if (this.peers.size >= P.P2P_MAX_PEERS) { sock.destroy(); return; }
    this.peers.add(sock);
    let buf = '';
    sock.on('data', d => {
      buf += d.toString();
      // bound the read buffer: a peer that never sends a newline can't exhaust memory
      if (buf.length > P.P2P_MAX_LINE) { this.peers.delete(sock); sock.destroy(); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) { try { this._onMsg(sock, JSON.parse(line)); } catch {} }
      }
    });
    sock.on('error', () => this.peers.delete(sock));
    sock.on('close', () => this.peers.delete(sock));
    // handshake carries the network id so a testnet node can't corrupt mainnet
    this._send(sock, this._hello());
    this._startResync();
  }

  _send(sock, msg) { try { sock.write(JSON.stringify(msg) + '\n'); } catch {} }

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
    else if (r.err !== 'known') this.node.log(`p2p rejected block ${b.header.height}: ${r.err}`);
    return r;
  }

  _onMsg(sock, msg) {
    if (!msg || typeof msg !== 'object') return;
    const chain = this.node.chain;
    switch (msg.t) {
      case 'hello': {
        // refuse peers on a different network (prevents cross-chain contamination)
        if (msg.net && msg.net !== P.NETWORK) { this.peers.delete(sock); sock.destroy(); return; }
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
          if (this._accept(b).ok) progress = true;
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
        const r = this._accept(b);
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
