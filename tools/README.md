# tools/ — the developer kit

Everything a stranger needs to build on Hearth, and nothing that pretends the
chain is further along than it is.

| Directory | What it is | Runnable today? |
| --- | --- | --- |
| [`hardhat/`](hardhat) | A Hardhat project preconfigured for chain 7411, Shanghai and legacy gas. Deploy, interact, deploy the AMM, run a swap | **Yes** — compiles, and the AMM scripts run end to end against Hardhat's own EVM |
| [`foundry/`](foundry) | The Foundry equivalent: `foundry.toml`, a sample contract, a deploy script, tests | **Yes** — `forge build` and `forge test` pass |
| [`faucet/`](faucet) | A testnet EMBER faucet. Zero dependencies, plain `node:http` | **Yes** — 66 tests pass; runs against a stub node |
| [`rpc-probe/`](rpc-probe) | A stub that serves Hearth's real `eth_*` layer over a fake chain, and logs every method a client calls | **Yes** — and read its README before trusting it |
| [`metamask.md`](metamask.md) | Add-network details and the `wallet_addEthereumChain` payload | Reference |

Start at [`../docs/quickstart.md`](../docs/quickstart.md).

---

## The one thing to understand first

**There is no live Hearth network.** Phases 1–4 of
[`../docs/evm-spec.md`](../docs/evm-spec.md) §8 are built and gated on published
reference vectors, and the `eth_*` JSON-RPC layer exists in `node/src/jsonrpc/`
and is tested against an in-memory fake — but **phase 5, consensus on the
account model, has not landed.** Nothing produces blocks and no endpoint serves
these methods over a real chain.

So these templates are configured against a frozen specification rather than a
running node. Where a value cannot exist yet it is marked `⬜` rather than filled
in with something plausible. Where a command has never been executed against
Hearth, it says so.

## Keys

No tool here has a key in it, and none ever should.

- Every template reads `HEARTH_PRIVATE_KEY` from the environment.
- `.env` is gitignored at the repository root (`.gitignore`: `.env`, `.env.*`,
  `!.env.example`), and every `.env.example` here contains a deliberately
  invalid placeholder rather than a working key.
- The faucet goes further: it refuses to read a key file that resolves to a path
  inside this repository, because `git add -f`, an editor backup and a `cp` to a
  scratch file all defeat a `.gitignore` entry.
