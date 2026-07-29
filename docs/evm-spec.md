# Ember EVM — specification

Hearth becomes an account-model, EVM-executing chain while keeping Homefire proof-of-work and
its emission schedule. This document is the contract every component is built against.

**Decision (owner, 2026-07-28):** EVM semantics, **implemented here rather than imported**. No
`@ethereumjs/*`, no `ethers`, no `web3`. Node's built-in `crypto` is permitted for SHA-256,
RIPEMD-160 and randomness; everything Ethereum-specific — Keccak-256, RLP, the Merkle Patricia
Trie, secp256k1 recovery, the interpreter, the gas schedule — is ours.

**This is a new chain, not an upgrade.** State model, address format, signature scheme and
transaction format all change. Existing testnet state is discarded.

---

## 0. The rule that keeps this safe

Writing your own EVM is tractable. Writing your own EVM *and being sure it is right* is only
tractable because the reference tests exist.

**Every component ships against published vectors, and conformance is CI-gating:**

| Component | Conformance source |
| --- | --- |
| Keccak-256 | Keccak team `KeccakF-1600-IntermediateValues.txt`, plus a differential against Node's SHA3/SHAKE at four rates. *The old `ShortMsgKAT_256.txt` KAT file no longer exists — the KeccakCodePackage path 404s.* |
| RLP | Ethereum RLP test vectors |
| secp256k1 | RFC 6979 + recovery vectors |
| Merkle Patricia Trie | `ethereum/tests` TrieTests |
| EVM opcodes & gas | **`ethereum/legacytests`** VMTests — *moved; cloning `ethereum/tests` gets RLP and trie only* |
| State transition | **`ethereum/legacytests`** GeneralStateTests |
| bn128 (`0x06`–`0x08`) | EIP-196 / EIP-197, plus go-ethereum `core/vm/testdata/precompiles/bn256{Add,ScalarMul,Pairing}.json` — which carry the expected GAS as well as the output. *`ethereum/tests` `stZeroKnowledge`/`stZeroKnowledge2` publish only a post-state root, so they cannot be executed until phase 4 lands; until then `node/test/bn128.js` lifts every precompile input out of them and checks the accept/reject decision against what each fixture's own name asserts.* |
| blake2f (`0x09`) | EIP-152's eight vectors — four of which assert FAILURE — plus a full BLAKE2b-512 built on the precompile and differentiated against OpenSSL's, which is the only thing that exercises multi-block chaining and the byte counter |

Four things about the corpus that a naive runner gets silently wrong, all found by running the
full 3,425-file set and all now guarded by the harness self-test:

- **GeneralStateTests `post` entries are not in index order.** `stEIP2930/transactionCosts.json`
  lists `0,1,2,3,4,5,6,10,7,8,9,11`, so a positional runner checks eight of twelve against the
  wrong state root and reports green.
- The `indexes` key for the gas limit is **`gas`**, not `gasLimit`, and `accessLists` is indexed by
  the *data* index with `null` meaning "legacy transaction for this combination".
- **VMTests are Constantinople-priced.** They predate EIP-2929/3529/3855, so their semantics and
  post states hold under Shanghai but their gas figures do not. Take gas conformance from
  GeneralStateTests only.
- In VMTests, `logs` is `keccak256(rlp(logs))` rather than a log list, `gas` is gas *remaining*,
  and an exception case **omits `post`, `gas`, `out` and `logs` entirely** — the absence is the
  assertion.

**An implementation signals EVM failure by returning `{ exception }`, never by throwing.** A thrown
JS error is a harness-level `ERROR`, not a pass. Without that rule a `TypeError` in the interpreter
masquerades as a correctly-rejected transaction, which makes the vectors that assert *failure* the
easiest ones to fake.

A divergence from Ethereum semantics is not a cosmetic bug — it means a Solidity contract behaves
differently here than where it was audited, and somebody loses money. **No component is
"done" until its vectors pass.** If a vector cannot be made to pass, the correct response is to
say so, not to skip it.

---

## 1. Chain parameters

| Parameter | Value | Note |
| --- | --- | --- |
| Chain ID — mainnet | `7411` | EIP-155 replay protection; verified unclaimed against the live registry (2,664 chains; nearest neighbours 7368 and 7447) |
| Chain ID — **testnet** | **`7412`** | **a separate id is mandatory, not cosmetic — see below** |
| Target fork semantics | **Shanghai** | includes PUSH0 (EIP-3855), reduced refunds (EIP-3529), warm coinbase (EIP-3651), initcode cap (EIP-3860). No blobs. |
| Native asset | EMBER | 18 decimals — changed from 8, because every EVM tool assumes 18 |
| Block time | 15 s | unchanged |
| Difficulty | LWMA, `MIN_TARGET` as raised | unchanged |
| Block gas limit | 30,000,000 | fixed initially; adjustable later |
| Emission | existing subsidy schedule | unchanged |
| Fees | paid to the block's coinbase | no burn in v1 |

