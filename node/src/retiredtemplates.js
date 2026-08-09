'use strict';
/* Why a mining template that is GONE still has to answer for itself.
 *
 * Two `Templates` classes hand work to miners outside this process — the UTXO one
 * in src/mining.js and the account-model one in src/chain/miner.js. Both used to
 * answer an id they no longer hold with a bare
 *
 *     { ok: false, err: 'unknown or expired template' }
 *
 * and neither HTTP route can turn that into anything but 400, because 409 is
 * reached only through `stale: true` (`send(r.ok ? 200 : r.stale ? 409 : 400, r)`
 * in src/evmnode.js, and the same expression in src/rpc.js).
 *
 * 400 AND 409 ARE NOT TWO SHADES OF ONE REFUSAL HERE. They are instructions to the
 * miner, and they are opposite ones:
 *
 *   400  your submission is malformed — you have a bug. src/mine/session.js counts
 *        these as `refused` and, past a threshold, stops the session outright
 *        "rather than mining into a wall". The browser miner in the network site
 *        counts them as `rejected` and shows them to the operator as faults.
 *   409  your work was merely late. Pull a fresh template and carry on. Both
 *        clients count these as `stale`, which is explicitly not an error and
 *        never a strike.
 *
 * So the old answer told a miner whose template had simply aged out that its proof
 * was wrong, and a miner that believes that stops. Observed on the public testnet
 * on 2026-08-07: a browser miner at 911 H/s, one correct 409 followed by four 400s
 * that were the identical situation wearing the wrong status code — micro-org#237.
 * It is reached easily because that miner polls for fresh work every 45 s against
 * a template lifetime of 120 s, so a slow client can and does cross the boundary
 * between two refreshes.
 *
 * WHAT THIS STRUCTURE HOLDS. Ids, and a reason. Never the template. The retired
 * template's candidate is the expensive part — on the account model it is a full
 * block of executed EVM — and keeping it alive to answer questions about itself
 * would defeat both of the bounds that retired it. An id is 16 bytes.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not make every unknown id stale, which
 * is the cheaper fix and a worse one. A template that expired and an id this node
 * never issued are different facts: the first means "refetch", the second means
 * the caller is confused, is talking to the wrong node, or is fabricating ids. One
 * answer for those two situations is the same defect as one answer for expiry and
 * a bad digest — the shape this file exists to remove, rebuilt one status code
 * over.
 *
 * THE HOLE, NAMED. This ring is bounded in both age and count, so an id retired
 * long enough ago — or far enough back in a burst — is forgotten, and answers
 * `unknown` again. That is not a regression (it is exactly the old behaviour) and
 * it is not free to remove: an unbounded ring is the unbounded map that
 * MAX_TEMPLATES exists to prevent, reintroduced one field over. The two bounds
 * below are each chosen so that a miner still plausibly hashing cannot reach it,
 * and each says why.
 */

/* How long a retired id is remembered, as a multiple of the template lifetime the
 * caller passed in.
 *
 * ONE lifetime, because that is the longest a miner could have been holding the
 * template before it died, so it is a fair upper bound on how long it might still
 * be grinding it afterwards. A miner that surfaces more than a full template
 * lifetime late is not mid-attempt; it was asleep, suspended, or its tab was
 * backgrounded, and the honest answer to it is that this node no longer knows. */
const RETAINED_LIFETIMES = 1;

/* How many ids are remembered, as a multiple of the live map's capacity.
 *
 * Under count pressure the live map retires exactly one id for every id it issues,
 * so a ring of `maxTemplates` is consumed by ONE full turnover — and the entry it
 * drops first is the one retired first, which belongs to the miner that has been
 * hashing longest and is therefore the likeliest of all of them to still be
 * mid-attempt. A margin is the entire point of the structure. Four turnovers
 * rather than three or five because nothing available would distinguish those; the
 * defensible claim is only that it must be more than one. */
const RETAINED_TURNOVERS = 4;

