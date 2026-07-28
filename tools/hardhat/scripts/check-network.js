/* Run this FIRST. It answers "am I actually talking to Hearth?" and nothing else.
 *
 *   npx hardhat run scripts/check-network.js --network hearth
 *
 * The asymmetry it checks is the one that breaks MetaMask: `eth_chainId`
 * returns HEX (`0x1cf3`) and `net_version` returns DECIMAL (`"7411"`). Get
 * those the wrong way round and MetaMask refuses the network outright with a
 * mismatch error that names neither value.
 */

const CHAIN_ID = 7411;
const CHAIN_ID_HEX = '0x1cf3';

async function main() {
  const provider = hre.ethers.provider;
  const send = (m, p = []) => provider.send(m, p);

  console.log('rpc url          ', hre.network.config.url);

  const chainIdHex = await send('eth_chainId');
  const netVersion = await send('net_version');

  console.log('eth_chainId      ', chainIdHex, '(hex QUANTITY)');
  console.log('net_version      ', JSON.stringify(netVersion), '(decimal STRING)');
  console.log('web3_clientVersion', await send('web3_clientVersion'));
  console.log('eth_blockNumber  ', await send('eth_blockNumber'));
  console.log('eth_gasPrice     ', await send('eth_gasPrice'));

  let bad = 0;
  if (chainIdHex !== CHAIN_ID_HEX) {
    console.error(`FAIL eth_chainId is ${chainIdHex}, want ${CHAIN_ID_HEX} — this is not Hearth`);
    bad++;
  }
  if (netVersion !== String(CHAIN_ID)) {
    console.error(`FAIL net_version is ${JSON.stringify(netVersion)}, want "${CHAIN_ID}"`);
    console.error('     If it came back as "0x1cf3", the node is hex-encoding a method');
    console.error('     that is specified as decimal. MetaMask will reject the network.');
    bad++;
  }

  /* v1 has no EIP-1559 (docs/evm-spec.md §3). A block that carried
   * `baseFeePerGas` would make ethers and viem advertise type-2 transactions
   * this chain cannot execute, so its ABSENCE is a correctness property and
   * worth asserting rather than assuming. */
  const block = await send('eth_getBlockByNumber', ['latest', false]);
  if (block && block.baseFeePerGas !== undefined) {
    console.error('FAIL the latest block carries baseFeePerGas —', block.baseFeePerGas);
    console.error('     v1 must omit it, or every client will build type-2 transactions.');
    bad++;
  } else {
    console.log('baseFeePerGas     absent (correct for v1 — legacy pricing)');
  }

  if (block) {
    const ts = Number(block.timestamp);
    // Milliseconds-as-seconds lands in the year 57,000 and breaks every
    // Solidity `deadline`, including the Uniswap V2 router's (spec §4).
    const year = new Date(ts * 1000).getUTCFullYear();
    console.log('latest timestamp  ', block.timestamp, `→ ${year}`);
    if (year > 2200) {
      console.error('FAIL block.timestamp looks like milliseconds, not seconds.');
      console.error('     Every AMM swap will revert on its deadline check.');
      bad++;
    }
  }

  if (hre.ethers.provider.getSigner && (await hre.ethers.getSigners()).length) {
    const [signer] = await hre.ethers.getSigners();
    const bal = await provider.getBalance(signer.address);
    console.log('signer           ', signer.address);
    console.log('balance          ', hre.ethers.formatEther(bal), 'EMBER');
    if (bal === 0n) {
      console.log('                  (zero — fund it from the faucet: tools/faucet)');
    }
  } else {
    console.log('signer            none — set HEARTH_PRIVATE_KEY to deploy');
  }

  if (bad) {
    console.error(`\n${bad} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll network checks passed.');
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
