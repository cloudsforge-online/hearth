'use strict';
/* Ember EVM — the opcode metadata table (Shanghai).
 *
 * This module is METADATA ONLY. It contains no behaviour and no gas arithmetic;
 * `interpreter.js` is a switch over behaviour, `gas.js` owns the numbers, and both
 * read their structural facts from here. The CLI tracer renders disassembly straight
 * off this table, and the interpreter's stack validation is driven by `minStack` /
 * `maxStack` below.
 *
 * Every one of the 256 byte values has an entry. Opcodes that Shanghai does not
 * define carry `defined: false` so the interpreter fails them as invalid instructions
 * (consume all gas, exceptional halt) rather than silently treating them as no-ops.
 *
 * Stack effects use the Yellow Paper's delta/alpha convention, which is also what
 * go-ethereum's jump table encodes:
 *
 *   pops   (delta) — how many items the instruction removes from the stack
 *   pushes (alpha) — how many items it puts back
 *
 * so DUPn is (n -> n+1), SWAPn is (n+1 -> n+1) and LOGn is (n+2 -> 0). The derived
 * fields are the ones the interpreter actually checks:
 *
 *   minStack = pops                        (need at least this many items)
 *   maxStack = 1024 + pops - pushes        (stack must be at or below this beforehand)
 *
 * GAS CONTRACT — read this before wiring the interpreter:
 *
 *   total = gas.baseGas(op)  +  <dynamic>  +  <memory expansion>
 *
 *   `tier` names a fixed cost that gas.js turns into a number and that is charged
 *   unconditionally. `dynamicGas` names the gas.js export that computes the rest, or
 *   is null when there is none. `expandsMemory` says the instruction may grow memory
 *   and so owes `gas.memoryExpansionCost(...)` on top. Opcodes whose price is entirely
 *   situational (SLOAD, SSTORE, the CALL family, SELFDESTRUCT, BALANCE, EXTCODE*) sit
 *   in the `zero` tier and get their FULL cost from the named gas function — there is
 *   no hidden constant to remember.
 *
 * Fork: Shanghai. That means PUSH0 (EIP-3855) is present at 0x5f, and the Cancun
 * additions — TLOAD 0x5c, TSTORE 0x5d, MCOPY 0x5e, BLOBHASH 0x49, BLOBBASEFEE 0x4a —
 * are deliberately left undefined.
 */

/** Fixed-cost tiers. gas.js maps these names to numbers; nothing here is numeric. */
const TIERS = Object.freeze([
  'zero',       // 0     — free, or fully priced by a dynamic gas function
  'jumpdest',   // 1
  'base',       // 2     — G_base
  'verylow',    // 3     — G_verylow
  'low',        // 5     — G_low
  'mid',        // 8     — G_mid
  'high',       // 10    — G_high
  'exp',        // 10    — G_exp, the EXP constant (distinct name, same value as high)
  'blockhash',  // 20    — G_blockhash
  'keccak256',  // 30    — G_sha3
  'create',     // 32000 — G_create
]);

const TIER_SET = new Set(TIERS);

/* Opcodes forbidden outright inside a STATICCALL frame (EIP-214). CALL is not in this
 * list because it is only forbidden when it transfers value — see `staticIfValue`. */
