# Hearth — a currency mined by people, made to spend

**Working paper · v0.1 · 2026**

> Money mined at home. Made to spend.

## Abstract

Proof-of-work was introduced as an egalitarian lottery — one unit of computation,
one chance to extend the ledger. In practice, economies of scale turned mining
into an industrial activity dominated by ASIC farms and a handful of pools, and
fixed-supply designs turned coins into speculative stores of value that people
hoard rather than spend. Hearth is a proof-of-work currency engineered against
both outcomes. It uses a memory-hard puzzle so that a laptop is competitive, a
proof that must be signed by the key its reward pays so work cannot be
redirected, and a **money-first** monetary policy — disinflationary emission into
a perpetual tail, offset by a base-fee burn — so the coin behaves like
circulating cash rather than digital gold. Around this, Hearth ships the things
ordinary people actually need: a reference node that is simultaneously node,
wallet and polite miner; a browser wallet and browser miner; and a block
explorer.

> **What is a design and what is running.** This is a working paper. Where a
> section describes something that does not exist yet, it says so inline. The
> two that matter most, because earlier drafts stated them as fact:
>
> * **Homefire is not a RandomX-class VM.** It compiles nothing. It is chained
>   SHA-256 over a scratchpad plus a pseudo-random walk (§2.1).
> * **Homefire is not non-outsourceable.** Only the coinbase *public* key is
>   bound into the seed, so a pool can be built on top of it (§2.2).
>
> `node/` is the running network; `rust/hearthd` is a benchmark and a set of
> libraries, and is not consensus-compatible. See
> [`docs/why-two-implementations.md`](docs/why-two-implementations.md).

---

## 1. The problems, precisely

Hearth is not "another blockchain." It targets six concrete, well-documented
failures.

**P1 — Mining centralization.** SHA-256 rewards specialized hardware, so hashing
concentrates in ASIC farms located near cheap power. Pools then concentrate the
*coordination* of that hashing. The result is that a handful of entities can
censor or reorganize the chain.

**P2 — Hoarding over spending.** A hard cap (e.g. 21M) with halvings creates a
deflationary narrative that rationally encourages holding, not transacting.
"Digital gold" is a feature for speculators and a bug for money.

**P3 — Throughput and fees.** Ten-minute blocks and small caps make base-layer
payments slow and, under load, expensive — unusable for a coffee.

**P4 — The security cliff.** When block subsidies approach zero, chains that
planned to be secured "by fees alone" face an unproven and probably insufficient
security budget.

**P5 — Capture.** Premines, ICOs and VC allocations mean the people who use the
money don't own or govern it, and development is steered by early holders.

**P6 — Usability.** Running a node, securing keys, and paying with crypto remain
too hard for non-technical people, which quietly recentralizes everything onto
custodians and exchanges.

Hearth addresses each of these directly. The rest of this paper is organized
around the mechanisms.

---

## 2. Homefire: proof-of-work that stays with people (P1)

Homefire combines three ideas.

### 2.1 CPU-optimized, memory-hard hashing
**Shipped.** Each nonce fills a scratchpad by chaining SHA-256, takes a
pseudo-random walk that reads and rewrites it, and derives the digest from the
whole pad — ~8,450 sequential rounds with a data dependency at every step
(`node/src/pow.js`). Memory latency, not gate count, sets the pace.

**Designed, not built.** The intended production puzzle is a **RandomX-class
virtual machine**: each nonce compiles a pseudo-random program that executes
against a large (≈2 GiB) dataset that must live in RAM. Nothing in this
repository compiles a program. When it exists it does two things:

- It makes custom silicon nearly pointless — a general-purpose CPU with a cache
  hierarchy *is* close to the optimal machine, so the ASIC premium collapses.
- It makes the bottleneck **memory bandwidth**, which is cheap and ubiquitous.
  The device in your bag is already competitive.

The reference proof-of-concept in [`proto/pow.js`](proto/pow.js) models the
memory-hard core: fill a scratchpad, take a pseudo-random walk that reads *and
mutates* it, and derive the digest from the whole pad so it can't be shortcut.

