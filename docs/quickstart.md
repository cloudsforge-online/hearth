# Quickstart — deploy your first contract on Hearth

Hearth is an account-model, EVM-executing proof-of-work chain. Chain id **7411**,
native asset **EMBER** with 18 decimals, Shanghai semantics, standard `eth_*`
JSON-RPC. If you have deployed a contract to any EVM chain, you already know how
to deploy to this one; the rest of this page is the specifics and the sharp
edges.

---

## Read this first: what you can actually run today

**Mainnet is live: `https://rpc.cloudsforge.online`, chain id 7411.** It answers
JSON-RPC over POST with a publicly trusted certificate, and an explorer is at
`https://explorer.cloudsforge.online`.

Read it before you trust it. It is **hours old** — block 1 was mined 2026-08-04
19:12 UTC — under 250 blocks tall, carries zero transactions so far, sits at its
launch difficulty, and runs on **one home server behind one Cloudflare Tunnel**
with no redundancy and no restored backup. Nothing here has been independently
audited. There is **no publicly reachable testnet**, so mainnet is the only
public chain to point at.

Which is why most of this page still runs against a chain of your own. One
command starts one:

```bash
node node/bin/hearthd.js --evm --mine --data /tmp/hearth      # [RUN]
```

That is an account-model chain: it mines Homefire blocks, executes the EVM,
and serves the `eth_*` surface on `http://127.0.0.1:8545/`. Everything on this
page except §7 was executed against it while this page was written — a
contract deployed, called, paid and read back. Swap the `--rpc` for
`https://rpc.cloudsforge.online` when you want the public chain instead.

Every step below carries a marker:

| Marker | Meaning |
| --- | --- |
| **[RUN]** | Works right now on your machine, with no chain involved. Everything so marked was executed while this page was written. |
| **[LOCAL]** | Needs a chain, and the one above is it — chain id 7411 on the default network, 7412 with `HEARTH_NETWORK=hearth-testnet`. Executed against `hearthd --evm` while this page was written **unless the surrounding text says it was not**, and where it was not, that is said in the same breath rather than left to the marker. |
| **[PROBE]** | Works against `tools/rpc-probe/stub.js`, which serves Hearth's real RPC layer over a chain with no state. Proves your wiring, encoding and chain id without mining anything. **Cannot execute code**, so deployments hang. |
| **[WAITING]** | Needs a chain someone else runs — a published endpoint, a deployed faucet, a deployed explorer. Written against the frozen spec, never executed. |

There is one exception worth knowing about up front: **§7, the exchange, is
fully `[RUN]`**, because Hardhat ships its own Shanghai EVM. You can deploy the
whole AMM, seed a pool and execute a swap today — just not on Hearth. That
rehearsal catches almost every mistake you would otherwise make later, so it is
worth doing.

---

## 1. What you need

Node.js ≥ 18 for everything. Then one of:

```bash
# Hardhat — comes with the template
cd tools/hardhat && npm install                        # [RUN]

# Foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup   # [RUN]
```

Versions this page was written against: Node 24.14.0, Hardhat 2.29.0,
ethers 6.15, Foundry 1.7.1 (forge 1.7.1), solc 0.8.26.

---

## 2. An account

An account is a secp256k1 key. Address derivation is byte-for-byte Ethereum's,
so anything that makes an Ethereum key makes a Hearth key.

```console
$ cast wallet new                                       # [RUN]
Successfully created new keypair.
Address:     0x1103fa380244591821a37504531A090EbCa8fA47
Private key: 0xe90b9bbee515cd33…35daa4          ← truncated deliberately
```

The key is truncated because a real one printed in a repository is a real one
leaked, even if it holds nothing today and even if the only chain it can spend
on is one you started five minutes ago.
**Never paste a funded key into a terminal, a config file or a repository.** The
templates read `HEARTH_PRIVATE_KEY` from the environment and nowhere else;
`.env` is gitignored at the repository root, and the faucet goes further and
refuses to read a key file that resolves to a path inside this repository.

The cheapest possible proof that the derivation is not bespoke — the same
address Ethereum derives for private key `0x…01`:

```console
$ cast wallet address --private-key 0x00…01              # [RUN]
0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
```

Addresses are rendered `0x` with an **EIP-55 mixed-case checksum**. The old
`ember1…` bech32 format belongs to the UTXO chain, is retired, and cannot
receive funds here.

---

## 3. Point your tooling at a node

