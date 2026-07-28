'use strict';
/* The world state: accounts, their storage, their code — and the ability to
 * undo any of it.
 *
 * The data model is two layers of the same trie. A secure trie keyed by address
 * holds `rlp([nonce, balance, storageRoot, codeHash])`; `storageRoot` names a
 * second secure trie, keyed by slot, holding that contract's storage. Both are
 * content-addressed into one shared node store, so a state root is a complete,
 * immutable description of the chain at a height and nothing has to be copied
 * to keep an old one readable.
 *
 * Two encoding rules here are consensus, not housekeeping:
 *
 *   - A storage value is stored as `rlp(value_with_leading_zeros_stripped)`, so
 *     the number 1 is one byte and not thirty-two. Store the padded word and
 *     every root is wrong.
 *   - Writing zero DELETES the slot. It does not store thirty-two zero bytes,
 *     because a trie holding "slot 5 is zero" and a trie holding nothing about
 *     slot 5 must be the same trie.
 *
 * **Journaling is the part the EVM actually leans on.** `REVERT`, a failed
 * `CALL` and out-of-gas all have to put the world back exactly as it was, while
 * the gas those attempts burned stays burned and — for the outermost frame —
 * the sender's nonce increment survives. That asymmetry is why this cannot be
 * "keep a copy and swap it back": the caller decides, per field, what survives.
 *
 * So every mutation appends a closure that undoes it, `snapshot()` hands back
 * the journal's length as a marker, and `revertTo(marker)` runs everything
 * after it backwards. Markers are integers into a flat array, so nesting is
 * free and the 1024-deep call stack the EVM allows costs nothing to support.
 *
 * The EIP-2929 warm/cold sets are journaled with everything else, and that is
 * not a detail: an address warmed inside a call frame that then reverts must go
 * cold again, or a later access is charged 100 gas where every other client
 * charges 2600, and the block does not validate.
 */

const { keccak256 } = require('../crypto/keccak');
const RLP = require('../crypto/rlp');
const { Trie, MemoryDB, EMPTY_TRIE_ROOT } = require('./trie');

/** keccak256('') — the codeHash of every account that is not a contract. */
const EMPTY_CODE_HASH = keccak256(Buffer.alloc(0));
const ZERO_WORD = Buffer.alloc(32);

/**
 * EIP-2929 pre-warms "the precompiles" at the start of every transaction, which
 * means whichever set the chain actually activates — so this is a default, not
 * a constant. Ethereum's Shanghai set is 0x01–0x09 and the conformance vectors
 * assume it; Hearth v1 ships only 0x01–0x05 (spec §9). Until that is settled,
 * callers should pass their own set to `prepareAccessList`, because warming an
 * address that is not a precompile here is a 2500-gas difference per access.
 */
const PRECOMPILES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => {
  const b = Buffer.alloc(20); b[19] = n; return b;
}));

// ---- coercions -------------------------------------------------------------

function hexToBuf(s, what) {
  const h = s.replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new TypeError('statedb: malformed hex ' + what);
  return Buffer.from(h, 'hex');
}

/** A 20-byte address from a Buffer or `0x…` string. */
function toAddress(a) {
  const b = Buffer.isBuffer(a) ? a : typeof a === 'string' ? hexToBuf(a, 'address') : null;
  if (!b || b.length !== 20) throw new TypeError('statedb: address must be 20 bytes');
  return b;
}

/** A 256-bit word as a right-aligned 32-byte Buffer. */
function toWord(v) {
  if (typeof v === 'number' || typeof v === 'bigint') {
    let n = BigInt(v);
    if (n < 0n) throw new TypeError('statedb: words are unsigned');
    const b = Buffer.alloc(32);
    for (let i = 31; i >= 0 && n > 0n; i--) { b[i] = Number(n & 0xffn); n >>= 8n; }
    if (n > 0n) throw new TypeError('statedb: word overflows 256 bits');
    return b;
  }
  const b = Buffer.isBuffer(v) ? v : typeof v === 'string' ? hexToBuf(v, 'word') : null;
  if (!b || b.length > 32) throw new TypeError('statedb: word must be at most 32 bytes');
  return b.length === 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]);
}

