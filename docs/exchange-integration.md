# Integrating EMBER — for exchange engineers

**The short version: if you have integrated any EVM chain, you have integrated
this one.**

Hearth speaks standard Ethereum JSON-RPC. Addresses are `0x…` with EIP-55
checksums, the native asset has 18 decimals, transactions are RLP-encoded legacy
(type 0) with EIP-155 replay protection, and deposits are detected exactly the
way you detect ETH deposits: `eth_getBlockByNumber` → look at `to` → confirm at
depth. There is no bespoke address format to parse, no custom signing scheme, no
proprietary SDK to vendor, and no new library to audit. Your existing EVM
codepath, pointed at a different RPC URL with a different chain id, is the
integration.

That is the whole pitch, and the rest of this document is the detail plus an
honest account of what is not built yet.

---

## 0. Status — read this before scheduling work

| Piece | Status |
| --- | --- |
| Chain id, address format, transaction format, gas model | **Specified and frozen.** [`evm-spec.md`](evm-spec.md) |
| Keccak-256, RLP, secp256k1 recovery, `uint256` | **Built**, passing published vectors |
| Merkle Patricia Trie, StateDB | **Built**, passing `ethereum/tests` TrieTests |
| EVM interpreter, opcode table, gas schedule | **Built. 609/609 VMTests pass** |
| Precompiles `0x01`–`0x09` — including bn128 and blake2f | **Built.** All nine of Shanghai's set |
| Transactions, receipts, logs bloom | **Built. 188/188 TransactionTests pass** |
| State transition | **Built. 20,077/20,077 GeneralStateTests pass** — the last ten fixed by EIP-7610 — see [`MAP.md`](../MAP.md) §4.3 |
| `eth_*` JSON-RPC surface | **Built and mounted** on 8545, 41 methods, 422 checks against a fake chain and 170 against a real one — see the caveat below |
| AMM contracts | **Compiled, and executed on our own EVM** — a full Uniswap V2 deployment and a real swap, `node/test/dex.js`, 167/167 |
| **Header v2 and consensus on the account model** | **Built.** Blocks are produced, validated and reorged |
| Public testnet on the account model | **Not published.** Chain 7412 runs on `127.0.0.1`, nothing routes it, and its `*.testnet.cloudsforge.online` names fail TLS — so there is nowhere but mainnet to integrate against |
| Mainnet | **Live.** Chain id 7411 at `https://rpc.cloudsforge.online`. Hours old, under 250 blocks, zero transactions, at the difficulty floor, on one home server with no failover |

**The caveat on the RPC row, because it is the row you care about.** The method
table, the strict QUANTITY/DATA hex codec, the JSON-RPC 2.0 transport, the error
mapping and the block/receipt shapes are all built and tested. They are tested
against an in-memory fake chain **and** against a real one — 422 checks and 170
respectively — and `node/src/evmnode.js:184` mounts the server, which mainnet is
now serving from. (The header comment at `node/src/jsonrpc/methods.js:1-20` still
says "the chain does not exist yet". That comment is stale; the code around it is
not.)

**Do not begin integration work yet — but the reason has changed.** It is no
longer that there is nothing to talk to. It is that mainnet is hours old, holds
zero transactions, has never run at its production proof-of-work parameters, has
not been independently audited, and runs on a single home server with no
failover. Scope the work now; schedule it against a chain with a track record.
Tell us now if anything below would be a problem for you. The request/response
shapes in §5 and §6 are the Ethereum JSON-RPC specification, which is what this
chain implements to — they are the contract, not captures from a running node. The
signing example in §6.2 *is* real: it is produced by this repository's own
secp256k1, RLP and Keccak code and you can reproduce it byte for byte.

**What you can do today, at zero cost:** point your stack at
`https://rpc.cloudsforge.online` (chain id 7411) and read from it — every `eth_*`
method below answers. To exercise your write path without touching a public
chain, point it instead at `node tools/rpc-probe/stub.js`, which serves this
repository's real `eth_*` method surface and hex encoder over a chain with no
state. It will not execute anything,
but it will prove your chain id handling, your encoding assumptions and your
legacy-pricing path — and it logs every method your client calls, *including the
ones we do not implement*, which is the fastest way to tell us what you need. See
[`quickstart.md`](quickstart.md) §3.

