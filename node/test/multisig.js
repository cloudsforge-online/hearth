'use strict';
/* HearthMultisig on our own EVM — phase A's gate (docs/ecosystem/39-forge-exchange.md §7).
 *
 * `HearthV2Factory.feeToSetter` is the one privileged role in the DEX, it has no
 * timelock and no two-step handover, and moving it off a compromised key requires that
 * key. So it has to be a contract no single person can operate FROM THE MOMENT THE
 * FACTORY IS DEPLOYED. `HearthMultisig` is that contract, and this file is the evidence
 * that it works — not that it compiles, which `contracts/test/build.test.mjs` already
 * covers, but that a call really does wait for m signatures on a real state transition.
 *
 * The phase gate is two sentences long: *signers rotate and a threshold change succeeds
 * on the in-process harness*. Both are here, and so is the thing that makes them worth
 * anything:
 *
 *   1. One confirmation short does not execute, and the shortfall is the revert.
 *   2. m confirmations do, and the target's state actually moved.
 *   3. A rotated-out signer's EXISTING confirmation stops counting. This is the whole
 *      reason `confirmationCount` walks the owner list instead of keeping a tally — a
 *      cached count would leave a departed key holding a vote, which is exactly what
 *      removing them was for.
 *   4. A threshold raised to n is immediately binding on proposals that were already
 *      confirmed under the old one.
 *   5. Owner and threshold changes cannot be reached except through the wallet itself,
 *      so there is no 1-of-n path to a 1-of-n.
 *   6. A real `HearthV2Factory` deployed with the multisig as `feeToSetter`: the EOA
 *      that deployed it is refused, the multisig is obeyed, and the role can be handed
 *      to a successor multisig — which is the disaster-recovery path a runbook needs.
 *
 * As with dex.js there is no chain here: signed legacy transactions straight through
 * `chain/statetransition.js` against a fresh StateDB. Run it against built artifacts:
 *
 *     pnpm --dir contracts install && pnpm --dir contracts compile
 *     node node/test/multisig.js         # --trace for the opcode trace of a failure
 */

const {
  Sim, reporter, artifact,
  hex, hx, ETHER,
  abi,
} = require('./evmsim');

const WANT_TRACE = process.argv.includes('--trace');

const ART = {
  Multisig: artifact('HearthMultisig'),
  Factory: artifact('HearthV2Factory'),
};

// ===========================================================================
// accounts
// ===========================================================================

/* Three signers on three keys. The point of the contract is that these are three
 * people on three devices; the point of the *test* is only that they are three
 * distinct senders, because the contract cannot tell the difference and neither can
 * the chain. Who really holds them is §8's open question, not this file's. */
const KEY = {
  alice: hex('a1'.repeat(32)),
  bob: hex('b0'.repeat(32)),
  carol: hex('c1'.repeat(32)),
  dave: hex('da'.repeat(32)),
  stranger: hex('57'.repeat(32)),
};

const SIM = new Sim({ keys: KEY });
const { counts, ok, group, succeeded, reverted } = reporter(SIM, { trace: WANT_TRACE });
const { alice: ALICE, bob: BOB, carol: CAROL, dave: DAVE, stranger: STRANGER } = SIM.ADDR;

const BENEFICIARY = hex('be'.repeat(20));
const FEE_COLLECTOR = hex('fe'.repeat(20));
const ZERO = Buffer.alloc(20);

const call = (sig, args = []) => abi.encodeCall(abi.resolveFunction(null, sig), args);

console.log('HearthMultisig on the Hearth EVM — the m-of-n that holds feeToSetter\n');

for (const a of [ALICE, BOB, CAROL, DAVE, STRANGER]) SIM.fund(a, 10000n * ETHER);

// ---------------------------------------------------------------------------
group('deployment — a 2-of-3');
// ---------------------------------------------------------------------------

