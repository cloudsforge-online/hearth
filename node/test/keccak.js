'use strict';
/* Conformance tests for Keccak-256. Zero-dependency mini harness.
 * Run: node test/keccak.js
 *
 * Three independent lines of evidence, because "my hash agrees with my hash"
 * is not evidence:
 *
 *  1. The permutation itself is pinned against the Keccak team's published
 *     KeccakF-1600 intermediate values (XKCP tests/TestVectors/
 *     KeccakF-1600-IntermediateValues.txt) — the round constants, the rho
 *     offsets and the pi map all have to be right for these to land.
 *  2. The sponge is diffed against Node's built-in SHA3 and SHAKE at every
 *     length across the rate boundaries. Keccak and SHA3 differ only in the
 *     suffix byte, so driving _sponge with 0x06 and comparing to OpenSSL's
 *     SHA3 validates absorb, pad, permute and squeeze at four different rates
 *     — everything except the one byte SHA3 cannot check.
 *  3. That one byte is pinned by known-answer Keccak-256 digests, including a
 *     table straddling the 136-byte rate boundary, which is where padding bugs
 *     live and where evidence (2) is deliberately blind.
 */

const crypto = require('crypto');
const K = require('../src/crypto/keccak');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name) { console.log('• ' + name); }

const hex = h => Buffer.from(h, 'hex');
/** Deterministic filler: byte i is i mod 256. */
const seq = n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = i & 0xff; return b; };

// ---- 1. the permutation, against the Keccak team's intermediate values ------
group('keccak-f[1600]');
{
  // "Example with the all-zero input" and "Example taking the previous output
  // as input", state printed as 200 bytes.
  const AFTER_ZERO = 'e7dde140798f25f18a47c033f9ccd584eea95aa61e2698d54d49806f304715bd57d05362'
    + '054e288bd46f8e7f2da497ffc44746a4a0e5fe90762e19d60cda5b8c9c05191bf7a630ad64fc8fd0b75a93'
    + '3035d617233fa95aeb0321710d26e6a6a95f55cfdb167ca58126c84703cd31b8439f56a5111a2ff20161ae'
    + 'd9215a63e505f270c98cf2febe641166c47b95703661cb0ed04f555a7cb8c832cf1c8ae83e8c14263aae22'
    + '790c94e409c5a224f94118c26504e72635f5163ba1307fe944f67549a2ec5c7bfff1ea';
  const AFTER_TWICE = '3ccb6ef94d955c2d6db55770d02c336a6c6bd770128d3d0994d06955b2d9208a56f1e7e5'
    + '994f9c4f38fb65daa2b957f90daf7512ae3d7785f710d8c347f2f4fa59879af7e69e1b1f25b498ee0fccfe'
    + 'e4a168ceb9b661ce684f978fbac466eadef5b1af6e833dc433d9db1927045406e065128309f0a9f87c4347'
    + '17bfa64954fd404b99d833addd9774e70b5dfcd5ea483cb0b755eec8b8e3e9429e646e22a0917bddbae729'
    + '310e90e8cca3fac59e2a20b63d1c4e4602345b59104ca4624e9f605cbf8f6ad26cd020';

  const stateToHex = s => { const b = Buffer.alloc(200); for (let i = 0; i < 50; i++) b.writeUInt32LE(s[i] >>> 0, i * 4); return b.toString('hex'); };

  const s = new Uint32Array(50);
  K._permute(s);
  ok(stateToHex(s) === AFTER_ZERO, 'Keccak-f[1600] of the all-zero state matches the reference');
  K._permute(s);
  ok(stateToHex(s) === AFTER_TWICE, 'Keccak-f[1600] applied twice matches the reference');
}

