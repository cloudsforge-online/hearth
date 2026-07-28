'use strict';
/* The state transition — one transaction end to end, and a block's worth in order.
 *
 * Everything below this file is a component: RLP encodes, the trie hashes, the
 * interpreter runs bytecode. This file is where they become a *chain*. It is also
 * where the single most consequential distinction in the whole design lives, so it
 * is stated first and everything else follows from it:
 *
 *   AN INVALID TRANSACTION IS NOT IN THE BLOCK AT ALL.
 *   A FAILED TRANSACTION IS IN THE BLOCK, PAID FOR IN FULL, AND CHANGED NOTHING.
 *
 * Invalid means the transaction could never have been included by anybody: the
 * signature recovers to no key, the nonce is not the account's next nonce, the
 * balance cannot cover `value + gasLimit * gasPrice`, the gas limit does not fit in
 * what is left of the block, or the gas limit is below the intrinsic cost. There is
 * no receipt, no nonce increment, no fee, no state change — `applyTransaction`
 * returns `{ ok: false, code }` and the world is exactly as it was.
 *
 * Failed means the transaction was valid, was included, ran, and reverted or ran out
 * of gas. It consumes all the gas it was given (a REVERT keeps its remainder), it
 * pays the coinbase, its nonce increment stands, it gets a receipt with `status: 0`
 * — and every state change it made is rolled back. Conflating the two is the classic
 * error at this layer, and it is silent: a client that treats "insufficient balance"
 * as a failed transaction includes a transaction nobody else has and forks.
 *
 * THE ORDER OF OPERATIONS IS CONSENSUS. It is the same order geth uses, for the same
 * reasons, and each step depends on the one before:
 *
 *   1. check      nonce, balance, block gas, intrinsic gas — pure reads
 *   2. buy gas    debit gasLimit * gasPrice, increment the nonce
 *   3. intrinsic  21000 + creation + calldata + EIP-3860 initcode words
 *   4. pre-warm   sender, target, coinbase (EIP-3651), precompiles 0x01–0x09
 *   5. execute    EVM.call or EVM.create with gasLimit - intrinsic
 *   6. refund     min(counter, gasUsed / 5) (EIP-3529), then unused gas to the sender
 *   7. pay        gasUsed * (gasPrice - baseFee) to the coinbase
 *   8. finalize   delete self-destructed and touched-and-still-empty accounts, receipt
 *
 * Step 2 before step 3 is not cosmetic: the gas is bought at the full limit and the
 * intrinsic cost comes out of the *bought* gas, so a transaction that runs out
 * mid-execution has already paid for its whole limit and gets nothing back.
 *
 * THE NONCE IS INCREMENTED IN TWO DIFFERENT PLACES AND THAT IS DELIBERATE. For a
 * call it is bumped here, before execution. For a creation it is bumped by
 * `EVM.create`, because the contract address is `keccak256(rlp([sender, nonce]))[12:]`
 * over the nonce *before* the increment — bumping it here as well would put the
 * contract at the wrong address and desynchronise every subsequent creation from the
 * same account.
 *
 * BASE FEE. Hearth v1 has no EIP-1559 (spec §1): `baseFee` is zero, so the coinbase
 * receives `gasUsed * gasPrice` and nothing is burned. The subtraction is written out
 * anyway, and parameterised, because the Shanghai GeneralStateTests are filled with a
 * non-zero base fee and because v2's fee market is then one configuration change
 * rather than a re-derivation of the fee split. With `baseFee = 0` the two are
 * identical by construction.
 */

const gas = require('../evm/gas');
const TX = require('./transaction');
const receipt = require('./receipt');
const bloom = require('./bloom');
const { EVM } = require('../evm/interpreter');
const { PRECOMPILES, EMPTY_CODE_HASH } = require('../state/statedb');

