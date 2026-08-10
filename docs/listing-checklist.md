# Listing readiness — what exists, and what does not

This is the gap list, not a marketing document. It exists so that nobody —
including us — mistakes intent for readiness.

**Summary: EMBER is not ready to apply for a listing.** The blocking item is not
paperwork, and it is no longer the EVM — the interpreter, the state transition,
the receipts, the bloom and the `eth_*` surface are all built and gated on
published vectors. Nor is it consensus, and it is no longer publication either:
**mainnet is live at `https://rpc.cloudsforge.online`, chain id 7411**. What
blocks a listing now is everything that being reachable does not buy you:

- The chain is **just under six days old and 10,987 blocks tall** (measured
  2026-08-10 17:56 UTC), and holds **62 transactions in 52 blocks** — a mean of
  one transaction per 177 blocks, and **every one of them produced by this
  project**: nine contract creations on 2026-08-04, three strays, and a
  41-transaction automated sweep between two addresses on 2026-08-10. No
  exchange will risk-assess that. Growing the height does not fix it; the
  figure that has to move is transactions from somebody who is not us.
- **No block has ever been produced at mainnet proof-of-work parameters** (§7,
  and [`pow-parameters.md`](pow-parameters.md)) — every block ever mined used a
  64 KiB scratchpad and a 256-step walk against an intent of 2 GiB and 2,048
  steps. That is a claim about the pad and the walk, and it is separate from
  difficulty, which is no longer at the floor and is no longer a fixed number —
  see B4.
- **Every block this chain has ever had was mined by this project**, and on
  2026-08-10 **one browser tab moved its difficulty by a factor of 32 and then
  stalled it for twenty minutes** on leaving. An exchange asking "who secures
  this chain" gets the answer "we do, and one participant is enough to destabilise
  it". [`../MAP.md` §1](../MAP.md#1-what-this-is-in-one-paragraph) has the
  measurements.
- It is **one home server behind one tunnel**, with no redundancy and no
  restored backup. Exchanges ask about node infrastructure early.
- **Nothing has been independently audited** ([`../SECURITY.md`](../SECURITY.md)).
- The public testnet is now reachable at `https://rpc-testnet.cloudsforge.online`
  (chain id 7412), so there is somewhere to integrate against — but it shares the
  single home server and tunnel that mainnet runs on.

Everything below is downstream of those.

**Legend:** ✅ done · 🟡 partial · ⬜ not started · 🚫 blocked on something else

---

## 0. The blockers, first

| # | Blocker | Status |
| --- | --- | --- |
| B1 | EVM interpreter, state transition, receipts, logs bloom | ✅ **built and vector-gated** — 609/609 VMTests, 20,077/20,077 GeneralStateTests, 188/188 TransactionTests |
| B2 | `eth_*` JSON-RPC surface | ✅ **built and mounted** — `node/src/evmnode.js` serves it on 8545. 41 methods, 422 checks against a fake chain and 170 against a real one over HTTP |
| B2a | **Header v2, and consensus on the account state model** | ✅ **landed.** Two real nodes partition, reorg and agree state roots byte for byte (`node/test/evm-p2p-fork.js`, 51 checks); three run under `docker-compose.testnet.yml` |
| B3 | Public account-model testnet with a stable endpoint | ✅ **done.** Chain 7412 at `https://rpc-testnet.cloudsforge.online`, publicly trusted TLS, verified from outside 2026-08-05 (`eth_chainId` → `0x1cf4`). Explorer `explorer-testnet.cloudsforge.online`, faucet `network-testnet.cloudsforge.online/faucet`. Single-label hostnames only — the two-label `*.testnet.` form fails TLS at Cloudflare's edge |
| B4 | Mainnet genesis, launch, and demonstrated hashrate | 🟡 **genesis and launch done** — chain 7411 published 2026-08-04, mining, publicly reachable. **Hashrate is still not demonstrated, and the reason changed on 2026-08-10.** There is now a number, and it is worse than having none: difficulty sat at the `GENESIS_TARGET` floor for every block to height 10,842, then reached **8,146** by height 11,242 — a factor of 32 — because a **single reader's browser tab** joined the mining. When that tab closed, the tip did not advance for **1,154 s**. So the demonstrated hashrate is one browser, it was ours, and it left; the steady-state miner is one throttled process at ~8 H/s. **Every block this chain has ever had was mined by this project.** Do not quote a difficulty figure to an exchange as though it were a security budget — it is a live reading that oscillates with one tab. [`../MAP.md` §1](../MAP.md#1-what-this-is-in-one-paragraph) has the measurements and the cause; the retarget behaviour is `micro-org#363` |
| B5 | Independent audit of consensus and the EVM | ⬜ |

