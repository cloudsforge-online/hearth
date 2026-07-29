# Architecture

A map of the whole system. **Everything in this document exists in this
repository** unless it is marked *(not built)*, and the marked things are marked
because a previous version of this page described a dozen unbuilt features in the
present tense.

The chain is mid-migration. Read §1 before anything else.

---

## 1. Two chains, one repository

| | The chain that runs today | The chain being built |
| --- | --- | --- |
| Ledger | UTXO | **accounts** `{nonce, balance, storageRoot, codeHash}` |
| Signatures | Ed25519 | **secp256k1** with public-key recovery |
| Addresses | `ember1…` bech32 | **`0x…`**, EIP-55 checksummed |
| Decimals | 8 ("sparks") | **18** (specified; `params.js:6` has not moved) |
| Transactions | canonical JSON | **RLP legacy (type 0)**, EIP-155 |
| Execution | none — records only | **the EVM**, Shanghai semantics |
| API | REST + SSE on 8645 | **`eth_*` JSON-RPC on 8545** |
| Status | produces blocks | **produces no blocks yet** |

**Unchanged across the migration:** Homefire proof-of-work, the 15-second block
time, LWMA difficulty, and the emission schedule. A miner receives a template and
grinds nonces, so the browser miner needs no EVM
([`evm-spec.md`](evm-spec.md) §4).

The specification is [`evm-spec.md`](evm-spec.md). The reasoning behind its
non-obvious choices is [`decisions.md`](decisions.md). What is actually built,
cited to `path:line`, is [`../MAP.md`](../MAP.md).

---

## 2. The shape of it

```
        MetaMask · ethers · viem · Hardhat · Foundry · web3.py
        web explorer · browser wallet · hearth CLI · faucet
                             │
                             │  Ethereum JSON-RPC (8545, root path)   ← nothing serves it yet
                             ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  hearthd                                                       │
   │                                                                │
   │  jsonrpc/    method table · QUANTITY/DATA codec · JSON-RPC 2.0 │
   │      ▲                                                         │
   │      │  a chain interface in native JS values (bigint, Buffer) │
   │      │                                                         │
   │  ┌───┴──────────────────  NOT BUILT  ───────────────────────┐  │
   │  │  consensus on the account model: header v2, block        │  │
   │  │  production and validation, fork choice on state roots   │  │
   │  └───┬──────────────────────────────────────────────────────┘  │
   │      │                                                         │
   │  chain/      state transition · transactions · receipts · bloom│
   │  evm/        interpreter · gas · opcodes · precompiles 0x01-09 │
   │  state/      Merkle Patricia Trie · StateDB (journaled)        │
   │  crypto/     keccak256 · RLP · secp256k1                       │
   │                                                                │
   │  ── and, in parallel, the UTXO chain still running: ──────────│
   │  pow.js · chain.js · tx.js · mempool.js · p2p.js · rpc.js      │
   └────────────────────────────────────────────────────────────────┘
```

The gap in the middle is the whole story. Every layer below it is built and
gated on Ethereum's published vectors; the layer above it is built and tested
against an in-memory fake. **Nothing joins them.**

---

## 3. The EVM stack, bottom up

Each row is a real directory with real tests. See [`../MAP.md`](../MAP.md) §4 for
the exact counts, all of which were produced by running the suites.

| Layer | Modules | Gated on |
| --- | --- | --- |
| Primitives | `crypto/keccak.js`, `crypto/rlp.js`, `crypto/secp256k1.js`, `evm/uint256.js` | Keccak team intermediate values, Ethereum RLP vectors, RFC 6979 |
| State | `state/trie.js`, `state/statedb.js` | `ethereum/tests` TrieTests |
| Execution | `evm/{stack,memory,opcodes,gas,interpreter}.js` | **609/609 VMTests** |
| Precompiles | `evm/precompiles.js`, `evm/bn128.js`, `evm/blake2f.js` | EIP-196/197/1108, EIP-152, go-ethereum vectors |
| Transition | `chain/{transaction,receipt,bloom,statetransition}.js` | **188/188 TransactionTests**, **20,077/20,077 GeneralStateTests** |
| RPC | `jsonrpc/{hex,methods,server,filters}.js` | 422 checks against an in-memory fake chain, 170 against a real node over HTTP |

