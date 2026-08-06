# rpc-probe — a stub for the `eth_*` layer

## This is not a node

It has no state, executes no code, mines nothing and validates nothing. It
serves the **real** JSON-RPC layer — `node/src/jsonrpc/{server,methods,hex}.js`,
unmodified — over a fake chain, and logs every method a client calls.

It existed because there was no chain to point Hardhat, Foundry, MetaMask,
ethers or viem at. There is one now — `hearthd --evm` — and this is still the
faster answer to "does my client speak the protocol correctly", because it
starts instantly, mines nothing, and logs every method a client calls including
the ones Hearth does not implement. Use it to prove wiring; use a node to prove
execution.

```bash
node tools/rpc-probe/stub.js --port 8745
```

```console
hearth rpc probe on http://127.0.0.1:8745  chainId=7411 (0x1cf3)
THIS IS NOT A NODE. No state, no execution, no mining. Deployments will hang.
→ eth_chainId []
→ eth_getTransactionCount ["0xf39f…","latest"]
→ eth_estimateGas [{…},"pending"]
→ eth_feeHistory  ** NOT IMPLEMENTED (v1 surface) **
```

## What it can tell you

- Whether a client accepts the chain id, the block shape and the hex encoding
  this repository produces.
- **Which methods a client probes that are not in the v1 surface.** That last
  line above is how the Foundry `--legacy` requirement was established rather
  than guessed.
- Whether the absence of `baseFeePerGas` makes a client fall back to legacy
  pricing — which is the behaviour v1 depends on.

## What it cannot

- **Anything about execution.** `eth_call` with calldata is *refused*, not
  answered with a plausible empty result. A stub that returns "success, empty"
  is indistinguishable from a contract that returned zero, which is the worst
  available failure mode — the same argument
  [`../../docs/evm-spec.md`](../../docs/evm-spec.md) §5 makes about the
  unimplemented precompiles.
- **Anything about deployment.** `eth_sendRawTransaction` decodes and hashes the
  transaction with `node/src/chain/transaction.js` — the tree's real codec, so a
  malformed transaction is rejected for real reasons — and then drops it. Every
  receipt poll returns null forever, so a deploy hangs and then times out. That
  is the correct, visible failure for "there is no chain yet".
- Anything about gas accounting, state roots, reorgs or consensus.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `HEARTH_PROBE_PORT` | `8645` | `--port` overrides |
| `HEARTH_PROBE_BLOCK_MS` | `1000` | how often an empty block appears, so "wait for the next block" terminates |
| `HEARTH_PROBE_BALANCE` | `1000` EMBER in wei | granted to **every** address, so affordability checks pass |
| `HEARTH_PROBE_GAS_PRICE` | 1 gwei | what `eth_gasPrice` returns |
| `HEARTH_PROBE_QUIET` | unset | `1` stops the per-call log |

Note that the default port collides with the UTXO-era REST API, which occupies
8645 (`node/src/params.js`). Use a different one if a `hearthd` is running —
that collision is itself an open question, documented at
[`../../docs/network-config.md`](../../docs/network-config.md) §3.
