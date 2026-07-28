# Listing readiness — what exists, and what does not

This is the gap list, not a marketing document. It exists so that nobody —
including us — mistakes intent for readiness.

**Summary: EMBER is not ready to apply for a listing, and will not be until the
chain runs.** The blocking item is not paperwork, and it is no longer the EVM
either — the interpreter, the state transition, the receipts, the bloom and the
`eth_*` surface are all built and gated on published vectors. **It is that
consensus on the account model has not landed, so no block has ever been
produced.** Everything below is downstream of that one gap.

**Legend:** ✅ done · 🟡 partial · ⬜ not started · 🚫 blocked on something else

---

## 0. The blockers, first

| # | Blocker | Status |
| --- | --- | --- |
| B1 | EVM interpreter, state transition, receipts, logs bloom | ✅ **built and vector-gated** — 609/609 VMTests, 20,067/20,077 GeneralStateTests, 188/188 TransactionTests |
| B2 | `eth_*` JSON-RPC surface | ✅ **built**, 301 checks — but against a chain *interface* and an in-memory fake, and **nothing mounts it** |
| B2a | **Header v2, and consensus on the account state model** | ⬜ **the blocker.** Being built; no block has ever been produced |
| B3 | Public account-model testnet with a stable endpoint | ⬜ blocked on B2a |
| B4 | Mainnet genesis, launch, and demonstrated hashrate | ⬜ |
| B5 | Independent audit of consensus and the EVM | ⬜ |

Nothing in §1–§8 should be filed before B2a–B4. An application submitted against
a chain that does not run is a permanent mark against the project.

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
Every one of those fields depends on B3/B4.

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
consume this. Nothing to list yet — no contract is deployed.

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
| Public HTTPS RPC endpoint (`https://rpc.…`) | ⬜ | Required by §1.1. Needs rate limiting and TLS — the node itself has neither ([`exchange-integration.md`](exchange-integration.md) §2) |
| Public WSS endpoint | ⬜ | `eth_subscribe` is v2, not v1 |
| Redundant RPC (≥2 independent providers) | ⬜ | Aggregators and wallets expect more than one |
| DNS seeds / documented seed nodes | ⬜ | Peers are currently supplied by hand with `--peer` |
| Faucet (testnet) | ⬜ | Required for the `faucets[]` field in §1.1 |
| Status page / network dashboard | ⬜ | |

---

## 3. Explorer and aggregator endpoints

CoinGecko and CoinMarketCap do not read a whitepaper — they poll endpoints. The
minimum set:

| Endpoint | Returns | Status |
| --- | --- | --- |
| Total supply | a plain decimal number, no JSON wrapper, no units | ⬜ |
| Circulating supply | total minus the Commons balance, per [`tokenomics.md`](tokenomics.md) §7 | ⬜ |
| Rich list / holder count | | ⬜ |
| Block explorer, `0x`-native | address, tx, block, contract pages with search | 🟡 — **built** (`web/index.html` + `web/assets/explorer/`: decoded logs, revert reasons, contract disassembly, ERC-20s, `eth_getLogs` search, 147 self-test checks). **Not deployed against a chain, because there is none** |
| Etherscan-compatible `/api` | `module=account&action=balance`, `module=stats&action=…`, `module=logs&action=getLogs` | ⬜ |
| Verified contract sources | source, ABI, compiler settings, constructor args | ⬜ |

**The existing `/supply` REST endpoint is not usable as-is.** Its `circulating`
field is the sum of the entire UTXO set and *includes* the Commons treasury
(`node/src/rpc.js:228-240`, `node/src/chain.js:166-170`). Whatever replaces it on
the account-model chain must return the figure defined in
[`tokenomics.md`](tokenomics.md) §7, or aggregators will publish a circulating
supply that is wrong by the treasury balance.

An Etherscan-compatible `/api` shim is worth more than a prettier explorer:
aggregators, tax tools, portfolio trackers and several exchange back-ends all
speak it, and implementing the five or six methods they actually call is a small
job that removes a large amount of downstream integration friction.

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
  (`node/src/chain.js:55-70`; verification command in
  [`tokenomics.md`](tokenomics.md) §9).
