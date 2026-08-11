'use strict';
/* THE ABSOLUTE-TIME EMERGENCY DIFFICULTY RULE — micro-org#363.
 * Run: node test/emergency-difficulty.js
 *
 * A block whose own timestamp is more than 8 × TARGET_BLOCK_TIME past its
 * parent's may be mined at MAX_TARGET instead of at the LWMA target, from
 * EMERGENCY_ACTIVATION_HEIGHT onwards. The argument for the rule is at
 * EMERGENCY_SOLVE_MULTIPLE in src/params.js; this is the evidence for it.
 *
 * THE SINGLE BIGGEST RISK IN THIS CHANGE IS NOT THE RULE, IT IS THE GATE.
 * `_validate` recomputes the expected target for every block, and `load()` runs
 * the same validation over the whole blocks file at boot, so a rule that applied
 * to history would make the node refuse its own chain: it would come up short,
 * say so once, and carry on serving a truncated tip. 877 of the 13,483 blocks
 * EMBER mainnet had mined by 2026-08-11 have a solve time over 120 s, so this is
 * not a corner — it is most of the chain. The first group therefore replays the
 * REAL mainnet header series through the REAL `_targetFor` and requires it to
 * agree with the difficulty the live node published at every one of those
 * heights, and the second builds a chain on disk under the old rule and requires
 * the shipped node to load it whole.
 *
 * THE BIAS OF THIS SUITE, as in test/candidate-freshness.js, is towards mutations
 * that leave a node which still mines, still syncs, still serves RPC and still
 * passes every other suite in this repository. Reverting `buildCandidate` to the
 * un-eased target is the sharpest of them: nothing anywhere fails, no block is
 * rejected, and the rule simply never fires — which is indistinguishable from a
 * chain that never needed it until the day it does.
 */

// MUST precede the params require: these are resolved at module load.
process.env.HEARTH_NETWORK = process.env.HEARTH_NETWORK || 'hearth-test';

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const HDR = require('../src/chain/header');
const { Blockchain } = require('../src/chain/blockchain');
const C = require('./evm-common');

const T = C.harness('The emergency difficulty rule');
const { ok, eq, group } = T;

const key = C.testKey('emergency');
const SHIPPED_ACTIVATION = P.EMERGENCY_ACTIVATION_HEIGHT;
const THRESHOLD = P.emergencySolveSeconds();
const FLOOR_DIFFICULTY = Number(HDR.difficulty(P.MAX_TARGET));

