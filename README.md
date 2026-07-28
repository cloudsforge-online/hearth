<div align="center">
  <img src="web/assets/logo.svg" width="104" alt="Hearth logo"/>
  <h1>Hearth — Money Mined at Home</h1>
  <b>A people-mined, ASIC-resistant proof-of-work cryptocurrency built to spend, not hoard.</b>
  <br/>
  <i>Mine EMBER on the computer you already own — no farms, no pools, no premine.</i>
  <br/><br/>

  <a href="https://github.com/cloudsforge-online/hearth/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/cloudsforge-online/hearth/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="tests" src="https://img.shields.io/badge/node-158%2F158%20checks-brightgreen">
  <img alt="rust" src="https://img.shields.io/badge/rust%20core-29%20tests%20%C2%B7%20clippy%20clean-orange">
  <img alt="deps" src="https://img.shields.io/badge/rust%20deps-2%20(ed25519%2C%20getrandom)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="pow" src="https://img.shields.io/badge/PoW-Homefire%20(CPU%2C%20memory--hard)-ff4d00">

  <br/><br/>
  🌐 <b><a href="https://hearth.cloudsforge.online/">hearth.cloudsforge.online</a></b>
  &nbsp;·&nbsp;
  <b>live explorer &amp; wallet: <a href="https://explorer.cloudsforge.online/">explorer.cloudsforge.online</a></b>
  <br/>
  <sub>Hearth is the <b>Mine</b> in <a href="https://cloudsforge.online/">CloudsForge</a>'s one crypto world — mine it, trade it, mint it, spend it, play in it.</sub>
  <br/><br/>
  <code>proof of work · CPU mining · ASIC-resistant · fair launch · digital cash</code>
</div>

---

## Why Hearth exists

Proof-of-work was supposed to be *one CPU, one vote*. Instead Bitcoin became a
game for warehouse farms and a few pools, and almost everything since became a
speculative chip you hoard rather than money you spend.

**Hearth gives the original promise back to ordinary people** and fixes the
specific things that pushed them out:

| Big crypto problem | What Hearth does |
|---|---|
| Mining centralized into ASIC farms | **Homefire PoW**: memory-hard and CPU-friendly, so a farm earns little more per dollar than your laptop. A winning proof must be signed by the key its coinbase pays, so work handed to you cannot be redirected — see [docs/mining.md](docs/mining.md) for what that does and does not buy. |
| Coins behave like "gold" you hoard | **Money-first coinnomics**: disinflationary emission → perpetual tail, offset by a fee burn. Net inflation trends toward ~0%. Built for velocity. |
| Slow & expensive to pay with | **15s blocks** and a sub-cent fee that is *burned*, not auctioned. **Tab** channels for instant retail settlement are a signed state machine in the Rust core, not yet on the network. |
| The "fee cliff" (security dies when rewards end) | **Perpetual tail emission** funds security forever. |
| Development captured by VCs / premines | **Fair launch** + on-chain **Commons treasury** (10% of each block), community-governed. |
| Too hard for normal humans | A **web wallet** and a **browser miner** that need nothing installed, a live **block explorer**, and a reference node that is a full node, a wallet and a miner in one process. |

Full argument: **[WHITEPAPER.md](WHITEPAPER.md)**.

---

## The coin

- **Network:** Hearth · **Coin:** Ember · **Ticker:** `EMBER`
- **Smallest unit:** 1 EMBER = 100,000,000 *sparks*
- **Block time:** 15 seconds · **PoW:** Homefire (memory-hard, CPU-friendly, ASIC-resistant)
- **Emission:** smooth halving-free decay → perpetual tail; 10% to the Commons; base fee burned
- **Supply:** uncapped but *disinflationary* — modeled net inflation ~0.37% at year 30

```
 yr      reward   issued/yr   burned/yr      supply     gross%    net%
  1        4.24  10,667,873   1,133,462   9,534,412     100.00  100.00
  5        1.06   2,666,968   1,416,827  22,527,372      11.14    5.55
 10        0.30     631,152     536,479  23,890,811       2.58    0.40
 30        0.30     631,152     536,479  25,784,267       2.40    0.37     (node proto/emission.js)
```

*Money, not gold.* Full breakdown: **[docs/coinnomics.md](docs/coinnomics.md)**.

---

## This is a working application, not a slide deck

Everything below **runs**:

- ✅ a real **blockchain node** (`node/`) — signed UTXO ledger, Homefire PoW, mempool, emission, fee burn, LWMA difficulty, disk persistence
- ✅ **most-work fork choice with chain reorganization** — not a toy single-chain accept
- ✅ **P2P networking** — nodes gossip and sync over TCP (network-id handshake, DoS caps)
- ✅ **wallet + CLI** — keys, checksummed addresses, balances, signed payments
- ✅ **HTTP/JSON-RPC/SSE API** + a live **block explorer** (tx search, block detail) and **web wallet** (keys encrypted at rest). `web/pay-demo.html` is a merchant-button *mockup* that simulates settlement — not an SDK
- ✅ **application records** — consensus-committed, namespaced, byte-metered data inside the signed transaction body, with a tx index and per-app subscriptions (**[docs/records.md](docs/records.md)**)
- ✅ **encrypted on-chain chat** built on them — X25519 reading keys, sealed boxes, `hearth-chat announce · send · inbox · watch`
- ✅ **browser mining** (`web/mine.html`) — a Web Worker pool running real Homefire against `/mining/template`, ~225 H/s per thread, checked digest-for-digest against the node in CI
- 🟡 a **Rust crate** (`rust/hearthd`) — a self-check, a PoW benchmark and libraries for ledger/mempool/Tab; `fmt`/`clippy`/`29 tests` clean. **Not a node and not consensus-compatible** — see [docs/why-two-implementations.md](docs/why-two-implementations.md)
- ✅ **Docker Compose** to boot a multi-node network on your Mac
- ✅ **CI** running Node tests + Rust build on every push

