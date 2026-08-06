'use strict';
/* ============================================================================
 * SUPPLY — and the trap this file exists to avoid.
 * ============================================================================
 *
 * The node's existing `GET /supply` reports a field named `circulating` whose
 * value is the sum of the ENTIRE UTXO set, INCLUDING the Commons treasury
 * (docs/tokenomics.md §7, node/src/rpc.js). An aggregator that takes
 * that at face value publishes a circulating supply overstated by the whole
 * treasury — currently 10% of everything ever mined.
 *
 * So here, total and circulating are two separately-named, separately-computed
 * numbers, and the definitions are the ones in tokenomics.md §7:
 *
 *     total       = Σ subsidy(h) for h = 0..tip
 *     commons     = balance of the Commons address
 *     circulating = total − commons
 *     max         = none (uncapped)
 *
 * THREE RULES, each of which is a refusal rather than a guess:
 *
 *   1. NO COMMONS ADDRESS → NO CIRCULATING FIGURE. Not "circulating = total".
 *      Serving total under the name circulating is the exact defect this
 *      service was written to fix, and doing it ourselves with a shrug in the
 *      README would be worse than the node's version, not better.
 *
 *   2. TOTAL IS MODELLED, AND THE MODEL IS CHECKED. The emission schedule is
 *      deterministic and offline-computable, which is the only way to get a
 *      total supply out of an `eth_*` surface that has no such method
 *      (docs/evm-spec.md §6). But a model drifts silently if the account-model
 *      genesis differs from the assumed one by even one block. So the modelled
 *      total is cross-checked against the observed Commons balance: the
 *      treasury takes a known 10% share, so if the chain has issued materially
 *      MORE than we model, the observed balance exceeds the modelled one and
 *      we return an error instead of a number.
 *
 *      The check is one-sided on purpose. An observed balance BELOW the model
 *      is normal once a spend mechanism exists — disbursed coins leave the
 *      treasury and become circulating, exactly as §7 says. An observed
 *      balance ABOVE it cannot happen unless our model understates issuance.
 *
 *   3. THE PARAMETERS ARE CONFIGURATION, NOT CONSTANTS. When phase 5 lands and
 *      the account-model genesis is written (listing-checklist M6), these must
 *      be pinned to consensus. Until then they are the published schedule.
 */

const ONE_EMBER = 10n ** 18n;
/** Reward resolution: 1e-9 EMBER. Below 2^53 so the float→int step is exact. */
const GIGA = 1_000_000_000;

