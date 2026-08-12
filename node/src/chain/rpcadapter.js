'use strict';
/* The chain, as the JSON-RPC layer wants it — the interface documented in full at
 * the top of ../jsonrpc/methods.js, and nothing else.
 *
 * THE ONE RULE, restated because it is the rule this file exists to keep: the chain
 * speaks in NATIVE JS VALUES. `bigint` for every number, `Buffer` for every byte
 * string, never a "0x…" string. All hex encoding lives in jsonrpc/hex.js and is
 * applied exactly once, on the way out. The moment this layer returns a hex string,
 * the QUANTITY/DATA distinction is being decided in two places and one of them is
 * wrong — and it fails silently, as a balance that is off by a factor of sixteen a
 * week later rather than as an exception.
 *
 * This is a thin adapter over Blockchain and Mempool on purpose. It holds no state
 * of its own, so there is nothing here that can disagree with consensus.
 *
 * FOUR THINGS IN HERE ARE NOT MECHANICAL AND ARE WORTH READING:
 *
 * 1. `logIndex` IS PER BLOCK, NOT PER RECEIPT. The receipts consensus stores know
 *    nothing about their position, so the numbering is applied here, across the
 *    whole block in transaction order. Numbering per receipt looks identical for
 *    every block whose first transaction is the only one that logs, which is most
 *    of them in a test.
 *
 * 2. `at: 'pending'` FOR A NONCE MEANS THE MEMPOOL. `eth_getTransactionCount(addr,
 *    'pending')` that answers with the mined nonce hands a wallet the nonce it just
 *    used, and the wallet's second transaction is rejected as a duplicate. Every
 *    other pending read aliases the tip, which is honest: there is no pending block.
 *
 * 3. `estimateGas` BISECTS, it does not report what one run used. A run at the block
 *    gas limit can succeed with less gas than the same transaction needs at its own
 *    limit, because the 63/64 rule gives a child frame a share of what is left — so
 *    "run it once and add 10%" produces estimates that are too low exactly where it
 *    matters, on deep calls.
 *
 * 4. SPECULATIVE EXECUTION IS SANDBOXED, GAS-CAPPED AND TIME-CAPPED, and all three
 *    are load-bearing. `eth_call`/`eth_estimateGas` are the only unauthenticated
 *    way to make this process run EVM code, over a CORS-`*` endpoint with no auth.
 *    So `_run` executes against an overlay store nothing outside the call can reach
 *    (`Blockchain.speculativeStateAt`), `_capFor` bounds the gas for BOTH methods,
 *    and `_deadline` bounds the wall clock for BOTH methods — one budget for a
 *    whole `estimateGas`, not one per bisection step. Without the first, every
 *    distinct call leaves trie nodes in the chain's never-pruned store for the life
 *    of the process. Without the other two, one request pins the single-threaded
 *    event loop for as long as it likes and p2p, mining and the healthcheck stop
 *    with it: measured before they existed, ONE `eth_call` of blake2f at the block
 *    gas limit froze this node for 11.3 s, and one `eth_estimateGas` of a message
 *    costing a tenth of that froze it for 15.2 s, because the bisection probed 26
 *    times and 14 of those probes really executed.
 */

const P = require('../params');
const HDR = require('./header');
const TX = require('./transaction');
const gas = require('../evm/gas');
const bloom = require('./bloom');
const { EVM, ERR, Deadline } = require('../evm/interpreter');
const { PRECOMPILES } = require('../state/statedb');
const { keccak256 } = require('../crypto/keccak');

const ZERO_ADDRESS = Buffer.alloc(20);
const hexBuf = h => Buffer.from(h, 'hex');

/** How many times `estimateGas` may re-execute before giving up bisecting. */
const ESTIMATE_ITERATIONS = 32;

