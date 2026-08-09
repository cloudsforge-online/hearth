'use strict';
/* Where the browser miner's own source is, for the two suites that compare it
 * against this node. Not a suite itself.
 *
 * HISTORY, BECAUSE THE SHAPE OF THIS FILE IS ENTIRELY ABOUT IT. The browser
 * miner used to live here, in `web/assets/mining/`, and two suites pinned it to
 * the node: `browser-pow.js` for the digests and `browser-proof.js` for the
 * proof signature. `web/` was deleted on 2026-08-04 (`48bc28a`) and both suites
 * went with it, on the reasoning that there was no browser miner left to check.
 *
 * That stopped being true on 2026-08-06. `micro-network-site` restored the
 * miner — `src/mining/{sha256,homefire,miner,worker}.js`, the same code, not a
 * rewrite — and its `/mine` page has been serving it since. So the browser half
 * of the comparison exists again; it simply lives in another repository. Its
 * own files still say `node/test/browser-pow.js` checks them. Between
 * 2026-08-04 and this commit, nothing did.
 *
 * WHY RESOLUTION IS EXPLICIT AND FAILURE IS LOUD. A suite that cannot find its
 * counterpart must FAIL, never skip. The whole defect this file exists to
 * prevent is a green run that verified nothing, and "skipped: browser sources
 * not found" scrolls past exactly like a pass. `micro-hearth-wallet-core` made
 * the same call in the other direction — it runs `hearth/node/src` in-process
 * as its oracle and fails when the node is absent — and that is the standard
 * being matched here.
 *
 * WHY THESE SUITES ARE NOT IN `npm test`. That command has to run on a bare
 * checkout of this repository with nothing installed, and it is what the `node`
 * CI job runs. Requiring a second repository would make it fail for every
 * contributor who has only this one. They run in their own CI job, which checks
 * `micro-network-site` out first (`.github/workflows/ci.yml`, job `browser`),
 * and locally via `npm run test:browser`.
 */

const fs = require('fs');
const path = require('path');
const url = require('url');

/** Every file either suite imports. All four must be present, or the directory
 *  is not the one we mean and a partial match would fail later and less
 *  legibly. */
const REQUIRED = ['sha256.js', 'homefire.js', 'miner.js', 'secp256k1.js'];

const ENV = 'HEARTH_BROWSER_MINING_SRC';

/** A sibling checkout under either the repository's name or the directory name
 *  the estate uses on disk, then a nested one — which is what a CI second
 *  checkout produces, since actions/checkout cannot write above the workspace. */
function candidates() {
  const out = [];
  const repoRoot = path.join(__dirname, '..', '..');
  for (const base of [path.join(repoRoot, '..'), repoRoot]) {
    for (const name of ['micro-network-site', 'network-site']) {
      out.push(path.join(base, name, 'src', 'mining'));
    }
  }
  return out;
}

const has = dir => REQUIRED.every(f => fs.existsSync(path.join(dir, f)));

/**
 * The directory holding the browser miner's sources, or a thrown error naming
 * everywhere that was looked. Never returns null: see the header.
 */
function resolveBrowserMining() {
  /* An explicit path is obeyed EXACTLY — a wrong one is an error, not a reason
   * to go looking. Falling back would let a typo in the CI step resolve to a
   * stale sibling checkout and report a pass about the wrong tree, which is the
   * same class of defect as skipping. */
  if (process.env[ENV]) {
    const dir = path.resolve(process.env[ENV]);
    if (has(dir)) return dir;
    throw new Error(
      `${ENV} is set to ${dir}, which does not contain ${REQUIRED.join(', ')}.\n`
      + 'Refusing to look elsewhere: an explicit path that resolves to a different tree '
      + 'would report a pass about code nobody meant to test.');
  }
  const tried = candidates();
  for (const dir of tried) if (has(dir)) return dir;
  throw new Error(
    'the browser miner\'s source was not found, so this suite verified NOTHING and is '
    + 'failing rather than skipping.\n\n'
    + 'It is `src/mining/` in cloudsforge-online/micro-network-site (public). Clone it\n'
    + `beside this repository, or set ${ENV} to the directory holding\n`
    + `${REQUIRED.join(', ')}.\n\n`
    + 'Looked in:\n' + tried.map(d => '  ' + d).join('\n'));
}

/** Import one of the browser's ES modules. They are plain ESM with no build
 *  step and no dependencies, which is why this works from CommonJS at all. */
function importBrowser(dir, file) {
  return import(url.pathToFileURL(path.join(dir, file)).href);
}

module.exports = { resolveBrowserMining, importBrowser, ENV, REQUIRED };
