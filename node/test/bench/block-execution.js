'use strict';
/* A full block's gas, executed — and the two numbers that decide whether the
 * chain survives someone sending it.
 *
 * A miner may put one transaction in a block that consumes the whole
 * 30,000,000-gas limit. Every other node must then EXECUTE that transaction to
 * decide whether the block is valid, inside a 15-second block interval, while
 * also relaying, mining and serving. If validation costs longer than the
 * interval, blocks arrive faster than they can be checked, peers fall behind,
 * and the difficulty retarget reacts to a chain nobody can keep up with. The
 * attacker pays the gas once; every node pays the CPU forever.
 *
 * docs/robustness-review.md §1 measured that transaction at 65 s and 443 MB
 * against a 15 s target, and the cause was `StateDB` materialising both trie
 * roots on every single mutation: an SSTORE re-hashed and re-stored the whole
 * path from the account's leaf to the state root, into an append-only node
 * store that never prunes. `statedb.js` now defers that to `root()` (see
 * `_flush`), and this file is the guard that keeps it deferred — the review's
 * own measurement, turned into something that fails.
 *
 * WHY IT IS A BENCHMARK AND NOT A UNIT TEST. There is no assertion about
 * behaviour that catches this: the state roots were always correct, every
 * conformance vector passed, and the suite was green throughout. The only
 * observable is cost. So the observable is what is asserted, against budgets
 * expressed as fractions of consensus parameters rather than as absolute
 * milliseconds — a slower CI runner shifts every number here together, and a
 * regression shifts them apart.
 *
 * Run:
 *   node test/bench/block-execution.js              the gate (part of `npm test`)
 *   node test/bench/block-execution.js --accounts=20000   the review's wide-trie case
 *   node test/bench/block-execution.js --verbose    per-phase detail
 */

const crypto = require('crypto');
const { StateDB, MemoryDB } = require('../../src/state/statedb');
const ST = require('../../src/chain/statetransition');
const P = require('../../src/params');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log('  ✓ ' + label)) : (fail++, console.log('  ✗ ' + label)); };
const section = s => console.log('\n• ' + s);
const note = s => console.log('    ' + s);

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : Number(hit.slice(name.length + 3));
};
const VERBOSE = argv.includes('--verbose');
const ACCOUNTS = arg('accounts', 2000);
const BLOCK_GAS = BigInt(P.EVM_BLOCK_GAS_LIMIT);

/* The attacker's contract, and it is deliberately the cheapest possible way to
 * spend a block's gas on state:
 *
 *   PUSH1 0                     the counter
 *   JUMPDEST DUP1 PUSH1 0 SSTORE PUSH1 1 ADD PUSH1 2 JUMP
 *
 * A new value into the SAME slot, forever. The first store is 22,100 gas (cold,
 * zero -> non-zero); every one after it is 100 — EIP-2200's "dirty slot" row —
 * plus 24 for the DUPs, the arithmetic and the jump. So ~124 gas buys one full
 * state mutation, and 30,000,000 gas buys roughly 240,000 of them.
 *
 * WRITING TO DISTINCT SLOTS IS NOT THE WORSE CASE, which is worth stating
 * because it is the first thing one reaches for: a fresh slot costs 22,100 gas,
 * so a block's gas buys only ~1,350 of those. EIP-2200's pricing already makes
 * new storage expensive; what it prices at 100 gas is re-writing storage the
 * transaction has already dirtied, and that is the mutation this chain used to
 * turn into a full state-trie re-root. Two hundred times more mutations for the
 * same gas is the whole attack.
 *
 * Ordinary traffic is nothing like either: a 30M-gas block of plain transfers
 * is ~1,400 mutations, and it was never slow — which is exactly why nothing
 * noticed.
 */
const LOOP_CODE = Buffer.from('60005b80600055600101600256', 'hex');

