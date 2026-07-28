'use strict';
/* Conformance fixture loader.
 *
 * Parses the four `ethereum/tests` JSON shapes we gate on into ONE normalised
 * vector object per executable case, so the runner and every future EVM
 * component see a single stable representation instead of the fixtures' many
 * historical conventions.
 *
 * Shapes supported (see README.md for provenance):
 *   RLPTests          { name: { in, out } }                  -> kind 'rlp'
 *   TrieTests         { name: { in, root } }                 -> kind 'trie'
 *   VMTests           { name: { env, exec, pre, ... } }       -> kind 'vm'
 *   GeneralStateTests { name: { env, pre, transaction, post } } -> kind 'state'
 *
 * Zero dependencies. Node 22+. CommonJS.
 */

const fs = require('fs');
const path = require('path');

const SUITES = ['RLPTests', 'TrieTests', 'VMTests', 'GeneralStateTests'];

/* We target Shanghai (docs/evm-spec.md §1). GeneralStateTests carry post
 * sections for every fork ever shipped; everything that is not this list is
 * SKIPPED WITH A COUNT, never silently dropped. */
const TARGET_FORKS = ['Shanghai'];

const ZERO_WORD = '0x' + '0'.repeat(64);

// ---------------------------------------------------------------------------
// primitive coercions
// ---------------------------------------------------------------------------

function isHexish(s) {
  return typeof s === 'string' && (s.startsWith('0x') || s.startsWith('0X'));
}

/** '0x1234' | '1234' | Buffer -> Buffer. Odd-length hex is left-padded. */
function hexToBuf(v) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'number' || typeof v === 'bigint') return intToBuf(BigInt(v));
  if (typeof v !== 'string') throw new TypeError('cannot read hex from ' + typeof v);
  if (BIGINT_ESCAPE.test(v)) return hexToBuf(v.replace(BIGINT_ESCAPE, ''));
  let h = isHexish(v) ? v.slice(2) : v;
  if (h.length % 2 === 1) h = '0' + h;
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error('not hex: ' + JSON.stringify(v));
  return Buffer.from(h, 'hex');
}

function bufToHex(b) {
  if (b === null || b === undefined) return null;
  if (typeof b === 'string') return b.startsWith('0x') ? b.toLowerCase() : '0x' + b.toLowerCase();
  return '0x' + Buffer.from(b).toString('hex');
}

/* retesteth escapes any quantity that will not fit in 256 bits as
 * `0x:bigint 0x<hex>` (see stTransactionTest/ValueOverflowParis.json). Parsing
 * that as plain hex throws; ignoring it would drop a vector whose whole point is
 * that the transaction must be REJECTED for overflowing. */
const BIGINT_ESCAPE = /^\s*\S*:bigint\s+/;

/** Fixtures write quantities as 0x-hex, as decimal strings, or as JSON numbers. */
function toBigInt(v) {
  if (v === null || v === undefined || v === '') return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && BIGINT_ESCAPE.test(v)) return toBigInt(v.replace(BIGINT_ESCAPE, ''));
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw new Error('fixture used an unsafe JSON number (' + v + '); it must be a "#" bignum or 0x-hex');
    }
    return BigInt(v);
  }
  if (Buffer.isBuffer(v)) return v.length ? BigInt('0x' + v.toString('hex')) : 0n;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0n;
    if (isHexish(s)) return BigInt(s.length % 2 ? '0x0' + s.slice(2) : s);
    return BigInt(s);
  }
  throw new TypeError('cannot read a quantity from ' + typeof v);
}

/** Minimal big-endian encoding; 0 is the empty string, per Ethereum convention. */
function intToBuf(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error('negative integers have no RLP encoding');
  if (v === 0n) return Buffer.alloc(0);
  let h = v.toString(16);
  if (h.length % 2) h = '0' + h;
  return Buffer.from(h, 'hex');
}

/** Canonical 32-byte hex, so `0x00` and `0x000…0` compare equal. */
function normWord(v) {
  const b = hexToBuf(v);
  if (b.length > 32) throw new Error('word longer than 32 bytes: ' + bufToHex(b));
  return '0x' + Buffer.concat([Buffer.alloc(32 - b.length), b]).toString('hex');
}

