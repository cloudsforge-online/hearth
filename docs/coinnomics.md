# Coinnomics — Ember (EMBER)

> Design goal: a coin people **spend**, not hoard. Money, not gold.
> Everything here is reproduced by [`../proto/emission.js`](../proto/emission.js) —
> run `node proto/emission.js` to regenerate every number.

## 1. Units

| Name | Value |
|---|---|
| 1 EMBER | base spendable coin |
| 1 spark | 0.00000001 EMBER (1e-8) |
| ticker | `EMBER` |

Eight decimals give room for micro-payments and for prices to stay small as the
network grows.

## 2. Time & issuance constants

| Parameter | Value | Why |
|---|---|---|
| Block time | 15 s | fast enough to pay with; big enough to propagate |
| Blocks/year | ~2,103,840 | 365.25 d ÷ 15 s |
| Genesis reward `R0` | 6 EMBER/block | bootstrap security & distribution |
| Reward half-life | 2 years | smooth, predictable disinflation |
| Tail emission `TAIL` | 0.3 EMBER/block (perpetual) | permanent security budget |
| Commons share | 10% of reward | community-funded development |
| Miner share | 90% of reward | pays the people securing the chain |

Emission is halving-free and continuous. The **design curve** is the smooth
exponential

```
reward(height) = max(TAIL, R0 · 2^(−height / HALFLIFE_BLOCKS))
```

but consensus can't use floating point (different CPUs/engines would disagree by
a spark and split the chain). So the **on-chain schedule** is a *deterministic
integer* approximation: the reward halves each half-life epoch, **linearly
interpolated** within the epoch. It is continuous at epoch boundaries (no cliff),
tracks the exponential closely, and is computed bit-identically in both clients
(`node/src/params.js` ↔ `rust/hearthd/src/ledger.rs`, pinned by a parity test —
e.g. `subsidy(4_207_680) == 300_000_000`). The illustrative table below comes
from the smooth model (`proto/emission.js`); the on-chain integers differ only in
negligible rounding.

## 3. Why uncapped (and why that's the point)

A hard cap manufactures scarcity, which manufactures hoarding. Money works when
holding it has a small, predictable cost, so it keeps moving. Hearth therefore:

1. **Disinflates** toward a tail instead of stopping — the supply growth rate
   falls every block but never hits zero.
2. **Burns** a base fee on every transaction, so **net** supply is driven by
   *usage*, not by a schedule.

The tail also fixes the **security cliff** (P4 in the whitepaper): miners are
always paid, so security never rests on a fragile fee-only market.

## 4. The fee burn (why net inflation → ~0%)

Every transaction pays an EIP-1559-style **base fee** sized by congestion, and
that base fee is **burned**. An optional **tip** goes to the miner for priority.

As adoption grows, burned fees approach gross tail issuance, so circulating
supply flattens. Modeled adoption ramp (burn climbs to ~85% of issuance over 8
years) produces:

```
 yr      reward   issued/yr   burned/yr      supply     commons     gross%    net%
  1        4.24  10,667,873   1,133,462   9,534,412   1,066,787     100.00  100.00
  2        3.00   7,543,325   1,602,957  15,474,781   1,821,120      44.17   38.39
  3        2.12   5,333,937   1,700,192  19,108,525   2,354,514      25.63   19.02
  5        1.06   2,666,968   1,416,827  22,527,372   2,998,377      11.14    5.55
  8        0.38     942,916     801,478  23,694,129   3,414,600       3.85    0.60
 10        0.30     631,152     536,479  23,890,811   3,545,721       2.58    0.40
 30        0.30     631,152     536,479  25,784,267   4,808,025       2.40    0.37
```

**Reading it:** the first year is a deliberate bootstrap (wide distribution while
few coins exist). By year 5 net inflation is ~5.5%; by year 10 it's ~0.4%; long
run it hovers near a few tenths of a percent — and *falls* if usage (burn) rises.
That is the profile of spendable money.

> These are *modeled* figures with an assumed adoption/burn curve, not a promise.
> Real net inflation depends on real usage. The point is structural: **more
> spending → more burn → tighter supply.** Usage tightens the money; idleness
> loosens it slightly. Exactly the incentive money should have.

## 5. Distribution: fair launch

- **No premine.** Genesis holds no spendable balance.
- **No ICO / sale.** You can't buy in early; you mine or you earn.
- **No founder/VC allocation.** The only "allocation" is the transparent, on-chain
  Commons treasury, spendable only by governance.

This maximizes the number of independent holders early — good for both
decentralization and legitimacy.

## 6. The Commons treasury

10% of every block (see table's `commons` column — millions of EMBER over time)
accrues to an on-chain treasury. It funds core development, security audits,
explorers, and infrastructure. Spending requires an on-chain proposal to pass
**hybrid governance**:

- **Coin-weighted vote** (skin in the game), blended with
- **One-node-one-vote** (attested full nodes), to blunt pure plutocracy.

No multisig of founders, no foundation with a treasury wallet nobody can audit.

## 7. Parameter change policy

Consensus constants (block time, `R0`, half-life, tail, commons share, burn rule)
are frozen at mainnet and only changeable by a supermajority governance vote plus
a coordinated upgrade. Stability *is* a monetary feature.

## 8. Reproduce / stress-test

```bash
node proto/emission.js          # prints the table above
```

Edit the constants at the top of `proto/emission.js` (e.g. change `TAIL` or the
burn ramp) to explore alternative policies before proposing them.
