'use strict';
/* Uniswap V2 on our own EVM — the phase 7 gate (docs/evm-spec.md §7, §8).
 *
 * Everything else in this directory tests a component against vectors somebody
 * else wrote. This file does the opposite: it takes real, audited, thousands-of-
 * opcodes-long bytecode that was compiled with no knowledge of this interpreter,
 * and asks whether our EVM runs it. Conformance vectors are small and targeted;
 * a V2 swap exercises CREATE2, DELEGATECALL-free-but-deeply-nested CALL chains,
 * `ecrecover`, SSTORE refund paths, memory expansion, revert-with-reason and the
 * 63/64 rule *in combination*. Bugs that every vector missed live exactly here.
 *
 * THERE IS NO CHAIN HERE. Phase 5 is still being built, so this drives the
 * contracts straight through `chain/statetransition.js` against a fresh StateDB:
 * real signed legacy transactions, RLP-encoded, recovered and applied in
 * `applyBlock` batches that stand in for blocks. That is the whole stack below
 * consensus — transaction codec, secp256k1 recovery, intrinsic gas, the
 * interpreter, the gas schedule, the state trie, receipts and the bloom — and
 * nothing above it.
 *
 * WHAT IT PROVES, in the order it proves it:
 *
 *   1. WEMBER, the factory and Router02 deploy, and their constructors run.
 *   2. `factory.pairCodeHash()` equals the hash Router02 was compiled with.
 *      Checked BEFORE anything touches liquidity, because a mismatch makes the
 *      router derive pair addresses where no pair exists and fail *silently*
 *      with an empty quote rather than an error.
 *   3. `createPair` lands the pair at exactly the CREATE2 address `pairFor`
 *      derives off-chain.
 *   4. The first `addLiquidity` mints `sqrt(a*b) - 1000` and burns
 *      MINIMUM_LIQUIDITY to the zero address, permanently.
 *   5. A swap moves the reserves, `k` does not decrease, and the output equals
 *      `getAmountOut` to the wei, fee included.
 *   6. A swap back, through the native-EMBER path, so WEMBER's deposit and its
 *      `.call{value:}` withdrawal are exercised too.
 *   7. `permit` — precompile 0x01 — with a low-s signature AND with the
 *      high-s/flipped-v form of the same signature, because ecrecover must NOT
 *      enforce EIP-2. `removeLiquidityWithPermit` then spends that approval.
 *   8. The logs and the bloom, not just the balances. Logs are not in the state
 *      trie, so a wrong bloom is invisible to every root check and silently
 *      breaks every `eth_getLogs` consumer.
 *
 * WHAT IT DOES NOT REACH, stated because a green run should not be read as more
 * than it is. **Uniswap V2 contains no DELEGATECALL.** Every library in
 * `contracts/src/libraries/` is `internal`, so solc inlines it and nothing is
 * ever linked or proxied; a disassembly of all five deployed contracts finds
 * only CALL, STATICCALL and CREATE2. So this suite is not evidence about
 * DELEGATECALL's context semantics — that still rests on the conformance
 * vectors alone, and the first contract to exercise it here will be a proxy
 * somebody deploys, not this one. It likewise never reaches SELFDESTRUCT, the
 * bn128 precompiles, or a flash swap's `hearthV2Call` re-entry.
 *
 * RUNNING IT. It needs the compiled artifacts, which need solc, which is the one
 * dependency `contracts/` has and `node/` does not:
 *
 *     pnpm --dir contracts install && pnpm --dir contracts compile
 *     node node/test/dex.js            # --gas for the gas table, --trace to debug
 *
 * It is deliberately NOT in `npm test`: that suite must keep running with zero
 * installed dependencies. It is a gate, run against `contracts/out`.
 */

const {
  Sim, reporter, artifact,
  hex, hx, word, addrWord,
  GWEI, ETHER, GAS_PRICE, GENESIS_TS,
  abi, TX, ST, receipt, StateDB, secp,
} = require('./evmsim');
const { keccak256 } = require('../src/crypto/keccak');
const bloom = require('../src/chain/bloom');

const ARGV = process.argv.slice(2);
const WANT_GAS = ARGV.includes('--gas') || ARGV.includes('-g');
const WANT_TRACE = ARGV.includes('--trace');

// ===========================================================================
// the artifacts
// ===========================================================================

const ART = {
  WEMBER: artifact('WEMBER'),
  Factory: artifact('HearthV2Factory'),
  Pair: artifact('HearthV2Pair'),
  Router: artifact('HearthV2Router02'),
  Multicall3: artifact('Multicall3'),
};

/** The constant Router02 was compiled with. contracts/README.md, spec §7. */
const EXPECTED_INIT_CODE_HASH = '0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537';

// ===========================================================================
// accounts
// ===========================================================================

const KEY = {
  deployer: hex('11'.repeat(32)),
  lp: hex('22'.repeat(32)),
  trader: hex('33'.repeat(32)),
};

/* Not a deployer EOA — spec §7 and contracts/README.md are explicit that the one
 * privileged role in the system must not be a key the deployer holds. Phase A of
 * docs/ecosystem/39-forge-exchange.md replaces this placeholder with a deployed
 * HearthMultisig; multisig.js is the suite that proves one can hold the role. */
const FEE_TO_SETTER = hex('5e'.repeat(20));
const ZERO = Buffer.alloc(20);

// ===========================================================================
// event decoding
// ===========================================================================

/* `indexed` is per-parameter and is NOT a prefix. `Swap(address indexed sender,
 * uint,uint,uint,uint, address indexed to)` indexes parameters 0 and 5, so a
 * decoder that takes "the first n are indexed" reads the amounts one word out of
 * place and still produces plausible numbers. Same for `Burn`. */
const EV = {};
for (const [sig, indexed] of [
  ['Transfer(address,address,uint256)', [1, 1, 0]],
  ['Approval(address,address,uint256)', [1, 1, 0]],
  ['Deposit(address,uint256)', [1, 0]],
  ['Withdrawal(address,uint256)', [1, 0]],
  ['PairCreated(address,address,address,uint256)', [1, 1, 0, 0]],
  ['Mint(address,uint256,uint256)', [1, 0, 0]],
  ['Burn(address,uint256,uint256,address)', [1, 0, 0, 1]],
  ['Swap(address,uint256,uint256,uint256,uint256,address)', [1, 0, 0, 0, 0, 1]],
  ['Sync(uint112,uint112)', [0, 0]],
]) {
  const types = abi.splitTop(sig.slice(sig.indexOf('(') + 1, -1));
  EV[sig.slice(0, sig.indexOf('('))] = { sig, types, indexed, topic: abi.topicHash(sig) };
}

const EV_BY_TOPIC = new Map();
for (const [name, e] of Object.entries(EV)) EV_BY_TOPIC.set(e.topic.toString('hex'), { name, ...e });

/** `{ name, address, args }` with args in DECLARED order, topics and data merged. */
function decodeLogs(logs) {
  return logs.map((l) => {
    const e = EV_BY_TOPIC.get(l.topics[0].toString('hex'));
    if (!e) return { name: null, address: hx(l.address), topic0: hx(l.topics[0]), args: [], raw: l };
    const unindexed = e.types.filter((_, i) => !e.indexed[i]);
    const body = unindexed.length ? abi.decodeParameters(unindexed, l.data) : [];
    let ti = 1, bi = 0;
    const args = e.types.map((t, i) => (e.indexed[i]
      // Every indexed parameter here is an address; a dynamic one would be the
      // hash of its value, which is why this table only carries value types.
      ? '0x' + l.topics[ti++].subarray(12).toString('hex')
      : body[bi++]));
    return { name: e.name, address: hx(l.address), args, raw: l };
  });
}