Today's running chain is the **UTXO-era** network with a REST API
(`node/src/rpc.js`, documented in [`../MAP.md`](../MAP.md) §7). It is being
replaced, not extended. If you integrate against it you will have to do the work
twice.

---

## 1. Chain parameters

| Parameter | Value |
| --- | --- |
| Chain name | Hearth |
| Native asset | EMBER |
| Symbol | `EMBER` |
| **Chain ID** | **7411** (mainnet). The testnet is **7412** — a separate id, deliberately: with one id shared, every testnet transaction would be replayable on mainnet |
| Decimals | **18** |
| Fork semantics | **Shanghai** — PUSH0 (EIP-3855), EIP-3529 refunds, warm coinbase (EIP-3651), EIP-3860 initcode cap. **No blobs**, no EIP-4844 |
| Transaction types | **Legacy (type 0) only.** EIP-1559 / type 2 deferred to v2 |
| Block time | 15 s target |
| Block gas limit | 30,000,000 |
| Consensus | proof-of-work (Homefire), heaviest-cumulative-work fork choice |
| Finality | **probabilistic, unbounded reorg depth** — see §4 |
| **Ethereum JSON-RPC port** | **8545, at the root path `/`** — settled ([`evm-spec.md`](evm-spec.md) §6). 8546 is reserved for the v2 WebSocket endpoint |
| Legacy REST port | 8645 — the UTXO-era REST + SSE surface, which stays for the explorer and is **not** the integration surface |
| Default P2P port | 8646 |
| Contract address for EMBER | **none.** EMBER is the native coin |

Chain id 7411 is **not yet registered** in `ethereum-lists/chains`. See
[`listing-checklist.md`](listing-checklist.md).

### Addresses

- 20 bytes, rendered `0x…`, **EIP-55 mixed-case checksummed**.
- Derived as `keccak256(uncompressed_pubkey[1:])[12:]` — identical to Ethereum.
- Contract creation address is `keccak256(rlp([sender, nonce]))[12:]` — identical
  to Ethereum.
- **Your existing Ethereum address validator works unchanged.** Accept a 40-hex
  string with `0x` prefix; reject on EIP-55 checksum mismatch when the input is
  mixed-case.
- The old `ember1…` bech32 format is **retired**. If a user gives you an
  `ember1…` string, it is from the pre-EVM chain and cannot receive funds.

Sanity check, using this repository's own code:

```bash
cd node && node -e "
const secp=require('./src/crypto/secp256k1'); const {keccak256}=require('./src/crypto/keccak');
const priv=Buffer.alloc(32); priv[31]=1;
const pub=secp.publicKeyFromPrivate(priv,false);
console.log('0x'+Buffer.from(keccak256(Buffer.from(pub).subarray(1))).subarray(12).toString('hex'));"
# → 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf   (0x7E5F45…95Bdf checksummed)
```

That is the same address Ethereum derives for private key `0x…01`, which is the
cheapest possible proof that the derivation is not bespoke.

---

## 2. Running a node

```bash
git clone https://github.com/cloudsforge-online/hearth && cd hearth/node
node bin/hearthd.js --data /var/lib/hearth --rpc 8645 --p2p 8646 --peer seed.example:8646
```

**That command runs the UTXO-era node**, which is the only one that exists. The
account-model node does not have an entrypoint yet: `node/src/jsonrpc/server.js`
is written and tested but nothing in `node/bin/` or `node/src/node.js` constructs
it. When it does, it will listen on **8545** per §1.

- **Runtime:** Node.js ≥ 18. **Zero runtime dependencies** — the entire node,
  including the EVM, is written against Node's standard library. There is nothing
  to `npm install` and no transitive dependency tree to review.
- **Flags:** `--data`, `--rpc`, `--p2p`, `--peer H:P` (repeatable), `--mine`,
  `--miner-address`, `--throttle`, `--quiet`. Each has an environment override:
  `HEARTH_DATA`, `HEARTH_RPC`, `HEARTH_P2P`, `HEARTH_PEERS`, `HEARTH_MINE`,
  `HEARTH_THROTTLE` (`node/bin/hearthd.js:12-39`).
- **Logging** is pino-shaped JSON in a container and prose at a TTY, switchable
  with `HEARTH_LOG_FORMAT` / `HEARTH_LOG_LEVEL`.