### 2.2 Signed proofs, and the pool problem that is still open
**Shipped.** A valid solution must be **signed by the same key that receives the
block reward** (`node/src/block.js`). So a candidate built for your public key is
worthless to anybody else, and work handed to you cannot be taken from you.

**Not shipped: non-outsourceability.** The consensus seed binds only the coinbase
*public* key (`node/src/pow.js`); the private key is used once, after a nonce has
already won. A pool operator can therefore distribute the header core together
with its **own** public key, collect `(nonce, digest)` pairs from hashers who
genuinely cannot steal the reward, and sign the blocks itself. Consensus does not
notice, and cannot.

The mechanism from the "non-outsourceable puzzles" literature requires the
private key **inside the hash loop**. Adopting it is a consensus change that
forks the chain and invalidates every existing miner, so it is an open design
decision rather than a property Hearth currently has. Until it is made, "pools
cannot form" is not a claim this paper is entitled to.

### 2.3 Polite, low-variance home mining
Solo mining is high-variance, so:

- **15-second blocks** and a smooth per-block difficulty retarget (LWMA) mean
  even small miners win regularly.
- **Warmshares** *(designed, not built)*: near-miss solutions (uncles) referenced
  by later blocks for a fraction of the reward, smoothing income without a pool.
- **Optional trustless co-ops** *(designed, not built)*: peers sharing variance
  via a P2P protocol that never takes custody of anyone's key.
- **Polite mining** *(shipped in the browser miner)*: a real duty cycle the
  workers sleep through, a trickle in a background tab, and a pause on battery
  where the browser reports power state. Idle detection and thermal awareness are
  not implementable from a web page and are not present in the node either.

The net effect: a warehouse of CPUs earns roughly *proportional* to its share of
honest commodity hardware, with no structural advantage and nobody to centralize
around.

---

## 3. Money-first coinnomics (P2, P4)

Hearth's monetary policy is designed so the coin is **used**, not stockpiled.
Every parameter below is reproduced by [`proto/emission.js`](proto/emission.js);
the full derivation is in [`docs/coinnomics.md`](docs/coinnomics.md).

### 3.1 Emission
Block reward decays **smoothly** (no cliff-edge halvings):

```
reward(h) = max(TAIL, R0 · 2^(−h / HALFLIFE))
R0 = 6 EMBER/block   HALFLIFE = 2 years   TAIL = 0.3 EMBER/block
```

This is **disinflationary**: the growth rate of supply falls every block toward
the tail. Unlike a hard cap, it never stops — which is deliberate.

### 3.2 The perpetual tail solves the security cliff (P4)
The tail (`0.3 EMBER/block`, forever) guarantees miners are always paid, so
security never depends on a speculative fee market. Because supply keeps growing
slowly while the tail is constant, the **tail's inflationary weight falls toward
zero over time** but never reaches it — a permanent, shrinking security budget.

### 3.3 The fee burn makes it behave like money (P2)
Every transaction pays an EIP-1559-style **base fee that is burned**. As real
usage grows, burn approaches (and can exceed) tail issuance, so **net** supply
flattens. Modeled over 30 years:

| Year | Gross issuance/yr | Burned/yr | Net inflation |
|-----:|------------------:|----------:|--------------:|
| 1 | 10.67M | 1.13M | 100% (bootstrap) |
| 5 | 2.67M | 1.42M | 5.55% |
| 10 | 0.63M | 0.54M | 0.40% |
| 30 | 0.63M | 0.54M | **0.37%** |

A currency whose net inflation sits near zero, funded by usage, is *money*: you
lose nothing meaningful by spending today, and the network stays secure.

### 3.4 No demurrage
We explicitly reject holding penalties (demurrage) as user-hostile and hard to
reason about. Mild perpetual issuance plus a usage-driven burn achieves the same
goal — discouraging idle hoarding — without punishing savers.

---

## 4. Fast, cheap, private payments (P3)

- **Base layer:** 15s blocks with a dynamic block-size limit governed by a penalty
  function, so capacity grows with demand without unbounded bloat.
