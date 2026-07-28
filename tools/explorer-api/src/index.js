#!/usr/bin/env node
'use strict';
/* Entry point. Opens the index, checks the chain, starts indexing, starts
 * serving.
 *
 *   HEARTH_RPC_URL=http://127.0.0.1:8545 \
 *   HEARTH_COMMONS_ADDRESS=0x… \
 *   node src/index.js
 *
 * The chain-id check is FATAL, exactly as it is in the faucet. An index built
 * against one chain and served as another is not a degraded service; it is a
 * service that publishes another chain's supply figure under our name.
 */

const { env } = require('./env');
const { logger } = require('./log');
const { Rpc } = require('./rpc');
const { Store } = require('./store');
const { Indexer } = require('./indexer');
const { Hydrator } = require('./hydrate');
const { Supply, formatEmber } = require('./supply');
const { VerifyClient } = require('./verifyclient');
const { Api } = require('./api');
const { createServer } = require('./server');

/**
 * Wire the whole service together.
 *
 * `e` defaults to the process environment and is a parameter only so that the
 * tests can stand up two independent stacks in one process. Nothing in
 * production passes it.
 */
function build(e = env) {
  const rpc = new Rpc(e.rpcUrl, { timeoutMs: e.rpcTimeoutMs });
  const store = new Store({
    dir: e.dataDir, chainId: e.chainId, startBlock: e.startBlock, syncEvery: e.syncEvery,
  }).open();
  const indexer = new Indexer({ store, rpc, env: e });
  const hydrator = new Hydrator({ rpc, blockCache: e.blockCache });
  const supply = new Supply({ env: e, rpc });
  const verify = e.verifyUrl ? new VerifyClient(e.verifyUrl) : null;
  const api = new Api({ env: e, store, indexer, rpc, hydrator, supply, verify });

  /* The hydrator caches blocks by number. After a reorg those numbers name
   * different blocks, so the cache has to go with the index. Without this the
   * explorer serves the orphaned block's transactions from memory while the
   * index correctly points at the new ones. */
  const unwind = store.unwindTo.bind(store);
  store.unwindTo = keepThrough => {
    hydrator.invalidateFrom(keepThrough + 1);
    return unwind(keepThrough);
  };

  return { env: e, rpc, store, indexer, hydrator, supply, verify, api };
}

async function main() {
  const parts = build();
  const { rpc, store, indexer, supply, hydrator, api } = parts;

  logger.info('hearth explorer api starting', {
    rpcUrl: env.rpcUrl,
    chainId: env.chainId,
    dataDir: env.dataDir,
    index: store.stats(),
    repaired: store.repaired,
    commonsAddress: env.commonsAddress || '(unset — circulating supply will be refused)',
    verifyUrl: env.verifyUrl || '(unset — every contract reads as unverified)',
  });

  if (!env.commonsAddress) {
    logger.warn('HEARTH_COMMONS_ADDRESS is not set. /supply/circulating will return an error rather '
      + 'than a number, because circulating = total − Commons treasury (docs/tokenomics.md §7) and '
      + 'serving total under the name "circulating" is the exact defect this service exists to fix.');
  }

  try {
    const reported = await rpc.chainId();
    if (reported !== env.chainId) {
      throw new Error(`the node reports chain ${reported}, this service is configured for ${env.chainId}`);
    }
    logger.info('node reached', { chainId: reported, height: String(await rpc.blockNumber()) });
  } catch (e) {
    if (/reports chain/.test(String(e.message))) throw e;
    logger.warn('could not reach the node at startup; serving anyway, /health will show it', {
      rpcUrl: env.rpcUrl, err: e,
    });
  }

  await indexer.start();

  const server = createServer({ env, api, supply, store, indexer, rpc, hydrator });
  server.listen(env.port, env.host, () => {
    logger.info('explorer api listening', { url: `http://${env.host}:${env.port}` });
  });

  const shutdown = signal => {
    logger.info('shutting down', { signal });
    indexer.stop();
    store.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch(e => {
    logger.error('explorer api failed to start', { err: e });
    process.stderr.write('\n' + String(e.message || e) + '\n');
    process.exit(1);
  });
}

module.exports = { main, build, formatEmber };