- **Docker:** `docker compose up --build` brings up a seed, two miners and the web
  layer. A three-node isolated testnet is `docker compose -f docker-compose.testnet.yml up`.

### Operational facts you will care about, stated bluntly

- **There is no RPC authentication and no rate limiting** beyond a 108,192-byte
  request body cap, and CORS is `*` on every response (`node/src/rpc.js:19-25`).
  **Do not expose a node to the internet.** Bind it to loopback and put it behind
  your own proxy. **The repository no longer ships an nginx config** — `web/nginx.conf`
  was deleted with `web/` in `48bc28a` — so the proxy is entirely yours to provide.
- **The whole chain state is held in memory.** `store`, the state map and the
  indexes are all JavaScript `Map`s (`node/src/chain.js:31-40`). Memory grows with
  chain length and there is no pruning.
- **Persistence is an append-only NDJSON file**, never compacted, and it includes
  orphaned blocks (`node/src/chain.js:407`, `:360`). Disk grows monotonically.
- **Startup replays and re-validates every persisted block**, and it does so
  silently — a data directory containing an invalid block loads a shorter chain
  without saying why (`node/src/chain.js:48-51`). If your node comes up at an
  unexpected height, that is the reason.
- **No snapshot sync, no fast sync, no state pruning.** Initial sync is a full
  replay from genesis. This is explicitly out of scope for v1
  ([`evm-spec.md`](evm-spec.md) §9).

None of this is a problem at the scale a new chain runs at, and all of it is a
problem later. It is listed here so that nobody discovers it during an incident.

---

## 3. Archive requirements

**Every node is an archive node today**, because nothing prunes. There is no
pruned mode to accidentally deploy.

What that means concretely:

- `eth_getBalance`, `eth_getStorageAt`, `eth_getCode` and `eth_call` at a
  historical block will work at any depth, once implemented, because every
  historical block is retained.
- You do **not** need to run a special archive build, pass an archive flag, or
  negotiate access to a hosted archive node.
- The cost is the memory and disk profile in §2. Budget for a full replay on
  restart and for disk that only grows.

For deposit crediting you do not need archive access at all: the pattern in §5
walks blocks forward and never queries historical state.

---

## 4. Confirmations, and the reasoning behind the number

### The recommendation

| Deposit size | Confirmations | Wall clock |
| --- | ---: | ---: |
| Small | **60** | ~15 min |
| Large | **240** | ~1 hour |
| Any size, at launch | **treat EMBER as low-assurance regardless of depth** | — |

### Why, and why the last row matters more than the first two

**Fork choice is heaviest-cumulative-work, with no depth limit.**
`Chain._ingest` switches to any branch with strictly greater cumulative work
(`node/src/chain.js:361-368`), and there is **no maximum reorg depth rule**, no
checkpointing, no finality gadget and no "irreversible block" concept anywhere in
the codebase. A 500-block reorg is not rejected by the protocol; it is simply
expensive. Your accounting must be able to unwind a credited deposit, and you
should subscribe to reorg events rather than assuming depth implies safety.

**Natural reorgs are shallow.** 15-second blocks over a gossip network produce
occasional 1–2 block orphans. Difficulty retargets every block on a 60-block
LWMA with each solve time clamped to `[1, 90]` seconds
(`node/src/chain.js:212-235`), so the chain absorbs hashrate changes in about a
minute and does not oscillate. 60 confirmations is roughly 60× the natural orphan
depth, which is the same margin exchanges apply on other 15-second chains.

**60 is what we publish and what we credit at.** Stating that explicitly because
the two used to differ: this document recommended 60 while the estate's own
payment rail credited EMBER deposits at a shallower depth. It now credits at 60
(`repos/forge-pay/services/pay/src/chains.ts:35`). If you are told a different
number by anyone, this table is the one to believe.

**Adversarial reorgs are the real risk, and confirmations do not fix them.** The
cost of rewriting *N* blocks is the cost of out-hashing the network for *N* × 15
seconds. On a launched chain with meaningful hashrate that is prohibitive. On a
new chain with little hashrate it is the price of some cloud CPUs — and Homefire
is deliberately *CPU-friendly*, which is excellent for fair distribution and
means an attacker does not need specialised hardware either. Doubling your
confirmation count doubles an attack cost that may have started near zero.

