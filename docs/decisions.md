# Decisions — settled, and still open

Some of what this chain does is not obvious from reading the code afterwards,
because the reasoning lived in the argument and not in the result. This page is
where that reasoning is kept.

It is not a second specification. [`evm-spec.md`](evm-spec.md) is the contract
every component is built against and it stays authoritative; this file
consolidates the decisions recorded across it, `SECURITY.md`,
[`listing-checklist.md`](listing-checklist.md) and
[`network-config.md`](network-config.md) so that a reader does not have to know
which document to look in.

Every settled decision cites the source that implements it. Every open decision
says who it blocks.

---

## 1. Settled

### 1.1 `PREVRANDAO` returns the parent block's Homefire digest, and is miner-influenceable

`PREVRANDAO` (`0x44`) is beacon-chain randomness on Ethereum, and Hearth has no
beacon chain. Returning the difficulty target — what pre-merge Ethereum did, and
what most proof-of-work EVM forks still do — would be nearly useless here,
because our target moves slowly and is close to constant between adjacent
blocks. So it returns the parent block's Homefire proof-of-work digest: a real
256-bit hash, deterministic, and verifiable by anyone
(`node/src/evm/interpreter.js`; the same value the RPC serves as
`mixHash`, `node/src/jsonrpc/methods.js`).

**It is miner-influenceable.** A miner who dislikes an outcome can discard the
block and grind another. That is true of every proof-of-work-derived randomness
source, and it is stated in those words because contracts routinely misuse
`block.prevrandao` as a randomness source. **It must not be used for anything an
adversarial miner would profit from biasing.**

Reasoning: [`evm-spec.md`](evm-spec.md) §5.

### 1.2 `BASEFEE` pushes zero

`BASEFEE` (`0x48`) exists because Shanghai includes EIP-3198, and removing it
would make Shanghai-compiled Solidity fail here while working on Ethereum. v1 has
no EIP-1559, so it pushes zero until a fee market lands in v2
(`node/src/evm/interpreter.js`). Do not price anything off it.

### 1.3 Nine precompiles are warmed; all nine are now implemented

EIP-2929 pre-warms `0x01`–`0x09`, and so do we
(`node/src/chain/statetransition.js`). The warm set is a **gas
rule, not a capability claim**: Ethereum warms all nine, the GeneralStateTests
assume it, and treating an address as cold that Ethereum treats as warm costs
2,500 gas per access — which is a chain split.

For a period, nine were warmed and five were implemented. `0x06`–`0x09` were made
to **fail loudly** rather than be absent, and that was the whole point: in the
EVM **a call to an address with no code succeeds and returns empty**, so a zk
verifier calling a missing pairing check would read the empty return as a zero
and accept a forged proof. Failing the call and burning the forwarded gas is the
only behaviour that surfaces the gap.

**All nine are implemented now** (`node/src/evm/precompiles.js`, bn128 in
`node/src/evm/bn128.js`, blake2f in `node/src/evm/blake2f.js`), so warmed and
implemented coincide. The interpreter keeps the machinery to fail a warmed,
unimplemented address, because a future fork can pull the two apart again.

The two conventions are both consensus and they are opposites:

| Precompiles | Malformed input |
| --- | --- |
| `0x01`–`0x05` | **empty output, successful call.** Solidity's `ecrecover()` maps that empty return to `address(0)`, which is what every `require(signer != address(0))` in every permit implementation tests. Getting it wrong breaks Uniswap V2's permit path |
| `0x06`–`0x09` | **the call FAILS and burns every drop of forwarded gas.** A coordinate outside the field, a point off the curve, a G2 point outside the r-torsion, a pairing input whose length is not a multiple of 192, a blake2f block that is not exactly 213 bytes or whose final flag is neither 0 nor 1 |

Validity checks live in `run`, never in `gas`, and that is a security property
rather than a style choice: `gas` is consulted before the interpreter tests
affordability, so any work it does is work an attacker buys for the ~130 gas a
`CALL` costs (`node/src/evm/precompiles.js`).

Reasoning: [`evm-spec.md`](evm-spec.md) §5.

### 1.4 Pre-EIP-155 transactions are accepted

Both EIP-155-protected and pre-155 unprotected transactions are accepted, exactly
as Ethereum does (`node/src/chain/transaction.js`).

