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
- **How do I start?** Install the Hearth app, press *Start your hearth*. Or mine in
  a browser tab with the WASM light-miner from `web/wallet.html`.

## Production vs. proof-of-concept
The JS in `proto/` demonstrates memory-hardness and non-outsourceability so the
ideas are executable and testable. The production algorithm is a hardened,
audited RandomX-class VM implemented in Rust inside `hearthd` — see the
[roadmap](roadmap.md).
