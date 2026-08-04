'use strict';
/* Replaying the on-disk chain — including a chain too big to be a string.
 * Run: node test/chain-replay.js
 *
 * THE BOMB THIS DEFUSES. `load()` used to read the entire blocks file into ONE
 * JavaScript string before splitting it:
 *
 *     const lines = fs.readFileSync(this.file, 'utf8').split('\n')
 *
 * V8 refuses to make a string longer than `buffer.constants.MAX_STRING_LENGTH`
 * — 536,870,888 bytes on this runtime — and throws ERR_STRING_TOO_LONG. At the
 * ~1.5 KB per block this chain actually writes and a 15 s block interval, that
 * ceiling arrives at roughly 350,000 blocks, which is about SIXTY-ONE DAYS of
 * uptime. After that the node cannot start, and the chain is unreadable by the
 * only software that can read it. Long before the throw it is holding the whole
 * file AND the split array in memory at once, so a node degrades first and dies
 * later, which is the worst order for diagnosing it.
 *
 * It is a correctness bomb with a date on it rather than a capacity concern, and
 * it makes recovery time unbounded exactly when recovery matters.
 *
 * So the last section builds a blocks file BIGGER THAN THAT LIMIT and requires
 * the node to load it — and, on the very same file, requires the old one-string
 * approach to throw. That second assertion is the point: it is evidence inside
 * the suite that this test is capable of failing, and it cannot rot, because it
 * exercises the discarded implementation directly rather than describing it.
 *
 * Everything above it is the behaviour that had to survive the rewrite. The note
 * on `load()` in src/chain/blockchain.js is deliberate and load-bearing: a block
 * that no longer validates stops the replay FOR THAT BRANCH rather than aborting
 * the load, and the count is emitted as `replay-rejected` so an operator can
 * find out why their height went backwards instead of guessing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { constants: BUF } = require('buffer');

const P = require('../src/params');
const { Blockchain, BLOCKS_FILE } = require('../src/chain/blockchain');
const C = require('./evm-common');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const dirs = [];
const tmpdir = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-replay-${tag}-`)); dirs.push(d); return d; };
const BLOCKS = BLOCKS_FILE;

const miner = C.testKey('replay');
const gen = { target: C.EASY_TARGET };

/* The Blockchain directly rather than an EvmNode: `load()` is the thing under
 * test, and EvmNode calls it inside its constructor (src/evmnode.js), so there
 * is no moment at which a listener for `replay-rejected` could be attached. */

/** A chain with `n` mined blocks on disk. Returns its directory and its tip. */
function chainOf(n, tag) {
  const dir = tmpdir(tag);
  const chain = new Blockchain({ dataDir: dir, config: gen }).load();
  for (let i = 0; i < n; i++) {
    const b = C.mineOn(chain, chain.tipId, miner);
    const r = chain.addBlock(b);
    if (!r.ok) throw new Error('mine rejected: ' + r.err);
  }
  return { dir, tip: chain.tipId, height: chain.height, root: chain.stateAtTip().rootHex() };
}

/** Reopen a data directory, collecting any replay-rejected event. */
function reopen(dir) {
  const events = [];
  const chain = new Blockchain({ dataDir: dir, config: gen });
  chain.on('replay-rejected', e => events.push(e));
  chain.load();
  return { node: { chain, close() {} }, events };
}

const file = dir => path.join(dir, BLOCKS);
const lines = dir => fs.readFileSync(file(dir), 'utf8').split('\n').filter(Boolean);
const write = (dir, ls) => fs.writeFileSync(file(dir), ls.join('\n') + '\n');