/** Spec §1. Fixed in v1; the header carries it so it can move later. */
const BLOCK_GAS_LIMIT = 30000000n;

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * EIP-2929 pre-warms "the precompiles", and Ethereum's set is 0x01–0x09 — all nine,
 * including the four Hearth has not implemented (spec §5). The warm set is a gas
 * rule, not a capability claim: treating an address as cold that Ethereum treats as
 * warm costs 2,500 gas per access, and that is a chain split. StateDB already
 * defines exactly this set; it is re-exported here so the transaction layer's warm
 * set has one visible source.
 */
const WARM_PRECOMPILES = PRECOMPILES;

/**
 * Why a transaction can never be included. Every one of these means "not in the
 * block": no receipt, no fee, no nonce increment. They are deliberately distinct
 * strings because a mempool that cannot say *which* rule a transaction broke is
 * unusable, and because several of them are indistinguishable from a failed
 * execution if you only look at the resulting state.
 */
const REJECT = Object.freeze({
  NONCE_TOO_LOW: 'NONCE_TOO_LOW',
  NONCE_TOO_HIGH: 'NONCE_TOO_HIGH',
  NONCE_MAX: 'NONCE_MAX',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  BLOCK_GAS_LIMIT_REACHED: 'BLOCK_GAS_LIMIT_REACHED',
  INTRINSIC_GAS_TOO_LOW: 'INTRINSIC_GAS_TOO_LOW',
  INITCODE_SIZE_EXCEEDED: 'INITCODE_SIZE_EXCEEDED',
  SENDER_NOT_EOA: 'SENDER_NOT_EOA',
  FEE_BELOW_BASE: 'FEE_BELOW_BASE',
  FIELD_OVERFLOW: 'FIELD_OVERFLOW',
  NO_SENDER: 'NO_SENDER',
});

// ---- coercions -------------------------------------------------------------

function toBuf(v, what) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    const h = v.replace(/^0x/i, '');
    if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new TypeError(`statetransition: malformed hex ${what}`);
    return Buffer.from(h, 'hex');
  }
  throw new TypeError(`statetransition: ${what} must be bytes or 0x-hex`);
}

function big(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return v === '' ? 0n : BigInt(v);
  if (Buffer.isBuffer(v)) return v.length ? BigInt('0x' + v.toString('hex')) : 0n;
  if (v === null || v === undefined) return 0n;
  throw new TypeError('statetransition: cannot read a quantity from ' + typeof v);
}

function toAddress(v, what) {
  if (v === null || v === undefined || v === '' || v === '0x') return null;
  const b = toBuf(v, what);
  if (b.length === 0) return null;
  if (b.length !== 20) throw new TypeError(`statetransition: ${what} must be 20 bytes`);
  return b;
}

const ZERO_ADDRESS = Buffer.alloc(20);

/** A transaction as this module wants it: BigInt scalars, Buffer `to` (or null). */
function normalizeTx(tx) {
  return {
    nonce: big(tx.nonce),
    gasPrice: big(tx.gasPrice),
    gasLimit: big(tx.gasLimit === undefined ? tx.gas : tx.gasLimit),
    to: toAddress(tx.to, 'to'),
    value: big(tx.value),
    data: toBuf(tx.data === undefined ? tx.input : tx.data, 'data'),
    /* Present only for a transaction that carries an EIP-2930 access list. Hearth
     * v1's decoder accepts legacy transactions only, so this is empty on-chain; the
     * transition honours it because intrinsic gas and the warm set are defined in
     * terms of it and because the reference vectors exercise both. */
    accessList: tx.accessList || [],
    /* The balance check is made against the most a transaction could possibly pay
     * per gas, which for a legacy transaction is simply its gas price. */
    feeCap: tx.feeCap === undefined || tx.feeCap === null ? null : big(tx.feeCap),
  };
}

function isCreation(tx) { return tx.to === null; }

// ---------------------------------------------------------------------------
// step 1 — validity
// ---------------------------------------------------------------------------

