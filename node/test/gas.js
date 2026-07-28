'use strict';
/* Unit tests for the Shanghai gas schedule. Zero-dependency mini harness.
 * Run: node test/gas.js
 *
 * Constants are checked against go-ethereum's params/protocol_params.go and
 * core/vm/{gas,eips,jump_table}.go. Where a value is derived rather than quoted the
 * derivation is written out, because "it looked right" is not a review of a
 * consensus constant. */

const gas = require('../src/evm/gas');
const { OPCODES, BY_NAME } = require('../src/evm/opcodes');
const { G } = gas;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(actual, expected, msg) {
  const good = actual === expected;
  if (!good) console.log(`  ✗ ${msg}: expected ${expected}, got ${actual}`);
  if (good) pass++; else fail++;
}
function group(name) { console.log('• ' + name); }

// ---- constants -------------------------------------------------------------
group('constants (go-ethereum params/protocol_params.go)');
eq(G.TX, 21000n, 'TxGas');
eq(G.TX_CREATION, 32000n, 'creation surcharge');
eq(G.TX + G.TX_CREATION, 53000n, 'TxGasContractCreation');
eq(G.TX_DATA_ZERO, 4n, 'TxDataZeroGas');
eq(G.TX_DATA_NONZERO, 16n, 'TxDataNonZeroGasEIP2028');
eq(G.COLD_ACCOUNT_ACCESS, 2600n, 'ColdAccountAccessCostEIP2929');
eq(G.COLD_SLOAD, 2100n, 'ColdSloadCostEIP2929');
eq(G.WARM_STORAGE_READ, 100n, 'WarmStorageReadCostEIP2929');
eq(G.SSTORE_SET, 20000n, 'SstoreSetGasEIP2200');
eq(G.SSTORE_RESET, 5000n, 'SstoreResetGasEIP2200');
eq(G.SSTORE_SENTRY, 2300n, 'SstoreSentryGasEIP2200');
eq(gas.SSTORE_RESET_2929, 2900n, 'SSTORE reset under 2929 is 5000 - 2100');
eq(gas.SSTORE_CLEARS_REFUND, 4800n, 'EIP-3529 clears refund is 5000 - 2100 + 1900');
eq(G.CALL_VALUE_TRANSFER, 9000n, 'CallValueTransferGas');
eq(G.CALL_NEW_ACCOUNT, 25000n, 'CallNewAccountGas');
eq(G.CALL_STIPEND, 2300n, 'CallStipend');
eq(G.SELFDESTRUCT, 5000n, 'SelfdestructGasEIP150');
eq(G.SELFDESTRUCT_NEW_ACCOUNT, 25000n, 'CreateBySelfdestructGas');
eq(G.SELFDESTRUCT_REFUND, 0n, 'EIP-3529 removed the selfdestruct refund');
eq(G.CREATE, 32000n, 'CreateGas / Create2Gas');
eq(G.INITCODE_WORD, 2n, 'InitCodeWordGas (EIP-3860)');
eq(G.MAX_INITCODE_SIZE, 49152n, 'MaxInitCodeSize is 2 * 24576');
eq(G.KECCAK256, 30n, 'Keccak256Gas');
eq(G.KECCAK256_WORD, 6n, 'Keccak256WordGas');
eq(G.LOG, 375n, 'LogGas');
eq(G.LOG_TOPIC, 375n, 'LogTopicGas');
eq(G.LOG_DATA, 8n, 'LogDataGas');
eq(G.COPY_WORD, 3n, 'CopyGas');
eq(G.EXP, 10n, 'ExpGas');
eq(G.EXP_BYTE, 50n, 'ExpByteEIP158 — 50, not the Frontier 10');
eq(G.QUAD_COEFF_DIV, 512n, 'QuadCoeffDiv');
eq(G.REFUND_QUOTIENT, 5n, 'RefundQuotientEIP3529 — 5, not the pre-London 2');
eq(G.ACCESS_LIST_STORAGE_KEY, 1900n, 'TxAccessListStorageKeyGas');
eq(G.ACCESS_LIST_ADDRESS, 2400n, 'TxAccessListAddressGas');