```bash
export HEARTH_RPC_URL=…      # ⬜ [WAITING] — nothing is published to point at
```

Run your own instead. This is the path the rest of the page takes:

```bash
node node/bin/hearthd.js --evm --mine --data /tmp/hearth   # [RUN]
export HEARTH_RPC_URL=http://127.0.0.1:8545
```

```console
$ cast chain-id --rpc-url $HEARTH_RPC_URL                # [LOCAL]
7411
$ cast block-number --rpc-url $HEARTH_RPC_URL
8
```

Three nodes instead of one, on the testnet chain id 7412, with the genesis hash
published in [`../TESTNET.md`](../TESTNET.md):

```bash
docker compose -f docker-compose.testnet.yml up -d       # [RUN]
# seed :8545 · miner1 :8547 · miner2 :8549
```

If you would rather not mine at all — you only want to check that your client
speaks the right protocol — run the probe stub:

```bash
node tools/rpc-probe/stub.js --port 8745                # [RUN]
export HEARTH_RPC_URL=http://127.0.0.1:8745
```

It serves `node/src/jsonrpc/` — the real method surface, the real hex encoder —
over a chain that has no state and executes nothing. It logs every method a
client calls, including the ones Hearth does not implement, which is the point
of it. Read [`../tools/rpc-probe/README.md`](../tools/rpc-probe/README.md) before
you trust anything it says.

Check it:

```console
$ cast chain-id --rpc-url $HEARTH_RPC_URL                # [PROBE]
7411
$ cast client --rpc-url $HEARTH_RPC_URL
Hearth-rpc-probe/NOT-A-NODE/node24.14.0
```

Or, with more diagnosis, from the Hardhat template:

```console
$ cd tools/hardhat
$ npx hardhat run scripts/check-network.js --network hearth   # [PROBE]
rpc url            http://127.0.0.1:8745
eth_chainId        0x1cf3 (hex QUANTITY)
net_version        "7411" (decimal STRING)
web3_clientVersion Hearth-rpc-probe/NOT-A-NODE/node24.14.0
eth_blockNumber    0x1
eth_gasPrice       0x3b9aca00
baseFeePerGas      absent (correct for v1 — legacy pricing)
latest timestamp   0x68e7780f → 2025
signer             0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
balance            1000.0 EMBER

All network checks passed.
```

That script exists because three of those lines are load-bearing and are wrong
in ways nothing else notices:

- **`eth_chainId` is hex and `net_version` is decimal.** Same number, different
  encodings, not interchangeable. Swap them and MetaMask refuses the network
  outright with an error naming neither value.
- **`baseFeePerGas` must be absent.** Its absence is what makes ethers and viem
  fall back to legacy pricing. A zero base fee would make them build type-2
  transactions v1 cannot execute.
- **`timestamp` must be seconds.** The retired UTXO header stores milliseconds
  and the account-model header divides at the header, not at the RPC boundary
  ([`evm-spec.md`](evm-spec.md) §4). Get that wrong and every explorer renders
  the year 57,000 and every Solidity `deadline` comparison — Uniswap's router
  included — behaves nonsensically.

---

## 4. Get some EMBER

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"address":"0x1103fa380244591821a37504531A090EbCa8fA47"}' \
  https://faucet.example.invalid/drip                   # ⬜ [WAITING] — not deployed
```

The faucet **service** is built and tested — [`../tools/faucet`](../tools/faucet)
— and you can run it locally today. It is not deployed anywhere public.

On your own chain you do not need it: **mine.** `hearthd --evm --mine` pays the
subsidy to a key it generates on first start and keeps at
`<data>/coinbase-key.json`. Import that key and the balance is yours to spend
— which is exactly how the deploy in §5 below was paid for:

```console
$ node node/bin/hearth.js wallet import --label coinbase \
    --key "$(node -p "require('/tmp/hearth/coinbase-key.json').privateKey")"   # [LOCAL]
$ node node/bin/hearth.js wallet balance --from coinbase --rpc http://127.0.0.1:8545
0x1085a284C830D892472F8E5c13cFE4d329Ab24Df  53.999964756 EMBER
```

`--miner-address` is refused with `--evm`, and the error says why: the coinbase
must **sign** the block, so the node can only mine to a key it holds.

Without a faucet and without mining, an account has no EMBER, and every step
from §5 onward needs gas.

---

## 5. Deploy a contract

### 5.0 With no toolchain at all

The node ships a client. This is the deployment this page was checked against —
WEMBER, the wrapped-EMBER contract from `contracts/`, onto a `hearthd --evm`
chain, paid for with mined coin:

```console
$ node -e "const a=require('./contracts/out/WEMBER.json');
  require('fs').writeFileSync('/tmp/w.bin',a.bytecode);
  require('fs').writeFileSync('/tmp/w.abi.json',JSON.stringify(a.abi))"   # [RUN]

