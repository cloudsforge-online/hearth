'use strict';
/* What the PRODUCTION proof-of-work parameters actually cost — measured.
 *
 * Every block this project has ever produced — in these suites, in CI, on the
 * compose testnet — used a 64 KiB scratchpad and a 256-step walk. The values
 * `params.js` records beside them as the mainnet intent are ~2 GiB and 2,048+
 * steps, and six documents describe reaching them as raising two constants
 * before launch. Nothing had ever evaluated `homefireHash` at those sizes, so
 * "raise the constant" was an assumption sitting underneath the security of the
 * chain rather than a plan anybody had priced.
 *
 * This file prices it. It measures per-evaluation wall time and resident memory
 * across a pad sweep and a walk sweep, fits the cost model those measurements
 * imply, and then checks the model against a single evaluation at a pad large
 * enough that extrapolation is no longer doing the work. What it finds is
 * written up in docs/pow-parameters.md; the short version is that Homefire's
 * cost is O(pad) with no amortisation — one attempt fills the whole pad with
 * chained SHA-256 — so a 2 GiB pad costs ~32,768x a 64 KiB one, and a block
 * interval of 15 s cannot contain even one evaluation of it, let alone the
 * millions an honest miner needs or the one a validator pays per received block.
 *
 * THE ASSERTIONS ARE THE POINT, not the numbers. The numbers move with the
 * machine; the assertions are scale-free:
 *
 *   1. the parameterised hash agrees with the configured one, so the
 *      measurement is of the real function and not of a copy of it;
 *   2. cost is linear in pad size, which is what makes the extrapolation legal
 *      and what makes "raise the constant" arithmetically impossible;
 *   3. the configured parameters can be evaluated inside a fraction of the
 *      block interval — the fail-closed check that catches the day somebody
 *      follows listing-checklist M1 and edits params.js.
 *
 * Run:
 *   node test/pow-params.js              fast sweep, part of `npm test`
 *   node test/pow-params.js --sweep      out to 256 MiB, a few minutes
 *   node test/pow-params.js --full       one real evaluation at 2 GiB
 */

const crypto = require('crypto');
const P = require('../src/params');
const POW = require('../src/pow');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log('  ✓ ' + label)) : (fail++, console.log('  ✗ ' + label)); };
const section = s => console.log('\n• ' + s);
const note = s => console.log('    ' + s);

const argv = process.argv.slice(2);
const SWEEP = argv.includes('--sweep');
const FULL = argv.includes('--full');

const MiB = 1024;                       // in KiB, which is the unit params uses
const PROD_SCRATCH_KIB = 2 * 1024 * MiB;   // 2 GiB — the value params.js names
const PROD_WALK_STEPS = 2048;

/**
 * Wall-clock and resident-memory cost of one evaluation, averaged over `n`.
 *
 * RSS rather than heap: the pad is a Buffer, so it is external memory and
 * `heapUsed` cannot see it — reporting heap here would have shown a 2 GiB pad
 * costing nothing. Sampled after a full evaluation and before the next
 * allocation, so it is the peak an operator would see, not a steady state.
 */
function measure(scratchKiB, walkSteps, n) {
  const seed = crypto.randomBytes(32);
  // One warm-up evaluation: the first call at a new size pays for JIT and for
  // the allocator growing to fit the pad, and neither is a per-attempt cost.
  // Skipped above 16 MiB, where the warm-up would cost as much as the
  // measurement and the JIT is long since warm from the smaller points.
  if (scratchKiB <= 16 * 1024) POW.homefireHash(seed, scratchKiB, walkSteps);
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    POW.homefireHash(crypto.randomBytes(32), scratchKiB, walkSteps);
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  return { scratchKiB, walkSteps, ms, peakRssMiB: peakRss / 1048576, rssDeltaMiB: (peakRss - rssBefore) / 1048576 };
}

function fmt(x, places = 3) { return x.toFixed(places).padStart(12); }