// ---- base tiers ------------------------------------------------------------
group('base tiers');
eq(gas.baseGas(BY_NAME.STOP.op), 0n, 'STOP is free');
eq(gas.baseGas(BY_NAME.ADD.op), 3n, 'ADD is verylow');
eq(gas.baseGas(BY_NAME.MUL.op), 5n, 'MUL is low');
eq(gas.baseGas(BY_NAME.ADDMOD.op), 8n, 'ADDMOD is mid');
eq(gas.baseGas(BY_NAME.JUMP.op), 8n, 'JUMP is mid');
eq(gas.baseGas(BY_NAME.JUMPI.op), 10n, 'JUMPI is high');
eq(gas.baseGas(BY_NAME.JUMPDEST.op), 1n, 'JUMPDEST is 1');
eq(gas.baseGas(BY_NAME.ADDRESS.op), 2n, 'ADDRESS is base');
eq(gas.baseGas(BY_NAME.BLOCKHASH.op), 20n, 'BLOCKHASH is 20');
eq(gas.baseGas(BY_NAME.SELFBALANCE.op), 5n, 'SELFBALANCE is low (EIP-1884)');
eq(gas.baseGas(BY_NAME.CHAINID.op), 2n, 'CHAINID is base');
eq(gas.baseGas(BY_NAME.BASEFEE.op), 2n, 'BASEFEE is base (EIP-3198)');
eq(gas.baseGas(BY_NAME.PUSH0.op), 2n, 'PUSH0 is base (2), NOT verylow — EIP-3855');
eq(gas.baseGas(BY_NAME.PUSH1.op), 3n, 'PUSH1 is verylow');
eq(gas.baseGas(BY_NAME.PUSH32.op), 3n, 'PUSH32 is verylow');
eq(gas.baseGas(BY_NAME.DUP16.op), 3n, 'DUP16 is verylow');
eq(gas.baseGas(BY_NAME.SWAP16.op), 3n, 'SWAP16 is verylow');
eq(gas.baseGas(BY_NAME.KECCAK256.op), 30n, 'KECCAK256 fixed part is 30');
eq(gas.baseGas(BY_NAME.EXP.op), 10n, 'EXP fixed part is 10');
eq(gas.baseGas(BY_NAME.CREATE.op), 32000n, 'CREATE fixed part is 32000');
eq(gas.baseGas(BY_NAME.CREATE2.op), 32000n, 'CREATE2 fixed part is 32000');
eq(gas.baseGas(BY_NAME.SLOAD.op), 0n, 'SLOAD is fully dynamic');
eq(gas.baseGas(BY_NAME.SSTORE.op), 0n, 'SSTORE is fully dynamic');
eq(gas.baseGas(BY_NAME.CALL.op), 0n, 'CALL is fully dynamic');
eq(gas.baseGas(BY_NAME.LOG0.op), 0n, 'LOG0 is fully dynamic');

// every opcode has a resolvable base cost, and every named dynamic function exists
{
  let allResolve = true, allDynamic = true;
  for (const e of OPCODES) {
    if (typeof gas.baseGas(e.op) !== 'bigint') allResolve = false;
    if (e.dynamicGas && typeof gas[e.dynamicGas] !== 'function') {
      allDynamic = false;
      console.log(`    (${e.name} names gas.${e.dynamicGas}, which does not exist)`);
    }
  }
  ok(allResolve, 'every one of the 256 bytes has a base cost');
  ok(allDynamic, 'every dynamicGas name in opcodes.js resolves to a gas.js function');
}

