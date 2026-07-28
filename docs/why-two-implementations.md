# Two implementations — a transition, not a design

> **There are not two clients today. There is one.** `node/` is the network.
> `rust/hearthd` is a crate that runs a self-check and a proof-of-work benchmark:
> it has no block store, no chain, no fork choice, no RPC and no P2P server, and
> `main.rs` never accepts a block. It is a *library and a benchmark*, and it is
> **consensus-INCOMPATIBLE** in two specific, load-bearing ways:
>
> * `pow.rs` omits the coinbase public key from the PoW seed, so it computes a
>   different digest from `node/src/pow.js` for the same header.
> * `difficulty.rs` moves ±1 leading-zero *bit* per retarget; consensus is a
>   256-bit LWMA over the last 60 targets (`node/src/chain.js`).
>
> Nothing here is a bug to be fixed casually — the crate was never wired to a
> chain, so nothing has ever been forced to agree. But it means you must not read
> `rust/hearthd` as a second opinion about what a block is. If the two disagree,
> the JS node is right by definition, because it is the only one that has ever
> validated a block.

A fair question: *if this is money, why is there JavaScript in it, and why two
clients?* The honest answer: **there is one target implementation — the Rust
node.** The JavaScript node is a temporary reference we intend to port away from.
This document explains the plan and where the line actually is today.

## End state (the goal)
**One implementation: `rust/hearthd`.** A single, fast, memory-safe node with a
minimal dependency set. When it reaches feature parity, the JavaScript node is
demoted to a cross-implementation *test oracle* and then removed. Two clients is
a migration phase, not the architecture.

## Why a JS reference existed at all
A fully networked, audited Rust node is a large effort. Shipping a readable
reference first let us:
1. **pin down the spec** in code that's easy to read and test,
2. **prove the economics and consensus rules** end to end (`node/test/e2e.js`
   now covers emission, the Commons split, fee burn, coinbase maturity,
   anti-inflation, and **chain reorganization**), and
3. **grow the Rust core against that spec**, module by module, with CI keeping
   both honest.

This is the same path Bitcoin and Ethereum took (a reference client, then
performance clients). The difference: we intend to converge to **one**.

## Where the port stands today

| Capability | JS `node/` (the network) | Rust `hearthd` (a crate) |
|---|:---:|:---:|
| Emission schedule | ✅ | ✅ **byte-identical, test-pinned** |
| SHA-256 | ✅ | ✅ (pure std, FIPS vectors) |
| Homefire PoW | ✅ | ❌ **different digest** — `pow.rs` leaves the coinbase pubkey out of the seed |
| Difficulty retargeting | ✅ 256-bit LWMA over 60 targets | ❌ **different rule** — ±1 leading-zero bit per retarget |
| Ed25519 keys + checksummed addresses | ✅ | ✅ (ed25519-dalek) |
| Signed UTXO ledger + fee burn | ✅ | 🟡 library only, never driven by a chain |
| Mempool (fee-ordered, double-spend safe) | ✅ | 🟡 library only |
| Application records (consensus) | ✅ | ⬜ |
| Block structure / storage | ✅ | ⬜ |
| Fork choice / reorg | ✅ | ⬜ |
| P2P networking + sync | ✅ | 🟡 message framing only, no server |
| RPC / SSE | ✅ | ⬜ |
| Tab payment channels | ⬜ | 🟡 signed state machine, not wired to a chain |

The **emission schedule is already frozen and byte-identical** across both (a
parity test pins exact values). That is the template for freezing the rest — and
also the honest measure of how much of the rest is still open. The two ❌ rows
are the ones that would fork the chain, and both must be reconciled *before*
`rust/hearthd` is allowed anywhere near a block.

## Why the target is Rust (not JS)
For money you want predictable latency and a small attack surface: no GC pauses,
memory safety, and few dependencies. The measured gap is real — the same
Homefire PoW runs several times faster in Rust than in the JS prototype on the
same machine — and the Rust ledger already uses `u64` checked arithmetic, avoiding
the JS `Number` precision limit (see [security-review.md](security-review.md), H5).

## Keeping them honest during the transition
- **Consensus constants** live in one place per client. Emission is identical and
  test-pinned; PoW and difficulty are *not*, and the table above says so.
- **CI** builds and tests both on every push — but note what that does and does
  not prove. `cargo test` checks the Rust crate against itself. There is no
  cross-implementation conformance test for PoW or difficulty, which is exactly
  why the two drifted without anything going red. The browser miner has one
  (`node/test/browser-pow.js`), and that is the model to copy when the Rust core
  is brought back onto consensus.
- Divergences are tracked as findings (e.g. the difficulty algorithm, M5 in the
  [security review](security-review.md)) and must be reconciled before either is
  consensus-active on mainnet.

## Migration plan
Bring Rust to parity in this order — ledger ✅ → mempool ✅ → difficulty → P2P →
fork choice → block storage → RPC — using the JS client as a conformance oracle,
then retire it. See [roadmap.md](roadmap.md), Phases 1–7.
