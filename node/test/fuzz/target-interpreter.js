'use strict';
/* Fuzz target: src/evm/interpreter.js
 *
 * ONE PROPERTY MATTERS MORE THAN THE REST, and the spec states it as a rule
 * rather than a preference: an EVM failure is a RETURNED `{ exception }` and
 * never a JavaScript throw. A thrown error is indistinguishable, to any test
 * harness, from a correctly rejected transaction — which makes every vector
 * that asserts *failure* the easiest one in the corpus to fake, and makes a
 * genuine fault in the machine look like a correctly-refused transaction on a
 * live node. So:
 *
 *   P1  NEVER THROWS.  `evm.call` / `evm.create` return for every input.
 *   P2  NEVER CRASHES INTERNALLY.  The result carries no `internalError`. The
 *       interpreter catches JS errors at the frame boundary and flags them;
 *       that flag is a bug report, and this target reads it as one.
 *   P3  ALWAYS TERMINATES.  Bounded gas must mean bounded time. A loop that
 *       does not charge is an unkillable node.
 *   P4  GAS IS CONSERVED.  0 <= gasLeft <= gas supplied, always; and an
 *       exceptional halt (anything but REVERT) leaves exactly zero.
 *   P5  DETERMINISM.  The same code, gas and state give the same result twice.
 *       An EVM that is not a function of its inputs is a chain split.
 *   P6  THE RESULT SHAPE IS TOTAL.  `exception` is a string or null,
 *       `gasLeft` is a BigInt, `returnData` is a Buffer. Always.
 *
 * Bytecode comes from three generators, because uniform random bytes are a
 * weak fuzzer for a stack machine: almost every program dies of STACK
 * UNDERFLOW in the first few instructions and the interesting opcodes are
 * never reached with operands. So there is also a "primed" generator that
 * pushes plausible operands first, and a "structured" one that emits only
 * defined opcodes with correct PUSH immediates.
 */

const { StateDB, MemoryDB } = require('../../src/state/statedb');
const { EVM, ERR } = require('../../src/evm/interpreter');
const { OPCODES } = require('../../src/evm/opcodes');
const U = require('../../src/evm/uint256');
const { hex, unhex } = require('./harness');

const name = 'interpreter';

const DEFINED = [];
for (let i = 0; i < 256; i++) if (OPCODES[i]) DEFINED.push(i);

/* Opcodes worth reaching with real operands, because they are where an
 * interpreter allocates, recurses, or reads something it did not bound:
 * memory, the copy family, the call family, CREATE, LOG, SHA3, RETURNDATACOPY,
 * EXTCODECOPY. Uniform bytes hit them, but never with a stack under them. */
const JUICY = [
  0x20,                                                   // KECCAK256
  0x37, 0x39, 0x3c, 0x3e,                                 // CALLDATACOPY CODECOPY EXTCODECOPY RETURNDATACOPY
  0x51, 0x52, 0x53, 0x54, 0x55,                           // MLOAD MSTORE MSTORE8 SLOAD SSTORE
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5e,               // JUMP JUMPI PC MSIZE GAS JUMPDEST MCOPY
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4,                           // LOG0-4
  0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xfa, 0xfd, 0xfe, 0xff,
];

/* Words that make a good operand for the above: tiny offsets, offsets either
 * side of a word boundary, sizes that would allocate gigabytes if they were
 * not priced, and addresses of accounts this fixture actually has. */
function operandWord(rng) {
  return rng.weighted([
    [10, () => BigInt(rng.int(256))],
    [6, () => BigInt(rng.pick([0, 1, 31, 32, 33, 63, 64, 65, 96, 127, 128, 255, 256, 1023, 1024]))],
    [4, () => (1n << BigInt(rng.between(8, 255)))],
    [3, () => U.MAX_UINT256 - BigInt(rng.int(4))],
    [3, () => BigInt(rng.pick([0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03, 0x04, 0x09]))],
    [3, () => rng.bigUint(256)],
    [2, () => 0n],
  ])();
}

