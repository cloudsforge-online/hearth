# Hearth contract verification

Recompiles a submitted source with the exact compiler it names and compares the
result against the runtime bytecode at an address. Zero npm dependencies,
CommonJS, plain `node:http`, Node 22+.

```bash
export HEARTH_RPC_URL=http://127.0.0.1:8545
node src/index.js                                # listens on 127.0.0.1:9648
```

```bash
npm test        # 116 assertions; the first run downloads ~9 MB of solc
```

> **Not deployed anywhere — and the reason is no longer "there is no chain".**
> That sentence stood here until 2026-08-10 and it had stopped being true: mainnet
> is live, chain id 7411 at `https://rpc.cloudsforge.online`, measured that day at
> height 10,987 and climbing. What is missing is a host for *this service*, not a
> chain for it to read. Two things follow. There is nothing on mainnet to verify
> yet — every block measured carries zero transactions, so no contract of record
> exists — and the round trip below is still proven end to end against a real
> artifact from `contracts/src` with `eth_getCode` coming from a stub. See
> [What is proven, and what is not](#what-is-proven-and-what-is-not).

---

## Why this exists

`docs/listing-checklist.md` §3 lists verified contract sources as a blocker, and
`forge verify-contract` currently has nothing to talk to. Without it every
contract on the chain is unverified bytecode — the DEX included. A user cannot
read the code of the pool they are about to put money into, which on a DeFi
chain is not a cosmetic gap.

**The only claim this service ever makes is: compiling this source with this
compiler and these settings produces the code at this address.** Everything it
cannot check is named in the record rather than assumed.

---

## Using it

### With Foundry

The Etherscan verification API is implemented, which is what `forge` and
`@nomicfoundation/hardhat-verify` speak — POST a form, get a GUID, poll until it
says `Pass - Verified`.

```bash
forge verify-contract 0x… src/Thing.sol:Thing \
  --verifier-url http://127.0.0.1:9648/api \
  --etherscan-api-key any \
  --compiler-version v0.8.26+commit.8a97fa7a \
  --num-of-optimizations 999999
```

### Directly

```http
POST /verify
{
  "address": "0x…",
  "compilerVersion": "v0.8.26+commit.8a97fa7a",
  "standardJsonInput": { "language": "Solidity", "sources": {…}, "settings": {…} },
  "contractName": "src/Thing.sol:Thing",
  "constructorArguments": "0x…",
  "creationTxHash": "0x…",
  "libraries": { "src/L.sol:BigMath": "0x…" }
}
```

`200` with the record, or **`422` with the reason** — understood, and the answer
is no. A `500` would read as an outage and get retried.

| Route | |
| --- | --- |
| `POST /verify` | native submission |
| `GET /contract/:address` | the full record — this is what `tools/explorer-api` reads |
| `GET /contract/:address/abi` | the ABI alone |
| `GET /contracts` | everything verified |
| `GET /compilers` | releases this service will accept, and which are cached |
| `GET /health` | |
| `GET|POST /api` | `verifysourcecode`, `checkverifystatus`, `getabi`, `getsourcecode` |

`contractName` is optional. Without it, every compiled contract is tried and the
one whose runtime bytecode matches wins — a convenience, not a weakening,
because a match is a match. With it, that name and no other; an ambiguous name
across files is a refusal rather than a coin toss.

---

## What a match means

| `matchType` | |
| --- | --- |
| `exact` | byte-identical, **including** the CBOR metadata trailer |
| `partial` | identical once the trailer is removed |

A partial match means "this source compiles to the deployed code", not "this is
byte-for-byte the source that was compiled". The distinction is in the record
(`matchType`, `metadataMatched`) and is surfaced by the explorer as
`HearthMatchType`. It is never hidden.

### The metadata hash

solc appends a CBOR blob to both the creation and the runtime code, followed by
its own two-byte big-endian length. It holds a hash of the source *metadata* —
which covers every source path, every compiler setting and the full text of
every comment. **Add a space to a docstring and the bytecode changes without a
single instruction changing.**

This repository's own contracts sidestep it by compiling with
`metadata.bytecodeHash: 'none'` (`contracts/scripts/compile.mjs`), because the
router's CREATE2 init code hash would otherwise depend on comment text.
Arbitrary user contracts do not, so the comparison handles it — and the trailer
is detected by **parsing it as CBOR**, not by assuming the last *N* bytes are
metadata. A length prefix that happens to be plausible is not grounds for
deleting bytes off the end of someone's contract.

A useful consequence: code deployed with `bytecodeHash: none` still verifies
against a submission compiled with the default settings, as a partial match.

### Immutables

`immutable` values are written into the runtime code at construction, so the
deployed code has values where the compiler emitted zeros. Both sides are masked
at the offsets solc reports in `evm.deployedBytecode.immutableReferences`. The
masked-out values are **read out of the deployed code and reported**
(`immutableValues`) — they are real information — but they are **not proven**,
because proving them means re-running the constructor. Two different deployments
of the same source both match, which is correct and is asserted by a test
against the real `HearthV2Router02`.

### Constructor arguments

**Recorded and not verified**, unless you supply `creationTxHash`. The runtime
bytecode does not contain them, so without the deployment there is nothing to
compare against; reporting them as verified anyway would assert something never
looked at. Every record carries `constructorArgumentsVerified` and a note saying
which happened.

With a `creationTxHash`, the transaction's input must begin with the recompiled
creation code and the remainder is the arguments. If declared arguments
contradict that, **the whole submission is refused** — the bytecode matched, but
the submitter asserted something the deployment disproves, and leaving a wrong
value on a contract page is worse than refusing.

### Libraries

`libraries` may be given as `{"path/File.sol:Lib": "0x…"}` (Etherscan and
Foundry's form) or as a bare `{"Lib": "0x…"}`, which is resolved against the
sources only when exactly one declares that name. Guessing would link the wrong
address.

An unlinked external library leaves a `__$<34 hex>$__` placeholder. Such code can
never equal deployed code, so it is **refused with the library's name** rather
than reported as a mismatch — the same reasoning as
`contracts/scripts/compile.mjs`, which refuses to hash unlinked bytecode.

---

## What this does not support

Stated rather than discovered:

- **Vyper, and standalone Yul.** Refused by name.
- **solc before 0.6.0.** The `solidity_compile(input, readCallback, context)`
  entry point has been stable since 0.6.0; earlier releases need solc-js's
  translation layer, which is an npm package this repository will not take.
  Refused with that explanation rather than failing obscurely.
- **Nightly builds**, unless `HEARTH_VERIFY_SOLC_ALLOW_NIGHTLY=1`. A verifier's
  product is reproducibility.
- **Proxy detection.** `Proxy` is always `"0"` and `Implementation` empty in
  `getsourcecode`. Following an EIP-1967 slot is easy; deciding what a proxy
  *is* across the dozen patterns in use is not, and a wrong answer here sends a
  reader to the wrong source.
- **Constructor arguments without a creation transaction** — see above.
- **Immutable values** — masked, reported, never proven.
- **"Similar" or fuzzy matching.** There are two outcomes and one of them is no.
- **Contracts deployed by a factory**, for constructor-argument purposes: there
  is no top-level creation input to check. The bytecode comparison itself is
  unaffected.
- **Imports that are not in the submission.** The compiler runs with no import
  callback, so `import "…"` resolves only among the sources supplied. This is
  deliberate: a verifier that could read the local filesystem during a compile
  would let a submission exfiltrate it.
- **`viaIR` reproducibility across patch releases.** Supported as a setting, but
  IR-pipeline output has changed between patch versions; if a match fails on a
  `viaIR` contract, the compiler version is the first thing to check.

---

## Getting a compiler, safely

Verification needs the **exact** compiler — a different patch release produces
different bytecode, so "close enough" does not exist. With zero npm dependencies
the compiler cannot come from `node_modules`, so it is fetched from
`binaries.soliditylang.org` and cached in `.solc-cache/`.

**A soljson build is a 9 MB JavaScript file this process `require`s.** Loading
one an attacker chose is arbitrary code execution. Therefore:

1. The version is resolved against `list.json` from the same server, which
   publishes a **keccak-256 for every build**.
2. The download is hashed with this repository's own vector-tested
   `node/src/crypto/keccak.js`, and must equal the published hash. A mismatch
   deletes the file and refuses.
3. Only files that passed (2) are ever `require`d, and only from inside the
   cache directory. A submitted `compilerVersion` can never become a path — it
   is matched against a version grammar first and against the published list
   second.
4. `HEARTH_VERIFY_SOLC_OFFLINE=1` refuses every fetch, so an air-gapped
   deployment can pre-seed the directory and know nothing else can arrive.

### Compiling in a child process

Every compile runs in `src/compile-child.js`, spawned per job. Three reasons:

1. **`solidity_compile` is synchronous and cannot be interrupted.** In-process,
   a pathological submission blocks the event loop until it finishes and
   `/health` stops answering. A child can be killed at a deadline.
2. **An emscripten heap grows and never shrinks**, and a long-lived verifier
   would accumulate one per compiler version it had ever loaded. A process per
   compile hands the memory back.
3. **This is the only place in either listing service that executes code chosen
   by an anonymous caller.** A process boundary is the cheapest isolation
   available and costs about 400 ms of startup.

The child is given no network access it would use, no import callback, and
nothing but the compiler path and the standard-JSON input.

---

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HEARTH_RPC_URL` | `http://127.0.0.1:8545` | `eth_getCode` is the ground truth |
| `HEARTH_CHAIN_ID` | `7411` | a mismatch at boot is **fatal** — a verifier on the wrong chain publishes "verified" against someone else's bytecode |
| `HEARTH_VERIFY_PORT` / `_HOST` | `9648` / `127.0.0.1` | no TLS, no auth, and it compiles what strangers send. Put it behind a proxy and rate-limit it |
| `HEARTH_VERIFY_DATA` | `./verified` | one JSON file per address |
| `HEARTH_VERIFY_SOLC_DIR` | `./.solc-cache` | ~9 MB per compiler release |
| `HEARTH_VERIFY_SOLC_OFFLINE` | `0` | refuse all fetches |
| `HEARTH_VERIFY_SOLC_ALLOW_NIGHTLY` | `0` | |
| `HEARTH_VERIFY_COMPILE_TIMEOUT_MS` | `180000` | the child is SIGKILLed at this |
| `HEARTH_VERIFY_CONCURRENCY` | `1` | a solc process is expensive and this is unauthenticated |
| `HEARTH_VERIFY_QUEUE_LIMIT` | `32` | |
| `HEARTH_VERIFY_ALLOW_OVERWRITE` | `0` | re-verifying an address is refused by default |
| `HEARTH_VERIFY_MAX_BODY` | `8388608` | |

### Storage

One JSON file per address. Not the explorer's format, and for a different
reason: there is one record per verified **contract** — a count that grows with
developer activity, not with chain length — and each is a self-contained
document written once and read many times. A directory of files is the right
shape for that: greppable, diffable, trivially backed up, and an operator can
hand one to someone without exporting anything. Writes go to a temporary file
and are renamed, so a reader never sees a half-written record.

---

## What is proven, and what is not

The round trip is run **in both directions on a real artifact**: `WEMBER.sol`
from `contracts/src` is compiled with the pinned solc 0.8.26 and the repository's
own settings, verified as an exact match, and then

- one byte in the middle of the deployed code is changed → **refused**, naming
  the exact differing byte offset;
- the code is truncated → refused;
- the address is empty → refused, and told there is nothing there rather than
  "mismatch";
- a different contract is put at the address → refused;
- a source that does not compile → refused with the compiler's own errors.

Also proven: the metadata partial-match path (same source, one extra docstring);
immutables and constructor arguments against the real `HearthV2Router02`, which
has two immutables and a two-argument constructor; a contradiction between
declared arguments and the deployment; unlinked-library refusal; the compiler
checksum, the pre-0.6.0 refusal, the nightly refusal, and that a corrupted
cached compiler is deleted rather than loaded; and the full asynchronous
Etherscan flow including a **failed** verification travelling through it.

**Not proven, because nothing has pointed this at a node:**

- that a real deployment of these contracts produces the bytecode the stub is
  handed. `eth_getCode` is a stub, so the comparison is between two things this
  process computed. A node closes that loop and one is now a single command
  away (`hearthd --evm --mine`) — this suite simply does not use it yet, the way
  `tools/explorer-api/test/live-chain.test.js` does.
- that `forge verify-contract` actually drives it. The wire format is
  reproduced from Etherscan's documented contract and exercised by tests that
  post the same form fields (misspelled `constructorArguements` included), but
  no Foundry binary has been pointed at this service.
- immutable *values* — masked, by design.
- reproducibility for `viaIR` builds and for compilers other than 0.8.26. The
  acquisition path is version-agnostic and 0.6.12 was checked by hand to use the
  same entry point; the test suite compiles with one release.
