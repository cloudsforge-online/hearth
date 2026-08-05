#!/usr/bin/env node
/* What the installer actually contains, and whether it mines.
 * Run: node app-desktop/scripts/verify-bundle.mjs        (after `npm run build`)
 *
 * WHY THIS EXISTS. Until this file, "Windows and Linux" meant a table in
 * TARGETS, a `[target.'cfg(target_os = ...)']` block, and a sentence in a README
 * promising all three worked. None of it had been compiled. A compiled installer
 * is better evidence, but it is still weak evidence: it proves the code links,
 * not that the application starts, not that the runtime inside it can execute on
 * the machine it is going to, and not that any of it mines. Those are three
 * different failures and every one of them happens at a user's first launch,
 * which is the worst possible place to find out.
 *
 * So this reads the artefact the bundler produced and requires four things of it.
 *
 *   THE RUNTIME IS THE RIGHT PLATFORM'S. Its magic number is checked and then it
 *   is EXECUTED — `--version` must print the version fetch-node.mjs pinned. A
 *   Mach-O binary inside a Windows installer passes every check that does not run
 *   it, and fails on a stranger's PC.
 *
 *   THE PACKAGE HOLDS WHAT THE RESOLVER LOOKS FOR. src-tauri/src/engine.rs finds
 *   the sidecar beside the executable and the engine under the platform's
 *   resource directory. Those are different directories on all three platforms,
 *   and the bundler decides them, not us. Checking the layout by hand once is how
 *   it was wrong on Linux.
 *
 *   IT DOES NOT SHIP A FILE CALLED `node` INTO /usr/bin. Tauri's deb and rpm
 *   bundlers put every externalBin there. Debian's own `nodejs` package owns
 *   /usr/bin/node, dpkg refuses to unpack over another package's file, and the
 *   package would not install at all on a machine with Node from apt.
 *
 *   IT MINES. The installed binary is run with `--selftest` against a real
 *   hearthd, and the chain is asked afterwards whether the address it printed was
 *   paid. A window is not evidence; a credited account is.
 *
 *   ITS WINDOW OPENS. `--selftest` deliberately opens none, so for a while a
 *   fully green run said the engine, the runtime, the paths and the mining loop
 *   were right and said NOTHING about whether the interface drew — and nobody
 *   had ever seen this application's window on Windows or on Linux. `--smoke`
 *   opens the real window on the real page, under `xvfb-run` where there is no
 *   display, and the page reports its own layout back.
 *
 * WHAT IT STILL DOES NOT CLAIM. No pixels are read. Layout ran and a section was
 * measured with real dimensions, which is a strong statement that the interface
 * DRAWS; whether it is LEGIBLE — fonts, contrast, a control clipped off the edge
 * — is a different question and still needs a person to look at it once per
 * platform.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, STEM, hostTriple, BINARIES_DIR, executableKind } from './fetch-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const REPO = path.join(APP, '..');
const BUNDLE = path.join(APP, 'src-tauri', 'target', 'release', 'bundle');
const CONF = JSON.parse(fs.readFileSync(path.join(APP, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const PRODUCT = CONF.productName;
const MAIN_BIN = 'hearth-desktop';
const EXE = process.platform === 'win32' ? '.exe' : '';

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmpdirs = [];
const tmp = tag => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-verify-${tag}-`));
  tmpdirs.push(d);
  return d;
};

/** `execFileSync`, but a non-zero exit is a value rather than a throw. */
function run(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', ...opts }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, err: e };
  }
}

