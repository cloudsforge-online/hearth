'use strict';
/* Consensus on the account model: header v2, genesis, block production, block
 * validation, the mempool, and reorganisation. No sockets, no HTTP.
 * Run: node test/evmchain.js
 *
 * The bias of this suite is towards the checks a validator could DROP without
 * anything appearing to break. A chain that never verifies `receiptsRoot` produces
 * blocks that look perfect, syncs happily with itself, and serves an explorer logs
 * that were never emitted — so every field the header commits to is tampered with
 * individually and the block must be refused for that specific reason. Those are
 * the assertions that survived mutation testing; the happy path did not catch a
 * single one of the mutants.
 */

// Mine on the test network unless told otherwise. Homefire is memory-hard by
// design, so at production sizes one attempt fills a 64 KiB pad and this suite
// spent 63 seconds finding nonces — not one line of it consensus logic.
// `hearth-test` shrinks the pad and the walk, leaving difficulty, retargeting
// and every consensus rule untouched. It has its own chain id and genesis, so
// nothing signed here is valid anywhere real.
// MUST precede the params require: these are resolved at module load.
process.env.HEARTH_NETWORK = process.env.HEARTH_NETWORK || 'hearth-test';

const assert = require('assert');
const P = require('../src/params');
const HDR = require('../src/chain/header');
const TX = require('../src/chain/transaction');
const genesis = require('../src/chain/genesis');
const { Blockchain, GENESIS_NETWORK_MISMATCH } = require('../src/chain/blockchain');
const { Mempool } = require('../src/chain/mempool');
const { EvmNode } = require('../src/evmnode');
const { keccak256 } = require('../src/crypto/keccak');
const C = require('./evm-common');

const T = C.harness('Hearth account-model consensus');
const { ok, eq, group } = T;

const miner = C.testKey('miner');
const other = C.testKey('other');
const alice = C.testKey('alice');
const bob = C.testKey('bob');

const ALLOC = { [alice.addressHex]: { balance: (100n * 10n ** 18n).toString() } };
const newNode = (extra = {}) => new EvmNode({
  quiet: true, coinbaseKey: miner, ...extra,
  genesis: { alloc: ALLOC, target: C.EASY_TARGET, ...(extra.genesis || {}) },
});

// ---------------------------------------------------------------------------
group('header v2');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  const { block } = C.mine(n);
  n.onMinedBlock(block);
  const h = block.header;

  eq(h.version, 2, 'header version is 2');
  ok(h.timestamp < HDR.MAX_TIMESTAMP && h.timestamp > 1_600_000_000, 'timestamp is in SECONDS');
  eq(HDR.hashHex(h), HDR.hashHex(HDR.normalize(h)), 'hashing is stable under normalize');

  // the core must NOT move when the miner varies the nonce, or grinding is futile
  const core = HDR.coreHash(h);
  eq(HDR.coreHash({ ...h, nonce: h.nonce + 1 }), core, 'coreHash excludes the nonce');
  eq(HDR.coreHash({ ...h, mixHash: 'aa'.repeat(32) }), core, 'coreHash excludes the digest');
  eq(HDR.coreHash({ ...h, powSig: 'bb'.repeat(65) }), core, 'coreHash excludes the signature');
  ok(HDR.coreHash({ ...h, stateRoot: 'cc'.repeat(32) }) !== core, 'coreHash covers the state root');
  ok(HDR.coreHash({ ...h, gasUsed: h.gasUsed + 1 }) !== core, 'coreHash covers gasUsed');
  ok(HDR.coreHash({ ...h, extraData: 'aabb' }) !== core, 'coreHash covers extraData');

  // the id must move with the proof and not with the signature
  ok(HDR.hashHex({ ...h, nonce: h.nonce + 1 }) !== HDR.hashHex(h), 'the block id covers the nonce');
  ok(HDR.hashHex({ ...h, mixHash: 'aa'.repeat(32) }) !== HDR.hashHex(h), 'the block id covers the digest');
  eq(HDR.hashHex({ ...h, powSig: '00'.repeat(65) }), HDR.hashHex(h),
    'the block id EXCLUDES the signature (a malleable signature must not give one block two ids)');

  eq(HDR.difficulty('00' + 'ff'.repeat(31)), (1n << 256n) / (BigInt('0x00' + 'ff'.repeat(31)) + 1n),
    'difficulty is 2^256 / (target + 1)');
  ok(HDR.blockSize(block) > 500n, 'a block reports its RLP size');

  // shape rules
  ok(!HDR.check({ ...h, timestamp: Date.now() }).ok, 'a millisecond timestamp is refused');
  ok(!HDR.check({ ...h, version: 1 }).ok, 'a v1 header is refused');
  ok(!HDR.check({ ...h, gasUsed: h.gasLimit + 1 }).ok, 'gasUsed above gasLimit is refused');
  ok(!HDR.check({ ...h, coinbasePub: '02' + '11'.repeat(32) }).ok, 'a compressed coinbase key is refused');

  // the proof
  ok(HDR.verifyPow(h).ok, 'a mined header verifies');
  ok(!HDR.verifyPow({ ...h, nonce: h.nonce + 1 }).ok, 'a different nonce does not verify');
  ok(!HDR.verifyPow({ ...h, mixHash: '00'.repeat(32) }).ok, 'a forged digest does not verify');
  const stolen = { ...h, powSig: HDR.signProof(h.mixHash, other.privateKey) };
  ok(!HDR.verifyPow(stolen).ok, "another key's signature does not redeem a winning proof");
  ok(!HDR.verifyPow({ ...h, target: '00'.repeat(31) + '01' }).ok, 'a digest above the target does not verify');
  eq(HDR.coinbaseAddress(h.coinbasePub).toString('hex'), miner.address.toString('hex'),
    'the coinbase address is derived from the header key');
  n.close();
}

