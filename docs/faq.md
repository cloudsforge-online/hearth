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
Hearth borrows Monero's best ideas (RandomX-class PoW, tail emission, stealth
addresses) and adds three things aimed at *spending*: **non-outsourceable** PoW to
kill pools, a **base-fee burn** so net inflation trends to ~0%, and a
payments/merchant stack (Tab channels + Hearth Pay). Monero is excellent private
cash; Hearth pushes further on anti-centralization and everyday usability.

### Can't someone just buy 10,000 CPUs and farm it anyway?
They can buy hardware, but they gain **no per-dollar advantage** (memory-hard, no
ASIC edge) and they **can't run a pool** to coordinate others (non-outsourceable).
The goal is *proportional, decentralized* mining, not literal one-person-one-vote.
We're honest about this in the whitepaper's threat model.

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
No. Install the app, press *Start your hearth*. Keys stay on your device. There's
also a browser wallet and in-tab mining.

### How do merchants accept it?
Two lines of HTML with the Hearth Pay SDK (`web/pay-demo.html` shows a live demo).
No custodian, no chargebacks, no card fees; settles instantly over Tab channels.

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
