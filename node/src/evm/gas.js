'use strict';
/* Ember EVM — the Shanghai gas schedule.
 *
 * Gas is consensus. A wrong constant here is not a bug, it is a chain split, and it
 * splits silently: the node computes a different stateRoot from every other node and
 * simply stops agreeing. Every number below is stated with the EIP that set it so it
 * can be re-checked against the reference clients without archaeology.
 *
 * EVERYTHING IN THIS MODULE IS BigInt. Inputs (memory offsets, sizes, requested call
 * gas) arrive from 256-bit stack words, so Number would introduce a precision cliff
 * exactly where an attacker would aim. Public entry points coerce Numbers for
 * convenience, but all returned gas is BigInt and the interpreter's gas counter must
 * be BigInt too.
 *
 * THE COST CONTRACT, restated from opcodes.js:
 *
 *     total = baseGas(op) + <dynamic, from the function opcodes.js names> + <memory>
 *
 * The dynamic functions return the whole of their share and nothing that belongs to
 * another term. `callCost` is the one exception and says so in its own comment: it
 * takes the memory cost as an argument, because EIP-150's all-but-one-64th rule has
 * to be applied to the gas that remains *after* memory expansion is paid for.
 *
 * Forks folded in: Tangerine Whistle (EIP-150), Spurious Dragon (EIP-158/160),
 * Istanbul (EIP-1884, EIP-2028, EIP-2200), Berlin (EIP-2565, EIP-2929),
 * London (EIP-3529), Shanghai (EIP-3855, EIP-3860).
 */

const { OPCODES, TIERS } = require('./opcodes');

const big = (x) => (typeof x === 'bigint' ? x : BigInt(x));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const G = Object.freeze({
  // --- fixed cost tiers (Yellow Paper appendix G) ---------------------------
  ZERO: 0n,
  JUMPDEST: 1n,
  BASE: 2n,          // G_base
  VERYLOW: 3n,       // G_verylow
  LOW: 5n,           // G_low
  MID: 8n,           // G_mid
  HIGH: 10n,         // G_high
  BLOCKHASH: 20n,    // G_blockhash

  // --- memory ---------------------------------------------------------------
  MEMORY: 3n,        // linear coefficient
  QUAD_COEFF_DIV: 512n,

  // --- hashing and copying --------------------------------------------------
  KECCAK256: 30n,
  KECCAK256_WORD: 6n,
  COPY_WORD: 3n,     // per word for *COPY, and for CREATE2's hash of the initcode

  // --- EXP (EIP-160 raised the per-byte cost from 10 to 50) -----------------
  EXP: 10n,
  EXP_BYTE: 50n,

  // --- logs ------------------------------------------------------------------
  LOG: 375n,
  LOG_TOPIC: 375n,
  LOG_DATA: 8n,      // per byte

  // --- EIP-2929 warm/cold access -------------------------------------------
  COLD_ACCOUNT_ACCESS: 2600n,
  COLD_SLOAD: 2100n,
  WARM_STORAGE_READ: 100n,

  // --- access lists (EIP-2930). Hearth v1 is legacy-tx only, so these are ---
  // --- unused today; they are here because EIP-3529's clears-refund is -----
  // --- defined in terms of ACCESS_LIST_STORAGE_KEY_COST. -------------------
  ACCESS_LIST_ADDRESS: 2400n,
  ACCESS_LIST_STORAGE_KEY: 1900n,

  // --- SSTORE (EIP-2200 as repriced by EIP-2929, refunds by EIP-3529) ------
  SSTORE_SET: 20000n,
  SSTORE_RESET: 5000n,           // the pre-2929 figure; see SSTORE_RESET_2929
  SSTORE_SENTRY: 2300n,          // EIP-2200 reentrancy sentry

  // --- calls -----------------------------------------------------------------
  // NOTE: the historical 700 gas CALL base (G_call, EIP-150) no longer exists in
  // Berlin and later. EIP-2929 replaced it with the account access cost, so a warm
  // CALL costs 100 and a cold one 2600. 700 is kept here only as a named relic so
  // that anybody grepping for it finds this comment instead of using it.
  CALL_BASE_PRE_BERLIN: 700n,
  CALL_VALUE_TRANSFER: 9000n,
  CALL_NEW_ACCOUNT: 25000n,
  CALL_STIPEND: 2300n,

  // --- selfdestruct ----------------------------------------------------------
  SELFDESTRUCT: 5000n,
  SELFDESTRUCT_NEW_ACCOUNT: 25000n,
  // EIP-3529 removed the 24000 selfdestruct refund entirely. Kept at zero, named,
  // so its absence is deliberate rather than an omission.
  SELFDESTRUCT_REFUND: 0n,

  // --- creation --------------------------------------------------------------
  CREATE: 32000n,
  INITCODE_WORD: 2n,             // EIP-3860
  MAX_INITCODE_SIZE: 49152n,     // EIP-3860: 2 * MAX_CODE_SIZE (24576)
  MAX_CODE_SIZE: 24576n,         // EIP-170
  CODE_DEPOSIT_BYTE: 200n,       // charged per byte of deployed runtime code

  // --- transactions ----------------------------------------------------------
  TX: 21000n,
  TX_CREATION: 32000n,           // additive: a creation tx costs 21000 + 32000
  TX_DATA_ZERO: 4n,
  TX_DATA_NONZERO: 16n,          // EIP-2028 lowered this from 68

  // --- refunds ---------------------------------------------------------------
  // EIP-3529: refunds are capped at gasUsed/5 (it was gasUsed/2 before London)
  // and the storage-clear refund fell from 15000 to 4800.
  REFUND_QUOTIENT: 5n,
});

