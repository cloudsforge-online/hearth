'use strict';
/* The contract ABI: types, selectors, encoding, decoding, and revert reasons.
 *
 * Written from the Solidity ABI specification rather than ported from ethers,
 * because the CLI has no dependencies and because the tracer needs the revert
 * decoder whether or not anyone ever passes it an ABI file.
 *
 * THE MODEL, in the two sentences that make the rest obvious. Every value is
 * encoded as a sequence of 32-byte words. A type is either STATIC — it occupies
 * a known number of words in place — or DYNAMIC, in which case its slot holds a
 * 32-byte OFFSET, measured from the start of the enclosing tuple's encoding, to
 * where the value really lives. A tuple is dynamic if any component is; an array
 * is dynamic if it is unsized or if its element type is.
 *
 * The offset base is the classic bug: it is the start of the ENCLOSING BLOCK,
 * not the start of the message. For top-level arguments, that block starts after
 * the 4-byte selector — so a decoder that measures from byte 0 of the calldata is
 * wrong by exactly four bytes and produces plausible garbage rather than an
 * error. Every recursive call below therefore takes its own base.
 *
 * WHAT IS AND IS NOT SUPPORTED (v1, honestly):
 *   - uint<M>, int<M> for every M in 8..256 step 8, plus the `uint`/`int` aliases
 *   - address, bool, bytes<M> for M in 1..32, bytes, string
 *   - fixed and dynamic arrays of any of the above, nested to any depth
 *   - tuples, nested to any depth, from ABI JSON `components` or `(a,b)` syntax
 *   - function selectors and event topic hashes over all of the above
 *   Not supported: `fixed`/`ufixed` (Solidity itself does not implement them),
 *   and the `function` type (24-byte address+selector). Both are rejected by name
 *   rather than mis-encoded.
 */

const { keccak256 } = require('../crypto/keccak');

const WORD = 32;
const MASK256 = (1n << 256n) - 1n;

class AbiError extends Error {
  constructor(message) { super('abi: ' + message); this.name = 'AbiError'; }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/* A Type is one of:
 *   { kind:'uint'|'int', bits }
 *   { kind:'address' } { kind:'bool' } { kind:'string' } { kind:'bytes' }
 *   { kind:'bytesN', size }
 *   { kind:'array', base: Type, length: number|null }   null length = dynamic
 *   { kind:'tuple', components: Type[], names: (string|null)[] }
 */

function typeError(s) { throw new AbiError(`unsupported or malformed type ${JSON.stringify(s)}`); }

/**
 * Split `a,b,(c,d),e` on top-level commas only. Depth tracking is the whole
 * point: a naive `split(',')` tears every nested tuple in half.
 */
function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    if (depth < 0) typeError(s);
  }
  if (depth !== 0) typeError(s);
  const tail = s.slice(start);
  if (out.length === 0 && tail.trim() === '') return [];
  out.push(tail);
  return out.map((x) => x.trim());
}

/** Peel the trailing `[]` / `[n]` suffixes off a type string, outermost last. */
function peelArray(s) {
  if (!s.endsWith(']')) return null;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ']') depth++;
    else if (s[i] === '[') {
      depth--;
      if (depth === 0) return { head: s.slice(0, i), size: s.slice(i + 1, s.length - 1).trim() };
    }
  }
  return typeError(s);
}

