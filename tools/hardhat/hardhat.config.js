/* Hardhat, configured for Hearth (chain id 7411).
 *
 * Two settings in here are load-bearing rather than stylistic. Both are
 * explained where they appear:
 *
 *   1. `evmVersion: 'shanghai'` — Hearth v1 implements Shanghai and nothing
 *      later. Hardhat's default for solc 0.8.26 is `cancun`, which emits
 *      MCOPY / TSTORE / TLOAD. Those compile fine and then hit an invalid
 *      opcode at runtime, on chain, after you have paid to deploy.
 *
 *   2. `gasPrice` set to a number on the network — this pins Hardhat to legacy
 *      (type 0) pricing without a round trip. Hearth v1 has no EIP-1559
 *      (docs/evm-spec.md §3, §9). See the note at the setting itself for what
 *      was actually observed when it is left out, which is NOT what the
 *      folklore says.
 */

require('@nomicfoundation/hardhat-ethers');

/* Chain id — 7411 mainnet, 7412 testnet (docs/evm-spec.md §1, and
 * `node/src/params.js`, which is the only place the mapping lives). It is set
 * from the environment because the two networks MUST NOT share an id: with one
 * id, a transaction signed for the testnet is byte-identical on mainnet, and a
 * faucet becomes a way to drain the account it funds. Hardhat also refuses to
 * send when this disagrees with `eth_chainId`, which is the check that catches
 * a misconfigured node before it costs anything. */
const HEARTH_CHAIN_ID = Number(process.env.HEARTH_CHAIN_ID || 7411);

/* `hearthd --evm` serves eth_* on 8545, path `/` (docs/evm-spec.md §6). The
 * REST API is a different PORT, 8645, and answers `POST /` with a 404 naming
 * this one — so pointing at the wrong port fails loudly rather than looking
 * like an empty chain. */
const RPC_URL = process.env.HEARTH_RPC_URL || 'http://127.0.0.1:8545';

/* NEVER put a key in this file. The account comes from the environment and
 * nothing else; `.env` is gitignored at the repository root. */
const KEY = process.env.HEARTH_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: '0.8.26',
    settings: {
      // These four match contracts/ exactly (contracts/README.md). If you
      // compile anything that has to interoperate with the Uniswap V2 router
      // — a pair, or a token you intend to pool — it must be built with the
      // same settings, because the router derives pair addresses from an init
      // code hash that is a function of all of them.
      optimizer: { enabled: true, runs: 999999 },
      evmVersion: 'shanghai',
      metadata: { bytecodeHash: 'none' },
    },
  },

  networks: {
    hearth: {
      url: RPC_URL,
      chainId: HEARTH_CHAIN_ID,
      accounts: KEY ? [KEY] : [],

      /* LEGACY PRICING — and this setting is a convenience, not a fix.
       *
       * MEASURED, not assumed (against tools/rpc-probe/stub.js, ethers 6.15 /
       * Hardhat 2.29): with this line REMOVED, ethers still produces a type-0
       * transaction. It reads `eth_getBlockByNumber("latest")`, finds no
       * `baseFeePerGas`, concludes the chain has no fee market and falls back
       * to `eth_gasPrice`. The raw transaction is byte-identical either way.
       * It never calls `eth_feeHistory` or `eth_maxPriorityFeePerGas`.
       *
       * So the thing that makes Hardhat work here is the OMISSION of
       * `baseFeePerGas` from Hearth's block responses — which is deliberate
       * and documented at node/src/jsonrpc/methods.js. This line just saves
       * the round trip and pins the price.
       *
       * FOUNDRY IS THE OPPOSITE and does not have this fallback: `forge
       * create` and `cast send` call `eth_feeHistory` unconditionally and
       * abort. They need `--legacy` on the command line. See
       * tools/foundry/README.md.
       *
       * 1 gwei is a placeholder. There is no fee market and no observed
       * clearing price, because there is no chain. Read the live suggestion
       * with `eth_gasPrice` once there is a node to ask. */
      gasPrice: 1_000_000_000,
    },

    /* Hardhat's own in-process EVM, for tests that do not need Hearth. Pinned
     * to Shanghai so a test cannot pass here on an opcode Hearth would reject. */
    hardhat: {
      hardfork: 'shanghai',
      chainId: HEARTH_CHAIN_ID,
    },
  },

  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
};
