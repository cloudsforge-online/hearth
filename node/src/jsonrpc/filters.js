'use strict';
/* The filter registry — the only server-side state the JSON-RPC layer holds.
 *
 * `eth_newFilter` and its family are the one part of the Ethereum RPC where the
 * SERVER remembers something between calls. Everything else in this directory is
 * a pure function of the chain: ask twice, get the same answer, hold nothing. A
 * filter is a cursor the caller creates and the node keeps until the caller says
 * otherwise — and "until the caller says otherwise" on an unauthenticated,
 * CORS-`*` endpoint means "forever, as many as anyone likes", which is a memory
 * leak with an HTTP interface in front of it. So three bounds, all of them
 * fail-closed:
 *
 *   - A TTL. A filter expires `ttlMs` after its last use, not after its
 *     creation, so a client that is still polling keeps its filter and one that
 *     went away loses it. Five minutes, matching geth's `--rpc.filter-timeout`
 *     default, which is long enough that a browser tab backgrounded through a
 *     GC pause does not lose its subscription.
 *   - A per-caller cap. Without it one address opens filters in a loop and the
 *     TTL only decides how fast. ethers v6 opens one filter per contract event
 *     plus one for pending transactions, so 32 is far above an honest client
 *     and far below anything that matters.
 *   - A global cap, because the per-caller cap is keyed on the remote address
 *     and an attacker with a /64 has more addresses than we have memory. When
 *     it is hit, creation is REFUSED rather than something else being evicted:
 *     evicting is how a well-behaved client silently loses events while an
 *     abusive one keeps its own.
 *
 * WHAT A FILTER IS ALLOWED TO HOLD, which is the other half of bounding this.
 * None of the three kinds accumulates results server-side — that is the design
 * geth uses (a channel per subscription, drained by the poll) and it is exactly
 * the part that grows without limit when nobody polls. Here a filter holds a
 * CURSOR and nothing else:
 *
 *   logs     the criteria, the next block height not yet reported, and the
 *            hashes of the last `filterReorgDepth` (12) heights it scanned —
 *            384 bytes, fixed, and the reason it can tell the chain reorganised
 *            under it. The logs themselves are re-derived at poll time.
 *   block    the height and hash last reported.
 *   pending  an integer into the mempool's own bounded journal.
 *
 * So a filter is O(1) in memory except for its criteria, which are bounded by
 * the request body limit, and `maxFilters * (that)` is the whole exposure. A
 * node that is never polled again cannot grow past it.
 *
 * ON WHO MAY POLL A FILTER. Accounting is by creator; ACCESS is not restricted,
 * which matches geth. The id is 16 bytes from `crypto.randomBytes`, so it is not
 * guessable, and refusing a poll whose source address has changed since creation
 * would break a client behind a rotating proxy or an IPv6 privacy address while
 * adding nothing an unguessable id does not already give.
 */

const { randomBytes } = require('crypto');
const { RpcError } = require('./hex');

/** Filter lifetime, refreshed on every use. geth's --rpc.filter-timeout. */
const FILTER_TTL_MS = 5 * 60 * 1000;
/** Filters one remote address may hold at once. */
const MAX_FILTERS_PER_CALLER = 32;
/** Filters this node will hold in total, across every caller. */
const MAX_FILTERS = 1024;

/** geth's wording, which clients match on to decide to re-create the filter. */
const NOT_FOUND = 'filter not found';

class FilterRegistry {
  /**
   * @param {object} [o]
   * @param {number} [o.ttlMs]           lifetime after last use
   * @param {number} [o.maxPerCaller]    filters one address may hold
   * @param {number} [o.maxFilters]      filters this node will hold at all
   * @param {function} [o.now]           injectable clock, for the suite
   */
  constructor({
    ttlMs = FILTER_TTL_MS, maxPerCaller = MAX_FILTERS_PER_CALLER,
    maxFilters = MAX_FILTERS, now = Date.now,
  } = {}) {
    this.ttlMs = Number(ttlMs);
    this.maxPerCaller = Number(maxPerCaller);
    this.maxFilters = Number(maxFilters);
    this.now = now;
    /** id -> { kind, owner, usedAt, … cursor fields } */
    this.byId = new Map();
    /** owner -> count. Deleted at zero so this cannot grow with addresses seen. */
    this.perCaller = new Map();
    if (!(this.ttlMs > 0) || !(this.maxPerCaller > 0) || !(this.maxFilters > 0)) {
      // Same reasoning as RpcChain's budgets: a zero here reads as "no limit"
      // to whoever wrote it, and would be one.
      throw new Error('FilterRegistry: ttlMs, maxPerCaller and maxFilters must all be positive');
    }
  }

  get size() { return this.byId.size; }

  /**
   * Drop everything past its TTL.
   *
   * Called at the top of every filter method rather than from a timer, on
   * purpose: a timer is a handle that has to be closed, and an embedder that
   * forgets keeps the process alive. The bound that matters when nobody calls
   * anything is `maxFilters`, not the sweep.
   */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, f] of this.byId) if (f.usedAt <= cutoff) this._drop(id, f);
  }

  _drop(id, f) {
    this.byId.delete(id);
    const left = (this.perCaller.get(f.owner) || 1) - 1;
    if (left <= 0) this.perCaller.delete(f.owner);
    else this.perCaller.set(f.owner, left);
  }

  /**
   * Register a filter and return its id.
   *
   * The caps are checked AFTER the sweep, so a caller whose old filters have
   * simply timed out is not refused on their account.
   */
  create(owner, filter) {
    this.sweep();
    if (this.byId.size >= this.maxFilters) {
      throw RpcError.server(`this node is holding its maximum of ${this.maxFilters} filters`);
    }
    const held = this.perCaller.get(owner) || 0;
    if (held >= this.maxPerCaller) {
      throw RpcError.server(
        `too many filters from this address (limit ${this.maxPerCaller}) — uninstall one with eth_uninstallFilter`);
    }
    // 16 bytes, not a counter: a guessable id lets one caller poll and uninstall
    // another's filter, and the changes a poll returns are consumed by whoever
    // asked first.
    const id = '0x' + randomBytes(16).toString('hex');
    this.byId.set(id, { ...filter, owner, usedAt: this.now() });
    this.perCaller.set(owner, held + 1);
    return id;
  }

  /**
   * The filter for `id`, with its lifetime refreshed — or null if it is unknown
   * or expired. Callers turn null into `filter not found`; see `notFound`.
   */
  touch(id) {
    this.sweep();
    if (typeof id !== 'string') return null;
    const f = this.byId.get(id);
    if (!f) return null;
    f.usedAt = this.now();
    return f;
  }

  /** Drop everything, counters included. For a server shutting down. */
  clear() { this.byId.clear(); this.perCaller.clear(); }

  /** true if `id` named a live filter, which is what eth_uninstallFilter returns. */
  remove(id) {
    this.sweep();
    if (typeof id !== 'string') return false;
    const f = this.byId.get(id);
    if (!f) return false;
    this._drop(id, f);
    return true;
  }

  /* geth answers an unknown or expired id with a plain server error, and every
   * client treats that as "re-create the filter" — ethers v6 falls all the way
   * back to polling eth_getLogs. Anything else (an empty array, say) is read as
   * "nothing happened" and the client waits forever for events it will never be
   * told about. */
  static notFound() { return RpcError.server(NOT_FOUND); }
}

module.exports = {
  FilterRegistry,
  FILTER_TTL_MS, MAX_FILTERS_PER_CALLER, MAX_FILTERS, NOT_FOUND,
};