const dMultisig = succeeded(SIM.send({
  from: 'alice',
  to: null,
  data: Buffer.concat([ART.Multisig.code, abi.encodeParameters(['address[]', 'uint256'], [[ALICE, BOB, CAROL], 2n])]),
  gas: 3000000n,
  label: 'deploy HearthMultisig',
}), 'the multisig deploys');
const M = dMultisig.contractAddress;

ok(SIM.state.getCode(M).equals(ART.Multisig.deployed), "the deployed code is byte-identical to solc's output");
ok(SIM.read(M, 'required()', [], ['uint256']) === 2n, 'required is 2');
ok(SIM.read(M, 'ownerCount()', [], ['uint256']) === 3n, 'there are three owners');
ok(SIM.read(M, 'MAX_OWNERS()', [], ['uint256']) === 20n, 'MAX_OWNERS bounds the loop that counts confirmations');

const ownersNow = () => SIM.read(M, 'owners()', [], ['address[]']).map((a) => a.toLowerCase());
ok(
  JSON.stringify(ownersNow()) === JSON.stringify([ALICE, BOB, CAROL].map(hx)),
  'owners() lists the three keys the constructor was given, in order',
);
for (const [who, addr] of [['alice', ALICE], ['bob', BOB], ['carol', CAROL]]) {
  ok(SIM.read(M, 'isOwner(address)', [addr], ['bool']) === true, `${who} is an owner`);
}
ok(SIM.read(M, 'isOwner(address)', [STRANGER], ['bool']) === false, 'the stranger is not');

/* A duplicate in the constructor is one key holding two of the three confirmations —
 * a 2-of-3 that is really a 1-of-2. It is rejected at construction because after
 * construction there is nothing to reject it with. */
const dupDeploy = SIM.send({
  from: 'alice',
  to: null,
  data: Buffer.concat([ART.Multisig.code, abi.encodeParameters(['address[]', 'uint256'], [[ALICE, BOB, ALICE], 2n])]),
  gas: 3000000n,
});
reverted(dupDeploy, 'DUPLICATE_OWNER', 'deploying with a repeated owner');

const overDeploy = SIM.send({
  from: 'alice',
  to: null,
  data: Buffer.concat([ART.Multisig.code, abi.encodeParameters(['address[]', 'uint256'], [[ALICE, BOB], 3n])]),
  gas: 3000000n,
});
reverted(overDeploy, 'BAD_REQUIRED', 'deploying with a threshold above the owner count');

// ---------------------------------------------------------------------------
group('the wallet holds EMBER, and a stranger has no way in');
// ---------------------------------------------------------------------------

const ENDOWMENT = 100n * ETHER;
const dep = succeeded(SIM.send({ from: 'alice', to: M, value: ENDOWMENT, gas: 100000n, label: 'fund the wallet' }), 'a plain transfer to the wallet');
ok(SIM.state.getBalance(M) === ENDOWMENT, 'the wallet holds the EMBER it was sent');
ok(dep.logs.length === 1, 'receive() emitted a Deposit');

for (const [what, data] of [
  ['submitTransaction', call('submitTransaction(address,uint256,bytes)', [BENEFICIARY, 1n, Buffer.alloc(0)])],
  ['confirmTransaction', call('confirmTransaction(uint256)', [0n])],
  ['executeTransaction', call('executeTransaction(uint256)', [0n])],
]) {
  reverted(SIM.send({ from: 'stranger', to: M, data, gas: 300000n }), 'NOT_OWNER', `a stranger calling ${what}`);
}

/* The one that would matter most. If these were `onlyOwner` the contract would be a
 * 2-of-3 for spending and a 1-of-3 for changing who spends, which is not a multisig. */
for (const [what, data] of [
  ['addOwner', call('addOwner(address)', [DAVE])],
  ['removeOwner', call('removeOwner(address)', [CAROL])],
  ['replaceOwner', call('replaceOwner(address,address)', [CAROL, DAVE])],
  ['changeRequirement', call('changeRequirement(uint256)', [1n])],
]) {
  reverted(SIM.send({ from: 'alice', to: M, data, gas: 300000n }), 'NOT_WALLET', `an owner calling ${what} directly`);
}

