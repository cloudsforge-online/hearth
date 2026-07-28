# Conformance harness

We are implementing the EVM ourselves (`docs/evm-spec.md`). The only reason that
is survivable is that Ethereum publishes reference vectors for every part of it.
This directory is the machinery that runs them.

**A divergence from Ethereum semantics is not a cosmetic bug.** It means a
Solidity contract behaves differently here than where it was audited. No
component is done until its vectors pass, and if a vector cannot be made to
pass, the correct response is to say so — not to skip it.

```
loader.js     parse the four fixture shapes into one normalised vector object
runner.js     execute vectors against an implementation; also the CLI and self-test
report.js     result reporting, and the account-level diff for root mismatches
fixtures/     a small representative subset — COMMITTED, runs offline
vectors/      the full upstream corpus — GITIGNORED, see ../../scripts/fetch-vectors.sh
```

---

## Quick start

```sh
cd node

# prove the harness itself works (needs no implementation, no network)
node test/conformance/runner.js --selftest        # 85 checks over the committed fixtures

# what would run
node test/conformance/runner.js --list
node test/conformance/runner.js --list --suite=GeneralStateTests

# run an implementation against the committed subset
node test/conformance/runner.js --impl=./test/conformance/my-impl.js

# ...against the full corpus
./scripts/fetch-vectors.sh
node test/conformance/runner.js --impl=./impl.js --dir=test/conformance/vectors

# one failing vector, alone, loudly
node test/conformance/runner.js --impl=./impl.js \
  --filter='stEIP2930/transactionCosts.json::transactionCosts::Shanghai::d10g0v0' --verbose
```

Exit status is non-zero on any failure, on a fixture that fails to load, and on
a run that matched no vectors at all. CI can gate on it directly.

---

## fixtures/ versus vectors/ — which is which

| | `fixtures/` | `vectors/` |
| --- | --- | --- |
| Committed | **yes** | no (gitignored) |
| Size | 39 files, 300 KB | 3,425 files, 351 MB |
| Vectors | **121** runnable Shanghai vectors | **20,766** (20,077 state, 609 VM, 55 RLP, 25 trie) |
| Runtime | instant | ~1 s to load and dispatch all of it |
| Purpose | offline development, fast CI gate | the real conformance gate |
| Obtained by | already here; `./scripts/fetch-vectors.sh --vendor` refreshes it | `./scripts/fetch-vectors.sh` |

**The default fixture root is `fixtures/` alone, even once `vectors/` has been
fetched.** The full corpus is a superset, so defaulting to both would run every
vendored vector twice; the real gate is a deliberate
`--dir=test/conformance/vectors`.

The subset is deliberately diverse rather than deliberately large: every one of
the four shapes, plus the cases that break naive parsers — trie deletes, secure
(hashed-key) keys, a VMTest that must throw, a GeneralStateTest that must be
rejected, a fixture with no Shanghai section at all, and one whose post entries
list their indexes **out of order**.

Passing `fixtures/` means the harness and the plumbing work. **It does not mean
a component is conformant.** Only the full corpus does.

### Vendored subset breakdown

| Suite | Files | Vectors | Notably includes |
| --- | ---: | ---: | --- |
| RLPTests | 2 | 54 | the complete published set, valid and INVALID |
| TrieTests | 6 | 25 | the complete published set: plain/secure × ordered/any-order, plus `trietestnextprev.json`, which has no root and must be skipped rather than parsed |
| VMTests | 17 | 17 | arithmetic, bitwise, push/dup, sha3, log, env, block, system; 4 exception cases |
| GeneralStateTests | 14 | 25 | multi-index, out-of-order indexes, access lists, PUSH0, a rejected tx, an over-256-bit value, two fixtures with no Shanghai post at all |

---

## Where the corpus lives upstream

`VMTests` and `GeneralStateTests` are **not** in `ethereum/tests` at the top
level any more — they moved into the `LegacyTests` submodule. Cloning
`ethereum/tests` alone gets you RLP and trie vectors and nothing else.

| Suite | Repository | Branch | Path |
| --- | --- | --- | --- |
| RLPTests | `ethereum/tests` | `develop` | `RLPTests/` |
| TrieTests | `ethereum/tests` | `develop` | `TrieTests/` |
| VMTests | `ethereum/legacytests` | `master` | `Constantinople/VMTests/` |
| GeneralStateTests | `ethereum/legacytests` | `master` | `Cancun/GeneralStateTests/` |

`fetch-vectors.sh` handles both and symlinks the four suite roots into
`vectors/` so the loader's path-based suite inference works.

---

## The four shapes, and what the loader does with them

