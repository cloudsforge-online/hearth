# proto/ — economics simulator & standalone PoW demo

Small, dependency-free scripts that make Hearth's core ideas *runnable* on their
own. For the full working node, see [`../node`](../node) and [`../rust`](../rust).

## `emission.js` — coinnomics model
Reproduces every number in [`../docs/coinnomics.md`](../docs/coinnomics.md): the
emission curve, perpetual tail, fee burn, and net inflation over 30 years.

```bash
node emission.js
```

Edit the constants at the top (`R0`, `HALFLIFE_YEARS`, `TAIL`, burn ramp) to
explore alternative monetary policies.

## `pow.js` + `mine.js` — Homefire proof-of-concept
A minimal model of two mechanisms: **memory-hardness** (every attempt must fill
and randomly walk a scratchpad) and a **proof that cannot be redirected** (the
solution must be signed by the key the coinbase pays, so work handed to you
cannot be taken from you).

```bash
node mine.js 16     # mine a toy block at 16-bit difficulty; a node then verifies it
```

You'll watch your CPU find a block, sign it, and a verifier accept it — and see
why nobody else could have redeemed that block without your private key.

> **This is not non-outsourceability, and this file used to say it was.** Only
> the coinbase *public* key goes into the seed; the private key signs after a
> nonce has already won. A pool operator can therefore hand out work under its
> own key and pay hashers off chain. Closing that needs the private key inside
> the hash loop — an open consensus decision, not a property Hearth has.
> See [`../docs/mining.md`](../docs/mining.md).

> These are teaching artifacts. The algorithm the chain actually runs is
> [`../node/src/pow.js`](../node/src/pow.js); the RandomX-class VM in
> [`../rust/hearthd`](../rust/hearthd) is a roadmap item, and that crate's PoW is
> not currently consensus-compatible.
