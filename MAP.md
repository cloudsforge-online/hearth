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

**The live-network figures were re-measured on 2026-08-08 UTC** against
`https://rpc.cloudsforge.online` from outside this network, by walking every
block from 1 to the tip over JSON-RPC. That pass corrected §1, §2 and §10, all of
which still described mainnet as hours old, under 200 blocks tall and empty —
true when written on 2026-08-04, wrong within a day, and unnoticed for four
because those three figures had been written down without the date they were
taken. Every live-network figure below now carries one. If you are reading this
well after 2026-08-08, assume the numbers have moved again and re-measure.

**Re-measured again 2026-08-10 17:56 UTC**, from outside this network and with no
credentials. Mainnet: `eth_chainId` → `0x1cf3`, `eth_blockNumber` → `0x2aeb`
(**10,987 blocks**), tip timestamp 2026-08-10 17:56:10 UTC, `difficulty` still
`0x100`, tip transaction count `0`. Block 1 to tip is a mean interval of
**46.8 s**. **That `0x100` was the last floor reading this file will ever
record**: two hours later a browser miner took the difficulty to 8,146 and then
left, and difficulty became a live number that oscillates rather than a standing
property of the chain — §1 has the account, and is the only place in this
repository that states it. Testnet: measured again 2026-08-11 14:04 UTC, `eth_chainId` → `0x1cf4`,
`eth_blockNumber` → `0x1f22` (**7,970 blocks**), tip timestamp three minutes
before the reading and the height advancing across a 75-second poll — **testnet
is mining again.** It was stopped at 7,765 from 2026-08-08 18:00:11 UTC to
2026-08-11, deliberately, because the machine it shared ran `bitcoind` and
`dogecoind` through initial block download and testnet mining competed with them
for the same disk and bandwidth. `bitcoind` reached the tip, the chain daemons
moved to a host of their own, and the miner was repointed at the public RPC name
and restarted (`micro-deploy`). The §1 sentence below calling the testnet
"live" was written on 2026-08-05 and is kept, corrected in place, rather than
deleted — a status that changed is itself a fact about this repository.

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

**The account model is now the published chain.** Mainnet — chain id 7411 — is
reachable at `https://rpc.cloudsforge.online` and mining. Verified from outside
this network on 2026-08-05, and `eth_chainId` and `web3_clientVersion` re-checked
and unchanged on 2026-08-08: `eth_chainId` → `0x1cf3`, `web3_clientVersion` →
`Hearth/v0.2.0/linux-x64/node22.23.1`, genesis `extraData` → `0x6865617274682f37343131`
(`"hearth/7411"`, the format `node/src/chain/genesis.js` describes). Block 1 was
mined 2026-08-04 19:12:21 UTC and the chain has not stopped since. Re-measured
from outside this network on 2026-08-08 UTC: `eth_blockNumber` → `0x1ad8`
(**6,872 blocks**), and the latest block's timestamp `0x6a77a04a` =
2026-08-08 21:31:54 UTC, which makes mainnet **four days and two hours old** —
not the "hours old and under 200 blocks tall" this paragraph claimed for its
first four days. On that block it was at the `GENESIS_TARGET` difficulty floor
(`difficulty: 0x100`, `node/src/params.js`), as it was on every block until the
evening of 2026-08-10 — see **the difficulty is no longer at the floor, and no
longer a fact worth writing down** below. It runs on one home server behind one
Cloudflare Tunnel.

**Those two figures do not divide into the 15-second block time, and the gap is
the interesting part.** Four days at 15 s would be roughly 23,600 blocks, not
6,872. Walking every block from 1 to 6,872 on 2026-08-08 UTC, the mean interval
is **51.5 s** and the median **34 s**, a little over three times target, and the
last 500 blocks average **45.5 s**. One miner at the `GENESIS_TARGET` floor is
the entire explanation for *that* reading: the floor set the work, a single
machine supplied whatever hash rate it had, and nothing retargeted because there
was nothing to retarget against. That last clause stopped being true on
2026-08-10 — the paragraph below is what happened when a second miner appeared —
but the conclusion for a reader is unchanged and is now stronger. Any reader
dividing the height by the age and concluding the block time is broken should
read these two paragraphs instead: the 15-second figure at the top of this
section is the **design target**, and no live block has ever been produced under
the parameters that would deliver it.

**The difficulty is no longer at the floor, and it is no longer a fact worth
writing down.** This is the one place in this repository that records it;
everything else points here, because a live reading copied into nine files is
nine corrections the next time it moves. Every block from genesis to **10,842**
carried `difficulty: 256` — `0x100`, the `GENESIS_TARGET` floor. It then rose:
**358 at height 10,942, 594 at 11,142, 8,146 at 11,242**, a factor of 32 in four
hundred blocks. The cause is not in this repository. Browser mining shipped to
three surfaces in release 2.5.16 that evening, and `hub-web`'s EMBER sweep has
been mining mainnet from **block 10,919** — 23 blocks before difficulty first
left the floor, which is the lag `LWMA_WINDOW: 60` produces (`node/src/params.js`;
`_nextTarget` in `node/src/chain/blockchain.js` averages over that window). One
reader's browser tab was the entire second miner, and when it closed it left the
chain stranded far above what the baseline miner (`cf-miner-mainnet`,
`--throttle 0.25`, a steady 8 H/s) can carry: **the tip did not advance for
1,154 s.**

**Measured 2026-08-10 20:06 UTC**, from outside this network and with no
credentials, walking the 60 blocks below the tip: `eth_blockNumber` → `0x2bed`
(**11,245**), tip `difficulty` **5,712** — 22x the floor, still falling — tip
timestamp 2026-08-10 19:41:02 UTC, which is **1,538 s before the reading was
taken**. Over the 50 blocks below the tip the mean interval is **35.3 s** and
difficulty ranges **4,312 to 8,417**; the largest gap in that window is
**1,210 s**, between blocks 11,243 and 11,244. **Polled again at 20:21 UTC, the
tip was still 11,245** — 2,393 s and counting with no new block, so the stall was
ongoing while this paragraph was written, not recovered from. The excursion is
therefore not a single past event: the chain is oscillating between bursts of
blocks seconds apart and stalls of tens of minutes, and it will do that every
time somebody opens or closes a mining tab. **Do not copy these numbers
anywhere.** Re-measure, or say what the difficulty does rather than what it is.

**What does not expire, and is what a reader actually needs.** Two facts survive
every one of these readings. **Every block this chain has ever had was mined by
this project** — there has never been an independent miner, and the browser tab
above was ours too, running our own code from our own site. And **one browser tab
is enough to move this chain's difficulty by a factor of 32 and then stall it for
twenty minutes**, because the LWMA retarget cannot shed work faster than the
remaining 8 H/s can produce blocks to retarget on. Write those, not the tip
difficulty. Fixing the second is a consensus change and is tracked as
`micro-org#363`; it is deliberately not fixed here.