The loader turns every fixture into one normalised vector object. Quantities
become `BigInt`, byte strings become `Buffer`, addresses and storage words are
canonicalised, so an implementation never has to care that the corpus spans a
decade of conventions.

### 1. RLPTests — `{ name: { in, out } }`

`in` is a nested tree; `out` is the hex encoding.

- a JSON number, or a `"#<decimal>"` bignum, becomes **minimal big-endian bytes**
- a `"0x…"` string is hex; **any other string is its UTF-8 bytes**
- `in: "INVALID"` means `out` is malformed and **decoding it must throw**
- `in: "VALID"` means `out` is well-formed and decoding must succeed

Integers are resolved by the loader on purpose. RLP is defined over byte strings
and lists only, so `impl.rlp.encode` never has to guess integer semantics.

The `INVALID` half is not a formality. A decoder that accepts malformed RLP will
accept a malformed transaction off the wire.

### 2. TrieTests — `{ name: { in, root } }`

- `in` as an **object** is the any-order form: the root must not depend on
  insertion order.
- `in` as an **array** is the ordered form: a replay of inserts and deletes,
  where a `null` value is a **delete**. Only the final root is asserted.
- Keys and values follow the same `0x`-is-hex, otherwise-UTF-8 rule.
- The **secure** variant (keys hashed with keccak-256 before insertion) is
  signalled *only by the filename* — the JSON bodies of `trietest.json` and
  `trietest_secureTrie.json` are identical apart from the expected roots. The
  loader sets `vector.secure` from the filename and passes it in `ctx`.
- `trietestnextprev.json` lives in the same directory but is **not this shape**:
  it asserts next/prev traversal and publishes no `root`. Parsed naively it
  becomes a vector asserting `root === '0x'`, which passes forever and tests
  nothing. The loader skips any trie case with no `root`, with a reason.

### 3. VMTests — `{ name: { env, exec, pre, post, gas, out, logs } }`

Execution only: no transaction validation, no intrinsic gas, no nonce or
balance checks.

Three things about this format regularly catch people out:

- **`gas` is gas REMAINING**, not gas used. The loader exposes it as
  `vector.gasRemaining`.
- **`logs` is `keccak256(rlp(logs))`**, a 32-byte hash — not a list of logs.
- **A vector that expects an exception omits `post`, `gas`, `out` and `logs`
  entirely.** That absence *is* the assertion. The loader sets
  `vector.expectException = true`.

VMTests carry a **full expected post state**, which makes their account diff
exact. They are by far the best debugging surface in the corpus — get these
green before touching GeneralStateTests.

⚠️ **These vectors are Constantinople-priced.** They predate EIP-2929
(Berlin, cold/warm access costs), EIP-3529 (London, reduced refunds) and
EIP-3855 (Shanghai, PUSH0). Their opcode *semantics* still hold under Shanghai
and their post states are still correct, but the `gas` figure will not match a
Shanghai gas schedule for anything touching `SLOAD`, `BALANCE`, `EXTCODE*`,
`CALL` or refunds. Run them with `--no-gas` while building the interpreter, and
take gas conformance from GeneralStateTests, which are filled for Shanghai.

### 4. GeneralStateTests — `{ name: { env, pre, transaction, post: { <fork>: [...] } } }`

The full transition: signature recovery, nonce and balance checks, intrinsic
gas, execution, refunds, receipts.

**The indexing is the trap.** `transaction.data`, `.gasLimit` and `.value` are
each an **array**, and every post entry's `indexes` selects one element from
each. Get it wrong and you silently execute the wrong case and chase a
non-existent bug.

```json
"transaction": { "data": ["0x", "0xabcd"], "gasLimit": ["0x061a80"], "value": ["0x0186a0"] },
"post": { "Shanghai": [ { "indexes": { "data": 1, "gas": 0, "value": 0 }, "hash": "0x…" } ] }
```

- the index key for `gasLimit` is **`gas`**, not `gasLimit`
- an index of `-1` means *every* element of that array
- `transaction.accessLists`, when present, is parallel to `data` and indexed by
  the **data** index; a `null` entry there means that combination is a legacy
  (type 0) transaction
- **post entries are not necessarily in index order.** `stEIP2930/transactionCosts.json`
  lists its twelve data indexes as `0,1,2,3,4,5,6,10,7,8,9,11`. A runner that
  walks the array positionally runs eight of the twelve against the wrong
  expected root. The self-test asserts this specific file maps correctly.

Other fields the loader carries through:

- `hash` — the expected **state root**. It is the *only* expected state the
  fixture publishes; there is no expected account list.
- `logs` — again `keccak256(rlp(logs))`.
- `expectException` — e.g. `"TR_IntrinsicGas"`: the transaction must be
  **rejected**, and the post root is the state with the transaction not applied.
