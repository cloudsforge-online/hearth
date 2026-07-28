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
pnpm test         # 22 build-level assertions
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

Nothing here is deployed automatically, and nothing has been deployed. Deploy through
ForgeMint's existing EVM path, in this order:

| # | Contract | Constructor arguments | Depends on |
| --- | --- | --- | --- |
| 1 | `WEMBER` | *(none)* | — |
| 2 | `HearthV2Factory` | `address _feeToSetter` | — |
| 3 | `HearthV2Router02` | `address _factory`, `address _WEMBER` | 1, 2 |
| 4 | `Multicall3` | *(none)* | — |

1 and 2 are independent and can go in either order. 4 is independent of all of them.

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

**Set it to a multisig or a governance contract, not a deployer EOA.** Uniswap launched
with `feeTo` unset and it is the right default here too: turn the protocol fee off at
launch, and only consider switching it on once there is liquidity worth taxing.

### After deploying

1. `HearthV2Factory.pairCodeHash()` == the hash above. If not, stop.
2. `HearthV2Router02.factory()` and `.WETH()` return the addresses from steps 2 and 1.
3. Create the first pair and check that the address matches what `pairFor` derives
   off-chain from the factory address and the init code hash.
4. **Ship with liquidity** (spec §7). A DEX with empty pools attracts nobody. Seed
   EMBER/WEMBER and at least one pair against a stable asset before announcing anything.

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
