# How this is tested

Written because an EVM implemented by hand is only safe if you can say precisely
what has been checked and what has not. Every number here was produced by running
the thing, not by recalling it.

**Two commands.** `npm test` in `node/` is the gate and takes about four minutes.
`node scripts/fetch-vectors.sh && node test/conformance/runner.js --impl=test/statetransition.js --suite=GeneralStateTests --dir=test/conformance/vectors`
is the full conformance corpus and takes about thirty-five.

---

## 1. The gate — `npm test`, 27 suites, 85,512 checks

| # | Suite | Checks | What it establishes |
| --- | --- | --- | --- |
| 1 | `keccak` | 52 | Keccak-256, **not** SHA3-256 — they differ by one padding byte |
| 2 | `rlp` | 149 | round trips, and non-canonical encodings are refused |
| 3 | `uint256` | 162 | EVM word semantics incl. all 38 EIP-145 shift vectors |
| 4 | `secp256k1` | 179 | RFC 6979 nonces, recovery, the EIP-155 worked example |
| 5 | `opcodes` | 81 | all 256 bytes; 112 explicitly invalid |
| 6 | `gas` | 205 | the Shanghai schedule — consensus, so a wrong constant is a split |
| 7 | `precompiles` | 119 | `0x01`–`0x05`, incl. ecrecover **not** enforcing low-s |
| 8 | `bn128` | 86 | ecAdd/ecMul/pairing against go-ethereum's vectors, gas included |
| 9 | `blake2f` | 46 | EIP-152, four of which assert failure |
| 10 | `trie` | 302 | all 25 TrieTests vectors (26 published cases across 6 files), anyorder files run at *every* permutation — which is what takes 252 of the 302 |
| 11 | `statedb` | 166 | 8 published state roots, journal and revert |
| 12 | `transaction` | 167 | 188 TransactionTests; mainnet block 4,400,116 end to end |
| 13 | `receipt` | 62 | encoding and the receipts trie |
| 14 | `bloom` | 61 | the 2048-bit filter — wrong is *silent*, logs just never match |
| 15 | `interpreter` | 182 | execution, frames, EIP-150, collisions |
| 16 | `statetransition` | 133 | a transaction end to end |
| 17 | `cli` | 310 | the tracer, ABI codec, wallet, keystore |
| 18 | `jsonrpc` | 301 | the `eth_*` surface and its hex codec |
| 19 | `conformance --selftest` | 85 | **that the harness can still fail** |
| 20 | `fuzz` | 82,481 | property tests over five surfaces |
| 21–27 | `unit`, `e2e`, `records`, `browser-pow`, `keystore`, `mining-api`, `p2p-fork` | 183 | the UTXO-era chain, still green |

`node test/dex.js` (167 checks) is separate because it needs `contracts/out`; it
runs in the `contracts` CI job.

**85,512 is the total with the reference corpus fetched.** `npm test` passes
without it — verified from a fresh clone into an empty directory, 27 suites,
exit 0 — and two suites are then smaller: `bn128` 86 → 81 (one case skipped) and
`blake2f` 46 → 43. The gate is **85,504** offline. A skipped optional corpus is
deliberately not counted as a check that passed.

---

## 2. Conformance — the corpus

We implement the EVM ourselves. The only reason that is survivable is that
Ethereum publishes reference vectors, so **no component is done until its vectors
pass**.

| Suite | Result |
| --- | --- |
| **GeneralStateTests** | **20,077 / 20,077** — 60,231 checks |
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

- **No block has ever been produced on the account model.** Consensus is under
  construction. Everything above tests the execution layer in isolation.
- **`DELEGATECALL`** — vectors only, for the reason above.
- **`hearth trace --tx`** cannot see a CREATE collision: chain replay prefetches
  state slot by slot, so it cannot know an account's true storage root. It needs
  an `eth_getProof`-style RPC we do not have.
- **`Create2OnDepth1023` is intermittently flaky**, pre-existing. The interpreter
  recurses on the JS stack (~2 frames per EVM level) and at depth 1024 uses ~70%
  of V8's default. A real fix means an explicit frame stack.
- **Performance is not gated.** `docs/robustness-review.md` measured StateDB
  re-rooting the trie on every mutation: **443 MB retained and 65 seconds of CPU
  for one 30M-gas transaction**, against a 15-second block time. No test fails on
  it.
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