- `txbytes` — the signed RLP of the exact transaction. Printed on failure,
  because a root mismatch is sometimes a transaction-encoding bug rather than an
  execution bug, and decoding this tells you which.

One more retesteth quirk: a quantity that will not fit in 256 bits is written
`"0x:bigint 0x<hex>"`, not as plain hex. Exactly one fixture in the corpus uses
it (`stTransactionTest/ValueOverflowParis.json`, vendored), and its whole point
is that the transaction must be **rejected** for overflowing — so reading it as
plain hex throws and loses the vector. The loader strips the escape and keeps
the value as an arbitrary-precision `BigInt`; rejecting it is the
implementation's job.

**Fork filtering.** We target Shanghai (`docs/evm-spec.md` §1). Every other fork
section is **skipped with a count**, never silently dropped — the summary prints
`skipped 48 records (102 fixture cases) by fork: Cancun 24, Berlin 24, …`. A
suite that quietly runs nothing is indistinguishable from a suite that passes.

---

## The implementation contract

Supply any subset. A suite with no implementation is skipped, loudly.

```js
module.exports = {
  rlp: {
    encode(value, ctx),           // -> Buffer | Uint8Array | '0x…'
    decode(bytes, ctx),           // -> value; MUST throw on malformed input
  },
  trie: {
    root(pairs, ctx),             // -> '0x…'   ctx.secure, ctx.ordered, ctx.vector
  },
  vm: {
    makeState(pre),               // -> state
    run({ state, env, exec, pre, vector }),
  },
  state: {
    makeState(pre),               // -> state
    runTransaction({ state, env, tx, fork, pre, vector }),
  },
};
```

`state` is whatever you like, so long as it answers:

```js
state.root()   // -> '0x…'   required for GeneralStateTests
state.dump()   // -> { address: { nonce, balance, code, storage } }
```

`dump()` is optional and you want it anyway: **without it a root mismatch
reports no account diff**, and see below for why that matters.

Results:

```js
// vm.run
{ exception?: string, gasLeft?: BigInt, returnData?: Buffer|'0x…', logsHash?: '0x…' }
// state.runTransaction
{ exception?: string, logsHash?: '0x…', gasUsed?: BigInt, stateRoot?: '0x…' }
```

`pairs` for the trie is `[[Buffer key, Buffer value | null], …]`; a `null` value
is a delete.

The flat aliases from the original API sketch also work:
`{ runTransaction, makeState, runVm, trieRoot, encodeRlp, decodeRlp }`.

### Signalling failure — read this one

**Report an EVM-level failure by RETURNING `{ exception: '…' }`.** A thrown
JavaScript error is treated as a harness-level `ERROR`, never as a passing
exception. Otherwise a `TypeError` in the interpreter would masquerade as a
correctly-rejected transaction, and the vectors that assert *failure* would be
the easiest ones to fake. If throwing is more natural, set
`err.evmException = true` on the error.

RLP decode is the one deliberate exception: there, throwing **is** the contract,
because that is how every decoder signals malformed input.

`logsHash` must be `keccak256(rlp(logs))`. If you return no `logsHash` the log
assertion is recorded as **unchecked** and counted in the summary — the harness
will not compute it for you, and will not pretend it verified something it
didn't.

---

## Reading a failure

```
• VMTests  (17 vectors)
  ✗ VMTests/vmArithmeticTest/add0.json::add0
      post state matches
        account divergence:
        ~ 0x0f572e5295c57f15886f9b263e2f6d2d6c7b5ec6
            balance  expected 0xde0b6b3a7640000 (1000000000000000000)  ours 0xde0b6b3a763ffff (999999999999999999)  (delta -1)
            storage 0x0000000000000000000000000000000000000000000000000000000000000000
              expected 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe
              ours     0x000000000000000000000000000000000000000000000000000000000000dead
      rerun: node test/conformance/runner.js --suite=VMTests --filter='…' --verbose
```

- `~` an account present in both but differing; `-` expected but missing; `+`
  produced but not expected.
- `rerun:` is a copy-pasteable command that runs that one vector alone.

**Read it in this order.** A single divergent storage slot is an opcode bug. A
divergent balance with everything else clean is a gas or refund bug. A missing
account is a self-destruct or empty-account-deletion bug. Every account
divergent by the same amount is a fee-distribution bug.

### The GeneralStateTests caveat

GeneralStateTests publish only a root — never the expected accounts. So when a
state root mismatches, the harness diffs your **post-state against the
pre-state** and labels it as such:

```
accounts our execution changed (the fixture publishes only a root, so this is pre vs ours — not a reference diff)
```

