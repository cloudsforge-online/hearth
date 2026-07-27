# Hearth EMBER — Isolated Testnet

This document explains how the Hearth node supports fully isolated networks, and
how to run a self-contained 3-node EMBER testnet with `docker-compose.testnet.yml`.

## How isolation works (by design)

The node already treats the **network id** as a hard boundary, so multiple
independent chains can coexist on the same machine or LAN without ever mixing:

- **P2P handshake gating** — every peer connection opens with a `hello` message
  that carries `net: P.NETWORK` (`node/src/p2p.js`). A node **refuses any peer**
  whose `net` differs from its own (`if (msg.net && msg.net !== P.NETWORK) { … sock.destroy() }`).
  Nodes on `hearth-testnet` therefore cannot gossip blocks or transactions with
  nodes on the default `hearth` network.
- **Transaction binding** — every transaction is stamped with `net: P.NETWORK`
  (`node/src/tx.js`), binding its signature to the chain and providing
  cross-network replay defense.
- **Observable everywhere** — the network id flows through the RPC `/info`
  endpoint (`network` field), the node startup log, and the CLI.

The network id is env-overridable:

```js
// node/src/params.js
NETWORK: process.env.HEARTH_NETWORK || 'hearth',
```

Set `HEARTH_NETWORK=hearth-testnet` on a set of nodes and they form an isolated
island — a distinct handshake id and distinct tx binding — with **no other
change required**.

## Devnet-tuned params (why it mines on a laptop)

The **shipped consensus parameters are dev-tuned**, so the node behaves as a
lively devnet/testnet out of the box — the first blocks arrive in seconds on a
single machine. This testnet deliberately keeps those values (see the `(dev)`
notes in `node/src/params.js`):

- `POW_SCRATCH_KIB: 64`   (production ≈ 2,097,152 / 2 GiB)
- `POW_WALK_STEPS: 256`   (production ≈ 2048+)
- `GENESIS_TARGET`        (easy target: a block roughly every 1–2s at dev hashrate)
- `COINBASE_MATURITY: 10` (production ≈ 100)

A **production mainnet** would require swapping those dev PoW params for the
hardened values noted alongside them in `params.js`, **plus** setting a distinct
`HEARTH_NETWORK`. Do not run mainnet with the dev-tuned params.

## Run the 3-container testnet

```bash
docker compose -f docker-compose.testnet.yml up --build
```

This brings up exactly three node containers, all on `HEARTH_NETWORK=hearth-testnet`:

| Container                | Role                  | Host RPC | Notes                                   |
|--------------------------|-----------------------|----------|-----------------------------------------|
| `hearth-testnet-seed`    | non-mining bootstrap  | `:8645`  | also exposes P2P on host `:8646`        |
| `hearth-testnet-miner1`  | mining, peers to seed | `:8647`  | `HEARTH_MINE=1`, `HEARTH_THROTTLE=0.6`  |
| `hearth-testnet-miner2`  | mining, peers to seed | `:8649`  | `HEARTH_MINE=1`, `HEARTH_THROTTLE=0.6`  |

Inside every container the RPC binds to `8645` and P2P to `8646`; only the
**host** port mapping differs (the miners map host `:8647`/`:8649` → container
`:8645`). Each container has its own named volume so its chain persists across
restarts.

## Poke at it

```bash
# seed node status — note "network":"hearth-testnet"
curl -s localhost:8645/info

# miner1 and miner2 RPCs
curl -s localhost:8647/info
curl -s localhost:8649/info

# latest 5 block summaries via the CLI, pointed at the seed's RPC
cd node && node bin/hearth-cli.js --rpc http://localhost:8645 blocks 5
```

The `network` field in `/info` will read `hearth-testnet` on all three nodes,
confirming they share an isolated chain distinct from the default `hearth`
network. Because the miners peer to the seed, all three converge on one chain;
the seed's height climbs even though it does not mine.

## Running alongside the rest of CloudsForge

`docker-compose.testnet.yml` is self-contained and needs nothing outside this
repository. The CloudsForge platform's own orchestrator
([cloudsforge-online/cloudsforge](https://github.com/cloudsforge-online/cloudsforge))
wires an equivalent testnet into the full stack separately; use that one if you
need EMBER running next to Forge Pay and the rest.