const dirs = [];
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-emerg-${tag}-`)); dirs.push(d); return d; };

/* A GENESIS TARGET ABOVE THE FLOOR, for every chain here that is actually mined.
 *
 * Four times harder than MAX_TARGET — difficulty 1,024 against the floor's 256,
 * roughly 0.1 s of grinding per block at this network's Homefire sizes. The
 * suites in this repository all launch at MAX_TARGET, and at MAX_TARGET this rule
 * is UNTESTABLE: easing to the floor from the floor changes nothing, every
 * assertion below passes with the rule deleted, and 2,830 of the 3,001 mainnet
 * blocks sampled in micro-org#363 were in exactly that state. A chain that has
 * left the floor is the only chain an emergency easement means anything on. */
const ABOVE_FLOOR = ((BigInt('0x' + P.MAX_TARGET) >> 2n).toString(16).padStart(64, '0'));

/** Run `fn` with the activation height moved, then put the shipped one back. */
function atActivation(height, fn) {
  const saved = P.EMERGENCY_ACTIVATION_HEIGHT;
  P.EMERGENCY_ACTIVATION_HEIGHT = height;
  try { return fn(); } finally { P.EMERGENCY_ACTIVATION_HEIGHT = saved; }
}

/* A store-shaped chain, so `_nextTarget`, `_slice` and `_targetFor` can be run
 * over a header series with no state, no EVM and no proofs of work.
 *
 * The REAL prototype methods, deliberately: a reimplementation of the LWMA in
 * this file would agree with a reimplementation of the LWMA in this file, which
 * is the one thing a replay test must not do. What is fake is only the store,
 * and `_slice` reads exactly three fields out of it. */
function headerChain(genesisTarget = P.GENESIS_TARGET) {
  const chain = Object.create(Blockchain.prototype);
  chain.store = new Map();
  chain.config = { target: genesisTarget };
  chain.tipId = null;
  return chain;
}
function append(chain, timestamp, target) {
  const height = chain.store.size;
  const id = 'b' + height;
  const prevHash = height === 0 ? null : 'b' + (height - 1);
  chain.store.set(id, { id, height, block: { header: { timestamp, target, prevHash } } });
  chain.tipId = id;
  return id;
}

// ===========================================================================
group('EMBER mainnet replays through the new rule, block for block');
// ===========================================================================
{
  /* MUTANT KILLED: dropping `if (!P.emergencyActive(parent.height + 1)) return
   * base;` from `_targetFor` — the whole gate, and the one-line version of this
   * change somebody will eventually propose. The node then eases 877 of these
   * heights, disagrees with the target committed in each of them, and stops at
   * the first one: the chain on disk becomes unreadable by the only software
   * that can read it. Nothing else in this repository notices, because every
   * other suite builds its chain under whatever rule is compiled in.
   *
   * ALSO KILLED: any change to the LWMA itself — the window, the 6× solve clamp,
   * the weighting, the rounding. This is a fixture of what the live chain
   * actually committed, so it is the only test here that would catch a retarget
   * "cleanup" that happens to be arithmetically different.
   *
   * The fixture is `timestamp` and `difficulty` for heights 0..13,483, pulled
   * from the mainnet node over eth_getBlockByNumber on 2026-08-11. Targets are
   * not in the fixture on purpose: they are the thing under test, recomputed
   * here from the timestamps and compared through HDR.difficulty against what
   * the chain published. */
  const fx = require('./fixtures/mainnet-headers.json');
  const n = fx.difficulty.length;

  const replay = (activation) => atActivation(activation, () => {
    const chain = headerChain();
    append(chain, fx.genesisTimestamp, P.GENESIS_TARGET);
    let disagreed = 0, firstAt = null, ts = fx.genesisTimestamp;
    for (let h = 1; h <= n; h++) {
      ts += fx.timestampDeltas[h - 1];
      const target = chain._targetFor(chain.tipId, ts);
      append(chain, ts, target);
      if (Number(HDR.difficulty(target)) !== fx.difficulty[h - 1]) {
        disagreed++;
        if (firstAt === null) firstAt = h;
      }
    }
    return { disagreed, firstAt };
  });

  ok(n === fx.height && n === 13_483,
    `the fixture is the whole chain as it stood on ${fx.capturedUtc} — ${n.toLocaleString()} blocks`);
  ok(SHIPPED_ACTIVATION > n,
    `and every block in it is below the activation height (tip ${n.toLocaleString()} < ${SHIPPED_ACTIVATION.toLocaleString()})`);

  const shipped = replay(SHIPPED_ACTIVATION);
  eq(shipped.disagreed, 0,
    'THE NODE STILL VALIDATES ITS OWN HISTORY: every committed difficulty is reproduced exactly');

  /* THE EVIDENCE THAT THE LINE ABOVE CAN FAIL, run on the same series rather
   * than described — the discarded design, exercised directly, exactly as
   * test/chain-replay.js runs the old one-string `load()` on its own file.
   *
   * 86 rather than 877, and the difference is worth knowing: most long blocks on
   * this chain happened while it was ALREADY at the floor, where easing to the
   * floor changes nothing. The 86 that differ are the ones during and after the
   * browser-mining excursion — and `load()` stops at the FIRST of them, so the
   * cost is not 86 blocks, it is every block from 10,968 to the tip. */
  const ungated = replay(0);
  ok(ungated.disagreed > 0,
    ungated.firstAt === null
      /* Reported rather than thrown, because an easement that eases NOTHING
       * reaches this line: the whole suite's premise is that the two rules
       * differ somewhere, and if they do not, that is the finding. */
      ? 'and an UNGATED rule disagrees NOWHERE — the easement is not easing anything'
      : `and an UNGATED rule disagrees with ${ungated.disagreed} of them, first at height `
        + `${ungated.firstAt.toLocaleString()} — which is where replay would stop, `
        + `losing the ${(n - ungated.firstAt + 1).toLocaleString()} blocks above it`);
}

// ===========================================================================
group('a chain written under the old rule loads whole under the new one');
// ===========================================================================
{
  /* The fixture above proves the arithmetic; this proves the boot. `load()` is
   * the path an operator actually meets — it revalidates every block, and a
   * block that no longer validates stops that branch and leaves the node serving
   * a shorter chain with one log line to explain it (test/chain-replay.js).
   *
   * MUTANT KILLED: the same missing gate, reached the way a restart reaches it.
   * The blocks below are stamped 121 s apart — routine on this chain, where 877
   * real blocks are — and are mined and persisted with the rule out of force. */
  const gen = { target: ABOVE_FLOOR };
  const dir = tmpdir('replay');
  const LONG = THRESHOLD + 1;

  /* Three blocks on schedule to establish a difficulty above the floor, then
   * three that run long — the shape of any chain that has lost hashrate, and the
   * shape 877 real mainnet blocks have. Stamped forward from the GENESIS
   * timestamp rather than from the clock, because the first solve time in the
   * window is measured against genesis and a chain started today would enter the
   * LWMA with a thirteen-month gap. */
  const built = atActivation(Number.MAX_SAFE_INTEGER, () => {
    const chain = new Blockchain({ dataDir: dir, config: gen }).load();
    let ts = chain.entry(chain.tipId).block.header.timestamp;
    const spacing = [P.TARGET_BLOCK_TIME, P.TARGET_BLOCK_TIME, P.TARGET_BLOCK_TIME, LONG, LONG, LONG];
    const committed = [];
    for (const dt of spacing) {
      ts += dt;
      const r = chain.addBlock(C.mineOn(chain, chain.tipId, key, { timestamp: ts }));
      if (!ok(r.ok !== false, `a ${dt}-second block is ordinary below the activation height: ` + r.err)) break;
      committed.push(Number(HDR.difficulty(chain.entry(chain.tipId).block.header.target)));
    }
    /* The FIRST long block, not the tip. Three of them in a row walk the LWMA
     * down to the floor by the third, where an easement to the floor is no
     * change and would prove nothing — which is the same reason the mainnet
     * series above disagrees at 86 heights rather than 877. */
    ok(committed[3] > FLOOR_DIFFICULTY,
      `the first long block was committed at difficulty ${committed[3]}, above the floor of `
      + `${FLOOR_DIFFICULTY} — the only state in which easing to the floor is a change`);
    return { height: chain.height, tip: chain.tipId };
  });
  eq(built.height, 6, '6 blocks on disk');

  const reopen = (activation) => atActivation(activation, () => {
    const chain = new Blockchain({ dataDir: dir, config: gen });
    const events = [];
    chain.on('replay-rejected', e => events.push(e));
    chain.load();
    return { height: chain.height, tip: chain.tipId, events };
  });

  const asShipped = reopen(SHIPPED_ACTIVATION);
  eq(asShipped.height, built.height, 'the shipped node replays it to the same height');
  eq(asShipped.tip, built.tip, 'and the same tip');
  eq(asShipped.events.length, 0, 'and reports nothing as rejected');

  const ungated = reopen(1);
  ok(ungated.height < built.height,
    `while an ungated node truncates the branch at height ${ungated.height} — the failure the gate exists for`);
  ok(ungated.events.length === 1 && ungated.events[0].rejected >= 1,
    'and says so, which is all an operator would ever see of it');
}

// ===========================================================================
group('the rule does not fire below the activation height, and does at it');
// ===========================================================================
{
  /* MUTANT KILLED: `P.emergencyActive(parent.height)` instead of
   * `parent.height + 1` in `_targetFor`. One block early, forever — invisible on
   * a chain that is nowhere near its activation, and on the day it activates it
   * makes two nodes disagree about exactly one block, which is a chain split for
   * a reason nobody will find by reading a log.
   *
   * Built as a header series rather than by mining, because the point is which
   * HEIGHT the gate turns on at and mining 15,000 blocks to ask is not a test. */
  const ACT = 40;
  atActivation(ACT, () => {
    const chain = headerChain();
    let ts = 1_800_000_000;
    append(chain, ts, P.MAX_TARGET);
    // A window's worth of fast blocks, so the LWMA is well away from the floor
    // and an easement to MAX_TARGET is visibly different from not easing.
    for (let h = 1; h < ACT - 1; h++) { ts += 1; append(chain, ts, chain._nextTarget(chain.tipId)); }

    const base = chain._nextTarget(chain.tipId);
    ok(Number(HDR.difficulty(base)) > FLOOR_DIFFICULTY * 4,
      `the LWMA has been driven to difficulty ${HDR.difficulty(base)} — well above the floor of ${FLOOR_DIFFICULTY}`);

    const late = ts + THRESHOLD + 1;
    const below = chain._targetFor(chain.tipId, late);
    eq(below, base, `at height ${ACT - 1}, one below activation, a ${THRESHOLD + 1}-second block gets the LWMA target`);

    append(chain, late, below);
    const at = chain._targetFor(chain.tipId, late + THRESHOLD + 1);
    eq(at, P.MAX_TARGET, `at height ${ACT}, the activation height itself, the same block gets the floor`);

    /* MUTANT KILLED: `<` instead of `<=` in the solve-time comparison. The rule
     * then fires at exactly 8× the target block time rather than past it, which
     * is a different consensus rule agreeing with this one on all but one second
     * of input — the kind of boundary two implementations differ on silently. */
    eq(chain._targetFor(chain.tipId, late + THRESHOLD), chain._nextTarget(chain.tipId),
      `and a block exactly ${THRESHOLD} s after its parent does not — the threshold is exclusive`);
    eq(chain._targetFor(chain.tipId, late + THRESHOLD + 1), P.MAX_TARGET,
      'while one second later it does');
  });
}

// ===========================================================================
group('a miner is handed the eased target, and mines a block that stands');
// ===========================================================================
{
  /* MUTANT KILLED, AND IT IS THE ONE WORTH HAVING: computing `target` before
   * `ts` in `buildCandidate`, i.e. leaving `this._nextTarget(parentId)` where it
   * was. Every block still validates, every suite still passes, the node mines
   * and syncs and serves templates — and no miner is ever offered the eased
   * target, so the rule exists in `_validate` and never fires in the world. The
   * only way to see it is to ask a candidate what target it carries.
   *
   * MUTANT ALSO KILLED: `_validate` left on `_nextTarget`. The candidate is then
   * built at the floor and refused by the node that built it, which is a miner
   * that produces nothing and blames its own proofs. */
  const dir = tmpdir('mine');
  atActivation(4, () => {
    const chain = new Blockchain({ dataDir: dir, config: { target: ABOVE_FLOOR } }).load();
    let ts = chain.entry(chain.tipId).block.header.timestamp;
    for (let i = 0; i < 3; i++) {
      ts += P.TARGET_BLOCK_TIME;
      const r = chain.addBlock(C.mineOn(chain, chain.tipId, key, { timestamp: ts }));
      ok(r.ok !== false, 'a warm-up block on schedule is accepted: ' + r.err);
    }
    const base = chain._nextTarget(chain.tipId);
    ok(Number(HDR.difficulty(base)) > FLOOR_DIFFICULTY,
      `the chain is asking for difficulty ${HDR.difficulty(base)} for its next block`);

    const late = ts + THRESHOLD + 1;        // the tip is 121 s old: the chain a burst leaves
    const cand = chain.buildCandidate({ coinbasePub: key.publicKey.toString('hex'), timestamp: late });
    eq(cand.header.target, P.MAX_TARGET, 'so the candidate the miner is handed carries the floor target');
    ok(cand.header.target !== base, `and not the LWMA's ${HDR.difficulty(base)}`);

    const r = chain.addBlock(C.mineOn(chain, chain.tipId, key, { timestamp: late }));
    ok(r.ok !== false, 'the block mined against it is accepted by the node that issued it: ' + r.err);
    eq(chain.height, 4, 'and is the tip');
    eq(chain.entry(chain.tipId).block.header.target, P.MAX_TARGET,
      'with the eased target committed in the header, where the next retarget will read it');
  });
}

