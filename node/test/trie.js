'use strict';
/* Conformance tests for the Merkle Patricia Trie. Zero-dependency mini harness.
 * Run: node test/trie.js
 *
 * VECTORS below is verbatim from ethereum/tests — TrieTests/trietest.json,
 * trieanyorder.json, their _secureTrie twins, and
 * hex_encoded_securetrie_test.json — copied in rather than fetched, so the
 * suite is offline and pinned.
 *
 * The vectors are the entire reason writing this trie by hand is defensible.
 * They are also unusually good at their job: `emptyValues` and `branchingTests`
 * delete their way back through every collapse case, `trieanyorder` asserts the
 * root does not depend on insertion order (run here against every permutation,
 * not the one the file happens to list), and the small-value cases exercise
 * embedding, since a node under 32 bytes goes into its parent rather than into
 * the store. Every one of the three rules in the module header has a vector
 * that fails when it is broken — which was checked, by breaking each of them.
 *
 * The `_secureTrie` files are the variant Ethereum uses for state and storage;
 * the plain ones are the variant the transaction and receipt tries use. Both
 * are gated here because both ship.
 *
 * For the shared conformance harness landing in test/conformance/: the entry
 * points are `runOrdered(name, entries, expectedRoot, secure)` and
 * `runAnyOrder(name, map, expectedRoot, secure)` below — both take the parsed
 * JSON shape unchanged, so the harness can hand them a file it loaded itself
 * and drop the vendored copy.
 */

const { Trie, MemoryDB, OverlayDB, EMPTY_TRIE_ROOT, hpEncode, hpDecode, toNibbles } = require('../src/state/trie');
const RLP = require('../src/crypto/rlp');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
/* A group is a thunk so that a throw inside it is scored and the run
 * continues — a broken trie throws about as often as it returns a wrong root,
 * and an abort would hide every check after the first one. */
function group(name, fn) {
  console.log('• ' + name);
  try { fn(); } catch (e) { fail++; console.log(`  ✗ ${name}: threw — ${e.message}`); }
}

/** The vector convention: `0x…` is hex, anything else is UTF-8, null deletes. */
function bytes(s) {
  if (s === null || s === undefined) return null;
  return /^0x/i.test(s) ? Buffer.from(s.slice(2), 'hex') : Buffer.from(String(s), 'utf8');
}
const hexOf = s => String(s).replace(/^0x/i, '').toLowerCase();

/** Every ordering of `a`. Only ever called on the tiny anyorder inputs. */
function permutations(a) {
  if (a.length <= 1) return [a];
  const out = [];
  for (let i = 0; i < a.length; i++) {
    for (const rest of permutations(a.slice(0, i).concat(a.slice(i + 1)))) out.push([a[i], ...rest]);
  }
  return out;
}

/* A broken trie throws as readily as it returns the wrong root, and an
 * uncaught throw would abort the run and hide every check after it — so a
 * vector that blows up is scored as the failure it is and the suite goes on. */
function attempt(name, fn) {
  try { return fn(); } catch (e) { fail++; console.log(`  ✗ ${name}: threw — ${e.message}`); return null; }
}

function runOrdered(name, entries, expectedRoot, secure) {
  const t = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure });
  const built = attempt(name, () => {
    for (const [k, v] of entries) {
      if (v === null) t.del(bytes(k)); else t.put(bytes(k), bytes(v));
    }
    return true;
  });
  if (!built) { fail++; return; }
  const got = t.rootHex();
  ok(got === hexOf(expectedRoot), `${name}: root ${got} != ${hexOf(expectedRoot)}`);
  // Whatever survived must also read back, which the roots alone do not prove.
  const live = new Map();
  for (const [k, v] of entries) { if (v === null) live.delete(hexOf(k)); else live.set(hexOf(k), v); }
  let reads = true;
  attempt(name + ' reads', () => {
    for (const [k, v] of entries) {
      const got2 = t.get(bytes(k));
      const want = live.has(hexOf(k)) ? bytes(live.get(hexOf(k))) : null;
      if (want === null ? got2 !== null : (got2 === null || !got2.equals(want))) reads = false;
    }
    return true;
  }) || (reads = false);
  ok(reads, `${name}: every surviving key reads back`);
}

function runAnyOrder(name, map, expectedRoot, secure) {
  for (const order of permutations(Object.entries(map))) {
    const label = `${name} [${order.map(e => e[0]).join(',')}]`;
    const t = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure });
    const got = attempt(label, () => {
      for (const [k, v] of order) t.put(bytes(k), bytes(v));
      return t.rootHex();
    });
    if (got === null) continue;                        // already scored a failure
    ok(got === hexOf(expectedRoot), `${label}: root ${got}`);
  }
}

