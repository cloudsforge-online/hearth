'use strict';
/* The `module=contract` half of the API is answered by tools/verify, over HTTP.
 *
 * Two services rather than one, and deliberately: verification recompiles
 * arbitrary user-supplied Solidity with a downloaded compiler, which is by far
 * the largest attack surface in either process. Keeping it out of the process
 * that aggregators poll means the explorer API stays a reader of blocks, and a
 * verifier that is down or compromised degrades `getabi` to "not verified"
 * rather than taking the supply endpoints with it.
 *
 * Absent configuration this returns null for everything, which renders as
 * Etherscan's "Contract source code not verified" — true, rather than an
 * outage that looks like a missing contract.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const NEGATIVE_TTL_MS = 30_000;
/* A DERIVED answer — the source of an address with identical runtime bytecode,
 * `twinOf` set — is the one positive that can be superseded. Verifying that
 * address directly adds its constructor arguments and its own creation
 * transaction, and caching the derived answer forever would hide that until a
 * restart. Long enough to still absorb a page's worth of requests. */
const DERIVED_TTL_MS = 5 * 60_000;

const ttlOk = hit => !hit.record.twinOf || Date.now() - hit.at < DERIVED_TTL_MS;

class VerifyClient {
  constructor(baseUrl, { timeoutMs = 5000 } = {}) {
    this.base = baseUrl ? new URL(baseUrl) : null;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();     // address -> { at, record }
  }

  get enabled() { return this.base !== null; }

  async lookup(address) {
    if (!this.base) return null;
    const key = address.toLowerCase();
    const hit = this.cache.get(key);
    /* A directly verified record never changes — a contract's runtime bytecode
     * is immutable — so that answer is cached forever. A negative one is cached
     * briefly, because "verify it, then look again" is the normal sequence and a
     * long negative TTL makes the verifier look broken. A derived one expires
     * too, for the reason above it. */
    if (hit && (hit.record ? ttlOk(hit) : Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.record;

    const record = await this._get(`/contract/${key}`);
    this.cache.set(key, { at: Date.now(), record });
    return record;
  }

  _get(path) {
    const transport = this.base.protocol === 'https:' ? https : http;
    return new Promise(resolve => {
      const req = transport.request(
        {
          protocol: this.base.protocol,
          hostname: this.base.hostname,
          port: this.base.port,
          path: (this.base.pathname.replace(/\/$/, '')) + path,
          method: 'GET',
          timeout: this.timeoutMs,
        },
        res => {
          let text = '';
          res.on('data', d => { text += d; });
          res.on('end', () => {
            if (res.statusCode !== 200) return resolve(null);
            try { resolve(JSON.parse(text)); } catch { resolve(null); }
          });
        },
      );
      // Every failure is "not verified". The explorer must not 500 because the
      // verifier is restarting.
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    });
  }
}

module.exports = { VerifyClient };