// ---------------------------------------------------------------------------
group('m of n — one confirmation short is not the same as approved');
// ---------------------------------------------------------------------------

/** Propose, and return the id. `submitTransaction` auto-confirms for the submitter. */
function propose(from, to, value, data, label) {
  const before = SIM.read(M, 'transactionCount()', [], ['uint256']);
  succeeded(SIM.send({ from, to: M, data: call('submitTransaction(address,uint256,bytes)', [to, value, data]), gas: 500000n, label }),
    `${from} proposes ${label}`);
  const after = SIM.read(M, 'transactionCount()', [], ['uint256']);
  ok(after === before + 1n, `${label} is recorded as one proposal`);
  return before;
}
const confirmations = (id) => SIM.read(M, 'confirmationCount(uint256)', [id], ['uint256']);
const confirmed = (id) => SIM.read(M, 'isConfirmed(uint256)', [id], ['bool']);
const executedFlag = (id) => SIM.read(M, 'transaction(uint256)', [id], ['address', 'uint256', 'bytes', 'bool'])[3];

const PAYOUT = 7n * ETHER;
const t0 = propose('alice', BENEFICIARY, PAYOUT, Buffer.alloc(0), 'a payout');

ok(confirmations(t0) === 1n, "the submitter's own confirmation is implied, and is one");
ok(confirmed(t0) === false, 'one of two is not confirmed');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [t0]), gas: 300000n }),
  'NOT_ENOUGH_CONFIRMATIONS', 'executing one short');
ok(SIM.state.getBalance(BENEFICIARY) === 0n, 'and nothing moved');

reverted(SIM.send({ from: 'alice', to: M, data: call('confirmTransaction(uint256)', [t0]), gas: 300000n }),
  'ALREADY_CONFIRMED', 'alice confirming twice');
ok(confirmations(t0) === 1n, 'a doubled confirmation is still one confirmation');

succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [t0]), gas: 300000n, label: 'confirm' }), 'bob confirms');
ok(confirmations(t0) === 2n, 'two owners have confirmed');
ok(confirmed(t0) === true, 'the threshold is met');

const exec = succeeded(SIM.send({ from: 'bob', to: M, data: call('executeTransaction(uint256)', [t0]), gas: 300000n, label: 'execute a payout' }), 'the payout executes');
ok(SIM.state.getBalance(BENEFICIARY) === PAYOUT, 'the beneficiary was paid, out of the wallet');
ok(SIM.state.getBalance(M) === ENDOWMENT - PAYOUT, 'and the wallet is lighter by exactly that');
ok(exec.logs.length === 1, 'an Execution event was emitted');
ok(executedFlag(t0) === true, 'the proposal is marked executed');

reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [t0]), gas: 300000n }),
  'ALREADY_EXECUTED', 'executing the same proposal twice');
ok(SIM.state.getBalance(BENEFICIARY) === PAYOUT, 'the beneficiary was not paid twice');

// ---------------------------------------------------------------------------
group('revocation — approval is withdrawable right up to execution');
// ---------------------------------------------------------------------------

const t1 = propose('alice', BENEFICIARY, 1n * ETHER, Buffer.alloc(0), 'a second payout');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [t1]), gas: 300000n }), 'bob confirms it');
ok(confirmed(t1) === true, 'it is confirmed');

succeeded(SIM.send({ from: 'alice', to: M, data: call('revokeConfirmation(uint256)', [t1]), gas: 300000n }), 'alice changes her mind');
ok(confirmations(t1) === 1n, 'her confirmation is gone');
ok(confirmed(t1) === false, 'and the proposal is below the threshold again');
reverted(SIM.send({ from: 'bob', to: M, data: call('executeTransaction(uint256)', [t1]), gas: 300000n }),
  'NOT_ENOUGH_CONFIRMATIONS', 'executing a revoked-down proposal');

