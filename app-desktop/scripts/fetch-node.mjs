#!/usr/bin/env node
/* Put a Node.js runtime inside the app bundle.
 *
 * WHY. The scaffolding this replaces assumed Node was installed and on PATH, and
 * its own README listed that as one of four reasons it was unshippable. It is
 * the right complaint: the person this application is for has a Mac and a PC and
 * has never heard of Node, and "install a JavaScript runtime first" is not a
 * step in mining a coin. So the runtime ships with the app, as a Tauri
 * `externalBin` sidecar placed next to the executable, and src/engine.rs prefers
 * it over anything on PATH.
 *
 * WHY THE ENGINE IS JAVASCRIPT AT ALL, given that cost: the mining loop is
 * node/src/mine/session.js and it is shared, unmodified, with the command-line
 * miner. A Rust port would be a second implementation of consensus-adjacent
 * code, and rust/README.md documents what happened to the last one — its
 * `pow.rs` omits the coinbase public key from the seed and would produce proofs
 * every node on the network rejects. Sixty megabytes is a cheap price for not
 * having two miners that disagree.
 *
 * THE DOWNLOAD IS VERIFIED. nodejs.org publishes SHASUMS256.txt beside each
 * release; the archive is checked against it before anything is unpacked. An
 * unverified binary placed inside a signed application bundle would be a supply
 * chain with no chain.
 *
 *   node scripts/fetch-node.mjs                 # this machine's platform
 *   node scripts/fetch-node.mjs --target x86_64-pc-windows-msvc
 *   node scripts/fetch-node.mjs --all           # every platform, for a release
 *
 * Zero npm dependencies: fetch and zlib are Node's, and unpacking shells out to
 * `tar`, which is present on macOS, on Linux, and on Windows 10 and later.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* Pinned, not "latest". A build that silently changes its runtime between two
 * runs is not reproducible, and the version that shipped is the one anybody
 * debugging a report needs to be able to get back. */
const VERSION = 'v22.14.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src-tauri', 'binaries');
const CACHE = path.join(os.tmpdir(), 'hearth-node-runtime');

/* The name it is installed under, and it is deliberately NOT `node`.
 *
 * Tauri's Linux bundlers copy every externalBin into /usr/bin beside the main
 * executable (tauri-bundler debian.rs:118,130 and rpm.rs:150, both through
 * settings.rs:1160-1176). A sidecar called `node` therefore installs as
 * /usr/bin/node — the file Debian's own `nodejs` package owns — so dpkg refuses
 * the package on any machine with Node from apt, and replaces the system
 * runtime on any machine without it. Must match RUNTIME_STEM in
 * src-tauri/src/engine.rs and `externalBin` in tauri.conf.json; a Rust test
 * (`the_config_and_the_resolver_agree_on_both_names`) holds two of the three
 * together and `test/wiring.js` holds this one to them. */
const STEM = 'hearth-node';

/** Rust target triple → the name Node publishes its build under. */
const TARGETS = {
  'aarch64-apple-darwin': { dist: 'darwin-arm64', ext: 'tar.gz', bin: 'bin/node', out: 'node' },
  'x86_64-apple-darwin': { dist: 'darwin-x64', ext: 'tar.gz', bin: 'bin/node', out: 'node' },
  'x86_64-unknown-linux-gnu': { dist: 'linux-x64', ext: 'tar.gz', bin: 'bin/node', out: 'node' },
  'aarch64-unknown-linux-gnu': { dist: 'linux-arm64', ext: 'tar.gz', bin: 'bin/node', out: 'node' },
  'x86_64-pc-windows-msvc': { dist: 'win-x64', ext: 'zip', bin: 'node.exe', out: 'node.exe' },
  'aarch64-pc-windows-msvc': { dist: 'win-arm64', ext: 'zip', bin: 'node.exe', out: 'node.exe' },
};

function hostTriple() {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  const plat = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
  if (!arch || !plat) throw new Error(`no Node build is published for ${process.platform}/${process.arch}`);
  return `${arch}-${plat}`;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} — HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The published SHASUMS256.txt for this release, as name → digest. */
async function shasums() {
  const text = (await download(`https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`)).toString('utf8');
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (m) map.set(m[2], m[1]);
  }
  if (map.size === 0) throw new Error('SHASUMS256.txt was empty or unreadable — refusing to trust the download');
  return map;
}

