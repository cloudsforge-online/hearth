'use strict';
/* ForgeReceipt on our own EVM — phase G's gate (docs/ecosystem/39-forge-exchange.md §6).
 *
 * The phase gate reads: *a stranger can compare issued supply to reserves on-chain, and a
 * redemption completes*. §4 sharpens it into three constraints this file has to hold the
 * contract to, because a wrapped asset is the one thing in the exchange plan that can
 * take a user's real Litecoin and hand back a number:
 *
 *   - the reserve must be checkable ON THE CHAIN by a stranger, without asking us;
 *   - the redemption path must exist and be EXERCISED BEFORE issuance, not after;
 *   - a wrapped asset that cannot satisfy doc 35 must not be issued.
 *
 * So the suite is ordered the way the plan says the product must be: everything about
 * redemption is proved before anything is issued, and the very first thing proved is that
 * a freshly deployed receipt with no attestation REFUSES TO MINT. That is not a corner
 * case. It is the estate's actual state on 2026-08-16: every platform-controlled LTC, BTC
 * and DOGE address has received nothing, ever, so the honest supply of every receipt we
 * could deploy today is zero and the contract is the thing that keeps it that way.
 *
 * What is proved here:
 *
 *   1. No attestation ⇒ no issuance. The zero state is the safe state, with no operator
 *      discipline involved.
 *   2. Issuance is bounded by the attested reserve at the EVM level: exactly at the
 *      reserve mints, one unit past it reverts.
 *   3. An attestation goes stale on a clock, so "we stopped attesting" and "we are hiding
 *      a shortfall" have the same effect — nothing new is issued.
 *   4. A shortfall can be RECORDED. `attest` accepts a reserve below supply, announces it,
 *      and issuance stops by itself.
 *   5. Height is strictly increasing, so a favourable old reading cannot be replayed.
 *   6. Redemption burns first, is public, and cannot be stopped by the issuer — including
 *      while issuance is frozen. The deployed code contains no DELEGATECALL and no
 *      SELFDESTRUCT, and the ABI has no pause, no freeze and no blacklist, so "we cannot
 *      confiscate or halt you" is a property of the bytecode rather than a promise.
 *   7. The backing addresses are published BY THE TOKEN, so the check does not route
 *      through any service of ours.
 *   8. The issuer is an m-of-n. A real `HearthMultisig` takes the role — which it must
 *      actively accept, two-step — and one signer alone cannot attest.
 *
 * As with dex.js and multisig.js there is no chain here: signed legacy transactions
 * straight through `chain/statetransition.js` against a fresh StateDB.
 *
 *     pnpm --dir contracts install && pnpm --dir contracts compile
 *     node node/test/forge-receipt.js        # --trace for the opcode trace of a failure
 */

const {
  Sim, reporter, artifact,
  hex, hx, word, addrWord,
  ETHER, receipt,
  abi, secp,
} = require('./evmsim');
const { keccak256 } = require('../src/crypto/keccak');
const { OPCODES } = require('../src/evm/opcodes');

const WANT_TRACE = process.argv.includes('--trace');

const ART = {
  Receipt: artifact('ForgeReceipt'),
  Multisig: artifact('HearthMultisig'),
};

// ===========================================================================
// accounts
// ===========================================================================

const KEY = {
  issuer: hex('11'.repeat(32)),      // the operator key, before the multisig takes over
  alice: hex('a1'.repeat(32)),       // a holder
  bob: hex('b0'.repeat(32)),         // another holder
  stranger: hex('57'.repeat(32)),    // nobody
  s1: hex('51'.repeat(32)),          // multisig signers
  s2: hex('52'.repeat(32)),
  s3: hex('53'.repeat(32)),
};

const SIM = new Sim({ keys: KEY });
const { counts, ok, group, fatal, succeeded, reverted } = reporter(SIM, { trace: WANT_TRACE });
const { issuer: ISSUER, alice: ALICE, bob: BOB, stranger: STRANGER, s1: S1, s2: S2, s3: S3 } = SIM.ADDR;
const ZERO = Buffer.alloc(20);

const call = (sig, args = []) => abi.encodeCall(abi.resolveFunction(null, sig), args);

for (const a of [ISSUER, ALICE, BOB, STRANGER, S1, S2, S3]) SIM.fund(a, 10000n * ETHER);

// ===========================================================================
// events
// ===========================================================================

/* dex.js's decoder assumes every indexed parameter is an address. Here they are a uint64
 * height, a uint256 redemption id and a bytes32 txid, so this one decodes each topic as
 * the type it was declared with. Dynamic indexed types would be the hash of the value and
 * are deliberately absent from the table below. */
const EVENTS = [
  ['Attested(uint256,uint64,uint256,bytes32)', ['uint256', 'uint64', 'uint256', 'bytes32'], [0, 1, 0, 0]],
  ['Undercollateralised(uint256,uint256,uint256,uint64)', ['uint256', 'uint256', 'uint256', 'uint64'], [0, 0, 0, 1]],
  ['ReserveAddressesSet(uint256)', ['uint256'], [0]],
  ['Issued(address,uint256,uint256,bytes32)', ['address', 'uint256', 'uint256', 'bytes32'], [1, 0, 0, 0]],
  ['RedemptionRequested(uint256,address,uint256,string)', ['uint256', 'address', 'uint256', 'string'], [1, 1, 0, 0]],
  ['RedemptionSettled(uint256,bytes32)', ['uint256', 'bytes32'], [1, 1]],
  ['IssuerHandoverBegun(address,address)', ['address', 'address'], [1, 1]],
  ['IssuerChanged(address,address)', ['address', 'address'], [1, 1]],
  ['Transfer(address,address,uint256)', ['address', 'address', 'uint256'], [1, 1, 0]],
  ['Approval(address,address,uint256)', ['address', 'address', 'uint256'], [1, 1, 0]],
];

