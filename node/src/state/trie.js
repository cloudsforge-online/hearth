'use strict';
/* Merkle Patricia Trie — the structure the `stateRoot` is a hash of.
 *
 * This is not a Merkle tree with a radix trie bolted on; the two are welded
 * together in ways that are easy to reimplement *almost* correctly, and
 * "almost" here means a `stateRoot` that differs from every other client's on
 * some block nobody predicted. Three rules do all the damage:
 *
 *   1. Hex-prefix path encoding. A path of nibbles is stored with one flag
 *      nibble carrying `isLeaf` and the parity of the path, plus a zero padding
 *      nibble when the path is even-length. Mishandle the parity and the trie
 *      still works — every get returns what was put — and every root is wrong.
 *
 *   2. A node whose RLP encoding is under 32 bytes is EMBEDDED in its parent
 *      verbatim rather than replaced by its hash. Hashing it anyway costs
 *      nothing observable except the root, which is the whole point of the
 *      structure. This is the single most commonly missed rule.
 *
 *   3. Deletion collapses. Emptying one slot of a branch that had two children
 *      leaves a branch with one child, which is not a legal shape: it must fold
 *      into that child, and if the child is itself an extension the two paths
 *      merge. A trie that only ever inserts passes casual tests and fails the
 *      vectors the moment anything is removed.
 *
 * The "secure" variant (the default here, and what Ethereum uses for the state
 * and storage tries) hashes the key before insertion, so path depth is bounded
 * by 64 nibbles and an attacker cannot hand-craft a pathologically deep trie.
 * The transaction and receipt tries are NOT secure — they are keyed by
 * `rlp(index)` — hence the flag.
 *
 * Nodes live in a pluggable store keyed by their own hash. Content addressing
 * means the store is append-only: writing never invalidates an old root, so
 * opening the trie at a historical root is free and needs no copy-on-write.
 */

const { keccak256 } = require('../crypto/keccak');
const RLP = require('../crypto/rlp');

const EMPTY = Buffer.alloc(0);

/** keccak256(rlp('')) — the root of a trie holding nothing. */
const EMPTY_TRIE_ROOT = keccak256(RLP.encode(EMPTY));

// ---- hex-prefix encoding ---------------------------------------------------

/** A byte string as its nibbles, high nibble first. */
function toNibbles(buf) {
  const n = new Array(buf.length * 2);
  for (let i = 0; i < buf.length; i++) { n[2 * i] = buf[i] >> 4; n[2 * i + 1] = buf[i] & 0x0f; }
  return n;
}

/**
 * Pack nibbles into bytes behind a flag nibble: bit 1 is `isLeaf`, bit 0 is
 * "the path has an odd number of nibbles". An odd path packs its first nibble
 * alongside the flag; an even one is preceded by a zero padding nibble, so the
 * result is always whole bytes and the parity is always recoverable.
 */
function hpEncode(nibbles, isLeaf) {
  const odd = nibbles.length & 1;
  const out = Buffer.alloc(((nibbles.length - odd) >> 1) + 1);
  out[0] = ((isLeaf ? 2 : 0) | odd) << 4;
  if (odd) out[0] |= nibbles[0];
  for (let i = odd, j = 1; i < nibbles.length; i += 2, j++) out[j] = (nibbles[i] << 4) | nibbles[i + 1];
  return out;
}

function hpDecode(buf) {
  if (buf.length === 0) throw new Error('trie: empty hex-prefix path');
  const flag = buf[0] >> 4;
  if (flag > 3) throw new Error('trie: invalid hex-prefix flag nibble');
  // An even path must pad with zero; a non-zero pad is a second encoding of
  // the same path, and two encodings mean two roots.
  if (!(flag & 1) && (buf[0] & 0x0f) !== 0) throw new Error('trie: non-zero padding nibble');
  return { nibbles: toNibbles(buf).slice(flag & 1 ? 1 : 2), isLeaf: (flag & 2) !== 0 };
}

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// ---- node store ------------------------------------------------------------

/**
 * The narrowest interface a backing store can have: get and put, keyed by a
 * 32-byte hash. Deliberately not a general kv API — a disk backend replaces
 * this class and nothing else changes. Sync for now; a disk store will want an
 * async twin, which is why nothing else in this file touches `this.db`.
 */
