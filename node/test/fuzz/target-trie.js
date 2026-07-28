'use strict';
/* Fuzz target: src/state/trie.js
 *
 * The trie's contract is not "gets return what puts stored" — a plain hash map
 * does that. The contract is that the ROOT is a function of the key/value set
 * and of nothing else: not of insertion order, not of how many deletes it took
 * to get there, not of whether a node happened to be embedded or hashed.
 *
 *   P1  ORDER INDEPENDENCE. The same key/value set inserted in any order gives
 *       one root. This is the property that catches every hex-prefix parity
 *       bug and every missed branch collapse, because a wrong-but-consistent
 *       encoding survives it and an order-dependent structure does not.
 *
 *   P2  DELETION IS AN INVERSE. Building {A ∪ B} and deleting B must give the
 *       same root as building A alone — for every subset B. Rule 3 (a branch
 *       left with one child folds into it, and a merged extension absorbs its
 *       child's path) is what this tests, and it is the rule the file's own
 *       header calls the one an insert-only implementation gets away with.
 *
 *   P3  EMPTY IS EMPTY. Delete everything and the root is EMPTY_TRIE_ROOT,
 *       exactly, not "some root with no reachable keys".
 *
 *   P4  READ BACK. get(k) equals what was put, for every key, including after
 *       an unrelated key was deleted.
 *
 *   P5  THE ROOT IS SUFFICIENT. Re-opening the store at the root and reading
 *       every key must work. This is the embed rule (rule 2) under test from
 *       the other side: any node of 32 bytes or more must actually have been
 *       written to the store, or a fresh reader hits `missing node`.
 *
 * The generators lean on the two places the file says the bugs live: keys that
 * share long prefixes, and values whose RLP straddles the 32-byte boundary
 * between "embedded in the parent" and "replaced by its hash".
 */

const { Trie, MemoryDB, EMPTY_TRIE_ROOT, hpEncode, hpDecode, toNibbles } = require('../../src/state/trie');
const { trieKeys, trieValue } = require('./random');
const { hex, unhex } = require('./harness');

const name = 'trie';

/** Build a trie from `pairs` in the given order and return its root. */
function build(pairs, order, secure) {
  const tr = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure });
  for (const i of order) tr.put(pairs[i][0], pairs[i][1]);
  return tr;
}

const rootOf = (tr) => tr.root().toString('hex');

