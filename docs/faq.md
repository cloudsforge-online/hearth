# FAQ

### Is this a live coin I can buy?
No. Hearth is a design plus a working proof-of-concept and full web layer on demo
data. There is **no premine and no sale** — when it launches you'll mine or earn
EMBER, not buy it early. See the [roadmap](roadmap.md).

### How is this different from Bitcoin?
Bitcoin is optimized to be *digital gold*: ASIC-mined, hard-capped, hoarded. Hearth
is optimized to be *money*: CPU-mined, pool-resistant, disinflationary with a fee
burn so it circulates, with instant sub-cent retail payments.

### How is it different from Monero?
Hearth borrows Monero's best ideas (memory-hard CPU PoW, tail emission, stealth
addresses) and aims at *spending*: a **base-fee burn** so net inflation trends to
~0%, and a payments/merchant stack (Tab channels + Hearth Pay) that is designed
but not yet built. Homefire is memory-hard SHA-256 over a scratchpad, not a
RandomX-class VM — that is on the roadmap.

### Can't someone just buy 10,000 CPUs and farm it anyway?
They can buy hardware, but they gain **little per-dollar advantage** — Homefire is
memory-latency-bound, so there is no meaningful ASIC edge. They **can** run a
pool: only the coinbase *public* key is bound into the proof, so an operator can
hand out work under its own key. Closing that is an open consensus decision, not
a property Hearth has today — see [mining.md](mining.md). The goal is
*proportional, decentralized* mining, not literal one-person-one-vote.

### Uncapped supply — won't it inflate away?
Emission is **disinflationary** into a small perpetual tail, and every transaction
**burns** a base fee. Modeled net inflation falls to ~0.4% by year 10 and drifts
lower as usage grows. Run `node proto/emission.js` to check. Mild, predictable
issuance is what keeps money *moving* instead of being hoarded.

### Why a tail emission at all?
To avoid the **security cliff**: chains that plan to pay miners "by fees alone"
have an unproven security budget. A perpetual tail guarantees miners are always
paid, so the network stays secure forever.

### Do I need to be technical to use it?
A browser wallet and in-tab mining need nothing installed, and keys stay on your
device. The one-click desktop app is scaffolding, not something you can download
yet; running a node today means `node bin/hearthd.js --mine`.

### How do merchants accept it?
They can't yet. `web/pay-demo.html` is a **mockup** that simulates its own
settlement — there is no SDK, no wallet handoff and no Tab network layer. The
node already reports what a merchant would need to verify a payment
(`GET /address/:addr`, `GET /tx/:txid`); the rest is unbuilt. The goal is no
custodian, no chargebacks and no card fees.

### Is it private?
Yes — stealth addresses by default, with optional view keys for voluntary
disclosure (accounting/audits).

### Who funds development if there's no ICO?
The **Commons treasury**: 10% of every block reward, spent only by on-chain
governance. No VCs, no foundation slush fund.

### What powers the graphics/UX?
A Tauri desktop app (Rust core + web UI) and vanilla web front-ends, around a warm
"living hearth" identity. See [`../branding/brand.md`](../branding/brand.md).

### Where do I start contributing?
The Rust `hearthd` node, the Tab channel layer, and the Tauri app. See
[CONTRIBUTING.md](../CONTRIBUTING.md) and the [roadmap](roadmap.md).
