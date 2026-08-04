# Hearth — a chain ordinary people can mine, and developers can build on

**EMBER · working paper v0.3 · 2026-07-29**

---

## Status, stated first

This paper describes a chain **under construction**. Read the status of every
claim before you read the claim.

| Part | Status |
| --- | --- |
| Homefire proof-of-work, LWMA difficulty, emission schedule | **Running.** JavaScript reference node, tested in CI, digest-conformant browser miner |
| UTXO ledger, Ed25519 signatures, `ember1…` addresses | **Running, and being retired.** Replaced by the account model below |
| EVM primitives — Keccak-256, RLP, secp256k1, `uint256` | **Built**, passing published vectors |
| State — Merkle Patricia Trie, StateDB | **Built**, passing `ethereum/tests` TrieTests |
| EVM execution — interpreter, opcode table, gas schedule | **Built. 609/609 VMTests pass** |
| Precompiles `0x01`–`0x09`, including bn128 and blake2f | **Built.** All nine implemented; EIP-196/197/152 vectors pass |
| Transactions, receipts, logs bloom | **Built. 188/188 TransactionTests pass** |
| State transition | **Built. 20,077 of 20,077 GeneralStateTests pass** — the last ten fixed by EIP-7610 — see [`MAP.md`](MAP.md) §4.3 |
| `eth_*` JSON-RPC surface | **Built and served** on 8545 by `node/src/evmnode.js`. 41 methods, 422 checks against a fake chain and 170 against a real one over HTTP |
| EVM-aware explorer · secp256k1 browser wallet · `hearth` CLI with an opcode tracer | **Built** |
| AMM contracts (WEMBER, Factory, Pair, Router, Multicall3) | **Compiled, and executed — on our own EVM.** A full Uniswap V2 deployment and a real swap run in `node/test/dex.js`, and WEMBER deploys to a local node. **Deployed to no chain that outlives the process that mined it** |
| **Consensus on the account model** | **Built.** Blocks are produced, validated and reorged; two real nodes partition and converge (`node/test/evm-p2p-fork.js`). **No block has ever been produced at production PoW parameters** — §2.4 |
| A public endpoint | **Does not exist.** The three-node testnet binds `127.0.0.1` and nothing routes it |
| Mainnet | **Does not exist.** Nothing but throwaway testnets has ever run |

There is no mainnet, no market, no listed price, and no EMBER of any monetary
value in existence. Anything in this document written in the present tense is
running today; anything else is marked.

**The single most important line in that table is the second-to-last one.**
Everything marked "built" above has now been driven by a block. What has not
happened is publication: every port binds `127.0.0.1`, and no genesis outlives
the process that mined it.

**"Built" is still not "ready", and the two remaining gaps are measured rather
than guessed.** The first is closed and recorded because it shaped this
paragraph for a long time: `StateDB` re-rooting both tries on every mutation cost
**443 MB and 65 seconds for one 30M-gas transaction against a 15-second block
time** ([`docs/robustness-review.md`](docs/robustness-review.md) §1); hashing is
deferred now and the same transaction measures 5.2 s and 9.2 MiB. The second is
open: the proof of work runs at a 64 KiB pad and **cannot be raised** — 2 GiB
measures at 185.7 s per evaluation against a validator's per-block budget
([`docs/pow-parameters.md`](docs/pow-parameters.md)) — so §2.4's
ASIC-resistance argument remains an argument about the construction.

**This paper replaces v0.1, which made two claims the code did not support.**
Both retractions are in §8. v0.3 updates the status table, which v0.2 took as a
snapshot of `node/src` before the interpreter, the state transition and the RPC
existed.

---

## Abstract

Proof-of-work started as an egalitarian lottery and became an industry. SHA-256
rewards custom silicon, custom silicon concentrates near cheap power, and pools
concentrate the coordination of it — so the set of parties who decide what the
ledger says is small, identifiable, and not the set of people who use the money.

Hearth's answer is narrow and deliberately unambitious in scope: make the puzzle
one that a commodity CPU is already near-optimal for, and launch with nothing
held back. **Homefire** is a memory-hard hash — chained SHA-256 filling a
scratchpad, then a read-*and-write* walk over it — so the bottleneck is memory
latency rather than gate count, and a laptop is a real participant. There is no
premine, no sale, no allocation and no founder balance: the genesis block mints
zero spendable coins, which anyone can check in about thirty seconds (§3.3).

