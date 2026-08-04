'use strict';
/* Block production on the account model, and work for miners outside this process.
 *
 * The loop is the UTXO miner's, unchanged in shape and for the same reason: nonces
 * are searched in batches on a `setImmediate` loop so the event loop never blocks,
 * with a duty-cycle throttle for polite mining (../miner.js:96-129).
 *
 * WHAT IS DIFFERENT IS WHAT A CANDIDATE COSTS. On the UTXO chain, assembling a
 * candidate validates signatures against a copy of the UTXO set. Here it EXECUTES
 * every selected transaction — up to 30,000,000 gas of EVM — to learn the state
 * root the header must commit to. There is no cheaper way: the root is a function
 * of the execution and nothing else. So the candidate is memoized on
 * (tip, mempool version) exactly as ../miner.js:43-66 memoizes its selection, and
 * for a sharper version of the same reason: `/mining/template` is unauthenticated
 * and served under `access-control-allow-origin: *`, so without the memo any
 * stranger could buy a full block of execution per HTTP request.
 *
 * THE KEY IS secp256k1 NOW (spec §4). The coinbase has to receive the reward and
 * the fees, so it must be an account this chain can credit. Homefire is untouched
 * — same seed, same pad, same walk — and a remote miner still grinds nonces over a
 * `coreHash` and never executes anything. The remote miners are bin/hearth-mine.js
 * and app-desktop/, both driving src/mine/session.js; the browser miner that also
 * used this endpoint was deleted in 48bc28a, along with test/browser-pow.js.
 */

const crypto = require('crypto');

const P = require('../params');
const POW = require('../pow');
const HDR = require('./header');
const secp = require('../crypto/secp256k1');
const { SLICE_MS, schedule } = require('../minerloop');

/** Enough for a browser to keep working across a couple of blocks. */
const TEMPLATE_TTL_MS = 120_000;
/** Bounded, so an unauthenticated caller cannot grow the map without limit. */
const MAX_TEMPLATES = 256;

class Miner {
  constructor(node) {
    this.node = node;
    this.running = false;
    this.throttle = 1.0;
    this.hashes = 0;
    this.hashrate = 0;
    this._rateStart = 0;
    this._cand = null;                 // memoized candidate, see `candidateFor`
  }

  start() { if (!this.running) { this.running = true; this._rateStart = Date.now(); this._mineOne(); } }
  stop() { this.running = false; }

  /**
   * A candidate block whose coinbase pays whoever holds `coinbasePubHex`.
   *
   * Memoized on (tip, mempool version, coinbase key). The key is part of the memo
   * because the coinbase account is credited inside the candidate, so a candidate
   * built for one miner has a state root that is wrong for any other — which is
   * exactly the difference the UTXO chain did NOT have and is the easiest way to
   * produce a block that fails its own validation.
   */
  candidateFor(coinbasePubHex, { extraData = this.node.extraData || '' } = {}) {
    const { chain, mempool } = this.node;
    const key = `${chain.tipId}:${mempool.version}:${coinbasePubHex}:${extraData}`;
    if (this._cand && this._cand.key === key) return this._cand.val;

    const state = chain.stateAtTip();
    const selected = mempool.select({ state, gasLimit: chain.gasLimit });
    const cand = chain.buildCandidate({
      coinbasePub: coinbasePubHex,
      transactions: selected.map(e => e.raw),
      extraData,
    });
    cand.selected = selected;
    this._cand = { key, val: cand };
    return cand;
  }

  /** Seal a candidate with a winning nonce and the signature over its digest. */
  static seal(candidate, nonce, digestHex, privateKey) {
    const header = {
      ...candidate.header,
      nonce,
      mixHash: digestHex,
      powSig: HDR.signProof(digestHex, privateKey),
    };
    return { header, txs: candidate.txs };
  }

