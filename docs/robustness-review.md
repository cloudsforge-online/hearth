# Robustness and resource-bounds review — `node/src`

A read-only review of the EVM, state and chain layers, looking for places where the
work a node performs is not proportional to the gas (or the bytes) it charges for,
and for malformed input that escapes as a throw rather than a returned failure.

**Nothing in this repository was modified when this review was written.** Where a
finding has since been fixed, the fix is recorded in a subsection under it, with
before-and-after numbers from the same machine — the original text is left
standing because a review that quietly edits itself into agreement with the code
cannot be audited.

**Method.** Every file under `node/src/evm`, `node/src/state`, `node/src/chain`, plus
`chain.js`, `tx.js`, `block.js`, `pow.js`, `p2p.js`, `mempool.js`, `params.js` and the
crypto modules was read in full. Every quantitative claim below was then measured by
running the real code — the numbers are from this machine and are reproducible with
the commands quoted alongside each finding.

**Environment for all timings:** Node v24.14.0, darwin arm64, Apple M1 Pro, single
thread. Absolute figures will differ elsewhere; the *ratios* are what carry the
argument, and they are what should be re-checked on other hardware.

---

## Standing on the ground first: what is live and what is latent

This matters for how you read the ranking, so it is stated before the findings.

Two chains live in this tree and they are not connected to each other:

- **The UTXO chain** — `chain.js`, `tx.js`, `mempool.js`, `p2p.js`, `block.js`,
  `pow.js`. This is what `bin/hearthd.js` runs. It is listening on a socket today.
- **The EVM** — `evm/`, `state/`, `chain/`. This is the 20,000 lines of
  conformance-tested consensus code. `bin/hearthd.js` does not require it; it is
  reached from `src/jsonrpc/methods.js` and `src/cli/`, and there is no
  `applyBlock` on any network path yet.

So findings **2**, **3** and **5** are exploitable against a running `hearthd` now.
Finding **1** was the most serious defect in the codebase and was latent only
because nothing called `applyBlock` on a network path. That is no longer true —
`evmnode.js` mounts the chain — and finding 1 is fixed and gated; see the
subsection under it.

---

## Findings, ranked by practical impact

### 1. `StateDB` re-roots both tries on every single mutation: 1.66 KB permanently retained and 245 µs of CPU for 112 gas

**Severity: critical (latent — blocks the EVM going live).**
`node/src/state/statedb.js` (`setStorage`) (`setBalance`) (`_write`), and `node/src/state/trie.js` (`_ref`).

`setStorage` writes the slot, then immediately asks the storage trie for its root,
then writes the account record — which re-roots the *state* trie too:

```js
// statedb.js
setStorage(addr, slot, value) {
  const st = this._storageTrie(hex);
  ...
  if (v.length === 0) st.del(toWord(slot));
  else st.put(toWord(slot), RLP.encode(v));
  a.storageRoot = st.root();          // <- hashes the storage trie now
  this._write(hex, a);                // <- and the state trie now
}
```

Each of those walks re-encodes and re-hashes every node on the path and, at
`trie.js`, unconditionally inserts each one into the node store:

```js
_ref(node) {
  const enc = RLP.encode(node);
  if (enc.length < 32) return node;
  const h = keccak256(enc);
  this.db.put(h, enc);                // never journaled, never pruned
  return h;
}
```