**Three design points that are load-bearing rather than stylistic:**

- **The trie is the *secure* variant** — keys are `keccak256(key)` before
  insertion, and a node whose RLP encoding is under 32 bytes is embedded rather
  than hashed. Getting either wrong produces a wrong `stateRoot` and a silent
  consensus failure.
- **StateDB is journaled, not a map.** `REVERT`, failed calls and out-of-gas must
  roll back storage, balance, nonce and code to a snapshot while gas already
  consumed stays consumed. It is an ordered journal with checkpoint markers.
  **Hashing is deferred to `root()`**, which is once per transaction: `_write`
  marks an account dirty and `_flush` puts the dirty records into the state trie,
  while `trie.js` leaves rebuilt nodes unhashed until `_commit` applies the
  encoding rules bottom-up. It used to re-root both tries on every single
  mutation — correct, and unusably slow at 443 MB and 65 seconds for one 30M-gas
  transaction against a 15-second block time
  ([`robustness-review.md`](robustness-review.md) §1). The same transaction
  measures 5.2 s and 9.2 MiB now. The STORAGE root is still materialised per
  write, which is about a third of what is left.
- **An EVM failure is a *returned* `{ exception }`, never a throw.** A thrown JS
  error is an internal bug, and if internal bugs could satisfy a vector, the
  vectors that assert *failure* would be the easiest ones to fake.

**Scalar canonicality lives in the decoders, not in RLP.** RLP is untyped, so it
cannot know that a `nonce` is a number and must carry no leading zero byte. The
yellow paper requires minimal-length scalars, and two encodings of one number hash
differently — a chain split with no error message anywhere. So
`chain/transaction.js` rejects a leading-zero `nonce`, `gasPrice`, `gasLimit`,
`value`, `v`, `r` or `s`, and the account decoder does the same for `nonce` and
`balance`.

---

## 4. Consensus

### What is unchanged

- **PoW: Homefire** ([`mining.md`](mining.md)) — memory-hard, CPU-oriented. The
  proof must be signed by the key its coinbase pays, which stops work being
  redirected but does **not** make the puzzle non-outsourceable.
- **Block time 15 s**, retargeted **every block** by a 60-block LWMA over a
  continuous 256-bit target. The expected target is recomputed and compared
  exactly, including on the fork path, so the retarget rule *is* consensus.
- **Emission**: a deterministic integer schedule, 6 EMBER at genesis, 2-year
  half-life, perpetual 0.3 EMBER tail, 10% to the Commons
  ([`tokenomics.md`](tokenomics.md)).
- **Fork choice**: heaviest cumulative work, **no depth limit**, no checkpointing,
  no finality gadget.

### What changes

- **The coinbase key becomes secp256k1**, because the coinbase has to *receive*
  the reward and the fees and so must be an account this chain can credit. The
  hashing itself is untouched ([`decisions.md`](decisions.md) §1.5).
- **The header gains** `txRoot` (a trie root over RLP transactions, not a binary
  merkle root), `stateRoot`, `receiptsRoot`, `logsBloom`, `gasLimit`, `gasUsed`,
  plus the six fields an RPC block response needs and the v1 header cannot supply:
  `difficulty`, `totalDifficulty`, `size`, `extraData`, `nonce`, `mixHash`.
- **`timestamp` must be seconds.** The v1 header stores milliseconds. This is a
  one-word change with a wide blast radius: milliseconds make every explorer
  render the year 57,000 and break every Solidity `deadline` comparison, Uniswap
  V2's router included.
- **Fees go to the coinbase, with no burn in v1.** The UTXO chain's flat 40,000-spark
  burn does not carry over.

**Block size is fixed, not dynamic.** `MAX_BLOCK_BYTES` is 2,000,000 and the block
gas limit is 30,000,000. An earlier version of this page described a
penalty-function-governed dynamic block size; no such mechanism exists.

### Finality, stated plainly