class RpcChain {
  /**
   * @param {object} o
   * @param {Blockchain} o.chain
   * @param {Mempool}    o.mempool
   * @param {function}   [o.submit]   (raw) -> {ok, hash} | {ok:false, error}; the
   *                                  node's, so a submitted transaction is gossiped
   * @param {bigint|number} [o.rpcGasCap]      the ceiling on a speculative run's gas
   * @param {number}     [o.rpcTimeBudgetMs]   wall clock for one call, or one whole
   *                                           estimateGas including its bisection
   * @param {function}   [o.peers]     () -> number of connected p2p peers
   * @param {function}   [o.mining]    () -> boolean
   * @param {function}   [o.hashrate]  () -> hashes per second
   * @param {function}   [o.coinbase]  () -> Buffer(20), where this node mines to
   */
  constructor({
    chain, mempool, submit = null, gasPrice = P.EVM_MIN_GAS_PRICE,
    rpcGasCap = P.EVM_RPC_GAS_CAP, rpcTimeBudgetMs = P.EVM_RPC_TIME_BUDGET_MS,
    peers = null, mining = null, hashrate = null, coinbase = null,
  }) {
    this.chain = chain;
    this.mempool = mempool;
    this.submit = submit;
    this.suggestedGasPrice = BigInt(gasPrice);
    this.rpcGasCap = BigInt(rpcGasCap);
    this.rpcTimeBudgetMs = Number(rpcTimeBudgetMs);
    if (this.rpcGasCap <= 0n || !(this.rpcTimeBudgetMs > 0)) {
      // Fail at construction rather than serve one unbounded call: a zero here
      // would read as "no cap" to anyone who wrote it, and would be one.
      throw new Error('RpcChain: rpcGasCap and rpcTimeBudgetMs must both be positive');
    }

    /* ---- the node, as opposed to the chain -------------------------------
     *
     * DEFINED ONLY WHEN THE EMBEDDER SUPPLIED THE FACT, because the JSON-RPC
     * layer registers `net_peerCount`, `eth_mining`, `eth_hashrate` and
     * `eth_coinbase` on exactly this test and leaves them ABSENT otherwise.
     * That is the whole point of routing them through here: an adapter built
     * over a bare Blockchain — an indexer's, a test's — has no peers and no
     * miner, and a node dashboard told "0 peers" by something that simply does
     * not know reports the network as down. -32601 is the honest answer and
     * the client can then fall back to its own probe.
     */
    if (peers) this.peerCount = () => BigInt(peers());
    if (mining) this.mining = () => mining() === true;
    if (hashrate) this.hashrate = () => BigInt(Math.max(0, Math.round(Number(hashrate()) || 0)));
    if (coinbase) this.coinbase = () => coinbase();
  }

  // ---- chain metadata ------------------------------------------------------

  chainId() { return BigInt(this.chain.chainId); }
  blockNumber() { return BigInt(this.chain.height); }
  gasPrice() { return this.suggestedGasPrice; }

  /**
   * When the chain started, and the genesis timestamp beside it so no caller has
   * to fetch block 0 to find out that it is not an answer. micro-org#396.
   *
   * `launchedAt` is null on a chain that holds only genesis, and that is a real
   * answer rather than a missing one — see `Blockchain#launchedAt`. Both figures
   * ride in one response ON PURPOSE: a consumer that has to make two calls to
   * learn "the round number is not the start" will make one, and the one it makes
   * is the wrong one.
   */
  chainStart() {
    const launchedAt = this.chain.launchedAt();
    return {
      launchedAt: launchedAt === null ? null : BigInt(launchedAt),
      genesisTimestamp: BigInt(this.chain.config.timestamp),
      launchHeight: 1n,
      height: BigInt(this.chain.height),
    };
  }

  /** The block's own bloom logic, so the bit order lives in one vector-tested place. */
  bloomMatches(b, item) { return bloom.contains(b, item); }

  // ---- state readers -------------------------------------------------------

  _stateFor(at) {
    if (at === 'pending') return this.chain.stateAtTip();
    return this.chain.stateAtHeight(Number(at));
  }

  getBalance(addr, at) {
    const s = this._stateFor(at);
    return s ? s.getBalance(addr) : 0n;
  }

  getNonce(addr, at) {
    const s = this._stateFor(at);
    if (!s) return 0n;
    const n = s.getNonce(addr);
    return at === 'pending' ? this.mempool.pendingNonce(addr, n) : n;
  }

  getCode(addr, at) {
    const s = this._stateFor(at);
    return s ? s.getCode(addr) : Buffer.alloc(0);
  }

  getStorageAt(addr, key, at) {
    const s = this._stateFor(at);
    return s ? s.getStorage(addr, key) : Buffer.alloc(32);
  }

