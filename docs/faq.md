# FAQ

### Is this a live coin I can buy?

**No.** Mainnet is live — chain id 7411 at `https://rpc.cloudsforge.online` — but
there is **no market, no listed price, no liquidity and no EMBER of any monetary
value** in existence. Nobody sells it and nobody quotes it. There is no premine
and no sale: you mine or earn EMBER, you do not buy it. Anyone offering to sell
you some is running a scam. See the [roadmap](roadmap.md).

### What is Hearth, in one sentence?

A proof-of-work chain that ordinary people can mine on the computer they already
own, which **speaks Ethereum** — `0x…` addresses, secp256k1, 18 decimals, chain
id 7411, Shanghai semantics, standard `eth_*` JSON-RPC — so that developers can
build on it with the tools they already have.

### It says "EVM-executing". Is that real, or a plan?

Real, and checkable. The EVM is written in this repository — no `@ethereumjs/*`,
no `ethers`, no `web3` — and every component is gated on Ethereum's published
reference vectors:

| | |
| --- | --- |
| VMTests | **609 / 609** |
| GeneralStateTests | **20,077 / 20,077** — see [`MAP.md`](../MAP.md) §4.3 |
| TransactionTests | **188 / 188** |

And it runs real contracts: `node/test/dex.js` deploys the whole Uniswap V2 stack
onto it and executes a swap at **112,456 gas**, 167/167 checks. The commands to
reproduce all of that are in the [README](../README.md).

### So can I deploy a contract to it today?

**Yes — to mainnet.** Point your tooling at `https://rpc.cloudsforge.online`,
chain id 7411. Locally, `hearthd --evm --mine` produces and validates blocks and
serves `eth_*` on 8545, and `docker-compose.testnet.yml` runs three nodes on
chain id 7412 — but that testnet is **not** publicly reachable, so it is your
machine only.

Two warnings before you do. The chain is hours old and runs on one home server
behind one tunnel with no failover, so do not deploy anything you cannot afford
to lose to an outage. And nothing here has been independently audited
([`../SECURITY.md`](../SECURITY.md)). The throughput defect that used to be the second half
of this answer (`StateDB` re-rooting both tries per mutation, 443 MB and 65 s for
one 30M-gas transaction) is fixed and gated at 5.2 s and 9.2 MiB
([`robustness-review.md`](robustness-review.md) §1).

What you *can* do today is run `node tools/rpc-probe/stub.js`, which serves the
real `eth_*` method surface over a chain with no state. It will not execute
anything, but it will prove your chain id handling, your encodings and your
legacy-pricing path. [`quickstart.md`](quickstart.md) marks every step **[RUN]**,
**[PROBE]** or **[WAITING]** so nothing is ambiguous.

### Why write your own EVM instead of importing one?

Because the alternative was a dependency tree in consensus-critical code, and
because Ethereum publishes reference vectors for every part of the EVM — which is
the only thing that makes writing one survivable. The rule is that **no component
is done until its vectors pass**, and if a vector cannot be made to pass, the
correct response is to say so rather than skip it
([`evm-spec.md`](evm-spec.md) §0).

The node has **zero runtime dependencies**, EVM included.

### How is this different from Bitcoin?

Bitcoin is optimized to be *digital gold*: ASIC-mined, hard-capped, hoarded.
Hearth is CPU-mined, uncapped but disinflating into a perpetual tail, and it
executes contracts. Bitcoin's fee-only future is an unproven security budget; a
perpetual tail means miners are always paid.

### How is it different from Monero?

Hearth borrows Monero's memory-hard CPU mining and its tail emission. It does
**not** borrow Monero's privacy: **Hearth has no stealth addresses and no view
keys**, and an account-model EVM chain has transparent balances by construction,
the same as Ethereum. Earlier versions of this page said otherwise; that was
wrong.

Homefire is memory-hard chained SHA-256 over a scratchpad, **not** a RandomX-class
VM. It compiles nothing.

### Can't someone just buy 10,000 CPUs and farm it anyway?

They can buy hardware, and they get 10,000 CPUs' worth of hashrate — the goal is
*proportional* mining, not one-person-one-vote. What they gain little of is a
per-dollar advantage: Homefire is memory-latency-bound, so there is no meaningful
ASIC edge.