/** Canonical 20-byte lower-case hex address. */
function normAddress(v) {
  if (v === null || v === undefined || v === '') return null;
  const b = hexToBuf(v);
  if (b.length > 20) throw new Error('address longer than 20 bytes: ' + bufToHex(b));
  return '0x' + Buffer.concat([Buffer.alloc(20 - b.length), b]).toString('hex');
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

/* A slot holding zero is indistinguishable from an absent slot in the EVM, so
 * both sides are normalised the same way. Without this an implementation that
 * journals explicit zeroes would show phantom divergences. */
function normStorage(storage) {
  const out = {};
  for (const [k, v] of Object.entries(storage || {})) {
    const val = normWord(v);
    if (val === ZERO_WORD) continue;
    out[normWord(k)] = val;
  }
  return out;
}

/**
 * Normalise a fixture (or implementation) account map.
 * -> { '0x<20 bytes>': { nonce: BigInt, balance: BigInt, code: Buffer, storage: {word: word} } }
 */
function normAccounts(accounts) {
  const out = {};
  for (const [addr, a] of Object.entries(accounts || {})) {
    out[normAddress(addr)] = {
      nonce: toBigInt(a && a.nonce),
      balance: toBigInt(a && a.balance),
      code: hexToBuf((a && a.code) || '0x'),
      storage: normStorage(a && a.storage),
    };
  }
  return out;
}

/* Env keys are `currentX` in every fixture generation; the normalised form drops
 * the prefix. `raw` is preserved so an implementation can reach anything we did
 * not anticipate without the loader needing a change. */
function normEnv(env) {
  const e = env || {};
  const out = {
    coinbase: normAddress(e.currentCoinbase),
    difficulty: e.currentDifficulty === undefined ? null : toBigInt(e.currentDifficulty),
    gasLimit: toBigInt(e.currentGasLimit),
    number: toBigInt(e.currentNumber),
    timestamp: toBigInt(e.currentTimestamp),
    baseFee: e.currentBaseFee === undefined ? null : toBigInt(e.currentBaseFee),
    random: e.currentRandom === undefined ? null : normWord(e.currentRandom),
    excessBlobGas: e.currentExcessBlobGas === undefined ? null : toBigInt(e.currentExcessBlobGas),
    previousHash: e.previousHash === undefined ? null : bufToHex(hexToBuf(e.previousHash)),
    raw: e,
  };
  return out;
}

// ---------------------------------------------------------------------------
// suite inference and file discovery
// ---------------------------------------------------------------------------

/** Infer the suite from any path segment. Returns null when nothing matches. */
function inferSuite(file) {
  const parts = path.resolve(file).split(path.sep);
  // Deepest match wins: LegacyTests/Cancun/GeneralStateTests/VMTests/... is a
  // GeneralStateTests subdirectory that is confusingly *named* VMTests, and the
  // outer directory is the truthful one, so scan outermost-first.
  for (const p of parts) if (SUITES.includes(p)) return p;
  const base = path.basename(file).toLowerCase();
  if (base.includes('rlp')) return 'RLPTests';
  if (base.includes('trie')) return 'TrieTests';
  return null;
}

/** Recursively collect *.json under `root` (a file path is returned as-is). */
function findFixtureFiles(root) {
  const abs = path.resolve(root);
  let st;
  try { st = fs.statSync(abs); } catch { return []; }
  if (st.isFile()) return abs.endsWith('.json') ? [abs] : [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...findFixtureFiles(p));
    else if (entry.name.endsWith('.json')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// RLPTests
// ---------------------------------------------------------------------------

/**
 * Translate an RLPTests `in` value into the byte-string / list tree that RLP is
 * actually defined over.
 *   array          -> array (recursive)
 *   JSON number    -> minimal big-endian bytes
 *   "#<decimal>"   -> minimal big-endian bytes (bignum escape)
 *   "0x…"          -> those bytes
 *   any other str  -> its UTF-8 bytes
 * Integers are resolved HERE on purpose: RLP is defined over byte strings and
 * lists only, so an implementation is not required to guess integer semantics.
 */
function parseRlpInput(v) {
  if (Array.isArray(v)) return v.map(parseRlpInput);
  if (typeof v === 'number' || typeof v === 'bigint') return intToBuf(toBigInt(v));
  if (typeof v === 'string') {
    if (v.startsWith('#')) return intToBuf(BigInt(v.slice(1)));
    if (isHexish(v)) return hexToBuf(v);
    return Buffer.from(v, 'utf8');
  }
  throw new Error('unsupported RLP input: ' + JSON.stringify(v));
}

function parseRlpFile(json, ctx) {
  const vectors = [];
  for (const [name, body] of Object.entries(json)) {
    if (name === '_info') continue;
    const marker = typeof body.in === 'string' ? body.in : null;
    const invalid = marker === 'INVALID';
    const validOnly = marker === 'VALID';
    vectors.push({
      kind: 'rlp',
      suite: 'RLPTests',
      file: ctx.file,
      relFile: ctx.relFile,
      case: name,
      name: ctx.relFile + '::' + name,
      valid: !invalid,
      /* null for the INVALID/VALID markers: those assert decoder behaviour only. */
      value: invalid || validOnly ? null : parseRlpInput(body.in),
      out: bufToHex(hexToBuf(body.out)),
      outBytes: hexToBuf(body.out),
      raw: body,
    });
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// TrieTests
// ---------------------------------------------------------------------------

function parseTrieKey(v) {
  if (v === null || v === undefined) return null;
  if (isHexish(v)) return hexToBuf(v);
  return Buffer.from(String(v), 'utf8');
}

function parseTrieFile(json, ctx) {
  /* The secure (keccak-hashed key) variant is signalled only by the filename;
   * the JSON body of trietest.json and trietest_secureTrie.json is identical
   * apart from the expected roots. */
  const secure = /secure_?trie/i.test(path.basename(ctx.file));
  const vectors = [];
  const skipped = [];
  for (const [name, body] of Object.entries(json)) {
    if (name === '_info') continue;
    /* trietestnextprev.json shares the directory but not the shape: it asserts
     * iteration order via a `tests` array and publishes no root. Parsing it as a
     * root vector would silently assert `root === '0x'` and pass forever. */
    if (body.root === undefined) {
      skipped.push({
        file: ctx.file,
        relFile: ctx.relFile,
        case: name,
        fork: null,
        count: 1,
        reason: body.tests
          ? 'trie next/prev iteration fixture — asserts traversal, not a root'
          : 'trie fixture has no `root` field',
      });
      continue;
    }
    const ordered = Array.isArray(body.in);
    let pairs;
    if (ordered) {
      /* Ordered form: replays inserts and deletes in sequence. A null value is
       * a DELETE, and the intermediate roots are not checked — only the final. */
      pairs = body.in.map(([k, v]) => [parseTrieKey(k), v === null ? null : parseTrieKey(v)]);
    } else {
      /* "anyorder" form: the root must not depend on insertion order. */
      pairs = Object.entries(body.in).map(([k, v]) => [parseTrieKey(k), v === null ? null : parseTrieKey(v)]);
    }
    vectors.push({
      kind: 'trie',
      suite: 'TrieTests',
      file: ctx.file,
      relFile: ctx.relFile,
      case: name,
      name: ctx.relFile + '::' + name,
      secure,
      ordered,
      pairs,
      root: bufToHex(hexToBuf(body.root)),
      raw: body,
    });
  }
  return { vectors, skipped };
}

// ---------------------------------------------------------------------------
// VMTests
// ---------------------------------------------------------------------------

function parseExec(exec) {
  const x = exec || {};
  return {
    address: normAddress(x.address),
    caller: normAddress(x.caller),
    origin: normAddress(x.origin),
    code: hexToBuf(x.code || '0x'),
    data: hexToBuf(x.data || '0x'),
    gas: toBigInt(x.gas),
    gasPrice: toBigInt(x.gasPrice),
    value: toBigInt(x.value),
    raw: x,
  };
}

function parseVmFile(json, ctx) {
  const vectors = [];
  for (const [name, body] of Object.entries(json)) {
    if (name === '_info') continue;
    /* A VMTest that expects an exception omits post/gas/out/logs entirely. That
     * absence IS the assertion: execution must fail and consume all gas. */
    const expectException = body.post === undefined;
    vectors.push({
      kind: 'vm',
      suite: 'VMTests',
      file: ctx.file,
      relFile: ctx.relFile,
      case: name,
      name: ctx.relFile + '::' + name,
      env: normEnv(body.env),
      exec: parseExec(body.exec),
      pre: normAccounts(body.pre),
      post: expectException ? null : normAccounts(body.post),
      expectException,
      /* `gas` in VMTests is gas REMAINING after execution, not gas used. */
      gasRemaining: expectException ? null : toBigInt(body.gas),
      out: expectException ? null : bufToHex(hexToBuf(body.out || '0x')),
      /* `logs` is keccak256(rlp(logs)), not the log list. */
      logsHash: expectException || body.logs === undefined ? null : bufToHex(hexToBuf(body.logs)),
      callcreates: body.callcreates || null,
      raw: body,
    });
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// GeneralStateTests
// ---------------------------------------------------------------------------

function parseAccessList(list) {
  if (list === null || list === undefined) return null;
  return list.map((e) => ({
    address: normAddress(e.address),
    storageKeys: (e.storageKeys || []).map(normWord),
  }));
}

/**
 * Build the concrete transaction for one (data, gas, value) index triple.
 *
 * THE SUBTLE PART. `transaction.data`, `.gasLimit` and `.value` are ARRAYS, and
 * each post entry's `indexes` picks one element from each. Note the index key
 * for gasLimit is `gas`, NOT `gasLimit`. `accessLists`, when present, is
 * parallel to `data` and indexed by the DATA index.
 */
function selectTransaction(tx, indexes) {
  const dataList = tx.data || [];
  const gasList = tx.gasLimit || [];
  const valueList = tx.value || [];
  if (indexes.data >= dataList.length) throw new Error('data index ' + indexes.data + ' out of range (' + dataList.length + ')');
  if (indexes.gas >= gasList.length) throw new Error('gas index ' + indexes.gas + ' out of range (' + gasList.length + ')');
  if (indexes.value >= valueList.length) throw new Error('value index ' + indexes.value + ' out of range (' + valueList.length + ')');

  const accessList = tx.accessLists ? parseAccessList(tx.accessLists[indexes.data]) : null;
  const hasFeeMarket = tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined;
  const type = hasFeeMarket ? 2 : accessList ? 1 : 0;

  return {
    type,
    nonce: toBigInt(tx.nonce),
    gasPrice: tx.gasPrice === undefined ? null : toBigInt(tx.gasPrice),
    maxFeePerGas: tx.maxFeePerGas === undefined ? null : toBigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas === undefined ? null : toBigInt(tx.maxPriorityFeePerGas),
    gasLimit: toBigInt(gasList[indexes.gas]),
    /* An empty `to` means contract creation. */
    to: tx.to === '' || tx.to === undefined || tx.to === null ? null : normAddress(tx.to),
    value: toBigInt(valueList[indexes.value]),
    data: hexToBuf(dataList[indexes.data]),
    sender: normAddress(tx.sender),
    secretKey: tx.secretKey ? hexToBuf(tx.secretKey) : null,
    accessList,
  };
}

/* `indexes` entries are normally a single number, but -1 means "every element
 * of that array" and a few fixtures use an explicit list. Expand all forms. */
function expandIndex(value, length) {
  if (Array.isArray(value)) return value.map(Number);
  const n = Number(value);
  if (n === -1) return Array.from({ length }, (_, i) => i);
  return [n];
}

function parseStateFile(json, ctx) {
  const forks = ctx.forks || TARGET_FORKS;
  const vectors = [];
  const skipped = [];
  for (const [name, body] of Object.entries(json)) {
    if (name === '_info') continue;
    const env = normEnv(body.env);
    const pre = normAccounts(body.pre);
    const tx = body.transaction || {};
    const nData = (tx.data || []).length;
    const nGas = (tx.gasLimit || []).length;
    const nValue = (tx.value || []).length;

    for (const [fork, entries] of Object.entries(body.post || {})) {
      if (!forks.includes(fork)) {
        skipped.push({
          file: ctx.file,
          relFile: ctx.relFile,
          case: name,
          fork,
          count: (entries || []).length,
          reason: 'fork not targeted',
        });
        continue;
      }
      for (const entry of entries || []) {
        if (entry.hash === undefined) {
          skipped.push({ file: ctx.file, relFile: ctx.relFile, case: name, fork, count: 1, reason: 'post entry publishes no expected state root' });
          continue;
        }
        const idx = entry.indexes || {};
        for (const d of expandIndex(idx.data === undefined ? 0 : idx.data, nData)) {
          for (const g of expandIndex(idx.gas === undefined ? 0 : idx.gas, nGas)) {
            for (const v of expandIndex(idx.value === undefined ? 0 : idx.value, nValue)) {
              const indexes = { data: d, gas: g, value: v };
              vectors.push({
                kind: 'state',
                suite: 'GeneralStateTests',
                file: ctx.file,
                relFile: ctx.relFile,
                case: name,
                fork,
                indexes,
                name: ctx.relFile + '::' + name + '::' + fork + '::d' + d + 'g' + g + 'v' + v,
                env,
                pre,
                tx: selectTransaction(tx, indexes),
                expectRoot: bufToHex(hexToBuf(entry.hash)),
                expectLogsHash: entry.logs === undefined ? null : bufToHex(hexToBuf(entry.logs)),
                /* Present on modern fixtures; the signed RLP of the exact tx we
                 * are meant to run. Invaluable when a root mismatch turns out to
                 * be a tx-encoding bug rather than an execution bug. */
                txbytes: entry.txbytes ? bufToHex(hexToBuf(entry.txbytes)) : null,
                /* e.g. "TR_IntrinsicGas": the transaction must be REJECTED. */
                expectException: entry.expectException || null,
                raw: entry,
              });
            }
          }
        }
      }
    }
    if (!body.post || Object.keys(body.post).length === 0) {
      skipped.push({ file: ctx.file, relFile: ctx.relFile, case: name, fork: null, count: 0, reason: 'no post section' });
    }
  }
  return { vectors, skipped };
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

const PARSERS = {
  RLPTests: parseRlpFile,
  TrieTests: parseTrieFile,
  VMTests: parseVmFile,
  GeneralStateTests: parseStateFile,
};

/**
 * Load one fixture file.
 * @param {string} file
 * @param {{suite?:string, root?:string, forks?:string[]}} [opts]
 * @returns {{suite, file, relFile, vectors: object[], skipped: object[]}}
 */
function loadFile(file, opts = {}) {
  const abs = path.resolve(file);
  const suite = opts.suite || inferSuite(abs);
  if (!suite) throw new Error('cannot infer suite for ' + abs + ' (pass { suite })');
  if (!PARSERS[suite]) throw new Error('unknown suite ' + suite + '; expected one of ' + SUITES.join(', '));
  const relFile = opts.root ? path.relative(path.resolve(opts.root), abs) : path.basename(abs);
  const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const ctx = { file: abs, relFile, forks: opts.forks };
  const parsed = PARSERS[suite](json, ctx);
  const vectors = Array.isArray(parsed) ? parsed : parsed.vectors;
  const skipped = Array.isArray(parsed) ? [] : parsed.skipped;
  return { suite, file: abs, relFile, vectors, skipped };
}

/**
 * Load every fixture under a directory tree.
 * @param {string} root
 * @param {{suite?:string, forks?:string[], filter?:RegExp|string|function}} [opts]
 */
function loadTree(root, opts = {}) {
  const abs = path.resolve(root);
  const files = findFixtureFiles(abs);
  const vectors = [];
  const skipped = [];
  const errors = [];
  for (const file of files) {
    /* Infer first, THEN apply the requested suite. Reversing these makes a
     * request for one suite parse every file in the tree as that suite. */
    const inferred = inferSuite(file);
    if (opts.suite && inferred && inferred !== opts.suite) continue;
    const suite = opts.suite || inferred;
    if (!suite) { errors.push({ file, error: 'cannot infer suite' }); continue; }
    try {
      const r = loadFile(file, { suite, root: abs, forks: opts.forks });
      vectors.push(...r.vectors);
      skipped.push(...r.skipped);
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }
  return { root: abs, files, vectors, skipped, errors };
}

/** Build a predicate from a regex, a substring, or a function. */
function makeFilter(filter) {
  if (!filter) return () => true;
  if (typeof filter === 'function') return filter;
  if (filter instanceof RegExp) return (v) => filter.test(v.name);
  const s = String(filter);
  let re = null;
  try { re = new RegExp(s); } catch { /* treat as a literal substring */ }
  return (v) => v.name.includes(s) || (re ? re.test(v.name) : false);
}

module.exports = {
  SUITES,
  TARGET_FORKS,
  ZERO_WORD,
  // discovery
  inferSuite,
  findFixtureFiles,
  loadFile,
  loadTree,
  makeFilter,
  // per-shape parsers (exported for targeted tests)
  parseRlpFile,
  parseTrieFile,
  parseVmFile,
  parseStateFile,
  parseRlpInput,
  selectTransaction,
  expandIndex,
  // coercions, shared with report.js and available to implementations
  hexToBuf,
  bufToHex,
  toBigInt,
  intToBuf,
  normWord,
  normAddress,
  normAccounts,
  normStorage,
  normEnv,
};