Nothing in §1–§8 should be filed before the rest of B4 and B5. An application
submitted against a chain that is days old, has no transactions and has never
run at its own production proof-of-work parameters is a permanent mark against
the project —
and "it answers `eth_chainId`" is not a track record.

---

## 1. Chain and asset registration

### 1.1 Chain ID in `ethereum-lists/chains` ⬜

This is the single highest-leverage registration. It feeds `chainid.network`,
`chainlist.org` and MetaMask's "add network" flow, so users get the network by
name with the right symbol and decimals instead of pasting an RPC URL and hoping.

**Chain id 7411 is currently unclaimed.** Verified against the live registry:

```bash
curl -s https://chainid.network/chains_mini.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const c=JSON.parse(s); console.log('7411 taken?', c.some(x=>x.chainId===7411));})"
# → 7411 taken? false      (2,664 chains registered; nearest neighbours 7368 and 7447)
```

Re-run this immediately before filing — the registry moves, and a collision
discovered after mainnet is a chain-splitting-grade problem for users.

The PR needs: a `_data/chains/eip155-7411.json` entry with `name`, `shortName`,
`chain`, `networkId`, `nativeCurrency {name: "Ember", symbol: "EMBER", decimals: 18}`,
`rpc[]`, `faucets[]`, `infoURL`, `explorers[]`, and an icon in `_data/icons/`.
`rpc[]` and `explorers[]` can now be filled in (`https://rpc.cloudsforge.online`,
`https://explorer.cloudsforge.online`); `faucets[]`, `shortName` and the icon
still cannot. See [`network-config.md`](network-config.md) §4.7 for the exact
JSON.

### 1.2 SLIP-44 coin type ⬜

Hardware wallets derive addresses from `m/44'/<coin_type>'/…`. Without a
registered coin type there is no canonical Hearth derivation path, and Ledger,
Trezor and every HD wallet will either refuse or guess.

**Finding, and it is not trivial: SLIP-44 coin type 170 is already registered as
`MBRS / Ember`.** Verified against `satoshilabs/slips/slip-0044.md` (line 203).
The *symbol* `EMBER` is unregistered; the *name* `Ember` is taken by an unrelated
coin. Expect the registration to require a distinguishing name — `Hearth` or
`Hearth EMBER` rather than `Ember` — and expect an aggregator or wallet to raise
the ambiguity. Decide the canonical name before filing anything else, because it
propagates into §1.1, §1.3 and every listing form.

```bash
curl -s https://raw.githubusercontent.com/satoshilabs/slips/master/slip-0044.md \
  | grep -iE "\| *(EMBER|MBRS) *\|"
```

**Interim position:** because address derivation and the signature curve are
identical to Ethereum, wallets derive working Hearth accounts under coin type 60.
That is a workaround, not a registration, and it means Hearth accounts share a
derivation path with Ethereum accounts. Say so rather than letting a user
discover it.

### 1.3 Token list ⬜

