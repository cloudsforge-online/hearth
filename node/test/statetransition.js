'use strict';
/* Tests for the state transition — and the GeneralStateTests conformance adapter.
 *
 * Two things live here, deliberately in one file, in the same shape as
 * test/interpreter.js:
 *
 *   1. A standalone unit suite — `node test/statetransition.js`.
 *   2. The conformance IMPLEMENTATION ADAPTER, exported for the harness:
 *
 *        node test/conformance/runner.js --impl=test/statetransition.js \
 *             --suite=GeneralStateTests --dir=test/conformance/vectors
 *
 * WHAT THE UNIT SUITE IS FOR, given that 20,000 reference vectors also run against
 * this code. The vectors assert one thing per case — a state root — so they say
 * "wrong" without saying where, and a bug that moves value between two accounts the
 * fixture happens not to distinguish can hide in them. The unit suite asserts the
 * five rules the vectors are least able to localise:
 *
 *   - a FAILED transaction rolls back its state but keeps its nonce increment,
 *   - …and still pays the coinbase in full,
 *   - an INVALID transaction changes nothing at all, including the nonce,
 *   - the EIP-3529 refund is capped at gasUsed/5 and the cap actually binds,
 *   - the EIP-2929 warm set is Ethereum's, so the coinbase and 0x01–0x09 are warm.
 *
 * Each of those is a mutation that survives a green unit run without them.
 *
 * THE FIXTURE FEE MODEL. Every Shanghai GeneralStateTest is filled with
 * `currentBaseFee: 0x0a`, so the expected roots have EIP-1559's split baked in: the
 * coinbase receives `gasUsed * (gasPrice - baseFee)` and `gasUsed * baseFee` is
 * burned. Hearth v1 has no fee market and runs with `baseFee = 0`, where the split
 * collapses to "the coinbase gets everything" — the same code, one parameter apart.
 * The adapter passes the fixture's base fee through; the chain passes zero.
 */

const { StateDB, MemoryDB } = require('../src/state/statedb');
const { keccak256 } = require('../src/crypto/keccak');
const secp = require('../src/crypto/secp256k1');
const U = require('../src/evm/uint256');
const gas = require('../src/evm/gas');
const TX = require('../src/chain/transaction');
const receipt = require('../src/chain/receipt');
const bloom = require('../src/chain/bloom');
const ST = require('../src/chain/statetransition');

