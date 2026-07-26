'use strict';
/* Homefire proof-of-work for hearthd.
 *  - memory-hard: fill & random-walk a scratchpad (ASIC-hostile, CPU-fair)
 *  - non-outsourceable: the winning digest must be signed by the coinbase key
 * Sizes come from params (dev-tuned for a lively local chain). */

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