/** Every file under a directory, as paths relative to it, with `/` separators. */
function walk(root, base = root, out = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const listDir = d => (fs.existsSync(d) ? fs.readdirSync(d).map(f => path.join(d, f)) : []);

// ===========================================================================
// 1. The runtime that was fetched for this build
// ===========================================================================
function checkRuntime() {
  group('the Node runtime this build put in the bundle');
  const triple = hostTriple();
  const sidecar = path.join(BINARIES_DIR, `${STEM}-${triple}${EXE}`);

  assert(fs.existsSync(sidecar),
    `fetch-node.mjs wrote it under the triple the bundler will strip (${path.basename(sidecar)})`);
  if (!fs.existsSync(sidecar)) return null;

  const want = { win32: 'pe', linux: 'elf', darwin: 'macho' }[process.platform];
  assert(executableKind(sidecar) === want,
    `and it is a ${want} binary, which is the only kind this platform can exec`);

  /* THE CHECK THAT NEEDED A MACHINE. Everything above is a file inspection and
   * could be done from anywhere; this runs the thing. It is the whole reason the
   * build moved to CI rather than staying on one developer's Mac. */
  const v = run(sidecar, ['--version']);
  assert(v.ok && v.out.trim() === VERSION,
    `AND IT RUNS HERE: \`${path.basename(sidecar)} --version\` → ${v.out.trim() || '(nothing)'}, pinned at ${VERSION}`);
  return sidecar;
}

// ===========================================================================
// 2. What the bundler produced, and what is inside it
// ===========================================================================

/** The resource paths every platform must carry, whatever it calls its root. */
const REQUIRED_RESOURCES = [
  'engine/engine.js',
  // `hearth/src`, not `node/src` — see the comment in engine.rs's find_engine.
  'hearth/src/mine/session.js',
  'hearth/src/params.js',
];

function checkContents(label, entries, { binDir, resDir }) {
  /* FIRST, THAT THE LISTING WAS READ AT ALL. The first version of this file
   * required a `./` prefix on every path, because that is what `dpkg-deb -c`
   * prints for a conventionally-built package — and Tauri's deb writer does not
   * emit one. Every path parsed to nothing, and the run reported five missing
   * files inside a package that contained all five. A check that cannot tell
   * "absent" from "unreadable" sends whoever reads it to the wrong place. */
  assert(entries.length >= 10,
    `${label}: its listing was readable — ${entries.length} entries`);
  const has = suffix => entries.some(e => e === suffix || e.endsWith('/' + suffix));
  assert(has(`${binDir}${MAIN_BIN}${EXE}`) || has(`${binDir}${PRODUCT}${EXE}`),
    `${label}: the application itself is in ${binDir || 'the root'}`);
  assert(has(`${binDir}${STEM}${EXE}`),
    `${label}: the Node runtime is BESIDE it, as \`${STEM}${EXE}\`, which is where find_node looks`);
  for (const r of REQUIRED_RESOURCES) {
    assert(has(`${resDir}${r}`), `${label}: ${resDir}${r}`);
  }
  return entries;
}

/** Linux only, and the reason the sidecar is not called `node`. */
function checkNoUsrBinNode(label, entries) {
  const collision = entries.filter(e => /(^|\/)usr\/bin\/node$/.test(e));
  assert(collision.length === 0,
    `${label}: NOTHING is installed as /usr/bin/node — that path belongs to Debian's `
    + `\`nodejs\` package and dpkg refuses to unpack over it${collision.length ? ` (found ${collision})` : ''}`);
}

function checkBundleMacos() {
  group('the macOS bundle');
  const app = path.join(BUNDLE, 'macos', `${PRODUCT}.app`);
  assert(fs.existsSync(app), `${PRODUCT}.app was produced`);
  if (!fs.existsSync(app)) return null;
  checkContents('.app', walk(app), { binDir: 'Contents/MacOS/', resDir: 'Contents/Resources/' });

  /* The .dmg was previously "not produced here" — hdiutil could not attach in
   * the environment the app was first built in. On a real macOS runner it can,
   * so a missing one now is a failure rather than a footnote. */
  const dmg = listDir(path.join(BUNDLE, 'dmg')).filter(f => f.endsWith('.dmg'));
  assert(dmg.length === 1, `and a .dmg alongside it (${dmg.map(f => path.basename(f)).join(', ') || 'none'})`);
  return path.join(app, 'Contents', 'MacOS', MAIN_BIN);
}

function checkBundleLinux() {
  group('the Linux packages');
  const deb = listDir(path.join(BUNDLE, 'deb')).filter(f => f.endsWith('.deb'));
  assert(deb.length === 1, `a .deb was produced (${deb.map(f => path.basename(f)).join(', ') || 'none'})`);
  if (deb.length !== 1) return null;

  const listing = run('dpkg-deb', ['-c', deb[0]]);
  assert(listing.ok, 'dpkg can read it — which is also the first thing an installer does');
  /* `-rwxr-xr-x root/root 9868976 2026-08-05 07:16 usr/bin/hearth-desktop`, and
   * a symlink adds ` -> target`. The leading `./` is OPTIONAL: dpkg prints
   * whatever the tar members are named, and Tauri's writer does not add one. */
  const entries = listing.out.split('\n')
    .map(l => (l.match(/^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+?)\s*$/) || [])[1])
    .filter(Boolean)
    .map(p => p.split(' -> ')[0].replace(/^\.\//, '').replace(/\/$/, ''));
  checkContents('.deb', entries, { binDir: 'usr/bin/', resDir: `usr/lib/${PRODUCT}/` });
  checkNoUsrBinNode('.deb', entries);

  for (const [dir, ext] of [['rpm', '.rpm'], ['appimage', '.AppImage']]) {
    const found = listDir(path.join(BUNDLE, dir)).filter(f => f.endsWith(ext));
    assert(found.length >= 1, `and a ${ext} (${found.map(f => path.basename(f)).join(', ') || 'none'})`);
  }
  return deb[0];
}

function checkBundleWindows() {
  group('the Windows installer');
  const nsis = listDir(path.join(BUNDLE, 'nsis')).filter(f => f.endsWith('.exe'));
  assert(nsis.length === 1, `an NSIS installer was produced (${nsis.map(f => path.basename(f)).join(', ') || 'none'})`);
  if (nsis.length !== 1) return null;

  /* 7-Zip reads an NSIS archive without running it, which is the only way to see
   * what is in there without changing the machine. It is preinstalled on the
   * Windows runners and on most developer PCs; a missing 7z is reported rather
   * than skipped silently, because a check that quietly does not run is worse
   * than one that is absent. */
  const listing = run('7z', ['l', '-ba', '-slt', nsis[0]]);
  assert(listing.ok, '7z can list it (needed to inspect an installer without installing it)');
  if (listing.ok) {
    const entries = listing.out.split('\n')
      .map(l => (l.match(/^Path = (.+?)\r?$/) || [])[1])
      .filter(Boolean)
      .map(p => p.split('\\').join('/'));
    checkContents('installer', entries, { binDir: '', resDir: '' });
  }

  const msi = listDir(path.join(BUNDLE, 'msi')).filter(f => f.endsWith('.msi'));
  assert(msi.length >= 1, `and an .msi (${msi.map(f => path.basename(f)).join(', ') || 'none'})`);
  return nsis[0];
}

// ===========================================================================
// 3. Install it the way a user would, then make it mine
// ===========================================================================

/** @returns the path to the installed executable, or null. */
function install(artefact) {
  if (process.platform === 'darwin') return artefact;      // the .app runs where it is

  if (process.platform === 'linux') {
    group('installing the .deb, which is where /usr/bin/node would have bitten');
    const r = run('sudo', ['dpkg', '-i', artefact], { stdio: 'pipe' });
    assert(r.ok, `dpkg -i accepted the package${r.ok ? '' : ' — ' + r.out.trim().split('\n').slice(-3).join(' / ')}`);
    const bin = `/usr/bin/${MAIN_BIN}`;
    assert(fs.existsSync(bin), `and put the application at ${bin}`);
    assert(fs.existsSync(`/usr/lib/${PRODUCT}/engine/engine.js`),
      `with its engine at /usr/lib/${PRODUCT}/engine/engine.js — the directory Tauri's own resolver reads`);
    return fs.existsSync(bin) ? bin : null;
  }

  group('installing the NSIS package silently, as an unattended install would');
  const r = run(artefact, ['/S'], { stdio: 'pipe' });
  assert(r.ok, 'the installer ran to completion');
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', PRODUCT),
    path.join(process.env['ProgramFiles'] || '', PRODUCT),
    path.join(process.env['ProgramFiles(x86)'] || '', PRODUCT),
  ];
  const root = roots.find(d => d && fs.existsSync(path.join(d, `${MAIN_BIN}.exe`)));
  assert(!!root, `and the application is installed (looked in: ${roots.filter(Boolean).join(', ')})`);
  if (!root) return null;
  assert(fs.existsSync(path.join(root, `${STEM}.exe`)), `with the Node runtime beside it`);
  return path.join(root, `${MAIN_BIN}.exe`);
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
}).then(r => r.json());

