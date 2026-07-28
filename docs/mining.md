# Mining — Homefire

How Hearth keeps mining in the hands of people instead of farms and pools.

## The three mechanisms

### 1. CPU-optimized & memory-hard (kills the ASIC advantage)
Homefire is a **RandomX-class** proof-of-work. For each nonce the miner:

1. derives a seed from the block header + coinbase key,
2. compiles a **pseudo-random program** from that seed,
3. executes it against a large (~2 GiB) **dataset that must reside in RAM**,
4. hashes the result and checks it against the target.

Because the program is random and memory-bound, a general-purpose CPU is close to
the optimal machine. Custom silicon can't meaningfully beat commodity hardware,
so there's little reason to build farms. The bottleneck is **memory bandwidth**,
which your laptop already has.

The proof-of-concept ([`../proto/pow.js`](../proto/pow.js)) models the memory-hard
core at toy scale: fill a scratchpad, take a pseudo-random walk that reads *and
writes* it, then derive the digest from the whole pad.

### 2. Non-outsourceable (kills the pool)
CPU-fairness isn't enough: pools recentralize by coordinating many miners. Hearth
removes the incentive. A valid block must be **signed by the private key that
receives the reward**:

```
solution = { nonce, digest, sig }   where   sig = Sign(coinbase_privkey, digest)
```

To mine "for" someone through a pool, that pool would need the key that controls
the reward — i.e. the power to steal it. So rational miners mine **solo**, and
there's no central operator to censor or reorganize around.

See `attempt()` and `verify()` in the PoC; run it to watch the signature check:

```bash
node proto/mine.js 16
```

### 3. Low variance without a pool
Solo mining is bursty, so Hearth smooths income *without* reintroducing pools:

- **15-second blocks** → frequent wins even for small miners.
- **Per-block LWMA difficulty** → smooth, no wild swings.
- **Warmshares (uncles)** → near-miss blocks are referenced by later blocks and
  earn a fraction of the reward, paying you for honest work that just missed.
- **Trustless co-ops (optional)** → peers share variance over a P2P protocol that
  *never* takes custody of a key. It's the benefit of a pool with none of the
  centralization.

## Polite mining (why it won't wreck your machine)
The Hearth app mines as a good houseguest:

- default to **AC power only** and **idle CPU**, so laptops on battery are left alone;
- **throttle** to a user-set share of cores (e.g. 35%);
- **thermal-aware** back-off;
- one toggle: *Start your hearth* / *Pause*.

Mining should be invisible — spare cycles turned into money, not a space heater.

## Mining in a browser

`web/mine.html` is a real miner, not a demo: the same Homefire the node runs,
hashing in a pool of Web Workers, submitting blocks to a live chain.

**Why a browser can do this at all.** Non-outsourceability means the winner must
sign the digest with the key the coinbase pays, so a browser has to hold its own
key — which it already does, in the wallet. The node hands out a candidate built
for *your* public key and keeps the transactions; you return a nonce, a digest
and a signature. Your private key never leaves the page.

  GET  /mining/template?pub=<spki-der-hex>   → header core, target, PoW params
  POST /mining/submit  {templateId, nonce, powDigest, powSig}

The node cannot mine on your behalf and no operator can take your work, because
work built for your key is worthless to anyone else. That is the same property
that kills pools, applied to a browser tab.

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
a trickle. The loop yields for a second reason too: a Worker that never yields
cannot receive `postMessage`, so it could not be stopped or handed new work.

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
- **Can I join a pool for steadier payouts?** There are no custodial pools by
  design. Use warmshares + an optional trustless co-op instead.
- **Will it drain my battery?** Not by default — polite mining runs on AC/idle and
  throttles.
- **How do I start?** Open `web/mine.html`, create or load a key, press *Start
  mining*. Or run a node with `hearthd --mine`. There is no WASM light-miner and
  never was — this line used to promise one in `web/wallet.html`.

## Production vs. proof-of-concept
The JS in `proto/` demonstrates memory-hardness and non-outsourceability so the
ideas are executable and testable. The production algorithm is a hardened,
audited RandomX-class VM implemented in Rust inside `hearthd` — see the
[roadmap](roadmap.md).
