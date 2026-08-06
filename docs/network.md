# Running a Hearth network locally

Two ways to bring up a real multi-node Hearth network on your machine.

> **This page is about the UTXO chain**, which is the only one that produces
> blocks. The account-model EVM chain has no consensus layer yet, so there is
> nothing to boot and nothing to point MetaMask at
> ([`roadmap.md`](roadmap.md)). The addresses below are `ember1…`, the API is the
> REST surface on 8645, and none of it is the integration surface.
>
> To exercise the **EVM** side today, use `node tools/rpc-probe/stub.js` (the real
> `eth_*` method surface over a fake chain) or `hearth devnet`. See
> [`quickstart.md`](quickstart.md).

## Option A — Docker Compose (recommended)

```bash
docker compose up --build
```

This starts:

| Service | Role | Address |
|---|---|---|
| `seed` | bootstrap node (not mining) | RPC on host, P2P |
| `miner1` | mining node, peers to seed | internal |
| `miner2` | mining node, peers to seed | internal |
| `web` | explorer + wallet + pay demo | http://localhost:8080 |

Open **http://localhost:8080** — the explorer reads the live chain from the
seed node at `http://localhost:8645` and shows the badge **● LIVE — hearthd**.

Query it directly:
```bash
curl -s localhost:8645/info
curl -s localhost:8645/supply
curl -s localhost:8645/blocks?limit=5
```

Tear down:
```bash
docker compose down            # keep chain data
docker compose down -v         # also wipe the chain volumes
```

## Option B — no Docker, just Node

```bash
./scripts/run-local-network.sh          # seed + 2 miners, logs in ./ .netlogs/
# then, in another shell:
cd node && node bin/hearth-cli.js info
cd node && node bin/hearth-cli.js supply
cd node && node bin/hearth-cli.js blocks 5
```

Stop it with `Ctrl-C` (the script cleans up child nodes).

## Make a payment on your local network

```bash
cd node
# create a recipient address (writes to ./data/wallet.json)
node bin/hearth-cli.js --rpc http://localhost:8645 newaddress
# check what the miner earned
node bin/hearth-cli.js --rpc http://localhost:8645 balance
# send 5 EMBER to any address
node bin/hearth-cli.js --rpc http://localhost:8645 send <toAddress> 5
```

The payment appears in the next mined block; watch it land in the explorer.

## Ports
| Port | Purpose |
|---|---|
| 8645 | node RPC / HTTP / SSE |
| 8646 | node P2P (TCP gossip) |
| 8080 | web (Docker only) |

Override the web explorer's node with a query param, e.g.
`http://localhost:8080/?rpc=http://localhost:8645`.
