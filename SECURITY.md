# Security Policy

Hearth is money. A consensus bug is not a defect report, it is a loss of funds,
so this policy is written to be usable rather than decorative.

---

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report privately through **GitHub's private vulnerability reporting** on this
repository: *Security → Advisories → Report a vulnerability*
(<https://github.com/cloudsforge-online/hearth/security/advisories/new>). This is
the only monitored intake channel and it is end-to-end private to the maintainers.

Please include:

- what the issue is and what an attacker gains,
- how to reproduce it — a proof of concept, a failing test, or a transaction or
  block that triggers it,
- the affected component (`node/`, `web/`, `contracts/`, `rust/hearthd/`) and the
  commit hash or published version,
- whether you believe it is already being exploited.

**A note on contact channels.** There is currently **no monitored `security@`
mailbox and no published PGP key**. Both are open gaps, tracked in
[`docs/listing-checklist.md`](docs/listing-checklist.md) §5. Until they exist,
GitHub private reporting is the route that actually reaches a human, and we would
rather say that than publish an address nobody reads.

---

## What we commit to

| | |
| --- | --- |
| Acknowledgement | within **72 hours** |
| Initial assessment (severity, whether we can reproduce) | within **7 days** |
| Status updates while a fix is in progress | at least every **14 days** |
| Coordinated disclosure window | **90 days** from acknowledgement, or sooner once a fix ships and is adopted |

If we cannot reproduce an issue we will say so and tell you what we tried, rather
than closing silently. If we disagree that something is a vulnerability we will
say that too, with reasoning, and you remain free to publish.

Credit is given in the advisory unless you ask us not to.

This is a small project. These windows are what we can actually meet, not what
sounds impressive.

---

## Scope

**In scope**

- `node/src/` — consensus, validation, fork choice, reorg, the emission and
  anti-inflation rules, the mempool, P2P, and the REST/JSON-RPC surface.
- `node/src/crypto/`, `node/src/state/`, `node/src/evm/` — the EVM
  implementation. **Any divergence from Ethereum semantics is in scope**, whether
  or not it is currently exploitable: a contract that behaves differently here
  than where it was audited is the failure mode this codebase most needs
  reported.
- `node/src/pow.js`, `node/src/mining.js` and the template/submit protocol.
- `web/assets/keystore.js`, `web/assets/wallet-core.js` and the browser wallet —
  key generation, sealing at rest, and anything that could expose a private key.
- `web/assets/mining/` — the browser miner, including any divergence from the
  node's Homefire digest.
- `contracts/src/` — the AMM sources, even though nothing is deployed.

**Out of scope**

- `rust/hearthd/` — a self-check binary and a benchmark. It has no block type, no
  chain, no fork choice and no P2P server, and two of its modules are known to
  diverge from consensus (see [`MAP.md`](MAP.md) §2.2). It is documented as not
  being a second implementation. Findings are welcome but are not treated as
  consensus issues.
- `proto/` — teaching scripts, not imported by the node.
- `web/pay-demo.html` — a mockup that settles nothing on a timer and says so on
  the control.
- `site/` — the marketing site, except for anything that could compromise a
  visitor.
- Missing hardening on the node's HTTP interface. **The RPC has no
  authentication, no API key and no rate limiting beyond a request-body cap, and
  CORS is `*`.** This is documented, deliberate for a node intended to sit behind
  a proxy, and not a finding. Reports that it should be exposed safely to the
  internet will be closed as "do not expose it".
- Denial of service requiring more resources than the attack yields, and
  volumetric attacks generally.
- Anything requiring physical access to a user's device.

**Especially wanted**

- Anything that mints EMBER outside the subsidy schedule, spends an output twice,
  or makes two honest nodes disagree about the same block.
- Any state root, gas cost or opcode behaviour that differs from Ethereum's under
  Shanghai semantics — ideally as a failing conformance vector.
- Anything that extracts a private key from the browser wallet or the node's
  keystore.

---

## Known and accepted, please do not re-report

These are documented, deliberate, and tracked. A report restating one of them
without new impact will be closed with a pointer here.

- **Homefire is not a non-outsourceable puzzle.** The seed binds only the
  coinbase *public* key (`node/src/pow.js:45-47`), so a pool operator can
  distribute work and sign blocks itself. This is an open consensus decision
  recorded at `node/src/pow.js:8-15` and in [`WHITEPAPER.md`](WHITEPAPER.md) §2.3.
- **Consensus parameters in this tree are dev-tuned** — a 64 KiB Homefire pad,
  256 walk steps, coinbase maturity 10 (`node/src/params.js:51-52`, `:95`). They
  must be raised before mainnet and are tracked in
  [`docs/listing-checklist.md`](docs/listing-checklist.md) §7.
- **Reorgs have no depth limit.** Fork choice is heaviest-cumulative-work with no
  checkpointing and no finality gadget, by design.
- **No RPC authentication or rate limiting** — see "Out of scope" above.
- **Pre-EIP-155 transactions are accepted** on the account-model chain, which
  makes an unprotected transaction cross-chain replayable. This is deliberate and
  is the same trade Ethereum makes; the reasoning is in
  [`docs/evm-spec.md`](docs/evm-spec.md) §3.
- **`PREVRANDAO` is miner-influenceable.** It returns the parent block's Homefire
  digest, and a miner who dislikes an outcome can discard the block and grind
  another. Contracts must not use it as a randomness source for anything an
  adversarial miner would profit from biasing.
- **The browser wallet has no recovery** — one key per browser, no seed phrase,
  no HD derivation.

---

## Status of this codebase

**Pre-mainnet. Nothing here has been independently audited, and no mainnet
exists.** The account-model EVM chain is under construction: primitives and state
pass published reference vectors, the interpreter is being written, and the
state transition, JSON-RPC surface and consensus integration are not built.
[`docs/evm-spec.md`](docs/evm-spec.md) §8 tracks the phases and
[`MAP.md`](MAP.md) is the verified inventory.

An internal review exists at [`docs/security-review.md`](docs/security-review.md)
and its findings are implemented. **It is not an audit and must not be cited as
one.** The intended audit scope is in
[`docs/listing-checklist.md`](docs/listing-checklist.md) §4.

Do not put value on this network. There is nothing of value on it, and until
there is a mainnet with demonstrated hashrate, an independent audit, and the
parameter changes in the checklist, there should not be.

---

## Bug bounty

There is **no funded bug bounty today**. A bounty for consensus, cryptographic
and fund-loss findings is intended, funded from the Commons treasury — which
currently has no implemented spend mechanism, so this is a statement of intent
and not a promise of payment. It is listed as a gap rather than a feature.

---

## Supported versions

Until mainnet, only `main` is supported. The published npm package
`@cloudsforge/hearth-node` tracks `main` and older versions receive no fixes.