// ---- memory expansion ------------------------------------------------------
group('memory expansion: 3w + w^2/512, on the increase only');
eq(gas.wordCount(0), 0n, 'wordCount(0)');
eq(gas.wordCount(1), 1n, 'wordCount(1)');
eq(gas.wordCount(32), 1n, 'wordCount(32)');
eq(gas.wordCount(33), 2n, 'wordCount(33)');
eq(gas.memoryCost(0n), 0n, 'C_mem(0) = 0');
eq(gas.memoryCost(1n), 3n, 'C_mem(1) = 3');
eq(gas.memoryCost(3n), 9n, 'C_mem(3) = 9, quadratic term still floors to 0');
// the floor matters: 23^2 = 529, and 529/512 floors to 1, not to 0 and not to 1.03
eq(gas.memoryCost(23n), 70n, 'C_mem(23) = 69 + floor(529/512) = 70');
eq(gas.memoryCost(32n), 98n, 'C_mem(32) = 96 + floor(1024/512) = 98');
eq(gas.memoryCost(100n), 319n, 'C_mem(100) = 300 + floor(10000/512) = 319');
eq(gas.memoryCost(512n), 2048n, 'C_mem(512) = 1536 + 512');
eq(gas.memoryCost(1024n), 5120n, 'C_mem(1024) = 3072 + 2048');
// the quadratic term, isolated, so a regression that drops it cannot hide
eq(gas.memoryCost(1024n) - 3n * 1024n, 2048n, 'quadratic term at 1024 words is 2048');
eq(gas.memoryCost(4096n) - 3n * 4096n, 32768n, 'quadratic term at 4096 words is 32768');
ok(gas.memoryCost(2048n) - gas.memoryCost(1024n) > gas.memoryCost(1024n),
  'the second 1024 words cost more than the first — the curve is superlinear');

eq(gas.memoryExpansionCost(0n, 1n), 3n, 'first word costs 3');
eq(gas.memoryExpansionCost(1n, 2n), 3n, 'second word costs 3');
eq(gas.memoryExpansionCost(5n, 5n), 0n, 'no growth is free');
eq(gas.memoryExpansionCost(10n, 5n), 0n, 'shrinking is free, never negative');
// expansion is a difference of two C_mem values, NOT C_mem of the delta
eq(gas.memoryExpansionCost(1000n, 1024n), 167n, 'growing 1000 -> 1024 words costs 167');
ok(gas.memoryExpansionCost(1000n, 1024n) !== gas.memoryCost(24n),
  'expansion is not C_mem(delta) — that would be 73, and would undercharge big buffers');
eq(gas.memoryExpansionForRange(0n, 0n, 32n), 3n, 'MSTORE at offset 0 expands one word');
eq(gas.memoryExpansionForRange(0n, 1n << 200n, 0n), 0n,
  'a zero-length access never expands memory, however wild the offset');

// ---- EIP-2929 --------------------------------------------------------------
group('EIP-2929 warm/cold');
eq(gas.accountAccessCost(true), 2600n, 'cold account access');
eq(gas.accountAccessCost(false), 100n, 'warm account access');
eq(gas.sloadCost(true), 2100n, 'cold storage slot');
eq(gas.sloadCost(false), 100n, 'warm storage slot');
eq(gas.extcodecopyCost(true, 32), 2603n, 'cold EXTCODECOPY of one word');
eq(gas.extcodecopyCost(false, 32), 103n, 'warm EXTCODECOPY of one word');
eq(gas.extcodecopyCost(false, 0), 100n, 'warm EXTCODECOPY of nothing still pays access');

