'use strict';
/* Tests for precompile 0x09 — BLAKE2b's compression function F (EIP-152).
 * Run: node test/blake2f.js
 *
 * Three independent layers, because each catches something the others cannot.
 *
 *   1. THE EIP'S OWN EIGHT VECTORS, verbatim, including the four that assert
 *      FAILURE. The failing four are the ones worth having: a wrong length and a
 *      final flag of 2 are the two ways a caller reaches this precompile with
 *      something that must not be compressed, and an implementation that quietly
 *      accepts either is wrong in a way no positive vector can see.
 *
 *   2. A DIFFERENTIAL AGAINST NODE'S OWN BLAKE2b. The EIP's vectors all use 12
 *      rounds on a single block, which is exactly the case where a wrong SIGMA row
 *      ordering beyond row 1, a wrong rotation, or a mishandled byte counter can
 *      still come out right. So a complete BLAKE2b-512 is built here out of nothing
 *      but the precompile, and run against OpenSSL's at every length from 0 to 400.
 *      That exercises multi-block chaining, the t counter crossing a block
 *      boundary, and the final-block flag, none of which the EIP vectors touch.
 *
 *   3. THE ENDIAN AND FLAG RULES, asserted directly. The round count is BIG-endian
 *      and everything else in the same 213 bytes is LITTLE-endian; that mismatch is
 *      the single most common implementation error in this precompile, and it is
 *      invisible for round counts under 256 — which is every published vector. So
 *      it gets its own check with a round count above 255.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const B = require('../src/evm/blake2f');
const P = require('../src/evm/precompiles');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(actual, expected, msg) {
  if (actual === expected) pass++;
  else { fail++; console.log(`  ✗ ${msg}: expected ${expected}, got ${actual}`); }
}
function group(name) { console.log('• ' + name); }
const buf = (h) => Buffer.from(h, 'hex');
const hex = (b) => (b === null ? '<fail>' : Buffer.from(b).toString('hex'));

// ---------------------------------------------------------------------------
// 1. EIP-152's published vectors
// ---------------------------------------------------------------------------

/* Copied from EIP-152 "Test cases", vectors 0 through 8. Vector 8 asks for
 * 0xffffffff rounds; at one gas per round that is 4.29 billion gas, 143 times a
 * full block, so it can never be executed on chain. Its ROUND COUNT is still
 * asserted below, because reading those four bytes little-endian turns 4.29
 * billion into 4.29 billion the other way round and the vector is the only place
 * that shows. */
/** h (64 bytes, the BLAKE2b IV with the parameter block folded in) followed by m
 *  (128 bytes, the message "abc" padded). The t counter and the flag are appended
 *  per vector, because those are what the vectors vary. */
const COMMON =
  '48c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5' +
  'd182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b' +
  '6162630000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';