const hex = (s) => Buffer.from(String(s).replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');

// ===========================================================================
// the conformance adapter
// ===========================================================================

/**
 * A StateDB seeded from a fixture pre-state, plus the `root()`/`dump()` the harness
 * wants. The state trie is the SECURE variant — its keys are keccak hashes — so it
 * cannot be walked back into addresses, and `dump()` therefore reports the union of
 * every address and slot the fixture mentions plus everything the run itself touched
 * (which the tracer hands over for free). Without a dump, a root mismatch reports no
 * account diff at all and debugging a 20,000-vector corpus becomes guesswork.
 */
function makeState(pre) {
  const db = new StateDB(new MemoryDB());
  const addresses = new Set();
  const slots = new Map();          // addrHex -> Set(slot hex)

  const note = (a, slot) => {
    const k = hx(a);
    addresses.add(k);
    if (slot === undefined) return;
    if (!slots.has(k)) slots.set(k, new Set());
    slots.get(k).add(Buffer.from(slot).toString('hex'));
  };

  for (const [a, acc] of Object.entries(pre || {})) {
    const A = hex(a);
    db.setAccount(A, { nonce: acc.nonce, balance: acc.balance });
    if (acc.code.length) db.setCode(A, acc.code);
    note(A);
    for (const [k, v] of Object.entries(acc.storage)) {
      db.setStorage(A, hex(k), hex(v));
      note(A, hex(k));
    }
  }
  db.commit();

  return {
    db,
    note,
    root: () => '0x' + db.rootHex(),
    dump() {
      const out = {};
      for (const a of addresses) {
        const A = hex(a);
        if (!db.exists(A)) continue;
        const storage = {};
        for (const s of slots.get(a) || []) {
          const v = db.getStorage(A, Buffer.from(s, 'hex'));
          if (!v.equals(Buffer.alloc(32))) storage['0x' + s] = '0x' + v.toString('hex');
        }
        out[a] = { nonce: db.getNonce(A), balance: db.getBalance(A), code: db.getCode(A), storage };
      }
      return out;
    },
  };
}

/* testeth's fixtures were filled with a fake environment whose BLOCKHASH is the
 * keccak of the block number rendered in DECIMAL. A harness convention, not a chain
 * rule, which is exactly why it lives here and not in the state transition. */
const fixtureBlockHash = (n) => keccak256(Buffer.from(n.toString(10), 'utf8'));

/** The sender, when a fixture gives only a secret key. */
function addressFromSecretKey(priv) {
  return TX.addressFromPublicKey(secp.publicKeyFromPrivate(priv, false));
}

/**
 * The fixture's fee fields, reduced to the two numbers the transition actually uses:
 * what the sender is charged per gas, and what the balance had to cover per gas.
 *
 * A legacy transaction has one number for both. A type-2 transaction has
 * `effective = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)` and a cap of
 * `maxFeePerGas` — Hearth v1 has no fee market and never produces one of these, but
 * the corpus is full of them and running them proves the split is right for v2.
 */
function feesFor(tx, baseFee) {
  if (tx.maxFeePerGas === null || tx.maxFeePerGas === undefined) {
    return { gasPrice: tx.gasPrice === null ? 0n : tx.gasPrice, feeCap: tx.gasPrice === null ? 0n : tx.gasPrice, ok: true };
  }
  const cap = tx.maxFeePerGas;
  const tip = tx.maxPriorityFeePerGas === null ? 0n : tx.maxPriorityFeePerGas;
  // A tip above the cap is not a transaction anybody can include.
  if (tip > cap) return { ok: false, code: 'TIP_ABOVE_FEE_CAP' };
  const effective = cap < baseFee + tip ? cap : baseFee + tip;
  return { gasPrice: effective, feeCap: cap, ok: true };
}

/* A rejected transaction still has an expected logs hash — the empty one — and the
 * harness will not compute it for us. Returning it turns ~1,000 "unchecked" log
 * assertions into checked ones, which matters because "we produced no logs" and "we
 * never ran" look identical without it. */
const NO_LOGS = () => hx(receipt.logsHash([]));

function runTransaction({ state, env, tx, vector }) {
  const db = state.db;
  const baseFee = env.baseFee === null ? 0n : env.baseFee;

  /* EIP-4844 blob transactions. The loader normalises a transaction into fields and
   * drops `blobVersionedHashes`, so the only place the type survives is the signed
   * envelope the fixture publishes. Hearth's decoder rejects every EIP-2718 type it
   * does not implement (`TYPE_NOT_SUPPORTED`), and a blob transaction is not one this
   * chain can ever carry — there is no blob market and no blob gas to charge. Types 1
   * and 2 are deliberately NOT rejected here: the transition handles an access list
   * and a fee cap, and running those vectors is how that gets proven. */
  if (vector && vector.txbytes && vector.txbytes.startsWith('0x03')) {
    return { exception: 'TYPE_NOT_SUPPORTED: blob transactions do not exist on this chain', logsHash: NO_LOGS() };
  }

  let sender;
  try {
    sender = tx.sender ? hex(tx.sender) : addressFromSecretKey(tx.secretKey);
  } catch {
    return { exception: 'NO_SENDER', logsHash: NO_LOGS() };
  }
  const coinbase = hex(env.coinbase);
  state.note(sender);
  state.note(coinbase);
  if (tx.to) state.note(hex(tx.to));
  else state.note(TX.contractAddress(sender, tx.nonce));
  // Slots the fixture never mentions but the run writes: the tracer names them, so
  // dump() can report them instead of silently omitting the interesting divergence.
  const seen = (ev) => { if (ev.slot) state.note(ev.address, ev.slot); };

  const fee = feesFor(tx, baseFee);
  if (!fee.ok) return { exception: fee.code, logsHash: NO_LOGS() };

  const res = ST.applyTransaction({
    state: db,
    tx: {
      nonce: tx.nonce,
      gasPrice: fee.gasPrice,
      feeCap: fee.feeCap,
      gasLimit: tx.gasLimit,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      accessList: tx.accessList || [],
    },
    sender,
    block: {
      number: env.number,
      timestamp: env.timestamp,
      coinbase,
      gasLimit: env.gasLimit,
      prevRandao: env.random !== null ? env.random : env.difficulty,
      baseFee,
      // The fixtures are filled for chain id 1; CHAINID must report what they used.
      chainId: 1n,
    },
    blockGasUsed: 0n,
    blockHash: fixtureBlockHash,
    onStep: seen,
  });

  if (!res.ok) return { exception: res.code + ': ' + res.error, logsHash: NO_LOGS() };
  /* An internal bug must surface as a harness ERROR, never as a satisfied
   * "this transaction must be rejected" vector. */
  if (res.internalError) throw res.internalError;

  return {
    gasUsed: res.gasUsed,
    logsHash: hx(receipt.logsHash(res.logs)),
    vector,
  };
}

module.exports = { state: { makeState, runTransaction }, makeState, runTransaction };

// ===========================================================================
// unit suite
// ===========================================================================

if (!require.main || require.main !== module) return;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name) { console.log('• ' + name); }