/**
 * A bounded ring of recently retired template ids.
 *
 * `ttlMs` and `maxTemplates` are passed in rather than imported because the two
 * node implementations own their own copies of both, under different names
 * (`TTL_MS` in src/mining.js, `TEMPLATE_TTL_MS` in src/chain/miner.js). Every
 * figure that reaches an operator below is interpolated from what was passed, so
 * a message can never quote a lifetime the node has since been retuned away from.
 */
class RetiredTemplates {
  constructor({ ttlMs, maxTemplates }) {
    this.ttlMs = ttlMs;
    this.maxTemplates = maxTemplates;
    /** Remembered for one further template lifetime — see RETAINED_LIFETIMES. */
    this.retainMs = ttlMs * RETAINED_LIFETIMES;
    /** …and no more than four turnovers of the live map — RETAINED_TURNOVERS. */
    this.maxIds = maxTemplates * RETAINED_TURNOVERS;
    this.byId = new Map(); // id -> { reason, at }; insertion-ordered, so oldest first
  }

  get size() { return this.byId.size; }

  /**
   * Record that `id` is gone, and why, and return the answer `submit` should give
   * for it. `reason` is one of:
   *
   *   expired      it outlived TTL. The common one, and the one micro-org#237 saw.
   *   evicted      MAX_TEMPLATES overflowed and this was the oldest. A node with
   *                many concurrent miners drops LIVE work this way, regardless of
   *                its age, so it must read identically to expiry — same status,
   *                same `stale` flag — or the fix only covers the easy half.
   *   superseded   the tip moved under it. Already answered 409 before this file
   *                existed, but the branch that did so also DELETED the id, so a
   *                miner that retried the same template got 400 on the second
   *                attempt: the same defect, one step later.
   */
  retire(id, reason, now = Date.now()) {
    this.byId.delete(id);          // re-insert: Map keeps insertion order, and this is now the newest
    this.byId.set(id, { reason, at: now });
    this.sweep(now);
    return this.answerFor(id, now);
  }

  /** Drop what is too old or too numerous to keep. Cheap; call it on every issue. */
  sweep(now = Date.now()) {
    for (const [id, e] of this.byId) {
      if (now - e.at <= this.retainMs) break;  // insertion-ordered: the rest are younger still
      this.byId.delete(id);
    }
    while (this.byId.size > this.maxIds) this.byId.delete(this.byId.keys().next().value);
  }

  /**
   * The body `submit` returns for an id the live map does not hold.
   *
   * `stale` is set explicitly in BOTH branches rather than left absent in one.
   * Absent-and-falsy is what produced micro-org#237: the route reads
   * `r.stale ? 409 : 400`, so "nobody thought about it here" and "this is
   * definitely not stale" were the same value and could not be told apart in
   * review.
   */
  answerFor(id, now = Date.now()) {
    const e = this.byId.get(id);
    if (e && now - e.at > this.retainMs) { this.byId.delete(id); return this._unknown(); }
    if (!e) return this._unknown();
    return { ok: false, err: this._message(e.reason), stale: true, reason: e.reason };
  }

  _unknown() {
    /* Named, not guessed. This node cannot tell an id it never issued from one it
     * issued and has since forgotten, and saying so is the whole reason a miner
     * can act on the other two answers: an operator who reads "not issued by this
     * node" and knows it WAS issued would rightly stop trusting the 409s too. */
    return {
      ok: false,
      stale: false,
      reason: 'unknown',
      err: 'unknown template — this id was not issued by this node, or was retired too long ago to be remembered',
    };
  }

  _message(reason) {
    if (reason === 'expired') {
      return `stale template — it expired ${this.ttlMs} ms after it was issued; fetch fresh work`;
    }
    if (reason === 'evicted') {
      return `stale template — evicted, this node keeps at most ${this.maxTemplates} outstanding templates; fetch fresh work`;
    }
    return 'stale template — the tip moved; fetch fresh work';
  }
}

module.exports = { RetiredTemplates, RETAINED_LIFETIMES, RETAINED_TURNOVERS };
