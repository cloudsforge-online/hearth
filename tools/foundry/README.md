# Foundry template for Hearth

```bash
forge install foundry-rs/forge-std --no-git    # once; lib/ is gitignored
forge build
forge test
```

All three were run while this was written, against Foundry 1.7.1 and solc
0.8.26. Everything needing a live Hearth node was not.

---

## `--legacy`, and why it is not in `foundry.toml`

**Every broadcasting Foundry command against Hearth needs `--legacy` on the
command line.** This is the one place Foundry and the Hardhat/ethers stack
diverge, and it is worth understanding rather than memorising.

Hearth v1 has no EIP-1559. The mechanism that makes clients cope is a deliberate
omission: block responses **do not carry `baseFeePerGas`**
(`node/src/jsonrpc/methods.js`). ethers and viem read that absence as "this
chain has no fee market" and fall back to legacy pricing by themselves.

Foundry has no such fallback. It calls `eth_feeHistory` **unconditionally**,
before pricing anything, and aborts when it is missing. Measured against
[`../rpc-probe`](../rpc-probe):

```console
$ forge create --rpc-url $HEARTH_RPC_URL --private-key $KEY --broadcast \
    src/Greeter.sol:Greeter --constructor-args 'hello hearth'
Error: Failed to estimate EIP1559 fees. This chain might not support EIP1559,
       try adding --legacy to your command.

Context:
- server returned an error response: error code -32601: the method
  eth_feeHistory does not exist/is not available
```

Three things, all tested:

1. **There is no configuration equivalent.** `legacy = true` in `foundry.toml`
   yields `Warning: Found unknown 'legacy' config for profile 'default'` and
   changes nothing. `FOUNDRY_LEGACY=true` is ignored. It must be the flag.
2. `forge script` fails at the same point with different wording —
   `Failed to get EIP-1559 fees; …` — and only **after** printing a successful
   local simulation, so it reads briefly as though the deployment worked.
3. Only `eth_feeHistory` is probed. `eth_maxPriorityFeePerGas` was never called
   by `forge create`, `forge script` or `cast send`.

**Implementing `eth_feeHistory` would be a regression.** Returning zero base
fees would let Foundry build a type-2 transaction the chain cannot execute,
trading a loud error at signing time for a silent rejection at the node. The
correct fix is the flag, until the fee market lands in v2
([`../../docs/evm-spec.md`](../../docs/evm-spec.md) §9).

Read-only commands — `cast call`, `cast balance`, `cast block`, `cast chain-id`
— need no flag. They do not price anything.

---

## Commands

```bash
export HEARTH_RPC_URL=https://rpc.cloudsforge.online   # mainnet, chain id 7411
# …or http://127.0.0.1:8545 for a node you run yourself
export HEARTH_PRIVATE_KEY=0x…

# deploy                                                     [needs a live chain]
forge create --rpc-url "$HEARTH_RPC_URL" --private-key "$HEARTH_PRIVATE_KEY" \
  --legacy --broadcast \
  src/Greeter.sol:Greeter --constructor-args 'hello hearth'

# or through the script
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$HEARTH_RPC_URL" --private-key "$HEARTH_PRIVATE_KEY" \
  --legacy --broadcast

# read                                                                  [free]
cast call "$GREETER" 'chainId()(uint256)' --rpc-url "$HEARTH_RPC_URL"

# write                                                      [needs a live chain]
cast send "$GREETER" 'setGreeting(string)' 'warmer' \
  --legacy --private-key "$HEARTH_PRIVATE_KEY" --rpc-url "$HEARTH_RPC_URL"
```

`[rpc_endpoints] hearth = "${HEARTH_RPC_URL}"` in `foundry.toml` lets you write
`--rpc-url hearth` instead.

---

## Compiler settings

`solc_version = "0.8.26"`, `evm_version = "shanghai"`, optimizer at 999 999
runs, `bytecode_hash = "none"` — identical to
[`../../contracts`](../../contracts).

**Do not raise `evm_version`.** `cancun` and later emit `MCOPY`, `TSTORE` and
`TLOAD`, which Hearth v1 does not implement. They compile here and revert with
an invalid-opcode error on chain, at runtime, in production.

The other three matter if you compile anything that has to interoperate with the
Uniswap V2 router: it derives pair addresses from an init code hash that is a
function of the source, the compiler version, the optimiser settings and the
`evmVersion` together (`contracts/README.md`).

---

## Verification

`[etherscan]` is deliberately empty. Hearth has no Etherscan-compatible
verification API ([`../../docs/listing-checklist.md`](../../docs/listing-checklist.md)
§3), so `forge verify-contract` has nothing to talk to. A plausible-looking URL
here would turn an obvious failure into a confusing one.

---

## What `forge test` does and does not prove

It runs against **Foundry's** EVM, not Hearth's. A green suite says the Solidity
is right; it says nothing about whether Hearth executes it identically. That
question is answered separately, by the `ethereum/legacytests` GeneralStateTests
conformance gate ([`../../docs/evm-spec.md`](../../docs/evm-spec.md) §0) — which
is precisely why the spec insists on it.

`test/Greeter.t.sol` sets `vm.chainId(7411)` so that anything reading
`block.chainid` — EIP-712 domain separators, `permit` signatures, replay guards
— is exercised against the value it will meet in production.
