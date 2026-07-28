'use strict';
/* Vector tests for secp256k1. Zero-dependency mini harness.
 * Run: node test/secp256k1.js
 *
 * Sources for every literal below:
 *   - key derivation and point encoding: bitcoinjs/tiny-secp256k1
 *     tests/fixtures/points.json (pointFromScalar, isPoint)
 *   - RFC 6979 nonces and deterministic signatures: bitcoinjs-lib
 *     test/fixtures/ecdsa.json, the long-standing secp256k1 RFC 6979 table.
 *     k0/k1/k15 are the first, second and sixteenth candidates from the same
 *     HMAC-DRBG stream, so they test the rejection loop as well as the seed.
 *   - the end-to-end Ethereum signature: EIP-155's own worked example, which
 *     publishes the signing hash directly. That is deliberate — it lets the
 *     signature be pinned to real Ethereum data without depending on keccak,
 *     which is another agent's module. Once keccak lands, the address
 *     0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f follows from the public key
 *     asserted here, and that is the check to add there. */

const S = require('../src/crypto/secp256k1');
const nodeCrypto = require('crypto');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name) { console.log('• ' + name); }

const hex = b => (typeof b === 'bigint' ? S.bigToBuf32(b) : b).toString('hex');
const sha256 = m => nodeCrypto.createHash('sha256').update(m).digest();
const key = h => Buffer.from(h.padStart(64, '0'), 'hex');

// ---- curve ----------------------------------------------------------------
group('curve');
ok(S.P === (1n << 256n) - (1n << 32n) - 977n, 'p = 2^256 - 2^32 - 977');
ok(S.N === 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n, 'group order n');
ok((S.G.y * S.G.y) % S.P === (S.G.x ** 3n + 7n) % S.P, 'G satisfies y^2 = x^3 + 7');
ok(S.toAffine(S.mulG(S.N)) === null, 'n * G is the point at infinity');
{
  const negG = S.toAffine(S.mulG(S.N - 1n));
  ok(negG.x === S.G.x && negG.y === S.P - S.G.y, '(n-1) * G is -G');
  const twoG = S.toAffine(S.jDouble({ x: S.G.x, y: S.G.y, z: 1n }));
  const alsoTwoG = S.toAffine(S.mulG(2n));
  ok(twoG.x === alsoTwoG.x && twoG.y === alsoTwoG.y, 'doubling G agrees with 2 * G');
  const sumG = S.toAffine(S.jAdd({ x: S.G.x, y: S.G.y, z: 1n }, { x: twoG.x, y: twoG.y, z: 1n }));
  const threeG = S.toAffine(S.mulG(3n));
  ok(sumG.x === threeG.x && sumG.y === threeG.y, 'G + 2G agrees with 3 * G');
  ok(S.toAffine(S.jAdd({ x: S.G.x, y: S.G.y, z: 1n }, { x: S.G.x, y: S.P - S.G.y, z: 1n })) === null,
    'G + (-G) is the point at infinity');
  // a random point times n is still infinity — the table is not the only path
  const R = S.decodePoint(S.publicKeyFromPrivate(key('2a')));
  ok(S.toAffine(S.mul(R, S.N)) === null, 'n * (a random point) is the point at infinity');
}

// ---- private key range -----------------------------------------------------
group('private keys');
ok(!S.isValidPrivateKey(Buffer.alloc(32)), 'private key 0 is rejected');
ok(S.isValidPrivateKey(key('01')), 'private key 1 is accepted');
ok(S.isValidPrivateKey(S.bigToBuf32(S.N - 1n)), 'private key n-1 is accepted');
ok(!S.isValidPrivateKey(S.bigToBuf32(S.N)), 'private key n is rejected');
ok(!S.isValidPrivateKey(Buffer.alloc(32, 0xff)), 'private key above n is rejected');
ok(!S.isValidPrivateKey(Buffer.alloc(31, 1)), 'a 31-byte private key is rejected');
{
  let threw = false;
  try { S.publicKeyFromPrivate(Buffer.alloc(32)); } catch { threw = true; }
  ok(threw, 'deriving from a zero private key throws rather than returning infinity');
  ok(S.isValidPrivateKey(S.randomPrivateKey()), 'randomPrivateKey produces a valid key');
}

