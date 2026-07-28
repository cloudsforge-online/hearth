# Hearth — application map

What is in this repository, what each part actually does, and what it does not
do. Every claim below was checked against source and cites `path:line`, or is a
command that was run while this file was written. Where this contradicts
`README.md`, `WHITEPAPER.md`, `TESTNET.md` or anything in `docs/`, believe this
file and the line it cites.

The one exception: [`docs/evm-spec.md`](docs/evm-spec.md) is the **contract**
other work is being built against. Where this file describes what exists and the
spec describes what is agreed, they are answering different questions — and where
they conflict about an intention rather than a fact, the spec wins.

**Verified against `92cea4e`.** The previous revision of this file was verified
against `db9b2e3` and had drifted: five suites had grown, the fuzzing suite and
two `tools/` services did not exist yet, and the `npm test` break it reported had
been fixed. What was re-run for this pass, on this machine: `npm test` (27 suites,
also from a fresh clone with no corpus), every unit suite individually,
`test/dex.js`, `test/fuzz/run.js`, the VMTests and GeneralStateTests conformance
gates, the TransactionTests corpus group, and the `tools/` suites.

---

## 1. What this is, in one paragraph

Hearth is a proof-of-work chain **in the middle of replacing its own ledger
model.** The chain that runs today is the original one: a UTXO ledger with
Ed25519 signatures, `ember1…` addresses and 8 decimals. The chain being built is
an **account-model, EVM-executing chain** — `0x…` addresses, secp256k1, 18
decimals, chain id 7411, standard `eth_*` JSON-RPC — keeping Homefire
proof-of-work, the 15-second block time and the emission schedule unchanged.

The EVM is **written here, not imported**: no `@ethereumjs/*`, no `ethers`, no
`web3`. That is only a defensible decision because Ethereum publishes reference
vectors for every part of it, so the rule is that no component is done until its
vectors pass. §4 is the evidence.

**Nothing has produced an account-model block.** Consensus on the new state model
is being built now, so there is no live endpoint, no testnet and no mainnet.

---

## 2. Status — the single table

Do not read a status from anywhere else in this repository without checking it
here first.

| Component | Where | Status |
| --- | --- | --- |
| Keccak-256, RLP, secp256k1, `uint256` | `node/src/crypto/`, `node/src/evm/uint256.js` | ✅ **merged**, published vectors pass |
| Merkle Patricia Trie, StateDB | `node/src/state/` | ✅ **merged**, TrieTests pass |
| EVM interpreter, gas, opcodes | `node/src/evm/` | ✅ **merged**, **609/609 VMTests** |
| Precompiles `0x01`–`0x09` — incl. bn128, blake2f | `node/src/evm/precompiles.js`, `bn128.js`, `blake2f.js` | ✅ **merged**, all nine implemented |
| Transactions, receipts, logs bloom | `node/src/chain/` | ✅ **merged**, **188/188 TransactionTests** *(unverified here — see §4.3)* |
| State transition | `node/src/chain/statetransition.js` | ✅ **merged**, **20,077/20,077 GeneralStateTests** — the last ten fixed by EIP-7610 (`c93a524`) |
| `eth_*` JSON-RPC surface | `node/src/jsonrpc/` | ✅ **merged**, 301 checks — but written against a **fake chain**; nothing mounts it |
| EVM-aware explorer | `web/index.html`, `web/assets/explorer/` | ✅ **merged**, 147 self-test checks |
| Browser wallet on secp256k1 | `web/wallet.html`, `web/assets/wallet/` | ✅ **merged**, 141 cross-check assertions |
| `hearth` CLI + opcode tracer | `node/bin/hearth.js`, `node/src/cli/` | ✅ **merged**, 310 checks |
| AMM contracts (WEMBER, V2 Factory/Pair/Router, Multicall3) | `contracts/` | ✅ **compile**, and **Uniswap V2 runs on our own EVM** — see §4.4 |
| Developer kit (faucet, Hardhat/Foundry templates, RPC probe) | `tools/` | ✅ **merged**, faucet 66 checks |
| Etherscan-compatible `/api` + address index | `tools/explorer-api/` | 🟡 **written, tests failing** — §3.5 |
| Contract verification (`forge verify-contract`-compatible) | `tools/verify/` | ✅ **merged**, 116 checks |
| Property fuzzing | `node/test/fuzz/` | ✅ **merged**, 82,481 checks; two open findings — §4.7, §11 |
| **Consensus on the account model** | — | ⬜ **being built now. No block has ever been produced.** |
| Public testnet, mainnet, any deployed contract | — | ⬜ does not exist |
| The UTXO chain (ledger, P2P, REST, reorg) | `node/src/chain.js`, `tx.js`, `p2p.js`, `rpc.js` | ✅ runs, and **is being retired** |
| `rust/hearthd` | `rust/` | 🟡 a self-check and a benchmark. **Not a node, not consensus** — §3.3 |

**The strongest single fact about this project:** `node/test/dex.js` deploys the
whole Uniswap V2 stack onto our own EVM and executes a real swap — 167/167
checks, a swap at **112,456 gas**. §4.4.

**The most important gap:** phase 5. Every "merged" row above is a component
proved offline against vectors. None of them has ever been driven by a block.

**And a "merged" row is not a "ready" row.** `StateDB` re-roots both tries on
every mutation, which costs **443 MB and 65 seconds for a single 30M-gas
transaction against a 15-second block time**
([`docs/robustness-review.md`](docs/robustness-review.md) §1, measured). Phase 5
is blocked on that, not merely unstarted. §11.

---

## 3. Component inventory

| Directory | What it is | Status |
| --- | --- | --- |
| `node/` | The reference full node, wallet, miner, P2P, REST API — **and the entire EVM implementation.** JavaScript, zero runtime dependencies | **This is the network, and this is the EVM** |
| `contracts/` | WEMBER, a Uniswap V2 port, Multicall3. Solidity, compiled with solc 0.8.26 / shanghai | Compiles in CI; **nothing deployed anywhere** |
| `tools/` | The developer onboarding kit: faucet, Hardhat and Foundry templates, an RPC probe stub | Real and runnable; §3.5 |
| `web/` | EVM-aware block explorer, secp256k1 browser wallet, browser miner, merchant-button mockup | Ships; served by nginx and GitHub Pages |
| `site/` | React + Vite marketing site for hearth.cloudsforge.online | Ships; copy corrected against the code |
| `rust/hearthd/` | A self-check binary and a Homefire benchmark over some library modules | **Not a node. Not consensus.** Two known divergences — §3.3 |
| `proto/` | Two teaching scripts: an emission *model* and a toy PoW miner | Prototype; **the emission model is not the consensus schedule** — §11 |
| `app-desktop/` | Tauri v2 shell | **Unshipped scaffolding.** Its three native commands have zero callers |
| `docs/` | Eighteen documents. [`evm-spec.md`](docs/evm-spec.md) is the authoritative one; [`robustness-review.md`](docs/robustness-review.md) is the measured one; [`testing.md`](docs/testing.md) says what is and is not covered | Prose only |
| `branding/` | Favicon, mark, wordmark, og, social | Complete |

### 3.1 `node/` — the node, and the EVM

One process is a full node, a wallet and a miner (`node/src/node.js:27-41`). The
directory now holds two chains' worth of code, deliberately separated so both can
be tested in isolation during the transition (`docs/evm-spec.md` §5).

**The account-model / EVM side — ~10,900 lines, none of it wired to a chain yet:**

| File | Responsibility | Lines |
| --- | --- | ---: |
| `src/crypto/keccak.js` | Keccak-256 — *not* SHA3-256; different padding | 158 |
| `src/crypto/rlp.js` | RLP encode / decode | 146 |
| `src/crypto/secp256k1.js` | sign / verify / recover, RFC 6979, low-s | 417 |
| `src/evm/uint256.js` | 256-bit arithmetic with wrapping and two's-complement semantics | 170 |
| `src/evm/stack.js` | 1024-deep, 256-bit words | 111 |
| `src/evm/memory.js` | byte-addressed, word-expanded, quadratic gas | 130 |
| `src/evm/opcodes.js` | the instruction table, all 256 entries | 288 |
| `src/evm/gas.js` | Shanghai schedule, memory expansion, EIP-2929 warm/cold | 565 |
| `src/evm/interpreter.js` | execution loop, call frames, depth 1024, revert semantics | 930 |
| `src/evm/precompiles.js` | `0x01`–`0x09`, and the two opposite failure conventions | 430 |
| `src/evm/bn128.js` | alt_bn128 curve, tower field, optimal ate pairing | 743 |
| `src/evm/blake2f.js` | BLAKE2b compression (EIP-152) | 186 |
| `src/state/trie.js` | Merkle Patricia Trie, secure (keccak-keyed) variant | 326 |
| `src/state/statedb.js` | accounts, storage, code, journaling, snapshot/revert | 546 |
| `src/chain/transaction.js` | legacy (type 0) tx: encode, decode, hash, sign, recover | 396 |
| `src/chain/receipt.js` | `[status, cumulativeGasUsed, logsBloom, logs]` | 182 |
| `src/chain/bloom.js` | the 2048-bit logs bloom | 148 |
| `src/chain/statetransition.js` | apply a transaction, produce a receipt; a block's worth in order | 503 |
| `src/jsonrpc/hex.js` | the QUANTITY/DATA codec, and the RPC error type | 272 |
| `src/jsonrpc/methods.js` | the `eth_*` method surface | 823 |
| `src/jsonrpc/server.js` | JSON-RPC 2.0 dispatch: batches, notifications, error mapping | 212 |
| `src/cli/trace.js` | the opcode-level tracer — the reason `hearth` exists | 878 |
| `src/cli/abi.js` | ABI encode/decode, selectors, event and revert decoding | 578 |
| `src/cli/{contract,wallet,watch,keystore,devnet,ui,client,args}.js` | the rest of the CLI | 1,490 |
| `bin/hearth.js` | the `hearth` entrypoint; commands load lazily | 94 |

