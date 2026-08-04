# The proof-of-work parameters, measured

Every block Hearth has ever produced — in the test suites, in CI, on the compose
testnet, everywhere — used a **64 KiB scratchpad and a 256-step walk**. The
values `params.js` recorded beside them as the mainnet intent were **2 GiB and
2,048+ steps**, and six documents described reaching them as raising two
constants before launch: free now, a hard fork later.

Nothing had ever evaluated `homefireHash` at those sizes. This page is what
happened when something did.

**The headline: the intended production parameters are not reachable with this
construction.** One evaluation at 2 GiB takes **185.7 seconds** — measured, not
extrapolated — against a 15-second block interval, and a validator pays one full
evaluation for every block it receives. This is not a tuning problem that a
faster machine solves; it is 32,768x more work per attempt with nothing
amortised between attempts, and the gap is four orders of magnitude.

Reproduce all of it with:

```bash
node test/pow-params.js            # the fast sweep, part of `npm test`
node test/pow-params.js --sweep    # out to 256 MiB
node test/pow-params.js --full     # one real evaluation at 2 GiB, ~3 minutes
```

---

## 1. What was measured, and on what

`node/test/pow-params.js`, Node v24.14.0, darwin/arm64, 10 cores, 32 GiB. The
harness calls `node/src/pow.js`'s own `homefireHash` — not a copy of it — with
the pad size and walk length passed explicitly, and asserts first that the
explicit call reproduces the configured one byte for byte. If that assertion
ever fails, nothing below means anything.

Timings are per evaluation, averaged over 20 repetitions at the small sizes and
2 at the large ones, after a warm-up. Memory is **RSS**, not heap: the pad is a
`Buffer`, so it is external memory and `heapUsed` cannot see it — reporting heap
would have shown a 2 GiB pad costing nothing.

## 2. Cost against pad size — **measured**

At the shipped 256-step walk:

| pad | ms per evaluation | µs per KiB | peak RSS |
| --- | --- | --- | --- |
| 64 KiB (**shipped**) | 6.57 | 102.7 | 58 MiB |
| 256 KiB | 25.4 | 99.3 | 64 MiB |
| 1 MiB | 100.2 | 97.8 | 89 MiB |
| 4 MiB | 388.3 | 94.8 | 115 MiB |
| 16 MiB | 1,525.9 | 93.1 | 195 MiB |
| 64 MiB | 6,091.5 | 93.0 | 324 MiB |
| 256 MiB | 24,039.7 | 91.7 | 843 MiB |
| **2 GiB (the intent)** | **185,700** | 88.6 | **2,165 MiB** |

The 6.57 ms at 64 KiB agrees with the 6.84 ms `robustness-review.md` measured
independently, which is the cheapest available check that the harness is timing
the right thing.

**Cost is linear in the pad**, to within the difference between a pad that fits
in cache and one that does not — the per-KiB rate falls slightly with size
because the fill is sequential and prefetches well. It never falls
*meaningfully*, because the work is one SHA-256 per 8-byte word of pad and there
is nothing else in the function to amortise it against.

The 2 GiB row is a **single real evaluation**, not a projection. The projection
from the 64 MiB → 256 MiB slope said 191.4 s; the clock said 185.7 s, 3% apart.
Both are recorded because the agreement is the evidence that the linear model
can be trusted for sizes nobody wants to sit through.

## 3. Cost against walk length — **measured**

At the shipped 64 KiB pad:

| steps | ms per evaluation |
| --- | --- |
| 256 (**shipped**) | 6.20 |
| 512 | 6.45 |
| 1,024 | 7.03 |
| 2,048 (the intent) | 8.13 |
| 4,096 | 10.27 |

**The walk is the affordable parameter and always was.** Each step is one
SHA-256 over 40 bytes; the fill is one SHA-256 per word — 8,192 of them at
64 KiB. Going to 2,048 steps therefore adds ~1,792 hashes to an evaluation that
already pays 8,192, which is the 1.31x above rather than the 8x a reader of the
constant would expect.

It is also close to pointless on its own. The walk is what makes the pad
*random-access*; the pad is what makes the function memory-hard. Raising the
walk without raising the pad buys latency, not hardness.

## 4. What this means for the chain

**For a miner.** At 2 GiB one attempt is 185.7 s. Homefire is
one-attempt-one-nonce, so a solo CPU miner would make roughly 19 attempts an
hour. The genesis target is ~1-in-256, so a *single* block would take about
13 hours of one core at genesis difficulty, on a chain targeting 15 seconds.

