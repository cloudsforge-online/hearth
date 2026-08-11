'use strict';
/* The account-model blockchain: storage, validation, fork choice and reorganisation.
 *
 * This is the file that turns a set of conformance-passing libraries into a chain.
 * Everything below it can be right in isolation and still not agree on a block.
 *
 * WHAT A BLOCK IS HERE
 *
 *   { header: <header v2, see header.js>, txs: [ '<hex raw signed RLP>', … ] }
 *
 * There is NO coinbase transaction. The reward is applied directly to the coinbase
 * account after the last transaction, which is what Ethereum does and what the
 * account model makes possible — and it is why an empty block is legal here and
 * was not on the UTXO chain. A validator that requires a first transaction rejects
 * every empty block on the network.
 *
 * THE ORDER OF VALIDATION IS A DoS PROPERTY, not a style choice, and it is the same
 * argument ../chain.js makes for the UTXO chain with one new and much sharper term:
 *
 *   header shape        a handful of comparisons
 *   difficulty target   a walk of at most 60 stored headers
 *   proof of work       one full Homefire evaluation, ~5 ms of a core
 *   THE STATE TRANSITION up to 30,000,000 gas of EVM execution — MILLISECONDS to
 *                       SECONDS, and thousands of times the cost of the proof
 *
 * So execution is last, and it is gated behind a proof the sender had to pay for.
 * Getting this order wrong is not a slow node, it is a node any stranger can stop
 * by sending a well-formed block with a bad nonce.
 *
 * STATE IS CONTENT-ADDRESSED, WHICH IS WHY A REORG IS CHEAP. Every block's state
 * lives in one append-only MemoryDB, and a block's `stateRoot` is a complete
 * description of the world at that block. Switching branches is therefore opening a
 * StateDB at a different root — not replaying from genesis, which is what the UTXO
 * chain must do (`_stateAt` there walks every block). It also means every historical
 * state is readable for free, so `eth_getBalance(addr, 12)` is exact rather than
 * approximate. The cost is that nothing is ever pruned; spec §9 puts pruning out of
 * scope for v1 and this is the shape that decision takes — which is precisely why
 * SPECULATIVE execution must not write here at all. See `speculativeStateAt`.
 *
 * WHAT IS COMMITTED. The header commits to `txRoot`, `stateRoot`, `receiptsRoot`,
 * `logsBloom` and `gasUsed`, and validation recomputes ALL FIVE from the
 * transactions rather than trusting any of them. A validator that recomputes the
 * state root but takes the bloom from the header serves an explorer logs that were
 * never emitted, and nothing ever errors.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const P = require('../params');
const HDR = require('./header');
const ST = require('./statetransition');
const bloom = require('./bloom');
const genesis = require('./genesis');
const { readLines, eachLine } = require('../lines');
const { StateDB, MemoryDB, OverlayDB } = require('../state/statedb');
const { keccak256 } = require('../crypto/keccak');

const BLOCKS_FILE = 'blocks.ndjson';

/** BLOCKHASH sees this far back, per the yellow paper. */
const BLOCKHASH_WINDOW = 256;

/* How long `open()` may hold the event loop, and how often it says where it has
 * got to — `REPLAY_YIELD_MS` and `REPLAY_PROGRESS_MS` in params.js, where the
 * measurements they were chosen from are written down. Both chains read them
 * from there: src/chain.js has the same replay and had the same defect. */

const hexBuf = h => Buffer.from(h, 'hex');

/** `err.code` on the refusal below, so a caller can present it without matching text. */
const GENESIS_NETWORK_MISMATCH = 'GENESIS_NETWORK_MISMATCH';

/** Render an extraData hex string as its text if it is printable ASCII, for a message. */
function readableExtraData(hex) {
  const s = Buffer.from(hex.slice(2), 'hex').toString('utf8');
  return /^[\x20-\x7e]*$/.test(s) ? `"${s}"` : hex;
}

