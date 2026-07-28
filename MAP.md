# Hearth — application map

What is in this repository, what each part actually does, and what it does not
do. Every claim below was checked against source and cites `path:line`. Where
this contradicts `README.md`, `WHITEPAPER.md`, `TESTNET.md` or `docs/`, believe
this file and the line it cites.

---

## 1. What this is

Hearth is a proof-of-work cryptocurrency. The network is called `hearth`, the
coin is **EMBER**, and the smallest unit is a **spark** — 1 EMBER = 100,000,000
sparks (`node/src/params.js:9-11`). It is a UTXO chain with Ed25519-signed
inputs, 15-second target block times (`params.js:14`) and a memory-hard
proof-of-work called **Homefire** (`node/src/pow.js:29-42`).

Emission is a deterministic integer schedule: 6 EMBER at genesis, decaying with
a 2-year half-life, interpolated linearly inside each epoch, floored at a
perpetual 0.3 EMBER tail (`params.js:19-21`, `params.js:140-151`). 10% of every
subsidy is paid to an on-chain Commons address
(`params.js:22`, `params.js:127`, enforced at `node/src/chain.js:306-313`). There
is no premine: genesis pays amount 0 to the Commons address and creates no
spendable supply (`chain.js:58-70`, asserted at `node/test/unit.js:100`).

Every transaction burns a flat base fee of 40,000 sparks plus 100 sparks per
byte of application-record payload; only the *excess* above that is a miner tip
(`params.js:25-29`, `node/src/tx.js:24-26`, `chain.js:304`).

**Its role in the estate.** Hearth is the `mine` verb of the CloudsForge spine
(mine / trade / mint / spend / play) and the funding rail for the rest. EMBER
mined here is deposited to a Forge Pay address and converted to Shards, which
every other product bills in. The concrete coupling is one REST route: Forge Pay
reads `GET /address/:addr` and credits a deposit only from UTXOs at or past the
declared confirmation depth, honouring the `spendable` flag
(`repos/forge-pay/services/pay/src/chains.ts:126-180`). Section 5 documents that
route as the contract it is.

---

## 2. Component inventory

| Directory | What it is | Status |
|---|---|---|
| `node/` | The reference full node, wallet, miner, P2P and REST API — JavaScript, zero dependencies | **This is the network.** Real and working |
| `rust/hearthd/` | A self-check binary and a Homefire benchmark over some library modules | **Not a node. Not consensus.** Two known divergences — see §2.2 |
| `proto/` | Two teaching scripts: an emission model and a toy PoW miner | Prototype, runnable, not wired to anything |
| `site/` | React + Vite marketing site for hearth.cloudsforge.online | Ships; brand-aligned; copy has been corrected against the code |
| `web/` | Static block explorer, non-custodial browser wallet, browser miner, merchant-button mockup | Ships; served by nginx and by GitHub Pages |
| `app-desktop/` | Tauri v2 shell | **Unshipped scaffolding.** Its three native commands have zero callers |
| `docs/` | Nine design/architecture documents | Prose only |
| `branding/` | Complete asset set: favicon, mark, wordmark, og, social | Complete |

### 2.1 `node/` — the real full node

One process is a full node, a wallet and a miner (`node/src/node.js:27-41`).
Files:

| File | Responsibility |
|---|---|
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
| `src/rpc.js` | HTTP REST + JSON-RPC + SSE |
| `src/wallet.js` | Local keys, coin selection, tx building |
| `src/box.js` | X25519 → HKDF → AES-256-GCM sealed boxes |
| `src/apps/chat.js` | An application built entirely out of records + sealed boxes |
| `bin/hearthd.js` | Node entrypoint |
| `bin/hearth-cli.js` | Wallet/query CLI |
| `bin/hearth-chat.js` | Encrypted chat CLI |

Published to npm as `@cloudsforge/hearth-node`, currently **0.2.0**
(`node/package.json:2-3`), exporting `.`, `./crypto`, `./chain`, `./tx`,
`./wallet` and `./params` (`node/package.json:13-21`). See §9 for the version
skew this creates.

### 2.2 `rust/hearthd/` — a self-check and a benchmark, NOT consensus

**Do not read this crate as a second opinion about what a valid block is.** It
has no block type, no chain, no fork choice, no storage, no RPC and no P2P
server; `main.rs` runs a self-check over the library modules and then benchmarks
Homefire against a stand-in header literal (`rust/hearthd/src/main.rs:28-102`,
`:122`). Nothing in the directory has ever accepted a block, because there is
nothing there to accept one into.

Two modules would produce the **wrong answer** if wired up:

1. **`pow.rs` omits the coinbase public key from the seed.** Consensus binds
   `(headerCoreHash, nonce, coinbasePubHex)` (`node/src/pow.js:45-47`); the Rust
   `homefire()` hashes whatever seed bytes it is handed, and the binary only
   ever hands it `header || nonce_le` (`rust/hearthd/src/pow.rs:31`,
   `main.rs:127-130`). Same header, different digest.
2. **`difficulty.rs` retargets ±1 leading-zero bit per block** — a factor of two
   per step, ignoring the magnitude of the miss (`rust/hearthd/src/difficulty.rs:47-53`).
   Consensus retargets a continuous 256-bit target with a 60-block LWMA
   (`node/src/chain.js:212-235`).

The crate's own header comments say all of this
(`rust/hearthd/src/main.rs:3-20`, `pow.rs:7-15`, `difficulty.rs:7-17`,
`rust/README.md:1-17`). What it does have that is real: a pure-`std` SHA-256
tested against FIPS vectors (`src/sha256.rs`), an emission schedule that matches
consensus, and unwired libraries for the ledger, mempool, P2P framing and Tab
payment channels (`src/lib.rs:15-22`). CI builds it under
`cargo clippy -- -D warnings` and runs its tests
(`.github/workflows/ci.yml:48-66`) — a green Rust job says nothing about
consensus.

