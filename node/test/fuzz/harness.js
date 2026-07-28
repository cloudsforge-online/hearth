'use strict';
/* The bookkeeping half of the fuzzer: counting checks, reporting failures with
 * enough information to reproduce them, and writing failing cases to the
 * corpus so they become permanent regression tests.
 *
 * The output shape matches test/unit.js and every other suite in test/ — a
 * bullet per group, a `✗` per failure, `PASS — n/n checks` at the end, and a
 * non-zero exit code when anything failed — so this can be dropped into the
 * `npm test` chain without anyone having to learn a second format.
 *
 * ONE RULE ABOUT FAILURES: a failing case is never reported as a message
 * alone. It carries the seed, the case index, and a JSON reproducer written
 * into corpus/. "RLP round-trip failed" is not a bug report; the bytes are.
 */

const fs = require('fs');
const path = require('path');

const CORPUS_DIR = path.join(__dirname, 'corpus');

/** Deep structural equality over the shape RLP.decode returns. */
function deepEq(a, b) {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  }
  return a === b;
}

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(String(s).replace(/^0x/i, ''), 'hex');

/** JSON that survives BigInts and Buffers, for corpus files and messages. */
function encodeJson(v) {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'bigint') return { $big: x.toString(10) };
    if (Buffer.isBuffer(x)) return { $hex: x.toString('hex') };
    if (x && x.type === 'Buffer' && Array.isArray(x.data)) return { $hex: Buffer.from(x.data).toString('hex') };
    return x;
  }, 2);
}

function decodeJson(text) {
  return JSON.parse(text, (_k, x) => {
    if (x && typeof x === 'object' && typeof x.$big === 'string') return BigInt(x.$big);
    if (x && typeof x === 'object' && typeof x.$hex === 'string') return Buffer.from(x.$hex, 'hex');
    return x;
  });
}

class Harness {
  /**
   * @param o.seed      the run's seed, printed on every failure
   * @param o.save      write failing cases into corpus/ (default true)
   * @param o.maxReport stop printing after this many failures — a broken
   *                    invariant fails on every case and would otherwise
   *                    bury the summary under a hundred thousand lines
   */
  constructor({ seed = 0, save = true, maxReport = 8, maxSave = 12 } = {}) {
    this.seed = seed >>> 0;
    this.save = save;
    this.maxReport = maxReport;
    this.maxSave = maxSave;
    this.pass = 0;
    this.fail = 0;
    this.pinned = 0;
    this.reported = 0;
    this.saved = [];
    this.caseIndex = 0;
    this.target = '';
    this.notes = new Map();
  }

  group(name) { console.log('• ' + name); }

  /**
   * An OBSERVATION, not a failure: something the fuzzer noticed that is worth a
   * human's attention but that no invariant in this directory calls wrong.
   * Deduplicated by key and printed once. This exists so that a known,
   * unpatched weakness can be surfaced on every run without turning CI red —
   * the alternative is either a silent fuzzer or a permanently failing build,
   * and both get ignored within a week.
   */
  note(key, message) {
    if (this.notes.has(key)) { this.notes.get(key).count++; return; }
    this.notes.set(key, { message, count: 1 });
    console.log('  ! ' + message);
  }

  /** The target and case currently under test; quoted in every failure. */
  context(target, caseIndex) { this.target = target; this.caseIndex = caseIndex; }

  /**
   * One check. `repro` is the object that, handed back to the target's
   * `replay`, re-runs exactly this case; it is written to corpus/ on failure.
   */
  ok(cond, msg, repro) {
    if (cond) { this.pass++; return true; }
    this.fail++;
    // The seed is printed the way `--seed=` takes it, so a failure line can be
    // pasted straight back onto the command line.
    const where = `seed=0x${this.seed.toString(16)} target=${this.target} case=${this.caseIndex}`;
    if (this.reported < this.maxReport) {
      this.reported++;
      console.log(`  ✗ ${msg}   [${where}]`);
      if (repro !== undefined) {
        const j = encodeJson(repro);
        console.log('    repro: ' + (j.length > 2000 ? j.slice(0, 2000) + ' …(truncated)' : j).replace(/\n\s*/g, ' '));
      }
    } else if (this.reported === this.maxReport) {
      this.reported++;
      console.log(`  … further failures suppressed (${this.maxReport} shown)`);
    }
    if (repro !== undefined) this.saveCase(msg, repro);
    return false;
  }