  // ---- blocks --------------------------------------------------------------

  _formatBlock(entry, fullTx) {
    const h = entry.block.header;
    const raws = entry.block.txs.map(hexBuf);
    return {
      number: BigInt(h.height),
      hash: hexBuf(entry.id),
      parentHash: hexBuf(h.prevHash),
      nonce: HDR.bytes8(h.nonce),
      mixHash: hexBuf(h.mixHash),
      logsBloom: hexBuf(h.logsBloom),
      transactionsRoot: hexBuf(h.txRoot),
      stateRoot: hexBuf(h.stateRoot),
      receiptsRoot: hexBuf(h.receiptsRoot),
      /* The 0x address, NOT coinbasePub. A client that is handed a public key here
       * displays a 65-byte "address" and every link from it 404s. */
      miner: h.height === 0 ? ZERO_ADDRESS : HDR.coinbaseAddress(h.coinbasePub),
      difficulty: h.height === 0 ? 0n : HDR.difficulty(h.target),
      /* Stored, not recomputed: it is the sum over the whole branch and summing it
       * per request is an O(height) walk on the hottest endpoint there is. */
      totalDifficulty: entry.work,
      extraData: hexBuf(h.extraData),
      size: BigInt(entry.size),
      gasLimit: BigInt(h.gasLimit),
      gasUsed: BigInt(h.gasUsed),
      /* SECONDS. The header stores seconds and this passes them through; the
       * conversion the spec asks for happens once, at the header. */
      timestamp: BigInt(h.timestamp),
      transactions: fullTx
        ? raws.map((raw, i) => this._formatTx(raw, { entry, index: i }))
        : raws.map(raw => keccak256(raw)),
    };
  }

  getBlockByNumber(n, fullTx) {
    const e = this.chain.entryAt(Number(n));
    return e ? this._formatBlock(e, fullTx) : null;
  }

  /**
   * A canonical block's hash by height, without building the block.
   *
   * `eth_newBlockFilter` polls this once per new head, and `_formatBlock` would
   * otherwise keccak every transaction in the block to produce a value the
   * caller throws away — a 5,000-transaction block costs 5,000 hashes to learn
   * one. The interface treats it as optional and falls back to getBlockByNumber.
   */
  blockHashAt(n) {
    const e = this.chain.entryAt(Number(n));
    return e ? hexBuf(e.id) : null;
  }

  getBlockByHash(hash, fullTx) {
    const e = this.chain.entry(Buffer.from(hash).toString('hex'));
    /* Only the ACTIVE chain answers by hash. A side-branch block is in the store —
     * p2p needs it — but serving it as a block would give a client a `number` that
     * resolves to a different block by height, which is how an indexer silently
     * writes the losing branch into its database. */
    if (!e || this.chain.chainIndex[e.height] !== e.id) return null;
    return this._formatBlock(e, fullTx);
  }

  // ---- transactions --------------------------------------------------------

  _formatTx(raw, at = null) {
    const tx = TX.decode(raw, { chainId: this.chain.chainId });
    const sender = TX.recoverSender(tx);
    return {
      hash: keccak256(raw),
      nonce: tx.nonce,
      from: sender,
      to: tx.to,
      value: tx.value,
      gasPrice: tx.gasPrice,
      gas: tx.gasLimit,
      input: tx.data,
      v: tx.v, r: tx.r, s: tx.s,
      chainId: tx.chainId === null ? null : BigInt(tx.chainId),
      blockHash: at ? hexBuf(at.entry.id) : null,
      blockNumber: at ? BigInt(at.entry.height) : null,
      transactionIndex: at ? BigInt(at.index) : null,
    };
  }

  getTransactionByHash(hash) {
    const hex = Buffer.from(hash).toString('hex');
    const found = this.chain.getTransaction(hex);
    if (found) return this._formatTx(found.raw, { entry: found.entry, index: found.index });
    /* A pooled transaction, with the three position fields null. Without this a
     * wallet that has just broadcast cannot see its own transaction at all until it
     * is mined, and reports it as lost. */
    const pooled = this.mempool.get(hex);
    return pooled ? this._formatTx(pooled.raw, null) : null;
  }