  _mineOne() {
    if (!this.running) return;
    const key = this.node.coinbaseKey;
    if (!key) return;
    const cand = this.candidateFor(key.publicKey.toString('hex'));
    const startHeight = cand.header.height;
    let nonce = 0;

    const step = () => {
      if (!this.running) return;
      if (this.node.chain.height + 1 !== startHeight) return this._mineOne();  // someone mined
      /* A TURN IS A SLICE OF WALL CLOCK, NOT A COUNT OF NONCES — see
       * ../minerloop.js. One nonce is one full Homefire evaluation, so a fixed
       * count is a variable and unbounded amount of blocked event loop, and on
       * this chain the loop is also carrying gossip, two HTTP servers and the
       * WebSocket keepalive. */
      const t0 = Date.now();
      do {
        const n = nonce++;
        const digest = POW.homefireHash(POW.powSeed(cand.coreHash, n, cand.header.coinbasePub)).toString('hex');
        this.hashes++;
        if (POW.meetsTarget(digest, cand.header.target)) {
          this.node.onMinedBlock(Miner.seal(cand, n, digest, key.privateKey), cand);
          return this._mineOne();
        }
      } while (Date.now() - t0 < SLICE_MS);
      const dt = (Date.now() - this._rateStart) / 1000;
      if (dt >= 1) { this.hashrate = Math.round(this.hashes / dt); this.hashes = 0; this._rateStart = Date.now(); }
      schedule(step, Date.now() - t0, this.throttle);
    };
    step();
  }
}

/**
 * Work for miners that are not this process.
 *
 * The node keeps the transactions; the miner gets the header core and a
 * `templateId`. Nothing in a submission is trusted except the three proof fields —
 * the core and the transactions come from the stored template, so a miner cannot
 * smuggle in a transaction, retarget, or repoint the coinbase. The chain
 * revalidates all of it regardless.
 */
class Templates {
  constructor(node) {
    this.node = node;
    this.byId = new Map();
  }

  issue(pubHex) {
    const pub = Buffer.from(String(pubHex).replace(/^0x/i, ''), 'hex');
    if (pub.length !== 65 || pub[0] !== 4) throw new Error('pub must be a 65-byte uncompressed secp256k1 key');
    if (secp.decodePoint(pub) === null) throw new Error('pub is not a point on secp256k1');
    const hex = pub.toString('hex');
    const cand = this.node.miner.candidateFor(hex);
    const id = crypto.randomBytes(16).toString('hex');
    this._evict();
    this.byId.set(id, { candidate: cand, createdAt: Date.now(), prevHash: cand.header.prevHash });
    return {
      templateId: id,
      height: cand.header.height,
      coreHash: cand.coreHash,
      target: cand.header.target,
      coinbasePub: hex,
      coinbaseAddress: '0x' + HDR.coinbaseAddress(hex).toString('hex'),
      prevHash: cand.header.prevHash,
      timestamp: cand.header.timestamp,
      stateRoot: cand.header.stateRoot,
      txRoot: cand.header.txRoot,
      txCount: cand.txs.length,
      gasUsed: Number(cand.gasUsed),
      /* THE REST OF THE CORE HEADER, so a miner can CHECK the work instead of
       * trusting it. `coreHash` above is the only thing a remote miner actually
       * grinds, and on its own it is an opaque 32 bytes: nothing tied it to the
       * `coinbasePub` alongside it, so an endpoint could advertise one coinbase
       * and issue work paying another. It could not have STOLEN a block that way
       * — the proof is signed by the coinbase key and `HDR.verifyPow` recovers it
       * — but the miner would have ground for hours and had every submission
       * refused, which is the same loss and much harder to diagnose.
       *
       * With these, `HDR.coreHash({...})` is recomputable from the response, and
       * bin/hearth-mine.js refuses any template whose core hash does not commit
       * to the fields it arrived with. They are exactly `coreFields` in
       * header.js; nothing here is secret, and all of it is in the block a
       * moment later. */
      version: cand.header.version,
      receiptsRoot: cand.header.receiptsRoot,
      logsBloom: cand.header.logsBloom,
      gasLimit: Number(cand.header.gasLimit),
      extraData: cand.header.extraData,
      /* The full subsidy for this height, in wei as a decimal string — JSON has no
       * integer wide enough for wei and a float would silently round it. */
      reward: P.subsidyWei(cand.header.height).toString(),
      /* …and what the COINBASE actually receives, which is not the same number:
       * 10% of every subsidy goes to the Commons (`_creditReward`). A remote
       * miner has no chain to check its balance against, so quoting it the full
       * subsidy means its running total is 10% higher than the coins it has —
       * a figure that never reconciles with a wallet and looks like theft.
       * Tips are not included: they are not known until the block is sealed. */
      coinbaseReward: P.coinbaseRewardWei(cand.header.height).toString(),
      /* Consensus parameters travel WITH the work: a miner that hardcodes them
       * keeps hashing happily after a retune and produces nothing valid, while one
       * that reads them here stops, which is the failure you want. */
      scratchKiB: P.POW_SCRATCH_KIB,
      walkSteps: P.POW_WALK_STEPS,
      expiresAt: Date.now() + TEMPLATE_TTL_MS,
    };
  }