const EV_BY_TOPIC = new Map(EVENTS.map(([sig, types, indexed]) => [
  abi.topicHash(sig).toString('hex'),
  { name: sig.slice(0, sig.indexOf('(')), types, indexed },
]));

function decodeLogs(logs) {
  return logs.map((l) => {
    const e = EV_BY_TOPIC.get(l.topics[0].toString('hex'));
    if (!e) return { name: null, address: hx(l.address), args: [], raw: l };
    const unindexed = e.types.filter((_, i) => !e.indexed[i]);
    const body = unindexed.length ? abi.decodeParameters(unindexed, l.data) : [];
    let ti = 1, bi = 0;
    const args = e.types.map((t, i) => (e.indexed[i]
      ? abi.decodeParameters([t], l.topics[ti++])[0]
      : body[bi++]));
    return { name: e.name, address: hx(l.address), args, raw: l };
  });
}
const findLog = (logs, name) => decodeLogs(logs).find((l) => l.name === name);
const countLog = (logs, name) => decodeLogs(logs).filter((l) => l.name === name).length;

// ===========================================================================
// the receipt under test
// ===========================================================================

/* A Litecoin receipt, because LTC is the coin the estate has custody machinery for and
 * the one a real phase G would wrap first. EIGHT decimals, matching Litecoin: one unit
 * here is one litoshi, so nothing a holder reads has to be converted before it can be
 * compared with a block explorer. */
const DECIMALS = 8;
const COIN = 100000000n;
const MAX_AGE = 86400n;                       // a day; an attestation older than this mints nothing
const STATEMENT = 'Issued by CloudsForge. Backed by Litecoin held in CloudsForge custody, not by a trustless bridge. Redeemable through CloudsForge.';

const ctorArgs = (overrides = {}) => {
  const a = {
    name: 'Forge Receipt: Litecoin',
    symbol: 'fLTC',
    decimals: BigInt(DECIMALS),
    underlying: 'LTC',
    statement: STATEMENT,
    issuer: ISSUER,
    maxAge: MAX_AGE,
    ...overrides,
  };
  return Buffer.concat([ART.Receipt.code, abi.encodeParameters(
    ['string', 'string', 'uint8', 'string', 'string', 'address', 'uint64'],
    [a.name, a.symbol, a.decimals, a.underlying, a.statement, a.issuer, a.maxAge],
  )]);
};

console.log('ForgeReceipt on the Hearth EVM — a receipt that cannot out-issue its reserve\n');

// ---------------------------------------------------------------------------
group('deployment — and the four ways it refuses to deploy');
// ---------------------------------------------------------------------------

const dReceipt = succeeded(SIM.send({
  from: 'issuer', to: null, data: ctorArgs(), gas: 4000000n, label: 'deploy ForgeReceipt',
}), 'the receipt deploys');
const R = dReceipt.contractAddress;

/* `decimals` and `maxAttestationAge` are immutable: the constructor patches them into the
 * runtime, so the deployed code is NOT byte-identical to solc's — it differs at exactly
 * the placeholder words, which solc leaves as zeros. Anything differing at a non-zero
 * byte would be a code change, which is what this is really checking. */
{
  const onchain = SIM.state.getCode(R);
  ok(onchain.length === ART.Receipt.deployed.length, "the deployed code is the length solc emitted");
  const diffs = [];
  for (let i = 0; i < onchain.length; i++) if (onchain[i] !== ART.Receipt.deployed[i]) diffs.push(i);
  ok(diffs.length > 0 && diffs.every((i) => ART.Receipt.deployed[i] === 0),
    `it differs from solc's output only where solc left an immutable placeholder (${diffs.length} bytes)`);
}
ok(SIM.read(R, 'name()', [], ['string']) === 'Forge Receipt: Litecoin', 'name()');
ok(SIM.read(R, 'symbol()', [], ['string']) === 'fLTC', "symbol() is fLTC, not wLTC — the 'w' would claim a trustlessness this does not have");
ok(SIM.read(R, 'decimals()', [], ['uint8']) === BigInt(DECIMALS), "decimals() is the UNDERLYING's 8, not 18");
ok(SIM.read(R, 'underlying()', [], ['string']) === 'LTC', 'underlying() names the coin this is a claim on');
ok(SIM.read(R, 'issuerStatement()', [], ['string']) === STATEMENT,
  'issuerStatement() names whose promise this is, from the token itself — §4, said in the sentence that offers it');
ok(SIM.read(R, 'issuer()', [], ['address']) === hx(ISSUER), 'issuer() is the deployer-nominated operator');
ok(SIM.read(R, 'maxAttestationAge()', [], ['uint64']) === MAX_AGE, 'maxAttestationAge is fixed at construction and is immutable');
ok(findLog(dReceipt.logs, 'IssuerChanged') !== undefined, 'the constructor announces the issuer rather than setting it silently');

