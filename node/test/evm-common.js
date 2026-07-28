'use strict';
/* Shared fixtures for the account-model suites. Not a suite itself.
 *
 * The contracts here are hand-assembled EVM, not compiled Solidity, and that is
 * deliberate rather than austere: this repository has zero npm dependencies, so
 * there is no solc to invoke, and a test whose bytecode came from a compiler
 * nobody can rerun is a test nobody can change. Every one of them is short enough
 * to check by eye against src/evm/opcodes.js.
 */

const P = require('../src/params');
const POW = require('../src/pow');
const TX = require('../src/chain/transaction');
const { Miner } = require('../src/chain/miner');
const { keyFrom } = require('../src/evmnode');
const { keccak256 } = require('../src/crypto/keccak');

// ---- a miniature harness ---------------------------------------------------

function harness(title) {
  const state = { pass: 0, fail: 0 };
  console.log(`\n${title}\n`);
  const show = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  return {
    state,
    group(name) { console.log('• ' + name); },
    ok(cond, msg) {
      if (cond) { state.pass++; return true; }
      state.fail++; console.log('  ✗ ' + msg);
      return false;
    },
    eq(actual, expected, msg) {
      const a = show(actual), b = show(expected);
      if (a === b) { state.pass++; return true; }
      state.fail++; console.log(`  ✗ ${msg}\n      want ${b}\n      got  ${a}`);
      return false;
    },
    done() {
      const total = state.pass + state.fail;
      console.log(`\n${state.fail === 0 ? 'PASS' : 'FAIL'} — ${state.pass}/${total} checks\n`);
      process.exit(state.fail === 0 ? 0 : 1);
    },
  };
}

/* The easiest target the retarget rule allows (params.js MAX_TARGET), used as the
 * genesis target for every suite here.
 *
 * This is a TEST-ONLY speed knob and it changes nothing about what is verified: a
 * proof at this target goes through exactly the same Homefire evaluation, the same
 * `meetsTarget` comparison and the same signature check as one at the shipped
 * GENESIS_TARGET — there are simply fewer attempts before one lands (~64 rather
 * than ~256). It is MAX_TARGET rather than something easier still because
 * `_nextTarget` clamps there, and a genesis target above the clamp would make the
 * very first retarget disagree with the header for reasons that have nothing to do
 * with the test. */
const EASY_TARGET = P.MAX_TARGET;

// ---- keys ------------------------------------------------------------------

/** Deterministic test keys. Public seeds; worthless by construction. */
function testKey(tag) { return keyFrom(keccak256(Buffer.from('hearth-test:' + tag, 'utf8'))); }

// ---- mining ----------------------------------------------------------------

/**
 * Grind a block synchronously. The dev target (~8 leading zero bits) makes this a
 * few hundred Homefire evaluations, which is milliseconds — the whole reason
 * GENESIS_TARGET is what it is.
 */
function mine(node, key = node.coinbaseKey, { transactions = null, timestamp } = {}) {
  const cand = transactions
    ? node.chain.buildCandidate({
      coinbasePub: key.publicKey.toString('hex'),
      transactions,
      timestamp,
    })
    : node.miner.candidateFor(key.publicKey.toString('hex'));
  for (let nonce = 0; ; nonce++) {
    const digest = POW.homefireHash(POW.powSeed(cand.coreHash, nonce, cand.header.coinbasePub)).toString('hex');
    if (POW.meetsTarget(digest, cand.header.target)) {
      return { block: Miner.seal(cand, nonce, digest, key.privateKey), candidate: cand };
    }
  }
}

/** Mine on top of a specific parent — the fork-building primitive. */
function mineOn(chain, parentId, key, { transactions = [], timestamp } = {}) {
  const cand = chain.buildCandidate({
    parentId,
    coinbasePub: key.publicKey.toString('hex'),
    transactions,
    timestamp: timestamp === undefined
      ? Math.max(Math.floor(Date.now() / 1000), chain.entry(parentId).block.header.timestamp + P.TARGET_BLOCK_TIME)
      : timestamp,
  });
  for (let nonce = 0; ; nonce++) {
    const digest = POW.homefireHash(POW.powSeed(cand.coreHash, nonce, cand.header.coinbasePub)).toString('hex');
    if (POW.meetsTarget(digest, cand.header.target)) return Miner.seal(cand, nonce, digest, key.privateKey);
  }
}

// ---- transactions ----------------------------------------------------------

const GWEI = 1_000_000_000n;

function signed(key, fields) {
  return TX.encode(TX.sign({
    nonce: 0n, gasPrice: GWEI, gasLimit: 100_000n, to: null, value: 0n, data: Buffer.alloc(0),
    ...fields,
  }, key.privateKey));
}