$ node node/bin/hearth.js deploy --bin /tmp/w.bin --abi /tmp/w.abi.json \
    --from coinbase --rpc http://127.0.0.1:8545 --wait --yes             # [LOCAL]
address 0x900cf10263873e2376d7067a0179596b7D2018f2 (from sender + nonce 0)
mined 0xfb7343025ff087e622d4921afc6bc0b1363905369170e5c1f03aef9b33418313  block 14  gas used 682499
deployed 0x900cf10263873e2376d7067a0179596b7D2018f2
```

It executes, it emits, and the state survives the block:

```console
$ node node/bin/hearth.js send --to 0x900cf1…2018f2 --fn deposit --value 2 \
    --abi /tmp/w.abi.json --from coinbase --rpc http://127.0.0.1:8545 --wait --yes   # [LOCAL]
mined 0xe9f0239b7fbf7075b9d46f896b4db60cc39234707d349dd6902a15c4fb66b248  block 18  gas used 44932
  log 0x900cf1…2018f2 topics 2 data 32B

$ node node/bin/hearth.js call --to 0x900cf1…2018f2 --fn balanceOf 0x1085a2…b24Df \
    --abi /tmp/w.abi.json --rpc http://127.0.0.1:8545                     # [LOCAL]
balanceOf(address) @ 0x900cf10263873e2376d7067a0179596b7D2018f2
  uint256            2000000000000000000
```

Your addresses and hashes will differ — the coinbase key is generated per data
directory — but the shape is the check: a receipt with a block number, a log,
and a `balanceOf` that reads back what you paid in.

Both templates below deploy the same `Greeter` instead. It stores a string,
emits an event, and reports `block.chainid` — the cheapest end-to-end proof
that the node, the signer and the tooling all agree which chain you are on.

### 5.1 Hardhat

```console
$ cd tools/hardhat
$ npm install                                            # [RUN]
$ npx hardhat compile                                    # [RUN]
Compiled 2 Solidity files successfully (evm target: shanghai).
```

Then:

```bash
export HEARTH_PRIVATE_KEY=0x…
export HEARTH_RPC_URL=http://127.0.0.1:8545
npx hardhat run scripts/deploy.js --network hearth       # [LOCAL]
```

**Not executed while this page was written** — `npm install` in the template
needs the network, and the machine this was checked on was offline — so treat
this one as spec-following rather than as a transcript. What it produces is a
legacy signed transaction like the one §5.0 mined, and the settings below are
what make it legacy.

Against the probe **[PROBE]** the same command signs and broadcasts a correct
transaction and then polls forever, because the probe mines nothing — which is
the honest behaviour for a chain with no state.

The two settings in `hardhat.config.js` that are not decoration:

```js
solidity: { version: '0.8.26', settings: {
  evmVersion: 'shanghai',          // ← NOT optional
  optimizer: { enabled: true, runs: 999999 },
  metadata: { bytecodeHash: 'none' },
}},
networks: { hearth: {
  url: process.env.HEARTH_RPC_URL, chainId: 7411,
  accounts: [process.env.HEARTH_PRIVATE_KEY],
  gasPrice: 1_000_000_000,          // optional; pins legacy pricing
}},
```

**`evmVersion: 'shanghai'` matters more than it looks.** Hardhat's default for
solc 0.8.26 is `cancun`, which emits `MCOPY`, `TSTORE` and `TLOAD`. Hearth v1
implements Shanghai and nothing later. Those opcodes compile without complaint
and then hit an invalid opcode **at runtime, on chain, after you have paid to
deploy** — the most expensive possible place to find out.

### 5.2 Foundry

```console
$ cd tools/foundry
$ forge install foundry-rs/forge-std --no-git             # [RUN] once
$ forge build                                             # [RUN]
Compiling 23 files with Solc 0.8.26
Solc 0.8.26 finished in 922.84ms
Compiler run successful!