/**
 * Refuse a persisted genesis that belongs to another network.
 *
 * params.js goes out of its way never to GUESS a chain id: an unregistered network
 * is a hard error and HEARTH_CHAIN_ID must be explicit, because "a node that
 * GUESSES its chain id signs transactions that are valid somewhere it did not
 * intend". But the id the chain actually runs on does not come from params — it
 * comes from `genesis.json`, and `genesis.loadOrCreate` returns whatever is on
 * disk. `eth_chainId`, the mempool's replay check and `_formatTx` all follow the
 * file, so that guard protected everything except the value it was guarding.
 *
 * A data directory written under one HEARTH_NETWORK and started under another
 * therefore advertises the id in the file while ForgeKeyvault, hardhat and every
 * wallet resolve the id of the network the operator asked for. The mild outcome is
 * that every signature is refused (`403 binding_mismatch`) with no obvious cause
 * and sweeps stall; the sharp one is a node that answers `eth_chainId` with
 * ANOTHER LIVE NETWORK's id, so a wallet that trusts it signs a transaction that is
 * byte-identical and valid over there — precisely the cross-net replay EIP-155
 * exists to prevent, and which docs/evm-spec.md §1 calls mandatory to stop.
 *
 * `extraData` is checked for the same reason one layer up. It names the network
 * inside the genesis header (see the long note in genesis.js), and that is what
 * stops a cheaply mined EMPTY testnet block — no transactions, therefore no chain
 * id anywhere in it — from being a structurally valid mainnet block. A directory
 * whose extraData names another network is not this network's chain, whatever its
 * chain id says.
 *
 * AN EXPLICIT OVERRIDE IS NOT A MISMATCH. Overrides already win over the file
 * (genesis.js `loadOrCreate` spreads them last), and a caller that passes
 * `chainId` or `extraData` has named the chain it means in the same breath as
 * asking for it — the devnet fixtures and the p2p suites do exactly that. Only the
 * default path, the one that takes the file's word for it, is refused.
 */
function assertGenesisMatchesNetwork(cfg, overrides, dataDir) {
  const named = k => overrides != null && Object.prototype.hasOwnProperty.call(overrides, k)
    && overrides[k] !== undefined && overrides[k] !== null;
  const where = dataDir ? ` in ${path.join(dataDir, genesis.GENESIS_FILE)}` : '';
  /* Both remedies are named because the right one depends on which side is wrong,
   * and the wrong guess is destructive: an operator who wipes a directory that was
   * merely mislabelled loses the chain. */
  const remedy = 'Start the node with HEARTH_NETWORK (or HEARTH_CHAIN_ID) set to the '
    + 'network this directory belongs to, or use a fresh data directory for this one. '
    + 'A node must never advertise a chain id it did not intend.';
  /* Tagged, not matched on its text: bin/hearthd.js prints this one cleanly and
   * exits 2 rather than dumping a stack, and must not swallow anything else. */
  const refuse = (msg) => {
    const e = new Error(`genesis: ${msg} ${remedy}`);
    e.code = GENESIS_NETWORK_MISMATCH;
    throw e;
  };

  if (!named('chainId') && cfg.chainId !== P.CHAIN_ID) {
    refuse(`chain id ${cfg.chainId}${where} disagrees with network "${P.NETWORK}", `
      + `whose chain id is ${P.CHAIN_ID}.`);
  }
  const expectedExtra = genesis.defaultConfig().extraData;
  if (!named('extraData') && cfg.extraData !== expectedExtra) {
    refuse(`extraData ${readableExtraData(cfg.extraData)}${where} names another network — `
      + `network "${P.NETWORK}" builds its genesis with ${readableExtraData(expectedExtra)}.`);
  }
}