const findLog = (logs, name, address = null) =>
  decodeLogs(logs).find((l) => l.name === name && (address === null || l.address === hx(address)));
const countLog = (logs, name) => decodeLogs(logs).filter((l) => l.name === name).length;

// ===========================================================================
// pure-JS mirrors of the maths, so the contract is checked against a second
// implementation rather than against itself
// ===========================================================================

function sqrtBig(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
const getAmountOut = (amountIn, rIn, rOut) => {
  const inWithFee = amountIn * 997n;
  return (inWithFee * rOut) / (rIn * 1000n + inWithFee);
};

/** `keccak256(0xff ++ factory ++ keccak256(token0 ++ token1) ++ INIT_CODE_HASH)[12:]` */
function pairFor(factory, tokenA, tokenB) {
  const [t0, t1] = sortTokens(tokenA, tokenB);
  const salt = keccak256(Buffer.concat([t0, t1]));
  return keccak256(Buffer.concat([Buffer.from([0xff]), factory, salt, hex(EXPECTED_INIT_CODE_HASH)])).subarray(12);
}
const sortTokens = (a, b) => (Buffer.compare(a, b) < 0 ? [a, b] : [b, a]);

// ===========================================================================
// the run
// ===========================================================================

const SIM = new Sim({ keys: KEY });
const { counts, ok, group, fatal, succeeded } = reporter(SIM, { trace: WANT_TRACE });
const { deployer: D, lp: LP, trader: TRADER } = SIM.ADDR;

console.log('Uniswap V2 on the Hearth EVM — no chain, no RPC, straight through the state transition\n');

for (const a of [D, LP, TRADER]) SIM.fund(a, 100000n * ETHER);

// ---------------------------------------------------------------------------
group('deployment');
// ---------------------------------------------------------------------------

const dWember = succeeded(SIM.send({ from: 'deployer', to: null, data: ART.WEMBER.code, gas: 1500000n, label: 'deploy WEMBER' }), 'WEMBER deploys');
const WEMBER = dWember.contractAddress;

const dToken = succeeded(SIM.send({ from: 'deployer', to: null, data: ART.WEMBER.code, gas: 1500000n, label: 'deploy TOKEN (a second WEMBER)' }), 'the second token deploys');
const TOKEN = dToken.contractAddress;

const dFactory = succeeded(SIM.send({
  from: 'deployer', to: null, gas: 5000000n, label: 'deploy Factory',
  data: Buffer.concat([ART.Factory.code, abi.encodeParameters(['address'], [FEE_TO_SETTER])]),
}), 'the factory deploys');
const FACTORY = dFactory.contractAddress;

const dRouter = succeeded(SIM.send({
  from: 'deployer', to: null, gas: 8000000n, label: 'deploy Router02',
  data: Buffer.concat([ART.Router.code, abi.encodeParameters(['address', 'address'], [FACTORY, WEMBER])]),
}), 'Router02 deploys');
const ROUTER = dRouter.contractAddress;

const dMulticall = succeeded(SIM.send({ from: 'deployer', to: null, data: ART.Multicall3.code, gas: 1500000n, label: 'deploy Multicall3' }), 'Multicall3 deploys');
const MULTICALL = dMulticall.contractAddress;

ok(SIM.state.getCode(WEMBER).equals(ART.WEMBER.deployed), "WEMBER's deployed code is byte-identical to what solc emitted");
ok(SIM.state.getCode(FACTORY).equals(ART.Factory.deployed), "the factory's deployed code is byte-identical");
ok(SIM.state.getCode(MULTICALL).equals(ART.Multicall3.deployed), "Multicall3's deployed code is byte-identical");

/* Router02 has two `immutable`s, and solc leaves 32 zero words in
 * `deployedBytecode` where the constructor is supposed to splice them in — at
 * every use site, not once. So the on-chain code must differ from the artifact
 * in exactly those places and nowhere else, and each difference must be one of
 * the two addresses. A constructor that failed to write them would leave the
 * router pointing at address(0) and every pairFor would resolve to nothing. */
{
  const live = SIM.state.getCode(ROUTER);
  const art = ART.Router.deployed;
  ok(live.length === art.length, "Router02's deployed code is the length solc emitted");
  const runs = [];
  for (let i = 0; i < art.length; i++) {
    if (live[i] === art[i]) continue;
    let j = i;
    while (j < art.length && live[j] !== art[j]) j++;
    runs.push([i, live.subarray(i, j)]);
    i = j - 1;
  }
  const allAddresses = runs.every(([, b]) => b.length === 20 && (b.equals(FACTORY) || b.equals(WEMBER)));
  ok(runs.length > 0 && allAddresses,
    `Router02 differs from the artifact only where its immutables go, and every one of the ${runs.length} holes holds the factory or WEMBER`);
  ok(runs.some(([, b]) => b.equals(FACTORY)) && runs.some(([, b]) => b.equals(WEMBER)),
    '…and both immutables were actually written by the constructor');
  ok(art.every((b, i) => b === live[i] || b === 0), 'every byte the artifact fixed is unchanged on chain');
}
ok(WEMBER.equals(TX.contractAddress(D, 0n)), 'a creation lands at keccak256(rlp([sender, nonce]))[12:]');
ok(SIM.state.getNonce(WEMBER) === 1n, 'EIP-161: a freshly created contract has nonce 1');

// ---------------------------------------------------------------------------
group('THE INIT CODE HASH — checked before anything touches liquidity');
// ---------------------------------------------------------------------------

/* contracts/README.md: "if this constant does not match the bytecode the factory
 * actually deploys, the router looks for pools at addresses that do not exist"
 * — and it fails silently, with an empty quote, not with an error. */
const liveHash = SIM.read(FACTORY, 'pairCodeHash()', [], ['bytes32']);
ok(liveHash === EXPECTED_INIT_CODE_HASH, `factory.pairCodeHash() is ${EXPECTED_INIT_CODE_HASH} (got ${liveHash})`);
ok(keccak256(ART.Pair.code).toString('hex') === EXPECTED_INIT_CODE_HASH.slice(2),
  'keccak256 of the compiled pair creation code agrees, so the hash is right about the right code');
ok(SIM.read(ROUTER, 'factory()', [], ['address']) === hx(FACTORY), 'router.factory() is the factory we deployed');
ok(SIM.read(ROUTER, 'WETH()', [], ['address']) === hx(WEMBER), 'router.WETH() is WEMBER');
ok(SIM.read(ROUTER, 'WEMBER()', [], ['address']) === hx(WEMBER), 'router.WEMBER() aliases it');
ok(SIM.read(FACTORY, 'feeToSetter()', [], ['address']) === hx(FEE_TO_SETTER), 'feeToSetter is the address given, and is not a deployer EOA');
ok(SIM.read(FACTORY, 'feeTo()', [], ['address']) === hx(ZERO), 'feeTo is unset, so the whole 0.3% accrues to LPs');

// ---------------------------------------------------------------------------
group('createPair — CREATE2 lands where pairFor says it will');
// ---------------------------------------------------------------------------

const [T0, T1] = sortTokens(WEMBER, TOKEN);
const PREDICTED = pairFor(FACTORY, WEMBER, TOKEN);

const createRes = succeeded(SIM.send({
  from: 'deployer', to: FACTORY, gas: 5000000n, label: 'createPair',
  data: abi.encodeCall(abi.resolveFunction(null, 'createPair(address,address)'), [WEMBER, TOKEN]),
}), 'createPair');

const PAIR = hex(SIM.read(FACTORY, 'getPair(address,address)', [WEMBER, TOKEN], ['address']));
ok(PAIR.equals(PREDICTED), `the pair is at the CREATE2 address pairFor derives (${hx(PREDICTED)})`);
ok(SIM.state.getCode(PAIR).equals(ART.Pair.deployed), "the pair's runtime code is what solc emitted for HearthV2Pair");
ok(SIM.read(PAIR, 'factory()', [], ['address']) === hx(FACTORY), 'the pair knows its factory');
ok(SIM.read(PAIR, 'token0()', [], ['address']) === hx(T0), 'token0 is the numerically smaller address');
ok(SIM.read(PAIR, 'token1()', [], ['address']) === hx(T1), 'token1 is the larger');
ok(SIM.read(FACTORY, 'allPairsLength()', [], ['uint256']) === 1n, 'the factory registered exactly one pair');
ok(SIM.read(FACTORY, 'getPair(address,address)', [TOKEN, WEMBER], ['address']) === hx(PAIR), 'getPair is symmetric in its arguments');

{
  const pc = findLog(createRes.logs, 'PairCreated', FACTORY);
  ok(!!pc, 'createPair emits PairCreated');
  ok(pc && pc.args[0] === hx(T0) && pc.args[1] === hx(T1), '…with token0 and token1 indexed, in sorted order');
  ok(pc && pc.args[2] === hx(PAIR) && pc.args[3] === 1n, '…and the pair address and the index in the data');
}

/* The pair's LP token computes its EIP-712 domain from CHAINID at construction,
 * inside a CREATE2 frame. If the opcode is wrong there, permit silently fails
 * later with INVALID_SIGNATURE and nothing points at the cause. */
{
  const ds = SIM.read(PAIR, 'DOMAIN_SEPARATOR()', [], ['bytes32']);
  const expect = keccak256(Buffer.concat([
    abi.topicHash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    keccak256(Buffer.from('Hearth V2', 'utf8')),
    keccak256(Buffer.from('1', 'utf8')),
    word(TX.CHAIN_ID),
    addrWord(PAIR),
  ]));
  ok(ds === hx(expect), `the pair's DOMAIN_SEPARATOR binds chain id ${TX.CHAIN_ID} and its own address`);
}

// ---------------------------------------------------------------------------
group('addLiquidity — the first mint burns MINIMUM_LIQUIDITY');
// ---------------------------------------------------------------------------

const MAX_UINT = (1n << 256n) - 1n;
const DEADLINE = GENESIS_TS + 100000n;

const AMOUNT_W = 100n * ETHER;   // WEMBER side
const AMOUNT_T = 400n * ETHER;   // TOKEN side

/* Both tokens are WEMBER contracts, so both are funded by wrapping native EMBER.
 * That is not a shortcut around a token fixture: it means every ERC-20 call the
 * router and the pair make lands on real audited WETH9 code. */
succeeded(SIM.send({ from: 'lp', to: WEMBER, value: AMOUNT_W, data: abi.encodeCall(abi.resolveFunction(null, 'deposit()'), []), gas: 200000n, label: 'WEMBER.deposit' }), 'wrapping EMBER into WEMBER');
succeeded(SIM.send({ from: 'lp', to: TOKEN, value: AMOUNT_T, data: abi.encodeCall(abi.resolveFunction(null, 'deposit()'), []), gas: 200000n }), 'wrapping EMBER into TOKEN');

ok(SIM.read(WEMBER, 'balanceOf(address)', [LP], ['uint256']) === AMOUNT_W, 'deposit() credits the depositor at par');
ok(SIM.read(WEMBER, 'totalSupply()', [], ['uint256']) === AMOUNT_W, "…and totalSupply() is the contract's own EMBER balance");
ok(SIM.state.getBalance(WEMBER) === AMOUNT_W, '…which the state agrees with');

const approveAll = (token, from) => SIM.send({
  from, to: token, gas: 100000n, label: 'ERC-20 approve',
  data: abi.encodeCall(abi.resolveFunction(null, 'approve(address,uint256)'), [ROUTER, MAX_UINT]),
});
succeeded(approveAll(WEMBER, 'lp'), 'approving the router on WEMBER');
succeeded(approveAll(TOKEN, 'lp'), 'approving the router on TOKEN');

const addRes = succeeded(SIM.send({
  from: 'lp', to: ROUTER, gas: 5000000n, label: 'addLiquidity (first, creates reserves)',
  data: abi.encodeCall(abi.resolveFunction(null, 'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)'),
    [WEMBER, TOKEN, AMOUNT_W, AMOUNT_T, 0n, 0n, LP, DEADLINE]),
}), 'addLiquidity');

const MINIMUM_LIQUIDITY = SIM.read(PAIR, 'MINIMUM_LIQUIDITY()', [], ['uint256']);
ok(MINIMUM_LIQUIDITY === 1000n, 'MINIMUM_LIQUIDITY is 10**3');
const expectedLiquidity = sqrtBig(AMOUNT_W * AMOUNT_T) - MINIMUM_LIQUIDITY;

ok(SIM.read(PAIR, 'balanceOf(address)', [LP], ['uint256']) === expectedLiquidity,
  `the first mint gives sqrt(a*b) - 1000 = ${expectedLiquidity}`);
ok(SIM.read(PAIR, 'balanceOf(address)', [ZERO], ['uint256']) === MINIMUM_LIQUIDITY,
  'MINIMUM_LIQUIDITY is minted to the zero address, permanently');
ok(SIM.read(PAIR, 'totalSupply()', [], ['uint256']) === expectedLiquidity + MINIMUM_LIQUIDITY,
  'totalSupply is the LP holding plus the burned minimum');

{
  const [r0, r1, ts] = SIM.read(PAIR, 'getReserves()', [], ['uint112', 'uint112', 'uint32']);
  const wIsToken0 = Buffer.compare(WEMBER, TOKEN) < 0;
  ok(r0 === (wIsToken0 ? AMOUNT_W : AMOUNT_T) && r1 === (wIsToken0 ? AMOUNT_T : AMOUNT_W),
    'the reserves are exactly what was deposited, in token0/token1 order');
  ok(BigInt(ts) === (addRes.block.env.timestamp % (1n << 32n)),
    'blockTimestampLast is the block timestamp truncated to uint32 — seconds, not milliseconds');
}

/* The zero-address mint is the one the fixture would silently lose: it is a log
 * with no balance an outside observer can query later. */
{
  const logs = decodeLogs(addRes.logs);
  const toZero = logs.find((l) => l.name === 'Transfer' && l.address === hx(PAIR) && l.args[0] === hx(ZERO) && l.args[1] === hx(ZERO));
  ok(!!toZero && toZero.args[2] === MINIMUM_LIQUIDITY, 'a Transfer(0x0 -> 0x0, 1000) records the permanent burn');
  const toLp = logs.find((l) => l.name === 'Transfer' && l.address === hx(PAIR) && l.args[1] === hx(LP));
  ok(!!toLp && toLp.args[2] === expectedLiquidity, '…and a Transfer(0x0 -> lp) the rest');
  ok(!!findLog(addRes.logs, 'Sync', PAIR), 'the pair emits Sync');
  const m = findLog(addRes.logs, 'Mint', PAIR);
  ok(!!m && m.args[0] === hx(ROUTER), 'the pair emits Mint with the router as sender');
  ok(countLog(addRes.logs, 'Transfer') === 4, 'four Transfers: two token deposits in, two LP mints out');
}

/* price0CumulativeLast only starts moving on the SECOND touch, because the first
 * _update has a zero blockTimestampLast to subtract from and zero reserves. */
ok(SIM.read(PAIR, 'price0CumulativeLast()', [], ['uint256']) === 0n, 'the TWAP accumulator is still zero after the first mint');

/* Captured for the accumulator check after the next touch. */
const FIRST_MINT_TS = addRes.block.env.timestamp;
const [FM_R0, FM_R1] = SIM.read(PAIR, 'getReserves()', [], ['uint112', 'uint112', 'uint32']);

// ---------------------------------------------------------------------------
group('a proportional second deposit');
// ---------------------------------------------------------------------------

const totalBefore2 = SIM.read(PAIR, 'totalSupply()', [], ['uint256']);
succeeded(SIM.send({ from: 'lp', to: WEMBER, value: 10n * ETHER, data: abi.encodeCall(abi.resolveFunction(null, 'deposit()'), []), gas: 200000n }), 'wrapping more WEMBER');
succeeded(SIM.send({ from: 'lp', to: TOKEN, value: 40n * ETHER, data: abi.encodeCall(abi.resolveFunction(null, 'deposit()'), []), gas: 200000n }), 'wrapping more TOKEN');

const add2 = succeeded(SIM.send({
  from: 'lp', to: ROUTER, gas: 3000000n, label: 'addLiquidity (subsequent)',
  data: abi.encodeCall(abi.resolveFunction(null, 'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)'),
    [WEMBER, TOKEN, 10n * ETHER, 40n * ETHER, 0n, 0n, LP, DEADLINE]),
}), 'the second addLiquidity');

ok(SIM.read(PAIR, 'totalSupply()', [], ['uint256']) === totalBefore2 + totalBefore2 / 10n,
  'a deposit of one tenth of the reserves mints one tenth of the supply');

/* The accumulators advance by `UQ112x112.encode(other).uqdiv(this) * timeElapsed`
 * — a 112.112 fixed-point price times the seconds since the last touch, both
 * inside the `unchecked` block that is one of the two places this port
 * deliberately keeps wrapping arithmetic. Asserting the exact value rather than
 * "> 0" is what makes this a test of the fixed-point maths and of the uint32
 * timestamp subtraction, instead of a test that something happened. */
{
  const Q112 = 1n << 112n;
  const elapsed = add2.block.env.timestamp - FIRST_MINT_TS;
  ok(elapsed === 45n, 'three 15-second blocks passed between the two liquidity events');
  ok(SIM.read(PAIR, 'price0CumulativeLast()', [], ['uint256']) === ((FM_R1 * Q112) / FM_R0) * elapsed,
    'price0CumulativeLast advanced by exactly (reserve1 << 112) / reserve0 * timeElapsed');
  ok(SIM.read(PAIR, 'price1CumulativeLast()', [], ['uint256']) === ((FM_R0 * Q112) / FM_R1) * elapsed,
    '…and price1CumulativeLast by the reciprocal, at the same 112.112 precision');
}

// ---------------------------------------------------------------------------
group('THE SWAP');
// ---------------------------------------------------------------------------

const SWAP_IN = 5n * ETHER;
succeeded(SIM.send({ from: 'trader', to: WEMBER, value: SWAP_IN, data: abi.encodeCall(abi.resolveFunction(null, 'deposit()'), []), gas: 200000n }), 'the trader wraps EMBER');
succeeded(approveAll(WEMBER, 'trader'), 'the trader approves the router');

const [rW0, rT0] = (() => {
  const [r0, r1] = SIM.read(PAIR, 'getReserves()', [], ['uint112', 'uint112', 'uint32']);
  return Buffer.compare(WEMBER, TOKEN) < 0 ? [r0, r1] : [r1, r0];
})();
const kBefore = rW0 * rT0;

const quoted = SIM.read(ROUTER, 'getAmountsOut(uint256,address[])', [SWAP_IN, [WEMBER, TOKEN]], ['uint256[]']);
const expectedOut = getAmountOut(SWAP_IN, rW0, rT0);
ok(quoted[0] === SWAP_IN && quoted[1] === expectedOut,
  `getAmountsOut agrees with an independent 997/1000 computation (${expectedOut})`);
ok(expectedOut > 0n, 'the quote is not the silent-empty answer a bad init code hash produces');

const traderBefore = SIM.read(TOKEN, 'balanceOf(address)', [TRADER], ['uint256']);

const swapRes = succeeded(SIM.send({
  from: 'trader', to: ROUTER, gas: 3000000n, label: 'swapExactTokensForTokens',
  data: abi.encodeCall(abi.resolveFunction(null, 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'),
    [SWAP_IN, expectedOut, [WEMBER, TOKEN], TRADER, DEADLINE]),
}), 'THE SWAP');

const traderAfter = SIM.read(TOKEN, 'balanceOf(address)', [TRADER], ['uint256']);
ok(traderAfter - traderBefore === expectedOut, `the trader receives exactly getAmountOut = ${expectedOut}`);
ok(SIM.read(WEMBER, 'balanceOf(address)', [TRADER], ['uint256']) === 0n, 'and paid exactly the input');

const [rW1, rT1] = (() => {
  const [r0, r1] = SIM.read(PAIR, 'getReserves()', [], ['uint112', 'uint112', 'uint32']);
  return Buffer.compare(WEMBER, TOKEN) < 0 ? [r0, r1] : [r1, r0];
})();
const kAfter = rW1 * rT1;
ok(rW1 === rW0 + SWAP_IN, 'the input reserve grew by exactly the input');
ok(rT1 === rT0 - expectedOut, 'the output reserve shrank by exactly the output');
ok(kAfter >= kBefore, `k did not decrease (${kBefore} -> ${kAfter})`);
ok(kAfter > kBefore, '…it grew, which is the 0.3% fee accruing to the pool');

{
  const s = findLog(swapRes.logs, 'Swap', PAIR);
  ok(!!s, 'the pair emits Swap');
  ok(s && s.args[0] === hx(ROUTER) && s.args[5] === hx(TRADER), '…with sender and recipient indexed');
  const wIsToken0 = Buffer.compare(WEMBER, TOKEN) < 0;
  const [a0In, a1In, a0Out, a1Out] = s.args.slice(1, 5);
  ok((wIsToken0 ? a0In : a1In) === SWAP_IN && (wIsToken0 ? a1In : a0In) === 0n, '…the amounts in match the side that was sold');
  ok((wIsToken0 ? a1Out : a0Out) === expectedOut && (wIsToken0 ? a0Out : a1Out) === 0n, '…and the amounts out the side that was bought');
  ok(!!findLog(swapRes.logs, 'Sync', PAIR), 'and a Sync carrying the new reserves');
}

// ---------------------------------------------------------------------------
group('the swap, priced against the Shanghai schedule by hand');
// ---------------------------------------------------------------------------

/* The gas TOTAL for a swap can only be compared to mainnet loosely — different
 * solc, different optimizer, different token. The component prices cannot: they
 * are fixed numbers in EIP-2929/2200/3529 and every one of them is arithmetic
 * anybody can check. This is where a schedule bug that the conformance vectors
 * did not reach would actually show, because it is the same opcodes in
 * combination rather than one at a time. */
const SWAP_TRACE = SIM.replay(swapRes.block, 0).steps;
const CALL_OPS = new Set(['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL', 'CREATE', 'CREATE2']);

{
  ok(SWAP_TRACE.length > 3000, `the swap really is thousands of opcodes (${SWAP_TRACE.length} steps), not a stub`);
  ok(Math.max(...SWAP_TRACE.map((s) => s.depth)) === 2, 'it nests two frames deep: router -> pair -> token');

  const sload = SWAP_TRACE.filter((s) => s.op === 'SLOAD');
  ok(sload.length > 0 && sload.every((s) => s.gasCost === 2100n || s.gasCost === 100n),
    `every one of the ${sload.length} SLOADs is priced at the EIP-2929 cold 2100 or warm 100, and nothing else`);
  ok(sload.some((s) => s.gasCost === 2100n) && sload.some((s) => s.gasCost === 100n),
    '…and both cases actually occur, so the warm set is being consulted rather than ignored');

  /* The legal Shanghai SSTORE prices. 20000 is a zero->nonzero write, 2900 a
   * nonzero->nonzero one on a warm slot, 100 a write to a slot already dirtied
   * this transaction, and the +2100 variants are the same on a cold slot. */
  const sstore = SWAP_TRACE.filter((s) => s.op === 'SSTORE');
  const LEGAL = new Set([100n, 2900n, 5000n, 20000n, 22100n]);
  ok(sstore.length > 0 && sstore.every((s) => LEGAL.has(s.gasCost)),
    `every one of the ${sstore.length} SSTOREs is priced at a legal EIP-2200 row (${[...new Set(sstore.map((s) => s.gasCost))].sort((a, b) => Number(a - b)).join(', ')})`);
  ok(sstore.some((s) => s.gasCost === 100n),
    'the reentrancy lock, written twice and left as it started, is charged 100 the second time — the dirty-slot row');

  /* A LOG is 375 + 375 per topic + 8 per byte. Reading the width out of the log
   * we actually emitted, rather than hard-coding it, keeps this true if the
   * contract changes. */
  const logSteps = SWAP_TRACE.filter((s) => s.op.startsWith('LOG'));
  const dataLens = swapRes.logs.map((l) => BigInt(l.data.length));
  const expectedLogGas = swapRes.logs.reduce((a, l) => a + 375n + 375n * BigInt(l.topics.length) + 8n * BigInt(l.data.length), 0n);
  const actualLogGas = logSteps.reduce((a, s) => a + s.gasCost, 0n);
  ok(logSteps.length === swapRes.logs.length, 'one LOG opcode per log in the receipt');
  ok(actualLogGas === expectedLogGas,
    `the logs cost 375 + 375/topic + 8/byte = ${expectedLogGas} for data widths [${dataLens.join(', ')}] (charged ${actualLogGas})`);

  /* 4800 for zeroing the trader's input-token balance, 2800 for putting the
   * reentrancy lock back exactly as it was. Both are EIP-3529 values; the
   * pre-London ones were 15000 and 4200 and would show up here immediately. */
  ok(swapRes.gasRefunded === 4800n + 2800n,
    `the refund is EIP-3529's 4800 for a cleared slot plus 2800 for a restored one = 7600 (got ${swapRes.gasRefunded})`);
  ok(swapRes.gasRefunded <= (swapRes.gasUsed + swapRes.gasRefunded) / 5n,
    'and it is under the gasUsed/5 cap, so the cap did not silently truncate it');

  /* EIP-150's 63/64 rule and EIP-2929's account access cost, together, out of
   * one number each. Solidity asks for `gas()` — everything it has — so the
   * rule binds on every call here:
   *
   *     available = gasLeft - (accessCost + memoryExpansion)
   *     forwarded = available - available/64          (all but one 64th)
   *     retained  = gasLeft - gasCost = available/64
   *
   * Inverting it, `gasLeft - 64*retained` recovers what was charged before
   * forwarding, to within the 63 of slack that integer division hides. That is
   * the account-level half of EIP-2929 — the half SLOAD cannot show — and it is
   * 2,500 gas per call if it is wrong. Without the 63/64 retention the child
   * would receive everything and the parent could not finish, which surfaces as
   * an out-of-gas that no accounting explains. */
  const outer = SWAP_TRACE.filter((s) => CALL_OPS.has(s.op) && s.depth === 0);
  const charged = outer.map((s) => s.gasLeft - 64n * (s.gasLeft - s.gasCost));
  ok(outer.length === 3, `the router makes ${outer.length} external calls at depth 0`);
  ok(outer.every((s) => {
    const retained = s.gasLeft - s.gasCost;
    return retained > 0n && retained * 64n <= s.gasLeft && (retained + 1n) * 64n > s.gasLeft - 2700n;
  }), 'each retains exactly one 64th of what it had, so all but one 64th was forwarded');
  ok(charged.every((c) => c >= 100n && c <= 2700n),
    `and the pre-forwarding charge on each is one account access plus a little memory (${charged.join(', ')})`);
  ok(charged[0] > 2600n && charged[1] > 2600n && charged[2] < 200n,
    'cold, cold, then warm: the pair costs 2600 for getReserves and 100 by the time swap() reaches it, so warming survives across call frames');
}

// ---------------------------------------------------------------------------
group('the logs and the bloom');
// ---------------------------------------------------------------------------

{
  const r = swapRes.receipt;
  ok(r.logsBloom.equals(bloom.fromLogs(swapRes.logs)), "the receipt's bloom is the filter over its own logs");
  ok(bloom.contains(r.logsBloom, PAIR), 'the pair address is in the bloom');
  ok(bloom.contains(r.logsBloom, WEMBER) && bloom.contains(r.logsBloom, TOKEN), 'both token addresses are');
  ok(bloom.contains(r.logsBloom, EV.Swap.topic), 'the Swap topic is');
  ok(bloom.contains(r.logsBloom, EV.Transfer.topic), 'the Transfer topic is');
  ok(bloom.contains(r.logsBloom, addrWord(TRADER)), 'and so is the 32-byte topic word for the indexed recipient');
  ok(!bloom.contains(r.logsBloom, hex('de'.repeat(20))), 'an address that never appeared is not (no false positive here)');
  ok(!bloom.contains(r.logsBloom, EV.Burn.topic), 'nor is an event that did not fire');

  const blk = swapRes.block;
  ok(blk.logsBloom.equals(bloom.fromReceipts(blk.receipts)), "the block bloom is the OR of its receipts'");
  ok(blk.logsBloom.equals(bloom.fromLogs(blk.logs)), '…which is also the filter over every log in the block');
  ok(blk.receiptsRoot.length === 32 && !blk.receiptsRoot.equals(Buffer.alloc(32)), 'the block has a receipts root');
  ok(blk.results[0].receipt.cumulativeGasUsed === blk.gasUsed, 'cumulativeGasUsed in the last receipt is the block total');

  /* Every log carries the address of the contract that emitted it, and for a V2
   * swap that is three different contracts in one transaction. Getting this
   * wrong is invisible to a state root. */
  const addrs = new Set(swapRes.logs.map((l) => hx(l.address)));
  ok(addrs.has(hx(PAIR)) && addrs.has(hx(WEMBER)) && addrs.has(hx(TOKEN)),
    'the swap logs are attributed to the pair and both tokens');
  ok(swapRes.logs.every((l) => l.topics.every((t) => t.length === 32)), 'every topic is a full 32-byte word');
}

// ---------------------------------------------------------------------------
group('the swap back, through the native-EMBER path');
// ---------------------------------------------------------------------------

/* swapExactTokensForETH ends in WEMBER.withdraw + a `.call{value:}` back to the
 * router and on to the trader — a value-carrying CALL out of a contract, which
 * the token-only path never reaches. */
succeeded(approveAll(TOKEN, 'trader'), 'the trader approves the router on TOKEN');

const backIn = traderAfter - traderBefore;
const quotedBack = SIM.read(ROUTER, 'getAmountsOut(uint256,address[])', [backIn, [TOKEN, WEMBER]], ['uint256[]']);
const nativeBefore = SIM.state.getBalance(TRADER);
const kBeforeBack = rW1 * rT1;

const backRes = succeeded(SIM.send({
  from: 'trader', to: ROUTER, gas: 3000000n, label: 'swapExactTokensForETH (swap back)',
  data: abi.encodeCall(abi.resolveFunction(null, 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)'),
    [backIn, quotedBack[1], [TOKEN, WEMBER], TRADER, DEADLINE]),
}), 'the swap back');

const nativeAfter = SIM.state.getBalance(TRADER);
ok(nativeAfter === nativeBefore + quotedBack[1] - backRes.gasUsed * GAS_PRICE,
  'the trader receives native EMBER, net of gas, from WEMBER.withdraw');
ok(!!findLog(backRes.logs, 'Withdrawal', WEMBER), 'WEMBER emits Withdrawal');
ok(SIM.read(TOKEN, 'balanceOf(address)', [TRADER], ['uint256']) === 0n, 'the trader sold the whole position');

{
  const [r0, r1] = SIM.read(PAIR, 'getReserves()', [], ['uint112', 'uint112', 'uint32']);
  const [rW2, rT2] = Buffer.compare(WEMBER, TOKEN) < 0 ? [r0, r1] : [r1, r0];
  ok(rW2 * rT2 >= kBeforeBack, 'k did not decrease across the swap back either');
  ok(rW2 < rW0 + SWAP_IN, 'the pool gave back EMBER…');
  ok(rW2 > rW0, '…but kept the fee: a round trip loses the trader 0.6% and the pool gains it');
}

// ---------------------------------------------------------------------------
group('permit — precompile 0x01, including the high-s form EIP-2 would reject');
// ---------------------------------------------------------------------------

const PERMIT_TYPEHASH = abi.topicHash('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');
const DOMAIN = hex(SIM.read(PAIR, 'DOMAIN_SEPARATOR()', [], ['bytes32']));

function permitDigest(owner, spender, value, nonce, deadline) {
  const structHash = keccak256(Buffer.concat([
    PERMIT_TYPEHASH, addrWord(owner), addrWord(spender), word(value), word(nonce), word(deadline),
  ]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), DOMAIN, structHash]));
}

