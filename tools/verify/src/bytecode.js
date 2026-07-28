'use strict';
/* ============================================================================
 * COMPARING BYTECODE — the three things that make this harder than `===`.
 * ============================================================================
 *
 * 1. THE METADATA HASH.
 *    solc appends a CBOR blob to the end of both the creation and the runtime
 *    code, followed by its own two-byte big-endian length. It contains a hash
 *    of the source *metadata* — which covers every source path, every setting
 *    and the full text of every comment. Add a space to a docstring and the
 *    bytecode changes without a single instruction changing.
 *
 *    This repository's own contracts avoid the problem by compiling with
 *    `metadata.bytecodeHash: 'none'` (contracts/scripts/compile.mjs), because
 *    the router's CREATE2 init code hash would otherwise depend on comment
 *    text. Arbitrary user contracts do not do that, so the comparison has to
 *    handle it: byte-identical including the trailer is a FULL match;
 *    identical after removing the trailer is a PARTIAL match, and the
 *    distinction is reported rather than hidden. A partial match means "this
 *    source compiles to this code", not "this is the source that was compiled".
 *
 *    The trailer is detected by PARSING it as CBOR, not by assuming the last N
 *    bytes are metadata. A length prefix that happens to be plausible is not
 *    enough to start deleting bytes off the end of someone's contract.
 *
 * 2. IMMUTABLES.
 *    `immutable` values are written into the runtime code at construction, so
 *    the deployed code has values where the compiler emitted zeros. solc tells
 *    us exactly where via `evm.deployedBytecode.immutableReferences`, so both
 *    sides are masked at those offsets. The masked-out values are reported —
 *    they are real information about the contract — but they are NOT proven,
 *    because proving them means re-running the constructor.
 *
 * 3. LIBRARIES.
 *    An unlinked external library leaves a `__$<34 hex>$__` placeholder. Code
 *    containing one can never equal deployed code, so a submission that
 *    produces a placeholder is refused with the library's name rather than
 *    reported as a mismatch — the same reasoning as
 *    contracts/scripts/compile.mjs, which refuses to hash unlinked bytecode.
 */

const PLACEHOLDER = /__\$[0-9a-fA-F]{34}\$__/g;

const norm = h => String(h || '').replace(/^0x/i, '').toLowerCase();

/** Minimal CBOR reader for the shapes solc emits. Returns null on anything else. */
function readCbor(buf) {
  let p = 0;
  const need = n => { if (p + n > buf.length) throw new Error('truncated'); };

  function readLen(ai) {
    if (ai < 24) return ai;
    if (ai === 24) { need(1); return buf[p++]; }
    if (ai === 25) { need(2); const v = buf.readUInt16BE(p); p += 2; return v; }
    throw new Error('length too large for metadata');
  }

  function readItem() {
    need(1);
    const b = buf[p++];
    const major = b >> 5, ai = b & 0x1f;
    switch (major) {
      case 0: return readLen(ai);                                     // uint
      case 2: { const n = readLen(ai); need(n); const v = buf.subarray(p, p + n).toString('hex'); p += n; return v; }
      case 3: { const n = readLen(ai); need(n); const v = buf.subarray(p, p + n).toString('utf8'); p += n; return v; }
      case 4: { const n = readLen(ai); const a = []; for (let i = 0; i < n; i++) a.push(readItem()); return a; }
      case 5: { const n = readLen(ai); const o = {}; for (let i = 0; i < n; i++) { const k = readItem(); o[String(k)] = readItem(); } return o; }
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        throw new Error('unsupported simple value');
      default: throw new Error('unsupported major type');
    }
  }

  const value = readItem();
  if (p !== buf.length) throw new Error('trailing bytes');
  return value;
}

/** Keys solc has ever put in the trailer. Anything else is not solc metadata. */
const METADATA_KEYS = new Set(['ipfs', 'bzzr0', 'bzzr1', 'solc', 'experimental']);

/**
 * Split a hex string into code and the CBOR metadata trailer.
 * @returns {{code: string, metadata: string|null, fields: object|null}}
 */