// ---- private key -> public key (tiny-secp256k1 pointFromScalar) ------------
group('public key derivation');
const scalarVectors = [
  ['0000000000000000000000000000000000000000000000000000000000000001', '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
  ['0000000000000000000000000000000000000000000000000000000000000002', '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'],
  ['0000000000000000000000000000000000000000000000000000000000000003', '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'],
  ['fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140', '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
  ['fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd036413f', '03c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'],
  ['fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd036413e', '03f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'],
  ['b1121e4088a66a28f5b6b0f5844943ecd9f610196d7bb83b25214b60452c09af', '02b07ba9dca9523b7ef4bd97703d43d20399eb698e194704791a25ce77a400df99'],
  ['0705e4b49ea25478d60ba7287cf2cc020c074dd97d478c7f84a3cfbab8c376e6', '034554288528e2c4f761826255482f20abe3d7a8caf747f2170984110b2f645467'],
  ['bd66074dae0276b29dd5d1136f53293e68eac94ceb82a2d2266411b22ec0f59c', '0369e33b06240ffd20467920fdb9a62089568327fe668eb2d17cb02b8ce8e608a5'],
  ['b5aa6da19452b8c9bb92b784fb6d47ab74bb066c2a879733b19ec8b1135c6a0b', '034180ac8b09bbc3ded2f7ea97ee29fc807a5c59059d77a634e18f90621633845f'],
  ['dc8c84fef13612bc12677f9d7300fce12fb2ce47340e28d9e478d5dabec4e813', '02510d746a6a0e90c09a8e93dd7c9d6be92de264f08e81114254bb70985582fc08'],
  ['348c8f3e7b11be8629ecaa28c8ef9fa6ee2d400cece1d49ea30e3b5653f01bf5', '033f42d8f6d800a7aac0d7d97b8046a9bcac3bfc6a9acf4bfeaaafdb8ff116b931'],
  ['c29d155bad7e29720784de6783c4c7c7c5135597b390b256d19aa8cb9e493cc2', '03f26f995ef1e313e21a91aa2d572a5775ef428c0aab4face67061dbb8d338aa4d'],
  ['ebdddef7704d4ef7322074d84fd087ce73eafac8d3170e8a122aa9cf0486e42f', '037cbf3da5bb6fbcc9b1ed5b9878e841aa4008e662b783ca32e367a33631caa5bd'],
  ['4f9694abc84c0d804bbff0f0609ee078a1284772b26efabf25c25ccf85dc272c', '02837efb38e822a7800a764150c882d72bde3fcdee3ef77bf81495748e76af12ce'],
  ['c20f4427017ea5f9f7fedcf5a9d9f9f7e37933769efcba600e3494f010e00048', '03e75cf8ee20205fb24805bf8c01fb4f38361c754774f4d5579ea8e6da35757491'],
];
for (const [d, expected] of scalarVectors) {
  const compressed = S.publicKeyFromPrivate(key(d), true);
  ok(hex(compressed) === expected, `pubkey(${d.slice(0, 8)}…) compressed`);
  const uncompressed = S.publicKeyFromPrivate(key(d));
  ok(uncompressed.length === 65 && uncompressed[0] === 4, `pubkey(${d.slice(0, 8)}…) uncompressed is 65 bytes with an 0x04 prefix`);
  ok(hex(S.encodePoint(S.decodePoint(uncompressed), true)) === expected, `uncompressed -> compressed roundtrip for ${d.slice(0, 8)}…`);
}

// ---- point decoding --------------------------------------------------------
group('point decoding');
ok(S.decodePoint(S.publicKeyFromPrivate(key('07'))) !== null, 'a valid uncompressed key decodes');
ok(S.decodePoint(S.publicKeyFromPrivate(key('07'), true)) !== null, 'a valid compressed key decodes');
ok(S.decodePoint(S.publicKeyFromPrivate(key('07')).subarray(1)) !== null, 'the bare 64-byte X||Y form decodes');
for (const bad of [
  '0100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001',
  '0500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001',
  '0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  '04fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f0000000000000000000000000000000000000000000000000000000000000001',
  '04fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc300000000000000000000000000000000000000000000000000000000000000001',
  '010000000000000000000000000000000000000000000000000000000000000001',
  '040000000000000000000000000000000000000000000000000000000000000001',
]) ok(S.decodePoint(bad) === null, `off-curve or malformed point rejected: ${bad.slice(0, 10)}…`);
// x = 5: 5^3 + 7 = 132 is not a quadratic residue mod p, so no point has it
ok(S.decodePoint('02' + '00'.repeat(31) + '05') === null, 'a compressed key whose x is not on the curve is rejected');

// ---- RFC 6979 nonces -------------------------------------------------------
group('RFC 6979 nonces');
const nonceVectors = [
  ['test data', 'fee0a1f7afebf9d2a5a80c0c98a31c709681cce195cbcd06342b517970c0be1e',
    'fcce1de7a9bcd6b2d3defade6afa1913fb9229e3b7ddf4749b55c4848b2a196e',
    '727fbcb59eb48b1d7d46f95a04991fc512eb9dbf9105628e3aec87428df28fd8',
    '398f0e2c9f79728f7b3d84d447ac3a86d8b2083c8f234a0ffa9c4043d68bd258'],
  ['Everything should be made as simple as possible, but not simpler.', '0000000000000000000000000000000000000000000000000000000000000001',
    'ec633bd56a5774a0940cb97e27a9e4e51dc94af737596a0c5cbb3d30332d92a5',
    'df55b6d1b5c48184622b0ead41a0e02bfa5ac3ebdb4c34701454e80aabf36f56',
    'def007a9a3c2f7c769c75da9d47f2af84075af95cadd1407393dc1e26086ef87'],
  ['Satoshi Nakamoto', '0000000000000000000000000000000000000000000000000000000000000002',
    'd3edc1b8224e953f6ee05c8bbf7ae228f461030e47caf97cde91430b4607405e',
    'f86d8e43c09a6a83953f0ab6d0af59fb7446b4660119902e9967067596b58374',
    '241d1f57d6cfd2f73b1ada7907b199951f95ef5ad362b13aed84009656e0254a'],
  ['Diffie Hellman', '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
    'c378a41cb17dce12340788dd3503635f54f894c306d52f6e9bc4b8f18d27afcc',
    '90756c96fef41152ac9abe08819c4e95f16da2af472880192c69a2b7bac29114',
    '7b3f53300ab0ccd0f698f4d67db87c44cf3e9e513d9df61137256652b2e94e7c'],
  ['Japan', '8080808080808080808080808080808080808080808080808080808080808080',
    'f471e61b51d2d8db78f3dae19d973616f57cdc54caaa81c269394b8c34edcf59',
    '6819d85b9730acc876fdf59e162bf309e9f63dd35550edf20869d23c2f3e6d17',
    'd8e8bae3ee330a198d1f5e00ad7c5f9ed7c24c357c0a004322abca5d9cd17847'],
  ['Bitcoin', 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140',
    '36c848ffb2cbecc5422c33a994955b807665317c1ce2a0f59c689321aaa631cc',
    '4ed8de1ec952a4f5b3bd79d1ff96446bcd45cabb00fc6ca127183e14671bcb85',
    '56b6f47babc1662c011d3b1f93aa51a6e9b5f6512e9f2e16821a238d450a31f8'],
  ['i2FLPP8WEus5WPjpoHwheXOMSobUJVaZM1JPMQZq', 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140',
    '6e9b434fcc6bbb081a0463c094356b47d62d7efae7da9c518ed7bac23f4e2ed6',
    'ae5323ae338d6117ce8520a43b92eacd2ea1312ae514d53d8e34010154c593bb',
    '3eaa1b61d1b8ab2f1ca71219c399f2b8b3defa624719f1e96fe3957628c2c4ea'],
  ['lEE55EJNP7aLrMtjkeJKKux4Yg0E8E1SAJnWTCEh', '3881e5286abc580bb6139fe8e83d7c8271c6fe5e5c2d640c1f0ed0e1ee37edc9',
    '5b606665a16da29cc1c5411d744ab554640479dd8abd3c04ff23bd6b302e7034',
    'f8b25263152c042807c992eacd2ac2cc5790d1e9957c394f77ea368e3d9923bd',
    'ea624578f7e7964ac1d84adb5b5087dd14f0ee78b49072aa19051cc15dab6f33'],
  ['2SaVPvhxkAPrayIVKcsoQO5DKA8Uv5X/esZFlf+y', '7259dff07922de7f9c4c5720d68c9745e230b32508c497dd24cb95ef18856631',
    '3ab6c19ab5d3aea6aa0c6da37516b1d6e28e3985019b3adb388714e8f536686b',
    '19af21b05004b0ce9cdca82458a371a9d2cf0dc35a813108c557b551c08eb52e',
    '117a32665fca1b7137a91c4739ac5719fec0cf2e146f40f8e7c21b45a07ebc6a'],
  ['00A0OwO2THi7j5Z/jp0FmN6nn7N/DQd6eBnCS+/b', '0d6ea45d62b334777d6995052965c795a4f8506044b4fd7dc59c15656a28f7aa',
    '79487de0c8799158294d94c0eb92ee4b567e4dc7ca18addc86e49d31ce1d2db6',
    '9561d2401164a48a8f600882753b3105ebdd35e2358f4f808c4f549c91490009',
    'b0d273634129ff4dbdf0df317d4062a1dbc58818f88878ffdb4ec511c77976c0'],
];
for (const [msg, d, k0, k1, k15] of nonceVectors) {
  const h = sha256(msg), pk = key(d);
  let seen = 0;
  ok(hex(S.rfc6979Nonce(h, pk)) === k0, `nonce k0 for "${msg.slice(0, 20)}"`);
  seen = 0;
  ok(hex(S.rfc6979Nonce(h, pk, () => seen++ >= 1)) === k1, `nonce k1 (one rejection) for "${msg.slice(0, 20)}"`);
  seen = 0;
  ok(hex(S.rfc6979Nonce(h, pk, () => seen++ >= 15)) === k15, `nonce k15 (fifteen rejections) for "${msg.slice(0, 20)}"`);
}
{
  const h = sha256('determinism'), pk = key('2b');
  ok(hex(S.rfc6979Nonce(h, pk)) === hex(S.rfc6979Nonce(h, pk)), 'the same key and message give the same nonce');
  ok(hex(S.rfc6979Nonce(h, pk)) !== hex(S.rfc6979Nonce(sha256('other'), pk)), 'a different message gives a different nonce');
  ok(hex(S.rfc6979Nonce(h, pk)) !== hex(S.rfc6979Nonce(h, key('2c'))), 'a different key gives a different nonce');
}

// ---- deterministic signatures ---------------------------------------------
group('deterministic signatures');
const sigVectors = [
  ['01', 'Everything should be made as simple as possible, but not simpler.',
    '33a69cd2065432a30f3d1ce4eb0d59b8ab58c74f27c41a7fdb5696ad4e6108c9',
    '6f807982866f785d3f6418d24163ddae117b7db4d5fdf0071de069fa54342262'],
  ['fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140',
    'Equations are more important to me, because politics is for the present, but an equation is something for eternity.',
    '54c4a33c6423d689378f160a7ff8b61330444abb58fb470f96ea16d99d4a2fed',
    '07082304410efa6b2943111b6a4e0aaa7b7db55a07e9861d1fb3cb1f421044a5'],
  ['fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140',
    'Not only is the Universe stranger than we think, it is stranger than we can think.',
    'ff466a9f1b7b273e2f4c3ffe032eb2e814121ed18ef84665d0f515360dab3dd0',
    '6fc95f5132e5ecfdc8e5e6e616cc77151455d46ed48f5589b7db7771a332b283'],
  ['0000000000000000000000000000000000000000000000000000000000000001',
    'How wonderful that we have met with a paradox. Now we have some hope of making progress.',
    'c0dafec8251f1d5010289d210232220b03202cba34ec11fec58b3e93a85b91d3',
    '75afdc06b7d6322a590955bf264e7aaa155847f614d80078a90292fe205064d3'],
  ['69ec59eaa1f4f2e36b639716b7c30ca86d9a5375c7b38d8918bd9c0ebc80ba64',
    'Computer science is no more about computers than astronomy is about telescopes.',
    '7186363571d65e084e7f02b0b77c3ec44fb1b257dee26274c38c928986fea45d',
    '0de0b38e06807e46bda1f1e293f4f6323e854c86d58abdd00c46c16441085df6'],
  ['00000000000000000000000000007246174ab1e92e9149c6e446fe194d072637',
    "...if you aren't, at any given time, scandalized by code you wrote five or even three years ago, you're not learning anywhere near enough",
    'fbfe5076a15860ba8ed00e75e9bd22e05d230f02a936b653eb55b61c99dda487',
    '0e68880ebb0050fe4312b1b1eb0899e1b82da89baa5b895f612619edf34cbd37'],
  ['000000000000000000000000000000000000000000056916d0f9b31dc9b637f3',
    'The question of whether computers can think is like the question of whether submarines can swim.',
    'cde1302d83f8dd835d89aef803c74a119f561fbaef3eb9129e45f30de86abbf9',
    '06ce643f5049ee1f27890467b77a6a8e11ec4661cc38cd8badf90115fbd03cef'],
];
for (const [d, msg, r, s] of sigVectors) {
  const h = sha256(msg), pk = key(d);
  const sig = S.sign(h, pk);
  const pub = S.publicKeyFromPrivate(pk);
  ok(hex(sig.r) === r, `signature r for "${msg.slice(0, 24)}…"`);
  ok(hex(sig.s) === s, `signature s for "${msg.slice(0, 24)}…"`);
  ok(sig.s <= S.N_HALF, `signature s is canonical (low-s) for "${msg.slice(0, 24)}…"`);
  ok(S.verify(h, sig, pub), `signature verifies for "${msg.slice(0, 24)}…"`);
  ok(S.recoverPublicKey(h, sig).equals(pub), `signature recovers the signer for "${msg.slice(0, 24)}…"`);
}

// ---- the EIP-155 worked example -------------------------------------------
group('EIP-155 vector');
{
  // EIP-155 publishes the signing hash of its example transaction, so this
  // pins us to real Ethereum data without needing keccak here.
  const hash = Buffer.from('daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53', 'hex');
  const priv = key('46'.repeat(32));
  const sig = S.sign(hash, priv);
  ok(hex(sig.r) === '28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276', 'EIP-155 r');
  ok(hex(sig.s) === '67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83', 'EIP-155 s');
  ok(sig.recoveryId + 1 * 2 + 35 === 37, 'EIP-155 v is 37 for chain id 1');
  const pub = S.publicKeyFromPrivate(priv);
  ok(hex(pub) === '044bc2a31265153f07e70e0bab08724e6b85e217f8cd628ceb62974247bb493382'
    + 'ce28cab79ad7119ee1ad3ebcdb98a16805211530ecc6cfefa1b88e6dff99232a', 'EIP-155 public key');
  ok(S.recoverPublicKey(hash, sig).equals(pub), 'EIP-155 signature recovers its signer');
  ok(S.recoverPublicKey(hash, { r: sig.r, s: sig.s, recoveryId: 1 }) !== null
    && !S.recoverPublicKey(hash, { r: sig.r, s: sig.s, recoveryId: 1 }).equals(pub),
    'the wrong recovery id recovers a different key, not the signer');
}

// ---- consensus rejections --------------------------------------------------
group('consensus rejections');
{
  const priv = key('11');
  const pub = S.publicKeyFromPrivate(priv);
  const h = sha256('reject me');
  const sig = S.sign(h, priv);

  ok(!S.verify(h, { r: 0n, s: sig.s }, pub), 'r = 0 rejected');
  ok(!S.verify(h, { r: S.N, s: sig.s }, pub), 'r = n rejected');
  ok(!S.verify(h, { r: S.N + 1n, s: sig.s }, pub), 'r > n rejected');
  ok(!S.verify(h, { r: sig.r, s: 0n }, pub), 's = 0 rejected');
  ok(!S.verify(h, { r: sig.r, s: S.N }, pub), 's = n rejected');
  ok(!S.verify(h, { r: sig.r, s: S.N + 1n }, pub), 's > n rejected');
  ok(S.recoverPublicKey(h, { r: 0n, s: sig.s, recoveryId: 0 }) === null, 'recovery with r = 0 returns null');
  ok(S.recoverPublicKey(h, { r: S.N, s: sig.s, recoveryId: 0 }) === null, 'recovery with r = n returns null');
  ok(S.recoverPublicKey(h, { r: sig.r, s: 0n, recoveryId: 0 }) === null, 'recovery with s = 0 returns null');
  ok(S.recoverPublicKey(h, sig, { lowS: true }) !== null, 'a low-s signature recovers');
  ok(S.recoverPublicKey(h, { ...sig, recoveryId: 4 }) === null, 'recovery id 4 is out of range');
  ok(S.recoverPublicKey(h, { ...sig, recoveryId: -1 }) === null, 'a negative recovery id is out of range');

  // EIP-2: (r, n-s) is the same signature reflected, and must not be accepted
  // as a second valid encoding of the same transaction.
  const high = { r: sig.r, s: S.N - sig.s, recoveryId: sig.recoveryId ^ 1 };
  ok(high.s > S.N_HALF, 'the malleated s really is in the upper half');
  ok(!S.verify(h, high, pub), 'the malleated signature is rejected by default (EIP-2)');
  ok(S.recoverPublicKey(h, high) === null, 'recovery rejects the malleated signature by default');
  // ...but ecrecover, the precompile, has never enforced low-s, and contracts
  // in the wild (Uniswap V2 permit among them) depend on that. Hence the opt-out.
  ok(S.verify(h, high, pub, { lowS: false }), 'the malleated signature still verifies with lowS disabled');
  const recovered = S.recoverPublicKey(h, high, { lowS: false });
  ok(recovered !== null && recovered.equals(pub), 'with lowS disabled the malleated signature recovers the same key');

  ok(!S.verify(sha256('a different message'), sig, pub), 'a signature over another message is rejected');
  ok(!S.verify(h, sig, S.publicKeyFromPrivate(key('12'))), 'a signature is rejected against the wrong key');
  ok(!S.verify(h, sig, Buffer.alloc(65, 4)), 'verification against a malformed key is false, not an exception');
  ok(!S.verify(h, { r: sig.r + 1n, s: sig.s }, pub), 'a tampered r is rejected');
  ok(!S.verify(h, { r: sig.r, s: sig.s - 1n }, pub), 'a tampered s is rejected');
}

// ---- roundtrip over many random keys ---------------------------------------
group('roundtrip');
{
  const rounds = 200;
  let good = 0, recovered = 0, lowS = 0, distinct = new Set();
  for (let i = 0; i < rounds; i++) {
    const priv = S.randomPrivateKey();
    const pub = S.publicKeyFromPrivate(priv);
    const h = nodeCrypto.randomBytes(32);
    const sig = S.sign(h, priv);
    if (S.verify(h, sig, pub)) good++;
    if (S.recoverPublicKey(h, sig).equals(pub)) recovered++;
    if (sig.s <= S.N_HALF) lowS++;
    distinct.add(sig.r);
  }
  ok(good === rounds, `every one of ${rounds} random signatures verifies`);
  ok(recovered === rounds, `every one of ${rounds} random signatures recovers its own public key`);
  ok(lowS === rounds, `every one of ${rounds} random signatures is low-s`);
  ok(distinct.size === rounds, 'no nonce was reused across random signatures');
}

// ---- performance -----------------------------------------------------------
group('performance');
{
  // Not a benchmark, a tripwire. Affine-only point arithmetic, or a naive
  // double-and-add over a modular inverse per step, lands in the minutes here;
  // a block full of transactions has to be validated in well under 15 seconds.
  const rounds = 500;
  const priv = S.randomPrivateKey();
  const pub = S.publicKeyFromPrivate(priv);
  const hashes = [];
  for (let i = 0; i < rounds; i++) hashes.push(nodeCrypto.randomBytes(32));
  const t0 = Date.now();
  const sigs = hashes.map(h => S.sign(h, priv));
  const t1 = Date.now();
  let hit = 0;
  for (let i = 0; i < rounds; i++) if (S.recoverPublicKey(hashes[i], sigs[i]).equals(pub)) hit++;
  const t2 = Date.now();
  ok(hit === rounds, `${rounds} signatures recovered correctly`);
  ok(t1 - t0 < 15000, `${rounds} signatures in ${t1 - t0}ms (budget 15000ms)`);
  ok(t2 - t1 < 15000, `${rounds} recoveries in ${t2 - t1}ms (budget 15000ms)`);
  console.log(`  ${Math.round(rounds / Math.max(1, t1 - t0) * 1000)} sign/s, `
    + `${Math.round(rounds / Math.max(1, t2 - t1) * 1000)} recover/s`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} secp256k1 checks`);
process.exit(fail === 0 ? 0 : 1);
