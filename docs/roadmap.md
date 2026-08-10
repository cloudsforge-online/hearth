# Roadmap

**Where this actually is:** an EVM implementation that passes Ethereum's
reference vectors, running Uniswap V2, **with a chain under it**. Consensus on
the account model has landed: the node mines blocks, reorgs onto the heavier
branch, replays its disk to the same tip, and serves `eth_*` on 8545. Nothing
is published, and two things are unfinished — throughput on storage-heavy load
(phase 5's row below) and the production PoW parameters
([`pow-parameters.md`](pow-parameters.md)).

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
| **5. Consensus** | block production and validation on the new state model | testnet produces and reorgs | ✅ **met.** `node/test/evm-p2p-fork.js` (51 checks) partitions two real nodes over real sockets, reorgs them onto the heavier branch, agrees state roots byte for byte and replays a restarted node to the same tip; `docker-compose.testnet.yml` runs three. The standing caveat here was throughput on storage-heavy load — `StateDB` re-rooting both tries per mutation, measured at 443 MB and 65 s for one 30M-gas transaction. Fixed and gated: `node/test/bench/block-execution.js` measures the same transaction at 5.2 s and 9.2 MiB and fails if it regresses |
| **6. RPC** | `eth_*` surface | MetaMask connects; Hardhat deploys | ✅ **mounted** on 8545 by `node/src/evmnode.js`. 41 methods (43 with `HEARTH_RPC_FEE_HISTORY=1`), 422 checks against a fake chain and 170 against a real one over HTTP. A contract deploys and answers through it ([`quickstart.md`](quickstart.md) §5.0). No WebSocket surface — 8546 is reserved for v2 |
| **7. DeFi** | WEMBER, Factory, Pair, Router, Multicall3 | a swap succeeds end to end | ✅ **met** — `node/test/dex.js`, 167/167, a swap at 112,456 gas *on our own EVM*. Deployed to no chain |
| **8. Ecosystem** | EVM-aware explorer, faucet, verified sources, docs | a stranger can deploy unaided | 🟡 the gate is **met locally** — one command starts a chain and the next deploys to it. Publicly it is **partly** met, and the old "nothing is hosted" was wrong by 2026-08-10: mainnet 7411 answers at `https://rpc.cloudsforge.online` and an explorer is served at `https://explorer.cloudsforge.online` (both measured that day), though the explorer is `micro-explorer-web` reading `micro-indexer` rather than anything in this repository. **The pieces that live here are still unhosted**: verified contract sources ✅ (`tools/verify`, 116/116) and the Etherscan-compatible `/api` ✅ (`tools/explorer-api`, 177/177 plus 27/27 against a real chain) run nowhere public, and the estate faucet is testnet-only and paused. explorer ✅, faucet ✅, CLI + tracer ✅, templates ✅ — as code |

Phases 1–4 were testable entirely offline against vectors, with no chain running.
That was deliberate: the risky part is provably correct before it touches
consensus. The corollary used to be that none of it had ever been driven by a
block. Phase 5 ended that, and what it did **not** end is written down rather
than implied: no long-range reorg has been exercised, no sustained load has
been applied, and **no block has ever been produced at production PoW
parameters** ([`pow-parameters.md`](pow-parameters.md)).

### What phase 5 had to do, and did

Kept here because several documents described it as one line and it was not.
Every item below is now in the tree:

- **Header v2** — `txRoot` (a trie root, not a binary merkle root), `stateRoot`,
  `receiptsRoot`, `logsBloom`, `gasLimit`, `gasUsed`, plus the six fields an RPC
  block response needs that nothing currently supplies: `difficulty`,
  `totalDifficulty` (**cumulative — must be stored**), `size`, `extraData`,
  `nonce`, `mixHash`.
- **`timestamp` in seconds, converted at the header**, not at the RPC boundary.
- **The coinbase key becomes secp256k1**, and with it the block signature. This
  is why `hearthd --evm` refuses `--miner-address`: the coinbase must sign the
  block, so a node can only mine to a key it holds — see
  [`decisions.md`](decisions.md) §2.5.
- **Mount the JSON-RPC server** on 8545 at the root path — `evmnode.js`
  constructs it.
- **An account-model genesis**, and its state root published as the verifiable
  no-premine artifact.

---

## Before mainnet — correctness, not paperwork

Each of these is a hard fork after launch and free before it. The full list with
status is [`listing-checklist.md`](listing-checklist.md) §7.

| | |
| --- | --- |
| ✅ | ~~**Raise `POW_SCRATCH_KIB`** from 64 to ~2 GiB~~ — **measured and closed the other way.** 2 GiB is 185.7 s per evaluation against a 15 s interval, and a validator pays one per block received; `params.js` refuses to start above 4 MiB. A 64 KiB pad still fits in L2 and is still not meaningfully memory-hard — fixing that needs an amortised dataset, not a constant ([`pow-parameters.md`](pow-parameters.md)) |
| ✅ | ~~**Raise `COINBASE_MATURITY`** from 10 to ~100~~ — a no-op on the account model, which credits the subsidy straight to the balance. The constant is read only by the retired UTXO path |
| ⬜ | **Implement 18 decimals.** `params.js` still defines 1e8 |
| ⬜ | **A `0x` Commons address**, and a decision about whether anything can ever spend from it |
| ⬜ | **Decide `nativeCurrency.name`** — SLIP-44 170 is already `MBRS / Ember`, so the name collides while the symbol does not |
| ⬜ | **Decide Multicall3** — replay the canonical presigned deployment, or deploy ours at a different address |
| ⬜ | **Independent audit** of the EVM and consensus. Conformance vectors make this tractable; they do not make it audited |
| ⬜ | **A monitored `security@` mailbox and a PGP key** |

---

## Infrastructure, once a chain exists

| | |
| --- | --- |
| ✅ | Public testnet on chain id **7412** with a stable HTTPS RPC endpoint — `https://rpc-testnet.cloudsforge.online` |
| ✅ | Deploy the faucet — `https://network-testnet.cloudsforge.online/faucet` |
| ✅ | Point the explorer at a real chain — `explorer.cloudsforge.online` (7411) and `explorer-testnet.cloudsforge.online` (7412) |
| ⬜ | Deploy WEMBER, the AMM and Multicall3 — **and seed liquidity.** A DEX with empty pools attracts nobody |
| ⬜ | Deploy the **Etherscan-compatible `/api` shim** — worth more than a prettier explorer: aggregators, tax tools, portfolio trackers and several exchange back-ends all speak it. The service is written and green (`tools/explorer-api`, 177/177 plus 27/27 against a real chain); there is nowhere public to run it |
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
| **The Hearth Pay merchant SDK** | Nothing exists. The `pay-demo.html` mockup that settled nothing on a timer was deleted with `web/` in `48bc28a` |
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
3. **`node/test/blake2f.js`** — a one-line fix that is currently turning CI
   red and hiding the results of ten suites ([`../MAP.md`](../MAP.md) §11).

See [CONTRIBUTING.md](../CONTRIBUTING.md).
