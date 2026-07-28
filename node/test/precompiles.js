'use strict';
/* Unit tests for precompiles 0x01-0x05. Zero-dependency mini harness.
 * Run: node test/precompiles.js
 *
 * The modexp and ecrecover vectors are the published ones from go-ethereum's
 * core/vm/testdata/precompiles/{modexp_eip2565,ecRecover}.json, copied verbatim with
 * their expected gas. They are the reason this file exists: modexp's EIP-2565 pricing
 * has four interacting terms and no amount of staring at the formula substitutes for
 * a vector that says 1360.
 *
 * The ecrecover vectors need node/src/crypto/secp256k1.js and node/src/crypto/keccak.js,
 * which are built separately. When they are absent this file says so loudly and skips
 * those checks rather than pretending to have tested them. */

const P = require('../src/evm/precompiles');

let pass = 0, fail = 0, skipped = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(actual, expected, msg) {
  const good = actual === expected;
  if (!good) console.log(`  ✗ ${msg}: expected ${expected}, got ${actual}`);
  if (good) pass++; else fail++;
}
function group(name) { console.log('• ' + name); }
const hex = (b) => Buffer.from(b).toString('hex');
const buf = (h) => Buffer.from(h, 'hex');

// ---- address decoding ------------------------------------------------------
group('address decoding');
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
eq(P.precompileIndex(addr(1)), 1, '0x..01 is precompile 1');
eq(P.precompileIndex(addr(5)), 5, '0x..05 is precompile 5');
eq(P.precompileIndex(addr(6)), 6, '0x..06 is bn128 add');
eq(P.precompileIndex(addr(9)), 9, '0x..09 is blake2f');
eq(P.precompileIndex(addr(10)), null, '0x..0a is an ordinary account, not a precompile');
eq(P.precompileIndex(addr(0)), null, '0x..00 is not a precompile');
eq(P.precompileIndex(addr(0x0101)), null, 'a non-zero high byte disqualifies an address');
eq(P.precompileIndex(buf('00'.repeat(19) + '04')), 4, 'a 20-byte Buffer decodes');
eq(P.precompileIndex(buf('00'.repeat(18) + '04')), null, 'a 19-byte address is not an address');
eq(P.precompileIndex('nonsense'), null, 'garbage decodes to nothing');
eq(P.precompileIndex(null), null, 'null decodes to nothing');
ok(P.isPrecompile(addr(3)), 'isPrecompile agrees');
ok(!P.isPrecompile(addr(10)), 'isPrecompile rejects 0x0a');
eq(P.precompileAt(addr(2)).name, 'sha256', 'precompileAt names the right one');
eq(P.precompileAt(addr(8)).name, 'bn128Pairing', 'precompileAt names the pairing check');
eq(P.precompileAt(addr(10)), null, 'precompileAt returns null for an ordinary account');
eq(Object.keys(P.PRECOMPILES).length, 9, 'all nine of Shanghai\'s precompiles ship');
// The warm set in statedb.js is 0x01-0x09 and must not have drifted from the table.
{
  const { PRECOMPILES: WARM } = require('../src/state/statedb');
  eq(WARM.length, Object.keys(P.PRECOMPILES).length,
    'the EIP-2929 warm set and the implemented set are the same nine addresses');
  ok(WARM.every((a) => P.precompileIndex(a) !== null),
    'every pre-warmed address resolves to a real precompile');
}

