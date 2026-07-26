# Hearth — a currency mined by people, made to spend

**Working paper · v0.1 · 2026**

> Money mined at home. Made to spend.

## Abstract

Proof-of-work was introduced as an egalitarian lottery — one unit of computation,
one chance to extend the ledger. In practice, economies of scale turned mining
into an industrial activity dominated by ASIC farms and a handful of pools, and
fixed-supply designs turned coins into speculative stores of value that people
hoard rather than spend. Hearth is a proof-of-work currency engineered against
both outcomes. It uses a memory-hard, **non-outsourceable** puzzle so that a
laptop is competitive and mining pools cannot form; and a **money-first**
monetary policy — disinflationary emission into a perpetual tail, offset by a
base-fee burn — so the coin behaves like circulating cash rather than digital
gold. Around this, Hearth ships the things ordinary people actually need: a
one-click app that is simultaneously a node, wallet and polite miner; a web
wallet and block explorer; and a two-line merchant SDK for accepting payments.

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
The puzzle is a **RandomX-class virtual machine**: each nonce compiles a
pseudo-random program that executes against a large (≈2 GiB) dataset that must
live in RAM. This does two things:

- It makes custom silicon nearly pointless — a general-purpose CPU with a cache
  hierarchy *is* close to the optimal machine, so the ASIC premium collapses.
- It makes the bottleneck **memory bandwidth**, which is cheap and ubiquitous.
  The device in your bag is already competitive.

The reference proof-of-concept in [`proto/pow.js`](proto/pow.js) models the
memory-hard core: fill a scratchpad, take a pseudo-random walk that reads *and
mutates* it, and derive the digest from the whole pad so it can't be shortcut.

### 2.2 Non-outsourceable puzzles (the anti-pool)
Even with CPU-fair hashing, pools recentralize PoW by aggregating many small
miners under one operator. Hearth removes the *incentive* to pool: a valid
solution must be **signed by the same key that receives the block reward**
(see `attempt()`/`verify()` in the PoC). To let someone else mine for you, you'd
have to hand them the private key that controls the reward — i.e. the power to
steal it. Rational miners therefore mine **solo**, and there is no central pool
to censor around. This is the mechanism from the "non-outsourceable puzzles"
literature, adapted as Hearth's consensus rule rather than an add-on.

### 2.3 Polite, low-variance home mining
Solo mining is high-variance, so:

- **15-second blocks** and a smooth per-block difficulty retarget (LWMA) mean
  even small miners win regularly.
- **Warmshares**: near-miss solutions (uncles) are referenced by later blocks and
  earn a fraction of the reward, smoothing income without a pool.
- **Optional trustless co-ops**: peers can share variance via a P2P protocol that
  never takes custody of anyone's key — the opposite of a pool.
- **Polite mining** in the app: mine only on AC power / when idle, throttled to
  spare cycles, thermally aware. Mining should be invisible, not a space heater.

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

- **One binary, one click.** The Hearth app is a full node, wallet and miner.
  Install, press *Start your hearth*, done. Light-client mode for phones.
- **Web everything.** A browser **web wallet** (keys stay client-side), a
  **WASM light-miner** so you can mine in a tab, and a public **block explorer**
  (`web/explorer.html`).
- **Hearth Pay.** Merchants accept EMBER with two lines of HTML
  (`web/assets/hearth-pay.js`): a payment button that opens the shopper's wallet
  and fires a callback on settlement. No custodian, no chargebacks, no card fees.
- **Great graphics.** The interface is built around a warm, living *hearth* that
  grows as you mine — a deliberately human, anti-industrial identity (see
  [`branding/brand.md`](branding/brand.md)).

---

## 7. Architecture summary

| Layer | Choice | Rationale |
|---|---|---|
| Node (`hearthd`) | Rust | memory-safety & performance for consensus |
| PoW | Homefire (RandomX-class + non-outsourceable) | CPU-fair, pool-resistant |
| Ledger | UTXO + stealth addresses | privacy, parallel validation |
| Retail | Tab payment channels | instant, sub-cent payments |
| Governance | on-chain Commons treasury | capture-resistant funding |
| Desktop app | Tauri (Rust + web UI) | small, cross-platform, great graphics |
| Web | web wallet · explorer · Hearth Pay SDK | zero-install access & merchant reach |

Full detail: [`docs/architecture.md`](docs/architecture.md).

---

## 8. Threat model & honest limitations

- **You can't fully stop someone buying many CPUs.** Non-outsourceability +
  memory-hardness removes the *super-linear* farm advantage and the pool
  coordination point; it does not make Hearth Sybil-proof. The goal is
  *proportional, decentralized* mining, not literal one-person-one-vote.
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
