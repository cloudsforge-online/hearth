'use strict';
/* Conformance result reporting.
 *
 * The single most important thing in this file is `diffAccounts`. "state root
 * mismatch" on its own is nearly useless: it tells you that something in a
 * 30,000-opcode execution went wrong and nothing about where. An account-level
 * diff — which address, which field, which storage slot, expected vs actual —
 * is the difference between an afternoon and a week (docs/evm-spec.md §8).
 *
 * Output style matches node/test/unit.js: `• group`, `  ✗ failure`, and a final
 * `PASS — n/n checks`.
 *
 * Zero dependencies. CommonJS.
 */

const { bufToHex, normAccounts } = require('./loader');

const STATUS = { PASS: 'pass', FAIL: 'fail', SKIP: 'skip', ERROR: 'error' };

// ---------------------------------------------------------------------------
// value formatting
// ---------------------------------------------------------------------------

function short(v, max = 66) {
  const s = fmt(v);
  return s.length > max ? s.slice(0, max - 3) + '…(' + s.length + ' chars)' : s;
}

function fmt(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'bigint') return '0x' + v.toString(16) + ' (' + v.toString(10) + ')';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return bufToHex(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

// ---------------------------------------------------------------------------
// the account diff
// ---------------------------------------------------------------------------

/**
 * Structural diff of two account maps.
 *
 * Both sides are pushed through the loader's normalisation first, so an
 * implementation may hand back accounts in whatever hex/number style it likes
 * and zero-valued storage slots never show up as phantom divergence.
 *
 * @param {object} expected account map (address -> {nonce,balance,code,storage})
 * @param {object} actual   account map
 * @returns {{missing:string[], unexpected:string[], changed:object[], clean:boolean}}
 *   missing    — in `expected`, absent from `actual`
 *   unexpected — in `actual`, absent from `expected`
 *   changed    — present in both but differing in some field
 */
function diffAccounts(expected, actual) {
  const e = normAccounts(expected || {});
  const a = normAccounts(actual || {});
  const addrs = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();

  const missing = [];
  const unexpected = [];
  const changed = [];

  for (const addr of addrs) {
    const ea = e[addr];
    const aa = a[addr];
    if (ea && !aa) { missing.push(addr); continue; }
    if (!ea && aa) { unexpected.push(addr); continue; }

    const fields = {};
    if (ea.nonce !== aa.nonce) fields.nonce = { expected: ea.nonce, actual: aa.nonce };
    if (ea.balance !== aa.balance) {
      fields.balance = { expected: ea.balance, actual: aa.balance, delta: aa.balance - ea.balance };
    }
    if (!ea.code.equals(aa.code)) {
      fields.code = { expected: bufToHex(ea.code), actual: bufToHex(aa.code) };
    }

    const storage = {};
    const slots = [...new Set([...Object.keys(ea.storage), ...Object.keys(aa.storage)])].sort();
    for (const s of slots) {
      const ev = ea.storage[s] || null;
      const av = aa.storage[s] || null;
      if (ev !== av) storage[s] = { expected: ev, actual: av };
    }

    if (Object.keys(fields).length || Object.keys(storage).length) {
      changed.push({ address: addr, fields, storage });
    }
  }

  return {
    missing,
    unexpected,
    changed,
    clean: missing.length === 0 && unexpected.length === 0 && changed.length === 0,
  };
}

/** Render a diff from `diffAccounts` as indented human-readable lines. */
function formatAccountDiff(diff, opts = {}) {
  const indent = opts.indent || '      ';
  const expectedLabel = opts.expectedLabel || 'expected';
  const actualLabel = opts.actualLabel || 'actual';
  if (!diff) return indent + '(no account detail available — implementation did not expose state.dump())';
  if (diff.clean) {
    return indent + '(' + (opts.cleanNote || 'accounts identical; the divergence is in trie encoding, not in state') + ')';
  }

  const width = Math.max(expectedLabel.length, actualLabel.length);
  const eL = expectedLabel.padEnd(width);
  const aL = actualLabel.padEnd(width);
  const lines = [];
  for (const addr of diff.missing) lines.push(indent + '- ' + addr + '  present in ' + expectedLabel + ', ABSENT from ' + actualLabel);
  for (const addr of diff.unexpected) lines.push(indent + '+ ' + addr + '  present in ' + actualLabel + ', ABSENT from ' + expectedLabel);
  for (const c of diff.changed) {
    lines.push(indent + '~ ' + c.address);
    for (const [name, v] of Object.entries(c.fields)) {
      let line = indent + '    ' + name.padEnd(8) + ' ' + eL + ' ' + short(v.expected, 40) + '  ' + aL + ' ' + short(v.actual, 40);
      if (v.delta !== undefined) line += '  (delta ' + (v.delta > 0n ? '+' : '') + v.delta.toString() + ')';
      lines.push(line);
    }
    const slots = Object.entries(c.storage);
    for (const [slot, v] of slots.slice(0, opts.maxSlots || 20)) {
      lines.push(indent + '    storage ' + slot);
      lines.push(indent + '      ' + eL + ' ' + (v.expected || '(unset)'));
      lines.push(indent + '      ' + aL + ' ' + (v.actual || '(unset)'));
    }
    if (slots.length > (opts.maxSlots || 20)) {
      lines.push(indent + '    … and ' + (slots.length - (opts.maxSlots || 20)) + ' more storage slots');
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// reporter
// ---------------------------------------------------------------------------

/**
 * Create a reporter.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]  print every vector, not just failures
 * @param {function} [opts.write]   line sink (defaults to console.log)
 * @param {number} [opts.maxFailures] stop printing detail after this many
 * @returns {{group,result,finish,summary}}
 */
function createReporter(opts = {}) {
  const write = opts.write || ((s) => console.log(s));
  const verbose = !!opts.verbose;
  const maxFailures = opts.maxFailures === undefined ? 50 : opts.maxFailures;

  const state = {
    startedAt: Date.now(),
    groups: [],
    results: [],
    counts: { pass: 0, fail: 0, skip: 0, error: 0 },
    checks: { passed: 0, total: 0 },
    unchecked: 0,
    skippedForks: {},
    skippedReasons: {},
    skippedEntries: 0,
    printedFailures: 0,
    currentGroup: null,
  };

  function group(name) {
    state.currentGroup = { name, counts: { pass: 0, fail: 0, skip: 0, error: 0 } };
    state.groups.push(state.currentGroup);
    write('• ' + name);
  }

  function result(r) {
    state.results.push(r);
    state.counts[r.status] = (state.counts[r.status] || 0) + 1;
    if (state.currentGroup) state.currentGroup.counts[r.status] = (state.currentGroup.counts[r.status] || 0) + 1;

    if (r.checks) {
      state.checks.total += r.checks.total || 0;
      state.checks.passed += r.checks.passed || 0;
    }

    if (r.unchecked) state.unchecked += r.unchecked.length;

    if (r.status === STATUS.SKIP) {
      /* `entries` is how many fixture cases the skip record stands for: one
       * skipped fork can hide a dozen post entries, and a count that hid that
       * would be the silent skipping this harness exists to prevent. */
      const entries = r.entries === undefined ? 1 : r.entries;
      state.skippedEntries += entries;
      if (r.fork) state.skippedForks[r.fork] = (state.skippedForks[r.fork] || 0) + entries;
      const why = r.reason || 'unspecified';
      state.skippedReasons[why] = (state.skippedReasons[why] || 0) + entries;
      if (verbose) write('  ~ ' + r.name + '  SKIP: ' + why + (entries > 1 ? ' (' + entries + ' post entries)' : ''));
      return;
    }

    if (r.status === STATUS.PASS) {
      if (verbose) write('  ✓ ' + r.name);
      return;
    }

    // fail / error
    if (state.printedFailures >= maxFailures) return;
    state.printedFailures++;
    write('  ✗ ' + r.name);
    for (const f of r.failures || []) {
      write('      ' + f.what);
      if (f.expected !== undefined) write('        expected  ' + short(f.expected, 90));
      if (f.actual !== undefined) write('        actual    ' + short(f.actual, 90));
      if (f.note) write('        note      ' + f.note);
      if (f.diff) {
        write('        ' + (f.diffLabel || 'account divergence') + ':');
        write(formatAccountDiff(f.diff, {
          indent: '        ',
          expectedLabel: f.expectedLabel,
          actualLabel: f.actualLabel,
          cleanNote: f.cleanNote,
        }));
      }
    }
    if (verbose && r.unchecked && r.unchecked.length) {
      for (const u of r.unchecked) write('      unchecked: ' + u);
    }
    if (r.error) {
      write('      threw: ' + r.error.message);
      if (verbose && r.error.stack) write(String(r.error.stack).split('\n').slice(1, 6).map((l) => '        ' + l.trim()).join('\n'));
    }
    if (r.rerun) write('      rerun: ' + r.rerun);
    if (state.printedFailures === maxFailures) write('  … further failure detail suppressed (--max-failures)');
  }

  function summary() {
    return {
      startedAt: new Date(state.startedAt).toISOString(),
      durationMs: Date.now() - state.startedAt,
      total: state.results.length,
      passed: state.counts.pass,
      failed: state.counts.fail,
      skipped: state.counts.skip,
      skippedEntries: state.skippedEntries,
      errored: state.counts.error,
      checks: { ...state.checks },
      unchecked: state.unchecked,
      skippedForks: { ...state.skippedForks },
      skippedReasons: { ...state.skippedReasons },
      groups: state.groups.map((g) => ({ name: g.name, ...g.counts })),
      failures: state.results
        .filter((r) => r.status === STATUS.FAIL || r.status === STATUS.ERROR)
        .map((r) => ({
          suite: r.suite,
          name: r.name,
          status: r.status,
          fork: r.fork || null,
          rerun: r.rerun || null,
          reasons: (r.failures || []).map((f) => ({
            what: f.what,
            expected: f.expected === undefined ? null : fmt(f.expected),
            actual: f.actual === undefined ? null : fmt(f.actual),
            diff: f.diff ? serialiseDiff(f.diff) : null,
          })),
          error: r.error ? r.error.message : null,
        })),
    };
  }

  function finish() {
    const s = summary();
    write('');
    if (s.skipped) {
      const forks = Object.entries(s.skippedForks).sort((a, b) => b[1] - a[1]);
      write(
        'skipped ' + s.skipped + ' record' + (s.skipped === 1 ? '' : 's') +
        ' (' + s.skippedEntries + ' fixture case' + (s.skippedEntries === 1 ? '' : 's') + ')' +
        (forks.length ? '  by fork: ' + forks.map(([f, n]) => f + ' ' + n).join(', ') : '')
      );
      for (const [r, n] of Object.entries(s.skippedReasons).filter(([r]) => r !== 'fork not targeted')) {
        write('        ' + n + ' × ' + r);
      }
    }
    if (s.unchecked) {
      write(s.unchecked + ' assertions could not be checked (the implementation did not expose what they need) — run with --verbose for detail');
    }
    const bad = s.failed + s.errored;
    /* Zero checks is NOT a pass. A suite that ran nothing looking green is how
     * a broken fixture path goes unnoticed for a month. */
    const verdict = bad > 0 ? 'FAIL' : s.checks.total === 0 ? 'EMPTY' : 'PASS';
    write(
      verdict +
        ' — ' + s.checks.passed + '/' + s.checks.total + ' checks' +
        '  (' + s.passed + ' vectors passed, ' + bad + ' failed, ' + s.skipped + ' skipped, ' + s.durationMs + 'ms)'
    );
    return s;
  }

  return { group, result, finish, summary, STATUS };
}

function serialiseDiff(d) {
  return {
    missing: d.missing,
    unexpected: d.unexpected,
    changed: d.changed.map((c) => ({
      address: c.address,
      fields: Object.fromEntries(
        Object.entries(c.fields).map(([k, v]) => [k, { expected: fmt(v.expected), actual: fmt(v.actual) }])
      ),
      storage: c.storage,
    })),
  };
}

module.exports = { createReporter, diffAccounts, formatAccountDiff, serialiseDiff, fmt, short, STATUS };
