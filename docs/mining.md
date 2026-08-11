# Mining — Homefire

How Hearth keeps mining in the hands of people instead of farms and pools.

> **Shipped vs designed.** Everything under "What the chain does today" is
> implemented in `node/src/` and covered by `npm test`. Everything under "What is
> still design" is not — it is written down so it can be built and argued with,
> not because it is running. This page previously mixed the two, and the mixing
> is what produced the claim that Homefire is non-outsourceable.

## What the chain does today

### 1. Memory-hard (blunts the ASIC advantage)
For each nonce, `node/src/pow.js` does exactly this:

1. derives a seed from the header core, the nonce and the **coinbase public key**,
2. fills a scratchpad by chaining SHA-256 — 8,192 words at the dev size,
3. takes a 256-step pseudo-random walk that reads *and rewrites* the pad,
4. hashes the accumulator plus the tail of the pad, and checks it against the target.

That is ~8,450 sequential SHA-256 rounds per attempt with a data dependency at
every step, so the bottleneck is memory latency rather than gate count and a
general-purpose CPU sits close to the optimal machine. Production sizes (~2 GiB,
more steps) make the pad itself the barrier.

It is **not** a RandomX-class VM: nothing is compiled, and there is no program to
execute. Growing it into one is **not scheduled and is not claimed** — see
[roadmap.md](roadmap.md), "Dropped, or never real". Until it exists,
"RandomX-class" is not a description of Homefire.

### 2. A winning proof cannot be redirected
A valid block must be **signed by the private key its coinbase pays**:

```
solution = { nonce, digest, sig }   where   sig = Sign(coinbase_privkey, digest)
```

So a candidate built for your public key is worth nothing to anyone else, and
work handed to you cannot be taken from you — and no more than that; §2 is about
what this is not. **This paragraph cited `node/test/mining-api.js` as the proof until
2026-08-09, and that file has not existed since 2026-08-04**, when it was deleted with
`web/` in `48bc28a`. What proves it today is `node/test/browser-proof.js`, which
submits a winning proof signed by a key the template was not issued to and requires
the node to refuse it and the chain not to grow.

**Under the account model the key changes and the hashing does not.** `coinbasePub`
becomes a **secp256k1** public key, because the coinbase has to *receive* the block
reward and the fees and so must be an account this chain can credit
([`evm-spec.md`](evm-spec.md) §4). Homefire — the pad fill, the walk, the digest —
is untouched, as is LWMA. The miners follow the key: `node/bin/hearth-mine.js` and
`app-desktop/` both request a template with a 65-byte uncompressed secp256k1 key and
sign the winning digest with it (`node/src/chain/header.js`).

**The node moved, and this paragraph did not.** It used to say the node still
required an 88-hex SPKI DER *Ed25519* key, citing `node/src/rpc.js` and
`node/src/block.js`, and concluded that the browser miner could not mine a
block this node would accept. Three other documents said the same thing. All four
were reading THE UTXO CHAIN — `rpc.js` and `block.js` are that chain's REST server
and that chain's block rules, and they will require Ed25519 for as long as they
exist, because it is a different chain with a different curve.

The account model has its own REST server and its own template issuer, and they
require secp256k1: `node/src/chain/miner.js` `issue()` refuses anything that is
not a 65-byte uncompressed secp256k1 key, and `node/src/chain/header.js`
`verifyPow` recovers a secp256k1 key from the proof signature. That is exactly what
`node/bin/hearth-mine.js` and `app-desktop/` sign with. Four documents agreeing is not
one of them agreeing with the node.

**There WAS a real mismatch, and it was one byte.** The browser miner's `POW_SIG_FORM`
said `r || s`, 64 bytes, no recovery id; the node requires 65 — `r || s || recoveryId`
(`node/src/chain/header.js`) — because `verifyPow` recovers the coinbase key
from the signature rather than reading one. Every block the browser miner found was
answered `bad signature` after the work was done. It was fixed — and then the whole
tree was deleted in `48bc28a`, along with the `node/test/browser-proof.js` that had
started checking the form rather than describing it.

