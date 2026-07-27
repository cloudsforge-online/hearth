'use strict';
/* Hearth consensus parameters — the single source of truth for the node.
 * These mirror docs/coinnomics.md. Values marked (dev) are tuned so a single
 * laptop produces a lively local chain; production values are noted alongside. */

const SPARKS_PER_EMBER = 100_000_000;          // 1e8, smallest unit = "spark"

module.exports = {
  NETWORK: process.env.HEARTH_NETWORK || 'hearth',
  COIN: 'EMBER',
  SPARKS_PER_EMBER,

  // ---- timing ----
  TARGET_BLOCK_TIME: 15,                        // seconds (production & dev)
  BLOCKS_PER_YEAR: Math.round((365.25 * 24 * 3600) / 15), // ~2,103,840
  LWMA_WINDOW: 60,                              // blocks used to retarget difficulty

  // ---- emission (see docs/coinnomics.md) ----
  R0_EMBER: 6,                                  // genesis block reward
  REWARD_HALFLIFE_YEARS: 2,
  TAIL_EMBER: 0.3,                              // perpetual tail reward
  COMMONS_SHARE: 0.10,                          // 10% of subsidy -> Commons treasury

  // ---- fees ----
  BASE_FEE_SPARKS: 40_000,                      // 0.0004 EMBER, BURNED, per tx
  //                                               excess over base fee = miner tip

  // ---- Proof of work (Homefire) ----
  // dev sizes keep local mining snappy; production ≈ 2 GiB / thousands of steps.
  POW_SCRATCH_KIB: 64,                          // (dev)  production: ~2,097,152 (2 GiB)
  POW_WALK_STEPS: 256,                          // (dev)  production: ~2048+
  // genesis difficulty target (32-byte big-endian threshold, as hex).
  // Easy on purpose so the first blocks come in ~seconds on one machine.
  // ~8 leading zero bits ⇒ ≈1/256 chance/hash ⇒ a block every ~1–2s at dev hashrate
  GENESIS_TARGET: '00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  MIN_TARGET: '00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  MAX_TARGET: '03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',

  // ---- safety limits (consensus + DoS) ----
  MAX_MONEY: 90_000_000 * SPARKS_PER_EMBER, // sane per-output ceiling
  MAX_BLOCK_TXS: 5_000,                     // reject oversized blocks before doing work
  MAX_TX_INPUTS: 1_000,
  MAX_TX_OUTPUTS: 1_000,
  COINBASE_MATURITY: 10,                    // (dev) coinbase unspendable until N deep; prod ~100
  MAX_FUTURE_DRIFT_S: 7200,                 // reject timestamps >2h in the future (Bitcoin-like)
  MEDIAN_TIME_SPAN: 11,                     // median-time-past window
  P2P_MAX_LINE: 4 * 1024 * 1024,            // drop peers that send >4MiB without a newline
  P2P_MAX_PEERS: 64,
  P2P_MAX_LOCATOR: 32,                      // hashes a peer may put in a getblocks locator
  P2P_MAX_BLOCKS: 200,                      // blocks served per getblocks round trip
  P2P_MAX_ORPHANS: 32,                      // parentless blocks held while ancestors arrive (× P2P_MAX_LINE = memory bound)
  P2P_RESYNC_MS: 20_000,                    // pull from every peer this often (converges equal-height forks)
  MEMPOOL_MAX_TXS: 50_000,                  // cap pending txs (DoS)

  // ---- special addresses ----
  COMMONS_ADDRESS: 'ember1commons00000000000000000000000000cmns',

  // ---- ports ----
  DEFAULT_RPC_PORT: 8645,                       // HTTP REST + JSON-RPC + SSE
  DEFAULT_P2P_PORT: 8646,                       // TCP peer gossip

  // Subsidy in sparks at a given height.
  //
  // DETERMINISTIC integer schedule (no floating point in consensus): the reward
  // halves every half-life epoch, interpolated *linearly* within the epoch so the
  // curve is continuous (no cliff) and reproducible bit-for-bit on any engine.
  // All intermediates stay < 2^53, so JS Number is exact; the Rust core computes
  // the identical value with u64/u128. See docs/coinnomics.md.
  subsidy(height) {
    const HL = Math.round(this.REWARD_HALFLIFE_YEARS * this.BLOCKS_PER_YEAR); // integer blocks
    const R0 = this.R0_EMBER * SPARKS_PER_EMBER;      // 600,000,000 sparks
    const TAIL = Math.round(this.TAIL_EMBER * SPARKS_PER_EMBER);
    const epoch = Math.floor(height / HL);
    if (epoch >= 30) return TAIL;                     // base has decayed below tail
    const base = Math.floor(R0 / Math.pow(2, epoch)); // 2^int is exact in a double
    const next = Math.floor(base / 2);
    const within = height - epoch * HL;               // 0..HL-1
    const reward = base - Math.floor(((base - next) * within) / HL);
    return Math.max(TAIL, reward);
  },
};
