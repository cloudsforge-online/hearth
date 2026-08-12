'use strict';
/* The `eth_*` method surface — docs/evm-spec.md §6.
 *
 * ============================================================================
 * THE CHAIN INTERFACE — this comment is phase 5's brief
 * ============================================================================
 *
 * The chain does not exist yet, so this layer is written against the interface
 * below and tested against an in-memory fake (test/jsonrpc.js). Phase 5
 * implements exactly this. Nothing else in this directory knows anything about
 * blocks, state or the mempool.
 *
 * THE ONE RULE THAT MATTERS: the chain speaks in NATIVE JS VALUES — `bigint`
 * for every number, `Buffer`/`Uint8Array` for every byte string — and NEVER in
 * hex strings. All hex encoding lives in hex.js and is applied exactly once, on
 * the way out. If the chain starts returning "0x…" strings, the QUANTITY/DATA
 * distinction gets decided in two places and one of them will be wrong.
 *
 * Every method may return its value directly or as a Promise; all call sites
 * await. Methods marked (optional) may be absent and have a documented
 * fallback. No method should throw for "not found" — return null.
 *
 * ---- reference types -------------------------------------------------------
 *
 *   BlockRef = bigint | 'pending'
 *       A canonical block height, or the mempool-applied pending state. See
 *       "on 'pending'" below.
 *
 *   Address  = Buffer(20)      Hash = Buffer(32)      Bloom = Buffer(256)
 *
 * ---- chain metadata --------------------------------------------------------
 *
 *   chainId()      -> bigint                7411n (docs/evm-spec.md §1)
 *   blockNumber()  -> bigint                height of the canonical tip
 *   gasPrice()     -> bigint                suggested gas price in wei
 *   syncing()      -> false | {startingBlock,currentBlock,highestBlock: bigint}
 *                                           (optional; defaults to false)
 *
 * ---- state readers ---------------------------------------------------------
 *
 *   getBalance(addr: Address, at: BlockRef)             -> bigint
 *   getNonce(addr: Address, at: BlockRef)               -> bigint
 *   getCode(addr: Address, at: BlockRef)                -> Buffer (empty if EOA)
 *   getStorageAt(addr: Address, key: Buffer(32), at)    -> Buffer(32)
 *
 *   An unknown account is not an error: balance 0n, nonce 0n, empty code, a
 *   32-byte zero storage word. `getStorageAt` MUST return a full 32 bytes,
 *   zero-padded — clients slice it by offset.
 *
 * ---- blocks, transactions, receipts ---------------------------------------
 *
 *   getBlockByNumber(n: bigint, fullTx: boolean) -> Block | null
 *   getBlockByHash(h: Hash, fullTx: boolean)     -> Block | null
 *   getTransactionByHash(h: Hash)                -> Transaction | null
 *   getTransactionReceipt(h: Hash)               -> Receipt | null
 *   getBlockReceipts(n: bigint)                  -> Receipt[]   (for eth_getLogs)
 *
 *   `fullTx` is a hint only: when false the chain may leave `block.transactions`
 *   as an array of Hash instead of Transaction objects, which is the cheap path
 *   for the common case. Correctness never depends on it — this layer accepts
 *   either shape and only requires full objects when the caller asked for them.
 *
 *   Block = {
 *     number: bigint, hash: Hash, parentHash: Hash,
 *     nonce: Buffer(8),          // the Homefire PoW nonce, low 8 bytes if wider
 *     mixHash: Hash,             // the Homefire PoW digest — the PREVRANDAO source (§5)
 *     logsBloom: Bloom,
 *     transactionsRoot: Hash, stateRoot: Hash, receiptsRoot: Hash,
 *     miner: Address,            // the coinbase, 0x-form — NOT coinbasePub
 *     difficulty: bigint,        // this block's work, derived from `target`
 *     totalDifficulty: bigint,   // cumulative work to and including this block
 *     extraData: Buffer,         // may be empty
 *     size: bigint,              // RLP byte length of the block as served
 *     gasLimit: bigint, gasUsed: bigint,
 *     timestamp: bigint,         // UNIX SECONDS, not milliseconds — see below
 *     transactions: Transaction[] | Hash[],
 *   }
 *
 *   `sha3Uncles` and `uncles` are NOT chain fields: Hearth has no uncles, so
 *   this layer always emits the RLP hash of the empty list and []. Omitting
 *   either breaks clients that assume Ethereum's block shape.
 *
 *   `timestamp` is SECONDS. The v1 header stores milliseconds
 *   (node/src/block.js), so phase 5 must divide. Getting this wrong makes every
 *   explorer date land in the year 55000 and every `block.timestamp` deadline
 *   in a Solidity contract — Uniswap's router, for one — behave nonsensically.
 *
 *   `baseFeePerGas` is deliberately absent: v1 has no EIP-1559 (§3, §9), and
 *   ethers/viem use the absence of that field to fall back to legacy pricing.
 *   Emitting a zero base fee would make them advertise type-2 transactions we
 *   cannot execute. Same for withdrawals/withdrawalsRoot, which are beacon
 *   chain artefacts.
 *
 *   Transaction = {
 *     hash: Hash, nonce: bigint, from: Address, to: Address | null,
 *     value: bigint, gasPrice: bigint, gas: bigint, input: Buffer,
 *     v: bigint, r: bigint, s: bigint,
 *     chainId: bigint | null,        // null for a pre-155 unprotected tx (§3)
 *     blockHash: Hash | null, blockNumber: bigint | null,
 *     transactionIndex: bigint | null,   // all three null while pending
 *   }
 *
 *   Receipt = {
 *     transactionHash: Hash, transactionIndex: bigint,
 *     blockHash: Hash, blockNumber: bigint,
 *     from: Address, to: Address | null,
 *     cumulativeGasUsed: bigint, gasUsed: bigint, effectiveGasPrice: bigint,
 *     contractAddress: Address | null,   // set only for a creation
 *     logs: Log[], logsBloom: Bloom,
 *     status: 0 | 1,                     // 1 = success. A reverted tx is a
 *                                        // SUCCESSFUL rpc call with status 0x0.
 *   }
 *
 *   Log = {
 *     address: Address, topics: Hash[] (0–4), data: Buffer,
 *     blockNumber: bigint, blockHash: Hash,
 *     transactionHash: Hash, transactionIndex: bigint,
 *     logIndex: bigint,        // index within the BLOCK, not the transaction
 *     removed: boolean,        // true only when serving a reorged-out log
 *   }
 *   Logs inside a receipt may omit the block/transaction fields; this layer
 *   fills them from the receipt, and numbers logIndex per block in order.
 *
 * ---- execution -------------------------------------------------------------
 *
 *   call(msg: CallMsg, at: BlockRef)        -> ExecResult
 *   estimateGas(msg: CallMsg, at: BlockRef) -> ExecResult with { gas: bigint }
 *   sendRawTransaction(raw: Buffer)         -> { ok: true, hash: Hash }
 *                                            | { ok: false, error: string }
 *
 *   CallMsg = { from: Address|null, to: Address|null, gas: bigint|null,
 *               gasPrice: bigint|null, value: bigint|null, data: Buffer|null,
 *               nonce: bigint|null }
 *   Every field may be null and the chain applies its own defaults (from =
 *   the zero address, gas = the RPC gas cap, gasPrice = 0 for a call).
 *   `gas` is a REQUEST, not a grant: the chain clamps it — to `EVM_RPC_GAS_CAP`,
 *   a third of the block gas limit — for both methods, and abandons a run that
 *   outlives `EVM_RPC_TIME_BUDGET_MS`. This layer is unauthenticated and the node
 *   is single-threaded, so an unbounded run is an outage anyone can order; both
 *   bounds are argued in params.js.
 *
 *   ExecResult — never a thrown error, matching the rule in §0 of the spec that
 *   an implementation signals EVM failure by returning, never by throwing,
 *   because a thrown TypeError in the interpreter would otherwise be
 *   indistinguishable from a correctly-rejected transaction:
 *
 *     { ok: true,  returnData: Buffer, gas?: bigint }
 *     { ok: false, reverted: true, returnData: Buffer }   // REVERT; may be empty
 *     { ok: false, error: 'out of gas' | 'invalid opcode' | … }
 *     { ok: false, timeout: true, error: 'execution timeout' }
 *
 *   The last is NOT an EVM outcome — no transaction can halt for it — it is this
 *   node saying it will not spend more of its only thread on the question. It
 *   goes back as a plain server error, deliberately: a client that retried it as
 *   if it were transient would be repeating the request that caused it.
 *
 *   The `reverted` case is what lets ethers decode a custom error instead of
 *   showing "unknown error": it becomes JSON-RPC code 3 with the raw revert
 *   payload in `data`.
 *
 * ---- logs ------------------------------------------------------------------
 *
 *   bloomMatches(bloom: Bloom, item: Buffer) -> boolean    (optional)
 *
 *   `eth_getLogs` walks the requested range and skips any block whose header
 *   bloom cannot contain the filter. That test is one line of chain/bloom.js
 *   (phase 4), and delegating it keeps the bit-order convention in exactly one
 *   vector-tested place. If the chain does not expose it we fall back to the
 *   local implementation below — identical in intent, but the delegated one is
 *   the authority.
 *
 *   getLogs(filter) -> Log[] (optional)
 *
 *   An indexed implementation may answer the whole query itself; the filter is
 *   handed over already normalised as
 *   { fromBlock: bigint, toBlock: bigint, addresses: Address[],
 *     topics: (Hash[]|null)[] } and must apply exactly the matching rules
 *   documented at `logMatches` below. Absent, we scan with getBlockReceipts.
 *
 * ---- the node, as opposed to the chain (all optional) ----------------------
 *
 *   peerCount()   -> bigint     connected p2p peers      -> net_peerCount
 *   mining()      -> boolean    is this node mining      -> eth_mining
 *   hashrate()    -> bigint     hashes per second        -> eth_hashrate
 *   coinbase()    -> Address    where this node mines to -> eth_coinbase
 *   txpoolStatus() -> { pending: bigint, queued: bigint } -> txpool_status
 *   blockHashAt(n: bigint) -> Hash | null   a cheap header-only hash lookup
 *   chainStart() -> { launchedAt: bigint|null, launchHeight, genesisTimestamp,
 *                     height: bigint }                   -> hearth_chainStart
 *
 *   EACH ONE THAT IS ABSENT MAKES ITS METHOD ABSENT, rather than making it
 *   answer a default. "0 peers" and "not mining" are meaningful answers; a node
 *   that cannot tell must say -32601 and let the caller decide, because a
 *   dashboard that is told zero peers reports the network as down.
 *
 *   pendingSince(cursor: number | null) -> { cursor: number, hashes: Hash[] }
 *
 *   The mempool's admission journal, for eth_newPendingTransactionFilter. A
 *   null cursor means "start from now" and returns no hashes. The journal is
 *   BOUNDED — see chain/mempool.js — so a cursor older than the oldest entry
 *   held gets everything still there and silently misses the rest. That is the
 *   right degradation for a filter that has not been polled in a long time, and
 *   it is why the journal is a ring rather than a per-filter queue: a queue
 *   nobody drains is the unbounded growth this endpoint must not have.
 *
 * ---- per-request context ---------------------------------------------------
 *
 * Every method takes (params, ctx). `ctx.remote` is the caller's address as the
 * transport saw it, and it exists for exactly one reason: filters are
 * server-side state and the per-caller cap on them has to be keyed on
 * something. No method's ANSWER depends on it.
 *
 * ---- on 'pending' ----------------------------------------------------------
 *
 * `at` is 'pending' when the caller asked for the pending tag. It means "tip
 * state with the mempool applied". An implementation MAY alias it to the tip,
 * but then eth_getTransactionCount(addr, 'pending') under-reports and every
 * wallet that sends two transactions in a row produces a nonce collision — so
 * at minimum the pending nonce must count queued mempool transactions.
 *
 * eth_getBlockByNumber('pending') returns null: there is no pending block on
 * this chain, and a synthesised one would have a null hash, which confuses more
 * clients than the null does.
 * ============================================================================
 */

