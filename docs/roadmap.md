# Roadmap

**Where this actually is:** an EVM implementation that passes Ethereum's
reference vectors, running Uniswap V2, with **no chain under it**. Consensus on
the account model is the one thing standing between here and a testnet.

The phase numbering below is [`evm-spec.md`](evm-spec.md) §8's, because that is
the plan the work is being executed against. Everything else is downstream of it.

**Legend:** ✅ done · 🟡 in progress · ⬜ planned

---

## The EVM migration — the live plan

| Phase | Deliverable | Gate | Status |
| --- | --- | --- | --- |
| **1. Primitives** | keccak, RLP, secp256k1, `uint256` | published vectors pass | ✅ |
| **2. State** | trie, statedb | TrieTests pass | ✅ |
| **3. Execution** | interpreter, gas, opcodes, precompiles | VMTests pass | ✅ **609/609** |
| **4. Transition** | tx application, receipts, bloom, header v2 | GeneralStateTests pass | ✅ **20,077/20,077** — the last ten fixed by EIP-7610 (`c93a524`) — see [`MAP.md`](../MAP.md) §4.3. *Header v2 belongs to phase 5* |
| **5. Consensus** | block production and validation on the new state model | testnet produces and reorgs | 🟡 **being built. No block has ever been produced** — and **blocked** on `StateDB` re-rooting both tries per mutation: 443 MB and 65 s for one 30M-gas transaction against a 15 s block time ([`robustness-review.md`](robustness-review.md) §1) |
| **6. RPC** | `eth_*` surface | MetaMask connects; Hardhat deploys | 🟡 the surface is built and passes 301 checks, but against an in-memory fake — **nothing mounts it**, and the gate needs phase 5 |
| **7. DeFi** | WEMBER, Factory, Pair, Router, Multicall3 | a swap succeeds end to end | ✅ **met** — `node/test/dex.js`, 167/167, a swap at 112,456 gas *on our own EVM*. Deployed to no chain |
| **8. Ecosystem** | EVM-aware explorer, faucet, verified sources, docs | a stranger can deploy unaided | 🟡 explorer ✅, faucet ✅ (undeployed), CLI + tracer ✅, templates ✅, **verified contract sources ✅** (`tools/verify`, 116/116). Etherscan-compatible `/api` 🟡 written, **suite failing** (`tools/explorer-api`). All undeployed |

Phases 1–4 were testable entirely offline against vectors, with no chain running.
That was deliberate: the risky part is provably correct before it touches
consensus. **The corollary is that none of it has ever been driven by a block**,
and phase 5 is where that stops being true.

### What phase 5 actually has to do

Named here because several documents describe it as one line and it is not:

- **Header v2** — `txRoot` (a trie root, not a binary merkle root), `stateRoot`,
  `receiptsRoot`, `logsBloom`, `gasLimit`, `gasUsed`, plus the six fields an RPC
  block response needs that nothing currently supplies: `difficulty`,
  `totalDifficulty` (**cumulative — must be stored**), `size`, `extraData`,
  `nonce`, `mixHash`.
- **`timestamp` in seconds, converted at the header**, not at the RPC boundary.
- **The coinbase key becomes secp256k1**, and with it the block signature. The
  browser miner has already moved and the node has not, so **the browser miner
  currently cannot mine a block the node will accept** — see
  [`decisions.md`](decisions.md) §2.5.
- **Mount the JSON-RPC server** on 8545 at the root path. `jsonrpc/server.js`
  exists; nothing constructs it.
- **An account-model genesis**, and its state root published as the verifiable
  no-premine artifact.

---

## Before mainnet — correctness, not paperwork

Each of these is a hard fork after launch and free before it. The full list with
status is [`listing-checklist.md`](listing-checklist.md) §7.

| | |
| --- | --- |
| ⬜ | **Raise `POW_SCRATCH_KIB`** from 64 to ~2 GiB and `POW_WALK_STEPS` from 256 to 2,048+. A 64 KiB pad fits in L2 cache and is not meaningfully memory-hard |
| ⬜ | **Raise `COINBASE_MATURITY`** from 10 to ~100 |
| ⬜ | **Implement 18 decimals.** `params.js:6` still defines 1e8 |
| ⬜ | **A `0x` Commons address**, and a decision about whether anything can ever spend from it |
| ⬜ | **Decide `nativeCurrency.name`** — SLIP-44 170 is already `MBRS / Ember`, so the name collides while the symbol does not |
| ⬜ | **Decide Multicall3** — replay the canonical presigned deployment, or deploy ours at a different address |
| ⬜ | **Independent audit** of the EVM and consensus. Conformance vectors make this tractable; they do not make it audited |
| ⬜ | **A monitored `security@` mailbox and a PGP key** |

