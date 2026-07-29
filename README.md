<div align="center">
  <img src="web/assets/logo.svg" width="104" alt="Hearth logo"/>
  <h1>Hearth — Money Mined at Home</h1>
  <b>A people-mined, ASIC-resistant proof-of-work chain that speaks Ethereum.</b>
  <br/>
  <i>Mine EMBER on the computer you already own — then deploy to it with the tools you already have.</i>
  <br/><br/>

  <a href="https://github.com/cloudsforge-online/hearth/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/cloudsforge-online/hearth/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="vmtests" src="https://img.shields.io/badge/VMTests-609%2F609-brightgreen">
  <img alt="statetests" src="https://img.shields.io/badge/GeneralStateTests-20%2C077%2F20%2C077-brightgreen">
  <img alt="dex" src="https://img.shields.io/badge/Uniswap%20V2-swap%20at%20112%2C456%20gas-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="pow" src="https://img.shields.io/badge/PoW-Homefire%20(CPU%2C%20memory--hard)-ff4d00">

  <br/><br/>
  🌐 <b><a href="https://hearth.cloudsforge.online/">hearth.cloudsforge.online</a></b>
  <br/>
  <sub>Hearth is the <b>Mine</b> in <a href="https://cloudsforge.online/">CloudsForge</a>'s one crypto world — mine it, trade it, mint it, spend it, play in it.</sub>
  <br/><br/>
  <code>proof of work · CPU mining · ASIC-resistant · fair launch · EVM · chain id 7411</code>
</div>

---

## Status, before anything else

**Hearth is an account-model, EVM-executing proof-of-work chain under
construction. There is no mainnet, no testnet, no public endpoint and no EMBER of
any monetary value.**

The EVM is built and gated on Ethereum's published reference vectors. **Consensus
on the account model is not** — no block has ever been produced on it. The chain
that has produced blocks is the original UTXO ledger, and it is being retired.

| | |
| --- | --- |
| **Built and vector-gated** | keccak/RLP/uint256/secp256k1 · Merkle Patricia Trie + StateDB · the interpreter (**609/609 VMTests**) · transactions, receipts, bloom (**188/188 TransactionTests**) · the state transition (**20,077/20,077 GeneralStateTests**) · all nine precompiles including bn128 and blake2f · the `eth_*` JSON-RPC surface · an EVM-aware explorer · the `hearth` CLI with an opcode tracer · a browser wallet on secp256k1 |
| **Proved end to end** | **Uniswap V2 runs on our own EVM** — `node/test/dex.js`, 167/167, a real swap at **112,456 gas** |
| **Built and running locally** | Consensus on the account model. `hearthd --evm --mine` produces and validates blocks and serves `eth_*` on 8545; two real nodes partition and reorg in `node/test/evm-p2p-fork.js`; `docker-compose.testnet.yml` runs three on chain id 7412 |
| **Not published** | No endpoint anyone else can reach. Every port binds `127.0.0.1`, no genesis outlives a `docker compose down -v`, and there is no mainnet |
| **Measured, and open** | The proof of work is 64 KiB and cannot be raised: a 2 GiB pad measures **185.7 s per evaluation** and a validator pays one per block received ([`docs/pow-parameters.md`](docs/pow-parameters.md)). Making it meaningfully memory-hard needs an amortised dataset, not a constant |

[`MAP.md`](MAP.md) is the verified inventory — every claim in it cites `path:line`
or a command that was run. **Where this README and `MAP.md` disagree, believe
`MAP.md`.**

---

## Why Hearth exists

Proof-of-work was supposed to be *one CPU, one vote*. Instead Bitcoin became a
game for warehouse farms and a few pools, and almost everything since became a
speculative chip you hoard rather than money you spend.

And the CPU-mineable, fair-launch corner of the space is full of coins with no
contracts, no tooling, no wallet support and no way for anyone to build anything.
Fairness that nobody can use is a moral position, not a network.