const H = require('./hex');
const { RpcError, CODES } = H;
const { keccak256 } = require('../crypto/keccak');
const { FilterRegistry } = require('./filters');

/** keccak256(rlp([])) — the uncle hash of a chain that has no uncles. */
const EMPTY_UNCLE_HASH = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347';
/** Error(string) — the selector Solidity's `require(cond, "…")` reverts with. */
const ERROR_STRING_SELECTOR = '08c379a0';

const DEFAULTS = {
  /** How deep a block must be before `safe`/`finalized` will name it. */
  confirmations: 12,
  /** Widest eth_getLogs range, in blocks. A wallet asks for a handful; an
   *  indexer that asks for a million is a denial of service, not a user. */
  maxLogRange: 10_000,
  /** Cap on logs returned, mirroring geth's "query returned more than N results". */
  maxLogs: 20_000,
  /** Consulted only when the chain does not export bloomMatches. */
  useBloom: true,
  /** Serve `eth_feeHistory` and `eth_maxPriorityFeePerGas` at all. OFF, and the
   *  measurement that decided it is at the methods themselves. */
  feeHistory: false,
  /** Widest `blockCount` eth_feeHistory will serve, when it is on.
   *
   *  geth allows 1,024 and can afford to because it caches the per-block fee
   *  summary. Here every block in the window costs a `getBlockReceipts`, which
   *  on the real chain decodes each transaction and recovers its sender, so the
   *  window is the cost. 128 blocks is over half an hour of chain at the target
   *  interval — far more history than any fee UI plots — and it is two orders of
   *  magnitude under the 10,000-block `maxLogRange` this endpoint already
   *  allows, so it cannot be the cheapest way to make this node work. */
  maxFeeHistory: 128,
  /** Block hashes one eth_getFilterChanges poll may return before it stops and
   *  leaves the rest for the next one. A filter that has not been polled since
   *  a long sync must not answer with the whole chain in one response. */
  maxBlockHashes: 1_000,
  /**
   * Addresses plus topic values one log filter may name.
   *
   * THIS IS A MEMORY BOUND, NOT A TASTE ONE, and it is why it applies to
   * `eth_getLogs` as well as to the stored filters. `eth_newFilter` KEEPS its
   * criteria for the filter's whole lifetime, and `topics` accepts an OR-set of
   * unbounded length — so without this, one caller's 32 filters could each hold
   * a 5 MB body limit's worth of hashes and the global cap of 1,024 filters
   * would authorise gigabytes. 1,000 is far above any real client (an indexer
   * watching a thousand contracts) and caps one filter's criteria at ~32 kB.
   */
  maxFilterCriteria: 1_000,
  /**
   * Block hashes a LOG filter remembers behind its cursor, so that it can tell
   * the chain moved under it and rewind — see `logFilterChanges`.
   *
   * It is deliberately the SAME number as `confirmations`: this node already
   * tells every caller that a block `confirmations` deep is `finalized`, and a
   * filter that reconciled reorgs deeper than the depth the node calls final
   * would be making a promise the rest of the surface does not. It is also the
   * memory bound — 12 × 32 bytes per filter, so the 1,024-filter global cap
   * authorises 384 kB of it and not a byte more.
   */
  filterReorgDepth: 12,
};

// ---- helpers ---------------------------------------------------------------

function isBytes(v) { return v instanceof Uint8Array; }

/** Positional params only — Ethereum has no by-name convention, and geth agrees. */
function arity(params, min, max) {
  if (params.length < min) {
    throw RpcError.invalidParams(`missing value for required argument ${params.length}`);
  }
  if (params.length > max) {
    throw RpcError.invalidParams(`too many arguments, want at most ${max}`);
  }
}

function decodeBool(v, what) {
  if (typeof v !== 'boolean') throw RpcError.invalidParams(`${what}: expected a boolean`);
  return v;
}

/**
 * Bloom membership, the go-ethereum bloom9 convention: take keccak256(item) and
 * for each of the first three big-endian 16-bit words, set/test bit
 * (word & 0x7ff) counted from the LOW end of the 256-byte filter.
 *
 * Used only when the chain does not supply its own; see the interface note. A
 * bloom test that is wrong in the "no" direction silently loses logs, which is
 * why the scan is written so that turning the bloom off must produce byte
 * identical results (test/jsonrpc.js asserts exactly that).
 */