  /**
   * A check that FAILS because of a bug already found, already reported and
   * deliberately not patched here — this directory adds tests, it does not
   * touch src/. Pinning it keeps the run green while printing the finding on
   * every single run, and the pin is written so that the day somebody fixes
   * the underlying bug the *general* property in the target starts passing and
   * the pin can be deleted. The alternative — a permanently red build — is
   * worse: it is ignored within a week and then it hides the next bug.
   *
   * `where` must be a precise, one-line reproducer; it is what a reader acts on.
   */
  expectedBug(key, message, where) {
    this.pinned++;
    this.note(key, 'KNOWN BUG (not patched here): ' + message + (where ? ' — repro: ' + where : ''));
  }

  /** Persist a failing case so the next run re-checks it before fuzzing at all. */
  saveCase(msg, repro) {
    if (!this.save) return;
    if (this.saved.length >= this.maxSave) return;   // a broken invariant would fill the directory
    const body = Object.assign({ target: this.target, note: msg, seed: this.seed, case: this.caseIndex }, repro);
    const json = encodeJson(body);
    // Content-addressed by the reproducer, so the same failure found by two
    // seeds writes one file rather than a directory full of duplicates.
    const id = require('crypto').createHash('sha256').update(json).digest('hex').slice(0, 12);
    const file = path.join(CORPUS_DIR, `${this.target || 'unknown'}-${id}.json`);
    if (fs.existsSync(file)) return;
    try {
      fs.mkdirSync(CORPUS_DIR, { recursive: true });
      fs.writeFileSync(file, json + '\n');
      this.saved.push(path.relative(path.join(__dirname, '..', '..'), file));
    } catch (e) {
      console.log('    (could not write corpus file: ' + e.message + ')');
    }
  }

  /**
   * Run `fn` and assert it threw. Returns the error so the caller can check
   * its type — "it threw" is a much weaker claim than "it threw a TxError with
   * a code", and the weaker one is what lets a TypeError from a typo pass for
   * a rejection.
   */
  throws(fn) {
    try { const value = fn(); return { threw: false, value }; }
    catch (e) { return { threw: true, error: e }; }
  }

  summary(label) {
    const total = this.pass + this.fail;
    if (this.notes.size) {
      console.log('\nobservations (not failures):');
      for (const [, n] of this.notes) console.log(`  ! ${n.message}  ×${n.count}`);
    }
    if (this.saved.length) {
      console.log(`\n${this.saved.length} failing case(s) written to corpus/:`);
      for (const f of this.saved.slice(0, 20)) console.log('  ' + f);
    }
    console.log(`\n${this.fail === 0 ? 'PASS' : 'FAIL'} — ${this.pass}/${total} ${label}`
      + (this.notes.size ? ` (${this.notes.size} observation(s) above`
        + (this.pinned ? `, ${this.pinned} hit(s) on pinned known bugs` : '') + ')' : ''));
    return this.fail === 0;
  }
}

/** Read every corpus entry, newest-looking name last; order is stable. */
function loadCorpus() {
  if (!fs.existsSync(CORPUS_DIR)) return [];
  return fs.readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const full = path.join(CORPUS_DIR, f);
      try { return Object.assign(decodeJson(fs.readFileSync(full, 'utf8')), { _file: f }); }
      catch (e) { return { _file: f, _error: e.message }; }
    });
}

module.exports = { Harness, deepEq, hex, unhex, encodeJson, decodeJson, loadCorpus, CORPUS_DIR };
