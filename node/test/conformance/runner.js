#!/usr/bin/env node
'use strict';
/* Conformance runner.
 *
 * The harness later phases plug an implementation into. Nothing in this file
 * knows how to encode RLP, hash a trie or execute an opcode — it only knows how
 * to ask an implementation to, and how to say precisely what came back wrong.
 *
 * THE IMPLEMENTATION CONTRACT  (all parts optional; a missing part skips its suite)
 *
 *   impl.rlp = {
 *     encode(value, ctx) -> Buffer | Uint8Array | '0x…'
 *     decode(bytes, ctx) -> value            // MUST throw on malformed input
 *   }
 *     `value` is a tree of Buffers and Arrays. Integers in the fixtures are
 *     already resolved to minimal big-endian Buffers by the loader.
 *
 *   impl.trie = {
 *     root(pairs, ctx) -> '0x…'              // ctx.secure, ctx.ordered, ctx.vector
 *   }
 *     `pairs` is [[Buffer key, Buffer value | null], …]; a null value is a DELETE.
 *     When ctx.secure, keys are keccak256(key) before insertion.
 *
 *   impl.vm = {
 *     makeState(pre) -> state
 *     run({ state, env, exec, pre, vector }) -> {
 *       exception?: string,                  // set IFF execution failed
 *       gasLeft?: BigInt,                    // gas REMAINING, matching the fixture
 *       returnData?: Buffer | '0x…',
 *       logsHash?: '0x…',                    // keccak256(rlp(logs))
 *     }
 *   }
 *
 *   impl.state = {
 *     makeState(pre) -> state
 *     runTransaction({ state, env, tx, fork, pre, vector }) -> {
 *       exception?: string,                  // set IFF the tx was REJECTED
 *       logsHash?: '0x…',
 *       gasUsed?: BigInt,
 *       stateRoot?: '0x…',                   // only if state.root() is unavailable
 *     }
 *   }
 *
 *   state = {
 *     root() -> '0x…'                        // required for GeneralStateTests
 *     dump() -> { address: { nonce, balance, code, storage } }
 *                                            // optional, but WITHOUT IT a root
 *                                            // mismatch reports no account diff
 *                                            // and debugging gets much harder
 *   }
 *
 * SIGNALLING FAILURE. An implementation reports an EVM-level failure by
 * RETURNING `{ exception: '…' }`. A thrown JavaScript error is treated as a
 * harness-level ERROR, not as a passing exception — otherwise a TypeError in
 * the interpreter would masquerade as a correctly-rejected transaction, which
 * is exactly the class of bug this harness exists to catch. If throwing is more
 * natural, set `err.evmException = true` on the thrown error and it counts.
 * (RLP decode is the deliberate exception: there, throwing IS the contract.)
 *
 * Zero dependencies. Node 22+. CommonJS.
 */

const fs = require('fs');
const path = require('path');

const L = require('./loader');
const { createReporter, diffAccounts, STATUS } = require('./report');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const VECTORS_DIR = path.join(__dirname, 'vectors');

// ---------------------------------------------------------------------------
// small comparison helpers
// ---------------------------------------------------------------------------

function normCmp(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return 'n:' + v.toString(16);
  if (typeof v === 'number') return 'n:' + BigInt(v).toString(16);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return 'b:' + Buffer.from(v).toString('hex');
  if (typeof v === 'string') return 'b:' + L.hexToBuf(v).toString('hex');
  if (Array.isArray(v)) return '[' + v.map(normCmp).join(',') + ']';
  return 's:' + String(v);
}

function sameValue(a, b) {
  try { return normCmp(a) === normCmp(b); } catch { return false; }
}

/** Deep-clone the pre-state so an implementation mutating it cannot poison a rerun. */
function cloneAccounts(acc) {
  const out = {};
  for (const [addr, a] of Object.entries(acc || {})) {
    out[addr] = { nonce: a.nonce, balance: a.balance, code: Buffer.from(a.code), storage: { ...a.storage } };
  }
  return out;
}

function makeCheck() {
  const failures = [];
  const unchecked = [];
  let total = 0;
  let passed = 0;
  return {
    eq(what, expected, actual, extra) {
      total++;
      if (sameValue(expected, actual)) { passed++; return true; }
      failures.push({ what, expected, actual, ...(extra || {}) });
      return false;
    },
    ok(what, cond, extra) {
      total++;
      if (cond) { passed++; return true; }
      failures.push({ what, ...(extra || {}) });
      return false;
    },
    skipCheck(what, why) { unchecked.push(what + ' — ' + why); },
    finish() { return { failures, unchecked, checks: { total, passed } }; },
  };
}

/** Did the implementation report an EVM-level failure (as opposed to a crash)? */
function reportedException(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.exception) return String(res.exception);
  if (res.success === false) return 'success:false';
  if (res.ok === false) return 'ok:false';
  return null;
}

// ---------------------------------------------------------------------------
// implementation normalisation (accepts the flat aliases used in the brief)
// ---------------------------------------------------------------------------

function normaliseImpl(impl) {
  if (!impl) return { rlp: null, trie: null, vm: null, state: null };
  const rlp = impl.rlp || (impl.encodeRlp || impl.decodeRlp ? { encode: impl.encodeRlp, decode: impl.decodeRlp } : null);
  const trie = impl.trie || (impl.trieRoot ? { root: impl.trieRoot } : null);
  const vm = impl.vm || (impl.runVm ? { run: impl.runVm, makeState: impl.makeState } : null);
  const state =
    impl.state || (impl.runTransaction ? { runTransaction: impl.runTransaction, makeState: impl.makeState } : null);
  return { rlp, trie, vm, state };
}

// ---------------------------------------------------------------------------
// per-shape vector execution
// ---------------------------------------------------------------------------