**The two networks MUST NOT share a chain id.** The retired UTXO scheme carried a
`net` field *inside* the signed transaction body, so a testnet signature was
structurally invalid on mainnet. EIP-155 replaces that with one number: if both
networks declare 7411 then every testnet transaction is replayable on mainnet and
back — same key, same nonce, the same bytes valid on both. The id is therefore
derived from `HEARTH_NETWORK` in `node/src/params.js` and read from there by
`node/src/chain/transaction.js`; **nothing else may hardcode it**, and an
unregistered network is a hard error rather than a default, because a node that
guesses signs transactions that are valid somewhere it did not intend.

An **empty block** carries no transactions and so the chain id cannot separate one
either. Ethereum's answer, which is ours, is a divergent genesis: the default
genesis `extraData` is `<network>/<chainId>`, so no block on one network descends
from an ancestor on the other.

The id the running chain actually uses is read from `<data>/genesis.json`, not from
params — so `node/src/chain/blockchain.js` **refuses to start** when a persisted
genesis's `chainId` or `extraData` disagrees with the node's `HEARTH_NETWORK`,
naming both values and the file. Without that check a data directory created under
one network and started under another advertises the file's id over `eth_chainId`
while every signer resolves the network's, which is the replay this section forbids.
An explicit genesis override is a deliberate statement of which chain is meant and
is honoured.

`decimals: 8 → 18` is deliberate. ERC-20 tooling, wallets and DEX maths all assume 18 for a
native asset. Keeping 8 would produce subtly wrong displays everywhere and cost more than the
migration does — and the chain is being reset regardless.

**Why testnet needs its own chain id, and why this was nearly missed.** The retired UTXO scheme
carried a `net` field *inside the signed transaction body*, so a testnet signature was structurally
invalid on mainnet. EIP-155 replaces that with the chain id — and if both networks declare `7411`,
**every testnet transaction is replayable on mainnet and vice versa.** Same key, same nonce, same
bytes, valid on both.

The blast radius is limited today because ForgeKeyvault mints a separate key per address, so no key
is used on both networks by accident. It is not limited for a *user*, who will quite reasonably
import one seed phrase into both, and it is not limited for anyone who funds a testnet address that
happens to collide with a mainnet one.

This surfaced only because retiring the Ed25519 path deleted the `net` field, and the agent doing
it noticed the protection had gone rather than assuming EIP-155 covered it. `7412` is adjacent,
memorable and inside the same verified-free range. **Nothing may hardcode `CHAIN_ID`** — it is
per-network configuration, and `node/src/chain/transaction.js:57` currently declares one constant.

---

## 2. Accounts and addresses

An account is `{ nonce, balance, storageRoot, codeHash }`, RLP-encoded as
`[nonce, balance, storageRoot, codeHash]`.

- **Address** = last 20 bytes of `keccak256(uncompressed_pubkey[1:])`, rendered `0x…` with
  EIP-55 mixed-case checksumming.
- **`ember1…` bech32 addresses are retired.** MetaMask, ethers, Hardhat and every block explorer
  assume `0x`. Keeping bech32 would forfeit the entire reason for this work.
- Empty account: `nonce 0, balance 0, storageRoot = EMPTY_TRIE_ROOT, codeHash = keccak256("")`.

**Signature scheme moves from Ed25519 to secp256k1** for the same reason. ForgeKeyvault already
signs secp256k1 for EVM chains, so custody works with existing code; the browser wallet's Ed25519
keystore needs reworking.

---

## 3. Transactions

v1 supports **legacy (type 0) only**. EIP-1559 (type 2) is deferred to v2; wallets fall back to
legacy pricing without complaint.

**Both EIP-155-protected and pre-155 unprotected transactions are accepted**, exactly as Ethereum
does. This is not laziness — a whole tier of ecosystem infrastructure is deployed by *keyless*
presigned transactions (Nick's method), where a transaction with a made-up signature is broadcast
from an address nobody controls, so the contract lands at the same address on every chain.
Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` is deployed this way, and every
front-end and indexer assumes that address. Reject pre-155 and that address is permanently
unreachable here, and every tool needs hand-configuring.

The trade is that an unprotected transaction is replayable on any chain that accepts them. That
risk sits with the sender, every modern wallet signs with EIP-155 by default, and it is the same
trade Ethereum itself makes.

**Deploy Multicall3 from the canonical presigned transaction, not from our own build.** The
presigned payload carries the canonical 0.8.12/london bytecode; deploying our `Multicall3.sol`
instead would produce different code and a different address, which defeats the entire point.
`contracts/src/Multicall3.sol` is kept as readable reference for what is being deployed.

```
[nonce, gasPrice, gasLimit, to, value, data, v, r, s]
```

- `to` empty ⇒ contract creation; the address is `keccak256(rlp([sender, nonce]))[12:]`.
- Signing hash: `keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]))`.
- `v = recoveryId + chainId * 2 + 35`.
- Intrinsic gas: 21,000 base, +32,000 for creation, +16 per non-zero byte, +4 per zero byte,
  plus EIP-3860 initcode word cost.
- Validity: signature recovers to an account whose `nonce` matches, whose balance covers
  `value + gasLimit * gasPrice`, and `gasLimit ≤` remaining block gas.

`MAX_TX_BYTES` stays 100,000. `MAX_BLOCK_BYTES` stays 2,000,000.

---

## 4. Block header

The existing header is `{version, prevHash, merkleRoot, height, timestamp, target, coinbasePub}`
(`node/src/block.js:13-23`). Version 2 extends it:

```
{ version: 2, prevHash, height, timestamp, target, coinbasePub,
  txRoot, stateRoot, receiptsRoot, logsBloom, gasLimit, gasUsed }
