# Hearth desktop miner

Mine EMBER from a Mac, a PC or a Linux box. One window, one key, and an honest
answer to the five questions a person mining at home actually has: **am I
connected, am I hashing, how fast, what have I earned, and which address is being
paid.**

It is a **light miner**, not a node. It takes work from a Hearth node over the
HTTP mining API, grinds Homefire locally, signs each winning digest with a key
that never leaves the machine, and posts the proof back. No chain on your laptop,
no sync, **no inbound port** — which is why it works through the Cloudflare
Tunnel the estate is published behind. If you want to validate the chain
yourself, that is a different program and it is still here: `hearthd --evm
--mine`.

> ### What this replaces
>
> The previous contents of this directory were scaffolding, and said so: three
> native commands with zero callers, a frontend that was the static web wallet
> and never called `invoke`, and a path resolver that worked relative to the
> *current working directory* — so it could only ever have resolved from a
> developer's checkout. All four of its stated blockers are fixed. The one it
> did not list — that the key was written to disk in the clear — is fixed too.

## Run it

```bash
cd app-desktop
npm install
npm run icons          # once: generates the app icons from ../web/assets/logo.svg
npm run runtime        # once: fetches + SHA-256-verifies the bundled Node runtime
npm run dev            # the app, in dev mode
npm run build          # a distributable bundle
```

`npm run build` runs `npm run runtime` first, so a release always carries its own
runtime. **A user needs nothing installed** — not Node, not Rust, not a wallet.

## Where the key lives, and what protects it

`<app data>/coinbase-keystore.json`, and it is **encrypted at rest**:

| | |
|---|---|
| Derivation | **scrypt**, N = 2¹⁸ = 262 144, r = 8, p = 1 — 256 MiB and about half a second per guess. Memory hardness is the point: it takes away the parallelism a GPU farm would otherwise bring to a stolen file. |
| Cipher | **AES-256-GCM** — *authenticated*. A tampered file must fail, not decrypt to some other key, because a key that silently becomes a different key mines to an address you do not control. |
| In the clear | Only the **address**, so the app can tell you who it pays before you unlock anything — and it is bound in as GCM additional data, so editing it breaks decryption rather than making the window display a lie. |
| Passphrase | Yours. It is **never generated and hidden from you**, because the reason to do that (a one-click first run) is not worth the reason not to (a dead laptop then becomes an unrecoverable loss). |
| Keychain | The OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) **remembers the passphrase** if you tick the box, so a machine that reboots at 4am comes back mining. It never holds the only copy of anything, and a machine with no keychain simply asks you to type it. |

**Your backup is one file plus one passphrase.** Deliberately a single artefact:
splitting the secret between the file and the keychain would be stronger against
a thief and much weaker against a dead disk, and the money is gone either way.

Two properties are enforced mechanically rather than promised:

* **No private key, passphrase or ciphertext ever crosses the engine's stdout or
  stderr.** `app-desktop/test/engine.js` keeps every byte the process writes for
  the whole run and searches it. That is why there is no "show me my private
  key" button: exporting one writes it to a file you name, at mode 600, and the
  reply carries only the path.
* **The window never holds the key.** It lives in one process, and the webview —
  which renders, can be inspected, and ends up in screenshots — is told the
  address and nothing else.

## Proving it mines

A screenshot of a user interface is not evidence that anything was mined. The
binary has a `--selftest` that drives exactly the production path — the same
resolution, the same spawn, the same protocol — with no window:

```bash
# a node to mine against
node ../node/bin/hearthd.js --evm --data /tmp/seed --p2p 0 --rpc 18645 --jsonrpc 18545

# the app, mining it
src-tauri/target/release/hearth-desktop --selftest --url http://127.0.0.1:18645 --blocks 2

# and the chain's own answer, which is the part that counts
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["<the address it printed>","latest"]}' \
  http://127.0.0.1:18545/
```

## Tests

```bash
npm test                      # wiring + engine + the Rust unit tests
node test/wiring.js           # do the window, the shell and the engine agree?
node test/engine.js           # the engine mines a real node — and leaks nothing
cargo test --manifest-path src-tauri/Cargo.toml
```

`test/wiring.js` exists because of how the scaffolding failed: a registered
command with no caller compiles, lints, builds and opens, and does nothing. It
requires the three files to line up **in both directions** — no caller without a
command, and no command without a caller — and checks the same for events and
for element ids. It found one in this application's own first draft.

The mining loop itself is tested where it lives: `node/test/mine-session.js` and
`node/test/mine-keystore.js`.

## Layout

```
app-desktop/
├── ui/                     the window. Plain HTML/CSS/JS, no framework, no build step
├── engine/engine.js        one mining session + one key, as JSON lines on stdin/stdout
├── scripts/fetch-node.mjs  fetches and SHA-256-verifies the bundled Node runtime
├── test/                   wiring.js, engine.js
└── src-tauri/
    ├── src/main.rs         Tauri commands, and --selftest
    ├── src/engine.rs       spawning and supervising the engine; path resolution
    ├── src/keychain.rs     the OS keychain, for the passphrase only
    └── tauri.conf.json     window, CSP, resources, the Node sidecar
```

**The mining loop is not in this directory.** It is
[`node/src/mine/session.js`](../node/src/mine/session.js), shared unmodified with
the `hearth-mine` command-line miner. A second implementation drifts from the
first, and this repository has already paid for that: the browser miner signed a
64-byte proof for months while the node required 65, and every block it ever
found was refused *after* the work was done. `src/engine.rs` explains why that
rules out a Rust port as well.

## What is built, and what is only configured

| Platform | State |
|---|---|
| **macOS (aarch64)** | **Built and run.** `Hearth.app` is produced, carries its own Node runtime, opens, spawns its engine, and `--selftest` mined blocks that a real node credited. |
| macOS `.dmg` | **Not produced here.** `bundle_dmg.sh` fails at `hdiutil attach` in this environment; the `.app` inside it is complete. |
| **Windows / Linux** | **Configured, not built.** `fetch-node.mjs` knows both targets, `Cargo.toml` selects the right keychain backend for each, and `main.rs` handles `node.exe`. None of it has been compiled or run — no Windows or Linux machine was involved. Treat as unverified until CI or a person builds it. |

CI does not build this app. Tauri needs each platform's webview toolchain, and
adding that job would have meant editing `.github/workflows/`, which another
agent holds.

## Prerequisites (to build; a user needs none of this)

* [Rust](https://rustup.rs) (stable)
* Node.js 18+ for the Tauri CLI and the fetch script
* Platform webview deps — see [Tauri's prerequisites](https://tauri.app/start/prerequisites/)
  (macOS: Xcode command-line tools; Linux: webkit2gtk; Windows: WebView2)