/**
 * Everything that decides whether a transaction may be included, given the state it
 * would be applied to. Pure: it reads the account and nothing else, and it changes
 * nothing, so a mempool can call it on every pending transaction after every block.
 *
 * `transaction.validate()` has already done the stateless half — structure,
 * canonicality, signature, size, and that `gasLimit` covers the intrinsic cost. What
 * is left is exactly the three state-dependent rules from spec §3, plus the field
 * bounds restated because this function is also reachable with a hand-built object
 * that never went through the decoder.
 *
 * @param {object}  o
 * @param {StateDB} o.state
 * @param {object}  o.tx            normalized or raw-ish; see `normalizeTx`
 * @param {Buffer}  o.sender        20 bytes, as recovered from the signature
 * @param {bigint}  [o.gasAvailable] gas left in the block (default: the whole limit)
 * @param {bigint}  [o.baseFee]     burned per gas; 0 in v1
 * @returns {{ok: true, intrinsicGas: bigint} | {ok: false, code: string, error: string}}
 */
function checkTransaction({ state, tx, sender, gasAvailable = BLOCK_GAS_LIMIT, baseFee = 0n }) {
  const t = typeof tx.nonce === 'bigint' && 'accessList' in tx ? tx : normalizeTx(tx);
  const from = toAddress(sender, 'sender');
  const bad = (code, error) => ({ ok: false, code, error });

  if (from === null) return bad(REJECT.NO_SENDER, 'no sender: the signature recovers to no public key');

  /* Field bounds. The decoder enforces these on anything that arrived over the
   * wire, but a value that does not fit in 256 bits has no encoding at all, so a
   * transaction carrying one can never be included and must be rejected here too
   * rather than silently wrapping somewhere downstream. */
  if (t.nonce >= MAX_UINT64) return bad(REJECT.NONCE_MAX, 'nonce 2^64-1 can never be spent (EIP-2681)');
  if (t.gasLimit > MAX_UINT64) return bad(REJECT.FIELD_OVERFLOW, 'gas limit exceeds 64 bits');
  if (t.value > MAX_UINT256 || t.gasPrice > MAX_UINT256) return bad(REJECT.FIELD_OVERFLOW, 'value or gas price exceeds 256 bits');

  const feeCap = t.feeCap === null ? t.gasPrice : t.feeCap;
  if (feeCap > MAX_UINT256) return bad(REJECT.FIELD_OVERFLOW, 'fee cap exceeds 256 bits');
  /* v1 has no fee market and `baseFee` is zero, so this is vacuous today. It is
   * here because it is the rule the moment a base fee exists, and because the
   * reference vectors are filled with one. */
  if (big(baseFee) > 0n && feeCap < big(baseFee)) {
    return bad(REJECT.FEE_BELOW_BASE, `fee cap ${feeCap} is below the base fee ${baseFee}`);
  }

  /* EIP-3860's cap is a validity rule for a creation transaction, not a failed
   * execution: initcode over 49,152 bytes cannot be included at all. */
  if (isCreation(t) && gas.initcodeTooLarge(t.data.length)) {
    return bad(REJECT.INITCODE_SIZE_EXCEEDED, `initcode is ${t.data.length} bytes, over the EIP-3860 cap`);
  }

  const intrinsicGas = gas.intrinsicGas({
    data: t.data,
    isCreation: isCreation(t),
    accessList: t.accessList,
  });
  /* Intrinsic gas above the limit is INVALID, not merely failed. There is no
   * execution to charge for, so there is nothing to put in a receipt. */
  if (t.gasLimit < intrinsicGas) {
    return bad(REJECT.INTRINSIC_GAS_TOO_LOW, `gas limit ${t.gasLimit} is below the intrinsic cost ${intrinsicGas}`);
  }
  if (t.gasLimit > big(gasAvailable)) {
    return bad(REJECT.BLOCK_GAS_LIMIT_REACHED, `gas limit ${t.gasLimit} exceeds the ${gasAvailable} left in the block`);
  }

  const nonce = state.getNonce(from);
  if (t.nonce < nonce) return bad(REJECT.NONCE_TOO_LOW, `nonce ${t.nonce} is below the account's ${nonce}`);
  if (t.nonce > nonce) return bad(REJECT.NONCE_TOO_HIGH, `nonce ${t.nonce} is above the account's ${nonce}`);

  /* EIP-3607: an account with code cannot originate a transaction. Without this a
   * contract address that somebody has a key for — or that a future signature
   * scheme collides with — could spend the contract's balance. */
  if (!state.getCodeHash(from).equals(EMPTY_CODE_HASH)) {
    return bad(REJECT.SENDER_NOT_EOA, 'sender has deployed code (EIP-3607)');
  }

  /* The up-front cost is the whole gas limit at the fee cap, PLUS the value. Not
   * "whatever it turns out to use": the sender must be good for the maximum before
   * a single opcode runs, or an out-of-gas transaction could leave the coinbase
   * unpaid. */
  const upfront = t.gasLimit * feeCap + t.value;
  const balance = state.getBalance(from);
  if (balance < upfront) {
    return bad(REJECT.INSUFFICIENT_FUNDS, `balance ${balance} does not cover value + gasLimit * gasPrice = ${upfront}`);
  }

  return { ok: true, intrinsicGas };
}