class MemoryDB {
  constructor() { this.map = new Map(); }
  get(key) { return this.map.get(key.toString('hex')); }
  put(key, value) { this.map.set(key.toString('hex'), value); }
  has(key) { return this.map.has(key.toString('hex')); }
  get size() { return this.map.size; }
}

// ---- the trie --------------------------------------------------------------

/* A node in memory is its RLP-decoded form:
 *   leaf       [hpEncode(path, true),  value ]
 *   extension  [hpEncode(path, false), childRef]
 *   branch     [ref0 … ref15, value]                (17 entries)
 * A childRef is an empty buffer (absent), a 32-byte hash, or — rule 2 — the
 * child node itself, inline. `null` is the empty trie. */

function isAbsent(ref) { return !Array.isArray(ref) && ref.length === 0; }
function leaf(path, value) { return [hpEncode(path, true), value]; }
function extension(path, childRef) { return [hpEncode(path, false), childRef]; }
function branch() { const b = new Array(17); b.fill(EMPTY); return b; }

class Trie {
  /**
   * @param db    node store; defaults to a fresh in-memory one
   * @param root  32-byte root hash to open at; defaults to the empty trie
   * @param opts  `{ secure }` — secure hashes keys before insertion (default true)
   */
  constructor(db = new MemoryDB(), root = EMPTY_TRIE_ROOT, { secure = true } = {}) {
    this.db = db;
    this.secure = secure;
    this.setRoot(root);
  }

  /** Re-open this trie at another root, sharing the store. */
  setRoot(root) {
    const h = Buffer.isBuffer(root) ? root : Buffer.from(String(root).replace(/^0x/i, ''), 'hex');
    if (h.length !== 32) throw new TypeError('trie: root must be 32 bytes');
    this._rootHash = h;
    this._node = undefined;                     // loaded on demand
  }

  /** A view of the same store at `root`, so historical state can be read. */
  at(root) { return new Trie(this.db, root, { secure: this.secure }); }

  /** The trie key for a caller key — hashed in the secure variant. */
  _path(key) {
    const k = Buffer.isBuffer(key) ? key
      : typeof key === 'string' && /^0x/i.test(key) ? Buffer.from(key.slice(2), 'hex')
        : Buffer.from(String(key), 'utf8');
    return toNibbles(this.secure ? keccak256(k) : k);
  }

  _root() {
    if (this._node === undefined) {
      this._node = this._rootHash.equals(EMPTY_TRIE_ROOT) ? null : this._deref(this._rootHash);
    }
    return this._node;
  }

  /** Resolve a child reference to a node, following a hash into the store. */
  _deref(ref) {
    if (Array.isArray(ref)) return ref;          // embedded, already here
    if (ref.length === 0) return null;
    const enc = this.db.get(ref);
    if (!enc) throw new Error('trie: missing node ' + ref.toString('hex'));
    return RLP.decode(enc);
  }

  /** Rule 2: under 32 bytes the node goes into its parent; otherwise its hash. */
  _ref(node) {
    if (node === null) return EMPTY;
    const enc = RLP.encode(node);
    if (enc.length < 32) return node;
    const h = keccak256(enc);
    this.db.put(h, enc);
    return h;
  }

  // -- reads -----------------------------------------------------------------

  /** The stored value, or null. */
  get(key) {
    let node = this._root(), path = this._path(key), i = 0;
    for (;;) {
      if (node === null) return null;
      if (node.length === 17) {
        if (i === path.length) return node[16].length ? node[16] : null;
        node = this._deref(node[path[i]]);
        i++;
        continue;
      }
      const { nibbles, isLeaf } = hpDecode(node[0]);
      const rest = path.length - i;
      if (nibbles.length > rest) return null;
      for (let j = 0; j < nibbles.length; j++) if (nibbles[j] !== path[i + j]) return null;
      i += nibbles.length;
      if (isLeaf) return i === path.length ? node[1] : null;
      node = this._deref(node[1]);
    }
  }

  /**
   * The 32-byte root hash. The root is always hashed, even when the root node
   * is small enough that rule 2 would embed it anywhere else. Answered without
   * touching the store when nothing has changed, so opening a trie at a root
   * and asking for that root costs nothing.
   */
  root() {
    if (this._rootHash) return this._rootHash;
    const node = this._root();
    if (node === null) return EMPTY_TRIE_ROOT;
    const enc = RLP.encode(node);
    const h = keccak256(enc);
    this.db.put(h, enc);
    this._rootHash = h;
    return h;
  }