$ forge test                                              # [RUN]
Ran 4 tests for test/Greeter.t.sol:GreeterTest
[PASS] testFuzz_SetGreeting(string) (runs: 256, μ: 37916, ~: 19152)
[PASS] test_ChainIdIsHearth() (gas: 5445)
[PASS] test_InitialGreeting() (gas: 13233)
[PASS] test_SetGreetingEmits() (gas: 21087)
Suite result: ok. 4 passed; 0 failed; 0 skipped
```

Deploy:

```bash
forge create --rpc-url "$HEARTH_RPC_URL" --private-key "$HEARTH_PRIVATE_KEY" \
  --legacy --broadcast \
  src/Greeter.sol:Greeter --constructor-args 'hello hearth'    # [LOCAL]
```

### 5.3 `--legacy` is required for Foundry, and only for Foundry

Hearth v1 has no EIP-1559. The mechanism that makes clients cope is a deliberate
omission: **block responses do not carry `baseFeePerGas`**, so ethers and viem
conclude there is no fee market and fall back to legacy pricing on their own.

Measured against the probe:

| Tool | Behaviour |
| --- | --- |
| ethers 6.15 / Hardhat 2.29 | Reads the latest block, finds no `baseFeePerGas`, calls `eth_gasPrice`, signs **type 0**. Never calls `eth_feeHistory`. Works with no flags. |
| `forge create`, `forge script`, `cast send` | Call **`eth_feeHistory` unconditionally** and abort when it is missing. |

Without the flag **[PROBE]**:

```console
$ forge create --rpc-url $HEARTH_RPC_URL --private-key $KEY --broadcast \
    src/Greeter.sol:Greeter --constructor-args 'hello hearth'
Error: Failed to estimate EIP1559 fees. This chain might not support EIP1559,
       try adding --legacy to your command.

Context:
- server returned an error response: error code -32601: the method
  eth_feeHistory does not exist/is not available
```

Three things about that, all tested rather than assumed:

1. **It must be a command-line flag.** `legacy = true` in `foundry.toml`
   produces `Warning: Found unknown 'legacy' config for profile 'default'` and
   changes nothing. `FOUNDRY_LEGACY=true` is ignored too.
2. `forge script` fails the same way but *after* printing a successful local
   simulation, so it looks briefly as though the deployment worked.
3. Only `eth_feeHistory` is probed. `eth_maxPriorityFeePerGas` was never called.

Implementing `eth_feeHistory` would make this worse, not better: returning zero
base fees would let Foundry build a type-2 transaction the chain cannot execute,
trading a loud error at signing time for a silent rejection at the node.

---

## 6. Talk to it

```bash
GREETER=0x… npx hardhat run scripts/interact.js --network hearth   # [LOCAL]
```

or

```bash
cast call  "$GREETER" 'greeting()(string)'          --rpc-url "$HEARTH_RPC_URL"
cast call  "$GREETER" 'chainId()(uint256)'          --rpc-url "$HEARTH_RPC_URL"
cast send  "$GREETER" 'setGreeting(string)' 'warmer' \
  --legacy --private-key "$HEARTH_PRIVATE_KEY" --rpc-url "$HEARTH_RPC_URL"
```

Reads (`cast call`, `eth_call`) are free, unsigned and need no `--legacy`.
Writes (`cast send`) are signed transactions, cost gas, and do.

Two opcodes behave in Hearth-specific ways and the `Greeter` exposes both:

**`PREVRANDAO` (0x44) returns the parent block's Homefire proof-of-work
digest.** Ethereum's beacon-chain randomness does not exist here. The digest is
a real 256-bit hash, deterministic and verifiable by anyone — and it is
**miner-influenceable**: a miner who dislikes the outcome can discard the block
and grind another. **Do not use `block.prevrandao` for anything an adversarial
miner would profit from biasing.** That is true of every proof-of-work chain
that derives randomness from its own header; it is stated plainly because
contracts misuse it routinely.

**`BASEFEE` (0x48) pushes zero.** It exists because Shanghai includes EIP-3198
and removing it would make Shanghai-compiled Solidity fail here while working on
Ethereum. v1 has no fee market. Do not price anything off it.

---

## 7. The exchange — deploy, add liquidity, swap

**This whole section is `[RUN]`.** Hardhat ships an in-process Shanghai EVM, so
you can rehearse the entire AMM deployment and a real swap on your own machine
today. Everything except the network is identical to what you will do on Hearth.

The contracts are in [`../contracts`](../contracts): WEMBER (WETH9), a Uniswap
V2 port, and Multicall3.

### 7.1 Build them

```console
$ pnpm --dir contracts install && pnpm --dir contracts compile   # [RUN]
  HearthV2Router02     deployed  21189 B   creation  21721 B
  HearthV2Factory      deployed  13059 B   creation  13194 B
  HearthV2Pair         deployed  10693 B   creation  10959 B
  Multicall3           deployed   3668 B   creation   3696 B
  WEMBER               deployed   2577 B   creation   3045 B

  INIT_CODE_HASH = 0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537