```

- `merkleRoot` → **`txRoot`**, now a trie root over RLP-encoded transactions, not a binary Merkle root.
- `stateRoot` — MPT root after applying every transaction in the block.
- `receiptsRoot` — trie root over RLP-encoded receipts.
- `logsBloom` — 2048-bit filter over every log address and topic. **Required**: `eth_getLogs` and
  every indexer depend on it.

**The header as specified cannot populate an RPC block response.** Building the JSON-RPC layer
surfaced six fields clients require that nothing here provides. Phase 5 must add them:

| Field | Source |
| --- | --- |
| `difficulty` | derivable from `target` as `2^256 / (target + 1)` |
| `totalDifficulty` | **cumulative — must be stored**, not recomputed per request |
| `size` | RLP byte length of the block |
| `extraData` | free bytes; may be empty, but the field must exist |
| `nonce` | 8 bytes, from the PoW proof |
| `mixHash` | the Homefire digest — the same value `PREVRANDAO` returns |

**`timestamp` must be seconds.** A millisecond timestamp makes every explorer render dates in the
year 57,000 and breaks every Solidity `deadline` comparison, including Uniswap V2's Router, which
rejects any swap whose deadline has "passed". Convert at the header, not at the RPC boundary, so
there is one representation on the chain.

*Correction (phase 5): this section previously said "the v1 header stores milliseconds". It does
not — `node/src/miner.js:88` divides by 1000 and genesis is `1750000000`, so v1 is already in
seconds. The requirement stands and is now enforced rather than assumed: `header.js` refuses any
timestamp past `MAX_TIMESTAMP` (≈ the year 5138), which every millisecond value exceeds today, so a
producer that forgets to divide fails on its first block instead of silently.*

**The proof-of-work algorithm is unchanged — but the key it binds is not.** §2 moves accounts to
secp256k1, and the coinbase has to *receive* the block reward and the fees, so it must be an
account this chain can credit. `coinbasePub` therefore becomes a secp256k1 public key and the
block signature becomes a secp256k1 signature. Homefire itself — the pad fill, the walk, the
digest — is untouched, as is LWMA and everything in `pow.js`.

Stating this because the spec was ambiguous enough that the agent writing the whitepaper
declined to assert either way, which was the right call. It is one sentence and it is consensus.

`coreHash` covers the whole header core, Homefire runs over it exactly as today, and `coinbasePub`
still binds the miner. Miners receive a template and grind
nonces (`/mining/template`), so **the browser miner needs no EVM** and the digest-conformance test
stays cheap.

---

## 5. Module layout

Everything new lives under `node/src/`, in packages with no dependency on the existing UTXO code
so both can be tested in isolation during the transition.

```
crypto/
  keccak.js        Keccak-256 (NOT SHA3-256 — different padding)
  rlp.js           encode / decode
  secp256k1.js     sign / verify / recoverPublicKey
state/
  trie.js          Merkle Patricia Trie (secure variant, keccak-keyed)
  statedb.js       accounts, storage, code, journaling, snapshot/revert
evm/
  uint256.js       256-bit arithmetic with wrapping semantics
  stack.js         1024-deep, 256-bit words
  memory.js        byte-addressed, word-expanded, quadratic gas
  gas.js           Shanghai schedule, memory expansion, EIP-2929 warm/cold
  opcodes.js       the instruction table
  interpreter.js   execution loop, call frames, depth 1024, revert semantics
  bn128.js         alt_bn128 curve, tower field and pairing
  blake2f.js       BLAKE2b compression (EIP-152)
  precompiles.js   0x01–0x09
chain/
  statetransition.js  apply a transaction, produce a receipt
  bloom.js            logs bloom
rpc/
  eth.js           the eth_* JSON-RPC surface