**The public testnet is reachable and mining** — chain id 7412 at
`https://rpc-testnet.cloudsforge.online`, verified from outside on 2026-08-05
(`eth_chainId` → `0x1cf4`) and again on 2026-08-11 14:04 UTC at `0x1f22` (7,970)
with the height moving across a 75-second poll. Between 2026-08-08 18:00:11 UTC
and 2026-08-11 it was stopped at 7,765 on purpose, so the machine it shared could
take `bitcoind` and `dogecoind` through initial block download without competing
for the same disk and bandwidth; that reason expired when `bitcoind` synced and
the chain daemons moved to a host of their own. **A reader deploying to testnet
today gets a receipt from a real block.**

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
| `eth_*` JSON-RPC surface | `node/src/jsonrpc/` | ✅ **merged**, 41 methods, 422 checks against a fake chain plus 170 against the real one over HTTP; mounted by `src/evmnode.js` on :8545 |
| EVM-aware explorer | left this repo — [`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web) | ➡️ **moved 2026-08-04** (`48bc28a`). The successor is **not a port**: it reads `micro-indexer`'s REST routes, not `eth_*`, and has no contract disassembly — §3.4 |
| Browser wallet on secp256k1 | left this repo — [`micro-hearth-wallet-core`](https://github.com/cloudsforge-online/micro-hearth-wallet-core) + [`micro-wallet-extension`](https://github.com/cloudsforge-online/micro-wallet-extension) | ➡️ **moved 2026-08-04**, and the cross-check against this node got *stronger* — §9.1 |
| `hearth` CLI + opcode tracer | `node/bin/hearth.js`, `node/src/cli/` | ✅ **merged**, 310 checks |
| AMM contracts (WEMBER, V2 Factory/Pair/Router, Multicall3) | `contracts/` | ✅ **compile**, and **Uniswap V2 runs on our own EVM** — see §4.4 |
| Developer kit (faucet, Hardhat/Foundry templates, RPC probe) | `tools/` | ✅ **merged**, faucet 66 checks |
| Etherscan-compatible `/api` + address index | `tools/explorer-api/` | ✅ **merged**, 177 fixture checks + 27 against a real chain — §3.5 |
| Contract verification (`forge verify-contract`-compatible) | `tools/verify/` | ✅ **merged**, 116 checks |
| Property fuzzing | `node/test/fuzz/` | ✅ **merged**, 82,481 checks; two open findings — §4.7, §11 |
| **Consensus on the account model** | `node/src/chain/`, `node/src/evmnode.js` | ✅ **merged.** Blocks are produced, validated and reorged — `evmchain` 191 checks, `evm-p2p-fork` 51 across two real nodes; three run under `docker-compose.testnet.yml` |
| **Public mainnet** | — | ✅ **published 2026-08-04.** Chain id 7411 at `https://rpc.cloudsforge.online`, mining, publicly trusted TLS. Measured from outside on **2026-08-08**: **6,872 blocks**, **four days and two hours** old, **21 transactions**, mean block interval 51.5 s — §1. On one home server behind one tunnel, and **every block it has ever had was mined by this project** — running, not established. It left the `GENESIS_TARGET` difficulty floor on 2026-08-10 when a single browser tab took the difficulty up 32x and then stalled the chain; difficulty is now a live reading, stated once in §1 and nowhere else |
| **Public testnet** | — | ✅ **published.** Chain id 7412 at `https://rpc-testnet.cloudsforge.online` — verified from outside on 2026-08-05, `eth_chainId` → `0x1cf4`. Explorer at `explorer-testnet.cloudsforge.online`, faucet at `network-testnet.cloudsforge.online/faucet`, P2P at `wss://p2p-testnet.cloudsforge.online/p2p` (**only the `/p2p` path is routed**). Hostnames are single-label `<surface>-testnet.` — the `*.testnet.cloudsforge.online` form fails TLS, because Cloudflare Universal SSL's `*.cloudsforge.online` covers one label |
| Any deployed contract of record | — | ⬜ **still none.** Off mainnet, no genesis outlives a `docker compose down -v`, so testnet state is disposable |
| The UTXO chain (ledger, P2P, REST, reorg) | `node/src/chain.js`, `tx.js`, `p2p.js`, `rpc.js` | ✅ runs, and **is being retired** |
| `rust/hearthd` | `rust/` | 🟡 a self-check and a benchmark. **Not a node, not consensus** — §3.3 |

**The strongest single fact about this project:** `node/test/dex.js` deploys the
whole Uniswap V2 stack onto our own EVM and executes a real swap — 167/167
checks, a swap at **112,456 gas**. §4.4.

**The most important gap is no longer publication.** Blocks are produced,
validated and reorged, the components above have been driven by one, and mainnet
is reachable. What remains is that **no block has ever been produced at
production PoW parameters** — every block ever mined, here and on the live
chain, used a 64 KiB scratchpad and a 256-step walk against an intent of 2 GiB
and 2,048 steps — and those parameters have now been measured and found
unreachable ([`docs/pow-parameters.md`](docs/pow-parameters.md)). **That is a
claim about the pad and the walk, not about difficulty**, and the two were run
together in this sentence until 2026-08-10, when difficulty left the
`GENESIS_TARGET` floor and the pad did not move at all — §1. Under that sits a
deployment fact worth stating plainly: one home server, one tunnel, no
redundancy, and no backup that has ever been restored. That is no longer only a
worry — walking every block on 2026-08-08 UTC found exactly one stall, **2 h
3 min with no block at all** between blocks 1962 and 1963 (2026-08-05 19:08:14 →
21:11:30 UTC), which is 2.1% of the chain's life to date. One server, one
outage, and nothing anywhere else that could have produced a block meanwhile.

**A "merged" row is still not a "ready" row**, but the thing that made it so is
fixed: `StateDB` used to re-root both tries on every mutation, at **443 MB and
65 seconds for a single 30M-gas transaction against a 15-second block time**
([`docs/robustness-review.md`](docs/robustness-review.md) §1, measured). Writes
are deferred to `root()` now; the same transaction measures **5.2 s and 9.2 MiB**
and `node/test/bench/block-execution.js` fails if that regresses. §11.

---

## 3. Component inventory

| Directory | What it is | Status |
| --- | --- | --- |
| `node/` | The reference full node, wallet, miner, P2P, REST API — **and the entire EVM implementation.** JavaScript, zero runtime dependencies | **This is the network, and this is the EVM** |
| `contracts/` | WEMBER, a Uniswap V2 port, Multicall3. Solidity, compiled with solc 0.8.26 / shanghai | Compiles in CI; **nothing deployed anywhere** |
| `tools/` | The developer onboarding kit: faucet, Hardhat and Foundry templates, an RPC probe stub | Real and runnable; §3.5 |
| `branding/` | The brand note, the vector lockup (`logo.svg`) and the generated PNG marks and cards | The lockup moved here from `web/assets/` in `48bc28a`; it is the only vector source and `app-desktop` generates its icons from it |
| `rust/hearthd/` | A self-check binary and a Homefire benchmark over some library modules | **Not a node. Not consensus.** Two known divergences — §3.3 |
| `proto/` | Two teaching scripts: an emission *model* and a toy PoW miner | Prototype; **the emission model is not the consensus schedule** — §11 |
| `app-desktop/` | Tauri v2 **desktop miner** — window, encrypted keystore, OS keychain, bundled Node runtime | Ships on macOS; Windows/Linux configured but never compiled — §3.7 |
| `docs/` | Eighteen documents. [`evm-spec.md`](docs/evm-spec.md) is the authoritative one; [`robustness-review.md`](docs/robustness-review.md) is the measured one; [`testing.md`](docs/testing.md) says what is and is not covered | Prose only |
| `branding/` | Favicon, mark, wordmark, og, social | Complete |

### 3.1 `node/` — the node, and the EVM

One process is a full node, a wallet and a miner (`node/src/node.js`). The
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
| `src/evm/interpreter.js` | execution loop, call frames, depth 1024, revert semantics, the RPC-only deadline | 1,022 |
| `src/evm/precompiles.js` | `0x01`–`0x09`, and the two opposite failure conventions | 458 |
| `src/evm/bn128.js` | alt_bn128 curve, tower field, optimal ate pairing | 743 |
| `src/evm/blake2f.js` | BLAKE2b compression (EIP-152) | 218 |
| `src/state/trie.js` | Merkle Patricia Trie, secure (keccak-keyed) variant, and the speculative overlay | 374 |
| `src/state/statedb.js` | accounts, storage, code, journaling, snapshot/revert | 565 |
| `src/chain/transaction.js` | legacy (type 0) tx: encode, decode, hash, sign, recover | 396 |
| `src/chain/receipt.js` | `[status, cumulativeGasUsed, logsBloom, logs]` | 182 |
| `src/chain/bloom.js` | the 2048-bit logs bloom | 148 |
| `src/chain/statetransition.js` | apply a transaction, produce a receipt; a block's worth in order | 503 |
| `src/jsonrpc/hex.js` | the QUANTITY/DATA codec, and the RPC error type | 272 |
| `src/jsonrpc/methods.js` | the `eth_*` method surface — 41 methods, 43 with `HEARTH_RPC_FEE_HISTORY=1` | 1,525 |
| `src/jsonrpc/server.js` | JSON-RPC 2.0 dispatch: batches, notifications, error mapping, and what one request may cost | 349 |
| `src/jsonrpc/filters.js` | the filter registry — the only server-side state in the layer, and its three bounds | 176 |
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
accepting the other's addresses (`node/bin/hearth.js`).

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
`/events`). They are separate servers precisely because `rpc.js` owns
`POST /rpc` with a different protocol.

Tested by `node/test/evmchain.js` (consensus, 191 checks), `node/test/evm-rpc.js`
(the `eth_*` surface over real HTTP, 170) and `node/test/evm-p2p-fork.js` (two
real nodes, partition, reorg, 51 — including an open `eth_newFilter` that has to
deliver the winning branch's logs after the reorg).

Published to npm as `@cloudsforge/hearth-node`, currently **0.2.0**
(`node/package.json`), exporting `.`, `./crypto`, `./chain`, `./tx`, `./wallet`
and `./params` (`node/package.json`) — **all six are UTXO-era modules.**
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
and CI runs it (`.github/workflows/ci.yml`).

`Multicall3.sol` is **not** the canonical bytecode and deploying it would not
produce the canonical address. That is an open decision — see
[`docs/decisions.md`](docs/decisions.md) §2.2.

### 3.3 `rust/hearthd/` — a self-check and a benchmark, NOT consensus

**Do not read this crate as a second opinion about what a valid block is.** It has
no block type, no chain, no fork choice, no storage, no RPC and no P2P server;
`main.rs` runs a self-check over the library modules and then benchmarks Homefire
against a stand-in header literal (`rust/hearthd/src/main.rs:28-102`).
Nothing in the directory has ever accepted a block, because there is nothing there
to accept one into.

Two modules would produce the **wrong answer** if wired up:

1. **`pow.rs` omits the coinbase public key from the seed.** Consensus binds
   `(headerCoreHash, nonce, coinbasePubHex)` (`node/src/pow.js`); the Rust
   `homefire()` hashes whatever seed bytes it is handed, and the binary only ever
   hands it `header || nonce_le` (`rust/hearthd/src/pow.rs:31`,
   `main.rs:127-130`). Same header, different digest.
2. **`difficulty.rs` retargets ±1 leading-zero bit per block** — a factor of two
   per step, ignoring the magnitude of the miss
   (`rust/hearthd/src/difficulty.rs:47-53`). Consensus retargets a continuous
   256-bit target with a 60-block LWMA (`node/src/chain.js`).

The crate's own header comments say all of this (`main.rs:3-20`, `pow.rs:7-15`,
`difficulty.rs:7-17`, `rust/README.md`). What it does have that is real: a
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