Probabilistic, with **unbounded reorg depth**. A 500-block reorg is not rejected by
the protocol; it is merely expensive — and on a new chain with little hashrate,
"expensive" may mean some cloud CPUs. Confirmation guidance and the reason it is
not sufficient on its own are in
[`exchange-integration.md`](exchange-integration.md) §4.

---

## 5. Privacy — what is and is not true

**There are no stealth addresses and no view keys.** Earlier versions of this page
described both as features of the ledger. Neither is implemented, neither is in
[`evm-spec.md`](evm-spec.md), and an account-model EVM chain has transparent
balances by construction — the same as Ethereum.

What does exist is `node/src/box.js`: X25519 ECDH → HKDF-SHA256 → AES-256-GCM
sealed boxes, used by the on-chain chat application to encrypt *payloads* before
they are signed. That hides message contents. It does not hide that a message
happened, how big it was, which block it is in, or who it was addressed to.

---

## 6. Applications

### Records — and their expiry date

The UTXO transaction body carries an optional `records` array: namespaced,
byte-metered, consensus-committed application data, inside the signed body so it
is covered by the txid, the input signatures, the merkle root and the block hash.
Full reference: [`records.md`](records.md).

**Records are a UTXO construct with no account-model successor.** Nothing in
[`evm-spec.md`](evm-spec.md) carries them forward, because on an EVM chain the
same job is done by contract storage and logs — which is strictly more capable and
which every indexer already understands. `node/src/apps/chat.js` and
`bin/hearth-chat.js` are built on records and have no future in their current
form.

### The DeFi layer

Solidity, in `contracts/`: **WEMBER** (a WETH9 port — native EMBER as an ERC-20,
which every AMM requires), a **Uniswap V2** port (Factory, Pair, Router02), and
**Multicall3**.

V2 rather than V3 deliberately: far simpler, thoroughly audited, thoroughly
understood, and its maths need no concentrated-liquidity tick machinery. V2 needs
`ecrecover` for `permit`, which is why precompile `0x01` is in v1.

`node/test/dex.js` drives the compiled contracts straight through the state
transition — deploy, `createPair`, `addLiquidity`, swap, swap back, `permit`,
`removeLiquidity`. 167/167, a swap at 112,456 gas. **Nothing is deployed to any chain that
outlives the process that mined it** — the contracts deploy to a local
`hearthd --evm` node, and no chain holding them is published.