  /**
   * Every receipt of a block, with the fields consensus does not store filled in.
   *
   * MEMOIZED ON THE ENTRY, because `from` is not stored anywhere — it is recovered
   * from the signature, at roughly a millisecond per transaction, and `eth_getLogs`
   * calls this once per block in its range. Without the memo a wallet asking for
   * ten thousand blocks of logs pays ten thousand blocks of ECDSA recovery, every
   * time it asks. The entry is immutable once stored, so the memo can never be
   * stale; a reorg replaces the entry rather than mutating it.
   */
  _receiptsFor(entry) {
    if (entry._rpcReceipts) return entry._rpcReceipts;
    const out = [];
    let previousCumulative = 0n;
    let logIndex = 0n;
    entry.block.txs.forEach((rawHex, index) => {
      const raw = hexBuf(rawHex);
      const r = entry.receipts[index];
      if (!r) return;
      const tx = TX.decode(raw, { chainId: this.chain.chainId });
      const sender = TX.recoverSender(tx);
      const hash = keccak256(raw);
      const gasUsed = r.cumulativeGasUsed - previousCumulative;
      previousCumulative = r.cumulativeGasUsed;
      out.push({
        transactionHash: hash,
        transactionIndex: BigInt(index),
        blockHash: hexBuf(entry.id),
        blockNumber: BigInt(entry.height),
        from: sender,
        to: tx.to,
        cumulativeGasUsed: r.cumulativeGasUsed,
        gasUsed,
        effectiveGasPrice: tx.gasPrice,
        /* Set for every creation, successful or not — which is what geth does, and
         * what a client needs in order to look up why a deployment failed. */
        contractAddress: tx.to === null ? TX.contractAddress(sender, tx.nonce) : null,
        logs: r.logs.map(l => ({
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber: BigInt(entry.height),
          blockHash: hexBuf(entry.id),
          transactionHash: hash,
          transactionIndex: BigInt(index),
          logIndex: logIndex++,          // per BLOCK; see the header note
          removed: false,
        })),
        logsBloom: r.logsBloom,
        status: r.status,
      });
    });
    entry._rpcReceipts = out;
    return out;
  }

  getTransactionReceipt(hash) {
    const hex = Buffer.from(hash).toString('hex');
    const found = this.chain.getTransaction(hex);
    /* Never from an orphaned branch: a receipt for a transaction a reorg un-mined
     * would tell a wallet its transfer succeeded when the chain no longer contains
     * it. That is enforced by the INDEX rather than by a check here — `_activate`
     * rebuilds `txIndex` from the winning branch only, so a lookup for an
     * orphaned transaction finds nothing at all. Adding a belt-and-braces
     * `chainIndex[height] === blockId` test here would be unreachable code, and
     * unreachable code is untestable code; test/evmchain.js asserts the behaviour
     * across a real reorg instead. */
    if (!found) return null;
    return this._receiptsFor(found.entry)[found.index] || null;
  }

  getBlockReceipts(n) {
    const e = this.chain.entryAt(Number(n));
    return e ? this._receiptsFor(e) : [];
  }

  // ---- execution -----------------------------------------------------------

  /**
   * The block context a call executes in: the referenced block's own header.
   *
   * DELEGATED to the chain rather than rebuilt here, and that is the point. This
   * context decides what BLOCKHASH, COINBASE, TIMESTAMP and PREVRANDAO return, and
   * a second copy of those rules is a divergence between what `eth_call` says and
   * what the same call does when it is mined — the worst kind, because a developer
   * tests with the first and ships against the second.
   */
  _contextFor(entry) {
    const h = entry.block.header;
    const parent = this.chain.entry(h.prevHash);
    if (!parent) {
      // genesis has no parent, so there is no digest to read; zero is honest
      return {
        number: BigInt(h.height), timestamp: BigInt(h.timestamp), coinbase: ZERO_ADDRESS,
        gasLimit: BigInt(h.gasLimit), prevRandao: HDR.ZERO_HASH,
        baseFee: this.chain.baseFee, chainId: this.chain.chainId,
      };
    }
    return this.chain._blockContext(h, parent, HDR.coinbaseAddress(h.coinbasePub));
  }

  _entryFor(at) {
    return at === 'pending'
      ? this.chain.entry(this.chain.tipId)
      : this.chain.entryAt(Number(at));
  }

