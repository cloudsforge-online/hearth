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
npm run icons          # once: generates the app icons from ../branding/logo.svg
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

## Proving it draws

`--selftest` opens no window, which is what makes it good evidence about mining
and no evidence at all about the interface. `--smoke` is the other half: it runs
the ordinary application — same builder, same window, same page, same CSP — and
then makes the page measure itself.

```bash
src-tauri/target/release/hearth-desktop --smoke --data /tmp/smoke --timeout 120

# on a machine with no display, which is what CI is:
xvfb-run -a src-tauri/target/release/hearth-desktop --smoke --data /tmp/smoke
```

It establishes four things in order: the webview was created and finished
loading the bundled `index.html`; `ui/app.js` ran under the real CSP and
completed an IPC round trip; and — the load-bearing one — a `<section>` has real
width and height. Every section in `index.html` ships `hidden` and only
`app.js`'s `render()` unhides one, so a visible section cannot happen unless the
script ran *and* the engine laid the document out.

It reads no pixels. Layout ran; whether the result is *legible* is a different
question and still wants a person.

## Tests

```bash
npm test                      # wiring + engine + the Rust unit tests
node test/wiring.js           # do the window, the shell and the engine agree?
node test/engine.js           # the engine mines a real node — and leaks nothing
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/verify-bundle.mjs   # after `npm run build`: what is IN the
                                 # installer, then install it, mine with it,
                                 # and open its window
```

`HEARTH_NETWORK=hearth-test` in front of the two that mine shrinks the
proof-of-work pad (`node/src/params.js`) and turns three minutes into ten
seconds. Difficulty, retargeting, signing, the proof format and the acceptance
rules are untouched, so the claim being proven does not change — only the grind
is affordable. That is what CI uses.

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
├── scripts/
│   ├── fetch-node.mjs      fetches and SHA-256-verifies the bundled Node runtime
│   └── verify-bundle.mjs   opens the built installer, installs it, mines with
│                           it, and opens its window
├── test/                   wiring.js, engine.js
└── src-tauri/
    ├── src/main.rs         Tauri commands, --selftest and --smoke
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

## What is built, what is proven, and what is still nobody's evidence

`.github/workflows/desktop.yml` builds all three natively — `ubuntu-latest`,
`windows-latest`, `macos-14` — on every change to `app-desktop/`, to the shared
`node/src`, or to the logo. Each job installs the platform's toolchain, fetches
and hash-verifies the Node runtime, runs the wiring and engine suites, builds the
installers, and then runs `scripts/verify-bundle.mjs`, which **installs the
package, mines a block with it, and opens its window**.

| | Built | Runtime inside it runs | Installs | Mines, chain-verified | Window opens and draws | Looked at by a person |
|---|---|---|---|---|---|---|
| **Linux x86_64** | deb, rpm, AppImage | ✓ | `dpkg -i` | ✓ | ✓ (under `xvfb`) | **no** |
| **Windows x86_64** | NSIS, MSI | ✓ | silent `/S` | ✓ | ✓ | **no** |
| **macOS aarch64** | `.app`, `.dmg` | ✓ | runs in place | ✓ | ✓ | ✓ |

**The last two columns are the honest ones, and they are different claims.**
`--smoke` proves the window is created, the page loads, `app.js` runs and a
section is laid out with real dimensions — the interface *draws*. It reads no
pixels, so whether the interface is *right* — fonts, contrast, a control clipped
off the edge of the window — is still unestablished on Windows and on Linux, and
wants one person to look at it once per platform. Until this change even the
first claim was unmade: `--selftest` opens no window, so a fully green build said
nothing whatever about the interface.

## Getting it

`.github/workflows/desktop-release.yml` publishes to a **GitHub Release**, which
for a desktop application is the distribution channel — a container registry
cannot serve a `.dmg` to a person with a browser, and a signed apt/dnf repository
would need a signing key and a host to serve it. Pushing a `v*` tag runs the
whole of `desktop.yml` first and publishes only if all three platforms passed,
with a `SHA256SUMS.txt` alongside.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Run artefacts are *not* a distribution: they need a GitHub login, they expire
after fourteen days, and they arrive zipped. That gap is why no installer had
ever reached a user despite a green build.

**Nothing here is code-signed.** Windows shows SmartScreen and macOS refuses the
`.dmg` until it is right-click-opened. Both need paid certificates in the owner's
name; the checksums are the interim answer, and the release notes say so.

Three defects were found by compiling the two platforms that never had been.
Each is a fault that no amount of building on a Mac could have surfaced:

* **The Node sidecar could not be called `node`.** Tauri's `deb` and `rpm`
  bundlers copy every `externalBin` into `/usr/bin`
  (`tauri-bundler` `linux/debian.rs:118,130`, `rpm.rs:150`, via
  `settings.rs:1160-1176`), so it would have installed as `/usr/bin/node` — the
  path Debian's own `nodejs` package owns, which `dpkg` refuses to unpack over.
  The package would not have installed on any machine with Node from apt, and on
  one without it would have replaced the system runtime. It is `hearth-node` now,
  in all four places that name it, and `verify-bundle.mjs` fails the build if
  anything called `node` ever appears in `/usr/bin` again.
* **`--selftest` could not find its own engine on Linux.** The path resolver had
  a macOS branch and treated Linux like Windows, but a `.deb` puts the executable
  in `/usr/bin` and the resources in `/usr/lib/Hearth` — not beside it. The Linux
  root is now the same one Tauri's own resolver uses
  (`tauri-utils/src/platform.rs:310-312`).
* **`--selftest` could not print anything on Windows.** The release binary is
  `windows_subsystem = "windows"`, so it starts with no console and `println!`
  goes nowhere; a passing run and a failing run were both silent. It attaches to
  the parent console now, unless the caller already gave it somewhere to write.

### One open advisory, and why it is not fixed here

Adding `src-tauri/Cargo.lock` surfaced RUSTSEC's unsoundness advisory for
`glib` 0.18.5 (`VariantStrIter`'s `Iterator`/`DoubleEndedIterator` impls,
medium). It reaches this app **only on Linux**, and only as a transitive
dependency:

```
glib 0.18.5 → atk 0.18.2 → gtk 0.18.2 → muda/tao → tauri 2.11
```

`cargo update -p glib` moves nothing — 0.18.5 is the newest release in that
series, and the fix is in gtk-rs 0.20, which Tauri 2.11 does not use. So it
closes when Tauri moves, not before; Dependabot's own attempt at it failed for
the same reason. Nothing in `src/` touches `glib`, and the macOS build does not
contain it at all (`cargo tree -i glib` prints nothing there).

It is no longer only a paper exposure: the Linux job compiles that dependency
tree on every run, so when Tauri does move to gtk-rs 0.20 the change will be
visible here rather than assumed.

## Prerequisites (to build; a user needs none of this)

* [Rust](https://rustup.rs) (stable)
* Node.js 18+ for the Tauri CLI and the fetch script
* Platform webview deps — see [Tauri's prerequisites](https://tauri.app/start/prerequisites/)
  (macOS: Xcode command-line tools; Linux: webkit2gtk; Windows: WebView2)