function parseType(spec) {
  const s = String(spec).trim();
  if (s === '') typeError(spec);

  const arr = peelArray(s);
  if (arr) {
    if (arr.head === '') typeError(spec);
    const length = arr.size === '' ? null : Number(arr.size);
    if (length !== null && (!Number.isInteger(length) || length < 0)) typeError(spec);
    return { kind: 'array', base: parseType(arr.head), length };
  }

  if (s.startsWith('(')) {
    if (!s.endsWith(')')) typeError(spec);
    const parts = splitTop(s.slice(1, -1));
    return { kind: 'tuple', components: parts.map(parseType), names: parts.map(() => null) };
  }

  if (s === 'address') return { kind: 'address' };
  if (s === 'bool') return { kind: 'bool' };
  if (s === 'string') return { kind: 'string' };
  if (s === 'bytes') return { kind: 'bytes' };

  let m = /^(u?int)(\d*)$/.exec(s);
  if (m) {
    const bits = m[2] === '' ? 256 : Number(m[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) typeError(spec);
    return { kind: m[1] === 'uint' ? 'uint' : 'int', bits };
  }

  m = /^bytes(\d+)$/.exec(s);
  if (m) {
    const size = Number(m[1]);
    if (size < 1 || size > 32) typeError(spec);
    return { kind: 'bytesN', size };
  }

  if (/^u?fixed/.test(s)) throw new AbiError(`fixed-point type ${s} is not supported (Solidity does not implement it either)`);
  if (s === 'function') throw new AbiError('the `function` type is not supported by this CLI');
  return typeError(spec);
}

/** An ABI-JSON input/output entry -> Type. Handles `tuple`, `tuple[]`, `tuple[2]`. */
function typeFromAbi(entry) {
  if (typeof entry === 'string') return parseType(entry);
  if (!entry || typeof entry.type !== 'string') throw new AbiError('ABI parameter has no `type`');
  const t = entry.type;
  if (!t.startsWith('tuple')) return parseType(t);

  const components = (entry.components || []).map(typeFromAbi);
  const names = (entry.components || []).map((cpt) => cpt.name || null);
  let type = { kind: 'tuple', components, names };
  // `tuple[2][]` -> wrap innermost-first, which is the order peelArray unwinds.
  const suffix = t.slice('tuple'.length);
  const dims = [];
  let rest = suffix;
  while (rest.endsWith(']')) {
    const p = peelArray(rest);
    dims.unshift(p.size === '' ? null : Number(p.size));
    rest = p.head;
  }
  if (rest !== '') throw new AbiError(`malformed tuple type ${JSON.stringify(t)}`);
  for (const d of dims) type = { kind: 'array', base: type, length: d };
  return type;
}

/** The canonical name, which is what the selector hash is taken over. */
function canonical(type) {
  switch (type.kind) {
    case 'uint': case 'int': return type.kind + type.bits;
    case 'bytesN': return 'bytes' + type.size;
    case 'array': return canonical(type.base) + '[' + (type.length === null ? '' : type.length) + ']';
    case 'tuple': return '(' + type.components.map(canonical).join(',') + ')';
    default: return type.kind;
  }
}

function isDynamic(type) {
  switch (type.kind) {
    case 'string': case 'bytes': return true;
    case 'array': return type.length === null || isDynamic(type.base);
    case 'tuple': return type.components.some(isDynamic);
    default: return false;
  }
}

/** How many 32-byte words a static type occupies in place. */
function headWords(type) {
  if (isDynamic(type)) return 1;
  if (type.kind === 'array') return type.length * headWords(type.base);
  if (type.kind === 'tuple') return type.components.reduce((n, t) => n + headWords(t), 0);
  return 1;
}

// ---------------------------------------------------------------------------
// value coercion
// ---------------------------------------------------------------------------

function toBigInt(v, what) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new AbiError(`${what}: ${v} is not an integer`);
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const s = v.trim().replace(/_/g, '');
    if (!/^[-+]?(0[xX][0-9a-fA-F]+|\d+)$/.test(s)) throw new AbiError(`${what}: ${JSON.stringify(v)} is not an integer`);
    return BigInt(s);
  }
  throw new AbiError(`${what}: cannot read an integer from ${typeof v}`);
}

function toBytes(v, what) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v !== 'string') throw new AbiError(`${what}: expected 0x-hex or bytes, got ${typeof v}`);
  const h = v.replace(/^0[xX]/, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new AbiError(`${what}: ${JSON.stringify(v)} is not 0x-hex of whole bytes`);
  return Buffer.from(h, 'hex');
}

function toAddress(v, what) {
  const b = toBytes(v, what);
  if (b.length !== 20) throw new AbiError(`${what}: an address is 20 bytes, got ${b.length}`);
  return b;
}

