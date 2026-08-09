# How this is tested

Written because an EVM implemented by hand is only safe if you can say precisely
what has been checked and what has not. Every number here was produced by running
the thing, not by recalling it.

**Two commands.** `npm test` in `node/` is the gate and takes about four minutes.
`node scripts/fetch-vectors.sh && node test/conformance/runner.js --impl=test/statetransition.js --suite=GeneralStateTests --dir=test/conformance/vectors`
is the full conformance corpus and takes about thirty-five.

---

## 1. The gate — `npm test`, 39 suites, 86,451 checks

**Re-derived 2026-08-09** by running it to completion: `npm test` in `node/`, exit 0,
**without** the optional reference corpus in `test/conformance/vectors`. Every row
below is that run, in the order `node/package.json` runs them — which is the source of
truth, so a suite added there appears here or this table is wrong. Two rows are smaller
offline than they would be with the corpus fetched (`bn128`, `blake2f`); a skipped
optional corpus is deliberately not counted as a check that passed.

| # | Suite | Checks | What it establishes |
| --- | --- | --- | --- |
| 1 | `keccak` | 52 | Keccak-256, **not** SHA3-256 — they differ by one padding byte |
| 2 | `rlp` | 149 | round trips, and non-canonical encodings are refused |
| 3 | `uint256` | 162 | EVM word semantics incl. all 38 EIP-145 shift vectors |
| 4 | `secp256k1` | 179 | RFC 6979 nonces, recovery, the EIP-155 worked example |
| 5 | `opcodes` | 81 | all 256 bytes; 112 explicitly invalid |
| 6 | `gas` | 205 | the Shanghai schedule — consensus, so a wrong constant is a split |
| 7 | `precompiles` | 126 | `0x01`–`0x09`, incl. ecrecover **not** enforcing low-s |
| 8 | `bn128` | 81 | ecAdd/ecMul/pairing against go-ethereum's vectors, gas included. One case is skipped offline; the corpus branch adds **5**, so 86 with it fetched |
| 9 | `blake2f` | 50 | EIP-152, four of which assert failure. The corpus branch adds **3**, so 53 with it fetched |
| 10 | `trie` | 315 | all 25 TrieTests vectors (26 published cases across 6 files), anyorder files run at *every* permutation — which is what takes most of them — plus the speculative overlay store |
| 11 | `statedb` | 166 | 8 published state roots, journal and revert |
| 12 | `transaction` | 165 | 188 TransactionTests; mainnet block 4,400,116 end to end |
| 13 | `receipt` | 62 | encoding and the receipts trie |
| 14 | `bloom` | 61 | the 2048-bit filter — wrong is *silent*, logs just never match |
| 15 | `interpreter` | 194 | execution, frames, EIP-150, collisions, and the RPC-only deadline |
| 16 | `statetransition` | 133 | a transaction end to end |
| 17 | `cli` | 310 | the tracer, ABI codec, wallet, keystore |
| 18 | `jsonrpc` | 422 | the `eth_*` surface, its hex codec, the filter registry and what one request may cost |
| 19 | `evmchain` | 191 | **the account-model chain**: block production, validation, retarget, reorg |
| 20 | `chain-replay` | 27 | a chain reloaded from disk reaches the same tip — including one too large to hold in a single JavaScript string |
| 21 | `evm-rpc` | 170 | the same `eth_*` surface over real HTTP against a real node |
| 22 | `conformance --selftest` | 85 | **that the harness can still fail** |
| 23 | `fuzz` | 82,481 | property tests over five surfaces |
| 24 | `unit` | 40 | the UTXO-era primitives |
| 25 | `e2e` | 24 | the UTXO chain in-process: mine, pay, emission, commons split, fee burn, maturity, reorg |
| 26 | `records` | 49 | the consensus rules for application data, and one conversation carried by them |
| 27 | `mining-budget` | 14 | what an **unauthenticated** caller may make `/mining/*` do — the verification budget and its 429 |
| 28 | `mining-stale` | 50 | what a miner is **told** when its template is gone: 409 for expired, evicted or superseded, 400 only for malformed or never-issued, over real HTTP against both node implementations |
| 29 | `miner-loop` | 4 | the loop's duty cycle — CPU-bound mining must not starve gossip, RPC or the WebSocket keepalive |
| 30 | `mine-keystore` | 52 | the desktop mining key's sealing, adversarially: every failure a keystore can have is otherwise silent |
| 31 | `mine-session` | 82 | the light-mining loop driven directly — templates, submission, staleness, refusals |
| 32 | `miner-cli` | 31 | `hearth-mine` driven as a user drives it, as a process |
| 33 | `netprefix` | 34 | no whole peer IP address ever reaches a log line (`micro-org#163`) |
| 34 | `ws` | 62 | hand-written RFC 6455 framing: masking, all three length forms, continuation, interleaved control frames |
| 35 | `p2p-fork` | 34 | **two real UTXO nodes over real TCP** — partition, compete, reconnect, reorg, and the UTXO set follows |
| 36 | `evm-p2p-fork` | 51 | **two real account-model nodes over real sockets** — partition, divergent mining, reorg onto the heavier branch, byte-identical state roots, disk replay to the same tip, and an open `eth_newFilter` that must deliver the winning branch's logs afterwards |
| 37 | `p2p-ws` | 45 | the same P2P over a `wss`-shaped link, because a home server behind a tunnel has no other inbound path |
| 38 | `pow-params` | 7 | **what the PoW parameters cost.** The production sizes had never been evaluated by anything; this fits the cost model and refuses a pad that cannot be verified inside a block interval ([`pow-parameters.md`](pow-parameters.md)) |
| 39 | `bench/block-execution` | 5 | **what a crafted block costs.** One transaction spending the whole 30M gas limit on SSTOREs, against a calibration block of ordinary traffic |