const VECTORS = {
  "trietest": {
    "emptyValues": {
      "in": [
        ["do", "verb"],
        ["ether", "wookiedoo"],
        ["horse", "stallion"],
        ["shaman", "horse"],
        ["doge", "coin"],
        ["ether", null],
        ["dog", "puppy"],
        ["shaman", null]
      ],
      "root": "0x5991bb8c6514148a29db676a14ac506cd2cd5775ace63c30a4fe457715e9ac84"
    },
    "branchingTests": {
      "in": [
        ["0x04110d816c380812a427968ece99b1c963dfbce6", "something"],
        ["0x095e7baea6a6c7c4c2dfeb977efac326af552d87", "something"],
        ["0x0a517d755cebbf66312b30fff713666a9cb917e0", "something"],
        ["0x24dd378f51adc67a50e339e8031fe9bd4aafab36", "something"],
        ["0x293f982d000532a7861ab122bdc4bbfd26bf9030", "something"],
        ["0x2cf5732f017b0cf1b1f13a1478e10239716bf6b5", "something"],
        ["0x31c640b92c21a1f1465c91070b4b3b4d6854195f", "something"],
        ["0x37f998764813b136ddf5a754f34063fd03065e36", "something"],
        ["0x37fa399a749c121f8a15ce77e3d9f9bec8020d7a", "something"],
        ["0x4f36659fa632310b6ec438dea4085b522a2dd077", "something"],
        ["0x62c01474f089b07dae603491675dc5b5748f7049", "something"],
        ["0x729af7294be595a0efd7d891c9e51f89c07950c7", "something"],
        ["0x83e3e5a16d3b696a0314b30b2534804dd5e11197", "something"],
        ["0x8703df2417e0d7c59d063caa9583cb10a4d20532", "something"],
        ["0x8dffcd74e5b5923512916c6a64b502689cfa65e1", "something"],
        ["0x95a4d7cccb5204733874fa87285a176fe1e9e240", "something"],
        ["0x99b2fcba8120bedd048fe79f5262a6690ed38c39", "something"],
        ["0xa4202b8b8afd5354e3e40a219bdc17f6001bf2cf", "something"],
        ["0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b", "something"],
        ["0xa9647f4a0a14042d91dc33c0328030a7157c93ae", "something"],
        ["0xaa6cffe5185732689c18f37a7f86170cb7304c2a", "something"],
        ["0xaae4a2e3c51c04606dcb3723456e58f3ed214f45", "something"],
        ["0xc37a43e940dfb5baf581a0b82b351d48305fc885", "something"],
        ["0xd2571607e241ecf590ed94b12d87c94babe36db6", "something"],
        ["0xf735071cbee190d76b704ce68384fc21e389fbe7", "something"],
        ["0x04110d816c380812a427968ece99b1c963dfbce6", null],
        ["0x095e7baea6a6c7c4c2dfeb977efac326af552d87", null],
        ["0x0a517d755cebbf66312b30fff713666a9cb917e0", null],
        ["0x24dd378f51adc67a50e339e8031fe9bd4aafab36", null],
        ["0x293f982d000532a7861ab122bdc4bbfd26bf9030", null],
        ["0x2cf5732f017b0cf1b1f13a1478e10239716bf6b5", null],
        ["0x31c640b92c21a1f1465c91070b4b3b4d6854195f", null],
        ["0x37f998764813b136ddf5a754f34063fd03065e36", null],
        ["0x37fa399a749c121f8a15ce77e3d9f9bec8020d7a", null],
        ["0x4f36659fa632310b6ec438dea4085b522a2dd077", null],
        ["0x62c01474f089b07dae603491675dc5b5748f7049", null],
        ["0x729af7294be595a0efd7d891c9e51f89c07950c7", null],
        ["0x83e3e5a16d3b696a0314b30b2534804dd5e11197", null],
        ["0x8703df2417e0d7c59d063caa9583cb10a4d20532", null],
        ["0x8dffcd74e5b5923512916c6a64b502689cfa65e1", null],
        ["0x95a4d7cccb5204733874fa87285a176fe1e9e240", null],
        ["0x99b2fcba8120bedd048fe79f5262a6690ed38c39", null],
        ["0xa4202b8b8afd5354e3e40a219bdc17f6001bf2cf", null],
        ["0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b", null],
        ["0xa9647f4a0a14042d91dc33c0328030a7157c93ae", null],
        ["0xaa6cffe5185732689c18f37a7f86170cb7304c2a", null],
        ["0xaae4a2e3c51c04606dcb3723456e58f3ed214f45", null],
        ["0xc37a43e940dfb5baf581a0b82b351d48305fc885", null],
        ["0xd2571607e241ecf590ed94b12d87c94babe36db6", null],
        ["0xf735071cbee190d76b704ce68384fc21e389fbe7", null]
      ],
      "root": "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
    },
    "jeff": {
      "in": [
        ["0x0000000000000000000000000000000000000000000000000000000000000045", "0x22b224a1420a802ab51d326e29fa98e34c4f24ea"],
        ["0x0000000000000000000000000000000000000000000000000000000000000046", "0x67706c2076330000000000000000000000000000000000000000000000000000"],
        ["0x0000000000000000000000000000000000000000000000000000001234567890", "0x697c7b8c961b56f675d570498424ac8de1a918f6"],
        ["0x000000000000000000000000697c7b8c961b56f675d570498424ac8de1a918f6", "0x1234567890"],
        ["0x0000000000000000000000007ef9e639e2733cb34e4dfc576d4b23f72db776b2", "0x4655474156000000000000000000000000000000000000000000000000000000"],
        ["0x000000000000000000000000ec4f34c97e43fbb2816cfd95e388353c7181dab1", "0x4e616d6552656700000000000000000000000000000000000000000000000000"],
        ["0x4655474156000000000000000000000000000000000000000000000000000000", "0x7ef9e639e2733cb34e4dfc576d4b23f72db776b2"],
        ["0x4e616d6552656700000000000000000000000000000000000000000000000000", "0xec4f34c97e43fbb2816cfd95e388353c7181dab1"],
        ["0x0000000000000000000000000000000000000000000000000000001234567890", null],
        ["0x000000000000000000000000697c7b8c961b56f675d570498424ac8de1a918f6", "0x6f6f6f6820736f2067726561742c207265616c6c6c793f000000000000000000"],
        ["0x6f6f6f6820736f2067726561742c207265616c6c6c793f000000000000000000", "0x697c7b8c961b56f675d570498424ac8de1a918f6"]
      ],
      "root": "0x9f6221ebb8efe7cff60a716ecb886e67dd042014be444669f0159d8e68b42100"
    },
    "insert-middle-leaf": {
      "in": [
        ["key1aa", "0123456789012345678901234567890123456789xxx"],
        ["key1", "0123456789012345678901234567890123456789Very_Long"],
        ["key2bb", "aval3"],
        ["key2", "short"],
        ["key3cc", "aval3"],
        ["key3", "1234567890123456789012345678901"]
      ],
      "root": "0xcb65032e2f76c48b82b5c24b3db8f670ce73982869d38cd39a624f23d62a9e89"
    },
    "branch-value-update": {
      "in": [
        ["abc", "123"],
        ["abcd", "abcd"],
        ["abc", "abc"]
      ],
      "root": "0x7a320748f780ad9ad5b0837302075ce0eeba6c26e3d8562c67ccc0f1b273298a"
    }
  },
  "trieanyorder": {
    "singleItem": {
      "in": {
        "A": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "root": "0xd23786fb4a010da3ce639d66d5e904a11dbc02746d1ce25029e53290cabf28ab"
    },
    "dogs": {
      "in": {
        "doe": "reindeer",
        "dog": "puppy",
        "dogglesworth": "cat"
      },
      "root": "0x8aad789dff2f538bca5d8ea56e8abe10f4c7ba3a5dea95fea4cd6e7c3a1168d3"
    },
    "puppy": {
      "in": {
        "do": "verb",
        "horse": "stallion",
        "doge": "coin",
        "dog": "puppy"
      },
      "root": "0x5991bb8c6514148a29db676a14ac506cd2cd5775ace63c30a4fe457715e9ac84"
    },
    "foo": {
      "in": {
        "foo": "bar",
        "food": "bass"
      },
      "root": "0x17beaa1648bafa633cda809c90c04af50fc8aed3cb40d16efbddee6fdf63c4c3"
    },
    "smallValues": {
      "in": {
        "be": "e",
        "dog": "puppy",
        "bed": "d"
      },
      "root": "0x3f67c7a47520f79faa29255d2d3c084a7a6df0453116ed7232ff10277a8be68b"
    },
    "testy": {
      "in": {
        "test": "test",
        "te": "testy"
      },
      "root": "0x8452568af70d8d140f58d941338542f645fcca50094b20f3c3d8c3df49337928"
    },
    "hex": {
      "in": {
        "0x0045": "0x0123456789",
        "0x4500": "0x9876543210"
      },
      "root": "0x285505fcabe84badc8aa310e2aae17eddc7d120aabec8a476902c8184b3a3503"
    }
  },
  "trietest_secureTrie": {
    "emptyValues": {
      "in": [
        ["do", "verb"],
        ["ether", "wookiedoo"],
        ["horse", "stallion"],
        ["shaman", "horse"],
        ["doge", "coin"],
        ["ether", null],
        ["dog", "puppy"],
        ["shaman", null]
      ],
      "root": "0x29b235a58c3c25ab83010c327d5932bcf05324b7d6b1185e650798034783ca9d"
    },
    "branchingTests": {
      "in": [
        ["0x04110d816c380812a427968ece99b1c963dfbce6", "something"],
        ["0x095e7baea6a6c7c4c2dfeb977efac326af552d87", "something"],
        ["0x0a517d755cebbf66312b30fff713666a9cb917e0", "something"],
        ["0x24dd378f51adc67a50e339e8031fe9bd4aafab36", "something"],
        ["0x293f982d000532a7861ab122bdc4bbfd26bf9030", "something"],
        ["0x2cf5732f017b0cf1b1f13a1478e10239716bf6b5", "something"],
        ["0x31c640b92c21a1f1465c91070b4b3b4d6854195f", "something"],
        ["0x37f998764813b136ddf5a754f34063fd03065e36", "something"],
        ["0x37fa399a749c121f8a15ce77e3d9f9bec8020d7a", "something"],
        ["0x4f36659fa632310b6ec438dea4085b522a2dd077", "something"],
        ["0x62c01474f089b07dae603491675dc5b5748f7049", "something"],
        ["0x729af7294be595a0efd7d891c9e51f89c07950c7", "something"],
        ["0x83e3e5a16d3b696a0314b30b2534804dd5e11197", "something"],
        ["0x8703df2417e0d7c59d063caa9583cb10a4d20532", "something"],
        ["0x8dffcd74e5b5923512916c6a64b502689cfa65e1", "something"],
        ["0x95a4d7cccb5204733874fa87285a176fe1e9e240", "something"],
        ["0x99b2fcba8120bedd048fe79f5262a6690ed38c39", "something"],
        ["0xa4202b8b8afd5354e3e40a219bdc17f6001bf2cf", "something"],
        ["0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b", "something"],
        ["0xa9647f4a0a14042d91dc33c0328030a7157c93ae", "something"],
        ["0xaa6cffe5185732689c18f37a7f86170cb7304c2a", "something"],
        ["0xaae4a2e3c51c04606dcb3723456e58f3ed214f45", "something"],
        ["0xc37a43e940dfb5baf581a0b82b351d48305fc885", "something"],
        ["0xd2571607e241ecf590ed94b12d87c94babe36db6", "something"],
        ["0xf735071cbee190d76b704ce68384fc21e389fbe7", "something"],
        ["0x04110d816c380812a427968ece99b1c963dfbce6", null],
        ["0x095e7baea6a6c7c4c2dfeb977efac326af552d87", null],
        ["0x0a517d755cebbf66312b30fff713666a9cb917e0", null],
        ["0x24dd378f51adc67a50e339e8031fe9bd4aafab36", null],
        ["0x293f982d000532a7861ab122bdc4bbfd26bf9030", null],
        ["0x2cf5732f017b0cf1b1f13a1478e10239716bf6b5", null],
        ["0x31c640b92c21a1f1465c91070b4b3b4d6854195f", null],
        ["0x37f998764813b136ddf5a754f34063fd03065e36", null],
        ["0x37fa399a749c121f8a15ce77e3d9f9bec8020d7a", null],
        ["0x4f36659fa632310b6ec438dea4085b522a2dd077", null],
        ["0x62c01474f089b07dae603491675dc5b5748f7049", null],
        ["0x729af7294be595a0efd7d891c9e51f89c07950c7", null],
        ["0x83e3e5a16d3b696a0314b30b2534804dd5e11197", null],
        ["0x8703df2417e0d7c59d063caa9583cb10a4d20532", null],
        ["0x8dffcd74e5b5923512916c6a64b502689cfa65e1", null],
        ["0x95a4d7cccb5204733874fa87285a176fe1e9e240", null],
        ["0x99b2fcba8120bedd048fe79f5262a6690ed38c39", null],
        ["0xa4202b8b8afd5354e3e40a219bdc17f6001bf2cf", null],
        ["0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b", null],
        ["0xa9647f4a0a14042d91dc33c0328030a7157c93ae", null],
        ["0xaa6cffe5185732689c18f37a7f86170cb7304c2a", null],
        ["0xaae4a2e3c51c04606dcb3723456e58f3ed214f45", null],
        ["0xc37a43e940dfb5baf581a0b82b351d48305fc885", null],
        ["0xd2571607e241ecf590ed94b12d87c94babe36db6", null],
        ["0xf735071cbee190d76b704ce68384fc21e389fbe7", null]
      ],
      "root": "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
    },
    "jeff": {
      "in": [
        ["0x0000000000000000000000000000000000000000000000000000000000000045", "0x22b224a1420a802ab51d326e29fa98e34c4f24ea"],
        ["0x0000000000000000000000000000000000000000000000000000000000000046", "0x67706c2076330000000000000000000000000000000000000000000000000000"],
        ["0x0000000000000000000000000000000000000000000000000000001234567890", "0x697c7b8c961b56f675d570498424ac8de1a918f6"],
        ["0x000000000000000000000000697c7b8c961b56f675d570498424ac8de1a918f6", "0x1234567890"],
        ["0x0000000000000000000000007ef9e639e2733cb34e4dfc576d4b23f72db776b2", "0x4655474156000000000000000000000000000000000000000000000000000000"],
        ["0x000000000000000000000000ec4f34c97e43fbb2816cfd95e388353c7181dab1", "0x4e616d6552656700000000000000000000000000000000000000000000000000"],
        ["0x4655474156000000000000000000000000000000000000000000000000000000", "0x7ef9e639e2733cb34e4dfc576d4b23f72db776b2"],
        ["0x4e616d6552656700000000000000000000000000000000000000000000000000", "0xec4f34c97e43fbb2816cfd95e388353c7181dab1"],
        ["0x0000000000000000000000000000000000000000000000000000001234567890", null],
        ["0x000000000000000000000000697c7b8c961b56f675d570498424ac8de1a918f6", "0x6f6f6f6820736f2067726561742c207265616c6c6c793f000000000000000000"],
        ["0x6f6f6f6820736f2067726561742c207265616c6c6c793f000000000000000000", "0x697c7b8c961b56f675d570498424ac8de1a918f6"]
      ],
      "root": "0x72adb52e9d9428f808e3e8045be18d3baa77881d0cfab89a17a2bcbacee2f320"
    }
  },
  "trieanyorder_secureTrie": {
    "singleItem": {
      "in": {
        "A": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "root": "0xe9e2935138352776cad724d31c9fa5266a5c593bb97726dd2a908fe6d53284df"
    },
    "dogs": {
      "in": {
        "doe": "reindeer",
        "dog": "puppy",
        "dogglesworth": "cat"
      },
      "root": "0xd4cd937e4a4368d7931a9cf51686b7e10abb3dce38a39000fd7902a092b64585"
    },
    "puppy": {
      "in": {
        "do": "verb",
        "horse": "stallion",
        "doge": "coin",
        "dog": "puppy"
      },
      "root": "0x29b235a58c3c25ab83010c327d5932bcf05324b7d6b1185e650798034783ca9d"
    },
    "foo": {
      "in": {
        "foo": "bar",
        "food": "bass"
      },
      "root": "0x1385f23a33021025d9e87cca5c66c00de06178807b96a9acc92b7d651ccde842"
    },
    "smallValues": {
      "in": {
        "be": "e",
        "dog": "puppy",
        "bed": "d"
      },
      "root": "0x826a4f9f9054a3e980e54b20da992c24fa20467f1ca635115ef4917be66e746f"
    },
    "testy": {
      "in": {
        "test": "test",
        "te": "testy"
      },
      "root": "0xaea54fb6c80499674248a462864c420c9d9f3b3d38c879c12425bade1ad76552"
    },
    "hex": {
      "in": {
        "0x0045": "0x0123456789",
        "0x4500": "0x9876543210"
      },
      "root": "0xbc11c02c8ab456db0c4d2728b6a2a6210d06f26a2ace4f7d8bdfc72ddf2630ab"
    }
  },
  "hex_encoded_securetrie_test": {
    "test1": {
      "in": {
        "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": "0xf848018405f446a7a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": "0xf8440101a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a004bccc5d94f4d1f99aab44369a910179931772f2a5c001c3229f57831c102769",
        "0xd2571607e241ecf590ed94b12d87c94babe36db6": "0xf8440180a0ba4b47865c55a341a4a78759bb913cd15c3ee8eaf30a62fa8d1c8863113d84e8a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        "0x62c01474f089b07dae603491675dc5b5748f7049": "0xf8448080a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        "0x2adc25665018aa1fe0e6bc666dac8fc2697ff9ba": "0xf8478083019a59a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
      },
      "root": "0x730a444e08ab4b8dee147c9b232fc52d34a223d600031c1e9d25bfc985cbd797",
      "hexEncoded": true
    },
    "test2": {
      "in": {
        "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": "0xf84c01880de0b6b3a7622746a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": "0xf84780830186b7a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0501653f02840675b1aab0328c6634762af5d51764e78f9641cccd9b27b90db4f",
        "0x2adc25665018aa1fe0e6bc666dac8fc2697ff9ba": "0xf8468082521aa056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
      },
      "root": "0xa7c787bf470808896308c215e22c7a580a0087bb6db6e8695fb4759537283a83",
      "hexEncoded": true
    },
    "test3": {
      "in": {
        "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": "0xf84c01880de0b6b3a7614bc3a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": "0xf84880840132b3a0a065fee2fffd7a68488cf7ef79f35f7979133172ac5727b5e0cf322953d13de492a06e5d8fec8b6b9bf41c3fb9b61696d5c87b66f6daa98d5f02ba9361b0c6916467",
        "0x0000000000000000000000000000000000000001": "0xf8448080a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        "0x2adc25665018aa1fe0e6bc666dac8fc2697ff9ba": "0xf8478083012d9da056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
      },
      "root": "0x40b37be88a49e2c08b8d33fcb03a0676ffd0481df54dfebd3512b8ec54f40cad",
      "hexEncoded": true
    }
  }
};

// ---- the empty trie --------------------------------------------------------
group('empty trie', () => {
  ok(EMPTY_TRIE_ROOT.toString('hex') === '56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    'EMPTY_TRIE_ROOT is keccak256(rlp(""))');
  ok(new Trie().rootHex() === EMPTY_TRIE_ROOT.toString('hex'), 'a fresh trie roots to the empty root');
  ok(new Trie().get('anything') === null, 'the empty trie holds nothing');
  {
    const t = new Trie();
    t.put('k', 'v'); t.del('k');
    ok(t.rootHex() === EMPTY_TRIE_ROOT.toString('hex'), 'deleting the last key returns to the empty root');
  }
});

// ---- hex-prefix encoding ---------------------------------------------------
/* The four canonical examples: parity is carried in the flag nibble, and an
 * even-length path is preceded by a zero padding nibble so the result is whole
 * bytes. Swap the two branches and every root moves. */
group('hex-prefix encoding', () => {
  ok(hpEncode([0, 1, 2, 3, 4, 5], false).toString('hex') === '00012345', 'extension, even length');
  ok(hpEncode([1, 2, 3, 4, 5], false).toString('hex') === '112345', 'extension, odd length');
  ok(hpEncode([0, 15, 1, 12, 11, 8], true).toString('hex') === '200f1cb8', 'leaf, even length');
  ok(hpEncode([15, 1, 12, 11, 8], true).toString('hex') === '3f1cb8', 'leaf, odd length');
  ok(hpEncode([], true).toString('hex') === '20', 'leaf, empty path');
  ok(hpEncode([], false).toString('hex') === '00', 'extension, empty path');
  {
    let roundTrips = true;
    for (let len = 0; len < 12; len++) {
      for (const isLeaf of [true, false]) {
        const nib = Array.from({ length: len }, (_, i) => (i * 7 + len) & 0x0f);
        try {
          const d = hpDecode(hpEncode(nib, isLeaf));
          if (d.isLeaf !== isLeaf || d.nibbles.join(',') !== nib.join(',')) roundTrips = false;
        } catch { roundTrips = false; }
      }
    }
    ok(roundTrips, 'hpDecode(hpEncode(x)) === x at every length and both kinds');
  }
  ok(toNibbles(Buffer.from('af09', 'hex')).join(',') === '10,15,0,9', 'nibbles are high-first');
  {
    let threw = 0;
    try { hpDecode(Buffer.from('40', 'hex')); } catch { threw++; }     // flag nibble > 3
    try { hpDecode(Buffer.from('0a12', 'hex')); } catch { threw++; }   // even path, non-zero pad
    try { hpDecode(Buffer.alloc(0)); } catch { threw++; }
    ok(threw === 3, 'hpDecode rejects an impossible flag, a non-zero pad and an empty path');
  }
});

// ---- ethereum/tests TrieTests ---------------------------------------------
group('trietest.json (ordered inserts and deletes, plain trie)', () => {
  for (const [name, t] of Object.entries(VECTORS.trietest)) runOrdered(name, t.in, t.root, false);
});

group('trietest_secureTrie.json (ordered, keccak-keyed)', () => {
  for (const [name, t] of Object.entries(VECTORS.trietest_secureTrie)) runOrdered(name, t.in, t.root, true);
});

group('trieanyorder.json (every insertion order, plain trie)', () => {
  for (const [name, t] of Object.entries(VECTORS.trieanyorder)) runAnyOrder(name, t.in, t.root, false);
});

group('trieanyorder_secureTrie.json (every insertion order, keccak-keyed)', () => {
  for (const [name, t] of Object.entries(VECTORS.trieanyorder_secureTrie)) runAnyOrder(name, t.in, t.root, true);
});

group('hex_encoded_securetrie_test.json (a trie of real account records)', () => {
  for (const [name, t] of Object.entries(VECTORS.hex_encoded_securetrie_test)) {
    runAnyOrder(name, t.in, t.root, true);
  }
});

// ---- rule 2: nodes under 32 bytes are embedded, not hashed -----------------
/* Roots alone would catch this, but only obliquely. Assert the mechanism: the
 * foo/food trie is one extension holding a branch holding a leaf, all of it
 * under 32 bytes, so the store must contain exactly one entry — the root. A
 * trie that hashed its small nodes would store three and root differently. */
group('embedded nodes', () => {
  {
    const db = new MemoryDB();
    const t = new Trie(db, EMPTY_TRIE_ROOT, { secure: false });
    t.put('foo', 'bar'); t.put('food', 'bass');
    ok(t.rootHex() === '17beaa1648bafa633cda809c90c04af50fc8aed3cb40d16efbddee6fdf63c4c3', 'foo/food root');
    ok(db.size === 1, 'the whole foo/food trie is one stored node; its children are embedded');
    const node = RLP.decode(db.get(t.root()));
    ok(Array.isArray(node[1]) && node[1].length === 17, 'the branch is inlined into the root as a list, not a hash');
    ok(RLP.encode(node[1]).length < 32, 'and it is inlined because its encoding is under 32 bytes');
    ok(t.get('foo').toString() === 'bar' && t.get('food').toString() === 'bass', 'embedded children still read');
  }
  {
    // The counterpart: values long enough to push nodes past 32 bytes must be
    // hashed into the store, or nothing would ever be stored at all.
    const db = new MemoryDB();
    const t = new Trie(db, EMPTY_TRIE_ROOT, { secure: false });
    t.put('foo', 'x'.repeat(64)); t.put('food', 'y'.repeat(64));
    t.root();
    ok(db.size > 1, 'nodes of 32 bytes or more are hashed into the store');
  }
  {
    /* The boundary itself, which is where an off-by-one lives: the threshold is
     * "under 32", so a node encoding to exactly 32 bytes is hashed. Keys 'a' and
     * 'b' meet at a branch whose children are `[0x20, value]` leaves, and that
     * encodes to value.length + 3 — so 29 bytes of value sits exactly on 32. */
    const leafFor = n => RLP.encode([Buffer.from([0x20]), Buffer.alloc(n, 0x5a)]);
    ok(leafFor(29).length === 32 && leafFor(28).length === 31, 'the boundary values are where we think');
    const build = n => {
      const db = new MemoryDB();
      const t = new Trie(db, EMPTY_TRIE_ROOT, { secure: false });
      t.put('a', Buffer.alloc(n, 0x5a)); t.put('b', Buffer.alloc(n, 0x5a));
      t.root();
      // The root is an extension whose child branch is inlined; the branch's own
      // children are the leaves in question.
      const branch = RLP.decode(db.get(t.root()))[1];
      return Array.isArray(branch) ? branch[1] : RLP.decode(db.get(branch))[1];
    };
    ok(Array.isArray(build(28)), 'a 31-byte leaf is embedded in its parent');
    ok(Buffer.isBuffer(build(29)) && build(29).length === 32, 'a 32-byte leaf is replaced by its hash');
  }
  {
    /* And the exception to rule 2: the root is hashed however small it is, or
     * there would be nothing 32 bytes wide to put in a block header. */
    const { keccak256 } = require('../src/crypto/keccak');
    const db = new MemoryDB();
    const t = new Trie(db, EMPTY_TRIE_ROOT, { secure: false });
    t.put('a', 'x');
    const enc = RLP.encode([hpEncode([6, 1], true), Buffer.from('x')]);
    ok(enc.length < 32, 'this entire trie encodes to under 32 bytes');
    ok(t.root().equals(keccak256(enc)), 'yet its root is the hash, not the node');
    ok(db.get(t.root()) !== undefined, 'and the node is in the store under that hash');
  }
});

// ---- rule 3: deletion collapses -------------------------------------------
group('deletion collapses', () => {
  {
    // Two keys sharing a prefix make ext → branch → two leaves. Removing one must
    // fold the branch into the survivor and merge it back through the extension,
    // giving byte-for-byte the trie that key alone would have built.
    const a = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    a.put('foo', 'bar'); a.put('food', 'bass'); a.del('food');
    const b = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    b.put('foo', 'bar');
    ok(a.rootHex() === b.rootHex(), 'branch with one survivor collapses back into a leaf');
  }
  {
    const a = new Trie(); const b = new Trie();
    const keys = ['do', 'dog', 'doge', 'horse', 'shaman', 'ether', 'etherium', 'e'];
    for (const k of keys) a.put(k, 'v-' + k);
    for (const k of ['dog', 'ether', 'e']) a.del(k);
    for (const k of keys) if (!['dog', 'ether', 'e'].includes(k)) b.put(k, 'v-' + k);
    ok(a.rootHex() === b.rootHex(), 'delete-down equals build-up for a mixed key set');
  }
  {
    // A branch that keeps only its value slot must become a leaf with an empty
    // path, not stay a 17-item node with sixteen holes.
    const a = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    a.put('ab', '1'); a.put('abc', '2'); a.del('abc');
    const b = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    b.put('ab', '1');
    ok(a.rootHex() === b.rootHex(), 'branch keeping only its value collapses too');
  }
  {
    const t = new Trie();
    t.put('a', '1'); t.put('b', '2');
    const before = t.rootHex();
    t.del('c'); t.del('');
    ok(t.rootHex() === before, 'deleting a key that is not there changes nothing');
  }
  {
    // 512 keys in, 512 keys out, in an order unrelated to the one they went in.
    const t = new Trie();
    const ks = Array.from({ length: 512 }, (_, i) => 'key-' + i);
    for (const k of ks) t.put(k, 'value-for-' + k + '-'.repeat(k.length));
    const shuffled = ks.slice().sort((x, y) => (x.length - y.length) || (x < y ? 1 : -1));
    for (const k of shuffled) t.del(k);
    ok(t.rootHex() === EMPTY_TRIE_ROOT.toString('hex'), '512 inserts fully deleted return to the empty root');
  }
});

// ---- values, reads, and the empty-value rule -------------------------------
group('values and reads', () => {
  {
    const t = new Trie();
    t.put('k', 'v');
    t.put('k', Buffer.alloc(0));
    ok(t.rootHex() === EMPTY_TRIE_ROOT.toString('hex'), 'putting an empty value is a delete, not a store');
    ok(t.get('k') === null, 'and the key reads back as absent');
  }
  {
    const t = new Trie();
    const big = Buffer.alloc(600, 0xab);
    t.put('0xdeadbeef', big);
    ok(t.get('0xdeadbeef').equals(big), 'a 600-byte value round-trips');
    ok(t.get('0xdeadbeee') === null, 'a near-miss key reads null');
  }
  {
    const t = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    t.put(Buffer.alloc(0), 'root value');
    t.put('a', 'x');
    ok(t.get(Buffer.alloc(0)).toString() === 'root value', 'the empty key is a legal key');
    ok(t.get('a').toString() === 'x', 'and coexists with others');
  }
});

// ---- historical roots ------------------------------------------------------
/* The store is content-addressed and never overwrites, so an old root stays
 * readable no matter what is written afterwards. Block N-1's state has to be
 * queryable while block N is being built, and reorgs need it too. */
group('historical roots', () => {
  {
    const db = new MemoryDB();
    const t = new Trie(db);
    t.put('a', '1'); t.put('b', '2');
    const rootA = t.root();
    t.put('a', 'changed'); t.put('c', '3'); t.del('b');
    const rootB = t.root();
    ok(!rootA.equals(rootB), 'the root moved');

    const past = new Trie(db, rootA);
    ok(past.get('a').toString() === '1', 'the historical trie still has the old value');
    ok(past.get('b').toString() === '2', 'and the key that was later deleted');
    ok(past.get('c') === null, 'and not the key added afterwards');
    ok(past.rootHex() === rootA.toString('hex'), 'opening at a root and asking for it is a no-op');

    const view = t.at(rootA);
    ok(view.get('a').toString() === '1', 'at() gives the same view over the shared store');
    ok(t.get('a').toString() === 'changed', 'and does not disturb the live trie');
  }
});

// ---- order independence at scale ------------------------------------------
group('order independence', () => {
  {
    // A deterministic pseudo-random key set — the anyorder vectors only reach
    // four keys, which is not enough to build a deep trie with real extensions.
    const { keccak256 } = require('../src/crypto/keccak');
    const pairs = [];
    for (let i = 0; i < 300; i++) {
      pairs.push([keccak256('key' + i).subarray(0, 8), keccak256('val' + i).subarray(0, 1 + (i % 40))]);
    }
    const forward = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    for (const [k, v] of pairs) forward.put(k, v);
    const backward = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    for (const [k, v] of pairs.slice().reverse()) backward.put(k, v);
    ok(forward.rootHex() === backward.rootHex(), '300 keys: insertion order does not affect the root');

    let allRead = true;
    for (const [k, v] of pairs) { const g = forward.get(k); if (!g || !g.equals(v)) allRead = false; }
    ok(allRead, '300 keys: every value reads back');

    // Delete half from the full trie; must equal the trie built from the other
    // half directly. This is the collapse path under real depth.
    const pruned = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    for (const [k, v] of pairs) pruned.put(k, v);
    for (let i = 0; i < pairs.length; i += 2) pruned.del(pairs[i][0]);
    const direct = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    for (let i = 1; i < pairs.length; i += 2) direct.put(pairs[i][0], pairs[i][1]);
    ok(pruned.rootHex() === direct.rootHex(), '300 keys: deleting half equals building the half');
  }
});

// ---- the secure variant ----------------------------------------------------
group('secure variant', () => {
  {
    const { keccak256 } = require('../src/crypto/keccak');
    const plain = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
    const secure = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: true });
    plain.put(keccak256('abc'), 'v');
    secure.put('abc', 'v');
    ok(plain.rootHex() === secure.rootHex(), 'the secure trie is the plain trie over keccak(key)');
    ok(secure.get('abc').toString() === 'v', 'and reads with the unhashed key');
  }
  {
    let threw = false;
    try { new Trie(new MemoryDB(), Buffer.alloc(31)); } catch { threw = true; }
    ok(threw, 'a root that is not 32 bytes is rejected');
    let missing = false;
    try { new Trie(new MemoryDB(), Buffer.alloc(32, 0xaa)).get('x'); } catch { missing = true; }
    ok(missing, 'opening at a root the store does not have fails loudly, not silently empty');
  }
});

// ---- the overlay store -----------------------------------------------------
/* The store speculative execution runs against. The property under test is not
 * "it works like a Map" — it is that a trie built on it is INDISTINGUISHABLE
 * from one built on the base store while it runs, and leaves NOTHING in the
 * base store when it is dropped. Both halves have to hold at once: a store that
 * only satisfies the second is a trie that cannot read its own writes back, and
 * an SSTORE followed by an SLOAD of the same slot would return zero. */
group('overlay store', () => {
  {
    const base = new MemoryDB();
    const seeded = new Trie(base, EMPTY_TRIE_ROOT, { secure: false });
    for (let i = 0; i < 64; i++) seeded.put('key' + i, 'value-' + i);
    const root = seeded.root();
    const sealed = base.size;
    ok(sealed > 1, 'the base store holds a real trie to overlay');

    const overlay = new OverlayDB(base);
    const spec = new Trie(overlay, root, { secure: false });
    ok(spec.get('key7').toString() === 'value-7', 'a read falls through to the base store');

    for (let i = 0; i < 64; i++) spec.put('key' + i, 'rewritten-' + i);
    const specRoot = spec.root();
    ok(specRoot.toString('hex') !== root.toString('hex'), 'the speculative writes changed the root');
    ok(spec.get('key7').toString() === 'rewritten-7', 'and the trie reads its own writes back');
    ok(base.size === sealed, 'while the base store gained NOT ONE node');
    ok(overlay.size > 0, 'the nodes went to the overlay, which the caller drops');

    // The base store is still openable at the old root and still says the old
    // thing — the whole point, since that root is what a block header commits to.
    const after = new Trie(base, root, { secure: false });
    ok(after.get('key7').toString() === 'value-7', 'the base trie at the sealed root is untouched');
    let orphaned = false;
    try { new Trie(base, specRoot, { secure: false }).get('key7'); } catch { orphaned = true; }
    ok(orphaned, 'and the speculative root is not resolvable against the base store at all');
  }
  {
    const base = new MemoryDB();
    const k = Buffer.alloc(32, 0x11);
    base.put(k, Buffer.from('base'));
    const overlay = new OverlayDB(base);
    ok(overlay.has(k), 'has() sees a key that only the base store holds');
    const fresh = Buffer.alloc(32, 0x22);
    ok(!overlay.has(fresh), 'and is false for a key neither holds');
    overlay.put(fresh, Buffer.from('spec'));
    ok(overlay.has(fresh) && !base.has(fresh), 'a put is visible through the overlay and not below it');
    overlay.put(k, Buffer.from('shadow'));
    ok(overlay.get(k).toString() === 'shadow', 'the overlay shadows the base store for the same key');
    ok(base.get(k).toString() === 'base', 'without changing what the base store says');
  }
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);