### 2.3 `proto/` — teaching artifacts

`proto/emission.js` reproduces the numbers in `docs/coinnomics.md` and is run in
CI as a sanity check (`.github/workflows/ci.yml:45-46`). `proto/pow.js` +
`proto/mine.js` are a minimal model of memory-hardness and of the
signature-binding property. `proto/pow.js:19-25` states plainly that this is not
non-outsourceability. Not consensus, not imported by the node.

### 2.4 `site/` — marketing

React + Vite. All copy is centralised in `site/src/lib/hearth.ts`, which carries
inline notes recording exactly which claims were corrected and why
(`site/src/lib/hearth.ts:114-124`). The current copy says Homefire is
memory-hard and that *work handed to a hasher cannot be redirected*, and
explicitly declines to claim non-outsourceability
(`site/src/lib/hearth.ts:128-133`). It also correctly labels Tab payment
channels as a signed state machine in the Rust core rather than something you
can spend through (`:72`).

### 2.5 `web/` — explorer, wallet, miner, merchant mockup

Static pages, no build step, served by nginx (`web/nginx.conf`) or published to
GitHub Pages (`.github/workflows/pages.yml`).

| Page | What it is |
|---|---|
| `web/index.html` + `web/assets/explorer/*.js` | Block explorer for the **account-model EVM chain**, written against the `eth_*` JSON-RPC contract (`node/src/jsonrpc/methods.js`). Blocks, transactions with decoded logs and revert reasons, EOA-vs-contract addresses with disassembly, ERC-20 tokens, `eth_getLogs` search, and a `/supply` view. Hash-routed, zero dependencies, no build step. See §2.5.1 |
| `web/wallet.html` | Non-custodial wallet — generate, unlock, read balances, build/sign/broadcast |
| `web/mine.html` | Browser miner over `/mining/template` and `/mining/submit` |
| `web/pay-demo.html` | Merchant-button **mockup** — see §8 |
| `web/explorer.html` | 0-second redirect to `./`, kept so old links land |

Node URL resolution is now split by protocol, because the pages no longer all
speak one. The miner's `/mining/*` calls and the pay mockup still resolve
`?rpc=` → `<meta name="hearth-rpc">` → same-origin `/rpc` → `:8645`
(`web/assets/api.js:20-27`) and speak the REST API. The explorer and the wallet
speak `eth_*` JSON-RPC and resolve `?rpc=` → `<meta name="hearth-eth-rpc">` →
same-origin `/rpc/` → `:8545` (`web/assets/explorer/rpc.js:37-44`). Same-origin
`/rpc` is the deployed path either way and nginx proxies it
(`web/nginx.conf:63`). **Where the JSON-RPC server mounts inside the node is
still undecided and it collides with the legacy `POST /rpc` handler** — see
`docs/evm-spec.md` §6.

#### 2.5.1 The explorer

`web/index.html` is a shell; every view is an ES module under
`web/assets/explorer/`, loaded with `<script type="module">`. No framework, no
bundler, no npm dependency — deliberately, so it stays a directory of files
nginx can serve.

| Module | Responsibility |
|---|---|
| `app.js` | Hash router, boot, the search box |
| `rpc.js` | JSON-RPC 2.0 client; batches matched by id; three distinct failure types |
| `views.js` | One function per view |
| `chaindata.js` | Multi-call queries and caches; the bounded address scan |
| `abi.js` | Event/selector hashing, log decoding, revert decoding |
| `disasm.js` | EVM disassembly; a transcription of `node/src/evm/opcodes.js` |
| `keccak.js` | Keccak-256 — EIP-55 checksums, code hashes, signature hashing |
| `emission.js` | A port of `params.js:140-151`, for the supply figure |
| `format.js`, `dom.js`, `search.js` | Pure formatting, DOM builders, query shape dispatch |
| `fixtures.js` | A canned chain answering the same wire protocol; opt-in with `?fixtures=1` |
| `selftest.js` | 147 assertions, runnable as `node web/assets/explorer/selftest.js` |

**It does not invent data.** The old page fell back to a sample-data generator
when no node answered; this one renders an explicit "no node answered" state
naming the endpoint and the failure, and offers the fixture chain as an opt-in
link. Fixtures are never engaged automatically and are labelled in the mode pill,
in a banner, and on every page.

`selftest.js` cross-checks the three modules that are *copies* of something in
`node/src` — `keccak.js` against `node/src/crypto/keccak.js`, `disasm.js` against
all 256 entries of `node/src/evm/opcodes.js`, and `emission.js` against
`node/src/params.js` — so the copies cannot drift silently. The node's files are
the authority in all three cases.

### 2.6 `app-desktop/` — unshipped

A Tauri v2 shell whose `frontendDist` is `../../web` and which opens
`wallet.html` in a native window (`app-desktop/src-tauri/tauri.conf.json:6-18`).
Its three native commands `start_node`, `stop_node` and `node_running` are
registered (`app-desktop/src-tauri/src/main.rs:91`) and have **zero callers** —
the bundled pages are plain static HTML that never call `invoke`. `node_entry()`
additionally resolves `../../node/bin/hearthd.js` relative to the process CWD,
which for an app launched from Finder is never a checkout
(`app-desktop/src-tauri/src/main.rs:27-39`). The file documents its own
brokenness at `:4-18`. A restrictive CSP *is* configured — `object-src 'none'`,
`base-uri 'none'`, `frame-ancestors 'none'`, `connect-src` limited to IPC, asset
and loopback (`app-desktop/src-tauri/tauri.conf.json:21`).

---

## 3. Consensus rules

All constants live in `node/src/params.js`; all enforcement is on the accept
path in `node/src/chain.js` and `node/src/tx.js`.

### 3.1 Block validation

`Chain._validate` (`chain.js:254-318`) runs checks in a deliberate order — cheap
comparisons, then the proof, then serialization, then signature work — so that
everything an anonymous peer can make the node do is gated behind a proof it had
to pay for (`chain.js:238-253`).

