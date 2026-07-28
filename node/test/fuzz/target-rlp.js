'use strict';
/* Fuzz target: src/crypto/rlp.js
 *
 * RLP is the highest-value surface in the tree because it is not a wire format,
 * it is an identity. Every transaction hash, every trie node and every receipt
 * is keccak over RLP, so if two distinct byte strings ever decode to the same
 * value then one object has two roots and two honest nodes disagree about
 * state. The properties below are that sentence turned into assertions.
 *
 *   P1  ROUND TRIP.        decode(encode(x)) deep-equals x, for every generated
 *                          structure.
 *   P2  CANONICALITY.      For ANY input the decoder accepts, encode(decode(b))
 *                          equals b byte for byte. This is the strong form of
 *                          "no two encodings for one object", and it subsumes
 *                          the whole invalid-vector table: a decoder that lets
 *                          any non-canonical form through fails it without the
 *                          fuzzer having to guess which form.
 *   P3  CLEAN REJECTION.   Anything it does not accept throws an Error whose
 *                          message names the rule. Never a hang, never garbage.
 *   P4  BOUNDED WORK.      Decoding N bytes stays linear-ish in N. A length
 *                          field is attacker-controlled and a decoder that
 *                          allocates against it is a denial of service.
 *   P5  NO ALIASING.       A decoded Buffer never shares memory with the input,
 *                          so mutating one cannot change the other. The module
 *                          claims this explicitly ("a copy, not a view").
 *
 * The non-canonical forms in `mutations` are generated DELIBERATELY rather than
 * hoped for: a leading zero in a long-form length is one byte out of 2^8 in one
 * position out of thousands, and uniform fuzzing would find it approximately
 * never.
 */

const RLP = require('../../src/crypto/rlp');
const { rlpValue } = require('./random');
const { deepEq, hex, unhex } = require('./harness');

const name = 'rlp';

/** Encode a length the way RLP's long form does, with `pad` leading zero bytes. */
function longLen(len, pad = 0) {
  const out = [];
  let v = len;
  while (v > 0) { out.unshift(v & 0xff); v >>>= 8; }
  if (out.length === 0) out.push(0);
  for (let i = 0; i < pad; i++) out.unshift(0);
  return Buffer.from(out);
}

/** Header for a payload of `len` bytes, forced into the long form. */
function forceLongHeader(len, base, pad = 0) {
  const l = longLen(len, pad);
  return Buffer.concat([Buffer.from([base + 55 + l.length]), l]);
}

// ---------------------------------------------------------------------------
// deliberate non-canonical constructions — every one of these MUST be rejected
// ---------------------------------------------------------------------------

/**
 * Each entry returns `{ bytes, why }`. They are the invalid-RLP table written
 * as generators so the fuzzer explores the whole family — every payload length
 * either side of 55, every amount of zero padding — rather than the handful of
 * literals a conformance file happens to contain.
 */