function stripZeros(b) {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
}

function toBigInt(b) { return b.length === 0 ? 0n : BigInt('0x' + b.toString('hex')); }

function bigToBytes(n) {
  if (n < 0n) throw new TypeError('statedb: negative scalar');
  return RLP.intToBytes(n);
}

// ---- account records -------------------------------------------------------

function emptyAccount() {
  return { nonce: 0n, balance: 0n, storageRoot: EMPTY_TRIE_ROOT, codeHash: EMPTY_CODE_HASH };
}

function encodeAccount(a) {
  return RLP.encode([bigToBytes(a.nonce), bigToBytes(a.balance), a.storageRoot, a.codeHash]);
}

/**
 * RLP is untyped, so it cannot know `nonce` is a scalar and must therefore be
 * minimal-length. Two encodings of one account hash differently, so the rule
 * has to live here (spec §5) — empty is the canonical zero, `0x00` is not.
 */
function decodeAccount(enc) {
  const a = RLP.decode(enc);
  if (!Array.isArray(a) || a.length !== 4) throw new Error('statedb: account is not a 4-item list');
  const [n, b, sr, ch] = a;
  if (!Buffer.isBuffer(n) || !Buffer.isBuffer(b)) throw new Error('statedb: account scalar is a list');
  if (n.length && n[0] === 0) throw new Error('statedb: non-canonical nonce (leading zero)');
  if (b.length && b[0] === 0) throw new Error('statedb: non-canonical balance (leading zero)');
  if (n.length > 32 || b.length > 32) throw new Error('statedb: account scalar too wide');
  if (!Buffer.isBuffer(sr) || sr.length !== 32) throw new Error('statedb: storageRoot must be 32 bytes');
  if (!Buffer.isBuffer(ch) || ch.length !== 32) throw new Error('statedb: codeHash must be 32 bytes');
  return { nonce: toBigInt(n), balance: toBigInt(b), storageRoot: sr, codeHash: ch };
}

// ---- the state -------------------------------------------------------------

class StateDB {
  constructor(db = new MemoryDB(), root = EMPTY_TRIE_ROOT) {
    this.db = db;
    this._trie = new Trie(db, root);          // secure: keyed by keccak(address)
    this._acct = new Map();                   // addrHex -> account | null (absent)
    this._storage = new Map();                // addrHex -> Trie
    this._code = new Map();                   // codeHashHex -> Buffer
    this._journal = [];
    this._destroyed = new Set();
    this._touched = new Set();
    // Accounts reset by createAccount within this transaction. Separate from
    // _destroyed because a reset is not a self-destruct: the account stays,
    // its storage does not. originalStorage has to know — see the note there.
    this._reset = new Set();
    this._warmAddr = new Set();
    this._warmSlot = new Set();
    this._refund = 0n;
    this._txRoot = this._trie.root();         // root as of the start of this tx
    this._committed = new Map();              // memo for originalStorage
  }

  root() { return this._trie.root(); }
  rootHex() { return this._trie.rootHex(); }

  // -- accounts --------------------------------------------------------------

  _load(hex) {
    if (this._acct.has(hex)) return this._acct.get(hex);
    const enc = this._trie.get(Buffer.from(hex, 'hex'));
    const a = enc === null ? null : decodeAccount(enc);
    this._acct.set(hex, a);
    return a;
  }

  /** Write straight through to the trie; the journal, not a cache, is the undo. */
  _write(hex, acct) {
    this._acct.set(hex, acct);
    const addr = Buffer.from(hex, 'hex');
    if (acct === null) this._trie.del(addr);
    else this._trie.put(addr, encodeAccount(acct));
  }

