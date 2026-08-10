# The mining key's custody

How to get a miner's coinbase key off a plaintext file **without losing the balance
that is at its address**, and what only a person can do.

Written for `cloudsforge-online/micro-org#206`. Every measurement below is dated and
was read off the live chain or the issue thread; nothing here is estimated.

---

## 1. Where the money actually is

There is one fact everything else follows from:

> **The coins are at an ADDRESS. Only the private key that derives that address can
> move them. Nothing else in the system can — not a database, not custody, not a
> node operator, not the chain's authors.**

For the mainnet miner that address is `0x980d52a868d41a34a186ce890874c8e547975b45`
on chain **7411**, and the private key that derives it is the 32 bytes in
`coinbase-key.json`.

| when | what was measured | value |
| --- | --- | --- |
| block 1733 | coinbase balance | 9,332.079 EMBER |
| 2026-08-06, block 7411-era | coinbase balance | 10,805.95 EMBER |
| 2026-08-09 | coinbase balance | **47,421.445463215 EMBER** |
| 2026-08-09 | coinbase **nonce** | 11 — that key has already sent eleven transactions |
| 2026-08-09 | accrual | ~5.4 EMBER/block at ~49 s/block ≈ **~400 EMBER/hour** |
| 2026-08-09 | cost of moving all of it | 21000 gas × 2 gwei = **0.000042 EMBER** |

The testnet coinbase is `0x91a11854b364178ed96054d8a6e9be1dbd751d33` on chain 7412
and is disposable. Do the whole of this on it first.

**Two traps, recorded so nobody re-derives them.** `eth_coinbase` on the RPC returns
a *different, empty* address than the block `miner` field — read the block, not the
method. And `cf-miner-mainnet` is not a node; it is `hearth-mine`, a light miner
pointed at the estate's RPC.

## 2. What signs, and why the key cannot simply be rotated

The key does **two** jobs, and the protocol binds them together:

1. it signs the **proof of work**. `node/src/mine/session.js` `_submit` calls
   `signProof`, and `node/src/chain/header.js` `verifyPow` *recovers the coinbase
   public key from that signature* and compares it to the header's. Work issued to
   you is redeemable only by you — that is the property, and it is worth having.
2. it signs **spends** from the address the reward was paid to.

Because of (1), a miner must hold, in memory, a key that can do (2). No encryption
at rest changes that. And because coins sit at an address, "rotating" the key in the
ordinary sense — replacing it and carrying on — abandons the balance.

So there are exactly two moves available, and the order they are done in is the
whole of the risk:

- **Rotate what FUTURE blocks pay.** Free, instant, no transaction, no fee, no
  accounting. The old balance stops growing and the key that guards it stops needing
  to be on a mining host.
- **Sweep the old balance.** One transaction, signed by the old key, which therefore
  has to be produced exactly once more.

Rotation first. It costs nothing and it is the step that shrinks the exposure.

## 3. What the code now supports

`node/src/coinbase.js` `resolveCoinbaseKey` takes the key from the first of these
that is configured:

| source | how | at rest |
| --- | --- | --- |
| `env` | `HEARTH_COINBASE_KEY` — 0x-hex, supplied at container-create time | never written to a disk |
| `env-file` | `HEARTH_COINBASE_KEY_FILE` — a docker secret, a tmpfs, a read-only mount. Takes bare hex **or** the existing `coinbase-key.json` shape | whatever that path is |
| `keystore` | `<data>/coinbase-keystore.json` + `HEARTH_COINBASE_PASSPHRASE_FILE` (or `…PASSPHRASE`) | scrypt N=2¹⁸, r=8, p=1 — 256 MiB and ~0.5 s per guess — then AES-256-GCM, with the address bound in as GCM additional data. `node/src/mine/keystore.js` |
| `plaintext` | `<data>/coinbase-key.json` | in the clear, mode 600 — what there was |

and two refusals that are the reason this is safe to do to a running miner:

- **`HEARTH_COINBASE_ADDRESS`** pins the address the resolved key must derive. Set it
  and a bind mount that did not come up **stops the miner** instead of generating a
  brand-new key and mining to it for three days. This is the worst accident
  available in this area and it is the only one with no recovery.
- **`HEARTH_COINBASE_SOURCE`** names the only source that may be consulted, and turns
  off key creation entirely. An operator who has moved to a keystore wants a refusal
  when it is missing, not a quiet fall back onto the plaintext file they believe they
  deleted.