The correct controls at launch are therefore **economic, not depth-based**:

- Cap per-user and per-day EMBER deposit volume until network hashrate is
  established.
- Monitor the network hashrate estimate exposed by the node and alert on sudden
  changes.
- Alert on any reorg deeper than ~5 blocks and halt crediting automatically.
- Require a manual review threshold above which deposits are held.

We would rather tell you this now than have you discover it. **If your risk model
needs a chain with economic finality, EMBER is not ready and you should wait for
hashrate data.**

### Coinbase maturity

If you ever mine EMBER yourself, block rewards are unspendable until they are
`COINBASE_MATURITY` blocks deep — **10 in this tree, intended to be ~100 in
production** (`node/src/params.js:95`). This does not affect ordinary deposits.

---

## 5. Deposits

### 5.1 Pattern — the one you already have

Assign each user a unique `0x` address. Then, per block:

```
head    = eth_blockNumber
target  = head - CONFIRMATIONS
for n in (lastProcessed+1 .. target):
    block = eth_getBlockByNumber(hex(n), true)      # true = full transactions
    if block.parentHash != hashOf(n-1):  → REORG, unwind and rescan
    for tx in block.transactions:
        if lower(tx.to) in depositAddresses and tx.value != "0x0":
            receipt = eth_getTransactionReceipt(tx.hash)
            if receipt.status == "0x1":  credit(tx.to, BigInt(tx.value))   # wei, 18 dp
    lastProcessed = n
```

Notes that matter:

- **Always check the receipt `status`.** A transaction can be included and still
  have failed. A failed transaction consumes gas but moves no value.
- **`tx.value` is wei.** Divide by `1e18` for display only; store the integer.
- **Track `parentHash` continuity.** This is your reorg detector, and given §4 it
  is not optional. On a mismatch, walk back until hashes agree, void the affected
  credits, and rescan forward.
- **Do not use `eth_getBalance` polling to detect deposits.** It cannot
  distinguish two deposits in the same block, gives you no transaction hash for
  support tickets, and silently misses value that arrives and leaves.

### 5.2 Value sent by a contract

`SELFDESTRUCT` and internal `CALL`s move value without producing a top-level
transaction with your address in `to`. If you credit only top-level transfers,
those deposits are invisible and a user will open a ticket.

The standard mitigations, in order of cost:

1. **Document that only top-level transfers are credited** (most exchanges do
   this) and reject the ticket.
2. Reconcile with `eth_getBalance` at the confirmed height and flag any address
   whose balance exceeds the sum of credited top-level transfers.
3. Wait for `debug_traceTransaction` / `trace_block`. **Neither is in the v1 RPC
   surface.** An opcode-level tracer is being built alongside the interpreter
   (`hearth trace <txhash>`, [`evm-spec.md`](evm-spec.md) §8), but it is a CLI
   tool, not an RPC method, and no timeline is promised.

If option 3 is a hard requirement for you, tell us now — the tracer exists
internally and exposing it over RPC is a small change, but it is not currently
planned for v1.

### 5.3 Worked deposit example

A user sends 1 EMBER to their deposit address. The transaction below is the one
signed in §6.2 — same hash, same `v`/`r`/`s` — so the two examples are one
end-to-end story you can verify against this repository's own code.

**Request**

```json
{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x1e240", true]}
```

