/* Add liquidity to an EMBER/DEMO pool and swap through it.
 *
 *   HEARTH_PRIVATE_KEY=0x… npx hardhat run scripts/swap.js --network hearth
 *
 * Requires scripts/deploy-dex.js to have run (it writes deployments.hearth.json).
 * Deploys a throwaway ERC-20, seeds the pool, then swaps EMBER for it and back.
 *
 * READ "ETH" AS "THE NATIVE ASSET" THROUGHOUT. The router keeps Uniswap's
 * naming — `addLiquidityETH`, `swapExactETHForTokens`, `WETH()` — because those
 * are SELECTORS, not prose. Renaming them to EMBER would break every V2
 * front-end, aggregator, subgraph and SDK for a cosmetic gain
 * (contracts/README.md). `WEMBER()` exists as a readable alias of `WETH()`.
 */

const fs = require('fs');
const path = require('path');

/* Resolved per network — a swap script that silently reads Hearth addresses
 * while connected to a local node is a bad afternoon. */
const deploymentsFile = () => path.join(__dirname, '..', `deployments.${hre.network.name}.json`);

/* Human-readable ABI fragments — only what this script calls. The full ABIs
 * are in contracts/out/*.json. */
const ROUTER_ABI = [
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
];
const FACTORY_ABI = [
  'function getPair(address,address) view returns (address)',
  'function pairCodeHash() view returns (bytes32)',
];
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function totalSupply() view returns (uint256)',
];
const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const E = n => hre.ethers.parseEther(String(n));
const fmt = n => hre.ethers.formatEther(n);

async function main() {
  const file = deploymentsFile();
  if (!fs.existsSync(file)) {
    throw new Error(`no ${file} — run scripts/deploy-dex.js against --network ${hre.network.name} first`);
  }
  const D = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [me] = await hre.ethers.getSigners();
  if (!me) throw new Error('no signer — set HEARTH_PRIVATE_KEY');

  const router = new hre.ethers.Contract(D.HearthV2Router02, ROUTER_ABI, me);
  const factory = new hre.ethers.Contract(D.HearthV2Factory, FACTORY_ABI, me);

  /* Re-check the init code hash on every run, not just at deployment. The
   * router's copy is a compile-time constant; the factory's is what it will
   * actually produce. If they ever disagree, `pairFor` points at nothing and
   * swaps silently resolve against an empty account. */
  const liveHash = await factory.pairCodeHash();
  if (liveHash.toLowerCase() !== D.initCodeHash.toLowerCase()) {
    throw new Error(`init code hash drifted: factory says ${liveHash}, deployment recorded ${D.initCodeHash}`);
  }

  console.log('--- 1. deploy a token to pool against ---');
  const Demo = await hre.ethers.getContractFactory('DemoToken');
  const demo = await Demo.deploy(E(1_000_000));
  await demo.waitForDeployment();
  const demoAddr = await demo.getAddress();
  console.log('DEMO', demoAddr);

  console.log('\n--- 2. add liquidity: 10 EMBER + 10,000 DEMO ---');
  // Approve first. The router pulls the token with transferFrom; without an
  // allowance the call reverts inside the token, not in the router, and the
  // error message will be the token's.
  await (await demo.approve(D.HearthV2Router02, E(10_000))).wait();

  /* THE DEADLINE. `block.timestamp` in Solidity is SECONDS. The v1 Hearth
   * header stores MILLISECONDS and phase 5 must divide at the header
   * (docs/evm-spec.md §4). If that conversion is ever missed, every call below
   * reverts with `UniswapV2Router: EXPIRED` — the router compares
   * `deadline >= block.timestamp` and a millisecond clock is ~55,000 years in
   * the future. It is the fastest way to detect the bug, so it is worth
   * knowing what it looks like. */
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const addTx = await router.addLiquidityETH(
    demoAddr,
    E(10_000),   // amountTokenDesired
    E(9_900),    // amountTokenMin  — 1% slippage floor
    E(9.9),      // amountETHMin
    me.address,  // LP tokens go here
    deadline,
    { value: E(10) },
  );
  console.log('addLiquidityETH', addTx.hash);
  await addTx.wait();

  const pairAddr = await factory.getPair(demoAddr, D.WEMBER);
  console.log('pair', pairAddr);
  const pair = new hre.ethers.Contract(pairAddr, PAIR_ABI, me);
  const [r0, r1] = await pair.getReserves();
  const token0 = await pair.token0();
  console.log('reserves', token0.toLowerCase() === demoAddr.toLowerCase()
    ? `${fmt(r0)} DEMO / ${fmt(r1)} WEMBER`
    : `${fmt(r0)} WEMBER / ${fmt(r1)} DEMO`);
  console.log('LP supply', fmt(await pair.totalSupply()),
    '(1000 wei was burned to address(0) on the first mint — MINIMUM_LIQUIDITY)');

  console.log('\n--- 3. swap 1 EMBER for DEMO ---');
  const path1 = [D.WEMBER, demoAddr];
  const quote = await router.getAmountsOut(E(1), path1);
  console.log('quote  1 EMBER →', fmt(quote[1]), 'DEMO (0.3% fee already taken)');

  const before = await demo.balanceOf(me.address);
  // amountOutMin is your ONLY protection against an adversarial reorder. A
  // zero here is an invitation to be sandwiched; 99% of the quote is a
  // reasonable default for a script, not for a front-end.
  const minOut = (quote[1] * 99n) / 100n;
  const swapTx = await router.swapExactETHForTokens(minOut, path1, me.address, deadline, { value: E(1) });
  console.log('swapExactETHForTokens', swapTx.hash);
  const rc = await swapTx.wait();
  console.log('gas used', rc.gasUsed.toString());
  const gained = (await demo.balanceOf(me.address)) - before;
  console.log('received', fmt(gained), 'DEMO');

  console.log('\n--- 4. swap it back ---');
  const path2 = [demoAddr, D.WEMBER];
  await (await demo.approve(D.HearthV2Router02, gained)).wait();
  const back = await router.getAmountsOut(gained, path2);
  const backTx = await router.swapExactTokensForETH(
    gained, (back[1] * 99n) / 100n, path2, me.address, deadline,
  );
  console.log('swapExactTokensForETH', backTx.hash);
  await backTx.wait();
  console.log('recovered ~', fmt(back[1]), 'EMBER — less than 1, which is the two 0.3% fees');

  console.log('\nSwap round trip complete.');
}

main().catch(e => { console.error(String(e.message || e)); process.exitCode = 1; });
