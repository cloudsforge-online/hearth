'use strict';
/*
 * Hearth — "Homefire" proof-of-work (reference proof-of-concept)
 * ---------------------------------------------------------------------------
 * This is a SMALL, READABLE model of the two ideas that make Hearth mineable
 * by people and not by farms. It is NOT the production algorithm (that is a
 * RandomX-class VM, see docs/mining.md). It exists so the concepts are
 * executable and testable. No external dependencies — Node's crypto only.
 *
 *   1. MEMORY-HARDNESS  — every attempt must fill and randomly walk a
 *      scratchpad in RAM. Compute-only ASICs gain little; the bottleneck is
 *      commodity memory bandwidth, which your laptop already has.
 *
 *   2. NON-OUTSOURCEABILITY — a valid solution must be SIGNED by the same key
 *      that receives the block reward. You cannot hand raw hashing to a pool
 *      operator without also handing them the power to steal your reward, so
 *      centralized pools (the thing that recentralizes PoW) don't form.
 */

const crypto = require('crypto');

const SCRATCH_KIB = 256;                 // toy size; production uses ~2 GiB
const SCRATCH_WORDS = (SCRATCH_KIB * 1024) / 8;
const WALK_STEPS = 4096;                 // random reads/writes per attempt

function h(...bufs) {
  const s = crypto.createHash('sha256');
  for (const b of bufs) s.update(b);
  return s.digest();
}

/**
 * Fill a scratchpad deterministically from a seed, then perform a
 * pseudo-random walk that reads and mutates it. The final digest depends on
 * the whole scratchpad, so you cannot shortcut it without the memory.
 */
function homefireHash(seed) {
  const pad = Buffer.allocUnsafe(SCRATCH_WORDS * 8);
  let cur = h(seed);
  for (let i = 0; i < SCRATCH_WORDS; i++) {
    // stretch the seed across the whole pad
    cur = h(cur);
    cur.copy(pad, i * 8, 0, 8);
  }
  let acc = h(seed, pad.subarray(0, 64));
  for (let step = 0; step < WALK_STEPS; step++) {
    const idx = acc.readUInt32LE(0) % SCRATCH_WORDS;
    const off = idx * 8;
    // read a word, mix it into the accumulator, write it back mutated
    const word = pad.readBigUInt64LE(off);
    acc = h(acc, pad.subarray(off, off + 8));
    pad.writeBigUInt64LE((word ^ acc.readBigUInt64LE(0)) & 0xffffffffffffffffn, off);
  }
  return h(acc, pad.subarray((SCRATCH_WORDS - 8) * 8));
}

function meetsTarget(digest, target) {
  return Buffer.compare(digest, target) < 0;
}

/** Difficulty (leading zero bits) -> 32-byte target. */
function bitsToTarget(bits) {
  const target = Buffer.alloc(32, 0xff);
  let b = bits;
  let i = 0;
  while (b >= 8) { target[i++] = 0x00; b -= 8; }
  if (i < 32) target[i] = 0xff >> b;
  return target;
}

/**
 * Attempt one nonce. `coinbaseKey` is an Ed25519 KeyObject pair. A solution
 * is only valid if it is signed by the coinbase key — this is the
 * non-outsourceable check.
 */
function attempt(headerBytes, nonce, coinbaseKey, target) {
  const nb = Buffer.alloc(8);
  nb.writeBigUInt64LE(BigInt(nonce));
  // The coinbase public key is committed inside the pre-image, binding the
  // puzzle to a specific reward recipient.
  const pub = coinbaseKey.publicKey.export({ type: 'spki', format: 'der' });
  const seed = h(headerBytes, nb, pub);
  const digest = homefireHash(seed);
  if (!meetsTarget(digest, target)) return null;

  const sig = crypto.sign(null, digest, coinbaseKey.privateKey);
  return { nonce, digest, sig, pub };
}

/** Anyone can verify without re-running the walk-signature dependency. */
function verify(headerBytes, sol, target) {
  const nb = Buffer.alloc(8);
  nb.writeBigUInt64LE(BigInt(sol.nonce));
  const seed = h(headerBytes, nb, sol.pub);
  const digest = homefireHash(seed);
  if (!digest.equals(sol.digest)) return false;
  if (!meetsTarget(digest, target)) return false;
  const pubKey = crypto.createPublicKey({ key: sol.pub, type: 'spki', format: 'der' });
  return crypto.verify(null, digest, pubKey, sol.sig);
}

module.exports = {
  homefireHash, attempt, verify, bitsToTarget, meetsTarget,
  SCRATCH_KIB, WALK_STEPS,
};