function toBool(v, what) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1 || v === 1n) return true;
  if (v === 'false' || v === '0' || v === 0 || v === 0n) return false;
  throw new AbiError(`${what}: ${JSON.stringify(v)} is not a boolean`);
}

const padLeft = (b) => Buffer.concat([Buffer.alloc(WORD - b.length), b]);
const padRight = (b) => Buffer.concat([b, Buffer.alloc((WORD - (b.length % WORD)) % WORD)]);

function uintWord(n) {
  const v = n & MASK256;
  let h = v.toString(16);
  if (h.length % 2) h = '0' + h;
  return padLeft(Buffer.from(h, 'hex'));
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

/** One value, as { head, tail } — `head` is what sits in place, `tail` what it points at. */
function encodeValue(type, value, path) {
  switch (type.kind) {
    case 'uint': {
      const n = toBigInt(value, path);
      if (n < 0n) throw new AbiError(`${path}: ${n} is negative for ${canonical(type)}`);
      if (type.bits < 256 && n >= 1n << BigInt(type.bits)) throw new AbiError(`${path}: ${n} does not fit in ${canonical(type)}`);
      return { head: uintWord(n), tail: null };
    }
    case 'int': {
      const n = toBigInt(value, path);
      const lim = 1n << BigInt(type.bits - 1);
      if (n >= lim || n < -lim) throw new AbiError(`${path}: ${n} does not fit in ${canonical(type)}`);
      // Two's complement over the full 256 bits: sign-extension is what makes a
      // negative int128 read correctly as a 32-byte word.
      return { head: uintWord(n & MASK256), tail: null };
    }
    case 'address': return { head: padLeft(toAddress(value, path)), tail: null };
    case 'bool': return { head: uintWord(toBool(value, path) ? 1n : 0n), tail: null };
    case 'bytesN': {
      const b = toBytes(value, path);
      if (b.length !== type.size) throw new AbiError(`${path}: ${canonical(type)} needs exactly ${type.size} bytes, got ${b.length}`);
      // bytesN is LEFT-aligned. Padding it like a number is the other classic bug.
      return { head: Buffer.concat([b, Buffer.alloc(WORD - b.length)]), tail: null };
    }
    case 'bytes': {
      const b = toBytes(value, path);
      return { head: null, tail: Buffer.concat([uintWord(BigInt(b.length)), padRight(b)]) };
    }
    case 'string': {
      const b = Buffer.from(String(value), 'utf8');
      return { head: null, tail: Buffer.concat([uintWord(BigInt(b.length)), padRight(b)]) };
    }
    case 'array': {
      if (!Array.isArray(value)) throw new AbiError(`${path}: expected an array for ${canonical(type)}`);
      if (type.length !== null && value.length !== type.length) {
        throw new AbiError(`${path}: ${canonical(type)} needs ${type.length} elements, got ${value.length}`);
      }
      const body = encodeTuple(value.map(() => type.base), value, path);
      if (type.length === null) return { head: null, tail: Buffer.concat([uintWord(BigInt(value.length)), body]) };
      return isDynamic(type) ? { head: null, tail: body } : { head: body, tail: null };
    }
    case 'tuple': {
      const vals = Array.isArray(value)
        ? value
        : type.names.map((n, i) => {
          if (!n || !(n in Object(value))) throw new AbiError(`${path}: tuple field ${n || i} is missing`);
          return value[n];
        });
      if (vals.length !== type.components.length) {
        throw new AbiError(`${path}: ${canonical(type)} needs ${type.components.length} fields, got ${vals.length}`);
      }
      const body = encodeTuple(type.components, vals, path);
      return isDynamic(type) ? { head: null, tail: body } : { head: body, tail: null };
    }
    default: throw new AbiError(`cannot encode ${type.kind}`);
  }
}

/** The head/tail layout of a tuple's components: the heart of the encoding. */
function encodeTuple(types, values, path = '') {
  const parts = types.map((t, i) => encodeValue(t, values[i], path ? `${path}[${i}]` : `arg ${i}`));
  const headSize = types.reduce((n, t) => n + headWords(t) * WORD, 0);
  const heads = [];
  const tails = [];
  let offset = headSize;
  for (let i = 0; i < types.length; i++) {
    if (parts[i].head !== null) { heads.push(parts[i].head); continue; }
    heads.push(uintWord(BigInt(offset)));
    tails.push(parts[i].tail);
    offset += parts[i].tail.length;
  }
  return Buffer.concat([...heads, ...tails]);
}

/** Encode a parameter list. `types` may be strings, ABI entries or Types. */
function encodeParameters(types, values) {
  const ts = types.map(asType);
  if (values.length !== ts.length) throw new AbiError(`expected ${ts.length} arguments, got ${values.length}`);
  return encodeTuple(ts, values);
}

function asType(t) {
  if (t && typeof t === 'object' && typeof t.kind === 'string') return t;
  return typeFromAbi(t);
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

function readWord(data, at, what) {
  if (at + WORD > data.length) throw new AbiError(`truncated: ${what} needs bytes ${at}..${at + WORD} of ${data.length}`);
  return data.subarray(at, at + WORD);
}

function readUint(data, at, what) {
  return BigInt('0x' + readWord(data, at, what).toString('hex'));
}

/** Offsets are attacker-controlled; a bad one must be an error, not a wild read. */
function checkedOffset(raw, data, what) {
  if (raw > BigInt(data.length)) throw new AbiError(`${what}: offset ${raw} is past the end of ${data.length} bytes`);
  return Number(raw);
}

function decodeValue(type, data, at, base, path) {
  switch (type.kind) {
    case 'uint': return readUint(data, at, path);
    case 'int': {
      const raw = readUint(data, at, path);
      const lim = 1n << BigInt(type.bits - 1);
      const v = raw & ((1n << BigInt(type.bits)) - 1n);
      return v >= lim ? v - (1n << BigInt(type.bits)) : v;
    }
    case 'address': return '0x' + readWord(data, at, path).subarray(12).toString('hex');
    case 'bool': return readUint(data, at, path) !== 0n;
    case 'bytesN': return '0x' + readWord(data, at, path).subarray(0, type.size).toString('hex');
    case 'bytes': case 'string': {
      const start = base + checkedOffset(readUint(data, at, path), data, path);
      const len = Number(readUint(data, start, path + ' length'));
      if (start + WORD + len > data.length) throw new AbiError(`${path}: declared length ${len} runs past the end`);
      const body = data.subarray(start + WORD, start + WORD + len);
      return type.kind === 'bytes' ? '0x' + body.toString('hex') : body.toString('utf8');
    }
    case 'array': {
      if (type.length === null) {
        const start = base + checkedOffset(readUint(data, at, path), data, path);
        const n = Number(readUint(data, start, path + ' length'));
        // A length that could not possibly have a head is a corrupt encoding, not
        // a 4-billion-element array we should try to allocate.
        if (n * WORD > data.length) throw new AbiError(`${path}: declared ${n} elements, more than ${data.length} bytes could hold`);
        return decodeTupleAt(new Array(n).fill(type.base), data, start + WORD, path);
      }
      if (isDynamic(type)) {
        const start = base + checkedOffset(readUint(data, at, path), data, path);
        return decodeTupleAt(new Array(type.length).fill(type.base), data, start, path);
      }
      return decodeTupleAt(new Array(type.length).fill(type.base), data, at, path);
    }
    case 'tuple': {
      const start = isDynamic(type) ? base + checkedOffset(readUint(data, at, path), data, path) : at;
      const values = decodeTupleAt(type.components, data, start, path);
      if (type.names.some(Boolean)) {
        const named = values.slice();
        type.names.forEach((n, i) => { if (n) named[n] = values[i]; });
        return named;
      }
      return values;
    }
    default: throw new AbiError(`cannot decode ${type.kind}`);
  }
}

/** Decode a tuple whose encoding block starts at `start` — its own offset base. */
function decodeTupleAt(types, data, start, path = '') {
  const out = [];
  let at = start;
  for (let i = 0; i < types.length; i++) {
    out.push(decodeValue(types[i], data, at, start, path ? `${path}[${i}]` : `out ${i}`));
    at += headWords(types[i]) * WORD;
  }
  return out;
}

function decodeParameters(types, data) {
  const ts = types.map(asType);
  const buf = toBytes(data, 'return data');
  return decodeTupleAt(ts, buf, 0);
}

// ---------------------------------------------------------------------------
// signatures and selectors
// ---------------------------------------------------------------------------

/** `transfer(address,uint256)` from a name and a parameter list. */
function signature(name, inputs) {
  return `${name}(${inputs.map((i) => canonical(asType(i))).join(',')})`;
}

/** keccak256(signature)[0:4]. */
function selector(sig) { return keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4); }

/** keccak256(signature) — an event's topic0. */
function topicHash(sig) { return keccak256(Buffer.from(sig, 'utf8')); }

/**
 * A callable description from either an ABI JSON array plus a name, or a bare
 * signature string like `balanceOf(address)`. Returns
 * `{ name, signature, selector, inputs, outputs }`.
 */
function resolveFunction(abi, nameOrSig) {
  const sig = String(nameOrSig).trim();
  if (sig.includes('(')) {
    const name = sig.slice(0, sig.indexOf('('));
    const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    // An explicit signature carries no output types; the caller may still supply
    // them with --returns, which is why `outputs` is empty rather than guessed.
    const inputs = splitTop(inner).map(parseType);
    const canonicalSig = signature(name, inputs);
    return { name, signature: canonicalSig, selector: selector(canonicalSig), inputs, outputs: [], from: 'signature' };
  }
  if (!Array.isArray(abi)) throw new AbiError(`no ABI given, so "${sig}" must be a full signature like "balanceOf(address)"`);
  const matches = abi.filter((e) => e && e.type === 'function' && e.name === sig);
  if (matches.length === 0) {
    const known = abi.filter((e) => e && e.type === 'function').map((e) => e.name);
    throw new AbiError(`no function "${sig}" in the ABI${known.length ? ' (has: ' + known.join(', ') + ')' : ''}`);
  }
  if (matches.length > 1) {
    throw new AbiError(`"${sig}" is overloaded in this ABI; name it in full, e.g. "${signature(sig, (matches[0].inputs || []).map(typeFromAbi))}"`);
  }
  const e = matches[0];
  const inputs = (e.inputs || []).map(typeFromAbi);
  const outputs = (e.outputs || []).map(typeFromAbi);
  const canonicalSig = signature(e.name, inputs);
  return {
    name: e.name,
    signature: canonicalSig,
    selector: selector(canonicalSig),
    inputs,
    inputNames: (e.inputs || []).map((i) => i.name || null),
    outputs,
    outputNames: (e.outputs || []).map((o) => o.name || null),
    stateMutability: e.stateMutability || (e.constant ? 'view' : 'nonpayable'),
    from: 'abi',
  };
}

/** The constructor's inputs, or an empty list when the ABI declares none. */
function resolveConstructor(abi) {
  const e = Array.isArray(abi) ? abi.find((x) => x && x.type === 'constructor') : null;
  return e ? (e.inputs || []).map(typeFromAbi) : [];
}

/** selector ++ encoded arguments. */
function encodeCall(fn, values) {
  return Buffer.concat([fn.selector, encodeParameters(fn.inputs, values)]);
}

// ---------------------------------------------------------------------------
// revert reasons
// ---------------------------------------------------------------------------

const ERROR_STRING_SELECTOR = '08c379a0';   // Error(string)
const PANIC_SELECTOR = '4e487b71';          // Panic(uint256)

/** Solidity's compiler-generated panic codes, from the language documentation. */
const PANIC_CODES = Object.freeze({
  0x00: 'generic compiler panic',
  0x01: 'assert(false)',
  0x11: 'arithmetic overflow or underflow',
  0x12: 'division or modulo by zero',
  0x21: 'value out of range for an enum',
  0x22: 'access to an incorrectly encoded storage byte array',
  0x31: '.pop() on an empty array',
  0x32: 'array index out of bounds',
  0x41: 'out of memory, or an array length that is too large',
  0x51: 'call to an uninitialised internal function',
});

/**
 * Decode revert output. Returns null for an empty revert — which is a real and
 * common case (`require(cond)` with no message, and every out-of-gas inside a
 * `try`) and must not be reported as a decoding failure.
 *
 * @returns {null|{kind:'Error'|'Panic'|'custom'|'raw', text:string, ...}}
 */
function decodeRevert(data, abi = null) {
  const buf = Buffer.isBuffer(data) ? data : toBytes(data || '0x', 'revert data');
  if (buf.length === 0) return null;
  if (buf.length < 4) return { kind: 'raw', text: '0x' + buf.toString('hex'), data: '0x' + buf.toString('hex') };

  const sel = buf.subarray(0, 4).toString('hex');
  const body = buf.subarray(4);

  if (sel === ERROR_STRING_SELECTOR) {
    try {
      const [message] = decodeTupleAt([{ kind: 'string' }], body, 0);
      return { kind: 'Error', selector: '0x' + sel, message, text: `Error(${JSON.stringify(message)})` };
    } catch (e) {
      return { kind: 'raw', selector: '0x' + sel, text: `Error(string) with undecodable payload: ${e.message}`, data: '0x' + buf.toString('hex') };
    }
  }

  if (sel === PANIC_SELECTOR) {
    try {
      const [code] = decodeTupleAt([{ kind: 'uint', bits: 256 }], body, 0);
      const why = PANIC_CODES[Number(code)] || 'unknown panic code';
      return { kind: 'Panic', selector: '0x' + sel, code, text: `Panic(0x${code.toString(16)}: ${why})` };
    } catch {
      return { kind: 'raw', selector: '0x' + sel, text: 'Panic(uint256) with undecodable payload', data: '0x' + buf.toString('hex') };
    }
  }

  // A custom error we have an ABI for decodes fully; one we do not is shown as
  // its 4-byte selector plus raw 32-byte words, which is still enough to look up
  // on a signature database and to see the arguments.
  if (Array.isArray(abi)) {
    for (const e of abi) {
      if (!e || e.type !== 'error') continue;
      const inputs = (e.inputs || []).map(typeFromAbi);
      if (selector(signature(e.name, inputs)).toString('hex') !== sel) continue;
      try {
        const args = decodeTupleAt(inputs, body, 0);
        return {
          kind: 'custom', name: e.name, selector: '0x' + sel, args,
          signature: signature(e.name, inputs),
          text: `${e.name}(${args.map(formatValue).join(', ')})`,
        };
      } catch { /* fall through to the raw rendering */ }
    }
  }

  const words = [];
  for (let i = 0; i + WORD <= body.length; i += WORD) words.push('0x' + body.subarray(i, i + WORD).toString('hex'));
  const trailing = body.length % WORD ? ['0x' + body.subarray(body.length - (body.length % WORD)).toString('hex') + ' (partial word)'] : [];
  const all = [...words, ...trailing];
  return {
    kind: 'custom', name: null, selector: '0x' + sel, args: all,
    text: `custom error 0x${sel}${all.length ? '(' + all.join(', ') + ')' : '()'}`,
  };
}

/** How the CLI prints one decoded value. */
function formatValue(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v.startsWith('0x') ? v : JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(formatValue).join(', ') + ']';
  return String(v);
}

module.exports = {
  AbiError, WORD,
  parseType, typeFromAbi, canonical, isDynamic, headWords, splitTop,
  encodeParameters, decodeParameters, encodeTuple, decodeTupleAt,
  signature, selector, topicHash, resolveFunction, resolveConstructor, encodeCall,
  decodeRevert, formatValue,
  PANIC_CODES, ERROR_STRING_SELECTOR, PANIC_SELECTOR,
};