  /**
   * The gas a speculative run may burn, which is NOT whatever the caller asked for.
   *
   * `eth_call` and `eth_estimateGas` are the only unauthenticated way to make this
   * process execute EVM code, and this node is single-threaded: the run holds the
   * event loop for its whole duration, so p2p, mining and the /info healthcheck
   * compose polls all stop with it. A transaction cannot do that — a block's gas
   * limit bounds it, and it has to be mined first — so the call path has to apply
   * a bound itself or a stranger's one request is an outage. Measured before any
   * clamp existed: `gas: 0x11e1a300` (300M, ten times the block limit) blocked the
   * loop for 3.6 s from a single request — the same spin loop at the block gas
   * limit is 0.37 s — and larger values scaled linearly with nothing to stop them.
   *
   * The cap is `EVM_RPC_GAS_CAP`, a third of the block gas limit by default and
   * NOT the block gas limit itself — the reasoning for the number is in params.js.
   * Clamping SILENTLY rather than erroring is deliberate and matches what geth
   * does with `--rpc.gascap`: a caller asking for more gas than the endpoint will
   * spend is asking a question about a transaction this node would not run anyway,
   * and the honest answer is what happens at the limit that applies. The clamp
   * lives here rather than in each caller because it was once in `estimateGas` and
   * not in `call`, and one copy of a rule cannot drift from the other.
   */
  _capFor(msg) {
    const asked = BigInt(msg.gas === null || msg.gas === undefined ? this.rpcGasCap : msg.gas);
    return asked > this.rpcGasCap ? this.rpcGasCap : asked;
  }

  /**
   * The wall clock one RPC request may spend executing, as a fresh `Deadline`.
   *
   * WHY GAS IS NOT ENOUGH, and why this is the half of the fix that actually stops
   * the attack. Gas prices instructions as a native client experiences them; this
   * interpreter's spread between its cheapest and dearest gas is 135x
   * (docs/robustness-review.md §6). At the 10M cap, ordinary compute is 160 ms and
   * blake2f is 3.5 s — and blake2f is one CALL into one loop with no instruction
   * boundary in it, which is why the deadline is handed all the way down to the
   * precompile rather than only checked between opcodes.
   *
   * ONE DEADLINE PER REQUEST, NOT PER EXECUTION. `estimateGas` re-executes the
   * message up to 33 times, so a per-execution budget would authorise 33 times the
   * outage; the bisection shares this one and stops when it is gone. Not every
   * probe costs a run — one that is out of gas before the first opcode is free,
   * and a message that fails at the cap returns after a single execution — but a
   * message that succeeds near the cap pays for roughly half of them: the blake2f
   * measurement in the header is 26 probes, 14 of which really executed.
   *
   * The consensus path must never see one of these. See the header of
   * evm/interpreter.js: a validator that gave up on a block because its machine
   * was busy would fork away from one that did not.
   */
  _deadline() { return new Deadline(this.rpcTimeBudgetMs); }

  /**
   * One speculative execution. Never throws — an EVM failure is a returned value
   * (spec §0), and so is a JavaScript error inside the interpreter, which would
   * otherwise be indistinguishable from a correctly-rejected transaction.
   *
   * The state is `speculativeStateAt`, not `stateAt`: every write this run makes
   * lands in a Map that is unreachable the moment this function returns, so an
   * `eth_call` cannot add a single node to the chain's own store. See the note on
   * that method — this is the one call site that must never use the real store.
   *
   * `deadline` is asked whether it tripped rather than the result being matched on
   * `ERR.TIMEOUT`, because a contract may CALL another, see that call fail and
   * return normally — reporting that as the callee's own outcome would turn "this
   * node gave up" into "your contract returned false".
   */
  _run(msg, entry, gasLimit, deadline) {
    const state = this.chain.speculativeStateAt(entry.id);
    const ctx = this._contextFor(entry);
    const from = msg.from || ZERO_ADDRESS;
    const value = msg.value === null || msg.value === undefined ? 0n : msg.value;
    const data = msg.data || Buffer.alloc(0);
    const creation = !msg.to;

    const intrinsic = gas.intrinsicGas({ data, isCreation: creation });
    if (gasLimit < intrinsic) return { ok: false, error: 'intrinsic gas too low' };
    if (creation && gas.initcodeTooLarge(data.length)) return { ok: false, error: 'max initcode size exceeded' };

    state.beginTransaction();
    state.prepareAccessList({
      origin: from,
      to: creation ? null : msg.to,
      coinbase: ctx.coinbase,
      precompiles: PRECOMPILES,
    });

    const evm = new EVM({
      state,
      block: ctx,
      tx: { origin: from, gasPrice: msg.gasPrice || 0n },
      blockHash: this.chain._blockHashFn(entry.block.header.prevHash, entry.height),
      deadline,
    });

    const execGas = gasLimit - intrinsic;
    const r = creation
      ? evm.create({ caller: from, initcode: data, gas: execGas, value })
      : evm.call({ caller: from, to: msg.to, value, data, gas: execGas });

    if (evm.timedOut) return { ok: false, timeout: true, error: ERR.TIMEOUT };
    if (r.internalError) return { ok: false, error: 'internal: ' + r.internalError };
    if (!r.exception) {
      const refund = gas.refundAllowance(gasLimit - r.gasLeft, state.getRefund());
      return { ok: true, returnData: r.returnData, gas: gasLimit - r.gasLeft - refund };
    }
    if (r.exception === ERR.REVERT) return { ok: false, reverted: true, returnData: r.returnData };
    return { ok: false, error: r.exception };
  }

