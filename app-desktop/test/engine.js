'use strict';
/* The desktop engine, driven exactly as the app drives it: as a child process
 * with a pipe on each end.
 * Run: node app-desktop/test/engine.js
 *
 * TWO CLAIMS, AND THEY NEED DIFFERENT KINDS OF EVIDENCE.
 *
 *   IT MINES. Not "the loop is unit-tested" — node/test/mine-session.js already
 *   says that — but that this process, spawned the way the app spawns it, takes
 *   work from a REAL hearthd over REAL HTTP and ends with the chain crediting the
 *   address the keystore holds. The balance is read out of the node afterwards.
 *   A UI screenshot is not evidence of mining; a credited account is.
 *
 *   IT LEAKS NOTHING. Every byte the process writes to stdout and to stderr is
 *   kept for the whole run and searched, at the end, for the passphrase, for the
 *   private key in three encodings, and for the ciphertext. This is the check
 *   that matters most, because the supervising process logs this stream, a crash
 *   reporter would upload it, and nobody reads it by eye. It has to be mechanical.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(__dirname, '..', 'engine', 'engine.js');
const HEARTHD = path.join(ROOT, 'node', 'bin', 'hearthd.js');
const KS = require(path.join(ROOT, 'node', 'src', 'mine', 'keystore'));
const { ember } = require(path.join(ROOT, 'node', 'src', 'coinbase'));

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dirs = [];
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-eng-${tag}-`)); dirs.push(d); return d; };
const procs = [];

const PASS = 'a passphrase nothing may ever repeat back';

/**
 * "Owner only", asserted the way the platform actually expresses it.
 *
 * On Windows there are no POSIX mode bits. `fs.chmod` there sets the read-only
 * flag and nothing else, and `stat().mode` comes back 0o666 or 0o444 — so
 * requiring 0o600 is a check that CANNOT PASS on Windows and says nothing about
 * whether the file is protected. It is not the assertion being dropped: what
 * protects the keystore on Windows is the ACL on the user profile that
 * `%APPDATA%` sits inside, which this suite has no business re-testing, plus the
 * encryption that is the actual guarantee everywhere.
 *
 * This was invisible until a Windows machine ran the suite, which until now none
 * ever had. Two of these were the first two failures on it.
 */
function ownerOnly(file, what) {
  if (process.platform === 'win32') {
    assert(fs.existsSync(file), `${what} (Windows has no mode bits; the ACL on the profile is what guards it)`);
    return;
  }
  assert((fs.statSync(file).mode & 0o777) === 0o600, what);
}