A keystore that is present with no passphrase configured is **always** an error, even
when some other source would have worked. Falling through there is how a miner
mid-migration goes back to mining on the key being retired, with nothing looking wrong.

The verbs:

```
hearth minerkey status --data <dir>            # what is where, what it pays. Prints no key.
hearth minerkey seal   --data <dir>            # plaintext file -> encrypted keystore, same address
hearth minerkey new    --data <dir>            # a fresh key that never exists in the clear
hearth minerkey verify --data <dir> --address 0x…   # exit 0 / 1. The migration's proof.
```

`hearth minerkey` is deliberately **not** `hearth wallet`, even though both seal
secp256k1 keys. A wallet's job is to spend; a miner's key has to live on a machine
whose job is to hash. Two commands, two formats, two directories: the mining host
never holds a keystore that can pay anybody, and the machine that sweeps never holds
a mining key.

## 4. The migration, in the order it must be done

Each step is safe to stop after. None of them moves money except step 6.

### Step 0 — read-only mounts, no code, do it first

`/minerdata` is bind-mounted **read-write** into `cf-miner-mainnet` and
`cf-miner-testnet`, where the process runs as uid 1000. That means a compromised
miner can *overwrite* the key, not merely read it — a durability problem as well as a
confidentiality one. The miner only ever reads it. Flip both mounts to `:ro` in
`deploy/compose/docker-compose.miners.yml`.

With `HEARTH_COINBASE_SOURCE` set (step 2) there is no code path left that writes to
the data directory at all, so `:ro` is provably safe rather than merely observed to be.

### Step 1 — seal the existing key, keeping the address

On the host, with the directory still writable:

```
hearth minerkey seal --data /home/malf/dev/cloudsforge/miner-keys/mainnet
```

It asks for a passphrase, writes `coinbase-keystore.json` beside the plaintext file,
**reopens it and re-derives the address to prove it worked**, and leaves the plaintext
file exactly where it is. It never prints a key.

The passphrase is new key material. Generate it and never look at it:

```
umask 077 && openssl rand -base64 48 > /run/keys/coinbase-mainnet.pass
```

**The keystore and the passphrase must not share a medium.** That is the same rule
`deploy/docs/custody-backup-restore.md` §4.1 puts on the vault and the keyring, and it
is the rule that makes the keystore safe to put in a backup: the file alone opens
nothing. Put the keystore in the backup set. Do **not** put the passphrase there.

### Step 2 — point the miner at it

```yaml
environment:
  HEARTH_COINBASE_SOURCE: keystore
  HEARTH_COINBASE_PASSPHRASE_FILE: /run/secrets/coinbase-passphrase
  HEARTH_COINBASE_ADDRESS: "0x980d52a868d41a34a186ce890874c8e547975b45"
volumes:
  - /home/malf/dev/cloudsforge/miner-keys/mainnet:/minerdata:ro
secrets:
  - coinbase-passphrase
```

Restart. If anything is wrong the container **refuses to start with one line saying
which two addresses disagree** — it does not mine to something else. Prove it:

```
hearth minerkey verify --data /minerdata --address 0x980d52a868d41a34a186ce890874c8e547975b45
```

`hearth-mine`'s banner also now prints `key from …` instead of a file path, so the
source in use is visible in the container's first ten lines of log.

### Step 3 — rehearse the recovery, then remove the plaintext

Do not delete anything until a keystore + passphrase pair has been **restored from a
backup on a different machine** and re-derived the address there. The estate's own
key-backup rehearsal (2026-08-05) is the model, including its negative controls: the
host could not decrypt its own backup, and a freshly generated wrong identity
recovered 0 of 1.

Only then remove `coinbase-key.json`. It is the last moment the plaintext exists.

### Step 4 — ROTATE. This is the step that shrinks the number.

```
hearth minerkey new --data /minerdata-v2
```

A key that has never existed in the clear on that machine. Point the miner at the new
directory and the new `HEARTH_COINBASE_ADDRESS`, and restart.

From that moment:

- the old address stops growing;
- **the key guarding 47,421 EMBER is no longer on a mining host at all** — it lives in
  the backup and on paper, and is needed exactly once more, offline, at step 6;
- the hot key guards only what has accrued since the rotation.

Nothing in the estate is configured with the mainnet coinbase address — a search over
every repository on 2026-08-10 found it only in `deploy/docs/house-seed.md`,
`deploy/docs/estate-backup-restore.md`, `deploy/backup/src/secrets.test.ts` (a fixture)
and `admin-api/src/backups.test.ts` (a fixture). Rotating breaks no service. Update
`house-seed.md`; the two fixtures are fixtures.