/** A state trie of `n` random accounts, so the paths this walks are realistic. */
function seedAccounts(state, n) {
  for (let i = 0; i < n; i++) {
    state.setAccount(crypto.randomBytes(20), { nonce: 1n, balance: 10n ** 18n });
  }
  state.root();               // flush, so the seeding is not counted as the run
}

function run({ accounts }) {
  const db = new MemoryDB();
  const state = new StateDB(db);
  seedAccounts(state, accounts);

  const sender = crypto.randomBytes(20);
  const victim = crypto.randomBytes(20);      // where the loop contract lives
  state.setAccount(sender, { nonce: 0n, balance: 10n ** 24n });
  state.setCode(victim, LOOP_CODE);
  state.root();

  const nodesBefore = db.size;
  let bytesBefore = 0;
  for (const v of db.map.values()) bytesBefore += v.length;

  const t0 = process.hrtime.bigint();
  const res = ST.applyTransaction({
    state,
    tx: { nonce: 0n, gasPrice: 1n, gasLimit: BLOCK_GAS, to: victim, value: 0n, data: Buffer.alloc(0) },
    sender,
    block: { number: 1n, timestamp: 1n, coinbase: crypto.randomBytes(20), gasLimit: BLOCK_GAS, baseFee: 0n },
  });
  state.finalize();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  let bytesAfter = 0;
  for (const v of db.map.values()) bytesAfter += v.length;

  return {
    ms,
    gasUsed: res.gasUsed,
    exception: res.exception,
    nodes: db.size - nodesBefore,
    bytes: bytesAfter - bytesBefore,
    accounts,
  };
}

