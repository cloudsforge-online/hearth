# hearthd — reference node (JavaScript)

A **runnable full node, wallet and miner** for the Hearth network. This is the
correctness-first *reference implementation* (see
[why two implementations](../docs/why-two-implementations.md)); the fast
production core lives in [`../rust/hearthd`](../rust/hearthd).

Zero third-party dependencies — Node's built-in `crypto`, `http`, and `net` only.
Ed25519/SHA-256 run in OpenSSL under the hood.

## What it does
- Homefire proof-of-work (memory-hard + non-outsourceable)
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
| GET | `/mempool` | pending transactions |
| GET | `/events` | SSE stream of new blocks; `?app=` streams that app's records instead |
| POST | `/tx` | broadcast a signed transaction |
| POST | `/rpc` | JSON-RPC (`getinfo`, `getbalance`, `getblockcount`, `sendtx`) |

## Tests

```bash
node test/unit.js     # primitives: crypto, tx, pow, emission, difficulty
node test/e2e.js      # mine, pay, verify ledger/burn/persistence end to end
node test/records.js  # record consensus rules, sealed boxes, a whole conversation
node test/p2p-fork.js # partition two nodes and prove the reorg
```

## Docker
See [`../docker-compose.yml`](../docker-compose.yml) and
[`../docs/network.md`](../docs/network.md) to run a multi-node network.