  /**
   * Snapshot an account into the journal and hand back a mutable copy of it.
   * Every field lives in this one record — including `storageRoot` — so one
   * entry undoes a balance change, a nonce bump and a storage write alike.
   */
  _mutable(hex, create) {
    const prev = this._load(hex);
    const snap = prev === null ? null : { ...prev };
    this._journal.push(() => this._write(hex, snap));
    return prev === null ? (create ? emptyAccount() : null) : { ...prev };
  }

  /**
   * The storage trie for an account, reconciled to whatever `storageRoot` the
   * account record currently claims. Reconciling on read rather than tracking
   * it on write is what makes revert correct for free: restoring the account
   * record restores the storage with it, because the node store is append-only
   * and an old root is always still resolvable.
   */
  _storageTrie(hex) {
    const a = this._load(hex);
    const want = a ? a.storageRoot : EMPTY_TRIE_ROOT;
    let t = this._storage.get(hex);
    if (!t) { t = new Trie(this.db, want); this._storage.set(hex, t); }
    else if (!t.root().equals(want)) t.setRoot(want);
    return t;
  }

  getAccount(addr) {
    const a = this._load(toAddress(addr).toString('hex'));
    return a === null ? null : { ...a };
  }

  /** Install an account wholesale — genesis allocation, and test fixtures. */
  setAccount(addr, acct) {
    const hex = toAddress(addr).toString('hex');
    this._mutable(hex, false);
    this._write(hex, acct === null ? null : {
      nonce: BigInt(acct.nonce || 0),
      balance: BigInt(acct.balance || 0),
      storageRoot: acct.storageRoot || EMPTY_TRIE_ROOT,
      codeHash: acct.codeHash || EMPTY_CODE_HASH,
    });
  }

  /** Is there a trie entry at all. NOT the same question as `empty`. */
  exists(addr) { return this._load(toAddress(addr).toString('hex')) !== null; }

  /**
   * EIP-161 emptiness: nonce 0, balance 0, no code. An absent account is empty,
   * but so is a *present* one with all three at their zero values — and the two
   * are not interchangeable. The CALL family charges 25,000 for value transfer
   * to an **empty** target, not to a non-existent one, and `SELFDESTRUCT` makes
   * the same distinction for its beneficiary. Defining this as `!exists()` is a
   * gas divergence, which is to say a chain split.
   */
  empty(addr) {
    const a = this._load(toAddress(addr).toString('hex'));
    return a === null || (a.nonce === 0n && a.balance === 0n && a.codeHash.equals(EMPTY_CODE_HASH));
  }

  isEmpty(addr) { return this.empty(addr); }

  /**
   * Reset an address to a fresh contract account. The balance survives, because
   * anyone may send to an address before it holds a contract and that value is
   * not theirs to destroy; nonce, code and storage do not.
   */
  createAccount(addr) {
    const hex = toAddress(addr).toString('hex');
    const prev = this._load(hex);
    this._mutable(hex, false);
    this._write(hex, { ...emptyAccount(), balance: prev === null ? 0n : prev.balance });
    // The storage is gone as of now, so originalStorage must stop answering
    // from the pre-transaction root. Journaled, so a revert un-resets it.
    if (!this._reset.has(hex)) {
      this._reset.add(hex);
      this._journal.push(() => this._reset.delete(hex));
    }
  }

  /**
   * The account's storage root. An absent account reports the empty root, so
   * "has no storage" is one comparison and never needs an existence test first.
   *
   * This is consensus, not introspection: CREATE treats a non-empty storage
   * root as an address collision (EIP-7610), so an address carrying storage but
   * no code and nonce 0 is occupied, not reusable. See the note in
   * `interpreter.create`.
   */
  getStorageRoot(addr) {
    const a = this._load(toAddress(addr).toString('hex'));
    return a === null ? EMPTY_TRIE_ROOT : a.storageRoot;
  }