for (const [what, over, why] of [
  ['a zero issuer', { issuer: ZERO }, 'ZERO_ISSUER'],
  ['a zero max age', { maxAge: 0n }, 'ZERO_MAX_AGE'],
  ['no underlying named', { underlying: '' }, 'NO_UNDERLYING'],
  ['no issuer statement', { statement: '' }, 'NO_STATEMENT'],
]) {
  reverted(SIM.send({ from: 'issuer', to: null, data: ctorArgs(over), gas: 4000000n }), why, `deploying with ${what}`);
}

// ---------------------------------------------------------------------------
group('the zero state is the safe state — this is the estate today');
// ---------------------------------------------------------------------------

/* On 2026-08-16 every platform-controlled LTC, BTC and DOGE address has received nothing,
 * ever. A receipt deployed against that reserve must mint nothing, and must do so without
 * anyone remembering to hold it back. */
{
  const [supply, reserve, height, at, fresh] = SIM.read(R, 'coverage()', [], ['uint256', 'uint256', 'uint64', 'uint64', 'bool']);
  ok(supply === 0n && reserve === 0n && height === 0n && at === 0n, 'a fresh receipt has no supply and no attested reserve');
  ok(fresh === false, 'and no attestation, so nothing is fresh');
}
ok(SIM.read(R, 'attestationIsFresh()', [], ['bool']) === false, 'attestationIsFresh() is false before anyone has attested');
reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [ALICE, 1n, word(0)]), gas: 300000n }),
  'STALE_ATTESTATION', 'the issuer minting a single litoshi with no attestation on file');
ok(SIM.read(R, 'totalSupply()', [], ['uint256']) === 0n, 'supply is still zero');

// ---------------------------------------------------------------------------
group('the issuer role is the only privilege, and a stranger has none of it');
// ---------------------------------------------------------------------------

for (const [what, data] of [
  ['attest', call('attest(uint256,uint64,bytes32)', [1000n * COIN, 100n, word(1)])],
  ['issue', call('issue(address,uint256,bytes32)', [STRANGER, 1n, word(0)])],
  ['setReserveAddresses', call('setReserveAddresses(string[])', [['ltc1qfake']])],
  ['settleRedemption', call('settleRedemption(uint256,bytes32)', [0n, word(1)])],
  ['beginIssuerHandover', call('beginIssuerHandover(address)', [STRANGER])],
]) {
  reverted(SIM.send({ from: 'stranger', to: R, data, gas: 300000n }), 'NOT_ISSUER', `a stranger calling ${what}`);
}

/* The properties that make "we cannot halt or confiscate you" checkable rather than
 * stated. An ABI with no pause and a bytecode with no DELEGATECALL are things a stranger
 * verifies from the deployed artifact; a policy page is not. */
{
  const fns = ART.Receipt.abi.filter((e) => e.type === 'function').map((e) => e.name);
  const censorship = fns.filter((n) => /pause|freeze|frozen|blacklist|blocklist|seize|confiscate|recover|rescue|upgrade|implementation|forceTransfer|burnFrom|sweep/i.test(n));
  ok(censorship.length === 0, `the ABI has no pause, freeze, blacklist or upgrade entry point (found: ${censorship.join(', ') || 'none'})`);
  ok(!fns.includes('mint'), 'there is no mint() — the only way supply rises is issue(), which is gated on the reserve');

  /* A real opcode walk, skipping PUSH immediates: scanning raw bytes would match data. */
  const present = new Set();
  const code = ART.Receipt.deployed;
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    present.add(op);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  ok(!present.has(0xf4), 'the deployed code contains no DELEGATECALL, so its behaviour cannot be swapped out underneath a holder');
  ok(!present.has(0xff), 'and no SELFDESTRUCT, so it cannot be removed from under one either');
  ok(!present.has(0xf0) && !present.has(0xf5), 'and it deploys nothing, so there is no second contract to reason about');
}

// ---------------------------------------------------------------------------
group('the reserve is published by the token, not by us');
// ---------------------------------------------------------------------------

/* Real-shaped Litecoin addresses. The contract cannot verify them and does not pretend
 * to — what it does is put them where a stranger reads them without our cooperation. */
const RESERVE_ADDRS = [
  'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'LcHKX2cWJXd8HZ7kn7VZzvNJhFrHkNPHfB',
  'MJRSgZ3UhaAt4pbCvcAZzHTiTHVSEbcHVi',
];

reverted(SIM.send({ from: 'issuer', to: R, data: call('setReserveAddresses(string[])', [['ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', '']]), gas: 400000n }),
  'EMPTY_ADDRESS', 'publishing an empty string as a backing address');

const setAddrs = succeeded(SIM.send({
  from: 'issuer', to: R, data: call('setReserveAddresses(string[])', [RESERVE_ADDRS]), gas: 500000n, label: 'publish reserve addresses',
}), 'the issuer publishes the backing addresses');
{
  const ev = findLog(setAddrs.logs, 'ReserveAddressesSet');
  ok(!!ev && ev.args[0] === 3n, 'the event carries the count, so a watcher sees a change without reading the array');
  ok(SIM.read(R, 'reserveAddressCount()', [], ['uint256']) === 3n, 'three addresses are published');
  const got = SIM.read(R, 'reserveAddresses()', [], ['string[]']);
  ok(JSON.stringify(got) === JSON.stringify(RESERVE_ADDRS), 'reserveAddresses() returns them verbatim — one eth_call, no API of ours in the path');
  ok(SIM.read(R, 'reserveAddressAt(uint256)', [1n], ['string']) === RESERVE_ADDRS[1], 'reserveAddressAt reads one without pulling the array');
  ok(SIM.readRevert(R, 'reserveAddressAt(uint256)', [3n]).includes('NO_SUCH_ADDRESS'), 'and refuses an index past the end');
}