**This paragraph used to end "the mismatch cannot recur, because there is no second
signing implementation left to drift", and that stopped being true on 2026-08-06.**
`micro-network-site` restored the browser miner — the same code, carrying the
corrected `POW_SIG_FORM` — and served it from its `/mine` page. So there are two
signing implementations again, and for three days there was nothing comparing them.
Every miner *in this repository* does call `HDR.signProof`
(`node/src/chain/miner.js`, `node/src/mine/session.js`); the browser's is its own,
and `node/test/browser-proof.js` — restored 2026-08-09 — is what holds it to this
node.

**This is not non-outsourceability, and this document used to say it was.** The
private key is used *after* a nonce wins (`node/src/miner.js`), never inside the
hash loop, and only the public key is bound into the seed. A pool operator can
therefore hand out `coreHash` plus its **own** pubkey, collect `(nonce, digest)`
pairs from hashers who genuinely cannot steal the reward, and sign the blocks
itself. Nothing in consensus notices.

Closing that means committing to the private key inside the loop — a consensus change
that forks the chain and rewrites every miner. It is deliberately open, not overlooked.

### 3. Low variance, so far
- **15-second blocks** → frequent wins even for small miners.
- **Per-block LWMA difficulty** → smooth, no wild swings.

### 4. Polite mining

**Partly moved, partly gone — from the LIGHT MINERS.** The browser miner that
implemented this was deleted with `web/` on 2026-08-04 (`48bc28a`) and restored on
2026-08-06 in `micro-network-site`, where all three behaviours below are intact
(`src/mining/miner.js`). This section described them as lost until 2026-08-09; they
are lost to `hearth-mine` and `app-desktop`, which is a narrower claim.

What survived into the light miners:

- the **effort control** is a real duty cycle — the miner sleeps proportionally between
  batches rather than pinning a core. It is `--throttle F` (0..1) on the command line
  (`node/bin/hearth-mine.js`), a percentage slider in the desktop app
  (`app-desktop/ui/index.html`), and it is enforced in one place for both
  (`node/src/mine/session.js`).

What did **not** survive into them, because both are properties of a browser tab and
nothing outside one replaces them:

- the **background-tab trickle** that clamped a hidden tab to 15% effort;
- **pause on battery**. This relied on the Battery Status API, which is Chromium-only
  (Firefox and Safari removed it), so it was never universal even in the browser. **The
  desktop miner and `hearth-mine` have no power awareness at all** — they have a duty
  cycle and nothing more.

## What is still design

None of the following exists in this repository. Do not describe them as features.

- **Warmshares (uncles)** — near-miss blocks referenced by later blocks for a
  fraction of the reward, to pay for honest work that just missed.
- **Trustless co-ops** — peers sharing variance over a P2P protocol that never
  takes custody of a key.
- **Idle detection** — "mine only when the machine is idle" is not implementable
  from a web page: `requestIdleCallback` means "this tab's event loop is quiet",
  which is always true for a page that only mines, and the Idle Detection API is
  permission-gated and Chromium-only.
- **Thermal-aware back-off** — no temperature source is available to either the
  node or the browser.
- **A non-outsourceable puzzle** — see §2 above.
- **A RandomX-class VM** — see §1 above. Not scheduled.

## Where to point a miner

Everything below explains how the mining works. This section is the part you can
copy. All of it was measured from off the estate on **2026-08-11**; where a
reading is a moving number it is marked as one.

| | Mainnet | Testnet |
|---|---|---|
| `--network` | `hearth` | `hearth-testnet` |
| Chain id | **7411** (`0x1cf3`) | **7412** (`0x1cf4`) |
| Work endpoint (`--url`) | `https://rpc.cloudsforge.online` | `https://rpc-testnet.cloudsforge.online` |
| Peer endpoint (`--peer`) | `wss://p2p.cloudsforge.online/p2p` | `wss://p2p-testnet.cloudsforge.online/p2p` |
| Explorer | `https://explorer.cloudsforge.online` | `https://explorer-testnet.cloudsforge.online` |

To mine the main network, which is the one EMBER is real on:

```
node node/bin/hearth-mine.js \
  --url https://rpc.cloudsforge.online \
  --network hearth \
  --data ./data
```

That is the whole command. There is no port to add, no `--cacert`, no host pin
and no account to create: all four endpoints above are plain HTTPS on 443 behind
a publicly trusted Cloudflare certificate (`ssl_verify_result` 0 from a stock
curl on a laptop that has never seen this estate). `--data` is where the
coinbase key is written on first run — **back it up, because whoever holds it
holds the coins.**

