'use strict';
/* Homefire proof-of-work for hearthd.
 *  - memory-hard: fill & random-walk a scratchpad (ASIC-hostile, CPU-fair)
 *  - the winning digest must be signed by the coinbase key, so work handed to a
 *    hasher cannot be redirected: the block pays whoever signed the proof
 * Sizes come from params (dev-tuned for a lively local chain).
 *
 * This is NOT a non-outsourceable puzzle, and the file used to say it was.
 * `powSeed` binds only the coinbase PUBLIC key; the private half is used once,
 * after a nonce has already won (miner.js). So a pool operator can distribute
 * coreHash together with its OWN pubkey, collect (nonce, digest) pairs from
 * hashers who genuinely cannot steal the reward, and sign the blocks itself.
 * Making that impossible means putting the private key inside the hash loop —
 * a consensus change that forks the chain and breaks the browser miner, so it
 * is a deliberate open item rather than an oversight. See docs/mining.md. */

const crypto = require('crypto');
const P = require('./params');

function h(...parts) {
  const s = crypto.createHash('sha256');
  for (const p of parts) s.update(Buffer.isBuffer(p) ? p : Buffer.from(String(p)));
  return s.digest();
}

const WORDS = (P.POW_SCRATCH_KIB * 1024) / 8;

/** Memory-hard hash: derive digest from the whole scratchpad. */
function homefireHash(seedBuf) {
  const pad = Buffer.allocUnsafe(WORDS * 8);
  let cur = h(seedBuf);
  for (let i = 0; i < WORDS; i++) { cur = h(cur); cur.copy(pad, i * 8, 0, 8); }
  let acc = h(seedBuf, pad.subarray(0, 64));
  for (let s = 0; s < P.POW_WALK_STEPS; s++) {
    const idx = acc.readUInt32LE(0) % WORDS;
    const off = idx * 8;
    const word = pad.readBigUInt64LE(off);
    acc = h(acc, pad.subarray(off, off + 8));
    pad.writeBigUInt64LE((word ^ acc.readBigUInt64LE(0)) & 0xffffffffffffffffn, off);
  }
  return h(acc, pad.subarray((WORDS - 8) * 8));
}

/** seed binds the header core, the nonce, and the coinbase pubkey together. */
function powSeed(headerCoreHash, nonce, coinbasePubHex) {
  return h(headerCoreHash, String(nonce), coinbasePubHex);
}

function meetsTarget(digestHex, targetHex) {
  return BigInt('0x' + digestHex) <= BigInt('0x' + targetHex);
}

module.exports = { homefireHash, powSeed, meetsTarget, h };