(async () => {
  console.log('\nHearth chain replay\n');
  console.log(`  (this runtime: MAX_STRING_LENGTH is ${BUF.MAX_STRING_LENGTH.toLocaleString()} bytes — `
    + `about ${Math.floor(BUF.MAX_STRING_LENGTH / 1530).toLocaleString()} blocks, `
    + `${(BUF.MAX_STRING_LENGTH / 1530 / 5760).toFixed(0)} days at 15 s)`);

  // ==========================================================================
  group('an ordinary chain comes back exactly as it went out');
  // ==========================================================================
  const good = chainOf(6, 'good');
  {
    const { node, events } = reopen(good.dir);
    assert(node.chain.height === good.height, `height replays (${node.chain.height})`);
    assert(node.chain.tipId === good.tip, 'to the same tip');
    assert(node.chain.stateAtTip().rootHex() === good.root, 'and the same state root — every block was revalidated');
    assert(events.length === 0, 'and nothing was reported as rejected');
    node.close();
  }

  // ==========================================================================
  group('the deliberate behaviour on damage, which the rewrite had to keep');
  // ==========================================================================
  {
    // A line that is not JSON at all: counted, skipped, and the rest still loads.
    const dir = tmpdir('badjson');
    fs.cpSync(good.dir, dir, { recursive: true });
    const ls = lines(dir);
    write(dir, [...ls.slice(0, 3), '{not json at all', ...ls.slice(3)]);
    const { node, events } = reopen(dir);
    assert(events.length === 1 && events[0].rejected === 1, 'a corrupt line is counted as one rejection');
    assert(events[0].total === ls.length + 1, 'and the total names how many lines were considered');
    assert(node.chain.height === good.height,
      'and the blocks after it still load — one bad line is not a truncated chain');
    node.close();
  }
  {
    // A block that no longer validates stops THAT BRANCH. Deliberate: the
    // alternative is loading a chain whose state nobody can reproduce.
    const dir = tmpdir('forged');
    fs.cpSync(good.dir, dir, { recursive: true });
    const ls = lines(dir);
    const forged = JSON.parse(ls[2]);
    forged.header.stateRoot = 'ab'.repeat(32);
    write(dir, [...ls.slice(0, 2), JSON.stringify(forged), ...ls.slice(3)]);
    const { node, events } = reopen(dir);
    assert(node.chain.height < good.height, `a forged block truncates the branch (height ${node.chain.height})`);
    assert(events.length === 1 && events[0].rejected >= 1,
      `and the operator is told rather than left to notice (${events[0].rejected} rejected)`);
    node.close();
  }
  {
    // A file whose last write was cut short — a power cut mid-append.
    const dir = tmpdir('truncated');
    fs.cpSync(good.dir, dir, { recursive: true });
    const raw = fs.readFileSync(file(dir), 'utf8');
    fs.writeFileSync(file(dir), raw.slice(0, raw.length - 40));   // no trailing newline, half a block
    const { node, events } = reopen(dir);
    assert(node.chain.height === good.height - 1, 'a half-written final block is dropped, not fatal');
    assert(events.length === 1, 'and counted');
    node.close();
  }
  {
    // Blank lines are not blocks and are not rejections.
    const dir = tmpdir('blanks');
    fs.cpSync(good.dir, dir, { recursive: true });
    write(dir, lines(dir).flatMap(l => ['', l, '']));
    const { node, events } = reopen(dir);
    assert(node.chain.height === good.height, 'blank lines are skipped');
    assert(events.length === 0, 'and are not reported as damage');
    node.close();
  }
  {
    // A single line so long it could not be a block. Bounded rather than
    // buffered: the whole point of this change is not to hold unbounded strings.
    const dir = tmpdir('longline');
    fs.cpSync(good.dir, dir, { recursive: true });
    const ls = lines(dir);
    write(dir, [...ls, '{"junk":"' + 'x'.repeat(40 * 1024 * 1024) + '"}']);
    const { node, events } = reopen(dir);
    assert(node.chain.height === good.height, 'a 40 MiB line does not stop the blocks before it loading');
    assert(events.length === 1 && events[0].rejected === 1, 'and is counted once as damage');
    node.close();
    fs.rmSync(file(dir));                       // 40 MiB, gone before the big one below
  }

  // ==========================================================================
  group('a chain too big to be a JavaScript string');
  // ==========================================================================
  {
    const dir = tmpdir('huge');
    fs.cpSync(good.dir, dir, { recursive: true });
    const target = BUF.MAX_STRING_LENGTH + (4 << 20);          // comfortably past the ceiling

    /* Filler that is valid JSON and an invalid block, so the replay does real
     * per-line work — parse, reject, count — over the whole file rather than
     * skipping it. ~4 KB a line, which is a block with transactions in it. */
    const pad = 'y'.repeat(4000);
    const fd = fs.openSync(file(dir), 'a');
    const batch = [];
    for (let i = 0; i < 256; i++) batch.push(`{"filler":${i},"pad":"${pad}"}`);
    const chunk = Buffer.from(batch.join('\n') + '\n');
    let written = fs.statSync(file(dir)).size;
    const t0 = Date.now();
    while (written < target) { fs.writeSync(fd, chunk); written += chunk.length; }
    fs.closeSync(fd);
    const size = fs.statSync(file(dir)).size;
    console.log(`    wrote ${(size / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    assert(size > BUF.MAX_STRING_LENGTH,
      `the blocks file is ${(size / 1e6).toFixed(0)} MB — past the ${(BUF.MAX_STRING_LENGTH / 1e6).toFixed(0)} MB string ceiling`);

    /* THE OLD IMPLEMENTATION, RUN ON THIS EXACT FILE. Not a description of the
     * defect — the defect. If this ever stops throwing, the test above it has
     * stopped being able to fail and this line says so. */
    let oldErr = null;
    try { fs.readFileSync(file(dir), 'utf8'); }
    catch (e) { oldErr = e; }
    assert(oldErr !== null && /string longer than|ERR_STRING_TOO_LONG|Invalid string length/i.test(String(oldErr.message || oldErr)),
      `reading it as one string throws, as it always would have (${oldErr && (oldErr.code || oldErr.message)})`);

    const t1 = Date.now();
    const { node, events } = reopen(dir);
    console.log(`    replayed in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    assert(node.chain.height === good.height, `THE NODE STILL LOADS ITS CHAIN (height ${node.chain.height})`);
    assert(node.chain.tipId === good.tip, 'and reaches the same tip as the undamaged copy');
    assert(node.chain.stateAtTip().rootHex() === good.root, 'and the same state root');
    assert(events.length === 1 && events[0].rejected > 100_000,
      `and every filler line was counted as damage (${events.length ? events[0].rejected.toLocaleString() : 0})`);
    node.close();
    fs.rmSync(file(dir));                        // half a gigabyte, released promptly
  }

  // ==========================================================================
  group('the UTXO chain, which had the same bomb and one more besides');
  // ==========================================================================
  {
    /* src/chain.js is the retired chain and still runs `docker-compose.yml`, so
     * it gets the same fix. It also had a defect the account model did not:
     * `JSON.parse` was called bare inside the replay loop, so ONE truncated line
     * — which is exactly what a power cut during an append leaves — threw out of
     * the constructor and the node would not boot at all. */
    const { Chain } = require('../src/chain');
    const dir = tmpdir('utxo');
    const chain = new Chain(dir).load();
    const f = path.join(dir, 'blocks.ndjson');

    let broke = null;
    fs.writeFileSync(f, '{"header":{"height":1,   <- a power cut lands here\n');
    try { new Chain(dir).load(); } catch (e) { broke = e; }
    assert(broke === null, `a truncated final line no longer stops the node booting${broke ? ' — ' + broke.message : ''}`);

    /* …and neither does a line that IS valid JSON and is not a block. This one
     * is sharper than it looks: `_ingest` on this chain reaches
     * `block.header.version` and throws a TypeError on undefined, so it was not
     * the JSON parser that killed the boot, it was the validator. */
    let broke2 = null;
    fs.writeFileSync(f, '{"filler":1,"pad":"yyy"}\n');
    try { new Chain(dir).load(); } catch (e) { broke2 = e; }
    assert(broke2 === null,
      `a well-formed JSON line that is not a block does not either${broke2 ? ' — ' + broke2.message : ''}`);
    fs.writeFileSync(f, '{"header":{"height":1,   <- a power cut lands here\n');

    const events = [];
    const c2 = new Chain(dir);
    c2.on('replay-rejected', e => events.push(e));
    c2.load();
    assert(events.length === 1 && events[0].rejected === 1,
      'and is reported as damage rather than discarded, which MAP.md §8 records as missing here');
    assert(c2.height === 0, 'the chain loads to genesis rather than not at all');

    // …and the string ceiling, on this chain too.
    const pad = 'y'.repeat(4000);
    const batch = [];
    for (let i = 0; i < 256; i++) batch.push(`{"filler":${i},"pad":"${pad}"}`);
    const buf = Buffer.from(batch.join('\n') + '\n');
    const fd = fs.openSync(f, 'a');
    let written = fs.statSync(f).size;
    while (written < BUF.MAX_STRING_LENGTH + (4 << 20)) { fs.writeSync(fd, buf); written += buf.length; }
    fs.closeSync(fd);
    let hugeErr = null;
    let c3 = null;
    try { c3 = new Chain(dir).load(); } catch (e) { hugeErr = e; }
    assert(hugeErr === null && c3 !== null,
      `a ${(fs.statSync(f).size / 1e6).toFixed(0)} MB UTXO chain loads too${hugeErr ? ' — ' + hugeErr.code : ''}`);
    assert(c3 && c3.height === 0, 'to the height its valid blocks support');
    fs.rmSync(f);
    void chain;
  }

  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