**The UTXO-era side — the chain that actually runs:**

| File | Responsibility |
| --- | --- |
| `src/params.js` | Every consensus constant, and the emission function |
| `src/crypto.js` | Canonical JSON, SHA-256, Ed25519, `ember1…` addresses, merkle root |
| `src/tx.js` | Transaction body, txid, signing, validation, UTXO application |
| `src/block.js` | Header core, block id, `verifyPow` |
| `src/pow.js` | Homefire |
| `src/chain.js` | Storage, indexes, difficulty, validation, fork choice, reorg |
| `src/mempool.js` | Fee-ordered pending transactions, byte-capped |
| `src/miner.js` | Solo miner with a duty-cycle throttle; also builds remote candidates |
| `src/mining.js` | Template issue/submit for miners outside the process |
| `src/p2p.js` | TCP gossip, locator sync, per-peer verification budget |
| `src/rpc.js` | HTTP REST + a legacy `POST /rpc` + SSE |
| `src/wallet.js` | Local keys, coin selection, tx building |
| `src/box.js` | X25519 → HKDF → AES-256-GCM sealed boxes |
| `src/apps/chat.js` | An application built entirely out of records + sealed boxes |
| `bin/hearthd.js` | Node entrypoint — **`--evm` selects the account-model chain instead**, see §2.1.1 |
| `bin/hearth-cli.js` | Wallet/query CLI |
| `bin/hearth-chat.js` | Encrypted chat CLI |

`bin/hearth.js` and `bin/hearth-cli.js` are **two tools for two chains** and are
deliberately not merged — merging them would mean one address format silently
accepting the other's addresses (`node/bin/hearth.js:19-22`).

### 2.1.1 The account-model chain (`hearthd --evm`)

A **second, separate chain** lives in the same package: 0x addresses, secp256k1,
an EVM, Shanghai semantics and the `eth_*` JSON-RPC surface
(`docs/evm-spec.md`). It shares **no consensus code** with the UTXO chain — a
different state model, different addresses, a different genesis — and the two
will not talk to each other. `--evm` chooses; the UTXO chain is still the
default because the browser wallet, the browser miner and Forge Pay are written
against it.

| File | Responsibility |
|---|---|
| `src/chain/header.js` | Header v2, block RLP, the block id, `verifyPow` |
| `src/chain/genesis.js` | The `hearth-genesis/1` file, the alloc, block 0 |
| `src/chain/blockchain.js` | Storage, validation, fork choice, reorganisation |
| `src/chain/mempool.js` | Per-sender nonce ladders, priced between senders |
| `src/chain/miner.js` | Block production, and `/mining/template` for remote miners |
| `src/chain/rpcadapter.js` | The chain interface `src/jsonrpc/methods.js` documents |
| `src/evmnode.js` | Wires it together and serves both HTTP surfaces |
| `src/chain/{statetransition,transaction,receipt,bloom}.js` | Phase 4; unchanged here |

What differs from §3, and each difference is consensus:

- **There is no coinbase transaction.** The reward is credited straight to the
  coinbase account after the last transaction, so **an empty block is normal**
  (`blockchain.js` `_creditReward`). The UTXO shape check requires a first
  transaction, which is why `p2p.js` now takes its block shape from the node
  (`UTXO_WIRE` there is the default).
- **`coinbasePub` is a 65-byte secp256k1 key** and `powSig` is a 65-byte
  secp256k1 signature over the digest. Homefire itself is untouched — the same
  `powSeed(coreHash, nonce, coinbasePubHex)`, the same pad, the same walk.
- **Header timestamps are seconds**, enforced rather than assumed: a value past
  `MAX_TIMESTAMP` (≈ year 5138) is refused, which every millisecond value
  exceeds.
- **Fork choice is cumulative difficulty**, `Σ 2^256/(target+1)`, stored per
  block rather than recomputed. Ties keep the incumbent.
- **State is content-addressed**, so switching branches is opening a StateDB at
  another root rather than replaying from genesis, and every historical state is
  readable. Nothing is pruned.
- **18 decimals.** `subsidyWei(h)` is `subsidy(h) × 1e10` exactly, so the
  emission curve is the same one in EMBER terms (`params.js`).
- **The Commons share defaults to the zero address**, i.e. burned, because a 0x
  Commons address has not been chosen. It is a genesis field.

Two HTTP surfaces: **port 8545 path `/`** is Ethereum JSON-RPC 2.0, and port
8645 is a small REST API (`/info`, `/supply`, `/mempool`, `/mining/*`,
`/events`). They are separate servers precisely because `rpc.js:152` owns
`POST /rpc` with a different protocol.

Tested by `node/test/evmchain.js` (consensus, 157 checks), `node/test/evm-rpc.js`
(the `eth_*` surface over real HTTP, 104) and `node/test/evm-p2p-fork.js` (two
real nodes, partition, reorg, 33).

Published to npm as `@cloudsforge/hearth-node`, currently **0.2.0**
(`node/package.json:3`), exporting `.`, `./crypto`, `./chain`, `./tx`, `./wallet`
and `./params` (`node/package.json:12-21`) — **all six are UTXO-era modules.**
None of `crypto/`, `state/`, `evm/`, `chain/` or `jsonrpc/` is exported. See §11
for the version skew this creates.

### 3.2 `contracts/` — the AMM, compiled and never deployed

WEMBER (a WETH9 port), a Uniswap V2 port (`HearthV2Factory`, `HearthV2Pair`,
`HearthV2Router02`, `HearthV2ERC20`, the libraries) and `Multicall3.sol`.

Built with solc 0.8.26+commit.8a97fa7a, `evmVersion: shanghai`, optimizer at
999,999 runs, `metadata.bytecodeHash: none`. Run
`pnpm --dir contracts install && pnpm --dir contracts compile`; it prints

```
INIT_CODE_HASH = 0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537
```

which is the number whose silent drift breaks a V2 fork — the Router derives pair
addresses from that constant rather than asking the factory, so a mismatch sends
it looking for pools at addresses where nothing exists, and a call to a codeless
address *succeeds and returns empty*. `compile.mjs` refuses to build on mismatch
and CI runs it (`.github/workflows/ci.yml:159-163`).

`Multicall3.sol` is **not** the canonical bytecode and deploying it would not
produce the canonical address. That is an open decision — see
[`docs/decisions.md`](docs/decisions.md) §2.2.

### 3.3 `rust/hearthd/` — a self-check and a benchmark, NOT consensus

**Do not read this crate as a second opinion about what a valid block is.** It has
no block type, no chain, no fork choice, no storage, no RPC and no P2P server;
`main.rs` runs a self-check over the library modules and then benchmarks Homefire
against a stand-in header literal (`rust/hearthd/src/main.rs:28-102`, `:122`).
Nothing in the directory has ever accepted a block, because there is nothing there
to accept one into.

Two modules would produce the **wrong answer** if wired up:

1. **`pow.rs` omits the coinbase public key from the seed.** Consensus binds
   `(headerCoreHash, nonce, coinbasePubHex)` (`node/src/pow.js:45-47`); the Rust
   `homefire()` hashes whatever seed bytes it is handed, and the binary only ever
   hands it `header || nonce_le` (`rust/hearthd/src/pow.rs:31`,
   `main.rs:127-130`). Same header, different digest.
2. **`difficulty.rs` retargets ±1 leading-zero bit per block** — a factor of two
   per step, ignoring the magnitude of the miss
   (`rust/hearthd/src/difficulty.rs:47-53`). Consensus retargets a continuous
   256-bit target with a 60-block LWMA (`node/src/chain.js:212-235`).

The crate's own header comments say all of this (`main.rs:3-20`, `pow.rs:7-15`,
`difficulty.rs:7-17`, `rust/README.md:1-17`). What it does have that is real: a
pure-`std` SHA-256 tested against FIPS vectors, an emission schedule that matches
consensus, and unwired libraries for the ledger, mempool, P2P framing and Tab
payment channels (`src/lib.rs:15-22`). CI builds it under
`cargo clippy -- -D warnings` and runs its tests — **a green Rust job says nothing
about consensus.**