```

**As built, phase 5 added** (the `rpc/eth.js` above landed as `jsonrpc/` in phase 6's layer):

```
chain/
  header.js       header v2, block encoding, the block id, verifyPow
  genesis.js      the `hearth-genesis/1` file, the alloc, block 0
  blockchain.js   storage, validation, fork choice, reorganisation
  mempool.js      per-sender nonce ladders, priced between senders
  miner.js        block production + `/mining/template` for remote miners
  rpcadapter.js   the chain interface jsonrpc/methods.js documents
evmnode.js        wires it together; `hearthd --evm`
```

### Design notes that matter

**`uint256` on BigInt.** JavaScript's `BigInt` is arbitrary-precision, so every arithmetic op must
mask to 256 bits: `(a + b) & MASK256`. Signed ops (`SDIV`, `SMOD`, `SAR`, `SIGNEXTEND`) interpret
the same 256-bit word as two's complement. This is the single most common source of subtle EVM
bugs — every operation gets a vector test.

**Keccak-256 is not SHA3-256.** Node's `crypto.createHash('sha3-256')` uses the NIST padding
(`0x06`); Ethereum uses the original Keccak padding (`0x01`). They produce different digests. This
must be implemented, and its first test is that `keccak256("")` equals
`c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`.

**The trie is the "secure" variant**: keys are `keccak256(key)` before insertion. Nodes are
RLP-encoded; any node whose encoding is under 32 bytes is embedded rather than hashed. Getting
this wrong produces a wrong `stateRoot` and silent consensus failure.

**Scalar canonicality has no home in RLP, and must be enforced by its callers.** RLP is untyped —
it decodes to byte strings, so it cannot know that a `nonce` or `balance` or `value` is a number
and must therefore carry no leading zero bytes. The yellow paper requires those scalars to be
minimal-length, and two encodings of the same number hash differently, which is a chain split.

So the rule lives in the **decoders**, not the codec: the transaction decoder must reject a
leading-zero `nonce`, `gasPrice`, `gasLimit`, `value`, `v`, `r` or `s`, and the account decoder
must reject a leading-zero `nonce` or `balance`. Empty (zero-length) is the canonical encoding of
zero and is valid; `0x00` is not. This applies to phases 2 and 4 and is easy to miss because
everything appears to work until someone crafts a non-canonical transaction.

**StateDB needs journaling, not just a map.** `REVERT`, failed calls and out-of-gas must roll back
storage, balance, nonce and code changes to a snapshot, while gas already consumed stays consumed.
Model it as an ordered journal with checkpoint markers.

**EIP-2929 pre-warms `0x01`–`0x09`, and so do we.** The warm set is a gas rule, not a capability
claim: Ethereum warms all nine, the GeneralStateTests assume it, and treating an address as cold
that Ethereum treats as warm costs 2,500 gas per access. That is consensus, so the warm set follows
Ethereum exactly. **All nine are now implemented**, so warmed and implemented coincide; the
interpreter keeps the machinery to fail an address that is warmed and unimplemented, because a fork
can pull the two apart again and a call to an address with no code *succeeds* and returns empty.

**Precompiles have two opposite failure conventions, and both are consensus.** `0x01`–`0x05` answer
a malformed input with EMPTY output and a SUCCESSFUL call — Solidity's `ecrecover()` maps that empty
return to `address(0)`, which is what every `require(signer != address(0))` in every permit
implementation is testing, so getting it wrong breaks Uniswap V2's permit path. `0x06`–`0x09` do the
opposite: a coordinate outside the field, a point off the curve, a G2 point outside the r-torsion, a
pairing input whose length is not a multiple of 192, a blake2f block that is not exactly 213 bytes
or whose final flag is neither 0 nor 1 — each FAILS the call and burns every drop of forwarded gas.
A zk verifier that read "success, no output" as a zero would accept a forged proof.

`run(input)` therefore returns `null` to mean "fail this call", and only `0x06`–`0x09` ever do.
**The validity checks live in `run`, never in `gas`**, and that placement is a security property
rather than a style choice: `gas` is consulted before the interpreter tests affordability, so any
work it does is work an attacker buys for the ~130 gas a CALL costs. A 192 KB pairing input
validated inside `gas` would let one contract burn minutes of node CPU per block. `gas` is O(1) in
the input — length only — exactly as go-ethereum's `RequiredGas` is.

**Gas is consensus.** A wrong gas cost is a chain split. The Shanghai schedule including EIP-2929
access lists (cold 2600 / warm 100 for accounts, cold 2100 / warm 100 for storage) is mandatory,
not an optimisation. Note that EIP-2929 **removed** the old 700 CALL base — from Berlin onward the
base is the account access cost itself, 100 warm or 2600 cold. Anything still quoting 700 predates
Berlin.

**Two opcodes have no natural meaning on this chain, and both needed deciding.**

`PREVRANDAO` (0x44) is beacon-chain randomness on Ethereum, and Hearth has no beacon chain.
Returning the difficulty target — what pre-merge Ethereum did, and what most proof-of-work EVM
forks still do — would be nearly useless here, because our target moves slowly and is close to
constant between adjacent blocks. So **`PREVRANDAO` returns the parent block's Homefire PoW
digest**: a real 256-bit hash, deterministic, and verifiable by anyone.

It is still **miner-influenceable** — a miner who dislikes an outcome can discard the block and
grind another — which is true of every PoW-derived randomness source. Document it in the developer
docs in exactly those words. Contracts routinely misuse `block.prevrandao` as a randomness source,
and the honest thing is to say plainly that it must not be used for anything an adversarial miner
would profit from biasing.

`BASEFEE` (0x48) exists because Shanghai includes EIP-3198, and removing it would make
Shanghai-compiled Solidity fail here while working on Ethereum. v1 has no EIP-1559, so **it pushes
zero** until the fee market lands in v2.

---

## 6. JSON-RPC

The highest-leverage deliverable. It is what makes MetaMask, ethers, viem, Hardhat and Foundry
work without any of them knowing this chain is bespoke.

### The method surface as it stands — 41 methods

**Chain and node metadata.** `eth_chainId`, `eth_blockNumber`, `eth_gasPrice`, `eth_syncing`,
`eth_accounts`, `eth_mining`, `eth_hashrate`, `eth_coinbase`, `net_version`, `net_listening`,
`net_peerCount`, `web3_clientVersion`, `web3_sha3`, `txpool_status`.

**State.** `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt`.

**Execution.** `eth_call`, `eth_estimateGas`, `eth_sendRawTransaction`.

**Blocks, transactions, receipts.** `eth_getBlockByNumber`, `eth_getBlockByHash`,
`eth_getBlockTransactionCountByNumber`, `eth_getBlockTransactionCountByHash`,
`eth_getTransactionByHash`, `eth_getTransactionByBlockNumberAndIndex`,
`eth_getTransactionByBlockHashAndIndex`, `eth_getTransactionReceipt`, `eth_getBlockReceipts`,
`eth_getUncleCountByBlockNumber`, `eth_getUncleCountByBlockHash`,
`eth_getUncleByBlockNumberAndIndex`, `eth_getUncleByBlockHashAndIndex`.

**Logs and filters.** `eth_getLogs`, `eth_newFilter`, `eth_newBlockFilter`,
`eth_newPendingTransactionFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`,
`eth_uninstallFilter`.

**Deliberately absent, each for a reason a client can act on** — every one answers `-32601`, which
is what lets a client fall back rather than mis-read a plausible default:

| Method | Why not |
|---|---|
| `eth_subscribe` / `eth_unsubscribe` | needs a WebSocket transport. 8546 is reserved for it; nothing listens yet. Every filter above is the HTTP equivalent and is what ethers v6 reaches for first anyway. |
| `eth_getProof` | needs Merkle proof extraction from `state/trie.js`, which has none. Light clients and bridges want it; nothing in this estate does yet. |
| `debug_traceTransaction` | needs a tracer hooked into the interpreter. `tools/explorer-api` already degrades gracefully without it and says so on the internal-transactions tab. |
| `txpool_content`, `txpool_inspect` | one request dumps the whole pool with senders — up to `MEMPOOL_MAX_TXS` (50,000) signature recoveries and a response in megabytes, unauthenticated. geth keeps the whole txpool namespace off HTTP by default for the same reason; `txpool_status` is the part that is safe. The REST `/mempool` serves the explorer. |
| `eth_protocolVersion` | names a devp2p `eth/NN` version. Hearth's p2p is not devp2p, so any number here is a lie; geth removed the method in 1.13. |
| `eth_getWork`, `eth_submitWork` | the mining interface is the REST `/mining/template` and `/mining/submit`, which the browser miner already speaks. |
| `eth_sign`, `eth_sendTransaction`, `personal_*` | the node holds no keys for callers, which is why `eth_accounts` is `[]`. Wallets sign locally. |
| `eth_feeHistory`, `eth_maxPriorityFeePerGas` | **implemented, and off by default** — see the fee-market decision below. `HEARTH_RPC_FEE_HISTORY=1` turns them on. |

**Filters hold server-side state, and that state is bounded three ways.** They are the only part
of this surface where the node remembers something between calls, on an endpoint with no auth and
CORS `*` — so "one filter per request, kept forever" would be a memory leak with an HTTP interface
in front of it. A filter holds a *cursor* and never accumulates results: log filters re-derive
from the chain at poll time, pending filters index into one bounded journal the mempool keeps for
all of them.

| Bound | Default | Behaviour at the limit |
|---|---|---|
| lifetime after **last use** | 5 minutes (geth's `--rpc.filter-timeout`) | the id becomes `-32000 filter not found`, which is what makes a client re-subscribe |
| filters per remote address | 32 | creation refused, naming the limit and `eth_uninstallFilter` |
| filters on the node, total | 1,024 | creation refused — nothing is evicted, because evicting punishes the client that behaved |
| blocks scanned per `eth_getFilterChanges` | 10,000 for logs, 1,000 hashes for blocks | the cursor advances by what it served and the caller catches up over several polls |

**`eth_newFilter` is a live subscription, not a query.** `eth_getFilterChanges` returns only what
arrived since the last poll, even when `fromBlock` names the past — history is `eth_getLogs`'s job,
and `eth_getFilterLogs` re-runs the filter's whole declared range on demand. This is geth's
behaviour, and it matters because every client that uses filters also queries the past separately;
replaying it here delivers each historical log twice.

**A block filter is a "the head moved" signal.** It reports canonical head hashes and re-delivers
a height whose hash changed under it, but it holds one `(height, hash)` pair and so cannot tell
how deep a reorg went. geth's does not either — its feed fires once for the new head. Anything
that must not miss a reorged-out block wants receipts and `eth_getBlockByNumber`.

**A log filter rewinds across a reorg, up to 12 blocks.** A cursor only walks forward, so without
this a reorg delivers the *winning* branch's logs to nobody: the cursor is already past the
replaced height and never goes back, and the client sees `[]`, which is indistinguishable from a
quiet chain. So each log filter also remembers the hashes of the last `confirmations` (12) heights
it scanned and rewinds to the deepest one that changed. Twelve is deliberately the same number as
`confirmations` — this node already calls a block that deep `finalized`, and it is also the memory
bound: 12 × 32 bytes per filter, so the 1,024-filter cap authorises 384 kB of it. A reorg deeper
than that rewinds only as far as it remembers. **No `removed: true` log is emitted** for what was
already delivered off the losing branch; geth sends those from a feed that retains every
subscription's results, which is the grow-forever shape these bounds exist to refuse. `removed` is
on every log this surface formats, and a client that must reconcile does it from `blockHash`, the
same way it already must for `eth_getLogs`. Proven end to end in `test/evm-p2p-fork.js`, on two
real nodes with a real fork: alice's nonce 2 emits one event on each branch, and the open filter
delivers the losing one before the reorg and the winning one after it.

### The EIP-1559 decision, made and written down

**This chain is legacy-only in v1 and says so through the block, not through a method.** A block
carries no `baseFeePerGas`, and that *absence* is what makes ethers, viem, Hardhat and MetaMask
price transactions the legacy way. **`eth_feeHistory` and `eth_maxPriorityFeePerGas` are therefore
off by default**, which is the opposite of what "a wallet that asks and gets an error looks broken"
suggests — and the reason is that this repository measured who actually asks
([`network-config.md`](network-config.md) §5, against `tools/rpc-probe/stub.js`):

| Toolchain | Asks for `eth_feeHistory`? | With it absent | With it answering zero base fees |
|---|---|---|---|
| ethers 6.15 / Hardhat 2.29 | never | works, type 0 | unchanged |
| viem, MetaMask | never | works, type 0 | unchanged |
| Foundry 1.7.1 | **unconditionally, before pricing anything** | aborts with *"This chain might not support EIP1559, try adding `--legacy`"* | signs a **type-2 transaction this chain cannot execute**, refused at broadcast as *"transaction type 0x2 — v1 accepts legacy (type 0) only"* |

The only client that asks is the one an answer makes *worse*: a message naming the remedy becomes a
message naming only the cause, one step later. `eth_maxPriorityFeePerGas` was never called by any
of the three, so it is paired with `eth_feeHistory` rather than served alone.

**Turned on with `HEARTH_RPC_FEE_HISTORY=1`**, for a private endpoint feeding a gas dashboard, or
on the day the fee market lands in v2 — the implementation and its tests are already here, so that
is a flag rather than a project. When on:

- `eth_feeHistory` returns `baseFeePerGas` as all zeros, which is the honest value rather than a
  placeholder, `gasUsedRatio` from each block's own header, and — only when percentiles are asked
  for — a `reward` distribution computed geth's way, sorted by price and weighted by gas used.
  `blockCount` is capped at **128 blocks**, because every block in the window costs a receipt walk;
  it accepts a JSON number, a decimal string or hex, as geth's `math.HexOrDecimal64` does, which is
  the one deliberate relaxation of the strict hex rules below.
- `eth_maxPriorityFeePerGas` equals `eth_gasPrice`. With no base fee the miner keeps the whole
  price, so the priority fee *is* the gas price; returning zero would be arithmetically defensible
  and practically a lie, since a wallet that then sends `maxPriorityFeePerGas: 0` gets a
  transaction the mempool refuses as underpriced.

**Speculative execution is sandboxed.** `eth_call` and `eth_estimateGas` are the only
unauthenticated way to make the node run EVM code, over an endpoint that answers CORS `*` with no
auth. The run executes against an *overlay* of the node store — reads fall through, writes land
in a per-call map that is dropped when the call returns — so a speculative call cannot add one
trie node to the never-pruned store §9 describes, and cannot influence consensus state at all.
**One request cannot stop the node, and it takes four bounds to say that.** This node is
single-threaded: an RPC execution holds the loop that also mines, gossips and answers the
healthcheck, so the size of a request is the length of an outage. Every one of these is part of
the surface a client sees rather than an implementation detail.

| Bound | Default | Knob |
|---|---|---|
| `gas` clamped, both methods | 10,000,000 — a third of the block gas limit | `HEARTH_RPC_GAS_CAP` |
| wall clock per request | 1,000 ms | `HEARTH_RPC_TIME_BUDGET_MS` |
| batch members per POST | 1,000 (geth's own default) | `maxBatchSize` |
| concurrent requests per address | 16 | `maxInFlightPerIp` |

The `gas` field is **clamped silently**, exactly as geth's `--rpc.gascap` does: a caller asking
for more gas than the endpoint will spend is asking about a transaction this node would not run,
and the honest answer is what happens at the limit that applies. Omitting `gas` means the cap,
not the block gas limit.

The **wall clock is the bound that actually holds**, because gas cannot. The spread between the
cheapest and dearest gas in this interpreter is 135× (`docs/robustness-review.md` §6): 10M gas of
`PUSH`/`ADD` is 160 ms, the same 10M gas of `blake2f` is three and a half seconds, and a 96 kB
`modexp` exponent is priced at 4.1M gas and runs for 3.2. A run that outlives its budget comes
back as JSON-RPC `-32000 execution timeout` — never as a revert, which would blame the caller's
contract, and never as a retryable error, which would invite the same request again. One budget
covers a whole `eth_estimateGas` including its 33-probe bisection, and running out of it
mid-bisection returns the smallest limit already proven to work rather than an error, because an
over-estimate costs the caller nothing.

**The deadline exists only here.** The same interpreter validates blocks, and a validator that
abandoned a block because its machine was busy would fork away from one that did not, so nothing
on a consensus path is given one — a mined transaction executes every round it paid for, however
long that takes.

**Three things the RPC surface still cannot supply, which are decisions rather than omissions:**

- **No revert reason on a receipt.** It can only be recovered by replaying `eth_call` against
  *current* state, which is not the state the transaction ran in — so the answer is best-effort and
  sometimes simply wrong. A `revertReason` field on the receipt (several chains add one) makes it
  correct instead.
- **No total or circulating supply on `eth_*`.** It can only be modelled from the emission schedule,
  which drifts silently if the account-model genesis differs by even one block. The node should
  serve plain-decimal supply endpoints; aggregators poll exactly this.
- **No address index, and there cannot be one cheaply.** "Transactions of an address" is a bounded
  block walk. The Etherscan-compatible `/api` shim in `docs/listing-checklist.md` is the real fix.

**Mempool visibility is now partial, deliberately.** `eth_getBlockByNumber('pending')` still returns
null by design, and `txpool_content` is still absent for the reason in the table above — but
`eth_newPendingTransactionFilter` announces every hash the pool admits, from `eth_sendRawTransaction`
and from p2p gossip alike, and `txpool_status` reports the executable/stranded split. So a pending
transaction can be *noticed* without knowing its hash first; reading it back is then
`eth_getTransactionByHash`, which has always served pooled transactions.

### Where it mounts — settled (owner, 2026-07-28)

**The Ethereum JSON-RPC server is port 8545, path `/`.** The public form is
`rpc.<apex>` → 8545.

| node | REST | Ethereum JSON-RPC (host) |
| --- | --- | --- |
| seed | 8645 | **8545** |
| miner1 | 8647 | 8547 |
| miner2 | 8649 | 8549 |

Every node listens on 8545 **inside its own container**; the host ports differ only so three can
run side by side. **8546 is reserved and still unbuilt** — it is the paired convention for the
WebSocket (`eth_subscribe`) endpoint and taking it for anything else would be awkward to undo.

**What 8546 would cost, so it can be scheduled rather than guessed at.** It is a bigger piece than
the whole HTTP method surface above, because it is a second *transport* and not a set of methods:
a WebSocket framing implementation (no dependency may be added lightly — this package has zero),
a connection registry with its own per-connection subscription cap and idle timeout, a *push* path
where every existing method is *pull* (`newHeads`, `logs`, `newPendingTransactions` and
`syncing` each need a hook on the chain's block event rather than a cursor a caller polls), and a
back-pressure rule for a client that stops reading — which is the failure mode that has no
equivalent anywhere in this file, because an HTTP response either lands or the socket dies. Call it
two to three days including the tests, and note that ethers v6's `JsonRpcProvider` reaches for the
filter methods above *before* it reaches for subscriptions, so nothing in this estate is blocked on
it. What is blocked on it: a client that only speaks `WebSocketProvider`, and sub-second event
latency for anything that cannot poll.

8545 is the port the ecosystem already defaults to: MetaMask's localhost default, and what every
Hardhat and Foundry tutorial assumes, so a developer's first guess is correct.
`tools/hardhat/hardhat.config.js:26` already defaults to `http://127.0.0.1:8645` and needs its one
line changed. **The REST API stays on 8645, untouched**, because `node/src/rpc.js:152` answers
`POST /rpc` with the legacy `{method:'getinfo'}` shape and mounting eth_* alongside it hands a
client a 200 that is not JSON-RPC 2.0 — which reads as an empty chain rather than as a
misconfiguration. Two ports, two protocols, no ambiguity.

