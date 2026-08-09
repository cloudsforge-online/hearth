# hearthd — reference node (JavaScript)

A **runnable full node, wallet and miner** for the Hearth network. This is the
correctness-first *reference implementation* and the only node that runs the
network today (see [why two implementations](../docs/why-two-implementations.md));
[`../rust/hearthd`](../rust/hearthd) is a benchmark and a set of libraries, not a
second node.

Zero third-party dependencies — Node's built-in `crypto`, `http`, and `net` only.
Ed25519/SHA-256 run in OpenSSL under the hood.

## ⚠ If you depend on `@cloudsforge/hearth-node` from npm, read this

This directory is published as **`@cloudsforge/hearth-node`**, and for a while the
registry and this source tree disagreed about consensus while both called
themselves `0.1.0`. That is not a packaging annoyance; it silently produces
signatures that verify on one build and not the other.

**What diverged.** Published `0.1.0` predates [application
records](../docs/records.md). Its `txBody()` — the object that is hashed to make
a txid and signed to authorise a spend — emits six fields and never a `records`
key, and it has no `MAX_TX_BYTES`, no `txRecords` and no `validateRecords`. This
tree's `txBody()` (`src/tx.js`) appends `records` whenever a transaction carries
any. So a record-carrying transaction **hashes to a different txid on the two
builds**, and a signature over one body is invalid under the other. Nothing
errors; the transaction is simply rejected by whichever side did not build it.

`0.1.0` also carries the old `MIN_TARGET` (~2⁻²⁰), which is the difficulty
ceiling this tree raised — see the note in `src/params.js`.

**Who this hits.** ForgeKeyvault signs EMBER spends against the pinned registry
build (`forge-keyvault/services/forge-keyvault/src/signing.ts`) while
`docker-compose` runs the testnet from *this* directory. It currently refuses
transactions carrying `records` outright, which is the correct fail-closed
response to the skew, and means the skew is contained rather than live.

**Where it stands.** This tree is now `0.2.0` and published as such, so the
registry no longer serves pre-records code as `latest` and the version number
means something again. It is a deliberate *minor* bump rather than a patch:
`records` in the signed body is a consensus change, so it must not be picked up
silently by a range like `^0.1.0`. Consumers therefore keep resolving `0.1.0`
until someone widens the range on purpose — and doing so requires re-checking
every place that builds or verifies a transaction body.

**Rule for anyone changing `src/`:** the published package is consensus. Bump the
version in the same commit as any change to `tx.js`, `crypto.js`, `chain.js` or
`params.js`, and never reuse one.

## What it does
- Homefire proof-of-work (memory-hard; the proof must be signed by the key its coinbase pays)
- UTXO ledger with Ed25519-signed transactions and stealth-ready addresses
- Emission with the Commons split, EIP-1559-style base-fee **burn**, LWMA difficulty
- P2P block/tx gossip and headers-behind sync (TCP)
- HTTP REST + JSON-RPC + Server-Sent Events for wallets, explorers, merchants
- Disk persistence (ndjson) with full replay on restart

## Run

```bash
# a mining node with an HTTP API on :8645
node bin/hearthd.js --mine

# flags
node bin/hearthd.js \
  --data ./data --rpc 8645 --p2p 8646 \
  --peer 127.0.0.1:8646 --mine --miner-address ember1... --throttle 0.35
```

Env vars (handy in containers): `HEARTH_DATA`, `HEARTH_RPC`, `HEARTH_P2P`,
`HEARTH_PEERS` (comma-separated), `HEARTH_MINE=1`, `HEARTH_THROTTLE`.

## Logs

`HEARTH_LOG_LEVEL` (`trace|debug|info|warn|error|fatal`, default `info`) and
`HEARTH_LOG_FORMAT` (`text|json`). The format defaults to `text` on a terminal
and `json` everywhere else, so an interactive run stays readable while a
container emits one pino-shaped JSON object per line:

```json
{"level":30,"time":1785178645587,"service":"hearthd","msg":"⛏  mined block #1 …","height":1,"reward":5.4}
```

`--quiet` still silences everything.

## Wallet CLI

```bash
node bin/hearth-cli.js info
node bin/hearth-cli.js supply
node bin/hearth-cli.js newaddress
node bin/hearth-cli.js balance
node bin/hearth-cli.js send <toAddress> 5      # send 5 EMBER
node bin/hearth-cli.js blocks 10
```

## Chat CLI

Messaging carried by [records](../docs/records.md). Announce once, then send.

```bash
node bin/hearth-chat.js announce               # publish your reading key
node bin/hearth-chat.js whois <address>        # look up someone else's
node bin/hearth-chat.js send <address> "hi"    # encrypt to them and broadcast
node bin/hearth-chat.js inbox                  # decrypt what is addressed to you
node bin/hearth-chat.js watch                  # stream it live
```

A message confirms when its block does — around 15s, not instantly.

## HTTP API
| Method | Path | Returns |
|---|---|---|
| GET | `/info` | height, tip, hashrate, peers, mempool, difficulty |
| GET | `/supply` | circulating supply, commons treasury, burned total |
| GET | `/blocks?limit=N` | latest block summaries |
| GET | `/block/:idOrHeight` | full block |
| GET | `/tx/:txid` | one transaction, its block and its confirmation depth |
| GET | `/address/:addr` | balance, spendable/immature split + UTXOs (each tagged `coinbase`, `spendable`, `maturesAtHeight`) |
| GET | `/records?app=&key=&since=&limit=` | application records on the active chain |
| GET | `/mining/template?pub=` | a block candidate whose coinbase pays that key |
| GET | `/mempool` | pending transactions |
| GET | `/events` | SSE stream of new blocks; `?app=` streams that app's records instead |
| POST | `/tx` | broadcast a signed transaction |
| POST | `/mining/submit` | `{templateId, nonce, powDigest, powSig}` from a remote miner |
| POST | `/rpc` | JSON-RPC (`getinfo`, `getbalance`, `getblockcount`, `sendtx`) |

## Tests

```bash
npm test              # the gate: every suite in package.json, on a bare checkout
node test/unit.js     # primitives: crypto, tx, pow, emission, difficulty
node test/e2e.js      # mine, pay, verify ledger/burn/persistence end to end
node test/records.js  # record consensus rules, sealed boxes, a whole conversation
node test/p2p-fork.js # partition two nodes and prove the reorg
```

`node test/mining-api.js` used to be listed here and **does not exist**: it was
deleted with `web/` in `48bc28a` and has no successor. The node's `/mining/*` path
is covered instead by `evmchain`, `mine-session`, `miner-cli` and `mining-budget`,
which test the node rather than a browser port of it.

### The two suites that need a second repository

```bash
npm run test:browser   # both of the below
```

`test/browser-pow.js` and `test/browser-proof.js` compare the **browser** miner
against this node — the hash loop digest for digest, and the proof signature through
the real template flow. The browser half lives in
[`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site)
`src/mining/`, so they are deliberately outside `npm test`: that command must pass on
a checkout of this repository alone. Clone it beside this one, or point
`HEARTH_BROWSER_MINING_SRC` at the directory. They **fail rather than skip** when it
is missing — a skip line scrolls past exactly like a pass, which is how these two
came to be cited here for five days while not existing at all.

## Docker
See [`../docker-compose.yml`](../docker-compose.yml) and
[`../docs/network.md`](../docs/network.md) to run a multi-node network.