  /** Does this address hold any storage at all — the EIP-7610 collision test. */
  hasStorage(addr) { return !this.getStorageRoot(addr).equals(EMPTY_TRIE_ROOT); }

  getNonce(addr) { const a = this._load(toAddress(addr).toString('hex')); return a === null ? 0n : a.nonce; }
  getBalance(addr) { const a = this._load(toAddress(addr).toString('hex')); return a === null ? 0n : a.balance; }

  setNonce(addr, n) {
    const hex = toAddress(addr).toString('hex');
    const a = this._mutable(hex, true);
    a.nonce = BigInt(n);
    this._write(hex, a);
  }

  incrementNonce(addr) { this.setNonce(addr, this.getNonce(addr) + 1n); }

  setBalance(addr, v) {
    const hex = toAddress(addr).toString('hex');
    const a = this._mutable(hex, true);
    a.balance = BigInt(v);
    if (a.balance < 0n) throw new RangeError('statedb: negative balance');
    this._write(hex, a);
  }

  /**
   * Adding zero is not a no-op: it brings the account into existence and marks
   * it touched, so EIP-161 sweeps it away again at the end of the transaction
   * if it is still empty. Skipping that leaves an empty account in the trie
   * that no other client has.
   */
  addBalance(addr, v) {
    const d = BigInt(v);
    if (d === 0n) { if (this.empty(addr)) { this.setBalance(addr, 0n); this.touch(addr); } return; }
    this.setBalance(addr, this.getBalance(addr) + d);
  }

  subBalance(addr, v) {
    const d = BigInt(v);
    if (d === 0n) { if (this.empty(addr)) { this.setBalance(addr, 0n); this.touch(addr); } return; }
    if (this.getBalance(addr) < d) throw new RangeError('statedb: insufficient balance');
    this.setBalance(addr, this.getBalance(addr) - d);
  }

  // -- code ------------------------------------------------------------------

  getCodeHash(addr) {
    const a = this._load(toAddress(addr).toString('hex'));
    return a === null ? EMPTY_CODE_HASH : a.codeHash;
  }

  getCode(addr) {
    const h = this.getCodeHash(addr);
    if (h.equals(EMPTY_CODE_HASH)) return Buffer.alloc(0);
    const hx = h.toString('hex');
    const cached = this._code.get(hx);
    if (cached) return cached;
    const code = this.db.get(h);
    if (!code) throw new Error('statedb: missing code ' + hx);
    this._code.set(hx, code);
    return code;
  }

  getCodeSize(addr) { return this.getCode(addr).length; }

  setCode(addr, code) {
    const c = Buffer.isBuffer(code) ? code : hexToBuf(String(code), 'code');
    const hex = toAddress(addr).toString('hex');
    const a = this._mutable(hex, true);
    const h = keccak256(c);
    // Code is content-addressed like a trie node, so it is never rewritten and
    // never needs journaling — only the account's pointer to it does.
    if (c.length) { this.db.put(h, c); this._code.set(h.toString('hex'), c); }
    a.codeHash = h;
    this._write(hex, a);
  }

  // -- storage ---------------------------------------------------------------

  getStorage(addr, slot) {
    const hex = toAddress(addr).toString('hex');
    return this._readSlot(this._storageTrie(hex), slot);
  }

  _readSlot(trie, slot) {
    const enc = trie.get(toWord(slot));
    if (enc === null) return ZERO_WORD;
    const raw = RLP.decode(enc);
    if (!Buffer.isBuffer(raw)) throw new Error('statedb: storage value is a list');
    if (raw.length === 0 || raw.length > 32 || raw[0] === 0) throw new Error('statedb: non-canonical storage value');
    return Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
  }

  setStorage(addr, slot, value) {
    const hex = toAddress(addr).toString('hex');
    const v = stripZeros(toWord(value));
    const st = this._storageTrie(hex);
    const a = this._mutable(hex, true);
    // Zero is absence. Storing 32 zero bytes would give one state two roots.
    if (v.length === 0) st.del(toWord(slot));
    else st.put(toWord(slot), RLP.encode(v));
    a.storageRoot = st.root();
    this._write(hex, a);
  }

