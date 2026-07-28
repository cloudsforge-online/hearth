#!/usr/bin/env node
'use strict';
/* One compile, in its own process, then exit.
 *
 * Reads `{ soljson, input }` as JSON on stdin and writes solc's standard-JSON
 * output on stdout. Nothing else: no network, no filesystem beyond the
 * compiler it was told to load, and no import callback — the callback pointer
 * is 0, so `import "…"` can only resolve to a source the submitter supplied.
 * A verifier that could read the local filesystem during a compile would let a
 * submission exfiltrate it.
 *
 * See compile.js for why this is a separate process at all.
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let job;
  try {
    job = JSON.parse(raw);
  } catch (e) {
    fail(`could not parse the compile job: ${e.message}`);
  }

  let solc;
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    solc = require(job.soljson);
  } catch (e) {
    fail(`could not load ${job.soljson}: ${e.message}`);
  }
  if (typeof solc.cwrap !== 'function') {
    fail(`${job.soljson} is not a soljson build (no cwrap)`);
  }

  let version;
  try {
    version = solc.cwrap('solidity_version', 'string', [])();
  } catch (e) {
    fail(`could not read the compiler version: ${e.message}`);
  }

  let out;
  try {
    /* The stable entry point since 0.6.0. The two zeros are the import read
     * callback and its context — deliberately absent. */
    const compile = solc.cwrap('solidity_compile', 'string', ['string', 'number', 'number']);
    out = compile(JSON.stringify(job.input), 0, 0);
  } catch (e) {
    fail(`solc threw: ${e.message}`);
  }

  process.stdout.write(JSON.stringify({ ok: true, version, output: out }));
});

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exit(0);
}