function pushWord(out, v) {
  const b = U.toBuffer(v);
  let i = 0;
  while (i < 31 && b[i] === 0) i++;
  const bytes = b.subarray(i);
  out.push(0x5f + bytes.length);                          // PUSH1..PUSH32 (0x60..0x7f)
  for (const x of bytes) out.push(x);
}

/** Uniform random bytes. The baseline: it must not be able to break anything. */
function randomCode(rng) {
  return rng.bytes(rng.between(1, 200));
}

/** Defined opcodes only, with PUSH immediates of the right length. */
function structuredCode(rng, len) {
  const out = [];
  while (out.length < len) {
    const op = rng.chance(0.35) ? rng.pick(JUICY) : rng.pick(DEFINED);
    out.push(op);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      for (let i = 0; i < n; i++) out.push(rng.u32() & 0xff);
    }
  }
  return Buffer.from(out.slice(0, Math.max(1, len)));
}

/** Operands first, then something that consumes them. */
function primedCode(rng, len) {
  const out = [];
  while (out.length < len) {
    const n = rng.between(1, 7);
    for (let i = 0; i < n; i++) pushWord(out, operandWord(rng));
    const op = rng.pick(JUICY);
    out.push(op);
    if (rng.chance(0.25)) out.push(0x5b);                 // a JUMPDEST to aim at
  }
  return Buffer.from(out.slice(0, Math.max(1, len)));
}

/** A deliberate unbounded loop: JUMPDEST … JUMP 0. Only gas may stop it. */
function loopCode(rng) {
  const body = [];
  const n = rng.between(0, 6);
  for (let i = 0; i < n; i++) {
    const op = rng.pick([0x50, 0x5a, 0x58, 0x59, 0x01, 0x03, 0x16, 0x19, 0x80, 0x90]);
    if (op === 0x80 || op === 0x90) { pushWord(body, operandWord(rng)); }
    body.push(op);
  }
  // 0x5b JUMPDEST, <body>, PUSH1 0x00, JUMP
  return Buffer.from([0x5b, ...body, 0x60, 0x00, 0x56]);
}

// ---------------------------------------------------------------------------

const ADDR = (n) => { const b = Buffer.alloc(20); b.writeUInt32BE(n, 16); return b; };
const SELF = ADDR(0xaa);
const CALLER = ADDR(0xca);

/** A small world with a few funded accounts and a bit of code to call into. */
function makeState(rng, code) {
  const db = new StateDB(new MemoryDB());
  db.setCode(SELF, code);
  db.setBalance(SELF, rng.chance(0.5) ? 10n ** 18n : 0n);
  db.setBalance(CALLER, 10n ** 20n);
  // A handful of neighbours so CALL/EXTCODECOPY/BALANCE have somewhere to go.
  for (const a of [0xbb, 0xcc, 0xdd]) {
    db.setBalance(ADDR(a), BigInt(rng.int(1000)));
    if (rng.chance(0.5)) db.setCode(ADDR(a), rng.bytes(rng.between(1, 40)));
  }
  if (rng.chance(0.5)) db.setStorage(SELF, U.toBuffer(BigInt(rng.int(4))), U.toBuffer(rng.bigUint(256)));
  db.commit();
  db.beginTransaction();
  return db;
}

function makeEvm(db, rng) {
  return new EVM({
    state: db,
    block: {
      number: BigInt(rng.int(1000000)),
      timestamp: BigInt(rng.int(2000000000)),
      coinbase: ADDR(0xc0),
      gasLimit: 30000000n,
      prevRandao: rng.bigUint(256),
      chainId: 7411n,
    },
    tx: { origin: CALLER, gasPrice: BigInt(rng.int(1000)) },
    blockHash: () => Buffer.alloc(32, 0x11),
  });
}

