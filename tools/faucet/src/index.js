#!/usr/bin/env node
'use strict';
/* Entry point. Reads the key, checks it can reach a node, and starts serving.
 *
 *   HEARTH_FAUCET_PRIVATE_KEY=0x… HEARTH_RPC_URL=http://…  node src/index.js
 *
 * The boot sequence refuses more than it accepts on purpose. A faucet that
 * starts happily against the wrong chain hands out real EMBER on mainnet, and
 * a faucet that starts with no balance answers every request with a 502 that
 * looks like someone else's bug.
 */

const { env, readKey } = require('./env');
const { logger, protect } = require('./log');
const { Rpc } = require('./rpc');
const { Limits } = require('./limits');
const { Sender } = require('./sender');
const { createServer, formatEmber } = require('./server');

/* Publicly known development keys. Anvil's and Hardhat's default account is
 * the one people paste while testing and then forget to change; it is funded
 * on every public testnet in the world and swept within seconds. */
const KNOWN_TEST_KEYS = new Set([
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '4646464646464646464646464646464646464646464646464646464646464646',
]);

async function main() {
  const key = readKey();
  // Before anything else can log. From here the raw key cannot appear in a log
  // line even if some future code path passes it to one by accident.
  protect(key);
  if (KNOWN_TEST_KEYS.has(key.toString('hex'))) {
    logger.warn('THE FAUCET KEY IS A PUBLICLY KNOWN TEST KEY. '
      + 'Anyone can spend from it. Acceptable for a local devnet and nowhere else.');
  }

  const rpc = new Rpc(env.rpcUrl);
  const sender = new Sender({
    privateKey: key,
    rpc,
    chainId: env.chainId,
    gasPriceWei: env.gasPriceWei,
    gasLimit: env.gasLimit,
  });

  const limits = new Limits({
    addressCooldownS: env.addressCooldownS,
    ipLimit: env.ipLimit,
    ipWindowS: env.ipWindowS,
    capWei: env.dailyCapWei,
    windowS: env.dailyWindowS,
    statePath: env.statePath,
  });

  logger.info('hearth faucet starting', {
    faucetAddress: sender.address,
    rpcUrl: env.rpcUrl,
    dripEmber: formatEmber(env.dripWei),
    dailyCapEmber: formatEmber(env.dailyCapWei),
    addressCooldownS: env.addressCooldownS,
    ipLimit: env.ipLimit,
    trustProxy: env.trustProxy,
    statePath: env.statePath,
  });

  /* Verify the chain BEFORE serving. `eth_chainId` disagreeing with the
   * configured id is the difference between a testnet faucet and an
   * unauthenticated mainnet withdrawal endpoint, so it is fatal rather than a
   * warning. */
  try {
    const reported = await rpc.chainId();
    if (reported !== env.chainId) {
      throw new Error(`the node reports chain ${reported}, this faucet is configured for ${env.chainId}`);
    }
    const balance = await sender.balance();
    logger.info('node reached', {
      chainId: reported,
      height: String(await rpc.blockNumber()),
      balanceEmber: formatEmber(balance),
    });
    if (balance < sender.maxCostWei(env.dripWei) + env.reserveWei) {
      logger.warn('the faucet has no usable balance and will refuse every request until it is funded', {
        faucetAddress: sender.address, balanceEmber: formatEmber(balance),
      });
    }
  } catch (e) {
    /* Not fatal for anything except a chain-id mismatch: a node that is down at
     * boot is a normal thing on a testnet, /health reports it, and the faucet
     * recovers on its own when the node comes back. */
    if (/reports chain/.test(String(e.message))) throw e;
    logger.warn('could not reach the node at startup; serving anyway, /health will show it', {
      rpcUrl: env.rpcUrl, err: e,
    });
  }

  if (env.trustProxy) {
    logger.warn('HEARTH_FAUCET_TRUST_PROXY is on — x-forwarded-for is believed. '
      + 'Only correct if something in front of this process overwrites that header.');
  }
  if (env.host === '0.0.0.0' && !env.trustProxy) {
    logger.warn('listening on 0.0.0.0 without a proxy: there is no TLS and no auth here. '
      + 'Put it behind one.');
  }

  const server = createServer({ env, limits, sender });
  server.listen(env.port, env.host, () => {
    logger.info('faucet listening', { url: `http://${env.host}:${env.port}` });
  });

  const shutdown = signal => {
    logger.info('shutting down', { signal });
    // Flush the limiter synchronously — losing the last few seconds of state
    // means handing those addresses a second drip after the restart.
    limits.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch(e => {
    logger.error('faucet failed to start', { err: e });
    process.stderr.write('\n' + String(e.message || e) + '\n');
    process.exit(1);
  });
}

module.exports = { main };
