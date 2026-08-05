# Adding Hearth to MetaMask

> **The public mainnet endpoint is `https://rpc.cloudsforge.online`, chain id
> 7411.** It is days old, has not been audited and runs on one home server with
> no failover — add it knowing that.
>
> **The public testnet endpoint is `https://rpc-testnet.cloudsforge.online`,
> chain id 7412.** Testnet hostnames are **single-label**
> (`rpc-testnet.`, not `rpc.testnet.`) — a two-label name fails TLS at
> Cloudflare's edge and always will, so do not enter one.
>
> You can also point MetaMask at a chain you run: `hearthd --evm --mine` serves
> `eth_chainId` on `http://127.0.0.1:8545/`, and `docker-compose.testnet.yml`
> serves chain id **7412** on the same port. See
> [`../docs/network-config.md`](../docs/network-config.md).
>
> Everything below is the exact configuration, and the explanation of every
> field, because getting one of them wrong produces an error message that names
> none of them.

---

## The values

| MetaMask field | Value | Notes |
| --- | --- | --- |
| **Network name** | `Hearth` | Display only. |
| **New RPC URL** | `https://rpc.cloudsforge.online` | HTTPS, publicly trusted certificate. MetaMask will not add an `http://` network unless it is loopback. |
| **Chain ID** | `7411` | **The UI field takes DECIMAL.** MetaMask converts it to `0x1cf3` itself. |
| **Currency symbol** | `EMBER` | |
| **Block explorer URL** | `https://explorer.cloudsforge.online` | Optional, and EIP-3091 conformance has not been verified — if a "view on explorer" link 404s, leave this blank rather than guessing another value. |

### The same, for testnet

| MetaMask field | Value |
| --- | --- |
| **Network name** | `Hearth Testnet` |
| **New RPC URL** | `https://rpc-testnet.cloudsforge.online` |
| **Chain ID** | `7412` (hex `0x1cf4`) |
| **Currency symbol** | `EMBER` |
| **Block explorer URL** | `https://explorer-testnet.cloudsforge.online` |

Test EMBER comes from the faucet at
`https://network-testnet.cloudsforge.online/faucet`.

Decimals are not a field in the MetaMask UI. They are fixed at 18 for a native
asset, which is exactly why [`../docs/evm-spec.md`](../docs/evm-spec.md) §1
moved EMBER from 8 decimals to 18.

---

## The one-click payload

For a dApp that offers "Add Hearth to your wallet", this is the
[EIP-3085](https://eips.ethereum.org/EIPS/eip-3085) request. It works in
MetaMask, Rabby, Coinbase Wallet, OKX and anything else exposing `window.ethereum`.

```js
await window.ethereum.request({
  method: 'wallet_addEthereumChain',
  params: [{
    // HEX HERE, not decimal. This field is a QUANTITY: minimal-length, no
    // leading zeros. `0x1cf3`, never `0x01cf3`, never `7411`.
    chainId: '0x1cf3',

    chainName: 'Hearth',

    nativeCurrency: {
      name: 'Ember',
      symbol: 'EMBER',
      decimals: 18,
    },

    // At least one, HTTPS, and it must answer eth_chainId with 0x1cf3 or the
    // wallet rejects the whole request.
    rpcUrls: ['https://rpc.cloudsforge.online'],

    // Optional, and better omitted than wrong. EIP-3091 conformance unverified.
    blockExplorerUrls: ['https://explorer.cloudsforge.online'],
  }],
});
```

Then, to switch to it:

```js
await window.ethereum.request({
  method: 'wallet_switchEthereumChain',
  params: [{ chainId: '0x1cf3' }],
});
// Error code 4902 means "the wallet does not know this chain" — call
// wallet_addEthereumChain and retry. Every dApp needs this branch.
```

**`0x1cf3` in the payload, `7411` in the manual UI form.** That is not an
inconsistency in this document; it is the actual difference between the RPC
convention and the human-facing field.

For testnet the same payload takes `chainId: '0x1cf4'`, `chainName: 'Hearth
Testnet'`, `rpcUrls: ['https://rpc-testnet.cloudsforge.online']` and
`blockExplorerUrls: ['https://explorer-testnet.cloudsforge.online']`.
Everything else is identical.

---

## Why MetaMask refuses a network, in order of likelihood

**1. `net_version` returned hex.**

This is the failure worth knowing about in advance. MetaMask calls both
`eth_chainId` and `net_version` and compares them. They return the **same number
in different encodings**, and it is not a choice:

| Method | Encoding | Correct answer for Hearth |
| --- | --- | --- |
| `eth_chainId` | hex QUANTITY | `"0x1cf3"` |
| `net_version` | **decimal string** | `"7411"` |

`net_version` predates the hex-quantity convention and was never migrated. It is
the one place in the whole RPC where hex is wrong. Hearth answers it correctly —
`node/src/jsonrpc/methods.js` carries the comment saying exactly that, and there
is a test pinning it — but any proxy, cache or load balancer that rewrites
responses can break it, so it is the first thing to check.

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"net_version","params":[]}' "$RPC"
# want: {"jsonrpc":"2.0","id":1,"result":"7411"}
# NOT:  {"jsonrpc":"2.0","id":1,"result":"0x1cf3"}
```

**2. The `chainId` in the payload disagrees with the endpoint.** MetaMask asks
the RPC and refuses if the two differ. That check is the reason a copy-pasted
config pointed at the wrong node fails loudly instead of silently signing
transactions for another chain.

**3. A non-minimal hex quantity.** `0x01cf3` is not `0x1cf3`. Strict clients
reject it.

**4. Plain HTTP on a non-loopback host.** Add TLS.

**5. The endpoint is not JSON-RPC at all.** On Hearth this has a specific and
likely cause: the UTXO-era REST API occupies the same default port, and answers
an unknown POST with `{"err":"no route"}` at HTTP 200. It parses as JSON, so the
error a client shows is confusing. See
[`../docs/network-config.md`](../docs/network-config.md) §3.

---

## What will not work once it is connected

Honest scope, so nobody debugs their own tooling for an hour:

- **No `eth_subscribe` / WebSockets in v1.** MetaMask polls, so this is
  invisible to a user; a dApp using `provider.on('block', …)` over a WebSocket
  is not.
- **No EIP-1559.** MetaMask will show a single gas price rather than the
  low/market/aggressive selector. That is correct — v1 has legacy pricing only.
- **No token auto-detection and no NFT detection.** Both are driven by
  Etherscan-compatible APIs that Hearth does not have
  ([`../docs/listing-checklist.md`](../docs/listing-checklist.md) §3). Tokens
  must be added by contract address by hand.
- **No hardware wallet under a Hearth derivation path.** SLIP-44 has no Hearth
  coin type. Ledger and Trezor will derive perfectly good accounts under coin
  type **60** — Ethereum's — because the curve and the address derivation are
  identical. That is a workaround, not a registration, and it means a user's
  Hearth account and their Ethereum account share a private key. Say so rather
  than letting them discover it.
- **No ENS.** There is no registry deployed.

---

## Related

- [`../docs/network-config.md`](../docs/network-config.md) — every other form of these values
- [`../docs/quickstart.md`](../docs/quickstart.md) — deploying against them
- [`../docs/evm-spec.md`](../docs/evm-spec.md) §1, §2, §6 — the specification
