'use strict';
/* The light-mining loop, written once so it cannot be written twice.
 *
 * WHY THIS FILE EXISTS. `bin/hearth-mine.js` grew the whole of light mining
 * inside it: fetch a template, check it, grind it, sign the win, post the proof,
 * back off when the node meters us, give up when the work is not ours. Then the
 * desktop app needed exactly that, and there were only two ways to get it —
 * shell out to the CLI and scrape its terminal output, or write the loop again.
 * Scraping a status line is not an interface, and a second loop drifts: this
 * repository has already paid for that once, when the browser miner signed a
 * 64-byte proof for months while the node required 65 and every block it found
 * was refused after the work was done. That miner lived in web/ and was deleted in
 * 48bc28a; this file is why the mistake cannot be made twice, since there is now
 * one loop and one signer for every front-end.
 *
 * So the loop lives here, headless, and BOTH front-ends drive it: the CLI
 * renders these events as a terminal status line, and app-desktop/engine/
 * forwards them to a window as JSON. A change to how mining works is one edit
 * in one place, and test/mine-session.js checks the behaviour directly rather
 * than through a regex over somebody's stdout.
 *
 * WHAT IT IS. A LIGHT miner: no chain, no sync, no listening socket. It takes
 * work from a node over HTTP and posts proofs back. It therefore CANNOT
 * VALIDATE THE CHAIN IT MINES ON — point it at a node you trust. The reasoning,
 * and what that does and does not cost, is in bin/hearth-mine.js's header and in
 * docs/mining.md; it is not repeated here.
 *
 * WHAT IT NEVER DOES. It never prints, never logs, and never puts a private key
 * in an event. `key.privateKey` is used for exactly one thing — signing the
 * winning digest — and nothing that leaves this file carries it. A front-end
 * cannot leak what it is never handed.
 */

const P = require('../params');
const POW = require('../pow');
const HDR = require('../chain/header');
const { SLICE_MS, schedule } = require('../minerloop');

/** How long to wait before asking for work again after a failure to get any. */
const RETRY_MS = 3000;

/**
 * Stop after this many REFUSED proofs.
 *
 * Once is bad luck — a tip that moved in a way the node did not call stale.
 * Repeatedly means the work is not what we think it is, and continuing burns a
 * core for nothing. Rate-limiting (429) is deliberately NOT counted: the proof
 * was fine and the node was busy, and counting it would turn a healthy node
 * under load into a miner that quits.
 */
const GIVE_UP_AFTER_REFUSALS = 5;

/** Take fresh work this long before a template expires, rather than after. */
const EXPIRY_MARGIN_MS = 5000;

/**
 * Where a search over BRAND NEW work begins. Not zero, and this is the whole
 * reason the miner works at all.
 *
 * A node's template is MEMOIZED on (tip, mempool version, coinbase key) —
 * src/chain/miner.js — so while the tip is still, every request returns a
 * byte-identical `coreHash` with a frozen `timestamp`; only `templateId` and
 * `expiresAt` differ. The seed is `h(coreHash, nonce, coinbasePub)`
 * (src/pow.js), so a given nonce over a given template has ONE digest,
 * forever. Re-searching a range already searched is therefore not merely
 * wasteful, it is guaranteed to fail.
 *
 * That makes the starting point load-bearing in two places. `run()` below keeps
 * the position across a re-fetch of unchanged work; this constant covers the
 * other one — a RESTART. Beginning every process at 0 means a miner that was
 * killed and started again re-treads exactly the nonces it has already rejected
 * and finds nothing, which is what the operator saw when restarting the stalled
 * miner changed nothing. The same applies to two machines sharing one key: at 0
 * they duplicate each other's search, and from a random offset they do not.
 *
 * 2^32 is picked to stay far inside a safe integer even after days of grinding,
 * and the node accepts any non-negative integer nonce (src/chain/miner.js;
 * the header field is 8 bytes, src/chain/header.js).
 */
const NONCE_SPACE = 2 ** 32;

