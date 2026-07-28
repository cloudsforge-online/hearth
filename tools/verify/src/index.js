#!/usr/bin/env node
'use strict';
/* Entry point.
 *
 *   HEARTH_RPC_URL=http://127.0.0.1:8545 node src/index.js
 *
 * The chain-id check is fatal, as it is in the faucet and the explorer API: a
 * verifier pointed at the wrong chain publishes "verified" against bytecode
 * from somewhere else, which is worse than publishing nothing.
 */

const { env } = require('./env');
const { logger } = require('./log');
const { Rpc } = require('./rpc');
const { Store } = require('./store');
const { SolcRegistry } = require('./solc');
const { Verifier } = require('./verifier');
const { createServer } = require('./server');

function build(e = env) {
  const rpc = new Rpc(e.rpcUrl);
  const store = new Store(e.dataDir);
  const registry = new SolcRegistry(e);
  const verifier = new Verifier({ env: e, rpc, registry, store });
  return { env: e, rpc, store, registry, verifier };
}

async function main() {
  const { rpc, store, registry, verifier } = build();

  logger.info('hearth verify starting', {
    rpcUrl: env.rpcUrl,
    chainId: env.chainId,
    dataDir: env.dataDir,
    solcDir: env.solcDir,
    solcOffline: env.solcOffline,
    verified: store.count,
  });

  try {
    const reported = await rpc.chainId();
    if (reported !== env.chainId) {
      throw new Error(`the node reports chain ${reported}, this service is configured for ${env.chainId}`);
    }
    logger.info('node reached', { chainId: reported });
  } catch (e) {
    if (/reports chain/.test(String(e.message))) throw e;
    logger.warn('could not reach the node at startup; serving anyway, /health will show it', {
      rpcUrl: env.rpcUrl, err: e,
    });
  }

  try {
    await registry.loadList();
    logger.info('compiler list ready', { path: registry.listPath });
  } catch (e) {
    logger.warn('no compiler list yet; verification will fail until one is available', { err: e });
  }

  if (env.host === '0.0.0.0') {
    logger.warn('listening on 0.0.0.0. This service compiles source supplied by anyone who can reach '
      + 'it. There is no TLS and no authentication here — put it behind a proxy and rate-limit it.');
  }

  const server = createServer({ env, verifier, store, registry });
  server.listen(env.port, env.host, () => {
    logger.info('verify listening', { url: `http://${env.host}:${env.port}` });
  });

  const shutdown = signal => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch(e => {
    logger.error('verify failed to start', { err: e });
    process.stderr.write('\n' + String(e.message || e) + '\n');
    process.exit(1);
  });
}

module.exports = { main, build };