**Response** (shape per the Ethereum JSON-RPC specification; values illustrative)

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "number": "0x1e240",
    "hash": "0x6f1b...c2a9",
    "parentHash": "0x0b3e...77d1",
    "timestamp": "0x68a7c3f0",
    "gasLimit": "0x1c9c380",
    "gasUsed": "0x5208",
    "miner": "0x4f2C1a9E0b7D6a5c3E8f10B2d4A6c8E0f1B3d5A7",
    "stateRoot": "0x9c4d...11ff",
    "transactionsRoot": "0x77aa...5e02",
    "receiptsRoot": "0x31cd...b840",
    "logsBloom": "0x0000…0000",
    "transactions": [
      {
        "hash": "0x9ebfaea47755cf9958a93aca6d3f6f3e6b4450ef2514570599832e7574d9b917",
        "blockNumber": "0x1e240",
        "transactionIndex": "0x0",
        "from": "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F",
        "to":   "0x3535353535353535353535353535353535353535",
        "value": "0xde0b6b3a7640000",
        "gas": "0x5208",
        "gasPrice": "0x4a817c800",
        "nonce": "0x9",
        "input": "0x",
        "v": "0x3a0a",
        "r": "0x450f25cb83e2bf822e5dd3820097d94572884447391aa8fbfb8ae16cb7fe4f8e",
        "s": "0x2432db8f32ed657806ed6890a99e961b0d48db2bc97d998e673571cc84774062"
      }
    ]
  }
}
```

`"value": "0xde0b6b3a7640000"` is 1,000,000,000,000,000,000 wei = **1 EMBER** —
and note the minimal-length encoding: `0xde0b…`, not `0x0de0b…`.
`"v": "0x3a0a"` is 14,858 = `recoveryId(1) + 7411×2 + 35`, which is how you can
tell at a glance that a transaction is EIP-155-bound to chain 7411.

**Then confirm the receipt**

```json
{"jsonrpc":"2.0","id":2,"method":"eth_getTransactionReceipt",
 "params":["0x9ebfaea47755cf9958a93aca6d3f6f3e6b4450ef2514570599832e7574d9b917"]}
```

```json
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "transactionHash": "0x9ebfaea47755cf9958a93aca6d3f6f3e6b4450ef2514570599832e7574d9b917",
    "blockNumber": "0x1e240",
    "blockHash": "0x6f1b...c2a9",
    "transactionIndex": "0x0",
    "from": "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F",
    "to":   "0x3535353535353535353535353535353535353535",
    "cumulativeGasUsed": "0x5208",
    "gasUsed": "0x5208",
    "effectiveGasPrice": "0x4a817c800",
    "contractAddress": null,
    "logs": [],
    "logsBloom": "0x0000…0000",
    "status": "0x1",
    "type": "0x0"
  }
}
```

Credit only on `"status": "0x1"` and only once the block is `CONFIRMATIONS` deep.

**Hex encoding is strict.** Quantities are minimal-length: `0x0`, never `0x00`,
never `0x0000`. Data (hashes, addresses, bytecode) is fixed-width and zero-padded.
This is the Ethereum convention and our RPC is held to it, because every client
library is strict about it.

---

## 6. Withdrawals

### 6.1 Gas and fees

| | |
| --- | --- |
| Model | legacy `gasPrice` only. No EIP-1559, no `maxFeePerGas`, no `maxPriorityFeePerGas` |
| Fee | `gasUsed × gasPrice`, paid **to the block's coinbase**. **No burn** |
| Plain transfer | 21,000 gas |
| Contract creation | 21,000 + 32,000 + EIP-3860 initcode word cost |
| Calldata | 16 gas per non-zero byte, 4 per zero byte |
| Block gas limit | 30,000,000 |
| `BASEFEE` opcode | pushes **zero** (present for Shanghai compatibility only) |
| Price discovery | `eth_gasPrice` |

Validity requires the sender's balance to cover `value + gasLimit × gasPrice`,
the nonce to match exactly, and `gasLimit ≤` remaining block gas.

A plain 21,000-gas transfer at 20 gwei costs `4.2 × 10^14` wei =
**0.00042 EMBER**.

**Wallets that only speak EIP-1559 fall back to legacy pricing without
complaint**, so this is not an integration problem in practice — but if your
signer *requires* type-2 transactions, it will need a legacy path.

### 6.2 Signing — worked, and reproducible

Signing hash:

```
keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data, 7411, 0, 0]))
```

Broadcast payload:

```
rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
where v = recoveryId + 7411*2 + 35   →  v ∈ {14857, 14858}
```

Every scalar (`nonce`, `gasPrice`, `gasLimit`, `value`, `v`, `r`, `s`) must be
**minimal-length with no leading zero bytes**. Empty is the canonical encoding of
zero; `0x00` is not, and will be rejected. This is a yellow-paper requirement and
our decoder enforces it, because two encodings of the same number hash
differently and that is a chain split.

Concrete example — 1 EMBER, nonce 9, 20 gwei, 21,000 gas, from the publicly known
test key `0x4646…46`:

```
from     0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F
to       0x3535353535353535353535353535353535353535
value    1000000000000000000        (1 EMBER)
sighash  0xccb6cb681f81750ce463cc38841f9d6707d075d4b8bb214cfc56c39b7252744c
v        14858  (0x3a0a)
r        0x450f25cb83e2bf822e5dd3820097d94572884447391aa8fbfb8ae16cb7fe4f8e
s        0x2432db8f32ed657806ed6890a99e961b0d48db2bc97d998e673571cc84774062
txhash   0x9ebfaea47755cf9958a93aca6d3f6f3e6b4450ef2514570599832e7574d9b917