/* Custody rotates keys. If the list were append-only a stranger could not tell which
 * entries still hold anything, so the setter replaces. */
{
  succeeded(SIM.send({ from: 'issuer', to: R, data: call('setReserveAddresses(string[])', [RESERVE_ADDRS.slice(0, 2)]), gas: 500000n, label: 'rotate' }),
    'the list is replaced when custody rotates');
  ok(SIM.read(R, 'reserveAddressCount()', [], ['uint256']) === 2n, 'the retired address is gone, not left standing as backing');
  succeeded(SIM.send({ from: 'issuer', to: R, data: call('setReserveAddresses(string[])', [RESERVE_ADDRS]), gas: 500000n }), 'and can be set back');
}

// ---------------------------------------------------------------------------
group('attestation — a figure, a height, and no way to replay an old one');
// ---------------------------------------------------------------------------

const RESERVE_1 = 1250n * COIN;                       // 1,250 LTC at height 2,800,000
const HEIGHT_1 = 2800000n;
const REF_1 = keccak256(Buffer.from('reconciliation run 2026-08-16T09:00Z', 'utf8'));

const att1 = succeeded(SIM.send({
  from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [RESERVE_1, HEIGHT_1, REF_1]),
  gas: 200000n, label: 'attest',
}), 'the issuer attests to the reserve');
{
  const ev = findLog(att1.logs, 'Attested');
  ok(!!ev && ev.args[0] === RESERVE_1 && ev.args[1] === HEIGHT_1 && ev.args[2] === 0n && ev.args[3] === hx(REF_1),
    'Attested carries the figure, the underlying-chain height, the supply at the time, and the reference');
  ok(countLog(att1.logs, 'Undercollateralised') === 0, 'a fully covered attestation announces no shortfall');

  const [supply, reserve, height, at, fresh] = SIM.read(R, 'coverage()', [], ['uint256', 'uint256', 'uint64', 'uint64', 'bool']);
  ok(supply === 0n && reserve === RESERVE_1 && height === HEIGHT_1, 'coverage() answers the whole question in one call');
  ok(at === SIM.timestamp - 15n, '…including when it was recorded on this chain');
  ok(fresh === true, '…and whether that is recent enough to authorise issuance');
}

/* Without this, the issuer could keep re-publishing a favourable old reading after the
 * coins moved, and every freshness check would pass on a figure about the past. */
reverted(SIM.send({ from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [RESERVE_1, HEIGHT_1, REF_1]), gas: 200000n }),
  'STALE_HEIGHT', 're-attesting at the same height');
reverted(SIM.send({ from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [9999n * COIN, HEIGHT_1 - 1n, REF_1]), gas: 200000n }),
  'STALE_HEIGHT', 'attesting at a height already passed');

// ---------------------------------------------------------------------------
group('redemption exists and works BEFORE anything is issued — §4, in that order');
// ---------------------------------------------------------------------------

/* §4: "The redemption path must exist and be exercised before issuance, not after."
 * Nothing has been minted yet, so the only way to exercise it is to prove that every
 * refusal is a refusal — and then, the moment supply exists, to burn it back out before
 * the suite does anything else with it. */
reverted(SIM.send({ from: 'alice', to: R, data: call('redeem(uint256,string)', [1n, 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4']), gas: 400000n }),
  'INSUFFICIENT_BALANCE', 'redeeming what you do not hold');
ok(SIM.read(R, 'redemptionCount()', [], ['uint256']) === 0n, 'and no redemption was recorded for it');

// ---------------------------------------------------------------------------
group('issuance is bounded by the attestation, in the EVM');
// ---------------------------------------------------------------------------

reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [ALICE, RESERVE_1 + 1n, word(0)]), gas: 300000n }),
  'EXCEEDS_RESERVE', 'issuing one litoshi more than has been attested');
reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [ZERO, 1n, word(0)]), gas: 300000n }),
  'ZERO_RECIPIENT', 'issuing to the zero address');
reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [ALICE, 0n, word(0)]), gas: 300000n }),
  'ZERO_AMOUNT', 'issuing nothing');

const REF_ISSUE = keccak256(Buffer.from('deposit ltc:mainnet:0001', 'utf8'));
const FIRST = 1000n * COIN;
const iss1 = succeeded(SIM.send({
  from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [ALICE, FIRST, REF_ISSUE]),
  gas: 300000n, label: 'issue',
}), 'issuing within the attested reserve');
{
  ok(SIM.read(R, 'balanceOf(address)', [ALICE], ['uint256']) === FIRST, 'alice holds 1,000 fLTC');
  ok(SIM.read(R, 'totalSupply()', [], ['uint256']) === FIRST, 'and supply is exactly that');
  const t = findLog(iss1.logs, 'Transfer');
  ok(!!t && t.args[0] === hx(ZERO) && t.args[1] === hx(ALICE) && t.args[2] === FIRST, 'a Transfer from the zero address, so every indexer sees the mint');
  const ev = findLog(iss1.logs, 'Issued');
  ok(!!ev && ev.args[2] === FIRST && ev.args[3] === hx(REF_ISSUE), 'Issued records the supply after and the deposit it answers');
}

/* The boundary itself. Anything short of exact here would be a rounding hole in the one
 * inequality the whole contract exists to enforce. */
const REMAINDER = RESERVE_1 - FIRST;
reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [BOB, REMAINDER + 1n, word(0)]), gas: 300000n }),
  'EXCEEDS_RESERVE', 'issuing one litoshi past the remaining headroom');