// ---------------------------------------------------------------------------
group('genesis');
// ---------------------------------------------------------------------------
{
  const a = genesis.build({ alloc: ALLOC });
  const b = genesis.build({ alloc: ALLOC });
  eq(a.hash, b.hash, 'genesis is deterministic');
  const c = genesis.build({ alloc: { [alice.addressHex]: { balance: '1' } } });
  ok(c.hash !== a.hash, 'a different allocation is a different genesis');
  eq(genesis.build({}).config.alloc, {}, 'the default genesis has NO premine');

  /* An empty block carries no transactions, so EIP-155 cannot separate two
   * networks the way it separates two transactions: with an identical genesis, a
   * cheap testnet block is a structurally valid mainnet block. The genesis
   * extraData names the network so the two chains cannot share an ancestor. */
  const mainnetGenesis = genesis.build({});
  const testnetGenesis = genesis.build({ chainId: 7412, extraData: '0x' + Buffer.from('hearth-testnet/7412').toString('hex') });
  ok(mainnetGenesis.hash !== testnetGenesis.hash, 'mainnet and testnet have DIFFERENT genesis hashes');
  // Read from params rather than a literal: the assertion is that the default
  // genesis NAMES whichever network the node is, which is the property that
  // stops two chains sharing an ancestor. Hardcoding 'hearth/7411' would make
  // this suite pass only on the network it happens to run as.
  eq(Buffer.from(mainnetGenesis.config.extraData.slice(2), 'hex').toString(), `${P.NETWORK}/${P.CHAIN_ID}`,
    'and the default genesis names its network and chain id in extraData');
  eq(TX.CHAIN_ID, P.CHAIN_ID, 'the transaction layer reads the chain id from params rather than declaring one');

  const g = genesis.build({ alloc: ALLOC });
  eq(g.state.getBalance(alice.address), 100n * 10n ** 18n, 'an allocation lands in the state');
  eq(g.block.header.height, 0, 'genesis is height 0');
  eq(g.block.header.prevHash, '00'.repeat(32), 'genesis has no parent');
  eq(g.block.txs.length, 0, 'genesis carries no transactions');

  assert.throws(() => genesis.normalizeConfig({ decimals: 8 }), /decimals must be 18/, 'decimals 8 is refused');
  assert.throws(() => genesis.normalizeConfig({ timestamp: Date.now() }), /SECONDS/, 'a millisecond genesis timestamp is refused');
  assert.throws(() => genesis.normalizeConfig({ format: 'geth/1' }), /unknown format/, 'a foreign genesis format is refused');
  T.state.pass += 3;

  const withCode = genesis.build({
    alloc: { [bob.addressHex]: { balance: '0', code: '0x60016000', storage: { ['0x' + '00'.repeat(32)]: '0x' + '00'.repeat(31) + '07' } } },
  });
  eq(withCode.state.getCode(bob.address).toString('hex'), '60016000', 'genesis can allocate code');
  eq(withCode.state.getStorage(bob.address, 0).toString('hex'), '00'.repeat(31) + '07', 'genesis can allocate storage');
}

// ---------------------------------------------------------------------------
group('emission and the block reward');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  const before = n.chain.stateAtTip().getBalance(miner.address);
  eq(before, 0n, 'the miner starts with nothing (no premine)');

  n.onMinedBlock(C.mine(n).block);
  const subsidy = P.subsidyWei(1);
  const commons = subsidy / 10n;
  eq(n.chain.stateAtTip().getBalance(miner.address), subsidy - commons, 'the miner receives 90% of the subsidy');
  eq(n.chain.stateAtTip().getBalance(n.chain.commonsAddress), commons, 'the Commons receives 10%');
  eq(subsidy, BigInt(P.subsidy(1)) * 10n ** 10n, 'the wei subsidy is the spark schedule scaled by 1e10 exactly');
  eq(P.subsidyWei(0) / P.WEI_PER_EMBER, 6n, 'the genesis-height reward is still 6 EMBER');

  // fees, on top of the subsidy and out of the sender's balance
  const raw = C.signed(alice, { nonce: 0n, to: bob.address, value: 10n ** 18n, gasLimit: 21000n });
  ok(n.submitRawTransaction(raw).ok, 'a value transfer is accepted');
  n.onMinedBlock(C.mine(n).block);
  const fee = 21000n * C.GWEI;
  eq(n.chain.stateAtTip().getBalance(bob.address), 10n ** 18n, 'the transfer arrives');
  eq(n.chain.stateAtTip().getBalance(alice.address), 100n * 10n ** 18n - 10n ** 18n - fee, 'the sender pays value plus gas');
  eq(n.chain.stateAtTip().getBalance(miner.address),
    (subsidy - commons) + (P.subsidyWei(2) - P.subsidyWei(2) / 10n) + fee,
    'the fee goes to the coinbase, on top of two subsidies');
  eq(n.chain.tip.header.gasUsed, 21000, 'the header records the gas used');
  n.close();
}