raw      0xf86e098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080823a0aa0450f25cb83e2bf822e5dd3820097d94572884447391aa8fbfb8ae16cb7fe4f8ea02432db8f32ed657806ed6890a99e961b0d48db2bc97d998e673571cc84774062
```

**Reproduce it exactly.** Save as `node/sign7411.js` and run `node sign7411.js`:

```js
const secp = require('./src/crypto/secp256k1');
const { keccak256 } = require('./src/crypto/keccak');
const rlp = require('./src/crypto/rlp');

const CHAIN_ID = 7411n;
const be = v => { if (v === 0n) return Buffer.alloc(0);
                  let h = v.toString(16); if (h.length % 2) h = '0' + h;
                  return Buffer.from(h, 'hex'); };

const priv     = Buffer.from('46'.repeat(32), 'hex');   // publicly known test key
const nonce    = 9n;
const gasPrice = 20_000_000_000n;                       // 20 gwei
const gasLimit = 21_000n;
const to       = Buffer.from('35'.repeat(20), 'hex');
const value    = 1_000_000_000_000_000_000n;            // 1 EMBER, 18 decimals
const data     = Buffer.alloc(0);

const fields  = [be(nonce), be(gasPrice), be(gasLimit), to, be(value), data];
const sighash = Buffer.from(keccak256(
  rlp.encode([...fields, be(CHAIN_ID), Buffer.alloc(0), Buffer.alloc(0)])));
const sig = secp.sign(sighash, priv);
const v   = BigInt(sig.recoveryId) + CHAIN_ID * 2n + 35n;
const raw = Buffer.from(rlp.encode([...fields, be(v), be(sig.r), be(sig.s)]));

console.log('sighash 0x' + sighash.toString('hex'));
console.log('v       ' + v);
console.log('raw     0x' + raw.toString('hex'));
console.log('txhash  0x' + Buffer.from(keccak256(raw)).toString('hex'));
```

Nonces are RFC 6979 deterministic and `s` is normalised to the lower half of the
group order (EIP-2), so this is byte-reproducible — if your signer produces the
same `raw` for these inputs, it is correct.

In practice you will use your existing library. `ethers.Wallet.signTransaction`
with `{ type: 0, chainId: 7411 }` produces the identical payload.

### 6.3 Broadcast and confirm

```json
{"jsonrpc":"2.0","id":3,"method":"eth_sendRawTransaction","params":["0xf86e0985…4774062"]}
```

```json
{"jsonrpc":"2.0","id":3,
 "result":"0x9ebfaea47755cf9958a93aca6d3f6f3e6b4450ef2514570599832e7574d9b917"}
```

The result is `keccak256(raw)` and you can compute it before you broadcast, which
means you can persist the hash **before** the network call and make retries
idempotent. Do that: a broadcast that times out has very often succeeded.

On failure the node returns a standard JSON-RPC error object:

```json
{"jsonrpc":"2.0","id":3,
 "error":{"code":-32000,"message":"nonce too low"}}
```

Then poll `eth_getTransactionReceipt` until non-null, check `status`, and apply
the same confirmation depth as §4. A `null` receipt means "not mined yet" — it
does not mean "rejected".

### 6.4 Nonce management

One sequential nonce per hot wallet. `eth_getTransactionCount(addr, "pending")`
includes mempool transactions; `"latest"` does not. Use `"pending"` to build, but
keep your own counter as the source of truth — a mempool-derived nonce after a
reorg will hand you a duplicate.

**Pre-EIP-155 transactions are accepted**, deliberately. This is not laziness: a
tier of ecosystem infrastructure — Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11` among it — is deployed by keyless
presigned transactions that carry no chain id, and rejecting them would make
those addresses permanently unreachable here. The consequence for you is that an
unprotected transaction is replayable across chains that accept them. **Sign
every withdrawal with EIP-155**; every modern signer does by default.