Two things the AMM depends on that are easy to get silently wrong, both automated:
the **init code hash** (the Router derives pair addresses from a compile-time
constant rather than asking the factory, and a mismatch presents as "the pool has
no reserves" rather than as an error), and **`feeToSetter` being a multisig from
the moment the factory is deployed** — V2 has no timelock and no two-step handover,
and moving it later requires the very key you are trying to stop relying on.

---

## 7. Clients and tools

| | What it is |
| --- | --- |
| **`hearthd`** | The node. Full node + wallet + miner in one process. JavaScript, zero runtime dependencies — including the EVM |
| **`hearth`** | The terminal tool for the EVM chain: `trace` (an opcode-level debugger — gas, stack, memory and storage deltas per step, with call depth and decoded revert reasons), `watch`, `wallet`, `call`, `send`, `deploy`, `devnet` |
| **`hearth-cli`** | The UTXO-era wallet and query client. Deliberately **not** merged with `hearth` — merging them would mean one address format silently accepting the other's |
| **Web explorer** | `web/index.html` + `web/assets/explorer/`. EVM-aware: decoded logs, revert reasons, contract disassembly, ERC-20s, `eth_getLogs` search. ES modules, no framework, no bundler, no npm dependency. **It renders an explicit "no node answered" state rather than inventing data** |
| **Browser wallet** | `web/wallet.html` + `web/assets/wallet/`. secp256k1, `0x…`, 18 decimals, keys sealed at rest with PBKDF2 → AES-256-GCM. Its crypto is a *port* of the node's, and CI runs both over the same random inputs and compares them |
| **Browser miner** | `web/mine.html` + `web/assets/mining/`. A Web Worker pool running real Homefire against `/mining/template`. Not WASM: the bottleneck was `crypto.subtle.digest` being async at ~8,450 hashes per attempt, so the win came from a synchronous SHA-256, not a different language |
| **Developer kit** | `tools/`: a faucet, Hardhat and Foundry templates, and an RPC probe that serves the **real** method surface over a fake chain — so an integrator can prove their wiring before an endpoint exists |
| **Desktop app** *(not built)* | `app-desktop/` is a Tauri shell whose three native commands have zero callers |

**The tracer is not an afterthought.** `node/src/cli/trace.js` was written *during*
the interpreter work, for a selfish reason: when a GeneralStateTests vector fails,
the difference between a good afternoon and a lost week is whether you can see the
exact opcode where our stack diverged from the reference.

**Why a browser can mine at all:** the winner must sign the digest with the key the
coinbase pays, so the page has to hold its own key — which it already does, in the
wallet. The node hands out a candidate built for *your* public key and keeps the
transactions; you return a nonce, a digest and a signature. Your private key never
leaves the page.

---

## 8. Not built — stated once, here

None of the following exists. Do not describe them as features.

| | |
| --- | --- |
| **Consensus on the account model** | The blocker. No account-model block has ever been produced |
| **Tab payment channels** | `rust/hearthd/src/tab.rs` is a signed state machine that nothing calls |
| **A payment SDK / merchant handoff** | `web/pay-demo.html` is a mockup that simulates settlement on a 1,200 ms timer and says so on the control |
| **Stealth addresses, view keys** | §5 |
| **Warmshares / uncles** | Near-miss blocks referenced for a fraction of the reward. Never implemented |
| **A RandomX-class VM** | Homefire compiles nothing. It is chained SHA-256 over a scratchpad |
| **On-chain governance, and any Commons spend path** | The treasury accumulates and cannot pay out |
| **Dynamic block size** | Fixed limits — §4 |
| **A base-fee burn** | Withdrawn. Gas goes to the coinbase, no burn in v1 |
| **Light-client mode, state pruning, snapshot sync** | Out of scope for v1 ([`evm-spec.md`](evm-spec.md) §9) |
| **Bridges** | Every bridge is a liability; not until the chain has proven itself |
| **Reproducible builds** | Claimed in older documents; never implemented |

---

## 9. Tech choices and rationale

| Concern | Choice | Why |
| --- | --- | --- |
| The EVM | **written here, not imported** | No `@ethereumjs/*`, `ethers` or `web3`. Only defensible because Ethereum publishes reference vectors for every part of it — and those vectors are the gate |
| Consensus + EVM language | JavaScript today | `rust/hearthd` remains the stated target ([`why-two-implementations.md`](why-two-implementations.md)), but the entire EVM was written in JS and has no Rust counterpart |
| Ledger | accounts | Everything downstream — MetaMask, ethers, Hardhat, every explorer, every audited contract — assumes it |
| Fork semantics | Shanghai | PUSH0, EIP-3529 refunds, warm coinbase, initcode cap. No blobs, no `MCOPY`/`TSTORE`/`TLOAD` |
| Transactions | legacy (type 0) only | EIP-1559 deferred to v2; wallets fall back to legacy pricing without complaint. Block responses omit `baseFeePerGas` precisely so they do |
| PoW | Homefire, memory-hard | CPU-fair. The bottleneck is memory latency, not gate count |
| AMM | Uniswap V2 | Simpler and more thoroughly audited than V3, and no tick machinery |
| Storage | append-only NDJSON, all state in memory | Adequate at the scale a new chain runs at, and a problem later. There is no pruning and a restart replays everything |
| Web | vanilla ES modules + Web Workers | Zero-install, no framework lock-in, and the explorer stays a directory of files nginx can serve |
| Desktop | Tauri | Small binaries, native performance — scaffolding only |

---

## 10. Related

- [`evm-spec.md`](evm-spec.md) — the authoritative specification
- [`decisions.md`](decisions.md) — settled and open decisions, with reasoning
- [`../MAP.md`](../MAP.md) — the verified inventory, cited to `path:line`
- [`quickstart.md`](quickstart.md) — deploy a contract, every step marked
- [`mining.md`](mining.md) · [`records.md`](records.md) · [`tokenomics.md`](tokenomics.md)
