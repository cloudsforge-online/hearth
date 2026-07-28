'use strict';
/* Conformance tests for receipts and the receipts trie. Zero-dependency mini
 * harness. Run: node test/receipt.js
 *
 * Vectors, and where each came from:
 *
 *   MAINNET_RECEIPTS   the six receipts of Ethereum mainnet block 4,400,116
 *                      (Byzantium, so post-EIP-658 status flags, and pre-Berlin
 *                      so every receipt is untyped) together with the header's
 *                      own receiptsRoot. That root is the strongest single
 *                      assertion available for this file: it fails if the field
 *                      order is wrong, if `status` is written as a state root,
 *                      if `cumulativeGasUsed` is per-transaction rather than
 *                      running, if a log is shaped wrongly, if the derived
 *                      bloom is wrong, if the trie is keyed by anything but
 *                      rlp(index), or if the secure variant is used by mistake.
 *
 *   LOGS_HASH_*        keccak256(rlp(logs)) taken from ethereum/tests
 *                      GeneralStateTests, which is how those fixtures publish
 *                      expected logs. `log0_emptyMem` is reproducible without
 *                      an interpreter because its emitter's code is literally
 *                      `PUSH1 0 PUSH1 0 LOG0 STOP` at a known address, so the
 *                      log it produces is known in advance.
 *
 * MUTATION-TESTED against src/chain/receipt.js. Checks lost, out of 62:
 *
 *   a state root in place of the status flag           28
 *   status and cumulativeGasUsed swapped               27
 *   a log encoded as [address, data, topics]           25
 *   keying the trie by the raw index, not rlp(index)    3
 *   using the secure (keccak-keyed) trie                3
 *   accepting a leading-zero status                     2
 *
 * The two trie mutations lost only ONE check each until the construction was
 * spelled out independently in the trie group; the mainnet root alone catches
 * them, but resting a consensus rule on a single assertion is how it quietly
 * stops being tested.
 */

const R = require('../src/chain/receipt');
const B = require('../src/chain/bloom');
const RLP = require('../src/crypto/rlp');
const { keccak256 } = require('../src/crypto/keccak');
const { Trie, MemoryDB, EMPTY_TRIE_ROOT } = require('../src/state/trie');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name, fn) {
  console.log('• ' + name);
  try { fn(); } catch (e) { fail++; console.log(`  ✗ ${name}: threw — ${e.message}`); }
}
const hex = b => '0x' + Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

const MAINNET_RECEIPTS = [
  { status: '0x1', cumulativeGasUsed: '0x5208',
    logs: [] },
  { status: '0x1', cumulativeGasUsed: '0xa96c',
    logs: [
      { address: '0x8f8221afbb33998d8584a2b05749ba73c37a938a',
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                 '0x000000000000000000000000a1cd6183abd34b842b9515965213595e51b32bbd',
                 '0x000000000000000000000000f8aa4529adb1b65fb6e6d5d90a0e226d9607ec2a'],
        data: '0x00000000000000000000000000000000000000000000071b8ff2a10222540000' },
    ] },
  { status: '0x1', cumulativeGasUsed: '0xfb74',
    logs: [] },
  { status: '0x1', cumulativeGasUsed: '0x195cc',
    logs: [
      { address: '0x209c4784ab1e8183cf58ca33cb740efbf3fc18ef',
        topics: ['0x23919512b2162ddc59b67a65e3b03c419d4105366f7d4a632f5d3c3bee9b1cff'],
        data: '0x00000000000000000000000032be343b94f860124dc4fee278fdcbd38c102d88' },
      { address: '0x8f510f3b268a798f9840d68061a2baf15fd2ff58',
        topics: ['0x23919512b2162ddc59b67a65e3b03c419d4105366f7d4a632f5d3c3bee9b1cff'],
        data: '0x000000000000000000000000209c4784ab1e8183cf58ca33cb740efbf3fc18ef' },
    ] },
  { status: '0x1', cumulativeGasUsed: '0x1e7d4',
    logs: [] },
  { status: '0x1', cumulativeGasUsed: '0x239dc',
    logs: [] },
];
const MAINNET_RECEIPTS_ROOT = '0xf43cca5df7d75b3260d6400210e25b496aa8df511ffe7db9dd8c5857798db22f';
const MAINNET_GAS_USED = '0x239dc';