// ---------------------------------------------------------------------------
group('block validation — every committed field is recomputed');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  n.onMinedBlock(C.mine(n).block);
  // a block carrying a transaction, so the roots are not all trivially empty
  ok(n.submitRawTransaction(C.signed(alice, { nonce: 0n, to: null, data: C.STORAGE_INITCODE, gasLimit: 200000n })).ok, 'deployment pooled');

  /* Re-grinding is required after touching the core: a tampered field changes
   * coreHash, so the old nonce no longer meets the target and the block would be
   * refused for the wrong reason — "pow digest mismatch" instead of the rule under
   * test. A test that accepts ANY rejection passes even when the only rule left is
   * the proof, so each case names the error it expects.
   *
   * One node is enough for all of them: a rejected block changes nothing, so the
   * chain, the mempool and the candidate are all still valid for the next case. */
  const POW = require('../src/pow');
  const regrind = (header, txs) => {
    const core = HDR.coreHash(header);
    for (let nonce = 0; ; nonce++) {
      const d = POW.homefireHash(POW.powSeed(core, nonce, header.coinbasePub)).toString('hex');
      if (POW.meetsTarget(d, header.target)) {
        return { header: { ...header, nonce, mixHash: d, powSig: HDR.signProof(d, miner.privateKey) }, txs };
      }
    }
  };

  const base = n.miner.candidateFor(miner.publicKey.toString('hex'));
  ok(n.chain.addBlock(regrind(base.header, base.txs)).ok, 'a well-formed block is accepted');
  ok(!n.chain.addBlock(regrind(base.header, base.txs)).ok, 'and the same block twice is not');

  /* Each case gets distinct extraData. Not a rule under test — it is what makes
   * every candidate a DIFFERENT block: the block id excludes the transaction list
   * and the signature, so "drop a transaction" and "re-sign with another key" both
   * produce a header identical to one already in the store, and would be rejected
   * as `known` before reaching the rule they are meant to exercise. */
  let variant = 0;
  const tamper = (mutate, expected, msg) => {
    const cand = { header: { ...base.header, extraData: (++variant).toString(16).padStart(2, '0') }, txs: [...base.txs] };
    mutate(cand);
    const r = n.chain.addBlock(regrind(cand.header, cand.txs));
    const got = r.ok ? 'ACCEPTED' : r.err;
    ok(!r.ok && String(got).includes(expected), `${msg} — want "${expected}", got "${got}"`);
  };

  tamper(c => { c.header.stateRoot = 'aa'.repeat(32); }, 'stateRoot mismatch', 'a wrong stateRoot is caught');
  tamper(c => { c.header.receiptsRoot = 'aa'.repeat(32); }, 'receiptsRoot mismatch', 'a wrong receiptsRoot is caught');
  tamper(c => { c.header.logsBloom = 'aa'.repeat(256); }, 'logsBloom mismatch', 'a wrong logsBloom is caught');
  tamper(c => { c.header.txRoot = 'aa'.repeat(32); }, 'txRoot mismatch', 'a wrong txRoot is caught');
  tamper(c => { c.header.gasUsed = c.header.gasUsed + 1; }, 'gasUsed mismatch', 'a wrong gasUsed is caught');
  tamper(c => { c.header.gasLimit = 40_000_000; }, 'wrong gas limit', 'a raised gas limit is caught');
  tamper(c => { c.header.target = 'ff'.repeat(32); }, 'wrong difficulty target', 'an easier target is caught');
  tamper(c => { c.header.height = c.header.height + 1; }, 'bad height', 'a skipped height is caught');
  tamper(c => { c.header.timestamp = Math.floor(Date.now() / 1000) + P.MAX_FUTURE_DRIFT_S + 60; },
    'timestamp too far in future', 'a far-future timestamp is caught');
  tamper(c => { c.header.timestamp = 1; }, 'median-time-past', 'a backdated timestamp is caught');
  tamper(c => { c.txs = []; }, 'txRoot mismatch', 'dropping a transaction is caught by the txRoot');
  tamper(c => { c.txs = [...c.txs, c.txs[0]]; }, 'txRoot mismatch', 'duplicating a transaction is caught by the txRoot');

  /* The proof is verified BEFORE the state transition, so a block with a bad nonce
   * costs one Homefire evaluation and not 30M gas of execution. */
  {
    const sealed = regrind({ ...base.header, extraData: 'f0' }, base.txs);
    const r = n.chain.addBlock({ header: { ...sealed.header, nonce: sealed.header.nonce + 1 }, txs: sealed.txs });
    ok(!r.ok && r.err === 'pow digest mismatch', 'a bad nonce is refused by the proof');
    const r2 = n.chain.addBlock({ header: { ...sealed.header, powSig: HDR.signProof(sealed.header.mixHash, other.privateKey) }, txs: sealed.txs });
    ok(!r2.ok && r2.err === 'pow signature invalid', 'a proof signed by another key is refused');
    const r3 = n.chain.addBlock({ header: { ...sealed.header, prevHash: 'ab'.repeat(32) }, txs: sealed.txs });
    ok(!r3.ok && r3.err === 'unknown parent', 'a block with no known parent is held, not applied');
  }

  /* A PROOF THAT DOES NOT MEET THE TARGET. Tampering with `target` cannot test
   * this — target is a core field, so changing it changes coreHash and the block is
   * refused as a digest mismatch before `meetsTarget` is ever consulted. The only
   * way to reach that rule is a HONESTLY COMPUTED digest from a nonce that simply
   * did not win, which is what a miner submitting early would produce. */
  {
    const header = { ...base.header, extraData: 'f1' };
    const core = HDR.coreHash(header);
    let attempt = 0, digest;
    do {
      digest = POW.homefireHash(POW.powSeed(core, attempt, header.coinbasePub)).toString('hex');
    } while (POW.meetsTarget(digest, header.target) && ++attempt);
    const losing = {
      header: { ...header, nonce: attempt, mixHash: digest, powSig: HDR.signProof(digest, miner.privateKey) },
      txs: base.txs,
    };
    eq(HDR.verifyPow(losing.header).err, 'pow does not meet target',
      'a correctly computed digest that does not meet the target is refused');
    eq(n.chain.addBlock(losing).err, 'pow does not meet target', 'and the chain refuses the block');
  }

  /* An EMPTY BLOCK IS LEGAL HERE. There is no coinbase transaction on the account
   * model — the reward is credited to an account — so a validator inherited from
   * the UTXO chain would reject every empty block on the network. */
  {
    const m = newNode();
    const r = m.chain.addBlock(C.mine(m).block);
    ok(r.ok, 'an empty block is valid');
    eq(m.chain.tip.txs.length, 0, 'and carries no transactions at all');
    m.close();
  }

  // a block whose transaction is invalid against the state voids the WHOLE block
  {
    const m = newNode();
    m.onMinedBlock(C.mine(m).block);
    const badNonce = C.signed(alice, { nonce: 7n, to: bob.address, value: 1n, gasLimit: 21000n });
    const cand = m.chain.buildCandidate({ coinbasePub: miner.publicKey.toString('hex'), transactions: [badNonce] });
    eq(cand.txs.length, 0, 'building a block SKIPS a transaction that cannot execute');
    ok(cand.rejected[0].code === 'NONCE_TOO_HIGH', 'and says why it was skipped');

    // now force it in and require the validator to refuse the block
    const forced = m.chain.buildCandidate({ coinbasePub: miner.publicKey.toString('hex'), transactions: [] });
    forced.txs = [badNonce.toString('hex')];
    forced.header = { ...forced.header, txRoot: HDR.txRoot([badNonce]).toString('hex') };
    const POW = require('../src/pow');
    const core = HDR.coreHash(forced.header);
    let sealed = null;
    for (let nonce = 0; !sealed; nonce++) {
      const d = POW.homefireHash(POW.powSeed(core, nonce, forced.header.coinbasePub)).toString('hex');
      if (POW.meetsTarget(d, forced.header.target)) {
        sealed = { header: { ...forced.header, nonce, mixHash: d, powSig: HDR.signProof(d, miner.privateKey) }, txs: forced.txs };
      }
    }
    const r = m.chain.addBlock(sealed);
    ok(!r.ok && /NONCE_TOO_HIGH/.test(r.err), 'VALIDATING refuses the whole block for one unexecutable transaction');
    m.close();
  }
  n.close();
}

