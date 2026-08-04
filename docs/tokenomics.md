# EMBER — tokenomics

**The document to verify against the chain.** Every number below is derived from
`node/src/params.js` and cited to `file:line`. Nothing here is copied from
[`../WHITEPAPER.md`](../WHITEPAPER.md) or [`coinnomics.md`](coinnomics.md); where
those disagree with this file, this file is right and the reason is in §9.

> **Status.** There is no mainnet. No EMBER of monetary value exists, there is no
> market and there is no listed price. Everything below describes the emission
> rules the reference node enforces today and will continue to enforce across the
> account-model migration ([`evm-spec.md`](evm-spec.md) §1: *"Emission — existing
> subsidy schedule — unchanged"*). Read §9 before relying on any figure.

---

## 1. Asset identity

| Field | Value | Source |
| --- | --- | --- |
| Name | Hearth | — |
| Ticker | `EMBER` | `node/src/params.js:10` |
| Network id (P2P/tx binding) | `hearth` | `node/src/params.js:9` |
| Chain ID (EIP-155) | `7411` mainnet · `7412` testnet | `node/src/chain/transaction.js:57` declares 7411. The testnet id is decided ([`evm-spec.md`](evm-spec.md) §1) and **nothing may hardcode it** — it must become per-network configuration |
| Decimals | **18** (target) / 8 (today) | see §2 |
| Contract address | **none — EMBER is a native coin, not a token** | — |
| Block time | 15 s | `node/src/params.js:14` |
| Blocks per year | 2,103,840 | `node/src/params.js:15` |
| Consensus | proof-of-work (Homefire), heaviest-cumulative-work fork choice | `node/src/pow.js`, `node/src/chain.js:323-370` |

EMBER is the **native asset** of the chain. It has no contract address on Hearth.
Any "EMBER" contract on any other chain is not this asset and is not endorsed.

---

## 2. Units and decimals — read this before wiring anything

| | Today (UTXO chain) | Target (account/EVM chain) |
| --- | --- | --- |
| Decimals | 8 | **18** |
| Smallest unit | 1 spark = 1e-8 EMBER | 1 wei = 1e-18 EMBER |
| Constant | `SPARKS_PER_EMBER = 100_000_000` (`node/src/params.js:6`) | `WEI_PER_EMBER = 10n ** 18n` (`node/src/params.js`) |

`decimals: 8 → 18` is a deliberate, specified change
([`evm-spec.md`](evm-spec.md) §1): ERC-20 tooling, wallets and DEX maths all
assume 18 for a native asset, and keeping 8 would produce subtly wrong displays
everywhere.

**Closed in phase 5, and NO FIGURE IN THIS DOCUMENT MOVED.** The account-model
chain uses `WEI_PER_EMBER` and `subsidyWei(height)`, which is the *same*
`subsidy(height)` scaled by exactly `1e10` (1 spark = 1e10 wei). The curve, the
half-life, the tail, the Commons share and the ~90M figure are all in EMBER and
are therefore unchanged; the only column that moves is the smallest unit.

`SPARKS_PER_EMBER = 1e8` deliberately stays as it is, because it is the UTXO
chain's consensus and both chains run side by side during the transition
(`hearthd --evm` selects the account model). So: **a figure quoted in this
document in _sparks_ describes the UTXO chain, and its account-model equivalent
is that number times 1e10.** Every figure quoted in EMBER is correct on both.

Every EMBER figure in this document is unit-independent: multiply by `1e18` for
wei.

---

## 3. Total supply

**There is no hard cap.** EMBER emission decays to a perpetual tail and continues
forever. Total supply is therefore a function of chain height, not a fixed
number, and any listing form asking for "max supply" should be answered
**"uncapped / no maximum supply"** rather than with a large placeholder.

Supply at height *H* is exactly `Σ subsidy(h)` for `h = 0..H`, with `subsidy`
defined at `node/src/params.js:140-151`. It is fully deterministic: given a
height, the total supply is computable offline with no chain access.

| Year | Issued that year | Cumulative supply | of which Commons |
| ---: | ---: | ---: | ---: |
| 1 | 11,045,161 | 11,045,161 | 1,104,516 |
| 2 | 7,889,401 | 18,934,562 | 1,893,456 |
| 3 | 5,522,580 | 24,457,142 | 2,445,714 |
| 5 | 2,761,290 | 31,163,132 | 3,116,313 |
| 10 | 631,152 | 36,827,722 | 3,682,772 |
| 20 | 631,152 | 43,139,242 | 4,313,924 |
| 50 | 631,152 | 62,073,802 | 6,207,380 |
| 100 | 631,152 | 93,631,402 | 9,363,140 |

All figures in EMBER, rounded to whole coins, assuming blocks land on the
15-second target. **Reproduce the table exactly:**

```bash
cd node && node -e "
const P=require('./src/params'), S=P.SPARKS_PER_EMBER, BPY=P.BLOCKS_PER_YEAR;
let h=0, total=0n, commons=0n;
for (let y=1; y<=100; y++) {
  let issued=0n, com=0n;
  for (let i=0;i<BPY;i++){ const s=P.subsidy(h++); issued+=BigInt(s); com+=BigInt(Math.floor(s*P.COMMONS_SHARE)); }
  total+=issued; commons+=com;
  if ([1,2,3,5,10,20,50,100].includes(y))
    console.log(y, (Number(issued)/S).toFixed(0), (Number(total)/S).toFixed(0), (Number(commons)/S).toFixed(0));
}"
```

Long-run issuance is a flat **631,152 EMBER/year** (0.3 × 2,103,840), which is a
*falling* percentage of supply forever — 1.74% at year 10, 1.29% at year 30,
0.68% at year 100 — without ever reaching zero.

---

## 4. Emission schedule

```
R0        = 6 EMBER/block            node/src/params.js:19
half-life = 2 years = 4,207,680 blocks   node/src/params.js:20, :15
TAIL      = 0.3 EMBER/block, perpetual   node/src/params.js:21
```

Consensus cannot use floating point — two engines disagreeing by one spark is a
chain split — so the on-chain rule is a **deterministic integer schedule**
(`node/src/params.js:140-151`):

1. `epoch = floor(height / 4,207,680)`
2. `base  = floor(600,000,000 sparks / 2^epoch)`, `next = floor(base / 2)`
3. reward is `base` linearly interpolated down to `next` across the epoch
4. `reward = max(TAIL, reward)`
5. at `epoch >= 30` the schedule short-circuits to `TAIL` (`params.js:145`)

This is **not** a Bitcoin-style halving with a cliff: the reward decreases every
single block and is continuous at epoch boundaries.

| Epoch | Starts at height | ≈ Year | Reward at epoch start |
| ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 6 EMBER |
| 1 | 4,207,680 | 2 | 3 EMBER |
| 2 | 8,415,360 | 4 | 1.5 EMBER |
| 3 | 12,623,040 | 6 | 0.75 EMBER |
| 4 | 16,830,720 | 8 | 0.375 EMBER |
| 5+ | 21,038,400 | 10 | 0.3 EMBER (tail) |

**The tail binds at height 18,513,792 (≈ year 8.8)** — mid-epoch-4, where the
interpolated reward first falls to 0.3 EMBER. From that block onward the reward
is 0.3 EMBER forever. Verify:

```bash
cd node && node -e "
const P=require('./src/params'); let lo=0, hi=30e6;
while(lo<hi){const m=Math.floor((lo+hi)/2); P.subsidy(m)<=0.3*P.SPARKS_PER_EMBER ? hi=m : lo=m+1;}
console.log('tail from height', lo, '=', P.subsidy(lo)/P.SPARKS_PER_EMBER, 'EMBER');"
# → tail from height 18513792 = 0.3 EMBER
```

---

## 5. Block reward split

| Recipient | Share | At genesis | Enforcement |
| --- | --- | --- | --- |
| Miner | 90% of subsidy + all tips | 5.4 EMBER | `node/src/chain.js:306-309` |
| Commons treasury | 10% of subsidy | 0.6 EMBER | `node/src/chain.js:310-313` |

`COMMONS_SHARE = 0.10` (`node/src/params.js:22`); the commons amount is
`floor(subsidy × 0.10)` and the miner receives `subsidy − commons + tips`
**exactly** — not "at most". A coinbase that mints one spark more or less than
`subsidy + tips` is rejected (`node/src/chain.js:314-315`). This is the
anti-inflation rule and it is checked on both the fast path and the fork path.

The coinbase may carry at most 2 outputs and no application records
(`chain.js:281-303`), so there is no room to attach anything else to a block
reward.

---

## 6. Fees

**Today (UTXO chain):** a flat base fee of 40,000 sparks (0.0004 EMBER) per
transaction plus 100 sparks per byte of application-record payload, both
**burned** — only the excess above that is a miner tip
(`node/src/params.js:25-29`, `node/src/tx.js:24-26`, `node/src/chain.js:304`).
The fee is flat, not congestion-priced.

**Target (account/EVM chain):** standard EVM gas. `gasUsed × gasPrice` is paid
**to the block's coinbase**, with **no burn in v1**
([`evm-spec.md`](evm-spec.md) §1). Block gas limit 30,000,000; intrinsic gas
21,000 for a plain transfer. EIP-1559 is deferred to v2, so `BASEFEE` pushes zero
and wallets fall back to legacy pricing.

**Retraction.** Earlier documents described "an EIP-1559-style base fee sized by
congestion, burned", and modelled net inflation approaching zero as burn
approached issuance. Neither the current flat burn nor the target no-burn gas
model supports that. **Do not model EMBER as having a burn mechanism.** Assume
gross issuance equals net issuance.

---

## 7. Circulating supply methodology

For CoinGecko / CoinMarketCap purposes:

```
total supply       = Σ subsidy(h) for h = 0..tip            (deterministic, offline-computable)
commons treasury   = balance of the Commons address          (minted, never yet spent)
circulating supply = total supply − commons treasury balance
max supply         = none (uncapped)
```

**Rationale for excluding the Commons.** It is an on-chain address that accrues
10% of every subsidy and has no implemented spend path (§8). Coins there are not
available to any market participant, which is exactly the condition under which
aggregator methodology excludes them. If and when a governance spend mechanism
exists, coins *disbursed* from the treasury become circulating on disbursement;
the undisbursed remainder stays excluded.

**Nothing else is excluded.** There is no vesting, no lock-up, no team wallet, no
foundation reserve and no escrow, because none of those exist.

**The node's `/supply` endpoint does not do this subtraction for you.**
`GET /supply` (`node/src/rpc.js:228-240`) returns:

```json
{ "circulating": 1234500000000, "circulatingEmber": 12345.0,
  "commonsTreasury": 123400000000, "commonsEmber": 1234.0,
  "burnedTotal": 400000, "height": 2057, "blockReward": 599999707 }
```

Its `circulating` field is the sum of the **entire** UTXO set, which *includes*
the Commons balance (`rpc.js:231-234` calls `chain.supply()`, and
`chain.supply()` at `chain.js:166-170` sums every unspent output). Aggregators
should compute `circulating − commonsTreasury`. The field name is misleading and
is a known issue; the arithmetic is unambiguous.

An equivalent `eth_*`-native endpoint for the account-model chain does not exist
yet — see [`listing-checklist.md`](listing-checklist.md).

---

## 8. The Commons treasury

**What it is.** 10% of every block subsidy is minted to
`ember1commons00000000000000000000000000cmns`
(`node/src/params.js:127`), enforced at `node/src/chain.js:310-313`. Its purpose
is to fund development, security audits, explorers and infrastructure without
selling the network to investors.

**What it is not.** It is not a premine and not an allocation. It holds nothing
at genesis and accrues block by block at the same rate as the miner's share,
under exactly the same consensus rule.

**What does not exist.** There is **no spend path**. No proposal mechanism, no
voting contract, no multisig, no key. Nothing in this repository can move a coin
out of the Commons address. Earlier documents described "hybrid governance
blending coin-weighted voting with one-node-one-vote"; that is a design sketch
with no implementation, and it should not be represented to anyone as a
mechanism. Until it exists, the treasury is an accumulator.

Two further notes an integrator will hit:

- The Commons address is **not checksum-valid** — it fails `isValidAddress`
  (`node/src/crypto.js:64-71`). It is a deliberately unspendable sink in the
  UTXO model. The deleted explorer's address search skipped the checksum test for
  this reason; that page went with `web/` in `48bc28a`, so any replacement surface has
  to rediscover the exception rather than inherit it.
- Under the account model the Commons becomes a `0x…` address and this changes.
  **The replacement address has still not been chosen.** Phase 5 made that a
  genesis field (`commonsAddress` in `genesis.json`, defaulted from
  `EVM_COMMONS_ADDRESS` in `node/src/params.js`) so it is consensus and every
  node on a network must agree on it — but its default is the **zero address**,
  which means the 10% is *burned* rather than accumulated. That is the honest
  default: a node cannot invent a treasury key, and paying to an address someone
  made up is worse than burning. `GET /supply` on the account-model node reports
  `commonsIsBurnAddress: true` while that is the case, and the emission schedule
  is unaffected either way. **Choose it before a network that matters launches;
  changing it afterwards is a hard fork.**

---

## 9. No premine — and how to verify it

**The claim:** at genesis, total spendable supply is zero. No allocation, no
sale, no vesting, no founder balance, no ecosystem fund.

**The code:** `Chain.genesis()` (`node/src/chain.js:55-70`) builds a fixed,
mined-free genesis whose single coinbase output pays amount `0` to the Commons
address. There is no other output and no other issuance path — every subsequent
coin must come from a coinbase that `_validate` checked against `P.subsidy(height)`
(`node/src/chain.js:304-315`).

**Verify it in one command**, from a clean clone, with no network access:

```bash
git clone https://github.com/cloudsforge-online/hearth && cd hearth/node
node -e "const {Chain}=require('./src/chain');
         const c=new Chain(require('fs').mkdtempSync('/tmp/hearth-genesis-')).load();
         console.log('height', c.height, 'supply', c.supply());
         console.log(JSON.stringify(c.genesis().txs[0], null, 2));"
```

Expected output:

```
height 0 supply 0
{
  "version": 1,
  "type": "coinbase",
  "height": 0,
  "inputs": [],
  "outputs": [
    {
      "address": "ember1commons00000000000000000000000000cmns",
      "amount": 0
    }
  ],
  "id": "18e380cb5a0db96cb0ae4ae9c11667402442ebba2112951d8b4503439224e98b"
}
```

`supply 0` is the claim. The coinbase `id` above is the genesis coinbase txid of
the *current* tree; it will change when the account-model genesis is written.

The same property is asserted in CI at `node/test/unit.js:101`
(`chain.supply() === 0`, "genesis creates no spendable supply"), which runs on
every push (`.github/workflows/ci.yml`).

### The caveat, stated plainly

The genesis above is the **UTXO-era genesis**. [`evm-spec.md`](evm-spec.md) opens
with *"This is a new chain, not an upgrade… Existing testnet state is
discarded."* The account-model chain will have a new genesis with a genesis state
root, and **that genesis has not been written**. The no-premine property must be
re-verified against it, and the artifact to check will be the genesis state root
and the account list it commits to.

Until that exists, the honest statement is: *the emission rules contain no
premine, the current genesis creates zero supply, and the mainnet genesis is not
yet written.* Anyone evaluating EMBER should require the mainnet genesis and
verify it directly rather than relying on this paragraph.

---

## 10. Known discrepancies in older documents

| Document | Claim | Correction |
| --- | --- | --- |
| `docs/coinnomics.md` | Year-1 issuance 10,667,873 EMBER | **11,045,161.** That figure comes from a smooth exponential model (`proto/emission.js`); consensus runs the *integer, linearly interpolated* schedule, which issues ~3.5% more in year 1. `coinnomics.md` now prints both columns side by side and labels itself a model; **this file is still the one to quote** |
| `docs/coinnomics.md` | Net inflation → ~0.37% via fee burn | Withdrawn there and here. See §6 |
| `docs/coinnomics.md` | Commons spending "requires an on-chain proposal to pass hybrid governance" | No governance exists. Withdrawn there. See §8 |
| `docs/coinnomics.md` | 8 decimals | 18 on the account-model chain. See §2 |
| `proto/emission.js` | The burn ramp it still contains | Not a policy. The account-model chain has **no burn** |
| `WHITEPAPER.md` v0.1 §3.3 | 30-year burn/inflation table | Withdrawn with the burn model |

`coinnomics.md` is kept for the *design rationale* — why uncapped, why a tail, why
10% to the Commons. **This file supersedes its numbers.**

---

## 11. Limitations of these figures

- **All year-based figures assume blocks land exactly on the 15-second target.**
  The schedule is indexed by **height, not by time**. If the network mines faster
  than target — which is what the `MIN_TARGET` clamp exists to prevent
  (`node/src/params.js:57-80`) — emission accelerates in wall-clock terms. Height
  is the ground truth; years are a convenience.
- **`MAX_MONEY` is 90,000,000 EMBER** (`node/src/params.js:84`) and is a
  **per-output** ceiling, not a supply cap. Cumulative supply crosses it around
  year 96. In the UTXO model that only constrains single outputs; the
  account-model equivalent has not been specified.
- **Consensus parameters in this tree are dev-tuned**, including
  `COINBASE_MATURITY: 10` against a production ~100 (`node/src/params.js:95`).
  Changing any of them is a hard fork.
- **No independent economic review has been done.** These are the rules the code
  enforces, not a claim that the rules are good ones.
