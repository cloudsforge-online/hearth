# Roadmap

Honest status: Hearth today is a **complete design + working proof-of-concept +
full web layer on demo data**. This is the path from here to a live network.

## Legend
✅ done · 🟡 in progress · ⬜ planned

## Phase 0 — Concept & proof-of-concept *(this repo)*
- ✅ Whitepaper, coinnomics, architecture, mining specs
- ✅ Homefire PoW proof-of-concept (memory-hard) — `proto/`
- ⬜ Non-outsourceable puzzle (private key inside the hash loop) — an open
  consensus decision, not implemented; see [mining.md](mining.md)
- ✅ Runnable emission/coinnomics simulator
- ✅ Web layer: marketing site, web wallet, browser miner, block explorer
- ⬜ Hearth Pay merchant SDK — `web/pay-demo.html` is a mockup that settles nothing
- ✅ Brand & visual identity

## Phase 1 — Node core (`hearthd`, Rust)
- 🟡 Block/tx types, serialization, genesis (tx/ledger types done)
- ✅ UTXO ledger + Ed25519 signatures + checksummed addresses + emission/fee burn
- ✅ Deterministic integer emission (byte-identical to the JS reference, parity-tested)
- ✅ Mempool (fee-ordered, double-spend safe)
- ✅ Tab payment channels (signed off-chain state machine)
- 🟡 Homefire PoW (memory-hard core done, but the Rust seed omits the coinbase
  pubkey — reconcile with consensus first, then grow toward a RandomX-class VM)
- 🟡 Difficulty retargeting (256-bit LWMA in JS; the Rust ±1-bit sketch is not it —
  freeze a byte-exact spec, then port)
- 🟡 P2P (wire framing + TCP handshake done; port gossip/sync)
- ⬜ Fork choice / reorg, block storage, JSON-RPC/WebSocket/REST
- ⬜ Stealth addresses + view keys; warmshare/uncle rules
- ⬜ Deterministic, reproducible builds

*Fork choice + reorg, coinbase maturity, timestamp bounds, DoS caps, address
checksums, and deterministic emission are already implemented and tested in the
JS reference (see [security-review.md](security-review.md)); the Rust port
inherits these as it reaches parity.*

## Phase 2 — Wallet & mining UX
- ⬜ HD wallet, stealth scanning, tx builder
- ⬜ Polite miner (AC/idle detection, throttle, thermal back-off)
- ⬜ Tauri desktop app (node + wallet + miner, "living hearth" UI)
- ⬜ WASM light-miner for the browser
- ⬜ Web wallet wired to real `hearthd` (replace demo data)

## Phase 3 — Payments & merchants
- ⬜ Tab payment-channel layer (open/update/close, routing)
- ⬜ `hearth:` URI scheme + wallet handlers
- ⬜ Hearth Pay SDK against live settlement
- ⬜ Reference merchant plugins (Woo/Shopify-style)

## Phase 4 — Explorer & infra
- ⬜ Explorer backend over node REST (replace demo generator)
- ⬜ Seed nodes, DNS seeds, network dashboards

## Phase 5 — Security & economics review
- ⬜ Independent audits of the PoW VM, consensus, and Tab
- ⬜ Public testnet ("Kindling") with fair-launch rehearsal
- ⬜ Economic review / adversarial modeling of emission + burn
- ⬜ Spec freeze of consensus constants

## Phase 6 — Governance
- ⬜ On-chain Commons treasury + hybrid voting (coin-weight + one-node-one-vote)
- ⬜ Proposal & upgrade process

## Phase 7 — Mainnet
- ⬜ Genesis with **no premine / no ICO / no allocation**
- ⬜ Coordinated launch, seed distribution
- ⬜ Bug-bounty program funded by the Commons

## Where to help first
Highest-leverage contributions right now:
1. **The Homefire VM** in Rust (`node/`) — the heart of CPU-fairness.
2. **Tab channels** — makes EMBER usable as everyday money.
3. **The Tauri desktop app** — one-click node+wallet+miner for non-technical users.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