// ---------------------------------------------------------------------------
group('the mempool: a nonce ladder, not a fee-ranked set');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  const pool = n.mempool;

  const tx = (key, nonce, price = C.GWEI, extra = {}) =>
    C.signed(key, { nonce: BigInt(nonce), gasPrice: price, to: bob.address, value: 1n, gasLimit: 21000n, ...extra });

  ok(pool.add(tx(alice, 0)).ok, 'nonce 0 is accepted');
  eq(pool.add(tx(alice, 0)).code, 'ALREADY_KNOWN', 'the same transaction twice is "already known"');
  ok(pool.add(tx(alice, 2)).ok, 'a future nonce is queued');
  eq(pool.select({ state: n.chain.stateAtTip() }).length, 1,
    'selection stops at the nonce GAP — a transaction behind a gap cannot execute');
  ok(pool.add(tx(alice, 1)).ok, 'the gap is filled');
  const sel = pool.select({ state: n.chain.stateAtTip() });
  eq(sel.map(e => Number(e.nonce)), [0, 1, 2], 'and the ladder is then selected in nonce order');

  eq(pool.add(tx(alice, 0, C.GWEI)).code, 'ALREADY_KNOWN', 'an identical replacement is already known');
  eq(pool.add(tx(alice, 0, C.GWEI + 1n, { value: 2n })).code, 'REPLACEMENT_UNDERPRICED',
    'a one-wei bump does not replace (or a free re-broadcast loop evicts forever)');
  ok(pool.add(tx(alice, 0, C.GWEI * 2n, { value: 2n })).ok, 'a 10% bump does replace');
  eq(pool.size, 3, 'and the replaced transaction is gone, not both');

  // above the pool minimum, below the pooled transaction: refused as a REPLACEMENT,
  // which is a different rule from being underpriced outright
  eq(pool.add(tx(alice, 0, (C.GWEI * 3n) / 2n)).code, 'REPLACEMENT_UNDERPRICED', 'a cheaper same-nonce transaction is refused');
  eq(pool.add(tx(bob, 0, C.GWEI / 2n)).code, 'UNDERPRICED', 'and a first transaction below the minimum is underpriced');
  eq(pool.add(tx(bob, 0, 1n)).code, 'UNDERPRICED', 'below the minimum gas price is refused');
  eq(pool.add(tx(alice, 500)).code, 'NONCE_TOO_HIGH', 'a nonce far above the account is refused outright');

  eq(pool.pendingNonce(alice.address, 0n), 3n, 'the pending nonce counts the consecutive ladder');
  eq(pool.pendingNonce(bob.address, 0n), 0n, 'and is the account nonce for a sender with nothing pooled');

  // cumulative affordability
  {
    const m = newNode();
    const big = 60n * 10n ** 18n;      // alice holds 100
    ok(m.mempool.add(C.signed(alice, { nonce: 0n, to: bob.address, value: big, gasLimit: 21000n })).ok, 'the first big spend fits');
    eq(m.mempool.add(C.signed(alice, { nonce: 1n, to: bob.address, value: big, gasLimit: 21000n })).code,
      'INSUFFICIENT_FUNDS',
      'the second is refused: affordability is CUMULATIVE, not per transaction');
    m.close();
  }

  // ordering between senders is by price, and it is deterministic
  {
    const m = newNode({ genesis: { alloc: { [alice.addressHex]: { balance: (10n ** 20n).toString() }, [bob.addressHex]: { balance: (10n ** 20n).toString() } } } });
    m.mempool.add(C.signed(alice, { nonce: 0n, gasPrice: C.GWEI, to: bob.address, value: 1n, gasLimit: 21000n }));
    m.mempool.add(C.signed(bob, { nonce: 0n, gasPrice: C.GWEI * 5n, to: alice.address, value: 1n, gasLimit: 21000n }));
    const picked = m.mempool.select({ state: m.chain.stateAtTip() });
    eq(picked[0].senderHex, bob.address.toString('hex'), 'the higher gas price goes first');
    m.close();
  }

  // the block gas limit bounds selection
  {
    const m = newNode({ genesis: { alloc: { [alice.addressHex]: { balance: (10n ** 20n).toString() } } } });
    for (let i = 0; i < 4; i++) {
      m.mempool.add(C.signed(alice, { nonce: BigInt(i), to: bob.address, value: 1n, gasLimit: 9_000_000n }));
    }
    eq(m.mempool.select({ state: m.chain.stateAtTip(), gasLimit: 30_000_000n }).length, 3,
      'selection stops at the block gas limit');
    m.close();
  }

  n.close();
}

