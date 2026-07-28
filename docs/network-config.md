# Hearth network configuration

Every form the chain's connection details take, in one place, so nobody has to
guess and nobody has to ask.

> ### Status, before anything else
>
> **There is no public Hearth endpoint. As of this document there is no live
> account-model chain at all.**
>
> Phases 1–4 of [`evm-spec.md`](evm-spec.md) §8 are built and gated on published
> vectors; the `eth_*` JSON-RPC layer (`node/src/jsonrpc/`) is written and
> tested against an in-memory fake. **Phase 5 — consensus on the new state
> model — has not landed**, so nothing produces blocks and nothing serves these
> methods over a real chain yet.
>
> Everything below is therefore the **specification you configure against**, not
> a description of a running network. The chain id, the decimals, the encodings
> and the shapes are frozen and correct. The URLs are not, because they do not
> exist. Every field that cannot be filled in today is marked
> **`⬜ does not exist yet`** rather than given a plausible-looking placeholder.

---

## 1. The canonical values

| Field | Value | Source |
| --- | --- | --- |
| Chain name | Hearth | [`evm-spec.md`](evm-spec.md) §1 |
| **Chain ID (decimal)** | **`7411`** | `node/src/chain/transaction.js:57` |
| **Chain ID (hex)** | **`0x1cf3`** | the same number |
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
| RPC URL | ⬜ does not exist yet | |
| WebSocket URL | ⬜ not in v1 at all (`eth_subscribe` is v2) | [`evm-spec.md`](evm-spec.md) §6 |
| Block explorer URL | ⬜ does not exist yet for `0x` addresses | [`listing-checklist.md`](listing-checklist.md) §3 |
| Faucet URL | ⬜ not deployed — the service is built, at [`../tools/faucet`](../tools/faucet) | |
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

## 3. Where the RPC will be served, and an open question

`node/src/jsonrpc/server.js` exists and works, but **it is not yet mounted by
`hearthd`** — nothing in `node/bin/` or `node/src/node.js` constructs it. Two
things are therefore undecided, and both are things an integrator will hit
first:

**a. The port.** [`exchange-integration.md`](exchange-integration.md) §1 lists
8645 as the default RPC port, which is `DEFAULT_RPC_PORT` in
`node/src/params.js:130` — the port the **UTXO-era REST API** already occupies.

**b. The path — and this one is a live collision.** The REST server already
answers `POST /rpc` with a completely different protocol: a
`{method, params}` shape whose method set is
`getinfo` / `getbalance` / `getblockcount` / `sendtx` (`node/src/rpc.js:242-254`).
Anything else gets `{"err":"unknown method"}` at **HTTP 200**, with no `jsonrpc`
field and no error object.

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

**Until phase 5 chooses, assume nothing.** The choice is between a separate port
(cleanest; the REST API keeps `/rpc` and its existing clients keep working) and
a new path such as `/eth` on 8645. Whichever it is, it must be decided before it
is published, because it goes into `ethereum-lists/chains` and into every wallet
in the world, and it cannot be changed afterwards.

---

## 4. The forms

### 4.1 MetaMask and any EIP-3085 wallet

See [`../tools/metamask.md`](../tools/metamask.md) for the full page, including
the `wallet_addEthereumChain` payload and why each field is what it is.

The short version:

| MetaMask field | Value |
| --- | --- |
| Network name | `Hearth` |
| New RPC URL | ⬜ does not exist yet |
| Chain ID | `7411` — MetaMask's UI takes **decimal** |
| Currency symbol | `EMBER` |
| Block explorer URL | ⬜ does not exist yet (optional field) |

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

Not filed, and cannot be until there is an endpoint
([`listing-checklist.md`](listing-checklist.md) §1.1). The shape it will take,
so the missing pieces are visible:

```json
{
  "name": "Hearth",
  "chain": "Hearth",
  "rpc": ["⬜ https://rpc.…"],
  "faucets": ["⬜ https://faucet.…"],
  "nativeCurrency": { "name": "Ember", "symbol": "EMBER", "decimals": 18 },
  "infoURL": "https://hearth.cloudsforge.online",
  "shortName": "⬜ undecided — must be globally unique in the registry",
  "chainId": 7411,
  "networkId": 7411,
  "icon": "⬜ needs an entry in _data/icons/",
  "explorers": [{ "name": "⬜", "url": "⬜", "standard": "EIP3091" }]
}
```

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

**The testnet's chain id.** [`exchange-integration.md`](exchange-integration.md)
§8 commits to a public account-model testnet with *"a documented chain id
distinct from 7411"*. That id has not been chosen. Everything in this document
describes 7411, which is mainnet.

---

## 7. Contract addresses

Nothing is deployed. Not on a testnet, not anywhere — there is no chain to
deploy to.

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
