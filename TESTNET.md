# Hearth EMBER — Isolated Testnet

This document explains how the Hearth node supports fully isolated networks, and
how to run a self-contained 3-node EMBER testnet with `docker-compose.testnet.yml`.

> **Looking for the PUBLIC testnet?** It is at
> `https://rpc-testnet.cloudsforge.online`, chain id **7412** (`0x1cf4`), with an
> explorer at `https://explorer-testnet.cloudsforge.online`, a faucet at
> `https://network-testnet.cloudsforge.online/faucet` and P2P at
> `wss://p2p-testnet.cloudsforge.online/p2p` — only the `/p2p` path is routed.
> Testnet hostnames are **single-label** (`rpc-testnet.`, never `rpc.testnet.`).
> This document is about running your *own* isolated network; see
> [`docs/network-config.md`](docs/network-config.md) for connection details.

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
| `hearth-testnet-seed`    | non-mining bootstrap  |  | P2P on host (TCP) and `:8648/p2p` (WebSocket) |
| `hearth-testnet-miner1`  | mining, peers to seed |  | `HEARTH_MINE=1`, `HEARTH_THROTTLE=0.6`  |
| `hearth-testnet-miner2`  | mining, peers to seed |  | `HEARTH_MINE=1`, `HEARTH_THROTTLE=0.6`  |

Inside every container the RPC binds to `8645` and P2P to `8646`; only the
**host** port mapping differs (the miners map host/ → container). Each container has its own named volume so its chain persists across
restarts.

## Mining from your own machine

**`hearth-mine` is the way in, and it is not a node.** It takes work from a node
over HTTP, grinds it, and posts the proof back. No chain on your disk, no sync,
no open ports:

```bash
cd node && node bin/hearth-mine.js --url https://<host>
```

Two commands before that one are worth knowing:

```bash
node bin/hearth-mine.js --address    # the address every block you mine will pay
node bin/hearth-mine.js --help
```

The key is created on first run in `<data>/coinbase-key.json`, mode `600`. **Back
it up.** Whoever holds it holds the coins, and nothing else in the system can
recover it. It is never printed and never leaves the machine — the node issues
work for your *public* key and you sign the winning digest yourself
(`node/src/chain/header.js` `signProof`), which is what makes work issued to you
redeemable only by you.

`--url` points at the **REST** API — the port serving `/info` and `/mining/*`,
container `8645` — not the Ethereum JSON-RPC one.

### What a light miner gives up, and what it does not

It **cannot validate the chain it mines on.** It does not hold the chain, so it
does not know whether the parent is real or whether the endpoint is the network
everyone else is on. Point it at a node you trust. If you want to check for
yourself, run a full node that mines instead:

```bash
node bin/hearthd.js --evm --mine --p2p 0 --peer wss://p2p.<apex>/p2p
```

What it does **not** give up is anything about the money or the electricity:

| It checks | Because |
|---|---|
| the core hash commits to the header it arrived with | otherwise "this work pays you" is only the endpoint's word for it |
| the coinbase is this machine's own key | work paying someone else is refused after you have paid for it |
| the proof-of-work parameters are this build's | after a retune, a miner that does not check hashes happily and produces nothing valid |

None of these is theoretical politeness: a proof cannot be *stolen* — `verifyPow`
recovers the signing key and compares it to the header's coinbase — but work you
should never have ground costs you exactly as much as a stolen block, and is far
harder to notice. `node/test/miner-cli.js` runs the miner against a deliberately
lying endpoint for each row above.

## Joining from another machine

The seed speaks the **same gossip protocol over two transports**. Which one you
can use depends entirely on how you reach the machine:

| Transport | Address | Use it when |
|---|---|---|
| TCP  | `hearth-testnet-seed:8646`, or `host:8646` | you are on the same docker network or the same LAN |
| WebSocket | `wss://p2p.<apex>/p2p` (container `8648`) | you are anywhere else |

The second one exists because there is no third option. CloudsForge is published
from a home server behind a **Cloudflare Tunnel** and the operator has no static
IP, so every inbound connection arrives through the tunnel. A tunnel carries HTTP
and WebSocket and **cannot carry raw TCP** — so `8646` is unreachable from
outside the house, and a miner that cannot gossip cannot mine: a mined block
reaches the network only through `p2p.broadcast` (`node/src/evmnode.js`).

It is not a different protocol. It is the identical newline-delimited JSON, with
**one line per WebSocket text message**, so a WebSocket peer and a TCP peer of
the same node relay to each other with nothing in between translating
(`node/test/p2p-ws.js` asserts exactly that). Every bound is on the shared path:
the peer cap, the 4 MiB read bound, the per-connection proof-of-work and
transaction verification budgets, the invalid-block budget, and the handshake
that refuses a peer on a different genesis, chain id or Commons address.

To run a **full node** that also mines, from a Mac or a PC:

```bash
# from a checkout of this repository
cd node && node bin/hearthd.js --evm --mine --p2p 0 --peer wss://p2p.<apex>/p2p
```

`--p2p 0` says *do not listen*: a machine dialling out through a tunnel has
nothing to serve, and an ephemeral listener nobody can be told about is strictly
worse than none.

If you only want to **mine**, you do not need any of this — use `hearth-mine`
above. It speaks HTTP to the REST API and needs no P2P transport at all.

Two things about this transport are worth knowing before you debug it:

- **It keeps itself alive.** Cloudflare closes a WebSocket that carries nothing,
  so the node pings every 20 s and hangs up on a peer that has answered nothing
  for 70 s (`P2P_WS_PING_MS` / `P2P_WS_IDLE_MS`, `node/src/params.js`). Without
  that the link dies quietly and a miner looks connected while receiving nothing.
- **A browser cannot peer.** The upgrade is refused if it carries an `Origin`
  header. Any page on any origin can open a WebSocket to any host with no
  preflight and no CORS — a raw TCP port cannot be reached that way at all — so
  without this an anonymous page's visitors could take every one of the 64 peer
  slots without knowing they had.

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