`MemoryDB` (`trie.js`) is an append-only `Map` with no eviction. This is not an
oversight — revert correctness *depends* on old roots staying resolvable
(`_storageTrie` reconciles a stale trie by re-opening it at the account's root). The
defect is not "the store does not prune", it is **materialising a root per write in
the first place**. Real clients keep the trie dirty and hash once, at the end of the
block.

**Measured, in isolation** (20,000-account state trie, one storage slot):

```
setStorage x20000: 2251ms => 112.5us each; nodes +119527  bytes +33.1MB => 1655 bytes per SSTORE
setBalance x20000: 1733ms =>  86.6us each; nodes  +79996  bytes +28.9MB => 1447 bytes per account write
```

**Measured end to end through the interpreter.** A loop of dirty SSTOREs to one slot
— `DUP1 PUSH1 0 SSTORE PUSH1 1 ADD`, 112 gas per iteration once the slot is dirty
(EIP-2200 row 7, 100 gas) — given one full block's gas:

```
accounts=  1000 | 38059ms | used=30000000 | NEW trie nodes retained: 1064860 | 245.1MB | 8.17 bytes/gas | 0.79 Mgas/s
accounts= 20000 | 65144ms | used=30000000 | NEW trie nodes retained: 1597290 | 442.6MB | 14.75 bytes/gas | 0.46 Mgas/s
```

**The arithmetic.** 30,000,000 gas ÷ 112 gas per iteration = ~266,000 SSTOREs.
Each costs 6.6 new node-store entries, 1,664 bytes and 245 µs. So one transaction
inside one block's gas limit costs every node on the network:

- **65 seconds of single-threaded CPU**, against a 15-second target block time
  (`params.js`) — 4.3× the block interval;
- **443 MB of heap retained for the life of the process**, at 14.75 bytes per gas.

And the transaction in the measurement above **runs out of gas and reverts**. Every
one of those 443 MB is garbage that no state root will ever reference again. Nothing
removes it, because `db.put` is outside the journal.

The cost also scales with the *width of the state trie*, which the attacker does not
pay for: doubling the account count from 1,000 to 20,000 raised the retention 80% and
the time 71%, for identical gas.

The two effects compound. 0.46 Mgas/s is **135× slower per gas than this
implementation's own plain-compute baseline** (62.2 Mgas/s, measured below) and 5×
worse than the next-worst opcode. Nothing else in the file measures close.

**What to change.** Defer hashing: let `setStorage`/`setBalance` mark the account
dirty and compute `storageRoot` and the state root once per transaction (or per
block), the way `finalize()` already ends the transaction. That removes both the
per-write keccak path and the per-write node insertion. If the write-through model is
kept for revert simplicity, then `db.put` must at minimum be reference-counted against
live roots, and the per-write cost has to be reflected in the SSTORE price — but
deferring is what every other client does and is much the smaller change.

### What was changed, and what it measures now

**Done, and gated.** Two edits, both deferrals:

- `trie.js` no longer hashes as it writes. `_put`/`_del` leave rebuilt nodes as
  objects and `_commit` applies the hashing rules — including rule 2 — bottom-up
  at `root()`. `_deref` already resolved an object to itself, so every read path
  was unchanged.
- `statedb.js` `_write` records the account in the cache and marks it dirty;
  `_flush` puts the dirty records into the state trie, and `root()` is what calls
  it. The cache was already the source of truth for reads and for undo, so the
  trie only has to be correct when somebody asks for the root — which is once per
  transaction, at `beginTransaction` and `finalize`.

The same 30M-gas SSTORE transaction, same machine, before and after:

| | before | after |
| --- | --- | --- |
| wall clock | 35.3 s | **5.2 s** |
| retained | 212.1 MiB | **9.2 MiB** |
| vs. an ordinary block of the same gas | 64.3x | **13.5x** |
| 5x the state trie width | 1.31x the time | **1.00x** |

`node/test/bench/block-execution.js` is that measurement as a gate: it fails
above 25x an ordinary block or 64 MiB retained, and both bounds are crossed by
the code as it was.

**The correctness argument is the corpus.** Deferred hashing is only safe if it
produces byte-identical roots, and nothing short of the published vectors
establishes that: the full **GeneralStateTests corpus was re-run against the
change — 20,077/20,077 vectors, 60,231/60,231 checks, 0 failed**, alongside all
25 TrieTests at every insertion permutation (`test/trie.js`, 315) and the eight
published state roots in `test/statedb.js`.

**What is NOT deferred: the storage root.** `setStorage` still does
`a.storageRoot = st.root()` on every write, which commits one storage-trie node
per mutation — about a third of the 5.2 s above, and all 9.2 MiB of the
retention. Deferring it too means journalling storage at the SLOT level (the
account record's `storageRoot` can no longer stand in for the trie's contents at
a snapshot) and reworking the reconciliation in `_storageTrie`, which is a
change to how revert works rather than to when hashing happens. It is worth
doing and it is not done; the dominant term — the state-trie re-root per
mutation, which is what made the cost scale with everyone else's account count —
is.

---

### 2. An anonymous peer buys a full copy of the UTXO set with a 39-byte message, and `tx` gossip has no verification budget at all

**Severity: critical (live today).**
`node/src/mempool.js`, `node/src/p2p.js`, `node/src/rpc.js`.

`Mempool.add` copies the entire UTXO set and replays the entire mempool **before**
validating anything:

```js
// mempool.js
const scratch = new Map(this.chain.utxo);                      // O(|UTXO|)
for (const { tx: pooled } of this.txs.values()) TX.applyToUtxo(pooled, scratch);  // O(|mempool|)
const r = TX.validateNormal(tx, scratch, this.chain.height + 1);
```

`validateNormal`'s very first line is `if (!tx.inputs || tx.inputs.length === 0)
return { ok: false, err: 'no inputs' }`. So an input-less transaction pays the whole
copy and is then thrown away. Because nothing is ever admitted, the `this.txs.has(tx.id)`
dedup at `mempool.js` never fires — **the identical message can be replayed verbatim**.

The message that does it is 39 bytes on the wire:

```
{"t":"tx","tx":{"id":"a","outputs":[]}}
```

`p2p.js` gates it on `typeof tx.id === 'string'` and nothing else. Unlike `block`
and `blocks`, which go through `_acceptFrom` and its token bucket, `tx` messages have
**no per-peer budget, no invalid counter and no rate limit**. `POST /tx` on the HTTP
RPC (`rpc.js`) reaches the same function with the same absence of limits.

**Measured** (`Mempool.add` with an input-less transaction, mean of 20):

```
utxo=  10000 | 0.9ms per message   | 1124 msgs/s a peer can force
utxo= 100000 | 13.0ms per message  |   77 msgs/s
utxo=1000000 | 354.0ms per message |    3 msgs/s
```

**The arithmetic.** At a million UTXOs — a chain this is explicitly sized for
(`MEMPOOL_MAX_TXS: 50_000`, `MAX_MONEY: 90M EMBER`) — 39 bytes of input buys 354 ms of
blocked event loop. That is **9 ms of CPU per byte sent**.

It gets worse from the framing. `p2p.js` drains every complete line in the read
buffer inside one synchronous `data` handler:

```js
while ((nl = buf.indexOf('\n')) >= 0) { ... this._onMsg(sock, JSON.parse(line)); }
```

`P2P_MAX_LINE` (4 MiB) bounds a frame *without* a newline; it does not bound how many
newline-terminated messages arrive at once. A single 4 MiB write holds ~107,000 of
these messages, and the handler will process all of them before yielding. At 10,000
UTXOs that is 96 seconds of a wedged event loop from one TCP write; at a million it is
over ten hours.

**What to change.** Three independent fixes, and all three are worth having:
validate before copying (`validateNormal`'s cheap structural checks need no UTXO set at
all); replace the copy-and-replay with an incremental pending-spend set maintained
across `add` calls; and put `tx` messages behind the same per-peer budget `_acceptFrom`
already gives blocks. Bounding messages-per-`data`-event would also stop the framing
amplification generally.

---

### 3. A self-fed side branch mines at 1-in-64 forever, and every block on it is stored, persisted and relayed permanently

**Severity: high (live today).**
`node/src/chain.js` (`_nextTarget`) (`_ingest` fork path) (`_stateAt`) (`_persist`); `node/src/params.js` (`MAX_TARGET`).

`_nextTarget` computes difficulty from *the branch the block is on*, which is correct
for fork-choice but means an attacker's branch retargets against the attacker's own
blocks. Two things then compound:

- `_nextTarget` returns `GENESIS_TARGET` unconditionally for any parent below height 2
  (`chain.js`), and `GENESIS_TARGET` is 1-in-256 — trivially mineable no matter how
  hard the real chain has become.
- `MAX_TARGET` (`params.js`, `0x03ff…`) is **easier than `GENESIS_TARGET`**: 1-in-64.
  The LWMA clamps `solve` at `TARGET_BLOCK_TIME * 6 = 90 s`, so a branch whose
  timestamps are 90 s apart multiplies its target by 6 each block until it pins at the
  clamp.

**Measured** — replaying the exact recurrence from `chain.js` on a self-fed
branch with 90-second spacing, and `homefireHash` timed at **6.84 ms** per evaluation:

```
branch height 1  1 in 256  => 1.75s/block of one core
branch height 2  1 in 256  => 1.75s/block
branch height 3  1 in  64  => 0.44s/block     <- pinned at MAX_TARGET
branch height 4+ 1 in  64  => 0.44s/block
```

Every block on that branch is fully valid: it passes `_validate`, is stored in
`this.store` (an unbounded `Map`), is appended to `blocks.ndjson`, and is **relayed to
every peer** (`p2p.js`, because `_ingest` returns `{ok: true}` even when the branch
does not win the fork choice). It never reorgs, so nothing ever cleans it up.

The verification budget does not touch this. `_acceptFrom` (`p2p.js`) explicitly
refunds the token whenever `r.ok`, and `cfInvalid` is only incremented on `wasted`
work. Every one of these blocks is `ok`.

**The arithmetic, and the quadratic.** `_ingest`'s fork path calls
`_stateAt(hdr.prevHash)` (`chain.js`), which replays the branch from genesis. For a
branch of length L the victim performs **O(L²)** block applications while the attacker
pays **O(L) × 0.44 s**. At L = 10,000 — 73 minutes of one attacker core — a victim
performs ~50 million block applications, stores 10,000 blocks forever, relays all of
them to every peer, and adds 10,000 × 6.84 ms = **68 seconds of Homefire to every
subsequent restart**, because `load()` re-validates every persisted block
(`chain.js`).

Timestamps are not a constraint: forking from genesis (`timestamp 1750000000`, June
2025) against a `MAX_FUTURE_DRIFT_S` of 7,200 leaves ~34 million seconds of headroom —
about 380,000 blocks at 90-second spacing.

**What to change.** `MAX_TARGET` must not be easier than `GENESIS_TARGET`, and the
`parent.height < 2` shortcut should not hand out the genesis difficulty at arbitrary
chain heights. Beyond that, side branches need a bound: a maximum depth below the tip
below which a fork is not stored at all, and a cap on stored branch blocks. `_stateAt`
being O(chain) per fork block is the quadratic; an incremental undo along the reorg
path would remove it.

---

### 4. The RLP decoder recurses once per nesting level and blows the JS stack at depth 2,823

**Severity: medium.** `node/src/crypto/rlp.js` and (`item` ↔ `items`).

`item` calls `items` calls `item`, with no depth counter. Each `0xc1` byte adds one
level, so nesting depth is bounded only by input length.

**Measured:**

```
$ node -e '...binary search over Buffer.alloc(n, 0xc1)...'
stack overflow at nesting depth ~ 2823
```

`MAX_TX_BYTES` is 100,000, so a transaction is allowed to be 35× deeper than the limit.

This is *not* currently a crash: the only untrusted caller is
`chain/transaction.js`, reached through `validate()`, whose `try/catch`
(`transaction.js`) turns the `RangeError` into `{ ok: false, code: 'RLP_ERROR' }`.
`receipt.js` decodes only locally produced receipts, and `statedb.js`/`336` and
`trie.js` decode only the node's own store.

I am reporting it anyway for two reasons. First, it is the one place in this codebase
where a malformed input produces a `RangeError` that is *indistinguishable from a
correctly-rejected transaction* — exactly the failure mode the interpreter's error
contract was built to prevent, and the one the brief singles out. `TX.decode` is
exported and is one careless direct call away from being an uncaught crash. Second, a
stack overflow unwinds through arbitrary frames; catching one and continuing is a
weaker guarantee than never generating it.

**What to change.** A depth counter threaded through `item`/`items`, rejecting past
(say) 64 levels. Ethereum's own structures nest three deep.

---

### 5. A `getblocks` page can exceed the receiving peer's own frame limit, and honest sync stalls

**Severity: medium (live today), and it is a liveness bug rather than an attack.**
`node/src/p2p.js`, `node/src/params.js` and.

The `getblocks` handler serves up to `P2P_MAX_BLOCKS` (200) whole blocks in one
newline-delimited JSON frame. The receiver drops any peer whose frame exceeds
`P2P_MAX_LINE` (4 MiB) (`p2p.js`).

```
P2P_MAX_BLOCKS x MAX_BLOCK_BYTES = 400 MB   P2P_MAX_LINE = 4.2 MB
=> a page overflows the receiver's frame limit once average block size exceeds 20.5 KB
```

`params.js` reasons that "MAX_BLOCK_BYTES is well under P2P_MAX_LINE so a full block
still fits one frame" — true for the `block` message, but `blocks` carries 200 of them.
The invariant holds for one message type and not the other, and nothing enforces it.

At an average block size of 20.5 KB — 1% of what `MAX_BLOCK_BYTES` permits, and easily
reached by a chain carrying records — two honest nodes will permanently fail to sync:
the server sends a legal page, the client warns "oversized frame" and destroys the
socket, the client reconnects and asks again. Sync never advances past that point.

**What to change.** Bound the page by bytes, not by count: fill until either
`P2P_MAX_BLOCKS` or a byte budget comfortably under `P2P_MAX_LINE` is reached. The
serving side already knows both numbers.

---

### 6. Absolute gas throughput is 20–100× below what the Ethereum schedule assumes, against a 15-second block time

**Severity: medium — a calibration observation, not a bug.**

The Shanghai gas schedule is calibrated so that a native client validates 30M gas in
roughly 100 ms. `evm/gas.js` reproduces that schedule exactly and correctly. What it
cannot do is make a BigInt interpreter run at native speed, and the *spread* between
the cheapest and dearest gas is what decides how much headroom exists between honest
load and a denial of service.

Measured through the real interpreter and the real precompiles, 30M gas of each:

| Workload | Mgas/s | Time to validate one 30M-gas block |
|---|---:|---:|
| `PUSH1`/`ADD`/`POP` (baseline) | 62.2 | 0.48 s |
| `EXP(2, 2²⁵⁶−1)` | 130.5 | 0.23 s |
| `identity` / `sha256` / `ripemd160` (0x02–0x04) | 700–1500 | < 0.05 s |
| `MULMOD`, full-width operands | 9.0 | 3.3 s |
| `KECCAK256` of 32 bytes | 7.0 | 4.3 s |
| bn128 pairing (0x08) | 6.5 | 4.6 s |
| `blake2f` (0x09) | 2.8 | 10.7 s |
| `modexp` 32/32/32 (0x05) | 2.6 | 11.6 s |
| **SSTORE dirty rewrite** (finding 1) | **0.46** | **65 s** |

`TARGET_BLOCK_TIME` is 15 s. Ignoring finding 1, a block filled with `blake2f` or small
`modexp` calls takes 10–12 seconds of one core to validate — most of the block
interval, with nothing left for networking, and no margin for a slower machine.

Two notes on individual rows. `blake2f`'s one-gas-per-round price is caller-chosen
(`precompiles.js`), so a *single* CALL can consume 30M gas and 10.7 seconds in one
uninterruptible loop — the most concentrated work-per-call in the file. `modexp` is
worst at *small* operands, not large: 32/32/32 with a full-width exponent charges 1,360
gas for 0.53 ms, whereas 2048/32/2048 charges 5.5M gas for 40 ms. The EIP-2565 formula
is implemented correctly; it is the fixed overheads of BigInt that make small operands
expensive here.

I do not think any of this blocks launch on its own. It does mean the safety margin
between honest load and a wedged node is roughly two orders of magnitude thinner than
on a native client, and the block gas limit should be chosen with these numbers in hand
rather than by copying Ethereum's 30M.

---

### 7. Smaller items

- **State reads outside the `try` in `EVM.call` and `EVM.create`.**
  `interpreter.js` (`toAddr`, `getBalance`) and (`getBalance`,
  `getNonce`) run before the `try` block that produces `_crash`. A `trie: missing node`
  or a non-canonical-storage-value error thrown from `_load` at that point escapes
  `EVM.call` as a throw, and `statetransition.js` calls it with no `try/catch`. Only
  reachable with a corrupt node store, but the return-don't-throw contract is meant to
  be absolute, and moving the `try` up two lines costs nothing.
- **`Trie.get` does not advance on a zero-length extension node.** `trie.js`:
  a node decoding to `nibbles.length === 0` and `isLeaf === false` leaves `i` unchanged
  and follows `node[1]`, so a chain of such nodes loops forever. `_put`/`_del` cannot
  construct one (extensions are only built with `cpl !== 0` or `sub.length`), and a
  hostile node would have to hash to an address the trie already asked for, so this is
  not reachable today. It becomes reachable the moment any form of state sync accepts
  nodes from a peer.
- **`Trie` node-shape validation.** `_deref` (`trie.js`) returns whatever RLP
  decodes to. `hpDecode` on an array yields `NaN` comparisons that all pass, so a
  malformed node produces nonsense rather than an error. Same reachability caveat as
  above; worth a shape check before any sync path exists.
- **Journal growth.** `_mutable` (`statedb.js`) pushes a closure and a fresh
  account copy per mutation. The SSTORE loop in finding 1 accumulates ~266,000 of them,
  roughly 40 MB — secondary to the 443 MB, but it is the same root cause and the same
  fix removes it.
- **`chain.js` linear scans.** `balance()`, `supply()` and `utxosFor()`
  (`chain.js`) walk the whole UTXO set. They are reached from `rpc.js`'s
  `/address/:addr` and `/supply`, which are unauthenticated. At a million UTXOs that is
  tens of milliseconds per request with no cache and no rate limit. Much smaller than
  finding 2, and mentioned because it is the same shape.

---

## Examined and found sound

Recorded in as much detail as the findings, because knowing where not to look again is
the other half of the value.

**Allocation sites gated on gas.** Every one was traced from the allocation back to the
charge:

- `Memory.charge`/`charge2` compute cost without allocating; `Memory.expand` is called
  only after `f.gas -= px.cost` at `interpreter.js`. The ordering comment at the
  head of `memory.js` is accurate and the code matches it.
- `getData` (`precompiles.js`) is called with a size that is either a constant (32
  for `CALLDATALOAD`) or one that has already been priced through `copyWordsCost` plus
  memory expansion (`CALLDATACOPY`, `CODECOPY`, `EXTCODECOPY` at
  `interpreter.js`).
- `Memory.read` at `KECCAK256`, `LOG0-4`, `RETURN`, `REVERT`, `CREATE`/`CREATE2` and the
  CALL family's input buffer is in every case preceded by a `charge`/`charge2` for the
  same range in `_price`.
- `modexpRun`'s allocations are behind `MODEXP_MAX_LEN` (`precompiles.js`) as well
  as the gas.

**`gas()` before affordability.** All nine precompile `gas` functions are O(1) in input
length, verified by measurement — calling all nine 200 times over a 1 MB input takes
0.8 ms, no slower than over a 1 KB input. `blake2fRounds` reads four bytes,
`bn128PairingGas` reads `input.length`, `modexpGas` reads three 32-byte headers plus at
most 32 exponent bytes. `_price` is likewise O(1) in every branch: `expCost` loops over
at most 32 exponent bytes, everything else is arithmetic. The one place `_price` touches
state before affordability is `originalStorage`/`getStorage` for SSTORE, which costs two
trie reads against a minimum 2,100-gas instruction whose frame then forfeits all its gas.

**Unbounded loops and recursion.** Call depth is capped at 1,024
(`interpreter.js`). `U.exp` and `modPow` are square-and-multiply over an
exponent bounded by the gas charged for it. `naf`/`f12Pow`/`g1Mul`/`g2ProjMul` all
iterate over fixed 254-bit constants. `p2p._connectOrphans` is bounded by
`P2P_MAX_ORPHANS` (32). `_locator` is memoised on `(tip, store size)`, which is exactly
the right key. The RLP decoder is the only unbounded recursion (finding 4).

**Nested-frame memory is genuinely bounded.** I expected the 3-gas-per-word linear term
to let 30M gas buy hundreds of megabytes spread across 1,024 frames. It does not —
EIP-150's all-but-one-64th rule starves the recursion long before the depth limit
binds. Instrumenting `Memory.expand` to track live bytes across the whole call stack:

```
per-frame   2KB  gasUsed=  154579  peak simultaneous EVM memory:  0.9 MB
per-frame   8KB  gasUsed=  402369  peak:  3.2 MB
per-frame  32KB  gasUsed= 1508620  peak:  9.4 MB
per-frame  99KB  gasUsed= 5315341  peak: 18.3 MB
```

Peak simultaneous memory tops out around 18 MB and the recursion cannot even spend the
30M gas. Sound.

**BigInt operand widths.** `U.exp` masks to 256 bits every step so intermediates never
exceed 512 bits. `U.mulmod`/`addmod` compute at full precision (correctly — truncating
first gives the wrong answer) with a 512-bit worst case. `U.shl`/`shr`/`sar` return
early for shifts ≥ 256, so the shift is bounded by 255 and the intermediate by 512 bits.
`signextend` bounds `k` at 31. None of these can be driven wide by input. `MULMOD`
measures 7× worse per gas than baseline, which is a property of the Ethereum schedule
(geth shows a similar ratio), not of this implementation.

**The trie under hostile key distributions.** The state and storage tries are secure
(`trie.js`, `secure = true` by default; `StateDB` takes the default), so keys are
`keccak256(key)` and the path is 64 nibbles regardless of what the caller chooses.
Forcing depth *d* costs 16^d grinding for a bounded win, and depth is capped at 64
anyway. The transaction and receipt tries are non-secure but keyed by `rlp(index)` over
at most `MAX_BLOCK_TXS` entries, giving 1–2 byte keys — short, bounded, no adversarial
prefix. Embedded sub-32-byte nodes are handled consistently: `_ref` returns the node
array, `_deref` passes an array straight through, and `_put` mutating an embedded child
in place is safe because the parent is rewritten on the same path. `_collapseBranch` and
`_join` read but never mutate the child.

**Aliasing between the node store and decoded values.** `RLP.cut` (`rlp.js`) copies
rather than sub-arraying, so a decoded trie node cannot alias — let alone mutate — the
stored encoding. This is load-bearing given that `_put` mutates node arrays in place,
and it is right.

**Canonical-encoding enforcement.** I looked for a decoder without a minimality rule and
did not find one. `rlp.js` rejects leading-zero long-form lengths, long form where short
fits, a single byte below 0x80 not encoded as itself, lengths that overrun their buffer
*and* lengths that overrun their enclosing list (`items`, `rlp.js` — the one that is
usually missed), and trailing bytes. `transaction.js` applies the scalar rule
per-field with width bounds. `statedb.js` applies it to nonce and balance and
enforces 32-byte `storageRoot`/`codeHash`. `statedb.js` rejects a storage value with
a leading zero, empty, or over 32 bytes. `receipt.js` applies the same rule to
`status` and `cumulativeGasUsed`. `trie.js` rejects a flag nibble above 3 and a
non-zero padding nibble on an even path. `jsonrpc/hex.js` is strict about QUANTITY vs
DATA. That is comprehensive.

**The low-s split, both directions.** Verified by executing both paths with the same
signature:

```
tx with high-s: rejected -> INVALID_SIGNATURE_VRS      (transaction.js, EIP-2)
same high-s sig through ecrecover: recovers (correct)  (precompiles.js, {lowS:false})
```

Both still hold. `secp256k1.verify` defaults `lowS` to true and the precompile passes
`false` explicitly, as its comment says.

**Journal and revert.** Warming an address inside a snapshot and reverting it leaves the
address cold — verified directly, and verified again end to end: a CALL whose upfront
cost (2600 cold + 9000 value + 25000 new account) exceeds the frame's gas returns
`out of gas` with `gasLeft: 0` and leaves the target **cold**, while the same CALL with
enough gas succeeds and leaves it warm. The asymmetries are right too: gas bought and
the outermost nonce increment survive a failed transaction because they are applied
after `beginTransaction` clears the journal and before `EVM.call` takes its snapshot
(`statetransition.js`); the creator's nonce bump survives a failed CREATE
because `create` reassigns `snapshot` after it (`interpreter.js`); and the
collision path returns without reverting, which matches geth, where the snapshot is
likewise taken after the collision check.

**`Number`/`BigInt` boundaries.** `isNormalized` (`transaction.js`) now checks
`Buffer.isBuffer(tx.data)` alongside the nonce, which is the fix for the hex-characters-
as-bytes bug and is correct. Every `Number(bigint)` conversion in `memory.js`,
`precompiles.js:getData` and `gas.wordCount` sits downstream of a gas charge that makes
a value above 2⁵³ unaffordable. `readLen` (`rlp.js`) checks `Number.isSafeInteger`.
`toBytes` (`rlp.js`) refuses unsafe integers rather than coercing.

**Interpreter error contract.** Every exit from `_interpret` is a `result(...)`. The one
`throw` (`interpreter.js`, on a stack fault that would mean this file and
`opcodes.js` disagree) is inside `call`/`create`'s `try` and surfaces as
`internalError`, which `applyTransaction` propagates rather than crediting as a
correctly-failed transaction. `bn128` returns the `INVALID` symbol rather than throwing
for every decode failure. Precompile soft-fail (0x01–0x05, empty output + success) and
hard-fail (0x06–0x09, `null` + failed CALL) are wired correctly at
`interpreter.js`.

**Jump-destination analysis.** The `WeakMap` cache is effective in practice, which was
worth confirming rather than assuming: `StateDB.getCode` memoises on the code hash
(`statedb.js`) and returns the *same Buffer object* on every call, so
`analyseJumpdests` returns the same `Uint8Array` and a contract called 300,000 times is
scanned once. Verified for a 24 KB contract.

**`p2p` block handling.** The verification budget is correctly placed for `block` and
`blocks`: `_acceptFrom` spends a token before `verifyPow` and refunds it only when the
work turned out useful or cost no hashing. The reasoning in the `params.js`
comment is right and the code matches it. `isBlock` bounds `txs.length`, the locator is
bounded and validated, `getblocks` refuses to queue a second page while one is in
flight, and `chain._validate` orders its checks so that everything expensive sits behind
the proof — including the `MAX_BLOCK_BYTES` serialization, which is deliberately after
`verifyPow` and before the signature loop. Finding 3 is not a hole in any of that; it is
that a *valid* block on a worthless branch is not metered at all.

**`gas.js` itself.** Every constant checked against its EIP. The EIP-2200 truth table at
`gas.js` is correct row by row, including the 4,800/19,900/2,800 refund figures
and the `2100 + 2900 = 5000` cross-check. `callCost` applies all-but-one-64th after the
access, value, new-account and memory charges, in that order. `memoryExpansionCost`
takes the difference of two `C_mem` values rather than `C_mem` of the delta. Nothing to
add.
