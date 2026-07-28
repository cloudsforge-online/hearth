'use strict';
/* The generator half of the fuzzer: a seeded PRNG and the value generators
 * built on it.
 *
 * EVERY BIT OF RANDOMNESS IN THIS DIRECTORY COMES FROM HERE, and it comes from
 * a seed the runner prints. That is not a nicety — a fuzzer whose failures
 * cannot be replayed is a fuzzer that reports "something broke once". `Rng` is
 * a pure function of its seed and the sequence of calls made against it, so
 * `--seed=N --target=T` reproduces a run exactly, and a failing case can be
 * lifted into `corpus/` and replayed forever after.
 *
 * Node's `Math.random` is deliberately not used: it is seeded from the OS and
 * cannot be pinned.
 *
 * The generators are BIASED, on purpose. Uniform random bytes almost never
 * land on a boundary, and boundaries are where the bugs are — 0x80 and 0xb7 in
 * RLP, 2^64-1 for a nonce, 2^255 for a signed word, 31/32/33 bytes for the
 * trie's embed rule. So every generator mixes a uniform tail with an explicit
 * table of the values a human reviewer would have picked.
 */

// ---------------------------------------------------------------------------
// the PRNG
// ---------------------------------------------------------------------------

/* sfc32 — 128 bits of state, passes PractRand, four lines long, and needs no
 * BigInt so it costs nothing in the inner loop. The state is expanded from a
 * single 32-bit seed with splitmix32 so that adjacent seeds (0, 1, 2 …) give
 * completely unrelated streams rather than correlated ones. */
function splitmix32(a) {
  return function () {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0);
  };
}