reverted(SIM.send({ from: 'carol', to: M, data: call('revokeConfirmation(uint256)', [t1]), gas: 300000n }),
  'NOT_CONFIRMED', 'revoking a confirmation never given');

// ---------------------------------------------------------------------------
group('signers rotate — and a rotated-out key stops counting');
// ---------------------------------------------------------------------------

/* Set the trap first: carol confirms a live proposal, taking it over the threshold.
 * She is then rotated out. If confirmations were a stored tally, her vote would still
 * be sitting on this proposal and it would still be executable — by exactly the key
 * the rotation was performed to retire. */
const trap = propose('alice', BENEFICIARY, 3n * ETHER, Buffer.alloc(0), 'a proposal carol confirms');
succeeded(SIM.send({ from: 'carol', to: M, data: call('confirmTransaction(uint256)', [trap]), gas: 300000n }), 'carol confirms it');
ok(confirmed(trap) === true, 'alice + carol reach the threshold');

const rotate = propose('alice', M, 0n, call('replaceOwner(address,address)', [CAROL, DAVE]), 'rotate carol to dave');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [rotate]), gas: 300000n }), 'bob confirms the rotation');
succeeded(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [rotate]), gas: 400000n, label: 'rotate a signer' }), 'the rotation executes');

ok(SIM.read(M, 'isOwner(address)', [CAROL], ['bool']) === false, 'carol is no longer an owner');
ok(SIM.read(M, 'isOwner(address)', [DAVE], ['bool']) === true, 'dave is');
ok(SIM.read(M, 'ownerCount()', [], ['uint256']) === 3n, 'the count did not move, so the threshold did not either');
ok(ownersNow().includes(hx(DAVE)) && !ownersNow().includes(hx(CAROL)), 'owners() reflects the swap');
ok(SIM.read(M, 'required()', [], ['uint256']) === 2n, 'required is untouched by a rotation');

ok(confirmations(trap) === 1n, "carol's confirmation stopped counting the moment she stopped being an owner");
ok(confirmed(trap) === false, 'so the proposal she carried over the line is back below it');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [trap]), gas: 300000n }),
  'NOT_ENOUGH_CONFIRMATIONS', 'executing on a retired signer\'s confirmation');

reverted(SIM.send({ from: 'carol', to: M, data: call('confirmTransaction(uint256)', [trap]), gas: 300000n }),
  'NOT_OWNER', 'carol confirming after her rotation');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [trap]), gas: 300000n }), 'dave, her successor, can');
ok(confirmed(trap) === true, 'and the proposal is live again on the new signer set');

ok(SIM.read(M, 'confirmedBy(uint256,address)', [trap, ALICE], ['bool']) === true,
  "alice never left, so carol's rotation did not touch alice's confirmation");

// ---------------------------------------------------------------------------
group('a rotated-out signer who comes back does not bring their old votes with them');
// ---------------------------------------------------------------------------

/* hearth#26. Counting over the live owner list makes a departed signer's confirmation
 * stop counting; it does NOT make it stay stopped. The flag was only hidden, so putting
 * that address back in the set would resurrect every confirmation it left behind — on
 * proposals nobody has looked at since, without the returning signer sending anything
 * or being told which proposals they are now confirming. That is the opposite of what
 * rotating someone out under suspicion is for.
 *
 * A whole wallet of its own, because the scenario needs a proposal that survives the
 * round trip and the narrative above is mid-flight. */
const dRejoin = succeeded(SIM.send({
  from: 'alice',
  to: null,
  data: Buffer.concat([ART.Multisig.code, abi.encodeParameters(['address[]', 'uint256'], [[ALICE, BOB, CAROL], 2n])]),
  gas: 3000000n,
}), 'a second 2-of-3 deploys for the round trip');
const R = dRejoin.contractAddress;
succeeded(SIM.send({ from: 'alice', to: R, value: 10n * ETHER, gas: 100000n }), 'and is funded');

