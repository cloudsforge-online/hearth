# Hearth network configuration

Every form the chain's connection details take, in one place, so nobody has to
guess and nobody has to ask.

> ### Status, before anything else
>
> **The public Hearth endpoint is `https://rpc.cloudsforge.online`, chain id
> 7411 (`0x1cf3`).** JSON-RPC over **POST** — a `GET` answers `405`. The
> certificate is publicly trusted (Google Trust Services, via Cloudflare), so no
> `--resolve` and no CA override is needed. An explorer is at
> `https://explorer.cloudsforge.online`.
>
> **Mainnet only.** There is **no publicly reachable testnet**: every
> `*.testnet.cloudsforge.online` name resolves to Cloudflare but fails the TLS
> handshake at the edge, because Universal SSL's `*.cloudsforge.online` wildcard
> is single-label and does not cover a two-label name. Only the bare
> `testnet.cloudsforge.online` apex answers. Do not configure any testnet
> subdomain — it cannot work today.
>
> **And "live" means reachable, not established.** Block 1 was mined
> 2026-08-04 19:12 UTC. The chain is hours old, is at the `GENESIS_TARGET`
> difficulty floor, carries zero transactions so far, and runs on **one home
> server behind one Cloudflare Tunnel** — no redundancy, no failover, no backup
> ever restored. Precisely:
>
> - **The chain runs.** `node/src/evmnode.js` builds the blockchain, the miner
>   and the JSON-RPC server and mounts it on 8545 (`evmnode.js:186`).
>   `hearthd --evm --mine` is a one-command account-model chain on your own
>   machine, and [`../docker-compose.testnet.yml`](../docker-compose.testnet.yml)
>   runs three of them on `hearth-testnet`, chain id **7412**, with the genesis
>   hash published in [`../TESTNET.md`](../TESTNET.md).
> - **It is proven under test, to a stated depth.** `node/test/evmchain.js`
>   (191 checks) covers block production and validation; `node/test/evm-rpc.js`
>   (170) drives the `eth_*` surface over real HTTP against that chain; and
>   `node/test/evm-p2p-fork.js` (51) runs **two real nodes over real sockets** —
>   they partition, mine divergent branches, reorg onto the heavier one, agree
>   on state roots byte for byte, and a restarted node replays its disk to the
>   same tip. What that does **not** prove is written down in
>   [`testing.md`](testing.md) §4, and it is not a short list: no long-range
>   reorg, no sustained load, and **no run at production PoW parameters**
>   ([`pow-parameters.md`](pow-parameters.md)).
> - **Mainnet is deployed; nothing else is.** Every port in the compose file
>   still binds `127.0.0.1` — the tunnel, not the bind address, is what makes
>   mainnet reachable. There is still no public faucet, and no testnet hostname
>   that completes a TLS handshake.
>
> So everything below is **both** the specification you configure against and,
> where marked **[LOCAL]**, a description of something you can run in a
> terminal in the next five minutes. Fields that genuinely do not exist are
> still marked **`⬜ does not exist yet`** rather than given a
> plausible-looking placeholder — but that mark now means *unpublished*, not
> *unbuilt*.

---

## 1. The canonical values

