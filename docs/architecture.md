# Architecture

A map of the whole system, from consensus up to the merchant layer. Boxes marked
*(design)* do not exist in this repository; everything else does.

```
                         ┌───────────────────────────────────────────┐
                         │                users                       │
                         └───────────────────────────────────────────┘
   Desktop app (design)       Web wallet + miner    Merchant site (design)
   node + wallet + miner      keys client-side      <script hearth-pay…>
        │                          │                        │
        │  JSON-RPC / WebSocket    │  JSON-RPC / WS         │ hearth: URI + node sub
        ▼                          ▼                        ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │              hearthd  (JS today; Rust is the target)                 │
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

### `hearthd` — the node (Rust) *(design; see the note under the diagram)*
Chosen for memory safety and performance on consensus-critical code. This is the
intended module layout. `rust/hearthd` today has `crypto`, `ledger`, `mempool`,
`difficulty`, `netmsg`, `pow`, `sha256` and `tab` — libraries, no node — and its
`pow` and `difficulty` do not match consensus.

- **`consensus/`** — block validation, Homefire PoW verification, LWMA difficulty,
  warmshare/uncle rules, Commons minting, base-fee burn.
- **`pow/`** — the RandomX-class VM: dataset generation, program compilation,
  execution, and the coinbase-key signature check.
- **`ledger/`** — UTXO set, stealth-address outputs, view keys.
- **`mempool/`** — fee-market, base-fee computation, tip ordering.
- **`p2p/`** — libp2p-style gossip, headers-first sync, compact blocks.
- **`tab/`** — payment-channel open/update/close and routing.
- **`rpc/`** — JSON-RPC + WebSocket + a REST surface for the explorer.
- **`wallet/`** — HD keys, stealth scanning, transaction building, polite miner.

The node that actually runs the network is the JS one in [`../node`](../node).

### Consensus at a glance
- **PoW:** Homefire (see [`mining.md`](mining.md)). Memory-hard; the proof must be
  signed by the key its coinbase pays, which stops work being redirected but does
  not make the puzzle non-outsourceable.
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
  or self-hosted `hearthd` over JSON-RPC/WS.
- **Browser miner:** `web/mine.html` — a Web Worker pool running the same Homefire
  the node runs, against `/mining/template` and `/mining/submit`. Not WASM: the
  bottleneck is `crypto.subtle.digest` being async at ~8,450 hashes per attempt,
  so the win came from a synchronous SHA-256, not from a different language. The
  page holds the key and signs the winning digest itself, which is why no
  operator can take work built for your key. See
  [mining.md](mining.md#mining-in-a-browser).
- **Explorer:** a static front-end (`web/index.html`) over the node's REST API,
  reached same-origin at `/rpc` so the page and the node it describes cannot
  disagree about being up.
- **Hearth Pay (design):** `web/assets/hearth-pay-demo.js` is a **mockup** — it
  renders the button and simulates its own settlement. The intended SDK builds a
  `hearth:` payment URI, hands off to the shopper's wallet and watches the
  merchant's node for settlement. The node side of that already exists
  (`GET /address/:addr`, `GET /tx/:txid`); the wallet handoff does not.
- **Chat:** `node/src/apps/chat.js` + `bin/hearth-chat.js` — encrypted messages
  carried by records. It is the reference application, not a privileged one: it
  uses nothing the node reserves for itself.

### Records — how anything other than payment gets built
The signed transaction body carries an optional `records` array — namespaced,
byte-metered, consensus-committed application data. It is the seam every
non-payment application hangs off, and the reason one is possible without a
scripting VM. Payload is opaque to the node: it is counted, priced, indexed by
`(app, key)`, and never parsed. Encrypt before signing — a record is public and
permanent. Full reference: **[records.md](records.md)**.

## Tech choices & rationale

| Concern | Choice | Why |
|---|---|---|
| Consensus code | Rust *(intended)* — JS today | safety + speed where bugs are catastrophic |
| PoW | Homefire, memory-hard (RandomX-class VM is a design) | CPU-fair |
| Ledger | UTXO + stealth | privacy, parallel validation, SPV |
| Storage | redb / RocksDB | embedded, fast, no external DB to run |
| Retail | Tab channels | instant, near-free, base-layer stays lean |
| Desktop | Tauri | great graphics, tiny footprint, cross-platform |
| Web | vanilla ES modules + Web Workers | zero-install, no framework lock-in |
| Governance | on-chain Commons | fund development without capture |

## Data flow: a coffee purchase *(design — none of this runs today)*
1. Merchant page renders a Hearth Pay button (`data-amount`, `data-to`).
2. Shopper taps it → wallet opens the `hearth:` URI, signs a Tab update.
3. Update is exchanged instantly; SDK fires a settlement event → order fulfilled.
4. Channel settles net to the base chain later; base fee is burned.

Compare to cards: no custodian, no 1–3% fee, no chargeback risk, ~instant. Steps
2–4 need the wallet handoff and the Tab network layer, neither of which is built;
`web/pay-demo.html` mocks step 3 and nothing else.