const rConfirmations = (id) => SIM.read(R, 'confirmationCount(uint256)', [id], ['uint256']);
const rConfirmed = (id) => SIM.read(R, 'isConfirmed(uint256)', [id], ['bool']);
const rPropose = (from, to, value, data) => {
  const id = SIM.read(R, 'transactionCount()', [], ['uint256']);
  succeeded(SIM.send({ from, to: R, data: call('submitTransaction(address,uint256,bytes)', [to, value, data]), gas: 500000n }), `${from} proposes`);
  return id;
};

ok(SIM.read(R, 'ownerEpoch()', [], ['uint256']) === 1n, 'the founding owner set is epoch 1');
for (const [who, addr] of [['alice', ALICE], ['bob', BOB], ['carol', CAROL]]) {
  ok(SIM.read(R, 'ownerSince(address)', [addr], ['uint256']) === 1n, `${who}'s tenure starts at the founding epoch`);
}

const RETURNEE_PAYEE = hex('b2'.repeat(20)); // its own payee, so the main narrative's balance assertions stay readable
const pending = rPropose('carol', RETURNEE_PAYEE, 2n * ETHER, Buffer.alloc(0));
ok(rConfirmations(pending) === 1n, 'carol proposes a payout and it carries her confirmation');

/* Out. */
const evict = rPropose('alice', R, 0n, call('removeOwner(address)', [CAROL]));
succeeded(SIM.send({ from: 'bob', to: R, data: call('confirmTransaction(uint256)', [evict]), gas: 300000n }), 'bob confirms the removal');
succeeded(SIM.send({ from: 'alice', to: R, data: call('executeTransaction(uint256)', [evict]), gas: 400000n }), 'carol is removed');
ok(SIM.read(R, 'isOwner(address)', [CAROL], ['bool']) === false, 'carol is out');
ok(rConfirmations(pending) === 0n, 'and her confirmation stops counting immediately');
ok(SIM.read(R, 'ownerEpoch()', [], ['uint256']) === 1n, 'a removal does not move the epoch — there is nothing yet to invalidate');

/* And back. */
const readmit = rPropose('alice', R, 0n, call('addOwner(address)', [CAROL]));
succeeded(SIM.send({ from: 'bob', to: R, data: call('confirmTransaction(uint256)', [readmit]), gas: 300000n }), 'bob confirms the readmission');
succeeded(SIM.send({ from: 'alice', to: R, data: call('executeTransaction(uint256)', [readmit]), gas: 400000n, label: 'readmit a removed owner' }), 'carol is an owner again');
ok(SIM.read(R, 'isOwner(address)', [CAROL], ['bool']) === true, 'carol is back in the set');
ok(SIM.read(R, 'ownerEpoch()', [], ['uint256']) === 2n, 'rejoining took the next epoch');
ok(SIM.read(R, 'ownerSince(address)', [CAROL], ['uint256']) === 2n, 'and her tenure now starts there');
ok(SIM.read(R, 'ownerSince(address)', [ALICE], ['uint256']) === 1n, "while alice's is untouched");

ok(SIM.read(R, 'confirmedBy(uint256,address)', [pending, CAROL], ['bool']) === false,
  'the confirmation carol gave in her previous tenure is not a confirmation');
ok(rConfirmations(pending) === 0n, 'so the proposal did not gain a vote by her walking back in');
ok(rConfirmed(pending) === false, 'and it is nowhere near the threshold');
reverted(SIM.send({ from: 'alice', to: R, data: call('executeTransaction(uint256)', [pending]), gas: 400000n }),
  'NOT_ENOUGH_CONFIRMATIONS', 'executing on a resurrected confirmation');
ok(SIM.state.getBalance(R) === 10n * ETHER, 'nothing left the wallet');

/* She can of course confirm it again — deliberately, now, knowing what it is. */
succeeded(SIM.send({ from: 'carol', to: R, data: call('confirmTransaction(uint256)', [pending]), gas: 300000n }),
  'carol is not "already confirmed", so she can confirm again');
