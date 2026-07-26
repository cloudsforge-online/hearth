#!/usr/bin/env node
'use strict';
/* Start a Hearth node.
 *
 *   hearthd [--data DIR] [--rpc PORT] [--p2p PORT] [--peer HOST:PORT ...]
 *           [--mine] [--miner-address ADDR] [--throttle 0.35]
 */

const path = require('path');
const { Node } = require('../src/node');

function parse(argv) {
  const o = { peers: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--data': o.dataDir = path.resolve(next()); break;
      case '--rpc': o.rpcPort = Number(next()); break;
      case '--p2p': o.p2pPort = Number(next()); break;
      case '--peer': o.peers.push(next()); break;
      case '--mine': o.mine = true; break;
      case '--miner-address': o.minerAddress = next(); break;
      case '--throttle': o.throttle = Number(next()); break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help':
        console.log('hearthd [--data DIR] [--rpc PORT] [--p2p PORT] [--peer H:P]... [--mine] [--miner-address ADDR] [--throttle F]');
        process.exit(0);
    }
  }
  // allow env overrides (handy for containers)
  if (process.env.HEARTH_DATA) o.dataDir = process.env.HEARTH_DATA;
  if (process.env.HEARTH_RPC) o.rpcPort = Number(process.env.HEARTH_RPC);
  if (process.env.HEARTH_P2P) o.p2pPort = Number(process.env.HEARTH_P2P);
  if (process.env.HEARTH_PEERS) o.peers.push(...process.env.HEARTH_PEERS.split(',').filter(Boolean));
  if (process.env.HEARTH_MINE === '1') o.mine = true;
  if (process.env.HEARTH_THROTTLE) o.throttle = Number(process.env.HEARTH_THROTTLE);
  return o;
}

const node = new Node(parse(process.argv));
node.start();

process.on('SIGINT', () => { node.log('shutting down'); process.exit(0); });
