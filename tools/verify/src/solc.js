'use strict';
/* ============================================================================
 * GETTING A COMPILER, SAFELY.
 * ============================================================================
 *
 * Verification means recompiling with the EXACT compiler the submitter claims
 * to have used — a different patch release produces different bytecode, so
 * "close enough" does not exist here. There are hundreds of releases and this
 * repository has zero npm dependencies, so the compiler cannot come from
 * `node_modules`; it is fetched from the Solidity team's own binary server and
 * cached on disk.
 *
 * THE SECURITY PROBLEM, STATED PLAINLY: a soljson build is a 9 MB JavaScript
 * file that this process `require`s. Loading one that an attacker chose is
 * arbitrary code execution as the verifier. So:
 *
 *   1. The version is resolved against `list.json` from the same server, which
 *      publishes a KECCAK-256 for every build.
 *   2. The download is hashed with this repository's own vector-tested
 *      keccak256 (node/src/crypto/keccak.js) and the hash must equal the
 *      published one. A mismatch deletes the file and refuses.
 *   3. Only files that passed (2) are ever `require`d, and only from inside the
 *      cache directory — a submitted "compilerVersion" can never become a path.
 *   4. Nightlies are refused by default: they are not reproducible in the way a
 *      release is, and a verifier's whole product is reproducibility.
 *   5. `HEARTH_VERIFY_SOLC_OFFLINE=1` refuses every fetch, so an air-gapped
 *      deployment can pre-seed the directory and know nothing else can arrive.
 *
 * WHY NOT solc-js: it is an npm package, and it is a wrapper around exactly the
 * file this downloads. The entry point it wraps —
 * `solidity_compile(input, readCallback, context)` — has been stable since
 * 0.6.0, which is the floor this supports and the floor it enforces. Older
 * releases need solc-js's translation layer and are refused by name rather
 * than failing obscurely.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const { keccak256 } = require('../../../node/src/crypto/keccak');

/** The oldest release whose `solidity_compile` signature we can call directly. */
const MIN_MAJOR_MINOR = [0, 6, 0];