| Rule | Where |
|---|---|
| height = parent + 1 | `chain.js:256` |
| non-empty, ≤ `MAX_BLOCK_TXS` (5,000) | `chain.js:257-258`, `params.js:85` |
| timestamp ≤ now + `MAX_FUTURE_DRIFT_S` (7200s) | `chain.js:262`, `params.js:96` |
| timestamp > median-time-past over 11 blocks | `chain.js:263`, `chain.js:203-207`, `params.js:97` |
| `header.target` equals the recomputed LWMA target | `chain.js:265` |
| Homefire proof verifies | `chain.js:267-268` → `block.js:39-57` |
| canonical bytes ≤ `MAX_BLOCK_BYTES` (2 MB) | `chain.js:273-274`, `params.js:94` |
| tx 0 is a coinbase with no inputs and **no records** | `chain.js:281-287` |
| no second coinbase | `chain.js:289` |
| every other tx passes `validateNormal` against a scratch UTXO | `chain.js:290-292` |
| coinbase has 1–2 outputs, each integer, ≥ 0, ≤ `MAX_MONEY` | `chain.js:299-303` |
| miner output = subsidy − commons + tips, exactly | `chain.js:304-309` |
| commons output present and exact | `chain.js:310-313` |
| total minted = subsidy + tips, exactly (**anti-inflation**) | `chain.js:314-315` |

A coinbase may not carry application records, because a coinbase is signed by
nobody and a record in one would be an unauthenticated write the miner alone
chooses (`chain.js:284-286`).

### 3.2 Transaction validation

`TX.validateNormal` (`tx.js:121-156`):

- at least one input and one output; ≤ 1,000 of each (`tx.js:122-125`, `params.js:86-87`)
- record shape/size rules (§3.5) (`tx.js:126-127`)
- serialized size ≤ `MAX_TX_BYTES` (100,000) (`tx.js:128`, `params.js:93`)
- **double-spend within the transaction**: a repeated `txid:vout` is rejected (`tx.js:133-135`)
- **double-spend against the set**: an input absent from the UTXO map is rejected — the same check covers "already spent" (`tx.js:136-137`)
- the input's public key must hash to the output's address (`tx.js:138`)
- Ed25519 signature over the canonical body, which excludes the signatures themselves (`tx.js:139`, `tx.js:36-50`)
- **coinbase maturity**: a coinbase output cannot be spent until `COINBASE_MATURITY` deep — 10 in this tree, noted as a dev value against a production ~100 (`tx.js:140-142`, `params.js:95`)
- outputs are positive integers ≤ `MAX_MONEY` (`tx.js:146-150`, `params.js:84`)
- fee = inputs − outputs must be ≥ base fee + data fee (`tx.js:151-153`)
- the declared `tx.id` must equal the recomputed txid (`tx.js:154`)

The signed body includes `net: P.NETWORK` (`tx.js:39`), so a signature from one
network cannot be replayed onto another.

### 3.3 Difficulty — LWMA, and `MIN_TARGET`

`Chain._nextTarget` (`chain.js:212-235`) is branch-aware: it walks back from a
given parent, takes up to `LWMA_WINDOW` = 60 solve times (`params.js:16`),
clamps each solve to `[1, 6 × TARGET_BLOCK_TIME]` (`chain.js:220`), takes a
linearly-weighted average, scales the arithmetic mean of the window's targets by
`avgSolve / TARGET_BLOCK_TIME`, and clamps into `[MIN_TARGET, MAX_TARGET]`
(`chain.js:229-234`). Because the expected target is recomputed per block and
compared exactly (`chain.js:265`, and again on the fork path at `:349`), the
retarget rule *is* consensus.

`MIN_TARGET` is the difficulty **ceiling** — the hardest the chain may get. It
was ~2^-20, which capped a block at about 1.1M attempts; at a couple of hundred
hashes per second per core that binds at roughly 300–500 cores, after which the
clamp fires, blocks arrive faster than 15s, and emission permanently accelerates
because the schedule is indexed by height and not by time. It is now
`0000000000000000ffff…` — 2^-64, about 1.8e19 attempts per block
(`params.js:57-80`). `node/test/unit.js:105-113` pins the property rather than
the literal: work-per-block must exceed 2^40.

**This was a hard chain break with no migration.** `_validate` recomputes the
expected target for every block and disk replay runs the same validation
(`chain.js:44-53` → `_ingest`), so any data directory holding a block whose
target was clamped at the old ceiling now fails to load, and nodes on either
side of the change reject each other with `wrong difficulty target`. The
parameter comment says this explicitly and prescribes `docker compose down -v`
(`params.js:71-79`).

`GENESIS_TARGET` is ~8 leading zero bits, deliberately easy so a single laptop
produces a lively local chain (`params.js:53-56`). `MAX_TARGET` (the easiest
allowed) is `03ffff…` (`params.js:81`).

### 3.4 Addresses and hashing

Canonical JSON sorts object keys recursively, so every hash is stable
(`crypto.js:8-13`). An address is `ember1` + 40 hex of `sha256(pubkey_der)` + 6
hex of checksum (`crypto.js:58-62`); `isValidAddress` verifies the checksum
(`crypto.js:64-71`) and both wallets refuse to build a payment to an address
that fails it (`wallet.js:75`, `web/assets/wallet-core.js:117`). The merkle root
duplicates the last hash on an odd layer (`crypto.js:74-87`).

### 3.5 Application records

Records are the only consensus-committed place for application bytes. They live
*inside* the signed transaction body, so they are covered by the txid, the input
signatures, the merkle root and the block hash (`tx.js:36-50`, `params.js:31-35`).