- **Tab channels:** a lightweight payment-channel layer for instant, sub-cent
  retail payments that settle to the base chain. Buying coffee shouldn't wait for
  a block.
- **Privacy by default:** one-time **stealth addresses** so amounts and recipients
  aren't trivially linkable. Cash-like privacy is a property of money, not a
  luxury. (Optional view keys support voluntary disclosure/auditing.)
- **Fees:** a small predictable base fee (burned) plus an optional tip to
  prioritize. Typical fee target: well under one US cent.

---

## 5. Fair launch & the Commons (P5)

- **No premine, no ICO, no founder coin allocation.** The genesis block holds no
  special balance. Everyone starts by mining or receiving EMBER.
- **Commons treasury:** 10% of every block reward is minted to an on-chain
  treasury. Spending is decided by **on-chain governance** using a hybrid of
  coin-weighted voting and one-node-one-vote to blunt plutocracy. This funds
  development, audits, and infrastructure **without** selling the network to
  investors.
- **Open by default:** MIT-licensed, reproducible builds, open specs.

---

## 6. Usability as a first-class feature (P6)

Decentralization that only experts can use recentralizes onto custodians. So
Hearth treats UX as consensus-critical:

- **One process.** `hearthd` is a full node, wallet and miner at once. The Tauri
  desktop shell around it is scaffolding today, not a shipped app; light-client
  mode for phones is a design.
- **Web everything.** A browser **web wallet** (keys stay client-side, sealed at
  rest with AES-256-GCM), a **browser miner** running the same Homefire the node
  does and conformance-tested against it in CI, and a public **block explorer**
  with transaction search and block detail.
- **Hearth Pay** *(mockup)*. `web/assets/hearth-pay-demo.js` renders the merchant
  button a real SDK would render and **simulates** its settlement locally. There
  is no SDK yet: no wallet handoff, no node subscription, no payment. The design
  is a payment button that opens the shopper's wallet and fires a callback on
  settlement — no custodian, no chargebacks, no card fees.
- **Great graphics.** The interface is built around a warm, living *hearth* that
  grows as you mine — a deliberately human, anti-industrial identity (see
  [`branding/brand.md`](branding/brand.md)).

---

## 7. Architecture summary

| Layer | Choice | Rationale |
|---|---|---|
| Node (`hearthd`) | JS today, Rust intended | JS runs the network; the Rust crate is not yet a node |
| PoW | Homefire (memory-hard; RandomX-class VM designed) | CPU-fair |
| Ledger | UTXO + stealth addresses | privacy, parallel validation |
| Retail | Tab payment channels | instant, sub-cent payments |
| Governance | on-chain Commons treasury | capture-resistant funding |
| Desktop app | Tauri (Rust + web UI) | small, cross-platform, great graphics |
| Web | web wallet · browser miner · explorer | zero-install access |

Full detail: [`docs/architecture.md`](docs/architecture.md).

---

## 8. Threat model & honest limitations

- **You can't fully stop someone buying many CPUs.** Memory-hardness removes the
  *super-linear* farm advantage; it does not make Hearth Sybil-proof. The goal is
  *proportional, decentralized* mining, not literal one-person-one-vote.
- **Pools are currently possible.** See §2.2. This is the largest gap between
  what this paper argues for and what the chain enforces.
- **RandomX-class VMs are complex** and a real attack surface; the production
  algorithm needs audits and a spec freeze before mainnet.
- **Privacy has trade-offs** with scalability and regulatory acceptance; Hearth
  chooses default privacy with optional disclosure.
- **Governance can still be gamed;** the hybrid voting model reduces, not
  eliminates, plutocracy. This is an area of active design.

This paper describes a design and a working proof-of-concept, not a finished
network. See the [roadmap](docs/roadmap.md).

---

## 9. Prior art & influences

Bitcoin (PoW, UTXO), Monero (RandomX, tail emission, stealth addresses),
Ethereum (EIP-1559 fee burn, on-chain governance experiments), and the
non-outsourceable puzzles line of research. Hearth's contribution is the
*combination*, tuned end-to-end for one goal: **money that ordinary people mine
and spend.**
