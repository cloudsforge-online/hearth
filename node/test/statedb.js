'use strict';
/* Tests for the world state: account encoding, storage encoding, and the
 * journal the EVM reverts through. Zero-dependency mini harness.
 * Run: node test/statedb.js
 *
 * The trie underneath is gated by test/trie.js against ethereum/tests
 * TrieTests, so what is left for this file is everything StateDB adds on top —
 * and the way to gate that against something other than our own opinion is
 * ALLOCS below. Each entry is a real, published Ethereum state: the account
 * list is verbatim from a BlockchainTest's `pre` or `postState`, and the root
 * is the `stateRoot` the corresponding block header commits to. Reproducing
 * those roots from balances, nonces, code and storage exercises every encoding
 * decision at once — field order in the account RLP, keccak-keyed addressing,
 * leading-zero-stripped storage values, and zero-means-absent — against
 * numbers no one here chose.
 *
 * Source: ethereum/tests BlockchainTests/ValidBlocks/{bcValidBlockTest,
 * bcStateTests}/{SimpleTx,log1_correct,simpleSuicide,suicideStorageCheck}.json,
 * Cancun variants. Vendored rather than fetched so the suite is offline.
 *
 * The journal half cannot be gated that way — no published fixture describes an
 * intermediate revert — so it is tested by the property that actually matters:
 * a snapshot taken, arbitrary damage done, and the state root back to the byte
 * it was. A root that matches after a revert is a much stronger claim than a
 * handful of field-by-field comparisons, because it covers the fields nobody
 * remembered to check.
 */

const {
  StateDB, MemoryDB, EMPTY_CODE_HASH, EMPTY_TRIE_ROOT, PRECOMPILES,
  encodeAccount, decodeAccount, emptyAccount,
} = require('../src/state/statedb');
const { Trie } = require('../src/state/trie');
const { keccak256 } = require('../src/crypto/keccak');
const RLP = require('../src/crypto/rlp');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name, fn) {
  console.log('• ' + name);
  try { fn(); } catch (e) { fail++; console.log(`  ✗ ${name}: threw — ${e.message}`); }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

const ALLOCS = {
  "SimpleTx (genesis)": {
    "alloc": {
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81"
        }
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x02540be400",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      }
    },
    "root": "0x53c881003b15376a1d1d235531d20bfccc8f1bdce9caeb6a6c5ac64a9c9b1e93"
  },
  "SimpleTx (post)": {
    "alloc": {
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81",
          "0x16ca": "0x54c99069"
        }
      },
      "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": {
        "balance": "0x0a",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      },
      "0x8888f1f195afa192cfee860698584c030f4c9db1": {
        "balance": "0x013bf2d0",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x0252cb74b6",
        "code": "0x",
        "nonce": "0x01",
        "storage": {}
      }
    },
    "root": "0xc38d881219a710cef8ba02b496f9211c657fbe8c18de3909d353cdc1a8d4e16f"
  },
  "log1_correct (genesis)": {
    "alloc": {
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81"
        }
      },
      "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": {
        "balance": "0x64",
        "code": "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff600052600060206000a100",
        "nonce": "0x00",
        "storage": {}
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x02540be400",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      }
    },
    "root": "0x305968077e727659a8732ededeae3add763a9b7b22e2cc976c0f2a6d9d6c6f35"
  },
  "log1_correct (post)": {
    "alloc": {
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81",
          "0x16ca": "0x54c99069"
        }
      },
      "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": {
        "balance": "0x012a05f264",
        "code": "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff600052600060206000a100",
        "nonce": "0x00",
        "storage": {}
      },
      "0x8888f1f195afa192cfee860698584c030f4c9db1": {
        "balance": "0x014b665e",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x0128b5d708",
        "code": "0x",
        "nonce": "0x01",
        "storage": {}
      }
    },
    "root": "0xb8113d5ae64406e461534648209f47465ec8afd60848fa9dc13ee3e4c23162ff"
  },
  "simpleSuicide (genesis)": {
    "alloc": {
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81"
        }
      },
      "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": {
        "balance": "0x0186a0",
        "code": "0x73a94f5374fce5edbc8e2a8697c15331677e6ebf0bff00",
        "nonce": "0x00",
        "storage": {}
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x1748721582",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      }
    },
    "root": "0x0a66b902c537793949e166eb2b27651c02f7f42615704781c57cdb0010fb4b5b"
  },
  "simpleSuicide (post)": {
    "alloc": {
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81",
          "0x16ca": "0x54c99069",
          "0x1ab2": "0x54c99451"
        }
      },
      "0x095e7baea6a6c7c4c2dfeb977efac326af552d87": {
        "balance": "0x00",
        "code": "0x73a94f5374fce5edbc8e2a8697c15331677e6ebf0bff00",
        "nonce": "0x00",
        "storage": {}
      },
      "0x8888f1f195afa192cfee860698584c030f4c9db1": {
        "balance": "0x030ed5ef",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x17455a0fb2",
        "code": "0x",
        "nonce": "0x02",
        "storage": {}
      }
    },
    "root": "0x97c2499be7ff9408507d11f5a5378b43d4cda26a64baa627387efe780097cccf"
  },
  "suicideStorageCheck (genesis)": {
    "alloc": {
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81"
        }
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x02540be400",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      },
      "0xec0e71ad0a90ffe1909d27dac207f7680abba42d": {
        "balance": "0x03e8",
        "code": "0x60036001556001ff00",
        "nonce": "0x00",
        "storage": {}
      }
    },
    "root": "0xe24421be14124bb1ac444d70bedc477f4540fd0b22088ccd359c1e170e4bad7d"
  },
  "suicideStorageCheck (post)": {
    "alloc": {
      "0x0000000000000000000000000000000000000001": {
        "balance": "0x03e8",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      },
      "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": {
        "balance": "0x00",
        "code": "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500",
        "nonce": "0x01",
        "storage": {
          "0x12e2": "0x54c98c81",
          "0x16ca": "0x54c99069"
        }
      },
      "0x8888f1f195afa192cfee860698584c030f4c9db1": {
        "balance": "0x1bce00e2",
        "code": "0x",
        "nonce": "0x00",
        "storage": {}
      },
      "0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b": {
        "balance": "0x0237d8d1f8",
        "code": "0x",
        "nonce": "0x02",
        "storage": {}
      },
      "0xec0e71ad0a90ffe1909d27dac207f7680abba42d": {
        "balance": "0x00",
        "code": "0x60036001556001ff00",
        "nonce": "0x00",
        "storage": {
          "0x01": "0x03"
        }
      }
    },
    "root": "0x5270e4ed7318a1c490b6c6323befbf60eb89ed031e9d468dc15f0cd876daf031"
  }
};