function runRlpVector(v, impl) {
  const c = makeCheck();
  const ctx = { vector: v };

  if (v.valid && v.value !== null) {
    if (impl.encode) {
      let enc, err = null;
      try { enc = impl.encode(v.value, ctx); } catch (e) { err = e; }
      if (err) c.ok('encode threw: ' + err.message, false, { expected: v.out });
      else c.eq('encode(in) === out', v.out, enc);
    } else c.skipCheck('encode', 'impl.rlp.encode not supplied');

    if (impl.decode) {
      let dec, err = null;
      try { dec = impl.decode(v.outBytes, ctx); } catch (e) { err = e; }
      if (err) c.ok('decode threw on a VALID encoding: ' + err.message, false, { expected: v.out });
      else c.eq('decode(out) round-trips to in', v.value, dec);
    } else c.skipCheck('decode', 'impl.rlp.decode not supplied');
  } else if (!v.valid) {
    /* The whole point of invalidRLPTest.json: a decoder that accepts malformed
     * input will accept a malformed transaction off the wire. */
    if (impl.decode) {
      let threw = false;
      let got;
      try { got = impl.decode(v.outBytes, ctx); } catch { threw = true; }
      c.ok('decode rejects malformed input', threw, {
        expected: 'a thrown error',
        actual: threw ? 'threw' : 'accepted, returning ' + JSON.stringify(String(got)).slice(0, 80),
        note: 'input ' + v.out,
      });
    } else c.skipCheck('decode-invalid', 'impl.rlp.decode not supplied');
  } else {
    // "VALID" marker: decoding must simply succeed.
    if (impl.decode) {
      let err = null;
      try { impl.decode(v.outBytes, ctx); } catch (e) { err = e; }
      c.ok('decode accepts a VALID encoding', !err, { actual: err && err.message });
    } else c.skipCheck('decode-valid', 'impl.rlp.decode not supplied');
  }

  return c.finish();
}

function runTrieVector(v, impl) {
  const c = makeCheck();
  let root, err = null;
  try {
    root = impl.root(v.pairs.map(([k, val]) => [Buffer.from(k), val === null ? null : Buffer.from(val)]), {
      secure: v.secure,
      ordered: v.ordered,
      vector: v,
    });
  } catch (e) { err = e; }
  if (err) c.ok('trie root threw: ' + err.message, false, { expected: v.root });
  else {
    c.eq((v.secure ? 'secure ' : '') + 'trie root', v.root, root, {
      note: v.ordered
        ? v.pairs.length + ' ordered operations (' + v.pairs.filter((p) => p[1] === null).length + ' deletes)'
        : v.pairs.length + ' insertions, order must not matter',
    });
  }
  return c.finish();
}

function runVmVector(v, impl, opts) {
  const c = makeCheck();
  const pre = cloneAccounts(v.pre);
  const state = impl.makeState ? impl.makeState(pre) : null;
  const res = impl.run({ state, env: v.env, exec: v.exec, pre, vector: v });
  const exception = reportedException(res);

  if (v.expectException) {
    /* No post/gas/out section at all: the fixture asserts the execution must
     * fail. Everything it touched is rolled back and all gas is consumed. */
    c.ok('execution must fail (fixture has no post section)', !!exception, {
      expected: 'an EVM exception',
      actual: exception || 'succeeded with gasLeft ' + (res && res.gasLeft),
    });
    return c.finish();
  }

  if (!c.ok('execution must succeed', !exception, { expected: 'success', actual: 'exception: ' + exception })) {
    return c.finish();
  }

  if (opts.checkGas) {
    if (res.gasLeft === undefined || res.gasLeft === null) c.skipCheck('gas', 'implementation returned no gasLeft');
    else c.eq('gas remaining', v.gasRemaining, res.gasLeft);
  } else c.skipCheck('gas', 'disabled with --no-gas');

  if (res.returnData === undefined || res.returnData === null) {
    if (v.out === '0x') c.eq('return data', v.out, '0x');
    else c.skipCheck('return data', 'implementation returned no returnData');
  } else c.eq('return data', v.out, res.returnData);

  if (v.logsHash !== null) {
    if (res.logsHash) c.eq('logs hash', v.logsHash, res.logsHash);
    else c.skipCheck('logs hash', 'implementation returned no logsHash (keccak256(rlp(logs)))');
  }

  /* VMTests carry a full expected post state, so this diff is exact — it is the
   * best debugging signal in the whole corpus. Use these before the state tests. */
  const dump = state && typeof state.dump === 'function' ? state.dump() : null;
  if (dump) {
    const diff = diffAccounts(v.post, dump);
    c.ok('post state matches', diff.clean, {
      diff,
      diffLabel: 'account divergence',
      expectedLabel: 'expected',
      actualLabel: 'ours',
    });
  } else c.skipCheck('post state', 'implementation state has no dump()');

  return c.finish();
}