### 3.4 The front ends that used to live here, and where each one went

**`web/` and `site/` were deleted on 2026-08-04 (`48bc28a`, 102 files).** They were
the pre-migration single-repo front ends. Nothing is served from this repository
any more: there is no `web` service in `docker-compose.yml`, and the Pages deploy
that published `web/` was removed one commit earlier (`88a1552` — there is no
`.github/workflows/pages.yml`).

This section exists so that "where is the explorer / the wallet / the miner" has an
answer rather than a gap.

| What it was | Where it is now |
| --- | --- |
| `web/index.html` + `web/assets/explorer/` — block explorer | ➡️ [`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web), **but see the warning below — it is a different program, not a port** |
| `web/wallet.html` + `web/assets/wallet/` — secp256k1 wallet | ➡️ [`micro-hearth-wallet-core`](https://github.com/cloudsforge-online/micro-hearth-wallet-core) (the signing library) and [`micro-wallet-extension`](https://github.com/cloudsforge-online/micro-wallet-extension) (the MV3 browser surface). §9.1 |
| `web/mine.html` + `web/assets/mining/` — browser miner | ➡️ [`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site) `src/mining/` + its `/mine` page. **This row read "Gone, not moved" until 2026-08-09; it was restored on 2026-08-06.** From here, mining is `node/bin/hearth-mine.js` and `app-desktop/`. §9.2 |
| `web/pay-demo.html` — merchant-button mockup | ❌ **Gone, and nothing replaces it.** It simulated settlement on a 1,200 ms timer. There is still no payment SDK — §10 |
| `web/explorer.html` — 0-second redirect | ❌ Gone with the page it redirected to |
| `web/nginx.conf`, `web/Dockerfile` | ❌ Gone. Each successor serves itself |
| `web/assets/logo.svg` | ➡️ **Moved, not deleted** — `branding/logo.svg`. It was the only vector source in the repository and `app-desktop` generates its icons from it |

> **The explorer successor is not the explorer that was deleted.** `micro-explorer-web`
> is a Vite/React SPA that reads **`micro-indexer`'s REST routes** — its route table is
> transcribed with citations in its `src/lib/indexer.ts` header — rather than speaking
> `eth_*` JSON-RPC to a Hearth node directly. It has blocks, transactions, addresses,
> tokens, chains and search (`src/pages/`), and a token page that reports supply and
> authorities. It does **not** carry the deleted explorer's EVM contract disassembly;
> nothing in its `src/` mentions disassembly at all. Treat the move as a replacement of
> the surface, not a transplant of the code.

**No count is carried across from the deleted tree.** The old explorer self-test
claimed 147 checks and the old wallet self-test 141; neither number describes anything
that exists now, so neither is repeated here. The successors report their own totals
from their own runners — `npm test` in each — and those totals are theirs to state.

**Two ports, and the lesson is about the node, not the page.** This is kept because it
is a fact about `node/`, which is still here. The node runs two servers: the REST API
+ SSE on (`node/src/rpc.js`) and Ethereum JSON-RPC 2.0 on
(`node/src/evmnode.js`). They are a different **port**, not a different path, because
`node/src/rpc.js` already owns `POST /rpc` with the legacy `{method:'getinfo'}`
shape. A client that sends `eth_*` to the REST port is answered HTTP 404 with
`{"err":"this is the REST API — the Ethereum JSON-RPC endpoint is a different port"}`,
plus the port and path it should have used (`node/src/evmnode.js`) — a
deliberate pointer, because it is "the single most likely first mistake". A body
carrying neither `result` nor `error` reads to a JSON-RPC client as a malformed
response rather than as a wrong address, which is how the deployed explorer once
reported a dead chain while the chain was fine (CF-13). Any new client points at 8545.
[`docs/evm-spec.md`](docs/evm-spec.md) §6 settles this.

**The chain id is deployment configuration, not a constant**, and that is still true of
the node. `CHAIN_IDS` is `{hearth: 7411, 'hearth-testnet': 7412}`
(`node/src/params.js`), resolved for the running network into the exported
`CHAIN_ID` and overridable with `HEARTH_CHAIN_ID` for a private network. The refusal to guess is stated in the source itself: a node must never
guess a chain id (`node/src/params.js`). A client must not take the chain id from
`eth_chainId` on an endpoint its user can override, or the endpoint would be choosing
what its visitor's signature is valid on.

### 3.5 `tools/` — the developer kit

Real, runnable, and the reason a stranger can get to a deploy without asking.

| Path | What it is |
| --- | --- |
| `tools/rpc-probe/stub.js` | Serves `node/src/jsonrpc/` — the **real** method surface and hex codec — over a chain with no state that executes nothing. Logs every method a client calls, *including the ones Hearth does not implement*, which is the point of it |
| `tools/faucet/` | A faucet service whose entire engineering problem is refusing: per-address and per-IP limits, a global payout cap, and an atomic check-and-record. **66 checks**, over real HTTP against a stub node, no dependencies |
| `tools/hardhat/` | A working Hardhat template — `evmVersion: 'shanghai'` pinned, plus `check-network.js`, `deploy.js`, `deploy-dex.js`, `swap.js`, `interact.js` |
| `tools/foundry/` | A working Foundry template; `--legacy` is required on every broadcasting command and the README says why |
| `tools/explorer-api/` | The **Etherscan-compatible `/api`** and the address index behind it — `account`, `contract`, `stats`, `transaction`, `logs` and `proxy`, plus `GET /supply/total`. Zero dependencies. **177/177 fixture checks, plus 27/27 against a real chain** — see below |
| `tools/verify/` | Contract verification, including the API `forge verify-contract` speaks. **116/116 checks**, run |
| `tools/metamask.md` | The add-network page |

**`tools/explorer-api` has two suites, and the second one is the gate.**
`test/explorer-api.test.js` (177 checks) runs the service against a fake chain
served by `node/src/jsonrpc`. `test/live-chain.test.js` (27 checks) runs it
against a **real node booted from `node/src`** — real proof-of-work, real signed
transactions, real EVM execution — and requires `module=account&action=balance`
and `module=logs&action=getLogs` to agree field for field with `eth_getBalance`
and `eth_getLogs`. `HEARTH_LIVE_RPC_URL=http://127.0.0.1:8545` points the same
comparison at a node someone else is running.

The fixture suite used to fail, on every run, locally and in CI:

```
RpcError: receipt for 0x47d3…aef2: internal error: receipt.logs[0].logIndex is
missing — the chain must number logs across the block, and this layer cannot
derive it from one receipt
```

**The side that owned it was the fake chain.** `logIndex` is per block
(`docs/evm-spec.md` §6), `node/src/chain/rpcadapter.js` numbers it that way, and
`node/src/jsonrpc/methods.js` is right to refuse a receipt that omits it — one
receipt cannot know how many logs preceded it in its block, and the plausible
wrong answer (restart at zero) silently resolves every lookup in a multi-log
block to the wrong log. The fixture now numbers it across the block, and the
ordinals are asserted on both paths that serve them, against a real chain.

CI parses the templates and boots the probe, asserting `eth_chainId` is `0x1cf3`
and `net_version` is `"7411"` — the same number in two encodings, which is the one
mistake that makes MetaMask refuse a network outright
(`.github/workflows/ci.yml`).

### 3.6 Marketing — no longer in this repository

`site/`, a React + Vite marketing site for hearth.cloudsforge.online, was deleted in
`48bc28a`. Marketing is served by the estate's own sites, not from here.

**It was removed carrying a known defect, which is part of why it went.** Its copy had
never been updated for the account model and still told the UTXO chain's user-facing
story — a marketing site describing a chain the code no longer implements. That defect
does not survive the deletion, but it is recorded here rather than quietly dropped: the
successor sites are written against the account model, and nobody should go looking in
this repository for the UTXO copy to fix.

### 3.7 `app-desktop/` — the desktop miner

A Tauri v2 application that mines EMBER on a Mac or a PC. It is a **light miner**,
not a node: it takes work over the HTTP mining API, grinds Homefire, signs the
winning digest with a key only it holds, and posts the proof. No chain, no sync,
no inbound port.

Three parts, and the split is the point:

* **`ui/`** — plain HTML/CSS/JS, no framework and no build step
  (`app-desktop/ui/app.js`). It is told the *address* and never the key.
* **`engine/engine.js`** — one mining session and one key, as JSON lines on
  stdin/stdout. It runs on the Node runtime bundled with the app.
* **`src-tauri/`** — the window, the OS keychain (`src/keychain.rs`), the
  supervisor and the path resolution (`src/engine.rs`).

