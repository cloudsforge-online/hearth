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
      case '--p2p-ws': o.p2pWsPort = Number(next()); break;
      case '--peer': o.peers.push(next()); break;
      case '--mine': o.mine = true; break;
      // Accepted, then refused under --evm below. The account-model chain
      // derives its coinbase from a KEY it holds (src/evmnode.js), because the
      // block signature is made with it — you cannot mine to an address you do
      // not hold. Silently ignoring the flag meant a node happily mined to its
      // own address while the operator believed otherwise, which is how someone
      // loses a day's rewards to a directory they later delete.
      case '--miner-address': o.minerAddress = next(); break;
      case '--throttle': o.throttle = Number(next()); break;
      case '--evm': o.evm = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help':
        console.log('hearthd [--evm] [--data DIR] [--rpc PORT] [--jsonrpc PORT] [--p2p PORT] [--p2p-ws PORT]');
        console.log('        [--peer H:P|wss://…]... [--mine] [--miner-address ADDR] [--throttle F]');
        console.log('  --evm       run the account-model EVM chain (eth_* JSON-RPC on :8545/)');
        console.log('  --rpc       REST API port            (default 8645)');
        console.log('  --jsonrpc   Ethereum JSON-RPC port   (default 8545, --evm only)');
        console.log('  --p2p       TCP gossip port          (default 8646; 0 = do not listen)');
        console.log('  --p2p-ws    WebSocket gossip port    (off unless set; served at /p2p)');
        console.log('  --peer      a seed, as host:port or as a ws:// / wss:// URL');
        console.log('');
        console.log('To be reached through a Cloudflare Tunnel — which carries WebSocket but not');
        console.log('raw TCP — run with --p2p-ws 8648 and point the ingress at :8648/p2p.');
        process.exit(0);
    }
  }
  // allow env overrides (handy for containers)
  if (process.env.HEARTH_DATA) o.dataDir = process.env.HEARTH_DATA;
  if (process.env.HEARTH_RPC) o.rpcPort = Number(process.env.HEARTH_RPC);
  if (process.env.HEARTH_JSONRPC) o.jsonRpcPort = Number(process.env.HEARTH_JSONRPC);
  if (process.env.HEARTH_P2P) o.p2pPort = Number(process.env.HEARTH_P2P);
  if (process.env.HEARTH_P2P_WS) o.p2pWsPort = Number(process.env.HEARTH_P2P_WS);
  // host:port for a peer on the same network, ws:// or wss:// for one reached
  // through a tunnel. Trimmed, because a compose file wraps long seed lists.
  if (process.env.HEARTH_PEERS) o.peers.push(...process.env.HEARTH_PEERS.split(',').map(s => s.trim()).filter(Boolean));
  if (process.env.HEARTH_MINE === '1') o.mine = true;
  if (process.env.HEARTH_EVM === '1') o.evm = true;
  if (process.env.HEARTH_THROTTLE) o.throttle = Number(process.env.HEARTH_THROTTLE);
  return o;
}

const opts = parse(process.argv);
if (opts.evm && opts.minerAddress) {
  console.error(
    'hearthd: --miner-address is not supported with --evm.\n'
    + '  The coinbase must SIGN the block, so the node mines to the key it HOLDS and\n'
    + '  mining to a bare address is not possible. To mine to a specific account,\n'
    + '  give this process its key: HEARTH_COINBASE_KEY, HEARTH_COINBASE_KEY_FILE,\n'
    + '  <data>/coinbase-keystore.json (encrypted) or <data>/coinbase-key.json.\n'
    + '  `hearth minerkey status` says which of those is in play.');
  process.exit(2);
}
/* A data directory whose genesis.json belongs to another network is refused by
 * src/chain/blockchain.js. Present it as an operator error rather than a crash:
 * under compose this is a restart loop, and a stack trace buries the one line
 * that says which two networks disagree. Only the tagged refusal is caught —
 * anything else is a bug and keeps its stack. */
let node;
try {
  node = opts.evm
    ? new (require('../src/evmnode').EvmNode)(opts)
    : new (require('../src/node').Node)(opts);
} catch (e) {
  // Only the account-model chain has a genesis.json, and by here its module is
  // already loaded — so this require is a cache hit, not a second chance to fail.
  const { GENESIS_NETWORK_MISMATCH } = opts.evm ? require('../src/chain/blockchain') : {};
  /* The coinbase key's refusals belong in the same place and for the same
   * reason. "the key from <data>/coinbase-keystore.json derives 0xA but
   * HEARTH_COINBASE_ADDRESS pins 0xB" is the entire message an operator needs,
   * and it is the message a stack trace hides. micro-org#206. */
  const { COINBASE_KEY_REFUSED } = require('../src/coinbase');
  if (e && e.code && (e.code === GENESIS_NETWORK_MISMATCH || e.code === COINBASE_KEY_REFUSED)) {
    console.error('hearthd: ' + e.message);
    process.exit(2);
  }
  throw e;
}
node.start();

process.on('SIGINT', () => { node.log('shutting down'); process.exit(0); });