// ---- 0x02 sha256 -----------------------------------------------------------
group('0x02 sha256 — 60 + 12 per word');
{
  const p = P.PRECOMPILES[2];
  eq(p.gas(Buffer.alloc(0)), 60n, 'empty input is 60');
  eq(p.gas(Buffer.alloc(1)), 72n, 'one byte is one word: 72');
  eq(p.gas(Buffer.alloc(32)), 72n, '32 bytes is one word: 72');
  eq(p.gas(Buffer.alloc(33)), 84n, '33 bytes is two words: 84');
  eq(p.gas(Buffer.alloc(64)), 84n, '64 bytes is two words: 84');
  eq(hex(p.run(Buffer.alloc(0))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256("")');
  eq(hex(p.run(Buffer.from('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc")');
  eq(p.run(Buffer.alloc(0)).length, 32, 'sha256 output is 32 bytes');
}

// ---- 0x03 ripemd160 --------------------------------------------------------
group('0x03 ripemd160 — 600 + 120 per word, left-padded to 32');
{
  const p = P.PRECOMPILES[3];
  eq(p.gas(Buffer.alloc(0)), 600n, 'empty input is 600');
  eq(p.gas(Buffer.alloc(1)), 720n, 'one word is 720');
  eq(p.gas(Buffer.alloc(32)), 720n, '32 bytes is one word');
  eq(p.gas(Buffer.alloc(33)), 840n, '33 bytes is two words');
  eq(hex(p.run(Buffer.alloc(0))),
    '0000000000000000000000009c1185a5c5e9fc54612808977ee8f548b2258d31',
    'ripemd160("") left-padded into a 32-byte word');
  eq(hex(p.run(Buffer.from('abc'))),
    '0000000000000000000000008eb208f7e05d987a9b044a8e98c6b087f15a0bfc', 'ripemd160("abc")');
  eq(p.run(Buffer.alloc(0)).length, 32, 'ripemd160 output is padded to 32 bytes, not 20');
  ok(p.run(Buffer.alloc(0)).subarray(0, 12).every((b) => b === 0), 'the padding is on the left');
}

// ---- 0x04 identity ---------------------------------------------------------
group('0x04 identity — 15 + 3 per word');
{
  const p = P.PRECOMPILES[4];
  eq(p.gas(Buffer.alloc(0)), 15n, 'empty input is 15');
  eq(p.gas(Buffer.alloc(1)), 18n, 'one word is 18');
  eq(p.gas(Buffer.alloc(32)), 18n, '32 bytes is one word');
  eq(p.gas(Buffer.alloc(33)), 21n, '33 bytes is two words');
  eq(hex(p.run(buf('deadbeef'))), 'deadbeef', 'identity returns its input');
  eq(p.run(Buffer.alloc(0)).length, 0, 'identity of nothing is nothing');
  const src = buf('0102030405');
  const out = p.run(src);
  out[0] = 0xff;
  eq(src[0], 0x01, 'identity copies rather than aliasing the caller buffer');
}

// ---- 0x05 modexp -----------------------------------------------------------
group('0x05 modexp — EIP-198 semantics, EIP-2565 pricing (go-ethereum vectors)');
{
  const p = P.PRECOMPILES[5];
  const VECTORS = [
    { name: "eip_example1", gas: 1360n,
      input: "00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002003fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2efffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f",
      expected: "0000000000000000000000000000000000000000000000000000000000000001" },
    { name: "eip_example2", gas: 1360n,
      input: "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000020fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2efffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f",
      expected: "0000000000000000000000000000000000000000000000000000000000000000" },
    { name: "nagydani-1-square", gas: 200n,
      input: "000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040e09ad9675465c53a109fac66a445c91b292d2bb2c5268addb30cd82f80fcb0033ff97c80a5fc6f39193ae969c6ede6710a6b7ac27078a06d90ef1c72e5c85fb502fc9e1f6beb81516545975218075ec2af118cd8798df6e08a147c60fd6095ac2bb02c2908cf4dd7c81f11c289e4bce98f3553768f392a80ce22bf5c4f4a248c6b",
      expected: "60008f1614cc01dcfb6bfb09c625cf90b47d4468db81b5f8b7a39d42f332eab9b2da8f2d95311648a8f243f4bb13cfb3d8f7f2a3c014122ebb3ed41b02783adc" },
    { name: "nagydani-2-square", gas: 200n,
      input: "000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080cad7d991a00047dd54d3399b6b0b937c718abddef7917c75b6681f40cc15e2be0003657d8d4c34167b2f0bbbca0ccaa407c2a6a07d50f1517a8f22979ce12a81dcaf707cc0cebfc0ce2ee84ee7f77c38b9281b9822a8d3de62784c089c9b18dcb9a2a5eecbede90ea788a862a9ddd9d609c2c52972d63e289e28f6a590ffbf5102e6d893b80aeed5e6e9ce9afa8a5d5675c93a32ac05554cb20e9951b2c140e3ef4e433068cf0fb73bc9f33af1853f64aa27a0028cbf570d7ac9048eae5dc7b28c87c31e5810f1e7fa2cda6adf9f1076dbc1ec1238560071e7efc4e9565c49be9e7656951985860a558a754594115830bcdb421f741408346dd5997bb01c287087",
      expected: "981dd99c3b113fae3e3eaa9435c0dc96779a23c12a53d1084b4f67b0b053a27560f627b873e3f16ad78f28c94f14b6392def26e4d8896c5e3c984e50fa0b3aa44f1da78b913187c6128baa9340b1e9c9a0fd02cb78885e72576da4a8f7e5a113e173a7a2889fde9d407bd9f06eb05bc8fc7b4229377a32941a02bf4edcc06d70" },
    { name: "marcin-1-exp-heavy", gas: 215n,
      input: "0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000005100000000000000000000000000000000000000000000000000000000000000080001020304050607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0001020304050607",
      expected: "0000000000000000" },
    { name: "mod-8-exp-896", gas: 298n,
      input: "00000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000000800ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00",
      expected: "00ffffffffffffff" },
    { name: "mod-32-exp-64", gas: 336n,
      input: "00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000002000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00",
      expected: "00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
    { name: "mod-32-exp-65", gas: 341n,
      input: "00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000009000000000000000000000000000000000000000000000000000000000000002000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00",
      expected: "00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
    { name: "mod-264-exp-2", gas: 363n,
      input: "00000000000000000000000000000000000000000000000000000000000001080000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000010800ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffff00",
      expected: "0100fefffffffffffff710f80000000006f108000000000000feffffffffffff0100fefffffffffffef90ff80000000105f008ffffffffff02fdffffffffffff0100feffffffffff00f80ff80000010101f407fffffffd06fc0000000000fd020000feffffffff00fff80ff8000101fa08f207fffffb0afa0000000001fb03000000feffffff00fffff80ff80102f80405f207fff90ef80000000002f90400000000feffff00fffffff80ff903f6050005f207f712f60000000003f7050000000000feff00fffffffff810fcf406000005f1fd16f40000000004f506000000000000fe00fffffffffff915ea0700000005e522f20000000005f306ffffffffffffffffffffffffff" },
    { name: "guido-2-even", gas: 2300n,
      input: "000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000d80000000000000000000000000000000000000000000000000000000000000010e0060000a921212121212121ff0000212b212121ffff1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f00feffff212121212121ffffffff1fe1e0e0e01e1f1f169f1f1f1f490afcefffffffffffffffff82828282828282828282828282828282828282828200ffff28ff2b212121ffff1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1fffffffffff0afceffffff7ffffffffff7c8282828282a1828282828282828282828282828200ffff28ff2b212121ffff1f1f1f1f1f1fd11f1f1f1f1f1f1f1f1f1f1fffffffffffffffff21212121212121fb2121212121ffff1f1f1f1f1f1f1f1fffaf82828282828200ffff28ff2b21828200",
      expected: "458ef0af2549d46d24c89079499479e1" },
    { name: "mod_vul_pawel_3_exp_8", gas: 200n,
      input: "000000000000000000000000000000000000000000000000000000000000001700000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000017bffffffffffffffffffffffffffffffffffffffffffffbffffffffffffffffff7ffffffffffffffffffffffffffffffffffffffffffe",
      expected: "200f14de1d474710c1c979920452e0ffc2ac6f618afba5" },
  ];
  for (const v of VECTORS) {
    const input = buf(v.input);
    eq(p.gas(input), v.gas, `${v.name}: gas`);
    eq(hex(p.run(input)), v.expected, `${v.name}: output`);
  }
  ok(VECTORS.length >= 10, 'a representative spread of published vectors is exercised');

  // --- edges the published vectors do not cover ---
  // A zero-length modulus returns zero bytes. Not a 32-byte zero, not an error.
  const zeroMod = buf('00'.repeat(96));
  eq(p.run(zeroMod).length, 0, 'zero-length modulus returns empty output');
  eq(p.gas(zeroMod), 200n, 'the all-zero input still costs the 200 minimum');

  // x mod 0 is defined as 0, and the output is still modLen bytes wide.
  const modZero = buf(
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '03' + '02' + '00');
  eq(hex(p.run(modZero)), '00', 'a zero modulus yields zero, one byte wide');

  // 3^2 mod 5 = 4, and the gas floors to the 200 minimum.
  const small = buf(
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '03' + '02' + '05');
  eq(hex(p.run(small)), '04', '3^2 mod 5 = 4');
  eq(p.gas(small), 200n, 'a tiny modexp still costs the 200 minimum');

  // 0^0 mod 7 = 1, the case every naive modpow gets wrong.
  const zeroPow = buf(
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '00' + '00' + '07');
  eq(hex(p.run(zeroPow)), '01', '0^0 mod 7 = 1');

  // Input truncated after the three lengths: everything is read as zero.
  const truncated = buf(
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001');
  eq(hex(p.run(truncated)), '00', 'missing operands read as zero: 0^0 mod 0 = 0');

  // Absurd declared lengths must price themselves out of reach rather than hang.
  const huge = buf(
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  const t0 = Date.now();
  const hugeGas = p.gas(huge);
  ok(Date.now() - t0 < 1000, 'pricing an absurd modexp returns immediately');
  ok(hugeGas > (1n << 128n), 'an absurd modexp is priced far beyond any block gas limit');
  let threw = false;
  try { p.run(huge); } catch { threw = true; }
  ok(threw, 'running an absurd modexp throws rather than allocating — gas must be charged first');

  // A 64-bit-length declaration is also unreachable, and must not be attempted.
  const bigLen = buf(
    '0000000000000000000000000000000000000000000000010000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000010000000000000000');
  ok(p.gas(bigLen) > (1n << 100n), 'a 2^64-byte operand prices out');
}

// ---- 0x01 ecrecover --------------------------------------------------------
group('0x01 ecrecover — gas 3000, empty output on failure');
{
  const p = P.PRECOMPILES[1];
  eq(p.gas(Buffer.alloc(0)), 3000n, 'ecrecover is a flat 3000');
  eq(p.gas(Buffer.alloc(1000)), 3000n, 'ecrecover ignores input length when pricing');

  // go-ethereum core/vm/testdata/precompiles/ecRecover.json
  const VECTORS = [
    { name: "CallEcrecoverUnrecoverableKey", gas: 3000n,
      input: "a8b53bdf3306a35a7103ab5504a0c9b492295564b6202b1942a84ef300107281000000000000000000000000000000000000000000000000000000000000001b307835653165303366353363653138623737326363623030393366663731663366353366356337356237346463623331613835616138623838393262346538621122334455667788991011121314151617181920212223242526272829303132",
      expected: "" },
    { name: "ValidKey", gas: 3000n,
      input: "18c547e4f7b0f325ad1e56f57e26c745b09a3e503d86e00e5255ff7f715d3d1c000000000000000000000000000000000000000000000000000000000000001c73b1693892219d736caba55bdb67216e485557ea6b6af75f37096c9aa6a5a75feeb940b1d03b21e36b0e47e79769f095fe2ab855bd91e3a38756b7d75a9c4549",
      expected: "000000000000000000000000a94f5374fce5edbc8e2a8697c15331677e6ebf0b" },
    { name: "InvalidHighV-bits-1", gas: 3000n,
      input: "18c547e4f7b0f325ad1e56f57e26c745b09a3e503d86e00e5255ff7f715d3d1c100000000000000000000000000000000000000000000000000000000000001c73b1693892219d736caba55bdb67216e485557ea6b6af75f37096c9aa6a5a75feeb940b1d03b21e36b0e47e79769f095fe2ab855bd91e3a38756b7d75a9c4549",
      expected: "" },
    { name: "InvalidHighV-bits-2", gas: 3000n,
      input: "18c547e4f7b0f325ad1e56f57e26c745b09a3e503d86e00e5255ff7f715d3d1c000000000000000000000000000000000000001000000000000000000000001c73b1693892219d736caba55bdb67216e485557ea6b6af75f37096c9aa6a5a75feeb940b1d03b21e36b0e47e79769f095fe2ab855bd91e3a38756b7d75a9c4549",
      expected: "" },
    { name: "InvalidHighV-bits-3", gas: 3000n,
      input: "18c547e4f7b0f325ad1e56f57e26c745b09a3e503d86e00e5255ff7f715d3d1c000000000000000000000000000000000000001000000000000000000000011c73b1693892219d736caba55bdb67216e485557ea6b6af75f37096c9aa6a5a75feeb940b1d03b21e36b0e47e79769f095fe2ab855bd91e3a38756b7d75a9c4549",
      expected: "" },
  ];

  let cryptoReady = true;
  try { require('../src/crypto/secp256k1'); require('../src/crypto/keccak'); }
  catch { cryptoReady = false; }

  if (!cryptoReady) {
    skipped += VECTORS.length;
    console.log('  … SKIPPED ' + VECTORS.length + ' ecrecover vectors: node/src/crypto/' +
      'secp256k1.js and/or keccak.js are not present in this worktree yet.');
    console.log('    These MUST be run before the EVM is considered conformant — ecrecover is');
    console.log('    what Uniswap V2 permit depends on, and a silent empty return there turns');
    console.log('    every permit into a require(signer != address(0)) revert.');
  } else {
    for (const v of VECTORS) {
      eq(hex(p.run(buf(v.input))), v.expected, `${v.name}`);
    }
  }

  ok(P.SECP256K1_N === 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    'the secp256k1 group order is the real one');

  // The low-s trap, asserted without needing any crypto to be present.
  //
  // EIP-2's low-s rule applies to transaction signatures, never to this precompile.
  // secp256k1.js defaults lowS to true, so ecrecoverRun must pass { lowS: false }.
  // The go-ethereum ValidKey vector carries s > n/2, which means that if the flag is
  // ever dropped that vector returns empty and the check above fails loudly. This
  // asserts the property the vector relies on, so nobody can "fix" the vector instead
  // of the bug.
  {
    const valid = VECTORS.find((v) => v.name === 'ValidKey');
    ok(!!valid, 'the ValidKey vector is present');
    const s = BigInt('0x' + valid.input.slice(192, 256));
    ok(s > P.SECP256K1_N / 2n,
      'ValidKey carries a HIGH-s signature — it is the regression test for low-s ' +
      'being wrongly enforced in ecrecover');
    ok(valid.expected !== '', 'and a high-s signature must still recover an address');
    const src = require('fs').readFileSync(require.resolve('../src/evm/precompiles.js'), 'utf8');
    ok(/lowS:\s*false/.test(src),
      'ecrecover passes { lowS: false } — the secp256k1 default of true is wrong here');
  }
}

// ---- 0x06-0x09 pricing and the hard-failure convention ---------------------
/* The maths for these four is exercised by test/bn128.js and test/blake2f.js
 * against the published EIP-152/196/197 and go-ethereum vectors. What is asserted
 * here is what only the TABLE can get wrong: the EIP-1108 prices, that `gas` stays
 * O(1) in the input, and that a bad input comes back as null rather than empty.
 *
 * The null is the whole point. 0x01-0x05 answer a malformed input with an empty
 * buffer and a SUCCESSFUL call; if 0x06-0x09 did the same, a verifier contract
 * would read "success, no output" as a zero and accept a forged proof. */
group('0x06-0x09 — EIP-1108 pricing, and failure that is not an empty success');
{
  const add = P.PRECOMPILES[6], mul = P.PRECOMPILES[7];
  const pair = P.PRECOMPILES[8], b2 = P.PRECOMPILES[9];

  eq(add.gas(Buffer.alloc(0)), 150n, 'ecAdd is a flat 150 (EIP-1108, was 500)');
  eq(add.gas(Buffer.alloc(1000)), 150n, 'ecAdd ignores input length when pricing');
  eq(mul.gas(Buffer.alloc(0)), 6000n, 'ecMul is a flat 6000 (EIP-1108, was 40,000)');
  eq(mul.gas(Buffer.alloc(1000)), 6000n, 'ecMul ignores input length when pricing');

  eq(pair.gas(Buffer.alloc(0)), 45000n, 'an empty pairing costs the 45,000 base alone');
  eq(pair.gas(Buffer.alloc(192)), 79000n, 'one pair is 45,000 + 34,000');
  eq(pair.gas(Buffer.alloc(192 * 5)), 215000n, 'five pairs is 45,000 + 5 x 34,000');
  // A length that is not a multiple of 192 still pays for the whole pairs it
  // contains, and then fails. go-ethereum prices it with the same truncation.
  eq(pair.gas(Buffer.alloc(191)), 45000n, 'a 191-byte input pays the base and then fails');
  eq(pair.gas(Buffer.alloc(193)), 79000n, 'a 193-byte input pays for one pair and then fails');

  // blake2f is priced by a number the CALLER supplies, big-endian, in the first
  // four bytes — while every other field in the same 213 bytes is little-endian.
  const b2in = (roundsHex, flag) => buf(roundsHex + '00'.repeat(208) + flag);
  eq(b2.gas(b2in('0000000c', '01')), 12n, 'blake2f charges one gas per round');
  eq(b2.gas(b2in('00000000', '00')), 0n, 'zero rounds is zero gas');
  eq(b2.gas(b2in('ffffffff', '01')), 4294967295n,
    'the round count is read BIG-endian: 0xffffffff is 4.29 billion gas, not 0xff');
  eq(b2.gas(Buffer.alloc(212)), 0n, 'a wrong-length blake2f has no round count and costs nothing');

  // …and the failures.
  eq(add.run(buf('ff'.repeat(128))), null, 'ecAdd fails on a coordinate above the modulus');
  eq(mul.run(buf('ff'.repeat(96))), null, 'ecMul fails on a coordinate above the modulus');
  eq(pair.run(Buffer.alloc(191)), null, 'ecPairing fails on a length that is not a multiple of 192');
  eq(b2.run(Buffer.alloc(212)), null, 'blake2f fails on anything but exactly 213 bytes');
  eq(b2.run(b2in('00000000', '02')), null, 'blake2f fails on a final flag that is neither 0 nor 1');

  // …and the successes that must NOT be mistaken for failures.
  eq(hex(add.run(Buffer.alloc(128))), '00'.repeat(64), 'O + O = O, encoded as 64 zero bytes');
  eq(hex(pair.run(Buffer.alloc(0))),
    '0000000000000000000000000000000000000000000000000000000000000001',
    'an empty pairing product is 1 (true), not 0 and not a failure');

  // Every one of the nine must be callable with no input at all without throwing:
  // the interpreter hands over whatever memory holds, including nothing.
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    let threw = false;
    try { P.PRECOMPILES[i].gas(Buffer.alloc(0)); P.PRECOMPILES[i].run(Buffer.alloc(0)); }
    catch (err) { threw = /secp256k1|keccak/.test(err.message) ? false : true; }
    ok(!threw, `precompile ${i} survives an empty input without throwing`);
  }

  /* `gas` MUST NOT touch the input beyond its length. It runs before the
   * interpreter's affordability test, so any work it does is work an attacker gets
   * for the ~130 gas a CALL costs — a 192 KB pairing input validated inside `gas`
   * would be a node-halting denial of service. This times it to prove the point. */
  const huge = Buffer.alloc(192 * 4000);
  const t0 = process.hrtime.bigint();
  eq(pair.gas(huge), 45000n + 34000n * 4000n, 'a 4000-pair input prices correctly');
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  ok(us < 1000, `pricing a 4000-pair input is O(1) in the input (${us.toFixed(0)}us) — ` +
    'validity checks belong in run(), after the gas is paid');
}

const total = pass + fail;
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${total} precompile checks` +
  (skipped ? ` (${skipped} skipped)` : ''));
process.exit(fail === 0 ? 0 : 1);