function bloomContains(bloom, item) {
  if (!isBytes(bloom) || bloom.length !== 256) return true;   // can't tell — don't skip
  const h = keccak256(Buffer.isBuffer(item) ? item : Buffer.from(item));
  for (let i = 0; i < 6; i += 2) {
    const bit = ((h[i] << 8) | h[i + 1]) & 0x7ff;
    if ((bloom[255 - (bit >> 3)] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/**
 * Decode a Solidity `Error(string)` revert payload so the message can be put
 * where a human will see it. Custom errors and Panic(uint256) are left alone —
 * they go back as raw `data`, which is what ethers needs to decode them against
 * the ABI. Deliberately paranoid about lengths: this parses attacker-chosen
 * bytes.
 */
function decodeRevertReason(data) {
  if (!isBytes(data) || data.length < 4 + 32 + 32) return null;
  if (Buffer.from(data.subarray(0, 4)).toString('hex') !== ERROR_STRING_SELECTOR) return null;
  const body = Buffer.from(data.subarray(4));
  const offset = Number(BigInt('0x' + body.subarray(0, 32).toString('hex')));
  if (!Number.isSafeInteger(offset) || offset + 32 > body.length) return null;
  const len = Number(BigInt('0x' + body.subarray(offset, offset + 32).toString('hex')));
  if (!Number.isSafeInteger(len) || offset + 32 + len > body.length) return null;
  return body.subarray(offset + 32, offset + 32 + len).toString('utf8');
}

/** Turn an ExecResult into a value, or into the error the client expects. */
function unwrapExec(res, what) {
  if (!res || typeof res !== 'object') throw RpcError.internal(`${what}: chain returned no result`);
  if (res.ok) return res;
  if (res.reverted) {
    const data = isBytes(res.returnData) ? res.returnData : Buffer.alloc(0);
    const reason = decodeRevertReason(data);
    throw new RpcError(
      CODES.EXECUTION_REVERTED,
      reason ? `execution reverted: ${reason}` : 'execution reverted',
      H.encodeData(data),
    );
  }
  throw RpcError.server(String(res.error || 'execution failed'));
}

/**
 * eth_call and eth_estimateGas take an optional third argument, a state
 * override map. We do not implement it — and ignoring it would answer a
 * question the caller did not ask while looking exactly like a correct answer,
 * so it is refused. An empty object is treated as "no override", because some
 * clients always send one.
 */
function rejectStateOverride(v) {
  if (v === undefined || v === null) return;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return;
  throw RpcError.invalidParams('state overrides are not supported');
}

/** Fields a call/transaction object may carry. Anything else is a typo. */
const CALL_KEYS = new Set([
  'from', 'to', 'gas', 'gasPrice', 'value', 'data', 'input', 'nonce', 'type',
  'chainId', 'accessList', 'maxFeePerGas', 'maxPriorityFeePerGas',
]);

/**
 * Normalise the call object shared by eth_call and eth_estimateGas.
 *
 * `data` and `input` are both accepted because the ecosystem never converged:
 * ethers and viem send `data`, newer geth-shaped tooling sends `input`. If both
 * are present they must agree, since guessing which one the caller meant is how
 * a transaction executes something other than what was signed.
 *
 * A 1559-shaped call (maxFeePerGas, no gasPrice) is accepted and priced as
 * legacy rather than rejected: v1 has no fee market, and a wallet that always
 * sends type-2 fields should still be able to read the chain.
 */
function parseCallMsg(o, what = 'call object') {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    throw RpcError.invalidParams(`${what}: expected an object`);
  }
  for (const k of Object.keys(o)) {
    if (!CALL_KEYS.has(k)) throw RpcError.invalidParams(`${what}: unknown field "${k}"`);
  }
  const has = k => o[k] !== undefined && o[k] !== null;
  let data = null;
  if (has('data') && has('input')) {
    const a = H.decodeData(o.data, `${what}.data`);
    const b = H.decodeData(o.input, `${what}.input`);
    if (!a.equals(b)) throw RpcError.invalidParams(`${what}: data and input are both set and differ`);
    data = a;
  } else if (has('data')) data = H.decodeData(o.data, `${what}.data`);
  else if (has('input')) data = H.decodeData(o.input, `${what}.input`);

  let gasPrice = has('gasPrice') ? H.decodeQuantity(o.gasPrice, `${what}.gasPrice`) : null;
  if (gasPrice === null && has('maxFeePerGas')) {
    gasPrice = H.decodeQuantity(o.maxFeePerGas, `${what}.maxFeePerGas`);
  }
  return {
    from: has('from') ? H.decodeAddress(o.from, `${what}.from`) : null,
    to: has('to') ? H.decodeAddress(o.to, `${what}.to`) : null,
    gas: has('gas') ? H.decodeQuantity(o.gas, `${what}.gas`) : null,
    gasPrice,
    value: has('value') ? H.decodeQuantity(o.value, `${what}.value`) : null,
    data,
    nonce: has('nonce') ? H.decodeQuantity(o.nonce, `${what}.nonce`) : null,
  };
}

// ---- output formatting -----------------------------------------------------

function formatLog(log, ctx) {
  const at = ctx || {};
  return {
    address: H.encodeAddress(log.address, 'log.address'),
    topics: (log.topics || []).map((t, i) => H.encodeDataFixed(t, 32, `log.topics[${i}]`)),
    data: H.encodeData(log.data || Buffer.alloc(0), 'log.data'),
    blockNumber: H.encodeQuantity(pick(log.blockNumber, at.blockNumber), 'log.blockNumber'),
    transactionHash: H.encodeHash(pick(log.transactionHash, at.transactionHash), 'log.transactionHash'),
    transactionIndex: H.encodeQuantity(pick(log.transactionIndex, at.transactionIndex), 'log.transactionIndex'),
    blockHash: H.encodeHash(pick(log.blockHash, at.blockHash), 'log.blockHash'),
    logIndex: H.encodeQuantity(pick(log.logIndex, at.logIndex), 'log.logIndex'),
    removed: log.removed === true,
  };
}

function pick(a, b) { return a === undefined || a === null ? b : a; }

function formatTx(tx) {
  const out = {
    blockHash: tx.blockHash ? H.encodeHash(tx.blockHash, 'tx.blockHash') : null,
    blockNumber: tx.blockNumber === null || tx.blockNumber === undefined
      ? null : H.encodeQuantity(tx.blockNumber, 'tx.blockNumber'),
    transactionIndex: tx.transactionIndex === null || tx.transactionIndex === undefined
      ? null : H.encodeQuantity(tx.transactionIndex, 'tx.transactionIndex'),
    hash: H.encodeHash(tx.hash, 'tx.hash'),
    from: H.encodeAddress(tx.from, 'tx.from'),
    to: tx.to ? H.encodeAddress(tx.to, 'tx.to') : null,
    value: H.encodeQuantity(tx.value, 'tx.value'),
    gas: H.encodeQuantity(tx.gas, 'tx.gas'),
    gasPrice: H.encodeQuantity(tx.gasPrice, 'tx.gasPrice'),
    input: H.encodeData(tx.input || Buffer.alloc(0), 'tx.input'),
    nonce: H.encodeQuantity(tx.nonce, 'tx.nonce'),
    // Legacy only in v1 (§3). Clients branch on this to pick a signing scheme,
    // so it must be present and must be 0x0.
    type: '0x0',
    v: H.encodeQuantity(tx.v, 'tx.v'),
    r: H.encodeQuantity(tx.r, 'tx.r'),
    s: H.encodeQuantity(tx.s, 'tx.s'),
  };
  // Absent for a pre-155 unprotected transaction, which is exactly how a client
  // can tell that Multicall3's keyless deployment is unprotected.
  if (tx.chainId !== undefined && tx.chainId !== null) {
    out.chainId = H.encodeQuantity(tx.chainId, 'tx.chainId');
  }
  return out;
}

function formatBlock(b, fullTx) {
  const txs = b.transactions || [];
  return {
    number: H.encodeQuantity(b.number, 'block.number'),
    hash: H.encodeHash(b.hash, 'block.hash'),
    parentHash: H.encodeHash(b.parentHash, 'block.parentHash'),
    nonce: H.encodeDataFixed(b.nonce, 8, 'block.nonce'),
    sha3Uncles: EMPTY_UNCLE_HASH,
    logsBloom: H.encodeBloom(b.logsBloom, 'block.logsBloom'),
    transactionsRoot: H.encodeHash(b.transactionsRoot, 'block.transactionsRoot'),
    stateRoot: H.encodeHash(b.stateRoot, 'block.stateRoot'),
    receiptsRoot: H.encodeHash(b.receiptsRoot, 'block.receiptsRoot'),
    miner: H.encodeAddress(b.miner, 'block.miner'),
    difficulty: H.encodeQuantity(b.difficulty, 'block.difficulty'),
    totalDifficulty: H.encodeQuantity(b.totalDifficulty, 'block.totalDifficulty'),
    extraData: H.encodeData(b.extraData || Buffer.alloc(0), 'block.extraData'),
    size: H.encodeQuantity(b.size, 'block.size'),
    gasLimit: H.encodeQuantity(b.gasLimit, 'block.gasLimit'),
    gasUsed: H.encodeQuantity(b.gasUsed, 'block.gasUsed'),
    timestamp: H.encodeQuantity(b.timestamp, 'block.timestamp'),
    mixHash: H.encodeHash(b.mixHash, 'block.mixHash'),
    transactions: txs.map((t, i) => {
      if (isBytes(t)) {
        if (fullTx) throw RpcError.internal(`block.transactions[${i}]: full transaction requested, got a hash`);
        return H.encodeHash(t, `block.transactions[${i}]`);
      }
      return fullTx ? formatTx(t) : H.encodeHash(t.hash, `block.transactions[${i}].hash`);
    }),
    uncles: [],
  };
}

function formatReceipt(r) {
  const ctx = {
    blockNumber: r.blockNumber, blockHash: r.blockHash,
    transactionHash: r.transactionHash, transactionIndex: r.transactionIndex,
  };
  return {
    transactionHash: H.encodeHash(r.transactionHash, 'receipt.transactionHash'),
    transactionIndex: H.encodeQuantity(r.transactionIndex, 'receipt.transactionIndex'),
    blockHash: H.encodeHash(r.blockHash, 'receipt.blockHash'),
    blockNumber: H.encodeQuantity(r.blockNumber, 'receipt.blockNumber'),
    from: H.encodeAddress(r.from, 'receipt.from'),
    to: r.to ? H.encodeAddress(r.to, 'receipt.to') : null,
    cumulativeGasUsed: H.encodeQuantity(r.cumulativeGasUsed, 'receipt.cumulativeGasUsed'),
    gasUsed: H.encodeQuantity(r.gasUsed, 'receipt.gasUsed'),
    effectiveGasPrice: H.encodeQuantity(r.effectiveGasPrice, 'receipt.effectiveGasPrice'),
    contractAddress: r.contractAddress ? H.encodeAddress(r.contractAddress, 'receipt.contractAddress') : null,
    // logIndex is the log's position within the BLOCK, not within this receipt.
    // The old fallback numbered from zero per receipt, so a block whose first
    // transaction logs twice and whose second logs once produced 0, 1, 0 — and
    // (blockHash, logIndex) is the key every indexer dedupes on, so the third
    // log silently overwrites the first.
    //
    // There is no honest fallback here: a single receipt cannot know how many
    // logs preceded it in its block. So the chain must supply it, which the
    // interface at the top of this file already says it does, and an absent
    // value fails loudly rather than inventing a plausible wrong one.
    logs: (r.logs || []).map((l, i) => {
      if (l.logIndex === undefined || l.logIndex === null) {
        throw new TypeError(
          `receipt.logs[${i}].logIndex is missing — the chain must number logs across the block, ` +
          'and this layer cannot derive it from one receipt',
        );
      }
      return formatLog(l, { ...ctx, logIndex: l.logIndex });
    }),
    logsBloom: H.encodeBloom(r.logsBloom, 'receipt.logsBloom'),
    // A reverted transaction is a mined transaction: the RPC call succeeds and
    // the receipt says 0x0. Returning an error here is a classic own goal —
    // ethers would report a network failure instead of a failed transaction.
    status: r.status ? '0x1' : '0x0',
    type: '0x0',
  };
}

// ---- log filtering ---------------------------------------------------------

/**
 * Topic matching, which is fiddly enough to be worth stating outright:
 *
 *   - the filter is positional; position i constrains log.topics[i]
 *   - null (or an empty array) at position i matches anything
 *   - a single topic at position i must equal log.topics[i]
 *   - an ARRAY at position i is an OR: any one of them matches
 *   - a log with FEWER topics than the filter has positions never matches, but
 *     a log with more does — a filter is a prefix constraint
 *
 * So [A, null, [C, D]] reads "topic0 is A, topic1 is anything, topic2 is C or
 * D". Getting the OR wrong is invisible until an event with an indexed enum
 * stops being delivered.
 */
function logMatches(log, filter) {
  if (filter.addresses.length) {
    const a = Buffer.from(log.address);
    if (!filter.addresses.some(x => x.equals(a))) return false;
  }
  if (filter.topics.length > (log.topics || []).length) return false;
  for (let i = 0; i < filter.topics.length; i++) {
    const rule = filter.topics[i];
    if (rule === null) continue;
    const t = Buffer.from(log.topics[i]);
    if (!rule.some(x => x.equals(t))) return false;
  }
  return true;
}

/** Can this block's header bloom possibly hold a match? Same rules, blurred. */
function bloomMayMatch(bloom, filter, test) {
  if (filter.addresses.length && !filter.addresses.some(a => test(bloom, a))) return false;
  for (const rule of filter.topics) {
    if (rule === null) continue;
    if (!rule.some(t => test(bloom, t))) return false;
  }
  return true;
}

function parseTopics(raw, what = 'topics') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw RpcError.invalidParams(`${what}: expected an array`);
  if (raw.length > 4) throw RpcError.invalidParams(`${what}: at most 4 topic positions`);
  return raw.map((rule, i) => {
    if (rule === null || rule === undefined) return null;
    if (Array.isArray(rule)) {
      // An empty OR-set is a wildcard, not "match nothing" — geth reads it that
      // way and clients emit it for an unconstrained middle position.
      if (rule.length === 0) return null;
      return rule.map((t, j) => H.decodeHash(t, `${what}[${i}][${j}]`));
    }
    return [H.decodeHash(rule, `${what}[${i}]`)];
  });
}

function parseAddresses(raw, what = 'address') {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map((a, i) => H.decodeAddress(a, `${what}[${i}]`));
  return [H.decodeAddress(raw, what)];
}

/**
 * `eth_feeHistory`'s block count, which is the one QUANTITY in this whole
 * surface that is NOT strictly a QUANTITY.
 *
 * geth types it `math.HexOrDecimal64` and its UnmarshalJSON takes a JSON number,
 * a decimal string and a hex string alike — so all three are in the wild, and
 * every client was written against whichever geth accepted. Rejecting the
 * non-canonical forms would be consistent with the rest of hex.js and would also
 * refuse callers geth answers, for a parameter where there is no wrong answer to
 * be had: a block count cannot be silently misread the way a wei value can.
 * Strictness is worth defending where a wrong answer is silent; here the only
 * thing it buys is an incompatibility.
 */
function decodeBlockCount(v, what = 'blockCount') {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw RpcError.invalidParams(`${what}: expected a non-negative integer`);
    return v;
  }
  if (typeof v === 'string') {
    if (/^0[xX]/.test(v)) return Number(H.decodeQuantity(v.toLowerCase(), what));
    if (/^[0-9]+$/.test(v)) return Number(v);
  }
  throw RpcError.invalidParams(`${what}: expected a block count as a number or a hex or decimal string`);
}

/**
 * The reward percentiles of one block: for each requested percentile, the gas
 * price paid by the transaction at that point of the block's gas-used
 * distribution. geth's algorithm exactly — sort ascending by reward, then walk
 * the cumulative gas used until it crosses each threshold — because a fee UI
 * plots these against geth's numbers and a different weighting shows a
 * different chain.
 *
 * ON THIS CHAIN THE REWARD IS THE WHOLE GAS PRICE. v1 has no EIP-1559 and so no
 * base fee; a miner keeps everything, which means "priority fee" and "gas price"
 * are the same number rather than the difference of two. See eth_feeHistory.
 */
function rewardPercentiles(receipts, gasUsed, percentiles) {
  if (!percentiles.length) return null;
  if (!receipts.length || gasUsed <= 0n) return percentiles.map(() => 0n);
  const sorted = receipts
    .map(r => ({ reward: BigInt(r.effectiveGasPrice || 0n), gas: BigInt(r.gasUsed || 0n) }))
    .sort((a, b) => (a.reward < b.reward ? -1 : a.reward > b.reward ? 1 : 0));
  const out = [];
  let i = 0;
  let cumulative = sorted[0].gas;
  for (const p of percentiles) {
    // Integer threshold, computed in BigInt so a 30M-gas block times a
    // percentile never rounds through a float.
    const threshold = (gasUsed * BigInt(Math.round(p * 100))) / 10_000n;
    while (cumulative < threshold && i < sorted.length - 1) {
      i += 1;
      cumulative += sorted[i].gas;
    }
    out.push(sorted[i].reward);
  }
  return out;
}

function parsePercentiles(raw, what = 'rewardPercentiles') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw RpcError.invalidParams(`${what}: expected an array of numbers`);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      throw RpcError.invalidParams(`${what}[${i}]: percentile must be between 0 and 100`);
    }
    // geth requires them to increase, and a client that sends them out of order
    // is reading the response positionally against an order it did not get.
    if (i > 0 && p <= raw[i - 1]) {
      throw RpcError.invalidParams(`${what}[${i}]: percentiles must be in increasing order`);
    }
    out.push(p);
  }
  return out;
}

