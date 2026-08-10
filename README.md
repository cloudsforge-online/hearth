<div align="center">
  <img src="branding/logo.svg" width="104" alt="Hearth logo"/>
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
  🌐 <b><a href="https://explorer.cloudsforge.online/">explorer.cloudsforge.online</a></b> · <code>https://rpc.cloudsforge.online</code> · chain id <code>7411</code>
  <br/>
  🧪 testnet <b>(paused — reads answer, no new blocks)</b> · <b><a href="https://explorer-testnet.cloudsforge.online/">explorer-testnet.cloudsforge.online</a></b> · <code>https://rpc-testnet.cloudsforge.online</code> · chain id <code>7412</code>
  <br/>
  <sub>Hearth is the <b>Mine</b> in <a href="https://cloudsforge.online/">CloudsForge</a>'s one crypto world — mine it, trade it, mint it, spend it, play in it.</sub>
  <br/><br/>
  <code>proof of work · CPU mining · ASIC-resistant · fair launch · EVM · chain id 7411</code>
</div>

---

## Status, before anything else

**Hearth is an account-model, EVM-executing proof-of-work chain, and mainnet is
live. Chain id `7411`, Ethereum JSON-RPC at `https://rpc.cloudsforge.online`,
height `10,987` and climbing.** Measured 2026-08-10 17:56 UTC from outside this
network, with no credentials: `eth_chainId` → `0x1cf3`, `eth_blockNumber` →
`0x2aeb`, `web3_clientVersion` → `Hearth/v0.2.0/linux-x64/node22.23.1`. A `GET`
answers `405` with `allow: POST,OPTIONS`, because this is a JSON-RPC endpoint and
not a page. Block 1 was mined **2026-08-04 19:12:21 UTC** and the chain has not
stopped since — just under six days at that measurement.

**What is not there yet, said in the same breath, because a chain id without this
paragraph reads as a promise.** There is no EMBER of any monetary value: no
market, no listed price, no liquidity. There is no payout path of any kind in
this repository. Nobody outside the project has used any of it. And the public
testnet is deliberately **stopped** (below).

**The chain is nearly empty, and "nearly" is the honest word rather than
"entirely".** Walking every block from 1 to 10,987 on 2026-08-10 counts **62
transactions in 52 blocks** — a mean of one transaction per 177 blocks. They fall
into three groups, and none of them is a stranger using this chain:

- **Blocks 235–251, 2026-08-04.** 18 transactions, of which **nine are successful
  contract creations** — `ForesightMarket` instances belonging to another
  repository in this estate. They are real: `eth_getCode` at
  `0x49408b99deb3afaafd914ed9f0e71a89874b980e` returns 6,007 bytes of runtime
  code, and the creation receipt reports `status: 0x1`. **So "no contract is
  deployed on mainnet" is false**, and this README asserted it until 2026-08-10.
- **Blocks 1,323, 1,506 and 1,518.** Three transactions, days apart.
- **Blocks 10,851–10,967, 2026-08-10 17:19–17:23 UTC.** 41 transactions, roughly
  one per block, **every one a plain value transfer with empty input from a
  single address to a single address** — the signature of an automated sweep
  rather than of anybody using the chain.

What *is* unqualifiedly true is narrower and more important: **no block has ever
been produced at production proof-of-work parameters**, and no third party has
ever transacted here.

**"Live" means reachable and mining, not established, and each measurement below
says something the height alone does not.**

- **Every block this chain has ever had was mined by this project.** There has
  never been an independent miner. This is the fact that does not expire, and it
  is the one to read instead of a difficulty number.