The second half of the design is a concession to reality. A chain nobody can
build on is a chain nobody uses. Hearth is therefore becoming an **account-model
chain that executes the EVM** — `0x…` addresses, secp256k1 signatures, 18
decimals, standard `eth_*` JSON-RPC — so that MetaMask, ethers, Hardhat, Foundry
and every block explorer work without knowing this chain is bespoke. The
proof-of-work and the emission schedule are unchanged by that move.

---

## 1. The problem

**Mining concentrates.** A hash function that maps efficiently onto a fixed
circuit hands a permanent, super-linear advantage to whoever can fabricate that
circuit. The advantage compounds: cheaper hashing funds more hardware, and the
network's security ends up rented from a handful of firms whose interests are
not the users'.

**Distribution concentrates before the chain even starts.** Premines, private
sales and team allocations decide the ownership of a network before a single
person has chosen to use it. Every later governance question is then decided by
people who were there first, by arrangement rather than by contribution.

**Chains that solve both usually solve nothing else.** The CPU-mineable,
fair-launch corner of the space is full of coins with no contracts, no tooling,
no wallet support and no way for anyone to build anything. Fairness that nobody
can use is a moral position, not a network.

Hearth is an attempt to take the first two seriously without ignoring the third.

---

## 2. Homefire

### 2.1 What it is, exactly

```
pad  = 64 KiB (8,192 × 8-byte words)          node/src/params.js:51, node/src/pow.js:26
fill : cur = SHA256(seed)
       repeat 8,192×:  cur = SHA256(cur);  take cur[0..8] into pad
walk : acc = SHA256(seed ‖ pad[0..64])
       repeat 256×:    idx = acc.readUInt32LE(0) % 8192
                       acc = SHA256(acc ‖ pad[idx*8 .. idx*8+8])
                       pad[idx] ^= acc[0..8]            ← read-modify-write
out  = SHA256(acc ‖ pad[last 64 bytes])
```

`node/src/pow.js:29-42`; step count at `node/src/params.js:52`. One attempt is
roughly 8,450 sequential SHA-256 invocations and touches the entire pad.

**Homefire compiles nothing.** It is chained SHA-256 over a scratchpad. It is
not a RandomX-class virtual machine, and describing it as one — as v0.1 of this
paper did — is wrong. A RandomX-class VM remains a roadmap item and is not
claimed here.

### 2.2 The properties it has

- **Memory-hard.** Every attempt must fill the pad before it can walk it, and
  each walk step's index depends on the previous step's accumulator. There is no
  way to compute the output without materialising the pad.
- **Unskippable.** The walk *rewrites* the word it reads. A read-only walk can be
  reordered or partially precomputed across attempts; a read-modify-write walk
  cannot, because the pad an attempt ends with is a function of the path it took.
- **CPU-friendly, ASIC-resistant.** The bottleneck is commodity memory latency,
  not gate count, which is the regime where a general-purpose CPU with a cache
  hierarchy is close to the optimal machine. This narrows the hardware premium;
  it does not abolish it, and no memory-hard function does.
- **Work handed to a hasher cannot be redirected.** The winning digest must be
  signed by the coinbase key, and `verifyPow` additionally requires the
  coinbase's first output to pay the address derived from that key
  (`node/src/block.js:45-52`). A candidate built for your public key is worthless
  to anyone else.

### 2.3 The property it does not have

**Homefire is not a non-outsourceable puzzle.** The seed binds
`(headerCoreHash, nonce, coinbasePubHex)` — only the coinbase *public* key
(`node/src/pow.js:45-47`). The private key is used exactly once, *after* a nonce
has already won, to sign the digest (`node/src/miner.js`). A pool operator can
therefore distribute the header core together with its **own** public key,
collect `(nonce, digest)` pairs from hashers who genuinely cannot steal the
reward, and sign the blocks itself. Consensus does not notice and cannot.

Making that impossible requires the private key inside the hash loop, which is a
consensus change that forks the chain and breaks the CI-conformance-tested
browser miner. It is a recorded open decision, not an oversight; the source says
so at `node/src/pow.js:8-15`.

