'use strict';
/* Unit tests for the Shanghai opcode metadata table. Zero-dependency mini harness.
 * Run: node test/opcodes.js
 *
 * Checked against go-ethereum's core/vm/jump_table.go and eips.go for the Shanghai
 * instruction set. The point of most of these is not that the table is pretty but
 * that the interpreter can trust it: undefined bytes must be undefined, stack effects
 * must match the Yellow Paper's delta/alpha, and the fork boundary must be exactly
 * Shanghai and not accidentally Cancun. */

const O = require('../src/evm/opcodes');
const gas = require('../src/evm/gas');
const { OPCODES, BY_NAME } = O;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(actual, expected, msg) {
  const good = actual === expected;
  if (!good) console.log(`  ✗ ${msg}: expected ${expected}, got ${actual}`);
  if (good) pass++; else fail++;
}
function group(name) { console.log('• ' + name); }

// ---- shape -----------------------------------------------------------------
group('table shape');
eq(OPCODES.length, 256, 'every byte value has an entry');
{
  let allFrozen = true, allTiered = true, opMatches = true;
  const tiers = new Set(O.TIERS);
  for (let i = 0; i < 256; i++) {
    const e = OPCODES[i];
    if (!Object.isFrozen(e)) allFrozen = false;
    if (!tiers.has(e.tier)) allTiered = false;
    if (e.op !== i) opMatches = false;
  }
  ok(allFrozen, 'entries are frozen — the table is a constant, not a scratchpad');
  ok(allTiered, 'every entry declares a tier that gas.js knows about');
  ok(opMatches, 'every entry knows its own byte');
}
{
  let derived = true;
  for (const e of OPCODES) {
    if (e.minStack !== e.pops) derived = false;
    if (e.maxStack !== 1024 + e.pops - e.pushes) derived = false;
  }
  ok(derived, 'minStack and maxStack are derived consistently from pops/pushes');
}

// ---- defined vs undefined --------------------------------------------------
group('defined and undefined bytes');
{
  const defined = OPCODES.filter((e) => e.defined);
  eq(defined.length, 144, 'Shanghai defines exactly 144 of the 256 bytes');
  const names = new Set(defined.map((e) => e.name));
  eq(names.size, 144, 'no two defined opcodes share a mnemonic');
  let lookupOk = true;
  for (const e of defined) if (BY_NAME[e.name] !== e) lookupOk = false;
  ok(lookupOk, 'BY_NAME round-trips every defined opcode');
}
{
  // the undefined ranges, spelled out so a future fork addition has to touch this line
  const holes = [[0x0c, 0x0f], [0x1e, 0x1f], [0x21, 0x2f], [0x49, 0x4f],
                 [0x5c, 0x5e], [0xa5, 0xef], [0xf6, 0xf9], [0xfb, 0xfc]];
  let allUndefined = true, count = 0;
  for (const [lo, hi] of holes) {
    for (let i = lo; i <= hi; i++) { count++; if (OPCODES[i].defined) allUndefined = false; }
  }
  ok(allUndefined, 'every byte in the expected holes is undefined');
  eq(count, 112, 'the holes account for all 112 undefined bytes');
  let terminatesAndInvalid = true;
  for (const e of OPCODES) {
    if (!e.defined && !(e.terminates && e.invalid)) terminatesAndInvalid = false;
  }
  ok(terminatesAndInvalid, 'undefined bytes are marked invalid and terminating, not no-ops');
}
// the fork boundary: these are Cancun, and must NOT be here
ok(!OPCODES[0x5c].defined, '0x5c TLOAD is Cancun, not Shanghai');
ok(!OPCODES[0x5d].defined, '0x5d TSTORE is Cancun, not Shanghai');
ok(!OPCODES[0x5e].defined, '0x5e MCOPY is Cancun, not Shanghai');
ok(!OPCODES[0x49].defined, '0x49 BLOBHASH is Cancun, not Shanghai');
ok(!OPCODES[0x4a].defined, '0x4a BLOBBASEFEE is Cancun, not Shanghai');
// and these are Shanghai and must be
ok(OPCODES[0x5f].defined && OPCODES[0x5f].name === 'PUSH0', '0x5f is PUSH0 (EIP-3855)');
ok(OPCODES[0x48].defined && OPCODES[0x48].name === 'BASEFEE', '0x48 BASEFEE is present');
ok(OPCODES[0x1d].defined && OPCODES[0x1d].name === 'SAR', '0x1d SAR is present');
ok(OPCODES[0x3f].defined && OPCODES[0x3f].name === 'EXTCODEHASH', '0x3f EXTCODEHASH is present');
ok(OPCODES[0xf5].defined && OPCODES[0xf5].name === 'CREATE2', '0xf5 CREATE2 is present');