const EIP152 = [
  { n: 0, input: '', expected: null, why: 'empty input' },
  { n: 1, input: '00000c' + COMMON + '03000000000000000000000000000000' + '01',
    expected: null, why: 'three-byte round count: 212 bytes, one short' },
  { n: 2, input: '0000000000' + COMMON + '03000000000000000000000000000000' + '01',
    expected: null, why: 'five-byte round count: 214 bytes, one long' },
  { n: 3, input: '0000000c' + COMMON + '03000000000000000000000000000000' + '02',
    expected: null, why: 'final flag of 2' },
  { n: 4, input: '00000000' + COMMON + '03000000000000000000000000000000' + '01',
    expected: '08c9bcf367e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5' +
              'd282e6ad7f520e511f6c3e2b8c68059b9442be0454267ce079217e1319cde05b',
    why: 'zero rounds — the state is only xored with the IV' },
  { n: 5, input: '0000000c' + COMMON + '03000000000000000000000000000000' + '01',
    expected: 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
              '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    why: 'twelve rounds, final block — this is blake2b("abc")' },
  { n: 6, input: '0000000c' + COMMON + '03000000000000000000000000000000' + '00',
    expected: '75ab69d3190a562c51aef8d88f1c2775876944407270c42c9844252c26d28752' +
              '98743e7f6d5ea2f2d3e8d226039cd31b4e426ac4f2d3d666a610c2116fde4735',
    why: 'the same block with the final flag clear' },
  { n: 7, input: '00000001' + COMMON + '03000000000000000000000000000000' + '01',
    expected: 'b63a380cb2897d521994a85234ee2c181b5f844d2c624c002677e9703449d2fb' +
              'a551b3a8333bcdf5f2f7e08993d53923de3d64fcc68c034e717b9293fed7a421',
    why: 'a single round' },
];

group('EIP-152 test vectors 0-8');
for (const v of EIP152) {
  const out = B.blake2f(buf(v.input));
  eq(hex(out), v.expected === null ? '<fail>' : v.expected, `vector ${v.n}: ${v.why}`);
}
ok(EIP152.filter((v) => v.expected === null).length === 4,
  'four of the eight vectors assert FAILURE — those are the ones that matter');

{
  // Vector 8, whose round count is the assertion.
  const v8 = buf('ffffffff' + COMMON + '03000000000000000000000000000000' + '01');
  eq(v8.length, 213, 'vector 8 is a well-formed 213-byte input');
  eq(B.rounds(v8), 4294967295, 'vector 8 asks for 0xffffffff rounds, read BIG-endian');
  eq(P.PRECOMPILES[9].gas(v8), 4294967295n,
    '…which prices it at 4.29 billion gas, 143 full blocks — unreachable on chain, ' +
    'which is why it is priced rather than executed here');
}

// ---------------------------------------------------------------------------
// 2. Full BLAKE2b-512 built out of the precompile, against OpenSSL's
// ---------------------------------------------------------------------------

/* RFC 7693: h[0] ^= 0x01010000 ^ (keylen << 8) ^ outlen, then compress every
 * 128-byte block with t = bytes consumed so far, the last one with f = 1. An
 * empty message still compresses one all-zero block. Everything below is written
 * through `blake2f` — the precompile's own 213-byte framing — so a bug anywhere
 * in the framing, the endianness or the round schedule shows up as a digest
 * mismatch rather than being reasoned about. */
function blake2b512(msg) {
  let h = Buffer.alloc(64);
  // The IV, little-endian, with the parameter block xored into h[0].
  const iv = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  iv[0] ^= 0x01010040n;                                  // no key, 64-byte output
  for (let i = 0; i < 8; i++) h.writeBigUInt64LE(iv[i], i * 8);

  const blocks = Math.max(1, Math.ceil(msg.length / 128));
  for (let i = 0; i < blocks; i++) {
    const block = Buffer.alloc(128);
    msg.copy(block, 0, i * 128, Math.min(msg.length, (i + 1) * 128));
    const last = i === blocks - 1;
    const t = last ? msg.length : (i + 1) * 128;

    const input = Buffer.alloc(213);
    input.writeUInt32BE(12, 0);                          // BLAKE2b is twelve rounds
    h.copy(input, 4);
    block.copy(input, 68);
    input.writeBigUInt64LE(BigInt(t), 196);
    input[212] = last ? 1 : 0;

    const next = B.blake2f(input);
    if (next === null) throw new Error('blake2f rejected a well-formed block');
    h = next;
  }
  return h;
}

group('a complete BLAKE2b-512 built on the precompile, differentiated against OpenSSL');
{
  let mismatch = -1, tested = 0;
  for (let len = 0; len <= 400 && mismatch < 0; len++) {
    const msg = crypto.createHash('sha256').update('hearth' + len).digest();
    const m = Buffer.alloc(len);
    for (let i = 0; i < len; i++) m[i] = msg[i % 32] ^ (i & 0xff);
    const mine = blake2b512(m).toString('hex');
    const theirs = crypto.createHash('blake2b512').update(m).digest('hex');
    tested++;
    if (mine !== theirs) mismatch = len;
  }
  ok(mismatch < 0, `BLAKE2b-512 agrees with OpenSSL at every length 0..400 ` +
    (mismatch < 0 ? `(${tested} lengths)` : `— first divergence at ${mismatch} bytes`));

  // The boundaries that the length sweep would still pass by luck if it stopped early.
  for (const len of [0, 1, 127, 128, 129, 255, 256, 257, 1024, 4096]) {
    const m = crypto.randomBytes(len);
    eq(blake2b512(m).toString('hex'), crypto.createHash('blake2b512').update(m).digest('hex'),
      `blake2b512 of ${len} random bytes`);
  }

  ok(blake2b512(Buffer.alloc(0)).toString('hex') ===
    crypto.createHash('blake2b512').update(Buffer.alloc(0)).digest('hex'),
    'the empty message still compresses one block — t = 0, f = 1');
}

// ---------------------------------------------------------------------------
// 3. The rules that are easy to hold the wrong way round
// ---------------------------------------------------------------------------

group('the endian mismatch, the flag, and the round schedule');
{
  const p = P.PRECOMPILES[9];
  const withRounds = (n) => {
    const b = buf('00000000' + COMMON + '03000000000000000000000000000000' + '01');
    b.writeUInt32BE(n, 0);
    return b;
  };

  /* The round count is big-endian while h, m and t beside it are little-endian.
   * Every published vector uses 0, 1 or 12 rounds, all of which fit in the LAST
   * byte, so a wholly little-endian reader passes all of them. 256 does not fit,
   * and reading it the wrong way gives 1 round instead of 256. */
  eq(B.rounds(withRounds(256)), 256, 'a round count of 256 reads as 256, not 1');
  eq(B.rounds(withRounds(0x01020304)), 0x01020304, 'and 0x01020304 is not 0x04030201');
  ok(hex(B.blake2f(withRounds(256))) !== hex(B.blake2f(withRounds(1))),
    '…and 256 rounds really does compute something different from 1 round');

  /* The state and message ARE little-endian, in the same 213 bytes. h[0] of the
   * published vectors read little-endian is the BLAKE2b IV word with RFC 7693's
   * parameter block (0x01010040 — no key, 64-byte digest) already xored in. Read
   * big-endian it is 0x08c9bdf267e6096a, which is nothing. */
  const v5 = buf('0000000c' + COMMON + '03000000000000000000000000000000' + '01');
  const IV0 = 0x6a09e667f3bcc908n;
  eq(v5.readBigUInt64LE(4), IV0 ^ 0x01010040n,
    'h[0] read LITTLE-endian is the parameterised BLAKE2b IV word');
  ok(v5.readBigUInt64BE(4) !== (IV0 ^ 0x01010040n), '…and read big-endian it is not');
  eq(v5.readBigUInt64LE(196), 3n, 't is little-endian too: three bytes of "abc" consumed');

  // The final flag takes exactly two values. Not "zero or non-zero".
  for (const f of [0, 1]) {
    const b = withRounds(12); b[212] = f;
    ok(B.blake2f(b) !== null, `a final flag of ${f} is accepted`);
  }
  let rejected = 0;
  for (const f of [2, 3, 0x7f, 0x80, 0xfe, 0xff]) {
    const b = withRounds(12); b[212] = f;
    if (B.blake2f(b) === null) rejected++;
  }
  eq(rejected, 6, 'every other final-flag byte is rejected — EIP-152 allows 0 and 1 only');

  // Length is exact. Not "at least", not zero-padded — this is the one precompile
  // with no padding rule at all.
  let lenRejected = 0;
  for (const len of [0, 1, 4, 68, 196, 211, 212, 214, 256, 512]) {
    if (B.blake2f(Buffer.alloc(len)) === null) lenRejected++;
    if (p.gas(Buffer.alloc(len)) !== 0n) lenRejected = -999;
  }
  eq(lenRejected, 10, 'every length but 213 is rejected, and costs zero gas before it is');

  /* SIGMA cycles mod 10, so rounds 10 and 11 reuse rows 0 and 1. If the schedule
   * were indexed without the modulus, 12 rounds would read off the end of the table
   * and the twelve-round vectors would fail — but 10 rounds would still pass. This
   * pins the wrap explicitly by checking that the tenth round is not a no-op and
   * that round 10 and round 0 use the same row. */
  eq(B.SIGMA.length, 10, 'the message schedule has ten permutations');
  ok(B.SIGMA.every((row) => new Set(row).size === 16 && Math.max(...row) === 15),
    'every SIGMA row is a permutation of 0..15');
  ok(hex(B.blake2f(withRounds(10))) !== hex(B.blake2f(withRounds(11))),
    'round 10 does real work (the schedule wraps, it does not stop)');
  ok(hex(B.blake2f(withRounds(12))) !== hex(B.blake2f(withRounds(2))),
    '…and wrapping is not the same as restarting');
}

group('gas and the interpreter contract');
{
  const p = P.PRECOMPILES[9];
  const b = buf('0000000c' + COMMON + '03000000000000000000000000000000' + '01');
  eq(p.gas(b), 12n, 'twelve rounds cost twelve gas');
  eq(p.run(b).length, 64, 'the output is exactly 64 bytes');
  eq(p.run(buf('0000000c' + COMMON + '03000000000000000000000000000000' + '02')), null,
    'and a rejected input returns null, which fails the CALL rather than succeeding empty');
  // The compression state must not leak between calls — the working vector is
  // module-level and reused, so this is a real risk rather than a theoretical one.
  const first = hex(p.run(b));
  p.run(buf('000000ff' + COMMON + '03000000000000000000000000000000' + '00'));
  eq(hex(p.run(b)), first, 'a second call with the same input gives the same answer');
}

// ---------------------------------------------------------------------------
// the ethereum/tests corpus
// ---------------------------------------------------------------------------

/* stPreCompiledContracts2/CALL{,CODE}Blake2f and stTimeConsuming/CALLBlake2f_MaxRounds
 * forward their raw calldata straight to 0x09, so the precompile input can be lifted
 * out of the fixture without executing anything. (stPreCompiledContracts/blake2B
 * cannot: its inputs are built inside the contract's own bytecode from an index, so
 * they only exist mid-execution.) Those fixtures publish a post-state ROOT and
 * nothing else, and Hearth has no state-transition layer yet, so what is checked
 * here is the accept/reject decision and the gas — plus the exact output for every
 * input that matches a published vector. */

const CORPUS = path.join(__dirname, 'conformance', 'vectors', 'GeneralStateTests');
const CORPUS_FILES = [
  'stPreCompiledContracts2/CALLBlake2f.json',
  'stPreCompiledContracts2/CALLCODEBlake2f.json',
  'stTimeConsuming/CALLBlake2f_MaxRounds.json',
];

/** Every published expected output, keyed by input. The 8,000,000-round one is
 *  go-ethereum's stand-in for EIP-152 vector 8, whose 0xffffffff rounds nobody
 *  can execute; at 208ns a round it takes about two seconds here, which is worth
 *  paying because it is the only vector that runs the schedule 800,000 times round
 *  its ten-row cycle. */
const KNOWN = new Map(EIP152.filter((v) => v.expected).map((v) => [v.input, v.expected]));
KNOWN.set('007a1200' + COMMON + '03000000000000000000000000000000' + '01',
  '6d2ce9e534d50e18ff866ae92d70cceba79bbcd14c63819fe48752c8aca87a4b' +
  'b7dcc230d22a4047f0486cfcfb50a17b24b2899eb8fca370f22240adb5170189');

group('ethereum/tests GeneralStateTests — every blake2f input they carry');
{
  const inputs = [];
  let missing = false;
  for (const rel of CORPUS_FILES) {
    const file = path.join(CORPUS, rel);
    if (!fs.existsSync(file)) { missing = true; continue; }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const t of Object.values(doc)) {
      for (const d of t.transaction.data) inputs.push(d.replace(/^0x/, '').toLowerCase());
    }
  }
  if (missing) {
    // No counter here on purpose: a skipped optional corpus is not a check that
    // passed. It says so on stdout and the suite's total stays honest.
    console.log('  … SKIPPED: the corpus is not fetched. Run node/scripts/fetch-vectors.sh.');
  } else {
    let structural = 0, exact = 0, priced = 0;
    const wrong = [];
    for (const h of inputs) {
      const b = buf(h);
      // What EIP-152 says the decision must be, read off the bytes alone.
      const shouldFail = b.length !== 213 || (b[212] !== 0 && b[212] !== 1);
      const gas = P.PRECOMPILES[9].gas(b);
      if (gas !== (b.length === 213 ? BigInt(b.readUInt32BE(0)) : 0n)) {
        wrong.push(`${h.slice(0, 8)}…(${b.length}B): gas ${gas}`);
      }
      priced++;
      // 0xffffffff rounds is 4.29 billion gas — 143 full blocks. Priced, never run.
      if (!shouldFail && b.readUInt32BE(0) > 8000000) continue;
      const out = B.blake2f(b);
      structural++;
      if ((out === null) !== shouldFail) {
        wrong.push(`${h.slice(0, 8)}…(${b.length}B, flag ${b.length === 213 ? b[212] : '-'}): ` +
          `${out === null ? 'rejected' : 'accepted'}, expected the opposite`);
      }
      const known = KNOWN.get(h);
      if (known) { exact++; if (hex(out) !== known) wrong.push(`${h.slice(0, 8)}…: wrong digest`); }
    }
    console.log(`  ${inputs.length} inputs lifted from the corpus: ${structural} executed, ` +
      `${exact} match a published vector exactly, ${priced} priced`);
    for (const w of wrong.slice(0, 10)) console.log('      ' + w);
    eq(wrong.length, 0, 'every corpus input is accepted or rejected as EIP-152 requires, ' +
      'priced by its own round count, and matches its published digest where one exists');
    ok(inputs.some((h) => h.length !== 426),
      'the corpus carries wrong-length inputs — the rejection path is exercised upstream too');
    ok(inputs.some((h) => h.length === 426 && h.slice(0, 8) === 'ffffffff'),
      'and the 0xffffffff-round input, which is the big-endian read written down');
  }
}

