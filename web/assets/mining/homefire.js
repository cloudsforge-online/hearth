/* Homefire proof-of-work, in the browser.
 *
 * A line-for-line port of node/src/pow.js. It has to be exactly that: a digest
 * that differs from the node's in one bit is a share the chain rejects, and the
 * miner would look like it was working while producing nothing.
 * node/test/browser-pow.js runs this file against the node's own implementation
 * and fails on any divergence.
 *
 * Two deliberate differences from the node, neither of them observable:
 *
 *  1. The scratchpad is allocated once per Miner, not once per attempt. The node
 *     allocates 64 KiB per hash and lets the GC deal with it; at browser hash
 *     rates that is the dominant cost.
 *  2. The node's 64-bit read/xor/write (`readBigUInt64LE` → xor → `writeBigUInt64LE`)
 *     is done byte-wise. XOR distributes over bytes, and both sides are
 *     little-endian, so `pad[off+i] ^= acc[i]` is identical — without a BigInt
 *     allocation in the innermost loop.
 */

import { Sha256, toHex, utf8 } from './sha256.js';

export class Homefire {
  /** `scratchKiB` and `walkSteps` come from the node's template, never from a
   *  constant here — if consensus retunes them, a stale miner must stop
   *  producing valid work rather than quietly produce invalid work. */
  constructor(scratchKiB, walkSteps) {
    this.words = (scratchKiB * 1024) / 8;
    this.steps = walkSteps;
    this.pad = new Uint8Array(this.words * 8);
    this.cur = new Uint8Array(32);
    this.acc = new Uint8Array(32);
    this.out = new Uint8Array(32);
    this.h = new Sha256();
  }

  /** homefireHash(seed) — the memory-hard digest. Returns a 32-byte view that
   *  is REUSED on the next call; copy it if you need to keep it. */
  hash(seed) {
    const { pad, cur, acc, out, h, words, steps } = this;

    // fill: cur = h(seed); then cur = h(cur), taking 8 bytes of each into the pad
    h.reset().update(seed).digestInto(cur);
    for (let i = 0; i < words; i++) {
      h.reset().update(cur).digestInto(cur);
      pad[i * 8] = cur[0]; pad[i * 8 + 1] = cur[1]; pad[i * 8 + 2] = cur[2]; pad[i * 8 + 3] = cur[3];
      pad[i * 8 + 4] = cur[4]; pad[i * 8 + 5] = cur[5]; pad[i * 8 + 6] = cur[6]; pad[i * 8 + 7] = cur[7];
    }

    // acc = h(seed, pad[0..64])
    h.reset().update(seed).update(pad.subarray(0, 64)).digestInto(acc);

    // walk: index by the accumulator, mix the visited word back in
    for (let s = 0; s < steps; s++) {
      const off = accIndex(acc, words) * 8;
      h.reset().update(acc).update(pad.subarray(off, off + 8)).digestInto(acc);
      pad[off] ^= acc[0]; pad[off + 1] ^= acc[1]; pad[off + 2] ^= acc[2]; pad[off + 3] ^= acc[3];
      pad[off + 4] ^= acc[4]; pad[off + 5] ^= acc[5]; pad[off + 6] ^= acc[6]; pad[off + 7] ^= acc[7];
    }

    // h(acc, last 64 bytes of the pad)
    h.reset().update(acc).update(pad.subarray((words - 8) * 8)).digestInto(out);
    return out;
  }
}

/** `acc.readUInt32LE(0) % words` — the node's index derivation. */
function accIndex(acc, words) {
  const lo = (acc[0] | (acc[1] << 8) | (acc[2] << 16) | (acc[3] << 24)) >>> 0;
  return lo % words;
}

/** powSeed(coreHash, nonce, coinbasePub) — every part is hashed as UTF-8 text,
 *  exactly as the node does: it passes hex STRINGS, not the bytes they encode. */
export function powSeed(h, coreHashHex, nonce, coinbasePubHex) {
  return h.reset()
    .update(utf8(coreHashHex))
    .update(utf8(String(nonce)))
    .update(utf8(coinbasePubHex))
    .digest();
}

/** digest <= target, compared as 256-bit big-endian. Byte-wise, so no BigInt. */
export function meetsTarget(digest, targetBytes) {
  for (let i = 0; i < 32; i++) {
    if (digest[i] !== targetBytes[i]) return digest[i] < targetBytes[i];
  }
  return true; // equal counts as meeting it
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export { toHex };
