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
| `node/` | JS **reference** node/wallet/miner (runs today; powers the local network & web) |
| `rust/hearthd/` | Rust **production** core (fast/stable/secure foundation) |
| `web/` | website + web wallet + explorer + Hearth Pay SDK |
| `proto/` | economics simulator + standalone PoW demo |
| `docs/` | whitepaper support: architecture, coinnomics, mining, roadmap |

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
- `node/`: `node test/unit.js && node test/e2e.js` must pass.
- `rust/hearthd/`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- `web/`: `node --check` on any changed JS.
- CI (`.github/workflows/ci.yml`) runs all of the above on every PR.

## Good first areas
1. **Homefire VM** — grow the Rust PoW toward a full RandomX-class engine.
2. **Tab channels** — the instant retail-payments layer.
3. **Tauri desktop app** — one-click node + wallet + miner for non-technical users.
4. **Explorer backend** — serve real data behind `web/explorer.html`.

See the [roadmap](docs/roadmap.md) for the bigger picture.

## Commit style
Small, focused commits with clear messages. Reference issues where relevant.
By contributing you agree to license your work under the repository's
[MIT License](LICENSE).
