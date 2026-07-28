'use strict';
/* Conformance tests for RLP. Zero-dependency mini harness.
 * Run: node test/rlp.js
 *
 * The vector tables below are verbatim from ethereum/tests — RLPTests/
 * rlptest.json and RLPTests/invalidRLPTest.json — copied in rather than
 * fetched, so the suite is offline and pinned. The invalid table is the
 * important half: every entry in it is a well-formed-looking byte string that
 * a lazy decoder accepts, and accepting any one of them means this chain has
 * two encodings for one object and therefore two roots for one state.
 */

const RLP = require('../src/crypto/rlp');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name) { console.log('• ' + name); }

/** Bytes from a hex string with or without 0x, in any case. */
function bytes(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('bad hex in vector: ' + h);
  return Buffer.from(s, 'hex');
}
const hexOf = h => String(h).replace(/^0x/i, '').toLowerCase();

function deepEq(a, b) {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  }
  return false;
}

/** The official harness's convention: an "in" string starting '#' is a bigint. */
function fromSpec(v) {
  if (Array.isArray(v)) return v.map(fromSpec);
  if (typeof v === 'string' && v[0] === '#') return BigInt(v.slice(1));
  return v;
}
/** What decode() owes us back: every leaf as bytes, every list as an array. */
function asDecoded(v) {
  return Array.isArray(v) ? v.map(asDecoded) : RLP.toBytes(fromSpec(v));
}

