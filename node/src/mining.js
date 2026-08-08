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
const { RetiredTemplates } = require('./retiredtemplates');

/** Enough for a browser to keep working across a couple of blocks. */
const TTL_MS = 120_000;
/** Bounded so an unauthenticated caller cannot grow this without limit. */
const MAX_TEMPLATES = 256;

class Templates {
  constructor(node) {
    this.node = node;
    this.byId = new Map(); // id -> { header, txs, createdAt, prevHash }
    /* Ids only, for the templates this map no longer holds, so that a miner whose
     * work merely aged out or was pushed out is told to refetch (409) rather than
     * told its proof is malformed (400). retiredtemplates.js has the whole
     * argument, including what it deliberately cannot tell apart. */
    this.retired = new RetiredTemplates({ ttlMs: TTL_MS, maxTemplates: MAX_TEMPLATES });
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

  /** Drop a template from the live map and remember the id, and why it went. */
  _retire(id, reason, now = Date.now()) {
    this.byId.delete(id);
    return this.retired.retire(id, reason, now);
  }

  _evict() {
    const now = Date.now();
    for (const [id, t] of this.byId) {
      if (now - t.createdAt > TTL_MS) this._retire(id, 'expired', now);
    }
    while (this.byId.size >= MAX_TEMPLATES) {
      this._retire(this.byId.keys().next().value, 'evicted', now); // oldest first: Map keeps insertion order
    }
    this.retired.sweep(now);
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
    const now = Date.now();
    const t = this.byId.get(templateId);
    /* An id this map does not hold is NOT automatically a bad request. It is one
     * of three different facts, and `retired` is what keeps them apart: expired,
     * evicted, or genuinely never issued. The first two are 409 and mean "refetch";
     * only the third is 400. See retiredtemplates.js. */
    if (!t) return this.retired.answerFor(templateId, now);

    /* TTL is enforced HERE as well as in `_evict`, which only runs when somebody
     * asks for new work. Without this, a node nobody is asking for templates from
     * accepts a template long past the `expiresAt` it published with it — the
     * endpoint contradicting its own advertised lifetime — and, worse for the bug
     * this file is fixing, whether a late submission answers 409 or 200 depends on
     * whether an unrelated third party happened to call `/mining/template` in the
     * meantime. Expiry has to be a property of the template, not of the traffic. */
    if (now - t.createdAt > TTL_MS) return this._retire(templateId, 'expired', now);

    if (!Number.isInteger(nonce) || nonce < 0) return { ok: false, err: 'bad nonce' };
    if (typeof powDigest !== 'string' || !/^[0-9a-f]{64}$/.test(powDigest)) return { ok: false, err: 'bad digest' };
    if (typeof powSig !== 'string' || !/^[0-9a-f]+$/.test(powSig)) return { ok: false, err: 'bad signature' };

    // Stale work: the tip moved on. Say so precisely — a miner needs to tell
    // "you were too slow" apart from "your proof is wrong".
    //
    // Retired rather than merely deleted. This branch used to `delete` the id and
    // return the 409 inline, which was right exactly once: a miner that retried
    // the same template — and mine/session.js and the browser miner both refresh
    // and can resubmit — fell through to the unknown-id path on the second
    // attempt and got 400 for the same template that had just correctly been
    // called stale.
    if (t.prevHash !== BLOCK.blockId(this.node.chain.tip)) {
      return this._retire(templateId, 'superseded', now);
    }

    const header = { ...t.header, nonce, powDigest, powSig };
    const block = { header, txs: t.txs };

    const pow = BLOCK.verifyPow(block);
    if (!pow.ok) return { ok: false, err: pow.err };

    const r = this.node.chain.addBlock(block);
    if (!r.ok) return r;
    /* Retired, not just deleted, for the same reason as the branch above: a miner
     * that resends a winning proof — a retry over a connection that dropped after
     * the node had already accepted it — must be told the tip moved, which it did,
     * and by this very block. It used to be told its proof was malformed. */
    this._retire(templateId, 'superseded', now);
    this.node.mempool.removeIncluded(block.txs.slice(1));
    if (this.node.p2p) this.node.p2p.broadcast({ t: 'block', block });
    return { ok: true, id: r.id, height: header.height, reward: t.txs[0].outputs[0].amount };
  }
}

module.exports = { Templates, TTL_MS, MAX_TEMPLATES };