function oneCase(t, rng, i) {
  const secure = rng.chance(0.5);
  const n = rng.weighted([[10, -1], [4, 1], [4, 2], [3, 3], [2, 17], [2, 16]]);
  const count = n === -1 ? rng.between(1, 24) : n;
  const keys = trieKeys(rng, count);
  if (keys.length === 0) return;
  const pairs = keys.map((k) => [k, trieValue(rng)]);
  const idx = pairs.map((_, j) => j);

  // -- P1: insertion order must not reach the root ---------------------------
  const a = build(pairs, idx, secure);
  const rootA = rootOf(a);
  const orders = rng.between(1, 3);
  for (let o = 0; o < orders; o++) {
    const shuffled = rng.shuffle(idx.slice());
    const b = build(pairs, shuffled, secure);
    t.ok(rootOf(b) === rootA, `root is independent of insertion order (${pairs.length} keys, secure=${secure})`,
      { secure, pairs, order: shuffled, rootA, rootB: rootOf(b) });
  }

  // -- P4: everything put comes back -----------------------------------------
  for (const [k, v] of pairs) {
    const got = a.get(k);
    if (!t.ok(got !== null && Buffer.from(got).equals(v), `get after put returns the stored value (secure=${secure})`,
      { secure, pairs, key: k })) break;
  }
  // and a key that was never inserted is absent
  const missing = Buffer.concat([rng.bytes(8), Buffer.from('never-inserted')]);
  t.ok(a.get(missing) === null, 'a key that was never inserted reads back null', { secure, pairs });

  // -- P5: the root is a sufficient handle on the store ----------------------
  const reopened = new Trie(a.db, a.root(), { secure });
  let reopenOk = true;
  for (const [k, v] of pairs) {
    let got = null, threw = null;
    try { got = reopened.get(k); } catch (e) { threw = e; }
    if (threw || got === null || !Buffer.from(got).equals(v)) {
      reopenOk = t.ok(false, `re-opening the store at the root reads every key back (${threw ? threw.message : 'value differs'})`,
        { secure, pairs, key: k });
      break;
    }
  }
  if (reopenOk) t.ok(true, 're-opening the store at the root reads every key back');

  // -- P2: deleting a subset equals never inserting it ------------------------
  const keep = [], drop = [];
  for (const j of idx) (rng.chance(0.5) ? keep : drop).push(j);
  if (drop.length) {
    const withAll = build(pairs, rng.shuffle(idx.slice()), secure);
    for (const j of rng.shuffle(drop.slice())) withAll.del(pairs[j][0]);
    const onlyKeep = build(pairs, keep, secure);
    t.ok(rootOf(withAll) === rootOf(onlyKeep),
      `deleting a subset gives the root of never having inserted it (${drop.length} of ${pairs.length} deleted, secure=${secure})`,
      { secure, pairs, keep, drop, afterDelete: rootOf(withAll), fresh: rootOf(onlyKeep) });
    for (const j of keep) {
      const got = withAll.get(pairs[j][0]);
      if (!t.ok(got !== null && Buffer.from(got).equals(pairs[j][1]), 'surviving keys are still readable after deletes',
        { secure, pairs, keep, drop, key: pairs[j][0] })) break;
    }
    for (const j of drop) {
      if (!t.ok(withAll.get(pairs[j][0]) === null, 'deleted keys read back null',
        { secure, pairs, keep, drop, key: pairs[j][0] })) break;
    }
  }

  // -- P3: delete everything -------------------------------------------------
  const all = build(pairs, rng.shuffle(idx.slice()), secure);
  for (const j of rng.shuffle(idx.slice())) all.del(pairs[j][0]);
  t.ok(all.root().equals(EMPTY_TRIE_ROOT), 'deleting every key returns the trie to the empty root',
    { secure, pairs, got: rootOf(all) });

  // -- overwrite: the last write wins, and the root matches a fresh build -----
  if (rng.chance(0.4)) {
    const over = build(pairs, idx, secure);
    const j = rng.int(pairs.length);
    const nv = trieValue(rng);
    over.put(pairs[j][0], nv);
    const want = pairs.map((p, k) => (k === j ? [p[0], nv] : p));
    const fresh = build(want, want.map((_, k) => k), secure);
    t.ok(rootOf(over) === rootOf(fresh), 'overwriting a key gives the root of having stored the new value all along',
      { secure, pairs, index: j, newValue: nv });
  }

  // -- an empty value is a delete, per the documented contract ---------------
  if (rng.chance(0.3)) {
    const viaEmpty = build(pairs, idx, secure);
    const j = rng.int(pairs.length);
    viaEmpty.put(pairs[j][0], Buffer.alloc(0));
    const viaDel = build(pairs, idx, secure);
    viaDel.del(pairs[j][0]);
    t.ok(rootOf(viaEmpty) === rootOf(viaDel), 'put(k, "") is exactly del(k)', { secure, pairs, index: j });
  }

  // -- deleting an absent key changes nothing --------------------------------
  if (rng.chance(0.3)) {
    const untouched = build(pairs, idx, secure);
    const before = rootOf(untouched);
    untouched.del(Buffer.concat([rng.bytes(6), Buffer.from('absent')]));
    t.ok(rootOf(untouched) === before, 'deleting a key that is not there leaves the root alone', { secure, pairs });
  }
}