// ---------------------------------------------------------------------------
// steps 2–8 — application
// ---------------------------------------------------------------------------

/**
 * Apply one transaction to the world state and produce its receipt.
 *
 * @param {object}   o
 * @param {StateDB}  o.state
 * @param {object}   o.tx                the transaction
 * @param {Buffer}   o.sender            recovered sender, 20 bytes
 * @param {object}   o.block             { number, timestamp, coinbase, gasLimit,
 *                                         prevRandao, baseFee, chainId }
 * @param {bigint}   [o.blockGasUsed=0n] gas used by earlier transactions in this block
 * @param {function} [o.blockHash]       (n: bigint) -> 32-byte Buffer | null, for BLOCKHASH
 * @param {function} [o.onStep]          tracer, passed straight to the EVM
 * @param {bigint}   [o.gasAvailable]    override the block's remaining gas
 *
 * @returns {object} On rejection, `{ ok: false, code, error }` and the state is
 *   untouched. On inclusion, `{ ok: true, receipt, gasUsed, gasRefunded, status,
 *   exception, returnData, contractAddress, logs, stateRoot, internalError }` —
 *   where `exception` non-null means the transaction FAILED, which is an outcome
 *   and not an error.
 */
function applyTransaction(o) {
  const state = o.state;
  const t = normalizeTx(o.tx);
  const sender = toAddress(o.sender, 'sender');
  const blk = o.block || {};
  const baseFee = big(blk.baseFee === undefined || blk.baseFee === null ? 0n : blk.baseFee);
  const blockGasUsed = big(o.blockGasUsed === undefined ? 0n : o.blockGasUsed);
  const blockGasLimit = big(blk.gasLimit === undefined ? BLOCK_GAS_LIMIT : blk.gasLimit);
  const gasAvailable = o.gasAvailable === undefined ? blockGasLimit - blockGasUsed : big(o.gasAvailable);

  // ---- 1. validity -------------------------------------------------------
  const check = checkTransaction({ state, tx: t, sender, gasAvailable, baseFee });
  if (!check.ok) return check;

  /* From here the transaction is IN the block, whatever happens next. Everything
   * below either succeeds or fails; nothing below can make it invalid again. */
  state.beginTransaction();

  const creation = isCreation(t);
  const coinbase = toAddress(blk.coinbase, 'coinbase') || ZERO_ADDRESS;
  /* The address a creation lands at. Computed here only to pre-warm it and to put
   * it in the result; `EVM.create` derives it independently from the same rule,
   * which is the copy that decides where the code actually goes. */
  const created = creation ? TX.contractAddress(sender, t.nonce) : null;

  // ---- 2. buy gas --------------------------------------------------------
  /* The whole limit is debited up front at the price actually paid. `feeCap` is
   * what the balance had to cover (above); `gasPrice` is what is charged. For a
   * legacy transaction they are the same number. */
  state.subBalance(sender, t.gasLimit * t.gasPrice);
  /* See the header: a creation must NOT be bumped here — its address is derived
   * from the pre-increment nonce inside EVM.create. */
  if (!creation) state.setNonce(sender, t.nonce + 1n);

  // ---- 4. pre-warm the EIP-2929 access list ------------------------------
  /* Sender, target, coinbase (EIP-3651 — Shanghai warms it so a builder payment
   * does not pay a cold-access toll), the nine precompiles, and anything in an
   * explicit access list. A set that differs from Ethereum's is 2,500 gas per
   * access, which is consensus and not an optimisation. */
  state.prepareAccessList({
    origin: sender,
    to: creation ? created : t.to,
    coinbase,
    accessList: t.accessList,
    precompiles: WARM_PRECOMPILES,
  });

  // ---- 5. execute --------------------------------------------------------
  const evm = new EVM({
    state,
    block: {
      number: blk.number,
      timestamp: blk.timestamp,
      coinbase,
      gasLimit: blockGasLimit,
      prevRandao: blk.prevRandao !== undefined ? blk.prevRandao : blk.difficulty,
      baseFee,
      chainId: blk.chainId === undefined ? TX.CHAIN_ID : blk.chainId,
    },
    tx: { origin: sender, gasPrice: t.gasPrice },
    onStep: o.onStep || null,
    blockHash: o.blockHash || null,
  });

  // ---- 3. intrinsic gas, taken out of the gas already bought -------------
  const executionGas = t.gasLimit - check.intrinsicGas;

  const r = creation
    ? evm.create({ caller: sender, initcode: t.data, gas: executionGas, value: t.value })
    : evm.call({ caller: sender, to: t.to, value: t.value, data: t.data, gas: executionGas });

  /* A JavaScript error escaping the interpreter is a bug in the interpreter, not an
   * EVM outcome. It is carried out rather than thrown — the return-don't-throw
   * contract is absolute — but it is labelled, so a caller can refuse to treat it
   * as a correctly-failed transaction. */
  const internalError = r.internalError || null;

  // ---- 6. refund ---------------------------------------------------------
  let gasRemaining = r.gasLeft;
  let gasUsed = t.gasLimit - gasRemaining;
  /* EIP-3529: capped at gasUsed/5, applied ONCE, to the accumulated counter, and
   * against the gas used BEFORE the refund is added back. A failed transaction has
   * no counter left — the refunds were journaled inside the frame that reverted. */
  const gasRefunded = gas.refundAllowance(gasUsed, state.getRefund());
  gasRemaining += gasRefunded;
  gasUsed -= gasRefunded;

  /* Unused gas returns to the sender at the price it was bought at. A FAILED
   * transaction reaches here too, with gasRemaining 0 for an exceptional halt and
   * whatever REVERT left for a revert — which is the whole point of the
   * distinction between the two. */
  state.addBalance(sender, gasRemaining * t.gasPrice);

  // ---- 7. pay the coinbase ----------------------------------------------
  /* `gasPrice - baseFee` is the tip. v1 has no EIP-1559 so `baseFee` is zero and
   * the coinbase receives the lot; nothing is burned. Note that this is `addBalance`
   * even when the fee is zero, because adding zero to an empty account still TOUCHES
   * it, and EIP-161 then deletes it at finalize. Skipping the call for a zero fee
   * leaves an account in the trie that no other client has. */
  state.addBalance(coinbase, gasUsed * (t.gasPrice - baseFee));

  // ---- 8. finalize -------------------------------------------------------
  /* Self-destructed accounts go, and so do accounts touched and left empty
   * (EIP-161). Both are past reverting: this runs after the last frame settled. */
  const logs = r.exception ? [] : evm.logs;
  const stateRoot = state.finalize();

  return {
    ok: true,
    receipt: receipt.normalize({
      status: r.exception ? receipt.FAILURE : receipt.SUCCESS,
      cumulativeGasUsed: blockGasUsed + gasUsed,
      logs,
    }),
    gasUsed,
    gasRefunded,
    status: r.exception ? receipt.FAILURE : receipt.SUCCESS,
    exception: r.exception || null,
    returnData: r.returnData,
    contractAddress: r.createdAddress || null,
    logs,
    stateRoot,
    internalError,
  };
}

