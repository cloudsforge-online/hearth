'use strict';
/* Conformance tests for the 2048-bit logs bloom. Zero-dependency mini harness.
 * Run: node test/bloom.js
 *
 * A wrong bloom fails SILENTLY. It is still 256 bytes, it still ORs, it still
 * round-trips, and it still answers every query with "no" — so logs simply
 * never match, nothing throws, and the only symptom is an explorer whose
 * transfer history is empty. There is no assertion that catches that from the
 * inside. The only thing that catches it is a filter another client built, so
 * every vector here is one:
 *
 *   BLOCK_LOGS / BLOCK_BLOOM      the three logs of Ethereum mainnet block
 *                                 4,400,116 and the header's own logsBloom.
 *   RECEIPT_LOGS / RECEIPT_BLOOMS the two log-bearing receipts of that block,
 *                                 so per-receipt and per-block agreement are
 *                                 both pinned rather than one being derived
 *                                 from the other.
 *   DENSE_LOGS / DENSE_BLOOM      one receipt from block 16,777,216 with six
 *                                 logs and sixteen topics — 22 items, 66 bits.
 *                                 Sparse blooms are forgiving: with three logs
 *                                 a mirrored byte order can still collide into
 *                                 a plausible filter. A dense one cannot.
 *
 * MUTATION-TESTED against src/chain/bloom.js. Every one of these was made and
 * confirmed to fail, which is the only evidence a bloom test is doing anything
 * at all. Checks lost, out of 61:
 *
 *   the bit numbered from the top of its byte            37
 *   the byte index counted from the front, not 255 - n   37
 *   a 12-bit mask (0xfff) instead of 11                  32
 *   pairs read from h[1..], h[3..], h[5..]               10
 *   little-endian 16-bit pairs                           10
 *   two bits per item instead of three                    9
 *   four bits per item                                    9
 */

const B = require('../src/chain/bloom');
const { keccak256 } = require('../src/crypto/keccak');

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

const BLOCK_LOGS = [
  { address: '0x8f8221afbb33998d8584a2b05749ba73c37a938a',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x000000000000000000000000a1cd6183abd34b842b9515965213595e51b32bbd',
              '0x000000000000000000000000f8aa4529adb1b65fb6e6d5d90a0e226d9607ec2a'],
    data: '0x00000000000000000000000000000000000000000000071b8ff2a10222540000' },
  { address: '0x209c4784ab1e8183cf58ca33cb740efbf3fc18ef',
    topics: ['0x23919512b2162ddc59b67a65e3b03c419d4105366f7d4a632f5d3c3bee9b1cff'],
    data: '0x00000000000000000000000032be343b94f860124dc4fee278fdcbd38c102d88' },
  { address: '0x8f510f3b268a798f9840d68061a2baf15fd2ff58',
    topics: ['0x23919512b2162ddc59b67a65e3b03c419d4105366f7d4a632f5d3c3bee9b1cff'],
    data: '0x000000000000000000000000209c4784ab1e8183cf58ca33cb740efbf3fc18ef' },
];
const BLOCK_BLOOM =
'0x' +
  '000000000000000000000000000000020000000400000000801000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000080000000100000000000000000000000000000000' +
  '000000000000000000000040000000000000000000000010000000100000000000000280000000000000001000400000' +
  '000000000000000000000000000001000000000000000000001000000000000000000000000000000000000000000000' +
  '000000020000000000000000000000000000000000000000202000000000000000000000000000000000000000000000' +
  '00000000040000800000000001000000';
