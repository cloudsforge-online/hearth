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
| EVM opcodes & gas | `ethereum/tests` VMTests + `execution-spec-tests` |
| State transition | `ethereum/tests` GeneralStateTests |

A divergence from Ethereum semantics is not a cosmetic bug — it means a Solidity contract behaves
differently here than where it was audited, and somebody loses money. **No component is
"done" until its vectors pass.** If a vector cannot be made to pass, the correct response is to
say so, not to skip it.

---

## 1. Chain parameters

| Parameter | Value | Note |
| --- | --- | --- |
| Chain ID | `7411` | EIP-155 replay protection; verify unclaimed on chainlist before mainnet |
| Target fork semantics | **Shanghai** | includes PUSH0 (EIP-3855), reduced refunds (EIP-3529), warm coinbase (EIP-3651), initcode cap (EIP-3860). No blobs. |
| Native asset | EMBER | 18 decimals — changed from 8, because every EVM tool assumes 18 |
| Block time | 15 s | unchanged |
| Difficulty | LWMA, `MIN_TARGET` as raised | unchanged |
| Block gas limit | 30,000,000 | fixed initially; adjustable later |
| Emission | existing subsidy schedule | unchanged |
| Fees | paid to the block's coinbase | no burn in v1 |

`decimals: 8 → 18` is deliberate. ERC-20 tooling, wallets and DEX maths all assume 18 for a
native asset. Keeping 8 would produce subtly wrong displays everywhere and cost more than the
migration does — and the chain is being reset regardless.

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

**Proof-of-work is unchanged.** `coreHash` covers the whole header core, Homefire runs over it
exactly as today, and `coinbasePub` still binds the miner. Miners receive a template and grind
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
  precompiles.js   0x01–0x05 in v1
chain/
  statetransition.js  apply a transaction, produce a receipt
  bloom.js            logs bloom
rpc/
  eth.js           the eth_* JSON-RPC surface
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

**v1 (required):** `eth_chainId`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount`,
`eth_getCode`, `eth_getStorageAt`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`,
`eth_sendRawTransaction`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`,
`eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getLogs`, `net_version`, `web3_clientVersion`.

**v2:** filters (`eth_newFilter`, `eth_getFilterChanges`), `eth_feeHistory`, `eth_subscribe`.

Served alongside the existing REST API, which stays for the explorer and Forge Pay. Hex quantity
encoding must be exact — `0x0` not `0x00`, no leading zeros — because clients are strict.

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
| **5. Consensus** | block production and validation on the new state model | testnet produces and reorgs |
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
- Precompiles `0x06`–`0x09` (bn128, blake2f) — no v1 use case; add before anything zk arrives.
- State pruning, snapshot sync, archive nodes.
- Lending, stablecoins, anything beyond the AMM.
- Bridges. Every bridge is a liability; not until the chain has proven itself.