// ---- SSTORE ----------------------------------------------------------------
group('SSTORE truth table (EIP-2200 metering, 2929 pricing, 3529 refunds)');
{
  const A = 1n, B = 2n, C = 3n, Z = 0n;
  const GAS = 100000n;
  const s = (original, current, value, cold = false) =>
    gas.sstoreCost({ cold, original, current, value, gasRemaining: GAS });

  //  #   orig cur  new       cost    refund
  let r;
  r = s(Z, Z, Z); eq(r.cost, 100n, 'row 1 cost: 0/0/0 no-op'); eq(r.refund, 0n, 'row 1 refund');
  r = s(A, A, A); eq(r.cost, 100n, 'row 2 cost: x/x/x no-op'); eq(r.refund, 0n, 'row 2 refund');
  r = s(Z, Z, B); eq(r.cost, 20000n, 'row 3 cost: create a slot'); eq(r.refund, 0n, 'row 3 refund');
  r = s(A, A, B); eq(r.cost, 2900n, 'row 4 cost: overwrite (5000 - 2100)'); eq(r.refund, 0n, 'row 4 refund');
  r = s(A, A, Z); eq(r.cost, 2900n, 'row 5 cost: clear'); eq(r.refund, 4800n, 'row 5 refund: +4800');
  r = s(Z, B, Z); eq(r.cost, 100n, 'row 6 cost: undo a create'); eq(r.refund, 19900n, 'row 6 refund: 20000 - 100');
  r = s(Z, B, C); eq(r.cost, 100n, 'row 7 cost: dirty, still new'); eq(r.refund, 0n, 'row 7 refund');
  r = s(A, Z, C); eq(r.cost, 100n, 'row 8 cost: un-clear'); eq(r.refund, -4800n, 'row 8 refund: take 4800 back');
  r = s(A, Z, A); eq(r.cost, 100n, 'row 9 cost: un-clear back to original');
  eq(r.refund, -2000n, 'row 9 refund: -4800 + 2800');
  r = s(A, B, Z); eq(r.cost, 100n, 'row 10 cost: clear an already-dirty slot'); eq(r.refund, 4800n, 'row 10 refund');
  r = s(A, B, A); eq(r.cost, 100n, 'row 11 cost: restore original'); eq(r.refund, 2800n, 'row 11 refund: 2900 - 100');
  r = s(A, B, C); eq(r.cost, 100n, 'row 12 cost: dirty overwrite'); eq(r.refund, 0n, 'row 12 refund');

  // cold adds COLD_SLOAD to every row
  eq(s(Z, Z, Z, true).cost, 2200n, 'cold no-op: 2100 + 100');
  eq(s(Z, Z, B, true).cost, 22100n, 'cold create: 2100 + 20000');
  eq(s(A, A, B, true).cost, 5000n, 'cold overwrite is exactly the classic 5000 — 2100 + 2900');
  eq(s(A, B, C, true).cost, 2200n, 'cold dirty overwrite: 2100 + 100');
  eq(s(A, A, Z, true).refund, 4800n, 'cold does not change the refund');

  // the EIP-2200 reentrancy sentry
  const sentry = (g) => gas.sstoreCost({ original: Z, current: Z, value: A, gasRemaining: g });
  ok(sentry(2300n).sentry === true, 'sentry trips at exactly 2300 gas remaining');
  ok(sentry(2299n).sentry === true, 'sentry trips below 2300');
  ok(sentry(2301n).sentry === false, 'sentry clears at 2301');
  eq(sentry(2300n).cost, 0n, 'a tripped sentry charges nothing — the frame just dies');
  ok(sentry(2300n).refund === 0n, 'a tripped sentry accrues no refund');
}