// ---- 2. the sponge, differentially against Node's SHA3 / SHAKE -------------
// Same permutation, FIPS-202's 0x06 suffix instead of Keccak's 0x01. If the
// absorb loop, the rate, the pad position or the squeeze were wrong, these
// would diverge — and they cover every offset around each block boundary.
group('sponge vs FIPS-202 (built-in crypto)');
{
  const rates = { 'sha3-224': 144, 'sha3-256': 136, 'sha3-384': 104, 'sha3-512': 72 };
  for (const [alg, rate] of Object.entries(rates)) {
    const outLen = parseInt(alg.slice(5), 10) / 8;
    let bad = -1;
    for (let n = 0; n <= 3 * rate + 4 && bad < 0; n++) {
      const msg = seq(n);
      const mine = K._sponge(msg, 0x06, rate, outLen).toString('hex');
      if (mine !== crypto.createHash(alg).update(msg).digest('hex')) bad = n;
    }
    ok(bad < 0, `${alg} (rate ${rate}) matches at every length 0..${3 * rate + 4} — first mismatch at ${bad}`);
  }

  // SHAKE, so the squeeze phase is exercised past a single block: output longer
  // than the rate has to permute again rather than repeat itself.
  for (const [alg, rate, suffix] of [['shake128', 168, 0x1f], ['shake256', 136, 0x1f]]) {
    let bad = -1;
    for (let out = 1; out <= 2 * rate + 3 && bad < 0; out++) {
      const msg = seq(out % 137);
      const mine = K._sponge(msg, suffix, rate, out).toString('hex');
      if (mine !== crypto.createHash(alg, { outputLength: out }).update(msg).digest('hex')) bad = out;
    }
    ok(bad < 0, `${alg} matches for output lengths 1..${2 * rate + 3} — first mismatch at ${bad}`);
  }

  // random lengths and random content, in case the ramp above hides something
  let bad = -1;
  for (let i = 0; i < 300 && bad < 0; i++) {
    const msg = crypto.randomBytes(Math.floor(Math.random() * 700));
    if (K._sponge(msg, 0x06, 136, 32).toString('hex') !== crypto.createHash('sha3-256').update(msg).digest('hex')) bad = i;
  }
  ok(bad < 0, 'sha3-256 matches over 300 random inputs');
}