Hardened against an adversarial audit — unlimited-mint, fork-choice, coinbase
maturity, timestamp, DoS, address-checksum, deterministic-emission, and XSS
issues are fixed with tests (see **[docs/security-review.md](docs/security-review.md)**).

Verified locally: **158 node checks + 29 Rust tests pass**, two nodes sync over
P2P, a reorg replaces the active chain, and the Rust core mines ~8× faster than
the JS prototype on the same machine.

> **One implementation is the goal.** Rust is the target; the JS node is the only
> thing that runs the network today, and `rust/hearthd` is a long way from taking
> over — it has no block, chain, RPC or P2P layer, and its PoW and difficulty
> rules do not match consensus. Emission is byte-identical across both, and that
> is the extent of the parity so far. See
> **[docs/why-two-implementations.md](docs/why-two-implementations.md)**.

---

## Try it now

**1 — Boot a real multi-node network** (seed + 2 miners + explorer/wallet):

```bash
docker compose up --build
# open http://localhost:8080 · the explorer reads the live chain over same-origin /rpc
```
No Docker? `./scripts/run-local-network.sh`. Details: **[docs/network.md](docs/network.md)**.

**2 — Run a node + wallet directly** (needs Node 18+, no install):

```bash
cd node
node bin/hearthd.js --mine                       # a mining node + API on :8645
node bin/hearth-cli.js supply                    # query it
node bin/hearth-cli.js send <toAddress> 5        # send 5 EMBER
node bin/hearth-chat.js announce                 # then: send / inbox / watch
npm test                                         # 158 checks
```

**3 — Build the Rust core** (needs stable Rust):

```bash
cd rust/hearthd
cargo run --release -- 20                         # mine a demo block
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

**4 — Open the web experience** (live against a node; clearly-labelled sample
data only when none answers):

```bash
npx serve web        # or: open web/index.html
```
`index.html` (live block explorer, with tx search and block detail) ·
`wallet.html` (non-custodial web wallet, key encrypted at rest — needs a
reachable node) · `mine.html` (mine EMBER in the tab) · `pay-demo.html` (a
*mockup* of an Accept EMBER checkout — it simulates settlement and takes no
payment).

The Hearth **marketing site** is a separate React app in [`site/`](site) — one
front door, not two:

```bash
cd site && pnpm install && pnpm dev   # http://localhost:3003
```

---

## Repository layout

```
hearth/
├── README.md · WHITEPAPER.md          the pitch and the full design
├── docs/                              architecture · coinnomics · mining · network · records · roadmap · faq
├── node/                              hearthd — runnable reference node/wallet/miner (JS) + tests
│   ├── src/  bin/  test/  Dockerfile
├── rust/hearthd/                      production core (Rust): SHA-256 + Homefire PoW + ledger + P2P, zero deps
├── app-desktop/                       Tauri desktop app scaffold (one-click node + wallet + miner)
├── site/                              the Hearth marketing site (React) — hearth.cloudsforge.online
├── web/                               block explorer + web wallet + Hearth Pay SDK — explorer.cloudsforge.online
├── proto/                             coinnomics simulator + standalone PoW demo
├── scripts/run-local-network.sh       local network without Docker
├── docker-compose.yml                 seed + 2 miners + web
└── .github/workflows/ci.yml           CI: node tests (unit + e2e + records + p2p) + rust build + web lint + secret hygiene
```

## Status

A complete design with a **working reference network, a compiling Rust core, a
full web layer, tests and CI** — but **pre-mainnet**: consensus, the Rust core and
the Tab channel layer still need audits and a public testnet before launch.
See **[docs/roadmap.md](docs/roadmap.md)**.

## Contributing

Hearth is a commons. See **[CONTRIBUTING.md](CONTRIBUTING.md)** and
**[docs/why-two-implementations.md](docs/why-two-implementations.md)**. Highest-leverage
areas: the Rust core (today a benchmark, not a node), the Tab payment layer, and
the Tauri desktop app (today unshipped scaffolding — see `app-desktop/README.md`).

## Security

Please report vulnerabilities privately — see **[SECURITY.md](SECURITY.md)**.

## License

[MIT](LICENSE) — money should be free to fork.

---

<sub><b>Keywords:</b> Hearth, EMBER, cryptocurrency, proof of work, CPU mining, ASIC resistant,
memory-hard proof of work, decentralized digital cash, mine crypto at home, no premine,
fair launch, crypto wallet, block explorer, blockchain node, Rust blockchain, tail emission, fee burn.</sub>

## How this was built

Parts of this repository were produced with AI assistance, and it seems worth saying so plainly
rather than leaving it to be inferred.

- **Code** — written with Claude Opus 5 and Claude Opus 4.8 (Anthropic), reviewed and directed by
  a human, and gated on the same tests and CI as anything else here.
- **Artwork** — brand marks, icons and in-game art generated with OpenAI's image models
  (GPT Image 1, 1.5 and 2), driven by the manifest pipeline in `asset-forge`.

The models were used under paid API access and the output is the project's to use. Nothing here is
claimed to be hand-written that is not, and nothing is claimed to work that has not been tested.