// ---------------------------------------------------------------------------
// a block's worth
// ---------------------------------------------------------------------------

/* A block entry is either raw signed RLP — in which case it is validated and its
 * sender recovered here — or an already-validated `{ tx, sender }` pair, which is
 * what a miner assembling a block from its own mempool has. Recovery is ~1000x the
 * cost of everything else in validation, so not repeating it matters. */
function resolveEntry(entry, chainId) {
  if (Buffer.isBuffer(entry) || typeof entry === 'string') {
    const v = TX.validate(entry, { chainId });
    return v.ok ? { ok: true, tx: v.tx, sender: v.sender, hash: v.hash, raw: v.raw } : v;
  }
  if (entry && entry.tx && entry.sender) {
    return { ok: true, tx: entry.tx, sender: entry.sender, hash: entry.hash || null, raw: entry.raw || null };
  }
  if (entry && entry.raw) return resolveEntry(entry.raw, chainId);
  return { ok: false, code: 'RLP_ERROR', error: 'a block entry is raw bytes or { tx, sender }' };
}

/**
 * Apply a block's transactions in order and produce everything the header commits to.
 *
 * Order is not an implementation detail: transaction *n* sees the state transaction
 * *n-1* left behind, and `cumulativeGasUsed` in receipt *n* is the running total for
 * the block. Applying them in any other order, or in parallel, gives a different
 * state root.
 *
 * @param {object}   o
 * @param {StateDB}  o.state
 * @param {Array}    o.transactions   raw RLP Buffers, or `{ tx, sender }` pairs
 * @param {object}   o.block          as `applyTransaction`
 * @param {boolean}  [o.skipInvalid]  true when BUILDING a block (drop what does not
 *                                    fit), false when VALIDATING one (an invalid
 *                                    transaction makes the whole block invalid)
 * @returns {{ok: boolean, receipts, results, gasUsed, logs, logsBloom,
 *            receiptsRoot, stateRoot, rejected}}
 */