- The only issuance path is a mined block, and the coinbase amount is checked
  exactly against a height-derived schedule (`node/src/chain.js:304-315`).
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
| M1 | **Raise `POW_SCRATCH_KIB` from 64 to the production ~2 GiB** and `POW_WALK_STEPS` from 256 to 2,048+ (`node/src/params.js:51-52`). A 64 KiB pad fits in L2 cache and is not meaningfully memory-hard | ⬜ |
| M2 | **Raise `COINBASE_MATURITY` from 10 to ~100** (`node/src/params.js:95`) | ⬜ |
| M3 | **Implement `SPARKS_PER_EMBER` → 18 decimals.** `params.js:6` still defines 1e8 | ⬜ |
| M4 | ~~Put chain id 7411 in the code~~ | ✅ **done** — `node/src/chain/transaction.js:57`. What remains is that it is a **hardcoded constant** and must become per-network configuration, because testnet is 7412 (`evm-spec.md` §1) |
| M5 | **Choose and fix the mainnet `NETWORK` id.** It defaults to `hearth` (`params.js:9`). Note this is the UTXO-era P2P/tx-binding id; under the account model EIP-155's chain id does that job | ⬜ |
| M6 | **Write the account-model genesis** and publish its state root as the verifiable no-premine artifact | ⬜ |
| M7 | **A new Commons address in `0x` form.** The current one is a non-checksummed UTXO sink (`params.js:127`) | ⬜ |
| M8 | **A governance or spend mechanism for the Commons**, or an explicit written decision that there is none | ⬜ |
| M9 | ~~Implement precompiles `0x06`–`0x09`~~ | ✅ **done** — `node/src/evm/bn128.js`, `node/src/evm/blake2f.js`, wired at `node/src/evm/precompiles.js:368-382`. All nine of Shanghai's set are implemented; EIP-196/197/1108 and EIP-152 vectors pass |
| M10 | **`feeToSetter` must be a multisig from the moment the factory is deployed**, not moved later — moving it later requires the key you are trying to stop relying on ([`evm-spec.md`](evm-spec.md) §7) | ⬜ |
| M11 | **Verify the Router init code hash against the live factory** before any liquidity is added ([`evm-spec.md`](evm-spec.md) §7) | 🟡 — the check is automated (`contracts/scripts/compile.mjs` refuses to build on mismatch; `node/test/dex.js` verifies it against a factory deployed on our own EVM before liquidity moves) and must still be re-run against the **live** factory at launch |
| M12 | **Reproducible builds**, claimed in older documents and not implemented | ⬜ |
| M14 | **Decide `nativeCurrency.name` and `shortName`.** SLIP-44 170 is already `MBRS / Ember`, so the *name* collides while the symbol does not (§1.2). It propagates into every registration and form | ⬜ |
| M15 | **Decide Multicall3**: replay the canonical presigned deployment, or deploy ours at a different address (`evm-spec.md` §3, §7; [`decisions.md`](decisions.md) §2.2) | ⬜ |
| M16 | **Reconcile the browser miner and the node on the coinbase key.** The miner signs secp256k1; `GET /mining/template` still requires an Ed25519 SPKI DER key and `node/src/block.js:45` still verifies Ed25519 | ⬜ |
| M13 | ~~Add the EVM conformance suites to the CI workflow~~ | 🟡 — CI now runs `npm test` as a **single command** (`.github/workflows/ci.yml:48-49`), so a new suite is covered the moment it is added. Two things remain: the **full corpus** is gitignored and CI runs only the harness self-test over the committed fixtures, and **the node job is currently failing outright** — `node/test/blake2f.js:304` references an undeclared `skipped` on the corpus-absent path, which is every clean checkout ([`../MAP.md`](../MAP.md) §11) |

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
  VMTests, 20,067/20,077 GeneralStateTests, 188/188 TransactionTests, plus RLP
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
