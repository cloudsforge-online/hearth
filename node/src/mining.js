'use strict';
/* Work for miners that are not this process — a browser tab, mostly.
 *
 * The winning digest must be Ed25519-signed by the coinbase key, and the
 * coinbase must pay that key (block.js). Two things follow, and they shape this
 * whole file:
 *
 *   1. A remote miner keeps its own private key. The node never sees it, and
 *      could not mine on that miner's behalf if it wanted to. There is no
 *      custody question here to get wrong.
 *   2. Work handed out here pays the asker, or it is worthless to them. So this
 *      is not a stratum server; it is one endpoint that hands out a candidate
 *      and one that takes the proof back.
 *
 * What that does NOT give us is non-outsourceability. Nothing stops a third
 * party running this exact protocol under its own key and paying hashers off
 * chain — the private key never enters the hash loop. See pow.js.
 *
 * The node keeps the transactions, not the miner. A template is ~a block of
 * JSON, and sending it twice per attempt would cost far more than the header
 * fields a miner actually needs. So `/mining/template` returns the header core
 * and a `templateId`, and `/mining/submit` posts the proof against that id.
 */

const crypto = require('crypto');
const P = require('./params');
const C = require('./crypto');
const BLOCK = require('./block');

/** Enough for a browser to keep working across a couple of blocks. */
const TTL_MS = 120_000;
/** Bounded so an unauthenticated caller cannot grow this without limit. */
const MAX_TEMPLATES = 256;

class Templates {
  constructor(node) {
    this.node = node;
    this.byId = new Map(); // id -> { header, txs, createdAt, prevHash }
  }

  /** Build a candidate whose coinbase pays `pubHex`, and remember its txs. */
  issue(pubHex) {
    const address = C.addressFromPub(pubHex);
    const cand = this.node.miner.candidateFor(pubHex, address);
    const id = crypto.randomBytes(16).toString('hex');
    this._evict();
    this.byId.set(id, {
      header: cand.header,
      txs: cand.txs,
      createdAt: Date.now(),
      prevHash: cand.header.prevHash,
    });
    return {
      templateId: id,
      height: cand.header.height,
      // What a miner hashes over. The header core is committed to by coreHash,
      // so a miner cannot change any of it without invalidating its own work.
      coreHash: cand.coreHash,
      target: cand.header.target,
      coinbasePub: pubHex,
      coinbaseAddress: address,
      prevHash: cand.header.prevHash,
      timestamp: cand.header.timestamp,
      merkleRoot: cand.header.merkleRoot,
      txCount: cand.txs.length,
      reward: cand.txs[0].outputs[0].amount,
      // Consensus parameters travel WITH the work. A miner that hardcodes these
      // keeps hashing happily after a retune and produces nothing valid; one
      // that reads them here stops, which is the failure you want.
      scratchKiB: P.POW_SCRATCH_KIB,
      walkSteps: P.POW_WALK_STEPS,
      expiresAt: Date.now() + TTL_MS,
    };
  }

  _evict() {
    const now = Date.now();
    for (const [id, t] of this.byId) {
      if (now - t.createdAt > TTL_MS) this.byId.delete(id);
    }
    while (this.byId.size >= MAX_TEMPLATES) {
      this.byId.delete(this.byId.keys().next().value); // oldest first: Map keeps insertion order
    }
  }

  /**
   * Reassemble a block from a stored template plus a submitted proof, and hand
   * it to the chain.
   *
   * Nothing here trusts the submission. The proof fields are the ONLY thing
   * taken from it — the header core and the transactions come from the template
   * the node built. A miner cannot smuggle a transaction in, retarget, or
   * repoint the coinbase, because none of that travels in the submit body. The
   * chain then revalidates all of it anyway.
   */
  submit({ templateId, nonce, powDigest, powSig }) {
    const t = this.byId.get(templateId);
    if (!t) return { ok: false, err: 'unknown or expired template' };
    if (!Number.isInteger(nonce) || nonce < 0) return { ok: false, err: 'bad nonce' };
    if (typeof powDigest !== 'string' || !/^[0-9a-f]{64}$/.test(powDigest)) return { ok: false, err: 'bad digest' };
    if (typeof powSig !== 'string' || !/^[0-9a-f]+$/.test(powSig)) return { ok: false, err: 'bad signature' };

    // Stale work: the tip moved on. Say so precisely — a miner needs to tell
    // "you were too slow" apart from "your proof is wrong".
    if (t.prevHash !== BLOCK.blockId(this.node.chain.tip)) {
      this.byId.delete(templateId);
      return { ok: false, err: 'stale template — the tip moved', stale: true };
    }

    const header = { ...t.header, nonce, powDigest, powSig };
    const block = { header, txs: t.txs };

    const pow = BLOCK.verifyPow(block);
    if (!pow.ok) return { ok: false, err: pow.err };

    const r = this.node.chain.addBlock(block);
    if (!r.ok) return r;
    this.byId.delete(templateId);
    this.node.mempool.removeIncluded(block.txs.slice(1));
    if (this.node.p2p) this.node.p2p.broadcast({ t: 'block', block });
    return { ok: true, id: r.id, height: header.height, reward: t.txs[0].outputs[0].amount };
  }
}

module.exports = { Templates, TTL_MS, MAX_TEMPLATES };
