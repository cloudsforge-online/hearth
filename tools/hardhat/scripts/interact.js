/* Read and write a deployed Greeter.
 *
 *   GREETER=0x… npx hardhat run scripts/interact.js --network hearth
 *
 * Shows the two halves a contract has: `eth_call` for reads (free, no
 * signature, no block) and a signed transaction for writes (costs gas,
 * produces a receipt, only visible once mined).
 */

async function main() {
  const address = process.env.GREETER;
  if (!address) throw new Error('set GREETER to the deployed address');

  const [me] = await hre.ethers.getSigners();
  const greeter = await hre.ethers.getContractAt('Greeter', address, me);

  // --- reads: eth_call, nothing is signed and nothing is mined -------------
  console.log('greeting            ', await greeter.greeting());
  console.log('owner               ', await greeter.owner());
  console.log('chainId (CHAINID)   ', await greeter.chainId());

  /* opcode 0x44. On Hearth this is the parent block's Homefire PoW digest
   * (docs/evm-spec.md §5) — a real 256-bit hash, and MINER-INFLUENCEABLE. A
   * miner who dislikes the outcome can throw the block away and grind another.
   * Never use it for anything an adversarial miner would profit from biasing. */
  console.log('PREVRANDAO (0x44)   ', '0x' + (await greeter.powDigestOfParent()).toString(16));

  /* opcode 0x48. Present because Shanghai includes EIP-3198; pushes zero
   * because v1 has no EIP-1559 fee market. Do not price anything off it. */
  console.log('BASEFEE (0x48)      ', await greeter.baseFee(), '(zero in v1 — no fee market)');

  // --- write: a signed legacy transaction ---------------------------------
  const next = `hello from block ${await hre.ethers.provider.getBlockNumber()}`;
  const tx = await greeter.setGreeting(next);
  console.log('\nsetGreeting tx      ', tx.hash);
  console.log('type                ', tx.type, '(0 = legacy; v1 has no other kind)');

  const receipt = await tx.wait();
  console.log('block               ', receipt.blockNumber);
  console.log('gas used            ', receipt.gasUsed.toString());
  console.log('status              ', receipt.status, receipt.status === 1 ? '(success)' : '(REVERTED — it was mined and it failed)');

  for (const log of receipt.logs) {
    const parsed = greeter.interface.parseLog(log);
    if (parsed) console.log('event               ', parsed.name, parsed.args.map(String));
  }

  console.log('\ngreeting now        ', await greeter.greeting());
}

main().catch(e => { console.error(String(e.message || e)); process.exitCode = 1; });
