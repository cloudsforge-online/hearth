# Listing readiness — what exists, and what does not

This is the gap list, not a marketing document. It exists so that nobody —
including us — mistakes intent for readiness.

**Summary: EMBER is not ready to apply for a listing, and will not be until the
chain runs.** The blocking item is not paperwork. It is that the account-model
chain has no interpreter, no state transition, no `eth_*` RPC and no mainnet.
Everything below is downstream of that.

**Legend:** ✅ done · 🟡 partial · ⬜ not started · 🚫 blocked on something else

---

## 0. The blockers, first

| # | Blocker | Status |
| --- | --- | --- |
| B1 | EVM interpreter, state transition, receipts, logs bloom, header v2 | 🟡 in progress ([`evm-spec.md`](evm-spec.md) §8, phases 3–5) |
| B2 | `eth_*` JSON-RPC surface | ⬜ |
| B3 | Public account-model testnet with a stable endpoint | ⬜ |
| B4 | Mainnet genesis, launch, and demonstrated hashrate | ⬜ |
| B5 | Independent audit of consensus and the EVM | ⬜ |

Nothing in §1–§8 should be filed before B1–B4. An application submitted against
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
| Total supply | a plain decimal number, no JSON wrapper, no units | 🟡 — `GET /supply/total` in [`../tools/explorer-api`](../tools/explorer-api). Written and tested; no chain to serve |
| Circulating supply | total minus the Commons balance, per [`tokenomics.md`](tokenomics.md) §7 | 🟡 — `GET /supply/circulating`, same service. **Refuses rather than serving total** when the Commons address is unset |
| Rich list / holder count | | ⬜ |
| Block explorer, `0x`-native | address, tx, block, contract pages with search | 🟡 — `web/index.html` exists but renders the UTXO chain and `ember1…` addresses |
| Etherscan-compatible `/api` | `module=account&action=balance`, `module=stats&action=…`, `module=logs&action=getLogs` | 🟡 — [`../tools/explorer-api`](../tools/explorer-api), with the address index behind it. `account`, `contract`, `stats`, `transaction`, `logs` and `proxy`; 🚫 on B2/B3 to run |
| Verified contract sources | source, ABI, compiler settings, constructor args | 🟡 — [`../tools/verify`](../tools/verify), which also speaks the API `forge verify-contract` speaks. 🚫 on B2/B3 |

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

**Both are now built** — [`../tools/explorer-api`](../tools/explorer-api) and
[`../tools/verify`](../tools/verify), zero-dependency services in the shape of
`tools/faucet`, tested over real HTTP. Neither has ever run against a node,
because there is not one: they are 🚫 on B2 and B3, not ⬜. Read each README's
"What is proven, and what is not" before treating any of it as operational.
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
| M4 | **Put chain id 7411 in the code.** It exists only in the spec | ⬜ |
| M5 | **Choose and fix the mainnet `NETWORK` id.** It defaults to `hearth` (`params.js:9`) | ⬜ |
| M6 | **Write the account-model genesis** and publish its state root as the verifiable no-premine artifact | ⬜ |
| M7 | **A new Commons address in `0x` form.** The current one is a non-checksummed UTXO sink (`params.js:127`) | ⬜ |
| M8 | **A governance or spend mechanism for the Commons**, or an explicit written decision that there is none | ⬜ |
| M9 | **Implement precompiles `0x06`–`0x09`** (bn128, blake2f). They currently revert loudly, which is the correct interim behaviour but breaks any contract needing them | ⬜ |
| M10 | **`feeToSetter` must be a multisig from the moment the factory is deployed**, not moved later — moving it later requires the key you are trying to stop relying on ([`evm-spec.md`](evm-spec.md) §7) | ⬜ |
| M11 | **Verify the Router init code hash against the live factory** before any liquidity is added ([`evm-spec.md`](evm-spec.md) §7) | ⬜ |
| M12 | **Reproducible builds**, claimed in older documents and not implemented | ⬜ |
| M13 | **Add the EVM conformance suites to the CI workflow.** `npm test` runs them; `.github/workflows/ci.yml` currently runs the legacy suites only, so "conformance-gated" is true of the test script and not yet of CI | ⬜ |

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

- ✅ A running proof-of-work network with tested fork choice and reorg over real
  sockets, a digest-conformant browser miner, and a deterministic emission
  schedule.
- ✅ A verifiable no-premine property on the current chain, checkable in one
  command.
- ✅ EVM primitives and state — Keccak, RLP, secp256k1, `uint256`, the Merkle
  Patricia Trie and StateDB — passing published reference vectors.
- ✅ A frozen, written specification for the account model
  ([`evm-spec.md`](evm-spec.md)) that an integrator can build against today.
- ✅ Complete brand assets.
- ✅ A repository inventory ([`../MAP.md`](../MAP.md)) that cites source for every
  claim, which is itself worth something to a diligence process.

That is a real foundation and it is not a listing. The distance between them is
§0.
