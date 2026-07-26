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
A minimal model of the two mechanisms that keep mining with people:
memory-hardness and **non-outsourceability** (the solution must be signed by the
coinbase key, so pools can't form).

```bash
node mine.js 16     # mine a toy block at 16-bit difficulty; a node then verifies it
```

You'll watch your CPU find a block, sign it, and a verifier accept it — and see
why a pool couldn't have mined it for you without your private key.

> These are teaching artifacts. The production algorithm is the RandomX-class VM
> in [`../rust/hearthd`](../rust/hearthd) and the reference logic in
> [`../node`](../node). See [`../docs/mining.md`](../docs/mining.md).