/** Every structural check on one result. */
function checkResult(t, r, repro, gasIn, label) {
  if (!t.ok(r && typeof r === 'object', `${label}: a result object was returned`, repro)) return;

  // P2 — the interpreter's own bug flag.
  t.ok(r.internalError === undefined,
    `${label}: no internalError — a JS fault inside the machine would masquerade as a rejected transaction`
    + (r.internalError ? `: ${r.internalError.stack ? r.internalError.stack.split('\n').slice(0, 3).join(' | ') : r.internalError.message}` : ''),
    repro);

  // P6 — the result shape is total.
  t.ok(r.exception === null || typeof r.exception === 'string', `${label}: exception is a string or null`, repro);
  t.ok(typeof r.gasLeft === 'bigint', `${label}: gasLeft is a BigInt`, repro);
  t.ok(Buffer.isBuffer(r.returnData), `${label}: returnData is a Buffer`, repro);

  // P4 — gas conservation.
  if (typeof r.gasLeft === 'bigint') {
    t.ok(r.gasLeft >= 0n, `${label}: gasLeft is not negative (${r.gasLeft})`, repro);
    t.ok(r.gasLeft <= gasIn, `${label}: gasLeft (${r.gasLeft}) never exceeds the gas supplied (${gasIn})`, repro);
    if (typeof r.exception === 'string' && r.exception !== ERR.REVERT && !/^internal error/.test(r.exception)) {
      // The interpreter's own header: every exceptional halt consumes all gas;
      // REVERT alone does not. DEPTH and INSUFFICIENT_BALANCE are refusals to
      // enter a frame at all and hand the gas straight back.
      const refusal = r.exception === ERR.DEPTH || r.exception === ERR.INSUFFICIENT_BALANCE;
      t.ok(refusal || r.gasLeft === 0n,
        `${label}: an exceptional halt (${r.exception}) consumed all gas`, repro);
    }
  }
}

function oneCase(t, rng, i) {
  const shape = rng.weighted([[22, 'random'], [24, 'structured'], [26, 'primed'], [10, 'loop'], [10, 'mixed'], [8, 'create']]);
  const len = rng.weighted([[10, -1], [3, 1], [3, 2], [2, 24576]]);
  const size = len === -1 ? rng.between(1, 220) : Math.min(len, 3000);

  let code;
  if (shape === 'random') code = randomCode(rng);
  else if (shape === 'structured') code = structuredCode(rng, size);
  else if (shape === 'primed') code = primedCode(rng, size);
  else if (shape === 'loop') code = loopCode(rng);
  else code = Buffer.concat([primedCode(rng, size >> 1), randomCode(rng)]);

  const gas = BigInt(rng.weighted([[10, -1], [4, 0], [3, 1], [3, 21000], [3, 100000], [2, 5000000]]) === -1
    ? rng.between(0, 3000000) : rng.pick([0, 1, 21000, 100000, 5000000]));
  const data = rng.bytes(rng.length(96));
  const value = rng.chance(0.25) ? BigInt(rng.int(1000)) : 0n;
  const isStatic = rng.chance(0.2);
  const repro = { code, gas, data, value, isStatic, isCreate: shape === 'create' };

  const db = makeState(rng, code);
  const evm = makeEvm(db, rng);

  const started = Date.now();
  let r, threw = null;
  try {
    r = shape === 'create'
      ? evm.create({ caller: CALLER, initcode: code, gas, value })
      : evm.call({ caller: CALLER, to: SELF, gas, data, value, isStatic });
  } catch (e) { threw = e; }
  const ms = Date.now() - started;

  // P1 — the rule the whole file is built around.
  if (!t.ok(threw === null,
    `${shape}: evm.${shape === 'create' ? 'create' : 'call'} threw ${threw && threw.constructor.name}: ${threw && threw.message}`
    + (threw && threw.stack ? ' @ ' + threw.stack.split('\n')[1].trim() : ''), repro)) return;

  // P3 — bounded gas means bounded time.
  t.ok(ms < 5000, `${shape}: finished in ${ms}ms with ${gas} gas`, repro);

  checkResult(t, r, repro, gas, shape);
}

/* A second world identical to the first, built without the PRNG so the
 * determinism check compares the machine rather than the fixture. */
function makeStateDeterministic(code) {
  const db = new StateDB(new MemoryDB());
  db.setCode(SELF, code);
  db.setBalance(SELF, 10n ** 18n);
  db.setBalance(CALLER, 10n ** 20n);
  db.commit();
  db.beginTransaction();
  return db;
}

