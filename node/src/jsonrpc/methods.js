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
 *   the zero address, gas = the block gas limit, gasPrice = 0 for a call).
 *
 *   ExecResult — never a thrown error, matching the rule in §0 of the spec that
 *   an implementation signals EVM failure by returning, never by throwing,
 *   because a thrown TypeError in the interpreter would otherwise be
 *   indistinguishable from a correctly-rejected transaction:
 *
 *     { ok: true,  returnData: Buffer, gas?: bigint }
 *     { ok: false, reverted: true, returnData: Buffer }   // REVERT; may be empty
 *     { ok: false, error: 'out of gas' | 'invalid opcode' | … }
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
      const raw = params[0];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw RpcError.invalidParams('filter: expected an object');
      }
      for (const k of Object.keys(raw)) {
        if (!FILTER_KEYS.has(k)) throw RpcError.invalidParams(`filter: unknown field "${k}"`);
      }
      const filter = {
        addresses: parseAddresses(raw.address),
        topics: parseTopics(raw.topics),
        fromBlock: 0n,
        toBlock: 0n,
      };
      if (raw.blockHash !== undefined && raw.blockHash !== null) {
        // EIP-234: blockHash pins the query to one block and excludes a range.
        if (raw.fromBlock !== undefined || raw.toBlock !== undefined) {
          throw RpcError.invalidParams('filter: blockHash cannot be combined with fromBlock/toBlock');
        }
        const b = await chain.getBlockByHash(H.decodeHash(raw.blockHash, 'filter.blockHash'), false);
        if (!b) throw RpcError.server('unknown block');
        filter.fromBlock = b.number;
        filter.toBlock = b.number;
      } else {
        const height = await tip();
        const opts = { allowPending: false, strict: false };
        const from = await resolveRef(raw.fromBlock, 'filter.fromBlock', opts);
        const to = await resolveRef(raw.toBlock, 'filter.toBlock', opts);
        if (from > to) throw RpcError.invalidParams('filter: fromBlock is after toBlock');
        // A range past the tip is clamped rather than refused: a client polling
        // "from lastSeen to latest" races block production constantly.
        filter.fromBlock = from > height ? height + 1n : from;
        filter.toBlock = to > height ? height : to;
        if (filter.toBlock >= filter.fromBlock
            && filter.toBlock - filter.fromBlock + 1n > BigInt(opt.maxLogRange)) {
          throw RpcError.invalidParams(`filter: range exceeds ${opt.maxLogRange} blocks`);
        }
      }
      if (filter.fromBlock > filter.toBlock) return [];
      return scanLogs(filter);
    },
  };

  return methods;
}

module.exports = {
  buildMethods,
  // exported for the test suite and for reuse by a future filter API
  formatBlock, formatTx, formatReceipt, formatLog,
  logMatches, bloomMayMatch, bloomContains, decodeRevertReason, parseCallMsg,
  parseTopics, parseAddresses,
  EMPTY_UNCLE_HASH, DEFAULTS,
};