| Big crypto problem | What Hearth does |
| --- | --- |
| Mining centralized into ASIC farms | **Homefire PoW**: memory-hard and CPU-friendly, so a farm earns little more per dollar than your laptop. A winning proof must be signed by the key its coinbase pays, so work handed to you cannot be redirected — see [docs/mining.md](docs/mining.md) for what that does and does not buy |
| Development captured by VCs / premines | **Fair launch** + an on-chain **Commons treasury** (10% of each block). Genesis mints zero spendable coins, checkable in about thirty seconds |
| The "fee cliff" (security dies when rewards end) | **Perpetual tail emission** funds security forever |
| A chain nobody can build on is a chain nobody uses | **Hearth speaks Ethereum.** `0x…` addresses, secp256k1, 18 decimals, chain id 7411, Shanghai semantics, standard `eth_*` JSON-RPC — so MetaMask, ethers, viem, Hardhat and Foundry work without knowing this chain is bespoke |
| Too hard for normal humans | A **web wallet** and a **browser miner** that need nothing installed, and a reference node that is a full node, a wallet and a miner in one process |

Full argument: **[WHITEPAPER.md](WHITEPAPER.md)**. The specification:
**[docs/evm-spec.md](docs/evm-spec.md)**.

---

## The coin

- **Network:** Hearth · **Coin:** Ember · **Ticker:** `EMBER` · **Chain ID:** `7411` (testnet `7412`)
- **Decimals:** **18** — specified; `node/src/params.js:6` still defines 1e8 and has not moved yet
- **Block time:** 15 seconds · **PoW:** Homefire (memory-hard, CPU-friendly, ASIC-resistant)
- **Emission:** a deterministic integer schedule — 6 EMBER at genesis, 2-year half-life, perpetual 0.3 EMBER tail; 10% to the Commons
- **Supply:** uncapped, disinflationary. **No hard cap and no fee burn** — gas is paid to the coinbase in v1

```
 yr      reward   issued/yr      supply     commons    gross%
  1        4.50  11,045,161  11,045,161   1,104,516   100.00
  2        3.00   7,889,401  18,934,562   1,893,456    41.67
  5        1.13   2,761,290  31,163,132   3,116,313     8.86
 10        0.30     631,152  36,827,722   3,682,772     1.71
 30        0.30     631,152  49,450,762   4,945,076     1.28
```

Those are the numbers the **consensus schedule** produces
(`node/src/params.js:140-151`); reproduce them with the command in
[docs/tokenomics.md](docs/tokenomics.md) §3. `docs/coinnomics.md` carries a
*different* table from a smooth exponential model with an assumed fee burn — it is
the historical design rationale and its numbers are not the chain's.

---

## This is a working application, not a slide deck

Everything below **runs**, and every number was produced by running it:

- ✅ **An EVM we wrote ourselves** (`node/src/{crypto,state,evm,chain}/`) — Keccak-256,
  RLP, secp256k1 recovery, `uint256`, the Merkle Patricia Trie, StateDB, the
  interpreter, the Shanghai gas schedule and all nine precompiles. No
  `@ethereumjs/*`, no `ethers`, no `web3`, no runtime dependency of any kind
- ✅ **Gated on Ethereum's own vectors** — 609/609 VMTests, 20,077/20,077
  GeneralStateTests, 188/188 TransactionTests, plus RLP and Trie tests. **No
  component is done until its vectors pass**
- ✅ **Uniswap V2 runs on it** — `node/test/dex.js` deploys the factory, router,
  pair and WEMBER, adds liquidity, swaps, swaps back, exercises `permit` and
  removes liquidity. 167/167, swap at 112,456 gas against mainnet's ~150,000
- ✅ **the `eth_*` JSON-RPC surface** (`node/src/jsonrpc/`) — 41 methods, 422
  checks against a fake chain and 170 against a real one over HTTP; strict
  QUANTITY/DATA encoding, batches, notifications, revert payloads as code 3.
  Mounted on 8545 by `node/src/evmnode.js`
- ✅ **`hearth`, the terminal tool** — `trace` (an opcode-level debugger with gas,
  stack, memory and storage deltas per step), `watch`, `wallet`, `call`, `send`,
  `deploy`, `devnet`. 310 checks