**For a validator, which is worse.** Verifying a received block is one full
Homefire evaluation. At the shipped parameters that is 6.6 ms, and
`P2P_BLOCK_VERIFY_BURST: 200` — one full `getblocks` page — was sized against
it: 200 x 6.6 ms is 1.3 seconds of worst-case wasted CPU for an anonymous peer,
which is the right order. At 2 GiB the same page is **185.7 s x 200 ≈ 10.3 hours
of one core**, and it is *synchronous*: `pow.js` allocates, fills and walks the
pad in one blocking loop. The node does not run out of memory — the pad is
allocated and released per call, so RSS peaks at ~2.2 GiB, not 200 x 2 GiB — it
simply stops. The failure mode is event-loop starvation, not exhaustion.

**For the browser miner**, which is the distribution thesis: a Worker cannot
allocate a 2 GiB `ArrayBuffer` in any mainstream browser, and would spend three
minutes per attempt if it could.

**So `P2P_BLOCK_VERIFY_BURST` and `_PER_S` do not need re-deriving.** They are
correctly sized for the parameters the chain actually runs, and no arithmetic
rescues them for parameters that cost minutes — at 2 GiB the only safe burst is
less than one. That is the finding, not a constant to retune.

## 5. What was done about it

1. **`POW_MAX_SCRATCH_KIB: 4,096`**, asserted at `require()` time in
   `params.js`. A node configured above it **refuses to start**, with an error
   naming this document. The failure this guards against is not a typo — it is a
   documented instruction ("raise `POW_SCRATCH_KIB` from 64 to the production
   ~2 GiB") that no test in the repository would have refused, on a day when
   somebody is cutting a genesis.
2. **`node/test/pow-params.js` runs in `npm test`.** Its fast path is a few
   seconds and it asserts the three scale-free properties: the parameterised
   hash is the configured hash, cost is linear in the pad, and the configured
   parameters evaluate inside 1% of the block interval.
3. **The six documents that described this as raising two constants** —
   `listing-checklist.md` M1, `roadmap.md`, `TESTNET.md`, `WHITEPAPER.md` §2.4,
   `docs/coinnomics.md` §8 and `MAP.md` — now say what it actually is.

## 6. What would actually make the PoW harder

Not a bigger constant. The property Homefire lacks is **amortisation**: Ethash
and its descendants pay O(dataset) once per epoch and O(1) per attempt against
it, so a 1 GiB dataset costs a miner 1 GiB of *residency* and costs a validator
one cheap lookup — the asymmetry that makes large memory affordable. Homefire
pays the whole pad on every attempt, so pad size is a direct multiplier on both
mining and verification, and verification is the side with a hard deadline.

Closing that gap means an epoch-cached dataset with a light per-attempt access
pattern and a light verification path. That is a redesign of `node/src/pow.js` and
`rust/hearthd/src/pow.rs` together (the browser twin `web/assets/mining/homefire.js`
was deleted in `48bc28a`), plus new
cross-implementation vectors — **not an edit to `params.js`**, and not something
to attempt in the week before a genesis.

Until that is done, the honest statement of the ASIC-resistance argument is the
one `WHITEPAPER.md` §2.4 already makes: it is an argument about the
construction, not a measured property — and now it is a construction whose
memory parameter is measured, and is 64 KiB.

## 7. What is still unmeasured

- **The three-node compose run at production parameters.** CF-11 asked for a
  fourth network (`hearth-prepare`) standing up the full 3-node testnet at 2 GiB
  and measuring it end to end. It was not stood up, and the reason is this
  document: at 185.7 s per attempt and ~1-in-256 at the genesis target, the
  first block would arrive some 13 core-hours in. The measurement that would
  have justified the network is the measurement that says the network cannot
  run, and standing it up to watch it not produce a block would add nothing to
  the numbers above.
- **A hostile-peer test at production parameters**, for the same reason.
- **Anything at all on the browser miner at 2 GiB.** The allocation fails before
  there is anything to time.
- **`COINBASE_MATURITY`.** Listing-checklist M2 says raise it from 10 to ~100.
  On the account model there is no maturity at all: `_creditReward`
  (`blockchain.js`) adds the subsidy straight to the balance, spendable in the
  next block, and `COINBASE_MATURITY` is read only by the retired UTXO path
  (`tx.js`, `wallet.js`, `rpc.js`, `chain.js`). M2 is a no-op on the chain being
  launched. Whether the account model *should* have a maturity rule is a real
  question and an open one; it is not the question M2 asks.
