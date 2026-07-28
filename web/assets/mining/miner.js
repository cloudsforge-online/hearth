/* The browser miner: a pool of workers, a template, and the one signature that
 * makes the reward yours.
 *
 * Homefire is non-outsourceable — the winning digest has to be Ed25519-signed by
 * the key the coinbase pays. So this file, and not the node, holds the key. The
 * node hands out a candidate that pays whoever asked for it; if you asked with
 * someone else's public key you have just mined them a block. There is no pool
 * to join and no operator to trust, because there is nothing an operator could
 * do with your work.
 *
 * The private key never leaves this page. It is not sent on submit — only the
 * signature over the digest is.
 */

import * as ed from '../vendor/noble-ed25519.js';
import { seedFromPem } from '../wallet-core.js';

const DEFAULT_WORKERS = () => Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

export class Miner extends EventTarget {
  /** @param {{rpc: string, key: {priv: string, pub: string, address: string}}} opts */
  constructor({ rpc, key, workers, duty = 0.6 }) {
    super();
    this.rpc = rpc.replace(/\/$/, '');
    this.key = key;
    this.seed = seedFromPem(key.priv);       // 32-byte hex, for signing
    this.workerCount = workers || DEFAULT_WORKERS();
    this.duty = duty;
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
    document.removeEventListener('visibilitychange', this._visibility);
    this.hashrate = 0;
    this.emit('state', { running: false });
  }

  setDuty(d) { this.duty = d; this._applyDuty(); }

  /** Background tabs are throttled by the browser anyway; drop to a trickle so
   *  we are not fighting it, and so a forgotten tab is not eating a battery. */
  _applyDuty() {
    const effective = document.hidden ? Math.min(this.duty, 0.15) : this.duty;
    for (const w of this.workers) w.postMessage({ type: 'tune', duty: effective });
    this.emit('duty', { duty: this.duty, effective });
  }

  async _refresh() {
    if (!this.running) return;
    const r = await fetch(`${this.rpc}/mining/template?pub=${this.key.pub}`);
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
    const effective = document.hidden ? Math.min(this.duty, 0.15) : this.duty;
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
    // The one place the key is used. Sign the digest bytes, exactly as the node
    // verifies them (block.js: C.verify(coinbasePub, Buffer.from(digest,'hex'), powSig)).
    const sig = await ed.signAsync(hexToBytes(digest), hexToBytes(this.seed));
    const powSig = toHex(sig);

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
