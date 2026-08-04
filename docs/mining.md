# Mining — Homefire

How Hearth keeps mining in the hands of people instead of farms and pools.

> **Shipped vs designed.** Everything under "What the chain does today" is
> implemented in `node/src/` and covered by `npm test`. Everything under "What is
> still design" is not — it is written down so it can be built and argued with,
> not because it is running. This page previously mixed the two, and the mixing
> is what produced the claim that Homefire is non-outsourceable.

## What the chain does today

### 1. Memory-hard (blunts the ASIC advantage)
For each nonce, `node/src/pow.js` does exactly this:

1. derives a seed from the header core, the nonce and the **coinbase public key**,
2. fills a scratchpad by chaining SHA-256 — 8,192 words at the dev size,
3. takes a 256-step pseudo-random walk that reads *and rewrites* the pad,
4. hashes the accumulator plus the tail of the pad, and checks it against the target.

That is ~8,450 sequential SHA-256 rounds per attempt with a data dependency at
every step, so the bottleneck is memory latency rather than gate count and a
general-purpose CPU sits close to the optimal machine. Production sizes (~2 GiB,
more steps) make the pad itself the barrier.

It is **not** a RandomX-class VM: nothing is compiled, and there is no program to
execute. Growing it into one is **not scheduled and is not claimed** — see
[roadmap.md](roadmap.md), "Dropped, or never real". Until it exists,
"RandomX-class" is not a description of Homefire.

### 2. A winning proof cannot be redirected
A valid block must be **signed by the private key its coinbase pays**:

```
solution = { nonce, digest, sig }   where   sig = Sign(coinbase_privkey, digest)
```

So a candidate built for your public key is worth nothing to anyone else, and
work handed to you cannot be taken from you. `node/test/mining-api.js` proves
exactly this, and no more.

**Under the account model the key changes and the hashing does not.** `coinbasePub`
becomes a **secp256k1** public key, because the coinbase has to *receive* the block
reward and the fees and so must be an account this chain can credit
([`evm-spec.md`](evm-spec.md) §4). Homefire — the pad fill, the walk, the digest —
is untouched, as is LWMA. The browser miner has already moved
(`web/assets/mining/miner.js:24-46`) and `node/test/browser-pow.js` still passes
digest for digest.

**The node moved, and this paragraph did not.** It used to say the node still
required an 88-hex SPKI DER *Ed25519* key, citing `node/src/rpc.js:130-134` and
`node/src/block.js:45`, and concluded that the browser miner could not mine a
block this node would accept. Three other documents said the same thing. All four
were reading THE UTXO CHAIN — `rpc.js` and `block.js` are that chain's REST server
and that chain's block rules, and they will require Ed25519 for as long as they
exist, because it is a different chain with a different curve.

The account model has its own REST server and its own template issuer, and they
require secp256k1: `node/src/chain/miner.js` `issue()` refuses anything that is
not a 65-byte uncompressed secp256k1 key, and `node/src/chain/header.js`
`verifyPow` recovers a secp256k1 key from the proof signature. That is exactly
what the browser miner signs with. Four documents agreeing is not one of them
agreeing with the node.

**There WAS a real mismatch, and it was one byte.** `POW_SIG_FORM` said `r || s`,
64 bytes, no recovery id; the node requires 65 — `r || s || recoveryId` — because
`verifyPow` recovers the coinbase key from the signature rather than reading one.
Every block the browser miner found was answered `bad signature` after the work
was done. Fixed, and now checked rather than described:
`node/test/browser-proof.js` imports the browser's own `proofSignature`, signs a
real winning digest and requires the node's template flow to produce a block.

**This is not non-outsourceability, and this document used to say it was.** The
private key is used *after* a nonce wins (`node/src/miner.js`), never inside the
hash loop, and only the public key is bound into the seed. A pool operator can
therefore hand out `coreHash` plus its **own** pubkey, collect `(nonce, digest)`
pairs from hashers who genuinely cannot steal the reward, and sign the blocks
itself. Nothing in consensus notices.

Closing that means committing to the private key inside the loop — a consensus
change that forks the chain and invalidates the CI-conformance-tested browser
miner. It is deliberately open, not overlooked.

### 3. Low variance, so far
- **15-second blocks** → frequent wins even for small miners.
- **Per-block LWMA difficulty** → smooth, no wild swings.

### 4. Polite mining, in the browser miner
`web/assets/mining/` implements, and `web/mine.html` exposes:

- an **effort slider** that is a real duty cycle — workers sleep proportionally
  between batches rather than pinning a core;
- a **background-tab trickle**: a hidden tab is clamped to 15% effort;
- **pause on battery**, where the browser reports power state. The Battery Status
  API is Chromium-only (Firefox and Safari removed it), so the page says which of
  the two it got rather than promising power-awareness everywhere.

## What is still design

None of the following exists in this repository. Do not describe them as features.

