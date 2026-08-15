# Hearth contracts — the DeFi layer

Solidity for Hearth's exchange, as specified in [`docs/evm-spec.md` §7](../docs/evm-spec.md).
WEMBER wraps the native asset, a Uniswap V2 port provides the AMM, and Multicall3 is
present because every front-end and indexer assumes it is.

This directory is self-contained. It has one dev dependency (`solc`), it does not touch
`node/`, and it compiles without a running Hearth node.

```
cd contracts
pnpm install
pnpm compile      # -> out/*.json
pnpm test         # 27 build-level assertions
```

---

## The contracts

| Contract | Basis | What it is |
| --- | --- | --- |
| `WEMBER` | WETH9 | EMBER as an ERC-20. `deposit()` mints at par, `withdraw()` burns at par, `totalSupply()` is this contract's EMBER balance, so the peg is an accounting identity rather than a promise. An AMM cannot pool the native asset directly; this is the adapter. 18 decimals, matching EMBER. |
| `HearthV2Factory` | `UniswapV2Factory` | Deploys and registers pairs with `CREATE2`, salted `keccak256(token0, token1)`. Holds `feeTo` / `feeToSetter`. |
| `HearthV2Pair` | `UniswapV2Pair` | The constant-product pool. `x * y >= k`, 0.3% fee, `MINIMUM_LIQUIDITY` burned on first mint, `UQ112x112` TWAP accumulators, `skim` / `sync`, a reentrancy `lock`, and an LP token with EIP-2612 `permit`. |
| `HearthV2Router02` | `UniswapV2Router02` | Swaps, liquidity, multi-hop paths, deadlines, native-EMBER wrapping, and the fee-on-transfer variants. Selector-for-selector identical to Router02. |
| `Multicall3` | canonical Multicall3 | Batched reads in one `eth_call`. |
| `HearthV2ERC20` | `UniswapV2ERC20` | Base of `HearthV2Pair`; the LP token. Not deployed on its own. |
| `HearthMultisig` | Gnosis `MultiSigWallet`, reduced | An *m*-of-*n* wallet. It exists because `feeToSetter` must not be an EOA and the estate had nothing else that could hold it. Confirmations are recorded on-chain by each signer rather than aggregated off-chain — no `ecrecover`, no domain separator, no nonce discipline. Owner and threshold changes are proposals the wallet makes to itself. |

Libraries (`src/libraries/`) are all `internal` and inline into their callers, so nothing
needs library linking at deploy time:

- `Math` — `min` and a Babylonian `sqrt`.
- `UQ112x112` — the 112.112 fixed-point format the TWAP accumulators are carried in.
- `TransferHelper` — ERC-20 calls that tolerate tokens returning nothing, plus native transfer.
- `HearthV2Library` — pricing maths and, critically, `pairFor` and `INIT_CODE_HASH`.

---

## THE INIT CODE HASH

```
0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537
```

Built with **solc 0.8.26+commit.8a97fa7a**, `evmVersion: shanghai`, optimizer enabled at
**999999 runs**, `metadata.bytecodeHash: none`.

The router derives every pair's address arithmetically —
`address(keccak256(0xff ++ factory ++ keccak256(token0,token1) ++ INIT_CODE_HASH))` — so it
never has to ask the factory where a pool lives. That saves an external call on every
swap, and it is also the single most common way a V2 fork is stood up broken: **if this
constant does not match the bytecode the factory actually deploys, the router looks for
pools at addresses that do not exist** and every call reverts or silently resolves to an
empty account.

It changes if *anything* changes: `HearthV2Pair.sol`, any file it imports, the solc
version, the optimizer settings, or the `evmVersion`.

**Regenerate:**

```
pnpm compile --sync-hash     # rewrites HearthV2Library.INIT_CODE_HASH, then recompiles
```

Then update the value quoted above, and re-run `pnpm test`.

**Three independent checks guard it:**

1. `pnpm compile` refuses to build if the constant and the bytecode disagree.
2. `pnpm test` additionally asserts that `HearthV2Pair`'s creation code is embedded
   *verbatim* in `HearthV2Factory`'s — so the hash cannot be right about the wrong code.
3. After deployment, `HearthV2Factory.pairCodeHash()` returns what the live factory will
   produce. Call it and compare. **Do this before seeding any liquidity.**

### Why `metadata.bytecodeHash: none`