succeeded(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [BOB, REMAINDER, word(0)]), gas: 300000n, label: 'issue to the exact reserve' }),
  'issuing exactly up to the attested reserve');
ok(SIM.read(R, 'totalSupply()', [], ['uint256']) === RESERVE_1, 'supply now equals the attested reserve to the litoshi');
reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [BOB, 1n, word(0)]), gas: 300000n }),
  'EXCEEDS_RESERVE', 'and one more litoshi at full coverage');

// ---------------------------------------------------------------------------
group('a redemption completes — burn first, publicly, then the underlying txid');
// ---------------------------------------------------------------------------

const PAYOUT = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const REDEEM = 250n * COIN;

reverted(SIM.send({ from: 'alice', to: R, data: call('redeem(uint256,string)', [REDEEM, '']), gas: 400000n }),
  'BAD_PAYOUT_ADDRESS', 'redeeming to an empty payout address');
reverted(SIM.send({ from: 'alice', to: R, data: call('redeem(uint256,string)', [REDEEM, 'L'.repeat(129)]), gas: 600000n }),
  'BAD_PAYOUT_ADDRESS', 'redeeming to a 129-character payout address');
reverted(SIM.send({ from: 'alice', to: R, data: call('redeem(uint256,string)', [0n, PAYOUT]), gas: 400000n }),
  'ZERO_AMOUNT', 'redeeming nothing');

const supplyBefore = SIM.read(R, 'totalSupply()', [], ['uint256']);
const red = succeeded(SIM.send({
  from: 'alice', to: R, data: call('redeem(uint256,string)', [REDEEM, PAYOUT]), gas: 500000n, label: 'redeem',
}), 'alice redeems 250 fLTC');
{
  ok(SIM.read(R, 'balanceOf(address)', [ALICE], ['uint256']) === FIRST - REDEEM, 'her balance fell by exactly what she redeemed');
  ok(SIM.read(R, 'totalSupply()', [], ['uint256']) === supplyBefore - REDEEM,
    'and supply fell with it — the burn is immediate, so a redemption in flight can only leave the book over-covered');
  const t = findLog(red.logs, 'Transfer');
  ok(!!t && t.args[0] === hx(ALICE) && t.args[1] === hx(ZERO) && t.args[2] === REDEEM, 'a Transfer to the zero address records the burn');
  const ev = findLog(red.logs, 'RedemptionRequested');
  ok(!!ev && ev.args[0] === 0n && ev.args[1] === hx(ALICE) && ev.args[2] === REDEEM && ev.args[3] === PAYOUT,
    'RedemptionRequested carries the id, the holder, the amount and where they want the Litecoin sent');
}

const RID = 0n;
{
  ok(SIM.read(R, 'redemptionCount()', [], ['uint256']) === 1n, 'the redemption is recorded');
  const [holder, amount, payout, requestedAt, txid] = SIM.read(R, 'redemption(uint256)', [RID], ['address', 'uint256', 'string', 'uint64', 'bytes32']);
  ok(holder === hx(ALICE) && amount === REDEEM && payout === PAYOUT, 'redemption(0) reads back what was asked for');
  ok(requestedAt === SIM.timestamp - 15n, '…and when');
  ok(txid === hx(Buffer.alloc(32)), '…and that nobody has claimed to have paid it yet');
  const [count, owed] = SIM.read(R, 'unsettledRedemptions()', [], ['uint256', 'uint256']);
  ok(count === 1n && owed === REDEEM,
    'unsettledRedemptions() is what a stranger watches: burnt supply with no payment claimed against it');
}

reverted(SIM.send({ from: 'issuer', to: R, data: call('settleRedemption(uint256,bytes32)', [RID, word(0)]), gas: 200000n }),
  'ZERO_TXID', 'settling with no transaction id');
reverted(SIM.send({ from: 'issuer', to: R, data: call('settleRedemption(uint256,bytes32)', [1n, word(1)]), gas: 200000n }),
  'NO_SUCH_REDEMPTION', 'settling a redemption that does not exist');

const TXID = keccak256(Buffer.from('a litecoin transaction id', 'utf8'));
const settle = succeeded(SIM.send({
  from: 'issuer', to: R, data: call('settleRedemption(uint256,bytes32)', [RID, TXID]), gas: 200000n, label: 'settle',
}), 'the issuer records the Litecoin transaction that paid it');
{
  const ev = findLog(settle.logs, 'RedemptionSettled');
  ok(!!ev && ev.args[0] === RID && ev.args[1] === hx(TXID), 'RedemptionSettled points at the transaction on the other chain');
  const [, , , , txid] = SIM.read(R, 'redemption(uint256)', [RID], ['address', 'uint256', 'string', 'uint64', 'bytes32']);
  ok(txid === hx(TXID), 'the claim is permanent and checkable by anyone who can read Litecoin');
  const [count, owed] = SIM.read(R, 'unsettledRedemptions()', [], ['uint256', 'uint256']);
  ok(count === 0n && owed === 0n, 'and nothing is outstanding');
}
reverted(SIM.send({ from: 'issuer', to: R, data: call('settleRedemption(uint256,bytes32)', [RID, keccak256(Buffer.from('a different txid', 'utf8'))]), gas: 200000n }),
  'ALREADY_SETTLED', 'settling the same redemption twice');

// ---------------------------------------------------------------------------
group('a stale attestation stops issuance by itself');
// ---------------------------------------------------------------------------