function runStateVector(v, impl, opts) {
  const c = makeCheck();
  const pre = cloneAccounts(v.pre);
  const state = impl.makeState ? impl.makeState(pre) : null;
  const res = impl.runTransaction({ state, env: v.env, tx: v.tx, fork: v.fork, pre, vector: v }) || {};
  const exception = reportedException(res);

  if (v.expectException) {
    c.ok('transaction must be rejected (' + v.expectException + ')', !!exception, {
      expected: v.expectException,
      actual: exception || 'accepted',
    });
    /* Even a rejected transaction has an expected post root: the sender pays
     * nothing and the block is otherwise untouched, so the root is still
     * asserted below. */
  } else {
    if (!c.ok('transaction must be accepted', !exception, { expected: 'accepted', actual: 'rejected: ' + exception })) {
      return c.finish();
    }
  }

  const root = state && typeof state.root === 'function' ? state.root() : res.stateRoot;
  if (root === undefined || root === null) {
    c.skipCheck('state root', 'implementation exposed neither state.root() nor result.stateRoot');
  } else if (!sameValue(v.expectRoot, root)) {
    /* A root mismatch with no further detail is nearly useless. GeneralStateTests
     * publish only the root, never the expected accounts, so the most useful
     * thing available is a diff of pre-state against what we produced: it names
     * every account our execution touched and by how much. Supply
     * opts.expectedPostFor(vector) — e.g. a dump from a reference client — and
     * the diff becomes exact instead. */
    const dump = state && typeof state.dump === 'function' ? state.dump() : null;
    const expectedPost = opts.expectedPostFor ? opts.expectedPostFor(v) : null;
    const extra = { expected: v.expectRoot, actual: root };
    if (dump && expectedPost) {
      extra.diff = diffAccounts(expectedPost, dump);
      extra.diffLabel = 'account divergence from the reference post-state';
      extra.expectedLabel = 'expected';
      extra.actualLabel = 'ours';
    } else if (dump) {
      extra.diff = diffAccounts(v.pre, dump);
      extra.diffLabel = 'accounts our execution changed (the fixture publishes only a root, so this is pre vs ours — not a reference diff)';
      extra.expectedLabel = 'pre';
      extra.actualLabel = 'ours';
      extra.cleanNote = 'our execution changed NO accounts at all — the transaction very likely never ran';
    }
    if (v.txbytes) extra.note = 'signed tx ' + v.txbytes.slice(0, 42) + '… — decode it and confirm we ran the tx the fixture meant';
    c.ok('state root', false, extra);
  } else {
    c.ok('state root', true);
  }

  if (v.expectLogsHash !== null) {
    if (res.logsHash) c.eq('logs hash', v.expectLogsHash, res.logsHash);
    else c.skipCheck('logs hash', 'implementation returned no logsHash (keccak256(rlp(logs)))');
  }

  return c.finish();
}

const EXECUTORS = {
  RLPTests: { part: 'rlp', run: runRlpVector },
  TrieTests: { part: 'trie', run: runTrieVector },
  VMTests: { part: 'vm', run: runVmVector },
  GeneralStateTests: { part: 'state', run: runStateVector },
};

// ---------------------------------------------------------------------------
// runSuite
// ---------------------------------------------------------------------------

/**
 * Run one suite against an implementation.
 *
 * @param {object} o
 * @param {string} o.suite      'RLPTests' | 'TrieTests' | 'VMTests' | 'GeneralStateTests'
 * @param {object} o.impl       see the contract at the top of this file
 * @param {string|string[]} [o.dirs]   fixture roots (default: fixtures/, plus vectors/ if present)
 * @param {object[]} [o.vectors]       pre-loaded vectors, instead of dirs
 * @param {RegExp|string|function} [o.filter]  select vectors by name
 * @param {string[]} [o.forks]  target forks for GeneralStateTests (default ['Shanghai'])
 * @param {boolean} [o.checkGas]       compare VMTests gas (default true)
 * @param {function} [o.onResult]      called with every result object
 * @param {object} [o.reporter]        a reporter from report.js; one is created if absent
 * @param {function} [o.expectedPostFor]  vector -> expected account map, for exact state diffs
 * @returns {{summary, results}}
 */
function runSuite(o) {
  const suite = o.suite;
  const exec = EXECUTORS[suite];
  if (!exec) throw new Error('unknown suite ' + suite + '; expected one of ' + L.SUITES.join(', '));

  const impl = normaliseImpl(o.impl)[exec.part];
  const reporter = o.reporter || createReporter({ verbose: o.verbose });
  const ownsReporter = !o.reporter;
  const forks = o.forks || L.TARGET_FORKS;
  const opts = { checkGas: o.checkGas !== false, expectedPostFor: o.expectedPostFor || null };
  const results = [];

  let vectors = o.vectors;
  let loadSkipped = [];
  let loadErrors = [];
  if (!vectors) {
    vectors = [];
    for (const dir of resolveDirs(o.dirs)) {
      const t = L.loadTree(dir, { suite, forks });
      vectors.push(...t.vectors);
      loadSkipped.push(...t.skipped);
      loadErrors.push(...t.errors);
    }
  }

  const keep = L.makeFilter(o.filter);
  const selected = vectors.filter(keep);

  reporter.group(suite + '  (' + selected.length + ' vectors)');

  for (const e of loadErrors) {
    const r = { suite, name: path.basename(e.file), status: STATUS.ERROR, failures: [{ what: 'fixture failed to load: ' + e.error }] };
    results.push(r); reporter.result(r);
  }

  /* Fork skips are recorded, never silent — a suite that quietly runs nothing
   * is indistinguishable from a suite that passes. */
  for (const s of loadSkipped) {
    if (!keep({ name: s.relFile + '::' + s.case })) continue;
    const r = {
      suite,
      name: s.relFile + '::' + s.case + (s.fork ? '::' + s.fork : ''),
      status: STATUS.SKIP,
      fork: s.fork,
      reason: s.reason,
      entries: s.count || 1,
    };
    results.push(r); reporter.result(r);
  }

  if (!impl) {
    const r = { suite, name: suite, status: STATUS.SKIP, reason: 'no implementation supplied for this suite' };
    results.push(r); reporter.result(r);
    const summary = ownsReporter ? reporter.finish() : null;
    return { summary, results };
  }

  for (const v of selected) {
    const started = Date.now();
    let outcome;
    try {
      outcome = exec.run(v, impl, opts);
    } catch (e) {
      const r = {
        suite,
        name: v.name,
        fork: v.fork || null,
        status: STATUS.ERROR,
        error: e,
        failures: [],
        checks: { total: 1, passed: 0 },
        rerun: rerunHint(suite, v),
        durationMs: Date.now() - started,
      };
      results.push(r); reporter.result(r); if (o.onResult) o.onResult(r);
      continue;
    }
    const r = {
      suite,
      name: v.name,
      fork: v.fork || null,
      status: outcome.failures.length ? STATUS.FAIL : STATUS.PASS,
      failures: outcome.failures,
      unchecked: outcome.unchecked,
      checks: outcome.checks,
      rerun: outcome.failures.length ? rerunHint(suite, v) : null,
      durationMs: Date.now() - started,
      vector: v,
    };
    results.push(r); reporter.result(r); if (o.onResult) o.onResult(r);
  }

  const summary = ownsReporter ? reporter.finish() : null;
  return { summary, results };
}