---

## 7. RPC surface

**v1 (committed):** `eth_chainId`, `eth_blockNumber`, `eth_getBalance`,
`eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt`, `eth_call`,
`eth_estimateGas`, `eth_gasPrice`, `eth_sendRawTransaction`,
`eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`,
`eth_getBlockByHash`, `eth_getLogs`, `net_version`, `web3_clientVersion`.

That set is sufficient for a complete deposit/withdrawal integration.

**v2 (not committed to a date):** `eth_newFilter` / `eth_getFilterChanges`,
`eth_feeHistory`, `eth_subscribe` (WebSocket).

**Not planned for v1:** `debug_traceTransaction`, `trace_block`, `trace_filter`,
`txpool_*`, `eth_getProof`. If you need any of these, say so — several are
straightforward and none are currently scheduled.

The existing REST API (`/info`, `/supply`, `/blocks`, `/block/:id`, `/tx/:txid`,
`/mempool`, and an SSE `/events` stream) is served alongside and stays for the
explorer. It is not the integration surface and its shapes belong to the UTXO
chain.

---

## 8. Testnet and faucet

**Neither exists for the account-model chain.** What exists today:

- An isolated UTXO testnet: `docker compose -f docker-compose.testnet.yml up`
  brings up a seed and two miners on `HEARTH_NETWORK=hearth-testnet`
  ([`../TESTNET.md`](../TESTNET.md)). It is the old chain and the old address
  format.
- Network isolation is enforced at the P2P handshake and in the transaction
  signature binding, so testnets cannot leak into mainnet.

**Before any exchange integration we owe you:** a public account-model testnet
with a stable RPC endpoint, a faucet, and an explorer that renders `0x`
addresses. **The testnet chain id is decided — `7412`** ([`evm-spec.md`](evm-spec.md)
§1), and it is deliberately distinct from mainnet's 7411 because a shared id
would make every testnet transaction replayable on mainnet. What is missing from
that list is deployment, not code: the explorer, the faucet and the
Etherscan-compatible `/api` all run against a local node today and none of them
is hosted anywhere you could reach. Tracked in
[`listing-checklist.md`](listing-checklist.md).

---

## 9. What will cost you time, honestly

The near-zero-cost claim at the top is about the *protocol surface*, and it
holds. These are the things that are not zero:

1. **There is no chain you can reach.** The `eth_*` surface is built, tested and
   mounted on 8545 by `node/src/evmnode.js`, and a chain that produces and
   reorgs blocks is one command away on your own machine (`hearthd --evm --mine`)
   or three under `docker-compose.testnet.yml`. What does not exist is a
   published endpoint, a persistent genesis or a mainnet. This is the only item
   that blocks you outright, and it is a deployment, not a build.
2. **Reorgs have no depth bound** (§4). If your ledger assumes a maximum reorg
   depth per chain, EMBER needs the general case.
3. **Low hashrate at launch** (§4). This is a risk-desk conversation, not an
   engineering one, and it is the honest reason to delay a listing rather than
   the integration.
4. **No `debug_*` / `trace_*`** (§5.2). Contract-originated deposits are invisible
   to a top-level scan.
5. **No WebSocket subscriptions in v1** (§7). Poll `eth_blockNumber`; at 15-second
   blocks that is cheap.
6. **No pruning, full replay on restart** (§2). Plan node restarts.
7. **No SLIP-44 coin type registered**, so hardware wallets will not derive EMBER
   accounts under a Hearth-specific path. Derivation under coin type 60
   (Ethereum) works, because the curve and address derivation are identical — but
   that is a workaround, not a registration.

---

## 10. Contacts

- **Security disclosure:** [`../SECURITY.md`](../SECURITY.md)
- **Repository:** <https://github.com/cloudsforge-online/hearth>
- **Specification:** [`evm-spec.md`](evm-spec.md) — authoritative and current
- **Repository inventory, cited to `path:line`:** [`../MAP.md`](../MAP.md)
- **Supply and emission:** [`tokenomics.md`](tokenomics.md)

If something in this document would block your integration, raise it as a GitHub
issue. It is much cheaper to change the spec now than after mainnet.