/* "We forgot to re-attest" and "we are hiding a shortfall" have to have the same effect,
 * because from outside they are indistinguishable. */
SIM.timestamp += MAX_AGE;                    // one second past the window, once send() adds its 15
ok(SIM.read(R, 'attestationIsFresh()', [], ['bool']) === false, 'past maxAttestationAge the attestation stops authorising anything');
reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [ALICE, 1n, word(0)]), gas: 300000n }),
  'STALE_ATTESTATION', 'issuing against a day-old attestation');

/* And the thing that must NOT stop: the exit. Issuance is frozen; alice leaves anyway. */
const exitWhileFrozen = succeeded(SIM.send({
  from: 'alice', to: R, data: call('redeem(uint256,string)', [50n * COIN, PAYOUT]), gas: 500000n, label: 'redeem while frozen',
}), 'a holder can still redeem while issuance is frozen — the only lever we have is issuance');
ok(!!findLog(exitWhileFrozen.logs, 'RedemptionRequested'), 'and it is recorded like any other');
succeeded(SIM.send({ from: 'alice', to: R, data: call('transfer(address,uint256)', [BOB, 1n * COIN]), gas: 200000n, label: 'transfer while frozen' }),
  '…and can still transfer');

const HEIGHT_2 = HEIGHT_1 + 1000n;
succeeded(SIM.send({ from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [RESERVE_1, HEIGHT_2, word(2)]), gas: 200000n, label: 're-attest' }),
  'a fresh reading at a higher height');
ok(SIM.read(R, 'attestationIsFresh()', [], ['bool']) === true, 'restores issuance');

// ---------------------------------------------------------------------------
group('a shortfall can be recorded, and recording it stops issuance');
// ---------------------------------------------------------------------------

/* Refusing to record bad news would leave the last honest number standing as the current
 * one. That is the failure this whole design is trying not to have, so `attest` takes a
 * reserve below supply, says so, and lets the inequality do the rest. */
const supplyNow = SIM.read(R, 'totalSupply()', [], ['uint256']);
const SHORT = supplyNow - 10n * COIN;
const bad = succeeded(SIM.send({
  from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [SHORT, HEIGHT_2 + 1n, word(3)]),
  gas: 200000n, label: 'attest a shortfall',
}), 'the issuer records a reserve BELOW the supply');
{
  const ev = findLog(bad.logs, 'Undercollateralised');
  ok(!!ev && ev.args[0] === SHORT && ev.args[1] === supplyNow && ev.args[2] === 10n * COIN,
    'Undercollateralised announces the reserve, the supply and the exact shortfall');
  const [supply, reserve] = SIM.read(R, 'coverage()', [], ['uint256', 'uint256', 'uint64', 'uint64', 'bool']);
  ok(reserve < supply, 'coverage() reports the truth rather than the last good number');
}
reverted(SIM.send({ from: 'issuer', to: R, data: call('issue(address,uint256,bytes32)', [ALICE, 1n, word(0)]), gas: 300000n }),
  'EXCEEDS_RESERVE', 'issuing while under-collateralised — even with a perfectly fresh attestation');
succeeded(SIM.send({ from: 'bob', to: R, data: call('redeem(uint256,string)', [1n * COIN, PAYOUT]), gas: 500000n, label: 'redeem while short' }),
  'a holder can still leave while the book is short — which is when they most want to');

succeeded(SIM.send({ from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [RESERVE_1, HEIGHT_2 + 2n, word(4)]), gas: 200000n }),
  'the shortfall is repaired by attesting to the repaired reserve');

// ---------------------------------------------------------------------------
group('ERC-20 mechanics, and the transfer that is refused on purpose');
// ---------------------------------------------------------------------------

{
  const before = SIM.read(R, 'balanceOf(address)', [BOB], ['uint256']);
  succeeded(SIM.send({ from: 'alice', to: R, data: call('transfer(address,uint256)', [BOB, 5n * COIN]), gas: 200000n, label: 'transfer' }), 'a transfer');
  ok(SIM.read(R, 'balanceOf(address)', [BOB], ['uint256']) === before + 5n * COIN, 'moves the balance');

  succeeded(SIM.send({ from: 'bob', to: R, data: call('approve(address,uint256)', [ALICE, 3n * COIN]), gas: 200000n }), 'an approval');
  ok(SIM.read(R, 'allowance(address,address)', [BOB, ALICE], ['uint256']) === 3n * COIN, 'sets the allowance');
  succeeded(SIM.send({ from: 'alice', to: R, data: call('transferFrom(address,address,uint256)', [BOB, ALICE, 2n * COIN]), gas: 200000n }), 'transferFrom within it');
  ok(SIM.read(R, 'allowance(address,address)', [BOB, ALICE], ['uint256']) === 1n * COIN, 'decrements it');

  /* An underflow panic, not a string revert — the reason is a Panic(0x11), so this checks
   * the status rather than the text. */
  const over = SIM.send({ from: 'alice', to: R, data: call('transferFrom(address,address,uint256)', [BOB, ALICE, 2n * COIN]), gas: 200000n });
  ok(over.status !== receipt.SUCCESS, 'and spending past it fails');

  const MAX = (1n << 256n) - 1n;
  succeeded(SIM.send({ from: 'bob', to: R, data: call('approve(address,uint256)', [ALICE, MAX]), gas: 200000n }), 'an infinite approval');
  succeeded(SIM.send({ from: 'alice', to: R, data: call('transferFrom(address,address,uint256)', [BOB, ALICE, 1n * COIN]), gas: 200000n }), 'spending against it');
  ok(SIM.read(R, 'allowance(address,address)', [BOB, ALICE], ['uint256']) === MAX, 'leaves it infinite');
}