const RLPTEST = {
  "emptystring": {
    "in": "",
    "out": "0x80"
  },
  "bytestring00": {
    "in": "\u0000",
    "out": "0x00"
  },
  "bytestring01": {
    "in": "\u0001",
    "out": "0x01"
  },
  "bytestring7F": {
    "in": "",
    "out": "0x7f"
  },
  "shortstring": {
    "in": "dog",
    "out": "0x83646f67"
  },
  "shortstring2": {
    "in": "Lorem ipsum dolor sit amet, consectetur adipisicing eli",
    "out": "0xb74c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c69"
  },
  "longstring": {
    "in": "Lorem ipsum dolor sit amet, consectetur adipisicing elit",
    "out": "0xb8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974"
  },
  "longstring2": {
    "in": "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Curabitur mauris magna, suscipit sed vehicula non, iaculis faucibus tortor. Proin suscipit ultricies malesuada. Duis tortor elit, dictum quis tristique eu, ultrices at risus. Morbi a est imperdiet mi ullamcorper aliquet suscipit nec lorem. Aenean quis leo mollis, vulputate elit varius, consequat enim. Nulla ultrices turpis justo, et posuere urna consectetur nec. Proin non convallis metus. Donec tempor ipsum in mauris congue sollicitudin. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia Curae; Suspendisse convallis sem vel massa faucibus, eget lacinia lacus tempor. Nulla quis ultricies purus. Proin auctor rhoncus nibh condimentum mollis. Aliquam consequat enim at metus luctus, a eleifend purus egestas. Curabitur at nibh metus. Nam bibendum, neque at auctor tristique, lorem libero aliquet arcu, non interdum tellus lectus sit amet eros. Cras rhoncus, metus ac ornare cursus, dolor justo ultrices metus, at ullamcorper volutpat",
    "out": "0xb904004c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e73656374657475722061646970697363696e6720656c69742e20437572616269747572206d6175726973206d61676e612c20737573636970697420736564207665686963756c61206e6f6e2c20696163756c697320666175636962757320746f72746f722e2050726f696e20737573636970697420756c74726963696573206d616c6573756164612e204475697320746f72746f7220656c69742c2064696374756d2071756973207472697374697175652065752c20756c7472696365732061742072697375732e204d6f72626920612065737420696d70657264696574206d6920756c6c616d636f7270657220616c6971756574207375736369706974206e6563206c6f72656d2e2041656e65616e2071756973206c656f206d6f6c6c69732c2076756c70757461746520656c6974207661726975732c20636f6e73657175617420656e696d2e204e756c6c6120756c74726963657320747572706973206a7573746f2c20657420706f73756572652075726e6120636f6e7365637465747572206e65632e2050726f696e206e6f6e20636f6e76616c6c6973206d657475732e20446f6e65632074656d706f7220697073756d20696e206d617572697320636f6e67756520736f6c6c696369747564696e2e20566573746962756c756d20616e746520697073756d207072696d697320696e206661756369627573206f726369206c756374757320657420756c74726963657320706f737565726520637562696c69612043757261653b2053757370656e646973736520636f6e76616c6c69732073656d2076656c206d617373612066617563696275732c2065676574206c6163696e6961206c616375732074656d706f722e204e756c6c61207175697320756c747269636965732070757275732e2050726f696e20617563746f722072686f6e637573206e69626820636f6e64696d656e74756d206d6f6c6c69732e20416c697175616d20636f6e73657175617420656e696d206174206d65747573206c75637475732c206120656c656966656e6420707572757320656765737461732e20437572616269747572206174206e696268206d657475732e204e616d20626962656e64756d2c206e6571756520617420617563746f72207472697374697175652c206c6f72656d206c696265726f20616c697175657420617263752c206e6f6e20696e74657264756d2074656c6c7573206c65637475732073697420616d65742065726f732e20437261732072686f6e6375732c206d65747573206163206f726e617265206375727375732c20646f6c6f72206a7573746f20756c747269636573206d657475732c20617420756c6c616d636f7270657220766f6c7574706174"
  },
  "zero": {
    "in": 0,
    "out": "0x80"
  },
  "smallint": {
    "in": 1,
    "out": "0x01"
  },
  "smallint2": {
    "in": 16,
    "out": "0x10"
  },
  "smallint3": {
    "in": 79,
    "out": "0x4f"
  },
  "smallint4": {
    "in": 127,
    "out": "0x7f"
  },
  "mediumint1": {
    "in": 128,
    "out": "0x8180"
  },
  "mediumint2": {
    "in": 1000,
    "out": "0x8203e8"
  },
  "mediumint3": {
    "in": 100000,
    "out": "0x830186a0"
  },
  "mediumint4": {
    "in": "#83729609699884896815286331701780722",
    "out": "0x8f102030405060708090a0b0c0d0e0f2"
  },
  "mediumint5": {
    "in": "#105315505618206987246253880190783558935785933862974822347068935681",
    "out": "0x9c0100020003000400050006000700080009000a000b000c000d000e01"
  },
  "emptylist": {
    "in": [],
    "out": "0xc0"
  },
  "stringlist": {
    "in": [
      "dog",
      "god",
      "cat"
    ],
    "out": "0xcc83646f6783676f6483636174"
  },
  "multilist": {
    "in": [
      "zw",
      [
        4
      ],
      1
    ],
    "out": "0xc6827a77c10401"
  },
  "shortListMax1": {
    "in": [
      "asdf",
      "qwer",
      "zxcv",
      "asdf",
      "qwer",
      "zxcv",
      "asdf",
      "qwer",
      "zxcv",
      "asdf",
      "qwer"
    ],
    "out": "0xf784617364668471776572847a78637684617364668471776572847a78637684617364668471776572847a78637684617364668471776572"
  },
  "longList1": {
    "in": [
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ]
    ],
    "out": "0xf840cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376"
  },
  "longList2": {
    "in": [
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ],
      [
        "asdf",
        "qwer",
        "zxcv"
      ]
    ],
    "out": "0xf90200cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376"
  },
  "listsoflists": {
    "in": [
      [
        [],
        []
      ],
      []
    ],
    "out": "0xc4c2c0c0c0"
  },
  "listsoflists2": {
    "in": [
      [],
      [
        []
      ],
      [
        [],
        [
          []
        ]
      ]
    ],
    "out": "0xc7c0c1c0c3c0c1c0"
  },
  "dictTest1": {
    "in": [
      [
        "key1",
        "val1"
      ],
      [
        "key2",
        "val2"
      ],
      [
        "key3",
        "val3"
      ],
      [
        "key4",
        "val4"
      ]
    ],
    "out": "0xecca846b6579318476616c31ca846b6579328476616c32ca846b6579338476616c33ca846b6579348476616c34"
  },
  "bigint": {
    "in": "#115792089237316195423570985008687907853269984665640564039457584007913129639936",
    "out": "0xa1010000000000000000000000000000000000000000000000000000000000000000"
  }
};

const INVALID = {
  "int32Overflow": "0xbf0f000000000000021111",
  "int32Overflow2": "0xff0f000000000000021111",
  "wrongSizeList": "0xf80180",
  "wrongSizeList2": "0xf80100",
  "incorrectLengthInArray": "0xb9002100dc2b275d0f74e8a53e6f4ec61b27f24278820be3f82ea2110e582081b0565df0",
  "randomRLP": "0xf861f83eb9002100dc2b275d0f74e8a53e6f4ec61b27f24278820be3f82ea2110e582081b0565df027b90015002d5ef8325ae4d034df55d4b58d0dfba64d61ddd17be00000b9001a00dae30907045a2f66fa36f2bb8aa9029cbb0b8a7b3b5c435ab331",
  "bytesShouldBeSingleByte00": "0x8100",
  "bytesShouldBeSingleByte01": "0x8101",
  "bytesShouldBeSingleByte7F": "0x817F",
  "leadingZerosInLongLengthArray1": "b90040000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  "leadingZerosInLongLengthArray2": "b800",
  "leadingZerosInLongLengthList1": "fb00000040000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  "leadingZerosInLongLengthList2": "f800",
  "nonOptimalLongLengthArray1": "b81000112233445566778899aabbccddeeff",
  "nonOptimalLongLengthArray2": "b801ff",
  "nonOptimalLongLengthList1": "f810000102030405060708090a0b0c0d0e0f",
  "nonOptimalLongLengthList2": "f803112233",
  "emptyEncoding": "",
  "lessThanShortLengthArray1": "81",
  "lessThanShortLengthArray2": "a0000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e",
  "lessThanShortLengthList1": "c5010203",
  "lessThanShortLengthList2": "e201020304050607",
  "lessThanLongLengthArray1": "ba010000aabbccddeeff",
  "lessThanLongLengthArray2": "b840ffeeddccbbaa99887766554433221100",
  "lessThanLongLengthList1": "f90180",
  "lessThanLongLengthList2": "ffffffffffffffffff0001020304050607"
};