- ✅ **an EVM-aware block explorer** (`web/`) — decoded logs, revert reasons,
  EOA-vs-contract with disassembly, ERC-20s, `eth_getLogs` search. Zero
  dependencies, no build step, and it **renders "no node answered" rather than
  inventing data**
- ✅ **a non-custodial browser wallet on secp256k1** — its crypto is a port of the
  node's, and CI runs both over the same random inputs and compares them. That
  cross-check found a real gas bug in the node on its first run
- ✅ **a developer kit** (`tools/`) — a faucet, working Hardhat and Foundry
  templates, and an RPC probe that serves the real method surface over a fake chain
- ✅ **contract verification** (`tools/verify/`, 116/116) — including the API
  `forge verify-contract` speaks — and 🟡 an **Etherscan-compatible `/api`**
  (`tools/explorer-api/`: `account`, `contract`, `stats`, `transaction`, `logs`,
  `proxy` over a real address index) whose **test suite currently fails**. Zero
  dependencies; no chain to serve either of them yet
- ✅ **property fuzzing** (`node/test/fuzz/`) — random bytes into `uint256`, the
  trie, RLP, transactions and the interpreter. It found two real defects in merged
  code and **reports rather than patches**; both are listed in [SECURITY.md](SECURITY.md)
- ✅ **a real proof-of-work network** (the UTXO chain) — most-work fork choice with
  reorg over real sockets, P2P gossip, LWMA difficulty, disk persistence
- ✅ **browser mining** — a Web Worker pool running real Homefire, checked
  digest-for-digest against the node in CI
- 🟡 a **Rust crate** (`rust/hearthd`) — a self-check and a PoW benchmark.
  **Not a node and not consensus-compatible**, and it has no EVM at all — see
  [docs/why-two-implementations.md](docs/why-two-implementations.md)

> **Two honest caveats about that list.** None of it has been driven by a block —
> consensus on the account model is the missing phase. And `web/pay-demo.html` is
> a merchant-button *mockup* that simulates settlement on a timer; there is no
> payment SDK.

**`npm test` passes from a clean clone** — 27 suites, no install, no corpus and no
network. Verified by cloning this repository into an empty directory and running
it. Fetching the reference corpus completes two of them: `blake2f` goes 43/43 →
46/46 and `bn128`'s one skipped case runs.

**The caveat that used to matter most is closed.**
[`docs/robustness-review.md`](docs/robustness-review.md) measured `StateDB`
re-rooting both tries on *every single mutation*: a single 30M-gas transaction
cost **443 MB of retained heap and 65 seconds of CPU, against a 15-second block
time**. Hashing is deferred to `root()` now and the same transaction measures
**5.2 s and 9.2 MiB**, gated by `node/test/bench/block-execution.js`.

The caveat that matters most now is the proof of work: every block ever produced
used a 64 KiB pad, the 2 GiB the documents promised measures at **185.7 s per
evaluation**, and closing that gap is a redesign rather than a constant
([`docs/pow-parameters.md`](docs/pow-parameters.md)).

---

## Try it now

**1 — Run the test suites** (needs Node 18+, no install, no network):

```bash
cd node
node test/interpreter.js      # 194 checks
node test/statetransition.js  # 133 checks
node test/jsonrpc.js          # 422 checks
node test/cli.js              # 310 checks
node test/fuzz/run.js         # 82,481 property-fuzz checks
```