// ---- 3. Keccak-256 known answers ------------------------------------------
group('keccak-256 known answers');
{
  // The two the spec names, then vectors published with js-sha3 (an independent
  // implementation). The last ASCII one is 301 bytes and so crosses two blocks.
  const vectors = [
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    ['The quick brown fox jumps over the lazy dog', '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15'],
    ['The quick brown fox jumps over the lazy dog.', '578951e24efd62a3d63a86f7cd19aaa53c898fe287d2552133220370240b572d'],
    ['The MD5 message-digest algorithm is a widely used cryptographic hash function producing a 128-bit (16-byte) hash value, typically expressed in text format as a 32 digit hexadecimal number. MD5 has been utilized in a wide variety of cryptographic applications, and is also commonly used to verify data integrity.',
      'af20018353ffb50d507f1555580f5272eca7fdab4f8295db4b1a9ad832c93f6d'],
    ['中文', '70a2b6579047f0a977fcb5e9120a4e07067bea9abb6916fbc2d13ffb9a4e4eee'],
    ['aécio', 'd7d569202f04daf90432810d6163112b2695d7820da979327ebd894efb0276dc'],
    ['𠜎', '16a7cc7a58444cbf7e939611910ddc82e7cba65a99d3e8e08cfcda53180a2180'],
  ];
  for (const [msg, want] of vectors) {
    ok(K.keccak256Hex(msg) === want, `keccak256(${JSON.stringify(msg).slice(0, 40)}) = ${want}`);
  }

  // The values Ethereum itself depends on, stated as themselves rather than
  // derived, so a regression here is unmissable.
  ok(K.keccak256Hex(Buffer.alloc(0)) === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    'EMPTY_CODE_HASH = keccak256("")');
  ok(K.keccak256Hex(hex('80')) === '56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    'EMPTY_TRIE_ROOT = keccak256(rlp(""))');
}

// ---- the rate boundary, where padding bugs live ----------------------------
// Digests generated with an independent implementation (OpenSSL 3.6:
// `openssl dgst -keccak-256`) over the deterministic filler above. 135/136/137
// and 271/272/273 are the one-byte-pad, exact-block and spill-into-a-new-block
// cases respectively.
group('keccak-256 across the 136-byte rate boundary');
{
  const table = [
    [0, 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    [1, 'bc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a'],
    [2, '49d03a195e239b52779866b33024210fc7dc66e9c2998975c0aa45c1702549d5'],
    [31, '3e50547cf72e8583ee91462f9d99fe624f53282f78e1a5ec2347b1d0123d0d9b'],
    [32, '8ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd2d'],
    [55, '797f92d5e159d80a886c0a7802a255b475a1e8e473e8cf4345144824a2aee79c'],
    [56, '0d0bf4902a749dee22eae5f1b6e2b867ba696ce9be7632eba14315ac09bd1856'],
    [63, 'eed42da65350e8490c201e15dd3bdb8aeaab8618692db71db386a19b6578c59d'],
    [64, '002030bde3d4cf89919649775cd71875c4d0ab1708a380e03fefc3a28aa24831'],
    [127, 'c52f0bd08793b9e8601b29753539e1bf47f8e483eed0a901e8761982449c9b4c'],
    [128, 'ed4c9adc183fb8cb025b1500ec3eeae1b45517314441a187605de1bb8a64726e'],
    [134, '861e165162f806cd361c4421a48f205820ddf4deb02db9f041f48e179ddada97'],
    [135, 'cbdfd9dee5faad3818d6b06f95a219fd290b0e1706f6a82e5a595b9ce9faca62'],
    [136, '7ce759f1ab7f9ce437719970c26b0a66ff11fe3e38e17df89cf5d29c7d7f807e'],
    [137, 'ac73d4fae68b8453f764007c1a20ce95994187861f0c3227a3a8e99a73a3b1db'],
    [138, '9dff24f078dfc5f2858894ee1f79728c3e4be850a0fccc5929bba850ca98efa1'],
    [200, 'bfb0aa97863e797943cf7c33bb7e880bb4543f3d2703c0923c6901c2af57b890'],
    [270, 'ab6cf59e344ec536f58f12d17acd9ef2cf2001e6af1fb00754fcc13fe62f3b22'],
    [271, '7c974895b2a88303ff2dc6b58f438ceb0b298cac91099ac0539cc0f477506191'],
    [272, 'fdf2ec49e749960d3c8521a0219af8d03e30e2b3bf19bd16150ee0eaf133d66e'],
    [273, '4f707289a9c3ccd0c4a51f2f17339f5dd171d371c04ff7783b735b5b22682eaf'],
    [400, '2c67ba73ca0f4721628e7345284061f6b9fbad1d2745f4e052bfb274a5df35a9'],
    [1000, 'aca79e4146e30eb1c733f6d6060d72471c36ea4e01ebf45d7f4916249c2bbd82'],
    [4096, '1c85a3e5666494583f321cd54285cc17276acf9aea34b207d43005bfa69d0a86'],
  ];
  for (const [n, want] of table) ok(K.keccak256Hex(seq(n)) === want, `keccak256 of ${n} bytes`);
}

// ---- the trap itself -------------------------------------------------------
group('keccak-256 is not sha3-256');
{
  // If someone "optimises" this file away to crypto.createHash('sha3-256'),
  // every address, tx hash and state root on the chain silently changes.
  let same = 0;
  for (let n = 0; n < 200; n++) {
    const m = seq(n);
    if (K.keccak256Hex(m) === crypto.createHash('sha3-256').update(m).digest('hex')) same++;
  }
  ok(same === 0, 'keccak256 differs from sha3-256 at every length (0x01 vs 0x06 padding)');
  ok(crypto.createHash('sha3-256').update('').digest('hex') === 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
    'and sha3-256("") is the other, wrong, value');
}

// ---- input handling --------------------------------------------------------
group('input coercion');
{
  const bytes = hex('deadbeef');
  ok(K.keccak256Hex(bytes) === K.keccak256Hex('0xdeadbeef'), '0x-prefixed hex string equals the same bytes');
  ok(K.keccak256Hex(bytes) === K.keccak256Hex(new Uint8Array(bytes)), 'Uint8Array accepted');
  ok(K.keccak256Hex('0xDEADBEEF') === K.keccak256Hex('0xdeadbeef'), 'hex is case-insensitive');
  ok(K.keccak256Hex('deadbeef') !== K.keccak256Hex('0xdeadbeef'), 'a bare string is UTF-8, not hex');
  ok(Buffer.isBuffer(K.keccak256('')) && K.keccak256('').length === 32, 'returns a 32-byte Buffer');

  let threw = 0;
  for (const bad of ['0xabc', '0xzz', 42, null, {}]) { try { K.keccak256(bad); } catch { threw++; } }
  ok(threw === 5, 'odd-length hex, non-hex, numbers, null and objects are all rejected');

  // a view into a larger buffer must hash only its own window
  const big = seq(64);
  ok(K.keccak256Hex(new Uint8Array(big.buffer, big.byteOffset + 8, 16)) === K.keccak256Hex(big.subarray(8, 24)),
    'a TypedArray view hashes only its own window');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} keccak checks`);
process.exit(fail === 0 ? 0 : 1);