class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    const sm = splitmix32(this.seed);
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    for (let i = 0; i < 12; i++) this.u32();          // warm up
  }

  u32() {
    let { a, b, c, d } = this;
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ (b >>> 9);
    b = c + (c << 3) | 0;
    c = (c << 21) | (c >>> 11);
    c = c + t | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  /** A float in [0, 1). */
  float() { return this.u32() / 4294967296; }

  /** An integer in [0, n). `n` must be a positive safe integer. */
  int(n) { return n <= 0 ? 0 : this.u32() % n; }

  /** An integer in [lo, hi], inclusive both ends. */
  between(lo, hi) { return lo + this.int(hi - lo + 1); }

  /** True with probability p. */
  chance(p) { return this.float() < p; }

  /** A uniformly chosen element. */
  pick(arr) { return arr[this.int(arr.length)]; }

  /**
   * Weighted choice. `table` is `[[weight, value], …]`; weights are integers
   * and need not sum to anything in particular.
   */
  weighted(table) {
    let total = 0;
    for (const [w] of table) total += w;
    let k = this.int(total);
    for (const [w, v] of table) { if (k < w) return v; k -= w; }
    return table[table.length - 1][1];
  }

  /** `n` uniform bytes. */
  bytes(n) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i += 4) {
      const w = this.u32();
      b[i] = w & 0xff;
      if (i + 1 < n) b[i + 1] = (w >>> 8) & 0xff;
      if (i + 2 < n) b[i + 2] = (w >>> 16) & 0xff;
      if (i + 3 < n) b[i + 3] = (w >>> 24) & 0xff;
    }
    return b;
  }

  /** A Fisher-Yates shuffle, in place, using this stream. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // -- biased generators ----------------------------------------------------

  /**
   * A byte drawn from a distribution that lands on the RLP prefix boundaries
   * far more often than chance would. Uniform bytes essentially never produce a
   * long-form list header; this makes half of them one.
   */
  rlpishByte() {
    return this.weighted([
      [40, null],                                       // uniform
      [6, 0x00], [4, 0x01], [6, 0x7f], [8, 0x80], [4, 0x81], [3, 0x82],
      [6, 0xb7], [8, 0xb8], [4, 0xb9], [6, 0xbf],
      [8, 0xc0], [4, 0xc1], [6, 0xf7], [8, 0xf8], [4, 0xf9], [6, 0xff],
    ]) ?? (this.u32() & 0xff);
  }

  /** A buffer of `n` bytes drawn from `rlpishByte`. */
  rlpishBytes(n) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = this.rlpishByte();
    return b;
  }

  /**
   * A length, biased hard onto the values where a size rule changes: 0 (the
   * empty string), 1 (the "single byte encodes as itself" rule), 55/56 (RLP's
   * short/long boundary) and 31/32/33 (the trie's embed boundary).
   */
  length(max = 64) {
    const n = this.weighted([
      [30, -1],                                         // uniform in [0, max]
      [6, 0], [6, 1], [3, 2], [4, 31], [4, 32], [4, 33],
      [5, 54], [6, 55], [6, 56], [3, 57], [2, 127], [2, 128],
    ]);
    if (n === -1) return this.int(max + 1);
    return n > max ? max : n;
  }

  /**
   * A non-negative BigInt of at most `bits` bits, biased onto the boundaries:
   * zero, one, all-ones, the sign bit, and either side of both.
   */
  bigUint(bits = 256) {
    const top = (1n << BigInt(bits)) - 1n;
    const half = 1n << BigInt(bits - 1);
    const kind = this.weighted([
      [34, 'uniform'], [12, 'small'], [8, 'byte-aligned'], [6, 'power'],
      [4, 'zero'], [4, 'one'], [4, 'max'], [4, 'sign'], [3, 'sign-1'], [3, 'sign+1'],
      [3, 'max-1'], [3, 'two'], [3, 'maxU64'], [3, 'maxU64+1'],
    ]);
    switch (kind) {
      case 'zero': return 0n;
      case 'one': return 1n;
      case 'two': return 2n;
      case 'max': return top;
      case 'max-1': return top - 1n;
      case 'sign': return half & top;
      case 'sign-1': return (half - 1n) & top;
      case 'sign+1': return (half + 1n) & top;
      case 'maxU64': return ((1n << 64n) - 1n) & top;
      case 'maxU64+1': return (1n << 64n) & top;
      case 'small': return BigInt(this.int(256));
      case 'power': return (1n << BigInt(this.int(bits))) & top;
      case 'byte-aligned': {
        const nbytes = this.between(1, Math.ceil(bits / 8));
        let v = 0n;
        for (let i = 0; i < nbytes; i++) v = (v << 8n) | BigInt(this.u32() & 0xff);
        return v & top;
      }
      default: {
        let v = 0n;
        for (let i = 0; i < bits; i += 32) v = (v << 32n) | BigInt(this.u32());
        return v & top;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// structural generators
// ---------------------------------------------------------------------------

/**
 * A random RLP-shaped value: nested arrays whose leaves are Buffers. Exactly
 * the shape `RLP.decode` returns, so `decode(encode(x))` can be compared with
 * `x` directly and a mismatch means a real round-trip failure rather than a
 * coercion artefact.
 *
 * `depth` bounds nesting; `breadth` bounds each list. Both are small by default
 * because the interesting bugs are at the length boundaries, not at size.
 */
function rlpValue(rng, depth = 4, breadth = 6) {
  if (depth <= 0 || rng.chance(0.55)) return rng.bytes(rng.length(70));
  const n = rng.weighted([[20, -1], [6, 0], [6, 1], [4, 2]]);
  const len = n === -1 ? rng.int(breadth + 1) : n;
  const out = new Array(len);
  for (let i = 0; i < len; i++) out[i] = rlpValue(rng, depth - 1, breadth);
  return out;
}

/**
 * A random trie key set. `sharedPrefix` deliberately produces keys that agree
 * for a long run of nibbles, because that is what forces extension nodes,
 * branch collapse and the path merges in rule 3 — the code paths a set of
 * uniformly random keys almost never reaches.
 */
function trieKeys(rng, count) {
  const keys = [];
  const stems = [];
  for (let i = 0; i < 1 + rng.int(3); i++) stems.push(rng.bytes(rng.between(1, 8)));
  for (let i = 0; i < count; i++) {
    const kind = rng.weighted([[10, 'random'], [8, 'shared'], [4, 'sibling'], [3, 'short'], [2, 'nested']]);
    if (kind === 'random') { keys.push(rng.bytes(rng.between(1, 32))); continue; }
    if (kind === 'short') { keys.push(rng.bytes(rng.between(0, 2))); continue; }
    const stem = rng.pick(stems);
    if (kind === 'shared') { keys.push(Buffer.concat([stem, rng.bytes(rng.between(0, 4))])); continue; }
    if (kind === 'nested') { keys.push(Buffer.concat([stem, Buffer.alloc(rng.between(0, 6), 0)])); continue; }
    // sibling: same stem, one byte apart — forces a branch at a known depth
    const tail = rng.bytes(1);
    keys.push(Buffer.concat([stem, tail]));
  }
  // A key of length 0 is legal; keep it, but do not let duplicates hide bugs.
  const seen = new Set(), out = [];
  for (const k of keys) { const h = k.toString('hex'); if (!seen.has(h)) { seen.add(h); out.push(k); } }
  return out;
}

/**
 * A trie value. Lengths cluster on 31/32/33 bytes because RLP-encoding a node
 * whose value sits either side of that boundary is what decides whether the
 * node is embedded in its parent or replaced by its hash — the rule the trie's
 * own header calls the most commonly missed one.
 */
function trieValue(rng) {
  const n = rng.weighted([
    [16, -1], [5, 1], [4, 28], [5, 29], [5, 30], [6, 31], [6, 32], [5, 33], [3, 64], [2, 200],
  ]);
  const len = n === -1 ? rng.between(1, 40) : n;
  return rng.bytes(len);
}

module.exports = { Rng, rlpValue, trieKeys, trieValue };
