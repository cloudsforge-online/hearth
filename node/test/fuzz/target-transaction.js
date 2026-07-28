'use strict';
/* Fuzz target: src/chain/transaction.js
 *
 * A transaction carries no sender field, so its bytes ARE the identity of the
 * payer. Two properties follow, and they are the whole target:
 *
 *   P1  RE-ENCODE IDENTITY. For every raw transaction this module ACCEPTS,
 *       `encode(decode(raw))` equals `raw` byte for byte. Fail this and two
 *       byte strings mean one transaction — two hashes, two mempool entries,
 *       and a block that one node validates and another rejects.
 *
 *   P2  THE DECODER'S CONTRACT, RESTATED INDEPENDENTLY. This file computes,
 *       from the raw field bytes and without reading transaction.js, whether a
 *       transaction should be accepted: minimal scalars, the width bounds, the
 *       nonce cap, the gasLimit x gasPrice product, r and s in [1, n), low-s,
 *       and v either 27/28 or EIP-155 over this chain id. Then it checks the
 *       decoder agrees. Restating the rules is the point — a test that calls
 *       the implementation to decide what the implementation should do tests
 *       nothing.
 *
 *   P3  `validate()` NEVER THROWS. It is documented as the function a mempool
 *       and a block validator call on hostile input. Every kind of garbage
 *       goes in; a `{ ok: false, code }` must come out.
 *
 *   P4  NORMALISATION INDEPENDENCE. Every exported function must behave as if
 *       `normalize()` had run — `f(draft)` must equal `f(normalize(draft))`.
 *       This is the generalisation of the bug already found by hand in this
 *       module (intrinsicGas counting hex characters as bytes because the
 *       "already normalised?" guard looked only at `nonce`). The guard is
 *       still a two-field sniff, and this property finds what that costs;
 *       see KNOWN_SNIFF below and fuzz/README.md.
 */

const T = require('../../src/chain/transaction');
const RLP = require('../../src/crypto/rlp');
const secp = require('../../src/crypto/secp256k1');
const { keccak256 } = require('../../src/crypto/keccak');
const { hex, unhex } = require('./harness');

const name = 'transaction';

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;
const CHAIN_ID = T.CHAIN_ID;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minimal big-endian bytes — the canonical scalar encoding, written here so
 *  the expectation does not come from the code under test. */
function minimal(v) {
  if (v === 0n) return Buffer.alloc(0);
  let h = v.toString(16);
  if (h.length % 2) h = '0' + h;
  return Buffer.from(h, 'hex');
}

function privateKey(rng) {
  const k = (rng.bigUint(256) % (secp.N - 1n)) + 1n;
  return secp.bigToBuf32(k);
}

/** A transaction whose every field is in range, so signing it must succeed. */
function validDraft(rng) {
  const gasLimit = rng.weighted([[8, -1], [3, 21000], [2, 30000000], [2, 0], [2, 1]]);
  const gl = gasLimit === -1 ? rng.bigUint(rng.between(1, 64)) % MAX_U64 : BigInt(gasLimit);
  // gasPrice is constrained so the product stays inside 256 bits — the decoder
  // refuses anything larger and we want a transaction it must accept.
  const gp = gl === 0n ? rng.bigUint(256) : rng.bigUint(rng.between(1, 200)) % ((MAX_U256 / (gl === 0n ? 1n : gl)) + 1n);
  return {
    nonce: rng.bigUint(rng.between(1, 63)) % MAX_U64,
    gasPrice: gp,
    gasLimit: gl,
    to: rng.chance(0.25) ? null : rng.bytes(20),
    value: rng.bigUint(rng.between(1, 256)),
    data: rng.bytes(rng.weighted([[8, -1], [4, 0], [2, 1], [2, 55], [2, 56]]) === -1 ? rng.between(0, 200) : rng.length(60)),
  };
}

// ---------------------------------------------------------------------------
// P2 — an independent statement of what `decode` must accept
// ---------------------------------------------------------------------------

/**
 * Given the nine raw field buffers, decide whether a correct decoder accepts.
 * Returns null for "accept", or the reason it must be rejected. Deliberately
 * written from the module's documented rules rather than from its code.
 */