  /**
   * The slot's value as of the start of this transaction — what EIP-2200 and
   * EIP-3529 call the "original" value and price SSTORE against. It is read out
   * of the state root captured at `beginTransaction`, which the append-only
   * node store keeps resolvable no matter how much has been written since.
   */
  originalStorage(addr, slot) {
    const a = toAddress(addr);
    const hex = a.toString('hex');
    // `createAccount` wipes the storage, so from that point on the "original"
    // value is zero even though the pre-transaction root still holds the old
    // one. Checked BEFORE the memo, because a slot read earlier in the same
    // transaction has already cached the pre-reset value.
    //
    // NO CONFORMANCE VECTOR REACHES THIS, and the honest thing is to say so.
    // The EVM only reaches `createAccount` after the CREATE collision test has
    // already established that the address holds no storage (interpreter.js —
    // EIP-7610), so `_reset` can never fire from a transaction. It stays
    // because `createAccount` is a public method of this module whose contract
    // is "the storage does not survive", and an `originalStorage` that then
    // answered from the pre-transaction root would contradict it; test/statedb.js
    // pins that directly. It was once believed to be what the ten
    // InitCollision/create2collision vectors were failing on. It was not — the
    // missing storage arm of the collision test was.
    if (this._reset.has(hex)) return ZERO_WORD;
    const key = hex + toWord(slot).toString('hex');
    const memo = this._committed.get(key);
    if (memo) return memo;
    let v = ZERO_WORD;
    const enc = this._trie.at(this._txRoot).get(a);
    if (enc !== null) v = this._readSlot(new Trie(this.db, decodeAccount(enc).storageRoot), slot);
    this._committed.set(key, v);
    return v;
  }

  // -- lifecycle: self-destruct and EIP-161 touch ----------------------------

  /**
   * Shanghai semantics (pre-EIP-6780): the balance moves immediately, but the
   * account itself only disappears at the end of the transaction — so code and
   * storage remain readable to the rest of the frame, and a revert can put the
   * whole thing back.
   */
  selfDestruct(addr, beneficiary) {
    const hex = toAddress(addr).toString('hex');
    if (this._load(hex) === null) return false;
    const value = this.getBalance(addr);
    // Credit first, then zero — so self-destructing to your own address burns
    // the balance rather than keeping it. That ordering is the rule, not an
    // accident, and reversing it silently mints.
    this.addBalance(beneficiary, value);
    this.setBalance(addr, 0n);
    if (!this._destroyed.has(hex)) {
      this._destroyed.add(hex);
      this._journal.push(() => this._destroyed.delete(hex));
    }
    return true;
  }

  hasSelfDestructed(addr) { return this._destroyed.has(toAddress(addr).toString('hex')); }

  /** EIP-161: an account merely *touched* and left empty is deleted at tx end. */
  touch(addr) {
    const hex = toAddress(addr).toString('hex');
    if (this._touched.has(hex)) return;
    this._touched.add(hex);
    this._journal.push(() => this._touched.delete(hex));
  }

  // -- EIP-2929 access list --------------------------------------------------

  isWarmAddress(addr) { return this._warmAddr.has(toAddress(addr).toString('hex')); }

  /** Warm an address; returns true if it was cold (i.e. the caller pays 2600). */
  warmAddress(addr) {
    const hex = toAddress(addr).toString('hex');
    if (this._warmAddr.has(hex)) return false;
    this._warmAddr.add(hex);
    this._journal.push(() => this._warmAddr.delete(hex));
    return true;
  }

  _slotKey(addr, slot) { return toAddress(addr).toString('hex') + toWord(slot).toString('hex'); }

  isWarmSlot(addr, slot) { return this._warmSlot.has(this._slotKey(addr, slot)); }