  _evict() {
    const now = Date.now();
    for (const [id, t] of this.byId) if (now - t.createdAt > TEMPLATE_TTL_MS) this.byId.delete(id);
    while (this.byId.size >= MAX_TEMPLATES) this.byId.delete(this.byId.keys().next().value);
  }

  /**
   * `{ templateId, nonce, powDigest, powSig }`. `powSig` is 65 bytes of
   * `r || s || recoveryId` over the digest, made by the key the template was
   * issued to — which is what stops anyone else redeeming a winning proof.
   */
  submit({ templateId, nonce, powDigest, powSig }, budget = null) {
    const t = this.byId.get(templateId);
    if (!t) return { ok: false, err: 'unknown or expired template' };
    if (!Number.isInteger(nonce) || nonce < 0) return { ok: false, err: 'bad nonce' };
    if (typeof powDigest !== 'string' || !/^[0-9a-f]{64}$/.test(powDigest)) return { ok: false, err: 'bad digest' };
    if (typeof powSig !== 'string' || !/^[0-9a-f]{130}$/.test(powSig)) return { ok: false, err: 'bad signature' };

    /* Stale work is not a bad proof, and a miner has to be able to tell them
     * apart: one means "pull a fresh template", the other means "you have a bug". */
    if (t.prevHash !== this.node.chain.tipId) {
      this.byId.delete(templateId);
      return { ok: false, err: 'stale template — the tip moved', stale: true };
    }

    /* EVERYTHING ABOVE THIS LINE IS FREE, and that is why the budget is taken
     * here rather than at the door. `verifyPow` below is a FULL HOMEFIRE
     * EVALUATION — the same ~7 ms of a core src/p2p.js meters a gossip peer for,
     * now reached from an endpoint published to the open internet. An unknown
     * template, a stale one, a bad nonce or a malformed signature never gets
     * that far, so charging for them would throttle a miner whose template
     * merely expired: the node's timing, not the miner's behaviour.
     *
     * `budget` is optional so an in-process caller — and every existing suite —
     * is unmetered; the HTTP route in src/evmnode.js always passes one. */
    let token = null;
    if (budget) {
      token = budget.spend();
      if (!token) return { ok: false, err: 'over budget', throttled: true };
    }

    const block = { header: { ...t.candidate.header, nonce, mixHash: powDigest, powSig }, txs: t.candidate.txs };
    const pow = HDR.verifyPow(block.header);
    if (!pow.ok) return { ok: false, err: pow.err };

    const r = this.node.acceptOwnBlock(block);
    if (!r.ok) return r;
    /* The proof was real and the block extended the chain, so the evaluation was
     * not wasted — give the token back. This is the half of the rule that keeps
     * an honest miner off the limiter entirely, and it is the refund p2p.js
     * `_acceptFrom` makes for exactly the same reason. */
    if (token) token.refund();
    this.byId.delete(templateId);
    return {
      ok: true, id: r.id, height: block.header.height,
      reward: P.subsidyWei(block.header.height).toString(),
      coinbaseReward: P.coinbaseRewardWei(block.header.height).toString(),
    };
  }
}

module.exports = { Miner, Templates, TEMPLATE_TTL_MS, MAX_TEMPLATES };
