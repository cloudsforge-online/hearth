# Security & completeness review

An independent adversarial audit of Hearth (code correctness, security, and
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
| **M1** | Web wallet is a **mockup** (hardcoded balance, fake mining/send). | 🟡 Labeled as a demo; the real client path is the desktop app + `node/`. Wiring the web wallet to real client-side keys/signing is ⬜ tracked. |
| **M2** | **Mempool** had no size cap and O(n²) admission. | 🟡 Added `MEMPOOL_MAX_TXS` cap; incremental spent-set (vs. full replay) is ⬜ tracked. |
| **M3** | Output amounts not constrained to positive integers ≤ max. | ✅ `Number.isInteger`, `> 0`, `≤ MAX_MONEY` enforced. |
| **M4** | **Commons treasury** funds are unspendable (no governance path). | ⬜ Tracked — governance/multisig spend path is Roadmap Phase 6; documented, not silently broken. |
| **M5** | Rust vs JS **difficulty** algorithms differ (parity risk). | ⬜ Tracked — a single byte-exact difficulty spec must be frozen before both are consensus-active. Emission parity (H7) is already done as the template. |

## Low

| # | Finding | Status |
|---|---------|--------|
| **L1** | No cross-network replay domain in signatures. | ✅ The network id is bound into the signed transaction body. |
| **L2** | RPC has open CORS, unbounded POST body, unbounded SSE clients. | ⬜ Tracked — cap body/SSE, document that RPC must sit behind a proxy in production. |
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