**The mining loop is not in this directory.** It is `node/src/mine/session.js`,
shared unmodified with `bin/hearth-mine.js`; `app-desktop/src-tauri/src/engine.rs:7-17`
gives the reason, which is the 64-byte browser-miner proof.

**The key is encrypted at rest** — scrypt N=2¹⁸ over a passphrase, AES-256-GCM
over the key, address in the clear and bound in as GCM additional data
(`node/src/mine/keystore.js`).

This used to be the one thing `hearth-mine` and `hearthd` did *not* do. Since
micro-org#206 they do: `node/src/coinbase.js` `resolveCoinbaseKey` takes the key
from `HEARTH_COINBASE_KEY`, from `HEARTH_COINBASE_KEY_FILE`, from that same
keystore under `HEARTH_COINBASE_PASSPHRASE_FILE`, or — still, so nothing that
worked stops — from the plaintext `coinbase-key.json` at mode 600. The verbs are
`hearth minerkey status|seal|new|verify` (`node/src/cli/minerkey.js`), the suite
is `node/test/coinbase-source.js`, and the runbook, including what only a person
can do, is [`docs/mining-key-custody.md`](docs/mining-key-custody.md).

The reason it changed is a number: on 2026-08-09 the mainnet coinbase held
47,421.445463215 EMBER and was accruing ~400 EMBER an hour behind a 240-byte
plaintext file that was bind-mounted read-**write** into the miner container.

**What replaced what.** The previous contents were scaffolding that documented its
own brokenness: three registered commands with zero callers, a `frontendDist` of
`../../web` whose pages never call `invoke`, and a `node_entry()` resolving
relative to the process CWD. All of it is gone. `app-desktop/test/wiring.js` is
the regression test for the first of those — it requires commands, events and
element ids to line up in *both* directions — and `src/engine.rs`'s unit tests
cover the second and third.

**Proved, not asserted.** `hearth-desktop --selftest` drives the production path
with no window and mines a real node; `app-desktop/test/engine.js` spawns the
engine as the app spawns it, mines a real `hearthd`, reads the balance back out of
the chain, and then searches every byte the process wrote for the key, the
passphrase and the ciphertext.

**Not built anywhere but macOS.** Windows and Linux are configured — target
triples in `scripts/fetch-node.mjs`, per-platform keychain backends in
`Cargo.toml` — and have never been compiled. No CI job builds this app.

### 3.8 `proto/` — teaching artifacts, and one trap

`proto/pow.js` + `proto/mine.js` are a minimal model of memory-hardness and of the
signature-binding property; `proto/pow.js` states plainly that this is not
non-outsourceability.

`proto/emission.js` is run in CI as a sanity check
(`.github/workflows/ci.yml`) — but **it is a smooth exponential model, not
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

