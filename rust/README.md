# rust/ — Hearth production core

`hearthd` (Rust) is the **fast, stable, secure** foundation for the production
network. Today it implements and benchmarks the consensus-critical hot path — the
Homefire memory-hard proof-of-work — with a **zero-dependency, pure-`std`** trusted
computing base (SHA-256 is implemented from scratch and tested against FIPS
vectors).

Why Rust, and why a second implementation exists alongside the JS reference:
see [../docs/why-two-implementations.md](../docs/why-two-implementations.md).

## Build & run

```bash
cd hearthd
cargo build --release
cargo run --release -- 20        # mine a demo block at 20 leading-zero-bit difficulty
```

## Quality gates (same as CI)

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test                       # sha256 vectors + Homefire determinism + mining
```

## Layout
| File | Purpose |
|---|---|
| `src/sha256.rs` | pure-std SHA-256 (FIPS 180-4) + hex |
| `src/pow.rs` | Homefire memory-hard PoW + difficulty checks |
| `src/main.rs` | mining loop / benchmark entry point |

## Roadmap for this crate
Grow modules to parity with the JS reference — ledger → mempool → P2P → RPC — with
the reference client acting as a conformance oracle. Mainnet runs on this core.
See [../docs/roadmap.md](../docs/roadmap.md).
