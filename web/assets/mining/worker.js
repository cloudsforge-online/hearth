/* One mining thread.
 *
 * Owns a 64 KiB scratchpad and grinds nonces over a fixed stride, so N workers
 * partition the nonce space without coordinating: worker i takes i, i+N, i+2N…
 * Nothing is shared and nothing is locked.
 *
 * The loop yields between batches. That is not politeness theatre — a Worker
 * that never yields cannot receive `postMessage`, so a stop or a new-block
 * signal would sit in the queue until the current run finished. Yielding is what
 * makes the miner interruptible.
 */

import { Sha256, toHex } from './sha256.js';
import { Homefire, powSeed, meetsTarget, hexToBytes } from './homefire.js';

let job = null;        // { coreHash, coinbasePub, targetBytes, templateId }
let hf = null;         // Homefire, rebuilt only when the params change
let params = null;     // "scratchKiB:walkSteps"
const h = new Sha256();

let nonce = 0, stride = 1, batch = 64, duty = 1;
let running = false, hashes = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'job') {
    const key = `${m.scratchKiB}:${m.walkSteps}`;
    // Reallocating a scratchpad per job would churn 64 KiB every block.
    if (key !== params) { hf = new Homefire(m.scratchKiB, m.walkSteps); params = key; }
    job = {
      coreHash: m.coreHash,
      coinbasePub: m.coinbasePub,
      targetBytes: hexToBytes(m.target),
      templateId: m.templateId,
    };
    nonce = m.startNonce;
    stride = m.stride;
    if (!running) { running = true; tick(); }
  } else if (m.type === 'tune') {
    duty = m.duty;
    batch = m.batch || batch;
  } else if (m.type === 'stop') {
    running = false;
    job = null;
  }
};

function tick() {
  if (!running || !job) { running = false; return; }
  // duty 0 is a real pause, not a slow trickle — it is what an unplugged laptop
  // gets. Keep the loop alive so a later `tune` resumes without a fresh job,
  // but do not hash a single nonce while it is set.
  if (duty <= 0) { setTimeout(tick, 500); return; }
  const started = performance.now();
  const { coreHash, coinbasePub, targetBytes, templateId } = job;

  for (let i = 0; i < batch; i++) {
    const digest = hf.hash(powSeed(h, coreHash, nonce, coinbasePub));
    if (meetsTarget(digest, targetBytes)) {
      // Copy: `hash()` reuses its output buffer for the next attempt.
      self.postMessage({
        type: 'solved', templateId, nonce, digest: toHex(digest.slice()),
      });
      running = false;
      job = null;
      return;
    }
    nonce += stride;
  }
  hashes += batch;
  const spent = performance.now() - started;
  self.postMessage({ type: 'progress', hashes: batch, ms: spent });
  hashes = 0;

  // Polite mining: at duty 0.35 we sleep ~2× as long as we worked, so the
  // machine stays usable and the fans stay quiet. At duty 1 we only yield.
  const rest = duty >= 1 ? 0 : Math.min(250, spent * (1 / duty - 1));
  if (rest > 1) setTimeout(tick, rest);
  else setTimeout(tick, 0);
}
