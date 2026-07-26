'use strict';
/* Peer-to-peer gossip over plain TCP (no dependencies). Newline-delimited JSON.
 * Handles block/tx propagation and headers-behind sync. Deliberately simple —
 * it favors clarity over the optimizations a production node needs. */

const net = require('net');
const BLOCK = require('./block');
const P = require('./params');

class P2P {
  constructor(node) {
    this.node = node;
    this.peers = new Set();   // sockets
    this.server = null;
  }

  listen(port) {
    this.server = net.createServer(sock => this._setup(sock, 'in'));
    this.server.listen(port, () => this.node.log(`p2p listening on :${port}`));
  }

  connect(hostport) {
    const [host, port] = hostport.split(':');
    const sock = net.connect({ host, port: Number(port) }, () => {
      this.node.log(`p2p connected to ${hostport}`);
      this._setup(sock, 'out');
    });
    sock.on('error', () => {/* retry loop below */});
    sock.on('close', () => setTimeout(() => this.connect(hostport), 3000));
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
    this._send(sock, { t: 'hello', net: P.NETWORK, height: this.node.chain.height });
  }

  _send(sock, msg) { try { sock.write(JSON.stringify(msg) + '\n'); } catch {} }

  broadcast(msg, except) {
    for (const p of this.peers) if (p !== except) this._send(p, msg);
  }

  _onMsg(sock, msg) {
    const chain = this.node.chain;
    switch (msg.t) {
      case 'hello':
        // refuse peers on a different network (prevents cross-chain contamination)
        if (msg.net && msg.net !== P.NETWORK) { this.peers.delete(sock); sock.destroy(); return; }
        if (msg.height > chain.height) this._send(sock, { t: 'getblocks', from: chain.height + 1 });
        break;
      case 'getblocks': {
        const out = [];
        for (let h = msg.from; h <= chain.height && out.length < 200; h++) out.push(chain.getBlock(h));
        this._send(sock, { t: 'blocks', blocks: out });
        break;
      }
      case 'blocks':
        for (const b of msg.blocks) {
          const r = chain.addBlock(b);
          if (!r.ok && r.err !== 'bad height' && r.err !== 'prevHash mismatch') {
            this.node.log(`p2p rejected block ${b.header.height}: ${r.err}`);
          }
        }
        // still behind? ask for more
        if (msg.blocks.length > 0) this._send(sock, { t: 'getblocks', from: chain.height + 1 });
        break;
      case 'block': {
        const b = msg.block;
        if (b.header.height <= chain.height) break; // already have (or fork we ignore)
        const r = chain.addBlock(b);
        if (r.ok) this.broadcast({ t: 'block', block: b }, sock);
        else if (r.err === 'prevHash mismatch' || r.err === 'bad height')
          this._send(sock, { t: 'getblocks', from: chain.height + 1 }); // we're behind
        break;
      }
      case 'tx': {
        const r = this.node.mempool.add(msg.tx);
        if (r.ok) this.broadcast({ t: 'tx', tx: msg.tx }, sock);
        break;
      }
    }
  }
}

module.exports = { P2P };
