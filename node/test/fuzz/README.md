# `node/test/fuzz` — property fuzzing for the EVM stack

Every vector the EVM stack passes — 609 VMTests, 20,067 GeneralStateTests, 188
TransactionTests, 97 TrieTests — is **well-formed input somebody intended to
work**. Nothing in `test/` has ever fed this code random bytes. The bugs that
survive a conformance suite are exactly the ones that a suite of intended inputs
cannot express: a decoder that throws where it should reject, an allocation that
scales with an attacker-controlled length, a round trip that is not a round
trip, a function whose answer depends on which of two equivalent
representations the caller happened to use.

One such bug was already found by hand in merged code: `intrinsicGas` counted
hex characters as bytes and overcharged 192 gas, because the "is this already
normalised?" guard looked only at `nonce`. `target-transaction.js` contains the
general form of that check, and it still finds things — see **Findings** below.

Nothing here modifies `src/`. **If the fuzzer finds a bug, it reports it; it
does not patch it.**

---

## Running it

```bash
node test/fuzz/run.js                      # the CI pass: fixed seed, ~1.5s, ~100k checks
node test/fuzz/run.js --time=60            # a 60-second soak, split across the targets
node test/fuzz/run.js --seed=12345 --time=600
node test/fuzz/run.js --target=rlp --cases=500000
node test/fuzz/run.js --replay-only        # just the corpus
node test/fuzz/run.js --help
```

Output is the same shape as `test/unit.js` — a bullet per group, `✗` per
failure, `PASS — n/n checks`, non-zero exit on failure — so it drops into the
`npm test` chain without anyone learning a second format. Zero npm
dependencies; CommonJS; Node 22+.

Two modes and deliberately no third:

- **the default pass** is deterministic. Same seed, same cases, same result, on
  every machine. A CI job that fuzzes differently every run produces failures
  nobody can reproduce, gets marked flaky, and is then ignored.
- **the soak** (`--time=N --seed=M`) covers new ground. Its seed is printed at
  the top and repeated in every failure, so whatever it finds becomes a corpus
  file and then part of the deterministic pass forever.

---

## Reproducing a failure

Every failure prints its seed, its target and its case index:

```
  ✗ encode(decode(raw)) is byte-identical to raw   [seed=0xc0ffee target=transaction case=41822]
    repro: { "raw": { "$hex": "f86e81ab84…" }, "draft": { … } }
```

Three ways to get it back, in increasing order of convenience:

1. **The corpus file.** A failing case is written to `corpus/` automatically,
   named `<target>-<hash>.json`. `node test/fuzz/run.js --replay-only` re-runs
   every corpus entry in milliseconds. This is the one to use — the corpus runs
   *before* new cases on every invocation, so a regression is caught
   immediately rather than whenever the seed happens to wander back.
2. **The same seed and target.** Each target draws from its own stream, derived
   from the run's seed and the target's name, so
   `node test/fuzz/run.js --seed=0xc0ffee --target=transaction` replays exactly
   the cases that target saw — regardless of what the other targets were doing.
3. **The `repro:` line.** It is the corpus file's contents, inline. Buffers are
   `{"$hex": "…"}` and BigInts are `{"$big": "…"}`; `harness.js` exports
   `decodeJson` to read them back.

`--no-save` suppresses corpus writes, for when you are exploring rather than
recording. At most 12 files are written per run, so a broken invariant cannot
fill the directory.

---

## The targets, and the property each one holds

| Target | Property |
| --- | --- |
| `target-rlp.js` | `decode(encode(x))` deep-equals `x`. **Anything the decoder accepts re-encodes to itself byte for byte** — the strong form of "one object, one encoding", which subsumes the whole invalid-vector table. Random bytes either decode or throw a typed `rlp:` error, never hang and never return garbage. Decoding stays linear in the bytes *present*, not the length *claimed*. No decoded Buffer aliases the input. |
| `target-transaction.js` | For every accepted transaction, `encode(decode(raw)) === raw` byte for byte — the whole defence against two byte strings meaning one transaction. The decoder's contract (minimal scalars, width bounds, the nonce cap, the gas product, `r`/`s` in `[1, n)`, low-s, `v` either 27/28 or EIP-155 over this chain id) is **restated independently** in `mustReject()` and checked against the implementation. `validate()` never throws, for any input at all. Every exported function behaves as if `normalize()` had run. |
| `target-trie.js` | The root is a function of the key/value set and nothing else: same set, any insertion order, one root. Deleting a subset gives the root of never having inserted it. Deleting everything gives `EMPTY_TRIE_ROOT` exactly. `get` after `put` for every key. Re-opening the store at the root reads every key back — which is the 32-byte embed rule tested from the other side. Keys share long prefixes and values straddle 31/32/33 bytes on purpose. |
| `target-uint256.js` | Differential against a second reference that disagrees about *how*: masking by `%` rather than `&`, two's-complement read bytewise off the 32-byte layout, `sdiv`/`smod` from magnitudes and signs separately, `exp` square-and-multiply from the other end of the exponent. Results are always canonical words. Nothing throws. `sdiv(MIN_INT256, -1)` and friends are generated on every run, not left to chance. |
| `target-interpreter.js` | **It always returns and never throws**, and the result never carries `internalError`. Bounded gas means bounded time. `0 <= gasLeft <= gas`, and every exceptional halt but `REVERT` leaves exactly zero. The same program in the same world gives the same answer twice, down to the state root. |