/* Burning through `transfer` would move supply without a redemption record — exactly the
 * accounting hole `redeem` exists to close, and the one that would break doc 35's identity
 * quietly. */
reverted(SIM.send({ from: 'alice', to: R, data: call('transfer(address,uint256)', [ZERO, 1n]), gas: 200000n }),
  'ZERO_RECIPIENT', 'transferring to the zero address');

// ---------------------------------------------------------------------------
group('permit — so a holder does not need EMBER before they can act');
// ---------------------------------------------------------------------------

{
  const DOMAIN = hex(SIM.read(R, 'DOMAIN_SEPARATOR()', [], ['bytes32']));
  const expect = keccak256(Buffer.concat([
    abi.topicHash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    keccak256(Buffer.from('Forge Receipt: Litecoin', 'utf8')),
    keccak256(Buffer.from('1', 'utf8')),
    word(SIM.env().chainId),
    addrWord(R),
  ]));
  ok(hx(DOMAIN) === hx(expect), 'the domain separator binds this chain and this token, so a signature cannot be replayed onto another');

  const PERMIT_TYPEHASH = abi.topicHash('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');
  const nonce = SIM.read(R, 'nonces(address)', [ALICE], ['uint256']);
  const deadline = SIM.timestamp + 3600n;
  const structHash = keccak256(Buffer.concat([PERMIT_TYPEHASH, addrWord(ALICE), addrWord(BOB), word(9n * COIN), word(nonce), word(deadline)]));
  const digest = keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), DOMAIN, structHash]));
  const sig = secp.sign(digest, KEY.alice);

  succeeded(SIM.send({
    from: 'bob', to: R, gas: 200000n, label: 'permit',
    data: call('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
      [ALICE, BOB, 9n * COIN, deadline, BigInt(27 + sig.recoveryId), word(sig.r), word(sig.s)]),
  }), 'a permit signed by alice and submitted by bob');
  ok(SIM.read(R, 'allowance(address,address)', [ALICE, BOB], ['uint256']) === 9n * COIN, 'sets the allowance without alice sending a transaction');
  ok(SIM.read(R, 'nonces(address)', [ALICE], ['uint256']) === nonce + 1n, 'and burns the nonce, so it cannot be replayed');

  reverted(SIM.send({
    from: 'bob', to: R, gas: 200000n,
    data: call('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
      [ALICE, BOB, 9n * COIN, deadline, BigInt(27 + sig.recoveryId), word(sig.r), word(sig.s)]),
  }), 'INVALID_SIGNATURE', 'replaying the same permit');

  const stale = SIM.timestamp - 1n;
  reverted(SIM.send({
    from: 'bob', to: R, gas: 200000n,
    data: call('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
      [ALICE, BOB, 1n, stale, BigInt(27 + sig.recoveryId), word(sig.r), word(sig.s)]),
  }), 'EXPIRED', 'a permit past its deadline');
}

// ---------------------------------------------------------------------------
group('the issuer is an m-of-n, and taking the role requires accepting it');
// ---------------------------------------------------------------------------

/* Phase A put `feeToSetter` behind a multisig because a single key holding the one
 * privileged role in the DEX is the whole risk. The role that decides how much of a
 * receipt exists is a strictly larger one, so it goes to the same place. */
const dMultisig = succeeded(SIM.send({
  from: 's1', to: null,
  data: Buffer.concat([ART.Multisig.code, abi.encodeParameters(['address[]', 'uint256'], [[S1, S2, S3], 2n])]),
  gas: 3000000n, label: 'deploy HearthMultisig',
}), 'a 2-of-3 deploys');
const M = dMultisig.contractAddress;

/* §2's trap 2 is the estate's own scar: a one-call handover to an address nobody holds is
 * unrecoverable. Here the successor has to act, so a fat-fingered address is a no-op. */
const begun = succeeded(SIM.send({ from: 'issuer', to: R, data: call('beginIssuerHandover(address)', [STRANGER]), gas: 200000n, label: 'begin handover' }),
  'the issuer nominates a successor');
ok(!!findLog(begun.logs, 'IssuerHandoverBegun'), 'the nomination is announced');
ok(SIM.read(R, 'issuer()', [], ['address']) === hx(ISSUER), 'and changes nothing yet');
reverted(SIM.send({ from: 'alice', to: R, data: call('acceptIssuer()', []), gas: 200000n }), 'NOT_PENDING_ISSUER', 'somebody else accepting');

succeeded(SIM.send({ from: 'issuer', to: R, data: call('beginIssuerHandover(address)', [M]), gas: 200000n, label: 'renominate' }),
  'a mistaken nomination is simply overwritten');
succeeded(SIM.send({ from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [RESERVE_1, HEIGHT_2 + 10n, word(5)]), gas: 200000n }),
  'and the outgoing issuer still works until the successor accepts');

/** Propose through the wallet, confirm to the threshold, execute. Returns the id. */
function multisigDo(target, data, label, { confirmations = ['s2'] } = {}) {
  const id = SIM.read(M, 'transactionCount()', [], ['uint256']);
  succeeded(SIM.send({ from: 's1', to: M, data: call('submitTransaction(address,uint256,bytes)', [target, 0n, data]), gas: 600000n, label }),
    `s1 proposes ${label}`);
  for (const who of confirmations) {
    succeeded(SIM.send({ from: who, to: M, data: call('confirmTransaction(uint256)', [id]), gas: 300000n }), `${who} confirms ${label}`);
  }
  return id;
}