  /** Warm a `(address, slot)` pair; returns true if it was cold (2100 vs 100). */
  warmSlot(addr, slot) {
    const k = this._slotKey(addr, slot);
    if (this._warmSlot.has(k)) return false;
    this._warmSlot.add(k);
    this._journal.push(() => this._warmSlot.delete(k));
    return true;
  }

  /**
   * The per-transaction warm set: sender, target, precompiles, anything in an
   * EIP-2930 access list, and — since EIP-3651, which Shanghai includes — the
   * coinbase, because otherwise every builder payment paid a cold-access toll.
   */
  prepareAccessList({ origin, to = null, coinbase = null, accessList = [], precompiles = PRECOMPILES } = {}) {
    this._warmAddr.clear();
    this._warmSlot.clear();
    if (origin) this.warmAddress(origin);
    if (to) this.warmAddress(to);
    if (coinbase) this.warmAddress(coinbase);
    for (const p of precompiles) this.warmAddress(p);
    for (const e of accessList) {
      const a = e.address !== undefined ? e.address : e[0];
      const keys = e.storageKeys !== undefined ? e.storageKeys : e[1] || [];
      this.warmAddress(a);
      for (const k of keys) this.warmSlot(a, k);
    }
  }

  // -- gas refund counter ----------------------------------------------------

  addRefund(n) {
    const d = BigInt(n);
    this._refund += d;
    this._journal.push(() => { this._refund -= d; });
  }

  subRefund(n) {
    const d = BigInt(n);
    if (this._refund < d) throw new RangeError('statedb: refund counter would go negative');
    this._refund -= d;
    this._journal.push(() => { this._refund += d; });
  }

  getRefund() { return this._refund; }

  // -- journal ---------------------------------------------------------------

  /** A marker for `revertTo`. Nesting is just a deeper index; there is no limit. */
  snapshot() { return this._journal.length; }

  /** Undo everything recorded after `marker`, newest first. */
  revertTo(marker) {
    if (!Number.isInteger(marker) || marker < 0 || marker > this._journal.length) {
      throw new RangeError('statedb: no such snapshot');
    }
    for (let i = this._journal.length - 1; i >= marker; i--) this._journal[i]();
    this._journal.length = marker;
  }

  /**
   * Discard every marker, making the current state final. A *frame* that
   * succeeds does not call this — it simply never calls `revertTo` — so this is
   * the end-of-transaction call, after which nothing can be rolled back.
   */
  commit() { this._journal.length = 0; }

  // -- transaction boundaries ------------------------------------------------

  /** Reset the per-transaction state: journal, refunds, warm sets, originals. */
  beginTransaction() {
    this._journal.length = 0;
    this._destroyed.clear();
    this._touched.clear();
    this._reset.clear();
    this._warmAddr.clear();
    this._warmSlot.clear();
    this._committed.clear();
    this._refund = 0n;
    this._txRoot = this._trie.root();
  }

  /**
   * End of transaction: self-destructed accounts go, and so do accounts that
   * were touched and left empty (EIP-161). Both are past the point of reverting
   * — this runs after the last frame has settled — so neither is journaled.
   */
  finalize() {
    for (const hex of this._destroyed) { this._write(hex, null); this._storage.delete(hex); }
    for (const hex of this._touched) {
      if (this._destroyed.has(hex)) continue;
      const a = this._load(hex);
      if (a !== null && a.nonce === 0n && a.balance === 0n && a.codeHash.equals(EMPTY_CODE_HASH)) {
        this._write(hex, null);
        this._storage.delete(hex);
      }
    }
    this._destroyed.clear();
    this._touched.clear();
    this._journal.length = 0;
    return this.root();
  }
}

module.exports = {
  StateDB, MemoryDB,
  EMPTY_CODE_HASH, EMPTY_TRIE_ROOT, PRECOMPILES,
  encodeAccount, decodeAccount, emptyAccount,
};
