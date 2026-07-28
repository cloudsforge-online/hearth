'use strict';
/* The rate limiter, and the reason the faucet cannot be drained.
 *
 * Four controls, deliberately layered, because each one alone has a known
 * bypass:
 *
 *   per address   an honest user's only encounter with any of this.
 *                 Bypass: generate another address. Free and instant.
 *   per IP        stops the lazy script. Bypass: an IPv6 /64 has 2^64
 *                 addresses, and residential proxies are sold by the hour.
 *   recipient     refuse anyone who already holds enough. Bypass: sweep the
 *   balance       drip to a cold address between requests.
 *   GLOBAL CAP    no bypass. However many addresses, however many IPs, however
 *                 fast, the faucet pays out at most `capWei` per rolling
 *                 window and then refuses everyone until the window rolls.
 *
 * The global cap is the one that means anything. The other three exist so that
 * an honest user is never the one who trips it.
 *
 * ATOMICITY. `reserve()` performs every check AND records the spend in one
 * synchronous block, with no `await` anywhere inside it. That is what makes it
 * safe on Node's single thread: two simultaneous requests for the same address
 * cannot both pass the check before either records. Splitting this into
 * "check" and later "record" — with the broadcast in between — is the classic
 * faucet drain, and it looks completely correct in review.
 *
 * `release()` exists for the one case where the spend did not happen: the
 * broadcast itself failed. It is deliberately NOT called when a transaction is
 * broadcast and then does not confirm, because that transaction may yet be
 * mined and the EMBER is genuinely gone.
 */

const fs = require('fs');
const path = require('path');

class Limits {
  /**
   * @param {object} o
   * @param {number} o.addressCooldownS  seconds between drips to one address
   * @param {number} o.ipLimit           drips per IP per window
   * @param {number} o.ipWindowS
   * @param {bigint} o.capWei            global payout ceiling per window
   * @param {number} o.windowS
   * @param {string|null} o.statePath    where to persist; null = memory only
   */
  constructor(o) {
    this.addressCooldownS = o.addressCooldownS;
    this.ipLimit = o.ipLimit;
    this.ipWindowS = o.ipWindowS;
    this.capWei = o.capWei;
    this.windowS = o.windowS;
    this.statePath = o.statePath || null;

    /** address (lowercase) -> unix seconds of the last drip */
    this.addresses = new Map();
    /** ip -> array of unix seconds */
    this.ips = new Map();
    /** [{ at: seconds, wei: bigint }] inside the rolling window */
    this.spends = [];

    this._dirty = false;
    this._timer = null;
    this.load();
  }

  now() { return Math.floor(Date.now() / 1000); }

  /** Total paid out inside the rolling window. */
  spentWei(now = this.now()) {
    const cutoff = now - this.windowS;
    let total = 0n;
    for (const s of this.spends) if (s.at > cutoff) total += s.wei;
    return total;
  }

  remainingWei(now = this.now()) {
    const left = this.capWei - this.spentWei(now);
    return left > 0n ? left : 0n;
  }

  /**
   * Take a slot, or say why not. SYNCHRONOUS AND ALL-OR-NOTHING — see the
   * atomicity note above.
   *
   * @returns {{ok: true} | {ok: false, reason: string, retryAfterS: number, status: number}}
   */
  reserve(address, ip, wei) {
    const now = this.now();
    const key = address.toLowerCase();

    const last = this.addresses.get(key);
    if (last !== undefined && now - last < this.addressCooldownS) {
      const retryAfterS = this.addressCooldownS - (now - last);
      return {
        ok: false,
        status: 429,
        reason: `this address was funded ${now - last}s ago; one drip per ${this.addressCooldownS}s`,
        retryAfterS,
      };
    }

    const hits = (this.ips.get(ip) || []).filter(t => now - t < this.ipWindowS);
    if (hits.length >= this.ipLimit) {
      const oldest = Math.min(...hits);
      return {
        ok: false,
        status: 429,
        reason: `this source has taken ${hits.length} drips; the limit is ${this.ipLimit} per ${this.ipWindowS}s`,
        retryAfterS: this.ipWindowS - (now - oldest),
      };
    }

    const remaining = this.remainingWei(now);
    if (wei > remaining) {
      /* Note the wording. The faucet is not dry — it is rate limited in
       * aggregate, which is a different thing and a different fix, and telling
       * an operator "dry" when the balance is fine wastes an hour. */
      const oldest = this.spends.length ? Math.min(...this.spends.map(s => s.at)) : now;
      return {
        ok: false,
        status: 429,
        reason: 'the faucet has reached its payout cap for this window',
        retryAfterS: Math.max(1, this.windowS - (now - oldest)),
      };
    }

    // Record. No await above this line, and none between here and the return.
    this.addresses.set(key, now);
    hits.push(now);
    this.ips.set(ip, hits);
    this.spends.push({ at: now, wei });
    this._prune(now);
    this._save();
    return { ok: true };
  }

  /** Undo a reservation. Only for a broadcast that never left the building. */
  release(address, ip, wei) {
    const key = address.toLowerCase();
    this.addresses.delete(key);
    const hits = this.ips.get(ip) || [];
    hits.pop();
    if (hits.length) this.ips.set(ip, hits); else this.ips.delete(ip);
    for (let i = this.spends.length - 1; i >= 0; i--) {
      if (this.spends[i].wei === wei) { this.spends.splice(i, 1); break; }
    }
    this._save();
  }

  _prune(now) {
    const cutoff = now - this.windowS;
    this.spends = this.spends.filter(s => s.at > cutoff);
    for (const [k, t] of this.addresses) if (now - t >= this.addressCooldownS) this.addresses.delete(k);
    for (const [k, arr] of this.ips) {
      const kept = arr.filter(t => now - t < this.ipWindowS);
      if (kept.length) this.ips.set(k, kept); else this.ips.delete(k);
    }
  }

  // ---- persistence ---------------------------------------------------------

  /* Without this, "restart the faucet" is "reset every limit", and a restart
   * happens on every deploy — and on every crash, which an attacker may be
   * able to cause. A JSON file is enough at faucet scale and adds no
   * dependency. */

  load() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.addresses = new Map(raw.addresses || []);
      this.ips = new Map(raw.ips || []);
      this.spends = (raw.spends || []).map(s => ({ at: s.at, wei: BigInt(s.wei) }));
      this._prune(this.now());
    } catch {
      // A corrupt state file must not stop the faucet, but it must not silently
      // grant everyone a fresh allowance either — so start empty and say so.
      process.stderr.write(`faucet: ${this.statePath} is unreadable; starting with empty limits\n`);
    }
  }

  _save() {
    if (!this.statePath) return;
    this._dirty = true;
    if (this._timer) return;
    // Debounced: a burst of requests writes once, and the write is atomic so a
    // crash mid-write cannot leave a half file that reads as "no limits".
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._dirty) return;
      this._dirty = false;
      this.flush();
    }, 1000);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (!this.statePath) return;
    const body = JSON.stringify({
      addresses: [...this.addresses],
      ips: [...this.ips],
      spends: this.spends.map(s => ({ at: s.at, wei: s.wei.toString() })),
    });
    const tmp = this.statePath + '.tmp';
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this.statePath);
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._dirty) this.flush();
  }
}

module.exports = { Limits };