async function mineWithIt(bin) {
  group('THE INSTALLED APPLICATION MINES, ON THIS PLATFORM, AND THE CHAIN SAYS SO');

  /* `hearth-test` shrinks the PoW pad so a block is seconds rather than minutes
   * — node/src/params.js:15 and its POW_SCRATCH_KIB. Difficulty, retargeting,
   * signing, the proof format and the acceptance rules are untouched, so what is
   * being proven is unchanged; only the grind is affordable. Both processes get
   * the same value or they are on different chains. */
  const env = { ...process.env, HEARTH_NETWORK: 'hearth-test' };
  const rest = 19300 + (process.pid % 300);
  const rpc = rest + 1000;

  const node = spawn(process.execPath, [
    path.join(REPO, 'node', 'bin', 'hearthd.js'), '--evm',
    '--data', tmp('chain'), '--p2p', '0', '--rpc', String(rest), '--jsonrpc', String(rpc),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env });

  let info = null;
  for (let i = 0; i < 200 && !info; i++) {
    info = await fetch(`http://127.0.0.1:${rest}/info`).then(r => r.json()).catch(() => null);
    if (!info) await sleep(200);
  }
  assert(!!info, `a real hearthd is up on ${env.HEARTH_NETWORK} at height ${info && info.height}`);
  if (!info) { node.kill('SIGKILL'); return; }

  /* Never printed, and it has to be a real secret rather than a fixture: the
   * scan below is only worth running if a leak would be a leak. */
  const passphrase = `verify-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const out = await new Promise(resolve => {
    const p = spawn(bin, [
      '--selftest', '--url', `http://127.0.0.1:${rest}`, '--blocks', '1', '--data', tmp('appdata'),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, HEARTH_SELFTEST_PASSPHRASE: passphrase },
    });
    let text = '';
    p.stdout.on('data', d => { text += d; });
    p.stderr.on('data', d => { text += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 600_000);
    p.on('close', code => { clearTimeout(kill); resolve({ code, text }); });
    p.on('error', e => { clearTimeout(kill); resolve({ code: -1, text: String(e) }); });
  });

  console.log(out.text.split('\n').map(l => '    | ' + l).join('\n'));

  /* On Windows the release binary is subsystem:windows and therefore starts with
   * no console. It only says anything at all because main.rs attaches to the
   * parent's — or, as here, because the caller handed it a pipe. An empty
   * transcript with exit 0 would be indistinguishable from a pass, so the
   * transcript is required to exist before anything is read out of it. */
  assert(out.text.trim().length > 0, 'the packaged binary printed its transcript rather than exiting silently');
  assert(/PASS —/.test(out.text) && out.code === 0, `--selftest passed (exit ${out.code})`);
  assert(/bundled with the app/.test(out.text),
    'and it used the runtime SHIPPED IN THE PACKAGE, not one it found on this machine');

  const address = (out.text.match(/paid to\s+(0x[0-9a-fA-F]{40})/) || [])[1];
  assert(!!address, `it mined to its own keystore address (${address})`);
  assert(!!address && info.minerAddress.toLowerCase() !== address.toLowerCase(),
    'which is NOT the node\'s own coinbase — anything credited to it, the app earned');

  if (address) {
    const bal = await post(`http://127.0.0.1:${rpc}/`,
      { method: 'eth_getBalance', params: [address, 'latest'] });
    const wei = BigInt(bal.result || '0x0');
    assert(wei > 0n, `AND THE CHAIN AGREES: eth_getBalance(${address}) = ${wei} wei`);
  }

  assert(!out.text.includes(passphrase),
    'the transcript does not contain the passphrase it was given — the leak rule holds through packaging too');

  node.kill('SIGKILL');
}