{
  const id = multisigDo(R, call('acceptIssuer()', []), 'accepting the issuer role');
  succeeded(SIM.send({ from: 's2', to: M, data: call('executeTransaction(uint256)', [id]), gas: 600000n, label: 'execute acceptIssuer' }),
    'the multisig accepts the role, 2 of 3');
  ok(SIM.read(R, 'issuer()', [], ['address']) === hx(M), 'the issuer is now a contract no single person can operate');
  ok(SIM.read(R, 'pendingIssuer()', [], ['address']) === hx(ZERO), 'and the nomination is cleared');
}

reverted(SIM.send({ from: 'issuer', to: R, data: call('attest(uint256,uint64,bytes32)', [9999n * COIN, HEIGHT_2 + 20n, word(6)]), gas: 200000n }),
  'NOT_ISSUER', 'the former issuer attesting after the handover');

/* One signer is not the issuer. This is the phase-G gate stated as a transaction: the
 * reserve figure that bounds every mint cannot be moved by one key. */
{
  const before = SIM.read(R, 'attestation()', [], ['uint256', 'uint64', 'uint64', 'bytes32']);
  const id = multisigDo(R, call('attest(uint256,uint64,bytes32)', [2000n * COIN, HEIGHT_2 + 30n, word(7)]), 'an attestation', { confirmations: [] });
  reverted(SIM.send({ from: 's1', to: M, data: call('executeTransaction(uint256)', [id]), gas: 600000n }),
    'NOT_ENOUGH_CONFIRMATIONS', 'one signer alone executing the attestation');
  const after = SIM.read(R, 'attestation()', [], ['uint256', 'uint64', 'uint64', 'bytes32']);
  ok(after[0] === before[0] && after[1] === before[1], 'the attested reserve did not move');

  succeeded(SIM.send({ from: 's3', to: M, data: call('confirmTransaction(uint256)', [id]), gas: 300000n }), 's3 confirms');
  succeeded(SIM.send({ from: 's3', to: M, data: call('executeTransaction(uint256)', [id]), gas: 600000n, label: 'execute attest' }),
    'two signers move it');
  ok(SIM.read(R, 'attestation()', [], ['uint256', 'uint64', 'uint64', 'bytes32'])[0] === 2000n * COIN, 'and the new reserve is what they signed');
}

{
  const supply = SIM.read(R, 'totalSupply()', [], ['uint256']);
  const id = multisigDo(R, call('issue(address,uint256,bytes32)', [ALICE, 1n * COIN, word(8)]), 'an issuance');
  succeeded(SIM.send({ from: 's2', to: M, data: call('executeTransaction(uint256)', [id]), gas: 600000n, label: 'execute issue' }),
    'the multisig issues');
  ok(SIM.read(R, 'totalSupply()', [], ['uint256']) === supply + 1n * COIN, 'and supply moved by exactly what was signed for');
}

/* The disaster-recovery path a runbook needs: the role can leave a compromised multisig
 * for a successor one, and again only if the successor accepts. */
{
  const id = multisigDo(R, call('beginIssuerHandover(address)', [ISSUER]), 'handing the role back');
  succeeded(SIM.send({ from: 's2', to: M, data: call('executeTransaction(uint256)', [id]), gas: 600000n, label: 'execute handover' }), 'the multisig nominates a successor');
  ok(SIM.read(R, 'issuer()', [], ['address']) === hx(M), 'and still holds the role until that successor accepts');
  succeeded(SIM.send({ from: 'issuer', to: R, data: call('acceptIssuer()', []), gas: 200000n, label: 'accept back' }), 'the successor accepts');
  ok(SIM.read(R, 'issuer()', [], ['address']) === hx(ISSUER), 'the role has moved');
}

// ---------------------------------------------------------------------------
group('what a stranger can compute, with one node and no cooperation from us');
// ---------------------------------------------------------------------------

/* The phase gate, restated as arithmetic anybody can do: read the token, read the other
 * chain at the height the token names, and compare. Nothing here needs an API of ours. */
{
  const [supply, reserve, height] = SIM.read(R, 'coverage()', [], ['uint256', 'uint256', 'uint64', 'uint64', 'bool']);
  const addrs = SIM.read(R, 'reserveAddresses()', [], ['string[]']);
  const [unsettledCount, unsettledAmount] = SIM.read(R, 'unsettledRedemptions()', [], ['uint256', 'uint256']);
  ok(addrs.length > 0, `the addresses to check are on-chain (${addrs.length} of them)`);
  ok(reserve >= supply, `issued ${supply} <= attested ${reserve} at underlying height ${height}`);
  ok(unsettledCount === 2n && unsettledAmount === 51n * COIN,
    'and the one thing left owed is visible as burnt supply with no payment claimed — 51 LTC across 2 redemptions');
  ok(SIM.read(R, 'issuerStatement()', [], ['string']).includes('not by a trustless bridge'),
    'while the token itself says, in the sentence a wallet would show, that it is a custodial claim');
}

// ---------------------------------------------------------------------------
console.log(`\n${counts.fail === 0 ? 'PASS' : 'FAIL'} — ${counts.pass}/${counts.pass + counts.fail} checks`);
process.exit(counts.fail === 0 ? 0 : 1);
