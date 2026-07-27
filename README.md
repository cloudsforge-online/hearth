<div align="center">
  <img src="web/assets/logo.svg" width="104" alt="Hearth logo"/>
  <h1>Hearth — Money Mined at Home</h1>
  <b>A people-mined, ASIC-resistant proof-of-work cryptocurrency built to spend, not hoard.</b>
  <br/>
  <i>Mine EMBER on the computer you already own — no farms, no pools, no premine.</i>
  <br/><br/>

  <img alt="tests" src="https://img.shields.io/badge/node-50%2F50%20checks-brightgreen">
  <img alt="rust" src="https://img.shields.io/badge/rust%20core-29%20tests%20%C2%B7%20clippy%20clean-orange">
  <img alt="deps" src="https://img.shields.io/badge/rust%20deps-2%20(ed25519%2C%20getrandom)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="pow" src="https://img.shields.io/badge/PoW-Homefire%20(CPU%2C%20non--outsourceable)-ff4d00">

  <br/><br/>
  🌐 <b>Website &amp; live explorer: <a href="https://savvaniss.github.io/hearth/">savvaniss.github.io/hearth</a></b>
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
| Mining centralized into ASIC farms & pools | **Homefire PoW**: RandomX-class, memory-hard, *non-outsourceable*. A farm earns no more per dollar than your laptop, and pools can't form. |
| Coins behave like "gold" you hoard | **Money-first coinnomics**: disinflationary emission → perpetual tail, offset by a fee burn. Net inflation trends toward ~0%. Built for velocity. |
| Slow & expensive to pay with | **15s blocks**, sub-cent fees, instant retail settlement over **Tab** channels. |
| The "fee cliff" (security dies when rewards end) | **Perpetual tail emission** funds security forever. |
| Development captured by VCs / premines | **Fair launch** + on-chain **Commons treasury** (10% of each block), community-governed. |
| Too hard for normal humans | **One app** (node + wallet + miner), **polite mining**, a **web wallet**, a **block explorer**, and a two-line **"Accept EMBER"** SDK. |

Full argument: **[WHITEPAPER.md](WHITEPAPER.md)**.

---

## The coin

- **Network:** Hearth · **Coin:** Ember · **Ticker:** `EMBER`
- **Smallest unit:** 1 EMBER = 100,000,000 *sparks*
- **Block time:** 15 seconds · **PoW:** Homefire (CPU-only, non-outsourceable)
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
- ✅ **HTTP/JSON-RPC/SSE API** + a live **block explorer**, **web wallet**, and **Hearth Pay** merchant SDK
- ✅ a **Rust production core** (`rust/hearthd`) — Homefire PoW, **Ed25519-signed ledger, mempool, and Tab payment channels**; `fmt`/`clippy`/`29 tests` clean
- ✅ **Docker Compose** to boot a multi-node network on your Mac
- ✅ **CI** running Node tests + Rust build on every push

Hardened against an adversarial audit — unlimited-mint, fork-choice, coinbase
maturity, timestamp, DoS, address-checksum, deterministic-emission, and XSS
issues are fixed with tests (see **[docs/security-review.md](docs/security-review.md)**).

Verified locally: **50 node checks + 29 Rust tests pass**, two nodes sync over
P2P, a reorg replaces the active chain, and the Rust core mines ~8× faster than
the JS prototype on the same machine.

> **One implementation is the goal.** The Rust node is the target; the JS node is
> a transitional reference we're porting away from (emission is already
> byte-identical across both). See **[docs/why-two-implementations.md](docs/why-two-implementations.md)**.

---

## Try it now

**1 — Boot a real multi-node network** (seed + 2 miners + web/explorer):

```bash
docker compose up --build
# open http://localhost:8080  ·  explorer reads the live chain from :8645
```
No Docker? `./scripts/run-local-network.sh`. Details: **[docs/network.md](docs/network.md)**.

**2 — Run a node + wallet directly** (needs Node 18+, no install):

```bash
cd node
node bin/hearthd.js --mine                       # a mining node + API on :8645
node bin/hearth-cli.js supply                    # query it
node bin/hearth-cli.js send <toAddress> 5        # send 5 EMBER
node test/unit.js && node test/e2e.js            # 40 checks
```

**3 — Build the Rust core** (needs stable Rust):

```bash
cd rust/hearthd
cargo run --release -- 20                         # mine a demo block
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

**4 — Open the web experience** (works offline on demo data, or live against a node):

```bash
npx serve web        # or: open web/index.html
```
`index.html` (site) · `explorer.html` (live block explorer) · `wallet.html`
(non-custodial web wallet — needs a reachable node) · `pay-demo.html` (Accept EMBER checkout).

---

## Repository layout

```
hearth/
├── README.md · WHITEPAPER.md          the pitch and the full design
├── docs/                              architecture · coinnomics · mining · network · roadmap · faq
├── node/                              hearthd — runnable reference node/wallet/miner (JS) + tests
│   ├── src/  bin/  test/  Dockerfile
├── rust/hearthd/                      production core (Rust): SHA-256 + Homefire PoW + ledger + P2P, zero deps
├── app-desktop/                       Tauri desktop app scaffold (one-click node + wallet + miner)
├── web/                               website + web wallet + explorer + Hearth Pay SDK (SEO-ready)
├── proto/                             coinnomics simulator + standalone PoW demo
├── scripts/run-local-network.sh       local network without Docker
├── docker-compose.yml                 seed + 2 miners + web
└── .github/workflows/ci.yml           CI: node tests + rust build + web lint
```

## Status

A complete design with a **working reference network, a compiling Rust core, a
full web layer, tests and CI** — but **pre-mainnet**: the production Homefire VM,
Tab channels, and consensus still need audits and a public testnet before launch.
See **[docs/roadmap.md](docs/roadmap.md)**.

## Contributing

Hearth is a commons. See **[CONTRIBUTING.md](CONTRIBUTING.md)** and
**[docs/why-two-implementations.md](docs/why-two-implementations.md)**. Highest-leverage
areas: the Rust Homefire VM, the Tab payment layer, and the Tauri desktop app.

## Security

Please report vulnerabilities privately — see **[SECURITY.md](SECURITY.md)**.

## License

[MIT](LICENSE) — money should be free to fork.

---

<sub><b>Keywords:</b> Hearth, EMBER, cryptocurrency, proof of work, CPU mining, ASIC resistant,
RandomX, non-outsourceable puzzle, decentralized digital cash, mine crypto at home, no premine,
fair launch, crypto wallet, block explorer, blockchain node, Rust blockchain, tail emission, fee burn.</sub>