const PRIV = hex('4646464646464646464646464646464646464646464646464646464646464646');
const SENDER = TX.addressFromPublicKey(secp.publicKeyFromPrivate(PRIV, false));
const COINBASE = hex('c0'.repeat(20));
const BOB = hex('bb'.repeat(20));
const ETHER = 10n ** 18n;

/** A StateDB with the given accounts installed, committed and ready. */
function world(accounts = {}) {
  const db = new StateDB(new MemoryDB());
  for (const [a, acc] of Object.entries(accounts)) {
    const A = Buffer.isBuffer(a) ? a : hex(a);
    db.setAccount(A, { nonce: BigInt(acc.nonce || 0), balance: BigInt(acc.balance || 0) });
    if (acc.code) db.setCode(A, hex(acc.code));
    for (const [k, v] of Object.entries(acc.storage || {})) db.setStorage(A, U.toBuffer(BigInt(k)), U.toBuffer(BigInt(v)));
  }
  db.commit();
  return db;
}

const BLOCK = {
  number: 5n, timestamp: 1000n, coinbase: COINBASE,
  gasLimit: 30000000n, prevRandao: 0n, baseFee: 0n, chainId: TX.CHAIN_ID,
};

function apply(db, tx, o = {}) {
  return ST.applyTransaction({
    state: db,
    tx: Object.assign({ nonce: 0n, gasPrice: 10n, gasLimit: 100000n, to: BOB, value: 0n, data: Buffer.alloc(0) }, tx),
    sender: o.sender || SENDER,
    block: Object.assign({}, BLOCK, o.block || {}),
    blockGasUsed: o.blockGasUsed || 0n,
    onStep: o.onStep || null,
  });
}

const sload = (db, A, slot) => U.fromBuffer(db.getStorage(A, U.toBuffer(BigInt(slot))));

// ---- the happy path --------------------------------------------------------
group('a plain transfer');
{
  const db = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const before = db.rootHex();
  const r = apply(db, { value: 1000n, gasPrice: 10n, gasLimit: 100000n });

  ok(r.ok === true && r.exception === null, 'a funded transfer is accepted and succeeds');
  ok(r.gasUsed === 21000n, 'a transfer with no data costs exactly the 21,000 intrinsic');
  ok(db.getBalance(BOB) === 1000n, 'the value arrives');
  ok(db.getNonce(SENDER) === 1n, "the sender's nonce is incremented");
  ok(db.getBalance(SENDER) === ETHER - 1000n - 21000n * 10n, 'the sender pays value + gasUsed * gasPrice, and nothing more');
  ok(db.getBalance(COINBASE) === 21000n * 10n, 'the coinbase receives gasUsed * gasPrice');
  ok(r.receipt.status === receipt.SUCCESS && r.receipt.cumulativeGasUsed === 21000n, 'the receipt reports success and the cumulative gas');
  ok(r.receipt.logs.length === 0 && r.receipt.logsBloom.equals(bloom.empty()), 'and an empty bloom for a transfer that logs nothing');
  ok(db.rootHex() !== before, 'the state root moved');
  ok(r.stateRoot.toString('hex') === db.rootHex(), 'and applyTransaction reports the root it produced');

  // Nothing is created out of nothing: total supply is conserved with baseFee 0.
  const total = db.getBalance(SENDER) + db.getBalance(BOB) + db.getBalance(COINBASE);
  ok(total === ETHER, 'with no base fee, every unit debited from the sender lands somewhere');
}