// ---------------------------------------------------------------------------
group('mempool selection against a state the pool has not caught up with');
// ---------------------------------------------------------------------------
{
  /* Selection is handed the state the BLOCK will build on, which is not the state
   * the pool admitted against — a block landed in between. Both rules below only
   * differ in that window, so they are unreachable through a node that revalidates
   * after every block, and a fake state reader is the only way to hold the window
   * open. Between them they are the difference between a template that executes and
   * one every other node rejects. */
  const fake = { nonce: 0n, balance: 1000n * 10n ** 18n };
  const pool = new Mempool({
    state: () => ({ getNonce: () => fake.nonce, getBalance: () => fake.balance }),
    gasLimit: () => 30_000_000n,
  });
  const cost = 21000n * C.GWEI;
  for (let i = 0; i < 3; i++) {
    ok(pool.add(C.signed(alice, { nonce: BigInt(i), to: bob.address, value: 10n ** 18n, gasLimit: 21000n })).ok,
      `nonce ${i} pooled`);
  }

  // a block arrived that mined nonce 0, but revalidate has not run yet
  fake.nonce = 1n;
  const picked = pool.select({ state: { getNonce: () => 1n, getBalance: () => fake.balance } });
  eq(picked.map(e => Number(e.nonce)), [1, 2],
    'selection starts at the ACCOUNT nonce, so an already-mined transaction is not re-included');

  // and now the sender can only afford one of what is left
  const poor = { getNonce: () => 1n, getBalance: () => 10n ** 18n + cost };
  eq(pool.select({ state: poor }).map(e => Number(e.nonce)), [1],
    'selection stops when the sender has committed everything it holds');
}

// ---------------------------------------------------------------------------
group('mempool maintenance across blocks');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  n.onMinedBlock(C.mine(n).block);
  n.submitRawTransaction(C.signed(alice, { nonce: 0n, to: bob.address, value: 1n, gasLimit: 21000n }));
  n.submitRawTransaction(C.signed(alice, { nonce: 1n, to: bob.address, value: 1n, gasLimit: 21000n }));
  eq(n.mempool.size, 2, 'two queued');
  n.onMinedBlock(C.mine(n).block);
  eq(n.mempool.size, 0, 'mining empties the pool of what it included');
  eq(n.chain.tip.txs.length, 2, 'and the block carried both');
  n.close();
}

// ---------------------------------------------------------------------------
group('reorganisation');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  const chain = n.chain;
  const forkPoint = chain.tipId;

  // branch A: two blocks, one of them carrying a transaction of alice's
  const aliceTx = C.signed(alice, { nonce: 0n, to: bob.address, value: 5n * 10n ** 18n, gasLimit: 21000n });
  const a1 = C.mineOn(chain, forkPoint, miner, { transactions: [aliceTx] });
  ok(chain.addBlock(a1).ok, 'branch A block 1');
  const a2 = C.mineOn(chain, HDR.hashHex(a1.header), miner);
  ok(chain.addBlock(a2).ok, 'branch A block 2');
  eq(chain.height, 2, 'branch A is the tip');
  eq(chain.stateAtTip().getBalance(bob.address), 5n * 10n ** 18n, 'branch A moved the money');
  const aliceTxHash = keccak256(aliceTx).toString('hex');
  ok(chain.getTransaction(aliceTxHash) !== null, 'and the transaction is indexed');

  // branch B: three blocks from the same fork point, mined by someone else
  let unwound = null;
  chain.once('reorg', e => { unwound = e; });
  let parent = forkPoint;
  const bIds = [];
  for (let i = 0; i < 3; i++) {
    const b = C.mineOn(chain, parent, other);
    const r = chain.addBlock(b);
    ok(r.ok, `branch B block ${i + 1} stored`);
    parent = r.id;
    bIds.push(r.id);
  }

  eq(chain.height, 3, 'the heavier branch wins');
  eq(chain.tipId, bIds[2], 'and the tip is branch B');
  ok(unwound && unwound.unwound.length === 1, 'the reorg reported the un-mined transaction');
  eq(chain.stateAtTip().getBalance(bob.address), 0n, 'the state followed the reorg — the transfer is undone');
  eq(chain.getTransaction(aliceTxHash), null, 'the transaction index followed the reorg');
  eq(chain.stateAtTip().getBalance(other.address) > 0n, true, 'the winning miner holds its rewards');
  eq(chain.stateAtTip().getBalance(miner.address), 0n, 'the losing miner keeps nothing');

  // the losing branch is still stored and still readable at its own state root
  const aState = chain.stateAt(HDR.hashHex(a2.header));
  eq(aState.getBalance(bob.address), 5n * 10n ** 18n,
    'the orphaned branch state is STILL readable at its own root (content addressing, not replay)');

  /* THE RECEIPT MUST GO WITH IT. The transaction is still in the store on the
   * losing branch, so a lookup by hash still finds a block — serving that receipt
   * tells a wallet its transfer succeeded when the chain no longer contains it. */
  eq(n.rpcChain.getTransactionReceipt(Buffer.from(aliceTxHash, 'hex')), null,
    'a receipt from an orphaned branch is NOT served');
  eq(n.rpcChain.getTransactionByHash(Buffer.from(aliceTxHash, 'hex')).blockNumber, null,
    'and the transaction is reported as pending again, not as mined');

  // and the node put the un-mined transaction back
  eq(n.mempool.size, 1, 'the un-mined transaction went back into the mempool');
  eq(n.mempool.get(aliceTxHash) !== null, true, 'by hash');
  n.close();
}