So: **pools can form on Hearth.** "No pools required" is true — solo mining on a
laptop works and is the default configuration of `hearthd`. "Pools cannot form"
is not a claim this paper is entitled to make.

### 2.4 The parameters are 64 KiB, and that is what mainnet will launch with

`POW_SCRATCH_KIB` is 64 and `POW_WALK_STEPS` is 256, and this section used to say
they were dev values awaiting a raise to the ~2 GiB and 2,048+ steps recorded
beside them. **That raise is not achievable and the paper should not have implied
it was.** It has now been measured
([`docs/pow-parameters.md`](docs/pow-parameters.md)): a 2 GiB pad costs **185.7
seconds per evaluation**, because Homefire fills the entire pad on every attempt
and amortises nothing between them. A validator pays one full evaluation to
verify every block it receives, against a 15-second interval, so the parameter
is bounded by verification cost and not by miner willingness. `params.js` refuses
to start above 4 MiB, and `node/test/pow-params.js` runs in the gate.

A 64 KiB pad fits in L2 cache and is **not meaningfully memory-hard against
dedicated hardware.** That is a real and unresolved weakness, stated plainly:
what would fix it is an epoch-cached dataset with a cheap verification path —
Ethash's shape — which is a redesign of the proof of work across the node, the
browser miner and the Rust core, not a change to a constant. Until that exists,
the ASIC-resistance argument above is an argument about the construction, not a
measured property, and the construction's memory parameter is 64 KiB.

---

## 3. Fair distribution

This is the thesis, and it is the one part of the design that is fully verifiable
today rather than in prospect.

### 3.1 What "fair" means here

Not "everyone gets some". It means: **at the moment the chain starts, nobody
holds anything, and the only way to acquire the asset is to do the same work
anybody else can do.** No allocation, no sale, no vesting schedule, no
foundation wallet, no "ecosystem fund" that turns out to be 20% of supply.

### 3.2 The three things that make it real

1. **Zero supply at genesis.** The genesis coinbase pays amount `0` to the
   Commons address and creates no spendable output (`node/src/chain.js:55-70`).
2. **The only issuance path is a mined block.** `_validate` recomputes the
   expected subsidy for every block from height alone and rejects any coinbase
   that mints one spark more than `subsidy + tips`
   (`node/src/chain.js:304-315`). There is no other mint.
3. **The puzzle runs on hardware people already own.** A CPU is competitive by
   construction; a browser tab is a working miner
   (`web/mine.html`, digest-conformance-tested against the node in CI at
   `node/test/browser-pow.js`).

### 3.3 Check it yourself

```bash
git clone https://github.com/cloudsforge-online/hearth && cd hearth/node
node -e "const {Chain}=require('./src/chain');const c=new Chain(require('fs').mkdtempSync('/tmp/h-')).load();
         console.log('height',c.height,'supply',c.supply())"
# → height 0 supply 0
```

That is the whole claim. It is one line and it is falsifiable.