// ---- invalid: not in the block at all --------------------------------------
group('invalid transactions change nothing');
{
  const cases = [
    ['nonce too low', { nonce: 5n }, { pre: { nonce: 7n } }, ST.REJECT.NONCE_TOO_LOW],
    ['nonce too high', { nonce: 9n }, { pre: { nonce: 7n } }, ST.REJECT.NONCE_TOO_HIGH],
    ['insufficient funds for value + gas', { value: ETHER }, {}, ST.REJECT.INSUFFICIENT_FUNDS],
    ['gas limit below the intrinsic cost', { gasLimit: 20999n }, {}, ST.REJECT.INTRINSIC_GAS_TOO_LOW],
    ['gas limit above what is left in the block', { gasLimit: 40000000n }, {}, ST.REJECT.BLOCK_GAS_LIMIT_REACHED],
    ['a nonce of 2^64-1', { nonce: (1n << 64n) - 1n }, { pre: { nonce: (1n << 64n) - 1n } }, ST.REJECT.NONCE_MAX],
    ['a value that does not fit in 256 bits', { value: 1n << 256n }, {}, ST.REJECT.FIELD_OVERFLOW],
  ];
  for (const [what, tx, opts, code] of cases) {
    const db = world({ [SENDER.toString('hex')]: { balance: ETHER, nonce: (opts.pre || {}).nonce || 0n } });
    const before = db.rootHex();
    const nonce = db.getNonce(SENDER);
    const balance = db.getBalance(SENDER);
    const r = apply(db, Object.assign({ nonce: nonce }, tx));
    ok(r.ok === false && r.code === code, `${what} is rejected as ${code}`);
    ok(db.rootHex() === before, `…and the state root is untouched (${what})`);
    ok(db.getNonce(SENDER) === nonce && db.getBalance(SENDER) === balance, `…nonce and balance too (${what})`);
    ok(db.getBalance(COINBASE) === 0n, `…and the coinbase is not paid (${what})`);
  }

  // EIP-3607: an account with code cannot originate a transaction.
  {
    const db = world({ [SENDER.toString('hex')]: { balance: ETHER, code: '00' } });
    const r = apply(db, {});
    ok(r.ok === false && r.code === ST.REJECT.SENDER_NOT_EOA, 'a sender with deployed code is rejected (EIP-3607)');
  }

  // The balance check is against the WHOLE gas limit, not the gas actually used.
  {
    const db = world({ [SENDER.toString('hex')]: { balance: 21000n * 10n + 1n } });
    ok(apply(db, { gasLimit: 100000n, gasPrice: 10n }).ok === false,
      'a sender who can afford the gas it will use but not the limit it asked for is rejected');
    ok(apply(db, { gasLimit: 21000n, gasPrice: 10n }).ok === true,
      '…and is accepted once the limit is one it can cover');
  }
}

// ---- failed: in the block, paid for, rolled back ---------------------------
group('a failed transaction');
{
  //  PUSH1 1 PUSH1 0 SSTORE  then REVERT(0,0)
  const REVERTER = '600160005560006000fd';
  const db = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: REVERTER },
  });
  const r = apply(db, { value: 1000n, gasLimit: 100000n, gasPrice: 10n });

  ok(r.ok === true, 'a reverting transaction is still VALID — it is in the block');
  ok(r.exception !== null && r.receipt.status === receipt.FAILURE, 'its receipt reports failure');
  ok(sload(db, BOB, 0) === 0n, 'every state change it made is rolled back');
  ok(db.getBalance(BOB) === 0n, 'including the value transfer');
  ok(db.getNonce(SENDER) === 1n, 'but the nonce increment SURVIVES');
  ok(db.getBalance(COINBASE) === r.gasUsed * 10n, 'and the coinbase is paid in full');
  ok(db.getBalance(SENDER) === ETHER - r.gasUsed * 10n, 'the sender pays for the gas it burned and keeps its value');
  ok(r.gasUsed > 21000n && r.gasUsed < 100000n, 'a REVERT returns the gas it did not use');
  ok(r.logs.length === 0, 'a failed transaction emits no logs');

  // An exceptional halt is different from a REVERT: it consumes the entire limit.
  const db2 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: '60016000556001600055fe' },     // …then INVALID
  });
  const r2 = apply(db2, { gasLimit: 100000n, gasPrice: 10n });
  ok(r2.ok === true && r2.gasUsed === 100000n, 'an exceptional halt consumes every unit of the gas limit');
  ok(db2.getBalance(COINBASE) === 100000n * 10n, '…all of which the coinbase receives');
  ok(db2.getNonce(SENDER) === 1n, '…and the nonce increment still survives');
  ok(sload(db2, BOB, 0) === 0n, '…with the state rolled back');

  // Out of gas, mid-execution.
  const db3 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: '6001600055' },
  });
  const r3 = apply(db3, { gasLimit: 22000n, gasPrice: 10n });
  ok(r3.ok === true && r3.gasUsed === 22000n, 'running out of gas consumes the whole limit');
  ok(sload(db3, BOB, 0) === 0n, 'and writes nothing');
}