ok(rConfirmations(pending) === 1n, 'and that one counts');
succeeded(SIM.send({ from: 'bob', to: R, data: call('confirmTransaction(uint256)', [pending]), gas: 300000n }), 'bob makes it two');
succeeded(SIM.send({ from: 'bob', to: R, data: call('executeTransaction(uint256)', [pending]), gas: 400000n }), 'and it executes on two live confirmations');

// ---------------------------------------------------------------------------
group('the threshold changes, and binds proposals already confirmed under the old one');
// ---------------------------------------------------------------------------

const raise = propose('alice', M, 0n, call('changeRequirement(uint256)', [3n]), 'go to 3-of-3');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [raise]), gas: 300000n }), 'bob confirms the raise');
succeeded(SIM.send({ from: 'bob', to: M, data: call('executeTransaction(uint256)', [raise]), gas: 400000n, label: 'change the threshold' }), 'the threshold change executes');
ok(SIM.read(M, 'required()', [], ['uint256']) === 3n, 'required is 3');

/* `trap` still carries alice + dave. Under 2-of-3 it was executable a moment ago. */
ok(confirmations(trap) === 2n, 'the old proposal still has its two confirmations');
ok(confirmed(trap) === false, '…which is no longer enough');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [trap]), gas: 300000n }),
  'NOT_ENOUGH_CONFIRMATIONS', 'executing a 2-confirmation proposal under 3-of-3');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [trap]), gas: 300000n }), 'bob supplies the third');
succeeded(SIM.send({ from: 'bob', to: M, data: call('executeTransaction(uint256)', [trap]), gas: 300000n }), 'and now it executes');
ok(SIM.state.getBalance(BENEFICIARY) === PAYOUT + 3n * ETHER, 'the beneficiary was paid the second time too');

/* A removal that would leave fewer owners than the threshold reverts rather than
 * silently lowering the threshold to fit, which is what the Gnosis original does.
 * Reducing a 3-of-3 to a 2-of-2 is a change to the security property and belongs in
 * its own proposal. */
const strand = propose('alice', M, 0n, call('removeOwner(address)', [DAVE]), 'remove dave under 3-of-3');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [strand]), gas: 300000n }), 'bob confirms');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [strand]), gas: 300000n }), 'dave confirms his own removal');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [strand]), gas: 400000n }),
  'WOULD_STRAND_REQUIRED', 'removing an owner the threshold still needs');
ok(SIM.read(M, 'ownerCount()', [], ['uint256']) === 3n, 'the owner set is intact');
ok(executedFlag(strand) === false, 'and the failed proposal is still pending rather than burned');

// ---------------------------------------------------------------------------
group('feeToSetter — the role this contract was written to hold');
// ---------------------------------------------------------------------------

const dFactory = succeeded(SIM.send({
  from: 'alice',
  to: null,
  data: Buffer.concat([ART.Factory.code, abi.encodeParameters(['address'], [M])]),
  gas: 4000000n,
  label: 'deploy HearthV2Factory(multisig)',
}), 'a factory deploys with the multisig as feeToSetter');
const FACTORY = dFactory.contractAddress;

ok(SIM.read(FACTORY, 'feeToSetter()', [], ['address']) === hx(M), 'feeToSetter is the multisig, not the deploying EOA');
ok(SIM.read(FACTORY, 'feeTo()', [], ['address']) === hx(ZERO), 'feeTo is unset, so the whole 0.3% accrues to LPs');

/* hearth#25. A factory born with no setter has no fee switch from block one, and there
 * is no key that can give it one — `feeTo()` reads zero either way, so nothing detects
 * it either. Uniswap V2 allows it; this does not. */
reverted(SIM.send({
  from: 'alice',
  to: null,
  data: Buffer.concat([ART.Factory.code, abi.encodeParameters(['address'], [ZERO])]),
  gas: 4000000n,
}), 'HearthV2: ZERO_ADDRESS', 'deploying a factory with no feeToSetter at all');