**And it is now further behind than that.** Everything in §3.1's first table — the
whole EVM — was written in JavaScript with no Rust counterpart, and the crate is
still Ed25519 and UTXO-shaped. [`docs/why-two-implementations.md`](docs/why-two-implementations.md)
describes Rust as the target implementation; nothing in this tree contradicts that
as an *intention*, but no work has been done toward it since the EVM began.

### 3.4 `web/` — explorer, wallet, miner, merchant mockup

Static pages, no build step, served by nginx (`web/nginx.conf`) or published to
GitHub Pages (`.github/workflows/pages.yml`).

| Page | What it is |
| --- | --- |
| `web/index.html` + `web/assets/explorer/*.js` | Block explorer for the **account-model EVM chain**, written against the `eth_*` contract. Blocks, transactions with decoded logs and revert reasons, EOA-vs-contract addresses with disassembly, ERC-20 tokens, `eth_getLogs` search, a `/supply` view. Hash-routed, zero dependencies. §3.4.1 |
| `web/wallet.html` + `web/assets/wallet/*.js` | Non-custodial **secp256k1** wallet — generate, unlock, read balances, build/sign/broadcast legacy transactions at 18 decimals. §9.1 |
| `web/mine.html` + `web/assets/mining/*.js` | Browser miner over `/mining/template` and `/mining/submit`. §9.2 |
| `web/pay-demo.html` | Merchant-button **mockup** — see §10 |
| `web/explorer.html` | 0-second redirect to `./`, kept so old links land |

Node URL resolution is split by protocol, because the pages no longer all speak
one. The miner's `/mining/*` calls and the pay mockup resolve `?rpc=` →
`<meta name="hearth-rpc">` → same-origin `/rpc` → `:8645` (`web/assets/api.js:20-27`)
and speak the REST API. The explorer and the wallet speak `eth_*` JSON-RPC and
resolve `?rpc=` → `<meta name="hearth-eth-rpc">` → same-origin `/rpc/` → `:8545`
(`web/assets/explorer/rpc.js:37-43`). nginx proxies same-origin `/rpc/`
(`web/nginx.conf:63`).

**The `:8545` default is now correct rather than a guess** —
[`docs/evm-spec.md`](docs/evm-spec.md) §6 settles the Ethereum RPC on port 8545 at
the root path, with the REST API staying on 8645. What has *not* happened is
anything mounting it: `node/src/jsonrpc/server.js` is never constructed by
`node/src/node.js` or anything in `node/bin/`. The explorer therefore has nothing
to talk to, and says so rather than inventing data.

#### 3.4.1 The explorer

`web/index.html` is a shell; every view is an ES module under
`web/assets/explorer/`, loaded with `<script type="module">`. No framework, no
bundler, no npm dependency — deliberately, so it stays a directory of files nginx
can serve.

| Module | Responsibility |
| --- | --- |
| `app.js` | Hash router, boot, the search box |
| `rpc.js` | JSON-RPC 2.0 client; batches matched by id; three distinct failure types |
| `views.js` | One function per view |
| `chaindata.js` | Multi-call queries and caches; the bounded address scan |
| `abi.js` | Event/selector hashing, log decoding, revert decoding |
| `disasm.js` | EVM disassembly; a transcription of `node/src/evm/opcodes.js` |
| `keccak.js` | Keccak-256 — EIP-55 checksums, code hashes, signature hashing |
| `emission.js` | A port of `node/src/params.js:140-151`, for the supply figure |
| `format.js`, `dom.js`, `search.js` | Pure formatting, DOM builders, query dispatch |
| `fixtures.js` | A canned chain answering the same wire protocol; opt-in with `?fixtures=1` |
| `selftest.js` | **147 checks**, runnable as `node web/assets/explorer/selftest.js` |

**It does not invent data.** The old page fell back to a sample-data generator
when no node answered; this one renders an explicit "no node answered" state
naming the endpoint and the failure, and offers the fixture chain as an opt-in
link. Fixtures are never engaged automatically and are labelled in the mode pill,
in a banner, and on every page.

`selftest.js` cross-checks the three modules that are *copies* of something in
`node/src` — `keccak.js`, `disasm.js` against all 256 opcode entries, and
`emission.js` — so the copies cannot drift silently. CI runs it
(`.github/workflows/ci.yml:92-93`).

### 3.5 `tools/` — the developer kit

Real, runnable, and the reason a stranger can get to a deploy without asking.

| Path | What it is |
| --- | --- |
| `tools/rpc-probe/stub.js` | Serves `node/src/jsonrpc/` — the **real** method surface and hex codec — over a chain with no state that executes nothing. Logs every method a client calls, *including the ones Hearth does not implement*, which is the point of it |
| `tools/faucet/` | A faucet service whose entire engineering problem is refusing: per-address and per-IP limits, a global payout cap, and an atomic check-and-record. **66 checks**, over real HTTP against a stub node, no dependencies |
| `tools/hardhat/` | A working Hardhat template — `evmVersion: 'shanghai'` pinned, plus `check-network.js`, `deploy.js`, `deploy-dex.js`, `swap.js`, `interact.js` |
| `tools/foundry/` | A working Foundry template; `--legacy` is required on every broadcasting command and the README says why |
| `tools/explorer-api/` | The **Etherscan-compatible `/api`** and the address index behind it — `account`, `contract`, `stats`, `transaction`, `logs` and `proxy`, plus `GET /supply/total`. Zero dependencies. **Its test suite currently fails** — see below |
| `tools/verify/` | Contract verification, including the API `forge verify-contract` speaks. **116/116 checks**, run |
| `tools/metamask.md` | The add-network page |

