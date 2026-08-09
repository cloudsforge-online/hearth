'use strict';
/* The browser miner must agree with the chain, bit for bit.
 *
 * `micro-network-site`'s `src/mining/{sha256,homefire}.js` reimplement SHA-256
 * and Homefire so they can run synchronously in a Worker — WebCrypto is async
 * and one Homefire attempt is ~8,450 hashes, so `crypto.subtle` would mean
 * thousands of promises per nonce. A digest that differs from the node's in one
 * bit is a block the network rejects, and the tab would look busy the whole
 * time, at full fan speed, paying nothing. This suite is the thing that catches
 * that.
 *
 * IT WENT MISSING FOR FIVE DAYS AND NOTHING SAID SO. The original stood here
 * until 2026-08-04, when `web/` — the browser miner of the day — was deleted
 * (`48bc28a`) and this file went with it. The miner came back on 2026-08-06 in
 * another repository; the suite did not. Its absence was invisible because
 * SECURITY.md, node/README.md, rust/README.md, docs/why-two-implementations.md
 * and both miner sources went on citing it in the present tense, and the
 * browser's own `homefire.js` and `sha256.js` still say "node/test/browser-pow.js
 * runs this file against the node's own implementation".
 *
 * WHAT IT DOES NOT COVER. Only the hash loop. The proof SIGNATURE — the other
 * half of a submission, and where the one real node/browser disagreement ever
 * was — is test/browser-proof.js.
 *
 * Run: node test/browser-pow.js  (or `npm run test:browser`; NOT part of
 * `npm test` — see test/browser-mining-src.js for why).
 */

const crypto = require('crypto');

const P = require('../src/params');
const POW = require('../src/pow');
const { resolveBrowserMining, importBrowser } = require('./browser-mining-src');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log('  ✓ ' + label)) : (fail++, console.log('  ✗ ' + label)); };
const section = s => console.log('\n• ' + s);