Once WEMBER and any issued assets exist, publish a
[Uniswap token-list](https://tokenlists.org) JSON at a stable HTTPS URL with a
schema-valid `version`, `tokens[]` (address, chainId 7411, decimals, symbol,
name, logoURI) and a signed release process. Front-ends, aggregators and wallets
consume this. Nothing to list yet: no token contract is deployed. (Mainnet is
not contract-free — nine `ForesightMarket` instances went live there on
2026-08-04 — but they are not assets, and a token list of them would be empty
anyway.)

### 1.4 Asset metadata ✅ / 🟡

Brand assets exist and are complete (`branding/`: mark, wordmark, favicon, og,
social). What is missing is the **canonical form of each field** — legal name,
display name, symbol, decimals, and a permanent logo URI — agreed once and used
identically in §1.1, §1.3, CoinGecko, CoinMarketCap and every exchange form.
Inconsistency across those is a common and entirely self-inflicted rejection
reason. Blocked on the naming decision in §1.2.

---

## 2. Public infrastructure

| Item | Status | Note |
| --- | --- | --- |
| Public HTTPS RPC endpoint (`https://rpc.…`) | ✅ | `https://rpc.cloudsforge.online` (7411) and `https://rpc-testnet.cloudsforge.online` (7412), both on publicly trusted certificates. TLS and rate limiting come from Cloudflare, **not** from the node, which still has neither ([`exchange-integration.md`](exchange-integration.md) §2) |
| Public WSS endpoint | ⬜ | `eth_subscribe` is v2, not v1 |
| Redundant RPC (≥2 independent providers) | ⬜ | Aggregators and wallets expect more than one |
| DNS seeds / documented seed nodes | ⬜ | Peers are currently supplied by hand with `--peer` |
| Faucet (testnet) | ✅ | `https://network-testnet.cloudsforge.online/faucet` — funds chain 7412. Note this is the *testnet* faucet, so it does not fill the `faucets[]` field of the **mainnet** 7411 entry in §1.1 |
| Status page / network dashboard | ⬜ | |

---

## 3. Explorer and aggregator endpoints

CoinGecko and CoinMarketCap do not read a whitepaper — they poll endpoints. The
minimum set:

| Endpoint | Returns | Status |
| --- | --- | --- |
| Total supply | a plain decimal number, no JSON wrapper, no units | 🟡 — `GET /supply/total` in [`../tools/explorer-api`](../tools/explorer-api). Written; suite green; **nothing hosts it** — mainnet exists to point it at, but the service is not deployed |
| Circulating supply | total minus the Commons balance, per [`tokenomics.md`](tokenomics.md) §7 | 🟡 — `GET /supply/circulating`, same service. **Refuses rather than serving total** when the Commons address is unset |
| Rich list / holder count | | ⬜ |
| Block explorer, `0x`-native | address, tx, block, contract pages with search | 🟡 — **built, but no longer here.** `web/` was deleted in `48bc28a`; the surface is [`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web), which reads `micro-indexer` rather than `eth_*` and **has no contract disassembly**. The 147-self-test figure described the deleted page and is not carried over. An explorer is deployed at `https://explorer.cloudsforge.online`, but it is that repository's, not this one's |
| Etherscan-compatible `/api` | `module=account&action=balance`, `module=stats&action=…`, `module=logs&action=getLogs` | 🟡 — [`../tools/explorer-api`](../tools/explorer-api), with the address index behind it. `account`, `contract`, `stats`, `transaction`, `logs` and `proxy`. B2 is done and mainnet can back it; what is missing is somewhere to host it |
| Verified contract sources | source, ABI, compiler settings, constructor args | 🟡 — [`../tools/verify`](../tools/verify), which also speaks the API `forge verify-contract` speaks. Nothing hosts it — and there **are** now contracts on mainnet to verify: nine `ForesightMarket` instances live since 2026-08-04, all of them unverified bytecode to anybody outside this estate |

**The existing `/supply` REST endpoint is not usable as-is.** Its `circulating`
field is the sum of the entire UTXO set and *includes* the Commons treasury
(`node/src/rpc.js`, `node/src/chain.js`). Whatever replaces it on
the account-model chain must return the figure defined in
[`tokenomics.md`](tokenomics.md) §7, or aggregators will publish a circulating
supply that is wrong by the treasury balance.

An Etherscan-compatible `/api` shim is worth more than a prettier explorer:
aggregators, tax tools, portfolio trackers and several exchange back-ends all
speak it, and implementing the five or six methods they actually call is a small
job that removes a large amount of downstream integration friction.

**Both are now written** — [`../tools/explorer-api`](../tools/explorer-api) and
[`../tools/verify`](../tools/verify), zero-dependency services in the shape of
`tools/faucet`, exercised over real HTTP. Neither has run against a *public*
node, because there is not one: they are 🚫 on B3, not ⬜. Read each README's
"What is proven, and what is not" before treating any of it as operational.

`tools/verify` passes **116/116**. `tools/explorer-api` passes **177/177**
fixture checks plus **27/27** against a chain that mined and executed the blocks
it indexes (`test/live-chain.test.js`). It did not always: the suite threw
`receipt.logs[0].logIndex is missing — the chain must number logs across the
block, and this layer cannot derive it from one receipt` on every run, locally
and in CI's *Developer kit* job. **The question of which side owned that bug is
settled: the test's fake chain did.** `logIndex` is per block
([`evm-spec.md`](evm-spec.md) §6), `node/src/chain/rpcadapter.js` numbers it that
way, and `node/src/jsonrpc/methods.js` is right to refuse a receipt that omits
it rather than restart the count at zero — a single receipt cannot know how many
logs preceded it in its block. The fixture omitted the field; it no longer does,
and the ordinals are now asserted against a real node on both paths that serve
them.

**The gate for this row is `test/live-chain.test.js`, not the fixture suite.**
A fake chain agrees with whatever its author believed, which is exactly how this
went wrong. That suite boots a real node, mines a block with two log-emitting
transactions, and requires `module=account&action=balance` and
`module=logs&action=getLogs` to agree field for field with `eth_getBalance` and
`eth_getLogs`; `HEARTH_LIVE_RPC_URL=http://127.0.0.1:8545` runs the same
comparison against the compose testnet. Count the `/api` row as done when that
has been run against the endpoint being listed.
The new supply endpoints serve total and circulating as separate figures and
**refuse to publish a circulating number they cannot compute**, which is the
specific defect described above.

---

## 4. Audit

**Nothing in this repository has been independently audited.** ⬜

Proposed scope, in priority order — the first two are non-negotiable before
mainnet:

1. **The EVM implementation** — `node/src/crypto/{keccak,rlp,secp256k1}.js`,
   `node/src/state/{trie,statedb}.js`, `node/src/evm/*`, and the state
   transition. A divergence from Ethereum semantics means a Solidity contract
   behaves differently here than where it was audited. Conformance vectors make
   this tractable; they do not make it audited.
2. **Consensus** — block and transaction validation, fork choice, reorg, the
   LWMA retarget, the emission and anti-inflation rules
   (`node/src/chain.js`, `node/src/tx.js`, `node/src/params.js`).
3. **Homefire and the mining protocol** — `node/src/pow.js`,
   `node/src/mining.js`, and the browser miner. Note that the ASIC-resistance
   argument is about the construction; the shipped pad is 64 KiB and dev-tuned
   (§7 below).
4. **P2P** — DoS surface, the verification budget, orphan handling.
5. **The AMM contracts** — `contracts/src/*`. Uniswap V2 is thoroughly audited
   upstream; our port and the `feeToSetter` handling are not.
6. **The browser wallet** — key generation, PBKDF2/AES-GCM sealing, the v1→v2
   migration.

An internal review exists at [`security-review.md`](security-review.md) and its
findings are implemented. **An internal review is not an audit** and must never
be presented as one.

---

## 5. Security policy ✅ / 🟡

[`../SECURITY.md`](../SECURITY.md) exists and is current: scope, disclosure
route, response expectations and the pre-mainnet posture.

Gaps:

- **No monitored `security@` mailbox.** Disclosure runs through GitHub's private
  vulnerability reporting, which works and is verifiable, but several exchange
  forms require an email address and a named contact. Provisioning one is a
  prerequisite, not a nicety. ⬜
- **No bug bounty.** Committed in principle, funded by the Commons — which has no
  spend mechanism (§7). ⬜
- **No PGP key** for encrypted reports. ⬜
- **No published incident-response or chain-halt procedure.** Exchanges ask what
  happens during a consensus failure and who can tell them to stop crediting
  deposits. There is no answer written down. ⬜

---

## 6. Token classification

**Position: EMBER is a mined, native network asset with no issuer, no sale, no
premine and no allocation.**

The supporting facts, each verifiable:

- Genesis creates zero spendable supply
  (`node/src/chain.js`; verification command in
  [`tokenomics.md`](tokenomics.md) §9).
- The only issuance path is a mined block, and the coinbase amount is checked
  exactly against a height-derived schedule (`node/src/chain.js`).
- There has been no sale of any kind: no ICO, no private round, no SAFT, no
  pre-sale, no airdrop.
- No entity holds a founder or team balance.
- The Commons treasury is an on-chain mint accruing block by block, not a
  pre-allocated balance, and no party can currently spend from it (§7).
- Code is MIT-licensed and public.

**What has not been done:** no legal opinion has been obtained in any
jurisdiction, and the paragraph above is a factual description of the code, not a
regulatory conclusion. A written opinion — at minimum for the US and EU/MiCA — is
required before applying anywhere, and MiCA in particular asks questions about
the issuer and the white paper that a genuinely issuer-less asset still has to
answer in writing. ⬜

One matter to resolve deliberately rather than by omission: the **Commons
treasury**. It accrues 10% of every block to an address that nobody can currently
spend from. Whether that reads as "no issuer" or as "an undistributed reserve
controlled by whoever eventually holds the governance keys" depends entirely on
what governance turns out to be. Design it before it is asked about. ⬜

---

## 7. Things that must change before mainnet

These are not listing paperwork; they are correctness. Each is a hard fork after
launch and free before it.

| # | Item | Status |
| --- | --- | --- |
| M1 | ~~Raise `POW_SCRATCH_KIB` from 64 to ~2 GiB~~ — **retired, measured.** One evaluation at 2 GiB is **185.7 s**; a validator pays one per block received against a 15 s interval, and a 200-block `getblocks` page is ~10 hours of one core. `params.js` now refuses to start above `POW_MAX_SCRATCH_KIB` 4096. A 64 KiB pad is still not meaningfully memory-hard, and closing that needs an amortised dataset across `pow.js`, the browser miner and the Rust core — a redesign, not a constant. [`pow-parameters.md`](pow-parameters.md) | ✅ **decided** |
| M2 | ~~Raise `COINBASE_MATURITY` from 10 to ~100~~ — **a no-op on the launch chain.** `_creditReward` adds the subsidy straight to the balance; the constant is read only by the retired UTXO path (`tx.js`, `wallet.js`, `rpc.js`, `chain.js`). Whether the account model should have a maturity rule at all is a separate, open question | ✅ **decided** |
| M3 | **Implement `SPARKS_PER_EMBER` → 18 decimals.** `params.js` still defines 1e8 | ⬜ |
| M4 | ~~Put chain id 7411 in the code~~ · ~~make it per-network~~ | ✅ **done** — `node/src/params.js` `CHAIN_IDS` resolves it per network (7411 mainnet, 7412 testnet, 7413 the in-process test chain) and `node/src/chain/transaction.js` reads it. An unregistered network is a hard error, not a default |
| M5 | **Choose and fix the mainnet `NETWORK` id.** It defaults to `hearth` (`params.js`). Note this is the UTXO-era P2P/tx-binding id; under the account model EIP-155's chain id does that job | ⬜ |
| M6 | **Write the account-model genesis** and publish its state root as the verifiable no-premine artifact | ⬜ |
| M7 | **A new Commons address in `0x` form.** The current one is a non-checksummed UTXO sink (`params.js`) | ⬜ |
| M8 | **A governance or spend mechanism for the Commons**, or an explicit written decision that there is none | ⬜ |
| M9 | ~~Implement precompiles `0x06`–`0x09`~~ | ✅ **done** — `node/src/evm/bn128.js`, `node/src/evm/blake2f.js`, wired at `node/src/evm/precompiles.js`. All nine of Shanghai's set are implemented; EIP-196/197/1108 and EIP-152 vectors pass |
| M10 | **`feeToSetter` must be a multisig from the moment the factory is deployed**, not moved later — moving it later requires the key you are trying to stop relying on ([`evm-spec.md`](evm-spec.md) §7) | ⬜ |
| M11 | **Verify the Router init code hash against the live factory** before any liquidity is added ([`evm-spec.md`](evm-spec.md) §7) | 🟡 — the check is automated (`contracts/scripts/compile.mjs` refuses to build on mismatch; `node/test/dex.js` verifies it against a factory deployed on our own EVM before liquidity moves) and must still be re-run against the **live** factory at launch |
| M12 | **Reproducible builds**, claimed in older documents and not implemented | ⬜ |
| M14 | **Decide `nativeCurrency.name` and `shortName`.** SLIP-44 170 is already `MBRS / Ember`, so the *name* collides while the symbol does not (§1.2). It propagates into every registration and form | ⬜ |
| M15 | **Decide Multicall3**: replay the canonical presigned deployment, or deploy ours at a different address (`evm-spec.md` §3, §7; [`decisions.md`](decisions.md) §2.2) | ⬜ |
| M16 | ~~**Reconcile the browser miner and the node on the coinbase key.**~~ **Done, and the item was misdiagnosed.** It cited `node/src/rpc.js` and `node/src/block.js` — the UTXO chain, which is not the chain the browser miner talks to and which will require Ed25519 for as long as it exists. The account model already required secp256k1 (`node/src/chain/miner.js` `issue()`). The real defect was the signature LENGTH: 64 bytes sent, 65 required (`r \|\| s \|\| recoveryId`). Fixed; `node/test/browser-proof.js` drives the browser's own signer through the node's template flow. **That citation was false between 2026-08-04 and 2026-08-09** — the suite was deleted with `web/` in `48bc28a` and this row went on claiming it while the browser miner came back on 2026-08-06 in `micro-network-site`. The suite is restored against that repository's `src/mining/miner.js` and runs in its own CI job, which is what a listing reviewer should check rather than this row | ✅ |
| M13 | ~~Add the EVM conformance suites to the CI workflow~~ | 🟡 — CI now runs `npm test` as a **single command** (`.github/workflows/ci.yml`), so a new suite is covered the moment it is added. Two things remain: the **full corpus** is gitignored and CI runs only the harness self-test over the committed fixtures, and **the node job is currently failing outright** — `node/test/blake2f.js` references an undeclared `skipped` on the corpus-absent path, which is every clean checkout ([`../MAP.md`](../MAP.md) §11) |

---

## 8. Market prerequisites

Not our decision, but every exchange asks:

- **There is no market and no price.** EMBER has never traded anywhere.
- **There is no liquidity.** The AMM contracts are written and have never been
  deployed. `evm-spec.md` §7 is explicit that launching with empty pools attracts
  nobody, and seeding EMBER/WEMBER plus at least one pair against a stable asset
  is a launch requirement.
- **There is no market maker** and no agreement with one.
- **Hashrate is unknown**, and it is the number that determines whether a
  confirmation count means anything
  ([`exchange-integration.md`](exchange-integration.md) §4).

---

## 9. What is genuinely ready

Short list, honestly scoped:

- ✅ **A complete EVM implementation, gated on Ethereum's own vectors** — 609/609
  VMTests, 20,077/20,077 GeneralStateTests, 188/188 TransactionTests, plus RLP
  and Trie. Written here rather than imported, which is only defensible *because*
  those vectors exist.
- ✅ **Uniswap V2 deploys and swaps on it** — `node/test/dex.js`, 167/167, a real
  swap at 112,456 gas, with the init code hash verified against the live factory
  before liquidity moved. This is the single strongest piece of diligence
  evidence in the repository.
- ✅ The `eth_*` JSON-RPC surface, an EVM-aware explorer, a secp256k1 browser
  wallet whose crypto is cross-checked against the node's in CI, and a `hearth`
  CLI with an opcode-level tracer.
- ✅ A developer kit that works today: a faucet service, Hardhat and Foundry
  templates, and an RPC probe that serves the real method surface over a fake
  chain — so an integrator can prove their wiring before an endpoint exists.
- ✅ A running proof-of-work network (the UTXO chain) with tested fork choice and
  reorg over real sockets, a digest-conformant browser miner, and a deterministic
  emission schedule.
- ✅ A verifiable no-premine property on that chain, checkable in one command —
  though the account-model genesis is the artifact that will actually matter and
  it has not been written ([`tokenomics.md`](tokenomics.md) §9).
- ✅ A frozen, written specification for the account model
  ([`evm-spec.md`](evm-spec.md)), and the reasoning behind its non-obvious choices
  ([`decisions.md`](decisions.md)).
- ✅ Complete brand assets.
- ✅ A repository inventory ([`../MAP.md`](../MAP.md)) that cites source for every
  claim, which is itself worth something to a diligence process.

That is a real foundation and it is not a listing. The distance between them is
B2a: **a chain that produces blocks.**
