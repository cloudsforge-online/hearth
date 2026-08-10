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
- the affected component (`node/`, `contracts/`, `rust/hearthd/`, `app-desktop/`) and
  the commit hash or published version,
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
- `node/src/jsonrpc/` — the `eth_*` surface, including anything that would make a
  client read a wrong value as a correct one (the QUANTITY/DATA distinction above
  all).
- `node/src/pow.js`, `node/src/mining.js` and the template/submit protocol.
- `node/src/cli/` and `node/bin/hearth.js` — the terminal tool, particularly the
  keystore (`node/src/cli/keystore.js`: PBKDF2-HMAC-SHA256 → AES-256-GCM).
- `node/bin/hearth-mine.js` and `app-desktop/` — the light miners. The key is
  generated and held locally and signs every winning digest, so anything that could
  expose it, or that lets a proof be redeemed by a key it was not issued to, is in
  scope.
- `contracts/src/` — the AMM sources, even though nothing is deployed.

**The browser wallet and the browser miner are no longer in this repository.**
`web/` was deleted on 2026-08-04 (`48bc28a`). Report against the successor instead:

| Was | Report to |
| --- | --- |
| `web/assets/wallet/` — secp256k1, keystore sealing, signing path | [`micro-hearth-wallet-core`](https://github.com/cloudsforge-online/micro-hearth-wallet-core) (signing library) and [`micro-wallet-extension`](https://github.com/cloudsforge-online/micro-wallet-extension) (browser surface) |
| `web/index.html` — the explorer | [`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web) |
| `web/assets/mining/` — the browser miner | [`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site) `src/mining/`. **This row said "nothing, it was deleted, not moved" until 2026-08-09, and that stopped being true on 2026-08-06**, when the miner was restored there — the same code, not a rewrite — and put behind its `/mine` page. Mining from this repository is `node/bin/hearth-mine.js` and `app-desktop/`, both in scope above |

**One class of report is still in scope here, and it is the important one.** A
divergence between `micro-hearth-wallet-core` and its `node/src` originals —
`crypto/secp256k1.js`, `crypto/rlp.js`, `chain/transaction.js`, `cli/keystore.js` — is
a finding **about this repository**, because a wallet that signs slightly differently
from the node does not bounce, it pays the wrong person. That library's suite executes
this repository's modules in-process as its oracle, so such a divergence should surface
as a red build there; if you find one it did not catch, report it against `node/`.

The **retired pre-EVM** Ed25519 modules were deleted before `web/` itself was. There is
no Ed25519 key handling on the account-model path at all, and a report about it is a
report about code that is not shipped.

**Out of scope**

- `rust/hearthd/` — a self-check binary and a benchmark. It has no block type, no
  chain, no fork choice and no P2P server, and two of its modules are known to
  diverge from consensus (see [`MAP.md`](MAP.md) §3.3). It is documented as not
  being a second implementation. Findings are welcome but are not treated as
  consensus issues.
- `proto/` — teaching scripts, not imported by the node.
- The front ends that used to be here. `web/` (explorer, wallet, browser miner, a
  merchant-button mockup that settled nothing on a timer) and `site/` (marketing) were
  deleted in `48bc28a`. They are not "out of scope" so much as **absent**: a report
  against a path under `web/` or `site/` is a report about code no longer shipped from
  this repository. See the table above for where the live successors are.
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
  coinbase *public* key (`node/src/pow.js`), so a pool operator can
  distribute work and sign blocks itself. This is an open consensus decision
  recorded at `node/src/pow.js` and in [`WHITEPAPER.md`](WHITEPAPER.md) §2.3.
- **Consensus parameters in this tree are dev-tuned** — a 64 KiB Homefire pad,
  256 walk steps, coinbase maturity 10 (`node/src/params.js`). They
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
  digest (`node/src/evm/interpreter.js`), and a miner who dislikes an
  outcome can discard the block and grind another. Contracts must not use it as a
  randomness source for anything an adversarial miner would profit from biasing.
- **Precompiles `0x06`–`0x09` fail hard where `0x01`–`0x05` fail soft.** Both
  conventions are consensus and they are opposites; `0x01`–`0x05` answer a
  malformed input with empty output and a *successful* call, while `0x06`–`0x09`
  fail the call and burn every drop of forwarded gas. All nine are implemented, and
  the interpreter retains the machinery to fail a warmed-but-unimplemented address
  because a call to a codeless address *succeeds and returns empty*
  ([`docs/decisions.md`](docs/decisions.md) §1.3). A report that "the precompile
  reverted on bad input" is this, working.
- **`BASEFEE` pushes zero.** v1 has no fee market; the opcode exists only because
  Shanghai includes EIP-3198.
- **The browser wallet has no recovery** — one key per browser, no seed phrase,
  no HD derivation.
- **A crafted block still costs about 13x an ordinary one.** `StateDB` used to
  re-root both tries on every mutation — 443 MB and 65 s for one 30M-gas
  transaction against a 15-second block time
  ([`docs/robustness-review.md`](docs/robustness-review.md) §1). Hashing is
  deferred now and the same transaction measures 5.2 s and 9.2 MiB, gated by
  `node/test/bench/block-execution.js`. It is inside the block interval rather
  than four times it, which is a bound and not a comfortable one; the storage
  root is still materialised per write.
- **The proof of work is 64 KiB and not meaningfully memory-hard.** The 2 GiB
  the documents used to promise measures at 185.7 s per evaluation and a
  validator pays one per block received, so the parameter is bounded by
  verification ([`docs/pow-parameters.md`](docs/pow-parameters.md)). `params.js`
  refuses to start above 4 MiB. Closing this needs an amortised dataset.
- **`RLP.decode` has no nesting cap.** Roughly 7–12 KB of nested input — inside
  `MAX_TX_BYTES` — exhausts the JS stack with an untyped `RangeError`, and the
  threshold moves with remaining stack, so the same bytes can decode from one call
  site and throw from another ([`docs/robustness-review.md`](docs/robustness-review.md)
  §4, `node/test/fuzz/` finding 1). `transaction.validate()` catches it and reports
  `RLP_ERROR`, so it is latent. **A reachable path that turns this into a consensus
  disagreement is very much wanted.**
- **`isNormalized(tx)` is not a complete test.** It checks `nonce`, `data` and `to`
  (`node/src/chain/transaction.js`); the remaining fields are read in
  whatever representation the caller left them in. A decimal-string `value` on an
  otherwise-normalised draft yields a different `signingHash` than the same draft
  normalised. Nothing on the node's own path reaches it — `decode()` normalises —
  so it is a **wallet/caller-facing footgun**, and reports that reach it *through
  the node* are in scope.
- **Three findings are live against a running `hearthd` today** — a 39-byte
  message that buys a full copy of the UTXO set, `tx` gossip with no verification
  budget, and a self-fed side branch stored and relayed forever
  ([`docs/robustness-review.md`](docs/robustness-review.md) §2, §3, §5). Documented
  and not yet fixed; re-reporting them adds nothing, but a *cheaper* variant does.
- **The browser miner and the node agree about the coinbase key, and this entry
  used to say otherwise.** It cited `node/src/rpc.js` and
  `node/src/block.js` requiring Ed25519 — both of which belong to the UTXO
  chain, which is not the chain the browser miner talks to. The account model's
  issuer (`node/src/chain/miner.js` `issue()`) requires a 65-byte uncompressed
  secp256k1 key and `node/src/chain/header.js` `verifyPow` recovers one from the
  proof signature, which is what the miner signs with. The one real disagreement
  was the signature LENGTH — 64 bytes sent against 65 required — and it is fixed.
  **The check that this entry cited was absent from 2026-08-04 to 2026-08-09 while
  this line went on claiming it.** `node/test/browser-proof.js` was deleted with
  `web/` in `48bc28a`; the browser miner came back on 2026-08-06 in
  `micro-network-site` and the suite did not. It is restored: it imports that
  repository's `proofSignature` and requires the node's own template flow to accept
  the block. It is **not** in `npm test`, because that has to run on a bare checkout
  of this repository — it runs in its own CI job, which checks the other repository
  out first (`.github/workflows/ci.yml`, job `browser`).
- **`/mining/template` and `/mining/submit` are unauthenticated on purpose.**
  This is a permissionless chain; anyone may submit a block and it still has to
  satisfy proof of work and full validation. The exposure is cost, not
  authorisation: one `submit` reaches a full Homefire evaluation, so both
  endpoints carry a token budget with a refund for useful work, per-caller for
  fairness and global for the actual bound (`MINING_VERIFY_BURST` in
  `node/src/params.js`, `node/test/mining-budget.js`). Reports of a way past
  those budgets are in scope.

---

## Status of this codebase

**Mainnet is live, and nothing here has been independently audited.** That
combination is the single most important sentence on this page.

The account-model EVM chain is under construction. What is built and gated on
published reference vectors: the primitives, the Merkle Patricia Trie and
StateDB, the interpreter (**609/609 VMTests**), transactions/receipts/bloom
(**188/188 TransactionTests**), the state transition (**20,077/20,077
GeneralStateTests**), all nine precompiles,
and the `eth_*` JSON-RPC surface. Uniswap V2 deploys and swaps on it
(`node/test/dex.js`).

**The public networks now exist, and they are new.** Mainnet — chain id 7411 —
serves JSON-RPC at `https://rpc.cloudsforge.online`, and testnet — chain id
7412 — at `https://rpc-testnet.cloudsforge.online`. Blocks are produced,
validated and reorged, two real nodes partition and converge in
`node/test/evm-p2p-fork.js`, and three run under `docker-compose.testnet.yml`.
None of that shortens this list:

- The chain is **just under six days old and 10,987 blocks tall** (measured
  2026-08-10 17:56 UTC), and walking every one of those blocks finds **62
  transactions in 52 of them** — nine successful contract creations on
  2026-08-04, three strays, and a 41-transaction automated sweep between two
  addresses on 2026-08-10. **No third party has ever transacted here**, so the
  state machine has been exercised by tests far more than by use. **No block has
  ever been produced at production proof-of-work parameters**
  ([`docs/pow-parameters.md`](docs/pow-parameters.md)) — every block ever mined
  used a 64 KiB scratchpad and a 256-step walk against a stated intent of 2 GiB
  and 2,048 steps, and that is unchanged. And nothing here has ever run under
  adversarial load.
- **Every block this chain has ever had was mined by this project**, and **one
  browser tab is enough to move its difficulty by a factor of 32 and then stall
  it for twenty minutes.** Both were demonstrated on 2026-08-10: difficulty sat
  at the `GENESIS_TARGET` floor for every block to height 10,842, reached 8,146
  by height 11,242 once a browser miner joined, and the tip then did not advance
  for 1,154 s after that miner left, because the retarget cannot shed work faster
  than the remaining ~8 H/s can produce blocks to retarget on. Treat the security
  of this chain accordingly: its hash rate has never had to be bought, and the
  cost of stalling it is one closed tab. The measurements and the cause are in
  [`MAP.md` §1](MAP.md#1-what-this-is-in-one-paragraph); the retarget behaviour
  is tracked as `micro-org#363` and is a consensus change, not a documentation
  one. Any statement of the form "the chain sits at the difficulty floor" is a
  reading with an expiry date, and this file no longer makes one.
- The class of bug that only appears when state is carried across blocks,
  reorged or persisted has had a few thousand blocks to show itself, not a few
  million.
- It runs on **one home server behind one Cloudflare Tunnel**. There is no
  redundancy, no failover, and no backup has ever been restored. Treat
  availability as a courtesy, not a guarantee.
- The node's own ports still bind `127.0.0.1`; the tunnel is the entire
  perimeter, so a tunnel misconfiguration is an exposure, not just an outage.

Reproduce findings against the **public testnet** — chain id 7412 at
`https://rpc-testnet.cloudsforge.online` — rather than mainnet. It runs on the
same home server and the same tunnel, so it is not an isolation boundary; it is
just the chain where a mistake costs nothing.

[`docs/evm-spec.md`](docs/evm-spec.md) §8 tracks the phases,
[`docs/decisions.md`](docs/decisions.md) records why the non-obvious choices were
made, and [`MAP.md`](MAP.md) is the verified inventory.

Two internal reviews exist, and **neither is an audit or may be cited as one.**
[`docs/security-review.md`](docs/security-review.md) covers the **UTXO-era** code
and its findings are implemented. [`docs/robustness-review.md`](docs/robustness-review.md)
is a measured resource-bounds review of the EVM, state and chain layers; its
findings are **recorded and not yet fixed**, and finding 1 is why nothing produces
an account-model block. The intended audit scope is in
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