/* The deployer is the obvious attacker here: she has the key that created the factory
 * and she is one of three signers. Neither buys her the role. */
reverted(SIM.send({ from: 'alice', to: FACTORY, data: call('setFeeTo(address)', [FEE_COLLECTOR]), gas: 200000n }),
  'HearthV2: FORBIDDEN', 'the deployer flipping the fee switch directly');
ok(SIM.read(FACTORY, 'feeTo()', [], ['address']) === hx(ZERO), 'the fee switch did not move');

const flip = propose('alice', FACTORY, 0n, call('setFeeTo(address)', [FEE_COLLECTOR]), 'turn the fee switch on');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [flip]), gas: 300000n }), 'bob confirms');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [flip]), gas: 400000n }),
  'NOT_ENOUGH_CONFIRMATIONS', 'two of the three trying to flip it');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [flip]), gas: 300000n }), 'dave confirms');
succeeded(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [flip]), gas: 400000n, label: 'setFeeTo through the multisig' }), 'all three flip it');
ok(SIM.read(FACTORY, 'feeTo()', [], ['address']) === hx(FEE_COLLECTOR), 'feeTo is now the collector');

/* A proposal whose target refuses it: the multisig is not the setter on this second
 * factory. The revert reason has to reach the owners — a swallowed failure means
 * reading a log to find out why nothing happened — and the proposal has to survive,
 * because "executed" would otherwise be spent on a call that never ran. */
const dOther = succeeded(SIM.send({
  from: 'bob',
  to: null,
  data: Buffer.concat([ART.Factory.code, abi.encodeParameters(['address'], [BOB])]),
  gas: 4000000n,
}), "a second factory deploys, with bob's EOA as its setter");
const OTHER = dOther.contractAddress;

const doomed = propose('alice', OTHER, 0n, call('setFeeTo(address)', [FEE_COLLECTOR]), 'a call the target will refuse');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [doomed]), gas: 300000n }), 'bob confirms');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [doomed]), gas: 300000n }), 'dave confirms');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [doomed]), gas: 400000n }),
  'HearthV2: FORBIDDEN', "the target's own revert reason reaches the owners");
ok(executedFlag(doomed) === false, 'the proposal was not consumed by the failure — it is still retryable');

/* Disaster recovery: the role can be handed to a successor multisig, and the moment it
 * is, the old one is as powerless as any other address. This is the path a runbook
 * takes when a signer set has to be rebuilt, and it is worth proving before the
 * factory is deployed for real rather than after. */
const dSuccessor = succeeded(SIM.send({
  from: 'bob',
  to: null,
  data: Buffer.concat([ART.Multisig.code, abi.encodeParameters(['address[]', 'uint256'], [[ALICE, BOB, DAVE], 2n])]),
  gas: 3000000n,
}), 'a successor multisig deploys');
const M2 = dSuccessor.contractAddress;

/* Before the handover that works, the one that must not. `setFeeToSetter(0)` succeeds on
 * Uniswap V2, and after it no key on earth can call `setFeeTo` or `setFeeToSetter`
 * again: the role is not stolen, it stops existing, and recovering it costs a new
 * factory, a new router and every pool migrated. It is a plausible mistake — a truncated
 * or empty address pasted into a proposal lands on zero — with an unrecoverable result,
 * so the contract refuses it, at full threshold, in front of everyone. */
const suicide = propose('alice', FACTORY, 0n, call('setFeeToSetter(address)', [ZERO]), 'send the role to nobody');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [suicide]), gas: 300000n }), 'bob confirms it');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [suicide]), gas: 300000n }), 'dave confirms it');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [suicide]), gas: 400000n }),
  'HearthV2: ZERO_ADDRESS', 'a fully confirmed proposal to delete the fee switch');
