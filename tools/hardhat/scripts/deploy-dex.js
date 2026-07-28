/* Deploy the Hearth exchange — WEMBER, Factory, Router02, Multicall3.
 *
 *   HEARTH_PRIVATE_KEY=0x… \
 *   HEARTH_FEE_TO_SETTER=0x<multisig> \
 *   npx hardhat run scripts/deploy-dex.js --network hearth
 *
 * The bytecode comes from `contracts/out/*.json`, which is the tree's own
 * build. Run `pnpm --dir contracts compile` first. It is read rather than
 * recompiled here on purpose: contracts/README.md pins the Uniswap V2 init
 * code hash to an exact solc version and optimiser setting, and a second
 * compilation under slightly different settings would produce pair bytecode
 * the router cannot find.
 *
 * ORDER MATTERS, and it is documented in contracts/README.md:
 *
 *   1. WEMBER            (no constructor arguments)
 *   2. HearthV2Factory   (address _feeToSetter)
 *   3. HearthV2Router02  (address _factory, address _WEMBER)   ← needs 1 and 2
 *   4. Multicall3        (no constructor arguments)            ← independent
 *
 * HearthV2Pair is NEVER deployed directly. The factory CREATE2s each one, and
 * its constructor takes no arguments — which is load-bearing, because an
 * argument would make the init code vary per pair and destroy the address
 * derivation the router depends on.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', '..', 'contracts', 'out');

/** contracts/README.md, and docs/evm-spec.md §7. Solc 0.8.26, shanghai, 999999 runs. */
const EXPECTED_INIT_CODE_HASH =
  '0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537';

function artifact(name) {
  const file = path.join(OUT, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file} — run: pnpm --dir contracts compile`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function deploy(signer, name, args = []) {
  const a = artifact(name);
  const factory = new hre.ethers.ContractFactory(a.abi, a.bytecode, signer);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log(`${name.padEnd(18)} ${address}`);
  return c;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error('no signer — set HEARTH_PRIVATE_KEY');

  const feeToSetter = process.env.HEARTH_FEE_TO_SETTER;
  if (!feeToSetter) {
    throw new Error(
      'HEARTH_FEE_TO_SETTER is required.\n'
      + '  It is the only privileged role in the whole system: it can switch the\n'
      + '  protocol fee on and hand itself to another address, with no timelock and\n'
      + '  no two-step handover. Uniswap V2 has no way to recover from setting it\n'
      + '  wrong.\n'
      + '  It MUST be a multisig or a governance contract FROM THE FIRST BLOCK —\n'
      + '  moving it later requires the very key you are trying to stop relying on\n'
      + '  (docs/evm-spec.md §7, docs/listing-checklist.md M10).',
    );
  }
  if (hre.ethers.getAddress(feeToSetter) === hre.ethers.getAddress(deployer.address)) {
    throw new Error('HEARTH_FEE_TO_SETTER is the deployer EOA. Refusing — see above.');
  }

  console.log('deployer  ', deployer.address);
  console.log('feeToSetter', hre.ethers.getAddress(feeToSetter));
  console.log('');

  const wember = await deploy(deployer, 'WEMBER');
  const factory = await deploy(deployer, 'HearthV2Factory', [feeToSetter]);
  const router = await deploy(deployer, 'HearthV2Router02', [
    await factory.getAddress(),
    await wember.getAddress(),
  ]);
  const multicall = await deploy(deployer, 'Multicall3');

  console.log('\n--- post-deployment checks (contracts/README.md "After deploying") ---');

  /* CHECK 1, AND IT IS THE ONE THAT MATTERS.
   *
   * The router does not ask the factory where a pair lives. It DERIVES the
   * address arithmetically from a hard-coded init code hash:
   *
   *   pair = keccak256(0xff ++ factory ++ keccak256(token0,token1) ++ INIT_CODE_HASH)[12:]
   *
   * If that constant does not match the bytecode the live factory actually
   * deploys, the router looks for pools at addresses where nothing exists. In
   * the EVM a call to an empty address SUCCEEDS and returns nothing, so this
   * does not fail loudly — it fails as "the pool has no reserves", over and
   * over, until someone loses money on a swap that silently did nothing.
   *
   * DO THIS BEFORE SEEDING ANY LIQUIDITY. */
  const liveHash = await factory.pairCodeHash();
  console.log('factory.pairCodeHash()', liveHash);
  if (liveHash.toLowerCase() !== EXPECTED_INIT_CODE_HASH) {
    throw new Error(
      `INIT CODE HASH MISMATCH.\n  live     ${liveHash}\n  expected ${EXPECTED_INIT_CODE_HASH}\n`
      + '  STOP. Do not add liquidity. Rebuild contracts/ and regenerate the constant\n'
      + '  with `pnpm --dir contracts compile --sync-hash`, then redeploy.',
    );
  }
  console.log('  matches the router\'s hard-coded constant');

  // CHECK 2: the router points where we think it does.
  const routerFactory = await router.factory();
  const routerWeth = await router.WETH();
  if (routerFactory !== await factory.getAddress()) throw new Error('router.factory() is wrong');
  if (routerWeth !== await wember.getAddress()) throw new Error('router.WETH() is wrong');
  console.log('  router.factory() and router.WETH() agree');

  // CHECK 3: feeTo is unset, which is the right launch default. While it is
  // zero the whole 0.3% accrues to liquidity providers.
  const feeTo = await factory.feeTo();
  console.log('  factory.feeTo()', feeTo, feeTo === hre.ethers.ZeroAddress ? '(unset — correct at launch)' : '(SET — was that deliberate?)');

  const addresses = {
    network: hre.network.name,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    WEMBER: await wember.getAddress(),
    HearthV2Factory: await factory.getAddress(),
    HearthV2Router02: await router.getAddress(),
    Multicall3: await multicall.getAddress(),
    initCodeHash: liveHash,
    feeToSetter: hre.ethers.getAddress(feeToSetter),
    deployedAt: new Date().toISOString(),
  };
  /* Named after the network, not after Hearth. A `deployments.hearth.json`
   * written by a run against a local Hardhat node is exactly how a front-end
   * ends up pointed at addresses that exist on nobody's chain. */
  const file = path.join(__dirname, '..', `deployments.${hre.network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + '\n');
  console.log('\nwrote', file);

  console.log(
    '\nNOTE ON MULTICALL3. Front-ends, wallets and indexers look for Multicall3 at\n'
    + '  0xcA11bde05977b3631167028862bE2a173976CA11\n'
    + 'on every chain. That address comes from a pre-signed, PRE-EIP-155 deployment\n'
    + 'transaction carrying solc 0.8.12 / london bytecode. The copy just deployed is\n'
    + 'our 0.8.26 / shanghai build at an ordinary address, so it is NOT at the\n'
    + 'canonical one and every front-end will need configuring by hand. Hearth\n'
    + 'accepts pre-155 transactions precisely so the canonical route stays open\n'
    + '(docs/evm-spec.md §3) — decide which one you want before front-ends hard-code\n'
    + 'an address.',
  );
}

main().catch(e => { console.error(String(e.message || e)); process.exitCode = 1; });