// ---- the method table ------------------------------------------------------

const FILTER_KEYS = new Set(['fromBlock', 'toBlock', 'address', 'topics', 'blockHash']);

/**
 * Build the method table. `chain` is the interface documented at the top of
 * this file; everything else is optional tuning.
 */
function buildMethods(options = {}) {
  const chain = options.chain;
  if (!chain) throw new Error('jsonrpc: a chain is required');
  const opt = { ...DEFAULTS, ...options };
  const clientVersion = options.clientVersion
    || `Hearth/v${options.version || '0.2.0'}/${process.platform}-${process.arch}/node${process.versions.node}`;
  /* The only server-side state in this layer. Owned by the caller when there is
   * one (JsonRpcServer passes its own, so it can be inspected and cleared),
   * built here otherwise so a bare buildMethods() is still usable. */
  const filters = options.filters || new FilterRegistry(options);
  /** A caller identity for the filter cap; `ctx` is absent when a suite calls
   *  a method directly, and one bucket for all of those is correct. */
  const owner = ctx => (ctx && ctx.remote) || 'unknown';

  const bloomTest = typeof chain.bloomMatches === 'function'
    ? (bloom, item) => chain.bloomMatches(bloom, item)
    : bloomContains;

  const tip = () => Promise.resolve(chain.blockNumber());

  /**
   * Resolve a block parameter to a BlockRef the chain understands.
   * `strict` (state reads) errors on a height above the tip the way geth does;
   * block lookups instead want a null result, so they pass strict = false.
   */
  async function resolveRef(param, what, { allowPending = true, strict = true } = {}) {
    const p = H.parseBlockParam(param, what);
    if (p.hash) {
      const b = await chain.getBlockByHash(p.hash, false);
      if (!b) throw RpcError.server('header not found');
      return b.number;
    }
    if (p.number !== undefined) {
      if (strict && p.number > await tip()) throw RpcError.server('header not found');
      return p.number;
    }
    switch (p.tag) {
      case 'earliest': return 0n;
      case 'latest': return tip();
      case 'pending':
        if (!allowPending) throw RpcError.invalidParams(`${what}: the pending tag is not supported here`);
        return 'pending';
      case 'safe':
      case 'finalized': {
        const h = await tip();
        const d = BigInt(opt.confirmations);
        return h > d ? h - d : 0n;
      }
      default: throw RpcError.invalidParams(`${what}: unknown block tag`);
    }
  }

  async function scanLogs(filter) {
    if (typeof chain.getLogs === 'function') {
      const logs = await chain.getLogs(filter);
      return logs.map((l, i) => formatLog(l, { logIndex: pick(l.logIndex, BigInt(i)) }));
    }
    const out = [];
    for (let n = filter.fromBlock; n <= filter.toBlock; n++) {
      const block = await chain.getBlockByNumber(n, false);
      if (!block) continue;
      if (opt.useBloom && !bloomMayMatch(block.logsBloom, filter, bloomTest)) continue;
      const receipts = await chain.getBlockReceipts(n) || [];
      let logIndex = 0n;
      for (const r of receipts) {
        for (const log of (r.logs || [])) {
          const at = {
            blockNumber: pick(r.blockNumber, block.number),
            blockHash: pick(r.blockHash, block.hash),
            transactionHash: r.transactionHash,
            transactionIndex: r.transactionIndex,
            logIndex: pick(log.logIndex, logIndex),
          };
          logIndex += 1n;
          if (!logMatches(log, filter)) continue;
          out.push(formatLog(log, at));
          if (out.length > opt.maxLogs) {
            throw RpcError.server(`query returned more than ${opt.maxLogs} results`);
          }
        }
      }
    }
    return out;
  }

  /**
   * Validate and resolve a log-filter object into the normalised filter
   * `scanLogs` takes. Shared by `eth_getLogs`, `eth_newFilter` (which must
   * refuse a malformed filter at CREATION, not at the first poll, or a client
   * finds out about its own typo minutes later) and `eth_getFilterLogs`.
   *
   * A returned filter with `fromBlock > toBlock` names no blocks at all, which
   * is a legitimate answer of [] and not an error — a client polling
   * "lastSeen..latest" produces it every time it wins the race with a block.
   */
  async function buildLogFilter(raw, what = 'filter') {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw RpcError.invalidParams(`${what}: expected an object`);
    }
    for (const k of Object.keys(raw)) {
      if (!FILTER_KEYS.has(k)) throw RpcError.invalidParams(`${what}: unknown field "${k}"`);
    }
    const filter = {
      addresses: parseAddresses(raw.address, `${what}.address`),
      topics: parseTopics(raw.topics, `${what}.topics`),
      fromBlock: 0n,
      toBlock: 0n,
    };
    /* See `maxFilterCriteria`. Checked here rather than in eth_newFilter so that
     * the one-shot and the stored form cannot disagree about what is acceptable
     * — a filter refused at creation but accepted by eth_getLogs would be a
     * confusing pair of rules for the same object. */
    const named = filter.addresses.length
      + filter.topics.reduce((n, rule) => n + (rule === null ? 0 : rule.length), 0);
    if (named > opt.maxFilterCriteria) {
      throw RpcError.invalidParams(
        `${what}: at most ${opt.maxFilterCriteria} addresses and topic values in one filter, got ${named}`);
    }
    if (raw.blockHash !== undefined && raw.blockHash !== null) {
      // EIP-234: blockHash pins the query to one block and excludes a range.
      if (raw.fromBlock !== undefined || raw.toBlock !== undefined) {
        throw RpcError.invalidParams(`${what}: blockHash cannot be combined with fromBlock/toBlock`);
      }
      const b = await chain.getBlockByHash(H.decodeHash(raw.blockHash, `${what}.blockHash`), false);
      if (!b) throw RpcError.server('unknown block');
      filter.fromBlock = b.number;
      filter.toBlock = b.number;
      return filter;
    }
    const height = await tip();
    const opts = { allowPending: false, strict: false };
    const from = await resolveRef(raw.fromBlock, `${what}.fromBlock`, opts);
    const to = await resolveRef(raw.toBlock, `${what}.toBlock`, opts);
    if (from > to) throw RpcError.invalidParams(`${what}: fromBlock is after toBlock`);
    // A range past the tip is clamped rather than refused: a client polling
    // "from lastSeen to latest" races block production constantly.
    filter.fromBlock = from > height ? height + 1n : from;
    filter.toBlock = to > height ? height : to;
    if (filter.toBlock >= filter.fromBlock
        && filter.toBlock - filter.fromBlock + 1n > BigInt(opt.maxLogRange)) {
      throw RpcError.invalidParams(`${what}: range exceeds ${opt.maxLogRange} blocks`);
    }
    return filter;
  }

  /** A block's hash by height, header-only where the chain offers that. */
  async function blockHashAt(n) {
    if (typeof chain.blockHashAt === 'function') return chain.blockHashAt(n);
    const b = await chain.getBlockByNumber(n, false);
    return b ? b.hash : null;
  }

  /**
   * Rewind a log filter's cursor to the deepest height behind it whose block is
   * no longer the one it scanned, and forget that height and everything above.
   *
   * WITHOUT THIS A REORG DELIVERS THE WINNING BRANCH'S LOGS TO NOBODY. The
   * cursor only ever walks forward, so once it is past height N a different
   * block taking height N is invisible: the filter answers [], which reads
   * exactly like a quiet chain. This chain reorgs by design — evm-p2p-fork.js
   * reorgs three blocks and asserts a reorg must not silently swallow a user
   * transaction — and the events in that transaction deserve the same rule.
   *
   * `f.seen` is the last `filterReorgDepth` (height, hash) pairs the filter
   * scanned, oldest first and contiguous. It is walked from the newest back so
   * that a multi-block reorg rewinds to its deepest changed height in one pass;
   * a missing hash (the chain got shorter) counts as changed, because that
   * height will be refilled by the winning branch and must be re-scanned when
   * it is.
   *
   * WHAT IS NOT DONE HERE, deliberately: no `removed: true` log is emitted for
   * what was already delivered off the losing branch. geth does that from a
   * feed that RETAINS every subscription's results, which is the grow-forever
   * shape filters.js exists to refuse — and it is why `removed` is on every log
   * this surface formats, so a client that must reconcile can do it from
   * `blockHash` the way it already must for `eth_getLogs`.
   */
  async function rewindLogFilter(f) {
    const seen = f.seen;
    if (!seen || seen.length === 0) return;
    let rewindTo = null;
    for (let i = seen.length - 1; i >= 0; i--) {
      const current = await blockHashAt(seen[i].height);
      if (current && Buffer.from(current).equals(seen[i].hash)) break;
      rewindTo = seen[i].height;
    }
    if (rewindTo === null) return;
    f.next = rewindTo;
    f.seen = seen.filter(e => e.height < rewindTo);
  }

  /**
   * A log filter's new logs since its last poll.
   *
   * SCANNED ONE BLOCK AT A TIME, and the cursor advances per block, so that a
   * poll which reaches `maxLogs` returns what it has and leaves the rest for
   * the next call instead of failing forever on the same range. A window that
   * has fallen more than `maxLogRange` behind is caught up over several polls
   * for the same reason — this endpoint is unauthenticated, and "one request,
   * unbounded work" is the shape of every defect CF-09 closed.
   */
  async function logFilterChanges(f) {
    await rewindLogFilter(f);
    const height = await tip();
    let to = f.end === null ? height : (height < f.end ? height : f.end);
    const windowEnd = f.next + BigInt(opt.maxLogRange) - 1n;
    if (to > windowEnd) to = windowEnd;
    const out = [];
    let n = f.next;
    for (; n <= to; n++) {
      const logs = await scanLogs({ ...f.criteria, fromBlock: n, toBlock: n });
      for (const l of logs) out.push(l);
      if (out.length >= opt.maxLogs) { n += 1n; break; }
    }
    if (n > f.next) {
      /* Only the newest `filterReorgDepth` heights are remembered, and their
       * hashes are read AFTER the scan rather than during it: a poll catching
       * up over 10,000 blocks would otherwise pay 10,000 header reads to
       * remember twelve of them. */
      const depth = BigInt(opt.filterReorgDepth);
      let start = n - depth;
      if (start < f.next) start = f.next;
      const fresh = [];
      for (let h = start; h < n; h++) {
        const hash = await blockHashAt(h);
        if (hash) fresh.push({ height: h, hash: Buffer.from(hash) });
      }
      f.seen = (f.seen || []).concat(fresh).slice(-opt.filterReorgDepth);
      f.next = n;
    }
    return out;
  }

  /**
   * A block filter's new canonical head hashes.
   *
   * A REORG RE-DELIVERS THE REPLACED HEIGHT AND NOTHING BELOW IT. The filter
   * remembers one (height, hash) pair, so when the hash at that height no
   * longer matches it can tell that the chain moved under it but not how far —
   * and geth does not tell a client either: its block filter is fed from
   * ChainHeadEvent, which fires once for the new head after a reorg and never
   * re-announces the heights in between. A client that must not miss a
   * reorged-out block wants receipts and `eth_getBlockByNumber`, not this; this
   * is a "go and look, the head moved" signal and is documented as one.
   */
  async function blockFilterChanges(f) {
    const height = await tip();
    if (f.height > height) {          // the chain got shorter: restart at the tip
      f.height = height;
      f.hash = await blockHashAt(height);
      return [];
    }
    let from = f.height + 1n;
    if (f.hash) {
      const current = await blockHashAt(f.height);
      // Re-deliver the height we last reported if a different block occupies it.
      if (current && !Buffer.from(current).equals(Buffer.from(f.hash))) from = f.height;
    }
    const out = [];
    for (let n = from; n <= height && out.length < opt.maxBlockHashes; n++) {
      const h = await blockHashAt(n);
      if (!h) continue;
      out.push(H.encodeHash(h, 'block.hash'));
      f.height = n;
      f.hash = h;
    }
    return out;
  }

  const methods = {

    // ---- chain metadata ----

    async eth_chainId(params) {
      arity(params, 0, 0);
      return H.encodeQuantity(await chain.chainId(), 'chainId');
    },

    /** net_version is a DECIMAL string, not hex — the one place hex is wrong. */
    async net_version(params) {
      arity(params, 0, 0);
      return (await chain.chainId()).toString(10);
    },

    async net_listening(params) { arity(params, 0, 0); return true; },

    async web3_clientVersion(params) { arity(params, 0, 0); return clientVersion; },

    async web3_sha3(params) {
      arity(params, 1, 1);
      return H.encodeHash(keccak256(H.decodeData(params[0], 'data')));
    },

    async eth_syncing(params) {
      arity(params, 0, 0);
      const s = typeof chain.syncing === 'function' ? await chain.syncing() : false;
      if (!s) return false;
      return {
        startingBlock: H.encodeQuantity(s.startingBlock, 'startingBlock'),
        currentBlock: H.encodeQuantity(s.currentBlock, 'currentBlock'),
        highestBlock: H.encodeQuantity(s.highestBlock, 'highestBlock'),
      };
    },

    /** The node holds no keys for callers; wallets sign locally. */
    async eth_accounts(params) { arity(params, 0, 0); return []; },

    async eth_blockNumber(params) {
      arity(params, 0, 0);
      return H.encodeQuantity(await tip(), 'blockNumber');
    },

    async eth_gasPrice(params) {
      arity(params, 0, 0);
      return H.encodeQuantity(await chain.gasPrice(), 'gasPrice');
    },

    // ---- state ----

    async eth_getBalance(params) {
      arity(params, 1, 2);
      const addr = H.decodeAddress(params[0], 'address');
      const at = await resolveRef(params[1], 'block');
      return H.encodeQuantity(await chain.getBalance(addr, at), 'balance');
    },

    async eth_getTransactionCount(params) {
      arity(params, 1, 2);
      const addr = H.decodeAddress(params[0], 'address');
      const at = await resolveRef(params[1], 'block');
      return H.encodeQuantity(await chain.getNonce(addr, at), 'nonce');
    },

    async eth_getCode(params) {
      arity(params, 1, 2);
      const addr = H.decodeAddress(params[0], 'address');
      const at = await resolveRef(params[1], 'block');
      return H.encodeData(await chain.getCode(addr, at) || Buffer.alloc(0), 'code');
    },

    async eth_getStorageAt(params) {
      arity(params, 2, 3);
      const addr = H.decodeAddress(params[0], 'address');
      const key = H.decodeStorageKey(params[1], 'position');
      const at = await resolveRef(params[2], 'block');
      const word = await chain.getStorageAt(addr, key, at);
      // Always a full 32-byte word, zero-padded: this is DATA, and a client
      // that slices bytes out of it must find them where it expects.
      return H.encodeDataFixed(word || Buffer.alloc(32), 32, 'storage');
    },

    // ---- execution ----

    async eth_call(params) {
      arity(params, 1, 3);
      const msg = parseCallMsg(params[0]);
      const at = await resolveRef(params[1], 'block');
      rejectStateOverride(params[2]);
      const res = unwrapExec(await chain.call(msg, at), 'eth_call');
      return H.encodeData(res.returnData || Buffer.alloc(0), 'return data');
    },

    async eth_estimateGas(params) {
      arity(params, 1, 3);
      const msg = parseCallMsg(params[0]);
      const at = await resolveRef(params[1], 'block');
      rejectStateOverride(params[2]);
      const res = unwrapExec(await chain.estimateGas(msg, at), 'eth_estimateGas');
      if (res.gas === undefined || res.gas === null) {
        throw RpcError.internal('eth_estimateGas: chain returned no gas figure');
      }
      return H.encodeQuantity(res.gas, 'gas');
    },

    async eth_sendRawTransaction(params) {
      arity(params, 1, 1);
      const raw = H.decodeData(params[0], 'transaction');
      if (raw.length === 0) throw RpcError.invalidParams('transaction: empty payload');
      const res = await chain.sendRawTransaction(raw);
      if (!res || typeof res !== 'object') throw RpcError.internal('sendRawTransaction: no result');
      if (!res.ok) {
        // "nonce too low", "insufficient funds for gas * price + value",
        // "already known" — clients match on these strings, so they are the
        // chain's words verbatim, under geth's generic server code.
        throw RpcError.server(String(res.error || 'transaction rejected'));
      }
      return H.encodeHash(res.hash, 'transaction hash');
    },

    // ---- blocks, transactions, receipts ----

    async eth_getBlockByNumber(params) {
      arity(params, 1, 2);
      const fullTx = params.length > 1 ? decodeBool(params[1], 'fullTransactionObjects') : false;
      const ref = await resolveRef(params[0], 'block', { strict: false });
      if (ref === 'pending') return null;   // no pending block on this chain
      const b = await chain.getBlockByNumber(ref, fullTx);
      return b ? formatBlock(b, fullTx) : null;
    },

    async eth_getBlockByHash(params) {
      arity(params, 1, 2);
      const hash = H.decodeHash(params[0], 'blockHash');
      const fullTx = params.length > 1 ? decodeBool(params[1], 'fullTransactionObjects') : false;
      const b = await chain.getBlockByHash(hash, fullTx);
      return b ? formatBlock(b, fullTx) : null;
    },

    async eth_getTransactionByHash(params) {
      arity(params, 1, 1);
      const tx = await chain.getTransactionByHash(H.decodeHash(params[0], 'transactionHash'));
      return tx ? formatTx(tx) : null;
    },

    async eth_getTransactionReceipt(params) {
      arity(params, 1, 1);
      const r = await chain.getTransactionReceipt(H.decodeHash(params[0], 'transactionHash'));
      // null while pending or unknown — every client polls this in a loop and
      // treats null as "not mined yet", so it must not be an error.
      return r ? formatReceipt(r) : null;
    },

    /**
     * Every receipt in one block, which is what an explorer actually wants: without
     * it, rendering a block's per-transaction status costs N round trips instead of
     * one. Geth and Erigon both expose it, and `getBlockReceipts` was already in the
     * chain interface because eth_getLogs scans with it — this only publishes it.
     *
     * Takes a number, a tag or a block HASH, matching geth: `resolveRef` already
     * accepts all three, and a client that has a hash in hand should not have to
     * resolve it to a height first.
     */
    async eth_getBlockReceipts(params) {
      arity(params, 1, 1);
      /* geth's BlockNumberOrHash accepts a BARE 32-byte hash here, not only the
       * EIP-1898 `{blockHash}` object — and every explorer sends the bare form,
       * because that is what geth documents. `parseBlockParam` reads a plain
       * string as a QUANTITY, which turns a hash into an astronomical block
       * number and answers null, so the hash form is recognised first. There is
       * no ambiguity to resolve: no chain will ever reach block 2^256. */
      const p0 = typeof params[0] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(params[0])
        ? { blockHash: params[0] } : params[0];
      const ref = await resolveRef(p0, 'block', { strict: false });
      if (ref === 'pending') return null;      // no pending block, per eth_getBlockByNumber
      const block = await chain.getBlockByNumber(ref, false);
      if (!block) return null;                 // null, not [], so "unknown" ≠ "empty"
      const receipts = await chain.getBlockReceipts(ref) || [];
      return receipts.map(formatReceipt);
    },

    // ---- logs ----

    async eth_getLogs(params) {
      arity(params, 1, 1);
      const filter = await buildLogFilter(params[0], 'filter');
      if (filter.fromBlock > filter.toBlock) return [];
      return scanLogs(filter);
    },

    // ---- filters ----
    //
    // The one stateful corner of this surface; the bounds on that state, and why
    // there have to be any, are argued in filters.js. Nothing here executes EVM
    // code, so the gas cap and the time budget of chain/rpcadapter.js do not
    // apply — what applies instead is that every poll is bounded in BLOCKS
    // (`maxLogRange`, `maxBlockHashes`) and in RESULTS (`maxLogs`, and the
    // mempool journal's own ring), and that a poll which hits a bound advances
    // its cursor and returns, rather than repeating the same too-large range.
    //
    // ethers v6's JsonRpcProvider reaches for these before it reaches for
    // polling: `_getSubscriber` returns FilterIdEventSubscriber for a contract
    // event and FilterIdPendingSubscriber for pending transactions, and only
    // falls back to `eth_getLogs` polling when they fail. web3.js does not fall
    // back at all.

    /**
     * A new log filter. `fromBlock` and `toBlock` are accepted and validated,
     * but a filter DELIVERS ONLY BLOCKS MINED AFTER IT WAS CREATED — geth's
     * `eth_newFilter` is a live subscription and its history is `eth_getLogs`'s
     * job, which is what `eth_getFilterLogs` below is for. A client that wants
     * the past asks for the past; one that got the past here would receive it
     * twice, because every such client also queries it directly first.
     */
    async eth_newFilter(params, ctx) {
      arity(params, 1, 1);
      const raw = params[0];
      // Validated now rather than at the first poll: a filter id handed back for
      // a filter that can never work is the worst of both answers.
      const criteria = await buildLogFilter(raw, 'filter');
      if (raw.blockHash !== undefined && raw.blockHash !== null) {
        // EIP-234 pins a query to one block that already exists. There is
        // nothing for a live filter to watch, and answering [] forever would
        // look exactly like an event that never fires.
        throw RpcError.invalidParams('filter: blockHash names one existing block and cannot be watched');
      }
      /* The RANGE the filter follows, taken from the raw parameters rather than
       * from `criteria`, whose from/to are clamped to the current tip — correct
       * for a one-shot eth_getLogs and wrong for a cursor that is about to walk
       * forward from here. A tag ('latest' and friends) means "follow the
       * chain", so it leaves `end` null; only an explicit height ends a filter. */
      const height = await tip();
      const fromParam = H.parseBlockParam(pick(raw.fromBlock, null), 'filter.fromBlock');
      const toParam = H.parseBlockParam(pick(raw.toBlock, null), 'filter.toBlock');
      const start = fromParam.number !== undefined && fromParam.number > height
        ? fromParam.number : height + 1n;
      return filters.create(owner(ctx), {
        kind: 'logs',
        criteria: { addresses: criteria.addresses, topics: criteria.topics },
        raw,
        next: start,
        end: toParam.number === undefined ? null : toParam.number,
        /* The (height, hash) pairs behind the cursor, bounded by
         * `filterReorgDepth`. Empty at creation on purpose: a filter starts
         * from "now" and has delivered nothing yet, so there is nothing a
         * reorg could make it deliver twice or skip. */
        seen: [],
      });
    },

    async eth_newBlockFilter(params, ctx) {
      arity(params, 0, 0);
      const height = await tip();
      return filters.create(owner(ctx), {
        kind: 'block', height, hash: await blockHashAt(height),
      });
    },

    async eth_getFilterChanges(params) {
      arity(params, 1, 1);
      const f = filters.touch(params[0]);
      if (!f) throw FilterRegistry.notFound();
      if (f.kind === 'logs') return logFilterChanges(f);
      if (f.kind === 'block') return blockFilterChanges(f);
      const { cursor, hashes } = await chain.pendingSince(f.cursor);
      f.cursor = cursor;
      return hashes.map((h, i) => H.encodeHash(h, `pendingTransactions[${i}]`));
    },

    /**
     * Every log the filter's criteria match, over its whole declared range —
     * NOT just what has arrived since the last poll. Only a log filter has a
     * range; geth answers `filter not found` for a block or pending id, and so
     * do we, because "[]" would read as "this event has never fired".
     */
    async eth_getFilterLogs(params) {
      arity(params, 1, 1);
      const f = filters.touch(params[0]);
      if (!f || f.kind !== 'logs') throw FilterRegistry.notFound();
      const filter = await buildLogFilter(f.raw, 'filter');
      if (filter.fromBlock > filter.toBlock) return [];
      return scanLogs(filter);
    },

    /** true if the id named a live filter. NOT an error for an unknown one:
     *  a client cleaning up after a timeout is doing the right thing. */
    async eth_uninstallFilter(params) {
      arity(params, 1, 1);
      return filters.remove(params[0]);
    },

    // ---- blocks by index, and uncles ----

    async eth_getBlockTransactionCountByNumber(params) {
      arity(params, 1, 1);
      const ref = await resolveRef(params[0], 'block', { strict: false });
      if (ref === 'pending') return null;      // no pending block; see eth_getBlockByNumber
      const b = await chain.getBlockByNumber(ref, false);
      return b ? H.encodeQuantity((b.transactions || []).length, 'transactionCount') : null;
    },

    async eth_getBlockTransactionCountByHash(params) {
      arity(params, 1, 1);
      const b = await chain.getBlockByHash(H.decodeHash(params[0], 'blockHash'), false);
      return b ? H.encodeQuantity((b.transactions || []).length, 'transactionCount') : null;
    },

    /**
     * The i-th transaction of a block.
     *
     * Fetched by HASH rather than by asking for the whole block with full
     * transaction objects: on the real chain `fullTx` decodes and
     * ECDSA-recovers the sender of every transaction in the block, and an
     * explorer walking a 5,000-transaction block by index would pay for all
     * 5,000 of them 5,000 times. The interface allows a chain to return full
     * objects even when `fullTx` is false, so both shapes are handled.
     */
    async eth_getTransactionByBlockNumberAndIndex(params) {
      arity(params, 2, 2);
      const ref = await resolveRef(params[0], 'block', { strict: false });
      if (ref === 'pending') return null;
      return txAtIndex(await chain.getBlockByNumber(ref, false), params[1]);
    },

    async eth_getTransactionByBlockHashAndIndex(params) {
      arity(params, 2, 2);
      const b = await chain.getBlockByHash(H.decodeHash(params[0], 'blockHash'), false);
      return txAtIndex(b, params[1]);
    },

    /* Hearth has no uncles (see EMPTY_UNCLE_HASH), so these are constants — but
     * they are SERVED rather than absent, because an explorer that gets -32601
     * for one of them reports the node as incompatible, and because "0" is the
     * true answer rather than a placeholder. The count is null for a block that
     * does not exist, so it still distinguishes "no uncles" from "no block". */
    async eth_getUncleCountByBlockNumber(params) {
      arity(params, 1, 1);
      const ref = await resolveRef(params[0], 'block', { strict: false });
      if (ref === 'pending') return null;
      return (await chain.getBlockByNumber(ref, false)) ? '0x0' : null;
    },

    async eth_getUncleCountByBlockHash(params) {
      arity(params, 1, 1);
      const b = await chain.getBlockByHash(H.decodeHash(params[0], 'blockHash'), false);
      return b ? '0x0' : null;
    },

    async eth_getUncleByBlockNumberAndIndex(params) {
      arity(params, 2, 2);
      await resolveRef(params[0], 'block', { strict: false });
      H.decodeQuantity(params[1], 'index');
      return null;
    },

    async eth_getUncleByBlockHashAndIndex(params) {
      arity(params, 2, 2);
      H.decodeHash(params[0], 'blockHash');
      H.decodeQuantity(params[1], 'index');
      return null;
    },
  };

  /* ------------------------------------------------------------------------
   * THE FEE-MARKET METHODS, AND WHY THEY ARE OFF BY DEFAULT.
   *
   * CHAIN-TESTPLAN.md §3 asks for a decision on `eth_feeHistory` and
   * `eth_maxPriorityFeePerGas` — "this may be correctly absent, decide and write
   * it down, because a wallet that asks and gets an error looks broken". This is
   * the decision, and it goes AGAINST implementing them, because this repository
   * already measured what happens when they exist.
   *
   * WHO ACTUALLY ASKS. docs/network-config.md §5 recorded every fee-related call
   * three toolchains make against `tools/rpc-probe/stub.js`:
   *
   *   ethers 6.15 / Hardhat 2.29  reads eth_getBlockByNumber("latest"), sees no
   *                               baseFeePerGas, calls eth_gasPrice, signs type
   *                               0. NEVER calls eth_feeHistory.
   *   viem / MetaMask             same signal, same conclusion — the ABSENCE of
   *                               baseFeePerGas on the block is what decides it,
   *                               not either of these methods.
   *   Foundry 1.7.1               calls eth_feeHistory UNCONDITIONALLY, before
   *                               pricing anything, and aborts when it is
   *                               missing. eth_maxPriorityFeePerGas: never
   *                               called by any of the three.
   *
   * So the only client that asks is the one for which an ANSWER IS WORSE THAN AN
   * ERROR. Today Foundry fails with "Failed to estimate EIP1559 fees. This chain
   * might not support EIP1559, try adding --legacy" — a message that names the
   * remedy. Given all-zero base fees it would instead compute a type-2
   * transaction, sign it, and have it refused at broadcast by
   * chain/transaction.js as "transaction type 0x2 — v1 accepts legacy (type 0)
   * only": true, but no longer telling anyone what to type. That trade is the
   * wrong way round, and it is why `--legacy` is documented rather than papered
   * over.
   *
   * SO WHY IS THE CODE HERE AT ALL. Because the answers are real and the day the
   * fee market lands in v2 this becomes a flag rather than a project, and because
   * an operator running a private endpoint for a gas dashboard wants
   * `gasUsedRatio` history and is not running `forge create` through it. Off by
   * default, fail-closed, one option — geth gates whole namespaces the same way.
   * ------------------------------------------------------------------------ */
  if (opt.feeHistory === true) {
    /**
     * Historical gas usage and the fee distribution inside it.
     *
     * `baseFeePerGas` IS ALL ZEROS AND THAT IS THE HONEST ANSWER, not a
     * placeholder: this chain has no fee market, so the base fee is zero
     * everywhere and every wei a sender pays is the miner's. The array is one
     * longer than the window, per the spec — the extra entry is the NEXT block's
     * projected base fee, which on a chain with no fee market is also zero.
     *
     * `reward` is only computed when percentiles are asked for, because it is
     * the only part that costs a receipt walk per block.
     */
    methods.eth_feeHistory = async params => {
      arity(params, 2, 3);
      const want = decodeBlockCount(params[0], 'blockCount');
      const newestRef = await resolveRef(params[1], 'newestBlock', { strict: true });
      // `pending` has no block of its own here, so it means the tip — which is
      // what geth resolves it to for this method as well.
      const newest = newestRef === 'pending' ? await tip() : newestRef;
      const percentiles = parsePercentiles(params[2], 'rewardPercentiles');
      if (want > opt.maxFeeHistory) {
        throw RpcError.invalidParams(`blockCount: at most ${opt.maxFeeHistory} blocks`);
      }
      // A window reaching below genesis is CLAMPED, not refused: a client that
      // asks for 20 blocks at height 3 wants the four that exist.
      const count = BigInt(want) > newest + 1n ? newest + 1n : BigInt(want);
      if (count === 0n) {
        // The spec's shape for "nothing to report". geth returns the same.
        return { oldestBlock: H.encodeQuantity(newest, 'oldestBlock'), baseFeePerGas: [], gasUsedRatio: [] };
      }
      const oldest = newest - count + 1n;
      const baseFeePerGas = [];
      const gasUsedRatio = [];
      const reward = percentiles.length ? [] : null;
      for (let n = oldest; n <= newest; n++) {
        const b = await chain.getBlockByNumber(n, false);
        if (!b) throw RpcError.server('header not found');
        baseFeePerGas.push('0x0');
        const limit = BigInt(b.gasLimit);
        const used = BigInt(b.gasUsed);
        // A JSON float, not a QUANTITY — the one number in this whole surface
        // that the spec asks for unencoded.
        gasUsedRatio.push(limit > 0n ? Number(used) / Number(limit) : 0);
        if (reward) {
          const receipts = await chain.getBlockReceipts(n) || [];
          reward.push(rewardPercentiles(receipts, used, percentiles)
            .map(v => H.encodeQuantity(v, 'reward')));
        }
      }
      baseFeePerGas.push('0x0');       // the next block's, per the spec's length rule
      const out = { oldestBlock: H.encodeQuantity(oldest, 'oldestBlock'), baseFeePerGas, gasUsedRatio };
      if (reward) out.reward = reward;
      return out;
    };

    /**
     * With no base fee the miner keeps the whole gas price, so the priority fee
     * IS the gas price. Returning zero instead would be arithmetically
     * defensible and practically a lie: a wallet that then sends
     * `maxPriorityFeePerGas: 0` gets a transaction the mempool refuses as
     * underpriced (params.js `EVM_MIN_GAS_PRICE`). Paired with eth_feeHistory
     * rather than served alone, because nothing measured calls it on its own.
     */
    methods.eth_maxPriorityFeePerGas = async params => {
      arity(params, 0, 0);
      return H.encodeQuantity(await chain.gasPrice(), 'maxPriorityFeePerGas');
    };
  }

  /* METHODS THAT DEPEND ON THE NODE, NOT THE CHAIN, and are ABSENT when this
   * node cannot answer them honestly — see the interface note. Registered here
   * rather than guarded inside each body so that `has()` and therefore -32601
   * tell the truth: a caller that gets "the method does not exist" knows to stop
   * asking, where one that gets a plausible zero does not. */
  if (typeof chain.chainStart === 'function') {
    /**
     * WHEN THIS CHAIN STARTED, so that nothing has to infer it. micro-org#396.
     *
     * `hearth_` and not `eth_` because it is not in the Ethereum JSON-RPC spec
     * and a client that finds an unknown method under `eth_` has been lied to
     * about which chain it is talking to.
     *
     * Both timestamps ride together deliberately. `genesisTimestamp` is not the
     * launch — on EMBER it is a round number picked so every node derives the
     * same genesis hash, 415 days before block 1 — and a caller that gets only
     * `launchedAt` learns nothing about the trap it just avoided, while a caller
     * that has to make a second call to find the genesis figure will instead
     * make the subtraction it already knows how to make.
     *
     * `launchedAt` is NULL on a chain holding only genesis, and null is the
     * answer: that chain has no start to report and no honest age. A default
     * here — genesis, zero, `now` — is the whole defect, restated one layer down.
     */
    methods.hearth_chainStart = async params => {
      arity(params, 0, 0);
      const s = await chain.chainStart();
      return {
        launchedAt: s.launchedAt === null || s.launchedAt === undefined
          ? null
          : H.encodeQuantity(s.launchedAt, 'launchedAt'),
        launchHeight: H.encodeQuantity(s.launchHeight, 'launchHeight'),
        genesisTimestamp: H.encodeQuantity(s.genesisTimestamp, 'genesisTimestamp'),
        height: H.encodeQuantity(s.height, 'height'),
      };
    };
  }
  if (typeof chain.peerCount === 'function') {
    methods.net_peerCount = async params => {
      arity(params, 0, 0);
      return H.encodeQuantity(await chain.peerCount(), 'peerCount');
    };
  }
  if (typeof chain.mining === 'function') {
    methods.eth_mining = async params => { arity(params, 0, 0); return (await chain.mining()) === true; };
  }
  if (typeof chain.hashrate === 'function') {
    methods.eth_hashrate = async params => {
      arity(params, 0, 0);
      return H.encodeQuantity(await chain.hashrate(), 'hashrate');
    };
  }
  if (typeof chain.coinbase === 'function') {
    /* geth errors with "etherbase must be explicitly specified" when it has no
     * mining address; this node always has one, and it is already public in the
     * REST /info and in every block it mines, so there is nothing to withhold. */
    methods.eth_coinbase = async params => {
      arity(params, 0, 0);
      return H.encodeAddress(await chain.coinbase(), 'coinbase');
    };
  }
  if (typeof chain.txpoolStatus === 'function') {
    /* `txpool_status` only — two integers. `txpool_content` and
     * `txpool_inspect` dump every pending transaction with its sender, which on
     * an unauthenticated CORS-`*` endpoint is one request that costs
     * MEMPOOL_MAX_TXS (50,000) signature recoveries and a response measured in
     * megabytes. geth keeps the whole txpool namespace off HTTP by default for
     * the same reason. The REST port's /mempool already lists the pool for the
     * explorer, which is where that belongs. */
    methods.txpool_status = async params => {
      arity(params, 0, 0);
      const s = await chain.txpoolStatus();
      return {
        pending: H.encodeQuantity(s.pending, 'pending'),
        queued: H.encodeQuantity(s.queued, 'queued'),
      };
    };
  }
  if (typeof chain.pendingSince === 'function') {
    /* Only registered when the chain can journal admissions. A pending filter
     * that always returns [] is worse than one that does not exist: ethers'
     * FilterIdPendingSubscriber would sit on it forever instead of erroring. */
    methods.eth_newPendingTransactionFilter = async (params, ctx) => {
      arity(params, 0, 0);
      const { cursor } = await chain.pendingSince(null);
      return filters.create(owner(ctx), { kind: 'pending', cursor });
    };
  }

  /**
   * The i-th transaction of an already-fetched block, or null.
   *
   * The index is decoded BEFORE the block is checked so that a malformed index
   * is -32602 whether or not the block exists — otherwise the same bad request
   * is invalid-params against a known block and a null against an unknown one,
   * and a client debugging its own encoding learns nothing.
   */
  async function txAtIndex(block, rawIndex) {
    const index = H.decodeQuantity(rawIndex, 'index');
    if (!block) return null;
    const txs = block.transactions || [];
    if (index >= BigInt(txs.length)) return null;
    const entry = txs[Number(index)];
    if (!isBytes(entry)) return formatTx(entry);
    const tx = await chain.getTransactionByHash(entry);
    return tx ? formatTx(tx) : null;
  }

  return methods;
}

module.exports = {
  buildMethods,
  // exported for the test suite and for reuse by a future subscription API
  formatBlock, formatTx, formatReceipt, formatLog,
  logMatches, bloomMayMatch, bloomContains, decodeRevertReason, parseCallMsg,
  parseTopics, parseAddresses, parsePercentiles, decodeBlockCount, rewardPercentiles,
  EMPTY_UNCLE_HASH, DEFAULTS,
};
