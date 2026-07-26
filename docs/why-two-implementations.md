# Two implementations — a transition, not a design

A fair question: *if this is money, why is there JavaScript in it, and why two
clients?* The honest answer: **there is one target implementation — the Rust
node.** The JavaScript node is a temporary reference we are actively porting
away from. This document explains the plan and where the line is today.

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

| Capability | JS `node/` (reference) | Rust `hearthd` (target) |
|---|:---:|:---:|
| SHA-256 / Homefire PoW | ✅ | ✅ (pure std) |
| Ed25519 keys + checksummed addresses | ✅ | ✅ (ed25519-dalek) |
| Signed UTXO ledger + emission + fee burn | ✅ | ✅ |
| Mempool (fee-ordered, double-spend safe) | ✅ | ✅ |
| Difficulty retargeting (LWMA) | ✅ | 🟡 (algorithm to be frozen to match) |
| P2P networking + sync | ✅ | 🟡 (message framing done) |
| Fork choice / reorg | ✅ | ⬜ |
| Tab payment channels | ⬜ | ✅ |
| Block storage / RPC | ✅ | ⬜ |

The **emission schedule is already frozen and byte-identical** across both (a
parity test pins exact values), which is the template for freezing difficulty and
the rest.

## Why the target is Rust (not JS)
For money you want predictable latency and a small attack surface: no GC pauses,
memory safety, and few dependencies. The measured gap is real — the same
Homefire PoW runs several times faster in Rust than in the JS prototype on the
same machine — and the Rust ledger already uses `u64` checked arithmetic, avoiding
the JS `Number` precision limit (see [security-review.md](security-review.md), H5).

## Keeping them honest during the transition
- **Consensus constants** live in one place per client and are mirrored; the
  emission rule is already identical and test-pinned.
- **CI** builds and tests both on every push.
- Divergences are tracked as findings (e.g. the difficulty algorithm, M5 in the
  [security review](security-review.md)) and must be reconciled before either is
  consensus-active on mainnet.

## Migration plan
Bring Rust to parity in this order — ledger ✅ → mempool ✅ → difficulty → P2P →
fork choice → block storage → RPC — using the JS client as a conformance oracle,
then retire it. See [roadmap.md](roadmap.md), Phases 1–7.
