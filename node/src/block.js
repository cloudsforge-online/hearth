'use strict';
/* Block structure + PoW binding.
 * A block = { header, txs }. The header's "core" is what PoW commits to; the
 * nonce/digest/signature are the proof. The first tx must be the coinbase whose
 * reward address matches the coinbase pubkey, so a winning proof can only be
 * redeemed by the key it was issued to. (That is not non-outsourceability —
 * see the note at the top of pow.js.) */

const C = require('./crypto');
const POW = require('./pow');
const TX = require('./tx');

function headerCore(header) {
  return {
    version: header.version,
    prevHash: header.prevHash,
    merkleRoot: header.merkleRoot,
    height: header.height,
    timestamp: header.timestamp,
    target: header.target,
    coinbasePub: header.coinbasePub,
  };
}

function coreHash(header) {
  return C.hashObject(headerCore(header));
}

/** The canonical block id commits to the core + the proof. */
function blockId(block) {
  return C.hashObject({
    core: headerCore(block.header),
    nonce: block.header.nonce,
    powDigest: block.header.powDigest,
  });
}

/** Fully verify a block's proof-of-work and its coinbase-key signature. */
function verifyPow(block) {
  const hdr = block.header;
  const seed = POW.powSeed(coreHash(hdr), hdr.nonce, hdr.coinbasePub);
  const digest = POW.homefireHash(seed).toString('hex');
  if (digest !== hdr.powDigest) return { ok: false, err: 'pow digest mismatch' };
  if (!POW.meetsTarget(digest, hdr.target)) return { ok: false, err: 'pow does not meet target' };
  if (!C.verify(hdr.coinbasePub, Buffer.from(digest, 'hex'), hdr.powSig))
    return { ok: false, err: 'pow signature invalid' };
  // the coinbase reward must pay the signer, so nobody can redeem someone
  // else's winning digest
  const cb = block.txs[0];
  if (!cb || cb.type !== 'coinbase') return { ok: false, err: 'missing coinbase' };
  if (cb.outputs[0].address !== C.addressFromPub(hdr.coinbasePub))
    return { ok: false, err: 'coinbase reward not paid to miner key' };
  // merkle must match the txs
  const mr = C.merkleRoot(block.txs.map(t => t.id));
  if (mr !== hdr.merkleRoot) return { ok: false, err: 'merkle root mismatch' };
  return { ok: true, id: blockId(block) };
}

module.exports = { headerCore, coreHash, blockId, verifyPow };