Bounds, all consensus (`tx.js:59-78`, `params.js:41-47`): ≤ 16 records per tx,
≤ 4,096 payload bytes per record, ≤ 8,192 across a tx, `app` matching
`/^[a-z][a-z0-9-]{1,15}$/`, `key` matching `/^[0-9a-z._-]{1,72}$/`, `data` a
even-length lowercase hex string, no empty records. `RECORDS_ACTIVATION_HEIGHT`
is 0 in this tree (`params.js:40`); enabling records above 0 would be a hard fork
(`params.js:36-39`).

The critical serialization detail: **`records` is omitted from the body when
empty** (`tx.js:47-49`). That is what keeps every pre-records transaction hashing
to the same id. It is also the root of the cross-repo skew in §9.

---

## 4. Homefire — what it actually is

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

One attempt is roughly 8,450 sequential SHA-256 compressions and touches the
whole pad. Dev sizes are 64 KiB / 256 steps; the comment records intended
production sizes of ~2 GiB and 2048+ steps (`params.js:50-52`).

**The properties this has:**

- **Memory-hard.** Every attempt must fill and then randomly read *and rewrite*
  a scratchpad; the read-modify-write makes the walk unskippable.
- **CPU-friendly and ASIC-resistant.** The bottleneck is commodity memory
  latency, not gate count.
- **Work handed to a hasher cannot be redirected.** The winning digest must be
  Ed25519-signed by the coinbase key, and `verifyPow` requires the coinbase's
  first output to pay the address derived from that key
  (`node/src/block.js:45-52`). A candidate built for your public key is
  worthless to anyone else.

**The property it does NOT have — non-outsourceability.**
`powSeed` binds `(headerCoreHash, nonce, coinbasePubHex)` — only the coinbase
**public** key (`pow.js:45-47`). The private key is used exactly once, *after* a
nonce has already won, to sign the digest (`node/src/miner.js:115`). So a pool
operator can distribute `coreHash` together with its own pubkey, collect
`(nonce, digest)` pairs from hashers who genuinely cannot steal the reward, and
sign the blocks itself. Making that impossible requires the private key inside
the hash loop, which forks the chain and breaks the CI-conformance-tested
browser miner — so it is a recorded open decision, not an oversight. The file
says so at `pow.js:8-15`; `block.js:4-7`, `mining.js:15-17`,
`web/assets/mining/miner.js:6-9`, `proto/pow.js:19-25` and
`site/src/lib/hearth.ts:114-133` all repeat the correction.

Homefire also **compiles nothing**. It is chained SHA-256 over a pad. Any
description of it as "RandomX-class" is wrong; a RandomX-class VM is a roadmap
item (`docs/mining.md:26-28`, `WHITEPAPER.md:27-29`).

---

## 5. REST API surface (`node/src/rpc.js`)

HTTP on `DEFAULT_RPC_PORT` 8645 (`params.js:130`). CORS is `*` on every response
(`rpc.js:19-25`) so the static pages can reach a node from anywhere. There is no
authentication of any kind.

### GET routes