// ---- the official valid vectors -------------------------------------------
group('ethereum/tests RLPTests — encode');
for (const [name, t] of Object.entries(RLPTEST)) {
  let got;
  try { got = RLP.encode(fromSpec(t.in)).toString('hex'); } catch (e) { got = 'threw: ' + e.message; }
  ok(got === hexOf(t.out), `encode ${name}`);
}

group('ethereum/tests RLPTests — decode');
for (const [name, t] of Object.entries(RLPTEST)) {
  let got;
  try { got = RLP.decode(bytes(t.out)); } catch (e) { got = null; }
  ok(deepEq(got, asDecoded(t.in)), `decode ${name}`);
}

group('ethereum/tests RLPTests — re-encoding is the identity');
for (const [name, t] of Object.entries(RLPTEST)) {
  // Canonicality stated as a property: the only encoding of a decoded value is
  // the bytes it was decoded from.
  let same = false;
  try { same = RLP.encode(RLP.decode(bytes(t.out))).toString('hex') === hexOf(t.out); } catch { same = false; }
  ok(same, `encode(decode(x)) === x for ${name}`);
}

// ---- the official invalid vectors — all must throw ------------------------
group('ethereum/tests invalidRLPTest — every one must be rejected');
for (const [name, out] of Object.entries(INVALID)) {
  let threw = false;
  try { RLP.decode(bytes(out)); } catch { threw = true; }
  ok(threw, `reject ${name}`);
}

// ---- non-canonical forms the official file does not name ------------------
group('further non-canonical forms');
{
  const rejects = [
    ['0x8100', 'one-byte string 0x00 that should encode as itself'],
    ['0x817f', 'one-byte string 0x7f that should encode as itself'],
    ['0x83646f6700', 'trailing byte after a complete item'],
    ['0xc0c0', 'trailing list after a complete item'],
    ['0xb8', 'long-form prefix with no length bytes'],
    ['0xf8', 'long-form list prefix with no length bytes'],
    ['0xb90038' + '00'.repeat(56), 'a two-byte length that fits in one'],
    ['0xc283646f67', 'a list item that overruns its list'],
  ];
  for (const [h, why] of rejects) {
    let threw = false;
    try { RLP.decode(bytes(h)); } catch { threw = true; }
    ok(threw, 'reject ' + why);
  }
  // controls: near-misses of the above that are in fact canonical
  ok(RLP.decode(bytes('0xb90100' + '00'.repeat(256))).length === 256, 'a genuine 256-byte long string decodes');
  ok(Array.isArray(RLP.decode(bytes('0xc180'))), 'a list holding the empty string decodes');
}

// ---- length-prefix boundaries ---------------------------------------------
group('length boundaries');
{
  const s = n => Buffer.alloc(n, 0x61);
  ok(RLP.encode(s(0)).toString('hex') === '80', 'empty string → 0x80');
  ok(RLP.encode(s(1)).toString('hex') === '61', 'a single byte < 0x80 is itself');
  ok(RLP.encode(Buffer.from([0x7f])).toString('hex') === '7f', '0x7f encodes as itself');
  ok(RLP.encode(Buffer.from([0x80])).toString('hex') === '8180', '0x80 does not');
  ok(RLP.encode(s(55)).subarray(0, 1).toString('hex') === 'b7', '55 bytes is the last short form');
  ok(RLP.encode(s(56)).subarray(0, 2).toString('hex') === 'b838', '56 bytes is the first long form');
  ok(RLP.encode(s(255)).subarray(0, 2).toString('hex') === 'b8ff', '255 bytes → one length byte');
  ok(RLP.encode(s(256)).subarray(0, 3).toString('hex') === 'b90100', '256 bytes → two length bytes');
  ok(RLP.encode([]).toString('hex') === 'c0', 'empty list → 0xc0');
  // s(54) encodes to 55 bytes (0xb6 + 54), which is the largest short-list payload
  ok(RLP.encode([s(54)]).subarray(0, 1).toString('hex') === 'f7', '55-byte payload is the last short list');
  ok(RLP.encode([s(55)]).subarray(0, 2).toString('hex') === 'f838', '56-byte payload is the first long list');
}