// ---- refunds ---------------------------------------------------------------
group('refunds (EIP-3529)');
{
  /* Clear four slots that were set at the start of the transaction. Each clear
   * refunds 4,800, so the counter reaches 19,200 — far more than a fifth of the
   * ~40,000 the transaction uses, so the cap is what decides the answer. */
  const CLEAR4 = '6000600055' + '6000600155' + '6000600255' + '6000600355';
  const db = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: CLEAR4, storage: { 0: 1, 1: 1, 2: 1, 3: 1 } },
  });
  const r = apply(db, { gasLimit: 200000n, gasPrice: 1n });
  const refundCounter = 4n * gas.SSTORE_CLEARS_REFUND;

  const beforeRefund = r.gasUsed + r.gasRefunded;
  ok(r.ok === true && r.exception === null, 'the clearing transaction succeeds');
  ok(sload(db, BOB, 3) === 0n, 'all four slots are cleared');
  ok(r.gasRefunded === beforeRefund / 5n, 'the refund granted is exactly gasUsed / 5 — the EIP-3529 cap binds');
  ok(r.gasRefunded < refundCounter, '…and it is strictly less than the counter, so an uncapped refund would differ');
  ok(r.gasUsed === beforeRefund - r.gasRefunded, 'gasUsed is net of the refund');
  ok(db.getBalance(COINBASE) === r.gasUsed, 'the coinbase is paid the NET gas, not the gross');

  // Below the cap, the counter itself is what is granted.
  const db2 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: '6000600055', storage: { 0: 1 } },
  });
  const r2 = apply(db2, { gasLimit: 200000n, gasPrice: 1n });
  ok(r2.gasRefunded === 4800n && 4800n < (r2.gasUsed + r2.gasRefunded) / 5n,
    'one cleared slot is under the cap, so the whole 4,800 is granted');

  // A failed transaction refunds nothing: the counter was journaled inside the
  // frame that reverted, so it went back with everything else.
  const db3 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: '600060005560006000fd', storage: { 0: 1 } },
  });
  const r3 = apply(db3, { gasLimit: 200000n, gasPrice: 1n });
  ok(r3.exception !== null && r3.gasRefunded === 0n, 'a reverted transaction is granted no refund');
}

// ---- the EIP-2929 warm set -------------------------------------------------
group('the pre-warmed access list');
{
  const costOf = (code, op, o = {}) => {
    const db = world(Object.assign({
      [SENDER.toString('hex')]: { balance: ETHER },
      [BOB.toString('hex')]: { code },
    }, o.accounts || {}));
    const seen = [];
    apply(db, { gasLimit: 200000n }, { onStep: (e) => { if (e.mnemonic === op) seen.push(e.gasCost); } });
    return seen;
  };

  // EIP-3651: Shanghai warms the coinbase, so a builder payment pays 100, not 2600.
  const cb = costOf('73' + COINBASE.toString('hex') + '3150', 'BALANCE');
  ok(cb.length === 1 && cb[0] === 100n, 'the coinbase is warm (EIP-3651): BALANCE costs 100, not 2600');

  // The nine precompiles are warm even though 0x06–0x09 are not implemented here:
  // the warm set is a gas rule, not a capability claim (spec §5).
  for (const n of [1, 5, 9]) {
    const a = Buffer.alloc(20); a[19] = n;
    const c = costOf('73' + a.toString('hex') + '3150', 'BALANCE');
    ok(c.length === 1 && c[0] === 100n, `precompile 0x0${n} is pre-warmed`);
  }
  {
    const a = Buffer.alloc(20); a[19] = 10;
    const c = costOf('73' + a.toString('hex') + '3150', 'BALANCE');
    ok(c.length === 1 && c[0] === 2600n, '0x0a is NOT pre-warmed — the set is exactly Ethereum\'s nine');
  }
  // Sender and recipient are warm; a third party is not.
  const self = costOf('73' + BOB.toString('hex') + '3150', 'BALANCE');
  ok(self.length === 1 && self[0] === 100n, 'the recipient is warm');
  const origin = costOf('73' + SENDER.toString('hex') + '3150', 'BALANCE');
  ok(origin.length === 1 && origin[0] === 100n, 'the sender is warm');
  const other = costOf('73' + 'ab'.repeat(20) + '3150', 'BALANCE');
  ok(other.length === 1 && other[0] === 2600n, 'anybody else is cold');

  // The warm set is rebuilt per transaction, not carried between them.
  {
    const db = world({ [SENDER.toString('hex')]: { balance: ETHER }, [BOB.toString('hex')]: { code: '73' + 'ab'.repeat(20) + '3150' } });
    const costs = [];
    const trace = (e) => { if (e.mnemonic === 'BALANCE') costs.push(e.gasCost); };
    apply(db, { nonce: 0n, gasLimit: 200000n }, { onStep: trace });
    apply(db, { nonce: 1n, gasLimit: 200000n }, { onStep: trace });
    ok(costs.length === 2 && costs[0] === 2600n && costs[1] === 2600n, 'the warm set does not survive into the next transaction');
  }
}

