# Architecture

A map of the whole system, from consensus up to the "Accept EMBER" button.

```
                         ┌───────────────────────────────────────────┐
                         │                users                       │
                         └───────────────────────────────────────────┘
   Desktop app (Tauri)        Web wallet            Merchant site
   node + wallet + miner      keys client-side      <script hearth-pay.js>
        │                          │                        │
        │  JSON-RPC / WebSocket    │  JSON-RPC / WS         │ hearth: URI + node sub
        ▼                          ▼                        ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                          hearthd  (Rust)                             │
   │                                                                      │
   │  P2P gossip ─ Mempool ─ Consensus (Homefire PoW) ─ UTXO ledger       │
   │      │            │             │                       │            │
   │      │            │             │                       ├─ stealth   │
   │      │            │             │                       │  addresses │
   │      │            │             ├─ difficulty (LWMA)    │            │
   │      │            │             ├─ warmshares (uncles)  │            │
   │      │            │             └─ Commons minting      │            │
   │      │            └─ base-fee burn (EIP-1559 style)                  │
   │      └─ Tab payment-channel routing                                  │
   │                                                                      │
   │  Storage: append-only blocks + UTXO set (RocksDB/redb)               │
   │  APIs: JSON-RPC, WebSocket (blocks/mempool), REST (explorer)         │
   └─────────────────────────────────────────────────────────────────────┘
```

## Components

### `hearthd` — the node (Rust)
Chosen for memory safety and performance on consensus-critical code. Modules:

- **`consensus/`** — block validation, Homefire PoW verification, LWMA difficulty,
  warmshare/uncle rules, Commons minting, base-fee burn.
- **`pow/`** — the RandomX-class VM: dataset generation, program compilation,
  execution, and the non-outsourceable signature check.
- **`ledger/`** — UTXO set, stealth-address outputs, view keys.
- **`mempool/`** — fee-market, base-fee computation, tip ordering.
- **`p2p/`** — libp2p-style gossip, headers-first sync, compact blocks.
- **`tab/`** — payment-channel open/update/close and routing.
- **`rpc/`** — JSON-RPC + WebSocket + a REST surface for the explorer.
- **`wallet/`** — HD keys, stealth scanning, transaction building, polite miner.

A minimal buildable skeleton lives in [`../node`](../node).

### Consensus at a glance
- **PoW:** Homefire (see [`mining.md`](mining.md)). Memory-hard + non-outsourceable.
- **Block time:** 15s, retargeted every block via LWMA for smoothness.
- **Block size:** dynamic, bounded by a penalty function so capacity tracks demand
  without unbounded growth.
- **Finality:** probabilistic (PoW). Retail instant-finality is handled off the
  base layer by **Tab** channels; large settlements wait for confirmations.

### Ledger & privacy
UTXO model (parallelizable validation, clean SPV proofs) with **one-time stealth
addresses** by default so recipients/amounts aren't trivially linkable. Optional
**view keys** allow voluntary disclosure (accounting, audits).

### Tab — retail payments
A payment-channel layer: two parties (or a small hub graph) open a channel funded
on-chain, then exchange signed balance updates instantly and for free, settling
net to the base chain on close. This is what makes "buy a coffee" feel instant and
sub-cent while keeping the base layer lean.

### Apps
- **Desktop (Tauri):** Rust core + web UI = small binaries, native performance,
  and the rich "living hearth" graphics without Electron's bloat.
- **Web wallet:** all key material stays client-side (WebCrypto); talks to a public
  or self-hosted `hearthd` over JSON-RPC/WS. A **WASM light-miner** lets users mine
  in a browser tab.
- **Explorer:** a static front-end (`web/index.html`) over the node's REST API.
- **Hearth Pay SDK:** `web/assets/hearth-pay.js` — a drop-in merchant button that
  builds a `hearth:` payment URI and watches the merchant's node for settlement.

## Tech choices & rationale

| Concern | Choice | Why |
|---|---|---|
| Consensus code | Rust | safety + speed where bugs are catastrophic |
| PoW | RandomX-class + non-outsourceable | CPU-fair, pool-resistant |
| Ledger | UTXO + stealth | privacy, parallel validation, SPV |
| Storage | redb / RocksDB | embedded, fast, no external DB to run |
| Retail | Tab channels | instant, near-free, base-layer stays lean |
| Desktop | Tauri | great graphics, tiny footprint, cross-platform |
| Web | vanilla + WASM | zero-install, no framework lock-in for the SDK |
| Governance | on-chain Commons | fund development without capture |

## Data flow: a coffee purchase
1. Merchant page renders a Hearth Pay button (`data-amount`, `data-to`).
2. Shopper taps it → wallet opens the `hearth:` URI, signs a Tab update.
3. Update is exchanged instantly; SDK fires `hearth:paid` → order fulfilled.
4. Channel settles net to the base chain later; base fee is burned.

Compare to cards: no custodian, no 1–3% fee, no chargeback risk, ~instant.