ok(SIM.read(FACTORY, 'feeToSetter()', [], ['address']) === hx(M), 'the role is still held by the multisig');
ok(executedFlag(suicide) === false, 'and the refused proposal is still pending, not burned');

/* `setFeeTo`, though, must keep accepting zero: there it is the meaningful state, and
 * turning the protocol fee back off is a thing the owners are supposed to be able to do. */
const feeOff = propose('alice', FACTORY, 0n, call('setFeeTo(address)', [ZERO]), 'turn the fee switch back off');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [feeOff]), gas: 300000n }), 'bob confirms');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [feeOff]), gas: 300000n }), 'dave confirms');
succeeded(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [feeOff]), gas: 400000n }), 'the fee goes back off');
ok(SIM.read(FACTORY, 'feeTo()', [], ['address']) === hx(ZERO), 'zero is a destination for feeTo and not for feeToSetter');
succeeded(SIM.send({ from: 'alice', to: M, data: call('submitTransaction(address,uint256,bytes)', [FACTORY, 0n, call('setFeeTo(address)', [FEE_COLLECTOR])]), gas: 500000n }), 'and back on again');
const feeOn = SIM.read(M, 'transactionCount()', [], ['uint256']) - 1n;
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [feeOn]), gas: 300000n }), 'bob confirms');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [feeOn]), gas: 300000n }), 'dave confirms');
succeeded(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [feeOn]), gas: 400000n }), 'the collector is restored');

const handover = propose('alice', FACTORY, 0n, call('setFeeToSetter(address)', [M2]), 'hand the role to the successor');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [handover]), gas: 300000n }), 'bob confirms');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [handover]), gas: 300000n }), 'dave confirms');
succeeded(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [handover]), gas: 400000n, label: 'hand over feeToSetter' }), 'the handover executes');
ok(SIM.read(FACTORY, 'feeToSetter()', [], ['address']) === hx(M2), 'the successor holds the role');

const stale = propose('alice', FACTORY, 0n, call('setFeeTo(address)', [ZERO]), 'the old wallet trying to act');
succeeded(SIM.send({ from: 'bob', to: M, data: call('confirmTransaction(uint256)', [stale]), gas: 300000n }), 'bob confirms');
succeeded(SIM.send({ from: 'dave', to: M, data: call('confirmTransaction(uint256)', [stale]), gas: 300000n }), 'dave confirms');
reverted(SIM.send({ from: 'alice', to: M, data: call('executeTransaction(uint256)', [stale]), gas: 400000n }),
  'HearthV2: FORBIDDEN', 'the superseded multisig, at full threshold, being refused');

const bySuccessor = (() => {
  succeeded(SIM.send({ from: 'alice', to: M2, data: call('submitTransaction(address,uint256,bytes)', [FACTORY, 0n, call('setFeeTo(address)', [ZERO])]), gas: 500000n }), 'the successor proposes');
  succeeded(SIM.send({ from: 'bob', to: M2, data: call('confirmTransaction(uint256)', [0n]), gas: 300000n }), 'and confirms to its own 2-of-3');
  return succeeded(SIM.send({ from: 'bob', to: M2, data: call('executeTransaction(uint256)', [0n]), gas: 400000n }), 'and is obeyed');
})();
ok(bySuccessor.status !== undefined && SIM.read(FACTORY, 'feeTo()', [], ['address']) === hx(ZERO),
  'the fee switch went back off, at the successor\'s instruction');

// ===========================================================================

console.log('\ngas:');
for (const [label, used] of SIM.gas) console.log(`  ${label.padEnd(38)} ${String(used).padStart(8)}`);

console.log(`\n${counts.fail === 0 ? 'PASS' : 'FAIL'} — ${counts.pass}/${counts.pass + counts.fail} multisig checks`);
if (counts.fail === 0) {
  console.log("\nSigners rotate and a threshold change succeeds. Phase A's gate");
  console.log('(docs/ecosystem/39-forge-exchange.md §7) is met.');
}
process.exit(counts.fail === 0 ? 0 : 1);