// ---- intrinsic gas ---------------------------------------------------------
group('intrinsic gas');
{
  const db = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const withData = apply(db, { nonce: 0n, data: hex('00ff00ff'), gasLimit: 100000n });
  ok(withData.gasUsed === 21000n + 2n * 4n + 2n * 16n, 'calldata costs 4 a zero byte and 16 a non-zero one');

  // A creation pays 32,000 more, plus EIP-3860's 2 per word of initcode.
  const db2 = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const initcode = hex('00'.repeat(64));            // two words, and a STOP: deploys nothing
  const c = ST.applyTransaction({
    state: db2, sender: SENDER, block: BLOCK,
    tx: { nonce: 0n, gasPrice: 1n, gasLimit: 100000n, to: null, value: 0n, data: initcode },
  });
  ok(c.gasUsed === 21000n + 32000n + 64n * 4n + 2n * 2n,
    'a creation costs 21,000 + 32,000 + calldata + 2 per initcode word (EIP-3860)');

  // Over the EIP-3860 cap the transaction is INVALID, not a failed creation.
  const db3 = world({ [SENDER.toString('hex')]: { balance: 10n * ETHER } });
  const over = ST.applyTransaction({
    state: db3, sender: SENDER, block: BLOCK,
    tx: { nonce: 0n, gasPrice: 1n, gasLimit: 10000000n, to: null, value: 0n, data: Buffer.alloc(49153) },
  });
  ok(over.ok === false && over.code === ST.REJECT.INITCODE_SIZE_EXCEEDED, 'initcode over 49,152 bytes makes the transaction invalid');
}

// ---- creation --------------------------------------------------------------
group('contract creation');
{
  // PUSH2 600a PUSH1 0 MSTORE PUSH1 2 PUSH1 30 RETURN — deploys the runtime `600a`.
  const INIT = '61600a6000526002601ef3';
  const db = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const r = ST.applyTransaction({
    state: db, sender: SENDER, block: BLOCK,
    tx: { nonce: 0n, gasPrice: 1n, gasLimit: 200000n, to: null, value: 77n, data: hex(INIT) },
  });
  const expected = TX.contractAddress(SENDER, 0n);
  ok(r.ok === true && r.exception === null, 'a creation transaction succeeds');
  ok(r.contractAddress && r.contractAddress.equals(expected), 'the contract lands at keccak256(rlp([sender, nonce]))[12:]');
  ok(db.getCode(expected).toString('hex') === '600a', 'the returned data becomes the deployed code');
  ok(db.getBalance(expected) === 77n, 'the endowment arrives');
  ok(db.getNonce(SENDER) === 1n, "the creator's nonce is incremented exactly once");
  ok(db.getNonce(expected) === 1n, 'and the new contract starts at nonce 1 (EIP-161)');

  // The address uses the PRE-increment nonce. Bumping before EVM.create would put
  // the second contract where the first one went, and vice versa.
  const r2 = ST.applyTransaction({
    state: db, sender: SENDER, block: BLOCK,
    tx: { nonce: 1n, gasPrice: 1n, gasLimit: 200000n, to: null, value: 0n, data: hex(INIT) },
  });
  ok(r2.contractAddress.equals(TX.contractAddress(SENDER, 1n)) && !r2.contractAddress.equals(expected),
    'the second creation from the same account lands somewhere else');

  // A failed creation keeps the nonce increment and deploys nothing.
  const db2 = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const bad = ST.applyTransaction({
    state: db2, sender: SENDER, block: BLOCK,
    tx: { nonce: 0n, gasPrice: 1n, gasLimit: 200000n, to: null, value: 500n, data: hex('60006000fd') },
  });
  ok(bad.ok === true && bad.exception !== null, 'a reverting initcode is a failed transaction, not an invalid one');
  ok(db2.getNonce(SENDER) === 1n, "…the creator's nonce increment survives");
  ok(!db2.exists(TX.contractAddress(SENDER, 0n)), '…nothing is deployed and the endowment is returned');
}

// ---- EIP-161 and self-destruct --------------------------------------------
group('finalisation');
{
  // A zero-value call to an account that does not exist must not bring it into being.
  const db = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  apply(db, { to: hex('de'.repeat(20)), value: 0n });
  ok(!db.exists(hex('de'.repeat(20))), 'a zero-value call does not create the recipient (EIP-161)');

  // …but a zero fee to an empty coinbase touches it, and the touch deletes it again.
  const db2 = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  apply(db2, { gasPrice: 0n, value: 0n });
  ok(!db2.exists(COINBASE), 'a coinbase paid nothing is touched and then swept away as empty');

  // A non-empty coinbase stays, obviously.
  const db3 = world({ [SENDER.toString('hex')]: { balance: ETHER }, [COINBASE.toString('hex')]: { nonce: 1n } });
  apply(db3, { gasPrice: 0n });
  ok(db3.exists(COINBASE), 'a coinbase with a nonce is not empty and survives a zero fee');

  // SELFDESTRUCT removes the account at the end of the transaction, not before.
  const db4 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: '73' + 'ab'.repeat(20) + 'ff', balance: 999n },
  });
  const r = apply(db4, { gasLimit: 200000n });
  ok(r.exception === null && !db4.exists(BOB), 'a self-destructed account is gone once the transaction finalises');
  ok(db4.getBalance(hex('ab'.repeat(20))) === 999n, 'and its balance reached the beneficiary');

  // A self-destruct inside a reverted transaction does not happen.
  const db5 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: '6000600060006000600073' + 'cc'.repeat(20) + '61fffff1' + '60006000fd', balance: 999n },
  });
  apply(db5, { gasLimit: 200000n });
  ok(db5.exists(BOB) && db5.getBalance(BOB) === 999n, 'a reverted transaction destroys nothing');
}

