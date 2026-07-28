'use strict';
/* Configuration, read once at boot. Every value has a default that works
 * except the two that must never be guessed:
 *
 *   HEARTH_COMMONS_ADDRESS  — without it, circulating supply is REFUSED rather
 *                             than served as total supply. See supply.js.
 *   HEARTH_RPC_URL          — points at a node; the default is the local one.
 */

const path = require('path');

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return v === '1' || String(v).toLowerCase() === 'true';
};

/** A 0x-prefixed 20-byte address, lowercased, or null. Never throws on absent. */
function address(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new Error(`not a 0x address: ${s}`);
  }
  return s.toLowerCase();
}

const env = {
  port: num(process.env.HEARTH_EXPLORER_API_PORT, 8647 + 1000),   // 9647
  host: process.env.HEARTH_EXPLORER_API_HOST || '127.0.0.1',

  /* The Ethereum JSON-RPC endpoint — port 8545 by settled decision
   * (docs/evm-spec.md §6, "Where it mounts"). NOT 8645, which is the UTXO-era
   * REST API and answers a POST with a 200 that is not JSON-RPC. */
  rpcUrl: process.env.HEARTH_RPC_URL || 'http://127.0.0.1:8545',
  rpcTimeoutMs: num(process.env.HEARTH_EXPLORER_API_RPC_TIMEOUT_MS, 20_000),

  chainId: num(process.env.HEARTH_CHAIN_ID, 7411),

  /** Where the index lives. It is disposable — it can always be rebuilt from a
   *  node — but rebuilding it is a full re-walk, so keep it on a real volume. */
  dataDir: process.env.HEARTH_EXPLORER_API_DATA || path.join(process.cwd(), 'explorer-index'),

  /** First block to index. 0 unless you are deliberately indexing a suffix. */
  startBlock: num(process.env.HEARTH_EXPLORER_API_START_BLOCK, 0),

  /** How often to look for new blocks. Block time is 15 s; 2 s keeps the tip
   *  fresh without hammering a node that has nothing new to say. */
  pollMs: num(process.env.HEARTH_EXPLORER_API_POLL_MS, 2000),

  /** Blocks per catch-up tick. Bounded so an initial sync cannot starve the
   *  HTTP surface — this process serves and indexes on one event loop. */
  batchBlocks: num(process.env.HEARTH_EXPLORER_API_BATCH, 64),

  /** fsync the index every N blocks. A torn tail is repaired on startup
   *  (store.js), so this trades durability for initial-sync throughput and
   *  never trades correctness. */
  syncEvery: num(process.env.HEARTH_EXPLORER_API_SYNC_EVERY, 256),

  /** Log a reorg at warn; above this depth, log it at error. Exchange guidance
   *  is to halt crediting past ~5 (docs/exchange-integration.md §4), so this is
   *  the number an operator should alert on. */
  reorgAlertDepth: num(process.env.HEARTH_EXPLORER_API_REORG_ALERT_DEPTH, 5),

  /** How far back a reorg may rewind before we refuse to unwind automatically
   *  and stop, rather than silently rewriting a large amount of served history. */
  maxReorgDepth: num(process.env.HEARTH_EXPLORER_API_MAX_REORG_DEPTH, 1000),

  /** Etherscan's default `offset` is 10,000. Ours is smaller because every row
   *  is hydrated from the node rather than stored (see README, "Storage"). */
  defaultOffset: num(process.env.HEARTH_EXPLORER_API_DEFAULT_OFFSET, 100),
  maxOffset: num(process.env.HEARTH_EXPLORER_API_MAX_OFFSET, 1000),

  /** Blocks (with their receipts) held in memory to make paging cheap. */
  blockCache: num(process.env.HEARTH_EXPLORER_API_BLOCK_CACHE, 256),

  /** Widest getLogs range, mirroring the node's own cap. */
  maxLogRange: num(process.env.HEARTH_EXPLORER_API_MAX_LOG_RANGE, 10_000),

  /* How far the index may trail the node before address queries REFUSE.
   *
   * An index that is a million blocks behind answers "no transactions found"
   * for every address, and that answer is indistinguishable from the truth. A
   * caller that gets an error retries; a caller that gets an empty list
   * believes it. 8 blocks is two minutes at 15 s and never fires in normal
   * operation. */
  maxLagBlocks: num(process.env.HEARTH_EXPLORER_API_MAX_LAG_BLOCKS, 8),

  /* THE COMMONS ADDRESS, and the whole reason the supply endpoints exist.
   *
   * circulating = total − commons (docs/tokenomics.md §7). With no address
   * configured we cannot do the subtraction, and serving total supply under the
   * name "circulating" is precisely the mistake the node's existing /supply
   * endpoint makes and that this service exists to stop. So: absent → the
   * circulating endpoints return an error, loudly, forever.
   *
   * There is no default because there is no account-model Commons address yet
   * (listing-checklist.md M7 — the current one is a non-checksummed UTXO sink). */
  commonsAddress: address(process.env.HEARTH_COMMONS_ADDRESS),

  /* Emission parameters. Total supply is Σ subsidy(h) for h = 0..tip, which is
   * offline-computable and does not depend on the index. These MUST match the
   * account-model consensus when it lands; until then they are the specified
   * schedule (docs/coinnomics.md, proto/emission.js) and the service
   * cross-checks itself against the Commons balance to catch drift. */
  emissionR0Ember: process.env.HEARTH_EMISSION_R0_EMBER || '6',
  emissionTailEmber: process.env.HEARTH_EMISSION_TAIL_EMBER || '0.3',
  emissionHalflifeYears: num(process.env.HEARTH_EMISSION_HALFLIFE_YEARS, 2),
  emissionBlockTimeS: num(process.env.HEARTH_EMISSION_BLOCK_TIME_S, 15),
  commonsShare: Number(process.env.HEARTH_COMMONS_SHARE || '0.10'),

  /** Relative tolerance on the modelled-vs-observed Commons balance check. Past
   *  this, the supply endpoints return an error instead of a number. */
  supplyDriftTolerance: Number(process.env.HEARTH_EXPLORER_API_SUPPLY_TOLERANCE || '0.01'),

  /** The verification service, for module=contract. Absent → every contract
   *  answers "not verified", which is true rather than misleading. */
  verifyUrl: process.env.HEARTH_VERIFY_URL || '',

  /** Etherscan requires an apikey. We accept and ignore one; set this to
   *  require a matching value if the deployment needs a gate. */
  requireApiKey: process.env.HEARTH_EXPLORER_API_KEY || '',

  logLevel: process.env.HEARTH_EXPLORER_API_LOG_LEVEL || 'info',
  logFormat: process.env.HEARTH_EXPLORER_API_LOG_FORMAT || (process.stdout.isTTY ? 'pretty' : 'json'),

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
};

module.exports = { env, num, bool, address };