/** A full block of ordinary traffic: plain value transfers, nothing crafted. */
function runTransfers(accounts) {
  const db = new MemoryDB();
  const state = new StateDB(db);
  seedAccounts(state, accounts);
  const sender = crypto.randomBytes(20);
  state.setAccount(sender, { nonce: 0n, balance: 10n ** 24n });
  state.root();
  const count = Number(BLOCK_GAS / 21000n);
  const block = { number: 1n, timestamp: 1n, coinbase: crypto.randomBytes(20), gasLimit: BLOCK_GAS, baseFee: 0n };
  let gasUsed = 0n;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    const res = ST.applyTransaction({
      state,
      tx: { nonce: BigInt(i), gasPrice: 1n, gasLimit: 21000n, to: crypto.randomBytes(20), value: 1n, data: Buffer.alloc(0) },
      sender, block, blockGasUsed: gasUsed,
    });
    gasUsed += res.gasUsed;
  }
  state.root();
  return { count, gasUsed, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

(async () => {
  console.log('A full block of SSTOREs — execution cost, which is the only observable\n');
  console.log(`  node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(`  block gas limit ${P.EVM_BLOCK_GAS_LIMIT.toLocaleString()} · `
    + `target block time ${P.TARGET_BLOCK_TIME} s · state trie ${ACCOUNTS.toLocaleString()} accounts`);

  /* The calibration workload, and the reason the wall-clock gate is expressed
   * against it rather than in milliseconds. A CI runner is two to three times
   * slower than a developer's machine and neither number is the one that
   * matters; what matters is the RATIO between a block of ordinary traffic and
   * a block crafted to be expensive, because that ratio is what an attacker
   * buys and it is the same on every machine. ~1,400 plain transfers is what a
   * full block of ordinary traffic looks like. */
  section('calibration: a full block of ordinary traffic');
  const baseline = runTransfers(ACCOUNTS);
  note(`${baseline.count} transfers, ${baseline.gasUsed.toLocaleString()} gas: ${baseline.ms.toFixed(0)} ms`);

  section('the attack: one transaction, the whole block gas limit, ~240,000 SSTOREs');
  const r = run({ accounts: ACCOUNTS });
  const retainedMiB = r.bytes / 1048576;
  const ratio = r.ms / baseline.ms;

  note(`wall clock        ${r.ms.toFixed(0)} ms  (${(r.ms / (P.TARGET_BLOCK_TIME * 1000) * 100).toFixed(0)}% of one block interval on this machine)`);
  note(`gas used          ${r.gasUsed.toLocaleString()} (${r.exception ? 'reverted: ' + r.exception : 'succeeded'})`);
  note(`trie nodes kept   ${r.nodes.toLocaleString()}`);
  note(`bytes kept        ${retainedMiB.toFixed(1)} MiB (${(r.bytes / Number(r.gasUsed)).toFixed(2)} bytes/gas)`);
  note(`throughput        ${(Number(r.gasUsed) / r.ms / 1000).toFixed(2)} Mgas/s`);
  note(`cost multiple     ${ratio.toFixed(1)}x an ordinary block of the same gas`);

  /* THE GATE. Before statedb.js deferred its state-trie writes this transaction
   * took 36-65 s on the machines that measured it — against a 15 s interval and
   * against an ordinary block of the same gas costing well under a second, i.e.
   * a multiple of roughly 100x. A multiple of 25 leaves generous room for a
   * slow runner and for the storage-trie writes that are still materialised per
   * mutation (see docs/robustness-review.md §1 and the note in statedb.js
   * `_flush`), while failing immediately if per-mutation state-trie re-rooting
   * ever comes back. */
  ok(ratio < 25,
    `a crafted block costs ${ratio.toFixed(1)}x an ordinary one, under the 25x budget`);

  /* AND THE RETENTION, which is the half that does not go away on its own and
   * the half that is machine-independent: bytes written to the node store are
   * deterministic. The store is append-only by design — a reorg has to be able
   * to re-open any historical root — so every node this transaction writes is
   * permanent, whether it succeeded or ran out of gas. The review measured
   * 245-443 MB for this one transaction. */
  ok(retainedMiB < 64,
    `retained ${retainedMiB.toFixed(1)} MiB of trie nodes, under the 64 MiB budget`);

  /* The gas has to have actually been spent, or the numbers above are measuring
   * a transaction that did nothing. This one runs out of gas by construction,
   * which is itself the point: a REVERTING transaction retains every node it
   * wrote, because db.put is outside the journal. */
  ok(r.gasUsed >= BLOCK_GAS - 100n,
    `the transaction really did consume the block limit (${r.gasUsed.toLocaleString()} gas)`);

  section('the cost must not scale with the width of the state trie');
  {
    /* The attacker does not pay for the size of everyone else's state, so if
     * cost rises with the account count then the chain gets more fragile as it
     * grows — the review measured exactly that, 71% more time and 80% more
     * retention for 20x the accounts, because every mutation walked a deeper
     * path. With writes deferred, the trie is walked once per touched account
     * per transaction, so the width stops mattering. */
    const wide = run({ accounts: ACCOUNTS * 5 });
    note(`${ACCOUNTS.toLocaleString()} accounts: ${r.ms.toFixed(0)} ms, ${retainedMiB.toFixed(1)} MiB`);
    note(`${(ACCOUNTS * 5).toLocaleString()} accounts: ${wide.ms.toFixed(0)} ms, ${(wide.bytes / 1048576).toFixed(1)} MiB`);
    /* 1.15x, not 2x: with writes deferred the width is genuinely irrelevant and
     * the measured ratio is 1.00. The write-through version measured 1.31x here
     * and 1.33x on retention, so a loose bound would have let it through. */
    ok(wide.ms < r.ms * 1.15,
      `5x the state trie costs ${(wide.ms / r.ms).toFixed(2)}x the time, not 5x — `
      + 'the per-mutation trie walk is gone');
    ok(wide.bytes < r.bytes * 1.15,
      `and ${(wide.bytes / r.bytes).toFixed(2)}x the retention`);
  }

  if (VERBOSE) {
    section('for reference: where the remaining cost is');
    note('the state trie is written once per touched account per transaction now,');
    note('but each SSTORE still materialises its STORAGE root — measured at about a');
    note('third of the run above. docs/robustness-review.md §1 and statedb.js `_flush`.');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} block-execution checks`);
  process.exit(fail ? 1 : 0);
})();
