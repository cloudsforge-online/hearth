'use strict';
/* WHEN A BLOCK SAYS IT WAS FOUND. Run: node test/candidate-freshness.js
 *
 * `buildCandidate` stamps `header.timestamp` when it assembles the candidate, and
 * the timestamp is inside `coreHash`, so it is frozen for the whole nonce search.
 * `candidateFor` memoized on (tip, mempool version, coinbase, extraData) and
 * nothing else, so the candidate for a given tip was built once — the instant its
 * parent landed — and every block sealed from it recorded that moment rather than
 * the moment its nonce was found.
 *
 * Measured on mainnet on 2026-08-11, polling the tip every 2 s: six consecutive
 * blocks arrived already 51, 28, 42, 9, 29 and 24 seconds old against a
 * TARGET_BLOCK_TIME of 15. The age on arrival IS the solve time, because the
 * header records when the search started.
 *
 * WHAT THIS IS AND IS NOT. Simulating the real LWMA against a browser-sized
 * hashrate burst, correcting the shift moves the recovery walk from 97 to 90
 * minutes and does not shorten the longest block at all — it is NOT the fix for
 * the wedge in micro-org#363, and a suite that implied otherwise would be lying
 * about what it protects. What it protects is that `now - tip.timestamp` means
 * something: it was overstated by a whole solve time, so a chain hitting its
 * target exactly still reported a tip that was never fresher than one block
 * interval, which is the quantity the tip-age alert reads.
 *
 * THE BIAS OF THIS SUITE is towards the mutations that leave a working miner
 * behind. Every one of the four below produces a node that mines, syncs, serves
 * templates and passes every other suite in this repository; three of them
 * reinstate the defect outright and the fourth trades it for an unmetered
 * `/mining/template`. The happy path — "a candidate has a timestamp" — catches
 * none of them.
 */

// MUST precede the params require: these are resolved at module load.
process.env.HEARTH_NETWORK = process.env.HEARTH_NETWORK || 'hearth-test';

const P = require('../src/params');
const { Miner } = require('../src/chain/miner');
const { EvmNode } = require('../src/evmnode');
const C = require('./evm-common');

const T = C.harness('Candidate timestamp freshness');
const { ok, eq, group } = T;

const miner = C.testKey('miner');

/** The refresh interval, read from the constant it is derived from rather than
 *  typed in, so retuning TARGET_BLOCK_TIME retunes this suite with it. */
const WINDOW_MS = P.TARGET_BLOCK_TIME * 1000;
const CANDIDATE_MAX_AGE_MS = WINDOW_MS;   // the same interval, named as the source names it

const newNode = () => new EvmNode({ quiet: true, coinbaseKey: miner });
const pub = miner.publicKey.toString('hex');

/** Run `fn` with the clock frozen at `at`, then put the real one back. */
function atClock(at, fn) {
  const real = Date.now;
  Date.now = () => at;
  try { return fn(); } finally { Date.now = real; }
}

// ---------------------------------------------------------------------------
group('a search that outlives its bucket is re-stamped');
{
  /* MUTANT KILLED: dropping `:${bucket}` from the memo key in `candidateFor`,
   * which is the code as it stood. The candidate is then built once per tip and
   * its timestamp is frozen for as long as the search runs, so this assertion
   * sees the same object and the same second no matter how far the clock moves. */
  const n = newNode();
  const t0 = 1_800_000_000_000;                      // any instant; a bucket boundary
  const first = atClock(t0, () => n.miner.candidateFor(pub));
  const later = atClock(t0 + WINDOW_MS, () => n.miner.candidateFor(pub));

  ok(later !== first, 'a candidate built a full interval later is a different candidate');
  ok(later.header.timestamp > first.header.timestamp,
    'and carries a strictly later timestamp than the one the search began at');
  eq(later.header.timestamp - first.header.timestamp, P.TARGET_BLOCK_TIME,
    'advanced by exactly the interval the clock advanced by');
}