function splitMetadata(hexStr) {
  const hex = norm(hexStr);
  const buf = Buffer.from(hex, 'hex');
  const none = { code: hex, metadata: null, fields: null };
  if (buf.length < 4) return none;
  const len = buf.readUInt16BE(buf.length - 2);
  if (len < 2 || len + 2 > buf.length) return none;
  const blob = buf.subarray(buf.length - 2 - len, buf.length - 2);
  let fields;
  try {
    fields = readCbor(blob);
  } catch {
    return none;
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return none;
  const keys = Object.keys(fields);
  if (keys.length === 0 || !keys.every(k => METADATA_KEYS.has(k))) return none;
  return {
    code: buf.subarray(0, buf.length - 2 - len).toString('hex'),
    metadata: blob.toString('hex'),
    fields,
  };
}

/**
 * Zero every immutable slot.
 * @param {string} hexStr
 * @param {object} immutableReferences  solc's map of astId -> [{start,length}]
 * @returns {{hex: string, ranges: Array<{start:number,length:number}>, values: string[]}}
 */
function maskImmutables(hexStr, immutableReferences) {
  const hex = norm(hexStr);
  const ranges = [];
  for (const list of Object.values(immutableReferences || {})) {
    for (const r of list || []) {
      if (!Number.isInteger(r.start) || !Number.isInteger(r.length) || r.start < 0 || r.length <= 0) continue;
      ranges.push({ start: r.start, length: r.length });
    }
  }
  if (ranges.length === 0) return { hex, ranges: [], values: [] };
  const buf = Buffer.from(hex, 'hex');
  const values = [];
  for (const r of ranges) {
    if (r.start + r.length > buf.length) continue;
    values.push('0x' + buf.subarray(r.start, r.start + r.length).toString('hex'));
    buf.fill(0, r.start, r.start + r.length);
  }
  return { hex: buf.toString('hex'), ranges, values };
}

/** Byte offset of the first difference, or -1. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 2) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1]) return i / 2;
  }
  return a.length === b.length ? -1 : n / 2;
}

function unlinkedLibraries(hexStr, linkReferences) {
  const hex = norm(hexStr);
  if (!PLACEHOLDER.test(hex)) { PLACEHOLDER.lastIndex = 0; return []; }
  PLACEHOLDER.lastIndex = 0;
  const names = [];
  for (const [file, libs] of Object.entries(linkReferences || {})) {
    for (const lib of Object.keys(libs || {})) names.push(`${file}:${lib}`);
  }
  return names.length ? names : ['(unnamed — solc reported no linkReferences)'];
}

/**
 * The comparison.
 *
 * @param {object} o
 * @param {string} o.onchain    runtime bytecode from eth_getCode
 * @param {string} o.compiled   evm.deployedBytecode.object
 * @param {object} [o.immutableReferences]
 * @param {object} [o.linkReferences]
 * @returns {{matched: boolean, matchType: 'exact'|'partial'|null, metadataMatched: boolean,
 *   immutableRanges: number, immutableValues: string[], reason?: string, detail?: object}}
 */
function compareRuntime({ onchain, compiled, immutableReferences, linkReferences }) {
  const on = norm(onchain);
  const co = norm(compiled);

  if (on.length === 0) {
    return {
      matched: false, matchType: null, metadataMatched: false, immutableRanges: 0, immutableValues: [],
      reason: 'there is no code at that address. Either nothing is deployed there, or it is an '
        + 'externally-owned account, or the contract self-destructed.',
    };
  }
  const unlinked = unlinkedLibraries(co, linkReferences);
  if (unlinked.length) {
    return {
      matched: false, matchType: null, metadataMatched: false, immutableRanges: 0, immutableValues: [],
      reason: 'the compiled bytecode still contains unlinked library placeholders, so it cannot equal '
        + `any deployed code. Supply addresses for: ${unlinked.join(', ')}`,
    };
  }
  if (co.length === 0) {
    return {
      matched: false, matchType: null, metadataMatched: false, immutableRanges: 0, immutableValues: [],
      reason: 'the named contract compiled to no runtime bytecode — it is an interface, an abstract '
        + 'contract, or a library that inlines entirely.',
    };
  }

  const mOn = maskImmutables(on, immutableReferences);
  const mCo = maskImmutables(co, immutableReferences);
  const base = { immutableRanges: mOn.ranges.length, immutableValues: mOn.values };

  if (mOn.hex === mCo.hex) {
    return { matched: true, matchType: 'exact', metadataMatched: true, ...base };
  }

  const sOn = splitMetadata(mOn.hex);
  const sCo = splitMetadata(mCo.hex);
  if (sOn.code === sCo.code && sOn.code.length > 0 && (sOn.metadata || sCo.metadata)) {
    return {
      matched: true, matchType: 'partial', metadataMatched: false, ...base,
      detail: {
        onchainMetadata: sOn.metadata, compiledMetadata: sCo.metadata,
        note: 'the executable code is identical; the appended CBOR metadata differs. That hash covers '
          + 'source paths, comments and compiler settings, so this proves the source compiles to the '
          + 'deployed code — not that it is byte-for-byte the source that was compiled.',
      },
    };
  }

  const at = firstDifference(sOn.code, sCo.code);
  return {
    matched: false, matchType: null, metadataMatched: false, ...base,
    reason: 'the recompiled runtime bytecode does not match the code at that address'
      + (at >= 0 ? `; first difference at byte ${at}` : '')
      + ` (deployed ${sOn.code.length / 2} bytes, recompiled ${sCo.code.length / 2} bytes, metadata excluded)`,
    detail: { firstDifferenceByte: at, onchainBytes: sOn.code.length / 2, compiledBytes: sCo.code.length / 2 },
  };
}

/**
 * Constructor arguments, checked against the transaction that created the
 * contract — the only way to check them at all.
 *
 * WITHOUT a creation transaction, declared constructor arguments are RECORDED
 * AND NOT VERIFIED, and every record says which of the two happened. The
 * runtime bytecode does not contain them, so there is nothing to compare
 * against; a verifier that reported them as verified anyway would be asserting
 * something it never looked at.
 */
function checkConstructorArguments({ creationInput, compiledCreation, declared }) {
  const declaredHex = norm(declared || '');
  if (declaredHex.length % 2 !== 0) {
    return { verified: false, arguments: '0x' + declaredHex, reason: 'the declared constructor arguments are not whole bytes' };
  }
  if (declaredHex.length && declaredHex.length % 64 !== 0) {
    /* Every ABI-encoded head slot is 32 bytes, dynamic types included, so a
     * length that is not a multiple of 32 is malformed whatever the types. */
    return {
      verified: false, arguments: '0x' + declaredHex,
      reason: `the declared constructor arguments are ${declaredHex.length / 2} bytes, which is not a `
        + 'multiple of 32 — ABI encoding cannot produce that',
    };
  }
  if (!creationInput) {
    return {
      verified: false, arguments: '0x' + declaredHex,
      reason: 'no creation transaction was supplied, so the constructor arguments are recorded but not '
        + 'verified. Pass creationTxHash to have them checked against the deployment.',
    };
  }

  const input = norm(creationInput);
  const creation = norm(compiledCreation);
  if (input.startsWith(creation)) {
    const tail = input.slice(creation.length);
    if (declaredHex && tail !== declaredHex) {
      /* A contradiction, not an absence: the submitter asserted something the
       * deployment disproves. The verifier turns this into a refusal. */
      return {
        verified: false, contradiction: true, arguments: '0x' + tail,
        reason: `the creation transaction carries different constructor arguments (0x${tail}) `
          + `than the ones declared (0x${declaredHex})`,
      };
    }
    return { verified: true, contradiction: false, arguments: '0x' + tail, reason: null };
  }

  const sCreation = splitMetadata(creation);
  if (sCreation.metadata && input.startsWith(sCreation.code)) {
    return {
      verified: false, arguments: '0x' + declaredHex,
      reason: 'the creation code matches only with its metadata trailer removed, so the arguments cannot '
        + 'be separated from the trailing bytes. Recorded, not verified.',
    };
  }
  return {
    verified: false, contradiction: true, arguments: '0x' + declaredHex,
    reason: 'the creation transaction\'s input does not begin with the recompiled creation code, so it is '
      + 'not the transaction that deployed this contract (or a factory deployed it, in which case there '
      + 'is no top-level creation input to check).',
  };
}

module.exports = {
  norm, splitMetadata, maskImmutables, compareRuntime, checkConstructorArguments,
  firstDifference, unlinkedLibraries, readCbor,
};