**Check it before you trust it.** Two commands, and the answers they gave:

```
$ curl -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' https://rpc.cloudsforge.online
{"jsonrpc":"2.0","id":1,"result":"0x1cf3"}

$ curl -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' https://rpc-testnet.cloudsforge.online
{"jsonrpc":"2.0","id":1,"result":"0x1cf4"}
```

`0x1cf3` is 7411 and `0x1cf4` is 7412. Both were reported by
`Hearth/v0.2.1/linux-x64/node22.23.1` and `Hearth/v0.2.0` respectively.

### Three ways this goes wrong, and how to tell them apart

**The testnet hostname has a hyphen, not a dot.** It is
`rpc-testnet.cloudsforge.online`. The form `rpc.testnet.cloudsforge.online`
has no DNS record at all, and could not work even if it did: Cloudflare's
certificate for this zone is `*.cloudsforge.online`, a wildcard covering exactly
one label, so a two-label name fails the TLS handshake at the edge. The same is
true of every other surface — `explorer-testnet`, not `explorer.testnet`.

**`/info` does not answer on the public endpoints, and that is not a fault.**
On a node you run yourself, port 8645 serves `/info`, `/supply`, `/mempool` and
`/mining/*` together. On the public endpoints only `/mining/*` is routed to that
REST port; everything else reaches the Ethereum JSON-RPC on 8545. So:

```
$ curl https://rpc.cloudsforge.online/info
{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"JSON-RPC requires POST"}}   # 405

$ curl 'https://rpc.cloudsforge.online/mining/template?pub=<65-byte-hex>'
{"templateId":"…","height":13513,"coreHash":"…","target":"…"}                            # 200
```

A 405 from `/info` on a URL that mines perfectly well has sent people looking
for a wrong hostname. Ask for a template instead — that is the path the miner
uses.

**A 503 saying "this node is starting" is a healthy node, not a wrong address.**
While a node replays its chain from disk after a restart it answers:

```
{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"this node is starting: replaying its chain from disk"}}
```

Observed for several minutes during a restart on 2026-08-11, after which the
same URL returned `0x1cf3` without anything being changed. Wait and retry. The
distinguishing signal is that DNS and TLS both succeeded to get you that error;
a wrong hostname fails before any JSON comes back.

### Gossip is WebSocket only

`hearth-mine` does not need a peer — it takes work over HTTP. A **full**
validating node does, and from outside this estate the only way in is the
WebSocket:

```
hearthd --evm --mine --peer wss://p2p.cloudsforge.online/p2p
```

Only the `/p2p` path is routed; the host root answers 404. A WebSocket upgrade
request to `/p2p` answers `426 Upgrade Required — Hearth p2p speaks WebSocket at
/p2p`, which is what a healthy endpoint looks like to curl.

The raw TCP gossip port **8646 is not reachable from outside and will not
become reachable.** These hosts are published through a Cloudflare tunnel, and a
tunnel does not carry raw TCP — that is why the node has a WebSocket transport
on 8648 at all. `nc -z p2p.cloudsforge.online 8646` fails, as does 8645. Inside
one machine or one compose network, 8646 is still the right port and nothing
here changes that.

## Mining as a light client