```

### 7.2 Deployment order and constructor arguments

| # | Contract | Constructor arguments | Depends on |
| --- | --- | --- | --- |
| 1 | `WEMBER` | *(none)* | — |
| 2 | `HearthV2Factory` | `address _feeToSetter` | — |
| 3 | `HearthV2Router02` | `address _factory, address _WEMBER` | 1, 2 |
| 4 | `Multicall3` | *(none)* | — |

1 and 2 are independent; 4 is independent of everything.

**`HearthV2Pair` is never deployed directly.** The factory `CREATE2`s each one
inside `createPair`. Its constructor takes no arguments, which is load-bearing:
an argument would make the init code vary per pair and destroy the address
derivation the router depends on.

### 7.3 `feeToSetter` must be a multisig from the first block

It is the only privileged role in the system. It can switch the protocol fee on
and hand itself to another address. **There is no timelock and no two-step
handover in Uniswap V2** — whoever holds that key can redirect the fee switch in
one transaction, and passing a wrong address to `setFeeToSetter` permanently
freezes both settings.

"Move it to a multisig later" does not work, because moving it later requires
the very key you are trying to stop relying on. `scripts/deploy-dex.js` refuses
to run without `HEARTH_FEE_TO_SETTER`, and refuses if it equals the deployer.

Leave `feeTo` **unset** at launch. While it is zero the whole 0.3% accrues to
liquidity providers; that is what Uniswap did and it is right here too.

### 7.4 Deploy

```console
$ cd tools/hardhat
$ npx hardhat node &                                          # [RUN] a local Shanghai EVM
$ HEARTH_FEE_TO_SETTER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  npx hardhat run scripts/deploy-dex.js --network localhost   # [RUN]
deployer   0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
feeToSetter 0x70997970C51812dc3A010C7d01b50e0d17dc79C8

WEMBER             0x5FbDB2315678afecb367f032d93F642f64180aa3
HearthV2Factory    0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
HearthV2Router02   0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
Multicall3         0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9

--- post-deployment checks (contracts/README.md "After deploying") ---
factory.pairCodeHash() 0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537
  matches the router's hard-coded constant
  router.factory() and router.WETH() agree
  factory.feeTo() 0x00…00 (unset — correct at launch)
```

On Hearth the same command becomes `--network hearth` **[LOCAL]** — pointed at
your own node, not at a published endpoint, and not executed here for the
`npm install` reason in §5.1.

### 7.5 Verify the init code hash before any liquidity is added

**This is the single most common way a Uniswap V2 fork is stood up broken, and
it does not fail loudly.**

The router never asks the factory where a pair lives. It derives the address
arithmetically from a compile-time constant:

```
pair = keccak256(0xff ++ factory ++ keccak256(token0, token1) ++ INIT_CODE_HASH)[12:]
```

If that constant does not match the bytecode the live factory actually deploys,
the router looks for pools at addresses where nothing exists. In the EVM **a
call to an address with no code succeeds and returns empty** — so this presents
as "the pool has no reserves", over and over, until somebody loses money on a
swap that silently did nothing.

The hash changes if *anything* changes: `HearthV2Pair.sol`, any file it imports,
the solc version, the optimiser settings, or the `evmVersion`. It is why
`contracts/` compiles with `metadata.bytecodeHash: none` — otherwise editing a
docstring would move every pair address.

`HearthV2Factory.pairCodeHash()` returns what the **live** factory will produce.
Call it and compare. `deploy-dex.js` does this automatically and aborts on a
mismatch; `swap.js` re-checks it on every run.

Current value: `0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537`,
built with solc 0.8.26+commit.8a97fa7a, `evmVersion: shanghai`, optimizer at
999999 runs, `metadata.bytecodeHash: none`. Verified against a live deployed
factory in the run above.

### 7.6 Add liquidity and swap

```console
$ npx hardhat run scripts/swap.js --network localhost         # [RUN]
--- 1. deploy a token to pool against ---
DEMO 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9