function rerunHint(suite, v) {
  return "node test/conformance/runner.js --suite=" + suite + " --filter='" + escapeRe(v.name) + "' --verbose";
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* The default is the committed subset ONLY. The full corpus is a superset of it,
 * so running both would execute every vendored vector twice — and the full
 * corpus is a deliberate, slower, explicit choice: --dir=test/conformance/vectors. */
function resolveDirs(dirs) {
  if (dirs) return (Array.isArray(dirs) ? dirs : [dirs]).map((d) => path.resolve(d));
  return [FIXTURES_DIR];
}

/**
 * Run every suite the implementation covers, through one shared reporter.
 * @returns {{summary, results, ok:boolean}}
 */
function runAll(o = {}) {
  const reporter = o.reporter || createReporter({ verbose: o.verbose, maxFailures: o.maxFailures });
  const suites = o.suites || L.SUITES;
  const results = [];
  for (const suite of suites) {
    const r = runSuite({ ...o, suite, reporter });
    results.push(...r.results);
  }
  const summary = reporter.finish();
  return { summary, results, ok: summary.failed === 0 && summary.errored === 0 };
}

// ===========================================================================
// SELF-TEST
//
// A harness that cannot fail is worse than none. This proves, against the real
// vendored fixtures, that the loader reads each shape correctly and that the
// runner reports BOTH passes and failures faithfully.
//
// The fake implementations below are ORACLES: they read the answer out of the
// vector they are handed, then deliberately corrupt a chosen subset. That is a
// legitimate way to test a harness (nothing here implements RLP, a trie or the
// EVM — that is other agents' work and is deliberately out of scope), and it
// exercises every reporting path including the account diff.
// ===========================================================================

function selfTest() {
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
  const group = (n) => console.log('• ' + n);
  const quiet = () => {};

  // ---- loader: RLP -------------------------------------------------------
  group('loader / RLPTests');
  const rlpValid = L.loadFile(path.join(FIXTURES_DIR, 'RLPTests/rlptest.json'), { root: FIXTURES_DIR });
  const rlpInvalid = L.loadFile(path.join(FIXTURES_DIR, 'RLPTests/invalidRLPTest.json'), { root: FIXTURES_DIR });
  ok(rlpValid.vectors.length > 20, 'rlptest.json yields vectors');
  ok(rlpValid.vectors.every((v) => v.valid), 'every rlptest.json vector is valid');
  ok(rlpInvalid.vectors.length > 20 && rlpInvalid.vectors.every((v) => !v.valid), 'every invalidRLPTest.json vector is marked INVALID');
  ok(rlpInvalid.vectors.every((v) => v.value === null), 'INVALID vectors carry no input value, only the bad encoding');
  {
    const byCase = Object.fromEntries(rlpValid.vectors.map((v) => [v.case, v]));
    ok(byCase.emptystring && byCase.emptystring.value.length === 0 && byCase.emptystring.out === '0x80', 'empty string decoded as zero bytes');
    ok(byCase.shortstring && byCase.shortstring.value.equals(Buffer.from('dog', 'utf8')), 'a bare string is UTF-8 bytes');
    ok(byCase.smallint3 && byCase.smallint3.value.equals(Buffer.from([0x4f])), 'a JSON number becomes minimal big-endian bytes');
    ok(byCase.zero && byCase.zero.value.length === 0, 'zero is the empty byte string, not 0x00');
    ok(byCase.bigint && byCase.bigint.value.length === 33 && byCase.bigint.value[0] === 0x01, 'a "#" bignum becomes minimal big-endian bytes');
    ok(byCase.multilist && Array.isArray(byCase.multilist.value) && byCase.multilist.value.length === 3 &&
       Array.isArray(byCase.multilist.value[1]), 'nested lists survive as nested arrays');
    ok(byCase.emptylist && Array.isArray(byCase.emptylist.value) && byCase.emptylist.value.length === 0, 'the empty list is an empty array, not empty bytes');
  }
  ok(L.parseRlpInput('0xdeadbeef').equals(Buffer.from('deadbeef', 'hex')), 'a 0x-prefixed string is hex, not text');

  // ---- loader: Trie ------------------------------------------------------
  group('loader / TrieTests');
  const trieAll = L.loadTree(path.join(FIXTURES_DIR, 'TrieTests'), { suite: 'TrieTests' });
  ok(trieAll.vectors.length >= 20, 'TrieTests fixtures load (' + trieAll.vectors.length + ' vectors)');
  ok(trieAll.vectors.some((v) => v.secure) && trieAll.vectors.some((v) => !v.secure), 'both the plain and secure variants are present and distinguished');
  ok(trieAll.vectors.some((v) => v.ordered) && trieAll.vectors.some((v) => !v.ordered), 'both the ordered and any-order forms are present and distinguished');
  {
    const empties = trieAll.vectors.filter((v) => v.case === 'emptyValues');
    ok(empties.length >= 1 && empties.every((v) => v.pairs.some((p) => p[1] === null)), 'a null value is preserved as a DELETE, not dropped');
    const hexEnc = trieAll.vectors.find((v) => v.relFile.includes('hex_encoded'));
    ok(hexEnc && hexEnc.secure, 'hex_encoded_securetrie_test.json is recognised as the secure variant');
    ok(hexEnc && hexEnc.pairs[0][0].length === 20, 'hex-encoded trie keys are decoded from hex, not taken as text');
    /* trietestnextprev.json sits in TrieTests but publishes no root. Parsed
     * naively it becomes a vector asserting `root === '0x'`, which passes
     * forever and tests nothing — the exact silent-skip failure mode. */
    ok(!trieAll.vectors.some((v) => v.relFile.includes('nextprev')), 'a trie fixture with no root produces no vector');
    ok(trieAll.skipped.some((s) => s.relFile.includes('nextprev') && /traversal/.test(s.reason)),
      '…and is recorded as a skip with a reason, rather than silently asserting nothing');
  }

  // ---- loader: VMTests ---------------------------------------------------
  group('loader / VMTests');
  const vmAll = L.loadTree(path.join(FIXTURES_DIR, 'VMTests'), { suite: 'VMTests' });
  ok(vmAll.vectors.length >= 10, 'VMTests fixtures load (' + vmAll.vectors.length + ' vectors)');
  ok(vmAll.vectors.some((v) => v.expectException), 'exception vectors (no post section) are present and flagged');
  ok(vmAll.vectors.some((v) => !v.expectException), 'succeeding vectors are present');
  {
    const add0 = vmAll.vectors.find((v) => v.case === 'add0');
    ok(add0 && add0.exec.gas === 0x0186a0n, 'exec.gas parsed as a BigInt quantity');
    ok(add0 && add0.gasRemaining === 0x013874n && add0.gasRemaining < add0.exec.gas, 'the VMTests `gas` field is gas REMAINING, not gas used');
    ok(add0 && Object.values(add0.post)[0].storage[L.normWord('0x00')] !== undefined, 'storage keys are normalised to 32-byte words');
    ok(add0 && add0.logsHash && add0.logsHash.length === 66, 'the VMTests `logs` field is a 32-byte hash, not a log list');
    const exc = vmAll.vectors.find((v) => v.expectException);
    ok(exc.post === null && exc.gasRemaining === null && exc.out === null, 'an exception vector has no expected post, gas or output');
  }

  // ---- loader: GeneralStateTests, and THE INDEXING ------------------------
  group('loader / GeneralStateTests');
  const gstAll = L.loadTree(path.join(FIXTURES_DIR, 'GeneralStateTests'), { suite: 'GeneralStateTests' });
  ok(gstAll.vectors.length >= 15, 'GeneralStateTests fixtures load (' + gstAll.vectors.length + ' vectors)');
  ok(gstAll.vectors.every((v) => v.fork === 'Shanghai'), 'only Shanghai vectors are produced');
  ok(gstAll.skipped.length > 10, 'non-Shanghai forks are skipped WITH A COUNT (' + gstAll.skipped.length + ' records), not silently dropped');
  ok(gstAll.skipped.some((s) => s.fork === 'Cancun') && gstAll.skipped.some((s) => s.fork === 'Berlin'), 'the skip records name the fork');

  {
    // The critical one. transactionCosts has 12 data indexes and its post
    // entries are NOT in index order (… 6, 10, 7, 8, 9, 11), so a runner that
    // walks the array positionally silently executes the wrong case.
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'GeneralStateTests/stEIP2930/transactionCosts.json'), 'utf8')).transactionCosts;
    const tc = gstAll.vectors.filter((v) => v.case === 'transactionCosts');
    ok(tc.length === raw.transaction.data.length, 'one vector per post entry (' + tc.length + ')');
    const postOrder = raw.post.Shanghai.map((e) => e.indexes.data);
    ok(postOrder.join(',') !== postOrder.slice().sort((a, b) => a - b).join(','), 'the fixture really does list its post entries out of index order');
    let indexedRight = 0;
    for (const e of raw.post.Shanghai) {
      const want = 'd' + e.indexes.data + 'g' + e.indexes.gas + 'v' + e.indexes.value;
      const v = tc.find((x) => x.name.endsWith(want));
      if (!v) continue;
      const dataMatches = v.tx.data.equals(L.hexToBuf(raw.transaction.data[e.indexes.data]));
      const gasMatches = v.tx.gasLimit === L.toBigInt(raw.transaction.gasLimit[e.indexes.gas]);
      const valueMatches = v.tx.value === L.toBigInt(raw.transaction.value[e.indexes.value]);
      const rootMatches = v.expectRoot === L.bufToHex(L.hexToBuf(e.hash));
      const alRaw = raw.transaction.accessLists[e.indexes.data];
      const alMatches = alRaw === null ? v.tx.accessList === null : v.tx.accessList.length === alRaw.length;
      if (dataMatches && gasMatches && valueMatches && rootMatches && alMatches) indexedRight++;
    }
    ok(indexedRight === raw.post.Shanghai.length,
      'every post entry maps to the data/gasLimit/value/accessList it names (' + indexedRight + '/' + raw.post.Shanghai.length + ')');
    ok(tc.some((v) => v.tx.accessList === null) && tc.some((v) => v.tx.accessList && v.tx.accessList.length),
      'accessLists is indexed by the DATA index, and a null entry means a legacy transaction');
    ok(tc.find((v) => v.tx.accessList === null).tx.type === 0 && tc.find((v) => v.tx.accessList && v.tx.accessList.length).tx.type === 1,
      'transaction type is inferred from the selected access list');
  }
  {
    const gasDim = gstAll.vectors.filter((v) => v.case === 'Create1000Shnghai');
    ok(gasDim.length === 2 && gasDim[0].tx.gasLimit !== gasDim[1].tx.gasLimit,
      'the gasLimit array is indexed by `indexes.gas` — note the key is `gas`, not `gasLimit`');
    const valDim = gstAll.vectors.filter((v) => v.case === 'jumpNonConst');
    ok(valDim.length === 2 && valDim[0].tx.value !== valDim[1].tx.value, 'the value array is indexed by `indexes.value`');
  }
  {
    const skippedCases = new Set(gstAll.skipped.map((s) => s.case));
    ok(skippedCases.has('HighGasPrice'), 'a fixture with no Shanghai post at all is recorded as skipped');
    ok(!gstAll.vectors.some((v) => v.case === 'HighGasPrice'), '…and produces no runnable vector');
    const invalidTr = gstAll.vectors.find((v) => v.case === 'invalidTr');
    ok(invalidTr && invalidTr.expectException === 'TR_IntrinsicGas', 'expectException is carried through for transactions that must be rejected');
    ok(gstAll.vectors.every((v) => v.txbytes === null || v.txbytes.startsWith('0x')), 'txbytes is carried through for debugging');
    const create = gstAll.vectors.find((v) => v.tx.to === null);
    ok(create === undefined || create.tx.to === null, 'an empty `to` becomes null (contract creation)');
    /* retesteth escapes an over-256-bit quantity as `0x:bigint 0x…`. Reading
     * that as plain hex throws and loses a vector whose whole point is that the
     * transaction must be rejected for overflowing. */
    const overflow = gstAll.vectors.find((v) => v.case === 'ValueOverflowParis');
    ok(overflow && overflow.tx.value === (1n << 256n) + 1n, "the `0x:bigint 0x…` escape for over-256-bit quantities is decoded");
    ok(overflow && overflow.expectException === 'TR_RLP_WRONGVALUE', '…and the overflowing transaction is still expected to be rejected');
  }

  // ---- runner: a perfect oracle passes -----------------------------------
  group('runner / a correct implementation passes');
  const perfect = buildOracle(new Set());
  const clean = runAll({ impl: perfect, reporter: createReporter({ write: quiet }) });
  ok(clean.summary.failed === 0 && clean.summary.errored === 0, 'a correct implementation produces zero failures');
  ok(clean.summary.passed >= 90, 'and a healthy number of passing vectors (' + clean.summary.passed + ')');
  ok(clean.summary.checks.total > clean.summary.passed, 'more checks than vectors — each vector asserts several things');
  ok(clean.summary.checks.passed === clean.summary.checks.total, 'every check passed');
  ok(clean.summary.skipped > 0 && Object.keys(clean.summary.skippedForks).length > 0, 'skipped forks are reported in the summary, with counts');
  ok(clean.ok === true, 'runAll reports ok');

  // ---- runner: a broken oracle fails, exactly where it should -------------
  group('runner / a broken implementation fails');
  const sabotage = new Set([
    'RLPTests/rlptest.json::shortstring',        // wrong encoding
    'RLPTests/invalidRLPTest.json::wrongSizeList', // decoder wrongly accepts malformed input
    'TrieTests/trietest.json::jeff',             // wrong root
    'VMTests/vmArithmeticTest/add0.json::add0',  // wrong post state (balance + storage)
  ]);
  const brokenLines = [];
  const broken = runAll({ impl: buildOracle(sabotage), reporter: createReporter({ write: (s) => brokenLines.push(s) }) });
  const failedNames = new Set(broken.summary.failures.map((f) => f.name));
  ok(broken.summary.failed === sabotage.size, 'exactly the sabotaged vectors fail (' + broken.summary.failed + ' of ' + sabotage.size + ')');
  ok([...sabotage].every((n) => failedNames.has(n)), 'and they are the right ones');
  ok(broken.ok === false, 'runAll reports not-ok');
  ok(broken.summary.checks.passed < broken.summary.checks.total, 'the failing checks are subtracted from the check count');
  {
    const enc = broken.summary.failures.find((f) => f.name.endsWith('::shortstring'));
    ok(enc && enc.reasons[0].expected === '0x83646f67' && enc.reasons[0].actual !== enc.reasons[0].expected,
      'an encoding failure reports expected vs actual');
    const inv = broken.summary.failures.find((f) => f.name.endsWith('::wrongSizeList'));
    ok(inv && /rejects malformed/.test(inv.reasons[0].what), 'a decoder that accepts malformed RLP is caught');
    const trie = broken.summary.failures.find((f) => f.name.endsWith('::jeff'));
    ok(trie && trie.reasons[0].expected !== trie.reasons[0].actual, 'a wrong trie root reports both roots');
  }
  {
    // The account diff — the reason this harness exists.
    const vm = broken.summary.failures.find((f) => f.name.endsWith('::add0'));
    const withDiff = vm && vm.reasons.find((r) => r.diff);
    ok(!!withDiff, 'a post-state mismatch carries an account diff, not just "mismatch"');
    const d = withDiff && withDiff.diff;
    ok(d && d.changed.length === 1, 'the diff names exactly the one divergent account');
    ok(d && d.changed[0].address === '0x0f572e5295c57f15886f9b263e2f6d2d6c7b5ec6', 'and names it by address');
    ok(d && d.changed[0].fields.balance, 'the divergent balance is called out');
    ok(d && Object.keys(d.changed[0].storage).length === 1, 'and so is the divergent storage slot');
    ok(d && Object.values(d.changed[0].storage)[0].expected !== Object.values(d.changed[0].storage)[0].actual,
      'with expected and actual slot values');
    const printed = brokenLines.join('\n');
    ok(/0x0f572e5295c57f15886f9b263e2f6d2d6c7b5ec6/.test(printed), 'the diff is printed, not merely returned');
    ok(/storage 0x0{64}/.test(printed), 'the printed diff names the storage slot');
    ok(/rerun:/.test(printed), 'every failure prints a command that reruns it alone');
  }

  // ---- runner: distinguishes a crash from an EVM exception ---------------
  group('runner / a crashing implementation is an ERROR, not a pass');
  {
    const crashing = {
      vm: {
        makeState: () => ({ root: () => '0x00', dump: () => ({}) }),
        run() { throw new TypeError('cannot read property of undefined'); },
      },
    };
    const r = runSuite({ suite: 'VMTests', impl: crashing, reporter: createReporter({ write: quiet }) });
    const errs = r.results.filter((x) => x.status === STATUS.ERROR);
    ok(errs.length > 0, 'a thrown JavaScript error is reported');
    ok(errs.length === r.results.filter((x) => x.status !== STATUS.SKIP).length, 'and every vector is an ERROR');
    ok(r.results.every((x) => x.status !== STATUS.PASS), 'crucially, an exception-expecting vector does NOT pass because of a crash');
  }

  // ---- runner: filtering, verbosity, machine-readable output -------------
  group('runner / filtering and reporting');
  {
    const one = runSuite({
      suite: 'TrieTests', impl: buildOracle(new Set()),
      filter: 'trietest.json::jeff', reporter: createReporter({ write: quiet }),
    });
    const ran = one.results.filter((x) => x.status !== STATUS.SKIP);
    ok(ran.length === 1 && ran[0].name.endsWith('::jeff'), 'a name filter selects exactly one vector');
    const re = runSuite({
      suite: 'RLPTests', impl: buildOracle(new Set()),
      filter: /::(short|long)string/, reporter: createReporter({ write: quiet }),
    });
    ok(re.results.length >= 3 && re.results.every((x) => /(short|long)string/.test(x.name)), 'a regex filter works too');
    const none = runSuite({ suite: 'RLPTests', impl: buildOracle(new Set()), filter: 'no-such-vector', reporter: createReporter({ write: quiet }) });
    ok(none.results.length === 0, 'a filter matching nothing runs nothing (the CLI exits non-zero for this)');
    /* The full corpus is a superset of the committed subset, so defaulting to
     * both would run every vendored vector twice and report inflated counts. */
    ok(resolveDirs(undefined).length === 1 && resolveDirs(undefined)[0] === FIXTURES_DIR,
      'the default fixture root is the committed subset alone, even once vectors/ has been fetched');
  }
  {
    const lines = [];
    runSuite({ suite: 'TrieTests', impl: buildOracle(new Set()), reporter: createReporter({ write: (s) => lines.push(s), verbose: true }) });
    ok(lines.some((l) => l.startsWith('  ✓ ')), '--verbose prints passing vectors');
    const quietLines = [];
    runSuite({ suite: 'TrieTests', impl: buildOracle(new Set()), reporter: createReporter({ write: (s) => quietLines.push(s) }) });
    ok(!quietLines.some((l) => l.startsWith('  ✓ ')), 'and without it they are silent');
  }
  {
    const s = clean.summary;
    const json = JSON.parse(JSON.stringify(s));
    ok(typeof json.total === 'number' && typeof json.checks.total === 'number' && Array.isArray(json.failures),
      'the summary is JSON-serialisable and machine-readable');
    ok(Array.isArray(json.groups) && json.groups.length === L.SUITES.length, 'with a per-suite breakdown');
  }

  // ---- report: the diff itself -------------------------------------------
  group('report / diffAccounts');
  {
    const A = { '0x01': { nonce: 1, balance: 100, code: '0x', storage: { '0x00': '0x01' } } };
    ok(diffAccounts(A, A).clean, 'identical states diff clean');
    ok(diffAccounts(A, {}).missing.length === 1, 'a dropped account is reported as missing');
    ok(diffAccounts({}, A).unexpected.length === 1, 'an invented account is reported as unexpected');
    const B = { '0x01': { nonce: 1, balance: 99, code: '0x', storage: { '0x00': '0x01' } } };
    ok(diffAccounts(A, B).changed[0].fields.balance.delta === -1n, 'a balance divergence reports the delta');
    const C = { '0x01': { nonce: 1, balance: 100, code: '0x', storage: { '0x00': '0x01', '0x05': '0x00' } } };
    ok(diffAccounts(A, C).clean, 'a slot explicitly set to zero is not a divergence — zero and absent are the same');
    const D = { '0x0000000000000000000000000000000000000001': { nonce: '0x01', balance: '0x64', code: '0x', storage: { '0x0000000000000000000000000000000000000000000000000000000000000000': '0x01' } } };
    ok(diffAccounts(A, D).clean, 'addresses and words are normalised before comparison');
  }

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + '/' + (pass + fail) + ' harness self-test checks');
  return fail === 0;
}