/* GeneralStateTests publish expected logs as keccak256(rlp(logs)). The empty
 * one is the value that appears in nearly every fixture that emits nothing —
 * keccak256(0xc0) — and it is worth pinning on its own, because an
 * implementation that hashes the receipts instead of the logs, or that RLP-
 * encodes a JS `undefined` somewhere, still returns a plausible 32 bytes. */
const LOGS_HASH_EMPTY = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347';
/* stLogTests/log0_emptyMem.json, post.Shanghai[0].logs. The emitter at
 * 0x0f57… has code 0x60006000a000 — LOG0 with offset 0 and size 0 — so the
 * single log it produces has no topics and no data. */
const LOGS_HASH_LOG0 = '0xea63b4dbbdbca1bd985580a0c3b6f35a4955d4d4cf0b4d903003cdfc4c40ba1c';
const LOG0_EMITTER = '0x0f572e5295c57f15886f9b263e2f6d2d6c7b5ec6';

// ---------------------------------------------------------------------------
// The real block
// ---------------------------------------------------------------------------

group('mainnet block 4,400,116 — six real receipts', () => {
  ok(hex(R.receiptsRoot(MAINNET_RECEIPTS)) === MAINNET_RECEIPTS_ROOT,
    'the six receipts produce the header receiptsRoot');

  /* Every receipt in this block succeeded, and the last one's cumulative
   * figure is the header's gasUsed — the invariant that catches a
   * per-transaction gas field, which otherwise looks entirely reasonable. */
  const last = R.normalize(MAINNET_RECEIPTS[MAINNET_RECEIPTS.length - 1]);
  ok(last.cumulativeGasUsed === BigInt(MAINNET_GAS_USED), 'the last cumulativeGasUsed is the block gasUsed');
  let prev = 0n;
  let monotonic = true;
  for (const r of MAINNET_RECEIPTS) { const n = R.normalize(r); if (n.cumulativeGasUsed <= prev) monotonic = false; prev = n.cumulativeGasUsed; }
  ok(monotonic, 'cumulativeGasUsed strictly increases across the block');

  for (let i = 0; i < MAINNET_RECEIPTS.length; i++) {
    const enc = R.encode(MAINNET_RECEIPTS[i]);
    const back = R.decode(enc);
    ok(R.encode(back).equals(enc), `receipt ${i}: encode(decode(enc)) is byte-identical`);
    ok(back.status === 1, `receipt ${i}: status flag is 1, not a state root`);
    ok(back.logs.length === (MAINNET_RECEIPTS[i].logs || []).length, `receipt ${i}: log count survives the round trip`);
  }

  /* The bloom a receipt carries must be exactly the one its logs imply — the
   * network's own receipts are the reference for that, and test/bloom.js pins
   * the same thing from the other direction. */
  for (let i = 0; i < MAINNET_RECEIPTS.length; i++) {
    const n = R.normalize({ ...MAINNET_RECEIPTS[i], logsBloom: undefined });
    ok(n.logsBloom.equals(B.fromLogs(MAINNET_RECEIPTS[i].logs || [])), `receipt ${i}: derived bloom matches its logs`);
  }
});

// ---------------------------------------------------------------------------
// Encoding shape
// ---------------------------------------------------------------------------

