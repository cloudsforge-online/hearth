# Records — application data on Hearth

> ### Records belong to the UTXO chain, and have no account-model successor
>
> Everything on this page is real, consensus-enforced and running — on the chain
> that is being retired. **Nothing in [`evm-spec.md`](evm-spec.md) carries records
> forward**, because on an EVM chain the same job is done by contract storage and
> event logs, which are strictly more capable and which every indexer already
> understands.
>
> That means `node/src/apps/chat.js` and `bin/hearth-chat.js` — the reference
> application built on records — have no future in their current form, and the
> `records` array, the `(app, key)` index, `GET /records` and the filtered SSE
> stream all retire with the ledger they belong to. Keep this page for what it
> documents; do not build anything new on it.

Hearth carries money. Records are the one place it also carries *bytes*, so that
things other than payments can be built on it without every one of them
inventing its own chain.

This document is the reference for the format, the rules, and what they cost.
The first application built on it is [chat](#chat), and it is deliberately not
special: it uses nothing the node reserves for itself.

---

## Why this exists

Before records there was nowhere to put a byte an application cared about:

- the signed transaction body was a closed seven fields — `net`, `version`,
  `type`, `inputs`, `outputs`, `height`
- an output is `{address, amount}` and nothing else
- there is no script system, no VM, and no contract

You could hang an extra key off a transaction object, and it would survive relay
and land in the block log — which made it look like a memo field. It was not
one. `txBody()` rebuilds the body from scratch, so anything extra is **excluded
from the txid, the input signatures, the merkle root and the block hash**. Any
relay could rewrite it and every node would still accept the block. Different
nodes would hold different bytes and never notice.

A record is inside the body. It is covered by all four.

---

## Format

```jsonc
{
  "app":  "chat",                 // namespace, /^[a-z][a-z0-9-]{1,15}$/
  "key":  "ember1e879…",          // optional index key, [0-9a-z._-]{1,72}
  "data": "0201c204d57f…"         // payload, lowercase hex
}
```

A transaction carries them in a `records` array:

```jsonc
{ "version": 1, "type": "normal", "inputs": [...], "outputs": [...],
  "records": [ { "app": "chat", "key": "ember1…", "data": "02…" } ] }
```

- **`app`** is a namespace so two applications cannot read each other's writes by
  accident. Pick one and stay in it.
- **`key`** is what the node indexes on. Without it a record is still stored, but
  finding it means scanning. With it, `GET /records?app=…&key=…` is a lookup.
- **`data`** is opaque to the node. It is never parsed, only counted and stored.

The **sender is not a field.** It is read off the transaction's inputs, where it
is signed. A record cannot claim to be from someone who did not sign for it.

### Backwards compatibility

`records` is omitted from the canonical body when empty. That is what keeps every
transaction signed before records existed hashing to the same id — the whole
chain still replays. *(Verified: a 900-block testnet replayed clean under the new
code.)*

Turning records **on** is still a hard fork. A pre-records node rebuilds the body
without them and computes a different txid, so it rejects the block.
`RECORDS_ACTIVATION_HEIGHT` in `node/src/params.js` is the coordination point;
below it, a record is not a small record, it is an invalid transaction.

---

## Limits

Unbounded data behind a flat fee is a denial of service, so all of this is
consensus, not policy:

| Rule | Value | Why |
|---|---|---|
| `MAX_TX_RECORDS` | 16 | records in one transaction |
| `MAX_RECORD_BYTES` | 4,096 | payload in one record |
| `MAX_TX_RECORD_BYTES` | 8,192 | payload across one transaction |
| `MAX_RECORD_KEY_LEN` | 72 | fits an `ember1…` address |
| `MAX_TX_BYTES` | 100,000 | there was no per-tx byte limit at all before |
| `MAX_BLOCK_BYTES` | 2,000,000 | nor a per-block one; well under the 4 MiB p2p frame |

A coinbase may not carry records. Nobody signs it, so a record in one would be a
write the miner alone chooses.

---

## Fees

```
fee = BASE_FEE_SPARKS + recordBytes × FEE_PER_RECORD_BYTE_SPARKS
    = 40,000          + bytes       × 100
```

Both halves are **burned**, not tipped to the miner. Paying a miner for data
would pay them to fill blocks with it.

A 180-byte chat message costs 0.00058 EMBER. A full 4 KiB record costs 0.0044.

The mempool bounds bytes as well as count — 50,000 transactions stopped being a
limit once one transaction can be 100 KB — and block selection ranks by **tip per
byte**, so a large data transaction cannot outbid a payment it is not worth more
than.

---

## Reading them back

| Endpoint | Use |
|---|---|
| `GET /records?app=&key=&since=&limit=` | records on the active chain, oldest first |
| `GET /tx/:txid` | the carrying transaction, its block, its confirmation depth |
| `GET /events?app=[&key=]` | SSE stream of matching records as blocks arrive |

Each hit carries `app`, `key`, `data`, `txid`, `height`, `blockId`, `timestamp`
and `from` — the address that signed the transaction.

Both indexes are rebuilt on reorg. A record on an abandoned branch is gone,
because as far as the chain is concerned it was never written.

`/events` without `?app=` is unchanged: a stream of new blocks, unnamed frames,
exactly as before.

---

## Privacy

A record is public and permanent. Encrypt anything private *before* it is signed
— `node/src/box.js` is the primitive for that, and it is not chat-specific:

> X25519 ECDH → HKDF-SHA256 → AES-256-GCM, from Node's built-in crypto. A fresh
> ephemeral keypair per message, so the sender's half of the exchange is
> discarded on send.

Wallets carry an X25519 **reading key** alongside their Ed25519 spending keys.
Deliberately separate: an application that needs to decrypt should never hold the
key that moves money, and a leaked reading key should not cost anyone a coin.

**What encryption does not hide:** that a message happened, how big it was, which
block it is in, and — because the index key is public by construction — who it
was for. That is the price of the record being findable at all. If you need the
recipient hidden, do not put it in `key`.

---

## Chat

The reference application. Two record kinds, both under `app: "chat"`.

| Kind | `key` | `data` |
|---|---|---|
| announce | your address | `0x01` ‖ X25519 reading key (32B) |
| message | recipient's address | `0x02` ‖ sealed box |

You must announce before anyone can write to you: nothing else on the chain maps
an address to a key worth encrypting to. An announcement only counts when the
address it names is the address that signed it, so nobody can publish a key they
hold and read your mail. A later announcement supersedes an earlier one — that is
key rotation.

Inside the sealed box is `{ v, body, sentAt, replyTo? }`. The sender is not in
it; it comes off the signed inputs.

```bash
node bin/hearth-chat.js announce
node bin/hearth-chat.js send ember1… "the grid went dark ninety days ago"
node bin/hearth-chat.js inbox
node bin/hearth-chat.js watch
```

A message is a record inside an ordinary payment, so it confirms when the block
does — **around 15s, not instantly** — and the chain's ceiling applies: 15s
blocks and 500 transactions per block by default is roughly 33 messages/second
network-wide. Chat on a chain is a different thing from chat on a server, and
this is where that shows.

---

## Building something else

Nothing above is reserved. Pick a namespace, decide what your `key` is, and
write bytes:

```js
const TX = require('./src/tx');
const record = { app: 'notes', key: 'shopping', data: Buffer.from('milk').toString('hex') };
const tx = wallet.buildTx(chain, wallet.primary, 1, [record]);   // fee covers the bytes
```

Then read them with `GET /records?app=notes&key=shopping`, or subscribe with
`GET /events?app=notes`. Encrypt first if it is not meant to be public.

See `node/test/records.js` for the consensus rules and a whole conversation
exercised end to end.