| Field | Value | Source |
| --- | --- | --- |
| Chain name | Hearth | [`evm-spec.md`](evm-spec.md) §1 |
| **Chain ID (decimal)** | **`7411`** mainnet · **`7412`** testnet | resolved per network in `node/src/params.js` (`CHAIN_IDS`); `node/src/chain/transaction.js` reads it and never declares it ([`evm-spec.md`](evm-spec.md) §1) |
| **Chain ID (hex)** | **`0x1cf3`** · testnet `0x1cf4` | the same numbers |
| Native currency name | Ember | [`listing-checklist.md`](listing-checklist.md) §1.1 — **and see §6, the name is not finally decided** |
| Native currency symbol | `EMBER` | |
| **Native currency decimals** | **`18`** | [`evm-spec.md`](evm-spec.md) §1 — changed from 8, deliberately |
| Smallest unit | wei (`1 EMBER = 10^18`) | the "spark" is retired with the UTXO chain |
| Address format | `0x` + 40 hex, EIP-55 mixed-case checksum | [`evm-spec.md`](evm-spec.md) §2 |
| Signature curve | secp256k1 | |
| Transaction types | **legacy (type 0) only** — no EIP-1559 in v1 | [`evm-spec.md`](evm-spec.md) §3 |
| Fork semantics | **Shanghai** — PUSH0, EIP-3529, EIP-3651, EIP-3860. No blobs, no MCOPY/TSTORE/TLOAD | [`evm-spec.md`](evm-spec.md) §1 |
| Block time | 15 s target | |
| Block gas limit | 30,000,000 | |
| Consensus | proof-of-work (Homefire), heaviest-cumulative-work | |
| Finality | probabilistic, **unbounded reorg depth** | [`exchange-integration.md`](exchange-integration.md) §4 |
| RPC URL | ✅ **mainnet: `https://rpc.cloudsforge.online`** — POST only, root path, publicly trusted TLS. **[LOCAL]** `http://127.0.0.1:8545` — `hearthd --evm`, or `docker compose -f docker-compose.testnet.yml up`, serves the same surface. The port and path are settled: 8545, root path — see §3. **No testnet URL exists**; see the status block above | [`evm-spec.md`](evm-spec.md) §6 |
| WebSocket URL | ⬜ not in v1 at all (`eth_subscribe` is v2). Port **8546 is reserved** for it and deliberately left unbound; poll `eth_newFilter`/`eth_getFilterChanges` meanwhile (`node/src/jsonrpc/filters.js`) | [`evm-spec.md`](evm-spec.md) §6 |
| Block explorer URL | ✅ **`https://explorer.cloudsforge.online`** (200), **but the explorer that was built is no longer in this repository** — `web/` was deleted in `48bc28a`. The estate surface is [`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web), which reads `micro-indexer` rather than `eth_*`. The Etherscan-compatible `/api` is still here and runs against a real chain in CI ([`../tools/explorer-api`](../tools/explorer-api)) | [`listing-checklist.md`](listing-checklist.md) §3 |
| Faucet URL | ⬜ nothing published — the service is built and tested, at [`../tools/faucet`](../tools/faucet) | |
| Multicall3 | ⬜ not deployed. See §7 | |
| SLIP-44 coin type | ⬜ unregistered. Derive under coin type **60** (Ethereum) meanwhile | [`listing-checklist.md`](listing-checklist.md) §1.2 |

---

## 2. Hex or decimal — the one that breaks MetaMask

Two methods return the same number in two different encodings, and they are not
interchangeable:

| Method | Returns | Example |
| --- | --- | --- |
| `eth_chainId` | **hex QUANTITY** | `"0x1cf3"` |
| `net_version` | **decimal STRING** | `"7411"` |

This is not a Hearth quirk. It is the Ethereum JSON-RPC specification, and every
client is strict about it. `net_version` predates the hex-quantity convention and
was never migrated.

**Get it backwards and MetaMask refuses the network outright.** Its add-network
flow calls both and compares them; if `net_version` comes back as `"0x1cf3"` the
comparison fails and the user sees a chain-id mismatch that names neither value
and suggests no fix. It is answered correctly by the RPC layer today —
`node/src/jsonrpc/methods.js` carries the comment *"net_version is a DECIMAL
string, not hex — the one place hex is wrong"* — and there is a test pinning it.

Verify it against any endpoint claiming to be Hearth, in two commands:

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$HEARTH_RPC_URL"
# {"jsonrpc":"2.0","id":1,"result":"0x1cf3"}

curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"net_version","params":[]}' "$HEARTH_RPC_URL"
# {"jsonrpc":"2.0","id":1,"result":"7411"}
```

Both of those were run against `tools/rpc-probe/stub.js` and produced exactly the
output shown.

Everywhere else in the RPC, quantities are **minimal-length hex**: `0x0`, never
`0x00`, never `0x0000`. Data — hashes, addresses, bytecode, storage words — is
fixed-width and zero-padded. Clients enforce this; so does Hearth.

---

## 3. Where the RPC is served — settled

**The decision is settled: port 8545, root path `/`.** Recorded in
[`evm-spec.md`](evm-spec.md) §6: use the port the ecosystem already defaults to.
It is MetaMask's localhost default and what every Hardhat and Foundry tutorial
assumes, so a developer's first guess is correct.

**The allocation below is built and bound.** Both columns are served today:
`node/src/evmnode.js` constructs the JSON-RPC server and listens on 8545
(`evmnode.js:186`), and `docker-compose.testnet.yml` publishes all three host
ports. This paragraph used to say the opposite — "nothing serves 8545 yet, grep
and you will find nothing" — and it was true when it was written.

| | REST + SSE | **Ethereum JSON-RPC** |
| --- | --- | --- |
| container port | 8645 | 8545 |
| path | `/info`, `/address/:a`, `/block/:id`, `/tx/:id`, `/supply`, `/events` | `/` |
| host: seed | 8645 | 8545 |
| host: miner1 | 8647 | 8547 |
| host: miner2 | 8649 | 8549 |

The host ports come from `docker-compose.testnet.yml`. Every node listens on
8545 inside its container; the host ports differ only so three can run side by
side. **8546 is reserved** for the v2 WebSocket endpoint (`eth_subscribe`) and
is deliberately left unbound rather than given to something else, because that
is the paired convention and reclaiming it later would break every client that
guessed.

**These are loopback bindings.** `127.0.0.1:8545` is a chain you can point
Hardhat at. It is not itself reachable from outside; what makes mainnet
reachable is a **Cloudflare Tunnel** in front of it, not a change of bind
address. The compose file above is unchanged, and the testnet ports it lists are
still routed by nothing.

Publicly this is one hostname — `rpc.cloudsforge.online` → 8545 — and it is now
serving. That URL is what goes into `ethereum-lists/chains` and
`chainid.network`, where MetaMask caches it, exchanges hardcode it and dapps bake
it into configs. **It cannot be changed after publication without stranding all
of them at once**, which is now a live constraint rather than a future one.

### Why not 8645, where the REST API already is

Because `POST /rpc` there is already a different protocol. The REST server answers
it with a `{method, params}` shape whose method set is
`getinfo` / `getbalance` / `getblockcount` / `sendtx` (`node/src/rpc.js:139`,
`:242-254`), and anything else gets `{"err":"unknown method"}` at **HTTP 200** —
with no `jsonrpc` field and no error object.

Observed against a running node in this tree:

```console
$ curl -s -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:8645/rpc
{"err":"unknown method"}

$ curl -s -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:8645/
{"err":"no route"}
```

Hardhat, pointed at `http://127.0.0.1:8645`, fails with:

```
HardhatError: HH110: Invalid JSON-RPC response received: {"err":"no route"}
```

A 200 that is not JSON-RPC 2.0 reads to a client as an **empty chain** rather than
as a misconfiguration, which is the worst available failure mode. Two ports, two
protocols, no ambiguity.

### What now serves it

`node/src/jsonrpc/server.js` is constructed by `node/src/evmnode.js` and mounted
on 8545 over a real account-model chain. Two commands reach it:

```bash
node node/bin/hearthd.js --evm --mine          # one node, your machine
docker compose -f docker-compose.testnet.yml up -d    # three, chain id 7412
```

The surface is 41 methods (43 with `HEARTH_RPC_FEE_HISTORY=1`), tested at 422
checks against a fake chain and 170 against a real one over HTTP.

`tools/rpc-probe/stub.js` still exists and is still useful, but its job has
narrowed: it serves the same method surface over a chain with **no state**, so
it proves your wiring, your encodings and your chain id without mining
anything. It is no longer the only thing to point tooling at, and a deployment
should never point at it.

---

## 4. The forms

### 4.1 MetaMask and any EIP-3085 wallet

See [`../tools/metamask.md`](../tools/metamask.md) for the full page, including
the `wallet_addEthereumChain` payload and why each field is what it is.

The short version:

| MetaMask field | Value |
| --- | --- |
| Network name | `Hearth` |
| New RPC URL | `https://rpc.cloudsforge.online`. **[LOCAL]** `http://127.0.0.1:8545` also works |
| Chain ID | `7411` — MetaMask's UI takes **decimal**. The local-only testnet is **`7412`** |
| Currency symbol | `EMBER` |
| Block explorer URL | `https://explorer.cloudsforge.online` (optional field) |

### 4.2 ethers v6

```js
import { JsonRpcProvider, Network } from 'ethers';

// Naming the network stops ethers probing for one, which saves a round trip
// and removes a class of "could not detect network" errors on a slow node.
const hearth = new Network('hearth', 7411);
const provider = new JsonRpcProvider(process.env.HEARTH_RPC_URL, hearth, {
  staticNetwork: hearth,
});
```

ethers needs no further configuration for legacy pricing. **Measured** (ethers
6.15 against `tools/rpc-probe/stub.js`): it reads `eth_getBlockByNumber("latest")`,
finds no `baseFeePerGas`, concludes there is no fee market, and falls back to
`eth_gasPrice` and a type-0 transaction on its own. See §5.

### 4.3 viem

```ts
import { defineChain, createPublicClient, http } from 'viem';

export const hearth = defineChain({
  id: 7411,
  name: 'Hearth',
  nativeCurrency: { name: 'Ember', symbol: 'EMBER', decimals: 18 },
  rpcUrls: { default: { http: [process.env.HEARTH_RPC_URL!] } },
  // blockExplorers: omitted — there is no 0x-native explorer yet. An entry
  // here makes viem produce links that 404, which is worse than no link.
  contracts: {
    // multicall3: omitted for the same reason. viem batches reads through
    // Multicall3 when it is configured; pointing it at an address with no code
    // makes every batched read return empty, which looks like "the contract
    // said zero" rather than like an error.
  },
  // No `fees` block: viem, like ethers, infers legacy pricing from a block
  // response with no baseFeePerGas.
});

export const client = createPublicClient({ chain: hearth, transport: http() });
```

### 4.4 Hardhat

A complete, working project is at [`../tools/hardhat`](../tools/hardhat). The
network entry:

```js
networks: {
  hearth: {
    url: process.env.HEARTH_RPC_URL,
    chainId: 7411,
    accounts: [process.env.HEARTH_PRIVATE_KEY],
    gasPrice: 1_000_000_000,     // optional; pins legacy pricing, saves a round trip
  },
},
solidity: {
  version: '0.8.26',
  settings: {
    evmVersion: 'shanghai',      // NOT optional — see §5
    optimizer: { enabled: true, runs: 999999 },
    metadata: { bytecodeHash: 'none' },
  },
},
```

### 4.5 Foundry

A complete project is at [`../tools/foundry`](../tools/foundry). `foundry.toml`:

```toml
[profile.default]
solc_version = "0.8.26"
evm_version  = "shanghai"
optimizer = true
optimizer_runs = 999_999
bytecode_hash = "none"

[rpc_endpoints]
hearth = "${HEARTH_RPC_URL}"
```

**Foundry additionally needs `--legacy` on every broadcasting command.** This is
not a preference; without it, it fails. See §5.

### 4.6 web3.py

```python
from web3 import Web3
w3 = Web3(Web3.HTTPProvider(os.environ["HEARTH_RPC_URL"]))
assert w3.eth.chain_id == 7411
# Build transactions with `gasPrice`, not `maxFeePerGas` — type 0 only.
```

### 4.7 `ethereum-lists/chains` entry

Not filed. The endpoint that used to block it now exists
([`listing-checklist.md`](listing-checklist.md) §1.1); what is still missing is
below, marked. The shape it will take:

```json
{
  "name": "Hearth",
  "chain": "Hearth",
  "rpc": ["https://rpc.cloudsforge.online"],
  "faucets": ["⬜ https://faucet.… — the service exists, nothing hosts it"],
  "nativeCurrency": { "name": "Ember", "symbol": "EMBER", "decimals": 18 },
  "infoURL": "https://cloudsforge.online",
  "shortName": "⬜ undecided — must be globally unique in the registry",
  "chainId": 7411,
  "networkId": 7411,
  "icon": "⬜ needs an entry in _data/icons/",
  "explorers": [
    { "name": "Hearth Explorer", "url": "https://explorer.cloudsforge.online",
      "standard": "⬜ EIP-3091 conformance not verified" }
  ]
}
```

`infoURL` is **not** `hearth.cloudsforge.online` — that name has no DNS record.
Checked 2026-08-05.

`networkId` equals `chainId`. They differ only on chains that forked after
EIP-155; Hearth never has.

**Re-check that 7411 is unclaimed immediately before filing.** The registry
moves, and a collision discovered after mainnet is a chain-splitting-grade
problem for users:

```bash
curl -s https://chainid.network/chains_mini.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const c=JSON.parse(s); console.log('7411 taken?', c.some(x=>x.chainId===7411));})"
```

---

## 5. Gas, fees, and the two toolchains that disagree

Hearth v1 has **legacy (type 0) pricing only**. There is no EIP-1559, no base
fee, no priority fee. `BASEFEE` (opcode `0x48`) exists — Shanghai includes
EIP-3198 and removing it would make Shanghai-compiled Solidity fail here — and
it **pushes zero**.

The mechanism that makes standard tooling do the right thing is a deliberate
omission: **Hearth's block responses do not carry `baseFeePerGas`**
(`node/src/jsonrpc/methods.js`). Emitting a zero base fee would make clients
advertise type-2 transactions the chain cannot execute. `withdrawals` and
`withdrawalsRoot` are absent for the same reason — they are beacon-chain
artefacts.

That omission is sufficient for ethers/viem/Hardhat. **It is not sufficient for
Foundry.**

| Tool | Behaviour, as measured against `tools/rpc-probe/stub.js` |
| --- | --- |
| ethers 6.15 / Hardhat 2.29 | Reads `eth_getBlockByNumber("latest")`, sees no `baseFeePerGas`, calls `eth_gasPrice`, signs a **type-0** transaction. Never calls `eth_feeHistory`. **Works with no extra flags.** |
| `forge create`, `forge script`, `cast send` (Foundry 1.7.1) | Calls **`eth_feeHistory` unconditionally**, before pricing anything, and aborts when it is missing. **`--legacy` is required.** |

The exact Foundry failure:

```console
$ forge create --rpc-url $HEARTH_RPC_URL --private-key $KEY --broadcast \
    src/Greeter.sol:Greeter --constructor-args 'hello hearth'
Error: Failed to estimate EIP1559 fees. This chain might not support EIP1559,
       try adding --legacy to your command.

Context:
- server returned an error response: error code -32601: the method
  eth_feeHistory does not exist/is not available
```

Three details worth knowing rather than discovering:

1. **`--legacy` must be on the command line.** There is no `foundry.toml` key
   for it and no environment variable. `legacy = true` in the profile produces
   `Warning: Found unknown 'legacy' config for profile 'default'` and changes
   nothing; `FOUNDRY_LEGACY=true` is likewise ignored. Both were tested.
2. `forge script` fails at the same point but with different wording —
   `Failed to get EIP-1559 fees; …` — and only *after* it has printed a
   successful local simulation, which reads as though the deployment worked.
3. Only `eth_feeHistory` is probed. `eth_maxPriorityFeePerGas` was never called
   by any of the three commands.

**Implementing `eth_feeHistory` would not be an improvement.** Returning zero
base fees would let Foundry compute a type-2 transaction, which v1 cannot
execute — trading a loud, actionable error at signing time for a silent
rejection at the node. Leaving it unimplemented and documenting `--legacy` is
the correct trade until the fee market lands in v2.

**Re-examined when the rest of the method surface landed, and upheld.** The
method and `eth_maxPriorityFeePerGas` are now written and tested
(`node/src/jsonrpc/methods.js`, `test/jsonrpc.js`) but **registered only when
`HEARTH_RPC_FEE_HISTORY=1`**, so a default node still answers `-32601` and
Foundry still prints its own remedy. The rejection at the node is not silent —
`chain/transaction.js` refuses it as *"transaction type 0x2 — v1 accepts legacy
(type 0) only"* — but it names the cause and not the fix, which is one step
worse than the message above and one step later. The flag exists for a private
endpoint feeding a gas dashboard, which wants `gasUsedRatio` history and is not
running `forge create` through it, and so that v2 is a flag rather than a
project. The measurement in the table above was **not** re-run for this change:
Foundry is not installed here, and nothing about its fee logic changed.

---

## 6. Names that are not yet settled

Do not hard-code these into anything published.

**`nativeCurrency.name`.** SLIP-44 coin type 170 is already registered as
`MBRS / Ember` — an unrelated coin. The *symbol* `EMBER` is free; the *name*
`Ember` is taken. Expect registration to require a distinguishing name —
`Hearth` or `Hearth EMBER` — and expect an aggregator to raise the ambiguity.
The decision propagates into the chains registry, the token list, CoinGecko,
CoinMarketCap and every exchange form, and inconsistency across those is a
common self-inflicted rejection ([`listing-checklist.md`](listing-checklist.md)
§1.2, §1.4).

**`shortName`** in `ethereum-lists/chains` must be globally unique and is not
chosen.

**~~The testnet's chain id~~ — decided.** It is **7412**
([`evm-spec.md`](evm-spec.md) §1): adjacent, memorable, and inside the same
verified-free range. A separate id is mandatory rather than cosmetic — the retired
UTXO scheme carried a `net` field *inside the signed body*, so a testnet signature
was structurally invalid on mainnet, and EIP-155's chain id is what replaces that
protection. Share one id and every testnet transaction is replayable on mainnet
and back. Unless stated otherwise, everything in this document describes 7411,
which is mainnet.

---

## 7. Contract addresses

Nothing is deployed to a **persistent** chain. The contracts deploy and run —
`node/test/dex.js` puts WEMBER, the factory, the pair and the router through a
full add-liquidity/swap/remove cycle on our own EVM — and they deploy to a local
`hearthd --evm` node the same way. But no address below is stable, because no
chain below is published, and an address is only worth recording once the chain
holding it outlives the process that made it.

| Contract | Address |
| --- | --- |
| WEMBER | ⬜ |
| HearthV2Factory | ⬜ |
| HearthV2Router02 | ⬜ |
| Multicall3 | ⬜ — and see below |

**Multicall3 has a decision attached to it.** Front-ends, wallets, viem's
batching and most indexers look for it at
`0xcA11bde05977b3631167028862bE2a173976CA11` on every chain. That address is not
magic: it comes from a **pre-signed, pre-EIP-155, keyless** deployment
transaction carrying solc 0.8.12 / london bytecode, replayed identically
everywhere. Hearth accepts pre-155 transactions specifically so that route stays
open ([`evm-spec.md`](evm-spec.md) §3).

The copy in `contracts/` is **not** that bytecode — it is a 0.8.26 / shanghai
build with `getCurrentBlockDifficulty` respelled. Deploying it yields a different
address. Taking the canonical address means replaying the canonical transaction,
not deploying ours. Decide before front-ends hard-code an address, not after
(`contracts/README.md`).

Until Multicall3 exists at a known address, **do not configure it in viem or
wagmi**. A configured Multicall3 with no code behind it makes every batched read
return empty — and in the EVM a call to an address with no code *succeeds*, so
that reads as "the contract said zero" rather than as an error.

---

## 8. Related

- [`quickstart.md`](quickstart.md) — deploy your first contract, start to finish
- [`../tools/metamask.md`](../tools/metamask.md) — the add-network page
- [`evm-spec.md`](evm-spec.md) — the authoritative specification
- [`exchange-integration.md`](exchange-integration.md) — deposits, withdrawals, confirmations
- [`listing-checklist.md`](listing-checklist.md) — what is registered and what is not
- [`../MAP.md`](../MAP.md) — repository inventory, cited to `path:line`