group('encoding', () => {
  const r = { status: 1, cumulativeGasUsed: 21000n, logs: [] };
  const items = RLP.decode(R.encode(r));
  ok(Array.isArray(items) && items.length === 4, 'a receipt is [status, cumulativeGasUsed, logsBloom, logs]');
  ok(items[0].length === 1 && items[0][0] === 1, 'status 1 is one byte');
  ok(items[2].length === 256, 'the bloom is 256 bytes even when empty');
  ok(Array.isArray(items[3]) && items[3].length === 0, 'logs is an empty list');

  /* A failed receipt still exists, still carries its gas, and encodes status
   * as the EMPTY string — RLP's canonical zero. `0x00` would be a second
   * encoding of the same receipt and therefore a second receiptsRoot. */
  const failed = RLP.decode(R.encode({ status: 0, cumulativeGasUsed: 21000n, logs: [] }));
  ok(failed[0].length === 0, 'status 0 encodes as the empty string, not 0x00');
  ok(!R.encode({ status: 0, cumulativeGasUsed: 21000n, logs: [] }).equals(R.encode(r)), 'success and failure differ');

  const log = { address: '0x' + 'ab'.repeat(20), topics: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)], data: '0xdeadbeef' };
  const withLog = RLP.decode(R.encode({ status: 1, cumulativeGasUsed: 1n, logs: [log] }));
  ok(withLog[3].length === 1 && withLog[3][0].length === 3, 'a log is [address, topics, data]');
  ok(withLog[3][0][0].length === 20, 'the address comes first, 20 bytes');
  ok(Array.isArray(withLog[3][0][1]) && withLog[3][0][1].length === 2, 'the topics are a list, second');
  ok(withLog[3][0][2].toString('hex') === 'deadbeef', 'the data is last, unpadded');

  let threw = 0;
  const refuse = fn => { try { fn(); } catch { threw++; } };
  refuse(() => R.normalize({ status: 2, cumulativeGasUsed: 0n, logs: [] }));
  refuse(() => R.normalize({ status: 1, cumulativeGasUsed: 0n, logs: [{ address: '0x1234', topics: [], data: '0x' }] }));
  refuse(() => R.normalize({ status: 1, cumulativeGasUsed: 0n, logs: [{ address: '0x' + 'ab'.repeat(20), topics: ['0x11'], data: '0x' }] }));
  refuse(() => R.normalize({ status: 1, cumulativeGasUsed: 0n, logs: [{ address: '0x' + 'ab'.repeat(20), topics: new Array(5).fill('0x' + '11'.repeat(32)), data: '0x' }] }));
  ok(threw === 4, `a status of 2, a short address, a short topic and a fifth topic are all refused (${threw}/4)`);
});

group('decoding rejects non-canonical scalars', () => {
  /* The same rule as the transaction decoder, for the same reason (spec §5):
   * RLP cannot know `status` is a number, so the minimality rule has to live
   * in the decoder or nowhere. */
  const bloom = Buffer.alloc(256);
  const bad = (items, why) => {
    let rejected = false;
    try { R.decode(RLP.encode(items)); } catch { rejected = true; }
    ok(rejected, why);
  };
  ok(R.decode(RLP.encode([Buffer.alloc(0), Buffer.alloc(0), bloom, []])).status === 0, 'empty status decodes as 0');
  bad([Buffer.from([0]), Buffer.alloc(0), bloom, []], '0x00 status is rejected');
  bad([Buffer.from([1]), Buffer.from([0, 1]), bloom, []], 'a leading zero on cumulativeGasUsed is rejected');
  bad([Buffer.from([2]), Buffer.alloc(0), bloom, []], 'a status of 2 is rejected');
  bad([Buffer.from([1]), Buffer.alloc(0), Buffer.alloc(255), []], 'a 255-byte bloom is rejected');
  bad([Buffer.from([1]), Buffer.alloc(0), bloom], 'a 3-item list is not a receipt');
  bad([Buffer.from([1]), Buffer.alloc(0), bloom, [[Buffer.alloc(20), Buffer.alloc(0)]]], 'a 2-item log is rejected');
});

// ---------------------------------------------------------------------------
// The trie
// ---------------------------------------------------------------------------