class SolcError extends Error {}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function fetch(url, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.get(u, { timeout: timeoutMs }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetch(new URL(res.headers.location, u).href, { timeoutMs }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new SolcError(`${url} returned HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new SolcError(`timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

class SolcRegistry {
  constructor(env) {
    this.env = env;
    this.dir = env.solcDir;
    this.listPath = path.join(this.dir, 'list.json');
    this.list = null;
  }

  async loadList({ force = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!force && this.list) return this.list;

    let fresh = false;
    if (fs.existsSync(this.listPath)) {
      const age = Date.now() - fs.statSync(this.listPath).mtimeMs;
      fresh = age < this.env.solcListTtlMs;
    }
    if (!fresh && !this.env.solcOffline) {
      try {
        const body = await fetch(this.env.solcListUrl);
        JSON.parse(body.toString('utf8'));           // reject junk before it lands
        fs.writeFileSync(this.listPath, body);
      } catch (e) {
        if (!fs.existsSync(this.listPath)) throw e;  // nothing to fall back to
      }
    }
    if (!fs.existsSync(this.listPath)) {
      throw new SolcError(
        `no compiler list at ${this.listPath} and fetching is ${this.env.solcOffline ? 'disabled' : 'failing'}. `
        + `Seed it with: curl -o ${this.listPath} ${this.env.solcListUrl}`,
      );
    }
    this.list = JSON.parse(fs.readFileSync(this.listPath, 'utf8'));
    return this.list;
  }

  /**
   * Resolve a submitted version string to a published build.
   * Accepts `v0.8.26+commit.8a97fa7a`, `0.8.26+commit.8a97fa7a` or `0.8.26`.
   */
  async resolve(version) {
    const raw = String(version || '').trim();
    if (!raw) throw new SolcError('no compilerVersion given');
    if (!/^v?\d+\.\d+\.\d+([+-][0-9a-zA-Z.+-]+)?$/.test(raw)) {
      throw new SolcError(`compilerVersion ${raw} is not a solc version string`);
    }
    const parsed = parseVersion(raw);
    if (!parsed || !atLeast(parsed, MIN_MAJOR_MINOR)) {
      throw new SolcError(
        `solc ${raw} is older than ${MIN_MAJOR_MINOR.join('.')}, which is the oldest release whose `
        + 'solidity_compile entry point can be called without solc-js\'s translation layer. '
        + 'Not supported, deliberately — see tools/verify/README.md.',
      );
    }
    const isNightly = /nightly/i.test(raw);
    if (isNightly && !this.env.solcAllowNightly) {
      throw new SolcError(`solc ${raw} is a nightly build; set HEARTH_VERIFY_SOLC_ALLOW_NIGHTLY=1 to allow it`);
    }

    let list = await this.loadList();
    const find = l => {
      const want = raw.replace(/^v/, '');
      return (l.builds || []).find(b => {
        if (b.prerelease && !this.env.solcAllowNightly) return false;
        return b.longVersion === want || b.longVersion === raw || (want === b.version && !b.prerelease);
      });
    };
    let build = find(list);
    if (!build && !this.env.solcOffline) {
      list = await this.loadList({ force: true });
      build = find(list);
    }
    if (!build) throw new SolcError(`solc ${raw} is not a published release`);
    /* The server publishes `path` for every build. Refuse anything that is not
     * the plain filename we expect, so nothing from the list can escape the
     * cache directory. */
    if (!/^soljson-v[0-9a-zA-Z.+_-]+\.js$/.test(build.path)) {
      throw new SolcError(`refusing a compiler path from the release list: ${build.path}`);
    }
    return build;
  }

  /** Absolute path to a verified soljson build, downloading it if needed. */
  async ensure(version) {
    const build = await this.resolve(version);
    const file = path.join(this.dir, build.path);

    if (fs.existsSync(file)) {
      if (this._digest(file) === String(build.keccak256).toLowerCase()) {
        return { path: file, build };
      }
      // Cached but wrong. Could be a truncated download; could be worse.
      fs.rmSync(file, { force: true });
    }
    if (this.env.solcOffline) {
      throw new SolcError(
        `solc ${build.longVersion} is not in ${this.dir} and fetching is disabled `
        + '(HEARTH_VERIFY_SOLC_OFFLINE). Pre-seed the directory to verify against it.',
      );
    }

    const body = await fetch(`${this.env.solcBinBase}/${build.path}`);
    const got = '0x' + Buffer.from(keccak256(body)).toString('hex');
    if (got !== String(build.keccak256).toLowerCase()) {
      throw new SolcError(
        `${build.path} does not match its published keccak256 (want ${build.keccak256}, got ${got}). `
        + 'Refusing to load it — this file would be executed by this process.',
      );
    }
    // Write to a temporary name and rename, so a concurrent verification can
    // never `require` a half-written compiler.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return { path: file, build };
  }

  _digest(file) {
    return '0x' + Buffer.from(keccak256(fs.readFileSync(file))).toString('hex');
  }

  /** Releases this service will accept, newest first. For GET /compilers. */
  async releases(limit = 200) {
    const list = await this.loadList();
    const out = [];
    for (const b of list.builds || []) {
      if (b.prerelease && !this.env.solcAllowNightly) continue;
      const p = parseVersion(b.version);
      if (!p || !atLeast(p, MIN_MAJOR_MINOR)) continue;
      out.push({ version: b.version, longVersion: b.longVersion, cached: fs.existsSync(path.join(this.dir, b.path)) });
    }
    return out.reverse().slice(0, limit);
  }
}

module.exports = { SolcRegistry, SolcError, parseVersion, atLeast, MIN_MAJOR_MINOR };