This URL goes into `ethereum-lists/chains` and `chainid.network`, where MetaMask caches it in every
user's saved networks and exchanges hard-code it, so it cannot be changed after publication without
stranding all of them at once.

Implemented in `node/src/evmnode.js`; `DEFAULT_JSONRPC_PORT` is in `node/src/params.js`, overridable
with `--jsonrpc` or `HEARTH_JSONRPC`. The REST port on the account-model node answers a `POST /` that
looks like JSON-RPC with a 404 naming the right port, rather than with `{"err":"no route"}`.

Hex quantity encoding must be exact — `0x0` not `0x00`, no leading zeros — because clients are
strict.

---

## 7. The exchange

Once the chain executes, the DeFi layer is Solidity and deploys through ForgeMint's existing EVM
path.

| Contract | Basis | Purpose |
| --- | --- | --- |
| **WEMBER** | WETH9 | native EMBER as an ERC-20, which every AMM requires |
| **Factory** | Uniswap V2 | creates and registers pairs |
| **Pair** | Uniswap V2 | constant-product pool, `x * y = k` |
| **Router** | Uniswap V2 `Router02` | swaps, liquidity, multi-hop paths, deadlines |
| **Multicall3** | standard | batched reads; front-ends assume it exists |

Uniswap V2 is chosen over V3 deliberately: far simpler, thoroughly audited, thoroughly understood,
and its maths do not need concentrated-liquidity tick machinery. V2 needs `ecrecover` (permit),
which is why precompile `0x01` is in v1.

