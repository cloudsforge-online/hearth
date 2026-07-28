# rust/ — Hearth core crate (NOT a node, NOT consensus)

> **Read this before you read the code.** `hearthd` is intended to become the
> production node. It is not one yet, and it is not close. There is no block
> type, no chain, no fork choice, no storage, no RPC and no P2P server —
> `main.rs` runs a self-check and a proof-of-work benchmark and exits.
>
> Two modules would give the **wrong answer** if they were wired to a chain:
>
> * `src/pow.rs` omits the coinbase public key from the PoW seed, so it computes
>   a different digest from `node/src/pow.js` for the same header.
> * `src/difficulty.rs` moves ±1 leading-zero bit per retarget; consensus is a
>   256-bit LWMA over the last 60 targets.
>
> `node/` is the network. Nothing in this directory has ever validated a block,
> and nothing here should be cited as evidence of what a valid block is.

What it *does* have is a **zero-dependency, pure-`std`** trusted computing base
for the hot path: SHA-256 written from scratch and tested against FIPS vectors,
the memory-hard Homefire core, and libraries for the ledger, mempool and Tab
channels. The emission schedule is byte-identical to consensus and test-pinned —
so far the only rule that is.

Why Rust, and exactly where the port stands:
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
| File | Purpose | Consensus-compatible? |
|---|---|---|
| `src/sha256.rs` | pure-std SHA-256 (FIPS 180-4) + hex | ✅ |
| `src/ledger.rs` | emission, coinbase, UTXO apply, signed spends | ✅ emission; rest never driven by a chain |
| `src/pow.rs` | Homefire memory-hard core | ❌ seed omits the coinbase pubkey |
| `src/difficulty.rs` | retarget sketch | ❌ ±1 bit, not the 256-bit LWMA |
| `src/mempool.rs`, `src/netmsg.rs`, `src/tab.rs` | libraries, not wired to anything | n/a |
| `src/main.rs` | self-check + PoW benchmark. Not a node. | n/a |

## Roadmap for this crate
First reconcile the two ❌ rows above against `node/src/`, with a
cross-implementation conformance test in CI — the model is
`node/test/browser-pow.js`, which is why the browser miner never drifted and this
crate did. Then grow the missing layers: block → chain → fork choice → storage →
P2P → RPC. Mainnet is intended to run on this core; today it cannot run anything.
See [../docs/roadmap.md](../docs/roadmap.md).