class MineSession {
  /**
   * @param {object} o
   * @param {string} o.url        base URL of the node's REST API
   * @param {object} o.key        a coinbase key: { privateKey, publicKey, addressHex }
   * @param {number} [o.throttle] share of a core, 0..1
   * @param {function} [o.fetch]  injected for tests; defaults to global fetch
   * @param {number} [o.startNonce] where to begin each fresh search. Defaults to
   *   a random point in the nonce space, which is what a restarted process needs
   *   (see NONCE_SPACE). Pinning it makes the search reproducible — which is how
   *   test/mine-session.js can assert a specific winning nonce, and how two
   *   machines sharing one key could be given disjoint ranges on purpose.
   */
  constructor(o) {
    if (!o || !o.url) throw new Error('MineSession needs a url to take work from');
    if (!o.key || !o.key.privateKey || !o.key.publicKey) throw new Error('MineSession needs a coinbase key');
    this.base = String(o.url).replace(/\/+$/, '');
    this.key = o.key;
    this.pubHex = o.key.publicKey.toString('hex');
    this.throttle = o.throttle === undefined ? 1.0 : o.throttle;
    this._fetch = o.fetch || ((...a) => globalThis.fetch(...a));
    this._retryMs = o.retryMs === undefined ? RETRY_MS : o.retryMs;
    this._giveUpAfter = o.giveUpAfterRefusals === undefined ? GIVE_UP_AFTER_REFUSALS : o.giveUpAfterRefusals;
    this._startNonce = Number.isInteger(o.startNonce) && o.startNonce >= 0 ? o.startNonce : null;

    this._handlers = new Map();
    this._running = false;
    this._stopping = false;
    this._stopReason = null;

    this.startedAt = 0;
    this.found = 0;
    this.stale = 0;
    this.refused = 0;
    this.height = 0;
    this.hashrate = 0;
    this.earnedWei = 0n;
    this.reachable = null;          // null = not tried yet
    this.work = null;

    /* WHERE THE SEARCH IS, not where this template's search is. It survives a
     * re-fetch of work that has not changed, and only moves back to a fresh
     * random offset when the `coreHash` does — see NONCE_SPACE and `run()`. */
    this.nonce = 0;
    this._ground = null;            // the coreHash `this.nonce` is a position in

    this._hashes = 0;
    this._rateStart = 0;
  }