const NONCANONICAL = [
  {
    id: 'string-long-form-for-short-length',
    make(rng) {
      const len = rng.between(0, 55);
      return { bytes: Buffer.concat([forceLongHeader(len, 0x80), rng.bytes(len)]), why: 'long form for a length the short form encodes' };
    },
  },
  {
    id: 'list-long-form-for-short-length',
    make(rng) {
      const body = Buffer.concat(Array.from({ length: rng.between(0, 4) }, () => RLP.encode(rng.bytes(rng.between(0, 6)))));
      if (body.length > 55) return null;
      return { bytes: Buffer.concat([forceLongHeader(body.length, 0xc0), body]), why: 'list long form for a short length' };
    },
  },
  {
    id: 'string-length-leading-zero',
    make(rng) {
      const len = rng.between(56, 300);
      return { bytes: Buffer.concat([forceLongHeader(len, 0x80, rng.between(1, 3)), rng.bytes(len)]), why: 'leading zero in a long-form length' };
    },
  },
  {
    id: 'list-length-leading-zero',
    make(rng) {
      const body = rng.bytes(0);
      const parts = [];
      let total = 0;
      while (total < 56) { const p = RLP.encode(rng.bytes(rng.between(0, 20))); parts.push(p); total += p.length; }
      const payload = Buffer.concat([body, ...parts]);
      return { bytes: Buffer.concat([forceLongHeader(payload.length, 0xc0, rng.between(1, 3)), payload]), why: 'leading zero in a list length' };
    },
  },
  {
    id: 'single-byte-wrapped',
    make(rng) {
      const b = rng.int(0x80);
      return { bytes: Buffer.from([0x81, b]), why: 'a byte below 0x80 wrapped in a 1-byte string header' };
    },
  },
  {
    id: 'trailing-bytes',
    make(rng) {
      const enc = RLP.encode(rlpValue(rng, 2, 3));
      return { bytes: Buffer.concat([enc, rng.bytes(rng.between(1, 4))]), why: 'trailing bytes after the top-level item' };
    },
  },
  {
    id: 'truncated',
    make(rng) {
      const enc = RLP.encode(rlpValue(rng, 3, 4));
      if (enc.length < 2) return null;
      const cut = rng.between(1, Math.min(4, enc.length - 1));
      return { bytes: enc.subarray(0, enc.length - cut), why: 'truncated encoding' };
    },
  },
  {
    id: 'declared-length-overruns-buffer',
    make(rng) {
      const len = rng.between(56, 400);
      const have = rng.between(0, len - 1);
      return { bytes: Buffer.concat([forceLongHeader(len, 0x80), rng.bytes(have)]), why: 'declared length runs past the end' };
    },
  },
  {
    id: 'nested-item-overruns-its-list',
    make(rng) {
      // A list declaring a payload SHORTER than the item it contains, with the
      // item's bytes still present in the buffer. `item` bounds-checks against
      // the whole buffer, so only the list-level check catches this.
      const inner = RLP.encode(rng.bytes(rng.between(2, 20)));
      const declared = rng.between(1, inner.length - 1);
      const header = declared <= 55 ? Buffer.from([0xc0 + declared]) : forceLongHeader(declared, 0xc0);
      return { bytes: Buffer.concat([header, inner]), why: 'a nested item overruns the list that declared it' };
    },
  },
  {
    id: 'huge-declared-length',
    make(rng) {
      // 8 length bytes naming a payload no machine has. Must be refused on the
      // spot, not attempted.
      const l = Buffer.alloc(8, 0xff);
      l[0] = rng.between(1, 0xff);
      return { bytes: Buffer.concat([Buffer.from([0xb7 + 8]), l, rng.bytes(rng.between(0, 8))]), why: 'a length beyond addressable memory' };
    },
  },
];

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

/** P2/P3/P5 over one arbitrary byte string. Returns the elapsed milliseconds. */
function probe(t, bytes, label) {
  // Decode a private copy so the aliasing check below can scribble on it.
  const work = Buffer.from(bytes);
  const started = process.hrtime.bigint();
  let decoded, threw = null;
  try { decoded = RLP.decode(work); } catch (e) { threw = e; }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  if (threw) {
    t.ok(threw instanceof Error, `${label}: rejection is an Error`, { input: bytes });
    if (!/^rlp: /.test(String(threw.message))) {
      // Not counted as a failure — see the finding in fuzz/README.md — but it
      // is exactly the "clean typed error" the property asks for, missing.
      t.note('rlp-untyped-' + threw.constructor.name,
        `RLP.decode threw ${threw.constructor.name} rather than a typed 'rlp: …' error: ${String(threw.message).slice(0, 60)}`);
    }
  } else {
    // P2: acceptance implies the input was already the canonical encoding.
    let re = null, reErr = null;
    try { re = RLP.encode(decoded); } catch (e) { reErr = e; }
    if (reErr) {
      t.note('rlp-reencode-' + reErr.constructor.name,
        `RLP.encode threw ${reErr.constructor.name} re-encoding something RLP.decode accepted: ${String(reErr.message).slice(0, 60)}`);
    } else {
      t.ok(re.equals(bytes), `${label}: an accepted encoding re-encodes to itself (canonicality)`,
        { input: bytes, reencoded: re });
    }
    /* P5: no decoded leaf may alias the input. Tested by observation rather
     * than by comparing `.buffer` identity — small Buffers come out of a shared
     * pool, so pointer identity gives false positives. Overwrite the input and
     * see whether anything decoded changes underneath us. */
    const leaves = [];
    (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else leaves.push(v); })(decoded);
    const before = leaves.map((l) => Buffer.from(l));
    work.fill(0x5a);
    for (let k = 0; k < leaves.length; k++) {
      if (!leaves[k].equals(before[k])) {
        t.ok(false, `${label}: a decoded leaf aliases the input buffer and changed when it was overwritten`, { input: bytes });
        break;
      }
    }
  }
  // P4: nothing in a few kilobytes may take a human-visible amount of time.
  t.ok(ms < 250, `${label}: decode of ${bytes.length} bytes finished promptly (${ms.toFixed(1)}ms)`, { input: bytes });
  return ms;
}