/** Load a published account list through the public API, as genesis would. */
function loadAlloc(sdb, alloc) {
  for (const [addr, a] of Object.entries(alloc)) {
    sdb.setBalance(addr, BigInt(a.balance));
    sdb.setNonce(addr, BigInt(a.nonce));
    if (a.code && a.code !== '0x') sdb.setCode(addr, a.code);
    for (const [slot, v] of Object.entries(a.storage || {})) sdb.setStorage(addr, BigInt(slot), BigInt(v));
  }
}

// ---- constants -------------------------------------------------------------
group('constants', () => {
  ok(EMPTY_CODE_HASH.toString('hex') === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    'EMPTY_CODE_HASH is keccak256("")');
  ok(EMPTY_TRIE_ROOT.toString('hex') === '56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    'EMPTY_TRIE_ROOT is keccak256(rlp(""))');
  ok(new StateDB().rootHex() === EMPTY_TRIE_ROOT.toString('hex'), 'an empty world roots to the empty trie root');
  const e = emptyAccount();
  ok(e.nonce === 0n && e.balance === 0n && e.storageRoot.equals(EMPTY_TRIE_ROOT) && e.codeHash.equals(EMPTY_CODE_HASH),
    'the empty account is 0 / 0 / empty trie / keccak256("")');
  ok(PRECOMPILES.length === 9 && PRECOMPILES[0][19] === 1 && PRECOMPILES[8][19] === 9,
    'the default pre-warmed precompile set is 0x01–0x09');
});

// ---- the account record ----------------------------------------------------
group('account encoding', () => {
  const a = { nonce: 7n, balance: 1234567890123456789n, storageRoot: keccak256('sr'), codeHash: keccak256('ch') };
  const back = decodeAccount(encodeAccount(a));
  ok(back.nonce === a.nonce && back.balance === a.balance
    && back.storageRoot.equals(a.storageRoot) && back.codeHash.equals(a.codeHash), 'an account round-trips');
  const fields = RLP.decode(encodeAccount(a));
  ok(fields.length === 4, 'an account is a 4-item list');
  ok(fields[0].toString('hex') === '07' && fields[2].equals(a.storageRoot),
    'the order is [nonce, balance, storageRoot, codeHash]');
  ok(RLP.decode(encodeAccount(emptyAccount()))[0].length === 0, 'zero is the empty string, not 0x00');

  /* RLP is untyped, so nothing below this layer can know that a nonce is a
   * scalar and must be minimal. Two encodings of one account hash differently;
   * that is a chain split, so the decoder has to refuse. */
  const raw = (n, b) => RLP.encode([n, b, EMPTY_TRIE_ROOT, EMPTY_CODE_HASH]);
  ok(throws(() => decodeAccount(raw(Buffer.from('00', 'hex'), Buffer.alloc(0)))), 'a 0x00 nonce is rejected');
  ok(throws(() => decodeAccount(raw(Buffer.alloc(0), Buffer.from('0001', 'hex')))), 'a leading-zero balance is rejected');
  ok(!throws(() => decodeAccount(raw(Buffer.alloc(0), Buffer.alloc(0)))), 'but the empty string is a valid zero');
  ok(throws(() => decodeAccount(RLP.encode([Buffer.alloc(0), Buffer.alloc(0), EMPTY_TRIE_ROOT]))), 'a 3-item account is rejected');
  ok(throws(() => decodeAccount(RLP.encode([Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(31), EMPTY_CODE_HASH]))),
    'a storageRoot that is not 32 bytes is rejected');
});

// ---- published state roots -------------------------------------------------
group('state roots against published Ethereum fixtures', () => {
  for (const [name, v] of Object.entries(ALLOCS)) {
    const sdb = new StateDB();
    loadAlloc(sdb, v.alloc);
    const got = '0x' + sdb.rootHex();
    ok(got === v.root, `${name}: ${got} != ${v.root}`);
  }
  // Order must not matter, and the state must read back as it went in.
  for (const [name, v] of Object.entries(ALLOCS)) {
    const sdb = new StateDB();
    const entries = Object.entries(v.alloc).reverse();
    loadAlloc(sdb, Object.fromEntries(entries));
    ok('0x' + sdb.rootHex() === v.root, `${name}: same root loaded in reverse`);
    let reads = true;
    for (const [addr, a] of Object.entries(v.alloc)) {
      if (sdb.getBalance(addr) !== BigInt(a.balance)) reads = false;
      if (sdb.getNonce(addr) !== BigInt(a.nonce)) reads = false;
      if (sdb.getCode(addr).toString('hex') !== (a.code || '0x').slice(2)) reads = false;
      for (const [slot, val] of Object.entries(a.storage || {})) {
        if (BigInt('0x' + sdb.getStorage(addr, BigInt(slot)).toString('hex')) !== BigInt(val)) reads = false;
      }
    }
    ok(reads, `${name}: every balance, nonce, code and slot reads back`);
  }
});

// ---- storage encoding ------------------------------------------------------
group('storage encoding', () => {
  const db = new MemoryDB();
  const sdb = new StateDB(db);
  sdb.setStorage(A, 0n, 1n);
  // Reach into the storage trie directly: the value must be rlp(0x01) — one
  // byte — not a padded 32-byte word. This is consensus, not compression.
  const st = new Trie(db, sdb.getAccount(A).storageRoot);
  ok(st.get(Buffer.alloc(32)).equals(RLP.encode(Buffer.from([1]))), 'a storage value is rlp(bytes) with leading zeros stripped');
  ok(sdb.getStorage(A, 0n).length === 32, 'but reads back as a full 32-byte word');
  ok(sdb.getStorage(A, 0n)[31] === 1, 'right-aligned');

  const withPadding = new StateDB();
  withPadding.setStorage(A, 0n, '0x0000000000000000000000000000000000000000000000000000000000000001');
  ok(withPadding.rootHex() === sdb.rootHex(), 'a padded write and a bare write give the same root');

  // Zero is absence. Storing 32 zero bytes would give one state two roots.
  const before = new StateDB().rootHex();
  const z = new StateDB();
  z.setStorage(A, 5n, 99n);
  z.setStorage(A, 5n, 0n);
  ok(z.getAccount(A).storageRoot.equals(EMPTY_TRIE_ROOT), 'writing zero deletes the slot rather than storing zeros');
  ok(z.getStorage(A, 5n).equals(Buffer.alloc(32)), 'and an unset slot reads as zero');
  ok(z.getStorage(A, 12345n).equals(Buffer.alloc(32)), 'as does a slot never written');
  ok(before !== z.rootHex(), 'the account itself still exists (it was created by the write)');

  const full = new StateDB();
  const word = Buffer.alloc(32, 0xcd);
  full.setStorage(A, 7n, word);
  ok(full.getStorage(A, 7n).equals(word), 'a full-width value round-trips');

  // The storage trie is keyed by keccak(slot), like the account trie by address.
  const manual = new Trie(new MemoryDB());
  manual.put(Buffer.alloc(32), RLP.encode(Buffer.from([1])));
  ok(manual.root().equals(sdb.getAccount(A).storageRoot), 'the storage trie is the secure trie over the slot');
});

// ---- exists vs empty -------------------------------------------------------
/* These are different questions and the gas schedule depends on the difference:
 * the CALL family charges 25,000 for a value transfer to an account that is
 * EMPTY, not to one that is absent. An account can sit in the trie with zero
 * nonce, zero balance and no code and still be empty. */
group('exists and empty are different predicates', () => {
  const sdb = new StateDB();
  ok(!sdb.exists(A) && sdb.empty(A), 'an absent account does not exist and is empty');
  sdb.setNonce(A, 0n);
  ok(sdb.exists(A), 'setting a zero nonce brings the account into existence');
  ok(sdb.empty(A), 'and it exists, yet is still empty — the case that separates the two');
  ok(sdb.rootHex() !== EMPTY_TRIE_ROOT.toString('hex'), 'an existing empty account is in the trie and moves the root');

  sdb.setBalance(A, 1n);
  ok(sdb.exists(A) && !sdb.empty(A), 'a balance makes it non-empty');
  sdb.setBalance(A, 0n); sdb.setNonce(A, 1n);
  ok(!sdb.empty(A), 'so does a nonce');
  sdb.setNonce(A, 0n); sdb.setCode(A, '0x00');
  ok(!sdb.empty(A), 'and so does code, even a single STOP');
  ok(sdb.isEmpty(A) === sdb.empty(A), 'isEmpty is an alias, not a second opinion');
});

// ---- code ------------------------------------------------------------------
group('code', () => {
  const sdb = new StateDB();
  ok(sdb.getCode(A).length === 0 && sdb.getCodeHash(A).equals(EMPTY_CODE_HASH), 'an unknown account has no code');
  const code = Buffer.from('60016002600301', 'hex');
  sdb.setCode(A, code);
  ok(sdb.getCode(A).equals(code), 'code round-trips');
  ok(sdb.getCodeHash(A).equals(keccak256(code)), 'codeHash is keccak256(code)');
  ok(sdb.getCodeSize(A) === code.length, 'codeSize matches');
  sdb.setCode(A, Buffer.alloc(0));
  ok(sdb.getCodeHash(A).equals(EMPTY_CODE_HASH), 'clearing code restores the empty hash');
  // Code survives a reopen, because it is written to the same store the trie uses.
  const db = new MemoryDB();
  const one = new StateDB(db);
  one.setCode(B, code);
  const reopened = new StateDB(db, one.root());
  ok(reopened.getCode(B).equals(code), 'code is readable from a state reopened at a root');
});

// ---- the journal -----------------------------------------------------------
group('journal: snapshot and revert', () => {
  const sdb = new StateDB();
  sdb.setBalance(A, 100n); sdb.setNonce(A, 3n); sdb.setStorage(A, 1n, 42n); sdb.setCode(A, '0x6001');
  const root = sdb.rootHex();
  const mark = sdb.snapshot();

  sdb.setBalance(A, 999n);
  sdb.setNonce(A, 9n);
  sdb.setStorage(A, 1n, 0n);          // delete
  sdb.setStorage(A, 2n, 7n);          // add
  sdb.setCode(A, '0x00');
  sdb.setBalance(B, 5n);              // a whole new account
  ok(sdb.rootHex() !== root, 'the damage moved the root');

  sdb.revertTo(mark);
  ok(sdb.rootHex() === root, 'reverting restores the state root byte for byte');
  ok(sdb.getBalance(A) === 100n && sdb.getNonce(A) === 3n, 'and the scalar fields');
  ok(sdb.getStorage(A, 1n)[31] === 42, 'and a deleted storage slot');
  ok(sdb.getStorage(A, 2n).equals(Buffer.alloc(32)), 'and removes a slot that was added');
  ok(sdb.getCode(A).toString('hex') === '6001', 'and the code');
  ok(!sdb.exists(B), 'and an account created after the snapshot is gone');
});

group('journal: nesting', () => {
  const sdb = new StateDB();
  sdb.setBalance(A, 1n);
  const roots = [sdb.rootHex()];
  const marks = [];
  // 1024 is the EVM's call depth, so the journal has to nest at least that far.
  for (let i = 0; i < 1024; i++) {
    marks.push(sdb.snapshot());
    sdb.setBalance(A, BigInt(i + 2));
    sdb.setStorage(A, BigInt(i), BigInt(i + 1));
    roots.push(sdb.rootHex());
  }
  ok(roots[1024] !== roots[0], '1024 nested frames each changed something');

  // Unwind one frame at a time; each must land exactly on the root it began at.
  let exact = true;
  for (let i = 1023; i >= 0; i--) {
    sdb.revertTo(marks[i]);
    if (sdb.rootHex() !== roots[i]) exact = false;
  }
  ok(exact, 'unwinding 1024 frames one at a time hits every intermediate root');
  ok(sdb.getBalance(A) === 1n, 'and lands back where it started');

  // And the same depth collapsed in a single call, which is what a revert at
  // the bottom of a deep call stack actually does.
  const deep = new StateDB();
  deep.setBalance(A, 1n);
  const base = deep.rootHex(), first = deep.snapshot();
  for (let i = 0; i < 1024; i++) { deep.snapshot(); deep.setStorage(A, BigInt(i), 1n); }
  deep.revertTo(first);
  ok(deep.rootHex() === base, 'reverting straight past 1024 frames restores the root too');
});

group('journal: commit and misuse', () => {
  const sdb = new StateDB();
  sdb.setBalance(A, 10n);
  const mark = sdb.snapshot();
  sdb.setBalance(A, 20n);
  sdb.commit();
  ok(sdb.getBalance(A) === 20n, 'commit keeps the change');
  ok(throws(() => sdb.revertTo(mark)), 'and the marker is no longer usable');
  ok(sdb.snapshot() === 0, 'the journal is empty again');
  ok(throws(() => sdb.revertTo(-1)) && throws(() => sdb.revertTo(5)) && throws(() => sdb.revertTo(1.5)),
    'a marker that was never issued is rejected rather than silently ignored');
});

// ---- EIP-2929 --------------------------------------------------------------
group('EIP-2929 access list', () => {
  const sdb = new StateDB();
  ok(!sdb.isWarmAddress(A), 'addresses start cold');
  ok(sdb.warmAddress(A) === true, 'warming a cold address reports it was cold (the caller pays 2600)');
  ok(sdb.warmAddress(A) === false, 'warming it again reports warm (100)');
  ok(sdb.isWarmAddress(A) && !sdb.isWarmAddress(B), 'and only that address');

  ok(sdb.warmSlot(A, 3n) === true && sdb.warmSlot(A, 3n) === false, 'slots warm the same way');
  ok(!sdb.isWarmSlot(A, 4n), 'a different slot on a warm address is still cold');
  ok(!sdb.isWarmSlot(B, 3n), 'and the same slot on a different address');

  /* The part that is easy to miss: an address warmed inside a frame that then
   * reverts must go cold again, or a later access is charged 100 where every
   * other client charges 2600 and the block fails to validate. */
  const mark = sdb.snapshot();
  sdb.warmAddress(B);
  sdb.warmSlot(A, 4n);
  ok(sdb.isWarmAddress(B) && sdb.isWarmSlot(A, 4n), 'warmed inside the frame');
  sdb.revertTo(mark);
  ok(!sdb.isWarmAddress(B), 'a revert cools an address warmed in the reverted frame');
  ok(!sdb.isWarmSlot(A, 4n), 'and a slot');
  ok(sdb.isWarmAddress(A) && sdb.isWarmSlot(A, 3n), 'but leaves what was warm before it alone');

  const tx = new StateDB();
  tx.prepareAccessList({
    origin: A, to: B, coinbase: C,
    accessList: [{ address: '0x4444444444444444444444444444444444444444', storageKeys: [1n, 2n] }],
  });
  ok(tx.isWarmAddress(A) && tx.isWarmAddress(B), 'a transaction starts with sender and target warm');
  ok(tx.isWarmAddress(C), 'and the coinbase — EIP-3651, which Shanghai includes');
  ok(PRECOMPILES.every(p => tx.isWarmAddress(p)), 'and every precompile');
  ok(tx.isWarmAddress('0x4444444444444444444444444444444444444444') && tx.isWarmSlot('0x4444444444444444444444444444444444444444', 2n),
    'and everything the EIP-2930 access list declared');
  ok(!tx.isWarmSlot('0x4444444444444444444444444444444444444444', 3n), 'but nothing it did not');
});

// ---- refunds ---------------------------------------------------------------
group('refund counter', () => {
  const sdb = new StateDB();
  ok(sdb.getRefund() === 0n, 'refunds start at zero');
  sdb.addRefund(4800n);
  const mark = sdb.snapshot();
  sdb.addRefund(4800n);
  sdb.subRefund(1000n);
  ok(sdb.getRefund() === 8600n, 'refunds add and subtract');
  sdb.revertTo(mark);
  ok(sdb.getRefund() === 4800n, 'and roll back with everything else');
  ok(throws(() => sdb.subRefund(9999n)), 'the counter refuses to go negative rather than wrapping');
});

// ---- self-destruct ---------------------------------------------------------
group('self-destruct', () => {
  const sdb = new StateDB();
  sdb.setBalance(A, 500n); sdb.setCode(A, '0x6001'); sdb.setStorage(A, 1n, 9n);
  sdb.setBalance(B, 1n);
  sdb.beginTransaction();

  ok(sdb.selfDestruct(A, B) === true, 'self-destruct reports success');
  ok(sdb.getBalance(B) === 501n, 'the balance moves to the beneficiary immediately');
  ok(sdb.getBalance(A) === 0n, 'and leaves nothing behind');
  ok(sdb.hasSelfDestructed(A), 'the account is marked');
  // Shanghai (pre-EIP-6780) destroys at the end of the transaction, not now —
  // the rest of the frame can still read the code it is executing.
  ok(sdb.exists(A) && sdb.getCode(A).length === 2, 'but the account is still there mid-transaction');
  ok(sdb.getStorage(A, 1n)[31] === 9, 'and so is its storage');

  sdb.finalize();
  ok(!sdb.exists(A), 'finalize removes it');
  ok(!sdb.hasSelfDestructed(A), 'and clears the mark for the next transaction');

  const back = new StateDB();
  back.setBalance(A, 500n); back.setCode(A, '0x6001');
  back.setBalance(B, 1n);
  const root = back.rootHex();
  const mark = back.snapshot();
  back.selfDestruct(A, B);
  back.revertTo(mark);
  ok(back.rootHex() === root, 'a reverted self-destruct leaves no trace');
  ok(!back.hasSelfDestructed(A), 'including the mark itself');
  back.finalize();
  ok(back.rootHex() === root, 'so finalize afterwards destroys nothing');

  const burn = new StateDB();
  burn.setBalance(A, 77n); burn.setCode(A, '0x00');
  burn.selfDestruct(A, A);
  ok(burn.getBalance(A) === 0n, 'self-destructing to your own address burns the balance');
});

// ---- EIP-161 ---------------------------------------------------------------
group('EIP-161 touch and empty-account deletion', () => {
  const sdb = new StateDB();
  sdb.setBalance(A, 1n);
  const root = sdb.rootHex();

  sdb.setNonce(B, 0n);                  // brings an empty account into existence
  ok(sdb.exists(B), 'the empty account is in the trie');
  ok(sdb.rootHex() !== root, 'and the root reflects it');
  sdb.touch(B);
  sdb.finalize();
  ok(!sdb.exists(B), 'a touched, still-empty account is deleted at the end of the transaction');
  ok(sdb.rootHex() === root, 'and the root returns to what it was');

  // Untouched empty accounts are left alone; only touching sweeps them.
  const kept = new StateDB();
  kept.setNonce(B, 0n);
  const withEmpty = kept.rootHex();
  kept.finalize();
  ok(kept.rootHex() === withEmpty, 'an untouched empty account survives finalize');

  // A touch inside a frame that reverts must not survive it.
  const rev = new StateDB();
  rev.setNonce(B, 0n);
  const before = rev.rootHex();
  const mark = rev.snapshot();
  rev.touch(B);
  rev.revertTo(mark);
  rev.finalize();
  ok(rev.rootHex() === before, 'a touch inside a reverted frame does not delete anything');

  // Touching a non-empty account does nothing.
  const live = new StateDB();
  live.setBalance(A, 1n);
  live.touch(A);
  const r = live.rootHex();
  live.finalize();
  ok(live.rootHex() === r && live.exists(A), 'a touched non-empty account survives');

  // Adding zero is a touch, which is how a zero-value CALL to a fresh address
  // avoids leaving an empty account behind.
  const zero = new StateDB();
  zero.setBalance(A, 1n);
  const base = zero.rootHex();
  zero.addBalance(B, 0n);
  zero.finalize();
  ok(zero.rootHex() === base, 'a zero-value transfer to a fresh address leaves nothing behind');
});

// ---- original (pre-transaction) storage ------------------------------------
group('original storage for SSTORE pricing', () => {
  const num = b => BigInt('0x' + b.toString('hex'));
  const sdb = new StateDB();
  sdb.setStorage(A, 1n, 10n);
  sdb.setStorage(A, 3n, 30n);
  sdb.setStorage(A, 4n, 40n);
  sdb.beginTransaction();
  ok(num(sdb.originalStorage(A, 1n)) === 10n, 'the original value is the one at transaction start');
  sdb.setStorage(A, 1n, 20n);
  sdb.setStorage(A, 3n, 33n);
  sdb.setStorage(A, 4n, 0n);
  ok(num(sdb.getStorage(A, 1n)) === 20n, 'the current value moves');
  ok(num(sdb.originalStorage(A, 1n)) === 10n, 'the original does not');
  // Slots 3 and 4 are asked about for the FIRST time only after they were
  // changed, so no memo taken before the write can be doing the work — the
  // answer has to come out of the pre-transaction root.
  ok(num(sdb.originalStorage(A, 3n)) === 30n, 'a slot first read after it was overwritten still reports its pre-transaction value');
  ok(num(sdb.originalStorage(A, 4n)) === 40n, 'and one that was deleted outright');
  sdb.setStorage(A, 1n, 0n);
  ok(num(sdb.originalStorage(A, 1n)) === 10n, 'not even when the slot is deleted');
  ok(sdb.originalStorage(A, 2n).equals(Buffer.alloc(32)), 'a slot that never existed originals to zero');
  ok(sdb.originalStorage(B, 1n).equals(Buffer.alloc(32)), 'as does one on an account that never existed');
  /* A state opened at a root already has its baseline — `eth_call` and
   * `eth_estimateGas` run against a historical root without a transaction
   * boundary ever being declared, and must still price SSTORE correctly. */
  const db = new MemoryDB();
  const seed = new StateDB(db);
  seed.setStorage(A, 9n, 77n);
  const fresh = new StateDB(db, seed.root());
  ok(num(fresh.originalStorage(A, 9n)) === 77n, 'a state opened at a root originals from that root, with no beginTransaction');
  fresh.setStorage(A, 9n, 88n);
  ok(num(fresh.originalStorage(A, 9n)) === 77n, 'and holds that baseline once written over');

  sdb.setStorage(A, 1n, 55n);
  sdb.beginTransaction();
  ok(num(sdb.originalStorage(A, 1n)) === 55n, 'the next transaction takes its baseline from where the last one ended');
  ok(num(sdb.originalStorage(A, 3n)) === 33n, 'for every slot, not just the ones asked about before');

  /* createAccount wipes the storage, so the baseline has to move to zero with
   * it — otherwise SSTORE prices the EIP-2200 rows against a value that is no
   * longer there. NOTHING IN THE CONFORMANCE CORPUS REACHES THIS: post-EIP-7610
   * the EVM never calls createAccount on an address that has storage, because
   * that is a collision. It is pinned here because createAccount is a public
   * method of this module and this is its documented contract; see the note on
   * originalStorage. */
  const rst = new StateDB();
  rst.setStorage(A, 1n, 10n);
  rst.setStorage(A, 2n, 20n);
  rst.beginTransaction();
  ok(num(rst.originalStorage(A, 1n)) === 10n, 'reset: the baseline starts at the pre-transaction value');
  const mark = rst.snapshot();
  rst.createAccount(A);
  ok(rst.originalStorage(A, 1n).equals(Buffer.alloc(32)), 'createAccount takes the baseline to zero for a slot already read');
  ok(rst.originalStorage(A, 2n).equals(Buffer.alloc(32)), 'and for one read for the first time afterwards');
  rst.revertTo(mark);
  ok(num(rst.originalStorage(A, 1n)) === 10n, 'and reverting the creation puts the baseline back');
});

// ---- historical state ------------------------------------------------------
group('historical state', () => {
  const db = new MemoryDB();
  const sdb = new StateDB(db);
  loadAlloc(sdb, ALLOCS['SimpleTx (genesis)'].alloc);
  const rootA = sdb.root();

  loadAlloc(sdb, ALLOCS['suicideStorageCheck (post)'].alloc);
  sdb.setBalance(A, 12345n);
  ok(!sdb.root().equals(rootA), 'the live state moved on');

  const past = new StateDB(db, rootA);
  ok(past.rootHex() === rootA.toString('hex'), 'a state reopened at an old root reports that root');
  ok(!past.exists(A), 'and does not have what was written afterwards');
  const addr = '0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b';
  ok(past.getBalance(addr) === BigInt(ALLOCS['SimpleTx (genesis)'].alloc[addr].balance), 'and still has what it had');
  ok(past.getStorage('0x000f3df6d732807ef1319fb7b8bb8522d0beac02', 0x12e2n)[31] === 0x81,
    'including storage, resolved through the shared node store');
});

// ---- input handling --------------------------------------------------------
group('input handling', () => {
  const sdb = new StateDB();
  sdb.setBalance(A, 5n);
  ok(sdb.getBalance(Buffer.from(A.slice(2), 'hex')) === 5n, 'an address may be a Buffer or a 0x string');
  ok(sdb.getBalance(A.toUpperCase().replace('0X', '0x')) === 5n, 'and is case-insensitive');
  ok(throws(() => sdb.getBalance('0x1234')), 'a short address is rejected rather than padded');
  ok(throws(() => sdb.getBalance('0xzz11111111111111111111111111111111111111')), 'and a malformed one');
  ok(throws(() => sdb.setStorage(A, 0n, Buffer.alloc(33))), 'a value wider than 32 bytes is rejected');
  ok(throws(() => sdb.setBalance(A, -1n)), 'a negative balance is rejected');
  ok(throws(() => sdb.subBalance(A, 6n)), 'spending more than the balance is rejected');
  sdb.subBalance(A, 5n);
  ok(sdb.getBalance(A) === 0n, 'and spending exactly the balance is not');
  sdb.setStorage(A, '0x02', '0x0a');
  ok(sdb.getStorage(A, 2n)[31] === 10, 'slots and values may be given as hex strings');
});

// ---- account creation ------------------------------------------------------
group('account creation', () => {
  const sdb = new StateDB();
  sdb.setBalance(A, 64n); sdb.setNonce(A, 4n); sdb.setCode(A, '0x6001'); sdb.setStorage(A, 1n, 5n);
  sdb.createAccount(A);
  // Value may be sent to an address before a contract lands there, and it is
  // not the deployment's to destroy.
  ok(sdb.getBalance(A) === 64n, 'creating over an address keeps its balance');
  ok(sdb.getNonce(A) === 0n, 'and resets the nonce');
  ok(sdb.getCode(A).length === 0, 'and the code');
  ok(sdb.getStorage(A, 1n).equals(Buffer.alloc(32)), 'and the storage');
  ok(sdb.getAccount(A).storageRoot.equals(EMPTY_TRIE_ROOT), 'right down to the storage root');

  const mark = sdb.snapshot();
  sdb.createAccount(B);
  sdb.setBalance(B, 1n);
  const withB = sdb.rootHex();
  sdb.revertTo(mark);
  ok(sdb.rootHex() !== withB && !sdb.exists(B), 'a reverted creation leaves no account');

  sdb.setAccount(C, { nonce: 2n, balance: 3n, storageRoot: EMPTY_TRIE_ROOT, codeHash: EMPTY_CODE_HASH });
  ok(sdb.getNonce(C) === 2n && sdb.getBalance(C) === 3n, 'setAccount installs a record wholesale');
  const raw = sdb.getAccount(C);
  raw.balance = 999n;
  ok(sdb.getBalance(C) === 3n, 'and getAccount hands back a copy, not the live record');
});

// ---- the storage root, as CREATE reads it ----------------------------------
/* `getStorageRoot` exists for exactly one caller — the EIP-7610 arm of the CREATE
 * collision test — so its contract is that "occupied" is one comparison, with no
 * existence check in front of it. An absent account must therefore report the
 * EMPTY root and not null, or `hasStorage` throws on the commonest case there is. */
group('storage root', () => {
  const sdb = new StateDB();
  ok(sdb.getStorageRoot(A).equals(EMPTY_TRIE_ROOT), 'an absent account reports the empty storage root');
  ok(sdb.hasStorage(A) === false, 'and holds no storage');

  sdb.setBalance(A, 1n);
  ok(sdb.hasStorage(A) === false, 'a funded account with no slots still holds none');
  sdb.setNonce(A, 9n); sdb.setCode(A, '0x6001');
  ok(sdb.hasStorage(A) === false, '…nor does a nonce or code make storage appear');

  sdb.setStorage(A, 1n, 5n);
  ok(sdb.hasStorage(A) === true, 'one written slot makes it non-empty');
  ok(sdb.getStorageRoot(A).equals(sdb.getAccount(A).storageRoot), 'and the root is the account record’s');

  // Zero is absence, so clearing the last slot must take the root back to empty
  // — otherwise an account that once held storage would collide forever.
  sdb.setStorage(A, 1n, 0n);
  ok(sdb.hasStorage(A) === false, 'clearing the last slot empties the root again');

  // Journaled with everything else: a reverted write must un-occupy the address.
  sdb.setStorage(B, 3n, 7n);
  const mark = sdb.snapshot();
  sdb.setStorage(B, 4n, 8n);
  ok(sdb.hasStorage(B) === true, 'a second slot keeps it occupied');
  sdb.revertTo(mark);
  ok(sdb.hasStorage(B) === true && sdb.getStorage(B, 4n).equals(Buffer.alloc(32)),
    'and a revert restores the earlier root, not the empty one');

  const m2 = sdb.snapshot();
  sdb.setStorage(C, 1n, 1n);
  ok(sdb.hasStorage(C) === true, 'a fresh account gains storage');
  sdb.revertTo(m2);
  ok(sdb.hasStorage(C) === false, 'and loses it again on revert');
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