---

## Infrastructure, once a chain exists

| | |
| --- | --- |
| ⬜ | Public testnet on chain id **7412** with a stable HTTPS RPC endpoint |
| ⬜ | Deploy the faucet (the service is written and tested; there is nowhere to run it) |
| ⬜ | Point the explorer at a real chain |
| ⬜ | Deploy WEMBER, the AMM and Multicall3 — **and seed liquidity.** A DEX with empty pools attracts nobody |
| ⬜ | Deploy the **Etherscan-compatible `/api` shim** — worth more than a prettier explorer: aggregators, tax tools, portfolio trackers and several exchange back-ends all speak it. The service is written (`tools/explorer-api`) but **its suite does not currently pass**, and there is nowhere to run it |
| ⬜ | Deploy the plain-decimal total and circulating supply endpoints; aggregators poll exactly these. Written, in the same service |
| ⬜ | Register chain id 7411 in `ethereum-lists/chains`; register a SLIP-44 coin type |
| ⬜ | Seed nodes, DNS seeds, a status page, a second independent RPC provider |
| ⬜ | Deploy contract source verification (`tools/verify`, 116/116 — written, undeployed) |

---

## Deferred to v2 or later

Written down so nobody plans around them.

| | |
| --- | --- |
| ⬜ | **EIP-1559 / type-2 transactions** and a real fee market. `BASEFEE` pushes zero until then, and block responses deliberately omit `baseFeePerGas` so clients fall back to legacy pricing |
| ⬜ | `eth_subscribe` over WebSocket (8546 is reserved), `eth_newFilter`, `eth_feeHistory` |
| ⬜ | `debug_traceTransaction` / `trace_block`. The tracer exists as a CLI tool; exposing it over RPC is a small change and is not scheduled |
| ⬜ | State pruning, snapshot sync, archive-node distinctions. Every node is an archive node today because nothing prunes |
| ⬜ | Account abstraction, blob transactions |
| ⬜ | Bridges. Every bridge is a liability |

---

## Dropped, or never real

Listing these rather than quietly deleting them, because earlier roadmaps
promised them and someone will ask.

| | |
| --- | --- |
| **Stealth addresses and view keys** | Not in the spec. An account-model EVM chain has transparent balances by construction |
| **Tab payment channels** | `rust/hearthd/src/tab.rs` is a signed state machine nothing calls. Not on the EVM plan |
| **The Hearth Pay merchant SDK** | `web/pay-demo.html` is a mockup that settles nothing on a timer |
| **Warmshares / uncles** | Never implemented, not in the spec |
| **A RandomX-class VM** | Homefire compiles nothing. Growing it into one is not scheduled and is not claimed |
| **Hybrid coin-weighted / one-node-one-vote governance** | A design sketch, never a mechanism |
| **A WASM light-miner** | The browser miner's bottleneck was async WebCrypto, not the language; a synchronous SHA-256 fixed it |
| **Reproducible builds** | Claimed and never implemented |
| **A non-outsourceable puzzle** | Requires the private key inside the hash loop — a consensus change that forks the chain and breaks the conformance-tested browser miner. A recorded open decision, not an oversight ([`mining.md`](mining.md)) |

---

## The Rust core

`rust/hearthd` is **not** a second implementation: no block type, no chain, no
fork choice, no P2P server, and two modules that would produce the wrong answer if
wired up ([`why-two-implementations.md`](why-two-implementations.md),
[`../MAP.md`](../MAP.md) §3.3).

It is also now much further behind than that suggests: **the entire EVM was
written in JavaScript and has no Rust counterpart**, and the crate is still
Ed25519 and UTXO-shaped. Rust remains the stated target; no work has moved toward
it since the EVM began, and this roadmap does not pretend otherwise.

---

## Where to help first

1. **Phase 5.** Nothing else matters until a block exists.
2. **The Etherscan-compatible `/api` shim** — a small job that removes a large
   amount of downstream integration friction.
3. **`node/test/blake2f.js:304`** — a one-line fix that is currently turning CI
   red and hiding the results of ten suites ([`../MAP.md`](../MAP.md) §11).

See [CONTRIBUTING.md](../CONTRIBUTING.md).
