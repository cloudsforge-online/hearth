'use strict';
/* The light-mining loop, driven directly instead of through a terminal.
 * Run: node test/mine-session.js   (also part of `npm test`)
 *
 * test/miner-cli.js already drives `hearth-mine` as a process and greps its
 * status line, which is the right test for a command-line program and a poor one
 * for a loop that now also has a window attached to it. This suite holds
 * src/mine/session.js to the behaviour BOTH front-ends depend on, at the seam
 * they both use — the event stream — so a change that breaks the desktop app
 * cannot pass by keeping the CLI's wording intact.
 *
 * The two halves are deliberately different in kind:
 *
 *   AGAINST A REAL NODE. A session takes work over real HTTP from a real
 *   EvmNode, grinds real Homefire, signs real proofs, and the node's own state
 *   is asked afterwards whether the address was actually credited. Nothing is
 *   stubbed, so "it mined" is a fact about a chain rather than about a mock.
 *
 *   AGAINST A HOSTILE ONE. `fetch` is injected for the rest, because the
 *   failures that cost a miner real money — work that pays someone else, a
 *   parameter change nothing will accept, a node that meters us — are precisely
 *   the ones a healthy node will not produce on demand.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const HDR = require('../src/chain/header');
const { EvmNode } = require('../src/evmnode');
const { keyFrom, newKey, ember } = require('../src/coinbase');
const { MineSession } = require('../src/mine/session');
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
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-sess-${tag}-`)); dirs.push(d); return d; };

/** Collect every event a session emits, in order, with its payload. */
function record(s) {
  const log = [];
  for (const e of ['started', 'work', 'rate', 'accepted', 'stale', 'refused', 'throttled',
    'unreachable', 'reachable', 'badwork', 'lost', 'error', 'stopped']) {
    s.on(e, p => log.push({ e, p }));
  }
  log.of = name => log.filter(x => x.e === name).map(x => x.p);
  log.count = name => log.of(name).length;
  return log;
}