const RECEIPT_BLOOMS = [
  '0x' +
    '000000000000000000000000000000000000000400000000800000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000010000000100000000000000080000000000000000000000000' +
    '000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000' +
    '000000020000000000000000000000000000000000000000002000000000000000000000000000000000000000000000' +
    '00000000040000800000000001000000',
  '0x' +
    '000000000000000000000000000000020000000000000000001000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000' +
    '000000000000000000000040000000000000000000000000000000000000000000000200000000000000001000400000' +
    '000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000',
];
const RECEIPT_LOGS = [
  [
    { address: '0x8f8221afbb33998d8584a2b05749ba73c37a938a',
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x000000000000000000000000a1cd6183abd34b842b9515965213595e51b32bbd',
                '0x000000000000000000000000f8aa4529adb1b65fb6e6d5d90a0e226d9607ec2a'],
      data: '0x00000000000000000000000000000000000000000000071b8ff2a10222540000' },
  ],
  [
    { address: '0x209c4784ab1e8183cf58ca33cb740efbf3fc18ef',
      topics: ['0x23919512b2162ddc59b67a65e3b03c419d4105366f7d4a632f5d3c3bee9b1cff'],
      data: '0x00000000000000000000000032be343b94f860124dc4fee278fdcbd38c102d88' },
    { address: '0x8f510f3b268a798f9840d68061a2baf15fd2ff58',
      topics: ['0x23919512b2162ddc59b67a65e3b03c419d4105366f7d4a632f5d3c3bee9b1cff'],
      data: '0x000000000000000000000000209c4784ab1e8183cf58ca33cb740efbf3fc18ef' },
  ],
];

const DENSE_LOGS = [
  { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x000000000000000000000000000000000dfde7deaf24138722987c9a6991e2d4',
              '0x0000000000000000000000009c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c'],
    data: '0x000000000000000000000000000000000000000000000000598d33d514dcdff8' },
  { address: '0x45804880de22913dafe09f4980848ece6ecbaf78',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x0000000000000000000000009c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c',
              '0x000000000000000000000000000000000dfde7deaf24138722987c9a6991e2d4'],
    data: '0x0000000000000000000000000000000000000000000000004bebb2acb7b4d666' },
  { address: '0x45804880de22913dafe09f4980848ece6ecbaf78',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x0000000000000000000000009c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c',
              '0x00000000000000000000000038699d04656ff537ef8671b6b595402ebdbdf6f4'],
    data: '0x0000000000000000000000000000000000000000000000000003e34e8a33b512' },
  { address: '0x45804880de22913dafe09f4980848ece6ecbaf78',
    topics: ['0xf228de527fc1b9843baac03b9a04565473a263375950e63435d4138464386f46',
              '0x0000000000000000000000009c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c',
              '0x00000000000000000000000038699d04656ff537ef8671b6b595402ebdbdf6f4'],
    data: '0x0000000000000000000000000000000000000000000000000003e34e8a33b512' },
  { address: '0x9c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c',
    topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
    data: '0x0000000000000000000000000000000000000000000000644688fe1b7540f8680000000000000000000000000000000000000000000000763702e4ba52e818c0' },
  { address: '0x9c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c',
    topics: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
              '0x000000000000000000000000000000000dfde7deaf24138722987c9a6991e2d4',
              '0x000000000000000000000000000000000dfde7deaf24138722987c9a6991e2d4'],
    data: '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000598d33d514dcdff80000000000000000000000000000000000000000000000004bef95fb41e88b780000000000000000000000000000000000000000000000000000000000000000' },
];
const DENSE_BLOOM =
'0x' +
  '002000200000000000000000800000000000002000000000000000000000000000040000000000200000000000002400' +
  '020000000800000000000000000000000000000000000000000000080000002000000000100000000000000000000000' +
  '000000000000000000000000000000000008000000000002000000100000000020000000000000000000000000000200' +
  '000000000000000800000040000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000020100000000000000000000000008000000000010000100000020000000002000000000000000000000000000' +
  '0000000000000000000000000000c001';

// ---------------------------------------------------------------------------
// Real blooms
// ---------------------------------------------------------------------------