> **The browser miner is not in this repository, and it is not gone.** `web/mine.html`
> and `web/assets/mining/` were deleted on 2026-08-04 (`48bc28a`) — and restored two
> days later, on 2026-08-06, in
> [`micro-network-site`](https://github.com/cloudsforge-online/micro-network-site)
> (`src/mining/`, served from its `/mine` page). This block said "there is no browser
> miner any more" until 2026-08-09.
>
> From this repository, mine with `node/bin/hearth-mine.js` on the command line, the
> desktop app in `app-desktop/` (Tauri; macOS, Windows, Linux), or `hearthd --evm --mine`
> if you want to validate the chain as well.
>
> It was removed rather than fixed because it had spent its whole life signing proofs in
> a 64-byte form while the node required the 65-byte recoverable form, so **every block
> it ever found was answered `bad signature`** — indistinguishable from bad luck. The
> defect was eventually fixed, but into a tree nothing ran, which is what settled the
> case for deleting it. The restored copy carries the fix, and
> `node/test/browser-pow.js` and `node/test/browser-proof.js` are what keep it honest;
> see "Production vs. proof-of-concept" below for what they do and do not gate.

**Why a light client can do this at all.** The winner must sign the digest with the key
the coinbase pays, so the miner has to hold its own key. The node hands out a candidate
built for *your* public key and keeps the transactions; you return a nonce, a digest and
a signature. Your private key never leaves the machine.

**And that is also the mining key's whole security problem**, so it is worth stating
next to the property rather than somewhere else: the key that proves the work is by
construction the key that can SPEND what the work earned, because `verifyPow` recovers
the coinbase from the proof signature. A miner therefore holds, in memory, a key that
can move its own balance, and no amount of encryption at rest changes that. What can
be changed is where the key comes from and how much sits behind it —
[`mining-key-custody.md`](mining-key-custody.md) is the four sources
`node/src/coinbase.js` now accepts, the two refusals worth configuring, and the
ordering that gets a funded coinbase off a plaintext file without losing the balance
(micro-org#206).

  GET  /mining/template?pub=<65-byte uncompressed secp256k1, hex>
                                            → header core, target, PoW params,
                                              and the rest of the core header so
                                              you can CHECK the work pays you
  POST /mining/submit  {templateId, nonce, powDigest, powSig}

`powSig` is 65 bytes: `r || s || recoveryId`. Both endpoints are metered rather
than authenticated — see `MINING_VERIFY_BURST` in `node/src/params.js` for why a
permissionless chain should not put a credential on `submit`, and what it puts
there instead.

**What `submit` answers, and why your miner must branch on it.** The status code
is an instruction, and 400 and 409 are opposite ones:

| Code | Means | What a miner must do |
|---|---|---|
| 200 | accepted, and the block is on the chain | count it and fetch fresh work |
| 409 | **stale** — `{ stale: true, reason }` where `reason` is `expired`, `evicted` or `superseded` | fetch fresh work. This is **not** a fault and must not count toward any give-up threshold |
| 400 | your submission is wrong — a malformed field, or `reason: 'unknown'` for an id this node never issued | stop and fix the client |
| 429 | the node is over its verification budget, not a judgement on your proof | wait `retryAfterMs` and retry |

All three ways work goes stale answer alike: it aged past `TEMPLATE_TTL_MS`, it
was pushed out when `MAX_TEMPLATES` overflowed, or the tip moved under it. A
miner cannot see which and must not have to. Until 2026-08-09 the first two
answered **400** instead, because a template that had left the map could not
reach the stale branch at all — so a miner whose work merely aged out was told
its proof was malformed, which is the one thing that makes an honest miner stop
(`micro-org#237`). `node/src/retiredtemplates.js` carries the reasoning,
including the one thing it deliberately cannot tell apart: an id retired long
enough ago to be forgotten is indistinguishable from one that was never issued,
and its message says so rather than guessing.

The node cannot mine on your behalf and cannot take work built for your key.
That is a real guarantee about *this* endpoint; it is not a guarantee that no
pool can exist (§2).

**A NEW TEMPLATE IS NOT NEW WORK, and a miner that assumes otherwise stops
mining.** Building a candidate executes a full block, so the node memoizes it on
(tip, mempool version, coinbase key) — `node/src/chain/miner.js`. While the
tip is still, every `GET /mining/template` therefore returns a **byte-identical
`coreHash` with a frozen `timestamp`**; only `templateId` and `expiresAt` change.
A template lives 120 s, so a miner re-fetches roughly every two minutes and gets
the same work back.

The seed is `h(coreHash, nonce, coinbasePub)`, so a given nonce over a given
`coreHash` has exactly one digest, for ever. **Restarting the nonce search on a
re-fetch therefore re-tests nonces already rejected, and if no winner lies in the
range one window covers, that miner can never find the block** — at a full, real,
correctly reported hashrate, with no error, no refusal and nothing in any log. It
is not a slowdown; it is a permanent stop that looks exactly like bad luck, and
restarting the process only re-treads the same range. This is what `hearth-mine`
did in production between heights 11 and 21 on both networks.

So a light miner must:

* **carry its nonce across a re-fetch of unchanged work** — compare `coreHash`,
  not `templateId`, and only move the search when the hash moves;
* **begin a fresh search at a random offset, not at 0**, so that a restarted
  process — or a second machine holding the same key — does not repeat a search
  that has already failed.

`node/src/mine/session.js` does both (`NONCE_SPACE`), and
`node/test/mine-session.js` holds it there with a template that is deliberately
re-issued unchanged and a winning nonce computed before the run.

**What one attempt costs.** ~8,450 SHA-256 rounds — 8,192 to fill the scratchpad, 256 to
walk it. That number is a property of the parameters, not of any one implementation, and
it is why the hot path matters more than the language.

> **A measurement that no longer has a subject.** This section used to report ~225 H/s
> per thread for the browser's synchronous SHA-256, "about 1.37× the node's own
> native-crypto implementation", because `crypto.subtle.digest` is async and WebCrypto
> would have meant thousands of promises per nonce. Both the module and the figure went
> with `web/`. **It is not carried over to the light miners**, which use the node's own
> `createHash` path and have never been benchmarked against that number. Anyone wanting
> a current figure has to measure one.

**Politeness, concretely.** The effort setting is a duty cycle: the miner sleeps
proportionally between batches rather than pinning a core
(`node/src/mine/session.js`). The loop yields for a second reason too — a grind that
never yields cannot notice a stop request or take new work. The hidden-tab trickle and
the stop-on-battery behaviour are browser-tab properties: the restored browser miner
still has them, neither light miner does; see §4.

**Correctness.** A digest that differs from the node's in one bit would mine
nothing while looking busy for hours. `node/test/browser-pow.js` compares the two
implementations directly — SHA-256 padding edges, `powSeed`, Homefire digests at the
live parameters and at retuned ones, target comparison including equality — then
grinds a winning nonce with the browser code and requires the node to recompute the
identical digest. `node/test/browser-proof.js` takes the other half: the browser's
own `proofSignature`, through the node's real template flow, with a block required to
come out of it.

Both were **deleted on 2026-08-04** with `web/` (`48bc28a`) and restored on
2026-08-09 against `micro-network-site`, where the browser miner has lived since
2026-08-06. This paragraph claimed them for the whole of that gap, and also claimed
`node/test/mining-api.js`, which was deleted in the same commit and has **not** been
restored — the HTTP endpoints and the budget are covered by `mining-budget`,
`mine-session` and `miner-cli` instead, against the node rather than a browser.

Neither browser suite is in `npm test`: that has to pass on a bare checkout of this
repository. They run in their own CI job, which checks `micro-network-site` out
first, and they fail rather than skip when it is absent.

## Mining from a desktop

The browser is not the only light miner, and for a machine you actually own it is
not the best one. Two programs share **one** implementation of the loop —
`node/src/mine/session.js` — and differ only in what renders it:

| | |
|---|---|
| `hearth-mine --url https://rpc.cloudsforge.online` | The command line. `node/bin/hearth-mine.js`. A status line, a key file, no window. |
| `app-desktop/` | A window: the address it pays, the hashrate, what it has earned, and a list of what it is doing. Ships its own Node runtime, so nothing has to be installed. |

Both are light miners over the same two endpoints as the browser, and both carry
the same checks. The one that matters most is not about hashing: **the endpoint
chooses the work**, so before spending a single evaluation the session recomputes
the core hash from the header fields the template carries and refuses anything
that does not commit to them, or that pays a different coinbase, or that was
built with different proof-of-work parameters (`node/src/mine/session.js`).
Without it a hostile endpoint cannot *steal* a block — the proof is signed by the
coinbase key — but it can hand out work paying someone else, and every submission
would be refused *after* the electricity was spent.

**Why one loop rather than two.** §2 above records what a second implementation
cost: the browser miner signed a 64-byte proof while the node required 65, and
every block it found was thrown away. The desktop application therefore runs the
same JavaScript the command-line miner runs, in a bundled Node runtime, rather
than a port. `app-desktop/src-tauri/src/engine.rs:7-17` is the long version.

**The key is the difference between them.** `hearth-mine` and `hearthd` write the
coinbase key in the clear at mode 600 (`node/src/coinbase.js`), which is the
right trade for a server that must come back up unattended after a reboot — a
passphrase the machine can read by itself is not a passphrase. A laptop is the
opposite case: the file is synced, backed up to a cloud and carried around. So the
desktop app uses an encrypted keystore instead — scrypt N=2¹⁸ over a passphrase,
AES-256-GCM over the key, and the address in the clear so the app can say who it
pays before you unlock anything (`node/src/mine/keystore.js`).

**There is no mobile miner, and there should not be.** Proof-of-work on a phone is
thermally throttled and battery-hostile, and at a 15-second block target against
desktop hardware it would essentially never win a block — it would spend a user's
battery to earn nothing. A phone's honest job is watching a balance and holding a
key.

## Difficulty & security
- Retarget every block with LWMA to resist timestamp manipulation and hashrate
  swings.
- The **perpetual tail** (0.3 EMBER/block) guarantees a standing reward, so
  security never depends on a speculative fee market (no "fee cliff").

## FAQ for miners
- **Do I need a GPU or ASIC?** No. A normal CPU is the intended machine. GPUs and
  ASICs gain little to nothing.
- **Can I join a pool for steadier payouts?** None exists today, and nothing in
  the protocol prevents one from being built — a pool would hand out work under
  its own key and pay hashers off chain. What consensus *does* guarantee is that
  work handed to you under your own key cannot be taken from you.
- **Will it drain my battery?** It will use whatever share of a core you give it and
  **nothing here is power-aware.** `hearth-mine`, the desktop app and `hearthd --mine`
  all have a duty-cycle throttle and no power awareness at all. The pause-on-battery
  behaviour belonged to the browser miner, which is gone — set the throttle down, or
  stop it, when you are unplugged.
- **How do I start?** Easiest is the desktop app (`app-desktop/`): it brings its
  own runtime and asks for a passphrase. Otherwise `hearth-mine --url <node>` on
  the command line, or `hearthd --evm --mine` if you want to validate the chain
  yourself as well. **From a browser, the Forge Network site's `/mine` page**
  (`micro-network-site`) — restored 2026-08-06; this line said there was no browser
  miner until 2026-08-09. **There is still no WASM light-miner**, and the browser one
  is JavaScript for the reason in §4: the bottleneck was async WebCrypto, not the
  language.
- **Do I have to trust the node I mine against?** For *validity*, yes: a light
  miner holds no chain, so it cannot tell whether the work is on the network
  everyone else is on. Point it at a node you trust — your own, ideally. For
  *payment*, no: work built for your key is redeemable only by you, and the miner
  refuses work that does not pay it before doing any of it.

## Production vs. proof-of-concept
`node/src/pow.js` is the algorithm the chain actually runs, and there is still
**only one implementation of it in this repository**. The browser twin
(`web/assets/mining/homefire.js`) and the CI suites that compared them
digest-for-digest — `node/test/browser-pow.js` and `node/test/browser-proof.js` —
were deleted with `web/` in `48bc28a` on 2026-08-04. The JS in `proto/` is an earlier
sketch of the same memory-hard core, is not conformance-tested, and is not consensus:
it hardcodes a 256 KiB pad and a 4096-step walk, hashes the nonce as 8 little-endian
bytes rather than as decimal text, and signs with Ed25519.

**The twin came back, in another repository, and the suites did not follow it for
three days.** `micro-network-site` restored `src/mining/{sha256,homefire,miner}.js` on
2026-08-06 and put it behind a public `/mine` page. Both suites are restored as of
2026-08-09 and now import that repository directly.

> **What that does and does not gate.** They are **not** in `npm test`, because that
> command has to pass on a checkout of this repository alone. They run in their own CI
> job (`.github/workflows/ci.yml`, job `browser`), which checks `micro-network-site`
> out first, and they **fail rather than skip** when the browser sources are absent —
> a skip line is indistinguishable from a pass at a glance, and that is close enough
> to what went wrong here.
>
> Measured 2026-08-09, against `micro-network-site` at `489903f`: `browser-pow` 11/11,
> `browser-proof` 12/12. Both were checked to still fail: flipping one term in the
> browser's scratchpad index derivation fails 4 of 11, and dropping the recovery byte
> from `proofSignature` fails 5 of 12.
>
> The other cross-implementation check, `rust/hearthd/src/pow.rs`, remains **known to
> diverge** — it omits the coinbase pubkey from the seed, so it computes a different
> digest for the same header, and nothing compares it to anything.

`rust/hearthd/src/pow.rs` is **not** a second implementation of consensus: it
omits the coinbase pubkey from the seed, so it computes a different digest for
the same header. See [why-two-implementations.md](why-two-implementations.md).
A hardened, audited RandomX-class VM is **not scheduled and is not claimed** — see
[roadmap.md](roadmap.md), "Dropped, or never real".