| Route | Handler | Returns |
|---|---|---|
| `/info` | `rpc.js:97`, `:191-203` | `network`, `coin`, `height`, `tip`, `hashrate`, `mining`, `peers`, `mempool` size, `difficultyTarget` (the *next* target), `minerAddress` |
| `/supply` | `rpc.js:98`, `:228-240` | `circulating` (sparks) + `circulatingEmber`, `commonsTreasury` + `commonsEmber`, `burnedTotal`, `height`, `blockReward` (full subsidy at height+1) |
| `/blocks?limit=N` | `rpc.js:99-105` | `{blocks:[…]}` newest first, `limit` capped at 100, default 20. Each entry is `blockSummary` (`rpc.js:28-40`): `height`, `id`, `timestamp`, `miner`, `txCount`, `reward`, `target`, `hashPreview` |
| `/block/:idOrHeight` | `rpc.js:106-110` | The **full block object** — all-digits is read as a height on the active chain, otherwise as a block id from the store (so side-branch blocks are reachable). 404 if absent |
| `/address/:addr` | `rpc.js:111-114`, `:208-226` | `address`, `balance`, `spendable`, `immature`, chain `height`, and `utxos[]` each with `txid`, `vout`, `amount`, `coinbase`, `height`, `spendable`, `maturesAtHeight` |
| `/mempool` | `rpc.js:115` | `{size, txs:[{id, fee, size, tx}]}` (`mempool.js:67`) |
| `/tx/:txid` | `rpc.js:116-119`, `chain.js:115-126` | `{tx, height, blockId, confirmations}`; confirmations = `tip.height − height + 1`. 404 if unknown |
| `/records?app=&key=&since=&limit=` | `rpc.js:120-129`, `chain.js:129-132` | `{app, key, height, records[]}`. `app` is required and must match `APP_NS_RE` (400 otherwise); `key` must match `RECORD_KEY_RE`; `limit` clamped to 1–500, default 100. Each hit carries `app`, `key`, `data`, `txid`, `height`, `blockId`, `from` (the signer's address) and `timestamp` (`chain.js:91-105`) |
| `/mining/template?pub=` | `rpc.js:130-136`, `mining.js:42-74` | `templateId`, `height`, `coreHash`, `target`, `coinbasePub`, `coinbaseAddress`, `prevHash`, `timestamp`, `merkleRoot`, `txCount`, `reward`, `scratchKiB`, `walkSteps`, `expiresAt`. `pub` must be 88 hex chars (SPKI DER Ed25519) or 400 |
| `/events` | `rpc.js:137`, `:171-189` | SSE. Unfiltered: unnamed `data:` frames of `blockSummary` per new block. With `?app=…[&key=…]`: named `record` events only, filtered — and block frames are suppressed for that subscriber (`rpc.js:78-79`) |

Block frames are deliberately **unnamed** so `EventSource.onmessage` receives
them; naming them would silently break every existing client (`rpc.js:68-74`).

### POST routes

| Route | Handler | Behaviour |
|---|---|---|
| `/tx` | `rpc.js:141-143` | Accepts `{tx}` or a bare tx. Validates into the mempool and gossips it (`node.js:97-102`). 200 on `{ok:true}`, 400 otherwise |
| `/mining/submit` | `rpc.js:145-151`, `mining.js:96-122` | `{templateId, nonce, powDigest, powSig}`. 200 accepted, **409** when the tip moved (stale — the miner did nothing wrong), 400 for a bad proof |
| `/rpc` | `rpc.js:152`, `:242-254` | JSON-RPC-ish `{method, params}`. Methods: `getinfo`, `getbalance`, `getblockcount`, `sendtx`. Anything else returns `{err:'unknown method'}` |

`OPTIONS` on any path returns 204 (`rpc.js:87`). Request bodies are capped at
`MAX_TX_BYTES + 8,192` = 108,192 bytes, answered with 413 and then the socket is
destroyed (`rpc.js:257-290`, `:156-161`).

### The Forge Pay contract

This surface matters outside this repo. `GET /address/:addr` is what Forge Pay
reads to credit EMBER deposits at depth: it computes `chainHeight − utxo.height
+ 1` per UTXO, skips anything with `spendable === false`, and sums only outputs
at or past the declared depth
(`repos/forge-pay/services/pay/src/chains.ts:127-180`). Two Hearth guarantees
are load-bearing there: `height` is per-UTXO and set from the containing block
(`chain.js:377-378`), and `spendable` already accounts for coinbase maturity
(`rpc.js:216`). `GET /tx/:txid` exposes the same confirmation convention — the
containing block is confirmation 1 (`chain.js:124`).

---

## 6. P2P (`node/src/p2p.js`)

Plain TCP, newline-delimited JSON, no dependencies. Default port 8646
(`params.js:131`).

**Messages.** `hello {net, height, tip}`, `getblocks {locator}`,
`getblock {id}`, `blocks {blocks[]}`, `block {block}`, `tx {tx}`
(`p2p.js:274-351`).

**Handshake.** `hello` carries the network id; a mismatch drops the peer
immediately (`p2p.js:280-283`). Sync is then negotiated on *any* tip the node
does not hold, not merely a taller one — that is the fix for equal-height peers
on different branches splitting forever (`p2p.js:284-287`).

**Sync.** A locator of exponentially-spaced hashes is built back from the
heaviest *stored* branch (not just the active tip), always ending at genesis, so
a common ancestor is always found (`p2p.js:160-180`). It is memoized on
`(tipId, store.size)` so a peer spamming invented tips cannot buy an O(chain)
walk per message (`p2p.js:163-165`). A peer answering `getblocks` finds the
newest locator entry that sits on its own *active* chain and serves forward from
there, at most `P2P_MAX_BLOCKS` = 200 per round trip (`p2p.js:290-303`,
`params.js:101`). `getblock` by hash exists specifically so a side-branch block
can be fetched at all, which height-based paging structurally cannot do
(`p2p.js:305-311`). Every peer is re-polled every `P2P_RESYNC_MS` = 20s
(`p2p.js:142-152`, `params.js:103`).

**Orphans.** A block with an unknown parent is held, capped at
`P2P_MAX_ORPHANS` = 32 with oldest-first eviction (`p2p.js:183-188`,
`params.js:102`), and connected transitively once an ancestor lands
(`p2p.js:190-201`).

**Fork choice and reorg.** `Chain._ingest` has a fast path for extending the
active tip, and a fork path otherwise (`chain.js:323-370`). On the fork path the
proof is verified **before** `_stateAt` replays the UTXO set from genesis, so a
remote peer cannot buy a full replay with an unproven block
(`chain.js:346-351`); the verified proof is then handed into `_validate` rather
than recomputed (`chain.js:356`, `chain.js:250-252`). Cumulative work is
`Σ 2^256 / (target+1)` (`chain.js:201`), and the heaviest branch wins: `_activate`
rebuilds `chainIndex`, the UTXO set, the burn total and both indexes, and a
`reorg` event fires (`chain.js:362-368`, `:394-405`). A reorg also *unwrites*
records — a message on an orphaned branch was never sent as far as the chain is
concerned (`chain.js:402-404`).

**The peer verification budget.** One PoW verification is a full Homefire
evaluation, so an unmetered peer could pin a core with junk that fails the very
check it paid for. `_acceptFrom` (`p2p.js:241-272`) takes a token before the
work and **refunds it** when the block turns out to be useful (`ok`) or to have
cost no hashing at all (`known`, `unknown parent`) — so honest initial sync,
which legitimately pushes thousands of blocks, never touches the limiter, while
junk keeps its token. Two limits, from `params.js:104-123`:
`P2P_BLOCK_VERIFY_BURST` = 200 (one full page), refilling at
`P2P_BLOCK_VERIFY_PER_S` = 25/s; and `P2P_MAX_INVALID_BLOCKS` = 16, after which
the peer is disconnected. Alongside these: a 4 MiB read-buffer cap that drops a
peer sending no newline (`p2p.js:99-102`, `params.js:98`), `P2P_MAX_PEERS` = 64
(`p2p.js:80-84`), a locator length cap of 32 (`p2p.js:292`), one page in flight
per peer (`p2p.js:294`), and per-connection log deduplication so a misbehaving
peer cannot write the log as fast as it writes the socket (`p2p.js:91-94`).

**Tested over real sockets.** `node/test/p2p-fork.js` stands up two real `Node`
instances with real TCP and RPC servers, partitions them, mines competing
branches, reconnects, and requires the lighter node to reorg onto the heavier
tip with the UTXO set following (`node/test/p2p-fork.js:1-6`). It runs in CI
(`.github/workflows/ci.yml:43-44`).

---

## 7. The wallet and the miner

### 7.1 Browser wallet (`web/wallet.html`, `web/assets/wallet/`)

**Account-model, and a clean break.** The wallet was Ed25519, `ember1…` and
UTXOs; it is now secp256k1, `0x…` and `[nonce, gasPrice, gasLimit, to, value,
data]` at 18 decimals (`docs/evm-spec.md` §2–§3). Nothing carries over and
nothing pretends to: there is no migration path and deliberately no export
machinery for one, because an Ed25519 key names no account on an EVM chain and
nobody holds EMBER — the testnet is reset. The pre-EVM modules
(`web/assets/wallet-core.js`, `web/assets/keystore.js`,
`web/assets/vendor/noble-ed25519.js`) are imported by no page and survive only
because `node/test/keystore.js` still exercises them in `npm test`.

Non-custodial and genuinely so. The key is generated in the tab with
`crypto.getRandomValues` (`wallet/account.js:60`, `wallet/secp256k1.js:296-301`);
the address is `keccak256(uncompressed_pubkey[1:])[12:]`, rendered EIP-55
(`wallet/account.js:39-57`).

**The ports, and how they are held honest.** `wallet/secp256k1.js`,
`wallet/rlp.js` and `wallet/transaction.js` are browser ports of
`node/src/crypto/secp256k1.js`, `node/src/crypto/rlp.js` and
`node/src/chain/transaction.js`. `web/assets/wallet-selftest.js` runs both
implementations over the same random inputs and compares them — 200 random keys
for public keys, RFC 6979 nonces, `r`, `s`, `recoveryId` and recovery; 500 random
RLP structures; 120 random transactions for the signing hash, the signed bytes,
the transaction hash, the recovered sender and intrinsic gas — plus the EIP-155
worked example byte for byte (`wallet-selftest.js:408-560`).
`.github/workflows/ci.yml` gates on it. `wallet/sha256.js` exists so RFC 6979 can
be synchronous: WebCrypto's HMAC is a Promise, and a DRBG loop built on it would
make signing async all the way up.

**One extra check the node has no reason to make.** `signAndCheck` signs, then
decodes its own bytes back, recovers the sender from them and refuses to
broadcast unless that sender is the unlocked account and every field survived the
round trip (`wallet/transaction.js:400-433`). A node only has to agree with the
network about what a transaction *means*; a wallet decides what it *says*, and a
one-field disagreement there pays the wrong person rather than bouncing.

**Encryption at rest, versioned this time.** Keys are stored under
`hearth.wallet.v3` as `{version, curve, chainId, address, created, kdf, cipher,
iv, ct}` — the same construction as the v2 Ed25519 keystore it replaces,
PBKDF2-HMAC-SHA256 at 600,000 iterations → AES-256-GCM, WebCrypto only,
passphrase never stored (`wallet/keystore.js:93-115`). `open()` refuses any
`version` it does not recognise by number, and refuses a record whose stored
address does not match the key that comes out of it
(`wallet/keystore.js:117-153`). A `v1`/`v2` Ed25519 record is reported as
`kind: 'pre-evm'`, explained in one paragraph on the page, never read and never
deleted (`wallet/keystore.js:157-172`, `web/wallet.html:97-110`).

**The private key reaches the DOM in exactly one place**, behind a button called
"Reveal private key" which re-asks for the passphrase and re-derives from storage
rather than printing the copy already unlocked in memory
(`wallet/app.js:498-516`).

**Sending.** `eth_getBalance` and `eth_getTransactionCount(…, 'pending')`, then
sign, then `eth_sendRawTransaction`, then poll `eth_getTransactionReceipt` — a
null receipt is "not yet", never an error (`wallet/app.js:324-410`, `:295-322`).
The node's returned hash is compared with the locally computed one; a mismatch is
reported as "those are not the bytes this wallet signed" rather than as success.
History is a bounded backwards block walk, batched, because there is no address
index and cannot cheaply be one (`wallet/app.js:186-230`, `docs/evm-spec.md` §6).

**Boot is a six-panel state machine** — `offline`, `preEvm`, `lock`,
`unreadable`, `setup`, `app` — and `app` is only reachable with an opened key
(`wallet/app.js:86-87`, `:572-615`).

**The chain does not exist yet.** Phase 5 is being built, so `?fixtures=1` serves
a canned account chain over the real transport (`wallet/fixtures.js`). It is
opt-in from the URL, labelled on screen, and its `eth_sendRawTransaction`
validates with the same module the node uses — so a signing bug is rejected there
exactly as it would be on the wire (`wallet/fixtures.js:270-330`).

### 7.2 Browser miner (`web/mine.html`, `web/assets/mining/`)

`homefire.js` is a line-for-line port of `node/src/pow.js` with two deliberate,
unobservable differences: the pad is allocated once per `Miner` rather than per
attempt, and the 64-bit read/xor/write is done byte-wise
(`web/assets/mining/homefire.js:9-18`). `sha256.js` is a synchronous SHA-256 so
it can run inside a Worker.

**Conformance is enforced in CI.** `node/test/browser-pow.js` imports the
browser modules and compares them to the node's own implementations digest for
digest, including SHA-256 padding edges at 55/56/64 bytes
(`node/test/browser-pow.js:1-9`, `:26-40`); `.github/workflows/ci.yml:32-33`
runs it. `node/test/mining-api.js` goes further: it stands up a node, grinds
nonces with the *browser* implementation, signs locally and posts the proof over
real HTTP (`node/test/mining-api.js:1-9`).

**Protocol.** `GET /mining/template?pub=` returns the header core plus a
`templateId`; the node keeps the transactions, so a full block is not sent per
attempt (`mining.js:18-23`). Workers are assigned disjoint arithmetic
progressions of nonces — `startNonce: i, stride: workers.length` — so no nonce
is tried twice with no shared counter (`web/assets/mining/miner.js:196-208`).
The winning digest is signed in the page and only the signature is posted
(`miner.js:246-256`). **That signature is secp256k1 now, not Ed25519**: spec §4
makes `coinbasePub` a secp256k1 key because the coinbase has to receive the
reward and the fees, so it must be an account this chain can credit. The hashing
half is untouched — Homefire, the pad fill, the walk, the digest — and
`node/test/browser-pow.js` still passes. The miner imports the wallet's port
rather than carrying a second one, since two independent browser ports of one
curve is how they drift apart. The wire form it assumes is named in one place,
`POW_SIG_FORM` (`miner.js:46`): `r || s`, 64 bytes, low-s, no recovery id,
because the header already carries the public key. **Phase 5 owns the node half
of that contract and had not landed it when this was written** — if it chooses a
recoverable 65-byte form instead, that constant is the one line to change.
`scratchKiB` and `walkSteps` travel *with* the work, so a
stale miner stops producing valid work rather than quietly producing invalid
work (`mining.js:67-71`, `homefire.js:23-25`).

`/mining/submit` **does not trust the submission**: only `nonce`, `powDigest`
and `powSig` are taken from it; the header core and the transactions come from
the stored template, staleness is checked against the current tip, the proof is
verified, and the chain revalidates everything anyway
(`mining.js:86-122`). Templates expire after 120s and are capped at 256 with
oldest-first eviction, so an unauthenticated caller cannot grow the map
(`mining.js:31-33`, `:76-84`).

**Politeness is real, and honestly scoped.** The effort slider is a duty cycle
the workers actually sleep through; a background tab drops to ≤15%; and where
the Battery Status API exists the miner pauses on unplug
(`web/assets/mining/miner.js:149-178`). Where it does not — Firefox and Safari
removed it — `powerKnown` stays false and the UI says which of the two it got
(`miner.js:122-147`, `web/mine.html:313-316`). There is deliberately **no** idle
detection: a page cannot see whether someone is at the keyboard
(`miner.js:157-163`).

### 7.3 Node-side wallet and miner

`node/src/wallet.js` keeps PKCS#8 PEM keys in `data/wallet.json` plus a separate
X25519 *reading* identity — deliberately not the spending key
(`wallet.js:17-20`). `buildTx` selects only spendable UTXOs, preferring the
node's own `spendable` answer over recomputing it, and refuses rather than
building a payment the chain would reject (`wallet.js:73-116`,
`node/test/unit.js:116-130`).

`node/src/miner.js` searches nonces on a `setImmediate` loop in batches of 150
so the event loop never blocks, with a throttle knob for polite mining
(`miner.js:96-129`). Its transaction selection is memoized on
`(tipId, mempool.version)` because building it copies the entire UTXO set and
the only externally reachable caller is the unauthenticated `/mining/template`
(`miner.js:32-66`, `mempool.js:14-18`).

### 7.4 CLI wallet (`node/bin/hearth-cli.js`)

`info`, `supply`, `newaddress`, `addresses`, `balance [addr]`, `send <to>
<EMBER>`, `blocks [n]`. `send` fetches UTXOs for every wallet address over
`/address/:addr`, builds a shim chain view, signs locally and broadcasts to
`POST /tx` (`hearth-cli.js:66-82`). `--rpc` and `--data`, or `HEARTH_RPC_URL`
and `HEARTH_DATA` (`hearth-cli.js:20-27`).

---

## 8. Not reachable, or not finished

- **The desktop app.** `start_node` / `stop_node` / `node_running` have zero
  callers, and `node_entry()` cannot resolve inside a bundle
  (`app-desktop/src-tauri/src/main.rs:4-18`, `:27-39`, `:91`). It opens the web
  wallet in a native window and nothing more.
- **On-chain encrypted chat is CLI-only.** `node/src/apps/chat.js` and
  `node/src/box.js` implement announce/whois/send/inbox/watch over records and
  sealed boxes, driven by `node/bin/hearth-chat.js`. No page in `web/` and no
  screen in `site/` touches it.
- **API surface the explorer does not show.** `GET /records` is consumed only by
  `hearth-chat` (`node/bin/hearth-chat.js:70`, `:117`); the filtered SSE stream
  `?app=&key=` likewise (`hearth-chat.js:130`). `POST /rpc`
  (`getinfo`/`getbalance`/`getblockcount`/`sendtx`) has no in-repo client at all.
  `/mempool` is read by the wallet but not the explorer. The explorer no longer
  reads the REST API at all — it is `eth_*`-only — so records, which are a UTXO
  construct, have no explorer surface.
- **Where the `eth_*` JSON-RPC server is mounted is not decided.**
  `node/src/jsonrpc/server.js` accepts POST at whatever path it is given, and
  `node/src/rpc.js:152` already answers `POST /rpc` with the older
  `{method:'getinfo'}` shape. The explorer defaults to same-origin `/rpc/` and
  reports "answered, but not with JSON-RPC 2.0" if it gets the legacy shape
  (`web/assets/explorer/rpc.js`).
- **`web/pay-demo.html` is a mockup, and says so on the control.**
  `web/assets/hearth-pay-demo.js` builds a real `hearth:` URI and then
  **simulates** settlement on a 1,200 ms timer; the txid is deliberately not
  64 hex characters so it can never be mistaken for a real one
  (`hearth-pay-demo.js:1-26`, `:76-88`). The disclaimer is rendered next to the
  button so it survives a screenshot (`:56-63`). Note `README.md:164` still
  describes `web/` as containing a "Hearth Pay SDK" — that line is stale.
- **The Rust core** — see §2.2. Also `src/tab.rs` (payment channels),
  `src/netmsg.rs` and `src/mempool.rs` are libraries wired to nothing but the
  self-check.
- **Chain replay is silent about rejects.** `Chain.load()` re-validates every
  persisted block through `_ingest(…, persist=false)` and discards the return
  value (`chain.js:48-51`), so a data directory containing an invalid block
  loads a shorter chain without saying why.

---

## 9. What this does NOT do, and non-obvious constraints

**The `@cloudsforge/hearth-node` version skew — the sharpest one.**
`node/package.json:3` is at **0.2.0**, and 0.2.0's `txBody` emits a `records`
key inside the signed body whenever a transaction carries records
(`node/src/tx.js:47-49`). ForgeKeyvault deliberately pins **`^0.1.0`**
(`repos/forge-keyvault/services/forge-keyvault/package.json:13`), which omits the
key entirely. A record-carrying transaction therefore hashes differently on the
two builds, and a signature over it is valid on **exactly one**. Keyvault's
response is to refuse `records` in EMBER signing altogether — its field allowlist
is `{version, type, inputs, outputs}` and its comment names this skew as the
reason (`repos/forge-keyvault/services/forge-keyvault/src/signing.ts:395-403`).
**Do not let a blanket re-lock pull that dependency forward.** A related detail
in the same file is load-bearing: `height` must be emitted even when
`undefined`, because `canonical()` writes `"height":undefined` and the node does
the same (`signing.ts:436-448`, `node/src/crypto.js:8-13`, `node/src/tx.js:45`).

**Other constraints and gaps:**

- **The browser wallet cannot send records.** `web/assets/wallet-core.js:100-109`
  has no `records` branch at all. It matches the node for record-free
  transactions and cannot construct a record-carrying one.
- **`GET /address/:addr` is O(UTXO set) per call**, iterating the whole map
  (`rpc.js:213`), unauthenticated and under CORS `*`. `Chain.balance` and
  `Chain.supply` are the same shape (`chain.js:147-151`, `:166-170`), and
  `/supply` calls `supply()` twice per request (`rpc.js:232-233`).
- **`/blocks` `reward` is the miner's cut, not the subsidy.** It reads
  `txs[0].outputs[0].amount` (`rpc.js:36`), which is `subsidy − commons + tips`.
  `/supply`'s `blockReward` is the full subsidy at height+1 (`rpc.js:238`). The
  two numbers are not the same quantity.
- **Dev-tuned consensus parameters.** `POW_SCRATCH_KIB` 64 and `POW_WALK_STEPS`
  256 against an intended production ~2 GiB / 2048+ (`params.js:50-52`);
  `COINBASE_MATURITY` 10 against a production ~100 (`params.js:95`). Changing any
  of them is a hard fork. Note that Forge Pay's comment assumes maturity is 100
  (`repos/forge-pay/services/pay/src/chains.ts:145-148`) — its *code* reads the
  `spendable` flag rather than the constant, so it is correct either way, but the
  prose is out of step with this tree.
- **No authentication anywhere on the RPC.** No API key, no rate limit beyond the
  body cap. The node is meant to sit behind a proxy; `web/nginx.conf:63` is that
  proxy, and it sets a CSP whose `connect-src` is a deployment variable
  (`web/nginx.conf:40`, `docker-compose.yml:59-68`).
- **Persistence is an append-only NDJSON file** (`chain.js:407`), rewritten
  never and compacted never. Forked blocks are appended too (`chain.js:360`).
- **The whole chain state is in memory** — `store`, `utxo`, `txIndex` and
  `recordIndex` are all `Map`s (`chain.js:31-40`), and `_reindex` on every reorg
  walks the full chain (`chain.js:109-113`).
- **`ember1commons…` is not a checksummed address.** The Commons sink
  (`params.js:127`) fails `isValidAddress`. Under the account model it becomes a
  `0x…` address that **has not been chosen** (`docs/tokenomics.md:253-254`), so
  the explorer's supply view can only *model* the treasury balance until one
  exists; it reads a real balance from `<meta name="hearth-commons-address">` or
  `?commons=` when given one, and says "not configured" when not.
- **Hearth does not do fiat, custody or conversion.** Deposit addresses, Shard
  conversion and withdrawal all live in Forge Pay and ForgeKeyvault. This
  repository's wallets are non-custodial only.
- **There is no payment SDK.** See §8.
- **No wallet recovery of any kind.** One key per browser, no seed phrase, no HD
  derivation, no passphrase recovery, no hardware wallet
  (`web/wallet.html:260-265`).

---

## 10. Running it

```bash
cd node && node bin/hearthd.js --mine          # one node, mining
npm test                                        # 7 suites; see node/package.json:37
docker compose up --build                       # seed + 2 miners + web on :8080
docker compose -f docker-compose.testnet.yml up # 3-node testnet
```

`hearthd` flags: `--data`, `--rpc`, `--p2p`, `--peer H:P` (repeatable), `--mine`,
`--miner-address`, `--throttle`, `--quiet` (`node/bin/hearthd.js:12-39`), each
with an env override — `HEARTH_DATA`, `HEARTH_RPC`, `HEARTH_P2P`,
`HEARTH_PEERS`, `HEARTH_MINE`, `HEARTH_THROTTLE` (`hearthd.js:31-38`). Logging
is pino-shaped JSON in a container and prose at a TTY, switchable with
`HEARTH_LOG_FORMAT` / `HEARTH_LOG_LEVEL` (`node/src/node.js:15-20`).

**CI** (`.github/workflows/ci.yml`): unit, e2e, records+chat, browser-PoW
conformance, browser keystore, remote mining API, P2P fork-sync, and the
coinnomics model; `cargo fmt --check` + `clippy -D warnings` + build + test for
Rust; `node --check` over `web/assets/*.js` — a top-level glob that does **not**
reach the explorer's modules in `web/assets/explorer/`, and does not run
`web/assets/explorer/selftest.js` at all; both are worth adding
(`ci.yml:83`); and three secret-hygiene gates
whose private-key matcher requires a PEM header *followed by real base64*, so
the legitimate PEM literals in `web/` do not force the check to be muted
(`ci.yml:99-113`).

**Deploys.** `.github/workflows/pages.yml` publishes `web/` — explorer, wallet,
miner, demo — to GitHub Pages, mirroring `explorer.cloudsforge.online`. The
marketing site in `site/` builds separately.