(async () => {
  const dir = resolveBrowserMining();
  console.log('\nHearth browser miner vs the node, digest for digest');
  console.log('browser source: ' + dir + '\n');

  const { Sha256, sha256, toHex } = await importBrowser(dir, 'sha256.js');
  const { Homefire, powSeed, meetsTarget, hexToBytes } = await importBrowser(dir, 'homefire.js');

  // ---------------------------------------------------------------- sha256
  section('SHA-256 matches Node');
  {
    const nodeHash = b => crypto.createHash('sha256').update(b).digest('hex');
    const cases = [
      Buffer.alloc(0),
      Buffer.from('abc'),
      Buffer.from('a'.repeat(55)),   // one byte under the padding boundary
      Buffer.from('a'.repeat(56)),   // exactly at it — forces a second block
      Buffer.from('a'.repeat(64)),   // exact block
      Buffer.from('a'.repeat(1000)),
      crypto.randomBytes(65_536),
    ];
    let allOk = true;
    for (const c of cases) if (toHex(sha256(new Uint8Array(c))) !== nodeHash(c)) allOk = false;
    ok(allOk, `${cases.length} inputs incl. the 55/56/64-byte padding edges`);

    // Streaming in odd-sized chunks must equal a single update.
    const data = crypto.randomBytes(5000);
    const h = new Sha256();
    for (let i = 0; i < data.length; i += 7) h.update(new Uint8Array(data.subarray(i, i + 7)));
    ok(toHex(h.digest()) === nodeHash(data), 'streaming in 7-byte chunks matches one-shot');

    // The hot path reuses one instance for millions of hashes rather than
    // allocating; a reset that left state behind would corrupt every digest
    // after the first, which is a bug that only shows up under load.
    const reused = new Sha256();
    reused.update(new Uint8Array(Buffer.from('first'))).digest();
    ok(toHex(reused.reset().update(new Uint8Array(Buffer.from('abc'))).digest()) === nodeHash(Buffer.from('abc')),
      'a reused instance resets cleanly (the hot path never allocates a new one)');
  }

  // ---------------------------------------------------------------- powSeed
  section('powSeed matches the node');
  {
    const h = new Sha256();
    let allOk = true;
    for (const [core, nonce, pub] of [
      ['00'.repeat(32), 0, '04' + 'ab'.repeat(64)],
      ['ff'.repeat(32), 1, '04' + 'cd'.repeat(64)],
      [crypto.randomBytes(32).toString('hex'), 987654321, '04' + crypto.randomBytes(64).toString('hex')],
    ]) {
      const mine = toHex(powSeed(h, core, nonce, pub));
      const theirs = POW.powSeed(core, nonce, pub).toString('hex');
      if (mine !== theirs) { allOk = false; console.log(`      nonce ${nonce} → ${mine.slice(0, 16)} vs ${theirs.slice(0, 16)}`); }
    }
    // The node passes the hex STRINGS to `createHash`, not the bytes they
    // encode, and the nonce as decimal text. A port that hashed the decoded
    // bytes would be the more obvious reading and would never mine anything.
    ok(allOk, 'hex strings are hashed as TEXT, and the nonce as decimal, exactly as the node does');
  }

  // ---------------------------------------------------------------- homefire
  section('Homefire digests match the node');
  {
    const hf = new Homefire(P.POW_SCRATCH_KIB, P.POW_WALK_STEPS);
    let allOk = true;
    for (let i = 0; i < 8; i++) {
      const seed = crypto.randomBytes(32);
      const mine = toHex(hf.hash(new Uint8Array(seed)));
      const theirs = POW.homefireHash(seed).toString('hex');
      if (mine !== theirs) { allOk = false; console.log(`      seed ${seed.toString('hex').slice(0, 16)} → ${mine.slice(0, 16)} vs ${theirs.slice(0, 16)}`); }
    }
    ok(allOk, `8 random seeds at the live params (${P.POW_SCRATCH_KIB} KiB / ${P.POW_WALK_STEPS} steps)`);

    // The browser allocates the scratchpad once per Miner and the node once per
    // hash. That is the one deliberate divergence between the two, and this is
    // the check that keeps it unobservable: leftover pad state must not reach
    // the next digest.
    const seed = crypto.randomBytes(32);
    const first = toHex(hf.hash(new Uint8Array(seed)));
    hf.hash(new Uint8Array(crypto.randomBytes(32)));
    ok(toHex(hf.hash(new Uint8Array(seed))) === first,
      'reusing one Homefire instance gives a stable digest (no scratchpad bleed)');

    // A stale miner must stop producing work rather than produce invalid work,
    // so the pad size and walk length travel with the template. Evaluating both
    // sides away from the configured params is the only way to prove the
    // browser reads them rather than baking them in.
    const OFF = [[P.POW_SCRATCH_KIB * 2, P.POW_WALK_STEPS], [P.POW_SCRATCH_KIB, P.POW_WALK_STEPS * 3]];
    let paramOk = true;
    for (const [kib, steps] of OFF) {
      const s = crypto.randomBytes(32);
      const mine = toHex(new Homefire(kib, steps).hash(new Uint8Array(s)));
      if (mine !== POW.homefireHash(s, kib, steps).toString('hex')) paramOk = false;
      // and the retuned digest must actually differ from the configured one,
      // or the comparison above would hold for a browser that ignored both.
      if (mine === POW.homefireHash(s).toString('hex')) paramOk = false;
    }
    ok(paramOk, 'and at retuned parameters, which the template carries and neither side hard-codes');
  }

  // ---------------------------------------------------------------- target
  section('target comparison matches the node');
  {
    const t = P.GENESIS_TARGET;
    const tb = hexToBytes(t);
    let allOk = true;
    for (let i = 0; i < 200; i++) {
      const d = crypto.randomBytes(32).toString('hex');
      if (meetsTarget(hexToBytes(d), tb) !== POW.meetsTarget(d, t)) allOk = false;
    }
    // and the boundaries the random sample will never hit. Equality is the one
    // that matters: the node compares `<=`, so a browser using `<` would throw
    // away a valid block roughly never, and be impossible to notice.
    for (const d of [t, '00'.repeat(32), 'ff'.repeat(32)]) {
      if (meetsTarget(hexToBytes(d), tb) !== POW.meetsTarget(d, t)) allOk = false;
    }
    ok(allOk, '200 random digests plus equal / min / max agree');
  }

  // ------------------------------------------------------------- end to end
  section('a digest the browser calls a win is a digest the node calls a win');
  {
    // The whole loop as the browser runs it — its SHA-256, its seed, its
    // Homefire, its target test — against a target easy enough to land. Nothing
    // above proves the four agree when COMPOSED; a browser that hashed
    // correctly and seeded from the wrong nonce would pass every section so far.
    const hf = new Homefire(P.POW_SCRATCH_KIB, P.POW_WALK_STEPS);
    const h = new Sha256();
    const target = P.MAX_TARGET;
    const tb = hexToBytes(target);
    const core = crypto.randomBytes(32).toString('hex');
    const pub = '04' + crypto.randomBytes(64).toString('hex');

    let nonce = 0, digestHex = null;
    for (; nonce < 200_000; nonce++) {
      const d = hf.hash(powSeed(h, core, nonce, pub));
      if (meetsTarget(d, tb)) { digestHex = toHex(d); break; }
    }
    ok(digestHex !== null, `the browser implementation found a nonce (nonce=${nonce})`);

    const theirs = POW.homefireHash(POW.powSeed(core, nonce, pub)).toString('hex');
    ok(theirs === digestHex, 'the node recomputes the identical digest from the same inputs');
    ok(POW.meetsTarget(theirs, target), 'and agrees that it meets the target');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nFAIL — ' + (e && e.message || e)); process.exit(1); });