/** The first four bytes, read as an executable format. */
export function executableKind(file) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';                 // "MZ"
  if (head.toString('latin1') === '\x7fELF') return 'elf';
  const be = head.readUInt32BE(0);
  // Mach-O thin (either endianness) or a universal binary.
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(be)) {
    return 'macho';
  }
  return `unknown (${head.toString('hex')})`;
}

async function fetchOne(triple, sums) {
  const t = TARGETS[triple];
  if (!t) throw new Error(`unknown target ${triple}. Known: ${Object.keys(TARGETS).join(', ')}`);

  const stem = `node-${VERSION}-${t.dist}`;
  const archive = `${stem}.${t.ext}`;
  const want = sums.get(archive);
  if (!want) throw new Error(`${archive} is not listed in SHASUMS256.txt for ${VERSION}`);

  fs.mkdirSync(CACHE, { recursive: true });
  const cached = path.join(CACHE, archive);
  let bytes;
  if (fs.existsSync(cached)) {
    bytes = fs.readFileSync(cached);
  } else {
    process.stdout.write(`  downloading ${archive} … `);
    bytes = await download(`https://nodejs.org/dist/${VERSION}/${archive}`);
    process.stdout.write(`${(bytes.length / 1e6).toFixed(1)} MB\n`);
  }

  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) {
    fs.rmSync(cached, { force: true });
    throw new Error(
      `${archive} does not match the published SHA-256.\n`
      + `  published ${want}\n  downloaded ${got}\n`
      + '  Refusing to put an unverified binary inside the application bundle.');
  }
  fs.writeFileSync(cached, bytes);

  // Unpack just the one file we want. `tar` reads zip on Windows 10+ (bsdtar).
  const work = fs.mkdtempSync(path.join(CACHE, 'x-'));
  execFileSync('tar', ['-xf', cached, '-C', work, `${stem}/${t.bin}`], { stdio: 'inherit' });

  fs.mkdirSync(OUT, { recursive: true });
  /* Tauri's externalBin convention: the file beside `binaries/hearth-node` in
   * the config must be suffixed with the target triple, and it is placed next to
   * the executable in the bundle with the suffix stripped. */
  const suffix = t.out.endsWith('.exe') ? '.exe' : '';
  const dest = path.join(OUT, `${STEM}-${triple}${suffix}`);
  fs.copyFileSync(path.join(work, stem, t.bin), dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(work, { recursive: true, force: true });

  /* WHAT WAS FETCHED, not what was asked for. A build that puts a Mach-O binary
   * inside a Windows installer fails at first launch on a stranger's machine and
   * nowhere else, so the magic number is read back off the file that will ship
   * and checked against the target it was fetched for. It costs four bytes. */
  const kind = executableKind(dest);
  const wantKind = { 'pc-windows-msvc': 'pe', 'unknown-linux-gnu': 'elf', 'apple-darwin': 'macho' }[
    triple.split('-').slice(1).join('-')];
  if (kind !== wantKind) {
    fs.rmSync(dest, { force: true });
    throw new Error(
      `${path.basename(dest)} is a ${kind} binary, and ${triple} needs ${wantKind}. `
      + 'Refusing to bundle a runtime that cannot run on the platform it ships to.');
  }

  const size = (fs.statSync(dest).size / 1e6).toFixed(1);
  console.log(`  ✓ ${triple} → ${path.relative(process.cwd(), dest)} (${size} MB, ${kind}, sha256 verified)`);
}

/* Exported, and the module only RUNS when it is the program being run.
 *
 * `verify-bundle.mjs` needs the pinned version, the name the sidecar is written
 * under and the host's triple in order to check what the bundler produced. A
 * second copy of "which Node belongs on this platform" is the same drift this
 * whole file exists to prevent — so it imports these instead, and importing must
 * therefore not download 100 MB. */
export { VERSION, STEM, TARGETS, hostTriple, OUT as BINARIES_DIR };

export async function main(argv) {
  const all = argv.includes('--all');
  const i = argv.indexOf('--target');
  const triples = all ? Object.keys(TARGETS) : [i >= 0 ? argv[i + 1] : hostTriple()];

  console.log(`Node ${VERSION} runtime for: ${triples.join(', ')}`);
  const sums = await shasums();
  for (const t of triples) await fetchOne(t, sums);
  console.log('\nThe app now carries its own runtime. A user needs nothing installed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