> **Why this table is now derived rather than maintained.** Until 2026-08-09 it
> enumerated 25 rows plus a `26–31` catch-all, and had drifted in three ways at once.
> **Ten suites were missing entirely** — `chain-replay`, `mining-budget`,
> `mining-stale`, `miner-loop`, `mine-keystore`, `mine-session`, `miner-cli`,
> `netprefix`, `ws` and `p2p-ws`, every one of them in `npm test`. **`transaction` was
> written as 167 and is 165**, and the `bn128` and `blake2f` rows quoted with-corpus
> figures in a table whose total was measured without it. And **the catch-all named
> `browser-pow` and `mining-api`, two files that had not existed since 2026-08-04** —
> 34 of its 181 checks were run by nothing at all. A table transcribed by hand from
> `node/package.json` drifts the moment that file changes; the only defence is to
> re-derive it from a run and date it, which is what the header above now does.

### Outside the gate, on purpose

| Suite | Checks | Why it is not in `npm test` |
| --- | --- | --- |
| `browser-pow` | 11 | Needs [`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site) checked out: it compares that repository's browser Homefire against `node/src/pow.js` digest for digest. `npm test` has to pass on a bare checkout of this one |
| `browser-proof` | 12 | Same, for the proof signature — it drives the browser's own `proofSignature` through the node's template flow and requires a block |

Both **fail rather than skip** when the browser sources are absent, and run in their
own CI job, which checks that repository out first. Measured 2026-08-09 against
`micro-network-site` at `489903f`. Falsifiability was checked rather than assumed:
flipping one term in the browser's scratchpad index derivation fails 4 of `browser-pow`'s
11, and dropping the recovery byte from `proofSignature` fails 5 of `browser-proof`'s 12.

`node test/dex.js` (167 checks) is separate because it needs `contracts/out`; it
runs in the `contracts` CI job. `tools/` has its own job — faucet 66,
explorer-api 177 plus 27 against a real chain, verify 116.

**86,451 is the total measured 2026-08-09 without the reference corpus.** It is larger
than the 86,094 this line used to claim "with the corpus fetched", because suites kept
being added to `node/package.json` and none of them were added here — which is the
drift the note above describes, and the reason the header now carries a date.

---

## 2. Conformance — the corpus

We implement the EVM ourselves. The only reason that is survivable is that
Ethereum publishes reference vectors, so **no component is done until its vectors
pass**.

| Suite | Result |
| --- | --- |
| **GeneralStateTests** | **20,077 / 20,077** — 60,231 checks, 0 failed, re-run in full (32 min) after the trie and StateDB stopped hashing on every write, because a deferred-hashing bug is a wrong state root and the corpus is the only thing that would say so |
| **VMTests** | **609 / 609**, zero errors |
| **TransactionTests** | **188 / 188** legacy |
| **TrieTests** | **25 / 25** vectors — `node/test/conformance/README.md` counts the corpus as 20,766 = 20,077 state + 609 VM + 55 RLP + 25 trie. An earlier revision said 97/97; that figure is not reproducible from this tree and has been corrected |
| RLPTests | all valid and all invalid cases |
| bn128 | 49/49 go-ethereum vectors, output *and* gas |
| blake2f | 8/8 EIP-152, plus BLAKE2b differentiated against OpenSSL at all 411 lengths |

Four traps in the corpus that make a naive runner report green while checking the
wrong thing, all now guarded by the harness self-test:

- **`post` entries are not in index order.** `stEIP2930/transactionCosts.json`
  lists `0,1,2,3,4,5,6,10,7,8,9,11`, so a positional runner checks eight of twelve
  against the wrong root.
- The `indexes` key for the gas limit is **`gas`**, not `gasLimit`.
- **VMTests are Frontier-priced**, not Constantinople as widely assumed — EXP at
  10/byte predates EIP-160, SLOAD at 50 predates EIP-1884. Semantics hold under
  Shanghai; gas figures do not. Take gas conformance from GeneralStateTests only.
- VMTests and GeneralStateTests live in **`ethereum/legacytests`**;
  TransactionTests live in **`ethereum/tests`**. Opposite repositories.

---

## 3. Beyond conformance

Conformance proves agreement with Ethereum on **well-formed input**. Every vector
is a valid transaction someone intended to work. Three other things were done
because that is a narrow guarantee.

### Uniswap V2 on our own EVM

`node/test/dex.js`, 167 checks. Real signed legacy transactions, RLP-encoded,
sender-recovered, applied through the state transition against a fresh StateDB:
deploy → `pairCodeHash()` → `createPair` → `addLiquidity` → swap → swap back →
`permit` → `removeLiquidity`. **A swap costs 112,456 gas** against mainnet's
~150,000; every component price was verified by hand against the trace, so the
difference is compiler, not consensus.

Two things it proved that vectors could not: `ecrecover`'s low-s permissiveness
against real audited code (`permit` is exercised with a high-s reflection EIP-2
would reject), and that the init code hash the Router hard-codes matches the
factory — the number whose drift silently breaks a V2 fork.

It also established a gap: **Uniswap V2 contains no `DELEGATECALL`.** Every
library is `internal`, so solc inlines it. `DELEGATECALL` rests on the
conformance vectors alone.

### Fuzzing

Five targets, properties rather than examples: RLP round-trips and anything
accepted re-encodes byte for byte; `encode(decode(raw)) === raw` for
transactions; the trie root is independent of insertion order; uint256
differentially tested against a reference that disagrees about *how*; the
interpreter never throws and always terminates.

**38 million cases, 176 million checks across six soaks.** uint256, the trie and
the interpreter resisted everything.

### Mutation testing

Every agent that wrote a suite was asked to break its own code and confirm the
score drops. This caught real gaps repeatedly — the two worth naming:

- **The 63/64 rule was tested for CALL and assumed for CREATE.** Removing it from
  CREATE survived both the unit suite *and* all 609 VMTests.
- **A VMTest's `value` transferred twice produces an identical opcode stream**, so
  no assertion about pcs, gas or the stack could catch it. Only the callee's
  balance moves.

---

## 4. What the tests do *not* cover

The most important section.

- **No block has ever been produced at production PoW parameters.** Every block
  this project has ever made — in these suites, in CI, on the compose testnet —
  used a 64 KiB scratchpad and a 256-step walk. The parameters `params.js`
  records as the mainnet intent are 2 GiB and 2,048+ steps, and they have now
  been *measured* rather than assumed: [`pow-parameters.md`](pow-parameters.md).
  This line used to read "no block has ever been produced on the account model",
  which stopped being true when `evmchain` and `evm-p2p-fork` landed.
- **No long-range reorg and no sustained load.** `evm-p2p-fork` partitions two
  nodes for a handful of blocks and reorgs them. Nothing here exercises a
  hundred-block reorg, a third node arriving mid-fork, or hours of traffic.
- **`DELEGATECALL`** — vectors only, for the reason above.
- **`hearth trace --tx`** cannot see a CREATE collision: chain replay prefetches
  state slot by slot, so it cannot know an account's true storage root. It needs
  an `eth_getProof`-style RPC we do not have.
- **`Create2OnDepth1023` is intermittently flaky**, pre-existing. The interpreter
  recurses on the JS stack (~2 frames per EVM level) and at depth 1024 uses ~70%
  of V8's default. A real fix means an explicit frame stack.
- **Performance is gated now, in exactly one place.**
  `node/test/bench/block-execution.js` executes one transaction that spends the
  whole 30,000,000-gas limit on SSTOREs — the case `docs/robustness-review.md`
  §1 measured at 443 MB and 65 s against a 15-second block time — and fails if
  it costs more than 25x an ordinary block of the same gas or retains more than
  64 MiB. It measures **5.2 s and 9.2 MiB** now, 13.5x, against **35.3 s /
  212 MiB / 64.3x** on the same machine before the fix. Nothing else in the
  suite asserts cost, and cost was the only observable: the state roots were
  correct throughout.
- **RLP has no nesting cap** — 7–12 KB, inside `MAX_TX_BYTES`, exhausts the stack.
  Worse, the limit is the *remaining* stack, so the same input decodes from a
  shallow call site and throws from a deep one. Pinned as an observation, not a
  failure.

---

## 5. Why the gate takes four minutes

Two legacy suites dominate: **`records.js` at 148 s and `e2e.js` at 62 s**. They
mine real Homefire blocks, and Homefire is memory-hard by design — 8,192 words of
chained SHA-256 per attempt — so at the genesis target each block is roughly two
million hashes in JavaScript. Everything else in the suite totals under 30
seconds; fuzzing is 4.

This is not a stall and not a timeout. It is 210 seconds of genuine proof-of-work
that every agent checking for regressions pays. A test-only easier target would
remove nearly all of it and is worth doing.

The two cost suites add about 30 seconds between them and neither is optional.
`pow-params` sweeps Homefire out to a 16 MiB pad (~15 s) because a cost model
fitted on cache-resident sizes only would understate the production figure, and
understating it is the mistake the suite exists to prevent.
`bench/block-execution` executes two full 30M-gas blocks (~11 s) because one is
the measurement and the second, against a five-times-wider state trie, is what
distinguishes a fixed cost from one an attacker can make everybody else pay.