function mustReject(f) {
  const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = f;

  const scalars = [['nonce', nonce, 8], ['gasPrice', gasPrice, 32], ['gasLimit', gasLimit, 8],
    ['value', value, 32], ['v', v, 32], ['r', r, 32], ['s', s, 32]];
  for (const [what, b, max] of scalars) {
    if (!Buffer.isBuffer(b)) return `${what} is not a scalar`;
    if (b.length > 0 && b[0] === 0) return `${what} has a leading zero byte`;
    if (b.length > max) return `${what} exceeds ${max * 8} bits`;
  }
  if (!Buffer.isBuffer(to)) return 'to is not a byte string';
  if (to.length !== 0 && to.length !== 20) return `to is ${to.length} bytes`;
  if (!Buffer.isBuffer(data)) return 'data is not a byte string';

  const N = (b) => (b.length === 0 ? 0n : BigInt('0x' + b.toString('hex')));
  const nNonce = N(nonce), nGp = N(gasPrice), nGl = N(gasLimit), nV = N(v), nR = N(r), nS = N(s);

  if (nNonce >= MAX_U64) return 'nonce is 2^64-1 or more';
  if (nGp * nGl > MAX_U256) return 'gasLimit * gasPrice exceeds 256 bits';

  if (nV !== 27n && nV !== 28n) {
    if (nV < 35n) return `v = ${nV} is neither 27/28 nor EIP-155`;
    if ((nV - 35n) >> 1n !== BigInt(CHAIN_ID)) return `v encodes another chain id`;
  }
  if (nR === 0n || nR >= secp.N) return 'r outside [1, n)';
  if (nS === 0n || nS >= secp.N) return 's outside [1, n)';
  if (nS > secp.N_HALF) return 's is high (EIP-2 requires low-s)';
  return null;
}

/** Field bytes drawn from the values that sit on or across every bound. */
function hostileFields(rng) {
  const scalar = (maxBytes, extra = []) => {
    const pool = [
      0n, 1n, 2n, 127n, 128n, 255n, 256n,
      (1n << BigInt(maxBytes * 8)) - 1n, (1n << BigInt(maxBytes * 8 - 8)) - 1n,
      MAX_U64, MAX_U64 - 1n, MAX_U64 + 1n, ...extra,
    ];
    let v = rng.chance(0.55) ? rng.pick(pool) : rng.bigUint(rng.between(1, maxBytes * 8 + 8));
    let b = minimal(v);
    // Non-canonical and over-wide forms, generated on purpose.
    const twist = rng.weighted([[60, 'none'], [10, 'zero-pad'], [6, 'zero'], [6, 'overwide'], [4, 'empty']]);
    if (twist === 'zero-pad') b = Buffer.concat([Buffer.alloc(rng.between(1, 2), 0), b]);
    else if (twist === 'zero') b = Buffer.from([0]);
    else if (twist === 'overwide') b = Buffer.concat([Buffer.from([rng.between(1, 255)]), Buffer.alloc(maxBytes, 0xff)]);
    else if (twist === 'empty') b = Buffer.alloc(0);
    return b;
  };

  const sigPool = [0n, 1n, 2n, secp.N_HALF - 1n, secp.N_HALF, secp.N_HALF + 1n, secp.N - 2n, secp.N - 1n, secp.N, secp.N + 1n, MAX_U256];
  const vPool = [0n, 1n, 26n, 27n, 28n, 29n, 30n, 34n, 35n, 36n, 37n, 38n,
    BigInt(CHAIN_ID) * 2n + 35n, BigInt(CHAIN_ID) * 2n + 36n, BigInt(CHAIN_ID) * 2n + 37n,
    BigInt(CHAIN_ID) * 2n + 34n, 1n << 64n, MAX_U256];

  const to = rng.weighted([
    [10, () => Buffer.alloc(0)],
    [10, () => rng.bytes(20)],
    [3, () => rng.bytes(19)],
    [3, () => rng.bytes(21)],
    [2, () => rng.bytes(rng.between(1, 32))],
    [2, () => Buffer.alloc(20, 0)],
  ])();

  return [
    scalar(8),
    scalar(32),
    scalar(8),
    to,
    scalar(32),
    rng.bytes(rng.length(40)),
    rng.chance(0.7) ? minimal(rng.pick(vPool)) : scalar(32),
    rng.chance(0.75) ? minimal(rng.pick(sigPool)) : scalar(32),
    rng.chance(0.75) ? minimal(rng.pick(sigPool)) : scalar(32),
  ];
}