// ---- logs, bloom, receipts -------------------------------------------------
group('logs and receipts');
{
  // LOG1(offset 0, size 32, topic 0x7b) over memory holding 0xaa.
  const LOGGER = '60aa600052' + '607b' + '6020' + '6000' + 'a1';
  const db = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: LOGGER },
  });
  const r = apply(db, { gasLimit: 200000n });
  ok(r.logs.length === 1 && r.logs[0].address.equals(BOB), 'the log is attributed to the executing contract');
  ok(r.receipt.logs.length === 1, 'and appears in the receipt');
  ok(bloom.contains(r.receipt.logsBloom, BOB), "the receipt's bloom carries the log address");
  ok(bloom.contains(r.receipt.logsBloom, r.logs[0].topics[0]), '…and its topic');
  ok(receipt.logsHash(r.logs).length === 32, 'the logs hash is keccak256(rlp(logs))');

  // A reverting frame drops its logs, and so does the receipt.
  const db2 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: LOGGER + '60006000fd' },
  });
  const r2 = apply(db2, { gasLimit: 200000n });
  ok(r2.receipt.status === receipt.FAILURE && r2.receipt.logs.length === 0, 'a failed transaction has an empty receipt log list');
  ok(r2.receipt.logsBloom.equals(bloom.empty()), '…and an empty bloom');

  /* The case the top-level check cannot see: an inner call that logs and then
   * REVERTS, inside a transaction that SUCCEEDS. Its logs must not reach the
   * receipt. A leak here is invisible in the state root — logs are not in the trie
   * — and shows up only as a block bloom no other client agrees with, which quietly
   * breaks every eth_getLogs consumer on the chain. */
  const CARL = hex('ca'.repeat(20));
  const OUTER = '6000600060006000600073' + CARL.toString('hex') + '61ffff' + 'f1' + '50'
    + '60bb600052' + '6099' + '6020' + '6000' + 'a1';
  const db3 = world({
    [SENDER.toString('hex')]: { balance: ETHER },
    [BOB.toString('hex')]: { code: OUTER },
    [CARL.toString('hex')]: { code: LOGGER + '60006000fd' },
  });
  const r3 = apply(db3, { gasLimit: 300000n });
  ok(r3.receipt.status === receipt.SUCCESS, 'a transaction whose inner call reverts still succeeds');
  ok(r3.logs.length === 1 && r3.logs[0].address.equals(BOB), "only the surviving frame's log is kept");
  ok(!bloom.contains(r3.receipt.logsBloom, CARL), "the reverted inner frame's log never reaches the bloom");
  ok(U.fromBuffer(r3.logs[0].topics[0]) === 0x99n, '…and the topic that survives is the outer one');
}

// ---- the base fee ----------------------------------------------------------
group('the base fee (v2)');
{
  // v1 runs with baseFee 0. The split is exercised anyway, because the reference
  // vectors are all filled with a base fee and because getting it wrong is silent.
  const db = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const r = apply(db, { gasPrice: 10n, value: 0n }, { block: { baseFee: 4n } });
  ok(r.gasUsed === 21000n, 'the base fee does not change what the transaction costs it');
  ok(db.getBalance(COINBASE) === 21000n * 6n, 'the coinbase receives the TIP: gasUsed * (gasPrice - baseFee)');
  ok(db.getBalance(SENDER) === ETHER - 21000n * 10n, 'the sender still pays the full gas price');
  const supply = db.getBalance(SENDER) + db.getBalance(COINBASE);
  ok(supply === ETHER - 21000n * 4n, 'and gasUsed * baseFee is burned — which is why v1 sets it to zero');

  // A gas price below the base fee cannot be included.
  const db2 = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  ok(apply(db2, { gasPrice: 3n }, { block: { baseFee: 4n } }).code === ST.REJECT.FEE_BELOW_BASE,
    'a gas price under the base fee is rejected');
}