(async () => {
  console.log('Homefire at production parameters — a measurement, not an estimate\n');
  console.log(`  node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(`  configured: POW_SCRATCH_KIB=${P.POW_SCRATCH_KIB}  POW_WALK_STEPS=${P.POW_WALK_STEPS}`
    + `  (network ${P.NETWORK})`);
  console.log(`  intended:   POW_SCRATCH_KIB=${PROD_SCRATCH_KIB} (2 GiB)  POW_WALK_STEPS=${PROD_WALK_STEPS}+`);

  // ------------------------------------------------------------------------
  section('the parameterised hash IS the configured hash');
  {
    /* If this fails, everything below measures a different function from the
     * one the chain runs and none of it means anything. */
    const seed = crypto.randomBytes(32);
    const configured = POW.homefireHash(seed);
    const explicit = POW.homefireHash(seed, P.POW_SCRATCH_KIB, P.POW_WALK_STEPS);
    ok(configured.equals(explicit), 'explicit parameters reproduce the default digest byte for byte');

    const other = POW.homefireHash(seed, P.POW_SCRATCH_KIB * 2, P.POW_WALK_STEPS);
    ok(!configured.equals(other), 'a different pad size is a different function — as it must be, the pad is consensus');
  }

  // ------------------------------------------------------------------------
  section('cost against pad size, at the configured walk length');
  const padPoints = SWEEP
    ? [64, 256, 1024, 4 * MiB, 16 * MiB, 64 * MiB, 256 * MiB]
    : [64, 256, 1024, 4 * MiB, 16 * MiB];
  const padRows = [];
  console.log('       pad KiB      ms/eval      µs/KiB    peak RSS MiB');
  for (const kib of padPoints) {
    // Enough repetitions to be worth timing at the small end, one at the large.
    const n = kib <= 1024 ? 20 : kib <= 16 * MiB ? 5 : 2;
    const r = measure(kib, 256, n);
    padRows.push(r);
    console.log(`  ${String(kib).padStart(12)}${fmt(r.ms)}${fmt(r.ms * 1000 / kib)}${fmt(r.peakRssMiB, 1)}`);
  }

  {
    /* LINEARITY IS THE LOAD-BEARING PROPERTY. Homefire fills the entire pad on
     * every attempt, so doubling the pad doubles the work with nothing carried
     * over between attempts — which is what makes the 2 GiB figure below an
     * extrapolation along a straight line rather than a guess. It is also
     * precisely why the parameter cannot be raised: there is no epoch cache, no
     * dataset, nothing amortised. Ethash costs O(dataset) once per epoch and
     * O(1) per attempt; Homefire pays the whole thing every time.
     *
     * The tolerance is wide (2x) because the small end lives in L2 and the
     * large end does not, so the per-KiB rate genuinely rises with size. A
     * SUB-linear result is what would falsify the model, and none has appeared. */
    const first = padRows[0], last = padRows[padRows.length - 1];
    const ratio = (last.ms / first.ms) / (last.scratchKiB / first.scratchKiB);
    ok(ratio > 0.5 && ratio < 2.0,
      `cost is linear in pad size across ${first.scratchKiB} KiB → ${last.scratchKiB} KiB `
      + `(work ratio ${(last.ms / first.ms).toFixed(0)}x for ${(last.scratchKiB / first.scratchKiB).toFixed(0)}x the pad)`);
  }

  // ------------------------------------------------------------------------
  section('cost against walk length, at the configured pad');
  {
    /* The walk is the cheap half and this measures how cheap. Each step is one
     * SHA-256 over 40 bytes; the fill is one SHA-256 per 8-byte word, i.e.
     * 8,192 of them at 64 KiB. So going from 256 steps to 2,048 adds ~1,792
     * hashes to an evaluation that already pays 8,192 — real, but nothing like
     * the pad. Raising POW_WALK_STEPS alone is affordable; it is also close to
     * pointless, because the walk is not what makes the function memory-hard. */
    console.log('        steps      ms/eval');
    const walkRows = [];
    for (const steps of [256, 512, 1024, 2048, 4096]) {
      const r = measure(P.POW_SCRATCH_KIB, steps, 20);
      walkRows.push(r);
      console.log(`  ${String(steps).padStart(12)}${fmt(r.ms)}`);
    }
    const at256 = walkRows[0].ms, at2048 = walkRows[3].ms;
    ok(at2048 < at256 * 8,
      `2,048 steps costs ${(at2048 / at256).toFixed(2)}x the 256-step evaluation, not 8x — `
      + 'the fill dominates, so the walk is the affordable parameter');
  }

  // ------------------------------------------------------------------------
  section('what 2 GiB would cost');
  let modelMsPerKiB, predicted2GiB;
  {
    /* Fit on the largest two points only. The small ones are cache-resident and
     * flatter their per-KiB rate; using them would UNDERSTATE the production
     * cost, and understating it is the failure mode this whole file exists to
     * prevent. */
    const a = padRows[padRows.length - 2], b = padRows[padRows.length - 1];
    modelMsPerKiB = (b.ms - a.ms) / (b.scratchKiB - a.scratchKiB);
    predicted2GiB = modelMsPerKiB * PROD_SCRATCH_KIB;
    note(`marginal rate ${(modelMsPerKiB * 1000).toFixed(3)} µs/KiB, fitted on `
      + `${a.scratchKiB} KiB → ${b.scratchKiB} KiB`);
    note(`EXTRAPOLATED: one evaluation at 2 GiB ≈ ${(predicted2GiB / 1000).toFixed(1)} s`);
    note(`              a ${P.P2P_BLOCK_VERIFY_BURST}-block getblocks page ≈ `
      + `${(predicted2GiB * P.P2P_BLOCK_VERIFY_BURST / 3.6e6).toFixed(1)} hours of one core`);
    note(`              at ${P.TARGET_BLOCK_TIME} s per block, one attempt is `
      + `${(predicted2GiB / (P.TARGET_BLOCK_TIME * 1000)).toFixed(0)}x the whole block interval`);

    if (FULL) {
      /* MEASURED, not modelled. One evaluation, because at these sizes one is
       * minutes. Reported separately from the extrapolation on purpose: a
       * number that came off the clock and a number that came off a line are
       * not the same kind of claim and this file will not blur them. */
      note('measuring one real 2 GiB evaluation — several minutes…');
      const r = measure(PROD_SCRATCH_KIB, PROD_WALK_STEPS, 1);
      note(`MEASURED: 2 GiB / ${PROD_WALK_STEPS} steps = ${(r.ms / 1000).toFixed(1)} s, `
        + `peak RSS ${r.peakRssMiB.toFixed(0)} MiB`);
      ok(r.ms > P.TARGET_BLOCK_TIME * 1000,
        `a single measured evaluation (${(r.ms / 1000).toFixed(1)} s) exceeds the whole `
        + `${P.TARGET_BLOCK_TIME} s block interval`);
      ok(r.peakRssMiB < 8192,
        `peak RSS ${r.peakRssMiB.toFixed(0)} MiB — the pad is allocated and released per call, `
        + 'so this fails on CPU, not on memory');
    } else {
      note('(--full measures this for real instead of extrapolating)');
    }
  }

  // ------------------------------------------------------------------------
  section('the configured parameters are runnable — the fail-closed check');
  {
    /* THE ASSERTION THAT WOULD HAVE CAUGHT THIS. Somebody following
     * listing-checklist M1 edits POW_SCRATCH_KIB to 2,097,152, runs the suite,
     * and every existing test still passes — they are all fast because they run
     * on `hearth-test`, and the ones that are not do not measure anything. This
     * check fails instead, on the machine of whoever made the edit, before a
     * genesis is cut.
     *
     * The budget is 1% of the block interval for ONE evaluation. That is not a
     * comfort margin, it is the validator's constraint: a node pays a full
     * evaluation for every block it receives, and must also pay for the
     * transactions in it, the state transition, the trie work and the relay,
     * inside the same interval it is trying to mine the next block in. */
    const budgetMs = P.TARGET_BLOCK_TIME * 1000 * 0.01;   // TARGET_BLOCK_TIME is SECONDS
    const r = measure(P.POW_SCRATCH_KIB, P.POW_WALK_STEPS, 20);
    ok(r.ms < budgetMs,
      `one evaluation at the configured parameters is ${r.ms.toFixed(3)} ms, `
      + `under the ${budgetMs} ms verification budget (1% of TARGET_BLOCK_TIME)`);
    ok(P.POW_SCRATCH_KIB <= P.POW_MAX_SCRATCH_KIB,
      `POW_SCRATCH_KIB ${P.POW_SCRATCH_KIB} is within POW_MAX_SCRATCH_KIB ${P.POW_MAX_SCRATCH_KIB}, `
      + 'the ceiling params.js refuses to start above');
    ok(PROD_SCRATCH_KIB > P.POW_MAX_SCRATCH_KIB,
      'and the documented 2 GiB intent is ABOVE that ceiling — a node configured for it '
      + 'refuses to start rather than mining a chain nothing can validate');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} pow-parameter checks`);
  process.exit(fail ? 1 : 0);
})();
