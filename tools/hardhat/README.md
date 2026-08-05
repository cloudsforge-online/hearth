# Hardhat template for Hearth

A working Hardhat project pointed at chain id **7411**, compiled for
**Shanghai**, priced as **legacy (type 0)**.

```bash
npm install          # pnpm and yarn work too
npx hardhat compile
```

Both of those were run while this was written. Everything that needs a live
Hearth node was not, and is marked below.

---

## Scripts

| Script | `npm run` | What it does | Needs |
| --- | --- | --- | --- |
| `check-network.js` | `check` | Asserts you are actually talking to Hearth: chain id in both encodings, no `baseFeePerGas`, timestamps in seconds | an endpoint |
| `deploy.js` | `deploy` | Deploys `Greeter`, reads it back, asserts `CHAINID == 7411` | a live chain |
| `interact.js` | `interact` | A read, a write, and the two Hearth-specific opcodes | a live chain |
| `deploy-dex.js` | — | WEMBER → Factory → Router02 → Multicall3, in order, with the post-deployment checks | a live chain, or `npx hardhat node` |
| `swap.js` | `swap` | Adds liquidity to an EMBER/DEMO pool and swaps both ways | the above |

`deploy-dex.js` and `swap.js` run today against Hardhat's own in-process
Shanghai EVM — see [`../../docs/quickstart.md`](../../docs/quickstart.md) §7 for
the full transcript. That rehearsal catches almost everything you would
otherwise get wrong later.

---

## Configuration, and why

```js
solidity: { version: '0.8.26', settings: {
  evmVersion: 'shanghai',
  optimizer: { enabled: true, runs: 999999 },
  metadata: { bytecodeHash: 'none' },
}}
```

**`evmVersion: 'shanghai'` is not optional.** Hardhat's default for solc 0.8.26
is `cancun`, which emits `MCOPY`, `TSTORE` and `TLOAD`. Hearth v1 implements
Shanghai and nothing later. Those opcodes compile silently and hit an invalid
opcode at runtime, on chain, after you have paid to deploy.

The other three match [`../../contracts`](../../contracts) exactly. If you
compile anything that has to interoperate with the Uniswap V2 router — a pair, a
token you intend to pool — it must be built with the same settings, because the
router derives pair addresses from an init code hash that is a function of all
of them.

```js
networks: { hearth: { url, chainId: 7411, accounts, gasPrice: 1_000_000_000 } }
```

**`gasPrice` is a convenience, not a fix.** Measured against
[`../rpc-probe`](../rpc-probe) with ethers 6.15: remove it and ethers still
produces a byte-identical type-0 transaction. It reads
`eth_getBlockByNumber("latest")`, finds no `baseFeePerGas`, concludes there is no
fee market and falls back to `eth_gasPrice`. It never calls `eth_feeHistory`.

The thing that makes Hardhat work here is Hearth **omitting `baseFeePerGas`**
from block responses, which is deliberate. Foundry does not have that fallback
and needs `--legacy`; see [`../foundry/README.md`](../foundry/README.md).

---

## Keys

`HEARTH_PRIVATE_KEY`, from the environment, and nowhere else. There is no key in
`hardhat.config.js` and there must never be one. Copy `.env.example` to `.env`
(gitignored) or export the variable in your shell.

```bash
export HEARTH_RPC_URL=https://rpc-testnet.cloudsforge.online   # testnet, chain id 7412
# …or https://rpc.cloudsforge.online          for mainnet, chain id 7411
# …or http://127.0.0.1:8545                  for a node you run yourself
export HEARTH_PRIVATE_KEY=0x…
export HEARTH_FEE_TO_SETTER=0x…         # only for deploy-dex.js; must be a multisig
```

`deploy-dex.js` refuses to run if `HEARTH_FEE_TO_SETTER` is unset or equals the
deployer. That role controls the protocol fee switch, has no timelock and no
two-step handover, and cannot be safely moved later — moving it requires the
very key you would be trying to stop relying on
([`../../docs/evm-spec.md`](../../docs/evm-spec.md) §7).