  rootHex() { return this.root().toString('hex'); }

  // -- writes ----------------------------------------------------------------

  /** Store `value` at `key`. An empty value is a delete, not a store of "". */
  put(key, value) {
    const v = Buffer.isBuffer(value) ? value : RLP.toBytes(value);
    if (v.length === 0) return this.del(key);
    this._node = this._put(this._root(), this._path(key), 0, v);
    this._rootHash = null;
  }

  del(key) {
    this._node = this._del(this._root(), this._path(key), 0);
    this._rootHash = null;
  }

  _put(node, path, i, value) {
    if (node === null) return leaf(path.slice(i), value);

    if (node.length === 17) {
      if (i === path.length) { node[16] = value; return node; }
      const k = path[i];
      node[k] = this._ref(this._put(this._deref(node[k]), path, i + 1, value));
      return node;
    }

    const { nibbles, isLeaf } = hpDecode(node[0]);
    const rest = path.slice(i);
    const cpl = commonPrefix(nibbles, rest);

    if (isLeaf && cpl === nibbles.length && cpl === rest.length) { node[1] = value; return node; }
    if (!isLeaf && cpl === nibbles.length) {
      node[1] = this._ref(this._put(this._deref(node[1]), path, i + cpl, value));
      return node;
    }

    // The paths diverge at `cpl`, so a branch is needed there. Both the node
    // that was here and the value being inserted hang off it, each having
    // consumed one more nibble as the branch slot they occupy.
    const b = branch();
    const tailK = nibbles.slice(cpl);
    if (tailK.length === 0) {
      b[16] = node[1];                                  // an exhausted leaf's value
    } else if (isLeaf) {
      b[tailK[0]] = this._ref(leaf(tailK.slice(1), node[1]));
    } else {
      const sub = tailK.slice(1);
      // A one-nibble extension has nothing left to say; its child moves up.
      b[tailK[0]] = sub.length ? this._ref(extension(sub, node[1])) : node[1];
    }

    const tailV = rest.slice(cpl);
    if (tailV.length === 0) b[16] = value;
    else b[tailV[0]] = this._ref(leaf(tailV.slice(1), value));

    return cpl === 0 ? b : extension(rest.slice(0, cpl), this._ref(b));
  }

  _del(node, path, i) {
    if (node === null) return null;

    if (node.length === 17) {
      if (i === path.length) {
        if (node[16].length === 0) return node;         // absent
        node[16] = EMPTY;
      } else {
        const k = path[i];
        const child = this._deref(node[k]);
        if (child === null) return node;                // absent
        const next = this._del(child, path, i + 1);
        node[k] = next === null ? EMPTY : this._ref(next);
      }
      return this._collapseBranch(node);
    }

    const { nibbles, isLeaf } = hpDecode(node[0]);
    const rest = path.slice(i);
    if (commonPrefix(nibbles, rest) !== nibbles.length) return node;   // absent

    if (isLeaf) return nibbles.length === rest.length ? null : node;

    const next = this._del(this._deref(node[1]), path, i + nibbles.length);
    if (next === null) return null;                     // nothing below: this node goes too
    return this._join(nibbles, next);
  }

  /** Rule 3a: a branch left with one child and no value folds into that child. */
  _collapseBranch(b) {
    let only = -1, n = 0;
    for (let k = 0; k < 16; k++) if (!isAbsent(b[k])) { only = k; n++; }
    const hasValue = b[16].length > 0;
    if (n === 0) return hasValue ? leaf([], b[16]) : null;
    if (n > 1 || hasValue) return b;
    // The surviving slot's nibble is prepended to whatever the child says next.
    const child = this._deref(b[only]);
    if (child.length === 17) return extension([only], b[only]);
    const d = hpDecode(child[0]);
    return [hpEncode([only, ...d.nibbles], d.isLeaf), child[1]];
  }

  /** Rule 3b: an extension whose child is not a branch merges into it. */
  _join(nibbles, child) {
    if (child.length === 17) return extension(nibbles, this._ref(child));
    const d = hpDecode(child[0]);
    return [hpEncode(nibbles.concat(d.nibbles), d.isLeaf), child[1]];
  }
}

module.exports = {
  Trie, MemoryDB, EMPTY_TRIE_ROOT,
  // Exported so the conformance suite can pin the encoding rules directly
  // rather than only through the roots they produce.
  hpEncode, hpDecode, toNibbles,
};