/** Run the same program twice in identical worlds; the results must agree. */
function determinismCase(t, rng) {
  const code = rng.chance(0.5) ? primedCode(rng, rng.between(10, 150)) : structuredCode(rng, rng.between(10, 150));
  const gas = BigInt(rng.between(0, 1000000));
  const data = rng.bytes(rng.length(64));
  const repro = { code, gas, data, value: 0n, isStatic: false };

  const runOnce = () => {
    const db = makeStateDeterministic(code);
    const evm = new EVM({
      state: db,
      block: { number: 5n, timestamp: 1000n, coinbase: ADDR(0xc0), gasLimit: 30000000n, prevRandao: 7n, chainId: 7411n },
      tx: { origin: CALLER, gasPrice: 7n },
      blockHash: () => Buffer.alloc(32, 0x11),
    });
    try {
      const r = evm.call({ caller: CALLER, to: SELF, gas, data, value: 0n });
      return { ok: true, exception: r.exception, gasLeft: r.gasLeft, out: r.returnData.toString('hex'), logs: evm.logs.length, root: db.root().toString('hex'), internal: r.internalError };
    } catch (e) { return { ok: false, error: e }; }
  };

  const a = runOnce(), b = runOnce();
  if (!t.ok(a.ok && b.ok, `determinism: evm.call threw (${(a.error || b.error || {}).message})`, repro)) return;
  t.ok(a.exception === b.exception && a.gasLeft === b.gasLeft && a.out === b.out && a.logs === b.logs && a.root === b.root,
    `determinism: the same program in the same world gave two different answers `
    + `(${a.exception}/${a.gasLeft}/${a.root.slice(0, 12)} vs ${b.exception}/${b.gasLeft}/${b.root.slice(0, 12)})`, repro);
  t.ok(a.internal === undefined, `determinism: no internalError (${a.internal && a.internal.message})`, repro);
}

function run(t, rng, { cases, deadline }) {
  t.group('interpreter — always returns, never throws, always terminates');
  let i = 0;
  for (; i < cases; i++) {
    if ((i & 7) === 0 && Date.now() > deadline) break;
    t.context(name, i);
    if (rng.chance(0.15)) determinismCase(t, rng);
    else oneCase(t, rng, i);
  }
  return i;
}

function replay(t, entry) {
  t.context(name, entry.case === undefined ? -1 : entry.case);
  const label = `corpus ${entry._file}`;
  const code = Buffer.isBuffer(entry.code) ? entry.code : unhex(entry.code);
  const gas = typeof entry.gas === 'bigint' ? entry.gas : BigInt(entry.gas === undefined ? 100000 : entry.gas);
  const data = entry.data === undefined ? Buffer.alloc(0) : (Buffer.isBuffer(entry.data) ? entry.data : unhex(entry.data));
  const value = typeof entry.value === 'bigint' ? entry.value : BigInt(entry.value || 0);

  const db = makeStateDeterministic(code);
  const evm = new EVM({
    state: db,
    block: { number: 5n, timestamp: 1000n, coinbase: ADDR(0xc0), gasLimit: 30000000n, prevRandao: 7n, chainId: 7411n },
    tx: { origin: CALLER, gasPrice: 7n },
    blockHash: () => Buffer.alloc(32, 0x11),
  });
  const started = Date.now();
  let r, threw = null;
  try {
    r = entry.isCreate
      ? evm.create({ caller: CALLER, initcode: code, gas, value })
      : evm.call({ caller: CALLER, to: SELF, gas, data, value, isStatic: !!entry.isStatic });
  } catch (e) { threw = e; }
  if (!t.ok(threw === null, `${label}: must not throw (${threw && threw.message}) — code ${hex(code)}`)) return;
  t.ok(Date.now() - started < 5000, `${label}: terminates`);
  checkResult(t, r, undefined, gas, label);
}

module.exports = { name, run, replay, structuredCode, primedCode, loopCode };
