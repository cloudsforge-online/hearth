# Contributing to Hearth

Hearth is a commons — money that belongs to the people who use and build it. All
contributions are welcome, from typo fixes to consensus code.

## Ground rules
- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Discuss big changes in an issue before you build them.
- Keep the trusted computing base small: the Rust core has **zero third-party
  dependencies** on purpose — think hard before adding any.

## Project layout
| Path | What it is |
|---|---|
| `node/` | JS **reference** node/wallet/miner, **and the whole EVM** (runs today; powers the local network) |
| `rust/hearthd/` | Rust **production** core — today a self-check binary and a PoW benchmark, not a node |
| `app-desktop/` | The Tauri desktop miner for macOS, Windows and Linux |
| `contracts/` | WEMBER, a Uniswap V2 port, Multicall3 |
| `tools/` | Developer kit: faucet, Hardhat/Foundry templates, RPC probe, explorer API, verifier |
| `branding/` | Brand note and marks, including `logo.svg`, the only vector source |
| `proto/` | economics simulator + standalone PoW demo |
| `docs/` | whitepaper support: architecture, coinnomics, mining, roadmap |

**There is no `web/` or `site/` any more** — the pre-migration front ends were deleted
on 2026-08-04 (`48bc28a`). The explorer is now
[`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web) and the
wallet is [`micro-hearth-wallet-core`](https://github.com/cloudsforge-online/micro-hearth-wallet-core);
see [`MAP.md`](MAP.md) §3.4.

See [docs/why-two-implementations.md](docs/why-two-implementations.md) for how the
JS and Rust clients relate.

## Dev setup

```bash
# reference node + tests (needs Node 18+)
cd node
node test/unit.js
node test/e2e.js
node bin/hearthd.js --mine          # run a mining node

# rust production core (needs stable Rust)
cd rust/hearthd
cargo fmt --check && cargo clippy -- -D warnings
cargo test
cargo run --release -- 20            # mine a demo block at 20-bit difficulty

# a real multi-node network on your machine
docker compose up --build            # seed + 2 miners + web on :8080
# or without Docker:
./scripts/run-local-network.sh
```

## Before you open a PR
- `node/`: **`npm test`** must pass — the whole suite, not two files. CI runs exactly
  this one command, so a suite is covered the moment `package.json` names it.
- `rust/hearthd/`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- CI (`.github/workflows/ci.yml`) runs all of the above on every PR.

> If you change `node/src/crypto/`, `node/src/chain/transaction.js` or
> `node/src/cli/keystore.js`, note that
> [`micro-hearth-wallet-core`](https://github.com/cloudsforge-online/micro-hearth-wallet-core)
> executes those modules in-process as the oracle for its own suite. A byte-level change
> here turns that repository red **by design** — but check it, rather than being
> surprised by it.

## Good first areas
1. **Homefire VM** — grow the Rust PoW toward a full RandomX-class engine.
2. **Tab channels** — the instant retail-payments layer.
3. **A merchant/payment path** — there is none. The old `pay-demo.html` was a mockup
   that simulated settlement on a timer, and it was deleted rather than finished.
4. **Consensus on the account model** — the EVM is built and unit-tested, but no block
   has driven it. This is the largest genuine gap; see [`MAP.md`](MAP.md).

See the [roadmap](docs/roadmap.md) for the bigger picture.

## Commit style
Small, focused commits with clear messages. Reference issues where relevant.
By contributing you agree to license your work under the repository's
[MIT License](LICENSE).