**Ship with liquidity.** A DEX with empty pools attracts nobody. Seed EMBER/WEMBER and at least one
pair against a bridged or issued stable asset at launch.

**`feeToSetter` must not be a deployer EOA.** It controls where protocol fees go, with no timelock
and no two-step handover in V2 — whoever holds that key can redirect the fee switch in one
transaction. It should be a multisig from the moment the factory is deployed, not "moved later",
because moving it later requires the very key you are trying to stop relying on.

**Verify the init code hash against the live factory before any liquidity is added.** The Router
computes pair addresses from a hard-coded hash rather than asking the factory, so a mismatch sends
it looking for pools that do not exist. The factory exposes `pairCodeHash()` for exactly this
check. Current hash: `0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537`.

Crucible already runs a fail-closed, multi-source, median price oracle — publishing it on-chain is
a genuine head start over a new chain with no price feed.

---

## 8. Phases

| Phase | Deliverable | Gate |
| --- | --- | --- |
| **1. Primitives** | keccak, RLP, secp256k1, uint256 | published vectors pass |
| **2. State** | trie, statedb | TrieTests pass |
| **3. Execution** | interpreter, gas, opcodes, precompiles | VMTests pass |
| **4. Transition** | tx application, receipts, bloom, header v2 | GeneralStateTests pass |
| **5. Consensus** | block production and validation on the new state model | testnet produces and reorgs ✅ |
| **6. RPC** | `eth_*` surface | MetaMask connects; Hardhat deploys |
| **7. DeFi** | WEMBER, Factory, Pair, Router, Multicall3 | a swap succeeds end to end |
| **8. Ecosystem** | EVM-aware explorer, faucet, verified sources, docs | a stranger can deploy unaided |

Phases 1–4 are testable entirely offline against vectors, with no chain running. That is
deliberate: the risky part is provably correct before it touches consensus.

### The tracer is not a phase-8 nicety

`hearth trace <txhash>` — an opcode-level debugger showing gas, stack, memory and storage deltas
per step, with call depth and decoded revert reasons — gets built **during phase 3**, alongside the
interpreter.

The reason is selfish rather than generous. When a `GeneralStateTests` vector fails, the difference
between a good afternoon and a lost week is whether you can see the exact opcode where our stack
diverged from the reference. Every client team builds this eventually; building it late is how the
hard bugs stay hidden. It happens to also be the tool contract developers want most.

---

## 9. What is explicitly out of scope for v1

- EIP-1559, blob transactions, account abstraction.
- State pruning, snapshot sync, archive nodes.
- Lending, stablecoins, anything beyond the AMM.
- Bridges. Every bridge is a liability; not until the chain has proven itself.