This is not laziness. A whole tier of ecosystem infrastructure is deployed by
*keyless* presigned transactions — a made-up signature broadcast from an address
nobody controls, so the contract lands at the same address on every chain.
Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` is deployed exactly
this way and every front-end and indexer assumes that address. Reject pre-155 and
that address is permanently unreachable here, and every tool needs hand
configuring.

The trade is that an unprotected transaction is replayable on any chain that
accepts them. That risk sits with the sender, every modern wallet signs with
EIP-155 by default, and it is the same trade Ethereum itself makes.

Reasoning: [`evm-spec.md`](evm-spec.md) §3.

### 1.5 The coinbase key moves to secp256k1; Homefire itself is untouched

§2 of the spec moves accounts to secp256k1, and the coinbase has to *receive* the
block reward and the fees — so it must be an account this chain can credit.
`coinbasePub` therefore becomes a secp256k1 public key and the block signature
becomes a secp256k1 signature.

**Homefire is not changed by this.** The pad fill, the walk and the digest are
untouched, as are LWMA and everything in `node/src/pow.js`. The hashing half was never
in question; only the key type changed.

The wire form of the proof signature is `r || s || recoveryId`, 65 bytes, and it is now
defined in exactly one place that is also the only implementation of it — `signProof`
in `node/src/chain/header.js`. The `POW_SIG_FORM` constant that used to mirror
it in the browser miner is gone, along with the miner
(`48bc28a`). See §2.5.

Reasoning: [`evm-spec.md`](evm-spec.md) §4.

### 1.6 EMBER has 18 decimals

`decimals: 8 → 18`. ERC-20 tooling, wallets and DEX maths all assume 18 for a
native asset; keeping 8 would produce subtly wrong displays everywhere and cost
more than the migration does — and the chain is being reset regardless.

**This is specified and not yet implemented.** `node/src/params.js` still
defines `SPARKS_PER_EMBER = 100_000_000`, and the emission function at
`params.js` still returns sparks. Integrate against 18; see §2.6.

Reasoning: [`evm-spec.md`](evm-spec.md) §1.
Tracked: [`listing-checklist.md`](listing-checklist.md) §7 M3.

### 1.7 Deposits confirm at 60 blocks, not 3

The published recommendation to exchanges is **60 confirmations** for a small
deposit and 240 for a large one, ~15 minutes and ~1 hour respectively
([`exchange-integration.md`](exchange-integration.md) §4). 60 is roughly 60× the
natural orphan depth on a 15-second chain.

The estate's own payment rail now credits at that same depth —
`repos/forge-pay/services/pay/src/chains.ts` records EMBER's depth as 60
blocks. It previously did not, and the mismatch between what was published and
what was credited is exactly the class of error this page exists to stop.

The caveat that matters more than the number: **fork choice has no depth limit**,
no checkpointing and no finality gadget, so confirmations are not safety on a
chain with little hashrate. The controls at launch are economic, not depth-based.

### 1.8 The Ethereum JSON-RPC is served on port 8545, at the root path

Owner decision: use the port the ecosystem already defaults to. It is MetaMask's
localhost default and what every Hardhat and Foundry tutorial assumes, so a
developer's first guess is correct. Verified free across the whole composed
stack.

The REST API stays on 8645. Mounting the Ethereum RPC there would have collided
with the legacy `POST /rpc` handler (`node/src/rpc.js`), and a client would
have received a 200 that is not JSON-RPC 2.0 — which reads as an empty chain
rather than as a misconfiguration. Two ports, two protocols, no ambiguity.

**It is served.** `node/src/evmnode.js` constructs
`node/src/jsonrpc/server.js` and listens on 8545; `hearthd --evm` is the flag
that gets you there. 8546 stays reserved and unbound for the v2 WebSocket
endpoint.

Reasoning: [`evm-spec.md`](evm-spec.md) §6, which also reserves 8546 for the v2
WebSocket endpoint.

### 1.9 The testnet gets its own chain id, 7412

Mainnet is 7411; testnet is **7412**.

The retired UTXO scheme carried a `net` field *inside the signed transaction
body*, so a testnet signature was structurally invalid on mainnet. EIP-155
replaces that with the chain id — and if both networks declare 7411, **every
testnet transaction is replayable on mainnet and back**: same key, same nonce,
same bytes, valid on both.

`node/src/chain/transaction.js` currently declares a single `CHAIN_ID`
constant. **Nothing may hardcode it** — it is per-network configuration.

Reasoning: [`evm-spec.md`](evm-spec.md) §1.

### 1.10 The EVM is implemented here rather than imported

No `@ethereumjs/*`, no `ethers`, no `web3`. Node's built-in `crypto` is permitted
for SHA-256, RIPEMD-160 and randomness; everything Ethereum-specific is ours.

That is only defensible because the reference vectors exist, so the rule is that
**every component ships against published vectors and conformance is CI-gating**.
See [`evm-spec.md`](evm-spec.md) §0 and
[`../node/test/conformance/README.md`](../node/test/conformance/README.md).

---

## 2. Open

These are not oversights. Each is written down because it has to be decided
deliberately, and because several of them become unchangeable the moment they are
published.

### 2.1 `nativeCurrency.name` and `shortName`

**SLIP-44 coin type 170 is already registered as `MBRS / Ember`** — an unrelated
coin (`satoshilabs/slips/slip-0044.md`, line 203). The *symbol* `EMBER` is free;
the *name* `Ember` is taken.

Expect registration to require a distinguishing name — `Hearth` or `Hearth EMBER`
rather than `Ember` — and expect an aggregator or wallet to raise the ambiguity.
`shortName` in `ethereum-lists/chains` must additionally be globally unique and is
not chosen.

**Decide this before filing anything else.** It propagates into the chains
registry, the token list, CoinGecko, CoinMarketCap and every exchange form, and
inconsistency across those is a common and entirely self-inflicted rejection
reason.

Blocks: [`listing-checklist.md`](listing-checklist.md) §1.1, §1.3, §1.4.

### 2.2 Multicall3 — the canonical presigned deployment, or ours

Front-ends, wallets, viem's batching and most indexers look for Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11` on every chain. That address comes
from a pre-signed, pre-EIP-155, keyless transaction carrying solc 0.8.12 / london
bytecode, replayed identically everywhere. Hearth accepts pre-155 transactions
specifically so that route stays open (§1.4).

`contracts/src/Multicall3.sol` is **not** that bytecode — it is a 0.8.26 /
shanghai build with `getCurrentBlockDifficulty` respelled. Deploying it yields a
different address, which defeats the entire point.

[`evm-spec.md`](evm-spec.md) §3 states the intent — deploy from the canonical
presigned transaction, keep our source as readable reference — but nothing is
deployed and no presigned payload is committed to this repository, so the decision
is not yet executed. **Decide before front-ends hard-code an address, not after.**

Until it exists at a known address, do not configure Multicall3 in viem or wagmi:
a configured address with no code makes every batched read return empty, which
reads as "the contract said zero" rather than as an error.

### 2.3 There is no `security@` mailbox, and no PGP key

Disclosure runs through GitHub's private vulnerability reporting, which works and
is verifiable ([`../SECURITY.md`](../SECURITY.md)). Several exchange forms require
an email address and a named contact, so provisioning one is a prerequisite rather
than a nicety. There is likewise no PGP key for encrypted reports, and no
published incident-response or chain-halt procedure.

Blocks: [`listing-checklist.md`](listing-checklist.md) §5.

### 2.4 The Commons address under the account model, and whether anything can spend it

The current Commons sink is `ember1commons00000000000000000000000000cmns`
(`node/src/params.js`) — a UTXO-era address that is not even checksum-valid.
Under the account model it becomes a `0x…` address, and **that address has not
been chosen** and is not in the spec.

Separately and more importantly: **there is no spend path at all.** No proposal
mechanism, no voting contract, no multisig, no key. Nothing in this repository can
move a coin out of the Commons address. Whether that reads as "no issuer" or as
"an undistributed reserve controlled by whoever eventually holds the governance
keys" depends entirely on what governance turns out to be, and that is a question
a regulator will ask.

Blocks: [`listing-checklist.md`](listing-checklist.md) §6, §7 M7 and M8;
[`tokenomics.md`](tokenomics.md) §8.

### 2.5 The proof-signature wire form — SETTLED, and it was wrong

`r || s || recoveryId`, 65 bytes, signed over the winning Homefire digest.

This was open, and while it was open it was not merely undecided — it was
decided differently on the two sides. `POW_SIG_FORM` said 64 bytes with no
recovery id, reasoning that the header already carried `coinbasePub`. The node
had gone the other way and required 65, because `verifyPow`
(`node/src/chain/header.js`) recovers the key from the signature rather than
reading one. So every block the browser miner found was refused `bad signature`
after the work was done, which from the miner's side is indistinguishable from
never having won.

The constant was supposed to prevent exactly this — "a mismatch with the node is
a grep, not an investigation" — and it did not, because it was kept faithfully in
sync with the wrong answer. A constant that names a format is documentation, and
documentation cannot be wrong loudly.

The lesson is in the fix, not in the value: a format must be **executed** by the test,
not described by a constant. The fix at the time was to export `proofSignature` from the
browser miner so `node/test/browser-proof.js` could call the browser's own code, sign a
real winning digest and require the node's template flow to accept the block.

**That machinery is gone, and so is the failure mode.** The browser miner and both
suites were deleted in `48bc28a`. There is now exactly one implementation of the proof
signature — `HDR.signProof` — and every miner calls it (`node/src/chain/miner.js`,
`node/src/mine/session.js`). Two implementations cannot drift when there is one.
The principle still applies to the next port anyone writes.

### 2.6 `SPARKS_PER_EMBER` is still 1e8

18 decimals is decided (§1.6) and not implemented. Until `node/src/params.js`
moves, the tree's arithmetic is in sparks while every document integrates against
wei. This is a hard fork to change and free before mainnet.

Blocks: [`listing-checklist.md`](listing-checklist.md) §7 M3.

---

## 3. Related

- [`evm-spec.md`](evm-spec.md) — the authoritative specification
- [`../MAP.md`](../MAP.md) — what is in this repository, cited to `path:line`
- [`listing-checklist.md`](listing-checklist.md) — the gap list
- [`network-config.md`](network-config.md) — every form of the connection details
- [`../SECURITY.md`](../SECURITY.md) — disclosure, scope, and known-and-accepted
