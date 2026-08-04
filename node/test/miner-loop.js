'use strict';
/* The mining loop's two obligations to everything else in the process.
 * Run: node test/miner-loop.js
 *
 * Mining is CPU-bound work on a single-threaded runtime that is also running
 * gossip, the RPC servers and, now, a WebSocket keepalive. So the loop owes the
 * rest of the process two things, and neither was true:
 *
 *   1. IT MUST YIELD OFTEN. A batch of nonces is a batch of FULL HOMEFIRE
 *      EVALUATIONS — ~9.5 ms of a core each at the shipped parameters, measured
 *      in docs/pow-parameters.md and again here. A fixed count of 150 per turn
 *      is therefore ~1.4 SECONDS of blocked event loop, and the cost lands
 *      exactly where a miner can least afford it: a block arriving from a peer
 *      is not even parsed for up to 1.4 s, so this node keeps grinding a tip it
 *      already knows is dead. At a 15 s block target that is a tenth of every
 *      interval spent on work that cannot win.
 *
 *   2. THROTTLE MUST THROTTLE. `--throttle 0.6` is the promise that this will
 *      leave the machine usable. With a fixed batch the sleep between turns was
 *      a constant `(1 - throttle) * 12` ms — about 5 ms of rest after 1,434 ms
 *      of work, a 99.7% duty cycle. The number was not a little optimistic, it
 *      was unrelated to what it claimed to control.
 *
 * Both are properties of WALL CLOCK, so both are measured here rather than
 * asserted about constants. The bounds are loose on purpose — this has to pass
 * on a loaded CI runner — but they are far tighter than the behaviour they
 * replaced, which fails them by an order of magnitude.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const POW = require('../src/pow');
const { EvmNode } = require('../src/evmnode');
const C = require('./evm-common');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dirs = [];
function node(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-mineloop-${tag}-`));
  dirs.push(dir);
  /* The HARDEST target the chain allows, so nothing is ever found and the loop
   * is measured while it is doing what it does 99.99% of the time. A test that
   * measured a loop which keeps restarting on a win would measure the restart. */
  return new EvmNode({ dataDir: dir, quiet: true, genesis: { target: P.MIN_TARGET } });
}

/** The worst delay a 20 ms timer suffered — i.e. how long the loop was blocked. */
function lagProbe() {
  let worst = 0;
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 20);
    last = now;
  }, 20);
  return { stop() { clearInterval(t); return worst; } };
}

/**
 * Hashes per second at a given throttle, read from `miner.hashrate` — the same
 * figure `/info`, `eth_hashrate` and the miner's own status line report, so this
 * measures the number an operator is actually shown.
 *
 * The median of the samples, not the mean: one turn of the loop is one
 * indivisible evaluation, so the first and last samples of any window are
 * partial and would drag a mean toward zero.
 */
async function measure(n, throttle, ms) {
  n.miner.throttle = throttle;
  n.miner.start();
  await sleep(1200);                   // the rate is recomputed once a second
  const samples = [];
  const t = setInterval(() => { if (n.miner.hashrate > 0) samples.push(n.miner.hashrate); }, 150);
  await sleep(ms);
  clearInterval(t);
  n.miner.stop();
  await sleep(50);
  if (!samples.length) return 0;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

(async () => {
  console.log('\nHearth mining loop — what it owes the rest of the process\n');

  // What one evaluation actually costs on this machine, so the numbers below
  // can be read rather than taken on faith.
  {
    const core = Buffer.alloc(32, 7), pub = 'ab'.repeat(33);
    for (let i = 0; i < 20; i++) POW.homefireHash(POW.powSeed(core, i, pub));
    const t0 = Date.now();
    const N = 40;
    for (let i = 0; i < N; i++) POW.homefireHash(POW.powSeed(core, i, pub));
    const per = (Date.now() - t0) / N;
    console.log(`  (one Homefire evaluation here is ${per.toFixed(2)} ms · `
      + `pad ${P.POW_SCRATCH_KIB} KiB · walk ${P.POW_WALK_STEPS})`);
  }

  // ==========================================================================
  group('the loop yields to the rest of the process');
  // ==========================================================================
  {
    const n = node('lag');
    n.miner.throttle = 1.0;
    n.miner.start();
    await sleep(300);
    const probe = lagProbe();
    await sleep(3000);
    const worst = probe.stop();
    n.miner.stop();
    n.close();

    /* 250 ms. Generous — the point is not a tight bound, it is that a block from
     * a peer is acted on in a fraction of a block interval rather than in a
     * second and a half. A fixed 150-nonce batch measures ~1,400 ms here. */
    assert(worst < 250,
      `mining at full throttle blocks the event loop for at most ${worst} ms (bound 250 ms) — `
      + 'a block from a peer cannot sit unparsed while this node grinds a dead tip');
  }

  // ==========================================================================
  group('throttle is a share of a core, not a decoration');
  // ==========================================================================
  {
    const n = node('throttle');
    const full = await measure(n, 1.0, 2500);
    const quarter = await measure(n, 0.25, 2500);
    n.close();
    const ratio = full > 0 ? quarter / full : 1;
    console.log(`    full ${full.toFixed(0)} H/s · quarter ${quarter.toFixed(0)} H/s · ratio ${ratio.toFixed(2)}`);

    assert(full > 0 && quarter > 0, 'both settings actually hash');
    /* 0.25 asked for, 0.10–0.45 accepted: scheduling granularity and the cost of
     * one indivisible evaluation put a floor under how precise this can be, and
     * a loaded machine widens it further. The behaviour being replaced sat at
     * ~1.0 — indistinguishable from no throttle at all — so this bound
     * discriminates the thing it is meant to. */
    assert(ratio > 0.10 && ratio < 0.45,
      `--throttle 0.25 delivers about a quarter of full rate (measured ${ratio.toFixed(2)}), `
      + 'so the number an operator sets is the number they get');
  }

  // ==========================================================================
  group('and a throttled miner still yields promptly');
  // ==========================================================================
  {
    // The failure this catches: implementing the throttle as one long sleep
    // between long bursts would satisfy the ratio above while leaving the loop
    // blocked for just as long inside each burst.
    const n = node('both');
    n.miner.throttle = 0.25;
    n.miner.start();
    await sleep(300);
    const probe = lagProbe();
    await sleep(3000);
    const worst = probe.stop();
    n.miner.stop();
    n.close();
    assert(worst < 250, `a throttled miner also yields within ${worst} ms — the rest is taken in small pieces`);
  }

  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