/** Hex-prefix encoding, which the trie's header calls damage rule 1. */
function hexPrefixCase(t, rng) {
  const len = rng.between(0, 70);
  const nibbles = Array.from({ length: len }, () => rng.int(16));
  for (const isLeaf of [true, false]) {
    const enc = hpEncode(nibbles, isLeaf);
    const dec = hpDecode(enc);
    t.ok(dec.isLeaf === isLeaf && dec.nibbles.length === nibbles.length && dec.nibbles.every((x, k) => x === nibbles[k]),
      `hpDecode(hpEncode(p, ${isLeaf})) returns p (${len} nibbles)`, { nibbles, isLeaf, encoded: enc });
    // Two encodings of one path would be two roots: the padding nibble must be
    // zero on an even path and a non-zero pad must be refused.
    if ((nibbles.length & 1) === 0 && enc.length > 0) {
      const bad = Buffer.from(enc);
      bad[0] |= rng.between(1, 15);
      const r = t.throws(() => hpDecode(bad));
      t.ok(r.threw, 'a non-zero padding nibble is refused — it would be a second encoding of one path', { encoded: bad });
    }
  }
  // toNibbles must be the exact inverse of packing bytes.
  const b = rng.bytes(rng.length(20));
  const nib = toNibbles(b);
  t.ok(nib.length === b.length * 2 && nib.every((x, k) => x === (k & 1 ? b[k >> 1] & 15 : b[k >> 1] >> 4)),
    'toNibbles splits high nibble first', { bytes: b });
  // An invalid flag nibble is not a path.
  const junk = Buffer.concat([Buffer.from([rng.between(4, 15) << 4]), rng.bytes(rng.length(4))]);
  t.ok(t.throws(() => hpDecode(junk)).threw, 'a flag nibble above 3 is refused', { encoded: junk });
}

function run(t, rng, { cases, deadline }) {
  t.group('trie — order independence, deletion as an inverse, the empty root');
  t.context(name, -1);
  t.ok(new Trie(new MemoryDB()).root().equals(EMPTY_TRIE_ROOT), 'a fresh trie is the empty root');

  let i = 0;
  for (; i < cases; i++) {
    if ((i & 7) === 0 && Date.now() > deadline) break;
    t.context(name, i);
    if (rng.chance(0.15)) hexPrefixCase(t, rng);
    else oneCase(t, rng, i);
  }
  return i;
}

function replay(t, entry) {
  t.context(name, entry.case === undefined ? -1 : entry.case);
  const label = `corpus ${entry._file}`;
  const pairs = (entry.pairs || []).map(([k, v]) => [Buffer.isBuffer(k) ? k : unhex(k), Buffer.isBuffer(v) ? v : unhex(v)]);
  if (!pairs.length) { t.ok(false, `${label}: no pairs to replay`); return; }
  const secure = entry.secure !== false;
  const idx = pairs.map((_, j) => j);
  const base = rootOf(build(pairs, idx, secure));
  const orders = entry.orders || [idx.slice().reverse()];
  for (const order of orders) {
    t.ok(rootOf(build(pairs, order, secure)) === base, `${label}: ${entry.note || 'root is order-independent'}`);
  }
  const all = build(pairs, idx, secure);
  for (const j of idx.slice().reverse()) all.del(pairs[j][0]);
  t.ok(all.root().equals(EMPTY_TRIE_ROOT), `${label}: deleting everything returns the empty root`);
  // `root()` is what writes the root node into the store, so it must be called
  // on the trie whose db is being re-opened — not merely on some earlier twin.
  const source = build(pairs, idx, secure);
  const reopened = new Trie(source.db, source.root(), { secure });
  for (const [k, v] of pairs) {
    const got = reopened.get(k);
    if (!t.ok(got !== null && Buffer.from(got).equals(v), `${label}: re-opened at the root, ${hex(k)} reads back`)) break;
  }
}

module.exports = { name, run, replay };