// ---------------------------------------------------------------------------
// P4 — normalisation independence, and the known sniff bug it keeps hitting
// ---------------------------------------------------------------------------

/** Is every field already in the representation `normalize` would produce? */
function fullyNormalized(d) {
  const scalarOk = (x) => typeof x === 'bigint';
  return scalarOk(d.nonce) && scalarOk(d.gasPrice) && scalarOk(d.gasLimit)
    && scalarOk(d.value) && Buffer.isBuffer(d.data)
    && (d.to === null || (Buffer.isBuffer(d.to) && d.to.length === 20))
    && d.gas === undefined && d.input === undefined;
}

/* `isNormalized` is not exported, and reimplementing it here is the point: the
 * pin below fires only when the module's two-field sniff says "already
 * normalised" about an object that plainly is not. Anything else that breaks
 * P4 is a NEW bug and fails properly. */
const sniffSaysNormalized = (d) => typeof d.nonce === 'bigint' && Buffer.isBuffer(d.data);

const KNOWN_SNIFF =
  '`isNormalized(tx)` tests only `nonce` and `data`, so signingHash / intrinsicGas / checkGas / '
  + 'recoverSender read the other seven fields in whatever representation the caller left them in. '
  + 'Worst instance: `to: \'\'` or `to: \'0x\'` (both documented by `toAddress` as meaning creation) '
  + 'makes `isCreation` false, undercharging intrinsic gas by 32,000 and skipping the EIP-3860 initcode cap';