// ---- integers --------------------------------------------------------------
group('integers');
{
  ok(RLP.encode(0).toString('hex') === '80', '0 is the empty string, not 0x00');
  ok(RLP.encode(0n).toString('hex') === '80', 'BigInt 0 likewise');
  ok(RLP.encode(null).toString('hex') === '80', 'null likewise');
  ok(RLP.encode(undefined).toString('hex') === '80', 'undefined likewise');
  ok(RLP.encode(1n << 255n).toString('hex') === 'a0' + '80' + '00'.repeat(31), '2^255 → 32 bytes, no leading zero');
  ok(RLP.encode((1n << 256n) - 1n).toString('hex') === 'a0' + 'ff'.repeat(32), 'uint256 max');
  ok(RLP.intToBytes(0n).length === 0, 'intToBytes(0) is empty');
  ok(RLP.intToBytes(256n).toString('hex') === '0100', 'intToBytes is minimal big-endian');
  let threw = 0;
  for (const bad of [-1, -1n, 1.5, Number.MAX_SAFE_INTEGER + 2, {}, true]) {
    try { RLP.encode(bad); } catch { threw++; }
  }
  ok(threw === 6, 'negatives, fractions, unsafe integers and junk are rejected');
}

// ---- round trip over generated structures ----------------------------------
group('round trip');
{
  const rnd = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
  function gen(depth) {
    if (depth <= 0 || Math.random() < 0.45) {
      const r = Math.random();
      if (r < 0.15) return Buffer.alloc(0);
      if (r < 0.3) return rnd(1);
      if (r < 0.6) return rnd(Math.floor(Math.random() * 60));
      return rnd(Math.floor(Math.random() * 400));
    }
    return Array.from({ length: Math.floor(Math.random() * 6) }, () => gen(depth - 1));
  }
  let badTrip = -1, badIdem = -1;
  for (let i = 0; i < 2000; i++) {
    const x = gen(4);
    const enc = RLP.encode(x);
    if (badTrip < 0 && !deepEq(RLP.decode(enc), x)) badTrip = i;
    if (badIdem < 0 && !RLP.encode(RLP.decode(enc)).equals(enc)) badIdem = i;
  }
  ok(badTrip < 0, `decode(encode(x)) deep-equals x over 2000 random structures — first failure ${badTrip}`);
  ok(badIdem < 0, `encode(decode(y)) === y over the same — first failure ${badIdem}`);

  // every truncation of a valid encoding must be rejected, never half-decoded
  const enc = RLP.encode([rnd(3), [rnd(70), rnd(0)], rnd(200)]);
  let accepted = -1;
  for (let n = 1; n < enc.length && accepted < 0; n++) {
    try { RLP.decode(enc.subarray(0, n)); accepted = n; } catch { /* expected */ }
  }
  ok(accepted < 0, `no truncation of a valid encoding decodes — accepted at ${accepted}`);

  // a decoded value must not alias the input buffer
  const src = RLP.encode(Buffer.from('dog'));
  const out = RLP.decode(src);
  src[1] = 0x63;
  ok(out.toString() === 'dog', 'decoded bytes are a copy, not a view into the input');
}

// ---- the shapes this chain will actually encode ----------------------------
group('EVM shapes');
{
  const K = require('../src/crypto/keccak');
  const EMPTY_TRIE = '56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
  ok(K.keccak256Hex(RLP.encode(Buffer.alloc(0))) === EMPTY_TRIE, 'keccak256(rlp("")) is the empty trie root');

  // an account, [nonce, balance, storageRoot, codeHash]
  const acct = [0n, 0n, Buffer.from(EMPTY_TRIE, 'hex'), K.keccak256('')];
  ok(deepEq(RLP.decode(RLP.encode(acct)), acct.map(v => RLP.toBytes(v))), 'an empty account round-trips');

  // a legacy transaction body, [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
  const tx = [1n, 20000000000n, 21000n, Buffer.alloc(20, 0xab), 10n ** 18n, Buffer.alloc(0), 14858n, Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22)];
  const encTx = RLP.encode(tx);
  ok(deepEq(RLP.decode(encTx), tx.map(v => RLP.toBytes(v))), 'a legacy tx round-trips');
  ok(RLP.encode(RLP.decode(encTx)).equals(encTx), 'and re-encodes identically');
  // creation: an empty "to" is the empty string, not 20 zero bytes
  ok(RLP.encode([1n, Buffer.alloc(0)]).toString('hex') === 'c20180', 'contract creation encodes "to" as empty');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} rlp checks`);
process.exit(fail === 0 ? 0 : 1);