By default solc appends a CBOR trailer containing an IPFS hash of the compilation
metadata, which covers source file *paths* and the text of every *comment*. With that
enabled, editing a docstring in `HearthV2Pair.sol` would silently change the init code
hash and point the router at addresses where no pair exists. Suppressing the trailer makes
the hash a function of the compiled code alone. Explorer verification still works — supply
the same settings.

---

## Deployment order

All five are **deployed on EMBER testnet, chain 7412** — addresses and the post-deploy
readings in [`micro-deploy` `docs/hearth-exchange.md`](https://github.com/cloudsforge-online/micro-deploy/blob/main/docs/hearth-exchange.md).
**Mainnet is untouched.** The deployer is `micro-deploy`'s `scripts/hearth-dex-deploy.js`,
which follows this table, reads every check below back off the chain, and on mainnet
refuses to invent a signer set. Deploy in this order:

| # | Contract | Constructor arguments | Depends on |
| --- | --- | --- | --- |
| 1 | `HearthMultisig` | `address[] owners_`, `uint256 required_` | — |
| 2 | `WEMBER` | *(none)* | — |
| 3 | `HearthV2Factory` | `address _feeToSetter` | 1 |
| 4 | `HearthV2Router02` | `address _factory`, `address _WEMBER` | 2, 3 |
| 5 | `Multicall3` | *(none)* | — |

5 is independent of all of them, and 2 can go anywhere before 4. **1 cannot move**: it is
the argument to 3, and there is no second chance at it — see below.

`HearthV2Pair` is **never deployed directly** — the factory creates each one with
`CREATE2` inside `createPair`. Its constructor takes no arguments, which is load-bearing:
an argument would make init code vary per pair and destroy the address derivation above.
Tokens are set once by `initialize`, which only the factory may call.

### `feeToSetter`

The one privileged role in the system. It is the only address that can:

- `setFeeTo(address)` — switch the protocol fee on or off. While `feeTo` is zero, the
  whole 0.3% accrues to liquidity providers. While it is set, one sixth of it (0.05%) is
  minted to `feeTo` as LP tokens at each liquidity event.
- `setFeeToSetter(address)` — hand the role on. There is no timelock and no two-step
  handover; passing a wrong address here is unrecoverable and permanently freezes both
  settings.

It cannot touch pool funds, cannot pause anything, and cannot upgrade anything. Nothing in
this system is upgradeable.

**Set it to a multisig, not a deployer EOA — at deployment, not afterwards.** The reason
it cannot wait is circular: moving the role off a key requires that key, so a factory
deployed with an EOA in the slot can only be fixed by the very key you would be trying to
stop relying on. That is why `HearthMultisig` is step 1 of the table above rather than a
follow-up, and why `node/test/multisig.js` deploys a real `HearthV2Factory` against it and
proves the deploying EOA is refused while the wallet is obeyed.

Uniswap launched with `feeTo` unset and it is the right default here too: turn the
protocol fee off at launch, and only consider switching it on once there is liquidity
worth taxing.

### After deploying

1. `HearthV2Factory.pairCodeHash()` == the hash above. If not, stop.
2. `HearthV2Factory.feeToSetter()` == the multisig from step 1, and
   `HearthMultisig.owners()` / `.required()` are the signer set and threshold you meant.
   Read them from the chain rather than from the deployment script — this is the one
   setting with no second chance.
3. `HearthV2Router02.factory()` and `.WETH()` return the addresses from steps 3 and 2.
4. Create the first pair and check that the address matches what `pairFor` derives
   off-chain from the factory address and the init code hash.
5. **Ship with liquidity** (spec §7). A DEX with empty pools attracts nobody. Seed at
   least one pair, then swap through it *and back*, and withdraw part of the position —
   a pool that takes deposits and cannot return them is not a market, and "we never tried
   to withdraw" is how that gets discovered late. `deploy/scripts/hearth-dex-seed.js`
   does all of it and records what it did.

### What is deployed

**EMBER testnet, chain 7412**, from block 14119. All five steps above pass, re-read from
the node.

| | |
| --- | --- |
| `HearthMultisig` | `0x51faced76d70981e863be2987ccc811b0712e4f8` — 2-of-3 |
| `WEMBER` | `0xa26dfebc362a380e1ade6090c7c5887180d1b263` |
| `HearthV2Factory` | `0x18bbd09d51f4e9e630dd0a86fc984b6326f10e41` — `feeTo` unset, `allPairsLength() == 1` |
| `HearthV2Router02` | `0xba2b9db822e1f2ec3039fe474644b8405268a9b4` |
| `Multicall3` | `0x76db8cdcaf4a517a51ae474bd00cfe9a53635c03` |
| EMBER/FTEST pair | `0xd439a085d812b21de4b179fafe00281de50733a0` — opened 2026-08-15 at block 16753 |

The pair has been traded through in both directions and partially withdrawn from: a swap
filled at exactly the quoted amount, `k` rose across both legs, and `removeLiquidityETH`
returned the position's share. The full record, including the two measurement bugs that
run cost, is [`deploy/docs/hearth-exchange.md`](../../deploy/docs/hearth-exchange.md) §6.

All three testnet wallet keys are on one host. That exercises the code path — a threshold
above one, an owner set that can be rotated — and it is not a custody arrangement; do not
cite it as evidence the fee switch is protected. **EMBER mainnet has nothing deployed**,
and the deploy script will not generate a signer set there.

---

## `HearthMultisig`

The first Solidity in this repository that is not a port. It is here for one reason —
`feeToSetter` needs a holder that no single person can operate — and it is deliberately
the smallest thing that satisfies that.

```
constructor(address[] owners_, uint256 required_)
```

Duplicates and the zero address are rejected at construction, because a repeated owner is
one key holding two confirmations: a 2-of-3 that is really a 1-of-2, and after
construction there is nothing left to reject it with.

**Operating it.** Any owner proposes; the proposal auto-confirms for the submitter; other
owners confirm; any owner executes once the threshold is met.

```
submitTransaction(to, value, data) -> txId     confirmTransaction(txId)
revokeConfirmation(txId)                       executeTransaction(txId)
```

Confirmation is withdrawable right up to execution. Reads: `owners()`, `required()`,
`ownerCount()`, `transactionCount()`, `transaction(txId)`, `confirmationCount(txId)`,
`isConfirmed(txId)`.

**Changing the signers or the threshold** is not a separate mechanism. `addOwner`,
`removeOwner`, `replaceOwner` and `changeRequirement` are `onlyWallet` — the wallet's own
address is the only permitted caller — so they are ordinary proposals confirmed by the
same threshold as a payment. There is no admin path around the multisig, because that
path is what an attacker looks for first.

### Four decisions worth knowing about

- **Confirmations are counted over the current owner list, never cached.** A stored tally
  goes stale in exactly one direction — a departed signer keeps a live vote on every
  proposal they touched, which is what removing them was for. `confirmationCount` walks
  `owners()`, which is O(n) against a set `MAX_OWNERS` caps at 20 and cannot be wrong.
  `node/test/multisig.js` sets this trap deliberately: a signer confirms a proposal to
  its threshold, is rotated out, and the proposal drops back below.

- **`removeOwner` reverts rather than lowering `required` to fit**, which is what the
  Gnosis original does. Reducing a 3-of-3 to a 2-of-2 as a side effect of removing
  somebody is a change to the security property, and that belongs in a proposal the
  owners confirm on its own terms. To rotate a signer without touching the threshold, use
  `replaceOwner`.

- **A failed execution reverts and bubbles the target's reason.** The alternative — the
  original's `ExecutionFailure` event — asks the owners to read a log to find out why
  nothing happened. `executed` is written before the call and rolled back with it, so a
  proposal whose target refused it is still pending and can be retried once the cause is
  fixed rather than being burned.

- **Confirmations are on-chain, not aggregated signatures.** A Safe-style EIP-712 scheme
  saves transactions, at the cost of a domain separator, a nonce discipline and a
  malleability policy. On a chain the project mines itself, with a signer set in single
  digits, that is three more things to get wrong for a saving that does not matter. There
  is no `ecrecover` in this contract and nothing to replay.

### Proof

`node/test/multisig.js` runs it on Hearth's own EVM — real signed transactions through
`chain/statetransition.js`, no chain and no RPC:

```
pnpm --dir contracts install && pnpm --dir contracts compile
node node/test/multisig.js          # 143/143
```

It covers the phase A gate from `docs/ecosystem/39-forge-exchange.md` §7 (*signers rotate
and a threshold change succeeds*) and, past it, the reason the gate exists: a real
`HearthV2Factory` deployed with the wallet as `feeToSetter` refuses the EOA that deployed
it, obeys the wallet, and can hand the role to a successor multisig — after which the old
wallet is refused at full threshold.

---

## Multicall3 and the canonical address

Front-ends, wallets and indexers look for Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11` on every chain. That address is not magic —
it comes from a **pre-signed, chain-agnostic (pre-EIP-155) deployment transaction** from a
keyless deployer, which is why it lands identically everywhere it is replayed.

Two consequences for Hearth, both real:

- **The node would have to accept pre-EIP-155 legacy transactions** (`v` of 27 or 28) for
  that transaction to be replayable here. `docs/evm-spec.md` §3 specifies legacy type-0
  transactions *with* EIP-155 replay protection. If pre-155 transactions are rejected, the
  canonical address is unreachable and Multicall3 must be deployed at an ordinary address
  and configured into every front-end by hand.
- **The bytecode in this directory is not the canonical bytecode.** The canonical build is
  solc 0.8.12 / `london` / 10,000,000 runs; this is 0.8.26 / `shanghai` / 999,999 runs, and
  `getCurrentBlockDifficulty` had to be respelled (below). The pre-signed transaction
  carries the canonical bytecode, so taking the canonical address means deploying that,
  not this. The ABI and every selector are identical either way — `pnpm test` asserts all
  sixteen against their published values.

Recommendation: decide this before phase 8, not after front-ends have hard-coded an
address.

### Three things worth knowing about

- **`aggregate`, `tryAggregate`, `tryBlockAndAggregate` and `blockAndAggregate` are
  `payable` but do no value accounting, and there is no sweep function.** EMBER sent to
  them is stranded permanently. Only `aggregate3Value` reconciles `msg.value` against the
  per-call values. This is inherited from the canonical contract, not introduced here, and
  it is not worth diverging over — but do not send value to Multicall3.

- `getCurrentBlockDifficulty()` returns `block.prevrandao`. solc rejects
  `block.difficulty` outright from 0.8.18 with `evmVersion >= paris`. Both spellings
  compile to opcode `0x44`; the selector and runtime behaviour are unchanged. Hearth is
  proof-of-work, so `0x44` is a difficulty here rather than a randomness beacon.
- `getBasefee()` uses opcode `0x48` (BASEFEE, EIP-3198), which Shanghai includes. Hearth
  v1 has no EIP-1559 fee market, so this reports whatever the node returns. Nothing else
  depends on it.

---

## Porting Uniswap V2 from 0.5/0.6 to 0.8

Solidity 0.8 checks all arithmetic by default. V2 depends on wrapping in two places, and
getting either wrong is how a port loses money.

**1. The TWAP accumulators.** `price0CumulativeLast` and `price1CumulativeLast` are
`uint256` counters that are *meant* to overflow. A TWAP consumer always reads the
difference between two observations, and that difference stays correct across a wrap
provided the wrap is silent. Under checked arithmetic the `+=` reverts instead.

**2. The `uint32` timestamp.** `timeElapsed = blockTimestamp - blockTimestampLast` is
*meant* to wrap. The timestamp is truncated to 32 bits so it packs into the same storage
slot as the two `uint112` reserves — one `SLOAD` for `getReserves()`. It wraps in February
2106; checked subtraction would revert at that moment and every `mint`, `burn`, `swap` and
`sync` on every pair would fail forever.

Both live in a single `unchecked` block in `HearthV2Pair._update`, and `pnpm test` asserts
they are still inside it.

`UQ112x112.encode` is also `unchecked`, but for a different reason: it provably cannot
overflow (`y <= 2**112 - 1`, `Q112 == 2**112`, product `< 2**224`), so the block only
suppresses a revert branch that can never be taken.

**Everything else that `SafeMath` used to guard is now guarded by the compiler**, so
`SafeMath` was deleted rather than kept as decoration. The failure modes are identical —
0.8 raises `Panic(0x11)` where SafeMath raised a string. A test asserts no file references
it.

### Other deliberate deviations

- **`WEMBER.withdraw` pays out with `.call{value:}`, not `.transfer`.** The 2300-gas
  stipend has been wrong since EIP-1884 repriced `SLOAD`; it breaks withdrawal for
  ordinary smart-contract wallets. The balance is decremented first, so reentrancy finds a
  zeroed balance. `TransferHelper.safeTransferETH` makes the same choice.
- **The flash-swap callback is `hearthV2Call`, not `uniswapV2Call`.** A contract written to
  be called back by Uniswap pairs on another chain must not be reachable by a Hearth pair.
  Every V2 fork renames this.
- **The router keeps Uniswap's `ETH` naming** — `swapExactETHForTokens`, `WETH()`, and so
  on. These are selectors, not prose. Renaming them to EMBER would break every V2
  front-end, aggregator, subgraph and SDK for a cosmetic gain. Read "ETH" as "the native
  asset". `WEMBER()` is provided as an alias of `WETH()` for readability, and is the only
  function in the router's ABI that Router02 does not have.
- **`HearthV2Factory.pairCodeHash()`** is an addition, so the init code hash can be
  verified against a live factory rather than trusted.
- `IHearthV2Router01` declares `factory()` and `WETH()` as `view` where Uniswap's interface
  says `pure`; the implementation reads immutables and solc will not accept `pure` for
  that. Same selectors, and every client dispatches both as `eth_call`.

---

## What the tests do and do not cover

`pnpm test` runs 22 build-level assertions: the init code hash agrees with the bytecode
and with what the factory embeds; every contract is under EIP-170 (24,576 B) and EIP-3860
(49,152 B); no post-Shanghai opcode (`MCOPY`, `TSTORE`, `TLOAD`, `BLOBHASH`,
`BLOBBASEFEE`) appears anywhere; `PUSH0` *does* appear, proving the Shanghai target is
live rather than silently falling back; the EIP-2612 and EIP-712 typehashes and the
hard-coded ERC-20 selectors match their canonical values; the WEMBER, pair, factory,
router and Multicall3 ABIs contain exactly what a client expects.

**They do not execute the contracts.** They are build-level: they read `out/*.json` and
assert on bytecode and ABIs. Execution is a separate suite.

### The execution suite — `node/test/dex.js`

The gate for phase 7 in the spec is "a swap succeeds end to end". **It is met.**
`node/test/dex.js` replays these artifacts through `node/src/evm` and `node/src/chain`,
driving real signed legacy transactions against a fresh `StateDB` — no chain, no blocks,
no RPC, because phase 5 is still being built:

```
pnpm --dir contracts install && pnpm --dir contracts compile
node ../node/test/dex.js          # --gas for the gas table, --trace to debug a failure
```

It deploys WEMBER, the factory, Router02 and Multicall3; checks `pairCodeHash()` against
the constant above *before* touching liquidity; creates the pair and asserts it lands at
the address `pairFor` derives; adds liquidity and asserts the first-mint
`MINIMUM_LIQUIDITY` burn to the zero address; swaps and asserts `k` does not decrease and
the output equals `getAmountOut` to the wei; swaps back through the native-EMBER path;
exercises `permit` against precompile `0x01` with a low-s signature, with the high-s form
EIP-2 would reject, and with a malformed one that must yield `address(0)` rather than
revert; removes liquidity both plainly and via `removeLiquidityWithPermit`; and asserts
the logs, their per-receipt bloom and the block bloom, which no state root would catch.

It is **not** in `npm test`. That suite runs with zero installed dependencies and this one
needs solc's output, so it is a gate run against `contracts/out` — the same place the
`contracts` CI job already builds.

Two things it does not reach, worth knowing before reading a green run as more than it is:
**there is no `DELEGATECALL` anywhere in this stack** — every library in `src/libraries/`
is `internal`, so solc inlines it, and a disassembly of all five deployed contracts finds
only `CALL`, `STATICCALL` and `CREATE2` — and no test here triggers a flash swap's
`hearthV2Call` re-entry.

`scripts/keccak.mjs` is a dependency-free Keccak-256 written for the init code hash. It
self-tests against `keccak256("") == c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`
at import — the same vector the spec names in §5 — because Node's built-in `sha3-256` uses
the NIST padding byte and is a different function.

---

## CI

There is no workflow for this yet; `.github/` was out of scope for the change that added
this directory. The job to add mirrors forge-mint's contracts job:

```yaml
contracts:
  name: Contracts compile and the init code hash is current
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22 }
    - run: pnpm install --dir contracts
    - run: pnpm --dir contracts test
    - name: The committed init code hash reproduces from source
      run: |
        pnpm --dir contracts compile
        git diff --exit-code -- contracts/src/libraries/HearthV2Library.sol
```

`pnpm compile` exits non-zero on a mismatch on its own, so the `git diff` is belt and
braces against someone running `--sync-hash` and not committing the result.