group('the RPC deadline (0x09 is one uninterruptible loop)');
{
  /* One gas per round, chosen by the caller, makes this the most concentrated
   * work-per-call in the machine: the performance group below measures a full
   * block of it at ten seconds, and an `eth_call` could buy all of it. There is
   * no instruction boundary inside `compress` for the interpreter to check, so
   * the deadline comes in here or not at all.
   *
   * The other half of the property is the one that would break consensus if it
   * were wrong: with no deadline the loop is exactly what EIP-152 says it is. */
  const many = (rounds) => buf(rounds.toString(16).padStart(8, '0') + COMMON
    + '03000000000000000000000000000000' + '01');

  const twelve = buf('0000000c' + COMMON + '03000000000000000000000000000000' + '01');
  const expected = B.blake2f(twelve).toString('hex');
  eq(B.blake2f(twelve, { expired: () => false }).toString('hex'), expected,
    'a deadline that never expires changes no digest at all');
  eq(B.blake2f(twelve, null).toString('hex'), expected, 'and neither does an absent one');

  {
    // 20,000,000 rounds is ~7 s of real work here. It must come back in the
    // budget, not in the rounds.
    const deadline = { at: Date.now() + 25, tripped: false, expired() { return this.tripped || (Date.now() > this.at && (this.tripped = true)); } };
    const t0 = Date.now();
    const out = B.blake2f(many(20_000_000), deadline);
    const ms = Date.now() - t0;
    eq(out, null, 'a 20,000,000-round F abandons the loop when the deadline expires');
    ok(deadline.tripped, '…having tripped the deadline, which is how it is told from a bad input');
    ok(ms < 1000, `…and returns in ${ms} ms rather than the seven seconds it was asked for`);
  }

  {
    const t0 = Date.now();
    const out = B.blake2f(many(2_000_000));
    ok(out !== null && Date.now() - t0 > 100,
      'with NO deadline the same call still runs every round it was paid for — the consensus path is untouched');
  }

  ok(B.DEADLINE_ROUNDS > 0 && B.DEADLINE_ROUNDS <= 65536,
    'and the clock is read often enough that the budget is honoured to well under a millisecond');
}

group('performance');
{
  const b = buf('0000000c' + COMMON + '03000000000000000000000000000000' + '01');
  const t0 = process.hrtime.bigint();
  const N = 20000;
  for (let i = 0; i < N; i++) B.blake2f(b);
  const ns = Number(process.hrtime.bigint() - t0) / N;
  const perRound = ns / 12;
  console.log(`  12-round F: ${(ns / 1000).toFixed(2)}us  (${perRound.toFixed(0)}ns/round)`);
  console.log(`  a full 30M-gas block of blake2f would take ${(30e6 * perRound / 1e9).toFixed(1)}s`);
  ok(perRound < 2000, 'a round costs under 2us — at one gas per round anything slower ' +
    'makes a block of blake2f unverifiable');
}

const total = pass + fail;
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${total} blake2f checks`);
process.exit(fail === 0 ? 0 : 1);