// 0xfe is *designated* invalid: defined by the spec as permanently invalid, and a
// disassembler should print INVALID rather than treat it as an unassigned byte.
ok(OPCODES[0xfe].defined, '0xfe INVALID is a defined opcode');
ok(OPCODES[0xfe].invalid && OPCODES[0xfe].terminates, '0xfe INVALID halts exceptionally');
eq(OPCODES[0xfe].name, 'INVALID', '0xfe prints as INVALID');

// ---- stack effects ---------------------------------------------------------
group('stack effects (Yellow Paper delta/alpha)');
eq(BY_NAME.ADD.pops, 2, 'ADD pops 2'); eq(BY_NAME.ADD.pushes, 1, 'ADD pushes 1');
eq(BY_NAME.ISZERO.pops, 1, 'ISZERO pops 1');
eq(BY_NAME.ADDMOD.pops, 3, 'ADDMOD pops 3');
eq(BY_NAME.STOP.pops, 0, 'STOP pops nothing');
eq(BY_NAME.PUSH0.pops, 0, 'PUSH0 pops nothing'); eq(BY_NAME.PUSH0.pushes, 1, 'PUSH0 pushes 1');
eq(BY_NAME.CALL.pops, 7, 'CALL pops 7'); eq(BY_NAME.CALL.pushes, 1, 'CALL pushes 1');
eq(BY_NAME.CALLCODE.pops, 7, 'CALLCODE pops 7');
eq(BY_NAME.DELEGATECALL.pops, 6, 'DELEGATECALL pops 6 — no value argument');
eq(BY_NAME.STATICCALL.pops, 6, 'STATICCALL pops 6');
eq(BY_NAME.CREATE.pops, 3, 'CREATE pops 3');
eq(BY_NAME.CREATE2.pops, 4, 'CREATE2 pops 4 — the extra one is the salt');
eq(BY_NAME.EXTCODECOPY.pops, 4, 'EXTCODECOPY pops 4');
eq(BY_NAME.RETURN.pops, 2, 'RETURN pops 2'); eq(BY_NAME.RETURN.pushes, 0, 'RETURN pushes nothing');
eq(BY_NAME.SELFDESTRUCT.pops, 1, 'SELFDESTRUCT pops 1');

// ---- the PUSH / DUP / SWAP / LOG ranges ------------------------------------
group('PUSH / DUP / SWAP / LOG ranges');
{
  let good = true;
  for (let n = 1; n <= 32; n++) {
    const e = OPCODES[0x5f + n];
    if (e.name !== 'PUSH' + n || e.immediate !== n || e.pops !== 0 || e.pushes !== 1 ||
        e.tier !== 'verylow' || !O.isPush(e.op) || O.pushBytes(e.op) !== n) good = false;
  }
  ok(good, 'PUSH1..PUSH32 at 0x60..0x7f, each with n immediate bytes');
  eq(BY_NAME.PUSH0.immediate, 0, 'PUSH0 has no immediate operand');
  ok(!O.isPush(0x5f), 'isPush excludes PUSH0 — it has nothing to read');
  eq(O.pushBytes(0x01), 0, 'a non-PUSH has no immediate bytes');
}
{
  let good = true;
  for (let n = 1; n <= 16; n++) {
    const e = OPCODES[0x7f + n];
    if (e.name !== 'DUP' + n || e.pops !== n || e.pushes !== n + 1 || !O.isDup(e.op)) good = false;
  }
  ok(good, 'DUP1..DUP16 at 0x80..0x8f, each (n -> n+1)');
  eq(BY_NAME.DUP16.minStack, 16, 'DUP16 needs 16 items');
  eq(BY_NAME.DUP16.maxStack, 1023, 'DUP16 needs room to grow by one');
}
{
  let good = true;
  for (let n = 1; n <= 16; n++) {
    const e = OPCODES[0x8f + n];
    if (e.name !== 'SWAP' + n || e.pops !== n + 1 || e.pushes !== n + 1 || !O.isSwap(e.op)) good = false;
  }
  ok(good, 'SWAP1..SWAP16 at 0x90..0x9f, each (n+1 -> n+1)');
  eq(BY_NAME.SWAP16.minStack, 17, 'SWAP16 needs 17 items');
  eq(BY_NAME.SWAP16.maxStack, 1024, 'SWAP16 does not grow the stack');
}
{
  let good = true;
  for (let n = 0; n <= 4; n++) {
    const e = OPCODES[0xa0 + n];
    if (e.name !== 'LOG' + n || e.pops !== n + 2 || e.pushes !== 0 ||
        !e.staticForbidden || !e.writesState || !e.expandsMemory ||
        !O.isLog(e.op) || O.logTopics(e.op) !== n) good = false;
  }
  ok(good, 'LOG0..LOG4 at 0xa0..0xa4, each (n+2 -> 0) and forbidden in static frames');
  eq(O.logTopics(0x01), -1, 'a non-LOG has no topic count');
}