### Step 5 — account for the eleven transactions. **Gating.**

That key's nonce is 11: it has already signed eleven transactions and nothing in
custody knows about any of them (`signing_audit` has 10 rows estate-wide). Somebody
must establish that all eleven are the operator's **before** the key is imported
anywhere. If they are not, the key is already compromised, and importing a compromised
key into custody imports the compromise.

### Step 6 — sweep, last, and not from this repository alone

```
hearth wallet import --label coinbase-mainnet-retired      # reads the key from stdin, not argv
hearth wallet send --from 0x980d…5b45 --to <destination> --value max
```

`--value max` sends **balance − fee** in integer wei. It is the one arithmetic nobody
should do by hand: one wei over and the transaction is refused after a human has
confirmed it; one wei under and the address you meant to empty still holds dust.
`node/test/coinbase-source.js` holds it to that, at the live 21000 gas × 2 gwei.

**The destination is not this repository's decision, and getting it wrong freezes EMBER
estate-wide.** `reconcile.ts` computes `drift = ledgerCustodyTotal − observedTotal`,
EMBER has no tolerance entry, and any non-zero drift refuses every EMBER withdrawal in
the estate until a clean run. Sweeping 47,421 EMBER into the pinned treasury
**without the accompanying ledger booking** replays micro-org#247 at 1,900×. The
booking, its `deposit_credited` kind, its accounts and the `confirmed`-transition
timing are specified in #206's scoping comment and belong to micro-settlement and
micro-custody. Do step 6 when those have landed, in their order, not before.

There is a second destination that needs none of it — an address no `watched_addresses`
row names — because then neither the observed total nor the ledger moves and drift stays
zero. It is safe today and it puts platform-mined coin outside custody. That is a
policy choice for the owner, not a technical shortcut.

**Sweeping is not urgent once step 4 is done.** That is the point of doing rotation
first.

## 5. What this does NOT fix, said plainly

A process that signs proofs holds a spendable key in memory. Encrypting it at rest
does not change that, and neither does an environment variable. What steps 1–3 buy is:
the key is not readable from the medium it is stored on, not readable from a backup of
that medium, and not destroyable by a container that can write to its data directory.
What step 4 buys is the large number: at ~400 EMBER/hour, a hot key that has been
rotated guards one accrual interval instead of a pile — and after step 6 it guards
whatever has arrived since, not 47,421 EMBER.

"The key is now safe" is not a sentence this document is willing to write.

## 6. What only the owner can do

These need key material in a human's hands. No script can do them, and none should try.

1. **Choose and hold the keystore passphrase.** Generate it as in step 1 —
   `openssl rand -base64 48` straight into a mode-600 file, never onto a terminal.
   Back it up **separately from the keystore**. Losing it loses everything the address
   is ever paid, with no recovery of any kind.
2. **Generate the production `age` identity — micro-org#214, #207.**
   `BACKUP_AGE_RECIPIENT` is unset, and the backup manifest says so itself: *"the miner
   coinbase key for mainnet is NOT in this set … The key remains on one disk with no
   backup until then."* Generate the identity **off the estate host**, on a machine
   that is not part of the estate. The identity (the private half) never touches the
   host, ever — that is the property the 2026-08-05 rehearsal proved by showing the
   host could not decrypt its own key backup. Give `deploy` only the **public
   recipient** string, for `BACKUP_AGE_RECIPIENT`.
3. **Make the paper/off-site copy**, per `deploy/docs/custody-backup-restore.md` §4.
   This is the only copy that survives losing both the host and the backup volume.
4. **Answer step 5** — the eleven transactions.
5. **Decide the sweep destination** (step 6), with micro-settlement.

## 7. How to prove each step, without showing anybody a key

Every check here is an **address comparison**, which is the same proof the estate's
backup rehearsal uses and for the same reason: an address is public, a key is not, and
a check you can run in front of somebody is a check that gets run.

| step | proof |
| --- | --- |
| 1 | `hearth minerkey seal` re-derives the address from the file it just wrote |
| 2 | `hearth minerkey verify --address 0x980d…5b45` exits 0; the container's banner prints the same address |
| 3 | the same `verify` passes on a **different machine**, from the backup |
| 4 | `verify` against the NEW address passes; the chain's `miner` field on new blocks is the new address |
| 6 | the old address's balance is 0 and the destination's has risen by exactly `balance − 0.000042 EMBER` |
