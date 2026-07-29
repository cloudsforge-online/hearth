# tools/ — the developer kit

Everything a stranger needs to build on Hearth, and nothing that pretends the
chain is further along than it is.

| Directory | What it is | Runnable today? |
| --- | --- | --- |
| [`hardhat/`](hardhat) | A Hardhat project preconfigured for chain 7411, Shanghai and legacy gas. Deploy, interact, deploy the AMM, run a swap | **Yes** — compiles, and the AMM scripts run end to end against Hardhat's own EVM |
| [`foundry/`](foundry) | The Foundry equivalent: `foundry.toml`, a sample contract, a deploy script, tests | **Yes** — `forge build` and `forge test` pass |
| [`faucet/`](faucet) | A testnet EMBER faucet. Zero dependencies, plain `node:http` | **Yes** — 66 tests pass; runs against a stub node |
| [`explorer-api/`](explorer-api) | The Etherscan-compatible `/api` shim, the address index behind it, and correctly-labelled supply endpoints | **Yes** — 171 tests pass against a fake chain; nothing has run against a node |
| [`verify/`](verify) | Contract source verification: recompile, compare against deployed bytecode, serve the result. Speaks the API `forge verify-contract` speaks | **Yes** — 116 tests pass, including compiling a real `contracts/src` artifact and rejecting a one-byte change |
| [`rpc-probe/`](rpc-probe) | A stub that serves Hearth's real `eth_*` layer over a fake chain, and logs every method a client calls | **Yes** — and read its README before trusting it |
| [`metamask.md`](metamask.md) | Add-network details and the `wallet_addEthereumChain` payload | Reference |

Start at [`../docs/quickstart.md`](../docs/quickstart.md).

---

## The one thing to understand first

**There is no PUBLISHED Hearth network, and there is a chain.**
`node bin/hearthd.js --evm --mine` produces blocks and serves the `eth_*`
surface on `http://127.0.0.1:8545/`; `docker-compose.testnet.yml` runs three
nodes on chain id 7412. What does not exist is an endpoint anyone else can
reach — every port binds loopback.

So these templates are configured against a frozen specification **and** run
against a node you start yourself. Where a value cannot exist without a
deployment it is marked `⬜` rather than filled in with something plausible.
Where a command has never been executed against Hearth, it says so.

## Keys

No tool here has a key in it, and none ever should.

- Every template reads `HEARTH_PRIVATE_KEY` from the environment.
- `.env` is gitignored at the repository root (`.gitignore`: `.env`, `.env.*`,
  `!.env.example`), and every `.env.example` here contains a deliberately
  invalid placeholder rather than a working key.
- The faucet goes further: it refuses to read a key file that resolves to a path
  inside this repository, because `git add -f`, an editor backup and a `cp` to a
  scratch file all defeat a `.gitignore` entry.