/** A fetch that answers from a function, so a node can be made to misbehave. */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), at: Date.now(), method: (init && init.method) || 'GET' });
    const r = await handler(String(url), init, calls.length);
    return { status: r.status, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

(async () => {
  console.log('\nHearth light-mining session\n');

  // ==========================================================================
  group('END TO END: a session mines a real node, and the chain says so');
  // ==========================================================================
  const nodeDir = tmpdir('node');
  const node = new EvmNode({ dataDir: nodeDir, quiet: true, genesis: { target: C.EASY_TARGET } });
  const server = node.listenRest(0);
  await new Promise(r => server.on('listening', r).listening && r());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /* A key the node has never seen the private half of. That is the whole claim
   * of remote mining: the node builds work paying an address it cannot spend
   * from, and only the holder of this key can redeem the proof. */
  const minerKey = newKey();
  assert(minerKey.addressHex.toLowerCase() !== node.minerAddress.toLowerCase(),
    'the miner\'s key is not the node\'s own coinbase');
  const startHeight = node.chain.height;
  const startBalance = node.chain.stateAtTip().getBalance(minerKey.address);
  assert(startBalance === 0n, 'and its address starts with nothing');

  const s = new MineSession({ url: base, key: minerKey, throttle: 1 });
  const log = record(s);
  const run = s.run();
  /* Wait for BOTH facts this group asserts, not just the first. The hashrate is
   * recomputed once a second of hashing has accumulated, and two lucky wins at
   * MAX_TARGET can land inside that second — so stopping at `found >= 2` left
   * `rate` empty perhaps one run in twenty, which is a flake and not a finding. */
  const deadline = Date.now() + 180_000;
  while ((s.found < 2 || log.count('rate') < 1) && Date.now() < deadline) await sleep(100);
  s.stop('the test has what it needs');
  const reason = await run;

  assert(s.found >= 2, `it found ${s.found} blocks over plain HTTP`);
  assert(node.chain.height >= startHeight + 2, `THE CHAIN GREW to height ${node.chain.height} — the proofs were accepted`);

  const balance = node.chain.stateAtTip().getBalance(minerKey.address);
  assert(balance > 0n, `AND THE ADDRESS WAS CREDITED: ${ember(balance)} ${P.COIN} at ${minerKey.addressHex}`);
  assert(balance === BigInt(s.earnedWei),
    `what the session says it earned (${ember(s.earnedWei)}) is what the chain actually holds (${ember(balance)})`);

  /* The reward it reports must be the COINBASE's share, not the block's whole
   * subsidy: 10% of every subsidy goes to the Commons, and a running total that
   * is a tenth too high never reconciles against a wallet. */
  const accepted = log.of('accepted');
  assert(accepted.length === s.found, `it announced each of the ${s.found} blocks`);
  assert(accepted.every(a => BigInt(a.paidWei) === P.coinbaseRewardWei(a.height)),
    'each at what the coinbase is PAID, not at what the block mints');
  assert(accepted.some(a => BigInt(a.paidWei) !== P.subsidyWei(a.height)),
    `— which is a different number (${ember(P.coinbaseRewardWei(accepted[0].height))} vs `
    + `${ember(P.subsidyWei(accepted[0].height))}), so the Commons share is not counted as the miner's`);
  assert(accepted.every(a => /^[0-9a-f]{6,}$/.test(a.id)), 'with the block id the node gave back');

  assert(log.count('work') >= 2, `it reported taking work ${log.count('work')} times`);
  assert(log.of('work').every(w => w.height > 0 && typeof w.target === 'string'),
    'saying which height and at what target');
  assert(log.count('rate') >= 1, 'and reported a hashrate at least once');
  assert(log.count('rate') >= 1 && log.of('rate').every(r => r.hashrate > 0),
    `— a real one (${(log.of('rate')[0] || {}).hashrate} H/s)`);
  assert(reason === 'the test has what it needs', `it stopped for the reason it was given ("${reason}")`);
  assert(log.count('stopped') === 1 && log.of('stopped')[0].found === s.found,
    'and said so once, with the final tally');

  /* THE THING THAT MUST NEVER HAPPEN. A UI renders whatever it is handed, and a
   * crash reporter uploads it. Nothing on this stream may carry the key. */
  const priv = minerKey.privateKey.toString('hex');
  const stream = JSON.stringify(log) + JSON.stringify(s.stats());
  assert(!stream.includes(priv), 'NO EVENT AND NO STAT CARRIES THE PRIVATE KEY');
  assert(!stream.includes(minerKey.privateKey.toString('base64')), 'in any encoding');
  assert(s.stats().address === minerKey.addressHex,
    'the stats do carry the address, which is the question an operator actually asks');
  server.close();

  // ==========================================================================
  group('it refuses work that is not its own, before spending a cycle on it');
  // Every case here is a template a lying endpoint can build. The cost of
  // missing one is hours of electricity and a submission refused at the end.
  // ==========================================================================
  /* Fixtures come from a PRISTINE node, not from `node` above. That one has just
   * had blocks mined on it as fast as a core allows, so LWMA has retargeted it
   * several times harder — and a fixture whose target drifts turns "how many
   * proofs did it submit in four seconds" into a measurement of the retarget
   * rule. At genesis the target is MAX_TARGET and a win is tens of attempts. */
  const fixtureNode = new EvmNode({ dataDir: tmpdir('fixtures'), quiet: true, genesis: { target: C.EASY_TARGET } });
  const real = fixtureNode.templates.issue(minerKey.publicKey.toString('hex'));
  const other = newKey();

  const doctored = async (mangle, label, re) => {
    const f = fakeFetch(async url => {
      if (url.includes('/mining/template')) return { status: 200, body: mangle(JSON.parse(JSON.stringify(real))) };
      return { status: 200, body: { ok: false, err: 'should never be reached' } };
    });
    const sess = new MineSession({ url: 'http://liar.invalid', key: minerKey, fetch: f, retryMs: 10 });
    const l = record(sess);
    const why = await sess.run();
    assert(re.test(why), `${label} — "${String(why).slice(0, 60)}"`);
    assert(l.count('badwork') === 1, '  …announced as bad work, once');
    assert(l.count('work') === 0, '  …and never accepted as work to grind');
    assert(f.calls.filter(c => c.method === 'POST').length === 0, '  …so nothing was ever submitted');
    return why;
  };

  await doctored(t => ({ ...t, coreHash: 'ab'.repeat(32) }), 'a core hash that does not commit to its own header',
    /core hash does not match/i);

  await doctored(t => {
    /* The version a careless check misses: the coinbase is swapped AND the core
     * hash is recomputed to be consistent with it, so only comparing the key to
     * our own catches it. */
    const h = {};
    for (const f of ['version', 'prevHash', 'height', 'timestamp', 'target', 'coinbasePub', 'txRoot',
      'stateRoot', 'receiptsRoot', 'logsBloom', 'gasLimit', 'gasUsed', 'extraData']) h[f] = t[f];
    h.coinbasePub = other.publicKey.toString('hex');
    return { ...t, coinbasePub: h.coinbasePub, coinbaseAddress: other.addressHex, coreHash: HDR.coreHash(h) };
  }, 'work that pays somebody else, with a core hash consistent with it', /pays another coinbase/i);

  await doctored(t => ({ ...t, coinbaseAddress: other.addressHex }), 'work whose stated address is not ours',
    /pays 0x/i);

  await doctored(t => ({ ...t, scratchKiB: P.POW_SCRATCH_KIB * 2 }),
    'work built with a different scratch pad — a retune nothing would accept', /scratch pad/i);
  await doctored(t => ({ ...t, walkSteps: P.POW_WALK_STEPS + 1 }),
    'work built with a different walk length', /walks \d+ steps/i);
  await doctored(t => { const c = { ...t }; delete c.stateRoot; return c; },
    'work from a node too old to send the fields the check needs', /does not carry the header fields/i);
  await doctored(() => ({ nope: true }), 'a response that is not a template at all', /not a work template/i);

  // ==========================================================================
  group('a metered node is backed off from, not hammered');
  // The endpoints are metered rather than authenticated (params.js
  // MINING_VERIFY_BURST). The honest answer to 429 is to ask less often.
  // ==========================================================================
  {
    const HAMMER = 20;
    let hammered = false, sess = null;
    /* THE TRIP-WIRE IS IN THE HANDLER, not on a timer, and that is not fussiness:
     * a client that answers 429 by retrying immediately never yields to the
     * MACROTASK queue — every `await` in that path resolves as a microtask — so
     * `setTimeout` never fires and the suite hangs instead of failing. A hang in
     * CI is a six-hour timeout and a shrug; a red check is a bug report. Counting
     * here runs on the caller's own stack, so it fires either way. */
    const f = fakeFetch(async (url, init, n) => {
      void url; void init;
      if (n > HAMMER) { hammered = true; if (sess) sess.stop('hammering the endpoint'); }
      return { status: 429, body: { err: 'too many work requests — slow down', retryAfterMs: 300 } };
    });
    sess = new MineSession({ url: 'http://busy.invalid', key: minerKey, fetch: f, retryMs: 10 });
    const l = record(sess);
    const running = sess.run();
    const stopper = setTimeout(() => sess.stop(), 1000);
    await running;
    clearTimeout(stopper);

    assert(l.count('throttled') >= 2, `it noticed being rate-limited (${l.count('throttled')} times)`);
    assert(l.of('throttled').every(t => t.kind === 'template'), 'and said which endpoint');
    /* In one second, honouring a 300 ms retryAfterMs plus the 10 ms retry gap
     * allows about three requests. A client that ignored it would make hundreds,
     * and be refused by a node it had just made slower. */
    assert(!hammered, `it made ${f.calls.length} requests in a second, not ${HAMMER}+`);
    assert(f.calls.length >= 2, '— while still retrying rather than giving up');
    assert(l.count('unreachable') === 1, 'it says the node is not answering once, not once per retry');
  }

  // ==========================================================================
  group('being throttled on a PROOF is not a refusal');
  // A 429 on submit means our proof was fine and the node was busy. Counting it
  // toward the give-up threshold turns a node under load into a miner that quits
  // — and a miner that quits at 3am earns nothing until somebody notices.
  // ==========================================================================
  {
    let posts = 0;
    /* The template is a REAL one, only its expiry pushed out — anything else
     * doctored breaks the core hash and the session correctly refuses the work
     * before ever reaching the behaviour under test. */
    const f = fakeFetch(async (url, init) => {
      if (url.includes('/mining/template')) return { status: 200, body: { ...real, expiresAt: Date.now() + 60_000 } };
      posts++;
      void init;
      return { status: 429, body: { err: 'too many proofs to verify — slow down', retryAfterMs: 50 } };
    });
    const sess = new MineSession({ url: 'http://busy2.invalid', key: minerKey, fetch: f, retryMs: 10 });
    const l = record(sess);
    const running = sess.run();
    /* WAIT FOR THE EVENT, NOT FOR THE CLOCK. A win at MAX_TARGET is 256 expected
     * evaluations and the distribution is geometric, so a fixed four-second
     * window submitted anywhere from one proof to four on the same machine — and
     * `refused === 0` passes vacuously when the count is zero, which is a check
     * that cannot fail dressed up as one that can. */
    const WANT = 3, deadline2 = Date.now() + 120_000;
    while (posts < WANT && Date.now() < deadline2) await sleep(50);
    const stillRunning = sess.stats().running;
    sess.stop();
    await running;

    assert(posts >= WANT, `${posts} proofs were submitted and every one was throttled`);
    assert(l.of('throttled').filter(t => t.kind === 'submit').length === posts, 'each reported as throttling');
    assert(l.count('refused') === 0, 'NOT ONE was counted as a refusal');
    assert(sess.refused === 0, 'the refusal counter stayed at zero');
    assert(stillRunning, 'and the session was still mining, not stopped');
  }

  // ==========================================================================
  group('but real refusals do stop it, rather than burning a core into a wall');
  // ==========================================================================
  {
    const f = fakeFetch(async url => {
      if (url.includes('/mining/template')) return { status: 200, body: { ...real, expiresAt: Date.now() + 60_000 } };
      return { status: 400, body: { ok: false, err: 'bad signature' } };
    });
    const sess = new MineSession({ url: 'http://wall.invalid', key: minerKey, fetch: f, retryMs: 10 });
    const l = record(sess);
    /* THE SAME 120 SECONDS THE GROUP ABOVE ALLOWS, AND FOR THE SAME REASON.
     *
     * This raced a real proof-of-work search against a 20-second clock, and it had to
     * win FIVE times before the assertion below could hold — `sess.refused === 5`. A
     * win at MAX_TARGET is 256 expected evaluations and the distribution is geometric,
     * so on a slow runner the search simply had not finished and the session was
     * reported as "mining forever" when it was in fact still working.
     *
     * It failed that way on CI twice running (30918746545, 30922381837) while passing
     * locally on two runs out of three, which is the signature of a deadline rather
     * than a defect: nothing in src/mine/session.js differed between them.
     *
     * The guarantee is unchanged. This still distinguishes a session that stops itself
     * after five refusals from one that grinds forever — it just stops calling a slow
     * machine a broken one. :257-261 above already made this argument: wait for the
     * event, not for the clock. */
    const why = await Promise.race([sess.run(), sleep(120_000).then(() => 'TIMED OUT')]);
    assert(why !== 'TIMED OUT', 'it stops by itself rather than mining forever');
    assert(/refused/i.test(String(why)), `and says why — "${String(why).slice(0, 60)}"`);
    assert(sess.refused === 5, `after exactly ${sess.refused} refusals, not one and not fifty`);
    assert(l.of('refused').every(r => /bad signature/.test(r.err)), 'passing on the node\'s own reason each time');
  }

  // ==========================================================================
  group('an endpoint that is not there is a sentence, not a crash');
  // ==========================================================================
  {
    const f = fakeFetch(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); });
    const sess = new MineSession({ url: 'http://127.0.0.1:1', key: minerKey, fetch: f, retryMs: 60 });
    const l = record(sess);
    const running = sess.run();
    await sleep(500);
    assert(sess.stats().running, 'it keeps retrying rather than exiting');
    assert(f.calls.length >= 3, `— ${f.calls.length} attempts in half a second`);
    assert(l.count('unreachable') === 1, 'and says so ONCE, not once per attempt');
    assert(/could not reach/i.test(l.of('unreachable')[0].err), 'in words a person can act on');
    assert(l.count('error') === 0, 'with no error event — an unreachable node is not a bug');
    sess.stop();
    await running;
  }

  // ==========================================================================
  group('…and when it comes back, it says that too');
  // Watched to fail by leaving `this.reachable = true` unconditional in
  // _fetchWork(), which reports the recovery on every single poll.
  // ==========================================================================
  {
    let up = false;
    const f = fakeFetch(async url => {
      if (!up) throw new Error('connect ECONNREFUSED');
      if (url.includes('/mining/template')) {
        return { status: 200, body: { ...real, expiresAt: Date.now() + 60_000 } };
      }
      return { status: 409, body: { stale: true } };
    });
    const sess = new MineSession({ url: 'http://flaky.invalid', key: minerKey, fetch: f, retryMs: 30 });
    const l = record(sess);
    const running = sess.run();
    await sleep(200);
    assert(l.count('unreachable') === 1 && l.count('reachable') === 0, 'while it is down, one complaint and no recovery');
    up = true;
    await sleep(400);
    sess.stop();
    await running;
    assert(l.count('reachable') === 1, 'when it answers again, the recovery is announced exactly once');
  }

  // ==========================================================================
  group('WORK THAT HAS NOT CHANGED IS NOT SEARCHED FROM THE SAME NONCE AGAIN');
  // THE DEFECT THIS SUITE EXISTS FOR. Both operator miners mined a burst of
  // blocks and then stopped forever at a real, reported hashrate, at the EASIEST
  // target the retarget rule allows (params.js MAX_TARGET, difficulty 256), with
  // no error, no refusal and no expiry anywhere in the logs — and restarting the
  // process changed nothing.
  //
  // The cause is an interaction, which is why neither half looks wrong alone:
  //
  //   THE NODE MEMOIZES THE CANDIDATE on (tip, mempool version, coinbase key)
  //   — src/chain/miner.js — because /mining/template is unauthenticated
  //   and building one EXECUTES a full block. So while the tip is still, every
  //   request returns a byte-identical `coreHash` with a frozen `timestamp`;
  //   only `templateId` and `expiresAt` change. That is asserted below rather
  //   than assumed.
  //
  //   THE MINER RESTARTED ITS SEARCH AT NONCE 0 on every re-fetch, and a
  //   template expires every 120 s (src/chain/miner.js), so it re-fetched
  //   every 115 s (EXPIRY_MARGIN_MS). The seed is h(coreHash, nonce,
  //   coinbasePub) (src/pow.js): the same nonce over the same coreHash has
  //   the same digest, forever. So the miner re-tested exactly the nonces it had
  //   already rejected, at full speed, and if no winner lay in the range one
  //   window covers it could NEVER find one. Six blocks a second of honest work,
  //   zero blocks, permanently — and a restart re-treads the same range.
  //
  // The check is deterministic, not statistical: the first winning nonce from a
  // pinned start is COMPUTED first, and the template is then made to expire
  // after a third of the way to it. Nothing here can pass by luck, and nothing
  // here can pass vacuously — a specific nonce must come back from a submission
  // that only happens on a real win.
  // ==========================================================================
  {
    /* Two issues from a still tip. The node's own behaviour, checked, because
     * every line below depends on it. */
    const t1 = fixtureNode.templates.issue(minerKey.publicKey.toString('hex'));
    await sleep(1100);                          // long enough for a second to tick over
    const t2 = fixtureNode.templates.issue(minerKey.publicKey.toString('hex'));
    assert(t1.coreHash === t2.coreHash,
      'a node re-issues the SAME work while its tip is still — identical core hash');
    assert(t1.timestamp === t2.timestamp && t1.templateId !== t2.templateId,
      '— same frozen timestamp under a new template id, so "fresh work" is not fresh');

    const POW = require('../src/pow');
    const work = t2;

    /* What one evaluation costs HERE — a CI runner and a laptop differ by 3x, and
     * the window below has to be a number of attempts, not a number of ms. */
    const c0 = Date.now();
    const CAL = 15;
    for (let i = 0; i < CAL; i++) POW.homefireHash(POW.powSeed(work.coreHash, 9e6 + i, work.coinbasePub));
    const perMs = (Date.now() - c0) / CAL;

    /* A START WITH NO WINNER NEAR IT, and this is the whole of what makes the
     * check deterministic rather than a coin toss. The distance to the first
     * winner is geometric with mean 256, so a pinned start can happen to have one
     * ten nonces away — and then a miner that restarts its search finds it inside
     * the first window and the bug passes. So: take the first winner from a
     * candidate start, and if it is too close to be a real test, step the start
     * past it and look again. What comes out is a start with NO winner in
     * [start, winner), so a search that keeps restarting inside that range cannot
     * succeed by luck. Bounded on both axes; at difficulty 256 the loop needs a
     * second or two. */
    const MIN_DISTANCE = 90;
    let START = 1_000_000, winner = null;
    const wins = n => POW.meetsTarget(
      POW.homefireHash(POW.powSeed(work.coreHash, n, work.coinbasePub)).toString('hex'), work.target);
    for (let round = 0; round < 25 && winner === null; round++) {
      let w = null;
      for (let n = START; n < START + 6000 && w === null; n++) if (wins(n)) w = n;
      if (w === null) break;                    // ~1-in-10^10 at difficulty 256
      if (w - START >= MIN_DISTANCE) winner = w; else START = w + 1;
    }
    assert(winner !== null && winner - START >= MIN_DISTANCE,
      `the first winning nonce at or after ${START} is ${winner}, ${winner - START} away `
      + `(difficulty ${HDR.difficulty(work.target)}) — and nothing before it wins`);

    /* A window that reaches a THIRD of the way there. A miner that restarts its
     * search cannot ever arrive; one that carries it arrives on the third fetch. */
    const reach = Math.max(4, Math.floor((winner - START) / 3));
    const windowMs = Math.round(perMs * reach) + 5000;   // + EXPIRY_MARGIN_MS

    let fetches = 0, submittedNonce = null, submits = 0;
    const backwards = [];
    const f = fakeFetch(async (url, init) => {
      if (url.includes('/mining/template')) {
        fetches++;
        // Exactly what the node does: same candidate, new id, new expiry.
        return { status: 200, body: { ...work, templateId: 'id' + fetches, expiresAt: Date.now() + windowMs } };
      }
      submits++;
      submittedNonce = JSON.parse(init.body).nonce;
      return { status: 200, body: { ok: true, height: work.height, id: 'a1b2c3d4e5f6' } };
    });

    const sess = new MineSession({ url: 'http://frozen.invalid', key: minerKey, throttle: 1, fetch: f, retryMs: 10, startNonce: START });
    /* The search position must never move BACKWARDS while the work is unchanged.
     * Sampled on the same loop the miner runs on, so it sees every re-fetch. */
    let last = -1;
    const watch = setInterval(() => {
      if (sess.nonce < last) backwards.push({ from: last, to: sess.nonce });
      last = sess.nonce;
    }, 20);
    const running = sess.run();
    const deadline3 = Date.now() + 180_000;
    while (sess.found < 1 && Date.now() < deadline3) await sleep(50);
    clearInterval(watch);
    sess.stop();
    await running;

    assert(fetches >= 3, `the template expired and was re-fetched ${fetches} times, unchanged each time`);
    assert(sess.found === 1, `IT STILL FOUND THE BLOCK — ${sess.found} found across ${fetches} identical templates`);
    assert(submits === 1 && submittedNonce === winner,
      `at nonce ${submittedNonce}, which is the winner computed before the run (${winner}) — `
      + `${winner - START} evaluations past a window that only reaches ${reach}`);
    assert(backwards.length === 0,
      `and the search never went backwards over unchanged work (${backwards.length} restarts observed)`);
  }

  // ==========================================================================
  group('…and a RESTARTED miner does not re-tread the range it already rejected');
  // The operator restarted the stalled miner and it still produced nothing. It
  // could not have: a fresh process began at nonce 0 over the same frozen
  // coreHash, so it re-evaluated the identical digests and rejected them again.
  // ==========================================================================
  {
    const work = fixtureNode.templates.issue(minerKey.publicKey.toString('hex'));
    const starts = [];
    for (let i = 0; i < 3; i++) {
      const f = fakeFetch(async () => ({ status: 200, body: { ...work, expiresAt: Date.now() + 60_000 } }));
      const sess = new MineSession({ url: 'http://frozen.invalid', key: minerKey, fetch: f, retryMs: 10 });
      const running = sess.run();
      while (!sess.work) await sleep(5);
      starts.push(sess.nonce);
      sess.stop();
      await running;
    }
    assert(new Set(starts).size === 3,
      `three fresh sessions on IDENTICAL work began at three different nonces (${starts.join(', ')})`);
    assert(starts.every(n => Number.isInteger(n) && n >= 0 && Number.isSafeInteger(n + 1e9)),
      '— each a non-negative integer the node will accept (src/chain/miner.js:213)');
  }

  // ==========================================================================
  group('it refuses to be built without the two things it cannot work without');
  // ==========================================================================
  {
    let e1 = null, e2 = null;
    try { new MineSession({ key: minerKey }); } catch (e) { e1 = e; }
    try { new MineSession({ url: 'http://x' }); } catch (e) { e2 = e; }
    assert(e1 && /url/.test(e1.message), 'no url is a refusal, not a session that mines nowhere');
    assert(e2 && /key/.test(e2.message), 'no key is a refusal, not a session that mines to nobody');
    const sess = new MineSession({ url: 'http://x/', key: keyFrom(minerKey.privateKey) });
    assert(sess.base === 'http://x', 'a trailing slash on the url is trimmed rather than doubling up the path');
  }

  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('\nFAIL —', e);
  process.exit(1);
});