function applyBlock(o) {
  const state = o.state;
  const blk = o.block || {};
  const chainId = blk.chainId === undefined ? TX.CHAIN_ID : blk.chainId;
  const blockGasLimit = big(blk.gasLimit === undefined ? BLOCK_GAS_LIMIT : blk.gasLimit);
  const skipInvalid = !!o.skipInvalid;

  const receipts = [];
  const results = [];
  const rejected = [];
  const logs = [];
  let gasUsed = 0n;

  const entries = o.transactions || [];
  for (let i = 0; i < entries.length; i++) {
    const e = resolveEntry(entries[i], chainId);
    if (!e.ok) {
      rejected.push({ index: i, code: e.code, error: e.error });
      if (skipInvalid) continue;
      return { ok: false, index: i, code: e.code, error: e.error, receipts, results, gasUsed, rejected };
    }

    const res = applyTransaction({
      state,
      tx: e.tx,
      sender: e.sender,
      block: blk,
      blockGasUsed: gasUsed,
      blockHash: o.blockHash || null,
      onStep: o.onStep || null,
    });

    if (!res.ok) {
      rejected.push({ index: i, code: res.code, error: res.error, hash: e.hash });
      if (skipInvalid) continue;
      return { ok: false, index: i, code: res.code, error: res.error, receipts, results, gasUsed, rejected };
    }

    gasUsed += res.gasUsed;
    receipts.push(res.receipt);
    results.push(Object.assign({ hash: e.hash, index: receipts.length - 1 }, res));
    logs.push(...res.logs);
  }

  return {
    ok: true,
    receipts,
    results,
    gasUsed,
    logs,
    /* The block bloom is the OR of the receipts', which is also the OR of every log
     * in the block — bloom.js asserts the two definitions agree. */
    logsBloom: bloom.fromReceipts(receipts),
    receiptsRoot: receipt.receiptsRoot(receipts),
    stateRoot: state.root(),
    rejected,
    gasLimit: blockGasLimit,
  };
}

module.exports = {
  BLOCK_GAS_LIMIT,
  WARM_PRECOMPILES,
  REJECT,
  normalizeTx,
  checkTransaction,
  applyTransaction,
  applyBlock,
};