--- 2. add liquidity: 10 EMBER + 10,000 DEMO ---
addLiquidityETH 0x732608b3…
pair 0x15E4A5D6ae275B97b37C1cA3c09C99F7FC41E868
reserves 10.0 WEMBER / 10000.0 DEMO
LP supply 316.227766016837933199 (1000 wei was burned to address(0) on the first mint)

--- 3. swap 1 EMBER for DEMO ---
quote  1 EMBER → 906.610893880149131581 DEMO (0.3% fee already taken)
swapExactETHForTokens 0x7abd0964…
gas used 136979
received 906.610893880149131581 DEMO

--- 4. swap it back ---
recovered ~ 0.994550668459521908 EMBER — less than 1, which is the two 0.3% fees

Swap round trip complete.
```

Five things in there that are worth understanding rather than copying:

- **`addLiquidityETH`, `swapExactETHForTokens`, `WETH()` — read "ETH" as "the
  native asset".** These are selectors, not prose. Renaming them to EMBER would
  break every V2 front-end, aggregator, subgraph and SDK for a cosmetic gain.
  `WEMBER()` is provided as a readable alias of `WETH()` and is the only
  function the router has that Uniswap's `Router02` does not.
- **You must `approve` the router before it can pull a token.** Without an
  allowance the call reverts inside the *token*, so the error message is the
  token's and does not mention the router.
- **The `deadline` is in seconds.** The router rejects any swap whose deadline
  has passed. If `block.timestamp` ever arrives in milliseconds, every call
  reverts with `UniswapV2Router: EXPIRED` — which is the fastest available
  detector for that bug.
- **`amountOutMin` is your only protection against being reordered.** Zero is an
  invitation to be sandwiched. The script uses 99% of the quote, which is fine
  for a script and not for a front-end.
- **`316.227766…` is `sqrt(10 × 10000)`**, the initial LP supply, minus the 1000
  wei `MINIMUM_LIQUIDITY` burned to `address(0)` on the first mint so the pool
  can never be fully drained and re-priced.

### 7.7 Multicall3 and the canonical address

Front-ends, wallets, viem's batching and most indexers look for Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11` on every chain. That address is not
magic: it comes from a **pre-signed, pre-EIP-155, keyless** deployment
transaction carrying solc 0.8.12 / london bytecode, which lands at the same
address wherever it is replayed. Hearth accepts pre-155 transactions
specifically so that route stays open ([`evm-spec.md`](evm-spec.md) §3).

The build in `contracts/` is **not** that bytecode, so deploying it puts
Multicall3 at an ordinary address that every front-end must be told about by
hand. Decide which you want before front-ends hard-code an address.

Also: do not send EMBER to Multicall3. `aggregate`, `tryAggregate`,
`tryBlockAndAggregate` and `blockAndAggregate` are `payable`, do no value
accounting, and there is no sweep function. Value sent to them is stranded
permanently. Only `aggregate3Value` reconciles `msg.value`.

---

## 8. Things that will bite you

**Shanghai, not Cancun.** Covered in §5.1, repeated because it costs a
deployment. `contracts/`'s own test suite asserts that no `MCOPY`, `TSTORE`,
`TLOAD`, `BLOBHASH` or `BLOBBASEFEE` appears in any artefact, and that `PUSH0`
*does* — proving the Shanghai target is live rather than silently falling back.

**Legacy transactions only.** No `maxFeePerGas`, no `maxPriorityFeePerGas`, no
access lists as a transaction type. If your signer *requires* type 2, it needs a
legacy path.

**All nine precompiles are implemented, and they fail in two opposite ways.**
`ecrecover` (`0x01`) through `modexp` (`0x05`) **fail soft**: a malformed input
gets EMPTY output and a *successful* call, which is what makes Solidity's
`ecrecover()` return `address(0)` and what every `require(signer != address(0))`
in every permit implementation is testing. bn128 add/mul/pairing (`0x06`–`0x08`)
and blake2f (`0x09`) **fail hard**: a coordinate outside the field, a point off
the curve, a G2 point outside the r-torsion, a pairing input whose length is not a
multiple of 192, or a blake2f block that is not exactly 213 bytes — each fails the
call and burns every drop of forwarded gas.