Why the interpreter's rule is the one that matters most: the conformance
harness treats a JS throw as a harness `ERROR`, so a real fault in the machine
is indistinguishable from a correctly-rejected transaction — which makes the
vectors that assert *failure* the easiest ones in the corpus to fake, and makes
a live node's rejection of a valid transaction look like correct behaviour.

---

## Findings

Reported, not patched — this directory adds tests and does not touch `src/`.
Each is printed as a `!` observation on every run so it cannot be forgotten,
and each is written so the check goes **red the day it is fixed**, at which
point the pin should be deleted.

### 1. `RLP.decode` has no nesting cap — stack exhaustion, and it is not deterministic

`item()` and `items()` in `src/crypto/rlp.js` recurse once per nesting level.
The maximum nesting an input can request is bounded by the input's length and
by nothing else, so roughly 2,500–4,000 levels — **7–12 KB of input, well
inside `MAX_TX_BYTES` (100,000) and the RPC body cap (108,192)** — exhaust the
JavaScript stack:

```js
// a properly nested [[[…]]]; test/fuzz/target-rlp.js exports nestedBytes()
RLP.decode(require('./test/fuzz/target-rlp').nestedBytes(4000));
// RangeError: Maximum call stack size exceeded
```

Two things about this, in order of importance:

- **The threshold moves.** A `RangeError` fires when the *remaining* stack runs
  out, so the same input decodes successfully from a shallow call site and
  throws from a deep one. Observed directly: at default stack size, depth 3,000
  threw while depth 5,000 succeeded in the same process. Anything that treats
  "RLP threw" and "RLP returned" as different outcomes is therefore not a pure
  function of its input. `Trie._deref` → `RLP.decode` (`trie.js`) and
  `StateDB` (`statedb.js`) are on that list.
- **It is not a typed error.** The module's contract is that every rejection
  names the rule broken (`rlp: …`); a `RangeError` names nothing and carries no
  code.

Today's blast radius is limited: `transaction.validate()` catches everything
and reports `RLP_ERROR`, and a deeply-nested transaction is refused for having
the wrong field count either way. It is a latent hazard rather than a live
break. A depth cap in `item()` — the yellow paper needs nothing like 2,000
levels — would close it.

### 2. `isNormalized(tx)` sniffs two fields out of nine

`src/chain/transaction.js`:

```js
function isNormalized(tx) {
  return typeof tx.nonce === 'bigint' && Buffer.isBuffer(tx.data);
}
```

`signingHash`, `intrinsicGas`, `checkGas` and `recoverSender` all skip
`normalize()` when this says yes, and then read the other seven fields in
whatever representation the caller left them in. This is the same shape as the
bug already found by hand in this function, one field over. The sharpest
instance:

```js
const T = require('./src/chain/transaction');
const initcode = Buffer.alloc(50000, 0x60);

// `toAddress` documents '' and '0x' as meaning "this is a creation".
T.intrinsicGas({ nonce: 0n, gasPrice: 1n, gasLimit: 30000000n,
                 to: '', value: 0n, data: initcode });          // 821,000  ← wrong
T.intrinsicGas(T.normalize({ …the same object… }));             // 853,002  ← right

T.checkGas({ …to: ''… });                                        // ok
T.checkGas(T.normalize({ …to: ''… }));                           // INITCODE_SIZE_EXCEEDED
```

So a caller who writes `to: ''` — which `toAddress` explicitly accepts, and
which `encode()` will happily turn into creation bytes — is under-quoted by
32,002 gas and has EIP-3860's initcode cap skipped entirely. The transaction
encodes as a creation and is priced as a call. Same root cause, smaller blast
radius: a decimal-string `value` or `gasPrice` on an otherwise-normalised draft
changes `signingHash`, because RLP reads a bare string as UTF-8.

Nothing on the node's own path reaches this — `decode()` normalises everything
it produces — so it is a wallet/caller-facing footgun rather than a consensus
bug. `isNormalized` checking `to`, or `isCreation` calling `toAddress`, would
close it.

