# Hearth explorer API

An **Etherscan-compatible `/api` shim** and the **address index** behind it.
Zero npm dependencies, CommonJS, plain `node:http`, Node 22+ — the same
discipline as `tools/faucet` and the node itself.

```bash
export HEARTH_RPC_URL=http://127.0.0.1:8545     # the eth_* endpoint, not 8645
export HEARTH_COMMONS_ADDRESS=0x…               # or circulating supply is refused
node src/index.js
```

```bash
npm test        # 177 assertions over real HTTP against a fake chain
node test/live-chain.test.js   # 27 more against a node that mined the blocks
```

> **Not deployed anywhere, and run against a real node in CI.**
> `test/live-chain.test.js` boots a node from `node/src` — real proof of work,
> real signed transactions, real EVM execution — and requires
> `module=account&action=balance` and `module=logs&action=getLogs` to agree
> field for field with `eth_getBalance` and `eth_getLogs`. The larger suite is
> still fixture-verified against blocks encoded by `node/src/jsonrpc`, and the
> difference between the two is the point: see
> [What is proven, and what is not](#what-is-proven-and-what-is-not).

---

## Why this exists

`docs/listing-checklist.md` §3 names it a blocker. CoinGecko, CoinMarketCap,
portfolio trackers, tax tools and several exchange back-ends do not read a
whitepaper — they poll an Etherscan-shaped `/api`. Not having one means manual
data submission and no automated supply verification.

The underlying problem is that `eth_*` has no `eth_getTransactionsByAddress` and
cannot cheaply have one, so "the transactions of an address" is a bounded block
walk. The explorer currently walks 25 blocks and says so on screen. This service
is the address index that makes the question answerable.

---

## API

Point any Etherscan client at `/api`. An `apikey` parameter is accepted and
ignored (set `HEARTH_EXPLORER_API_KEY` to require one).

| Module | Actions |
| --- | --- |
| `account` | `balance`, `balancemulti`, `txlist`, `txlistinternal`, `tokentx`, `tokennfttx` |
| `contract` | `getabi`, `getsourcecode` |
| `stats` | `ethsupply`, `tokensupply`, **`circulatingsupply`**, **`supplybreakdown`** |
| `transaction` | `getstatus`, `gettxreceiptstatus` |
| `logs` | `getLogs` |
| `proxy` | a passthrough to `eth_*` |

**Bold** entries are extensions, named so nobody mistakes them for Etherscan's.

The envelope is exact, because clients string-match it:

```json
{ "status": "1", "message": "OK",                    "result": … }
{ "status": "0", "message": "No transactions found", "result": [] }
{ "status": "0", "message": "NOTOK",                 "result": "Error! …" }
```

`status` is the **string** `"1"` or `"0"`. Every numeric field in a result row
is a **decimal string** — a wei value does not survive `JSON.parse` as a
`Number`. `module=proxy` is the one exception and returns raw JSON-RPC 2.0,
exactly as Etherscan does, because its clients hand the body to a JSON-RPC
parser. Refusals are still HTTP 200; clients read `status`, not the status line.

### Supply — read this before integrating

```
GET /supply/total          → a bare decimal, EMBER
GET /supply/circulating    → total − the Commons treasury
GET /supply?unit=wei       → both, labelled, with the methodology
```

Plain text, no JSON wrapper and no units, because that is the shape
`docs/listing-checklist.md` §3 asks for. `?unit=wei` switches to wei;
`module=stats&action=ethsupply` is wei, matching Etherscan.

**The trap this service exists to close.** The node's own `GET /supply` reports
a field called `circulating` whose value is the sum of the entire UTXO set —
**including the Commons treasury** (`node/src/rpc.js`,
[`../../docs/tokenomics.md`](../../docs/tokenomics.md) §7). An aggregator taking
it at face value publishes a circulating supply overstated by the whole
treasury, currently 10% of everything ever mined.

Here, total and circulating are two separately-named, separately-computed
numbers:

```
total supply       = Σ subsidy(h) for h = 0..tip     (deterministic, offline-computable)
commons treasury   = eth_getBalance(HEARTH_COMMONS_ADDRESS)
circulating supply = total − commons
max supply         = none (uncapped)
```

Three rules, each a refusal rather than a guess:

1. **No `HEARTH_COMMONS_ADDRESS` → no circulating figure.** `/supply/circulating`
   returns **503 with a reason**, not total supply under a different name.
2. **The model is cross-checked against the chain.** `eth_*` has no supply
   method ([`../../docs/evm-spec.md`](../../docs/evm-spec.md) §6), so total is
   modelled from the emission schedule — and a model drifts silently if the
   account-model genesis differs by one block. The treasury takes a known 10%
   share, so if the observed Commons balance **exceeds** what the model says can
   have been minted, every supply endpoint returns an error. The check is
   one-sided: a balance *below* the model is normal once a spend mechanism
   exists, because disbursed coins become circulating (§7).
3. **The emission parameters are configuration, not constants**
   (`HEARTH_EMISSION_*`). When phase 5 lands they must be pinned to consensus
   ([`../../docs/listing-checklist.md`](../../docs/listing-checklist.md) M6).

Nothing else is excluded. There is no vesting, no lock-up, no team wallet, no
foundation reserve and no escrow, because none of those exist.

---

## Storage — the decision, and why

**An append-only inverted index on local disk: two fixed-width files plus one
in-memory map of address → posting ordinals.** Not Postgres, and not a copy of
the chain.

The estate uses Postgres everywhere else and `infra/lantern` is the pattern, so
the burden of proof is on doing something different. Three things carried it:

1. **Zero dependencies is a hard constraint here.** The node, the RPC layer and
   the faucet all hold to it. There is no pure-Node Postgres driver in the
   standard library, so "use Postgres" means either an npm dependency tree —
   inside a process that must run beside a node with nothing installed — or
   hand-writing the v3 wire protocol, which is more novel code than the index.
2. **The workload is an inverted index, not a relation.** Every query is
   "postings for this key, in block order, paged". No joins, no ad-hoc
   predicates, no transaction spanning more than one block. That is precisely
   an append-only posting list, which is what a relational engine would build
   under a B-tree anyway.
3. **A reorg is a truncation.** Postings are appended in strict block order, so
   unwinding block *N* is `ftruncate` to the offset recorded for *N−1* — atomic,
   O(reorg depth), and impossible to leave half-done. In a table the equivalent
   is a `DELETE` across an index whose write amplification is worst exactly when
   you most need it to be quick.

### What is stored

Postings only — `(key, block, txIndex, subIndex, kind, flags)`, 48 bytes each.
Not transactions, not receipts, not logs. Rows are hydrated from the node when a
query asks for them, through a block-plus-receipts LRU so paging an address
costs one round trip per distinct block.

- The index stays small: ~48 bytes per participation, so a year of ten-
  transaction blocks is a few hundred MB rather than tens of GB.
- Every Hearth node is an archive node and nothing prunes
  ([`../../docs/exchange-integration.md`](../../docs/exchange-integration.md) §3),
  so the source rows are always available.
- It is impossible for the index to disagree with the chain about the *content*
  of a transaction. It can only be wrong about which transactions exist — the
  one thing it is responsible for, and the one thing the reorg logic guards.

### Files

| File | Record | Purpose |
| --- | --- | --- |
| `manifest.json` | — | format version, chain id, start block, record sizes. A mismatch **refuses to start** rather than decoding another chain's index into plausible nonsense |
| `chain.idx` | 96 B | one per indexed block: number, hash, parentHash, timestamp, tx count, and the postings offset at which the block ends. Seekable by height. **This is the commit marker** |
| `postings.idx` | 48 B | 32-byte key (20-byte address or 32-byte topic), block, txIndex, subIndex, kind, flags |

Postings are written first, then the chain record that names their end offset.
A crash between the two leaves orphan postings; a torn write leaves a partial
record. `open()` truncates both. **There is no state in which the index serves a
block it did not finish writing** — and the tests kill it in both places to
prove it.

### The ceiling, stated rather than discovered

The address → ordinals map is in memory: ~4 bytes per posting plus ~100 bytes per
distinct key. A chain with 20 M postings across 1 M addresses is roughly **180 MB
resident**. Past a few hundred million postings this wants a disk-resident hash
index or Postgres. The migration is mechanical because everything above
`store.js` goes through one method, `scan()`.

### Kinds

| Kind | Key | Serves |
| --- | --- | --- |
| `TX` | `from`, `to`, or a created contract address | `txlist` |
| `TOKEN` | the participants of an ERC-20/721 `Transfer` | `tokentx`, `tokennfttx` |
| `LOG` | the emitting contract | `logs&getLogs` by address |
| `TOPIC` | `topics[0]` | `logs&getLogs` by topic |
| `INTERNAL` | the parties to a value-bearing internal call | `txlistinternal` — only where a node can trace |

**`logIndex` is derived, not taken from the node** — but not because the node
gets it wrong. The specification says it is per block
([`../../docs/evm-spec.md`](../../docs/evm-spec.md) §6), `node/src/chain/rpcadapter.js`
numbers it that way, and `node/src/jsonrpc/methods.js` refuses to serve a receipt
whose logs lack it rather than restart the count at zero. We derive it anyway
because this service indexes whatever node it is pointed at, and getting it
wrong is silent: a node that numbered per receipt would report the third
transaction's first log as `logIndex 0`, and every lookup in a block with more
than one log-emitting transaction would resolve to the wrong log — wrong
contract, wrong amount, wrong counterparties, under a `"status": "1"`. The
derived ordinal also cannot depend on *which* method fetched the receipts, and
this service fetches them two ways. Both suites assert that case, and
`test/live-chain.test.js` asserts that the derived value equals the one a real
node reports.

---

## Reorgs

Hearth's fork choice is heaviest-cumulative-work with **no depth limit**, no
checkpoint and no finality gadget
([`../../docs/exchange-integration.md`](../../docs/exchange-integration.md) §4).
On a young CPU-mined chain a 1–2 block reorg is routine. An index that only
appends keeps serving transactions that are in no block, and does it silently —
nothing about an orphaned transaction looks wrong in isolation.

Every tick therefore does two things, in this order:

1. **Confirm the tip we already have.** Ask the node for the block at our head
   height and compare hashes. One call, and it is the only thing that catches a
   reorg that does not change the height.
2. Only then extend.

On a mismatch it walks back a block at a time to the fork point and truncates.
Two refusals are deliberate:

- **Past `HEARTH_EXPLORER_API_MAX_REORG_DEPTH` (default 1000) the indexer
  parks.** A thousand-block rewind is either an attack or an operator pointed at
  a different chain, and quietly rewriting that much served history is the wrong
  response. Every address query then answers with the reason and `/health` is
  503.
- **A block whose `parentHash` does not match what was just indexed aborts the
  batch.** Chaining onto the wrong parent produces an index that is internally
  consistent and wrong.

A reorg at or beyond `HEARTH_EXPLORER_API_REORG_ALERT_DEPTH` (default 5) is
logged at **error**, matching the exchange guidance to halt crediting past that
depth. The hydrator's block cache is invalidated with the index, because after a
reorg those block numbers name different blocks.

---

## Where this deliberately differs from Etherscan

Four places, all of them refusals:

1. **`txlistinternal` refuses** rather than returning an empty list, unless the
   node exposes a call tracer. Internal transfers can only be derived from
   execution traces, and `debug_traceTransaction` / `trace_block` are **not in
   the v1 RPC surface** (`exchange-integration.md` §5.2). They are not merely
   absent from the index — they are unknowable. `{"message":"No transactions
   found"}` would assert that an address received none, which we cannot know.
   Value moved by a contract `CALL` or `SELFDESTRUCT` is invisible here.
   The capability is probed once at boot; if a node ever answers
   `debug_traceTransaction`, internal transfers are indexed and this endpoint
   starts working. A test proves both halves.
2. **Address queries refuse while the index is behind the node** (more than
   `HEARTH_EXPLORER_API_MAX_LAG_BLOCKS`, default 8 ≈ two minutes). Same reason:
   "no transactions found" and "I have not looked yet" must not be
   indistinguishable. `balance` and `module=proxy` are unaffected — they read
   the node directly.
3. **`offset` defaults to 100 and caps at 1,000**, not 10,000, because rows are
   hydrated rather than stored.
4. **`logIndex` and `transactionIndex` are canonical `0x0`.** Etherscan emits a
   bare `0x` for zero, which is not valid QUANTITY hex and which strict decoders
   reject.

Also not implemented, and named rather than stubbed: `functionName` on a
`txlist` row is always empty (resolving a selector needs a signature database we
do not have, and a wrong function name is worse than none), and
`module=logs`'s `topicX_Y_opr=or` is refused rather than silently ANDed.

---

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HEARTH_RPC_URL` | `http://127.0.0.1:8545` | the `eth_*` endpoint. **Not 8645**, which is the UTXO-era REST API and answers a POST with a 200 that is not JSON-RPC |
| `HEARTH_CHAIN_ID` | `7411` | a mismatch at boot is **fatal** |
| `HEARTH_COMMONS_ADDRESS` | *(unset)* | without it, circulating supply is refused |
| `HEARTH_VERIFY_URL` | *(unset)* | `tools/verify`; without it every contract reads as unverified, which is true rather than an outage |
| `HEARTH_EXPLORER_API_PORT` / `_HOST` | `9647` / `127.0.0.1` | no TLS, no auth — put it behind a proxy |
| `HEARTH_EXPLORER_API_DATA` | `./explorer-index` | disposable; delete it and it rebuilds |
| `HEARTH_EXPLORER_API_START_BLOCK` | `0` | |
| `HEARTH_EXPLORER_API_POLL_MS` | `2000` | |
| `HEARTH_EXPLORER_API_BATCH` | `64` | blocks per catch-up tick; bounded so an initial sync cannot starve the HTTP surface |
| `HEARTH_EXPLORER_API_MAX_LAG_BLOCKS` | `8` | above this, address queries refuse |
| `HEARTH_EXPLORER_API_REORG_ALERT_DEPTH` | `5` | logged at error above this |
| `HEARTH_EXPLORER_API_MAX_REORG_DEPTH` | `1000` | above this the indexer parks |
| `HEARTH_EXPLORER_API_DEFAULT_OFFSET` / `_MAX_OFFSET` | `100` / `1000` | |
| `HEARTH_EXPLORER_API_BLOCK_CACHE` | `256` | blocks-with-receipts held in memory |
| `HEARTH_EMISSION_R0_EMBER`, `_TAIL_EMBER`, `_HALFLIFE_YEARS`, `_BLOCK_TIME_S` | `6`, `0.3`, `2`, `15` | the published schedule; pin to consensus when phase 5 lands |
| `HEARTH_EXPLORER_API_KEY` | *(unset)* | require a matching `apikey` |

`/health` reports index size, lag, reorg counters, cache hit rates and whether
the Commons address is configured. It is **503 while the index is behind or
parked**, so a load balancer will take it out rather than serve half an answer.

---

## What is proven, and what is not

There are two suites, and the difference between them is the point.

`pnpm test` (`test/explorer-api.test.js`) drives both HTTP surfaces for real:
the service talks to a **fake chain** served by the tree's own `node/src/jsonrpc`
layer, and the assertions talk to the service through its own socket. Using the
real RPC encoder matters — it means a QUANTITY/DATA mistake surfaces here rather
than on a running chain, which hand-written JSON fixtures would never catch
because they would agree with whatever the parser expected.

`pnpm run test:live` (`test/live-chain.test.js`) is **the aggregator/listing
gate**. It boots a real node from `node/src` — real proof-of-work, real signed
transactions, real EVM execution — mines a block holding two log-emitting
transactions, and requires `module=account&action=balance` and
`module=logs&action=getLogs` to agree field for field with `eth_getBalance` and
`eth_getLogs`. Point it at a node someone else is running with
`HEARTH_LIVE_RPC_URL=http://127.0.0.1:8545` and it indexes a window of that
chain's recent history and runs the same comparison; it refuses rather than
passing if that window holds no logs.

That distinction is not academic. A fake chain agrees with whatever its author
believed, and the belief that the node numbers `logIndex` per receipt is what
kept this suite — and with it CI's whole *Developer kit* job — red.

**Fixture-verified** (proven by `test/explorer-api.test.js`):

- ingestion, paging, sorting, block ranges, and every envelope shape;
- the log-ordinal derivation, against a block with three logs across two
  transactions;
- reorg unwind — an orphaned transaction stops being served and the replacement
  appears; the deep-reorg park; block-cache invalidation;
- crash repair, in both the torn-postings and orphaned-chain-record cases;
- the supply arithmetic, both refusals, and that circulating is strictly less
  than total;
- internal transactions refused without a tracer and indexed with one.

**Chain-verified** (proven by `test/live-chain.test.js`, against blocks a node
actually mined and executed):

- balances served by the shim equal `eth_getBalance`, in decimal wei rather than
  the node's hex;
- logs served by the shim equal `eth_getLogs` — address, topics, data, block,
  transaction, position and ordinal;
- `logIndex` really is numbered across the block by the chain, on a block with
  two log-emitting transactions, where per-receipt numbering would give both
  ordinal 0;
- a receipt carrying logs is served rather than refused.

**Still not proven:**

- indexing throughput or memory at any real chain length. The 180 MB figure
  above is arithmetic, not a measurement, and the live gate mines five blocks.
- the emission model against consensus. It matches the published schedule and
  `proto/emission.js`; the account-model genesis is not written
  ([`../../docs/listing-checklist.md`](../../docs/listing-checklist.md) M6), so
  the cross-check exists precisely because the model could be wrong.
- anything about `debug_traceTransaction` on a real node — it is not in the v1
  surface, so the internal-transaction path has only ever run against a stub
  that implements it.