/** Several representations of one transaction; all must behave identically. */
function representations(rng, d) {
  const reps = [d];
  // JSON-RPC quantity form. Zero is `0x0`, never a bare `0x` — `BigInt('0x')`
  // is a SyntaxError and that is a caller bug, not a module bug.
  const hexOf = (v) => (v === 0n ? '0x0' : '0x' + minimal(v).toString('hex'));

  // Every alternative here is one `normalize` explicitly supports.
  reps.push({
    nonce: hexOf(d.nonce), gasPrice: hexOf(d.gasPrice), gasLimit: hexOf(d.gasLimit),
    to: d.to === null ? null : '0x' + d.to.toString('hex'),
    value: hexOf(d.value), data: '0x' + d.data.toString('hex'),
  });
  reps.push({
    nonce: d.nonce.toString(10), gasPrice: d.gasPrice.toString(10), gasLimit: d.gasLimit.toString(10),
    to: d.to, value: d.value.toString(10), data: d.data,
  });
  // the `gas`/`input` aliases normalize() accepts
  reps.push({
    nonce: d.nonce, gasPrice: d.gasPrice, gas: d.gasLimit,
    to: d.to, value: d.value, input: d.data,
  });
  if (d.to === null) {
    // The three spellings of "this is a creation" that toAddress accepts.
    for (const empty of [rng.pick(['', '0x']), Buffer.alloc(0)]) {
      reps.push(Object.assign({}, d, { to: empty }));
    }
  }
  if (d.nonce <= BigInt(Number.MAX_SAFE_INTEGER) && d.gasLimit <= BigInt(Number.MAX_SAFE_INTEGER)) {
    reps.push(Object.assign({}, d, { nonce: Number(d.nonce), gasLimit: Number(d.gasLimit) }));
  }
  return reps;
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

function checkAcceptedRoundTrip(t, raw, label) {
  let dec, err = null;
  try { dec = T.decode(raw); } catch (e) { err = e; }
  if (err) {
    t.ok(err instanceof Error, `${label}: rejection is an Error`, { raw });
    if (err instanceof T.TxError) t.ok(typeof err.code === 'string' && err.code.length > 0, `${label}: TxError carries a code`, { raw });
    else if (!(err instanceof TypeError)) {
      /* decode()'s JSDoc says `@throws {TxError} with a code naming the rule
       * broken`, but strict-RLP rejections come out of RLP.decode as plain
       * Errors with no `code`. Harmless inside validate(), which catches
       * everything and substitutes 'RLP_ERROR'; a trap for any other caller
       * that switches on `e.code`. */
      t.note('tx-decode-untyped-throw',
        `transaction.decode() lets a plain ${err.constructor.name} out of RLP rather than the documented TxError `
        + `(no .code for callers to switch on): "${err.message}"`);
    }
    return null;
  }
  // P1, the property the whole module is built around.
  let re = null, reErr = null;
  try { re = T.encode(dec); } catch (e) { reErr = e; }
  if (reErr) { t.ok(false, `${label}: encode() threw on a transaction decode() accepted: ${reErr.message}`, { raw }); return dec; }
  t.ok(re.equals(Buffer.isBuffer(raw) ? raw : unhex(raw)), `${label}: encode(decode(raw)) is byte-identical to raw`, { raw, reencoded: re });
  return dec;
}

function oneCase(t, rng, i) {
  const kind = rng.weighted([
    [20, 'signed'],
    [22, 'hostile-fields'],
    [16, 'random-bytes'],
    [14, 'mutate'],
    [14, 'representation'],
    [8, 'validate-garbage'],
    [6, 'wrong-shape'],
  ]);

  switch (kind) {
    case 'signed': {
      const priv = privateKey(rng);
      const d = validDraft(rng);
      const chainId = rng.chance(0.25) ? null : CHAIN_ID;
      let signed;
      try { signed = T.sign(d, priv, { chainId }); }
      catch (e) {
        // The only legitimate refusal is recovery id 2/3, ~1 in 2^128.
        t.ok(e.code === 'UNREPRESENTABLE_V', `sign refused a valid draft: ${e.message}`, { draft: d, priv });
        return;
      }
      const raw = T.encode(signed);
      const dec = checkAcceptedRoundTrip(t, raw, 'signed');
      if (!dec) return;

      t.ok(dec.nonce === d.nonce && dec.gasPrice === d.gasPrice && dec.gasLimit === d.gasLimit
        && dec.value === d.value && dec.data.equals(d.data)
        && ((dec.to === null && d.to === null) || (dec.to && d.to && dec.to.equals(d.to))),
      'decoded fields equal what was signed', { draft: d, raw });

      const want = T.addressFromPublicKey(secp.publicKeyFromPrivate(priv));
      const res = T.validate(raw);
      /* The only stateless reasons a correctly signed, in-range transaction may
       * still be refused, each a pure function of the transaction: it does not
       * carry enough gas to pay its own intrinsic cost, or it is a creation
       * over EIP-3860's initcode cap. Anything else is a failure. */
      const intrinsic = T.intrinsicGas(T.normalize(d));
      const underGassed = d.gasLimit < intrinsic;
      if (underGassed) {
        t.ok(res.ok === false && res.code === 'INTRINSIC_GAS_TOO_LOW',
          `a transaction whose gasLimit (${d.gasLimit}) is below its intrinsic cost (${intrinsic}) is refused for exactly that reason, got ${res.code}`,
          { draft: d, raw });
      } else {
        t.ok(res.ok === true, `validate accepts a well-formed signed transaction (${res.code || ''} ${res.error || ''})`, { draft: d, raw, priv });
      }
      if (res.ok) {
        t.ok(res.sender.equals(want), 'validate recovers the signing key\'s address', { draft: d, raw, priv });
        t.ok(res.hash.equals(keccak256(raw)), 'validate\'s hash is keccak over the raw bytes', { raw });
        t.ok(T.hash(dec).equals(keccak256(raw)), 'hash(tx) equals hash(raw)', { raw });
        t.ok(dec.protected === (chainId !== null), 'the protected flag matches how it was signed', { raw });
      }

      // A transaction signed for another chain must not be accepted here.
      if (chainId !== null && !underGassed && rng.chance(0.2)) {
        const other = T.encode(T.sign(d, priv, { chainId: CHAIN_ID + 1 + rng.int(1000) }));
        const r2 = T.validate(other);
        t.ok(r2.ok === false && r2.code === 'INVALID_CHAINID', 'a transaction signed for another chain id is refused', { raw: other });
      }
      return;
    }

    case 'hostile-fields': {
      const f = hostileFields(rng);
      let raw;
      try { raw = RLP.encode(f); } catch { return; }
      if (raw[0] <= 0x7f) return;                         // not a list; a different rule
      const reason = mustReject(f);
      let dec, err = null;
      try { dec = T.decode(raw); } catch (e) { err = e; }

      if (reason !== null) {
        t.ok(err !== null, `decode must reject: ${reason}`, { fields: f, raw, reason });
        if (err) t.ok(err instanceof T.TxError, `rejection of "${reason}" is a TxError, not ${err.constructor.name}`, { fields: f, raw });
      } else {
        t.ok(err === null, `decode must accept a canonical in-range transaction (threw ${err && err.code}: ${err && err.message})`, { fields: f, raw });
        if (!err) {
          const re = T.encode(dec);
          t.ok(re.equals(raw), 'encode(decode(raw)) is byte-identical for a hand-built transaction', { fields: f, raw, reencoded: re });
        }
      }
      // Whatever the outcome, validate() must have answered rather than thrown.
      const v = t.throws(() => T.validate(raw));
      t.ok(!v.threw, `validate() did not throw (${v.threw && v.error && v.error.message})`, { raw });
      return;
    }

    case 'random-bytes': {
      const n = rng.between(1, 300);
      const raw = rng.chance(0.6) ? rng.rlpishBytes(n) : rng.bytes(n);
      const v = t.throws(() => T.validate(raw));
      t.ok(!v.threw, `validate() never throws on random bytes (${v.threw && v.error && v.error.message})`, { raw });
      if (!v.threw) t.ok(v.value.ok === false || v.value.sender, 'validate returns a decided answer', { raw });
      if (!v.threw && v.value.ok) checkAcceptedRoundTrip(t, raw, 'random bytes that decoded');
      return;
    }

    case 'mutate': {
      const priv = privateKey(rng);
      let raw;
      try { raw = T.encode(T.sign(validDraft(rng), priv, { chainId: rng.chance(0.3) ? null : CHAIN_ID })); } catch { return; }
      const b = Buffer.from(raw);
      const how = rng.weighted([[10, 'flip'], [8, 'byte'], [4, 'truncate'], [4, 'extend'], [3, 'prefix']]);
      let m = b;
      if (how === 'flip') b[rng.int(b.length)] ^= 1 << rng.int(8);
      else if (how === 'byte') b[rng.int(b.length)] = rng.rlpishByte();
      else if (how === 'truncate') m = b.subarray(0, rng.int(b.length));
      else if (how === 'extend') m = Buffer.concat([b, rng.rlpishBytes(rng.between(1, 3))]);
      else if (how === 'prefix') m = Buffer.concat([Buffer.from([rng.int(0x80)]), b]);
      if (m.length === 0) return;

      const v = t.throws(() => T.validate(m));
      t.ok(!v.threw, `validate() never throws on a mutated transaction (${v.threw && v.error && v.error.message})`, { raw: m, how });
      checkAcceptedRoundTrip(t, m, `mutated (${how})`);
      return;
    }

    case 'representation': {
      const d = validDraft(rng);
      const reps = representations(rng, d);
      const base = T.normalize(d);
      for (const rep of reps) {
        let norm;
        try { norm = T.normalize(rep); }
        catch (e) {
          t.ok(false, `normalize() refused a representation it documents as accepted: ${e.constructor.name}: ${e.message}`, { draft: d, rep });
          continue;
        }
        const sniffed = sniffSaysNormalized(rep) && !fullyNormalized(rep);

        // normalize() itself must be idempotent and representation-blind.
        t.ok(norm.nonce === base.nonce && norm.gasPrice === base.gasPrice && norm.gasLimit === base.gasLimit
          && norm.value === base.value && norm.data.equals(base.data)
          && ((norm.to === null && base.to === null) || (norm.to && base.to && norm.to.equals(base.to))),
        'normalize() maps every accepted representation to the same transaction', { draft: d, rep });

        for (const [what, fn] of [
          ['signingHash', (x) => T.signingHash(x, CHAIN_ID).toString('hex')],
          ['signingHash(unprotected)', (x) => T.signingHash(x, null).toString('hex')],
          ['intrinsicGas', (x) => String(T.intrinsicGas(x))],
          ['isCreation', (x) => String(T.isCreation(x))],
          ['checkGas', (x) => { try { return 'ok:' + T.checkGas(x); } catch (e) { return 'err:' + e.code; } }],
        ]) {
          let a, bb, threw = false;
          try { a = fn(rep); bb = fn(norm); } catch { threw = true; }
          if (threw) continue;
          if (a === bb) { t.ok(true, `${what} is representation-independent`); continue; }
          if (sniffed) t.expectedBug('tx-isnormalized-sniff', KNOWN_SNIFF, `transaction.${what}({… to: ${JSON.stringify(String(rep.to))} …}) = ${a}, normalized = ${bb}`);
          else t.ok(false, `${what} differs between two representations of one transaction: ${a} vs ${bb}`, { draft: d, rep });
        }
      }
      return;
    }

    case 'validate-garbage': {
      /* Labelled by index rather than by stringifying, because one of these is
       * an object whose `toString` throws — which is the point of including
       * it, and would otherwise take the fuzzer down instead of the module. */
      const junkPool = [
        null, undefined, 0, 1, -1, NaN, Infinity, true, false, '', '0x', 'not hex', '0xzz',
        [], {}, { nonce: 1 }, { nonce: {}, data: [] }, Buffer.alloc(0), new Uint8Array(4),
        { nonce: -1n }, { to: 'x'.repeat(41) }, { data: 1234 }, { v: 'abc' },
        { nonce: 1n, data: Buffer.alloc(0), value: {} },
        { toString() { throw new Error('a hostile toString'); } },
        { get nonce() { throw new Error('a hostile getter'); } },
      ];
      const which = rng.int(junkPool.length);
      const v = t.throws(() => T.validate(junkPool[which]));
      t.ok(!v.threw, `validate() never throws, even on garbage #${which} (${v.threw && v.error && v.error.message})`, { junkIndex: which });
      if (!v.threw) t.ok(v.value.ok === false && typeof v.value.code === 'string', `garbage #${which} is refused with a code`, { junkIndex: which });
      return;
    }

    case 'wrong-shape': {
      // An RLP item that is not a nine-element list of byte strings.
      const shape = rng.weighted([[6, 'short'], [6, 'long'], [5, 'nested'], [4, 'string'], [4, 'empty-list']]);
      let value;
      if (shape === 'short') value = Array.from({ length: rng.between(0, 8) }, () => rng.bytes(rng.length(8)));
      else if (shape === 'long') value = Array.from({ length: rng.between(10, 14) }, () => rng.bytes(rng.length(8)));
      else if (shape === 'nested') {
        value = Array.from({ length: 9 }, () => rng.bytes(rng.length(8)));
        value[rng.int(9)] = [rng.bytes(2)];
      } else if (shape === 'string') value = rng.bytes(rng.between(1, 40));
      else value = [];
      const raw = RLP.encode(value);
      if (raw[0] <= 0x7f) return;
      const r = t.throws(() => T.decode(raw));
      t.ok(r.threw, `a ${shape} RLP item is not a transaction`, { raw, shape });
      if (r.threw) t.ok(r.error instanceof T.TxError, `${shape}: refused with a TxError, not ${r.error.constructor.name}`, { raw, shape });
      return;
    }

    default:
      return;
  }
}

function run(t, rng, { cases, deadline }) {
  t.group('transaction — re-encode identity, the decoder contract, validate()');
  let i = 0;
  for (; i < cases; i++) {
    if ((i & 15) === 0 && Date.now() > deadline) break;
    t.context(name, i);
    oneCase(t, rng, i);
  }
  return i;
}

function replay(t, entry) {
  t.context(name, entry.case === undefined ? -1 : entry.case);
  const label = `corpus ${entry._file}`;
  if (entry.raw !== undefined) {
    const raw = Buffer.isBuffer(entry.raw) ? entry.raw : unhex(entry.raw);
    const v = t.throws(() => T.validate(raw));
    t.ok(!v.threw, `${label}: validate() must not throw — ${entry.note || ''} ${hex(raw)}`);
    if (entry.mustReject) t.ok(!v.threw && v.value.ok === false, `${label}: must be refused — ${entry.note || ''}`);
    if (entry.mustAccept) t.ok(!v.threw && v.value.ok === true, `${label}: must be accepted — ${entry.note || ''}`);
    checkAcceptedRoundTrip(t, raw, label);
    return;
  }
  if (entry.fields !== undefined) {
    const raw = RLP.encode(entry.fields);
    const reason = mustReject(entry.fields);
    const r = t.throws(() => T.decode(raw));
    if (reason !== null) t.ok(r.threw, `${label}: must reject (${reason})`);
    else { t.ok(!r.threw, `${label}: must accept`); if (!r.threw) t.ok(T.encode(r.value).equals(raw), `${label}: re-encodes identically`); }
    return;
  }
  t.ok(false, `${label}: no raw or fields to replay`);
}

module.exports = { name, run, replay, mustReject, minimal, KNOWN_SNIFF };