// ---------------------------------------------------------------------------
group('fork choice is by cumulative work, not height');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  const chain = n.chain;
  const a1 = C.mineOn(chain, chain.tipId, miner);
  chain.addBlock(a1);
  const tipWork = chain.totalDifficulty;
  const b1 = C.mineOn(chain, chain.genesisId, other);
  chain.addBlock(b1);
  eq(chain.tipId, HDR.hashHex(a1.header), 'an equal-work competing tip does NOT displace the incumbent');
  eq(chain.totalDifficulty, tipWork, 'and the total difficulty is unchanged');
  ok(chain.entry(HDR.hashHex(b1.header)) !== null, 'but the competing block is stored, so the branch can grow');
  eq(chain.totalDifficulty, HDR.difficulty(a1.header.target), 'total difficulty is the sum over the branch');
  n.close();
}

// ---------------------------------------------------------------------------
group('block production');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  n.onMinedBlock(C.mine(n).block);
  n.submitRawTransaction(C.signed(alice, { nonce: 0n, to: bob.address, value: 1n, gasLimit: 21000n }));

  const mineCand = n.miner.candidateFor(miner.publicKey.toString('hex'));
  const otherCand = n.miner.candidateFor(other.publicKey.toString('hex'));
  /* The coinbase is CREDITED INSIDE THE CANDIDATE, so a candidate built for one
   * miner has a state root that is wrong for any other. The UTXO chain does not
   * have this property — its selection genuinely does not depend on who is paid —
   * so a memo inherited from ../miner.js hands the second caller a block that
   * fails its own validation, and `/mining/template` is where that happens. */
  ok(mineCand.header.stateRoot !== otherCand.header.stateRoot,
    'a candidate built for a different coinbase key has a different state root');
  ok(mineCand.coreHash !== otherCand.coreHash, 'and therefore different work to grind');
  eq(n.miner.candidateFor(miner.publicKey.toString('hex')).header.stateRoot, mineCand.header.stateRoot,
    'while the same key gets the memoized candidate back');

  // both must actually validate, which is the property the memo can break
  const mined = C.mine(n, other);
  ok(n.chain.addBlock(mined.block).ok, 'a block mined for a second key validates');
  eq(n.chain.stateAtTip().getBalance(other.address) > 0n, true, 'and pays that key');
  eq(n.chain.tip.txs.length, 1, 'and carries the pooled transaction');
  n.close();
}

// ---------------------------------------------------------------------------
group('PREVRANDAO is the parent block\'s Homefire digest (spec §5)');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  n.onMinedBlock(C.mine(n).block);
  n.submitRawTransaction(C.signed(alice, { nonce: 0n, to: null, data: C.PREVRANDAO_INITCODE, gasLimit: 200000n }));
  n.onMinedBlock(C.mine(n).block);
  const addr = TX.contractAddress(alice.address, 0n);
  n.onMinedBlock(C.mine(n).block);

  const at = BigInt(n.chain.height);
  const res = n.rpcChain.call({ to: addr, data: Buffer.alloc(0) }, at);
  const parentMix = n.chain.entryAt(Number(at) - 1).block.header.mixHash;
  ok(res.ok, 'the contract returns');
  eq(res.returnData.toString('hex'), parentMix,
    "PREVRANDAO reads the PARENT block's PoW digest — a real 256-bit hash, not the difficulty");
  ok(parentMix !== '00'.repeat(32), 'which is a value that was actually ground for');
  eq(n.rpcChain.getBlockByNumber(at - 1n, false).mixHash.toString('hex'), parentMix,
    'and it is the same value the RPC serves as that block\'s mixHash');
  n.close();
}