**The caveat that matters:** the genesis above is the *UTXO-era* genesis. The
account-model chain gets a new genesis (`docs/evm-spec.md` — "This is a new
chain, not an upgrade"), and the no-premine property must be re-verified against
that genesis when it exists. It has not been written yet. If you are evaluating
Hearth, the genesis state root of the mainnet chain is the artifact to check, and
this paper will not claim it until it exists.

### 3.4 The Commons treasury

10% of every block subsidy is minted to an on-chain address
(`node/src/params.js:22`, address at `:127`, enforced at
`node/src/chain.js:306-313`). It funds development, audits and infrastructure so
that the network does not have to be sold to investors to be built.

Two honest notes. First, the Commons is a *mint*, not a premine: it accrues block
by block at the same rate as the miner's share, and holds nothing at genesis.
Second, **the governance that is supposed to spend it does not exist.** No
proposal mechanism, no voting, no multisig, no spend path of any kind is
implemented. The treasury today is an address that accumulates and cannot pay
out. Earlier drafts described hybrid coin-weighted/one-node-one-vote governance
as though it were a mechanism; it is a design sketch. Full accounting is in
[`docs/tokenomics.md`](docs/tokenomics.md).

---

## 4. Difficulty

Difficulty retargets **every block** with a 60-block linearly-weighted moving
average (`node/src/chain.js:212-235`, window at `node/src/params.js:16`). Each
solve time is clamped to `[1, 6 × TARGET_BLOCK_TIME]` before it enters the
average, so a single timestamp outlier cannot swing the target. The target is a
continuous 256-bit value, and the expected target is recomputed and compared
exactly on every block including the fork path (`chain.js:265`, `:349`) — the
retarget rule *is* consensus, not a heuristic.

Per-block retargeting is what makes small miners viable. A chain that retargets
every 2,016 blocks punishes whoever is mining when hashrate leaves; a chain that
retargets every block absorbs a departure in about a minute.

`MIN_TARGET` — the *hardest* the chain is allowed to become — is
`0000000000000000ffff…`, about 2⁻⁶⁴, or ~1.8×10¹⁹ attempts per block
(`node/src/params.js:80`). This is not decoration. The previous value, ~2⁻²⁰,
bound at roughly 300–500 CPU cores; past that the clamp fires, blocks arrive
faster than the 15-second target, and **emission permanently accelerates**,
because the schedule is indexed by height and not by time. For a coin whose whole
thesis is that ordinary people mine it, a ceiling that binds at a few hundred
CPUs was a launch blocker. `node/test/unit.js:105-113` pins the property rather
than the literal.

---

## 5. Emission

```
reward(0)              = 6 EMBER
half-life              = 2 years  (4,207,680 blocks at 15 s)
tail                   = 0.3 EMBER/block, perpetual
commons share          = 10% of the subsidy
```

`node/src/params.js:19-22`; the schedule itself is `params.js:140-151`.

Consensus cannot use floating point, so the reward is a **deterministic integer
schedule**: it halves each two-year epoch, linearly interpolated inside the
epoch, so the curve is continuous with no cliff and reproduces bit-for-bit on any
engine. The reward reaches the 0.3 EMBER tail at height 18,513,792 — about year
8.8 — and stays there forever.

There is **no hard cap**. Supply rises indefinitely at a fixed 631,152 EMBER per
year once the tail binds, which is a falling *percentage* of supply forever
without reaching zero. This is deliberate: a perpetual tail means the security
budget never depends on a fee market that has not been demonstrated to exist.

Every number, with derivations from `params.js`, is in
[`docs/tokenomics.md`](docs/tokenomics.md). **Do not use the tables in
[`docs/coinnomics.md`](docs/coinnomics.md)** — they are generated from a smooth
exponential model, not from the integer schedule consensus actually runs, and
they differ by about 3.5% in the first year.

---

## 6. The account model and the EVM

### 6.1 Why

Hearth was a UTXO chain with Ed25519 signatures and `ember1…` bech32 addresses.
That design is defensible and it is being replaced anyway, for one reason: **a
chain nobody can build on is a chain nobody uses.**

The concrete cost of being bespoke is not philosophical. It is that MetaMask
cannot add the network, ethers and viem cannot talk to it, Hardhat and Foundry
cannot deploy to it, no block explorer renders it, no hardware wallet derives its
addresses, no audited contract can be reused, and every exchange integration is a
bespoke engineering project rather than a config entry. Each of those is a
separate multi-week piece of work for somebody else, and the sum of them is the
reason most independent chains have no ecosystem.

Speaking the Ethereum RPC dialect converts all of that from work into
configuration.

### 6.2 What changes

Per [`docs/evm-spec.md`](docs/evm-spec.md):

| | Before | After |
| --- | --- | --- |
| State model | UTXO | accounts `{nonce, balance, storageRoot, codeHash}` |
| Address | `ember1…` bech32 | `0x…`, last 20 bytes of `keccak256(pubkey[1:])`, EIP-55 checksummed |
| Signatures | Ed25519 | secp256k1 with public-key recovery |
| Decimals | 8 ("sparks") | **18** — every EVM tool assumes 18 for a native asset. *Specified; `node/src/params.js:6` still defines 1e8* |
| Chain ID | none (a `net` field inside the signed body) | **7411** mainnet, **7412** testnet, EIP-155 replay protection |
| Fork semantics | n/a | **Shanghai** — PUSH0, EIP-3529 refunds, warm coinbase, initcode cap. No blobs |
| Transactions | custom JSON | RLP legacy (type 0). EIP-1559 deferred |
| Block gas limit | n/a | 30,000,000 |
| Fees | flat 40,000-spark burn | gas × gasPrice **to the coinbase**; no burn in v1 |

**Proof-of-work, block time and the emission schedule are unchanged.** Miners
still receive a template and grind nonces, so the browser miner needs no EVM.

### 6.3 Why implemented rather than imported

The decision (owner, 2026-07-28) is that the EVM is written here — no
`@ethereumjs/*`, no `ethers`, no `web3`. Node's built-in `crypto` is used for
SHA-256 and randomness; Keccak-256, RLP, the trie, secp256k1 recovery, the
interpreter and the gas schedule are ours.

That is only a defensible decision because the reference vectors exist, and so
the rule is that **every component ships against published vectors and
conformance is CI-gating**: Keccak against the Keccak team's
`KeccakF-1600-IntermediateValues`, RLP and the trie against `ethereum/tests`,
secp256k1 against RFC 6979, opcodes and gas against `ethereum/legacytests`
VMTests and GeneralStateTests. A divergence from Ethereum semantics is not a
cosmetic bug — it means a Solidity contract behaves differently here than where
it was audited, and somebody loses money.

The harness runs 121 committed vectors offline and 20,766 against the full
upstream corpus — 20,077 state, 609 VM, 55 RLP, 25 trie
(`node/test/conformance/README.md`); the 188 TransactionTests live in a different
upstream repository and run inside `node/test/transaction.js`. **All of it now passes.** The last ten
failures — a single family of `*Paris` account-collision fixtures — were closed by
implementing **EIP-7610**: storage alone makes an address occupied, so `CREATE`
onto it is a collision rather than a legal reset. See [`MAP.md`](MAP.md) §4.3:

| Suite | Result |
| --- | --- |
| VMTests | **609 / 609** |
| GeneralStateTests | **20,077 / 20,077** |
| TransactionTests | **188 / 188** |
| RLPTests, TrieTests | pass |

Two things about that which matter more than the numbers. VMTests are run with
gas checking off, and that is not a concession: `legacytests/Constantinople/VMTests`
is Constantinople *semantics* at Frontier *prices*, and running them with gas on
produces 434 divergences that decompose exactly into EIP-2929, EIP-160 and
EIP-150 with nothing left over (`node/test/interpreter.js:12-21`). Gas conformance
comes from GeneralStateTests, where it is checked. And the corpus is
**gitignored** — `node/scripts/fetch-vectors.sh` obtains it — so the full gate is
a deliberate command rather than something `npm test` runs.

`.github/workflows/ci.yml` now runs `npm test` as a single command rather than
naming suites individually, so a new suite is covered the moment it is added
(`ci.yml:19-49`). That closes the gap v0.2 recorded here. What CI still does
**not** run is the full corpus, only the harness self-test over the committed
fixtures — and at the time of writing the node job is failing outright for an
unrelated one-line reason ([`MAP.md`](MAP.md) §11).

### 6.4 Two opcodes with no natural meaning here, and what they do

`PREVRANDAO` (0x44) is beacon-chain randomness on Ethereum and Hearth has no
beacon chain. It returns **the parent block's Homefire proof-of-work digest** — a
real 256-bit hash, deterministic and verifiable by anyone. It is
**miner-influenceable**: a miner who dislikes an outcome can discard the block
and grind another. It must not be used for anything an adversarial miner would
profit from biasing. Every PoW-derived randomness source has this property and it
is stated here rather than left for a contract developer to discover.

`BASEFEE` (0x48) exists because Shanghai includes EIP-3198 and removing it would
make Shanghai-compiled Solidity fail here while working on Ethereum. v1 has no
EIP-1559, so it pushes zero.

---

## 7. Where the pieces are

| Directory | What it is |
| --- | --- |
| `node/` | The reference full node, wallet, miner, P2P and REST API — **and the entire EVM implementation.** JavaScript, zero runtime dependencies. **This is the network.** |
| `node/src/{crypto,state,evm,chain,jsonrpc}` | The account-model chain: primitives, trie, interpreter, state transition, RPC. ~7,700 lines |
| `node/src/cli`, `node/bin/hearth.js` | `hearth` — the terminal tool, including the opcode-level tracer |
| `node/test/conformance/` | The vector harness and a committed offline subset; the full corpus is gitignored and fetched |
| `contracts/` | Uniswap-V2-derived AMM sources, WEMBER, Multicall3. **Compiled in CI** (`.github/workflows/ci.yml`), and executed against our own EVM by `node/test/dex.js`. **Deployed nowhere** |
| `tools/` | The developer kit: a faucet, Hardhat and Foundry templates, and an RPC probe that serves the real method surface over a fake chain |
| `web/` | EVM-aware block explorer, non-custodial secp256k1 browser wallet, browser miner |
| `site/` | Marketing site. Its copy still describes the UTXO chain |
| `rust/hearthd/` | A self-check binary and a Homefire benchmark. **Not a node, not consensus** — two known divergences, documented in `MAP.md` §3.3. It has no EVM at all |
| `proto/` | Teaching scripts. Not consensus, not imported — and `proto/emission.js` is a *model*, not the schedule |

[`MAP.md`](MAP.md) is the authoritative inventory: every claim in it is checked
against source and cites `path:line`. Where this paper and `MAP.md` disagree,
believe `MAP.md`.

---

## 8. Honest limitations

**Retracted from v0.1 of this paper:**

1. **"Non-outsourceable proof-of-work."** False. See §2.3. Pools can be built on
   Homefire today.
2. **"A RandomX-class VM — each nonce compiles a pseudo-random program."**
   False. Homefire compiles nothing (§2.1).
3. **"An EIP-1559-style base fee sized by congestion, burned"** and the net-zero
   inflation table that followed from it. The fee today is a flat 40,000 sparks
   plus 100 sparks per record byte (`node/src/params.js:25-29`) — not congestion
   priced. And under the account model the fee model changes again: gas is paid
   **to the coinbase with no burn in v1**. The "net inflation approaches zero via
   burn" argument does not survive either fact and is withdrawn.
4. **"Stealth addresses and view keys", "Tab payment channels", "dynamic
   block-size limit governed by a penalty function", "warmshares", "trustless
   mining co-ops", "on-chain governance", "light-client mode", "Hearth Pay SDK",
   "reproducible builds".** None of these are implemented. `rust/hearthd/src/tab.rs`
   contains a signed state machine that nothing calls. `web/pay-demo.html` is a
   mockup that settles nothing on a 1,200 ms timer, and says so on the control.
   They have been removed rather than restated as roadmap, because a paper that
   lists twelve unbuilt features reads as a product.
5. **"Mines only on AC power or when idle."** The browser miner has a real duty
   cycle and drops to ≤15% in a background tab, and pauses on unplug **only where
   the Battery Status API exists** — Firefox and Safari removed it. There is no
   idle detection anywhere and a web page cannot implement one.

**Standing limitations of the current design:**

- **Security budget.** A new PoW chain with low hashrate is cheap to attack, and
  a deep confirmation count does not fix that. Until hashrate is meaningful,
  treat EMBER's settlement assurance as weak and size exposure accordingly. This
  is the single most important honest statement in this document.
- **Memory-hardness does not make mining Sybil-proof.** Someone who buys 10,000
  CPUs gets 10,000 CPUs' worth of hashrate. The goal is *proportional* mining,
  not one-person-one-vote.
- **Dev-tuned consensus parameters ship in this tree.** Pad size, walk steps and
  coinbase maturity (10, against a production ~100 — `params.js:95`) are all set
  for local development. Each is a hard fork to change.
- **Writing an EVM is a serious undertaking.** Conformance vectors make it
  tractable, not safe. The corpus now passes in full, but **no independent audit
  has run**, and the vectors only cover what someone thought to write down.
  Treat contract behaviour here as unverified.
- **The EVM was correct and too slow to run a chain, and that is fixed.**
  `StateDB` re-rooted both of its tries on every single mutation — **443 MB and
  65 seconds for one 30M-gas transaction, against a 15-second block time**
  ([`docs/robustness-review.md`](docs/robustness-review.md) §1, measured, with the
  commands alongside). Root computation moved to the end of the transaction; the
  same transaction now measures 5.2 s and 9.2 MiB, and a benchmark in the test
  gate fails if it regresses. A third of what remains is the storage root, which
  is still materialised per write. Correctness against vectors and
  fitness to run a network are different properties, and only the first is
  demonstrated.
- **A green DEX run is narrower than it looks.** `node/test/dex.js` proves a real
  Uniswap V2 swap executes correctly on our EVM, and it proves nothing about
  `DELEGATECALL`: V2 contains none, because every library is `internal` and solc
  inlines it. `DELEGATECALL`'s context semantics rest on the conformance vectors
  alone.
- **Nothing has been driven by a block.** Every EVM component is proved against
  vectors and fixtures. Consensus on the account model is the missing phase, and
  bugs that only appear when state is carried across blocks, reorged, or persisted
  have had no opportunity to show themselves.
- **`0x06`–`0x09` (bn128, blake2f) are implemented now.** For a period they were
  warmed but unimplemented, and they deliberately **failed loudly** rather than
  being absent — because in the EVM a call to a codeless address *succeeds* and
  returns empty, which a pairing check reads as zero. The interpreter keeps the
  machinery to fail a warmed-but-unimplemented address for exactly that reason
  ([`docs/decisions.md`](docs/decisions.md) §1.3).
- **`PREVRANDAO` is miner-influenceable** (§6.4). It must not be used as a
  randomness source for anything an adversarial miner would profit from biasing.
- **Pre-EIP-155 transactions are accepted**, deliberately, so Multicall3's
  canonical address stays reachable — which means an unprotected transaction is
  replayable across chains ([`docs/decisions.md`](docs/decisions.md) §1.4).
- **No bridges, and none planned soon.** Every bridge is a liability.
- **No wallet recovery.** The browser wallet has one key per browser: no seed
  phrase, no HD derivation, no hardware wallet, no passphrase recovery.
- **No audit.** Nothing in this repository has been independently audited.
- **The Rust crate is not a second implementation.** It has no block type, no
  chain, no fork choice and no P2P server, and two of its modules would produce
  wrong answers if wired up. A green Rust CI job says nothing about consensus.

---

## 9. AI assistance

Parts of this repository were produced with AI assistance, and it seems better to
say so than to leave it to be inferred.

- **Code** — written with Claude Opus 5 and Claude Fable 5 (Anthropic), directed
  and reviewed by a human, and gated on the same tests and CI as anything else
  here.
- **Artwork** — brand marks and icons generated with FLUX 2 Pro. The generated
  originals carry C2PA provenance written by the model, so the claim is checkable
  rather than asserted; derived sizes do not, because resampling discards the
  metadata along with the pixels.

This paragraph named **Claude Opus 4.8** and **OpenAI's image models** until
2026-08-04, and both were true when written. Neither is now: the chain was
rewritten around the account model and its own EVM, retiring the code that
attribution described, and the art was regenerated. An attribution that outlives
the work it describes is a stale sentence with a credit in it.

The models were used under paid API access and the output is the project's to
use. Nothing here is claimed to be hand-written that is not, and nothing is
claimed to work that has not been tested. The conformance-vector discipline in
§6.3 exists partly for this reason: an implementation is judged by whether it
passes the reference vectors, not by who or what wrote it.

---

## 10. Prior art

Bitcoin (proof-of-work, fork choice by cumulative work), Monero (CPU-oriented
mining, tail emission), Zawy's LWMA difficulty algorithm, Ethereum (the account
model, the EVM, and the reference test corpus without which reimplementing it
would be irresponsible), and Uniswap V2 (the AMM the DeFi layer derives from).

Hearth's contribution is not a new primitive. It is the combination: a fair,
CPU-mined launch on a chain that speaks the dialect the rest of the ecosystem
already speaks.

---

## Documents

| | |
| --- | --- |
| [`MAP.md`](MAP.md) | What is actually in this repository, cited to `path:line` |
| [`docs/evm-spec.md`](docs/evm-spec.md) | The account-model / EVM specification. Authoritative |
| [`docs/decisions.md`](docs/decisions.md) | Why the non-obvious choices were made, and what is still open |
| [`docs/quickstart.md`](docs/quickstart.md) | Deploy a contract, every step marked RUN / PROBE / WAITING |
| [`docs/tokenomics.md`](docs/tokenomics.md) | Supply, emission, circulating-supply methodology |
| [`docs/exchange-integration.md`](docs/exchange-integration.md) | For exchange integration engineers |
| [`docs/listing-checklist.md`](docs/listing-checklist.md) | What still has to exist before applying |
| [`SECURITY.md`](SECURITY.md) | Disclosure contact, scope, response expectations |
