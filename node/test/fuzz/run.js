'use strict';
/* The fuzz runner.
 *
 *   node test/fuzz/run.js                     the CI pass: fixed seed, a couple of seconds
 *   node test/fuzz/run.js --time=60           a soak, same seed, sixty seconds
 *   node test/fuzz/run.js --seed=12345        a different stream
 *   node test/fuzz/run.js --target=rlp        one surface
 *   node test/fuzz/run.js --cases=200000      a case budget instead of a clock
 *   node test/fuzz/run.js --replay-only       just the corpus, no new cases
 *
 * Two modes and no third. The default pass is deterministic — same seed, same
 * cases, same result, every time, on every machine — because a CI job that
 * fuzzes differently on each run reports failures nobody can reproduce and gets
 * marked flaky and then ignored. The soak is where new ground is covered, and
 * its seed is printed at the top and again in every failure so that whatever it
 * finds becomes a corpus file and then part of the deterministic pass forever.
 *
 * THE CORPUS RUNS FIRST, ALWAYS. Everything the fuzzer has ever found is
 * re-checked before a single new case is generated, so a regression is caught
 * in milliseconds rather than after the seed happens to wander back.
 *
 * Output matches test/unit.js: a bullet per group, `✗` per failure, and
 * `PASS — n/n checks` with a non-zero exit code on failure.
 */

const { Harness, loadCorpus } = require('./harness');
const { Rng } = require('./random');

const TARGETS = [
  require('./target-rlp'),
  require('./target-transaction'),
  require('./target-trie'),
  require('./target-uint256'),
  require('./target-interpreter'),
];
const BY_NAME = new Map(TARGETS.map((t) => [t.name, t]));

/* The CI budget, per target. Chosen so the whole default pass is a couple of
 * seconds on a laptop; the interpreter is the slow one because every case
 * builds a StateDB and runs a VM, and the trie is slow because every case does
 * a few hundred keccaks. */
const CI_CASES = { rlp: 6000, transaction: 900, trie: 220, uint256: 20000, interpreter: 900 };
const DEFAULT_SEED = 0x48454152;                 // 'HEAR'

function parseArgs(argv) {
  const o = { seed: DEFAULT_SEED, time: null, cases: null, targets: null, replayOnly: false, save: true, quiet: false };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { console.error('fuzz: unrecognised argument ' + a); process.exit(2); }
    const [, k, v] = m;
    switch (k) {
      case 'seed': o.seed = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10); break;
      case 'time': o.time = Number(v); break;
      case 'cases': o.cases = parseInt(v, 10); break;
      case 'target': o.targets = v.split(',').map((s) => s.trim()); break;
      case 'replay-only': o.replayOnly = true; break;
      case 'no-save': o.save = false; break;
      case 'quiet': o.quiet = true; break;
      case 'list': console.log(TARGETS.map((t) => t.name).join('\n')); process.exit(0); break;
      case 'help': console.log(HELP); process.exit(0); break;
      default: console.error('fuzz: unknown option --' + k); process.exit(2);
    }
  }
  if (!Number.isFinite(o.seed)) { console.error('fuzz: --seed must be a number'); process.exit(2); }
  return o;
}

const HELP = `hearth EVM fuzzer
  --seed=N          PRNG seed (default 0x${DEFAULT_SEED.toString(16)}); printed on every failure
  --time=SECONDS    soak for this long, split evenly across the selected targets
  --cases=N         case budget per target (overrides the CI default)
  --target=a,b      only these targets (see --list)
  --replay-only     re-run the corpus and stop
  --no-save         do not write failing cases into corpus/
  --list            print target names
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chosen = opts.targets ? opts.targets.map((n) => {
    const t = BY_NAME.get(n);
    if (!t) { console.error(`fuzz: no target "${n}" — try --list`); process.exit(2); }
    return t;
  }) : TARGETS;

  const t = new Harness({ seed: opts.seed, save: opts.save });
  const started = Date.now();
  const slice = opts.time ? Math.max(1, Math.floor((opts.time * 1000) / chosen.length)) : null;

  console.log(`fuzz — seed=0x${(opts.seed >>> 0).toString(16)} targets=${chosen.map((x) => x.name).join(',')}`
    + (opts.time ? ` soak=${opts.time}s` : '') + (opts.cases ? ` cases=${opts.cases}/target` : ''));
  console.log('reproduce any failure below with: node test/fuzz/run.js --seed=0x'
    + (opts.seed >>> 0).toString(16) + ' --target=<name>\n');

  // -- the corpus, first and always -----------------------------------------
  const corpus = loadCorpus();
  const wanted = new Set(chosen.map((x) => x.name));
  const relevant = corpus.filter((e) => wanted.has(e.target));
  t.group(`corpus — ${relevant.length} recorded case(s)`);
  for (const entry of relevant) {
    if (entry._error) { t.context(entry.target || 'corpus', -1); t.ok(false, `corpus file ${entry._file} is unreadable: ${entry._error}`); continue; }
    const target = BY_NAME.get(entry.target);
    // Replaying must never write new corpus files — a corpus entry that fails
    // is already recorded, and re-saving it would fork it under a new name.
    const wasSaving = t.save; t.save = false;
    try { target.replay(t, entry); }
    catch (e) { t.ok(false, `corpus ${entry._file} threw during replay: ${e.stack ? e.stack.split('\n')[0] : e.message}`); }
    finally { t.save = wasSaving; }
  }

  if (opts.replayOnly) return finish(t, started, {});

  // -- new cases -------------------------------------------------------------
  const counts = {};
  for (const target of chosen) {
    const rng = new Rng(opts.seed ^ hashName(target.name));
    const cases = opts.cases !== null ? opts.cases : (slice ? Number.MAX_SAFE_INTEGER : (CI_CASES[target.name] || 1000));
    const deadline = slice ? Date.now() + slice : Number.MAX_SAFE_INTEGER;
    const t0 = Date.now();
    counts[target.name] = { cases: target.run(t, rng, { cases, deadline }), ms: 0 };
    counts[target.name].ms = Date.now() - t0;
  }
  return finish(t, started, counts);
}

/* Each target gets its own stream, derived from the run's seed and the target's
 * name, so adding a target or changing a case budget does not shift the cases
 * every other target sees. Without this, `--seed=N --target=rlp` would not
 * reproduce what `--seed=N` did. */
function hashName(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function finish(t, started, counts) {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const per = Object.entries(counts).map(([n, c]) => `${n}:${c.cases}`).join(' ');
  console.log(`\ncases: ${per || '(replay only)'}   elapsed ${secs}s`);
  const okAll = t.summary('fuzz checks');
  process.exit(okAll ? 0 : 1);
}

main();
