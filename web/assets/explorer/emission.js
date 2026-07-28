/* The emission schedule, ported from node/src/params.js.
 *
 * A LINE-FOR-LINE PORT, in the same spirit as web/assets/mining/homefire.js is a
 * port of node/src/pow.js: same integer arithmetic, same flooring, same order of
 * operations. All intermediates stay under 2^53, which params.js states as the
 * reason plain Number is exact here, so this produces bit-identical values.
 *
 * WHY THE EXPLORER NEEDS IT AT ALL. Total supply is not on the `eth_*` surface —
 * there is no eth_totalSupply and there is not going to be one — and the REST
 * `/supply` route sums a UTXO set that the account model does not have. Until
 * phase 5 exposes the figure, the only honest source is the schedule itself,
 * which is deterministic and offline-computable exactly as
 * docs/tokenomics.md §7 says. Every number derived from this file is labelled
 * "modelled" on screen, because a model is what it is.
 *
 * The unit here is EMBER, not wei. That is deliberate: docs/evm-spec.md §1
 * changes decimals from 8 to 18, which changes what a base unit is but not how
 * many EMBER exist, and EMBER is the figure an aggregator publishes.
 */

export const SPARKS_PER_EMBER = 100_000_000;
export const TARGET_BLOCK_TIME = 15;
export const BLOCKS_PER_YEAR = Math.round((365.25 * 24 * 3600) / 15);   // ~2,103,840
export const R0_EMBER = 6;
export const REWARD_HALFLIFE_YEARS = 2;
export const TAIL_EMBER = 0.3;
export const COMMONS_SHARE = 0.10;

const HALFLIFE_BLOCKS = Math.round(REWARD_HALFLIFE_YEARS * BLOCKS_PER_YEAR);

/** Subsidy at a height, in sparks. params.js:140-151. */
export function subsidy(height) {
  const R0 = R0_EMBER * SPARKS_PER_EMBER;
  const TAIL = Math.round(TAIL_EMBER * SPARKS_PER_EMBER);
  const epoch = Math.floor(height / HALFLIFE_BLOCKS);
  if (epoch >= 30) return TAIL;
  const base = Math.floor(R0 / Math.pow(2, epoch));
  const next = Math.floor(base / 2);
  const within = height - epoch * HALFLIFE_BLOCKS;
  const reward = base - Math.floor(((base - next) * within) / HALFLIFE_BLOCKS);
  return Math.max(TAIL, reward);
}

/** The Commons cut of a subsidy — floor(subsidy × 0.10), chain.js:310-313. */
export const commonsCut = s => Math.floor(s * COMMONS_SHARE);

/**
 * Σ subsidy(h) for h = 0..height, in sparks, as a BigInt.
 *
 * Summed block by block rather than by a closed form. The per-block value is
 * itself a floor, so an epoch-level formula would be off by the accumulated
 * rounding — small, but this is a supply figure and "nearly right" is not a
 * category it has. A couple of million iterations of integer arithmetic is a few
 * milliseconds, once, on a page the reader asked for.
 */
export function cumulative(height) {
  let total = 0n;
  let commons = 0n;
  // Accumulate in Number within a block of 2^53-safe partial sums, then fold
  // into BigInt: 2^53 sparks is ~90M EMBER, so fold often enough to never reach it.
  let partT = 0, partC = 0;
  for (let h = 0; h <= height; h++) {
    const s = subsidy(h);
    partT += s;
    partC += commonsCut(s);
    if (partT > 4_000_000_000_000_000) { total += BigInt(partT); commons += BigInt(partC); partT = 0; partC = 0; }
  }
  total += BigInt(partT);
  commons += BigInt(partC);
  return { totalSparks: total, commonsSparks: commons, minerSparks: total - commons };
}

/** Sparks to a decimal EMBER string, exactly (1e8 sparks = 1 EMBER). */
export function sparksToEmber(sparks) {
  const v = BigInt(sparks);
  const whole = (v / 100000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (v % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return whole + (frac ? '.' + frac : '');
}
