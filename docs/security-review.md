# Security & completeness review — **of the UTXO-era code**

> ## Scope, before anything else
>
> **This review predates every line of the EVM.** It was conducted against the
> UTXO ledger, its Ed25519 signatures, its `ember1…` addresses and its REST API —
> the chain that is now being retired. Nothing in `node/src/{crypto,state,evm,chain,jsonrpc}/`
> has been reviewed here, and neither has the account model.
>
> **It is not an audit and must never be cited as one.** It is an internal
> adversarial review whose findings were implemented. Nothing in this repository
> has been independently audited
> ([`listing-checklist.md`](listing-checklist.md) §4).
>
> The EVM's assurance comes from a different mechanism entirely: Ethereum's
> published conformance vectors, which are CI-relevant and cover 609/609 VMTests,
> 20,067/20,077 GeneralStateTests and 188/188 TransactionTests. Vectors make an
> EVM tractable; they do not make it audited.

An internal adversarial review of Hearth (code correctness, security, and
functionality gaps that would block it from being real money), plus the status
of each finding. Findings are ranked most-severe first. "Fixed" items ship with
tests; "tracked" items are documented with a concrete plan on the
[roadmap](roadmap.md).

Legend: ✅ fixed & tested · 🟡 partially addressed · ⬜ tracked (not yet applied)

## Critical

| # | Finding | Status |
|---|---------|--------|
| **C1** | **Coinbase could mint unlimited coins.** Validation only checked the miner + commons outputs, not the total or output count, so a miner could add a third output paying itself arbitrary EMBER. | ✅ `chain.js` now caps coinbase to ≤2 outputs and requires `sum(outputs) === subsidy + tips` exactly. Test: *coinbase minting extra coins rejected*. |
| **C2** | **No fork choice / no reorg.** The node accepted only `height+1` on one chain and dropped everything else, so two miners at the same height split the network permanently. | ✅ `chain.js` rewritten with a block store, per-branch **cumulative-work** fork choice, and full **reorganization** (UTXO rebuilt on the winning branch). Test: *chain reorged to the heavier branch* / *orphaned payment removed by reorg*. |
| **C3** | **No coinbase maturity.** Freshly mined coins were spendable immediately, unsafe under reorgs. | ✅ UTXOs are tagged coinbase+height; spends of coinbase outputs younger than `COINBASE_MATURITY` (10 dev / ~100 prod) are rejected. Test: *immature coinbase spend rejected*. |

## High

| # | Finding | Status |
|---|---------|--------|
| **H1** | **Private keys stored in plaintext** (`wallet.json`). | ⬜ Tracked. Plan: scrypt/argon2-derived key + AES-GCM keystore; never persist raw PEM. Roadmap Phase 2. |
| **H2** | **No upper bound on block timestamps** → difficulty manipulation. | ✅ Reject `timestamp > now + 2h`; require `timestamp > median-time-past(11)`. Miner timestamps are strictly monotonic. |
| **H3** | **No block-size / tx-count limits** → CPU/memory DoS via a giant block. | ✅ `MAX_BLOCK_TXS`, `MAX_TX_INPUTS`, `MAX_TX_OUTPUTS` enforced before heavy work. |
| **H4** | **P2P: unbounded read buffer, no peer cap, no network id.** | ✅ Buffer capped (`P2P_MAX_LINE`, drop offenders), inbound peers capped (`P2P_MAX_PEERS`), and the `hello` handshake now carries the network id (cross-network peers rejected). Eclipse-resistance (peer diversity/persistence) remains ⬜ tracked. |
| **H5** | **JS `Number` precision on amounts** — aggregate supply crosses `MAX_SAFE_INTEGER` (~90M EMBER) in ~9 years. | 🟡 The **production Rust core uses `u64` with checked arithmetic** (correct). The JS reference adds a `MAX_MONEY` per-output cap and integer checks; a full BigInt migration of the JS client is ⬜ tracked. |
| **H6** | **No address checksum** → funds lost to a typo. | ✅ Addresses are now `ember1 + 40-hex body + 6-hex checksum` (identical in JS and Rust); wallets validate the destination before building a payment. Tests in both clients. |
| **H7** | **Emission used floating-point `Math.pow` in consensus** → cross-engine divergence. | ✅ Replaced with a **deterministic integer** schedule (linear interpolation between halvings) computed identically in JS and Rust; a parity test pins exact values (`subsidy(4_207_680) == 300_000_000`, …). |
| **H8** | **Stored XSS in the block explorer** via a miner-controlled coinbase address rendered with `innerHTML`. | ✅ Explorer rows are built with `textContent`/`createElement` — node-supplied strings can no longer inject markup. |

