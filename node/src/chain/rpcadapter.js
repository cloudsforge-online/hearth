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
 * THREE THINGS IN HERE ARE NOT MECHANICAL AND ARE WORTH READING:
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
 */

const P = require('../params');
const HDR = require('./header');
const TX = require('./transaction');
const gas = require('../evm/gas');
const bloom = require('./bloom');
const { EVM, ERR } = require('../evm/interpreter');
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
   */
  constructor({ chain, mempool, submit = null, gasPrice = P.EVM_MIN_GAS_PRICE }) {
    this.chain = chain;
    this.mempool = mempool;
    this.submit = submit;
    this.suggestedGasPrice = BigInt(gasPrice);
  }

  // ---- chain metadata ------------------------------------------------------

  chainId() { return BigInt(this.chain.chainId); }
  blockNumber() { return BigInt(this.chain.height); }
  gasPrice() { return this.suggestedGasPrice; }

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
   * One speculative execution. Never throws — an EVM failure is a returned value
   * (spec §0), and so is a JavaScript error inside the interpreter, which would
   * otherwise be indistinguishable from a correctly-rejected transaction.
   */
  _run(msg, entry, gasLimit) {
    const state = this.chain.stateAt(entry.id);
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
    });

    const execGas = gasLimit - intrinsic;
    const r = creation
      ? evm.create({ caller: from, initcode: data, gas: execGas, value })
      : evm.call({ caller: from, to: msg.to, value, data, gas: execGas });

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
    const cap = msg.gas === null || msg.gas === undefined ? this.chain.gasLimit : msg.gas;
    return this._run(msg, entry, BigInt(cap));
  }

  /**
   * The smallest gas limit at which this message succeeds, by bisection.
   *
   * The failure at the cap is returned verbatim rather than as "gas required
   * exceeds allowance": a revert here is almost always a genuine revert, and
   * turning it into a gas error is how a developer spends an afternoon raising a
   * limit that was never the problem.
   */
  estimateGas(msg, at) {
    const entry = this._entryFor(at);
    if (!entry) return { ok: false, error: 'header not found' };
    let hi = BigInt(msg.gas === null || msg.gas === undefined ? this.chain.gasLimit : msg.gas);
    if (hi > this.chain.gasLimit) hi = this.chain.gasLimit;

    const top = this._run(msg, entry, hi);
    if (!top.ok) return top;

    let lo = gas.intrinsicGas({ data: msg.data || Buffer.alloc(0), isCreation: !msg.to }) - 1n;
    let best = hi;
    for (let i = 0; i < ESTIMATE_ITERATIONS && lo + 1n < hi; i++) {
      const mid = (lo + hi) / 2n;
      const r = this._run(msg, entry, mid);
      if (r.ok) { hi = mid; best = mid; } else lo = mid;
    }
    return { ok: true, returnData: top.returnData, gas: best };
  }

  sendRawTransaction(raw) {
    if (!this.submit) return { ok: false, error: 'this node does not accept transactions' };
    return this.submit(raw);
  }

  syncing() { return false; }
}

module.exports = { RpcChain, ESTIMATE_ITERATIONS };