- **Warmshares (uncles)** — near-miss blocks referenced by later blocks for a
  fraction of the reward, to pay for honest work that just missed.
- **Trustless co-ops** — peers sharing variance over a P2P protocol that never
  takes custody of a key.
- **Idle detection** — "mine only when the machine is idle" is not implementable
  from a web page: `requestIdleCallback` means "this tab's event loop is quiet",
  which is always true for a page that only mines, and the Idle Detection API is
  permission-gated and Chromium-only.
- **Thermal-aware back-off** — no temperature source is available to either the
  node or the browser.
- **A non-outsourceable puzzle** — see §2 above.
- **A RandomX-class VM** — see §1 above. Not scheduled.

## Mining in a browser

`web/mine.html` is a real miner, not a demo: the same Homefire the node runs,
hashing in a pool of Web Workers, submitting blocks to a live chain.

**Why a browser can do this at all.** The winner must sign the digest with the key
the coinbase pays, so a browser has to hold its own key — which it already does,
in the wallet. The node hands out a candidate built for *your* public key and
keeps the transactions; you return a nonce, a digest and a signature. Your
private key never leaves the page.

  GET  /mining/template?pub=<65-byte uncompressed secp256k1, hex>
                                            → header core, target, PoW params,
                                              and the rest of the core header so
                                              you can CHECK the work pays you
  POST /mining/submit  {templateId, nonce, powDigest, powSig}

`powSig` is 65 bytes: `r || s || recoveryId`. Both endpoints are metered rather
than authenticated — see `MINING_VERIFY_BURST` in `node/src/params.js` for why a
permissionless chain should not put a credential on `submit`, and what it puts
there instead.

The node cannot mine on your behalf and cannot take work built for your key.
That is a real guarantee about *this* endpoint; it is not a guarantee that no
pool can exist (§2).

**Why it is not slow.** One attempt is ~8,450 SHA-256 rounds — 8,192 to fill the
scratchpad, 256 to walk it. `crypto.subtle.digest` is async, so WebCrypto would
mean thousands of promises per nonce. `web/assets/mining/sha256.js` is a
synchronous implementation that allocates nothing in the hot path, and
`homefire.js` keeps one scratchpad across attempts. Measured at the dev params
(64 KiB / 256 steps), that is **~225 H/s per thread — about 1.37× the node's own
native-crypto implementation**, because `createHash`'s per-call overhead
dominates when you need thousands of calls.

**Politeness, concretely.** An effort slider sets a duty cycle; workers sleep
proportionally between batches rather than pinning a core. A hidden tab drops to
a trickle, and an unplugged laptop stops entirely where the browser will say so.
The loop yields for a second reason too: a Worker that never yields cannot
receive `postMessage`, so it could not be stopped or handed new work.

**Correctness.** A digest that differs from the node's in one bit would mine
nothing while looking busy for hours. `node/test/browser-pow.js` compares the two
implementations directly — SHA-256 padding edges, `powSeed`, Homefire digests,
target comparison — then mines a block with the browser code and has the node
verify it. `node/test/mining-api.js` drives the HTTP endpoints and asserts that a
proof signed by anyone but the coinbase key is rejected. Both run in CI.

## Difficulty & security
- Retarget every block with LWMA to resist timestamp manipulation and hashrate
  swings.
- The **perpetual tail** (0.3 EMBER/block) guarantees a standing reward, so
  security never depends on a speculative fee market (no "fee cliff").

## FAQ for miners
- **Do I need a GPU or ASIC?** No. A normal CPU is the intended machine. GPUs and
  ASICs gain little to nothing.
- **Can I join a pool for steadier payouts?** None exists today, and nothing in
  the protocol prevents one from being built — a pool would hand out work under
  its own key and pay hashers off chain. What consensus *does* guarantee is that
  work handed to you under your own key cannot be taken from you.
- **Will it drain my battery?** The browser miner pauses on battery where the
  browser reports power state, and throttles to your effort setting otherwise.
  `hearthd --mine` has a duty-cycle throttle and no power awareness at all.
- **How do I start?** Open `web/mine.html`, create or load a key, press *Start
  mining*. Or run a node with `hearthd --mine`. There is no WASM light-miner and
  never was — this line used to promise one in `web/wallet.html`.

## Production vs. proof-of-concept
`node/src/pow.js` is the algorithm the chain actually runs, and
`web/assets/mining/homefire.js` is its conformance-tested browser twin. The JS in
`proto/` is an earlier sketch of the same memory-hard core.

`rust/hearthd/src/pow.rs` is **not** a second implementation of consensus: it
omits the coinbase pubkey from the seed, so it computes a different digest for
the same header. See [why-two-implementations.md](why-two-implementations.md).
A hardened, audited RandomX-class VM is **not scheduled and is not claimed** — see
[roadmap.md](roadmap.md), "Dropped, or never real".