**Re-derived 2026-08-09** from one `npm test` in `node/`, run to completion, exit 0,
**without** the optional reference corpus in `test/conformance/vectors` — and the same
totals reproduced from a fresh clone and in CI ([run
31306048763](https://github.com/cloudsforge-online/hearth/actions/runs/31306048763)). This is every
suite `node/package.json` runs, in that order — not a selection — because the previous
version of this table was a hand-kept subset and had silently fallen ten suites behind
it. [`docs/testing.md`](docs/testing.md) §1 carries the same figures with a line on
what each one establishes.

| Suite | Result |
| --- | --- |
| `keccak` | 52/52 |
| `rlp` | 149/149 |
| `uint256` | 162/162 |
| `secp256k1` | 179/179 |
| `opcodes` | 81/81 |
| `gas` | 205/205 |
| `precompiles` | 126/126 |
| `bn128` | 81/81 offline (1 case skipped); **86/86** with the corpus fetched |
| `blake2f` | 50/50 offline; **53/53** with the corpus fetched — see §12 |
| `trie` | 315/315 |
| `statedb` | 166/166 |
| `transaction` | 165/165 |
| `receipt` | 62/62 |
| `bloom` | 61/61 |
| `interpreter` | 194/194 |
| `statetransition` | 133/133 |
| `cli` | 310/310 |
| `jsonrpc` | **422/422** |
| `evmchain` | **191/191** |
| `chain-replay` | 27/27 |
| `evm-rpc` | 170/170 |
| `conformance --selftest` | 85/85 |
| `fuzz --cases=2000` | **82,481/82,481**, with 3 standing observations — §4.7 |
| `unit` / `e2e` / `records` | 40/40 · 24/24 · 49/49 |
| `mining-budget` / `mining-stale` | 14/14 · 50/50 |
| `miner-loop` / `mine-keystore` | 4/4 · 52/52 |
| `mine-session` / `miner-cli` | 82/82 · 31/31 |
| `netprefix` / `ws` | 34/34 · 62/62 |
| `p2p-fork` / `evm-p2p-fork` / `p2p-ws` | 34/34 · 51/51 · 45/45 |
| `pow-params` | 7/7 |
| `bench/block-execution` | 5/5 |
| **Total** | **39 suites, 86,451 checks** |

> **This table used to also name `browser-pow`, `keystore` and `mining-api`, and none
> of the three had existed since 2026-08-04** (`48bc28a`) — a table headed "only things
> that were run" was reporting counts for files that were not there. `browser-pow` is
> restored (§9.2) but is **not** in `npm test`, because it needs a second repository
> checked out; it has its own CI job and is listed in `docs/testing.md` §1 under
> "outside the gate, on purpose". `mining-api` and the Ed25519 `keystore` suite have no
> successor.
>
> Seven per-suite counts here were also stale when this was re-derived (`precompiles`
> was written as 119, `trie` 302, `interpreter` 182, `transaction` 167, `unit` 32,
> `p2p-fork` 25, `blake2f` 43 offline). A table transcribed by hand from `node/package.json` drifts the moment
> that file changes; the total row above exists so the next drift is one subtraction
> away from being visible. The two with-corpus figures are the only numbers here not
> taken from that run: the corpus branch of `test/bn128.js` contains 5 checks and that
> of `test/blake2f.js` contains 3, all unconditional once the branch is entered, so 86
> and 53 follow from the offline totals by counting rather than by memory.

### 4.3 The reference corpus

The full corpus is **gitignored** and fetched by `node/scripts/fetch-vectors.sh`
(3,425+ files, ~350 MB). The committed `fixtures/` subset — 121 vectors — is what
runs offline.

| Suite | Result | How |
| --- | --- | --- |
| **VMTests** | **609/609 vectors, 2121/2121 checks** — verified | `node test/conformance/runner.js --impl=test/interpreter.js --dir=test/conformance/vectors/VMTests --no-gas` |
| **GeneralStateTests** | **20,077 / 20,077**, 60,231 checks — verified, re-run for this pass (2,002 s) | `node test/conformance/runner.js --impl=test/statetransition.js --suite=GeneralStateTests --dir=test/conformance/vectors` |
| **TransactionTests** | **188/188** — verified. `188/188 corpus cases, 22 typed (EIP-2718) skipped, 2 with no Shanghai result` | `node test/transaction.js`, group *TransactionTests — full corpus* |
| RLPTests / TrieTests | pass, inside `test/rlp.js` and `test/trie.js` — 55 and 25 vectors respectively, by the loader's count. Neither suite reports a separate vector total on stdout, so quote the suite's own check count (149/149, 315/315 — measured 2026-08-09) rather than a vector count | |

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
with nothing left over (`node/test/interpreter.js`). Gas conformance comes
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
**miner-influenceable** (`node/src/evm/interpreter.js`).
`BASEFEE` (`0x48`) pushes zero. Both, with the reasoning, are in
[`docs/decisions.md`](docs/decisions.md) §1.1 and §1.2.

### 4.6 The JSON-RPC layer, and exactly what it is

`node/src/jsonrpc/` implements the v1 method set of `docs/evm-spec.md` §6 and
passes 422 checks against a fake chain plus 170 against a real one over HTTP
(`test/evm-rpc.js`). **It is written against an interface, and a chain now
implements that interface** — `chain/rpcadapter.js`, mounted by
`evmnode.js`. The fake is still where the edge cases live, because a real
chain will not produce a malformed receipt on demand.

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

`Chain._validate` (`chain.js`) runs checks in a deliberate order — cheap
comparisons, then the proof, then serialization, then signature work — so that
everything an anonymous peer can make the node do is gated behind a proof it had
to pay for (`chain.js`).

| Rule | Where |
| --- | --- |
| height = parent + 1 | `chain.js` |
| non-empty, ≤ `MAX_BLOCK_TXS` (5,000) | `chain.js`, `params.js` |
| timestamp ≤ now + `MAX_FUTURE_DRIFT_S` (7200s) | `chain.js`, `params.js` |
| timestamp > median-time-past over 11 blocks | `chain.js`, `params.js` |
| `header.target` equals the recomputed LWMA target | `chain.js` |
| Homefire proof verifies | `chain.js` → `block.js` |
| canonical bytes ≤ `MAX_BLOCK_BYTES` (2 MB) | `chain.js`, `params.js` |
| tx 0 is a coinbase with no inputs and **no records** | `chain.js` |
| no second coinbase | `chain.js` |
| every other tx passes `validateNormal` against a scratch UTXO | `chain.js` |
| coinbase has 1–2 outputs, each integer, ≥ 0, ≤ `MAX_MONEY` | `chain.js` |
| miner output = subsidy − commons + tips, **exactly** | `chain.js` |
| commons output present and exact | `chain.js` |
| total minted = subsidy + tips, exactly (**anti-inflation**) | `chain.js` |

A coinbase may not carry application records, because a coinbase is signed by
nobody and a record in one would be an unauthenticated write the miner alone
chooses (`chain.js`).

### 5.2 Transaction validation

`TX.validateNormal` (`tx.js`): ≥1 input and output and ≤1,000 of each; the
record shape/size rules; size ≤ `MAX_TX_BYTES`; **double-spend within the
transaction** (a repeated `txid:vout`) and **against the set**; the input's public
key must hash to the output's address; an Ed25519 signature over the canonical
body, which excludes the signatures themselves; **coinbase maturity** (10 in this
tree, against a production ~100); positive integer outputs ≤ `MAX_MONEY`;
`fee = inputs − outputs ≥ base fee + data fee`; and `tx.id` equal to the recomputed
txid.

The signed body includes `net: P.NETWORK` (`tx.js`), so a signature from one
network cannot be replayed onto another. **The account model has no equivalent
field** — EIP-155's chain id replaces it, which is exactly why the testnet needed
its own id (`docs/evm-spec.md` §1, [`docs/decisions.md`](docs/decisions.md) §1.9).

### 5.3 Difficulty — LWMA, and `MIN_TARGET`

`Chain._nextTarget` (`chain.js`) is branch-aware: it walks back from a
given parent, takes up to `LWMA_WINDOW` = 60 solve times, clamps each solve to
`[1, 6 × TARGET_BLOCK_TIME]`, takes a linearly-weighted average, scales the
arithmetic mean of the window's targets by `avgSolve / TARGET_BLOCK_TIME`, and
clamps into `[MIN_TARGET, MAX_TARGET]`. Because the expected target is recomputed
per block and compared exactly (`chain.js`, and again on the fork path), **the retarget rule *is* consensus.**

`MIN_TARGET` is the difficulty **ceiling** — the hardest the chain may get. It was
~2⁻²⁰, which capped a block at ~1.1M attempts and therefore bound at roughly
300–500 cores, after which the clamp fires, blocks arrive faster than 15s, and
emission permanently accelerates because the schedule is indexed by height and not
by time. It is now `0000000000000000ffff…` — 2⁻⁶⁴, ~1.8×10¹⁹ attempts per block
(`params.js`). `node/test/unit.js` pins the property rather than the
literal: work-per-block must exceed 2⁴⁰.

**This was a hard chain break with no migration.** Any data directory holding a
block whose target was clamped at the old ceiling now fails to load, and nodes on
either side reject each other with `wrong difficulty target`. The parameter comment
prescribes `docker compose down -v` (`params.js`).

### 5.4 Addresses, hashing and records

An address is `ember1` + 40 hex of `sha256(pubkey_der)` + 6 hex of checksum
(`crypto.js`). Canonical JSON sorts object keys recursively, so every hash is
stable (`crypto.js`).

Records are the only consensus-committed place for application bytes; they live
*inside* the signed transaction body. Bounds, all consensus (`tx.js`,
`params.js`): ≤16 records per tx, ≤4,096 payload bytes per record, ≤8,192
across a tx, `app` matching `/^[a-z][a-z0-9-]{1,15}$/`, `key` matching
`/^[0-9a-z._-]{1,72}$/`, `data` an even-length lowercase hex string. Full reference:
[`docs/records.md`](docs/records.md).

The critical serialization detail: **`records` is omitted from the body when
empty** (`tx.js`). That is what keeps every pre-records transaction hashing to
the same id, and it is the root of the cross-repo skew in §11.

**Records are a UTXO construct and have no account-model equivalent.** Nothing in
`docs/evm-spec.md` carries them forward; on an EVM chain the same job is done by
contract storage and logs. `node/src/apps/chat.js` therefore has no future in its
current form, and nothing says so anywhere else.

---

## 6. Homefire — what it actually is

```
pad   = 64 KiB (8,192 × 8-byte words)              params.js, pow.js
fill  : cur = SHA256(seed); repeat 8,192×: cur = SHA256(cur); take cur[0..8] into pad
walk  : acc = SHA256(seed ‖ pad[0..64])
        repeat 256×:  idx = acc.readUInt32LE(0) % 8192
                      acc = SHA256(acc ‖ pad[idx*8 .. idx*8+8])
                      pad[idx] ^= acc[0..8]          ← read-write, not read-only
out   = SHA256(acc ‖ pad[last 64 bytes])
```
(`node/src/pow.js`; walk-step count at `params.js`.)

One attempt is roughly 8,450 sequential SHA-256 compressions and touches the whole
pad. Dev sizes are 64 KiB / 256 steps; the comment records intended production
sizes of ~2 GiB and 2048+ steps (`params.js`).

**The properties this has:** memory-hard (every attempt must fill and then randomly
read *and rewrite* a scratchpad, so the walk is unskippable); CPU-friendly and
ASIC-resistant (the bottleneck is commodity memory latency, not gate count); and
**work handed to a hasher cannot be redirected** — the winning digest must be signed
by the coinbase key, and `verifyPow` requires the coinbase's first output to pay the
address derived from that key (`node/src/block.js`).

**The property it does NOT have — non-outsourceability.** `powSeed` binds
`(headerCoreHash, nonce, coinbasePubHex)` — only the coinbase **public** key
(`pow.js`). The private key is used exactly once, *after* a nonce has already
won, to sign the digest (`node/src/miner.js`). So a pool operator can distribute
`coreHash` together with its own pubkey, collect `(nonce, digest)` pairs from hashers
who genuinely cannot steal the reward, and sign the blocks itself. Making that
impossible requires the private key inside the hash loop, which forks the chain and
breaks the CI-conformance-tested browser miner — so it is a recorded open decision,
not an oversight (`pow.js`).

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

HTTP on `DEFAULT_RPC_PORT` 8645 (`params.js`). CORS is `*` on every response
(`rpc.js`). There is no authentication of any kind. **This surface belongs to
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
(`rpc.js`).

### POST routes

| Route | Behaviour |
| --- | --- |
| `/tx` | Accepts `{tx}` or a bare tx. Validates into the mempool and gossips it |
| `/mining/submit` | `{templateId, nonce, powDigest, powSig}`. 200 accepted; **409** for every way work goes stale — expired, evicted, or the tip moved — because the miner did nothing wrong and should refetch; 400 only for a malformed field or an id this node never issued (`retiredtemplates.js`) |
| `/rpc` | A **legacy** `{method, params}` shape: `getinfo`, `getbalance`, `getblockcount`, `sendtx` (`rpc.js`). Anything else returns `{err:'unknown method'}` at HTTP 200 |

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
(`repos/forge-pay/services/pay/src/chains.ts`). EMBER's depth
there is **60 blocks**, which matches what
[`docs/exchange-integration.md`](docs/exchange-integration.md) §4 publishes.

That file also records what it is waiting on: the RPC endpoint
(`chains.ts` — *"Every EMBER probe and payment will fail until it is
repointed"*). So the estate's payment rail is already built against a chain this
repository has not yet produced a block on.

---

## 8. P2P (`node/src/p2p.js`)

Plain TCP, newline-delimited JSON, no dependencies. Default port 8646
(`params.js`). **UTXO-era in origin**, but what a block *is* now sits behind a
three-function `wire` seam (`p2p.js,63`) that `src/evmnode.js` supplies for the
account model, so both chains gossip through this one implementation.

**Messages.** `hello {net, genesis, chainId, commonsAddress, height, tip}`,
`getblocks {locator}`, `getblock {id}`, `blocks {blocks[]}`, `block {block}`,
`tx {tx}` (`p2p.js`).

**Handshake.** `hello` carries the network id **and the chain's identity**; a
mismatch on any of them drops the peer immediately, with a log line naming both
values (`p2p.js`). `net` alone is a label two incompatible chains agree on
for free — the genesis hash is the identity, and `chainId`/`commonsAddress` ride
alongside because block 0 does not hash them (`p2p.js`), so a shared genesis is
not by itself a shared chain. A hello with no genesis hash is dropped: fail closed.
Sync is negotiated on *any* tip the node does not hold, not merely a taller one —
the fix for equal-height peers on different branches splitting forever
(`p2p.js`).

**Sync.** A locator of exponentially-spaced hashes is built back from the heaviest
*stored* branch, always ending at genesis. It is memoized on `(tipId, store.size)`
so a peer spamming invented tips cannot buy an O(chain) walk per message
(`p2p.js`). At most `P2P_MAX_BLOCKS` = 200 per round trip. `getblock` by
hash exists specifically so a side-branch block can be fetched at all, which
height-based paging structurally cannot do.

**Orphans.** Held, capped at `P2P_MAX_ORPHANS` = 32 with oldest-first eviction, and
connected transitively once an ancestor lands.

**Fork choice and reorg.** `Chain._ingest` has a fast path for extending the active
tip and a fork path otherwise (`chain.js`). On the fork path the proof is
verified **before** `_stateAt` replays the UTXO set from genesis, so a remote peer
cannot buy a full replay with an unproven block. Cumulative work is
`Σ 2²⁵⁶ / (target+1)`, and the heaviest branch wins. A reorg also *unwrites*
records — a message on an orphaned branch was never sent as far as the chain is
concerned (`chain.js`).

**The peer verification budget.** One PoW verification is a full Homefire
evaluation, so an unmetered peer could pin a core with junk that fails the very
check it paid for. `_acceptFrom` (`p2p.js`) takes a token before the work
and **refunds it** when the block turns out to be useful or to have cost no hashing
at all — so honest initial sync never touches the limiter while junk keeps its
token. `P2P_BLOCK_VERIFY_BURST` = 200 refilling at 25/s, and
`P2P_MAX_INVALID_BLOCKS` = 16 before disconnection (`params.js`).

**Tested over real sockets.** `node/test/p2p-fork.js` stands up two real `Node`
instances with real TCP and RPC servers, partitions them, mines competing branches,
reconnects, and requires the lighter node to reorg onto the heavier tip. 34/34
(measured 2026-08-09), in CI.

---

## 9. Wallets, miners and the CLI

### 9.1 The self-custody wallet — now `micro-hearth-wallet-core`

**The browser wallet left this repository on 2026-08-04 (`48bc28a`).** `web/wallet.html`
and `web/assets/wallet/` are gone. The successor is
[`micro-hearth-wallet-core`](https://github.com/cloudsforge-online/micro-hearth-wallet-core),
a zero-dependency TypeScript signing library, with
[`micro-wallet-extension`](https://github.com/cloudsforge-online/micro-wallet-extension)
as the MV3 browser surface on top of it. The library is shared across Tauri desktop,
React Native mobile, three MV3 browsers and the `hearth` CLI.

**Why this section still matters to this repository: the successor is gated against
`node/src`, and more strictly than the deleted one was.** The old `wallet-selftest.js`
compared two implementations over random inputs and claimed 141 checks. That number is
**not carried over** — it described a file that no longer exists, and repeating it here
is exactly how a stale citation is born.

What replaced it is stronger in a specific way. `test/hearth-oracle.ts` in the successor
`createRequire`s this repository's own CommonJS modules — `crypto/keccak.js`,
`crypto/rlp.js`, `crypto/secp256k1.js`, `chain/transaction.js` and `cli/keystore.js` —
and **executes them in-process** as the oracle. It locates them via `HEARTH_NODE_SRC` or
a sibling `hearth/node/src` checkout, and it **fails rather than skips when the node is
absent**, on the stated reasoning that a suite which quietly skips its only external
check "would go green in CI having verified nothing".

The comparisons that bear on `node/`:

| Claim checked against `node/src` | Where |
| --- | --- |
| keccak256 agrees at every length across the rate boundary | `test/oracle-primitives.test.ts` |
| RLP encodes byte-identically, and rejects the same non-canonical forms | |
| signatures are byte-identical and each recovers to the same key | |
| public keys, addresses and contract-creation addresses re-derive identically | |
| a keystore record this library seals is opened by `node/src/cli/keystore.js`, **and the reverse** | `test/oracle-keystore.test.ts` |
| the PBKDF2 iteration count matches the node's 600,000 (`node/src/cli/keystore.js`) | `test/oracle-keystore.test.ts` |
| a testnet-signed transaction is refused by the node as a mainnet one | `test/oracle-transaction.test.ts` |
| the node refuses an EIP-1559 envelope — which is why the successor marks Hearth as having no base fee | `test/oracle-transaction.test.ts` |

The rule the old self-test could not state is stated there: nothing is compared against a
fixture the library produced itself.

> **This repository is a load-bearing dependency of that suite.** A change to
> `node/src/crypto/`, `node/src/chain/transaction.js` or `node/src/cli/keystore.js` that
> alters a byte will turn `micro-hearth-wallet-core` red. That is the intended direction —
> the node is the oracle "precisely because it is not ours to adjust when the test goes
> red" — but it means a consensus-relevant edit here has a consumer that will notice.

**The history worth keeping.** The original cross-check earned its keep on its first run
(`a670a8a`): the node's "already normalised?" fast path asked only whether `nonce` was a
`BigInt`, which is safe for a node reading a decoded transaction and wrong for a wallet
building a draft, where `data.length` counted hex characters and charged 192 gas too much
for a 10-byte payload. **The bug was in the node, and a second implementation is what
found it.** That is the argument for keeping the successor's oracle pointed here.

**The clean break still stands.** The wallet was Ed25519, `ember1…` and UTXOs; it is now
secp256k1, `0x…` and 18 decimals. There is no migration path and deliberately no export
machinery for one, because an Ed25519 key names no account on an EVM chain and nobody
holds EMBER.

### 9.2 The browser miner — deleted here, restored elsewhere two days later

**`web/mine.html` and `web/assets/mining/` were deleted on 2026-08-04 (`48bc28a`), and
this section said "nothing in this estate mines in a browser tab any more, and that is
deliberate" until 2026-08-09.** It was wrong from 2026-08-06, when
[`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site)
restored the miner as `src/mining/{sha256,homefire,miner,worker}.js` — the same code
rather than a rewrite — and served it from its public `/mine` page.

Mining you can run from **this** repository:

| How to mine | Where |
| --- | --- |
| Command line, light miner over HTTP | `node/bin/hearth-mine.js` |
| Desktop app for macOS, Windows and Linux (Tauri) | `app-desktop/` — §3.7 |
| Full node that validates what it mines | `hearthd --evm --mine` |

**Why it was not worth carrying.** The browser miner signed its proofs in a 64-byte
form with no recovery id, on the reasoning that the header already carried the coinbase
key. The node had chosen the **65-byte recoverable form** — `r || s || recoveryId`,
`node/src/chain/header.js` — because `verifyPow` recovers the signer from the
signature rather than trusting a key supplied alongside it. So every block the browser
miner ever found was answered `bad signature`: after all the work, and indistinguishable
from bad luck.

The form was named in a constant precisely so that a mismatch would be "a grep, not an
investigation" — and the constant was faithfully kept in sync with the **wrong** answer,
which is the limit of what a constant naming a format can do.

> **The honest version of this history.** The 64-vs-65 defect *was* fixed, on the last
> night the tree existed — but the fix landed in code nothing executed, which is what
> settled the argument for deleting it rather than maintaining it. The lesson is not
> "the miner was broken"; it is that a front end nobody runs will absorb real fixes and
> return nothing for them.

**The conformance gates: two restored, one not.** `node/test/browser-pow.js`,
`node/test/browser-proof.js` and `node/test/mining-api.js` all imported
`web/assets/mining/` and were removed in `48bc28a`.

- `browser-pow.js` and `browser-proof.js` are **back as of 2026-08-09**, pointed at
  `micro-network-site/src/mining/` instead. The first compares the hash loop digest for
  digest; the second drives that repository's own `proofSignature` through this node's
  template flow and requires a block. They are not in `npm test` — that has to pass on
  a bare checkout of this repository — so they run in the `browser` CI job, which
  checks the other repository out first, and they fail rather than skip when it is
  absent. Measured 2026-08-09 against `micro-network-site` at `489903f`: 11/11 and
  12/12.
- `mining-api.js` is **not restored and has no successor**. The node's `/mining/*` path
  is covered by suites that test the node rather than a browser port of it: `evmchain`,
  `mine-session`, `miner-cli`, `mining-budget` and `mining-stale`
  (`node/package.json`).

**Between 2026-08-06 and 2026-08-09 there was a live browser miner and no
cross-check at all**, while this section, SECURITY.md, `rust/README.md`,
`docs/why-two-implementations.md`, `node/README.md`, `docs/listing-checklist.md` M16
and two source comments all cited the deleted suites in the present tense. The signing
path **inside this repository** is `HDR.signProof`, used by `node/src/chain/miner.js`
and `node/src/mine/session.js`; the browser's is its own, which is precisely why the
comparison has to exist.

**Which endpoint, because there are two chains here.** `GET /mining/template?pub=` on the
**UTXO** REST server still requires an 88-hex SPKI DER Ed25519 key
(`node/src/rpc.js`), and always will — that is the other chain. The light miners
above talk to the **account model**'s REST server (`node/src/evmnode.js`), which takes a
65-byte uncompressed secp256k1 key (`node/bin/hearth-mine.js`).

`/mining/submit` **does not trust the submission**: only `nonce`, `powDigest` and
`powSig` are taken from it; the header core and the transactions come from the
stored template, staleness is checked against the current tip, and the chain
revalidates everything anyway. A template lives `TEMPLATE_TTL_MS` (120 s) and the
map is capped at `MAX_TEMPLATES` (256) with oldest-first eviction.

**A template that is gone still answers for itself, and that is a status code, not
a nicety.** Expiry, eviction and a moved tip all answer **409** with
`{ stale: true, reason }`; a malformed field or an id this node never issued
answers **400**. The two mean opposite things to a miner — 409 is "refetch and
carry on", 400 is "you have a bug, stop" — and `node/src/mine/session.js` and the
network site's browser miner both act on exactly that difference. Until
2026-08-09 a template that had LEFT the map could not reach the stale branch at
all, so expiry and eviction answered 400 (`micro-org#237`, four of them measured
in a browser against the public testnet). `node/src/retiredtemplates.js` keeps a
bounded ring of retired ids to close it, is shared by both `Templates` classes so
they cannot drift, and names what it cannot do: an id retired long enough ago is
forgotten and reads as never-issued again. `node/test/mining-stale.js` asserts
the four answers over real HTTP against both nodes.

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
and a syntax error in one command cannot stop the others (`bin/hearth.js`).
Exit codes are part of the interface: 0 succeeded, 1 the thing you asked about
failed (a revert, an unreachable node), 2 you asked wrongly.

**The tracer is not a phase-8 nicety.** `src/cli/trace.js` is 878 lines and was
built *during* phase 3, alongside the interpreter, for a selfish reason: when a
`GeneralStateTests` vector fails, the difference between a good afternoon and a lost
week is whether you can see the exact opcode where our stack diverged from the
reference (`docs/evm-spec.md` §8).

Note `HEARTH_RPC_URL` still defaults to `http://127.0.0.1:8645`
(`node/src/cli/client.js`),
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

- ~~**Nothing produces an account-model block.**~~ Closed, and then published.
  `node/src/evmnode.js` constructs and mounts `node/src/jsonrpc/server.js`
  over a real account-model chain, and mainnet — chain id 7411 — serves it at
  `https://rpc.cloudsforge.online`. What is still true of §4 is narrower, and
  narrower than it was: its vectors and fixtures remain the bulk of the evidence,
  but the public chain is no longer contributing nothing to them. Measured by
  walking every block from 1 to 6,872 on 2026-08-08 UTC, mainnet is **four days
  and two hours old** and holds **21 transactions** — not the **zero
  transactions** this bullet claimed for its first four days — of which **nine
  are successful contract creations** (receipt `status: 0x1`, about 1,358,000 gas
  each, 6,007 bytes of runtime code apiece) and twelve are plain value transfers.
  What survives without qualification is the last clause: **no block has ever
  been produced at production proof-of-work parameters** — the pad is still
  64 KiB and the walk still 256 steps, everywhere, and nothing about 2026-08-10
  changed that. What this bullet used to offer as its evidence, `difficulty:
  0x100` on the latest block, is **no longer evidence and no longer true**: the
  chain left the floor that evening and difficulty is now a live reading. §1 has
  it, and is the only place that states it.
- **§2's "Any deployed contract of record — still none" row and the chain now
  disagree, and the row is deliberately left standing.** Deciding what "of
  record" is meant to cover is not a measurement, so it is not made here; the
  measurement that forces the decision is, because a fact that lives only in an
  agent's scrollback is a fact this file has already lost once. The nine
  creations above are nine **`ForesightMarket`** instances —
  `foresight/src/contracts/ForesightMarket.sol`, a different repository in this
  estate — mined into blocks 238 to 251 between 22:22 and 22:33 UTC on
  2026-08-04, and live at `0x49408b99…`, `0xf8202a8f…`, `0x541c29de…`,
  `0xbff77573…`, `0xae5d2dd3…`, `0x4177304b…`, `0x2acc6fd3…`, `0x3bb8e307…` and
  `0xe1b7955a…`. They are identified rather than guessed: every one answers
  `treasury()` → `0x76C853d699B17106E5e15d7D40A38F2238cb246c`, the live mainnet
  value `deploy/docs/house-seed.md` documents, `oracle()` →
  `0x2c71eb5753e7d08929d2ec14b303a5f5b3b0b9ca` and `feeBps()` → 200, and each
  carries a **distinct** `questionHash()` and `closeTime()` — so this is nine
  real markets, not one deployment probe run nine times. All nine read `state()`
  → `0` (`Open`) over an empty pool, so they are deployed and reachable and
  nothing has ever been staked into one. **The failure mode worth naming: no file
  in any repository in this estate records these addresses.** Grepping the whole
  estate for them returns nothing; the only place they are written down is the
  `markets.contract_address` column created by `foresight/src/migrations.ts`,
  which exists solely in the running service's database on the deployment host.
  Nine contracts are live on a public chain and the source tree cannot name one
  of them.
- ~~**The browser miner and the node disagree about the coinbase key.**~~ Closed,
  and both bullets here were reading the wrong chain. `node/src/rpc.js`
  and `node/src/block.js` are the **UTXO** REST server and the **UTXO** block
  rules; they require Ed25519 and always will, because that is a different chain
  with a different curve. The browser miner talks to the account model, whose
  `issue()` (`node/src/chain/miner.js`) has always required a 65-byte
  uncompressed secp256k1 key. The real defect was one byte of signature — 64 sent
  against 65 required — and it is fixed (§9.2). Four documents said this; none of
  them said it after reading `chain/miner.js`.
- **The desktop app.** `start_node` / `stop_node` / `node_running` have zero
  callers, and `node_entry()` cannot resolve inside a bundle.
- **On-chain encrypted chat is CLI-only** — and records, which it is built on, have
  no account-model successor at all (§5.4).
- **API surface nothing in-repo consumes.** `POST /rpc`
  (`getinfo`/`getbalance`/`getblockcount`/`sendtx`) has no in-repo client.
  `/mempool` is read by no in-repo client. Since `web/` was deleted there is **no
  explorer surface in this repository at all**, so records and the mempool have none
  either — and neither does anything else.
- **The `eth_*` JSON-RPC server mounts on port 8545, path `/`** — settled, and
  implemented by `node/src/evmnode.js` for `hearthd --evm` (`docs/evm-spec.md`
  §6). It is a different PORT from the REST API, not a different path, because
  `node/src/rpc.js` owns `POST /rpc` with the legacy `{method:'getinfo'}`
  shape. A client that sends `eth_*` to the REST port is answered with a pointer to
  the right port rather than `{"err":"no route"}` (`node/src/evmnode.js`).
  CF-13 was exactly this mistake made in a deployment: the explorer defaulted to the
  REST prefix, asked it for `eth_*`, and correctly reported "answered, but not with
  JSON-RPC 2.0" against a perfectly healthy chain. §3.4.
- **There is no payment SDK, and now not even a mockup of one.** `web/pay-demo.html`
  built a real `hearth:` URI and then **simulated** settlement on a 1,200 ms timer,
  with a txid deliberately not 64 hex characters so it could never be mistaken for a
  real one. It was deleted with `web/` in `48bc28a` and nothing replaces it. The gap
  it stood in front of is unchanged: **no merchant handoff exists.**
- **The Rust core** — §3.3. Also `src/tab.rs` (payment channels), `src/netmsg.rs`
  and `src/mempool.rs` are libraries wired to nothing but the self-check.
- **Chain replay is silent about rejects.** `Chain.load()` re-validates every
  persisted block through `_ingest(…, persist=false)` and discards the return value
  (`chain.js`), so a data directory containing an invalid block loads a
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
cloning the repository into an empty directory and running `npm test`. **Re-run
2026-08-09** on the merge of this branch with `main`, still with no corpus, no
`node_modules` and no network: all **39** suites pass, exit 0. `blake2f` reports
50/50 offline and 53/53 once the corpus is fetched — §4.2 for the whole table.

**The defect that used to block wiring the EVM to a block is fixed and gated.**
[`docs/robustness-review.md`](docs/robustness-review.md) §1 measured `StateDB`
re-rooting *both* tries on every single mutation, so one 30M-gas transaction cost
**443 MB of permanently retained heap and 65 seconds of single-threaded CPU
against a 15-second block time**. `trie.js` now leaves rebuilt nodes unhashed
until `root()` (`_commit`) and `statedb.js` writes dirty accounts into the state
trie at the same point (`_flush`). The same transaction measures **5.2 s and
9.2 MiB** — 13.5x an ordinary block of the same gas, against 64.3x before — and
`node/test/bench/block-execution.js` runs in the gate and fails above 25x or
64 MiB. What is still write-through is the STORAGE root, about a third of that
5.2 s; the review records why deferring it is a change to how revert works. That review also records findings **2**,
**3** and **5** as exploitable against a running `hearthd` *today* — a 39-byte
message buying a full copy of the UTXO set, an unbudgeted `tx` gossip path, and a
self-fed side branch that is stored and relayed forever.

**Two defects the fuzzer found are still open** (§4.7):

- **`RLP.decode` has no nesting cap.** `item()`/`items()` recurse once per level,
  so 7–12 KB of properly-nested input — well inside `MAX_TX_BYTES` (100,000) and
  the RPC body cap — exhausts the JS stack. Worse than the crash: the threshold
  moves with remaining stack, so the *same* input decodes from a shallow call site
  and throws from a deep one, and a `RangeError` carries no `code` for a caller to
  switch on. `Trie._deref` (`trie.js`) and `StateDB` (`statedb.js`)
  are on that path. Blast radius is limited today because
  `transaction.validate()` catches everything and reports `RLP_ERROR`. Also
  [`docs/robustness-review.md`](docs/robustness-review.md) §4.
- **`isNormalized` is still not a complete test.** It now checks `nonce`, `data`
  and `to` (`transaction.js`), which closed the gas undercharge — verified:
  `intrinsicGas` returns 856,126 for a `to: ''` draft either way. But six fields
  are still unchecked, and the divergence is demonstrable: a decimal-string
  `value` on an otherwise-normalised draft produces a **different `signingHash`**
  than the same draft normalised, because RLP reads a bare string as UTF-8.
  `isCreation({to: ''})` also still returns `false` on its own. Nothing on the
  node's own path reaches this — `decode()` normalises everything it produces — so
  it is a wallet/caller-facing footgun rather than a consensus bug.

**The `@cloudsforge/hearth-node` version skew.** `node/package.json` is at
**0.2.0**, whose `txBody` emits a `records` key inside the signed body whenever a
transaction carries records (`node/src/tx.js`). ForgeKeyvault deliberately
pins **`^0.1.0`**, which omits the key entirely. A record-carrying transaction
therefore hashes differently on the two builds and a signature over it is valid on
**exactly one**. Keyvault's response is to refuse `records` in EMBER signing
altogether. **Do not let a blanket re-lock pull that dependency forward.**

**The published package does not export the EVM.** `node/package.json`
exports six UTXO-era modules and nothing under `crypto/`, `state/`, `evm/`,
`chain/` or `jsonrpc/`. Anything downstream wanting the transaction encoder — the
RPC probe does, and so does ForgeKeyvault eventually — must reach past the export
map or vendor it.

**`proto/emission.js` is a model, not the schedule.** It computes
`R0 · 2^(−h/HL)` in floating point; consensus computes a deterministic integer
schedule with linear interpolation inside each epoch (`node/src/params.js`).
Year one differs by ~3.5% — **11,045,161 EMBER** from consensus against
**10,667,873** from the model. [`docs/tokenomics.md`](docs/tokenomics.md) §3 carries
the consensus numbers and is the file to use.

**Other constraints and gaps:**

- **`SPARKS_PER_EMBER` is still 1e8** (`node/src/params.js`) while every document
  integrates against 18 decimals. Specified, not implemented.
- **`GET /address/:addr` is O(UTXO set) per call**, unauthenticated and under
  CORS `*`. `Chain.balance` and `Chain.supply` are the same shape, and `/supply`
  calls `supply()` twice per request.
- **`/blocks` `reward` is the miner's cut, not the subsidy** — it reads
  `txs[0].outputs[0].amount`, which is `subsidy − commons + tips`. `/supply`'s
  `blockReward` is the full subsidy at height+1. Two different quantities.
- **`/supply`'s `circulating` includes the Commons treasury.** Aggregators must
  compute `circulating − commonsTreasury` ([`docs/tokenomics.md`](docs/tokenomics.md) §7).
- **The PoW parameters are not "dev-tuned pending a raise".** `POW_SCRATCH_KIB`
  64 is what mainnet launches with: 2 GiB was measured at 185.7 s per evaluation
  against a 15 s block interval, and `params.js` now refuses to start above
  `POW_MAX_SCRATCH_KIB` 4096 ([`docs/pow-parameters.md`](docs/pow-parameters.md)).
  `COINBASE_MATURITY` 10 is read only by the retired UTXO path — the account
  model has no maturity rule.
- **No authentication anywhere on the RPC.** No API key, no rate limit beyond the
  body cap. The node is meant to sit behind a proxy. **This repository no longer ships
  one** — `web/nginx.conf` went with `web/` in `48bc28a` — so the proxy is now the
  deployment's responsibility, and an exposed node has nothing in front of it by default.
- **Persistence is an append-only NDJSON file** (`chain.js`), never rewritten
  and never compacted. Forked blocks are appended too.
- **The whole chain state is in memory** — `store`, `utxo`, `txIndex` and
  `recordIndex` are all `Map`s, and `_reindex` on every reorg walks the full chain.
- **`ember1commons…` is not a checksummed address** (`params.js`). Under the
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

Fetching it also takes `blake2f` from 50/50 to 53/53 and `bn128` from 81/81 to
86/86, running its one skipped case (§11).

**CI** (`.github/workflows/ci.yml`), seven jobs:

| Job | What it runs |
| --- | --- |
| Node reference client | `npm test` — **one command, not a list**, so a new suite is covered the moment it is added to `package.json` (`ci.yml`). Plus the coinnomics model sanity check |
| Rust production core | `cargo fmt --check`, `clippy -D warnings`, build, test |
| Browser miner vs this node | **Added 2026-08-09.** Checks out [`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site) and runs `npm run test:browser` against it — `browser-pow` (11) and `browser-proof` (12). They **fail rather than skip** when that checkout is missing, which is the whole point: for three days there was a browser miner on the public `/mine` page and nothing comparing it to this node, while six documents said otherwise — §9.2 |
| Web assets | ⚠️ **Runs nothing.** The syntax check, explorer self-test and wallet self-test that stood here all read `web/assets`, and went with it in `48bc28a` (`ci.yml`). The job still checks out the repo, reports green, and gates nothing. Its remaining body is a comment recording where the wallet gate went — §9.1. **A green job that executes no assertion is worth deleting rather than reading as a pass** |
| Secret hygiene | `.env` untracked; no API tokens; a private-key matcher that requires a PEM header **followed by real base64** rather than the header alone, so a bare PEM literal in source cannot force the check to be muted (`ci.yml`) |
| DeFi contracts | `pnpm compile` (which refuses on an init-code-hash mismatch) and the build tests |
| Developer kit | The faucet's 66 checks; `tools/explorer-api`'s 177 fixture checks **and its 27-check live-chain gate**; `tools/verify`'s 116; the templates and probe parse; the probe boots and answers the chain id in both encodings. Every step carries `if: ${{ !cancelled() }}`, because one failing step used to skip every step after it |

**One CI job is failing on `main`, and it is a different one from the job this
paragraph used to name.** The *DeFi contracts* failure recorded here
(`Error: No pnpm version is specified.`) is **fixed** — that job passed on run
[30918746545](https://github.com/cloudsforge-online/hearth/actions/runs/30918746545),
as did *Developer kit*, *Rust production core*, *Web assets* and *Secret hygiene*.
What is red now:

| Job | Failure | Is it an implementation failure? |
| --- | --- | --- |
| Node reference client | `node/test/mine-session.js` — `FAIL — 68/71 checks`, on the group *"but real refusals do stop it, rather than burning a core into a wall"* | **No — it is a flaky deadline.** The check races a real proof-of-work search against a fixed 20-second wall clock (`node/test/mine-session.js`). A win is geometrically distributed, so on a slow runner the search simply has not finished and the assertion reports `TIMED OUT`. The sibling group immediately above it allows 120 seconds for the same kind of wait |

**It was a deadline, not a defect, and it is fixed.** `node/test/mine-session.js`
raced a **real proof-of-work search against a 20-second clock**, and it had to win
five times before its assertion could hold (`sess.refused === 5`). A win at
`MAX_TARGET` is 256 expected evaluations and the distribution is geometric, so on a
slow runner the search had simply not finished — and the test then reported the
session as "mining forever" when it was still working.

The signature was unmistakable once both sides were measured: **red on CI twice
running (30918746545, 30922381837) while passing locally on two runs out of three**,
with nothing in `node/src/mine/session.js` differing between them. The failing count
even varied between runs — "after exactly 2 refusals", then "3" — because the message
interpolates however far the search had got.

The deadline is now **120 seconds, the same budget the group immediately above it
already allows**, whose own comment states the rule this assertion was not
taking: *wait for the event, not for the clock*. The guarantee is
unchanged — it still distinguishes a session that stops itself after five refusals
from one that grinds forever.

> **The benchmark beside it is healthy, and an earlier note here was wrong about
> that.** `node/test/bench/block-execution.js` asserts that widening the state
> trie 5× costs **< 1.15×** the time. It measured 1.18× once and was briefly recorded
> here as a second flaky threshold — but that reading was taken while two other test
> suites were running on the same machine. Four clean sequential runs measured
> **0.94×, 1.05×, 1.03× and 1.00×**. The bound is not marginal; the measurement was
> contended. Recorded because a wrong diagnosis left standing is worse than no
> diagnosis.

**A red step used to disable the steps after it.** Actions skips the rest of a
job at the first failure, so for as long as the explorer API step was red,
*Contract verification*, *Templates and probe parse* and the probe-boot check
never executed — `tools/verify`'s 116 checks had never gated a push. Every step
in that job now carries `if: ${{ !cancelled() }}` and reports its own result.

**Deploys.** **This repository publishes no web surface.** The Pages workflow that
served `web/` was removed in `88a1552` and `.github/workflows/pages.yml` no longer
exists; the `hearth-web` and `hearth-site` publish-matrix entries went with `web/` and
`site/` in `48bc28a`. What remains is `.github/workflows/publish.yml`, which builds the
node images. Already-published `hearth-web` and `hearth-site` tags were **left in the
registry on purpose** — deleting a published tag breaks anyone who pinned it — so their
presence there is history, not a live deploy.

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