// ---- a block's worth -------------------------------------------------------
group('applyBlock');
{
  const db = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const raw = [0, 1, 2].map(n => TX.encode(TX.sign({ nonce: BigInt(n), gasPrice: 10n, gasLimit: 30000n, to: BOB, value: 100n, data: '0x' }, PRIV)));
  const b = ST.applyBlock({ state: db, transactions: raw, block: BLOCK });

  ok(b.ok === true && b.receipts.length === 3, 'three signed transactions are applied in order');
  ok(b.gasUsed === 63000n, "the block's gas is the sum of its transactions'");
  ok(b.receipts.map(r => r.cumulativeGasUsed).join(',') === '21000,42000,63000', 'cumulativeGasUsed is the running BLOCK total, not the per-transaction figure');
  ok(b.receipts[2].cumulativeGasUsed === b.gasUsed, "…and the last receipt's figure is the header's gasUsed");
  ok(db.getNonce(SENDER) === 3n && db.getBalance(BOB) === 300n, 'each transaction saw the state the one before left');
  ok(b.receiptsRoot.length === 32 && b.receiptsRoot.equals(receipt.receiptsRoot(b.receipts)), 'the receipts root is the trie over the encoded receipts');
  ok(b.logsBloom.equals(bloom.empty()), 'a block with no logs has an empty bloom');

  // A signature that recovers to somebody else is not this sender's transaction.
  const wrongNonce = TX.encode(TX.sign({ nonce: 9n, gasPrice: 10n, gasLimit: 30000n, to: BOB, value: 1n, data: '0x' }, PRIV));
  const db2 = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const bad = ST.applyBlock({ state: db2, transactions: [wrongNonce], block: BLOCK });
  ok(bad.ok === false && bad.code === ST.REJECT.NONCE_TOO_HIGH, 'one invalid transaction makes the whole block invalid');
  const built = ST.applyBlock({ state: db2, transactions: [wrongNonce], block: BLOCK, skipInvalid: true });
  ok(built.ok === true && built.receipts.length === 0 && built.rejected.length === 1,
    '…but a miner BUILDING a block drops it and carries on');

  // The block gas limit is enforced across transactions, not just within one.
  const db3 = world({ [SENDER.toString('hex')]: { balance: ETHER } });
  const two = [0, 1].map(n => TX.encode(TX.sign({ nonce: BigInt(n), gasPrice: 1n, gasLimit: 21000n, to: BOB, value: 0n, data: '0x' }, PRIV)));
  const tight = ST.applyBlock({ state: db3, transactions: two, block: Object.assign({}, BLOCK, { gasLimit: 30000n }) });
  ok(tight.ok === false && tight.index === 1 && tight.code === ST.REJECT.BLOCK_GAS_LIMIT_REACHED,
    'the second transaction does not fit in what is left of the block');

  // Logs from several transactions aggregate into one block bloom.
  const LOGGER = '60aa600052' + '607b' + '6020' + '6000' + 'a1';
  const db4 = world({ [SENDER.toString('hex')]: { balance: ETHER }, [BOB.toString('hex')]: { code: LOGGER } });
  const logging = [0, 1].map(n => TX.encode(TX.sign({ nonce: BigInt(n), gasPrice: 1n, gasLimit: 100000n, to: BOB, value: 0n, data: '0x' }, PRIV)));
  const lb = ST.applyBlock({ state: db4, transactions: logging, block: BLOCK });
  ok(lb.logs.length === 2 && bloom.contains(lb.logsBloom, BOB), "the block's bloom is the OR of its receipts'");
  ok(lb.logsBloom.equals(bloom.fromLogs(lb.logs)), '…which is also the OR of every log in the block');
}

// ---- the error contract ----------------------------------------------------
group('the error contract');
{
  /* None of these may throw, and none may report an internal error: a JavaScript
   * fault escaping here would be indistinguishable, to the conformance harness,
   * from a correctly-rejected transaction. */
  const nasty = [
    ['a call to an address with no code', { to: hex('de'.repeat(20)), value: 1n }],
    ['a creation with empty initcode', { to: null, data: Buffer.alloc(0) }],
    ['a transaction to the zero address', { to: Buffer.alloc(20), value: 1n }],
    ['a zero gas price', { gasPrice: 0n }],
    ['calldata full of high bytes', { data: Buffer.alloc(100, 0xff) }],
    ['a self-call', { to: SENDER, value: 1n }],
  ];
  for (const [what, tx] of nasty) {
    const db = world({ [SENDER.toString('hex')]: { balance: ETHER } });
    let threw = null, r = null;
    try { r = apply(db, tx); } catch (e) { threw = e; }
    ok(threw === null, what + ' does not throw');
    ok(r && (r.ok === false || !r.internalError), '…and reports no internal error (' + what + ')');
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} state transition checks`);
process.exit(fail === 0 ? 0 : 1);