**2 — Run the real conformance gate** (fetches ~350 MB of Ethereum's corpus):

```bash
cd node && ./scripts/fetch-vectors.sh
node test/conformance/runner.js --impl=test/interpreter.js \
     --dir=test/conformance/vectors/VMTests --no-gas          # 609/609
node test/conformance/runner.js --impl=test/statetransition.js \
     --suite=GeneralStateTests --dir=test/conformance/vectors  # 20,077/20,077
```

**3 — Watch Uniswap V2 execute on our EVM:**

```bash
pnpm --dir contracts install && pnpm --dir contracts compile
cd node && node test/dex.js                                    # 167/167
```

**4 — Point your tooling at something** — there is no endpoint, so serve the real
RPC layer over a fake chain:

```bash
node tools/rpc-probe/stub.js --port 8745
cast chain-id --rpc-url http://127.0.0.1:8745                   # 7411
```

Full walkthrough, with every step marked **[RUN]**, **[PROBE]** or **[WAITING]**:
**[docs/quickstart.md](docs/quickstart.md)**.

**5 — Boot the UTXO network** (the chain that actually produces blocks today):

```bash
docker compose up --build      # seed + 2 miners + web on :8080
```

No Docker? `./scripts/run-local-network.sh`. Details:
**[docs/network.md](docs/network.md)**.

---

## Repository layout

```
hearth/
├── README.md · WHITEPAPER.md · MAP.md   the pitch, the argument, and the verified inventory
├── docs/                                evm-spec (authoritative) · decisions · quickstart ·
│                                        network-config · tokenomics · exchange-integration ·
│                                        listing-checklist · mining · records · architecture ·
│                                        robustness-review (measured) · testing (coverage)
├── node/                                the reference node — AND the EVM implementation
│   ├── src/crypto  src/state  src/evm  src/chain  src/jsonrpc   the account-model chain
│   ├── src/*.js                                                 the UTXO chain, being retired
│   ├── src/cli/  bin/hearth.js                                  the terminal tool + tracer
│   └── test/  test/conformance/  test/fuzz/                     27 suites + vectors + fuzzing
├── contracts/                           WEMBER, a Uniswap V2 port, Multicall3 (compiled, undeployed)
├── tools/                               faucet · hardhat · foundry · rpc-probe · metamask.md ·
│                                        explorer-api (Etherscan-compatible /api) · verify
├── web/                                 EVM explorer + secp256k1 wallet + browser miner
├── site/                                the marketing site (React)
├── rust/hearthd/                        a self-check and a benchmark — not a node
├── proto/                               teaching scripts (the emission model is NOT consensus)
└── .github/workflows/ci.yml             six jobs; `npm test` is the single source of truth
```

## Contributing

Hearth is a commons. See **[CONTRIBUTING.md](CONTRIBUTING.md)**. Highest-leverage
areas right now: **publishing the testnet** (it runs on loopback and nothing
routes it), **an amortised proof of work** so the memory-hardness argument is
more than a construction ([docs/pow-parameters.md](docs/pow-parameters.md)), and
closing the items in **[docs/listing-checklist.md](docs/listing-checklist.md)**
§7. Contract verification is **already built** (`tools/verify/`, 116/116) and the
Etherscan-compatible `/api` shim is built and green
(`tools/explorer-api/`) — both are waiting on a chain to serve.

## Security

Please report vulnerabilities privately — see **[SECURITY.md](SECURITY.md)**.
There is deliberately no `security@` mailbox yet, and that is tracked rather than
papered over.

## License

[MIT](LICENSE) — money should be free to fork.

---

<sub><b>Keywords:</b> Hearth, EMBER, cryptocurrency, proof of work, CPU mining, ASIC resistant,
memory-hard proof of work, EVM chain, EVM implementation, Ethereum JSON-RPC, chain id 7411,
Solidity, Uniswap V2, decentralized digital cash, mine crypto at home, no premine, fair launch,
crypto wallet, block explorer, blockchain node, tail emission.</sub>

## How this was built

Parts of this repository were produced with AI assistance, and it seems worth saying so plainly
rather than leaving it to be inferred.

- **Code** — written with Claude Opus 5 and Claude Opus 4.8 (Anthropic), reviewed and directed by
  a human, and gated on the same tests and CI as anything else here.
- **Artwork** — brand marks, icons and in-game art generated with OpenAI's image models
  (GPT Image 1, 1.5 and 2), driven by the manifest pipeline in `asset-forge`.

The models were used under paid API access and the output is the project's to use. Nothing here is
claimed to be hand-written that is not, and nothing is claimed to work that has not been tested.
The conformance-vector discipline exists partly for this reason: an implementation is judged by
whether it passes the reference vectors, not by who or what wrote it.