  /** Subscribe. Several handlers per event are allowed; a throwing one is ignored. */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  }

  _emit(event, payload) {
    for (const fn of this._handlers.get(event) || []) {
      try { fn(payload === undefined ? {} : payload); } catch { /* a listener must not break mining */ }
    }
  }

  /** A snapshot a UI can render. Contains no key material, by construction. */
  stats() {
    return {
      address: this.key.addressHex,
      url: this.base,
      running: this._running,
      working: this.work !== null,
      height: this.height,
      hashrate: this.hashrate,
      found: this.found,
      stale: this.stale,
      refused: this.refused,
      earnedWei: this.earnedWei.toString(),
      reachable: this.reachable,
      throttle: this.throttle,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /** Ask the loop to wind up. It stops at the end of the current slice. */
  stop(reason = 'asked to stop') {
    this._stopping = true;
    if (!this._stopReason) this._stopReason = reason;
  }

  async _api(pathname, init) {
    const res = await this._fetch(this.base + pathname, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  /**
   * Check a template before spending a single evaluation on it.
   *
   * The endpoint chooses the work, so this is the whole of what a light miner
   * can check for itself, and it is not a formality: without it an endpoint can
   * hand out work paying its own coinbase and the only symptom is that every
   * submission is refused — after the electricity has been spent.
   *
   * @returns {string|null} an error to show a human, or null when the work is ours.
   */
  verify(t) {
    if (!t || typeof t !== 'object' || typeof t.templateId !== 'string') return 'the response is not a work template';
    if (typeof t.coreHash !== 'string' || !/^[0-9a-f]{64}$/.test(t.coreHash)) return 'the template carries no core hash';

    /* THE PROOF-OF-WORK PARAMETERS TRAVEL WITH THE WORK, and src/chain/miner.js
     * says why: a miner that hardcodes them keeps hashing happily after a retune
     * and produces nothing valid, while one that reads them stops — "which is the
     * failure you want". So stop. */
    if (t.scratchKiB !== undefined && t.scratchKiB !== P.POW_SCRATCH_KIB) {
      return `this node mines with a ${t.scratchKiB} KiB scratch pad and this build uses ${P.POW_SCRATCH_KIB} KiB `
        + '— different proof-of-work parameters, so nothing mined here would be accepted';
    }
    if (t.walkSteps !== undefined && t.walkSteps !== P.POW_WALK_STEPS) {
      return `this node walks ${t.walkSteps} steps and this build walks ${P.POW_WALK_STEPS} `
        + '— different proof-of-work parameters, so nothing mined here would be accepted';
    }

    // …and it must pay US.
    if (t.coinbasePub !== this.pubHex) return 'the work pays another coinbase key, not ours';
    if (t.coinbaseAddress && t.coinbaseAddress.toLowerCase() !== this.key.addressHex.toLowerCase()) {
      return `the work pays ${t.coinbaseAddress}, not ${this.key.addressHex}`;
    }

    /* And the core hash must actually COMMIT to all of that. Without this the two
     * checks above are only the endpoint's word for what it put in the header. */
    const fields = ['version', 'prevHash', 'height', 'timestamp', 'target', 'coinbasePub',
      'txRoot', 'stateRoot', 'receiptsRoot', 'logsBloom', 'gasLimit', 'gasUsed', 'extraData'];
    if (fields.some(f => t[f] === undefined)) {
      return 'the template does not carry the header fields its core hash is made of, '
        + 'so there is no way to check that the work pays us — the node is older than this miner';
    }
    let recomputed;
    const h = {};
    for (const f of fields) h[f] = t[f];
    try { recomputed = HDR.coreHash(h); }
    catch (e) { return `the header in the template is malformed: ${e && e.message || e}`; }
    if (recomputed !== t.coreHash) {
      return 'the core hash does not match the header it came with — the work we would grind is '
        + 'not the work we were shown';
    }
    return null;
  }

  /** Fetch and check work. Returns a template, or null having already said why. */
  async _fetchWork() {
    let r;
    try {
      r = await this._api(`/mining/template?pub=${this.pubHex}`);
    } catch (e) {
      this._down(`could not reach ${this.base} — ${String(e && e.message || e)}`);
      return null;
    }
    if (r.status === 429) {
      /* Throttled, not broken. Both mining endpoints are metered rather than
       * authenticated (params.js `MINING_VERIFY_BURST`), and the honest way to
       * meet that is to ask less often — not to hammer it and be refused. */
      const retryAfterMs = (r.body && r.body.retryAfterMs) || 1000;
      this._emit('throttled', { kind: 'template', retryAfterMs, err: r.body && r.body.err });
      this._down(`${this.base} is rate-limiting work requests — backing off`);
      await sleep(retryAfterMs);
      return null;
    }
    if (r.status !== 200) {
      this._down(`${this.base} answered HTTP ${r.status} for work — ${(r.body && r.body.err) || 'no reason given'}`,
        { status: r.status });
      return null;
    }
    if (this.reachable === false) { this.reachable = true; this._emit('reachable', { url: this.base }); }
    else this.reachable = true;

    const bad = this.verify(r.body);
    if (bad) {
      this.stop(bad);
      this._emit('badwork', { err: bad });
      return null;
    }
    this.height = r.body.height;
    this._emit('work', {
      height: r.body.height,
      target: r.body.target,
      expiresAt: r.body.expiresAt,
      coinbaseReward: String(r.body.coinbaseReward === undefined ? (r.body.reward || '0') : r.body.coinbaseReward),
      txCount: r.body.txCount,
    });
    return r.body;
  }

  /** Say "the node is not answering" ONCE, not once per retry. */
  _down(err, extra) {
    if (this.reachable === false) return;
    this.reachable = false;
    this._emit('unreachable', Object.assign({ err, url: this.base }, extra || {}));
  }

  async _submit(t, nonce, digest) {
    /* The one and only use of the private key in this file. `signProof` returns
     * r||s||recoveryId — 65 bytes, 130 hex — because src/chain/header.js
     * `verifyPow` recovers the coinbase from it and refuses anything shorter.
     * The browser miner sent 64 for months and had every block refused. Its
     * successor in micro-network-site sends 65, and test/browser-proof.js is what
     * CHECKS that rather than describing it — restored 2026-08-09 after being
     * deleted with web/ in 48bc28a, three days after the browser miner itself came
     * back. This comment named it for the whole of that gap. */
    const powSig = HDR.signProof(digest, this.key.privateKey);
    let r;
    try {
      r = await this._api('/mining/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: t.templateId, nonce, powDigest: digest, powSig }),
      });
    } catch (e) {
      this._emit('lost', { err: `found a block but could not submit it — ${String(e && e.message || e)}` });
      return;
    }
    if (r.status === 200 && r.body.ok) {
      this.found++;
      /* `coinbaseReward`, NOT `reward`. The latter is the full subsidy the block
       * mints, 10% of which goes to the Commons — quoting it here made the running
       * total 10% higher than the coins actually held, which never reconciles
       * against a wallet. Falls back only for a node too old to send it. */
      const paid = BigInt(t.coinbaseReward !== undefined ? t.coinbaseReward : (t.reward || 0));
      this.earnedWei += paid;
      this._emit('accepted', {
        height: r.body.height,
        id: String(r.body.id || ''),
        paidWei: paid.toString(),
        earnedWei: this.earnedWei.toString(),
        found: this.found,
      });
      return;
    }
    if (r.status === 409 || r.body.stale) {
      // Somebody else found this height first. Expected, and not an error.
      this.stale++;
      this._emit('stale', { stale: this.stale, height: this.height });
      return;
    }
    if (r.status === 429) {
      // Our proof was fine; the node is over its verification budget. Not a
      // refusal, and it must not count toward the give-up threshold below.
      const retryAfterMs = (r.body && r.body.retryAfterMs) || 1000;
      this._emit('throttled', { kind: 'submit', retryAfterMs, err: r.body && r.body.err });
      await sleep(retryAfterMs);
      return;
    }
    this.refused++;
    const err = r.body.err || 'HTTP ' + r.status;
    this._emit('refused', { err, refused: this.refused });
    if (this.refused >= this._giveUpAfter) {
      this.stop(`${this.refused} proofs refused — stopping rather than mining into a wall`);
    }
  }

  /**
   * Run until `stop()`. Resolves with the reason it stopped.
   *
   * Grinding yields on a slice of WALL CLOCK, exactly as the in-process miners do
   * (src/minerloop.js), because this process still has to run its HTTP calls and
   * whatever UI is watching it. A fixed batch of nonces is a variable and
   * unbounded amount of blocked event loop when one nonce is a full evaluation:
   * the fixed batch of 150 was 1.43 s per turn, and the slice is SLICE_MS.
   *
   * THE NONCE BELONGS TO THE SESSION, NOT TO THE TEMPLATE, and that distinction
   * is the difference between a miner that mines and one that stops. See
   * NONCE_SPACE above for why.
   */
  async run() {
    if (this._running) throw new Error('this session is already running');
    this._running = true;
    this.startedAt = Date.now();
    this._rateStart = Date.now();
    this._emit('started', { address: this.key.addressHex, url: this.base, throttle: this.throttle });

    try {
      for (;;) {
        if (this._stopping) break;
        if (!this.work) {
          this.work = await this._fetchWork();
          if (!this.work) {
            if (this._stopping) break;
            await sleep(this._retryMs);
            continue;
          }
          /* ONLY MOVE THE SEARCH WHEN THE WORK ACTUALLY MOVED. A template
           * expiring is not new work: the node re-issues the same memoized
           * candidate under a new id, so restarting at 0 here re-tested the
           * exact nonces already rejected — every 115 s, forever, at a full and
           * entirely real hashrate. That is the stall this compares away. */
          if (this.work.coreHash !== this._ground) {
            this._ground = this.work.coreHash;
            this.nonce = this._startNonce === null ? Math.floor(Math.random() * NONCE_SPACE) : this._startNonce;
          }
        }
        if (Date.now() > (this.work.expiresAt || 0) - EXPIRY_MARGIN_MS) { this.work = null; continue; }

        const t = this.work;
        const spent = this._grind(t, this.nonce);
        this.nonce = spent.nextNonce;

        const dt = (Date.now() - this._rateStart) / 1000;
        if (dt >= 1) {
          this.hashrate = Math.round(this._hashes / dt);
          this._hashes = 0;
          this._rateStart = Date.now();
          this._emit('rate', { hashrate: this.hashrate, height: this.height });
        }

        if (spent.win) {
          await this._submit(t, spent.win.nonce, spent.win.digest);
          this.work = null;                        // always take fresh work after a win
          continue;
        }
        await new Promise(r => schedule(r, spent.ms, this.throttle));
      }
    } catch (e) {
      this._stopReason = String(e && e.message || e);
      this._emit('error', { err: this._stopReason });
    }
    this._running = false;
    this.work = null;
    const reason = this._stopReason || 'asked to stop';
    this._emit('stopped', Object.assign({ reason }, this.stats()));
    return reason;
  }

  /**
   * One slice of hashing. Synchronous on purpose — the slice IS the yield point,
   * and awaiting inside it would make the throttle meaningless.
   */
  _grind(t, from) {
    let nonce = from;
    const t1 = Date.now();
    do {
      const digest = POW.homefireHash(POW.powSeed(t.coreHash, nonce, t.coinbasePub)).toString('hex');
      this._hashes++;
      if (POW.meetsTarget(digest, t.target)) {
        const n = nonce;
        nonce++;
        return { ms: Date.now() - t1, nextNonce: nonce, win: { nonce: n, digest } };
      }
      nonce++;
    } while (Date.now() - t1 < SLICE_MS);
    return { ms: Date.now() - t1, nextNonce: nonce, win: null };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { MineSession, RETRY_MS, GIVE_UP_AFTER_REFUSALS, EXPIRY_MARGIN_MS, NONCE_SPACE };