function oneCase(t, rng, i) {
  const kind = rng.weighted([
    [24, 'roundtrip'],
    [20, 'random-bytes'],
    [16, 'noncanonical'],
    [14, 'mutate'],
    [10, 'leaf-coercion'],
    [8, 'wide'],
    [8, 'concat'],
  ]);

  switch (kind) {
    case 'roundtrip': {
      const v = rlpValue(rng, rng.between(0, 5), 7);
      const enc = RLP.encode(v);
      let dec, err = null;
      try { dec = RLP.decode(enc); } catch (e) { err = e; }
      if (err) { t.ok(false, 'decode rejected this module\'s own encoding', { value: v, encoded: enc, error: err.message }); return; }
      t.ok(deepEq(dec, v), 'decode(encode(x)) deep-equals x', { value: v, encoded: enc, decoded: dec });
      t.ok(RLP.encode(dec).equals(enc), 'encode(decode(encode(x))) is byte-identical', { value: v, encoded: enc });
      return;
    }

    case 'random-bytes': {
      const len = rng.weighted([[10, -1], [4, 1], [3, 2], [3, 3], [2, 0]]);
      const n = len === -1 ? rng.between(1, 512) : len;
      const bytes = rng.chance(0.7) ? rng.rlpishBytes(n) : rng.bytes(n);
      if (bytes.length === 0) {
        const r = t.throws(() => RLP.decode(bytes));
        t.ok(r.threw, 'empty input is rejected', { input: bytes });
        return;
      }
      probe(t, bytes, 'random bytes');
      return;
    }

    case 'noncanonical': {
      const gen = rng.pick(NONCANONICAL);
      const made = gen.make(rng);
      if (!made) return;
      const r = t.throws(() => RLP.decode(made.bytes));
      t.ok(r.threw, `non-canonical form rejected: ${gen.id} (${made.why})`, { input: made.bytes, form: gen.id });
      if (r.threw) t.ok(r.error instanceof Error, `${gen.id}: rejection is an Error`, { input: made.bytes });
      return;
    }

    case 'mutate': {
      const enc = RLP.encode(rlpValue(rng, rng.between(1, 4), 5));
      const b = Buffer.from(enc);
      const how = rng.weighted([[10, 'flip'], [6, 'byte'], [5, 'truncate'], [5, 'extend'], [4, 'swap'], [3, 'zero-len']]);
      let mutated = b;
      if (how === 'flip') { const p = rng.int(b.length); b[p] ^= 1 << rng.int(8); }
      else if (how === 'byte') { const p = rng.int(b.length); b[p] = rng.rlpishByte(); }
      else if (how === 'truncate') mutated = b.subarray(0, rng.int(b.length));
      else if (how === 'extend') mutated = Buffer.concat([b, rng.rlpishBytes(rng.between(1, 4))]);
      else if (how === 'swap' && b.length > 1) { const p = rng.int(b.length - 1); const x = b[p]; b[p] = b[p + 1]; b[p + 1] = x; }
      else if (how === 'zero-len' && b.length > 1) { b[rng.between(1, b.length - 1)] = 0x00; }
      if (mutated.length === 0) return;
      probe(t, mutated, `mutated (${how})`);
      return;
    }

    case 'leaf-coercion': {
      // encode() accepts numbers, BigInts, hex strings and null; whatever it
      // makes of them must survive the round trip as RLP.toBytes says it will.
      const src = rng.weighted([
        [6, () => rng.bigUint(rng.between(1, 256))],
        [4, () => rng.int(2 ** 31)],
        [4, () => '0x' + rng.bytes(rng.length(40)).toString('hex')],
        [2, () => null],
        [2, () => Buffer.alloc(0)],
        [3, () => rng.bytes(rng.length(40))],
      ])();
      const arr = [src, [src, src], rng.bytes(rng.length(8))];
      let enc, err = null;
      try { enc = RLP.encode(arr); } catch (e) { err = e; }
      if (err) { t.ok(err instanceof TypeError, 'a refused leaf is refused with a TypeError', { value: arr, error: err.message }); return; }
      const dec = RLP.decode(enc);
      const want = [RLP.toBytes(src), [RLP.toBytes(src), RLP.toBytes(src)], arr[2]];
      t.ok(deepEq(dec, want), 'coerced leaves round-trip through toBytes', { value: arr, encoded: enc, decoded: dec });
      return;
    }

    case 'wide': {
      // Long-form headers, exercised on purpose: payloads either side of 55 and
      // either side of 256 so one-, two- and three-byte lengths all appear.
      const len = rng.weighted([[4, 54], [6, 55], [6, 56], [4, 57], [4, 254], [5, 255], [5, 256], [4, 257], [3, 1024], [2, 65535], [2, 65536]]);
      const v = rng.chance(0.5) ? rng.bytes(len) : [rng.bytes(len), rng.bytes(rng.length(60))];
      const enc = RLP.encode(v);
      const dec = RLP.decode(enc);
      t.ok(deepEq(dec, v), `long-form payload of ${len} bytes round-trips`, { size: len });
      t.ok(RLP.encode(dec).equals(enc), `long-form payload of ${len} bytes re-encodes identically`, { size: len });
      return;
    }

    case 'concat': {
      // Two valid encodings back to back. Exactly one item is a complete input;
      // the second must be reported as trailing bytes, never silently dropped.
      const a = RLP.encode(rlpValue(rng, 2, 3));
      const b = RLP.encode(rlpValue(rng, 2, 3));
      const r = t.throws(() => RLP.decode(Buffer.concat([a, b])));
      t.ok(r.threw, 'two concatenated items are rejected, not truncated to the first', { first: a, second: b });
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// the once-per-run structural probes
// ---------------------------------------------------------------------------

/**
 * A properly nested `[[[…]]]` of the given depth, built iteratively and
 * assembled in one pass — the obvious `Buffer.concat` per level is quadratic
 * and would make the fuzzer's own setup the slowest thing in the run.
 */
function nestedBytes(depth) {
  const headers = [];
  let len = 1;                                   // the innermost 0xc0
  for (let i = 0; i < depth; i++) {
    const h = len <= 55 ? Buffer.from([0xc0 + len]) : forceLongHeader(len, 0xc0);
    headers.push(h);
    len += h.length;
  }
  headers.reverse();
  headers.push(Buffer.from([0xc0]));
  return Buffer.concat(headers, len);
}

/**
 * P4 in its sharpest form. A length prefix is attacker-controlled, and the
 * decoder's cost must track the bytes actually present, not the bytes claimed.
 * Also the recursion probe: `item`/`items` recurse once per nesting level with
 * no depth cap, so the maximum nesting an input can request is bounded by the
 * input's size and nothing else. See fuzz/README.md — this is a real finding
 * and it is reported, not asserted against, because it is not this
 * directory's job to patch src/.
 */
function structuralProbes(t) {
  t.context(name, -1);

  // Cost must follow the bytes present, not the length declared.
  const claimed = Buffer.concat([forceLongHeader(0x7fffff, 0x80), Buffer.alloc(8)]);
  const t0 = process.hrtime.bigint();
  const r = t.throws(() => RLP.decode(claimed));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.ok(r.threw, 'a length of 8 MiB with 8 bytes present is rejected', { input: claimed });
  t.ok(ms < 50, `and rejected without allocating against the claim (${ms.toFixed(2)}ms)`, { input: claimed });

  // Linearity: decoding 2x the bytes must not cost 4x the time.
  const build = (n) => {
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(RLP.encode(Buffer.alloc(30, i & 0xff)));
    const body = Buffer.concat(parts);
    return Buffer.concat([forceLongHeader(body.length, 0xc0), body]);
  };
  const time = (b) => { const s = process.hrtime.bigint(); RLP.decode(b); return Number(process.hrtime.bigint() - s) / 1e6; };
  const small = build(2000), large = build(8000);
  time(small); time(large);                                  // warm the JIT
  let ts = 0, tl = 0;
  for (let i = 0; i < 5; i++) { ts += time(small); tl += time(large); }
  const ratio = tl / Math.max(ts, 0.01);
  t.ok(ratio < 12, `decoding 4x the items costs ~4x the time, not 16x (ratio ${ratio.toFixed(2)})`, { small: small.length, large: large.length, ratio });

  // A modest nesting must simply work, and re-encode to itself.
  const shallow = nestedBytes(48);
  t.ok(RLP.encode(RLP.decode(shallow)).equals(shallow), '48 levels of nesting round-trip byte for byte', { input: shallow });

  // Depth, probed rather than asserted. Recorded with the exact threshold.
  let deepest = 0, firstFailure = null;
  for (const d of [64, 256, 512, 1024, 1536, 2048, 2560, 3072, 4096, 8192, 16384]) {
    const b = nestedBytes(d);
    let outcome;
    try { RLP.decode(b); outcome = 'ok'; } catch (e) { outcome = e.constructor.name; }
    if (outcome === 'ok') { deepest = d; continue; }
    if (firstFailure === null) firstFailure = { depth: d, bytes: b.length, outcome };
  }
  if (firstFailure && firstFailure.outcome === 'RangeError') {
    t.note('rlp-nesting-stack',
      `RLP.decode has no nesting cap: ~${firstFailure.depth} levels (${firstFailure.bytes} bytes, well inside MAX_TX_BYTES) `
      + `exhausts the JS stack and throws RangeError, not a typed 'rlp:' error. Deepest accepted here: ${deepest}.`);
  }
}

// ---------------------------------------------------------------------------

function run(t, rng, { cases, deadline }) {
  t.group('rlp — round trip, canonicality, rejection, bounded work');
  structuralProbes(t);
  let i = 0;
  for (; i < cases; i++) {
    if ((i & 63) === 0 && Date.now() > deadline) break;
    t.context(name, i);
    oneCase(t, rng, i);
  }
  return i;
}

/** Re-run one corpus entry. Every failure this target writes is replayable. */
function replay(t, entry) {
  t.context(name, entry.case === undefined ? -1 : entry.case);
  if (entry.input !== undefined) {
    const bytes = Buffer.isBuffer(entry.input) ? entry.input : unhex(entry.input);
    if (entry.mustReject) {
      const r = t.throws(() => RLP.decode(bytes));
      t.ok(r.threw, `corpus ${entry._file}: ${entry.note || 'must be rejected'} — ${hex(bytes)}`);
      return;
    }
    probe(t, bytes, `corpus ${entry._file}`);
    return;
  }
  if (entry.value !== undefined) {
    const enc = RLP.encode(entry.value);
    t.ok(deepEq(RLP.decode(enc), entry.value), `corpus ${entry._file}: ${entry.note || 'round-trips'}`);
    return;
  }
  t.ok(false, `corpus ${entry._file}: no input or value to replay`);
}

module.exports = { name, run, replay, NONCANONICAL, nestedBytes, forceLongHeader };