// ---- flags -----------------------------------------------------------------
group('behavioural flags');
{
  const forbidden = OPCODES.filter((e) => e.staticForbidden).map((e) => e.name).sort();
  const expected = ['CREATE', 'CREATE2', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4', 'SELFDESTRUCT', 'SSTORE'];
  eq(forbidden.join(','), expected.join(','), 'exactly the EIP-214 write set is static-forbidden');
  ok(!BY_NAME.CALL.staticForbidden, 'CALL is not forbidden outright in a static frame');
  ok(BY_NAME.CALL.staticIfValue, 'CALL is forbidden in a static frame only when it moves value');
  const ifValue = OPCODES.filter((e) => e.staticIfValue).map((e) => e.name);
  eq(ifValue.join(','), 'CALL', 'CALL is the only conditional case');
  ok(!BY_NAME.STATICCALL.writesState, 'STATICCALL cannot write state');
  ok(!BY_NAME.SLOAD.writesState, 'SLOAD is a read');
  ok(BY_NAME.SSTORE.writesState, 'SSTORE writes state');
}
{
  const terminating = OPCODES.filter((e) => e.defined && e.terminates).map((e) => e.name).sort();
  eq(terminating.join(','), 'INVALID,RETURN,REVERT,SELFDESTRUCT,STOP',
    'exactly five defined opcodes end a frame');
  ok(BY_NAME.REVERT.reverts, 'REVERT is flagged as reverting');
  ok(!BY_NAME.RETURN.reverts, 'RETURN is not a revert');
  ok(!BY_NAME.STOP.reverts, 'STOP is not a revert');
}
{
  const mem = OPCODES.filter((e) => e.expandsMemory).map((e) => e.name).sort().join(',');
  const expected = ['CALL', 'CALLCODE', 'CALLDATACOPY', 'CODECOPY', 'CREATE', 'CREATE2',
    'DELEGATECALL', 'EXTCODECOPY', 'KECCAK256', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4',
    'MLOAD', 'MSTORE', 'MSTORE8', 'RETURN', 'RETURNDATACOPY', 'REVERT', 'STATICCALL'].sort().join(',');
  eq(mem, expected, 'exactly the memory-touching opcodes are flagged');
  ok(!BY_NAME.MSIZE.expandsMemory, 'MSIZE reads the size, it does not grow memory');
  ok(!BY_NAME.RETURNDATASIZE.expandsMemory, 'RETURNDATASIZE does not touch memory');
}

// ---- the gas contract ------------------------------------------------------
group('the gas contract with gas.js');
{
  const named = OPCODES.filter((e) => e.dynamicGas);
  let allResolve = true;
  for (const e of named) if (typeof gas[e.dynamicGas] !== 'function') allResolve = false;
  ok(allResolve, 'every dynamicGas name resolves to a gas.js export');
  ok(named.length > 0, 'some opcodes do have dynamic gas');
  // the fully-dynamic ones must sit in the zero tier, or their cost is double counted
  const zeroTierDynamic = ['SLOAD', 'SSTORE', 'BALANCE', 'EXTCODESIZE', 'EXTCODEHASH',
    'EXTCODECOPY', 'CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL', 'SELFDESTRUCT',
    'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4'];
  let zeroed = true;
  for (const n of zeroTierDynamic) if (BY_NAME[n].tier !== 'zero') zeroed = false;
  ok(zeroed, 'fully-priced-by-function opcodes are in the zero tier — no hidden constant');
  eq(BY_NAME.CALL.dynamicGas, 'callCost', 'CALL points at callCost');
  eq(BY_NAME.SSTORE.dynamicGas, 'sstoreCost', 'SSTORE points at sstoreCost');
  eq(BY_NAME.CALLDATACOPY.dynamicGas, 'copyWordsCost', 'CALLDATACOPY points at copyWordsCost');
  eq(BY_NAME.BALANCE.dynamicGas, 'accountAccessCost', 'BALANCE points at accountAccessCost');
  eq(BY_NAME.MLOAD.dynamicGas, null, 'MLOAD has no dynamic cost beyond memory');
  eq(BY_NAME.ADD.dynamicGas, null, 'ADD is a flat tier cost');
}

// ---- accessors -------------------------------------------------------------
group('accessors');
eq(O.nameOf(0x01), 'ADD', 'nameOf reads the mnemonic');
eq(O.nameOf(0x0c), 'UNDEFINED_0c', 'an undefined byte names itself in hex');
eq(O.opcodeAt(0x5f).name, 'PUSH0', 'opcodeAt returns the entry');
{
  let threw = false;
  try { O.opcodeAt(256); } catch { threw = true; }
  ok(threw, 'opcodeAt rejects a non-byte');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} opcode checks`);
process.exit(fail === 0 ? 0 : 1);