const SPENDER = hex('5b'.repeat(20));

{
  const nonce = SIM.read(PAIR, 'nonces(address)', [LP], ['uint256']);
  ok(nonce === 0n, "the LP's permit nonce starts at zero");
  const digest = permitDigest(LP, SPENDER, 12345n, nonce, DEADLINE);
  const sig = secp.sign(digest, KEY.lp);
  ok(sig.s <= secp.N_HALF, 'our signer normalises to low-s, so the plain case is the EIP-2-compliant one');

  const r = succeeded(SIM.send({
    from: 'trader', to: PAIR, gas: 200000n, label: 'permit (low-s)',
    data: abi.encodeCall(abi.resolveFunction(null, 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'),
      [LP, SPENDER, 12345n, DEADLINE, BigInt(27 + sig.recoveryId), word(sig.r), word(sig.s)]),
  }), 'permit with a low-s signature');

  ok(SIM.read(PAIR, 'allowance(address,address)', [LP, SPENDER], ['uint256']) === 12345n,
    'permit set the allowance, so ecrecover recovered the owner');
  ok(SIM.read(PAIR, 'nonces(address)', [LP], ['uint256']) === 1n, '…and consumed the nonce');
  const ap = findLog(r.logs, 'Approval', PAIR);
  ok(!!ap && ap.args[0] === hx(LP) && ap.args[1] === hx(SPENDER) && ap.args[2] === 12345n, '…and emitted Approval');
}

{
  /* (r, N-s, recoveryId^1) is the same signature reflected across the x-axis: it
   * recovers the same key. EIP-2 made it non-canonical for TRANSACTIONS; it never
   * applied to the ecrecover precompile, and a client that enforces low-s there
   * breaks every wallet that has ever produced a high-s permit. Spec §0: a
   * divergence means a contract behaves differently here than where it was
   * audited. This is the first time a real audited contract depends on it. */
  const nonce = SIM.read(PAIR, 'nonces(address)', [LP], ['uint256']);
  const digest = permitDigest(LP, SPENDER, 777n, nonce, DEADLINE);
  const sig = secp.sign(digest, KEY.lp);
  const highS = secp.N - sig.s;
  const flippedV = BigInt(27 + (sig.recoveryId ^ 1));
  ok(highS > secp.N_HALF, 'the reflected signature really is high-s');

  const r = SIM.send({
    from: 'trader', to: PAIR, gas: 200000n, label: 'permit (high-s)',
    data: abi.encodeCall(abi.resolveFunction(null, 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'),
      [LP, SPENDER, 777n, DEADLINE, flippedV, word(sig.r), word(highS)]),
  });
  if (r.exception) {
    const why = abi.decodeRevert(r.returnData || Buffer.alloc(0));
    fatal(`permit with a HIGH-S signature reverted (${r.exception}${why ? ' — ' + why.text : ''}). ` +
      'Precompile 0x01 must NOT enforce EIP-2 low-s: see src/evm/precompiles.js.', r.block, 0);
  }
  ok(!r.exception, 'permit accepts a high-s signature: ecrecover does not enforce EIP-2');
  ok(SIM.read(PAIR, 'allowance(address,address)', [LP, SPENDER], ['uint256']) === 777n,
    '…and it recovers the same owner as the low-s form');
}

{
  /* And the malformed case must return address(0) rather than revert, because
   * every permit implementation's `require(recovered != address(0))` depends on
   * it. src/evm/precompiles.js says so; this is the contract asserting it. */
  const nonce = SIM.read(PAIR, 'nonces(address)', [LP], ['uint256']);
  const digest = permitDigest(LP, SPENDER, 1n, nonce, DEADLINE);
  const sig = secp.sign(digest, KEY.lp);
  const r = SIM.send({
    from: 'trader', to: PAIR, gas: 200000n,
    data: abi.encodeCall(abi.resolveFunction(null, 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'),
      [LP, SPENDER, 1n, DEADLINE, 27n, word(0n), word(sig.s)]),   // r = 0: no such point
  });
  const why = r.exception ? abi.decodeRevert(r.returnData) : null;
  ok(r.exception === 'execution reverted' && why && why.kind === 'Error' && why.message === 'HearthV2: INVALID_SIGNATURE',
    'a malformed signature makes ecrecover return address(0), so permit reverts with INVALID_SIGNATURE rather than an EVM error');
  ok(SIM.read(PAIR, 'nonces(address)', [LP], ['uint256']) === nonce,
    '…and the reverted permit rolled back its nonce increment');
}

// ---------------------------------------------------------------------------
group('removeLiquidity, and removeLiquidityWithPermit');
// ---------------------------------------------------------------------------

const lpBalance = SIM.read(PAIR, 'balanceOf(address)', [LP], ['uint256']);
const half = lpBalance / 2n;

succeeded(SIM.send({
  from: 'lp', to: PAIR, gas: 100000n,
  data: abi.encodeCall(abi.resolveFunction(null, 'approve(address,uint256)'), [ROUTER, half]),
}), 'the LP approves the router for half the position');

const wBefore = SIM.read(WEMBER, 'balanceOf(address)', [LP], ['uint256']);
const tBefore = SIM.read(TOKEN, 'balanceOf(address)', [LP], ['uint256']);
const supplyBefore = SIM.read(PAIR, 'totalSupply()', [], ['uint256']);
const [rr0, rr1] = SIM.read(PAIR, 'getReserves()', [], ['uint112', 'uint112', 'uint32']);

const remRes = succeeded(SIM.send({
  from: 'lp', to: ROUTER, gas: 3000000n, label: 'removeLiquidity',
  data: abi.encodeCall(abi.resolveFunction(null, 'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)'),
    [WEMBER, TOKEN, half, 0n, 0n, LP, DEADLINE]),
}), 'removeLiquidity');

{
  const wIsToken0 = Buffer.compare(WEMBER, TOKEN) < 0;
  const expectW = (half * (wIsToken0 ? rr0 : rr1)) / supplyBefore;
  const expectT = (half * (wIsToken0 ? rr1 : rr0)) / supplyBefore;
  ok(SIM.read(WEMBER, 'balanceOf(address)', [LP], ['uint256']) - wBefore === expectW, 'the LP gets its pro-rata share of WEMBER');
  ok(SIM.read(TOKEN, 'balanceOf(address)', [LP], ['uint256']) - tBefore === expectT, '…and of TOKEN');
  ok(SIM.read(PAIR, 'totalSupply()', [], ['uint256']) === supplyBefore - half, 'the LP supply shrank by exactly what was burned');
  const b = findLog(remRes.logs, 'Burn', PAIR);
  ok(!!b && b.args[0] === hx(ROUTER) && b.args[3] === hx(LP), 'the pair emits Burn with the router as sender and the LP as recipient');
  ok(!!findLog(remRes.logs, 'Sync', PAIR), '…and a Sync');
}

{
  /* The whole permit path end to end: sign an approval off-chain, and let the
   * router spend it in the same transaction it burns with. */
  const rest = SIM.read(PAIR, 'balanceOf(address)', [LP], ['uint256']);
  const nonce = SIM.read(PAIR, 'nonces(address)', [LP], ['uint256']);
  const digest = permitDigest(LP, ROUTER, MAX_UINT, nonce, DEADLINE);
  const sig = secp.sign(digest, KEY.lp);

  const r = succeeded(SIM.send({
    from: 'lp', to: ROUTER, gas: 3000000n, label: 'removeLiquidityWithPermit',
    data: abi.encodeCall(abi.resolveFunction(null, 'removeLiquidityWithPermit(address,address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)'),
      [WEMBER, TOKEN, rest, 0n, 0n, LP, DEADLINE, true, BigInt(27 + sig.recoveryId), word(sig.r), word(sig.s)]),
  }), 'removeLiquidityWithPermit');

  ok(SIM.read(PAIR, 'balanceOf(address)', [LP], ['uint256']) === 0n, 'the LP is fully out');
  ok(SIM.read(PAIR, 'totalSupply()', [], ['uint256']) === MINIMUM_LIQUIDITY,
    'and what is left of the LP supply is exactly the MINIMUM_LIQUIDITY nobody can ever redeem');
  ok(!!findLog(r.logs, 'Burn', PAIR), 'it burned through the permitted allowance in one transaction');
}

// ---------------------------------------------------------------------------
group('the reverting paths still revert, with their reasons');
// ---------------------------------------------------------------------------

const reverts = [
  ['an expired deadline', ROUTER,
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    [1n, 0n, [WEMBER, TOKEN], TRADER, GENESIS_TS - 1n], 'HearthV2Router: EXPIRED'],
  ['a slippage bound that cannot be met', ROUTER,
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    [1n, MAX_UINT, [WEMBER, TOKEN], TRADER, DEADLINE], 'HearthV2Router: INSUFFICIENT_OUTPUT_AMOUNT'],
  ['a pair that already exists', FACTORY, 'createPair(address,address)', [WEMBER, TOKEN], 'HearthV2: PAIR_EXISTS'],
  ['identical tokens', FACTORY, 'createPair(address,address)', [WEMBER, WEMBER], 'HearthV2: IDENTICAL_ADDRESSES'],
  ['initialize called by anyone but the factory', PAIR, 'initialize(address,address)', [WEMBER, TOKEN], 'HearthV2: FORBIDDEN'],
  ['setFeeTo from the wrong key', FACTORY, 'setFeeTo(address)', [D], 'HearthV2: FORBIDDEN'],
];
for (const [what, to, sig, args, reason] of reverts) {
  const r = SIM.send({ from: 'trader', to, gas: 1000000n, data: abi.encodeCall(abi.resolveFunction(null, sig), args) });
  const why = r.exception ? abi.decodeRevert(r.returnData) : null;
  ok(r.exception === 'execution reverted' && why && why.kind === 'Error' && why.message === reason,
    `${what} reverts with "${reason}" (got ${why ? why.text : r.exception || 'success'})`);
  ok(r.status === receipt.FAILURE && r.receipt.logs.length === 0,
    `…and the failed transaction is in the block with status 0 and no logs (${what})`);
}

{
  /* The pair's storage, read straight out of the trie rather than through a
   * getter. Layout: HearthV2ERC20 takes 0..4, then factory 5, token0 6,
   * token1 7, the packed reserves 8, the two accumulators 9 and 10, kLast 11,
   * and the reentrancy flag 12.
   *
   * Slot 8 is the interesting one: reserve0 in bits 0..111, reserve1 in
   * 112..223 and blockTimestampLast in 224..255, all in ONE word so that
   * getReserves() is a single SLOAD. If our storage words were byte-swapped or
   * mis-masked anywhere, this is where it shows. */
  const slot = (n) => BigInt('0x' + SIM.state.getStorage(PAIR, word(n)).toString('hex'));
  ok(slot(12) === 1n, 'the reentrancy lock is back to unlocked after every call, so the next swap is not LOCKED');
  ok('0x' + SIM.state.getStorage(PAIR, word(5)).subarray(12).toString('hex') === hx(FACTORY), 'slot 5 holds the factory');

  const packed = slot(8);
  const [g0, g1, gts] = SIM.read(PAIR, 'getReserves()', [], ['uint112', 'uint112', 'uint32']);
  const MASK112 = (1n << 112n) - 1n;
  ok((packed & MASK112) === g0, 'slot 8 bits 0..111 are reserve0');
  ok(((packed >> 112n) & MASK112) === g1, '…bits 112..223 are reserve1');
  ok((packed >> 224n) === BigInt(gts), '…and bits 224..255 are the uint32 timestamp, one SLOAD for all three');
  ok(BigInt(gts) < (1n << 32n) && BigInt(gts) > 1000000000n, 'that timestamp is a plausible seconds-since-epoch, not milliseconds');
}

// ---------------------------------------------------------------------------
group('Multicall3 batches reads');
// ---------------------------------------------------------------------------

{
  const sel = (s) => abi.encodeCall(abi.resolveFunction(null, s), []);
  const calls = [
    [PAIR, sel('token0()')],
    [PAIR, sel('token1()')],
    [FACTORY, sel('allPairsLength()')],
  ];
  const data = abi.encodeCall(abi.resolveFunction(null, 'aggregate((address,bytes)[])'), [calls]);
  const r = SIM.rawCall(MULTICALL, data);
  ok(!r.exception, 'Multicall3.aggregate runs');
  if (!r.exception) {
    const [blockNumber, returnData] = abi.decodeParameters(['uint256', 'bytes[]'], r.returnData);
    ok(blockNumber === SIM.number, 'it reports the block number NUMBER returns');
    ok(returnData.length === 3, 'and three results');
    ok(abi.decodeParameters(['address'], hex(returnData[0]))[0] === hx(T0), '…the first being token0');
    ok(abi.decodeParameters(['uint256'], hex(returnData[2]))[0] === 1n, '…and the last allPairsLength');
  }
}

// ---------------------------------------------------------------------------
group('the state trie agrees with itself');
// ---------------------------------------------------------------------------

{
  const root = SIM.state.root();
  const fresh = new StateDB(SIM.state.db, root);
  ok(fresh.getCode(PAIR).equals(ART.Pair.deployed), 'a StateDB reopened at the final root has the pair code');
  ok(fresh.getStorage(PAIR, word(0)).equals(SIM.state.getStorage(PAIR, word(0))), '…and the same storage');
  ok(fresh.root().equals(root), '…and rehashes to the same root');
  ok(SIM.state.getBalance(WEMBER) === SIM.read(WEMBER, 'totalSupply()', [], ['uint256']),
    "WEMBER's peg is an accounting identity: its EMBER balance is its total supply");
}

{
  /* Spec §0: "An implementation signals EVM failure by returning `{ exception }`,
   * never by throwing." A JavaScript fault escaping the interpreter is carried
   * out as `internalError` rather than thrown, and it is indistinguishable from
   * a correctly-reverted transaction unless somebody looks. Across every frame
   * of every transaction in this run, nobody should have looked and found one. */
  const all = SIM.mined.flatMap((b) => (b.ok ? b.results : []));
  const faults = all.filter((r) => r.internalError);
  ok(faults.length === 0,
    `no transaction in the run reported an internal error across ${all.length} applied transactions` +
    (faults.length ? ` (first: ${faults[0].internalError})` : ''));
  ok(SIM.mined.every((b) => b.ok), `every one of the ${SIM.mined.length} blocks was accepted whole, with nothing rejected`);
  ok(all.every((r) => r.receipt.logsBloom.equals(bloom.fromLogs(r.logs))),
    "every receipt's bloom in the whole run is the filter over its own logs");
}

// ===========================================================================
// gas
// ===========================================================================

/* Typical observed mainnet Uniswap V2 costs, for the divergence the brief asks
 * about. Only the CALLS are comparable. A deployment is not: its gas is
 * dominated by the 200-per-byte code deposit, and these are 0.8.26 builds at
 * 999,999 runs against mainnet's 0.5.16 — different bytecode, therefore
 * different length, therefore a different number with nothing wrong. Deploys
 * are reported with the deposit component broken out instead, which is the
 * figure that can actually be checked. */
const MAINNET = new Map([
  ['addLiquidity (first, creates reserves)', 200000n],
  ['addLiquidity (subsequent)', 120000n],
  ['swapExactTokensForTokens', 150000n],
  ['swapExactTokensForETH (swap back)', 170000n],
  ['removeLiquidity', 160000n],
  ['removeLiquidityWithPermit', 200000n],
  ['permit (low-s)', 75000n],
  ['ERC-20 approve', 46000n],
]);
const DEPLOYED_LEN = new Map([
  ['deploy WEMBER', ART.WEMBER.deployed.length],
  ['deploy TOKEN (a second WEMBER)', ART.WEMBER.deployed.length],
  ['deploy Factory', ART.Factory.deployed.length],
  ['deploy Router02', ART.Router.deployed.length],
  ['deploy Multicall3', ART.Multicall3.deployed.length],
  ['createPair', ART.Pair.deployed.length],
]);

console.log('\n• gas per operation, against mainnet Uniswap V2');
const rows = [...SIM.gas].map(([label, used]) => {
  const ref = MAINNET.get(label);
  const len = DEPLOYED_LEN.get(label);
  if (ref) return [label, used, `   mainnet ~${ref}   ${used >= ref ? '+' : ''}${((Number(used) / Number(ref) - 1) * 100).toFixed(0)}%`];
  if (len) return [label, used, `   of which ${200 * len} is the ${len}-byte code deposit at 200/byte`];
  return [label, used, ''];
});
const w = Math.max(...rows.map((r) => r[0].length));
for (const [label, used, cmp] of rows) console.log(`    ${label.padEnd(w)}  ${String(used).padStart(9)}${cmp}`);

/* The assertion, rather than the table: a swap that costs wildly more or less
 * than mainnet's means the gas schedule is wrong somewhere the vectors did not
 * reach. The band is deliberately loose — solc 0.8.26 at 999999 runs is not the
 * 0.5.16 build mainnet runs, so an exact match would be the surprising outcome
 * — but an order of magnitude is not explainable that way. */
{
  const swapGas = SIM.gas.get('swapExactTokensForTokens');
  ok(swapGas > 90000n && swapGas < 250000n, `a swap costs ${swapGas}, within sight of mainnet's ~150,000`);
  const addGas = SIM.gas.get('addLiquidity (subsequent)');
  ok(addGas > 70000n && addGas < 220000n, `addLiquidity into an existing pool costs ${addGas}, against mainnet's ~120,000`);
  const createGas = SIM.gas.get('createPair');
  ok(createGas > 1500000n && createGas < 3500000n, `createPair costs ${createGas}, against mainnet's ~2,100,000`);
}

if (WANT_GAS) {
  console.log('\n  block-by-block:');
  SIM.mined.forEach((b, i) => {
    if (!b.ok) return;
    console.log(`    block ${String(i + 1).padStart(2)}  gasUsed ${String(b.gasUsed).padStart(9)}  ${b.results.length} tx  ${b.logs.length} logs  root ${hx(b.stateRoot).slice(0, 18)}…`);
  });

  /* Where the swap's gas actually goes, by opcode — the answer to "is a
   * divergence from mainnet a wrong schedule or a different compiler". A wrong
   * schedule shows up as a whole opcode family priced oddly, which a total
   * cannot reveal.
   *
   * A CALL's `gasCost` includes the gas FORWARDED to the child, most of which
   * comes back, so summing it raw reports 17 million for a 112,000-gas
   * transaction. The net cost of a call is instead the drop in `gasLeft`
   * between the call and the caller's next step at the same depth — which is
   * the call and everything it did, charged once. */
  /* Per-opcode, across every frame, EXCLUDING the call family: a CALL's
   * `gasCost` is dominated by the gas forwarded to the child, most of which
   * comes straight back, so adding it to a total reports seventeen million for a
   * hundred-thousand-gas transaction. The calls are listed separately below at
   * their net cost — the drop in `gasLeft` across the whole child frame. */
  const byOp = new Map();
  let storageAndLogs = 0n;
  for (const s of SWAP_TRACE) {
    if (CALL_OPS.has(s.op)) continue;
    const e = byOp.get(s.op) || { n: 0, gas: 0n };
    e.n++; e.gas += s.gasCost;
    byOp.set(s.op, e);
    storageAndLogs += s.gasCost;
  }
  console.log(`\n  the swap, by opcode — ${SWAP_TRACE.length} steps over 3 frames, ${storageAndLogs} gas outside the call family:`);
  for (const [op, e] of [...byOp].sort((a, b) => Number(b[1].gas - a[1].gas)).slice(0, 8)) {
    console.log(`    ${op.padEnd(14)} ${String(e.n).padStart(5)}x  ${String(e.gas).padStart(8)}`);
  }

  const sl = SWAP_TRACE.filter((s) => s.op === 'SLOAD');
  console.log(`    EIP-2929: ${sl.filter((s) => s.gasCost === 2100n).length} cold SLOADs at 2100, ${sl.filter((s) => s.gasCost === 100n).length} warm at 100`);
  console.log(`    EIP-2200: SSTOREs at ${SWAP_TRACE.filter((s) => s.op === 'SSTORE').map((s) => s.gasCost).join(', ')}`);
  console.log(`    EIP-3529: refunded ${swapRes.gasRefunded}, cap was ${(swapRes.gasUsed + swapRes.gasRefunded) / 5n}`);
  console.log(`    intrinsic + everything else: ${swapRes.gasUsed + swapRes.gasRefunded - storageAndLogs}`);
}

// ===========================================================================

console.log(`\n${counts.fail === 0 ? 'PASS' : 'FAIL'} — ${counts.pass}/${counts.pass + counts.fail} DEX checks`);
if (counts.fail === 0) {
  console.log('\nA swap succeeded end to end on our own EVM. Phase 7\'s gate (docs/evm-spec.md §8) is met.');
}
process.exit(counts.fail === 0 ? 0 : 1);