/** SSTORE reset under EIP-2929: 5000 - COLD_SLOAD = 2900. */
const SSTORE_RESET_2929 = G.SSTORE_RESET - G.COLD_SLOAD;                       // 2900
/** EIP-3529 storage-clear refund: SSTORE_RESET - COLD_SLOAD + ACCESS_LIST_KEY. */
const SSTORE_CLEARS_REFUND = G.SSTORE_RESET - G.COLD_SLOAD + G.ACCESS_LIST_STORAGE_KEY; // 4800

// ---------------------------------------------------------------------------
// Fixed cost tiers
// ---------------------------------------------------------------------------

/** Tier name (from opcodes.js) to its unconditional cost. */
const TIER_GAS = Object.freeze({
  zero: G.ZERO,
  jumpdest: G.JUMPDEST,
  base: G.BASE,
  verylow: G.VERYLOW,
  low: G.LOW,
  mid: G.MID,
  high: G.HIGH,
  exp: G.EXP,
  blockhash: G.BLOCKHASH,
  keccak256: G.KECCAK256,
  create: G.CREATE,
});

for (const t of TIERS) {
  if (!(t in TIER_GAS)) throw new Error(`gas: opcodes.js declares tier "${t}" with no cost here`);
}

/** Precomputed per-opcode fixed cost, indexed by byte. */
const BASE_GAS = OPCODES.map((e) => TIER_GAS[e.tier]);
Object.freeze(BASE_GAS);