/** The engine, wrapped in the request/response discipline the Rust side uses. */
function engine(dataDir) {
  const p = spawn(process.execPath, [ENGINE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HEARTH_APP_DATA: dataDir },
  });
  procs.push(p);

  const e = {
    proc: p,
    // EVERYTHING it ever writes, on both streams, kept for the leak scan.
    out: '', err: '',
    events: [],
    _waiting: new Map(),
    _id: 0,
  };
  let buf = '';
  p.stdout.on('data', d => {
    e.out += d;
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event) { e.events.push(m); continue; }
      const w = e._waiting.get(m.id);
      if (w) { e._waiting.delete(m.id); w(m); }
    }
  });
  p.stderr.on('data', d => { e.err += d; });

  e.send = (cmd, args) => new Promise((resolve, reject) => {
    const id = ++e._id;
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${cmd}`)), 120_000);
    e._waiting.set(id, m => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n');
  });
  e.of = name => e.events.filter(x => x.event === name).map(x => x.data);
  e.until = async (fn, ms = 180_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); }
    return false;
  };
  return e;
}

(async () => {
  console.log('\nHearth desktop engine\n');

  // ==========================================================================
  group('first run: it has no key, and says so rather than inventing one');
  // ==========================================================================
  const appDir = tmpdir('app');
  const e = engine(appDir);
  assert(await e.until(() => e.of('ready').length === 1, 20_000), 'it announces itself when it is up');
  const ready = e.of('ready')[0];
  assert(!!ready.network && !!ready.coin, `on ${ready.network}, chain ${ready.chainId}, paying in ${ready.coin}`);

  let r = await e.send('status');
  assert(r.ok && r.result.keystore === null, 'there is no keystore yet');
  assert(r.result.unlocked === false && r.result.address === null, 'nothing is unlocked and there is no address to show');

  // ==========================================================================
  group('creating the key');
  // ==========================================================================
  r = await e.send('keystore.create', { passphrase: PASS });
  assert(r.ok, 'a keystore is created');
  const address = r.result.address;
  assert(/^0x[0-9a-f]{40}$/.test(address), `and the window is told the ADDRESS it will be paid at (${address})`);
  assert(r.result.unlocked === true, 'and left unlocked — nobody wants to retype a passphrase they just invented');
  assert(fs.existsSync(KS.keystorePath(appDir)), 'the file is on disk where the app said it would be');
  ownerOnly(KS.keystorePath(appDir), 'at mode 600');

  // The private key, which the TEST knows and the engine must never say.
  const secret = KS.revealPrivateKey(appDir, PASS).replace(/^0x/, '');
  const ciphertext = JSON.parse(fs.readFileSync(KS.keystorePath(appDir), 'utf8')).ciphertext;

  /* Deliberately the REAL passphrase. A command that FAILS while holding the
   * secret is the case the leak scan below actually needs: a success has no
   * error message to accidentally quote it in, so a scan with only successful
   * calls behind it is a check that cannot fail. */
  r = await e.send('keystore.create', { passphrase: PASS });
  assert(!r.ok && /already exists/i.test(r.err), 'a second create is refused rather than overwriting a funded key');
  assert(!r.err.includes(PASS), 'and the refusal does not quote the passphrase it was handed');

  r = await e.send('keystore.lock');
  assert(r.ok && r.result.unlocked === false, 'it can be locked again');
  assert(r.result.address === address, 'and STILL shows the address while locked — the file keeps it in the clear on purpose');

  r = await e.send('keystore.unlock', { passphrase: 'not the passphrase' });
  assert(!r.ok && /wrong passphrase|altered/i.test(r.err), 'a wrong passphrase is refused');
  r = await e.send('keystore.unlock', { passphrase: PASS });
  assert(r.ok && r.result.unlocked === true, 'and the right one opens it');

  r = await e.send('mine.start', { url: 'http://127.0.0.1:1' });
  const lockedFirst = await (async () => {
    await e.send('mine.stop');
    await e.send('keystore.lock');
    const x = await e.send('mine.start', { url: 'http://127.0.0.1:1' });
    await e.send('keystore.unlock', { passphrase: PASS });
    return x;
  })();
  assert(r.ok, 'mining starts once the key is open');
  assert(!lockedFirst.ok && /unlock/i.test(lockedFirst.err), 'and cannot start while it is locked — there would be nobody to pay');

  // ==========================================================================
  group('END TO END: the engine mines a real node, and the chain credits it');
  // ==========================================================================
  const REST = 19745 + (process.pid % 200);
  const seed = spawn(process.execPath, [HEARTHD, '--evm', '--data', tmpdir('seed'),
    '--p2p', '0', '--rpc', String(REST), '--jsonrpc', String(REST + 1000)], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(seed);
  const info = async () => fetch(`http://127.0.0.1:${REST}/info`).then(x => x.json()).catch(() => null);
  assert(await e.until(async () => (await info()) !== null, 40_000) !== false, 'a real hearthd is up and serving its REST API');
  {
    let up = null;
    for (let i = 0; i < 200 && !up; i++) { up = await info(); if (!up) await sleep(200); }
    assert(!!up, `the node answers /info at height ${up && up.height}`);
    assert(up.minerAddress.toLowerCase() !== address.toLowerCase(),
      'and it is NOT mining to our address — anything credited to us, we earned');
  }

  r = await e.send('mine.start', { url: `http://127.0.0.1:${REST}` });
  assert(r.ok && r.result.mining === true, 'the engine starts mining against it');

  assert(await e.until(() => e.of('work').length >= 1, 60_000), 'it takes work from the node');
  assert(await e.until(() => e.of('rate').length >= 1, 60_000),
    `and reports a hashrate (${(e.of('rate')[0] || {}).hashrate} H/s) — a miner that prints nothing is a miner you cannot trust`);
  assert(await e.until(() => e.of('accepted').length >= 2, 240_000),
    `THE NODE ACCEPTED ${e.of('accepted').length} BLOCKS FROM IT`);

  /* STOP BEFORE COUNTING, and the ordering is the assertion.
   *
   * A running miner is a moving target. This block used to read the engine's
   * tally, then read the chain's balance a moment later, and require the two to
   * be equal — two snapshots of different instants compared as though they were
   * one. At production proof-of-work cost the gap between blocks is minutes and
   * the window never opened; the moment CI began mining on `hearth-test`, where
   * a block lands in tens of milliseconds, it started failing with both numbers
   * correct and one of them merely newer. It failed on the Linux runner exactly
   * this way.
   *
   * Nothing is weakened by stopping first. A stopped session's final tally must
   * equal the chain's balance EXACTLY, with no allowance for timing, which is a
   * stronger statement than the flaky one it replaces — and it is now the whole
   * mining run being reconciled rather than an arbitrary prefix of it. */
  const stoppedBefore = e.of('stopped').length;
  r = await e.send('mine.stop');
  assert(r.ok && r.result.mining === false, 'it stops when asked');

  /* The LAST one: an earlier case in this file started and stopped a session
   * against a dead port, so `stopped` has been emitted before. `[0]` would have
   * been that one, and every assertion below it would have been about a session
   * that never mined anything. */
  const final = e.of('stopped').at(-1);
  assert(e.of('stopped').length === stoppedBefore + 1 && !!final,
    'saying so, with the final tally');

  const accepted = e.of('accepted');
  assert(accepted.length >= 2, `each announced with its height and reward (#${accepted.map(a => a.height).join(', #')})`);
  assert(Number(final.found) === accepted.length,
    `and the final tally matches the blocks announced (${final.found} vs ${accepted.length})`);

  // The claim, settled by the chain rather than by the miner.
  const bal = await fetch(`http://127.0.0.1:${REST + 1000}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  }).then(x => x.json());
  const wei = BigInt(bal.result || '0x0');
  assert(wei > 0n, `AND THE CHAIN SAYS SO: eth_getBalance(${address}) = ${ember(wei)} ${r.result.coin}`);
  assert(wei === BigInt(final.earnedWei),
    `which is exactly what the engine reported earning (${ember(BigInt(final.earnedWei))})`);

  // ==========================================================================
  group('getting the key out — without it ever crossing this channel');
  // ==========================================================================
  const backup = path.join(tmpdir('backup'), 'hearth-backup.json');
  r = await e.send('keystore.backup', { file: backup });
  assert(r.ok && fs.existsSync(backup), 'the encrypted keystore can be copied somewhere safe');
  assert(KS.decrypt(JSON.parse(fs.readFileSync(backup, 'utf8')), PASS).addressHex === address,
    'and the copy opens with the same passphrase, to the same address — that is what "backed up" means');
  r = await e.send('keystore.backup', { file: backup });
  assert(!r.ok && /already exists/i.test(r.err), 'it will not silently overwrite an existing backup');

  const exported = path.join(tmpdir('export'), 'private-key.txt');
  r = await e.send('key.export', { file: exported, passphrase: 'wrong' });
  assert(!r.ok && /wrong passphrase/i.test(r.err), 'exporting the raw key asks for the passphrase again');
  assert(!fs.existsSync(exported), 'and writes nothing when it is wrong');

  r = await e.send('key.export', { file: exported, passphrase: PASS });
  assert(r.ok && r.result.file === exported, 'with the right one it writes the key to the file the user named');
  ownerOnly(exported, 'at mode 600');
  assert(fs.readFileSync(exported, 'utf8').trim() === '0x' + secret, 'and the file really does hold the key');
  assert(!JSON.stringify(r).includes(secret), 'THE REPLY ITSELF CARRIES ONLY THE PATH — the key is not in it');

  r = await e.send('key.export', { file: exported, passphrase: PASS });
  assert(!r.ok && /already exists/i.test(r.err), 'a second export will not overwrite the first');
  assert(!r.err.includes(PASS), 'and that refusal, too, holds the real passphrase without repeating it');

  // ==========================================================================
  group('an unknown command is an answer, not a crash');
  // ==========================================================================
  r = await e.send('rm -rf /');
  assert(!r.ok && /unknown command/i.test(r.err), 'an unknown command is refused by name');
  e.proc.stdin.write('this is not json\n');
  await sleep(200);
  assert(e.proc.exitCode === null, 'and a line of rubbish does not kill the engine');
  r = await e.send('status');
  assert(r.ok, 'which is still answering afterwards');

  // ==========================================================================
  group('THE LEAK SCAN: every byte this process ever wrote');
  // Watched to fail by having `status` return `privateKey`, and again by having
  // `key.export` answer with the hex alongside the path. Both went red here and
  // nowhere else, which is the point of scanning the stream rather than the API.
  // ==========================================================================
  {
    const all = e.out + e.err;
    assert(all.length > 500, `${all.length} bytes were captured, so the scan has something to scan`);
    assert(!all.includes(secret), 'THE PRIVATE KEY IS NOWHERE IN IT — not in hex');
    assert(!all.includes(Buffer.from(secret, 'hex').toString('base64')), 'nor in base64');
    assert(!all.includes(secret.toUpperCase()), 'nor upper-cased');
    assert(!all.includes(PASS), 'THE PASSPHRASE IS NOWHERE IN IT — not even echoed back in an error');
    assert(!all.includes(ciphertext), 'nor is the ciphertext, which would let an offline guess be checked');
    assert(all.includes(address), '— while the ADDRESS is there, repeatedly, because that is the question a miner asks');
    assert(e.err === '', 'and stderr stayed empty: nothing escaped the JSON channel');
  }

  // ==========================================================================
  group('closing the pipe stops the miner');
  // An orphaned miner is invisible on a laptop until the fan tells you.
  // ==========================================================================
  {
    const e2 = engine(tmpdir('orphan'));
    await e2.until(() => e2.of('ready').length === 1, 20_000);
    await e2.send('keystore.create', { passphrase: PASS });
    const started = await e2.send('mine.start', { url: `http://127.0.0.1:${REST}` });
    assert(started.ok, 'a second engine is mining');
    e2.proc.stdin.end();
    const gone = await e2.until(() => e2.proc.exitCode !== null, 15_000);
    assert(gone, `when the app closes its pipe the engine exits (code ${e2.proc.exitCode})`);
  }

  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('\nFAIL —', err);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(1);
});