- **One browser tab can move this chain's difficulty by a factor of 32 and then
  stall it for twenty minutes.** That is not a hypothetical: it happened on the
  evening of 2026-08-10, and the chain spent 1,154 s at a standstill afterwards.
  Difficulty is therefore a **live reading that oscillates**, not a property —
  which is why no number for it appears in this README. The account, the
  measurements and the cause are in
  [`MAP.md` §1](MAP.md#1-what-this-is-in-one-paragraph), stated once there and
  nowhere else in this repository.
- **The mean interval from block 1 to the tip is 46.8 s** (measured
  2026-08-10 17:56 UTC), against a 15 s protocol *target*. Dividing height by age
  and concluding the block time is broken is the wrong conclusion; 15 s is a
  design target, not an observed rate, and the observed rate is whatever the one
  or two machines mining at the time happen to supply.
- **It is one home server behind a single Cloudflare Tunnel** — no redundancy, no
  failover, and no backup that has ever been restored.

**The public testnet answers reads, and is not producing blocks.** Chain id
`7412` at `https://rpc-testnet.cloudsforge.online` still serves: measured
2026-08-10 17:56 UTC, `eth_chainId` → `0x1cf4` and `eth_blockNumber` → `0x1e55`
(`7,765`). That height did not move across repeated polls, and the tip's
timestamp is **2026-08-08 18:00:11 UTC** — about 48 hours before the
measurement. **This is stopped on purpose, not broken.** The same home server
runs `bitcoind` and `dogecoind`, both still in initial block download, and
testnet mining competes with them for the same disk and bandwidth; the estate
records that decision in `micro-deploy`'s `docs/releasing.md`. Treat testnet as
paused: reads work, nothing new confirms, and no genesis off mainnet outlives a
`docker compose down -v`.

The public surfaces around it all answered `200` in the same measurement:
[`cloudsforge.online`](https://cloudsforge.online),
[`network.cloudsforge.online`](https://network.cloudsforge.online),
[`explorer.cloudsforge.online`](https://explorer.cloudsforge.online),
[`explorer-testnet.cloudsforge.online`](https://explorer-testnet.cloudsforge.online)
and [`network-testnet.cloudsforge.online/faucet`](https://network-testnet.cloudsforge.online/faucet).
A faucet page that renders is not a faucet that can pay: it drips from the
testnet chain, and that chain is paused.

The EVM is built and gated on Ethereum's published reference vectors, and
consensus on the account model now runs in public rather than only on loopback.
The original UTXO ledger is being retired.

| | |
| --- | --- |
| **Built and vector-gated** | keccak/RLP/uint256/secp256k1 · Merkle Patricia Trie + StateDB · the interpreter (**609/609 VMTests**) · transactions, receipts, bloom (**188/188 TransactionTests**) · the state transition (**20,077/20,077 GeneralStateTests**) · all nine precompiles including bn128 and blake2f · the `eth_*` JSON-RPC surface · an EVM-aware explorer · the `hearth` CLI with an opcode tracer · a browser wallet on secp256k1 |
| **Proved end to end** | **Uniswap V2 runs on our own EVM** — `node/test/dex.js`, 167/167, a real swap at **112,456 gas** |
| **Built and running locally** | Consensus on the account model. `hearthd --evm --mine` produces and validates blocks and serves `eth_*` on 8545; two real nodes partition and reorg in `node/test/evm-p2p-fork.js`; `docker-compose.testnet.yml` runs three on chain id 7412 |
| **Published, and mining** | **Mainnet, chain id 7411**, at `https://rpc.cloudsforge.online` — publicly trusted TLS, JSON-RPC over POST (a GET answers 405), plus an explorer at [`explorer.cloudsforge.online`](https://explorer.cloudsforge.online). Height `10,987` and climbing, measured 2026-08-10 17:56 UTC. The node ports still bind `127.0.0.1`; a Cloudflare Tunnel on one home server is the only thing routing them, so this is one machine with no failover |
| **Published, and paused** | **Testnet, chain id 7412**, at `https://rpc-testnet.cloudsforge.online` — same POST-only surface, same publicly trusted TLS, with an explorer at [`explorer-testnet.cloudsforge.online`](https://explorer-testnet.cloudsforge.online) and a faucet at [`network-testnet.cloudsforge.online/faucet`](https://network-testnet.cloudsforge.online/faucet). **It answers reads and produces no blocks**: height `7,765`, tip timestamp 2026-08-08 18:00:11 UTC, unchanged across polls on 2026-08-10 — stopped on purpose while the host's `bitcoind` and `dogecoind` finish initial block download. P2P is a WebSocket at `wss://p2p-testnet.cloudsforge.online/p2p` — **only the `/p2p` path is routed**, the host root answers 404 |
| **Still not published** | Any contract **of record** — nine `ForesightMarket` instances are live on mainnet from 2026-08-04 and **no file in this repository names one of them**, which is the defect rather than the achievement. Off mainnet no genesis outlives a `docker compose down -v`, so testnet state is not durable and should be treated as disposable |
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
- **Decimals:** **18** — specified; `node/src/params.js` still defines 1e8 and has not moved yet
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
(`node/src/params.js`); reproduce them with the command in
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
- ✅ **an EVM-aware block explorer** — decoded logs, revert reasons,
  EOA-vs-contract with disassembly, ERC-20s, `eth_getLogs` search, and it
  **renders "no node answered" rather than inventing data**. It lived in `web/`
  until 2026-08-04 and is now [`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web)
- ✅ **a non-custodial wallet on secp256k1** — its crypto is a port of the node's,
  and the two are run over the same random inputs and compared. That cross-check
  found a real gas bug in the node on its first run. Now
  [`micro-hearth-wallet-core`](https://github.com/cloudsforge-online/micro-hearth-wallet-core),
  where the comparison is made **in-process against `node/src`** and nothing is
  checked against a fixture the library produced itself
- ✅ **a developer kit** (`tools/`) — a faucet, working Hardhat and Foundry
  templates, and an RPC probe that serves the real method surface over a fake chain
- ✅ **contract verification** (`tools/verify/`, 116/116) — including the API
  `forge verify-contract` speaks — and 🟡 an **Etherscan-compatible `/api`**
  (`tools/explorer-api/`: `account`, `contract`, `stats`, `transaction`, `logs`,
  `proxy` over a real address index) whose **test suite currently fails**. Zero
  dependencies. There is now a chain for both to serve — mainnet 7411 — and
  neither is hosted against it; that is a deployment that has not happened, not a
  chain that does not exist
- ✅ **property fuzzing** (`node/test/fuzz/`) — random bytes into `uint256`, the
  trie, RLP, transactions and the interpreter. It found two real defects in merged
  code and **reports rather than patches**; both are listed in [SECURITY.md](SECURITY.md)
- ✅ **a real proof-of-work network** (the UTXO chain) — most-work fork choice with
  reorg over real sockets, P2P gossip, LWMA difficulty, disk persistence
- ✅ **mining you can run** — `hearth-mine` on the command line and a **desktop
  app** (`app-desktop/`, Tauri) for macOS, Windows and Linux, both over
  `/mining/template` and `/mining/submit`. The browser miner that stood here was
  removed with `web/`: it signed 64-byte signatures where the node requires 65,
  so **every block it ever found was refused**. It lives in
  [`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site)
  now, carrying the fix, and `node/test/browser-pow.js` and
  `node/test/browser-proof.js` compare it against this node
- 🟡 a **Rust crate** (`rust/hearthd`) — a self-check and a PoW benchmark.
  **Not a node and not consensus-compatible**, and it has no EVM at all — see
  [docs/why-two-implementations.md](docs/why-two-implementations.md)

> **Two honest caveats about that list.** It *is* driven by blocks now — mainnet
> has produced `10,987` of them as of 2026-08-10, carrying 62 transactions
> including nine contract deployments — but that is a rounding error of traffic,
> all of it produced by this project, so every path through the EVM is still
> proven by tests rather than by use. And the merchant-button *mockup* that used
> to sit in `web/pay-demo.html` — it simulated settlement on a timer — went with
> that directory; there is still no payment SDK and no payout path.

**`npm test` passes from a clean clone** — **39 suites, 86,451 checks**, no install,
no corpus and no network. Re-measured 2026-08-09 by cloning this repository into an
empty directory and running it; [`docs/testing.md`](docs/testing.md) §1 lists every
suite. Fetching the reference corpus completes two of them: `blake2f` goes 50/50 →
53/53 and `bn128` 81/81 → 86/86, running its one skipped case.

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

**4 — Point your tooling at mainnet:**

```bash
cast chain-id     --rpc-url https://rpc.cloudsforge.online      # 7411
cast block-number --rpc-url https://rpc.cloudsforge.online      # climbing
```

**The public testnet is where you should be if you are deploying anything you
have not deployed before — but it is paused right now**, so a transaction sent to
it will sit in the pool and never confirm:

```bash
cast chain-id     --rpc-url https://rpc-testnet.cloudsforge.online   # 7412
cast block-number --rpc-url https://rpc-testnet.cloudsforge.online   # 7765, and static
```

Reads answer; mining is stopped while the host's Bitcoin and Dogecoin nodes
finish initial block download on the same disk. Until it resumes, run a chain of
your own — `hearthd --evm --mine`, or the three-node `docker-compose.testnet.yml`
— which is faster to iterate against anyway.

Or serve the real RPC layer locally over a fake chain, to check your wiring and
your encodings without mining anything:

```bash
node tools/rpc-probe/stub.js --port 8745
cast chain-id --rpc-url http://127.0.0.1:8745                   # 7411
```

Full walkthrough, with every step marked **[RUN]**, **[PROBE]** or **[WAITING]**:
**[docs/quickstart.md](docs/quickstart.md)**.

**5 — Boot the UTXO network** (the ledger being retired; mainnet 7411 is the
chain producing blocks today, and it is account-model):

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
├── app-desktop/                         the desktop miner (Tauri) — macOS, Windows, Linux
├── rust/hearthd/                        a self-check and a benchmark — not a node
├── proto/                               teaching scripts (the emission model is NOT consensus)
└── .github/workflows/ci.yml             six jobs; `npm test` is the single source of truth
```

## Contributing

Hearth is a commons. See **[CONTRIBUTING.md](CONTRIBUTING.md)**. Highest-leverage
areas right now: **an amortised proof of work** so the memory-hardness argument is
more than a construction ([docs/pow-parameters.md](docs/pow-parameters.md)), and
closing the items in **[docs/listing-checklist.md](docs/listing-checklist.md)**
§7. Contract verification is **already built** (`tools/verify/`, 116/116) and the
Etherscan-compatible `/api` shim is built and green (`tools/explorer-api/`) —
both are waiting on a *deployment*, not on a chain. Mainnet 7411 has been
answering since 2026-08-04; nobody has hosted either service against it.

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

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.

**This paragraph used to name different models, and the correction is itself a fact about the
repository.** It credited Claude Opus 4.8 for the code and OpenAI's GPT Image models for the art.
Both were true when written and neither is true now: the chain was rewritten around the account
model and its own EVM, decommissioning the code that attribution described, and every brand mark
and piece of in-game art was regenerated with FLUX 2 Pro. An attribution that survives the work it
describes is just a stale sentence with a credit in it.

The generated originals carry **C2PA provenance metadata** written by the model, so the claim above
is checkable rather than merely asserted — `branding/hearth-logo.png` and `branding/mark-hearth.png`
hold it. The wordmark, favicon, Open Graph and social files do not, because they are derived from
those originals by downscaling and cropping, and resampling discards the metadata along with the
pixels. *(This list named a third holder, `web/art/mine-hero.png`, until that tree was deleted in
`48bc28a`.)*

The models were used under paid API access and the output is the project's to use. Nothing here is
claimed to be hand-written that is not, and nothing is claimed to work that has not been tested.
The conformance-vector discipline exists partly for this reason: an implementation is judged by
whether it passes the reference vectors, not by who or what wrote it.