// ===========================================================================
group('a block stamped into the future cannot buy the easement');
// ===========================================================================
{
  /* This is the reason MAX_FUTURE_DRIFT_S had to move in the same change. At
   * 7,200 s a miner does not have to WAIT 120 s to be 120 s late — it stamps
   * forward, well inside two hours of tolerated drift, and every block it makes
   * is at the floor. The easement stops bounding a stall and becomes the normal
   * difficulty of the chain.
   *
   * MUTANT KILLED: `P.MAX_FUTURE_DRIFT_S` left in `_validate` in place of
   * `P.maxFutureDriftS(hdr.height)`. Every existing suite passes — nothing else
   * in this repository stamps a block more than an hour out — and the chain
   * quietly stops having a difficulty.
   *
   * MUTANT ALSO KILLED: EMERGENCY_MAX_FUTURE_DRIFT_S raised to anything at or
   * above the threshold. params.js refuses to load at all in that case (the last
   * group here), but this is the behaviour that refusal is protecting. */
  const dir = tmpdir('future');
  atActivation(4, () => {
    const chain = new Blockchain({ dataDir: dir, config: { target: ABOVE_FLOOR } }).load();
    const now = Math.floor(Date.now() / 1000);
    // Warmed up to the CLOCK this time, not to the genesis timestamp: the drift
    // check is the one under test and it is the only rule here that reads a clock.
    for (const ts of [now - 31, now - 16, now - 1]) {
      const r = chain.addBlock(C.mineOn(chain, chain.tipId, key, { timestamp: ts }));
      ok(r.ok !== false, 'a warm-up block at the clock is accepted: ' + r.err);
    }
    ok(chain._nextTarget(chain.tipId) !== P.MAX_TARGET, 'with the chain off the floor, so the easement is a change');

    const forward = now + THRESHOLD + 1;    // 121 s ahead of a parent that is at `now`
    const cheat = C.mineOn(chain, chain.tipId, key, { timestamp: forward });
    eq(cheat.header.target, P.MAX_TARGET, 'a forward stamp does get the eased target from buildCandidate…');
    const r2 = chain.addBlock(cheat);
    eq(r2.ok, false, '…and the node refuses the block outright');
    eq(r2.err, 'timestamp too far in future', 'naming the drift, not the difficulty');

    eq(P.maxFutureDriftS(P.EMERGENCY_ACTIVATION_HEIGHT), P.EMERGENCY_MAX_FUTURE_DRIFT_S,
      'because the drift tightens at exactly the height the easement begins');
    eq(P.maxFutureDriftS(P.EMERGENCY_ACTIVATION_HEIGHT - 1), P.MAX_FUTURE_DRIFT_S,
      'and is the inherited two hours below it, so history keeps validating');
    ok(P.EMERGENCY_MAX_FUTURE_DRIFT_S < THRESHOLD,
      `so at least ${THRESHOLD - P.EMERGENCY_MAX_FUTURE_DRIFT_S} s of the ${THRESHOLD} s must be genuinely elapsed`);
  });
}

