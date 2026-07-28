#!/usr/bin/env node
'use strict';
/* Start a Hearth node — one of the two chains.
 *
 *   hearthd [--data DIR] [--rpc PORT] [--p2p PORT] [--peer HOST:PORT ...]
 *           [--mine] [--miner-address ADDR] [--throttle 0.35]
 *
 *   hearthd --evm [--jsonrpc PORT] …          the account-model, EVM-executing chain
 *
 * `--evm` selects the chain docs/evm-spec.md describes: 0x addresses, secp256k1,
 * Shanghai semantics, and the Ethereum JSON-RPC surface on its own port. It is a
 * DIFFERENT CHAIN, not an upgrade — different state model, different addresses,
 * different genesis — so the two do not share a data directory and will not talk to
 * each other. The UTXO chain remains the default while the browser wallet, the
 * browser miner and Forge Pay are still written against it; flipping that default
 * is a one-line change here once they are ported.
 */

const path = require('path');

function parse(argv) {
  const o = { peers: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--data': o.dataDir = path.resolve(next()); break;
      case '--rpc': o.rpcPort = Number(next()); break;
      case '--jsonrpc': case '--eth-rpc': o.jsonRpcPort = Number(next()); break;
      case '--p2p': o.p2pPort = Number(next()); break;
      case '--peer': o.peers.push(next()); break;
      case '--mine': o.mine = true; break;
      case '--miner-address': o.minerAddress = next(); break;
      case '--throttle': o.throttle = Number(next()); break;
      case '--evm': o.evm = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help':
        console.log('hearthd [--evm] [--data DIR] [--rpc PORT] [--jsonrpc PORT] [--p2p PORT] [--peer H:P]... [--mine] [--miner-address ADDR] [--throttle F]');
        console.log('  --evm       run the account-model EVM chain (eth_* JSON-RPC on :8545/)');
        console.log('  --rpc       REST API port            (default 8645)');
        console.log('  --jsonrpc   Ethereum JSON-RPC port   (default 8545, --evm only)');
        process.exit(0);
    }
  }
  // allow env overrides (handy for containers)
  if (process.env.HEARTH_DATA) o.dataDir = process.env.HEARTH_DATA;
  if (process.env.HEARTH_RPC) o.rpcPort = Number(process.env.HEARTH_RPC);
  if (process.env.HEARTH_JSONRPC) o.jsonRpcPort = Number(process.env.HEARTH_JSONRPC);
  if (process.env.HEARTH_P2P) o.p2pPort = Number(process.env.HEARTH_P2P);
  if (process.env.HEARTH_PEERS) o.peers.push(...process.env.HEARTH_PEERS.split(',').filter(Boolean));
  if (process.env.HEARTH_MINE === '1') o.mine = true;
  if (process.env.HEARTH_EVM === '1') o.evm = true;
  if (process.env.HEARTH_THROTTLE) o.throttle = Number(process.env.HEARTH_THROTTLE);
  return o;
}

const opts = parse(process.argv);
const node = opts.evm
  ? new (require('../src/evmnode').EvmNode)(opts)
  : new (require('../src/node').Node)(opts);
node.start();

process.on('SIGINT', () => { node.log('shutting down'); process.exit(0); });