// ---------------------------------------------------------------------------
group('the RPC adapter speaks native values');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  n.onMinedBlock(C.mine(n).block);
  n.submitRawTransaction(C.signed(alice, { nonce: 0n, to: null, data: C.STORAGE_INITCODE, gasLimit: 200000n }));
  n.onMinedBlock(C.mine(n).block);
  const contract = TX.contractAddress(alice.address, 0n);
  const word = Buffer.concat([Buffer.alloc(31), Buffer.from([42])]);
  n.submitRawTransaction(C.signed(alice, { nonce: 1n, to: contract, data: word, gasLimit: 100000n }));
  n.onMinedBlock(C.mine(n).block);

  const R = n.rpcChain;
  const b = R.getBlockByNumber(3n, true);
  eq(typeof b.number, 'bigint', 'block.number is a bigint, not a hex string');
  ok(Buffer.isBuffer(b.hash) && b.hash.length === 32, 'block.hash is 32 bytes');
  ok(Buffer.isBuffer(b.nonce) && b.nonce.length === 8, 'block.nonce is exactly 8 bytes');
  ok(Buffer.isBuffer(b.logsBloom) && b.logsBloom.length === 256, 'block.logsBloom is 256 bytes');
  ok(Buffer.isBuffer(b.miner) && b.miner.length === 20, 'block.miner is a 20-byte ADDRESS, not the coinbase key');
  eq(b.miner.toString('hex'), miner.address.toString('hex'), 'and it is the address the reward went to');
  eq(b.timestamp < BigInt(HDR.MAX_TIMESTAMP), true, 'block.timestamp is seconds');
  eq(b.totalDifficulty, n.chain.totalDifficulty, 'totalDifficulty is stored, not recomputed');
  eq(b.difficulty, HDR.difficulty(n.chain.tip.header.target), 'difficulty comes from the target');
  ok(b.size > 0n, 'size is the RLP byte length');
  eq(b.transactions.length, 1, 'the block carries one transaction');
  eq(typeof b.transactions[0].nonce, 'bigint', 'a full transaction has bigint fields');
  eq(b.transactions[0].chainId, BigInt(P.CHAIN_ID), 'and its chain id');

  const receipts = R.getBlockReceipts(3n);
  eq(receipts.length, 1, 'getBlockReceipts answers the whole block');
  eq(receipts[0].status, 1, 'the call succeeded');
  eq(receipts[0].logs.length, 1, 'and logged');
  eq(receipts[0].logs[0].logIndex, 0n, 'logIndex is per BLOCK');
  eq(receipts[0].gasUsed, receipts[0].cumulativeGasUsed, 'gasUsed is derived from the cumulative figures');
  eq(receipts[0].contractAddress, null, 'a plain call has no contract address');

  const deployReceipt = R.getBlockReceipts(2n)[0];
  eq(deployReceipt.contractAddress.toString('hex'), contract.toString('hex'), 'a creation reports where it landed');

  /* TWO logging transactions in ONE block. Everything above passes with logIndex
   * numbered per receipt and with gasUsed reporting the cumulative figure, because
   * with one transaction per block the two definitions coincide — which is exactly
   * how both bugs reach production. */
  {
    n.submitRawTransaction(C.signed(alice, { nonce: 2n, to: contract, data: word, gasLimit: 100000n }));
    n.submitRawTransaction(C.signed(alice, { nonce: 3n, to: contract, data: word, gasLimit: 100000n }));
    n.onMinedBlock(C.mine(n).block);
    const rs = R.getBlockReceipts(BigInt(n.chain.height));
    eq(rs.length, 2, 'the block carries two transactions');
    eq(rs.map(r => r.logs[0].logIndex), [0n, 1n], 'logIndex is numbered across the BLOCK, not per receipt');
    eq(rs[1].cumulativeGasUsed, rs[0].gasUsed + rs[1].gasUsed, 'cumulativeGasUsed is the running total');
    ok(rs[1].gasUsed < rs[1].cumulativeGasUsed, 'and gasUsed is this transaction ALONE');
    eq(BigInt(n.chain.tip.header.gasUsed), rs[1].cumulativeGasUsed, "the header's gasUsed is the last cumulative figure");
    eq(rs[0].transactionIndex, 0n, 'the first is index 0');
    eq(rs[1].transactionIndex, 1n, 'the second is index 1');
  }

  // historical state, which content addressing makes exact rather than approximate
  eq(R.getBalance(bob.address, 3n), 0n, 'a never-funded account reads zero');
  eq(R.getCode(contract, 1n).length, 0, 'the contract did not exist at height 1');
  eq(R.getCode(contract, 2n).length, 53, 'and does at height 2');
  eq(R.getStorageAt(contract, Buffer.alloc(32), 3n).toString('hex'), word.toString('hex'), 'storage reads a full 32-byte word');
  eq(R.getStorageAt(contract, Buffer.alloc(32), 2n).toString('hex'), '00'.repeat(32), 'and zero before it was written');

  // pending — alice's next nonce is 4 by now (deploy, set, and the pair above)
  n.submitRawTransaction(C.signed(alice, { nonce: 4n, to: bob.address, value: 1n, gasLimit: 21000n }));
  eq(R.getNonce(alice.address, 'pending'), 5n, "'pending' counts the mempool, or a wallet's second send collides");
  eq(R.getNonce(alice.address, BigInt(n.chain.height)), 4n, 'while the mined nonce is unchanged');
  const pendingHash = keccak256(C.signed(alice, { nonce: 4n, to: bob.address, value: 1n, gasLimit: 21000n }));
  const pending = R.getTransactionByHash(pendingHash);
  ok(pending !== null, 'a pooled transaction is visible before it is mined');
  eq(pending.blockNumber, null, 'with null block fields');
  eq(R.getTransactionReceipt(pendingHash), null, 'and no receipt yet');

  // a side branch must not answer as a block
  const side = C.mineOn(n.chain, n.chain.entryAt(1).id, other);
  n.chain.addBlock(side);
  eq(R.getBlockByHash(Buffer.from(HDR.hashHex(side.header), 'hex'), false), null,
    'a stored side-branch block is NOT served by hash (its number resolves to a different block)');
  n.close();
}

