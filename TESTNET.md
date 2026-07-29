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
- **…and chain gating, because `net` is only a label.** The same `hello` carries
  `genesis`, `chainId` and `commonsAddress`, and any of the three differing drops
  the peer with a log line naming **both** values. A network name is a string two
  incompatible chains agree on for free: `genesis.loadOrCreate` pins a genesis to a
  data directory the first time a node starts, so wiping some volumes and not others
  after a consensus change leaves two chains both calling themselves
  `hearth-testnet`. Without this they connect, orphan every block the other mines
  forever, and nothing anywhere says the word *genesis* — both halves just keep
  climbing on divergent tips. `chainId` and `commonsAddress` are compared
  **separately** because block 0 does not hash them (see below).
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

## The published genesis — what a node must match

Two nodes are on the same chain only if all of these agree. Built from the shipped
`params.js` with no overrides, which is what `docker-compose.testnet.yml` runs:

| Field                 | `hearth-testnet`                                                     |
|-----------------------|----------------------------------------------------------------------|
| chain id              | `7412`                                                               |
| **genesis hash**      | `0xc3a0cc990f31306c54d24c3a490107ce4f91eb18f7941fb3486f02c99c0a7155` |
| genesis state root    | `0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421` |
| genesis `extraData`   | `hearth-testnet/7412`                                                |
| commons address       | `0x0000000000000000000000000000000000000000` (`HEARTH_COMMONS_ADDRESS` unset) |
| block gas limit       | `30000000`                                                           |

That state root is the **empty-trie root**: there is no allocation and no premine.

Check a running node against the table — these four fields are exactly what the
handshake compares, so a node that disagrees on any of them will be refused by
every other node here:

```bash
curl -s localhost:8645/info | jq '{network, chainId, genesis, commonsAddress}'
```

Two things worth knowing rather than rediscovering at 2am:

- **The genesis hash does not cover `chainId` or `commonsAddress`.** Block 0 commits
  to the alloc (through the state root), the gas limit, the target, the timestamp and
  `extraData` — nothing else. Change either of the other two and the genesis hash is
  byte-identical while the chain forks at the first block anybody mines, which is why
  they are compared by name in the handshake and why they are in this table.
- **`genesis.json` is pinned to a data directory the first time a node starts.** After
  a consensus change, a volume that was not wiped keeps the old file. That is the
  split this table exists to let you diagnose in one `curl`.

Regenerate the table after any consensus change:

```bash
cd node && HEARTH_NETWORK=hearth-testnet node -e '
  const g = require("./src/chain/genesis"), { MemoryDB } = require("./src/state/statedb");
  const b = g.build({}, new MemoryDB());
  console.log("genesis   0x" + b.hash);
  console.log("stateRoot 0x" + b.block.header.stateRoot);
  console.log(b.config.chainId, b.config.commonsAddress, b.config.gasLimit);'
```

## Devnet-tuned params (why it mines on a laptop)

The **shipped consensus parameters are dev-tuned**, so the node behaves as a
lively devnet/testnet out of the box — the first blocks arrive in seconds on a
single machine. This testnet deliberately keeps those values (see the `(dev)`
notes in `node/src/params.js`):

- `POW_SCRATCH_KIB: 64`   — and **this is the value mainnet will launch with too**,
  not a placeholder for the 2 GiB the comment used to name. `params.js` now
  refuses to start above `POW_MAX_SCRATCH_KIB: 4096`, because a 2 GiB pad was
  measured at **185.7 s per evaluation** and a validator pays one evaluation per
  block received ([`docs/pow-parameters.md`](docs/pow-parameters.md))
- `POW_WALK_STEPS: 256`   (2,048 is affordable — 1.31x — and buys little on its own)
- `GENESIS_TARGET`        (easy target: a block roughly every 1–2s at dev hashrate)
- `COINBASE_MATURITY: 10` — read only by the retired UTXO path; the account model
  credits the subsidy straight to the balance and has no maturity rule at all

A **production mainnet** would require swapping those dev PoW params for the
hardened values noted alongside them in `params.js`, **plus** setting a distinct
`HEARTH_NETWORK`. Do not run mainnet with the dev-tuned params.

> ### ⚠ `MIN_TARGET` changed — wipe your volumes
>
> The difficulty **ceiling** was raised from ~2⁻²⁰ to ~2⁻⁶⁴. The old value capped
> a block at ~1.1M attempts, which pins difficulty at roughly 300–500 CPU cores;
> past that the retarget clamps, blocks arrive faster than the 15s target, and
> emission permanently accelerates because the schedule is indexed by height, not
> by time. For a coin whose thesis is mass CPU mining, that is a launch blocker.
>
> **This is a hard consensus break with no migration.** `_validate` recomputes the
> expected target for every block, and disk replay runs the same validation — so
> a volume holding any block whose target was clamped at the old ceiling will now
> fail to load, and nodes on either side of the change reject each other with
> `wrong difficulty target`. Existing testnet chains are gone:
>
> ```bash
> docker compose -f docker-compose.testnet.yml down -v   # drop the chain volumes
> docker compose -f docker-compose.testnet.yml up --build
> ```
>
> Deliberate, and free to do now — nothing but throwaway testnets has ever run.
> After launch the same change would be a fork.

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