The fuzzer pins this: `target-transaction.js` runs the general property
`f(draft) === f(normalize(draft))` over many representations, and downgrades a
failure to an observation **only** when the two-field sniff is what caused it.
Any other way of breaking that property is a new bug and fails properly.

### 3. `transaction.decode()` throws untyped errors from RLP

The JSDoc says `@throws {TxError} with a code naming the rule broken`, but a
strict-RLP rejection comes straight out of `RLP.decode` as a plain `Error` with
no `.code`. Harmless inside `validate()`, which catches everything and
substitutes `RLP_ERROR`; a trap for any other caller that switches on
`e.code`. Reported as an observation, not a failure.

### Surfaces that resisted everything

`uint256`, the trie and the interpreter came through clean. See the commit
message for the exact case counts.

---

## Adding a target

A target is one module exporting `{ name, run, replay }`:

```js
'use strict';
const name = 'mything';

/** Generate and check cases until the budget or the deadline runs out.
 *  @param t         the Harness: t.ok(cond, msg, repro), t.note(), t.expectedBug()
 *  @param rng       a seeded Rng from ./random — the ONLY source of randomness
 *  @param budget    { cases, deadline }  — a count and a Date.now() cutoff
 *  @returns         how many cases actually ran */
function run(t, rng, { cases, deadline }) {
  t.group('mything — the property, in a sentence');
  let i = 0;
  for (; i < cases; i++) {
    if ((i & 63) === 0 && Date.now() > deadline) break;   // check the clock cheaply
    t.context(name, i);                                    // quoted in every failure
    // … generate, then assert. The third argument to t.ok is the reproducer:
    // whatever `replay` needs to re-run this exact case. It is written to
    // corpus/ on failure, so make it complete and make it small.
  }
  return i;
}

/** Re-run one corpus entry. Must be able to consume anything `run` saved. */
function replay(t, entry) { /* … */ }

module.exports = { name, run, replay };
```

Then add it to the `TARGETS` array in `run.js` and give it a budget in
`CI_CASES` — pick a number that keeps the default pass around a second.

Three rules that are not optional:

1. **All randomness comes from `rng`.** No `Math.random`, no `Date.now()` in a
   generated value, no `crypto.randomBytes`. A failure that cannot be replayed
   from its seed is a failure nobody can fix.
2. **State the property independently.** A check that asks the implementation
   what the implementation should do tests nothing. `mustReject()` in
   `target-transaction.js` and the reference table in `target-uint256.js` are
   the pattern: restate the rule from the specification, in different code.
3. **Bias the generators onto the boundaries.** Uniform bytes essentially never
   produce a long-form RLP length, a nonce of exactly 2^64-1, or a trie value
   of exactly 32 bytes. `random.js` exports `length()`, `bigUint()`,
   `rlpishByte()`, `trieKeys()` and `trieValue()` for this; extend them rather
   than reaching for `rng.bytes` alone.

### The harness API

| Call | Meaning |
| --- | --- |
| `t.group(name)` | A section header. |
| `t.context(target, i)` | The target and case index quoted in every subsequent failure. |
| `t.ok(cond, msg, repro)` | One check. On failure, prints `msg` with the seed and case, and writes `repro` to `corpus/`. Returns `cond`, so `if (!t.ok(…)) break;` works. |
| `t.throws(fn)` | Runs `fn`, returns `{ threw, error, value }`. Use it to assert *how* something was rejected, not merely that it was — "it threw" is what lets a typo pass for a rejection. |
| `t.note(key, message)` | An observation, deduplicated by `key`. Printed, never a failure. |
| `t.expectedBug(key, message, repro)` | A check that fails because of a bug already found, reported and deliberately not patched here. Keeps the run green while printing the finding every time. Use it **only** with a predicate narrow enough that a new instance still fails properly. |

### The corpus

`corpus/*.json` is a flat directory of `{ target, note, … }` files, replayed
before every run. The `…` is whatever that target's `replay` reads —
`{ input, mustReject }` for RLP, `{ raw, mustAccept }` for transactions,
`{ pairs, orders, secure }` for the trie, `{ op, args }` for uint256,
`{ code, gas, data }` for the interpreter. Buffers are `{"$hex": "…"}` and
BigInts `{"$big": "…"}`.

The files numbered `-0001-` upwards were written by hand to seed the corpus
with the cases a reviewer would pick; anything with a 12-hex-character suffix
was found by the fuzzer and written automatically. Both kinds are permanent
regression tests. Give a hand-written one a `note` that says what would break
if it stopped passing — a corpus entry with no explanation gets deleted by
somebody in six months.
