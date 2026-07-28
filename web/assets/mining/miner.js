/* The browser miner: a pool of workers, a template, and the one signature that
 * makes the reward yours.
 *
 * The winning digest has to be signed by the key the coinbase pays. So this
 * file, and not the node, holds the key: the node hands out a candidate that
 * pays whoever asked for it, and if you ask with someone else's public key you
 * have just mined them a block. Work handed to you cannot be redirected — which
 * is a different and weaker property than non-outsourceability, because the
 * private key never enters the hash loop. See docs/mining.md.
 *
 * The private key never leaves this page. It is not sent on submit — only the
 * signature over the digest is.
 *
 * ---------------------------------------------------------------------------
 * THE CURVE CHANGED, AND THE HASHING DID NOT (docs/evm-spec.md §4).
 *
 * Homefire is untouched: the pad fill, the walk, the digest and the target
 * comparison are exactly what they were, they still live in homefire.js and
 * worker.js, and node/test/browser-pow.js still checks them digest for digest
 * against the node. Nothing in this file's hash loop moved.
 *
 * What moved is the key the proof BINDS. The coinbase has to receive the block
 * reward and the fees, so it must be an account the account-model chain can
 * credit — which means a secp256k1 key and a 0x address, not an Ed25519 key and
 * an ember1 one. So `coinbasePub` is now the uncompressed secp256k1 public key
 * and the proof signature is ECDSA over the same digest bytes.
 *
 * There is exactly one secp256k1 implementation in this front-end — the wallet's
 * port of node/src/crypto/secp256k1.js, cross-checked against it over hundreds
 * of random keys in assets/wallet-selftest.js. Two independent browser ports of
 * one curve is how they drift apart, so this file imports that one rather than
 * carrying its own.
 *
 * THE WIRE FORMAT THIS ASSUMES, which phase 5 owns and had not landed when this
 * was written. `powSig` is r || s, 32 bytes each, 128 lowercase hex characters,
 * with s in the low half of the group order (EIP-2). No recovery id: the header
 * already carries `coinbasePub`, so the verifier has the key and does not need
 * to recover it. If phase 5 chooses a 65-byte recoverable form instead, this is
 * the one line to change — `POW_SIG_FORM` below names it.
 * ---------------------------------------------------------------------------
 */

import { sign as secpSign, bigToBuf32 } from '../wallet/secp256k1.js';

/** Named so a mismatch with the node is a grep, not an investigation. */
export const POW_SIG_FORM = 'secp256k1-r||s-64-lowS';

const DEFAULT_WORKERS = () => Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

export class Miner extends EventTarget {
  /**
   * @param {{rpc: string,
   *          key: {priv: Uint8Array, pubHex: string, address: string}}} opts
   *   `key` is what assets/wallet/keystore.js hands back: a 32-byte secp256k1
   *   private key, the uncompressed public key as 0x-hex, and the EIP-55 address.
   */
  constructor({ rpc, key, workers, duty = 0.6, pauseOnBattery = true }) {
    super();
    this.rpc = rpc.replace(/\/$/, '');
    this.key = key;
    if (!(key && key.priv instanceof Uint8Array && key.priv.length === 32)) {
      // Better here than three hundred hashes later, at submit time, on the one
      // block this machine will find all week.
      throw new Error('miner: needs a 32-byte secp256k1 private key — an Ed25519 key from the '
        + 'pre-EVM wallet cannot sign a proof this chain accepts');
    }
    // The template endpoint takes bare hex, as it always has.
    this.pubParam = String(key.pubHex || '').replace(/^0x/, '');
    this.workerCount = workers || DEFAULT_WORKERS();
    this.duty = duty;
    this.pauseOnBattery = pauseOnBattery;
    this.onPower = true;                     // assume mains until told otherwise
    this.powerKnown = false;                 // …and say so, rather than implying we checked
    this._battery = null;
    this.workers = [];
    this.running = false;
    this.template = null;
    this.hashes = 0;
    this.hashrate = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.stale = 0;
    this._samples = [];
    this._sse = null;
    this._refreshTimer = null;
    this._visibility = () => this._applyDuty();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    if (this.running) return;
    this.running = true;
    this.emit('state', { running: true });
    document.addEventListener('visibilitychange', this._visibility);
    await this._watchPower();
    await this._refresh();
    // The tip moving invalidates every in-flight nonce, so follow new blocks
    // rather than polling on a timer we would have to keep short to be useful.
    this._sse = new EventSource(`${this.rpc}/events`);
    this._sse.onmessage = () => this._refresh().catch(() => {});
    // Templates expire; refresh well inside that even if no block arrives.
    this._refreshTimer = setInterval(() => this._refresh().catch(() => {}), 45_000);
  }

  stop() {
    this.running = false;
    for (const w of this.workers) { w.postMessage({ type: 'stop' }); w.terminate(); }
    this.workers = [];
    if (this._sse) { this._sse.close(); this._sse = null; }
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    if (this._battery && this._onCharging) this._battery.removeEventListener('chargingchange', this._onCharging);
    document.removeEventListener('visibilitychange', this._visibility);
    this.hashrate = 0;
    this.emit('state', { running: false });
  }

  setDuty(d) { this.duty = d; this._applyDuty(); }

  setPauseOnBattery(on) { this.pauseOnBattery = !!on; this._applyDuty(); }