They **can** run a pool. Only the coinbase *public* key is bound into the proof, so
an operator can hand out work under its own key, collect nonces from hashers who
genuinely cannot steal the reward, and sign the blocks itself. Closing that
requires the private key inside the hash loop, which forks the chain and breaks
the conformance-tested browser miner. It is a **recorded open decision, not a
property Hearth has** — see [mining.md](mining.md).

### Uncapped supply — won't it inflate away?

Emission is disinflationary into a small perpetual tail. Supply growth as a
percentage falls forever without reaching zero: **1.71% at year 10, 1.28% at year
30**, and lower after.

**There is no fee burn.** Earlier documents modelled net inflation approaching
~0% via an EIP-1559-style burn; that is withdrawn. On the account-model chain
`gasUsed × gasPrice` is paid **to the block's coinbase**, with no burn in v1.
Assume gross issuance equals net issuance. The real numbers are in
[tokenomics.md](tokenomics.md); [coinnomics.md](coinnomics.md) is a *model* and
labels itself as one.

### Why a tail emission at all?

To avoid the **security cliff**. Chains that plan to pay miners "by fees alone"
have an unproven security budget. A perpetual tail guarantees miners are always
paid.

### Is `block.prevrandao` safe to use as randomness?

**No.** `PREVRANDAO` returns the parent block's Homefire proof-of-work digest —
a real 256-bit hash, deterministic and verifiable — and it is
**miner-influenceable**: a miner who dislikes an outcome can discard the block and
grind another. Do not use it for anything an adversarial miner would profit from
biasing. That is true of every proof-of-work chain deriving randomness from its own
header, and it is stated plainly because contracts misuse it routinely
([`decisions.md`](decisions.md) §1.1).

### Do I need to be technical to use it?

A browser wallet and in-tab mining need nothing installed, and keys stay on your
device. Running a node today means `node bin/hearthd.js --mine`. The one-click
desktop app is scaffolding, not something you can download.

### How do merchants accept it?

**They can't.** There is no SDK, no wallet handoff and no payment channel layer. The
closest thing that ever existed was `pay-demo.html`, a **mockup** that simulated its own
settlement on a 1,200 ms timer and said so on the control — and it was deleted with
`web/` in `48bc28a` rather than finished. When there is a chain, accepting EMBER will be
the same job as accepting ETH.

### Who funds development if there's no ICO?

The **Commons treasury**: 10% of every block subsidy, minted to an on-chain
address block by block. It is not a premine — it holds nothing at genesis.

**There is no way to spend it.** No proposal mechanism, no voting contract, no
multisig, no key. Earlier documents described "hybrid coin-weighted /
one-node-one-vote governance"; that was a design sketch, never a mechanism. Today
the treasury is an accumulator, and under the account model it also needs a `0x…`
address that has not been chosen ([`decisions.md`](decisions.md) §2.4).

### Has any of this been audited?

**No.** Nothing in this repository has been independently audited.
`docs/security-review.md` is an internal review of the **UTXO-era** code that
predates every line of the EVM, and it must never be presented as an audit. The
intended audit scope is in [listing-checklist.md](listing-checklist.md) §4.

Conformance vectors make writing an EVM tractable. They do not make it audited.

### What should I not trust in this repository?

- `rust/hearthd` as a second opinion about consensus — it is a self-check and a
  benchmark, with two modules that would produce the wrong answer if wired up.
- `proto/emission.js` as the emission schedule — it is a smooth-exponential
  *model* and differs from the chain by ~3.5% in year one.
- Any front end in this repository — there is none. `web/` and `site/` were deleted in
  `48bc28a`; the successors are listed in [`../MAP.md`](../MAP.md) §3.4.
- Any status line anywhere that disagrees with [`../MAP.md`](../MAP.md), which
  cites `path:line` for every claim.

### Where do I start contributing?

Publishing the testnet — it runs on loopback and nothing routes it, so the
gap between "a stranger can deploy unaided" and the truth is deployment, not
code. After that, the proof of work: it runs at a 64 KiB pad, the 2 GiB the
documents promised is unreachable at 185.7 s per evaluation, and making it
genuinely memory-hard means an amortised dataset across three implementations
([`pow-parameters.md`](pow-parameters.md)). See [CONTRIBUTING.md](../CONTRIBUTING.md) and the
[roadmap](roadmap.md).