class Blockchain extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.dataDir]   where blocks.ndjson and genesis.json live; omit
   *                               for an entirely in-memory chain (tests)
   * @param {object} [o.config]    genesis config overrides
   */
  constructor({ dataDir = null, config = null } = {}) {
    super();
    this.dataDir = dataDir;
    this.file = dataDir ? path.join(dataDir, BLOCKS_FILE) : null;
    this.db = new MemoryDB();

    const cfg = dataDir ? genesis.loadOrCreate(dataDir, config) : genesis.normalizeConfig(config || {});
    assertGenesisMatchesNetwork(cfg, config, dataDir);
    const g = genesis.build(cfg, this.db);
    this.config = g.config;
    this.chainId = g.config.chainId;
    this.gasLimit = BigInt(g.config.gasLimit);
    this.baseFee = 0n;                     // spec §1: no EIP-1559 in v1
    this.commonsAddress = hexBuf(g.config.commonsAddress.slice(2));

    this.store = new Map();                // idHex -> { block, height, work, id, stateRoot, receipts, gasUsed }
    this.chainIndex = [];                  // height -> idHex, active chain only
    this.tipId = null;
    this.txIndex = new Map();              // txHashHex -> { blockId, height, index }

    this.genesisId = g.hash;
    this._install(g.block, g.hash, 0n, g.block.header.stateRoot, [], 0n);
    this.tipId = g.hash;
    this.chainIndex = [g.hash];

    /* TRUE WHILE THIS CHAIN IS SHORTER THAN THE ONE ON DISK, and the single fact
     * a node's readiness is derived from (src/evmnode.js `ready`). It is set
     * here, before a byte of history is read, because the answer has to exist
     * from the first instant the object does: the replay is no longer part of
     * construction, so between `new Blockchain(...)` and the end of `load()` or
     * `open()` this object IS a genesis-only chain, and anything that answers a
     * balance or a height from it in that window answers wrongly. Cleared by
     * `_replayDone` and by nothing else.
     *
     * An in-memory chain (no dataDir) and an empty data directory have no
     * history to read and are therefore complete on construction. */
    this.replayPending = !!(this.file && fs.existsSync(this.file) && fs.statSync(this.file).size > 0);
    this._abortReplay = false;
    this._opening = null;
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Replay the on-disk chain, revalidating every block exactly as if it had
   * arrived from a peer. A block that no longer validates stops the replay for
   * that branch, which is deliberate — see the note below.
   *
   * SYNCHRONOUS, AND THEREFORE NOT WHAT A NODE BOOTS WITH. `open()` is the same
   * replay, byte for byte and block for block, with the loop handed back
   * periodically; a node uses that. This one stays because a suite, a tool or an
   * embedder that wants a loaded chain in one expression is entitled to it and
   * cannot be observed half-loaded — nothing else can run while it runs. What it
   * must never be is the boot path of a process that is also expected to answer
   * for itself, which is what micro-org#349 was about.
   */
  load() {
    if (!this.file) { this.replayPending = false; return this; }
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) { this.replayPending = false; return this; }
    const c = { total: 0, rejected: 0 };
    /* STREAMED, one line at a time, and this is a correctness requirement rather
     * than a tidy-up. Reading the file into a single string — which is what this
     * did — throws ERR_STRING_TOO_LONG past V8's 536,870,888-byte limit, i.e.
     * after about 350,000 blocks or sixty-one days of uptime, at which point the
     * node cannot start at all. See src/lines.js, and test/chain-replay.js,
     * which loads a chain past that ceiling and checks on the same file that the
     * old approach would still throw. */
    readLines(this.file, line => this._replayLine(line, c), {
      // A line no block could ever be is damage, and is counted as such rather
      // than accumulated — otherwise one corrupt file reproduces the very
      // failure this rewrite exists to remove.
      onOversized: () => { c.total++; c.rejected++; },
    });
    this._replayDone(c);
    return this;
  }

  /**
   * The same replay as `load()`, yielding to the event loop as it goes.
   *
   * WHY A BOOT MUST NOT BE ONE UNBROKEN CALL. Measured 2026-08-11 at mainnet
   * height 11,247: 90.8 s of replay on a laptop, 539 s on the live seed, with
   * the loop blocked for the whole of it and not one line of output — a node
   * that is starting is indistinguishable from a node that has hung, and the
   * usual response to a hung node throws the work away and starts it again. The
   * cost is linear in chain length and the chain grows ~5,760 blocks a day, so
   * it has no ceiling. This does not make the replay shorter. It makes the
   * process ANSWERABLE while it runs — a health check gets a refusal instead of
   * a dropped connection, and `onProgress` can say how far along it is.
   *
   * THE RESULT IS IDENTICAL TO `load()`'s and that is a hard requirement, not a
   * hope: the same lines in the same order through the same `_ingest`, with the
   * awaits placed where no other code can touch this chain. What runs during a
   * yield is a node that is refusing to answer (src/evmnode.js), not gossip and
   * not the miner — both are started only after this resolves.
   *
   * @param {object} [o]
   * @param {(status: object) => (void|Promise)} [o.onProgress] awaited, so a
   *        caller may do something asynchronous with it. Called once before any
   *        work, at most every `progressEveryMs` during, and once at the end.
   * @returns {Promise<Blockchain>} this — replayed, or stopped by `abortReplay`,
   *        which `replayPending` is how a caller tells apart.
   */
  open(o = {}) {
    // One replay per chain, however many callers ask for it: two loops over the
    // same file would both `_ingest` every block, and the second one's every
    // result would be 'known'. Harmless and pure waste, on the slowest path
    // this process has.
    return (this._opening ||= this._replayAsync(o));
  }

  /**
   * Stop a replay in flight. `replayPending` STAYS TRUE — the chain is now a
   * prefix of the one on disk, and nothing may treat it as the chain.
   */
  abortReplay() { this._abortReplay = true; }

  async _replayAsync({ onProgress = null, yieldEveryMs = P.REPLAY_YIELD_MS,
    progressEveryMs = P.REPLAY_PROGRESS_MS } = {}) {
    if (this.file) fs.mkdirSync(this.dataDir, { recursive: true });
    if (!this.file || !fs.existsSync(this.file)) { this.replayPending = false; return this; }

    const c = { total: 0, rejected: 0 };
    const totalBytes = fs.statSync(this.file).size;
    const startedAt = Date.now();
    let bytes = 0;
    const status = () => ({
      height: this.height, blocks: c.total, rejected: c.rejected,
      bytes, totalBytes, elapsedMs: Date.now() - startedAt,
    });

    let last = startedAt, lastProgress = startedAt;
    if (onProgress) await onProgress(status());
    for (const line of eachLine(this.file, { onOversized: n => { c.total++; c.rejected++; bytes += n + 1; } })) {
      this._replayLine(line, c);
      bytes += Buffer.byteLength(line) + 1;
      const now = Date.now();
      if (now - last < yieldEveryMs) continue;
      last = now;
      if (onProgress && now - lastProgress >= progressEveryMs) { lastProgress = now; await onProgress(status()); }
      /* setImmediate, not a bare `await`: awaiting a non-promise only drains the
       * microtask queue and lets no timer, socket or accept run — the loop would
       * still be blocked and this would be theatre. The same argument, and the
       * same call, as the batch loop in src/jsonrpc/server.js. */
      await new Promise(r => setImmediate(r));
      if (this._abortReplay) return this;             // …and `replayPending` stays true
    }
    this._replayDone(c);
    if (onProgress) await onProgress({ ...status(), done: true });
    return this;
  }

  /** One line of the on-disk chain, counted into `c`. Shared so that the sync
   *  replay and the async one cannot come to different conclusions. */
  _replayLine(line, c) {
    if (!line) return;                               // blank: not a block, not damage
    c.total++;
    let b;
    try { b = JSON.parse(line); } catch { c.rejected++; return; }
    const r = this._ingest(b, false);
    if (!r.ok && r.err !== 'known') c.rejected++;
  }

  _replayDone({ rejected, total }) {
    this.replayPending = false;
    /* A data directory holding an invalid block loads a SHORTER CHAIN. Making
     * that an event is the difference between an operator finding out why their
     * height went backwards and guessing. It is emitted after the flag clears so
     * that a listener acting on it sees a chain that is done loading, and it can
     * finally be HEARD: until micro-org#349 the replay ran inside `EvmNode`'s
     * constructor, so no caller held the object in time to listen for it. */
    if (rejected) this.emit('replay-rejected', { rejected, total });
  }

  _persist(block) {
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(block) + '\n');
  }

  // ---- accessors -----------------------------------------------------------

  get tip() { return this.store.get(this.tipId).block; }
  get height() { return this.store.get(this.tipId).height; }
  get totalDifficulty() { return this.store.get(this.tipId).work; }

  entry(id) { return this.store.get(id) || null; }
  getBlock(h) { const id = this.chainIndex[h]; return id ? this.store.get(id).block : undefined; }
  getById(id) { const e = this.store.get(id); return e ? e.block : null; }

  /** The entry for a height on the ACTIVE chain, or null. */
  entryAt(height) {
    const id = this.chainIndex[Number(height)];
    return id ? this.store.get(id) : null;
  }

  /** A read-only StateDB at a block id — the whole point of content addressing. */
  stateAt(id) {
    const e = this.store.get(id);
    if (!e) return null;
    return new StateDB(this.db, hexBuf(e.stateRoot));
  }

  stateAtHeight(height) {
    const e = this.entryAt(height);
    return e ? new StateDB(this.db, hexBuf(e.stateRoot)) : null;
  }

  stateAtTip() { return new StateDB(this.db, hexBuf(this.store.get(this.tipId).stateRoot)); }

  /**
   * A StateDB at a block id whose WRITES GO NOWHERE THIS CHAIN CAN SEE.
   *
   * `stateAt` above hands back the chain's own append-only node store, which is
   * right for anything that will be mined and wrong for anything that will not.
   * A speculative run — `eth_call`, `eth_estimateGas`, anything an unauthenticated
   * stranger can ask for — writes trie nodes and code through `Trie._ref` exactly
   * as a real transaction does, and the store is never pruned (see the header of
   * this file), so those nodes stay for the life of the process. This overlays a
   * per-call Map: reads fall through to the real store, writes stop at the Map,
   * and the caller drops the whole thing when the run returns.
   *
   * The point is not only the memory. It is that a speculative execution becomes
   * INCAPABLE of influencing consensus state, because nothing it writes is in the
   * store any block's state root is resolved against.
   */
  speculativeStateAt(id) {
    const e = this.store.get(id);
    if (!e) return null;
    return new StateDB(new OverlayDB(this.db), hexBuf(e.stateRoot));
  }

  receiptsAt(height) {
    const e = this.entryAt(height);
    return e ? e.receipts : null;
  }

  getTransaction(hashHex) {
    const at = this.txIndex.get(hashHex);
    if (!at) return null;
    const e = this.store.get(at.blockId);
    if (!e) return null;
    return { ...at, entry: e, raw: hexBuf(e.block.txs[at.index]) };
  }

  // ---- branch walking ------------------------------------------------------

  _slice(id, n) {                       // up to n entries ending at id, oldest first
    const out = [];
    let cur = id;
    while (cur && out.length < n) {
      const e = this.store.get(cur);
      if (!e) break;
      out.push(e);
      if (e.height === 0) break;
      cur = e.block.header.prevHash;
    }
    out.reverse();
    return out;
  }

  _fullChain(id) {
    const out = [];
    let cur = id;
    while (cur) {
      const e = this.store.get(cur);
      if (!e) break;
      out.push(e);
      if (e.height === 0) break;
      cur = e.block.header.prevHash;
    }
    out.reverse();
    return out;
  }

  _medianTimePast(parentId) {
    const slice = this._slice(parentId, P.MEDIAN_TIME_SPAN);
    const ts = slice.map(e => e.block.header.timestamp).sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  }

  /** BLOCKHASH: the last 256 blocks of the branch ending at `parentId`. */
  _blockHashFn(parentId, height) {
    return (n) => {
      const want = Number(n);
      if (!Number.isSafeInteger(want) || want >= height || want < height - BLOCKHASH_WINDOW) return null;
      let cur = parentId;
      for (;;) {
        const e = this.store.get(cur);
        if (!e) return null;
        if (e.height === want) return hexBuf(e.id);
        if (e.height <= want || e.height === 0) return null;
        cur = e.block.header.prevHash;
      }
    };
  }

  // ---- difficulty ----------------------------------------------------------

  /**
   * The LWMA target at the tip — what a block arriving ON TIME must meet.
   *
   * Deliberately NOT the emergency-eased target: this is the number `/info`,
   * `eth_getBlockByNumber` and the difficulty alert in micro-deploy read, and the
   * easement is a momentary permission granted to one late block, not a change in
   * what the chain is asking for. Reporting the eased value would make a gauge
   * that reads the floor every time a block runs long, which is the opposite of
   * what `EmberDifficultyAtFloor` was built to notice.
   */
  nextTarget() { return this._nextTarget(this.tipId); }

  /**
   * The same branch-aware LWMA the UTXO chain uses (../chain.js) — 60
   * solve times, each clamped to [1, 6×target], linearly weighted, scaling the
   * window's mean target. Unchanged on purpose: spec §4 says the proof of work and
   * the retarget are untouched and only the key they bind moves.
   *
   * Still a pure function of COMMITTED HISTORY and of nothing else, which is what
   * `_targetFor` below depends on: the base a block is eased FROM cannot be
   * influenced by the block doing the easing.
   */
  _nextTarget(parentId) {
    const parent = this.store.get(parentId);
    if (!parent || parent.height < 2) return this.config.target;
    const window = Math.min(P.LWMA_WINDOW, parent.height);
    const slice = this._slice(parentId, window + 1);
    let weightedTime = 0, weightSum = 0, targetSum = 0n;
    for (let i = 1; i < slice.length; i++) {
      const dt = slice[i].block.header.timestamp - slice[i - 1].block.header.timestamp;
      const solve = Math.max(1, Math.min(dt, P.TARGET_BLOCK_TIME * 6));
      const w = i;
      weightedTime += solve * w;
      weightSum += w;
      targetSum += BigInt('0x' + slice[i].block.header.target);
    }
    const n = slice.length - 1;
    const avgTarget = targetSum / BigInt(n);
    const avgSolve = weightedTime / weightSum;
    let next = avgTarget * BigInt(Math.round(avgSolve * 1000)) / BigInt(P.TARGET_BLOCK_TIME * 1000);
    const min = BigInt('0x' + P.MIN_TARGET);
    const max = BigInt('0x' + P.MAX_TARGET);
    if (next < min) next = min;
    if (next > max) next = max;
    return next.toString(16).padStart(64, '0');
  }

  /**
   * The target a block extending `parentId` and stamped `timestamp` must meet —
   * the LWMA above, eased to the difficulty floor if the block is already more
   * than `P.emergencySolveSeconds()` past its parent.
   *
   * THE WHOLE RULE IS THE TWO COMPARISONS BELOW. The argument for it, the burst
   * it was measured against, why the easement is the floor rather than something
   * proportional, and why a branch built out of eased blocks loses on cumulative
   * work anyway, are all at EMERGENCY_SOLVE_MULTIPLE in ../params.js. Two things
   * that belong here rather than there:
   *
   * `timestamp` is the block's OWN stamp and never this node's clock. That is the
   * difference between a rule that replays and one that does not: `_validate`
   * recomputes this for every block on disk at boot, days or months after the
   * fact, and a `Date.now()` in here would make the expected target a function of
   * WHEN the check runs. Two nodes would then disagree about the same block for
   * no reason either could see. The stamp is honest because the two checks in
   * `_validate` bracket it — median-time-past below, `P.maxFutureDriftS` above —
   * and params.js refuses to load unless that drift is smaller than the threshold.
   *
   * The height gate is `parent.height + 1` — the height of the block being
   * priced, not the tip's — so a reorg across the activation boundary prices each
   * block by its own height and both sides of the fork agree about which rule
   * applied to which block.
   *
   * MAX_TARGET is never harder than the base: `_nextTarget` clamps its result to
   * it, and params.js asserts GENESIS_TARGET ≤ MAX_TARGET, so the substitution
   * below can only ever ease.
   */
  _targetFor(parentId, timestamp) {
    const base = this._nextTarget(parentId);
    const parent = this.store.get(parentId);
    if (!parent) return base;
    if (!P.emergencyActive(parent.height + 1)) return base;
    if (timestamp - parent.block.header.timestamp <= P.emergencySolveSeconds()) return base;
    return P.MAX_TARGET;
  }

  // ---- the block reward ----------------------------------------------------

  /**
   * Emission, applied after the last transaction and before the state root is
   * taken. The subsidy schedule is unchanged (params.js) — only the unit is, from
   * sparks to wei, exactly — and the Commons keeps its 10%.
   *
   * `addBalance` even for a zero share, because adding zero still TOUCHES the
   * account and EIP-161 then sweeps it at finalize. Skipping the call for a zero
   * would leave an account in the trie no other client has, which is a state root
   * that differs on a block where nothing appeared to happen.
   */
  _creditReward(state, height, coinbaseAddr) {
    // params.js owns the split, so the figure a remote miner is quoted in its
    // work template is the same arithmetic that credits it here.
    const subsidy = P.subsidyWei(height);
    const commons = P.commonsShareWei(height);
    state.beginTransaction();
    state.addBalance(coinbaseAddr, subsidy - commons);
    if (commons > 0n) state.addBalance(this.commonsAddress, commons);
    state.finalize();
    return { subsidy, commons };
  }

  // ---- validation ----------------------------------------------------------

  /**
   * Everything decidable about a block given its parent, in cost order.
   *
   * @returns {{ok:true, id, stateRoot, receipts, gasUsed, results}} or {ok:false, err}
   */
  _validate(block, parent, pow = null) {
    const shape = HDR.check(block.header);
    if (!shape.ok) return { ok: false, err: shape.err };
    const hdr = shape.header;

    if (!Array.isArray(block.txs)) return { ok: false, err: 'txs must be a list' };
    if (block.txs.length > P.MAX_BLOCK_TXS) return { ok: false, err: 'too many transactions' };
    if (hdr.height !== parent.height + 1) return { ok: false, err: 'bad height' };
    if (hdr.prevHash !== parent.id) return { ok: false, err: 'parent mismatch' };

    const now = Math.floor(Date.now() / 1000);
    /* THESE TWO CHECKS ARE WHAT MAKES THE EMERGENCY EASEMENT HONEST, and from
     * EMERGENCY_ACTIVATION_HEIGHT they are load-bearing rather than hygiene. The
     * drift tightens from 7,200 s to 30 s at exactly the height the easement
     * begins, because a block that may be stamped two hours ahead can claim a
     * 120-second easement without waiting for it (params.js
     * EMERGENCY_MAX_FUTURE_DRIFT_S). Median-time-past closes the other side: the
     * gap the rule reads cannot be widened by backdating either. */
    if (hdr.timestamp > now + P.maxFutureDriftS(hdr.height)) return { ok: false, err: 'timestamp too far in future' };
    if (hdr.timestamp <= this._medianTimePast(parent.id)) return { ok: false, err: 'timestamp <= median-time-past' };

    /* Fixed in v1 (spec §1). It is in the header so a later fork can move it, but
     * a block that moves it now is invalid — otherwise a miner sets it to 2^53 and
     * everyone else's node runs out of memory validating one block. */
    if (BigInt(hdr.gasLimit) !== this.gasLimit) return { ok: false, err: 'wrong gas limit' };
    if (hdr.target !== this._targetFor(parent.id, hdr.timestamp)) return { ok: false, err: 'wrong difficulty target' };

    if (!pow) pow = HDR.verifyPow(hdr);
    if (!pow.ok) return { ok: false, err: pow.err };

    let raws;
    try { raws = HDR.txBuffers(block); } catch (e) { return { ok: false, err: 'malformed transaction: ' + e.message }; }
    const size = HDR.encodeBlock({ header: hdr, txs: block.txs }).length;
    if (size > P.MAX_BLOCK_BYTES) return { ok: false, err: 'block exceeds max bytes' };

    /* The transaction root, from the bytes actually carried. Checked BEFORE
     * execution because it is a hash of what is already in hand, and a block whose
     * txRoot is wrong cannot become valid by executing it. */
    const txRoot = HDR.txRoot(raws).toString('hex');
    if (txRoot !== hdr.txRoot) return { ok: false, err: 'txRoot mismatch' };

    // ---- the state transition ---------------------------------------------
    const coinbase = HDR.coinbaseAddress(hdr.coinbasePub);
    const state = new StateDB(this.db, hexBuf(parent.stateRoot));
    const res = ST.applyBlock({
      state,
      transactions: raws,
      block: this._blockContext(hdr, parent, coinbase),
      blockHash: this._blockHashFn(parent.id, hdr.height),
      skipInvalid: false,           // VALIDATING: one invalid transaction voids the block
    });
    if (!res.ok) return { ok: false, err: `transaction ${res.index} invalid: ${res.code}` };
    /* An internal error is a bug in OUR interpreter, not a property of the block.
     * Treating it as "the block is invalid" would fork this node off the network
     * silently, so it is reported as what it is. */
    for (const r of res.results) {
      if (r.internalError) return { ok: false, err: `interpreter error: ${r.internalError}`, internal: true };
    }

    if (BigInt(hdr.gasUsed) !== res.gasUsed) return { ok: false, err: 'gasUsed mismatch' };
    if (res.receiptsRoot.toString('hex') !== hdr.receiptsRoot) return { ok: false, err: 'receiptsRoot mismatch' };
    if (res.logsBloom.toString('hex') !== hdr.logsBloom) return { ok: false, err: 'logsBloom mismatch' };

    this._creditReward(state, hdr.height, coinbase);
    const stateRoot = state.root().toString('hex');
    if (stateRoot !== hdr.stateRoot) return { ok: false, err: 'stateRoot mismatch' };

    return { ok: true, id: pow.id, stateRoot, receipts: res.receipts, gasUsed: res.gasUsed, results: res.results, size };
  }

  /** The block context every transaction in this block executes against. */
  _blockContext(hdr, parent, coinbase) {
    return {
      number: BigInt(hdr.height),
      timestamp: BigInt(hdr.timestamp),
      coinbase,
      gasLimit: BigInt(hdr.gasLimit),
      /* Spec §5: PREVRANDAO is the PARENT's Homefire digest — a real 256-bit hash
       * that is already fixed when this block is built, so a contract cannot read
       * a value the miner is still grinding. It is still miner-influenceable: a
       * miner who dislikes the outcome can discard the block and grind another. */
      prevRandao: hexBuf(parent.block.header.mixHash),
      baseFee: this.baseFee,
      chainId: this.chainId,
    };
  }

  // ---- ingest and fork choice ---------------------------------------------

  addBlock(block) { return this._ingest(block, true); }

  _install(block, id, work, stateRootHex, receipts, gasUsed, size) {
    const entry = {
      block, id,
      height: block.header.height,
      work,
      stateRoot: stateRootHex,
      receipts,
      gasUsed,
      /* Taken from validation where there is one — encoding a 2 MB block twice per
       * accept is a real cost on the sync path. */
      size: size === undefined ? HDR.encodeBlock(block).length : size,
    };
    this.store.set(id, entry);
    return entry;
  }

  _ingest(raw, persist) {
    if (!raw || typeof raw !== 'object' || !raw.header) return { ok: false, err: 'malformed block' };
    if (!Array.isArray(raw.txs)) return { ok: false, err: 'txs must be a list' };
    /* NORMALISE FIRST, then work only with the normalised block. A peer's `0X…`,
     * upper-case or short hex is the same block as ours and must not be looked up,
     * stored or persisted in two forms — two spellings of one parent hash is a
     * store that cannot find its own parent. */
    let block, id;
    try {
      block = {
        header: HDR.normalize(raw.header),
        txs: raw.txs.map((t, i) => HDR.hexToBuf(t, `txs[${i}]`).toString('hex')),
      };
      id = HDR.hashHex(block.header);
    } catch (e) { return { ok: false, err: 'malformed block: ' + e.message }; }

    if (this.store.has(id)) return { ok: false, err: 'known' };
    const parent = this.store.get(block.header.prevHash);
    if (!parent) return { ok: false, err: 'unknown parent' };

    const r = this._validate(block, parent);
    if (!r.ok) return r;

    const work = parent.work + HDR.difficulty(block.header.target);
    const entry = this._install(block, id, work, r.stateRoot, r.receipts, r.gasUsed, r.size);
    if (persist) this._persist(block);

    if (block.header.prevHash === this.tipId) {
      this.tipId = id;
      this.chainIndex[entry.height] = id;
      this._indexBlock(entry);
      this.emit('block', block, entry);
      return { ok: true, id };
    }

    /* Most cumulative work wins. Ties go to the incumbent — the first block seen at
     * a given weight stays, which is what stops two nodes flip-flopping between
     * equally heavy tips and re-broadcasting forever. */
    if (work > this.store.get(this.tipId).work) {
      const from = this.height;
      const unwound = this._activate(id);
      this.emit('reorg', { from, to: entry.height, tip: id, unwound });
      this.emit('block', block, entry);
    }
    return { ok: true, id };
  }

  /**
   * Switch the active chain to the branch ending at `id`.
   *
   * Returns the raw transactions that were on the losing branch and are not on the
   * winning one, so the node can put them back in the mempool. Forgetting that is
   * a silent way to lose a user's transaction: it was mined, the wallet stopped
   * watching, and then it was un-mined.
   */
  _activate(id) {
    const oldChain = this._fullChain(this.tipId);
    const newChain = this._fullChain(id);
    const newIds = new Set(newChain.map(e => e.id));

    const unwound = [];
    for (const e of oldChain) {
      if (newIds.has(e.id)) continue;
      for (const t of e.block.txs) unwound.push(t);
    }
    const readded = new Set();
    for (const e of newChain) for (const t of e.block.txs) readded.add(t);

    this.tipId = id;
    this.chainIndex = [];
    for (const e of newChain) this.chainIndex[e.height] = e.id;

    this.txIndex = new Map();
    for (const e of newChain) this._indexBlock(e);

    return unwound.filter(t => !readded.has(t));
  }

  _indexBlock(entry) {
    entry.block.txs.forEach((raw, index) => {
      const h = keccak256(hexBuf(raw)).toString('hex');
      this.txIndex.set(h, { blockId: entry.id, height: entry.height, index });
    });
  }

  // ---- building ------------------------------------------------------------

  /**
   * Execute a candidate list of transactions on top of the tip and return
   * everything a header needs. `skipInvalid` is true here and false in `_validate`
   * — that asymmetry is the whole difference between building a block and checking
   * one, and it is why they are one code path with one flag rather than two
   * implementations that can drift.
   */
  buildCandidate({ parentId = this.tipId, coinbasePub, timestamp, transactions = [], extraData = '' }) {
    const parent = this.store.get(parentId);
    if (!parent) throw new Error('blockchain: no such parent ' + parentId);
    const height = parent.height + 1;
    const coinbase = HDR.coinbaseAddress(coinbasePub);
    const ts = Math.max(
      Number(timestamp === undefined ? Math.floor(Date.now() / 1000) : timestamp),
      this._medianTimePast(parentId) + 1,
    );
    /* THE STAMP IS TAKEN BEFORE THE TARGET, and the order is the rule working.
     * `_targetFor` prices a block by how late it already is, so a candidate
     * rebuilt past the threshold — which is what the clock bucket in
     * chain/miner.js `candidateFor` exists to force — is assembled at the eased
     * target and the search that follows is the short one. Computing the target
     * first would hand every miner the pre-easement number forever. */
    const target = this._targetFor(parentId, ts);

    const hdrCtx = {
      height, timestamp: ts, gasLimit: Number(this.gasLimit),
    };
    const state = new StateDB(this.db, hexBuf(parent.stateRoot));
    const res = ST.applyBlock({
      state,
      transactions,
      block: this._blockContext(hdrCtx, parent, coinbase),
      blockHash: this._blockHashFn(parentId, height),
      skipInvalid: true,            // BUILDING: drop what does not fit, keep going
    });

    const included = [];
    const rejectedAt = new Set(res.rejected.map(r => r.index));
    transactions.forEach((t, i) => { if (!rejectedAt.has(i)) included.push(t); });

    this._creditReward(state, height, coinbase);

    const header = HDR.normalize({
      version: HDR.HEADER_VERSION,
      prevHash: parentId,
      height,
      timestamp: ts,
      target,
      coinbasePub,
      txRoot: HDR.txRoot(included),
      stateRoot: state.root(),
      receiptsRoot: res.receiptsRoot,
      logsBloom: res.logsBloom,
      gasLimit: Number(this.gasLimit),
      gasUsed: Number(res.gasUsed),
      extraData,
      nonce: 0,
      mixHash: HDR.ZERO_HASH,
      powSig: '',
    });

    return {
      header,
      txs: included.map(t => Buffer.from(t).toString('hex')),
      coreHash: HDR.coreHash(header),
      receipts: res.receipts,
      results: res.results,
      rejected: res.rejected,
      gasUsed: res.gasUsed,
    };
  }

  // ---- supply --------------------------------------------------------------

  /**
   * Emitted supply, from the schedule rather than by summing accounts: the state
   * trie has no "total" and walking every account per request is exactly the
   * O(state) endpoint MAP.md §9 complains about on the UTXO side. Deriving it from
   * height is exact, because emission is a pure function of height.
   */
  supply(height = this.height) {
    const to = Number(height);
    /* Walked once and then extended, not recomputed: /supply is an unauthenticated
     * endpoint under CORS `*` and an O(height) loop per request is a free denial of
     * service by the millionth block. */
    if (!this._supplyMemo || this._supplyMemo.height > to) {
      let allocated = 0n;
      for (const entry of Object.values(this.config.alloc)) allocated += BigInt(entry.balance || 0);
      this._supplyMemo = { height: 0, minted: allocated, commons: 0n };
    }
    const memo = this._supplyMemo;
    for (let h = memo.height + 1; h <= to; h++) {
      const s = P.subsidyWei(h);
      memo.minted += s;
      memo.commons += s * BigInt(Math.round(P.COMMONS_SHARE * 100)) / 100n;
    }
    memo.height = Math.max(memo.height, to);
    return { minted: memo.minted, commons: memo.commons, height: to };
  }
}

module.exports = { Blockchain, BLOCKS_FILE, BLOCKHASH_WINDOW, GENESIS_NETWORK_MISMATCH };