  /**
   * Watch mains power, where the browser will tell us.
   *
   * The Battery Status API is Chromium-only — Firefox and Safari removed it as a
   * fingerprinting surface. Where it is missing this stays `powerKnown: false`
   * and mining runs normally, which is why the UI has to say which of the two it
   * got rather than promising power-awareness everywhere.
   *
   * A machine with no battery reports `charging: true`, which is the answer we
   * want for a desktop.
   */
  async _watchPower() {
    if (typeof navigator.getBattery !== 'function') {
      this.emit('power', { onPower: true, known: false });
      return;
    }
    try { this._battery = await navigator.getBattery(); }
    catch { this.emit('power', { onPower: true, known: false }); return; }
    this._onCharging = () => {
      this.onPower = this._battery.charging;
      this._applyDuty();
      this.emit('power', { onPower: this.onPower, known: true, level: this._battery.level });
    };
    this._battery.addEventListener('chargingchange', this._onCharging);
    this.powerKnown = true;
    this._onCharging();
  }

  /**
   * Politeness, decided in one place.
   *
   *   - Unplugged: stop. A miner that quietly drains someone's laptop is the
   *     behaviour that makes browser mining a dirty word, and the reward from a
   *     few minutes on battery is not worth the trade.
   *   - Background tab: a trickle. The browser throttles timers there anyway,
   *     so fighting it just burns power for very little hashing.
   *
   * There is deliberately no "machine is idle" term. A web page cannot see
   * whether someone is at the keyboard — `requestIdleCallback` means "this tab's
   * event loop is quiet", which is always true for a page that is only mining,
   * and the Idle Detection API is permission-gated and Chromium-only.
   * `document.hidden` is the strongest honest signal available here.
   */
  effectiveDuty() {
    if (this.pauseOnBattery && this.powerKnown && !this.onPower) return 0;
    return document.hidden ? Math.min(this.duty, 0.15) : this.duty;
  }

  _applyDuty() {
    const effective = this.effectiveDuty();
    for (const w of this.workers) w.postMessage({ type: 'tune', duty: effective });
    this.emit('duty', {
      duty: this.duty, effective, hidden: document.hidden,
      onPower: this.onPower, powerKnown: this.powerKnown,
    });
  }

  async _refresh() {
    if (!this.running) return;
    const r = await fetch(`${this.rpc}/mining/template?pub=${this.pubParam}`);
    if (!r.ok) throw new Error('template ' + r.status);
    const t = await r.json();
    // Same height AND same parent means nothing we are working on changed.
    if (this.template && this.template.coreHash === t.coreHash) return;
    this.template = t;
    this.emit('template', t);
    this._dispatch();
  }

  _dispatch() {
    if (!this.workers.length) this._spawn();
    const t = this.template;
    const effective = this.effectiveDuty();
    this.workers.forEach((w, i) => {
      w.postMessage({ type: 'tune', duty: effective });
      w.postMessage({
        type: 'job',
        coreHash: t.coreHash,
        coinbasePub: t.coinbasePub,
        target: t.target,
        templateId: t.templateId,
        scratchKiB: t.scratchKiB,
        walkSteps: t.walkSteps,
        // Disjoint arithmetic progressions: no two workers ever try one nonce
        // twice, with no shared counter to synchronise.
        startNonce: i,
        stride: this.workers.length,
      });
    });
  }

  _spawn() {
    for (let i = 0; i < this.workerCount; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onWorker(e.data);
      this.workers.push(w);
    }
    this._meter();
  }

  _onWorker(m) {
    if (m.type === 'progress') {
      this.hashes += m.hashes;
      this._samples.push({ at: performance.now(), n: m.hashes });
    } else if (m.type === 'solved') {
      this._submit(m).catch(err => this.emit('error', { message: String(err && err.message || err) }));
    }
  }

  /** Rolling 10-second window, so the number settles quickly but does not jump. */
  _meter() {
    const tick = () => {
      if (!this.running) return;
      const cut = performance.now() - 10_000;
      this._samples = this._samples.filter(s => s.at >= cut);
      const n = this._samples.reduce((a, s) => a + s.n, 0);
      const span = this._samples.length ? (performance.now() - this._samples[0].at) / 1000 : 0;
      this.hashrate = span > 0.5 ? n / span : 0;
      this.emit('hashrate', { hashrate: this.hashrate, total: this.hashes });
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  }

  async _submit({ templateId, nonce, digest }) {
    /* The one place the key is used. The digest is 32 bytes, which is exactly an
     * ECDSA message hash, so it is signed as-is rather than hashed again — the
     * node verifies over the same bytes it handed out. RFC 6979 makes the nonce
     * deterministic, so re-signing the same digest is idempotent and a tab that
     * has been open all week never risks a repeated k. */
    const sig = secpSign(hexToBytes(digest), this.key.priv);
    const powSig = toHex(bigToBuf32(sig.r)) + toHex(bigToBuf32(sig.s));   // see POW_SIG_FORM

    const res = await fetch(`${this.rpc}/mining/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId, nonce, powDigest: digest, powSig }),
    });
    const out = await res.json().catch(() => ({}));

    if (res.ok && out.ok) {
      this.accepted++;
      this.emit('accepted', { height: out.height, id: out.id, reward: out.reward });
    } else if (res.status === 409 || out.stale) {
      // Someone else found this height first. Expected, not an error.
      this.stale++;
      this.emit('stale', { templateId });
    } else {
      this.rejected++;
      this.emit('rejected', { err: out.err || `http ${res.status}` });
    }
    await this._refresh();
    this._dispatch();
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