// ===========================================================================
// 4. And then open its window, because none of the above does
// ===========================================================================

/** Run the INSTALLED binary with `--smoke`, which opens the real window.
 *
 * Everything above this deliberately avoids the interface: `--selftest` opens no
 * window, so a fully green run used to leave "does it draw on Windows and Linux"
 * completely unanswered — the webview is a different product on each platform
 * (WKWebView, WebView2, WebKitGTK) and is precisely the part a successful
 * compile cannot vouch for. `--smoke` opens the window, waits for ui/app.js to
 * render into it, and measures the result from inside the page. See the block
 * above `run_smoke` in src-tauri/src/main.rs.
 *
 * Linux runners have no display, so this needs an X server. `xvfb-run` is a real
 * one with a real framebuffer — layout genuinely happens, it simply is not shown
 * to anyone. macOS and Windows runners already have a window server in session.
 */
async function smokeWindow(bin) {
  group('AND ITS WINDOW OPENS, ON THIS PLATFORM, WITH THE INTERFACE DRAWN INTO IT');

  const data = tmp('smokedata');
  const [cmd, args] = process.platform === 'linux'
    // -a picks a free display number; the app must not inherit a stale one.
    ? ['xvfb-run', ['-a', '--server-args=-screen 0 1280x1024x24', bin]]
    : [bin, []];

  const out = await new Promise(resolve => {
    const p = spawn(cmd, [...args, '--smoke', '--data', data, '--timeout', '120'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', d => { text += d; });
    p.stderr.on('data', d => { text += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 180_000);
    p.on('close', code => { clearTimeout(kill); resolve({ code, text }); });
    p.on('error', e => { clearTimeout(kill); resolve({ code: -1, text: String(e) }); });
  });

  console.log(out.text.split('\n').map(l => '    | ' + l).join('\n'));

  assert(out.text.trim().length > 0, 'the packaged binary printed its smoke transcript');
  assert(/the webview loaded /.test(out.text),
    'the webview was created and finished loading the bundled index.html');
  assert(/ui\/app\.js ran and called get_settings over IPC/.test(out.text),
    "the application's OWN script ran under the real CSP and reached the backend over IPC");
  /* The load-bearing one. Every <section> in ui/index.html ships `hidden`; only
   * app.js's render() unhides one. A section with real width and height cannot
   * happen unless the script ran and the engine laid the document out. */
  assert(/PASS — the window opened/.test(out.text) && out.code === 0,
    `a <section> is drawn with real dimensions — the interface renders here (exit ${out.code})`);
}

// ===========================================================================

console.log(`\nHearth desktop — what is actually in the ${process.platform} package, and does it mine?\n`);

const sidecar = checkRuntime();
const artefact = { darwin: checkBundleMacos, linux: checkBundleLinux, win32: checkBundleWindows }[
  process.platform]();

if (sidecar && artefact) {
  const bin = install(artefact);
  if (bin) {
    await mineWithIt(bin);
    await smokeWindow(bin);
  } else assert(false, 'nothing was installed, so nothing could be run');
}

for (const d of tmpdirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks`);
console.log('NOT CHECKED HERE: that what the window drew is LEGIBLE. Layout ran and was');
console.log('measured; no pixels were read, so fonts, contrast and clipping still need eyes.\n');
process.exit(failed === 0 ? 0 : 1);