/** The unconditional cost of an opcode, charged before any dynamic cost. */
function baseGas(op) {
  const g = BASE_GAS[op];
  if (g === undefined) throw new RangeError(`gas: ${op} is not a byte`);
  return g;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** Words (32-byte units) needed to hold `bytes` bytes, rounded up. */
function wordCount(bytes) {
  const b = big(bytes);
  return (b + 31n) / 32n;
}

/* The total price of owning `words` words of memory:
 *
 *     C_mem(w) = 3w + floor(w^2 / 512)
 *
 * The quadratic term is the part that is routinely got wrong. It is floored, it is
 * divided by 512 and not by 32, and it is computed on the TOTAL size rather than on
 * the increment — which is why expansion has to be priced as a difference of two
 * C_mem values and never as C_mem of the delta. At 1024 words (32 KiB) the linear
 * term is 3072 and the quadratic term is 2048, so anybody who drops it is only ~40%
 * wrong at that size and would likely not notice until a contract with a big buffer
 * settles differently from the rest of the network.
 */
function memoryCost(words) {
  const w = big(words);
  return G.MEMORY * w + (w * w) / G.QUAD_COEFF_DIV;
}

/** The gas owed for growing memory from `oldWords` to `newWords`. Charged on the
 *  increase only: shrinking, or an access below the high-water mark, is free. */
function memoryExpansionCost(oldWords, newWords) {
  const o = big(oldWords);
  const n = big(newWords);
  if (n <= o) return 0n;
  return memoryCost(n) - memoryCost(o);
}

/** Convenience: expansion cost for touching [offset, offset+size). A zero-length
 *  access never expands memory, however large the offset — that is a real EVM rule,
 *  not a shortcut. */
function memoryExpansionForRange(currentWords, offset, size) {
  const s = big(size);
  if (s === 0n) return 0n;
  return memoryExpansionCost(currentWords, wordCount(big(offset) + s));
}

// ---------------------------------------------------------------------------
// EIP-2929 warm / cold access
// ---------------------------------------------------------------------------

/* The interpreter owns the access lists (`accessed_addresses`, `accessed_storage_keys`)
 * and their snapshot/revert behaviour. This module only prices the answer.
 *
 * Note that a cold *access* and a cold *slot* are different numbers: touching an
 * account for the first time costs 2600, touching a storage slot costs 2100, and
 * both are 100 once warm. */

/** BALANCE, EXTCODESIZE, EXTCODEHASH, and the account half of EXTCODECOPY and the
 *  CALL family. Returns the FULL cost — these opcodes sit in the zero tier. */
function accountAccessCost(cold) {
  return cold ? G.COLD_ACCOUNT_ACCESS : G.WARM_STORAGE_READ;
}

/** SLOAD. Returns the FULL cost. */
function sloadCost(cold) {
  return cold ? G.COLD_SLOAD : G.WARM_STORAGE_READ;
}

// ---------------------------------------------------------------------------
// Simple dynamic costs
// ---------------------------------------------------------------------------

/** EXP: 50 per byte of the exponent, on top of the 10 fixed tier cost. EIP-160.
 *  A zero exponent has zero bytes and so costs nothing beyond the base. */
function expCost(exponent) {
  const e = big(exponent);
  if (e === 0n) return 0n;
  let bytes = 0n;
  let v = e;
  while (v > 0n) { bytes++; v >>= 8n; }
  return G.EXP_BYTE * bytes;
}

/** KECCAK256: 6 per word, on top of the 30 fixed tier cost. */
function keccak256WordsCost(size) {
  return G.KECCAK256_WORD * wordCount(size);
}

/** CALLDATACOPY / CODECOPY / RETURNDATACOPY: 3 per word, on top of the VERYLOW
 *  tier cost of 3 and the memory expansion. */
function copyWordsCost(size) {
  return G.COPY_WORD * wordCount(size);
}

/** EXTCODECOPY: account access plus the per-word copy. FULL cost (zero tier). */
function extcodecopyCost(cold, size) {
  return accountAccessCost(cold) + copyWordsCost(size);
}

/** LOGn: 375 + 375 per topic + 8 per byte of data. FULL cost (zero tier). */
function logCost(topics, size) {
  const t = big(topics);
  if (t < 0n || t > 4n) throw new RangeError(`gas: LOG${topics} does not exist`);
  return G.LOG + G.LOG_TOPIC * t + G.LOG_DATA * big(size);
}

/** EIP-3860: 2 gas per 32-byte word of initcode. Applies to CREATE, CREATE2 and to
 *  the intrinsic gas of a creation transaction. */
function initcodeWordCost(size) {
  return G.INITCODE_WORD * wordCount(size);
}

/** CREATE: on top of the 32000 tier cost, only EIP-3860's initcode word cost. */
function createCost(initcodeSize) {
  return initcodeWordCost(initcodeSize);
}

/** CREATE2: as CREATE, plus 6 per word for hashing the initcode into the address. */
function create2Cost(initcodeSize) {
  return G.KECCAK256_WORD * wordCount(initcodeSize) + initcodeWordCost(initcodeSize);
}

/** SELFDESTRUCT. FULL cost (zero tier).
 *  - 5000 always (EIP-150)
 *  - plus the cold account surcharge for the beneficiary (EIP-2929)
 *  - plus 25000 if the beneficiary is empty (EIP-161) and there is a balance to move
 *  EIP-3529 removed the 24000 refund, so nothing is returned here.
 *
 *  @param {boolean} o.cold             beneficiary not in accessed_addresses
 *  @param {boolean} o.beneficiaryEmpty beneficiary is empty per EIP-161
 *  @param {bigint}  o.balance          balance of the contract being DESTROYED — it is
 *                                      the sender's balance that decides whether an
 *                                      account comes into existence, not the target's.
 */
function selfdestructCost({ cold = false, beneficiaryEmpty = false, balance = 0n } = {}) {
  let cost = G.SELFDESTRUCT;
  if (cold) cost += G.COLD_ACCOUNT_ACCESS;
  if (beneficiaryEmpty && big(balance) !== 0n) cost += G.SELFDESTRUCT_NEW_ACCOUNT;
  return cost;
}

// ---------------------------------------------------------------------------
// SSTORE — EIP-2200 metering, EIP-2929 pricing, EIP-3529 refunds
// ---------------------------------------------------------------------------

/* THE TRUTH TABLE. `original` is the value at the start of the transaction (the
 * committed value), `current` is the value now, `value` is what is being written.
 * Costs shown are the warm case; a cold slot adds COLD_SLOAD (2100) to every row.
 * Refunds are signed deltas applied to the transaction's refund counter.
 *
 *  #   original current  value   cost   refund      why
 *  --  -------- -------  -----   -----  ----------  ------------------------------
 *  1   0        0        0        100   0           no-op
 *  2   x        x        x        100   0           no-op
 *  3   0        0        y      20000   0           create a slot
 *  4   x        x        y       2900   0           overwrite a slot   (2900 = 5000 - 2100)
 *  5   x        x        0       2900   +4800       clear a slot
 *  6   0        y        0        100   +19900      undo a create      (20000 - 100)
 *  7   0        y        z        100   0           dirty, still new
 *  8   x        0        z        100   -4800       un-clear a slot
 *  9   x        0        x        100   -4800+2800  un-clear, back to original (net -2000)
 * 10   x        y        0        100   +4800       clear an already-dirty slot
 * 11   x        y        x        100   +2800       restore original   (2900 - 100)
 * 12   x        y        z        100   0           dirty overwrite
 *
 * where x, y, z are distinct non-zero values. Row 4 plus the cold surcharge is
 * 2100 + 2900 = 5000, which is the classic pre-Berlin SSTORE_RESET — a good check
 * that the 2929 split has been applied and not double-counted.
 *
 * The refund figures are EIP-3529's: the clears refund is 4800, not the 15000 it was
 * under EIP-2200. Getting this wrong does not change execution, only the final gas
 * charged, which makes it a particularly quiet way to split a chain.
 */

/**
 * Price an SSTORE.
 *
 * @param {object}  o
 * @param {boolean} o.cold          slot is not yet in accessed_storage_keys
 * @param {bigint}  o.original      committed value at the start of the transaction
 * @param {bigint}  o.current       value right now
 * @param {bigint}  o.value         value being written
 * @param {bigint}  o.gasRemaining  gas left before this instruction, for the sentry
 * @returns {{cost: bigint, refund: bigint, sentry: boolean}}
 *
 * `sentry` is true when EIP-2200's reentrancy guard trips (2300 gas or less remaining).
 * `cost` is then 0 because there is no price to quote, NOT because the frame gets off
 * lightly: the interpreter must treat it as an ordinary out-of-gas exceptional halt,
 * which consumes ALL remaining gas in the frame and reverts its state. Reading `cost:
 * 0` as "charge nothing and carry on" would let a stipend frame write storage, which
 * is the exact attack the guard exists to stop — a 2300-gas `transfer()` callback must
 * never be able to reach SSTORE.
 */
function sstoreCost({ cold = false, original = 0n, current = 0n, value = 0n, gasRemaining = 0n }) {
  const orig = big(original);
  const cur = big(current);
  const val = big(value);

  if (big(gasRemaining) <= G.SSTORE_SENTRY) {
    return { cost: 0n, refund: 0n, sentry: true };
  }

  let cost = cold ? G.COLD_SLOAD : 0n;
  let refund = 0n;

  if (cur === val) {                                   // rows 1, 2
    return { cost: cost + G.WARM_STORAGE_READ, refund: 0n, sentry: false };
  }

  if (orig === cur) {                                  // first write to this slot
    if (orig === 0n) {                                 // row 3
      return { cost: cost + G.SSTORE_SET, refund: 0n, sentry: false };
    }
    if (val === 0n) refund += SSTORE_CLEARS_REFUND;    // row 5
    return { cost: cost + SSTORE_RESET_2929, refund, sentry: false };  // rows 4, 5
  }

  // Slot is already dirty: the expensive write was paid for earlier in this
  // transaction, so only a warm read is charged and the refund counter is corrected.
  if (orig !== 0n) {
    if (cur === 0n) refund -= SSTORE_CLEARS_REFUND;    // rows 8, 9 — take the refund back
    else if (val === 0n) refund += SSTORE_CLEARS_REFUND; // row 10
  }
  if (orig === val) {                                  // rows 6, 9, 11 — back to original
    refund += orig === 0n
      ? G.SSTORE_SET - G.WARM_STORAGE_READ             // 19900
      : SSTORE_RESET_2929 - G.WARM_STORAGE_READ;       // 2800
  }
  cost += G.WARM_STORAGE_READ;
  return { cost, refund, sentry: false };
}

// ---------------------------------------------------------------------------
// The CALL family — EIP-150 and EIP-2929
// ---------------------------------------------------------------------------

/** EIP-150: a child frame may receive at most all but one 64th of what is left. */
function allButOne64th(gas) {
  const g = big(gas);
  if (g <= 0n) return 0n;
  return g - g / 64n;
}

/**
 * Price a CALL, CALLCODE, DELEGATECALL or STATICCALL and decide the child's gas.
 *
 * This is the one function that takes memory cost as an argument rather than leaving
 * it to the caller, because the order of operations is load-bearing: EIP-150's
 * all-but-one-64th cap is computed on the gas remaining AFTER the access cost, the
 * value surcharge, the new-account charge and memory expansion have been paid. Apply
 * the cap first and the child gets slightly too much gas, on a schedule that only
 * diverges for deep call trees — which is to say, in production and not in tests.
 *
 * @param {object}  o
 * @param {string}  o.kind          'CALL' | 'CALLCODE' | 'DELEGATECALL' | 'STATICCALL'
 * @param {boolean} o.cold          target address not in accessed_addresses
 * @param {bigint}  o.value         value transferred (0 for DELEGATECALL/STATICCALL)
 * @param {boolean} o.targetEmpty   target is "empty" per EIP-161: zero nonce, zero
 *                                  balance and no code. Note EMPTY, not merely absent:
 *                                  an account that exists with a zero balance and no
 *                                  code still triggers the 25000 charge.
 * @param {bigint}  o.memoryCost    memory expansion for the argument and return ranges
 * @param {bigint}  o.gasRemaining  gas left before this instruction
 * @param {bigint}  o.requestedGas  the gas argument off the stack (may be enormous)
 * @returns {{cost: bigint, childGas: bigint, stipend: bigint, outOfGas: boolean}}
 *
 * `cost` is everything charged to the caller now, including the child's allotment.
 * Whatever the child does not spend must be returned to the caller afterwards.
 * `childGas` already includes the stipend, which is a gift and is not part of `cost`.
 */
function callCost({
  kind = 'CALL',
  cold = false,
  value = 0n,
  targetEmpty = false,
  memoryCost = 0n,
  gasRemaining = 0n,
  requestedGas = 0n,
}) {
  const val = big(value);
  const mem = big(memoryCost);
  const remaining = big(gasRemaining);

  const transfersValue = (kind === 'CALL' || kind === 'CALLCODE') && val !== 0n;
  if (kind !== 'CALL' && kind !== 'CALLCODE' && kind !== 'DELEGATECALL' && kind !== 'STATICCALL') {
    throw new RangeError(`gas: unknown call kind "${kind}"`);
  }
  if ((kind === 'DELEGATECALL' || kind === 'STATICCALL') && val !== 0n) {
    throw new RangeError(`gas: ${kind} cannot transfer value`);
  }

  let upfront = accountAccessCost(cold) + mem;
  if (transfersValue) upfront += G.CALL_VALUE_TRANSFER;
  // Only a plain CALL can bring an account into existence. CALLCODE and DELEGATECALL
  // execute against the caller's own account, so there is nothing new to create.
  if (kind === 'CALL' && val !== 0n && targetEmpty) upfront += G.CALL_NEW_ACCOUNT;

  if (remaining < upfront) {
    return { cost: upfront, childGas: 0n, stipend: 0n, outOfGas: true };
  }

  const cap = allButOne64th(remaining - upfront);
  const req = big(requestedGas);
  const given = req < cap ? req : cap;
  const stipend = transfersValue ? G.CALL_STIPEND : 0n;

  return { cost: upfront + given, childGas: given + stipend, stipend, outOfGas: false };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Intrinsic gas: what a transaction owes before a single opcode runs.
 *
 * 21000 base, a further 32000 for a creation, 16 per non-zero calldata byte and 4
 * per zero byte (EIP-2028 cut non-zero bytes from 68 to 16), plus EIP-3860's 2 per
 * word of initcode for creations.
 *
 * The access-list terms are here for completeness; Hearth v1 accepts legacy (type 0)
 * transactions only, so `accessList` will be empty until EIP-2930 lands.
 *
 * @returns {bigint}
 */
function intrinsicGas({ data = Buffer.alloc(0), isCreation = false, accessList = [] } = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  let gas = G.TX;
  if (isCreation) gas += G.TX_CREATION;

  let zero = 0n;
  let nonzero = 0n;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) zero++; else nonzero++;
  }
  gas += zero * G.TX_DATA_ZERO + nonzero * G.TX_DATA_NONZERO;

  if (isCreation) gas += initcodeWordCost(bytes.length);

  for (const entry of accessList) {
    gas += G.ACCESS_LIST_ADDRESS;
    const keys = (entry && entry.storageKeys) || [];
    gas += G.ACCESS_LIST_STORAGE_KEY * BigInt(keys.length);
  }
  return gas;
}