group('the receipts trie', () => {
  ok(R.receiptsRoot([]).equals(EMPTY_TRIE_ROOT), 'no receipts gives the empty trie root');

  /* Index 0 is rlp(0) = 0x80, the empty string — NOT 0x00. Pinning the key
   * itself is worth a line, because getting it wrong changes only the root and
   * every read still works. */
  ok(RLP.encode(0).equals(Buffer.from([0x80])), 'the key for index 0 is 0x80');
  ok(RLP.encode(1).equals(Buffer.from([0x01])), 'the key for index 1 is 0x01');
  ok(RLP.encode(128).equals(Buffer.from([0x81, 0x80])), 'the key for index 128 is 0x8180');

  /* Order is part of the root: swapping two receipts must change it, or the
   * trie is not committing to the position of anything. */
  const a = { status: 1, cumulativeGasUsed: 21000n, logs: [] };
  const b = { status: 0, cumulativeGasUsed: 42000n, logs: [] };
  ok(!R.receiptsRoot([a, b]).equals(R.receiptsRoot([b, a])), 'the root depends on receipt order');

  /* Past 127 the key stops being a single byte, which is where a hand-rolled
   * "just use the index as a byte" implementation quietly stops matching. */
  const many = Array.from({ length: 200 }, (_, i) => ({ status: 1, cumulativeGasUsed: BigInt(21000 * (i + 1)), logs: [] }));
  const root = R.receiptsRoot(many);
  ok(root.length === 32 && !root.equals(EMPTY_TRIE_ROOT), '200 receipts produce a root');
  ok(!R.receiptsRoot(many.slice(0, 199)).equals(root), 'and dropping the last one changes it');

  /* trieRoot is shared with the transaction trie on purpose — one construction,
   * one place to be wrong. */
  ok(R.trieRoot(many.map(R.encode)).equals(root), 'receiptsRoot is trieRoot over the encodings');

  /* Spelled out independently here, so that the two trie rules — non-secure,
   * keyed by rlp(index) — are each pinned by something other than the single
   * mainnet root above. Either of them broken alone leaves every read working
   * and only the root wrong. */
  const built = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
  many.forEach((r, i) => built.put(RLP.encode(i), R.encode(r)));
  ok(built.root().equals(root), 'the root is a NON-secure trie keyed by rlp(index)');
  const secure = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: true });
  many.forEach((r, i) => secure.put(RLP.encode(i), R.encode(r)));
  ok(!secure.root().equals(root), '…and the secure variant would give a different one');
  const rawKeyed = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
  many.forEach((r, i) => rawKeyed.put(Buffer.from([i & 0xff]), R.encode(r)));
  ok(!rawKeyed.root().equals(root), '…and so would keying by the raw index');
});

// ---------------------------------------------------------------------------
// logsHash — how the state-transition vectors publish expected logs
// ---------------------------------------------------------------------------

group('logsHash', () => {
  ok(hex(R.logsHash([])) === LOGS_HASH_EMPTY, 'no logs hashes to keccak256(rlp([]))');
  ok(hex(keccak256(Buffer.from([0xc0]))) === LOGS_HASH_EMPTY, '…which is keccak256(0xc0)');
  ok(hex(R.logsHash([{ address: LOG0_EMITTER, topics: [], data: '0x' }])) === LOGS_HASH_LOG0,
    'GeneralStateTests stLogTests/log0_emptyMem');
  ok(hex(R.logsHash(MAINNET_RECEIPTS[1].logs)) !== LOGS_HASH_EMPTY, 'a real log hashes to something else');
});

group('block aggregation', () => {
  /* receiptsBloom must agree whether the receipts carry their own bloom or the
   * blooms are derived — two definitions of the header field that have to be
   * the same one. */
  const derived = R.receiptsBloom(MAINNET_RECEIPTS.map(r => ({ logs: r.logs })));
  const carried = R.receiptsBloom(MAINNET_RECEIPTS);
  ok(derived.equals(carried), 'the block bloom is the same whether taken from logs or from receipts');
  ok(derived.equals(B.fromLogs(MAINNET_RECEIPTS.flatMap(r => r.logs || []))),
    '…and the same as one bloom over every log in the block');
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