group('mainnet block 4,400,116', () => {
  ok(hex(B.fromLogs(BLOCK_LOGS)) === BLOCK_BLOOM, "every log in the block reproduces the header's logsBloom");
  for (let i = 0; i < RECEIPT_LOGS.length; i++) {
    ok(hex(B.fromLogs(RECEIPT_LOGS[i])) === RECEIPT_BLOOMS[i], `receipt ${i}: reproduces the published receipt bloom`);
  }
  /* The header field is defined as the OR of the receipts', and separately as
   * one filter over every log. Both definitions ship, so both are checked. */
  ok(hex(B.or(...RECEIPT_BLOOMS)) === BLOCK_BLOOM, 'OR-ing the receipt blooms gives the block bloom');
  ok(hex(B.or(...RECEIPT_LOGS.map(B.fromLogs))) === BLOCK_BLOOM, '…and so does OR-ing what they imply');
});

group('mainnet block 16,777,216 — a dense receipt', () => {
  const items = DENSE_LOGS.length + DENSE_LOGS.reduce((a, l) => a + l.topics.length, 0);
  ok(items === 22, `22 indexed items across ${DENSE_LOGS.length} logs`);
  ok(hex(B.fromLogs(DENSE_LOGS)) === DENSE_BLOOM, 'reproduces the published receipt bloom');

  /* Adding the same logs again must change nothing: the filter is a set, and
   * an implementation that counted or XORed instead of OR-ing would pass every
   * single-pass test above and fail here. */
  const twice = B.empty();
  for (const l of DENSE_LOGS) B.addLog(twice, l);
  for (const l of DENSE_LOGS) B.addLog(twice, l);
  ok(hex(twice) === DENSE_BLOOM, 'adding every log twice is idempotent');

  /* Order-independence, likewise: a header field that depended on log order
   * would fail on any node that indexed receipts differently. */
  ok(hex(B.fromLogs([...DENSE_LOGS].reverse())) === DENSE_BLOOM, 'and independent of log order');
});

// ---------------------------------------------------------------------------
// The construction itself
// ---------------------------------------------------------------------------