/** 18 decimals, printed without floating point. */
function formatEmber(wei) {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / ONE_EMBER;
  const frac = (v % ONE_EMBER).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

class Emission {
  /**
   * @param {object} o
   * @param {string} o.r0Ember           EMBER per block at genesis
   * @param {string} o.tailEmber         perpetual floor, EMBER per block
   * @param {number} o.halflifeYears
   * @param {number} o.blockTimeS
   * @param {number} [o.firstBlock]      first height that issues a subsidy
   */
  constructor(o) {
    this.r0 = Number(o.r0Ember);
    this.tail = Number(o.tailEmber);
    this.blocksPerYear = Math.round((365.25 * 24 * 3600) / o.blockTimeS);
    this.halflifeBlocks = o.halflifeYears * this.blocksPerYear;
    /* tokenomics.md §7 sums from h = 0. The account-model genesis is not
     * written yet (listing-checklist M6) and the UTXO genesis creates zero
     * spendable supply, so this is exposed rather than assumed. */
    this.firstBlock = o.firstBlock === undefined ? 0 : o.firstBlock;
    this.checkpointEvery = 100_000;
    /** checkpoints[k] = Σ subsidy(h) for h < k*checkpointEvery, in wei. */
    this.checkpoints = [0n];
  }

  /** Subsidy at one height, in wei. Integer-exact at 1e-9 EMBER resolution. */
  subsidyWei(height) {
    if (height < this.firstBlock) return 0n;
    const decayed = this.r0 * Math.pow(2, -height / this.halflifeBlocks);
    const ember = Math.max(this.tail, decayed);
    return BigInt(Math.round(ember * GIGA)) * BigInt(ONE_EMBER / BigInt(GIGA));
  }

  /** Σ subsidy(h) for h = 0..tip, in wei. Cached in 100k-block checkpoints. */
  totalWei(tip) {
    if (tip < 0) return 0n;
    const k = Math.floor(tip / this.checkpointEvery);
    while (this.checkpoints.length <= k) {
      const from = (this.checkpoints.length - 1) * this.checkpointEvery;
      let sum = this.checkpoints[this.checkpoints.length - 1];
      for (let h = from; h < from + this.checkpointEvery; h++) sum += this.subsidyWei(h);
      this.checkpoints.push(sum);
    }
    let total = this.checkpoints[k];
    for (let h = k * this.checkpointEvery; h <= tip; h++) total += this.subsidyWei(h);
    return total;
  }
}

class Supply {
  constructor({ env, rpc }) {
    this.env = env;
    this.rpc = rpc;
    this.emission = new Emission({
      r0Ember: env.emissionR0Ember,
      tailEmber: env.emissionTailEmber,
      halflifeYears: env.emissionHalflifeYears,
      blockTimeS: env.emissionBlockTimeS,
    });
    this.cache = null;
    this.cacheHeight = -1;
  }

  /**
   * @returns {Promise<{height:number, totalWei:bigint, commonsWei:bigint|null,
   *   circulatingWei:bigint|null, unavailable:string|null}>}
   */
  async read() {
    const height = Number(await this.rpc.blockNumber());
    if (this.cache && this.cacheHeight === height) return this.cache;

    const totalWei = this.emission.totalWei(height);

    if (!this.env.commonsAddress) {
      /* Rule 1. Total is still served — it does not depend on the treasury —
       * but circulating is refused with a reason an operator can act on. */
      const out = {
        height,
        totalWei,
        commonsWei: null,
        circulatingWei: null,
        unavailable: 'circulating supply is unavailable: HEARTH_COMMONS_ADDRESS is not set, so the '
          + 'Commons treasury cannot be subtracted (docs/tokenomics.md §7). Refusing to serve total '
          + 'supply under the name "circulating".',
        source: 'modelled from the emission schedule; treasury not checked',
      };
      this.cache = out; this.cacheHeight = height;
      return out;
    }

    const commonsWei = await this.rpc.getBalance(this.env.commonsAddress, 'latest');
    const modelledCommons = (totalWei * BigInt(Math.round(this.env.commonsShare * 1e6))) / 1_000_000n;
    const tolerance = (modelledCommons * BigInt(Math.round(this.env.supplyDriftTolerance * 1e6))) / 1_000_000n;

    let unavailable = null;
    if (modelledCommons > 0n && commonsWei > modelledCommons + tolerance) {
      // Rule 2. The chain has issued more than the model says. Every number we
      // could publish from here is understated, so publish none of them.
      unavailable = 'supply is unavailable: the observed Commons balance ('
        + `${formatEmber(commonsWei)} EMBER) exceeds what the emission model says can have been minted `
        + `by height ${height} (${formatEmber(modelledCommons)} EMBER). The model and the chain disagree, `
        + 'so the total is understated and the circulating figure would be overstated. '
        + 'Pin HEARTH_EMISSION_* to consensus.';
    }
    const circulatingWei = unavailable ? null : totalWei - commonsWei;
    if (circulatingWei !== null && circulatingWei < 0n) {
      unavailable = 'supply is unavailable: the Commons balance exceeds the modelled total supply.';
    }

    const out = {
      height,
      totalWei,
      commonsWei,
      circulatingWei: unavailable ? null : circulatingWei,
      unavailable,
      source: 'total modelled from the emission schedule; commons read with eth_getBalance',
    };
    this.cache = out; this.cacheHeight = height;
    return out;
  }
}

module.exports = { Supply, Emission, formatEmber, ONE_EMBER };