Both conventions are consensus, and the hard one exists because **in the EVM a
call to an address with no code succeeds and returns empty**. A zk verifier that
read "success, no output" as a zero would accept a forged proof. Earlier versions
of this page said `0x06`–`0x09` were unimplemented and reverted for that reason;
they are implemented now ([`decisions.md`](decisions.md) §1.3), and they still
fail hard on bad input, which is correct rather than a bug.

**Reorgs have no depth bound.** Fork choice is heaviest-cumulative-work with no
maximum reorg depth, no checkpointing and no finality gadget. A 500-block reorg
is not rejected by the protocol; it is merely expensive — and at launch, with
little hashrate, "expensive" may mean some cloud CPUs. Do not treat a
confirmation count as safety on day one
([`exchange-integration.md`](exchange-integration.md) §4).

**Contract-originated value transfers are invisible to a top-level scan.**
`SELFDESTRUCT` and internal `CALL`s move EMBER without a top-level transaction.
There is no `debug_traceTransaction` and no `trace_block` in v1.

**Every node is an archive node**, because nothing prunes. Historical
`eth_call` works at any depth. The cost is that memory and disk only grow, and a
restart replays and re-validates the whole chain.

---

## 9. What does not exist yet

Do not plan around any of these:

| | |
| --- | --- |
| A **published** RPC endpoint | ✅ `https://rpc.cloudsforge.online`, chain id 7411, POST only. What it does **not** have is age, transactions, a demonstrated hashrate, an audit or a second machine |
| A **public** testnet | ⬜ the three-node testnet runs on `127.0.0.1` and nothing routes it; its `*.testnet.cloudsforge.online` names resolve but fail the TLS handshake. Its chain id **is** chosen: **7412**, and its genesis hash is published in [`../TESTNET.md`](../TESTNET.md) |
| A **deployed** `0x`-native block explorer | 🟡 one is deployed at `https://explorer.cloudsforge.online`, but **not from this repository** — `web/` was deleted in `48bc28a`. The estate surface is [`micro-explorer-web`](https://github.com/cloudsforge-online/micro-explorer-web), which reads `micro-indexer` rather than talking `eth_*` to your node — so there is still **nothing here you can point at your own node** |
| Contract source verification | 🟡 the services are written — [`../tools/verify`](../tools/verify) (116/116, and it speaks what `forge verify-contract` speaks) and [`../tools/explorer-api`](../tools/explorer-api) (the Etherscan-compatible `/api`, 177/177 plus 27/27 against a real chain). Neither is hosted |
| A deployed faucet | ⬜ the service is written and tested; nowhere public to run it. Mine instead — §4 |
| Any **persistently** deployed contract | ⬜ WEMBER, the AMM and Multicall3 deploy and run (§5.0, §7), but nothing is deployed to mainnet — every block on it so far carries zero transactions |
| `eth_subscribe` / WebSockets | ⬜ v2. Port 8546 is reserved for it |
| `eth_newFilter` / `eth_getFilterChanges` | ✅ implemented, bounded and served (`node/src/jsonrpc/filters.js`) — the poll-based stand-in for `eth_subscribe` |
| `eth_feeHistory` | 🟡 implemented but **OFF by default** — `HEARTH_RPC_FEE_HISTORY=1` turns it on. See §5.3 for why the default is off on a legacy-only chain |
| `debug_*` / `trace_*` / `eth_getProof` | ⬜ not planned for v1. `node/bin/hearth.js trace` covers the opcode-level case out of band |
| A registered SLIP-44 coin type | ⬜ derive under coin type 60 meanwhile |
| Chain id 7411 in `ethereum-lists/chains` | ⬜ unclaimed, unfiled |
| Any independent audit | ⬜ [`listing-checklist.md`](listing-checklist.md) §4 |

If you need one of these, say so on the repository — several are small and none
are scheduled.

---

## 10. Where to go next

- [`network-config.md`](network-config.md) — every form of the connection details
- [`../tools/metamask.md`](../tools/metamask.md) — adding the network to a wallet
- [`../tools/hardhat`](../tools/hardhat) / [`../tools/foundry`](../tools/foundry) — the templates used above
- [`../tools/faucet`](../tools/faucet) — running a faucet
- [`../contracts/README.md`](../contracts/README.md) — the AMM in detail
- [`evm-spec.md`](evm-spec.md) — the authoritative specification
- [`../MAP.md`](../MAP.md) — what is in this repository, cited to `path:line`