// ---- CALL family -----------------------------------------------------------
group('CALL family, EIP-150 and EIP-2929');
eq(gas.allButOne64th(64n), 63n, 'all but one 64th of 64 is 63');
eq(gas.allButOne64th(63n), 63n, 'below 64 the reservation floors to zero');
eq(gas.allButOne64th(128n), 126n, 'all but one 64th of 128 is 126');
eq(gas.allButOne64th(0n), 0n, 'nothing left, nothing to give');
{
  const REM = 100000n;
  let c;

  c = gas.callCost({ kind: 'CALL', cold: false, gasRemaining: REM, requestedGas: 1n << 64n });
  // 100 upfront, 99900 left, 99900/64 = 1560 reserved, 98340 handed on
  eq(c.cost, 98440n, 'warm valueless CALL: 100 + 98340');
  eq(c.childGas, 98340n, 'warm valueless CALL child gas');
  eq(c.stipend, 0n, 'no value, no stipend');

  c = gas.callCost({ kind: 'CALL', cold: true, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98479n, 'cold CALL pays 2600 up front: 2600 + 95879');
  eq(c.childGas, 95879n, 'cold CALL child gas');

  c = gas.callCost({ kind: 'CALL', value: 1n, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98580n, 'CALL with value: 100 + 9000 + 89480');
  eq(c.childGas, 91780n, 'child gets 89480 plus the 2300 stipend');
  eq(c.stipend, 2300n, 'the stipend is 2300');

  c = gas.callCost({ kind: 'CALL', value: 1n, targetEmpty: true, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98971n, 'CALL creating an account: 100 + 9000 + 25000 + 64871');
  eq(c.childGas, 67171n, 'account-creating CALL child gas includes the stipend');

  c = gas.callCost({ kind: 'CALL', value: 0n, targetEmpty: true, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98440n, 'no value means no 25000, even to an empty account');

  c = gas.callCost({ kind: 'CALLCODE', value: 1n, targetEmpty: true, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98580n, 'CALLCODE pays the 9000 but never the 25000 — it creates nothing');
  eq(c.stipend, 2300n, 'CALLCODE with value gets a stipend');

  c = gas.callCost({ kind: 'DELEGATECALL', cold: false, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98440n, 'DELEGATECALL is priced like a valueless CALL');
  eq(c.stipend, 0n, 'DELEGATECALL never gets a stipend');

  c = gas.callCost({ kind: 'STATICCALL', cold: true, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98479n, 'STATICCALL pays the cold surcharge too');

  // asking for less than the cap gets exactly what was asked for
  c = gas.callCost({ kind: 'CALL', gasRemaining: REM, requestedGas: 1000n });
  eq(c.cost, 1100n, 'a modest gas request is honoured exactly');
  eq(c.childGas, 1000n, 'child gets what it asked for');

  // memory expansion is paid BEFORE the 63/64 cap is computed
  c = gas.callCost({ kind: 'CALL', memoryCost: 1000n, gasRemaining: REM, requestedGas: 1n << 64n });
  eq(c.cost, 98455n, 'memory is inside the 63/64 base: 1100 + 97355');
  eq(c.childGas, 97355n, 'child gas is capped on what is left after memory');

  c = gas.callCost({ kind: 'CALL', gasRemaining: 50n, requestedGas: 0n });
  ok(c.outOfGas === true, 'not enough gas for the access cost is out of gas');
  eq(c.childGas, 0n, 'an out-of-gas call hands on nothing');

  let threw = false;
  try { gas.callCost({ kind: 'STATICCALL', value: 1n, gasRemaining: REM }); } catch { threw = true; }
  ok(threw, 'STATICCALL with value is a programming error, not a gas outcome');
  threw = false;
  try { gas.callCost({ kind: 'CALLL', gasRemaining: REM }); } catch { threw = true; }
  ok(threw, 'an unknown call kind is rejected rather than silently mispriced');
}

// ---- EXP, KECCAK256, LOG, COPY, CREATE2, 3860 ------------------------------
group('EXP / KECCAK256 / LOG / COPY / CREATE');
eq(gas.expCost(0n), 0n, 'EXP with a zero exponent has no byte cost');
eq(gas.expCost(1n), 50n, 'EXP: 50 per byte of exponent');
eq(gas.expCost(255n), 50n, 'EXP: 255 is still one byte');
eq(gas.expCost(256n), 100n, 'EXP: 256 is two bytes');
eq(gas.expCost((1n << 255n)), 1600n, 'EXP: a full 32-byte exponent is 1600');
eq(gas.baseGas(BY_NAME.EXP.op) + gas.expCost(256n), 110n, 'EXP total for exponent 256 is 110');

eq(gas.keccak256WordsCost(0), 0n, 'KECCAK256 of nothing has no word cost');
eq(gas.keccak256WordsCost(32), 6n, 'KECCAK256: 6 per word');
eq(gas.keccak256WordsCost(33), 12n, 'KECCAK256: 33 bytes is two words');
eq(gas.baseGas(BY_NAME.KECCAK256.op) + gas.keccak256WordsCost(32), 36n, 'KECCAK256 of one word totals 36');

eq(gas.copyWordsCost(0), 0n, 'copy of nothing is free');
eq(gas.copyWordsCost(1), 3n, 'copy: 3 per word, one byte is one word');
eq(gas.copyWordsCost(64), 6n, 'copy: 64 bytes is two words');
eq(gas.baseGas(BY_NAME.CODECOPY.op) + gas.copyWordsCost(32) + gas.memoryExpansionCost(0n, 1n), 9n,
  'CODECOPY of one word into fresh memory totals 9');

eq(gas.logCost(0, 0), 375n, 'LOG0 with no data is 375');
eq(gas.logCost(1, 0), 750n, 'LOG1 with no data is 750');
eq(gas.logCost(4, 32), 2131n, 'LOG4 of one word: 375 + 1500 + 256');
eq(gas.logCost(2, 10), 1205n, 'LOG2 of 10 bytes: 375 + 750 + 80');
{
  let threw = false;
  try { gas.logCost(5, 0); } catch { threw = true; }
  ok(threw, 'there is no LOG5');
}

eq(gas.initcodeWordCost(0), 0n, 'EIP-3860: no initcode, no cost');
eq(gas.initcodeWordCost(32), 2n, 'EIP-3860: 2 per word');
eq(gas.initcodeWordCost(33), 4n, 'EIP-3860: rounds up to whole words');
eq(gas.createCost(32), 2n, 'CREATE pays only the initcode word cost beyond its 32000');
eq(gas.baseGas(BY_NAME.CREATE.op) + gas.createCost(32), 32002n, 'CREATE of a one-word initcode totals 32002');
eq(gas.create2Cost(32), 8n, 'CREATE2 adds 6/word hashing to the 2/word initcode cost');
eq(gas.create2Cost(64), 16n, 'CREATE2 of two words is 12 + 4');
eq(gas.baseGas(BY_NAME.CREATE2.op) + gas.create2Cost(32), 32008n, 'CREATE2 of a one-word initcode totals 32008');
ok(gas.initcodeTooLarge(49152n) === false, 'EIP-3860 allows exactly 49152 bytes');
ok(gas.initcodeTooLarge(49153n) === true, 'EIP-3860 rejects 49153 bytes');

// ---- SELFDESTRUCT ----------------------------------------------------------
group('SELFDESTRUCT');
eq(gas.selfdestructCost({}), 5000n, 'warm selfdestruct to a live account is 5000');
eq(gas.selfdestructCost({ cold: true }), 7600n, 'cold beneficiary adds 2600');
eq(gas.selfdestructCost({ beneficiaryEmpty: true, balance: 1n }), 30000n,
  'creating the beneficiary adds 25000');
eq(gas.selfdestructCost({ cold: true, beneficiaryEmpty: true, balance: 1n }), 32600n,
  'cold and creating: 5000 + 2600 + 25000');
eq(gas.selfdestructCost({ beneficiaryEmpty: true, balance: 0n }), 5000n,
  'no balance to move means no account is created');

// ---- intrinsic transaction gas ---------------------------------------------
group('intrinsic transaction gas');
eq(gas.intrinsicGas({}), 21000n, 'a bare transaction is 21000');
eq(gas.intrinsicGas({ isCreation: true }), 53000n, 'a bare creation is 53000');
eq(gas.intrinsicGas({ data: Buffer.from([0x00, 0x01]) }), 21020n, 'one zero byte (4) and one non-zero (16)');
eq(gas.intrinsicGas({ data: Buffer.alloc(100) }), 21400n, '100 zero bytes cost 4 each');
eq(gas.intrinsicGas({ data: Buffer.alloc(100, 0xff) }), 22600n, '100 non-zero bytes cost 16 each');
eq(gas.intrinsicGas({ data: Buffer.alloc(32, 0xff), isCreation: true }), 53514n,
  'creation with a one-word initcode: 53000 + 512 + 2');
eq(gas.intrinsicGas({ data: Buffer.alloc(33, 0xff), isCreation: true }), 53532n,
  'creation with a 33-byte initcode: 53000 + 528 + 4');
eq(gas.intrinsicGas({ data: Buffer.alloc(32, 0xff) }), 21512n,
  'a plain call pays no initcode word cost');
eq(gas.intrinsicGas({ accessList: [{ address: '0x', storageKeys: ['a', 'b'] }] }), 27200n,
  'access list: 21000 + 2400 + 2 * 1900');

// ---- refunds ---------------------------------------------------------------
group('refunds (EIP-3529 cap of gasUsed/5)');
eq(gas.refundAllowance(100000n, 50000n), 20000n, 'a large refund is capped at a fifth of gas used');
eq(gas.refundAllowance(100000n, 10000n), 10000n, 'a small refund is granted in full');
eq(gas.refundAllowance(100000n, 0n), 0n, 'no refund counter, no refund');
eq(gas.refundAllowance(100000n, -5000n), 0n, 'a negative counter never becomes a charge');
eq(gas.refundAllowance(4n, 1n), 0n, 'the cap floors: a fifth of 4 is 0');
eq(gas.refundAllowance(100000n, 20000n), 20000n, 'exactly at the cap is granted in full');
ok(gas.refundAllowance(100000n, 50000n) !== 50000n / 2n,
  'the cap is a fifth, not the pre-London half');

eq(gas.codeDepositCost(0), 0n, 'no code, no deposit');
eq(gas.codeDepositCost(10), 2000n, 'code deposit is 200 per byte');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} gas checks`);
process.exit(fail === 0 ? 0 : 1);