// ---------------------------------------------------------------------------
group('…but the memo still holds inside one bucket');
{
  /* MUTANT KILLED: keying the memo on `Date.now()` itself rather than on a
   * bucket. That refreshes the timestamp even more promptly — it passes the group
   * above — and destroys the only thing the memo is for: `/mining/template` is
   * unauthenticated and `candidateFor` EXECUTES the block to learn its state
   * root, so a per-call key sells a stranger a full block of EVM per HTTP
   * request. test/mining-budget.js asserts the metering around that endpoint;
   * this asserts the memo underneath it still exists. */
  const n = newNode();
  const t0 = 1_800_000_000_000;
  const a = atClock(t0, () => n.miner.candidateFor(pub));
  const b = atClock(t0 + WINDOW_MS - 1, () => n.miner.candidateFor(pub));

  ok(a === b, 'two calls one millisecond short of the boundary share one execution');
}

// ---------------------------------------------------------------------------
group('a freshly issued candidate never asks the miner to restart');
{
  /* MUTANT KILLED: dropping `cand.bucket = bucket` from `candidateFor`. `bucket`
   * is then undefined on every candidate, `cand.bucket !== Miner.bucketAt()` is
   * true on every turn of the mining loop, and `_mineOne` restarts before it ever
   * grinds a nonce — a miner at 0 H/s that logs nothing and looks alive. Nothing
   * else in this repository would notice, because no other suite runs the loop
   * long enough to need a second turn. */
  const n = newNode();
  const t0 = 1_800_000_000_000 + 7;                  // mid-bucket, not on a boundary
  const cand = atClock(t0, () => n.miner.candidateFor(pub));

  eq(atClock(t0, () => n.miner._stale(cand)), false,
    'the restart predicate is false for the candidate the miner was just handed');
  eq(atClock(t0 + WINDOW_MS, () => n.miner._stale(cand)), true,
    'and true once the clock leaves the bucket it was built in');
}

// ---------------------------------------------------------------------------
group('the refresh survives a chain whose timestamps run ahead of this node');
{
  /* MUTANT KILLED: testing the candidate's AGE — `Date.now() - cand.header
   * .timestamp * 1000 >= WINDOW_MS` — instead of its bucket. `buildCandidate`
   * stamps `max(now, medianTimePast + 1)`, and `_validate` accepts a header up to
   * MAX_FUTURE_DRIFT_S ahead, so a chain carrying timestamps from a fast clock
   * hands the candidate a moment in the FUTURE. The age is then negative forever
   * and the refresh silently stops happening — on exactly the chain state where a
   * late timestamp matters most, with no symptom anywhere. Two readings of one
   * clock cannot drift apart that way.
   *
   * MEDIAN_TIME_SPAN blocks are mined ahead of the clock because the median is
   * what `buildCandidate` floors against; fewer and the median is still local. */
  const n = newNode();
  /* The real clock, floored to a bucket boundary — unlike the groups above, this
   * one compares the stubbed clock against timestamps `addBlock` validates
   * against the REAL one, so an arbitrary instant would be either rejected as
   * far-future or trivially later than the chain. */
  const t0 = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const ahead = Math.floor(t0 / 1000) + 3600;        // inside MAX_FUTURE_DRIFT_S
  for (let i = 0; i < P.MEDIAN_TIME_SPAN + 1; i++) {
    const block = C.mineOn(n.chain, n.chain.tipId, miner, { timestamp: ahead + i });
    const res = n.chain.addBlock(block);
    if (!ok(res.ok !== false, 'a block stamped an hour ahead is accepted: ' + res.err)) break;
  }

  const cand = atClock(t0, () => n.miner.candidateFor(pub));
  ok(cand.header.timestamp * 1000 > t0,
    'the candidate inherits a timestamp from median-time-past, not from the clock');
  ok(t0 + WINDOW_MS - cand.header.timestamp * 1000 < CANDIDATE_MAX_AGE_MS,
    'so an age comparison is still under the interval — and here, negative');

  eq(atClock(t0 + WINDOW_MS, () => n.miner._stale(cand)), true,
    'the miner rebuilds anyway, because it asks the clock and not the header');
  ok(atClock(t0 + WINDOW_MS, () => n.miner.candidateFor(pub)) !== cand,
    'and a rebuild is what it gets');
}

T.done();