// ---- hand-assembled contracts ----------------------------------------------

const hex = (...parts) => Buffer.from(parts.map(p => (Buffer.isBuffer(p) ? p.toString('hex') : p)).join(''), 'hex');

/** Wrap runtime code in the standard "copy myself out and return it" initcode. */
function deployer(runtime) {
  const len = runtime.length.toString(16).padStart(2, '0');
  // PUSH1 len, DUP1, PUSH1 0x0b, PUSH1 0x00, CODECOPY, PUSH1 0x00, RETURN
  const init = hex('60', len, '80', '600b', '6000', '39', '6000', 'f3');
  if (init.length !== 11) throw new Error('deployer: the runtime offset is no longer 0x0b');
  return Buffer.concat([init, runtime]);
}

/** keccak256('Stored(uint256)') — the topic the storage contract logs under. */
const STORED_TOPIC = keccak256(Buffer.from('Stored(uint256)', 'utf8'));

/**
 * STORAGE + LOG. Takes one 32-byte word of calldata, writes it to slot 0, emits
 * LOG1(topic = Stored(uint256), data = the word), and returns the word.
 *
 *   PUSH1 00 CALLDATALOAD   v
 *   DUP1 PUSH1 00 SSTORE    slot0 = v
 *   PUSH1 00 MSTORE         mem[0:32] = v
 *   PUSH32 <topic> PUSH1 20 PUSH1 00 LOG1
 *   PUSH1 20 PUSH1 00 RETURN
 */
const STORAGE_RUNTIME = hex(
  '6000', '35',           // PUSH1 00 CALLDATALOAD
  '80', '6000', '55',     // DUP1 PUSH1 00 SSTORE
  '6000', '52',           // PUSH1 00 MSTORE
  '7f', STORED_TOPIC,     // PUSH32 topic
  '6020', '6000', 'a1',   // PUSH1 20 PUSH1 00 LOG1
  '6020', '6000', 'f3',   // PUSH1 20 PUSH1 00 RETURN
);
const STORAGE_INITCODE = deployer(STORAGE_RUNTIME);

/** The ABI encoding of `revert("nope")` — selector, offset, length, padded bytes. */
const REVERT_PAYLOAD = Buffer.concat([
  Buffer.from('08c379a0', 'hex'),
  Buffer.alloc(31), Buffer.from([0x20]),
  Buffer.alloc(31), Buffer.from([0x04]),
  Buffer.concat([Buffer.from('nope', 'utf8'), Buffer.alloc(28)]),
]);

/**
 * ALWAYS REVERTS, with a Solidity `Error(string)` payload, so the RPC layer's
 * revert decoding is exercised against the real thing.
 *
 *   PUSH1 64 PUSH1 0c PUSH1 00 CODECOPY   mem[0:100] = code[12:112]
 *   PUSH1 64 PUSH1 00 REVERT
 *
 * 0x0c is the length of the prelude above it — twelve bytes, counted by hand and
 * asserted below, because an off-by-one here reverts with a payload that shifts by
 * one byte and decodes as an unknown custom error rather than as a message.
 */
const REVERT_PRELUDE = hex('6064', '600c', '6000', '39', '6064', '6000', 'fd');
if (REVERT_PRELUDE.length !== 0x0c) throw new Error('evm-common: the revert payload offset moved');
const REVERT_RUNTIME = Buffer.concat([REVERT_PRELUDE, REVERT_PAYLOAD]);
const REVERT_INITCODE = deployer(REVERT_RUNTIME);

/** Burns every unit of gas it is given: `JUMPDEST PUSH1 00 JUMP`. */
const INFINITE_LOOP_INITCODE = deployer(hex('5b', '6000', '56'));

/**
 * Returns PREVRANDAO (0x44). Spec §5 decides that opcode reads the PARENT block's
 * Homefire digest, and nothing else on this chain can observe that decision — so
 * without this contract the choice is untested and a node could return the
 * difficulty, the state root or zero and every other test would still pass.
 *
 *   PREVRANDAO PUSH1 00 MSTORE PUSH1 20 PUSH1 00 RETURN
 */
const PREVRANDAO_RUNTIME = hex('44', '6000', '52', '6020', '6000', 'f3');
const PREVRANDAO_INITCODE = deployer(PREVRANDAO_RUNTIME);

module.exports = {
  harness, testKey, mine, mineOn, signed, GWEI, EASY_TARGET,
  deployer, STORAGE_RUNTIME, STORAGE_INITCODE, STORED_TOPIC,
  REVERT_RUNTIME, REVERT_INITCODE, REVERT_PAYLOAD, INFINITE_LOOP_INITCODE,
  PREVRANDAO_RUNTIME, PREVRANDAO_INITCODE,
  hex,
};
