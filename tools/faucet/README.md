# Hearth testnet faucet

A real service, not a page. Zero npm dependencies, CommonJS, plain `node:http`,
in the style of `infra/lantern`.

```bash
export HEARTH_RPC_URL=http://127.0.0.1:8645
export HEARTH_FAUCET_KEY_FILE=~/.hearth/faucet.key     # chmod 600, outside the repo
node src/index.js
```

```bash
npm test        # 66 assertions over real HTTP against a stub node
```

> **Not deployed anywhere public.** It runs against a local chain today —
> `hearthd --evm --mine`, or the three-node `docker-compose.testnet.yml` — and
> the service is finished and tested. What it is waiting for is a published
> network, not a chain. See [`../../docs/network-config.md`](../../docs/network-config.md).

---

## API

### `POST /drip`

```json
{ "address": "0x1103fa380244591821a37504531A090EbCa8fA47" }
```

```json
{
  "ok": true,
  "txHash": "0xb2ed1a16…",
  "to": "0x1103fa380244591821a37504531A090EbCa8fA47",
  "amount": "10",
  "status": "broadcast — poll eth_getTransactionReceipt until it is non-null"
}
```

**`address` is the only field read.** Not an amount, not a token, not a chain
id. The drip is a server-side constant. Every faucet that has ever been drained
let the caller influence the amount.

Refusals, each with a reason a human can act on:

| Status | When |
| --- | --- |
| `400` | malformed address, failed EIP-55 checksum, the zero address, the faucet's own address, an `ember1…` address, or a recipient that already holds enough |
| `429` | per-address cooldown, per-IP limit, or the global payout cap — with `Retry-After` |
| `503` | the faucet is out of EMBER |
| `502` | the node refused the broadcast |

### `GET /health`

Balance, chain id, whether the node is reachable, what remains in the current
payout window. **Never the key.** A test asserts that.

### `GET /`

A single-page form, so a human with a browser is not stuck reading curl syntax.

---

## Why it cannot be drained

Four controls, layered, because each one alone has a known bypass:

| Control | Default | Bypass |
| --- | --- | --- |
| Per address | 1 per 24 h | generate another address — free and instant |
| Per IP | 3 per 24 h | an IPv6 `/64` has more addresses than the chain has blocks |
| Recipient balance ceiling | refuse ≥ 100 EMBER | sweep the drip to a cold address between requests |
| **Global payout cap** | **1000 EMBER per 24 h** | **none** |

The global cap is the one that means anything: however many addresses, however
many IPs, however fast, the faucet pays out at most that per rolling window and
then refuses everyone. The other three exist so that an honest user is never the
one who trips it.

Three implementation details that are the actual engineering:

**The check and the record are one synchronous block.** `Limits.reserve()`
performs every check *and* writes the spend with no `await` anywhere inside it.
That is what makes it safe on Node's single thread — two simultaneous requests
for the same address cannot both pass before either records. Splitting it into
"check now, record after the broadcast" is the classic faucet drain and it looks
completely correct in review. There is a test that fires two concurrent requests
for one address and asserts exactly one 200 and exactly one payment.

**Limits are persisted.** Without that, "restart the faucet" means "reset every
limit", and a restart happens on every deploy — and on every crash, which an
attacker may be able to cause. State is written atomically (temp file, rename)
so a crash mid-write cannot leave a half file that reads as "no limits".

**A failed broadcast releases the reservation, a broadcast that never confirms
does not.** In the first case the EMBER never moved; in the second it may yet.
Getting this backwards either locks users out for a day over a transient RPC
error, or lets them retry until one lands.

---

## The key

There is exactly one way in, and it is the environment.

```bash
HEARTH_FAUCET_PRIVATE_KEY=0x…              # or
HEARTH_FAUCET_KEY_FILE=/path/outside/the/repo
```

Three rules, each because of a specific way faucet keys leak:

1. **No default and no start without it.** A faucet that boots with a generated
   key looks healthy and funds nobody.
2. **The key file may not live inside this repository.** `.env` is gitignored,
   but `git add -f`, an editor backup, and a `cp` to a scratch file followed by
   `git add .` all defeat that. Refusing any path under the working tree is a
   rule a habit cannot beat. The file must also not be group- or
   world-readable.
3. **It is never logged.** The value is registered at boot and redacted by exact
   match — not by pattern. The first version of that redactor matched anything
   64-hex-shaped and cheerfully destroyed every transaction hash in the log,
   which is worse than useless.

Observed:

```console
$ node src/index.js
no faucet key.
  Set HEARTH_FAUCET_PRIVATE_KEY=0x<64 hex>, or HEARTH_FAUCET_KEY_FILE=/path/outside/the/repo.

$ HEARTH_FAUCET_KEY_FILE=./secret.key node src/index.js
HEARTH_FAUCET_KEY_FILE points inside the repository (…/tools/faucet/secret.key).
  Refusing. Put it somewhere a `git add` cannot reach — ~/.hearth/faucet.key,
  a mounted secret, or your platform's secret store.

$ HEARTH_FAUCET_KEY_FILE=/tmp/k.key node src/index.js      # mode 644
/tmp/k.key is readable by group or other (mode 644). chmod 600 it.
```

The faucet also warns — loudly, and by name — if the key is Anvil's or
Hardhat's publicly known default account.

---

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HEARTH_RPC_URL` | `http://127.0.0.1:8645` (`src/env.js:92`) | Point it at **`https://rpc-testnet.cloudsforge.online`**, never at `https://rpc.cloudsforge.online` — a faucet on mainnet gives away the only EMBER there is. The estate's hosted faucet is a different service (`micro-faucet`, served at `https://network-testnet.cloudsforge.online/faucet`); this one is the reference implementation |
| `HEARTH_CHAIN_ID` | `7411` (`src/env.js:94`) | **The shipped default is the MAINNET id, and that is the wrong default for a faucet — set `7412` explicitly.** A mismatch against the node is fatal at boot, which is the safety net: a testnet faucet pointed at mainnet is an unauthenticated withdrawal endpoint |
| `HEARTH_FAUCET_PORT` / `_HOST` | `9646` / `127.0.0.1` | |
| `HEARTH_FAUCET_DRIP_EMBER` | `10` | |
| `HEARTH_FAUCET_ADDRESS_COOLDOWN_S` | `86400` | |
| `HEARTH_FAUCET_IP_LIMIT` / `_IP_WINDOW_S` | `3` / `86400` | |
| `HEARTH_FAUCET_DAILY_CAP_EMBER` | `1000` | the control that bounds the loss |
| `HEARTH_FAUCET_MAX_BALANCE_EMBER` | `100` | refuse an already-funded address |
| `HEARTH_FAUCET_RESERVE_EMBER` | `1` | stop cleanly rather than broadcasting transactions the node will reject |
| `HEARTH_FAUCET_GAS_PRICE_WEI` | `1000000000` | 1 gwei; legacy pricing, v1 has no fee market |
| `HEARTH_FAUCET_TRUST_PROXY` | `false` | see below |
| `HEARTH_FAUCET_STATE` | `./faucet-state.json` | |
| `CORS_ORIGINS` | *(none)* | allowlist, never `*` |

**`HEARTH_FAUCET_TRUST_PROXY` has no safe default.** `x-forwarded-for` is a
request header — the client writes it. Trust it while directly exposed and the
per-IP limit is decorative, because an attacker sets a different one per
request. Do not trust it behind nginx and every user in the world shares the
proxy's address, so the third visitor is locked out. It is a setting because
there is no answer that is right in both deployments.

---

## Operating it

There is **no TLS and no authentication** here, exactly like the node itself.
Put it behind a reverse proxy, bind it to loopback, and turn `TRUST_PROXY` on
only once something in front of it overwrites the header. It warns on startup if
you bind `0.0.0.0` without it.

The signing is not reimplemented: it is `node/src/chain/transaction.js`, the
tree's own codec, whose canonicality rules, low-S enforcement and EIP-155 `v`
are pinned against published vectors. A faucet that hand-rolled RLP would be the
one place in the repository where a transaction is built by untested code. A
test asserts every drip is EIP-155 bound to chain 7411 — an unprotected pre-155
signature would be replayable on any chain that accepts them, and the faucet
holds the only key that matters.

Sends are serialised through one promise chain with a locally held nonce.
`eth_getTransactionCount(addr, "pending")` counts what the node has *seen*; ask
it twice before the first transaction reaches the mempool and it answers the
same number twice, so the second transaction replaces the first instead of
following it and one user never gets paid.

---

## Docker

```bash
docker build -t hearth-faucet tools/faucet
docker run --rm -p 9646:9646 \
  -e HEARTH_RPC_URL=http://host.docker.internal:8645 \
  -e HEARTH_FAUCET_HOST=0.0.0.0 \
  -v /run/secrets/faucet.key:/run/secrets/faucet.key:ro \
  -e HEARTH_FAUCET_KEY_FILE=/run/secrets/faucet.key \
  -v hearth-faucet-state:/state -e HEARTH_FAUCET_STATE=/state/faucet-state.json \
  hearth-faucet
```

The state volume is not optional in production: without it every restart is an
amnesty.