// ---------------------------------------------------------------------------
group('execution through the adapter');
// ---------------------------------------------------------------------------
{
  const n = newNode();
  n.onMinedBlock(C.mine(n).block);
  n.submitRawTransaction(C.signed(alice, { nonce: 0n, to: null, data: C.REVERT_INITCODE, gasLimit: 300000n }));
  n.submitRawTransaction(C.signed(alice, { nonce: 1n, to: null, data: C.STORAGE_INITCODE, gasLimit: 200000n }));
  n.onMinedBlock(C.mine(n).block);
  const reverter = TX.contractAddress(alice.address, 0n);
  const storage = TX.contractAddress(alice.address, 1n);
  const R = n.rpcChain;
  const at = BigInt(n.chain.height);

  const rev = R.call({ to: reverter, data: Buffer.alloc(0) }, at);
  eq(rev.ok, false, 'a revert is not ok');
  eq(rev.reverted, true, 'it is flagged as a revert, not an error');
  eq(require('../src/jsonrpc/methods').decodeRevertReason(rev.returnData), 'nope', 'and carries a decodable reason');

  const word = Buffer.concat([Buffer.alloc(31), Buffer.from([7])]);
  const est = R.estimateGas({ from: alice.address, to: storage, data: word }, at);
  ok(est.ok && est.gas > 21000n, 'estimateGas returns a figure above the intrinsic cost');
  const tooLittle = R._run({ from: alice.address, to: storage, data: word }, n.chain.entry(n.chain.tipId), est.gas - 1n);
  ok(!tooLittle.ok, 'and it is MINIMAL: one gas less fails');

  const failed = R.call({ to: storage, data: word, gas: 21000n }, at);
  ok(!failed.ok && !failed.reverted, 'too little gas is an error, not a revert');

  // a call must not mutate the chain
  const rootBefore = n.chain.stateAtTip().rootHex();
  R.call({ from: alice.address, to: storage, data: word }, at);
  eq(n.chain.stateAtTip().rootHex(), rootBefore, 'eth_call leaves the world state untouched');
  n.close();
}

// ---------------------------------------------------------------------------
group('persistence');
// ---------------------------------------------------------------------------
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-evm-'));
  const a = new EvmNode({ dataDir: dir, quiet: true, coinbaseKey: miner, genesis: { alloc: ALLOC } });
  a.onMinedBlock(C.mine(a).block);
  a.submitRawTransaction(C.signed(alice, { nonce: 0n, to: bob.address, value: 3n, gasLimit: 21000n }));
  a.onMinedBlock(C.mine(a).block);
  const tip = a.chain.tipId, root = a.chain.stateAtTip().rootHex();
  a.close();

  const b = new EvmNode({ dataDir: dir, quiet: true, coinbaseKey: miner });
  eq(b.chain.tipId, tip, 'a restarted node replays to the same tip');
  eq(b.chain.stateAtTip().rootHex(), root, 'and to the same state root');
  eq(b.chain.stateAtTip().getBalance(bob.address), 3n, 'with balances intact');
  ok(fs.existsSync(path.join(dir, 'genesis.json')), 'genesis.json is written so the allocation cannot drift');
  eq(b.chain.config.alloc[alice.addressHex].balance, (100n * 10n ** 18n).toString(),
    'and is read back rather than regenerated from code');
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
group('a persisted genesis may not change the network');
// ---------------------------------------------------------------------------
{
  /* params.js refuses to guess a chain id, but the id the chain RUNS on comes from
   * genesis.json — so before this guard existed, a data directory written under one
   * HEARTH_NETWORK and started under another answered eth_chainId with the file's
   * id and nothing said so. Everything downstream follows that number: the mempool's
   * replay check, _formatTx, and any wallet that asks. The realistic drift is a dir
   * created with HEARTH_NETWORK unset (chain 7411) and later relabelled testnet. */
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-genesis-'));
  const write = (cfg) => fs.writeFileSync(path.join(dir, 'genesis.json'), JSON.stringify(cfg, null, 2) + '\n');
  const base = genesis.defaultConfig();

  write({ ...base, chainId: 9999 });
  /* The message is asserted, not just the throw: the whole cost of this defect was
   * time-to-diagnose, so a refusal that does not name BOTH ids, the network and the
   * file it read is only half the fix. */
  assert.throws(() => new Blockchain({ dataDir: dir }),
    e => e.code === GENESIS_NETWORK_MISMATCH
      && e.message.includes('chain id 9999')
      && e.message.includes(`"${P.NETWORK}"`)
      && e.message.includes(String(P.CHAIN_ID))
      && e.message.includes(path.join(dir, 'genesis.json')),
    'a genesis.json on another chain id is refused, naming both ids, the network and the file');

  // extraData is what keeps an EMPTY block — no transactions, therefore no chain
  // id in it at all — from being valid on both networks. Same treatment.
  write({ ...base, extraData: '0x' + Buffer.from('hearth/7411', 'utf8').toString('hex') });
  assert.throws(() => new Blockchain({ dataDir: dir }),
    e => e.code === GENESIS_NETWORK_MISMATCH && e.message.includes('extraData "hearth/7411"'),
    'a genesis.json whose extraData names another network is refused too');

  // An explicit override is a deliberate statement of which chain is meant, and it
  // already wins over the file — so it is not a mismatch. This is the seam the
  // devnet fixtures and the p2p suites run through.
  write({ ...base, chainId: 9999 });
  const forced = new Blockchain({ dataDir: dir, config: { chainId: 9999 } });
  eq(forced.chainId, 9999, 'an explicitly overridden chain id is honoured, not refused');

  // The ordinary case must still be silent: a directory this network created,
  // reopened by this network, is not a mismatch.
  fs.rmSync(path.join(dir, 'genesis.json'));
  const fresh = new Blockchain({ dataDir: dir });
  eq(fresh.chainId, P.CHAIN_ID, 'a fresh data directory takes its chain id from the network');
  const reopened = new Blockchain({ dataDir: dir });
  eq(reopened.chainId, P.CHAIN_ID, 'and reopening it is not a mismatch');
  T.state.pass += 2;                     // the two assert.throws above

  fs.rmSync(dir, { recursive: true, force: true });
}

T.done();