  call(msg, at) {
    const entry = this._entryFor(at);
    if (!entry) return { ok: false, error: 'header not found' };
    return this._run(msg, entry, this._capFor(msg), this._deadline());
  }

  /**
   * The smallest gas limit at which this message succeeds, by bisection.
   *
   * The failure at the cap is returned verbatim rather than as "gas required
   * exceeds allowance": a revert here is almost always a genuine revert, and
   * turning it into a gas error is how a developer spends an afternoon raising a
   * limit that was never the problem.
   *
   * THE BUDGET IS SHARED BY EVERY PROBE, and running out of it mid-bisection is
   * NOT an error — it returns the smallest limit already proven to work. That is
   * a true answer, just a loose one: `best` is a limit at which this message
   * succeeded, and an over-estimate costs the caller nothing, because a
   * transaction is charged for the gas it uses and not for the limit it names.
   * Failing instead would deny an answer that has already been computed. Only a
   * timeout on the FIRST probe is fatal, because then nothing is known at all.
   */
  estimateGas(msg, at) {
    const entry = this._entryFor(at);
    if (!entry) return { ok: false, error: 'header not found' };
    const deadline = this._deadline();
    let hi = this._capFor(msg);

    const top = this._run(msg, entry, hi, deadline);
    if (!top.ok) return top;

    let lo = gas.intrinsicGas({ data: msg.data || Buffer.alloc(0), isCreation: !msg.to }) - 1n;
    let best = hi;
    for (let i = 0; i < ESTIMATE_ITERATIONS && lo + 1n < hi; i++) {
      const mid = (lo + hi) / 2n;
      const r = this._run(msg, entry, mid, deadline);
      if (r.timeout) break;
      if (r.ok) { hi = mid; best = mid; } else lo = mid;
    }
    return { ok: true, returnData: top.returnData, gas: best };
  }

  sendRawTransaction(raw) {
    if (!this.submit) return { ok: false, error: 'this node does not accept transactions' };
    return this.submit(raw);
  }

  // ---- the mempool, as the RPC sees it -------------------------------------

  /** geth's two counts, for `txpool_status`. See Mempool#status. */
  txpoolStatus() {
    const s = this.mempool.status();
    return { pending: BigInt(s.pending), queued: BigInt(s.queued) };
  }

  /**
   * The mempool's admission journal, for `eth_newPendingTransactionFilter`.
   *
   * Passed straight through rather than re-derived: the pool is where a
   * transaction is ANNOUNCED, and it is announced whether it arrived over
   * `eth_sendRawTransaction` or over p2p gossip, which is exactly what a pending
   * filter is asking about. Deriving it here from `mempool.list()` instead would
   * mean diffing the pool per poll, and would report a mined transaction as
   * "removed" — a pending filter has no such concept.
   */
  pendingSince(cursor) { return this.mempool.pendingSince(cursor); }

  syncing() { return false; }
}

module.exports = { RpcChain, ESTIMATE_ITERATIONS };