group('three bits, big-endian, 11-bit mask', () => {
  /* Pinning the derivation directly, not just its effect. Asserting only on
   * the finished filter tells you it is wrong; asserting on the bits tells you
   * which of the four rules broke. */
  const item = Buffer.from('c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'hex');   // WETH, from DENSE_LOGS
  const h = keccak256(item);
  const bits = B.bitsFor(item);
  ok(bits.length === 3, 'exactly three bits per item');
  ok(bits[0] === (((h[0] << 8) | h[1]) & 0x7ff), 'bit 0 is the low 11 bits of the big-endian pair h[0..1]');
  ok(bits[1] === (((h[2] << 8) | h[3]) & 0x7ff), 'bit 1 from h[2..3]');
  ok(bits[2] === (((h[4] << 8) | h[5]) & 0x7ff), 'bit 2 from h[4..5]');
  ok(bits.every(b => b >= 0 && b < 2048), 'every bit index is inside 2048');

  /* Where a bit LIVES. The 2048-bit filter is one big-endian number, so bit b
   * counts from the least significant end — byte 255 - (b >> 3). Numbering
   * from the front mirrors the whole filter, which still looks like a bloom. */
  const one = B.add(B.empty(), item);
  const expect = B.empty();
  for (const b of bits) expect[256 - 1 - (b >> 3)] |= 1 << (b & 7);
  ok(one.equals(expect), 'bit b sits in byte 255 - (b >> 3) at mask 1 << (b & 7)');
  ok(one.reduce((a, x) => a + x.toString(2).split('1').length - 1, 0) <= 3, 'and sets at most three bits');

  ok(B.empty().length === 256 && B.empty().every(x => x === 0), 'an empty bloom is 256 zero bytes');
  ok(B.BLOOM_BYTES === 256 && B.BLOOM_BITS === 2048, '256 bytes, 2048 bits');
});

group('membership', () => {
  const bloom = B.fromLogs(DENSE_LOGS);
  for (const log of DENSE_LOGS) {
    ok(B.contains(bloom, log.address), `contains ${log.address}`);
    for (const t of log.topics) ok(B.contains(bloom, t), `contains topic ${t.slice(0, 14)}…`);
  }
  /* The negative direction is the one the whole structure exists for, and the
   * one a mirrored or half-built filter still gets right by accident only
   * rarely — so it is checked over a spread of absent values. */
  let absent = 0, tried = 0;
  for (let i = 0; i < 64; i++) {
    const probe = keccak256(Buffer.from('absent-' + i, 'utf8'));
    tried++;
    if (!B.contains(bloom, probe)) absent++;
  }
  ok(absent === tried, `64 values that are not in the block are all reported absent (${absent}/${tried})`);
});

group('eth_getLogs filtering', () => {
  const bloom = B.fromLogs(DENSE_LOGS);
  const weth = DENSE_LOGS[0].address;
  const transfer = DENSE_LOGS[0].topics[0];
  const nowhere = '0x' + 'ee'.repeat(20);
  const noTopic = '0x' + 'ee'.repeat(32);

  ok(B.matches(bloom, {}) === true, 'an empty filter matches everything');
  ok(B.matches(bloom, { address: weth }) === true, 'a present address matches');
  ok(B.matches(bloom, { address: nowhere }) === false, 'an absent address does not');
  ok(B.matches(bloom, { address: [nowhere, weth] }) === true, 'an address list is an OR');
  ok(B.matches(bloom, { address: [nowhere] }) === false, 'a list of absent addresses does not match');
  ok(B.matches(bloom, { topics: [transfer] }) === true, 'a present topic matches');
  ok(B.matches(bloom, { topics: [noTopic] }) === false, 'an absent topic does not');
  ok(B.matches(bloom, { topics: [null, DENSE_LOGS[0].topics[1]] }) === true, 'a null topic position is a wildcard');
  ok(B.matches(bloom, { topics: [[noTopic, transfer]] }) === true, 'a topic list is an OR');
  ok(B.matches(bloom, { address: weth, topics: [transfer, noTopic] }) === false, 'positions are ANDed');

  /* The failure this must never have: a log that IS in the block reported as
   * not worth reading. False positives cost a wasted read; a false negative
   * loses the log forever, with no error anywhere. */
  let missed = 0;
  for (const log of DENSE_LOGS) {
    if (!B.matches(bloom, { address: log.address, topics: log.topics })) missed++;
  }
  ok(missed === 0, `no log in the block is filtered out of its own bloom (${missed} missed)`);
});

group('or', () => {
  const a = B.add(B.empty(), '0x' + '11'.repeat(20));
  const b = B.add(B.empty(), '0x' + '22'.repeat(20));
  const both = B.or(a, b);
  ok(B.contains(both, '0x' + '11'.repeat(20)) && B.contains(both, '0x' + '22'.repeat(20)), 'the union contains both');
  ok(B.or(a).equals(a) && B.or().equals(B.empty()), 'or of one is itself, or of none is empty');
  ok(B.or(a, a).equals(a), 'or is idempotent');
  ok(B.or(a, b).equals(B.or(b, a)), 'or is commutative');
  /* `or` must not alias its inputs — a block builder that ORs receipts into
   * the header field and then mutates a receipt would corrupt both. */
  const copy = Buffer.from(a);
  B.or(a, b)[0] = 0xff;
  ok(a.equals(copy), 'or returns a fresh buffer');
});

group('input handling', () => {
  ok(B.add(B.empty(), '0x' + '11'.repeat(20)).equals(B.add(B.empty(), Buffer.alloc(20, 0x11))), 'hex and Buffer items agree');
  ok(B.toBloom(BLOCK_BLOOM).length === 256, 'a 0x bloom parses');
  let threw = 0;
  for (const bad of [Buffer.alloc(255), Buffer.alloc(257), '0x00']) { try { B.toBloom(bad); } catch { threw++; } }
  ok(threw === 3, 'a bloom that is not 256 bytes is refused');
  /* The bloom hashes raw bytes and knows nothing of addresses versus topics,
   * so a 20-byte and a 32-byte item are simply different items. */
  ok(!B.contains(B.add(B.empty(), Buffer.alloc(20, 0x11)), Buffer.alloc(32, 0x11)), 'a padded address is a different item');
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