## Medium

| # | Finding | Status |
|---|---------|--------|
| **M1** | Web wallet is a **mockup** (hardcoded balance, fake mining/send). | ✅ **Closed, and then superseded.** The wallet is now real, non-custodial and secp256k1: keys generated in the tab, sealed with PBKDF2 → AES-256-GCM, signing legacy transactions at 18 decimals. Its crypto is a *port* of `node/src`, and CI runs both over the same random inputs and compares them (`web/assets/wallet-selftest.js`, 141 checks) — a cross-check that found a real gas bug in the node on its first run. |
| **M2** | **Mempool** had no size cap and O(n²) admission. | 🟡 Added `MEMPOOL_MAX_TXS` cap; incremental spent-set (vs. full replay) is ⬜ tracked. |
| **M3** | Output amounts not constrained to positive integers ≤ max. | ✅ `Number.isInteger`, `> 0`, `≤ MAX_MONEY` enforced. |
| **M4** | **Commons treasury** funds are unspendable (no governance path). | ⬜ Tracked — governance/multisig spend path is Roadmap Phase 6; documented, not silently broken. |
| **M5** | Rust vs JS **difficulty** algorithms differ (parity risk). | ⬜ Tracked — a single byte-exact difficulty spec must be frozen before both are consensus-active. Emission parity (H7) is already done as the template. |

## Low

| # | Finding | Status |
|---|---------|--------|
| **L1** | No cross-network replay domain in signatures. | ✅ The network id is bound into the signed transaction body. |
| **L2** | RPC has open CORS, unbounded POST body, unbounded SSE clients. | 🟡 The POST body is now capped at `MAX_TX_BYTES + 8,192` = 108,192 bytes, answered with 413, and the socket destroyed (`node/src/rpc.js:257-290`). CORS is still `*` and SSE clients are still uncapped, both deliberately — the node is meant to sit behind a proxy, and [`../SECURITY.md`](../SECURITY.md) declares that out of scope rather than pretending otherwise. |
| **L3** | Append-only persistence with no atomicity; blocks trusted on reload. | 🟡 Blocks are now **re-validated on reload** (full replay through consensus). Atomic writes/fsync + integrity marker ⬜ tracked. |

## Bottom line
The two individually-fatal issues — **C1 (unlimited mint)** and **C2 (no fork
choice)** — are fixed and covered by end-to-end tests, along with coinbase
maturity, timestamp bounds, DoS caps, address checksums, deterministic emission,
and the explorer XSS. The remaining items (wallet-key encryption, JS BigInt
amounts, mempool eviction, governance spend path, difficulty-spec freeze) are
documented with concrete plans and, where it matters most, the **Rust production
core already implements the correct behavior** (u64 value math, signed ledger).
None of the open items are consensus-fatal for a testnet; all must close before
mainnet — see the [roadmap](roadmap.md).

*Re-run the evidence:* `cd node && node test/unit.js && node test/e2e.js` and
`cd rust/hearthd && cargo test`.

**What this review does not cover, restated because it is now most of the
repository:** the EVM (`node/src/{crypto,state,evm,chain}/`), the JSON-RPC surface
(`node/src/jsonrpc/`), the `hearth` CLI, the AMM contracts, the EVM-aware explorer
and the secp256k1 browser wallet. For those, see
[`../MAP.md`](../MAP.md) §4 and the audit scope in
[`listing-checklist.md`](listing-checklist.md) §4.