That names every account your execution touched and by how much, which is
usually enough. For an exact diff, pass a reference post-state:

```js
runSuite({ suite: 'GeneralStateTests', impl, expectedPostFor: (vector) => referenceDump[vector.name] });
```

A diff that comes back **clean** here means your execution changed nothing at
all — the transaction almost certainly never ran.

If the accounts genuinely match and the root still differs, the bug is in the
trie, not the interpreter: node encoding, the `<32`-byte embedding rule, or
secure-key hashing. Go back to TrieTests.

The opcode-level tracer (`docs/evm-spec.md` §8, built during phase 3) is the
next tool after this one.

---

## Programmatic use

```js
const { runSuite, runAll } = require('./test/conformance/runner');

const { summary, results } = runSuite({
  suite: 'GeneralStateTests',
  impl: require('../../src/evm/conformance'),
  dirs: ['test/conformance/vectors'],   // default: fixtures/, plus vectors/ if present
  filter: /stSStoreTest/,               // regex, substring, or vector => boolean
  forks: ['Shanghai'],                  // default
  checkGas: true,                       // false for Constantinople-priced VMTests
  verbose: false,
  onResult(r) { /* r.status, r.name, r.failures, r.checks, r.rerun */ },
});

const all = runAll({ impl });           // every suite, one shared reporter
process.exit(all.ok ? 0 : 1);
```

`summary` is plain JSON — `total`, `passed`, `failed`, `skipped`,
`skippedEntries`, `errored`, `checks`, `unchecked`, `skippedForks`, `groups`,
`failures[]` — and `--json[=path]` writes exactly that.

---

## CLI

```
--impl=<path>        module exporting the implementation
--dir=<path>         fixture root; repeatable. default: fixtures/ (+ vectors/ if fetched)
--suite=<name>       RLPTests | TrieTests | VMTests | GeneralStateTests; repeatable
--filter=<pattern>   regex or substring matched against the vector name
--fork=<name>        target fork; repeatable. default: Shanghai
--no-gas             skip the VMTests gas comparison
--max-failures=<n>   stop printing failure detail after n (default 50)
--json[=<path>]      machine-readable summary; omit the path for stdout
--list               list the vectors that would run, then exit
--verbose, -v        print passing and skipped vectors, and unchecked assertions
--allow-empty        exit 0 when nothing matched (default: exit 1)
--selftest           run the harness's own self-test
```

---

## Adding a suite

1. **Get the fixtures.** Add the upstream paths to `VENDORED` in
   `../../scripts/fetch-vectors.sh` for the committed subset, and to the
   sparse-checkout list in `do_fetch` for the full corpus. Run
   `./scripts/fetch-vectors.sh --vendor`. The script refuses to write anything
   that is not valid JSON, so a captive portal cannot silently vendor an HTML
   page as a fixture.

2. **Teach the loader the shape.** Add `parseMySuiteFile(json, ctx)` to
   `loader.js`, register it in `PARSERS`, and add the name to `SUITES`. Return
   either an array of vectors or `{ vectors, skipped }`. Every vector needs
   `kind`, `suite`, `file`, `relFile`, `case` and a stable unique `name`
   (`<relFile>::<case>[::<discriminator>]` — the name is what `--filter` and the
   `rerun:` hint use). Normalise with the exported helpers: `toBigInt`,
   `hexToBuf`, `normAddress`, `normWord`, `normAccounts`, `normEnv`. Anything
   the fixture asserts but you cannot represent must become a **skip record with
   a reason**, never a silent drop.

3. **Teach the runner to execute it.** Add `runMySuiteVector(v, impl, opts)` to
   `runner.js` and register it in `EXECUTORS` with the `impl` part it needs. Use
   `makeCheck()`: `c.eq(what, expected, actual)`, `c.ok(what, cond, extra)`,
   `c.skipCheck(what, why)` for anything the implementation did not expose.
   Attach a `diff` from `diffAccounts()` to any state comparison — a bare
   "mismatch" is not an acceptable failure message here.

4. **Extend the self-test.** In `selfTest()`, add loader assertions for the
   shape's awkward cases, then extend `buildOracle` so the suite both passes
   with a correct oracle and fails — visibly and specifically — with a sabotaged
   one. **A harness that cannot fail is worse than none.**

5. Run `node test/conformance/runner.js --selftest`.

---

## Wiring into CI

The harness is standalone and is not yet in `package.json`'s `test` script
(that file was out of scope for this change). To gate on it, add:

```json
"test:conformance": "node test/conformance/runner.js --selftest",
```

and append `&& npm run test:conformance` to `test`. Once an implementation
exists, point it at `--impl=` and, in a separate slower job, at the full
`--dir=test/conformance/vectors` corpus.
