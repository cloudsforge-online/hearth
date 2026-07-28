/* Deploy Greeter to Hearth.
 *
 *   HEARTH_PRIVATE_KEY=0x… npx hardhat run scripts/deploy.js --network hearth
 *
 * Nothing here is Hearth-specific. That is the point: the chain is standard
 * enough that the deploy script is the one you already have. The Hearth-aware
 * parts live in hardhat.config.js (Shanghai, legacy gas price) and in the
 * assertion at the end (the deployed contract agrees it is on chain 7411).
 */

const CHAIN_ID = 7411n;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error('no signer — set HEARTH_PRIVATE_KEY');

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log('deployer', deployer.address);
  console.log('balance ', hre.ethers.formatEther(balance), 'EMBER');
  if (balance === 0n) {
    throw new Error('deployer has no EMBER — fund it from the faucet (tools/faucet) first');
  }

  const Greeter = await hre.ethers.getContractFactory('Greeter');
  const greeter = await Greeter.deploy('hello hearth');

  console.log('deploy tx', greeter.deploymentTransaction().hash);
  await greeter.waitForDeployment();

  const address = await greeter.getAddress();
  console.log('deployed at', address);

  // Read it back over eth_call. A deployment that "succeeded" but whose code
  // is empty is the classic silent failure — in the EVM a call to an address
  // with no code SUCCEEDS and returns nothing, so a bad deploy looks like a
  // contract that returns zero rather than like an error.
  const code = await hre.ethers.provider.getCode(address);
  if (code === '0x') throw new Error('no code at the deployed address — the deployment did not take');
  console.log('code size', (code.length - 2) / 2, 'bytes');

  console.log('greeting ', await greeter.greeting());

  const onChainId = await greeter.chainId();
  console.log('CHAINID  ', onChainId);
  if (onChainId !== CHAIN_ID) {
    throw new Error(`the contract reports chain ${onChainId}, expected ${CHAIN_ID} — you deployed somewhere else`);
  }

  console.log('\nDeployed and verified on Hearth.');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