/** EIP-3860 also caps initcode size; a creation transaction whose data exceeds this
 *  is invalid, and CREATE/CREATE2 with a larger initcode fails the frame. */
function initcodeTooLarge(size) {
  return big(size) > G.MAX_INITCODE_SIZE;
}

/**
 * EIP-3529: the refund a transaction actually receives is capped at one fifth of the
 * gas it used (it was one half before London). The cap is applied once, at the end of
 * the transaction, to the accumulated counter — never per-opcode.
 *
 * @returns {bigint} the refund to grant, already capped and never negative.
 */
function refundAllowance(gasUsed, refundCounter) {
  const used = big(gasUsed);
  const counter = big(refundCounter);
  if (counter <= 0n) return 0n;
  const cap = used / G.REFUND_QUOTIENT;
  return counter < cap ? counter : cap;
}

/** Gas for writing a contract's runtime code at the end of a successful creation:
 *  200 per byte. If this cannot be paid the creation fails (EIP-2 behaviour). */
function codeDepositCost(codeSize) {
  return G.CODE_DEPOSIT_BYTE * big(codeSize);
}

module.exports = {
  G,
  TIER_GAS,
  BASE_GAS,
  SSTORE_RESET_2929,
  SSTORE_CLEARS_REFUND,

  baseGas,

  wordCount,
  memoryCost,
  memoryExpansionCost,
  memoryExpansionForRange,

  accountAccessCost,
  sloadCost,

  expCost,
  keccak256WordsCost,
  copyWordsCost,
  extcodecopyCost,
  logCost,
  initcodeWordCost,
  createCost,
  create2Cost,
  selfdestructCost,
  sstoreCost,

  allButOne64th,
  callCost,

  intrinsicGas,
  initcodeTooLarge,
  refundAllowance,
  codeDepositCost,
};