// ===========================================================================
group('params refuses to load if the drift ever reaches the threshold');
// ===========================================================================
{
  /* MUTANT KILLED: deleting the assertion at the foot of src/params.js. The two
   * constants it relates are three hundred lines apart and a future retune of
   * either — a longer TARGET_BLOCK_TIME, a looser drift for a peer with a bad
   * clock — silently unbinds the rule. There is no symptom: the node mines, the
   * chain advances, and its difficulty is the floor forever.
   *
   * The copy is edited on disk and required, so what is under test is the file
   * as it loads rather than a description of it. params.js requires nothing, so
   * it resolves from anywhere. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'params.js'), 'utf8');
  const dir = tmpdir('params');
  const write = (text, name) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

  const unchanged = write(src, 'ok.js');
  let boom = null;
  try { require(unchanged); } catch (e) { boom = e; }
  eq(boom, null, 'the shipped file loads' + (boom ? ' — ' + boom.message : ''));

  const loose = write(src.replace(/EMERGENCY_MAX_FUTURE_DRIFT_S: \d+/, `EMERGENCY_MAX_FUTURE_DRIFT_S: ${THRESHOLD}`), 'loose.js');
  let thrown = null;
  try { require(loose); } catch (e) { thrown = e; }
  ok(thrown !== null, `a drift of exactly ${THRESHOLD} s is refused at require() time`);
  ok(thrown !== null && /strictly less than/.test(String(thrown.message)),
    'with the inequality named rather than a bare assertion failure');
}

// ===========================================================================
group('the burst that wedged mainnet, replayed against both rules');
// ===========================================================================
{
  /* The shape micro-org#363 measured on 2026-08-10: a chain resting at the floor
   * with the ~17 H/s that a 15-second block there needs, joined for thirty
   * minutes by a browser tab worth +550 H/s, which then closes.
   *
   * The mining model is deterministic — a block lands when cumulative hashrate
   * has paid its difficulty — so this is a statement about expectations, not a
   * sample. That is the right shape for a regression assertion and the wrong one
   * for a forecast; the real chain's individual blocks are geometric around
   * these numbers. Attempts are independent and memoryless, so the work ground
   * before an easement is correctly discarded rather than credited.
   *
   * MUTANT KILLED: `_targetFor` returning `base` unconditionally. Every other
   * group here still passes if the rule is merely never REACHED under load; this
   * one is the only place that asks what it is for. */
  const H0 = 17.1, BURST = 550, BURST_S = 30 * 60;

  function simulate(emergency) {
    const chain = headerChain(P.MAX_TARGET);
    let t = 0;
    append(chain, t, P.MAX_TARGET);
    for (let i = 0; i < P.LWMA_WINDOW + 2; i++) { t += P.TARGET_BLOCK_TIME; append(chain, t, P.MAX_TARGET); }
    const burstStart = t, burstEnd = t + BURST_S;
    const rate = at => H0 + (at >= burstStart && at < burstEnd ? BURST : 0);
    const solve = (from, work) => { let acc = 0, s = 0; while (acc < work) { acc += rate(from + s); s++; } return s; };

    let peak = 0, longest = 0, recoveredAt = null, blocksToFloor = null, after = 0;
    while (t < burstEnd + 8 * 3600) {
      const base = chain._nextTarget(chain.tipId);
      const D = Number(HDR.difficulty(base));
      if (D > peak) peak = D;
      let s = solve(t, D), target = base;
      if (emergency && s > THRESHOLD) { s = THRESHOLD + solve(t + THRESHOLD, FLOOR_DIFFICULTY); target = P.MAX_TARGET; }
      t += s;
      append(chain, t, target);
      if (t > burstEnd) {
        if (s > longest) longest = s;
        if (blocksToFloor === null && target === P.MAX_TARGET) blocksToFloor = after;
        after++;
        if (recoveredAt === null && Number(HDR.difficulty(chain._nextTarget(chain.tipId))) <= FLOOR_DIFFICULTY) {
          recoveredAt = t;
        }
      }
      if (recoveredAt !== null && t > recoveredAt + 900) break;
    }
    return {
      peak,
      longestMin: longest / 60,
      recoveryMin: recoveredAt === null ? Infinity : (recoveredAt - burstEnd) / 60,
      blocksToFloor: blocksToFloor === null ? Infinity : blocksToFloor,
    };
  }

  const before = atActivation(Number.MAX_SAFE_INTEGER, () => simulate(false));
  const after = atActivation(0, () => simulate(true));
  const row = (name, r) => console.log(`      ${name.padEnd(12)} peak ${String(r.peak).padStart(5)}`
    + `   longest block ${r.longestMin.toFixed(1).padStart(4)} min`
    + `   priced at the floor after ${String(r.blocksToFloor).padStart(3)} blocks`
    + `   LWMA back to the floor ${r.recoveryMin.toFixed(0).padStart(3)} min`);
  console.log(`    baseline ${H0} H/s, +${BURST} H/s for ${BURST_S / 60} minutes, measured from when it leaves:`);
  row('status quo', before);
  row('this rule', after);

  /* TWO RECOVERY NUMBERS BECAUSE THEY ARE TWO QUESTIONS, and reporting only one
   * of them is how "recovers in 0 minutes" gets written down.
   *
   * What a MINER meets is the first column: the first block that has to face the
   * reduced hashrate for its whole search is already priced at the floor, so
   * nothing on this chain waits for a retarget. What the DIFFICULTY GAUGE shows
   * is the second, and it is emphatically not zero — the LWMA's mean-target term
   * still has a sixty-block window to walk off, so `indexer_chain_difficulty`
   * stays elevated for a while after the chain has stopped caring. Halved here
   * rather than eliminated, and an operator watching that gauge during the first
   * real burst after activation should expect the tail. */
  ok(after.blocksToFloor <= 1,
    `the first block to face the reduced hashrate alone is already priced at the floor `
    + `(block ${after.blocksToFloor} after the burst, against ${before.blocksToFloor} without the rule)`);

  ok(after.longestMin < before.longestMin / 2,
    `the longest block after the hashrate leaves falls from ${before.longestMin.toFixed(1)} to `
    + `${after.longestMin.toFixed(1)} minutes`);
  ok(after.longestMin <= (THRESHOLD + 60) / 60,
    `and is bounded by the threshold plus one block at the floor, whatever the burst was `
    + `(${after.longestMin.toFixed(1)} min)`);
  ok(after.recoveryMin < before.recoveryMin,
    `the walk back to the floor falls from ${before.recoveryMin.toFixed(0)} to `
    + `${after.recoveryMin.toFixed(0)} minutes`);
  /* Stated as an assertion because it is the honest half of the claim and the
   * one a reader will want to argue with: a thirty-minute burst is long enough
   * for the retarget to track it fully under any window, so the EXCURSION is set
   * by the browser's hashrate and by nothing in params.js. No option in
   * micro-org#363's table moved it, and neither does this one. */
  eq(after.peak, before.peak, 'the peak difficulty is untouched — no rule here reduces it, and none claimed to');
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
T.done();