**`tools/explorer-api`'s tests do not pass**, locally or in CI
(`node test/explorer-api.test.js`, and the *Developer kit* job on run
[30402531669](https://github.com/cloudsforge-online/hearth/actions/runs/30402531669)):

```
RpcError: receipt for 0x47d3…aef2: internal error: receipt.logs[0].logIndex is
missing — the chain must number logs across the block, and this layer cannot
derive it from one receipt
```

The shim requires `logIndex` to be numbered across the whole block, and the test's
fake chain does not supply it. Whether the defect is in the fake or in the shim's
expectation is **not established here** — this file does not edit source. Read the
shim as *written and not yet passing*, not as *done*.

CI parses the templates and boots the probe, asserting `eth_chainId` is `0x1cf3`
and `net_version` is `"7411"` — the same number in two encodings, which is the one
mistake that makes MetaMask refuse a network outright
(`.github/workflows/ci.yml:184-200`).

### 3.6 `site/` — marketing

React + Vite. All copy is centralised in `site/src/lib/hearth.ts`, which carries
inline notes recording exactly which claims were corrected and why
(`site/src/lib/hearth.ts:114-124`). It says Homefire is memory-hard and that *work
handed to a hasher cannot be redirected*, and explicitly declines to claim
non-outsourceability (`:128-133`). **It has not been updated for the account
model** and still describes the UTXO chain's user-facing story.

### 3.7 `app-desktop/` — unshipped

A Tauri v2 shell whose `frontendDist` is `../../web` and which opens `wallet.html`
in a native window (`app-desktop/src-tauri/tauri.conf.json:6-18`). Its three native
commands `start_node`, `stop_node` and `node_running` are registered
(`src-tauri/src/main.rs:91`) and have **zero callers** — the bundled pages are
plain static HTML that never call `invoke`. `node_entry()` resolves
`../../node/bin/hearthd.js` relative to the process CWD, which for an app launched
from Finder is never a checkout (`src-tauri/src/main.rs:27-39`). The file documents
its own brokenness at `:4-18`. A restrictive CSP *is* configured
(`tauri.conf.json:21`).

### 3.8 `proto/` — teaching artifacts, and one trap

`proto/pow.js` + `proto/mine.js` are a minimal model of memory-hardness and of the
signature-binding property; `proto/pow.js:19-25` states plainly that this is not
non-outsourceability.

`proto/emission.js` is run in CI as a sanity check
(`.github/workflows/ci.yml:50-51`) — but **it is a smooth exponential model, not
the integer schedule consensus runs**, and its numbers differ from the chain's by
about 3.5% in year one. See §11.

---

## 4. The EVM, and what proves it

This is the part of the repository that is easiest to claim and hardest to
believe, so this section is only things that were run.

### 4.1 The rule

Every component ships against published vectors and no component is done until
they pass. An implementation signals EVM failure by **returning** `{ exception }`,
never by throwing — a thrown JS error is a harness `ERROR`, not a pass. Without
that rule a `TypeError` in the interpreter masquerades as a correctly-rejected
transaction, which makes the vectors that assert *failure* the easiest ones to
fake (`docs/evm-spec.md` §0).

### 4.2 The unit suites — run, and their exact counts

Every one of these was executed while writing this file
(`cd node && node test/<name>.js`):

| Suite | Result |
| --- | --- |
| `keccak` | 52/52 |
| `rlp` | 149/149 |
| `uint256` | 162/162 |
| `secp256k1` | 179/179 |
| `opcodes` | 81/81 |
| `gas` | 205/205 |
| `precompiles` | 119/119 |
| `bn128` | 81/81 (1 skipped without the corpus) |
| `blake2f` | 43/43 offline; **46/46 with the corpus fetched** — see §12 |
| `trie` | 302/302 |
| `statedb` | 166/166 |
| `transaction` | 167/167 |
| `receipt` | 62/62 |
| `bloom` | 61/61 |
| `interpreter` | 182/182 |
| `statetransition` | 133/133 |
| `cli` | 310/310 |
| `jsonrpc` | **301/301** |
| `conformance --selftest` | 85/85 |
| `fuzz --cases=2000` | **82,481/82,481**, with 3 standing observations — §4.7 |
| `unit` / `e2e` / `records` | 32/32 · 24/24 · 49/49 |
| `browser-pow` / `keystore` / `mining-api` / `p2p-fork` | 10/10 · 19/19 · 24/24 · 25/25 |

### 4.3 The reference corpus

The full corpus is **gitignored** and fetched by `node/scripts/fetch-vectors.sh`
(3,425+ files, ~350 MB). The committed `fixtures/` subset — 121 vectors — is what
runs offline.

| Suite | Result | How |
| --- | --- | --- |
| **VMTests** | **609/609 vectors, 2121/2121 checks** — verified | `node test/conformance/runner.js --impl=test/interpreter.js --dir=test/conformance/vectors/VMTests --no-gas` |
| **GeneralStateTests** | **20,077 / 20,077**, 60,231 checks — verified, re-run for this pass (2,002 s) | `node test/conformance/runner.js --impl=test/statetransition.js --suite=GeneralStateTests --dir=test/conformance/vectors` |
| **TransactionTests** | **188/188** — verified. `188/188 corpus cases, 22 typed (EIP-2718) skipped, 2 with no Shanghai result` | `node test/transaction.js`, group *TransactionTests — full corpus* |
| RLPTests / TrieTests | pass, inside `test/rlp.js` and `test/trie.js` — 55 and 25 vectors respectively, by the loader's count. Neither suite reports a separate vector total on stdout, so quote the suite's own check count (149/149, 302/302) rather than a vector count | |

**The ten GeneralStateTests failures are fixed.** Earlier revisions of this file
named them individually, because they sat in four different directories and a
reader looking for one directory would not find them:

```
stCreate2/RevertInCreateInInitCreate2Paris.json        d0g0v0
stCreate2/create2collisionStorageParis.json            d0g0v0, d1g0v0, d2g0v0
stExtCodeHash/dynamicAccountOverwriteEmpty_Paris.json  d0g0v0
stRevertTest/RevertInCreateInInit_Paris.json           d0g0v0
stSStoreTest/InitCollisionParis.json                   d0g0v0, d1g0v0, d2g0v0, d3g0v0
```

They were one family, and the rule was **EIP-7610**. EIP-684 makes an address
occupied if it carries a nonce *or* code; EIP-7610 adds a third arm — a non-empty
**storage root** — and geth has applied all three unconditionally since 1.13. So
`CREATE` onto an address holding storage is a collision that consumes the entire
gas limit and leaves the storage exactly where it is. We had been treating it as
the legal reset EIP-684 reads like, wiping the slots and diverging on the state
root. Balance is deliberately *not* a fourth arm: anyone may send to an address
before a contract lands there, so making that brick the address would be a
griefing vector. Fixed in `3cc7e70` / `c93a524` (`node/src/evm/interpreter.js`,
`node/src/state/statedb.js`).

**Re-run for this pass**, on the full corpus:
`PASS — 60231/60231 checks (20077 vectors passed, 0 failed, 14510 skipped, 2002137ms)`.
The 14,510 skips are non-Shanghai fork sections, which is expected — the runner
scores the Shanghai section of each fixture.

`--no-gas` on VMTests is not a concession. `legacytests/Constantinople/VMTests` is
Constantinople *semantics* at Frontier *prices*: running the 609 with gas checking
produces 434 divergences that decompose exactly into EIP-2929, EIP-160 and EIP-150
with nothing left over (`node/test/interpreter.js:12-21`). Gas conformance comes
from GeneralStateTests.

**A harness quirk worth knowing.** `--suite=VMTests --dir=test/conformance/vectors`
— the invocation `node/test/conformance/README.md` documents — now also sweeps in
the `TransactionTests` the fetch script added, classifies them as VMTests, and
reports `FAIL — 609 vectors passed, 169 failed`. Scoping the run to
`--dir=…/vectors/VMTests` gives a clean `PASS`. The implementation is fine; the
suite inference is not. Flagged, not fixed — this file does not edit source.

### 4.4 Uniswap V2 runs on our own EVM

`node/test/dex.js` drives the compiled contracts straight through
`node/src/chain/statetransition.js` against a fresh `StateDB` — real signed legacy
transactions, RLP-encoded, sender-recovered, applied in `applyBlock` batches that
stand in for blocks because phase 5 has no consensus yet. Deploy, `pairCodeHash`,
`createPair`, `addLiquidity`, swap, swap back, `permit`, `removeLiquidity`.

Run while writing this file (`pnpm --dir contracts compile && node test/dex.js`):

```
PASS — 167/167 DEX checks
  swapExactTokensForTokens        112456   mainnet ~150000   -25%
  swapExactTokensForETH           109892   mainnet ~170000   -35%
```

The init code hash was verified before any liquidity moved: the Router's constant,
`keccak256` of the compiled pair creation code, and the factory's own
`pairCodeHash()` all agree, and the pair landed at exactly the CREATE2 address
`pairFor` derives.

Two things recorded rather than glossed, both from the suite's own header:

- **Uniswap V2 contains no `DELEGATECALL`.** Every library is `internal`, so solc
  inlines it, and a disassembly of all five deployed contracts finds only `CALL`,
  `STATICCALL` and `CREATE2`. **This run says nothing about `DELEGATECALL`**,
  which still rests on the conformance vectors alone.
- **`ecrecover`'s low-s permissiveness is now proven against real audited code.**
  `permit` is exercised with a high-s reflection that EIP-2 would reject and the
  precompile must not — which is the exact opposite of the rule
  `node/src/chain/transaction.js` enforces on transaction signatures.

`node/test/dex.js` is **not in `npm test`**: that suite runs with zero installed
dependencies and this one needs solc's output.

### 4.5 The two opcodes that had to be decided

`PREVRANDAO` (`0x44`) returns the parent block's Homefire digest and is
**miner-influenceable** (`node/src/evm/interpreter.js:211-214`, `:568`).
`BASEFEE` (`0x48`) pushes zero (`:215-216`). Both, with the reasoning, are in
[`docs/decisions.md`](docs/decisions.md) §1.1 and §1.2.

### 4.6 The JSON-RPC layer, and exactly what it is

`node/src/jsonrpc/` implements the v1 method set of `docs/evm-spec.md` §6 and
passes 301 checks. **It is written against an interface, not a chain.** The header
of `node/src/jsonrpc/methods.js:1-20` is explicit: *"The chain does not exist yet,
so this layer is written against the interface below and tested against an
in-memory fake (test/jsonrpc.js). Phase 5 implements exactly this."*

So "the `eth_*` surface is built" means: the method table, the QUANTITY/DATA codec,
the JSON-RPC 2.0 transport, the error mapping and the block/receipt shapes are
built and tested. What is not built is anything to serve them from.

### 4.7 Property fuzzing, and the two defects it found

`node/test/fuzz/` feeds random bytes to `uint256`, the trie, RLP, transactions and
the interpreter. Every vector in §4.3 is *well-formed input somebody intended to
work*; this is the first thing in the tree that is not. It runs inside `npm test`
as the deterministic pass (fixed seed) and reports **82,481/82,481 checks** at
`--cases=2000`, with a `--time=N` soak mode for new ground.

**It reports and does not patch** — nothing under `test/fuzz/` modifies `src/`.
Each finding is printed as a standing `!` observation on every run, and each is
written so the check goes red the day it is fixed.

Two defects it found in merged code, and their current state:

| Finding | State |
| --- | --- |
| **`intrinsicGas` counted hex characters as bytes** — `isNormalized` sniffed only `nonce`, so a wallet draft with a `0x…` string `data` was overcharged 192 gas on a 10-byte payload | **Fixed** (`a670a8a`), found by the browser wallet's cross-check |
| **`isNormalized` still sniffed two fields of three** — `to: ''` means creation, so a draft using it was under-quoted 32,002 gas and skipped EIP-3860's initcode cap entirely | **Fixed** (`521ecd5`) — `to` is now checked |
| **`RLP.decode` has no nesting cap** | **Open.** §11 |
| **`isNormalized` is still not a complete test** | **Open, and narrower than it was.** §11 |

The `--cases=2000` run reports 3 standing observations and 207 hits on pinned
known bugs; the pin text still describes the pre-`521ecd5` `to` case, so it
overstates what remains. What actually remains is measured in §11.

---

## 5. Consensus rules — the UTXO chain that runs today

All constants live in `node/src/params.js`; enforcement is on the accept path in
`node/src/chain.js` and `node/src/tx.js`. **This is the chain being retired**, and
it is documented because it is the only chain that has ever produced a block.

### 5.1 Block validation

`Chain._validate` (`chain.js:254-318`) runs checks in a deliberate order — cheap
comparisons, then the proof, then serialization, then signature work — so that
everything an anonymous peer can make the node do is gated behind a proof it had
to pay for (`chain.js:238-253`).

| Rule | Where |
| --- | --- |
| height = parent + 1 | `chain.js:256` |
| non-empty, ≤ `MAX_BLOCK_TXS` (5,000) | `chain.js:257-258`, `params.js:85` |
| timestamp ≤ now + `MAX_FUTURE_DRIFT_S` (7200s) | `chain.js:262`, `params.js:96` |
| timestamp > median-time-past over 11 blocks | `chain.js:263`, `params.js:97` |
| `header.target` equals the recomputed LWMA target | `chain.js:265` |
| Homefire proof verifies | `chain.js:267-268` → `block.js:39-57` |
| canonical bytes ≤ `MAX_BLOCK_BYTES` (2 MB) | `chain.js:273-274`, `params.js:94` |
| tx 0 is a coinbase with no inputs and **no records** | `chain.js:281-287` |
| no second coinbase | `chain.js:289` |
| every other tx passes `validateNormal` against a scratch UTXO | `chain.js:290-292` |
| coinbase has 1–2 outputs, each integer, ≥ 0, ≤ `MAX_MONEY` | `chain.js:299-303` |
| miner output = subsidy − commons + tips, **exactly** | `chain.js:304-309` |
| commons output present and exact | `chain.js:310-313` |
| total minted = subsidy + tips, exactly (**anti-inflation**) | `chain.js:314-315` |

A coinbase may not carry application records, because a coinbase is signed by
nobody and a record in one would be an unauthenticated write the miner alone
chooses (`chain.js:284-286`).

### 5.2 Transaction validation

`TX.validateNormal` (`tx.js:121-156`): ≥1 input and output and ≤1,000 of each; the
record shape/size rules; size ≤ `MAX_TX_BYTES`; **double-spend within the
transaction** (a repeated `txid:vout`) and **against the set**; the input's public
key must hash to the output's address; an Ed25519 signature over the canonical
body, which excludes the signatures themselves; **coinbase maturity** (10 in this
tree, against a production ~100); positive integer outputs ≤ `MAX_MONEY`;
`fee = inputs − outputs ≥ base fee + data fee`; and `tx.id` equal to the recomputed
txid.

The signed body includes `net: P.NETWORK` (`tx.js:39`), so a signature from one
network cannot be replayed onto another. **The account model has no equivalent
field** — EIP-155's chain id replaces it, which is exactly why the testnet needed
its own id (`docs/evm-spec.md` §1, [`docs/decisions.md`](docs/decisions.md) §1.9).

### 5.3 Difficulty — LWMA, and `MIN_TARGET`

`Chain._nextTarget` (`chain.js:212-235`) is branch-aware: it walks back from a
given parent, takes up to `LWMA_WINDOW` = 60 solve times, clamps each solve to
`[1, 6 × TARGET_BLOCK_TIME]`, takes a linearly-weighted average, scales the
arithmetic mean of the window's targets by `avgSolve / TARGET_BLOCK_TIME`, and
clamps into `[MIN_TARGET, MAX_TARGET]`. Because the expected target is recomputed
per block and compared exactly (`chain.js:265`, and again on the fork path at
`:349`), **the retarget rule *is* consensus.**

`MIN_TARGET` is the difficulty **ceiling** — the hardest the chain may get. It was
~2⁻²⁰, which capped a block at ~1.1M attempts and therefore bound at roughly
300–500 cores, after which the clamp fires, blocks arrive faster than 15s, and
emission permanently accelerates because the schedule is indexed by height and not
by time. It is now `0000000000000000ffff…` — 2⁻⁶⁴, ~1.8×10¹⁹ attempts per block
(`params.js:57-80`). `node/test/unit.js:105-113` pins the property rather than the
literal: work-per-block must exceed 2⁴⁰.

**This was a hard chain break with no migration.** Any data directory holding a
block whose target was clamped at the old ceiling now fails to load, and nodes on
either side reject each other with `wrong difficulty target`. The parameter comment
prescribes `docker compose down -v` (`params.js:71-79`).

### 5.4 Addresses, hashing and records

An address is `ember1` + 40 hex of `sha256(pubkey_der)` + 6 hex of checksum
(`crypto.js:58-62`). Canonical JSON sorts object keys recursively, so every hash is
stable (`crypto.js:8-13`).

Records are the only consensus-committed place for application bytes; they live
*inside* the signed transaction body. Bounds, all consensus (`tx.js:59-78`,
`params.js:41-47`): ≤16 records per tx, ≤4,096 payload bytes per record, ≤8,192
across a tx, `app` matching `/^[a-z][a-z0-9-]{1,15}$/`, `key` matching
`/^[0-9a-z._-]{1,72}$/`, `data` an even-length lowercase hex string. Full reference:
[`docs/records.md`](docs/records.md).

The critical serialization detail: **`records` is omitted from the body when
empty** (`tx.js:47-49`). That is what keeps every pre-records transaction hashing to
the same id, and it is the root of the cross-repo skew in §11.

**Records are a UTXO construct and have no account-model equivalent.** Nothing in
`docs/evm-spec.md` carries them forward; on an EVM chain the same job is done by
contract storage and logs. `node/src/apps/chat.js` therefore has no future in its
current form, and nothing says so anywhere else.

---

## 6. Homefire — what it actually is

```
pad   = 64 KiB (8,192 × 8-byte words)              params.js:51, pow.js:26
fill  : cur = SHA256(seed); repeat 8,192×: cur = SHA256(cur); take cur[0..8] into pad
walk  : acc = SHA256(seed ‖ pad[0..64])
        repeat 256×:  idx = acc.readUInt32LE(0) % 8192
                      acc = SHA256(acc ‖ pad[idx*8 .. idx*8+8])
                      pad[idx] ^= acc[0..8]          ← read-write, not read-only
out   = SHA256(acc ‖ pad[last 64 bytes])
```
(`node/src/pow.js:29-42`; walk-step count at `params.js:52`.)

One attempt is roughly 8,450 sequential SHA-256 compressions and touches the whole
pad. Dev sizes are 64 KiB / 256 steps; the comment records intended production
sizes of ~2 GiB and 2048+ steps (`params.js:50-52`).

**The properties this has:** memory-hard (every attempt must fill and then randomly
read *and rewrite* a scratchpad, so the walk is unskippable); CPU-friendly and
ASIC-resistant (the bottleneck is commodity memory latency, not gate count); and
**work handed to a hasher cannot be redirected** — the winning digest must be signed
by the coinbase key, and `verifyPow` requires the coinbase's first output to pay the
address derived from that key (`node/src/block.js:39-51`).

**The property it does NOT have — non-outsourceability.** `powSeed` binds
`(headerCoreHash, nonce, coinbasePubHex)` — only the coinbase **public** key
(`pow.js:45-47`). The private key is used exactly once, *after* a nonce has already
won, to sign the digest (`node/src/miner.js:115`). So a pool operator can distribute
`coreHash` together with its own pubkey, collect `(nonce, digest)` pairs from hashers
who genuinely cannot steal the reward, and sign the blocks itself. Making that
impossible requires the private key inside the hash loop, which forks the chain and
breaks the CI-conformance-tested browser miner — so it is a recorded open decision,
not an oversight (`pow.js:8-15`).

Homefire also **compiles nothing**. It is chained SHA-256 over a pad. Any
description of it as "RandomX-class" is wrong.

**What the account model changes, and what it does not.** `coinbasePub` becomes a
secp256k1 public key and the block signature becomes a secp256k1 signature, because
the coinbase has to *receive* the reward and the fees and so must be an account this
chain can credit. **The pad fill, the walk, the digest, LWMA and everything in
`pow.js` are untouched** (`docs/evm-spec.md` §4). The browser miner has already
moved; the node side has not — §9.2.

---

## 7. REST API surface (`node/src/rpc.js`)

HTTP on `DEFAULT_RPC_PORT` 8645 (`params.js:130`). CORS is `*` on every response
(`rpc.js:19-25`). There is no authentication of any kind. **This surface belongs to
the UTXO chain**; the Ethereum JSON-RPC is a separate server on 8545 that nothing
mounts yet.

### GET routes

| Route | Returns |
| --- | --- |
| `/info` | `network`, `coin`, `height`, `tip`, `hashrate`, `mining`, `peers`, `mempool` size, `difficultyTarget` (the *next* target), `minerAddress` |
| `/supply` | `circulating` (sparks) + `circulatingEmber`, `commonsTreasury` + `commonsEmber`, `burnedTotal`, `height`, `blockReward` (full subsidy at height+1) |
| `/blocks?limit=N` | `{blocks:[…]}` newest first, `limit` capped at 100, default 20 |
| `/block/:idOrHeight` | The **full block object** — all-digits reads as a height on the active chain, otherwise as a block id from the store, so side-branch blocks are reachable |
| `/address/:addr` | `address`, `balance`, `spendable`, `immature`, `height`, and `utxos[]` each with `txid`, `vout`, `amount`, `coinbase`, `height`, `spendable`, `maturesAtHeight` |
| `/mempool` | `{size, txs:[{id, fee, size, tx}]}` |
| `/tx/:txid` | `{tx, height, blockId, confirmations}`; the containing block is confirmation 1 |
| `/records?app=&key=&since=&limit=` | `app` required and must match `APP_NS_RE`; `limit` clamped to 1–500 |
| `/mining/template?pub=` | `templateId`, `coreHash`, `target`, `coinbasePub`, `coinbaseAddress`, `prevHash`, `timestamp`, `merkleRoot`, `reward`, `scratchKiB`, `walkSteps`, `expiresAt` |
| `/events` | SSE. Unfiltered: unnamed `data:` frames per new block. With `?app=…[&key=…]`: named `record` events only |

Block frames are deliberately **unnamed** so `EventSource.onmessage` receives them
(`rpc.js:68-74`).

### POST routes

| Route | Behaviour |
| --- | --- |
| `/tx` | Accepts `{tx}` or a bare tx. Validates into the mempool and gossips it |
| `/mining/submit` | `{templateId, nonce, powDigest, powSig}`. 200 accepted, **409** when the tip moved (stale — the miner did nothing wrong), 400 for a bad proof |
| `/rpc` | A **legacy** `{method, params}` shape: `getinfo`, `getbalance`, `getblockcount`, `sendtx` (`rpc.js:139`, `:152`, `:242-254`). Anything else returns `{err:'unknown method'}` at HTTP 200 |

That last row is why the Ethereum RPC does not mount here: a JSON-RPC 2.0 client
posting `eth_chainId` to `POST /rpc` receives a 200 that is not JSON-RPC, which
reads as an empty chain rather than as a misconfiguration
(`docs/evm-spec.md` §6).

`OPTIONS` on any path returns 204. Request bodies are capped at
`MAX_TX_BYTES + 8,192` = 108,192 bytes, answered with 413 and then the socket is
destroyed.

### The Forge Pay coupling — and it has moved

`GET /address/:addr` used to be the contract Forge Pay read to credit EMBER
deposits at depth. **It is not any more.** Forge Pay has rebuilt EMBER as an
account-model EVM coin and now credits from `eth_getBalance` at
`latest - confirmations`, exactly as it does ETH
(`repos/forge-pay/services/pay/src/chains.ts:18-41`, `:161-192`). EMBER's depth
there is **60 blocks**, which matches what
[`docs/exchange-integration.md`](docs/exchange-integration.md) §4 publishes.

That file also records what it is waiting on: the RPC endpoint
(`chains.ts:282` — *"Every EMBER probe and payment will fail until it is
repointed"*). So the estate's payment rail is already built against a chain this
repository has not yet produced a block on.

---

## 8. P2P (`node/src/p2p.js`)

Plain TCP, newline-delimited JSON, no dependencies. Default port 8646
(`params.js:131`). **UTXO-era; nothing here knows about the account model.**

**Messages.** `hello {net, height, tip}`, `getblocks {locator}`, `getblock {id}`,
`blocks {blocks[]}`, `block {block}`, `tx {tx}` (`p2p.js:274-351`).

**Handshake.** `hello` carries the network id; a mismatch drops the peer
immediately. Sync is negotiated on *any* tip the node does not hold, not merely a
taller one — the fix for equal-height peers on different branches splitting forever
(`p2p.js:284-287`).

**Sync.** A locator of exponentially-spaced hashes is built back from the heaviest
*stored* branch, always ending at genesis. It is memoized on `(tipId, store.size)`
so a peer spamming invented tips cannot buy an O(chain) walk per message
(`p2p.js:163-165`). At most `P2P_MAX_BLOCKS` = 200 per round trip. `getblock` by
hash exists specifically so a side-branch block can be fetched at all, which
height-based paging structurally cannot do.

**Orphans.** Held, capped at `P2P_MAX_ORPHANS` = 32 with oldest-first eviction, and
connected transitively once an ancestor lands.

**Fork choice and reorg.** `Chain._ingest` has a fast path for extending the active
tip and a fork path otherwise (`chain.js:323-370`). On the fork path the proof is
verified **before** `_stateAt` replays the UTXO set from genesis, so a remote peer
cannot buy a full replay with an unproven block. Cumulative work is
`Σ 2²⁵⁶ / (target+1)`, and the heaviest branch wins. A reorg also *unwrites*
records — a message on an orphaned branch was never sent as far as the chain is
concerned (`chain.js:402-404`).

**The peer verification budget.** One PoW verification is a full Homefire
evaluation, so an unmetered peer could pin a core with junk that fails the very
check it paid for. `_acceptFrom` (`p2p.js:241-272`) takes a token before the work
and **refunds it** when the block turns out to be useful or to have cost no hashing
at all — so honest initial sync never touches the limiter while junk keeps its
token. `P2P_BLOCK_VERIFY_BURST` = 200 refilling at 25/s, and
`P2P_MAX_INVALID_BLOCKS` = 16 before disconnection (`params.js:104-123`).

**Tested over real sockets.** `node/test/p2p-fork.js` stands up two real `Node`
instances with real TCP and RPC servers, partitions them, mines competing branches,
reconnects, and requires the lighter node to reorg onto the heavier tip. 25/25, in
CI.

---

## 9. Wallets, miners and the CLI

### 9.1 Browser wallet (`web/wallet.html`, `web/assets/wallet/`)

**Account-model, and a clean break.** The wallet was Ed25519, `ember1…` and UTXOs;
it is now secp256k1, `0x…` and `[nonce, gasPrice, gasLimit, to, value, data]` at 18
decimals. Nothing carries over and nothing pretends to: there is no migration path
and deliberately no export machinery for one, because an Ed25519 key names no
account on an EVM chain and nobody holds EMBER. The pre-EVM modules
(`web/assets/wallet-core.js`, `keystore.js`, `vendor/noble-ed25519.js`) have been
deleted, along with the `node/test/keystore.js` that was the last thing importing
them. `wallet/keystore.js` is the only keystore in `web/`, and
`web/assets/wallet-selftest.js` is what tests it.

Non-custodial and genuinely so. The key is generated in the tab with
`crypto.getRandomValues`; the address is `keccak256(uncompressed_pubkey[1:])[12:]`,
rendered EIP-55 (`wallet/account.js:39-57`).

**The ports, and how they are held honest.** `wallet/secp256k1.js`, `wallet/rlp.js`
and `wallet/transaction.js` are browser ports of `node/src/crypto/secp256k1.js`,
`node/src/crypto/rlp.js` and `node/src/chain/transaction.js`.
`web/assets/wallet-selftest.js` runs both implementations over the same random
inputs and compares them — 200 random keys, 500 random RLP structures, 120 random
transactions for the signing hash, the signed bytes, the transaction hash, the
recovered sender and intrinsic gas, plus the EIP-155 worked example byte for byte.
**141 checks**, and CI gates on it (`.github/workflows/ci.yml:100-101`).

That cross-check found a real bug on its first run
(`a670a8a`): the node's "already normalised?" fast path asked only whether `nonce`
was a `BigInt`, which is safe for a node reading a decoded transaction and wrong
for a wallet building a draft, where `data.length` counted hex characters and
charged 192 gas too much for a 10-byte payload. **A second implementation earning
its keep on day one is the argument for having one.**

**One extra check the node has no reason to make.** `signAndCheck` signs, decodes
its own bytes back, recovers the sender and refuses to broadcast unless that sender
is the unlocked account and every field survived the round trip
(`wallet/transaction.js:400-433`). A node only has to agree with the network about
what a transaction *means*; a wallet decides what it *says*, and a one-field
disagreement there pays the wrong person rather than bouncing.

**Encryption at rest, versioned this time.** Keys are stored under
`hearth.wallet.v3` — PBKDF2-HMAC-SHA256 at 600,000 iterations → AES-256-GCM,
WebCrypto only, passphrase never stored. `open()` refuses any `version` it does not
recognise by number, and refuses a record whose stored address does not match the
key that comes out of it. A `v1`/`v2` Ed25519 record is reported as
`kind: 'pre-evm'`, explained on the page, never read and never deleted.

**The private key reaches the DOM in exactly one place**, behind a "Reveal private
key" button that re-asks for the passphrase and re-derives from storage rather than
printing the copy already unlocked in memory (`wallet/app.js:498-516`).

**The chain does not exist yet**, so `?fixtures=1` serves a canned account chain
over the real transport. It is opt-in from the URL, labelled on screen, and its
`eth_sendRawTransaction` validates with the same module the node uses — so a
signing bug is rejected there exactly as it would be on the wire.

### 9.2 Browser miner (`web/mine.html`, `web/assets/mining/`)

`homefire.js` is a line-for-line port of `node/src/pow.js` with two deliberate,
unobservable differences: the pad is allocated once per `Miner` rather than per
attempt, and the 64-bit read/xor/write is done byte-wise. `sha256.js` is a
synchronous SHA-256 so it can run inside a Worker — measured at ~225 H/s per thread
at dev params, about 1.37× the node's own native-crypto implementation, because
`createHash`'s per-call overhead dominates at thousands of calls per attempt.

**Conformance is enforced in CI.** `node/test/browser-pow.js` compares the browser
modules to the node's digest for digest including SHA-256 padding edges at 55/56/64
bytes; `node/test/mining-api.js` stands up a node, grinds nonces with the *browser*
implementation, signs locally and posts the proof over real HTTP.

**The signature is secp256k1 now, not Ed25519** — spec §4 makes `coinbasePub` a
secp256k1 key. The hashing half is untouched and `browser-pow` still passes. The
miner imports the wallet's port rather than carrying a second one. The wire form it
assumes is named in one place, `POW_SIG_FORM` (`web/assets/mining/miner.js:46`):
`r || s`, 64 bytes, low-s, no recovery id, because the header already carries the
public key.

> **This is a live disagreement inside the repository.** The browser miner sends a
> secp256k1 signature and a secp256k1 `coinbasePub`. The node's
> `GET /mining/template?pub=` still rejects anything that is not an 88-hex SPKI DER
> Ed25519 key (`node/src/rpc.js:130-134`), and
> `node/src/block.js:45` still verifies it with the UTXO-era Ed25519 `C.verify`. Phase 5
> owns the node half of that contract and has not landed it, so **the browser
> miner cannot currently mine a block the node will accept.** `POW_SIG_FORM` is the
> one line to change if phase 5 picks a recoverable 65-byte form instead.
> Tracked in [`docs/decisions.md`](docs/decisions.md) §2.5.

`/mining/submit` **does not trust the submission**: only `nonce`, `powDigest` and
`powSig` are taken from it; the header core and the transactions come from the
stored template, staleness is checked against the current tip, and the chain
revalidates everything anyway. Templates expire after 120s and are capped at 256
with oldest-first eviction.

**Politeness is real, and honestly scoped.** The effort slider is a duty cycle the
workers actually sleep through; a background tab drops to ≤15%; and where the
Battery Status API exists the miner pauses on unplug. Where it does not — Firefox
and Safari removed it — `powerKnown` stays false and the UI says which of the two it
got. There is deliberately **no** idle detection: a page cannot see whether someone
is at the keyboard.

### 9.3 `hearth` — the terminal tool for the EVM chain

`node/bin/hearth.js`, 310 checks in `node/test/cli.js`.

```
hearth trace <txhash>            replay a transaction opcode by opcode
hearth trace --vector <file>     replay a conformance vector
hearth watch                     a live view of a node
hearth wallet <new|list|send|…>  secp256k1 keys, encrypted at rest
hearth call | send | deploy      read / write / deploy a contract
hearth devnet <init|accounts|run>  a throwaway chain for development
```

Commands are required lazily, so `hearth trace` never pays for the wallet's crypto
and a syntax error in one command cannot stop the others (`bin/hearth.js:14-18`).
Exit codes are part of the interface: 0 succeeded, 1 the thing you asked about
failed (a revert, an unreachable node), 2 you asked wrongly (`:78-81`).

**The tracer is not a phase-8 nicety.** `src/cli/trace.js` is 878 lines and was
built *during* phase 3, alongside the interpreter, for a selfish reason: when a
`GeneralStateTests` vector fails, the difference between a good afternoon and a lost
week is whether you can see the exact opcode where our stack diverged from the
reference (`docs/evm-spec.md` §8).

Note `HEARTH_RPC_URL` still defaults to `http://127.0.0.1:8645`
(`node/src/cli/client.js:34`),
which is the **REST** port. The Ethereum RPC is settled on 8545
(`docs/evm-spec.md` §6), so that default will have to move when phase 5 mounts the
server.

### 9.4 Node-side wallet, miner and the UTXO CLI

`node/src/wallet.js` keeps PKCS#8 PEM keys in `data/wallet.json` plus a separate
X25519 *reading* identity — deliberately not the spending key. `buildTx` selects
only spendable UTXOs and refuses rather than building a payment the chain would
reject.

`node/src/miner.js` searches nonces on a `setImmediate` loop in batches of 150 so
the event loop never blocks. Its transaction selection is memoized on
`(tipId, mempool.version)` because building it copies the entire UTXO set and the
only externally reachable caller is the unauthenticated `/mining/template`.

`node/bin/hearth-cli.js` — `info`, `supply`, `newaddress`, `addresses`, `balance`,
`send`, `blocks` — is the **UTXO-era** client and speaks `ember1…`.

---

## 10. Not reachable, or not finished

- **Nothing produces an account-model block.** `node/src/jsonrpc/server.js` is
  never constructed; `node/src/chain.js` is UTXO-only; there is no account-model
  genesis, no state root to publish, and no endpoint. Everything in §4 is proved
  against vectors and fixtures, not against a chain.
- **The browser miner and the node disagree about the coinbase key.** §9.2.
- **`GET /mining/template` still takes an Ed25519 SPKI DER pubkey** — 88 hex
  characters or a 400 (`node/src/rpc.js:130-134`) — and `node/src/block.js:45`
  still verifies the proof signature with Ed25519.
- **The desktop app.** `start_node` / `stop_node` / `node_running` have zero
  callers, and `node_entry()` cannot resolve inside a bundle.
- **On-chain encrypted chat is CLI-only** — and records, which it is built on, have
  no account-model successor at all (§5.4).
- **API surface nothing in-repo consumes.** `POST /rpc`
  (`getinfo`/`getbalance`/`getblockcount`/`sendtx`) has no in-repo client.
  `/mempool` is read by no current page — the explorer is `eth_*`-only now, so
  records and the mempool have no explorer surface.
- **The `eth_*` JSON-RPC server mounts on port 8545, path `/`** — settled, and
  implemented by `node/src/evmnode.js` for `hearthd --evm` (`docs/evm-spec.md`
  §6). It is a different PORT from the REST API, not a different path, because
  `node/src/rpc.js:152` owns `POST /rpc` with the legacy `{method:'getinfo'}`
  shape. **The explorer still defaults to same-origin `/rpc/`**
  (`web/assets/explorer/rpc.js`), which `web/nginx.conf:63` proxies to the
  node's root — so a deployment must now point that proxy at 8545 rather than
  8645, or the explorer gets the legacy shape and correctly reports "answered,
  but not with JSON-RPC 2.0".
- **`web/pay-demo.html` is a mockup, and says so on the control.**
  `web/assets/hearth-pay-demo.js` builds a real `hearth:` URI and then **simulates**
  settlement on a 1,200 ms timer; the txid is deliberately not 64 hex characters so
  it can never be mistaken for a real one. The disclaimer is rendered next to the
  button so it survives a screenshot. **There is no payment SDK.**
- **`site/` still tells the UTXO story.** §3.6.
- **The Rust core** — §3.3. Also `src/tab.rs` (payment channels), `src/netmsg.rs`
  and `src/mempool.rs` are libraries wired to nothing but the self-check.
- **Chain replay is silent about rejects.** `Chain.load()` re-validates every
  persisted block through `_ingest(…, persist=false)` and discards the return value
  (`chain.js:48-51`), so a data directory containing an invalid block loads a
  shorter chain without saying why.

---

## 11. What this does NOT do, and non-obvious constraints

**`npm test` passes from a clean clone — this was broken and is now fixed.**
`node/test/blake2f.js` used to increment a `skipped` variable that was never
declared, on the path taken when the reference corpus is absent, which is the
state of every clean checkout including CI's. That killed the run at suite 9 with
`ReferenceError: skipped is not defined` and hid the results of ten suites.
Fixed in `521ecd5` by deleting the counter rather than declaring it — a skipped
optional corpus is not a check that passed. **Re-verified for this file** by
cloning the repository into an empty directory and running `npm test`: all 27
suites pass, exit 0, with no corpus and no install. `blake2f` reports 43/43
offline and 46/46 once the corpus is fetched.

**The EVM cannot be wired to a block yet, and the number is measured.**
[`docs/robustness-review.md`](docs/robustness-review.md) §1: `StateDB` re-roots
*both* tries on every single mutation (`statedb.js:342-352`, `:266-272`,
`:166-171`, `trie.js:163-170`), so one 30M-gas transaction costs **443 MB of
permanently retained heap and 65 seconds of single-threaded CPU against a
15-second block time** — 1.66 KB and 245 µs for 112 gas of `SSTORE`. It is the
most serious defect in the codebase, it is latent only because nothing calls
`applyBlock` on a network path, and it becomes live the day phase 5 lands.
**No statement anywhere in this repository that the EVM is "built" should be read
as "ready to run" until this is fixed.** That review also records findings **2**,
**3** and **5** as exploitable against a running `hearthd` *today* — a 39-byte
message buying a full copy of the UTXO set, an unbudgeted `tx` gossip path, and a
self-fed side branch that is stored and relayed forever.

**Two defects the fuzzer found are still open** (§4.7):

- **`RLP.decode` has no nesting cap.** `item()`/`items()` recurse once per level,
  so 7–12 KB of properly-nested input — well inside `MAX_TX_BYTES` (100,000) and
  the RPC body cap — exhausts the JS stack. Worse than the crash: the threshold
  moves with remaining stack, so the *same* input decodes from a shallow call site
  and throws from a deep one, and a `RangeError` carries no `code` for a caller to
  switch on. `Trie._deref` (`trie.js:159`) and `StateDB` (`statedb.js:117`, `:336`)
  are on that path. Blast radius is limited today because
  `transaction.validate()` catches everything and reports `RLP_ERROR`. Also
  [`docs/robustness-review.md`](docs/robustness-review.md) §4.
- **`isNormalized` is still not a complete test.** It now checks `nonce`, `data`
  and `to` (`transaction.js:281-285`), which closed the gas undercharge — verified:
  `intrinsicGas` returns 856,126 for a `to: ''` draft either way. But six fields
  are still unchecked, and the divergence is demonstrable: a decimal-string
  `value` on an otherwise-normalised draft produces a **different `signingHash`**
  than the same draft normalised, because RLP reads a bare string as UTF-8.
  `isCreation({to: ''})` also still returns `false` on its own. Nothing on the
  node's own path reaches this — `decode()` normalises everything it produces — so
  it is a wallet/caller-facing footgun rather than a consensus bug.

**The `@cloudsforge/hearth-node` version skew.** `node/package.json:3` is at
**0.2.0**, whose `txBody` emits a `records` key inside the signed body whenever a
transaction carries records (`node/src/tx.js:47-49`). ForgeKeyvault deliberately
pins **`^0.1.0`**, which omits the key entirely. A record-carrying transaction
therefore hashes differently on the two builds and a signature over it is valid on
**exactly one**. Keyvault's response is to refuse `records` in EMBER signing
altogether. **Do not let a blanket re-lock pull that dependency forward.**

**The published package does not export the EVM.** `node/package.json:12-21`
exports six UTXO-era modules and nothing under `crypto/`, `state/`, `evm/`,
`chain/` or `jsonrpc/`. Anything downstream wanting the transaction encoder — the
RPC probe does, and so does ForgeKeyvault eventually — must reach past the export
map or vendor it.

**`proto/emission.js` is a model, not the schedule.** It computes
`R0 · 2^(−h/HL)` in floating point; consensus computes a deterministic integer
schedule with linear interpolation inside each epoch (`node/src/params.js:140-151`).
Year one differs by ~3.5% — **11,045,161 EMBER** from consensus against
**10,667,873** from the model. [`docs/tokenomics.md`](docs/tokenomics.md) §3 carries
the consensus numbers and is the file to use.

**Other constraints and gaps:**

- **`SPARKS_PER_EMBER` is still 1e8** (`node/src/params.js:6`) while every document
  integrates against 18 decimals. Specified, not implemented.
- **`GET /address/:addr` is O(UTXO set) per call**, unauthenticated and under
  CORS `*`. `Chain.balance` and `Chain.supply` are the same shape, and `/supply`
  calls `supply()` twice per request.
- **`/blocks` `reward` is the miner's cut, not the subsidy** — it reads
  `txs[0].outputs[0].amount`, which is `subsidy − commons + tips`. `/supply`'s
  `blockReward` is the full subsidy at height+1. Two different quantities.
- **`/supply`'s `circulating` includes the Commons treasury.** Aggregators must
  compute `circulating − commonsTreasury` ([`docs/tokenomics.md`](docs/tokenomics.md) §7).
- **Dev-tuned consensus parameters.** `POW_SCRATCH_KIB` 64 and `POW_WALK_STEPS` 256
  against an intended production ~2 GiB / 2048+; `COINBASE_MATURITY` 10 against a
  production ~100. Each is a hard fork to change.
- **No authentication anywhere on the RPC.** No API key, no rate limit beyond the
  body cap. The node is meant to sit behind a proxy; `web/nginx.conf` is that proxy.
- **Persistence is an append-only NDJSON file** (`chain.js:407`), never rewritten
  and never compacted. Forked blocks are appended too.
- **The whole chain state is in memory** — `store`, `utxo`, `txIndex` and
  `recordIndex` are all `Map`s, and `_reindex` on every reorg walks the full chain.
- **`ember1commons…` is not a checksummed address** (`params.js:127`). Under the
  account model it becomes a `0x…` address that **has not been chosen**, and there
  is no spend path of any kind ([`docs/decisions.md`](docs/decisions.md) §2.4).
- **Hearth does not do fiat, custody or conversion.** This repository's wallets are
  non-custodial only.
- **No wallet recovery of any kind.** One key per browser, no seed phrase, no HD
  derivation, no passphrase recovery, no hardware wallet.
- **No audit.** Nothing here has been independently audited, and
  `docs/security-review.md` is an internal review of the **UTXO-era** code that
  predates every line of the EVM.

---

## 12. Running it

```bash
cd node && node bin/hearthd.js --mine          # one UTXO node, mining
cd node && node bin/hearthd.js --evm --mine    # the account-model EVM chain
                                               #   eth_* JSON-RPC on :8545/
                                               #   REST on :8645
npm test                                        # 27 suites, clean clone, exit 0
node test/dex.js                                # needs contracts/out — §4.4
node test/fuzz/run.js                           # property fuzzing — §4.7
docker compose up --build                       # seed + 2 miners + web on :8080
```

**The reference corpus.** `npm test` and the conformance harness run offline
against the 121 committed fixtures. The real gate needs the full corpus:

```bash
cd node && ./scripts/fetch-vectors.sh                       # ~350 MB, gitignored
node test/conformance/runner.js --impl=test/interpreter.js \
     --dir=test/conformance/vectors/VMTests --no-gas        # 609/609
node test/conformance/runner.js --impl=test/statetransition.js \
     --suite=GeneralStateTests --dir=test/conformance/vectors
```

Fetching it also takes `blake2f` from 43/43 to 46/46 and runs `bn128`'s one
skipped case (§11).

**CI** (`.github/workflows/ci.yml`), six jobs:

| Job | What it runs |
| --- | --- |
| Node reference client | `npm test` — **one command, not a list**, so a new suite is covered the moment it is added to `package.json` (`ci.yml:19-49`). Plus the coinnomics model sanity check |
| Rust production core | `cargo fmt --check`, `clippy -D warnings`, build, test |
| Web assets | `find web/assets -name '*.js'` piped through `node --check` — **`find`, not a glob**, because the old glob was `web/assets/*.js` and silently skipped every module under `web/assets/explorer/` — plus the explorer self-test and the wallet self-test (`ci.yml:85-101`) |
| Secret hygiene | `.env` untracked; no API tokens; a private-key matcher that requires a PEM header **followed by real base64**, so the legitimate PEM literals in `web/` do not force the check to be muted |
| DeFi contracts | `pnpm compile` (which refuses on an init-code-hash mismatch) and the build tests |
| Developer kit | The faucet's 66 checks; `tools/verify`'s 116; the templates and probe parse; the probe boots and answers the chain id in both encodings. Also `tools/explorer-api`, which is **why this job is red** |

**Two CI jobs are failing on `main` right now — and they are not the two this file
used to name.** The node job now **passes** (run
[30402531669](https://github.com/cloudsforge-online/hearth/actions/runs/30402531669),
*Node reference client (tests)*: success), because the blake2f break in §11 is
fixed. The two that fail are:

| Job | Failure | Is it an implementation failure? |
| --- | --- | --- |
| DeFi contracts | `Error: No pnpm version is specified.` from `pnpm/action-setup@v4` — `contracts/package.json` has no `packageManager` field and the step passes no `version` | No. Tooling configuration |
| Developer kit | `tools/explorer-api`'s suite throws on `receipt.logs[0].logIndex is missing` | **Yes.** §3.5 |

Neither is fixed here.

**Deploys.** `.github/workflows/pages.yml` publishes `web/` to GitHub Pages. The
marketing site in `site/` builds separately.

---

## 13. Where to look next

| | |
| --- | --- |
| [`docs/evm-spec.md`](docs/evm-spec.md) | The authoritative specification. Do not edit casually — other work is built against it |
| [`docs/decisions.md`](docs/decisions.md) | Why the non-obvious choices were made, and what is still open |
| [`docs/tokenomics.md`](docs/tokenomics.md) | Supply and emission, from the consensus schedule |
| [`docs/quickstart.md`](docs/quickstart.md) | Deploy a contract, with every step marked RUN / PROBE / WAITING |
| [`docs/exchange-integration.md`](docs/exchange-integration.md) | Deposits, withdrawals, confirmations |
| [`docs/listing-checklist.md`](docs/listing-checklist.md) | The gap list |
| [`docs/robustness-review.md`](docs/robustness-review.md) | Measured resource bounds. Read §1 before believing any "ready" claim |
| [`docs/testing.md`](docs/testing.md) | What the suites cover, and §4 — what they do not |