const STATIC_FORBIDDEN = ['SSTORE', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4', 'CREATE', 'CREATE2', 'SELFDESTRUCT'];

const OPCODES = new Array(256);
const BY_NAME = Object.create(null);

/** Every entry is frozen; the table is a constant, not a scratchpad. */
function def(op, name, pops, pushes, tier, extra) {
  if (!TIER_SET.has(tier)) throw new Error(`opcodes: unknown tier "${tier}" for ${name}`);
  if (OPCODES[op]) throw new Error(`opcodes: duplicate definition at 0x${op.toString(16)}`);
  const e = Object.assign({
    op,                       // the byte itself
    name,                     // mnemonic, as a disassembler would print it
    defined: true,            // false only for bytes Shanghai does not assign
    pops,                     // delta
    pushes,                   // alpha
    minStack: pops,
    maxStack: 1024 + pops - pushes,
    tier,                     // fixed-cost tier name, resolved by gas.js
    dynamicGas: null,         // name of the gas.js export that prices the rest
    expandsMemory: false,     // instruction may grow memory; owes memoryExpansionCost
    terminates: false,        // ends the current frame
    writesState: false,       // mutates storage, logs, code or balance
    staticForbidden: false,   // always illegal inside STATICCALL
    staticIfValue: false,     // illegal inside STATICCALL only when value != 0 (CALL)
    reverts: false,           // REVERT: halts and rolls back, but returns data
    invalid: false,           // 0xfe, the designated invalid instruction
    immediate: 0,             // bytes of inline operand following the opcode (PUSHn)
  }, extra || {});
  Object.freeze(e);
  OPCODES[op] = e;
  BY_NAME[name] = e;
  return e;
}

// ---- 0x00 arithmetic -------------------------------------------------------
def(0x00, 'STOP', 0, 0, 'zero', { terminates: true });
def(0x01, 'ADD', 2, 1, 'verylow');
def(0x02, 'MUL', 2, 1, 'low');
def(0x03, 'SUB', 2, 1, 'verylow');
def(0x04, 'DIV', 2, 1, 'low');
def(0x05, 'SDIV', 2, 1, 'low');
def(0x06, 'MOD', 2, 1, 'low');
def(0x07, 'SMOD', 2, 1, 'low');
def(0x08, 'ADDMOD', 3, 1, 'mid');
def(0x09, 'MULMOD', 3, 1, 'mid');
def(0x0a, 'EXP', 2, 1, 'exp', { dynamicGas: 'expCost' });
def(0x0b, 'SIGNEXTEND', 2, 1, 'low');

// ---- 0x10 comparison and bitwise -------------------------------------------
def(0x10, 'LT', 2, 1, 'verylow');
def(0x11, 'GT', 2, 1, 'verylow');
def(0x12, 'SLT', 2, 1, 'verylow');
def(0x13, 'SGT', 2, 1, 'verylow');
def(0x14, 'EQ', 2, 1, 'verylow');
def(0x15, 'ISZERO', 1, 1, 'verylow');
def(0x16, 'AND', 2, 1, 'verylow');
def(0x17, 'OR', 2, 1, 'verylow');
def(0x18, 'XOR', 2, 1, 'verylow');
def(0x19, 'NOT', 1, 1, 'verylow');
def(0x1a, 'BYTE', 2, 1, 'verylow');
def(0x1b, 'SHL', 2, 1, 'verylow');
def(0x1c, 'SHR', 2, 1, 'verylow');
def(0x1d, 'SAR', 2, 1, 'verylow');

// ---- 0x20 keccak -----------------------------------------------------------
def(0x20, 'KECCAK256', 2, 1, 'keccak256', { dynamicGas: 'keccak256WordsCost', expandsMemory: true });

// ---- 0x30 environment ------------------------------------------------------
def(0x30, 'ADDRESS', 0, 1, 'base');
def(0x31, 'BALANCE', 1, 1, 'zero', { dynamicGas: 'accountAccessCost' });
def(0x32, 'ORIGIN', 0, 1, 'base');
def(0x33, 'CALLER', 0, 1, 'base');
def(0x34, 'CALLVALUE', 0, 1, 'base');
def(0x35, 'CALLDATALOAD', 1, 1, 'verylow');
def(0x36, 'CALLDATASIZE', 0, 1, 'base');
def(0x37, 'CALLDATACOPY', 3, 0, 'verylow', { dynamicGas: 'copyWordsCost', expandsMemory: true });
def(0x38, 'CODESIZE', 0, 1, 'base');
def(0x39, 'CODECOPY', 3, 0, 'verylow', { dynamicGas: 'copyWordsCost', expandsMemory: true });
def(0x3a, 'GASPRICE', 0, 1, 'base');
def(0x3b, 'EXTCODESIZE', 1, 1, 'zero', { dynamicGas: 'accountAccessCost' });
def(0x3c, 'EXTCODECOPY', 4, 0, 'zero', { dynamicGas: 'extcodecopyCost', expandsMemory: true });
def(0x3d, 'RETURNDATASIZE', 0, 1, 'base');
def(0x3e, 'RETURNDATACOPY', 3, 0, 'verylow', { dynamicGas: 'copyWordsCost', expandsMemory: true });
def(0x3f, 'EXTCODEHASH', 1, 1, 'zero', { dynamicGas: 'accountAccessCost' });

// ---- 0x40 block context ----------------------------------------------------
def(0x40, 'BLOCKHASH', 1, 1, 'blockhash');
def(0x41, 'COINBASE', 0, 1, 'base');
def(0x42, 'TIMESTAMP', 0, 1, 'base');
def(0x43, 'NUMBER', 0, 1, 'base');
// Post-Merge this is PREVRANDAO (EIP-4399). Hearth keeps proof-of-work, so it reports
// the block difficulty; the mnemonic stays PREVRANDAO because that is what Shanghai
// disassemblers and Solidity emit, and the opcode number is what matters to consensus.
def(0x44, 'PREVRANDAO', 0, 1, 'base');
def(0x45, 'GASLIMIT', 0, 1, 'base');
def(0x46, 'CHAINID', 0, 1, 'base');
def(0x47, 'SELFBALANCE', 0, 1, 'low');
// BASEFEE is part of Shanghai (EIP-3198) even though Hearth v1 has no EIP-1559 market.
// It must exist and push a value (zero) — removing it would make Shanghai-compiled
// Solidity fail here but not on Ethereum, which is exactly the divergence to avoid.
def(0x48, 'BASEFEE', 0, 1, 'base');

// ---- 0x50 stack, memory, storage, flow -------------------------------------
def(0x50, 'POP', 1, 0, 'base');
def(0x51, 'MLOAD', 1, 1, 'verylow', { expandsMemory: true });
def(0x52, 'MSTORE', 2, 0, 'verylow', { expandsMemory: true });
def(0x53, 'MSTORE8', 2, 0, 'verylow', { expandsMemory: true });
def(0x54, 'SLOAD', 1, 1, 'zero', { dynamicGas: 'sloadCost' });
def(0x55, 'SSTORE', 2, 0, 'zero', { dynamicGas: 'sstoreCost', writesState: true, staticForbidden: true });
def(0x56, 'JUMP', 1, 0, 'mid');
def(0x57, 'JUMPI', 2, 0, 'high');
def(0x58, 'PC', 0, 1, 'base');
def(0x59, 'MSIZE', 0, 1, 'base');
def(0x5a, 'GAS', 0, 1, 'base');
def(0x5b, 'JUMPDEST', 0, 0, 'jumpdest');
// 0x5c TLOAD, 0x5d TSTORE, 0x5e MCOPY are Cancun — undefined in Shanghai.
def(0x5f, 'PUSH0', 0, 1, 'base');            // EIP-3855; base tier (2), not verylow

// ---- 0x60 PUSH1..PUSH32 ----------------------------------------------------
for (let n = 1; n <= 32; n++) def(0x5f + n, 'PUSH' + n, 0, 1, 'verylow', { immediate: n });

// ---- 0x80 DUP1..DUP16 ------------------------------------------------------
for (let n = 1; n <= 16; n++) def(0x7f + n, 'DUP' + n, n, n + 1, 'verylow');

// ---- 0x90 SWAP1..SWAP16 ----------------------------------------------------
for (let n = 1; n <= 16; n++) def(0x8f + n, 'SWAP' + n, n + 1, n + 1, 'verylow');

// ---- 0xa0 LOG0..LOG4 -------------------------------------------------------
// Entirely dynamic: 375 + 375 per topic + 8 per byte all come from gas.logCost.
for (let n = 0; n <= 4; n++) {
  def(0xa0 + n, 'LOG' + n, n + 2, 0, 'zero',
    { dynamicGas: 'logCost', expandsMemory: true, writesState: true, staticForbidden: true });
}

// ---- 0xf0 system -----------------------------------------------------------
def(0xf0, 'CREATE', 3, 1, 'create',
  { dynamicGas: 'createCost', expandsMemory: true, writesState: true, staticForbidden: true });
def(0xf1, 'CALL', 7, 1, 'zero',
  { dynamicGas: 'callCost', expandsMemory: true, writesState: true, staticIfValue: true });
def(0xf2, 'CALLCODE', 7, 1, 'zero', { dynamicGas: 'callCost', expandsMemory: true, writesState: true });
def(0xf3, 'RETURN', 2, 0, 'zero', { expandsMemory: true, terminates: true });
def(0xf4, 'DELEGATECALL', 6, 1, 'zero', { dynamicGas: 'callCost', expandsMemory: true, writesState: true });
def(0xf5, 'CREATE2', 4, 1, 'create',
  { dynamicGas: 'create2Cost', expandsMemory: true, writesState: true, staticForbidden: true });
def(0xfa, 'STATICCALL', 6, 1, 'zero', { dynamicGas: 'callCost', expandsMemory: true });
def(0xfd, 'REVERT', 2, 0, 'zero', { expandsMemory: true, terminates: true, reverts: true });
// 0xfe is the *designated* invalid instruction: defined by the spec, guaranteed to
// remain undefined-as-an-operation, and distinct from an unassigned byte only in that
// a disassembler should print INVALID rather than a hex blob. Both consume all gas.
def(0xfe, 'INVALID', 0, 0, 'zero', { terminates: true, invalid: true });
def(0xff, 'SELFDESTRUCT', 1, 0, 'zero',
  { dynamicGas: 'selfdestructCost', terminates: true, writesState: true, staticForbidden: true });

// ---- everything else is undefined ------------------------------------------
for (let op = 0; op < 256; op++) {
  if (OPCODES[op]) continue;
  OPCODES[op] = Object.freeze({
    op,
    name: 'UNDEFINED_' + op.toString(16).padStart(2, '0'),
    defined: false,
    pops: 0,
    pushes: 0,
    minStack: 0,
    maxStack: 1024,
    tier: 'zero',
    dynamicGas: null,
    expandsMemory: false,
    terminates: true,      // an unassigned byte halts the frame exceptionally
    writesState: false,
    staticForbidden: false,
    staticIfValue: false,
    reverts: false,
    invalid: true,
    immediate: 0,
  });
}

/* STATIC_FORBIDDEN is declared above as documentation; this asserts that it and the
 * per-opcode flags cannot drift apart. Two lists of the same fact is how a static-call
 * check quietly stops covering CREATE2 three refactors from now. */
{
  const flagged = OPCODES.filter((e) => e.staticForbidden).map((e) => e.name).sort().join(',');
  const declared = STATIC_FORBIDDEN.slice().sort().join(',');
  if (flagged !== declared) {
    throw new Error(`opcodes: STATIC_FORBIDDEN says [${declared}] but the flags say [${flagged}]`);
  }
}

Object.freeze(OPCODES);
Object.freeze(BY_NAME);

// ---- accessors -------------------------------------------------------------

/** The entry for a byte. Always defined for 0..255; throws outside that range. */
function opcodeAt(op) {
  const e = OPCODES[op];
  if (!e) throw new RangeError(`opcodes: ${op} is not a byte`);
  return e;
}

/** Mnemonic for a byte, for tracing and disassembly. */
function nameOf(op) { return opcodeAt(op).name; }

/** true when `op` is PUSH1..PUSH32. PUSH0 has no immediate and is excluded. */
function isPush(op) { return op >= 0x60 && op <= 0x7f; }
/** Number of immediate bytes following a PUSH; 0 for everything else. */
function pushBytes(op) { return isPush(op) ? op - 0x5f : 0; }
function isDup(op) { return op >= 0x80 && op <= 0x8f; }
function isSwap(op) { return op >= 0x90 && op <= 0x9f; }
function isLog(op) { return op >= 0xa0 && op <= 0xa4; }
/** Topic count for LOG0..LOG4, else -1. */
function logTopics(op) { return isLog(op) ? op - 0xa0 : -1; }

module.exports = {
  TIERS,
  OPCODES,
  BY_NAME,
  STATIC_FORBIDDEN,
  opcodeAt,
  nameOf,
  isPush,
  pushBytes,
  isDup,
  isSwap,
  isLog,
  logTopics,
};