/**
 * Build an oracle implementation: correct for every vector except those named
 * in `sabotage`, which it gets deliberately and specifically wrong.
 */
function buildOracle(sabotage) {
  const bad = (v) => sabotage.has(v.name);

  const mkState = (pre, post) => ({
    _accounts: post,
    root: () => '0x' + '11'.repeat(32),
    dump: () => post,
  });

  return {
    rlp: {
      encode(value, ctx) {
        if (bad(ctx.vector)) return '0x' + 'ff'.repeat(4);
        return ctx.vector.outBytes;
      },
      decode(bytes, ctx) {
        if (!ctx.vector.valid) {
          // A correct decoder throws here; the sabotaged one wrongly accepts.
          if (bad(ctx.vector)) return Buffer.alloc(0);
          throw new Error('malformed RLP');
        }
        return ctx.vector.value;
      },
    },
    trie: {
      root(pairs, ctx) {
        if (bad(ctx.vector)) return '0x' + '00'.repeat(32);
        return ctx.vector.root;
      },
    },
    vm: {
      makeState: (pre) => mkState(pre, pre),
      run({ state, vector }) {
        if (vector.expectException) return { exception: 'out of gas' };
        let post = vector.post;
        if (bad(vector)) {
          const addr = Object.keys(post)[0];
          const a = post[addr];
          const slot = Object.keys(a.storage)[0];
          post = { ...post, [addr]: { ...a, balance: a.balance - 1n, storage: { ...a.storage, [slot]: L.normWord('0xdead') } } };
        }
        state._accounts = post;
        state.dump = () => post;
        return {
          gasLeft: vector.gasRemaining,
          returnData: vector.out,
          logsHash: vector.logsHash,
        };
      },
    },
    state: {
      makeState: (pre) => mkState(pre, pre),
      runTransaction({ state, vector }) {
        state.root = () => (bad(vector) ? '0x' + '00'.repeat(32) : vector.expectRoot);
        return {
          exception: vector.expectException ? 'rejected: ' + vector.expectException : undefined,
          logsHash: vector.expectLogsHash,
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `hearth conformance harness

  node test/conformance/runner.js [options]

  --impl=<path>        module exporting the implementation (see the contract in runner.js)
  --dir=<path>         fixture root; repeatable. default: fixtures/ (+ vectors/ if fetched)
  --suite=<name>       RLPTests | TrieTests | VMTests | GeneralStateTests; repeatable
  --filter=<pattern>   run only vectors whose name matches this regex or substring
  --fork=<name>        target fork for GeneralStateTests; repeatable. default: Shanghai
  --no-gas             skip the VMTests gas comparison (they are Constantinople-priced)
  --max-failures=<n>   stop printing failure detail after n (default 50)
  --json[=<path>]      write a machine-readable summary; omit the path for stdout
  --list               list the vectors that would run, then exit
  --verbose, -v        print passing and skipped vectors too
  --allow-empty        exit 0 when no vectors matched (default: exit 1)
  --selftest           run the harness's own self-test
  --help, -h

Exits non-zero on any failure, on a load error, and on an empty run.
`;

function parseArgv(argv) {
  const o = { dirs: [], suites: [], forks: [], filter: null, verbose: false, json: null, checkGas: true, list: false, selftest: false, allowEmpty: false, impl: null, maxFailures: 50 };
  for (const a of argv) {
    const [k, ...rest] = a.split('=');
    const v = rest.join('=');
    switch (k) {
      case '--impl': o.impl = v; break;
      case '--dir': o.dirs.push(v); break;
      case '--suite': o.suites.push(v); break;
      case '--filter': o.filter = v; break;
      case '--fork': o.forks.push(v); break;
      case '--no-gas': o.checkGas = false; break;
      case '--max-failures': o.maxFailures = Number(v); break;
      case '--json': o.json = v || '-'; break;
      case '--list': o.list = true; break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--allow-empty': o.allowEmpty = true; break;
      case '--selftest': o.selftest = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('unknown option ' + a + '\n\n' + USAGE);
    }
  }
  return o;
}

function main(argv) {
  let o;
  try { o = parseArgv(argv); } catch (e) { console.error(e.message); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  if (o.selftest) return selfTest() ? 0 : 1;

  const suites = o.suites.length ? o.suites : L.SUITES;
  const forks = o.forks.length ? o.forks : L.TARGET_FORKS;
  const dirs = o.dirs.length ? o.dirs : undefined;

  if (!dirs && fs.existsSync(VECTORS_DIR)) {
    console.error('note: running the committed fixtures/ subset only. The full corpus is fetched —');
    console.error('      add --dir=test/conformance/vectors for the real conformance gate.\n');
  }

  if (o.list) {
    let n = 0;
    for (const suite of suites) {
      for (const dir of resolveDirs(dirs)) {
        const t = L.loadTree(dir, { suite, forks });
        for (const v of t.vectors.filter(L.makeFilter(o.filter))) { console.log(v.name); n++; }
      }
    }
    console.error(n + ' vectors');
    return n > 0 || o.allowEmpty ? 0 : 1;
  }

  let impl = null;
  if (o.impl) {
    const p = path.isAbsolute(o.impl) ? o.impl : path.resolve(process.cwd(), o.impl);
    impl = require(p);
    if (impl && impl.default) impl = impl.default;
  } else {
    console.error('no --impl supplied: loading the fixtures only, which verifies the harness but proves nothing about an EVM.');
    console.error('run `node test/conformance/runner.js --selftest` to exercise the harness itself.\n');
  }

  const reporter = createReporter({ verbose: o.verbose, maxFailures: o.maxFailures });
  const results = [];
  for (const suite of suites) {
    const r = runSuite({ suite, impl, dirs, filter: o.filter, forks, checkGas: o.checkGas, reporter, verbose: o.verbose });
    results.push(...r.results);
  }
  const summary = reporter.finish();

  if (o.json) {
    const text = JSON.stringify(summary, null, 2);
    if (o.json === '-') console.log(text);
    else { fs.writeFileSync(o.json, text); console.error('summary written to ' + o.json); }
  }

  const ran = results.filter((r) => r.status !== STATUS.SKIP).length;
  if (ran === 0 && !o.allowEmpty) {
    console.error('\nno vectors ran. A harness that runs nothing must not look green — pass --allow-empty if that is intended.');
    return 1;
  }
  return summary.failed === 0 && summary.errored === 0 ? 0 : 1;
}

module.exports = {
  runSuite,
  runAll,
  selfTest,
  /* Exported as a worked example of the implementation contract, and so the
   * self-test's oracle can be driven from outside when debugging the harness. */
  buildOracle,
  normaliseImpl,
  diffAccounts,
  createReporter,
  loader: L,
  FIXTURES_DIR,
  VECTORS_DIR,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
