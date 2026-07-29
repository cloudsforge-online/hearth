'use strict';
/* JSON-RPC layer tests. Zero-dependency mini harness.
 * Run: node test/jsonrpc.js
 *
 * Driven against an in-memory fake chain implementing exactly the interface
 * documented at the top of src/jsonrpc/methods.js — which is phase 5's brief.
 * If phase 5 lands something this fake could not stand in for, one of the two
 * is wrong and this suite is where that argument gets settled.
 *
 * The encoding rules get the hardest treatment, because that is where a
 * home-made RPC fails silently rather than loudly: swap QUANTITY and DATA and
 * nothing throws, MetaMask just shows the wrong balance a week later. Every
 * assertion below was mutation-tested — quantity/data swapped, a block field
 * dropped, topic OR-matching broken, the bloom's byte order reversed — and each
 * mutation drops the score.
 */

const H = require('../src/jsonrpc/hex');
const M = require('../src/jsonrpc/methods');
const { JsonRpcServer, FilterRegistry } = require('../src/jsonrpc/server');
const { keccak256 } = require('../src/crypto/keccak');
const http = require('http');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
const show = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
function eq(actual, expected, msg) {
  const a = show(actual), b = show(expected);
  if (a === b) { pass++; } else { fail++; console.log(`  ✗ ${msg}\n      want ${b}\n      got  ${a}`); }
}
function group(name) { console.log('• ' + name); }

/** Assert a call rejects with a specific JSON-RPC error code. */
async function throwsCode(fn, code, msg) {
  try { await fn(); } catch (e) {
    if (e && e.code === code) { pass++; return e; }
    fail++; console.log(`  ✗ ${msg} — wanted code ${code}, got ${e && e.code} (${e && e.message})`);
    return e;
  }
  fail++; console.log(`  ✗ ${msg} — did not throw`);
  return null;
}

const hb = h => Buffer.from(h, 'hex');
const pad32 = h => hb(h.padStart(64, '0'));

// ---- the fake chain --------------------------------------------------------

const ADDR_ALICE = hb('aa'.repeat(20));
const ADDR_BOB = hb('bb'.repeat(20));
const ADDR_TOKEN = hb('c0'.repeat(20));
const ADDR_TOKEN2 = hb('d1'.repeat(20));
const ADDR_MINER = hb('11'.repeat(20));
const ADDR_NEW = hb('ee'.repeat(20));
const CODE = hb('6080604052600080fd');

const T_TRANSFER = pad32('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
const T_APPROVAL = pad32('8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925');
const T_ALICE = Buffer.concat([Buffer.alloc(12), ADDR_ALICE]);
const T_BOB = Buffer.concat([Buffer.alloc(12), ADDR_BOB]);

/* Bloom, geth's bloom9 convention: three 11-bit indices taken from the first
 * six bytes of keccak256(item), counted from the low end of a 256-byte filter.
 * chain/bloom.js (phase 4) owns this for real; it is here so the fake can build
 * headers the way a real block will. */
function bloomAdd(bloom, item) {
  const h = keccak256(item);
  for (let i = 0; i < 6; i += 2) {
    const bit = ((h[i] << 8) | h[i + 1]) & 0x7ff;
    bloom[255 - (bit >> 3)] |= 1 << (bit & 7);
  }
  return bloom;
}
function bloomFor(logs) {
  const b = Buffer.alloc(256);
  for (const l of logs) { bloomAdd(b, l.address); for (const t of l.topics) bloomAdd(b, t); }
  return b;
}

function h32(seed) { return keccak256(Buffer.from(seed, 'utf8')); }

// three blocks of history plus an empty tip
const BLOCKS = [];
const TXS = new Map();
const RECEIPTS = new Map();
const BLOCK_RECEIPTS = new Map();

function mkTx(o) {
  return {
    hash: h32('tx:' + o.tag), nonce: o.nonce, from: o.from, to: o.to === undefined ? null : o.to,
    value: o.value, gasPrice: 1_000_000_000n, gas: 100_000n, input: o.input || Buffer.alloc(0),
    v: o.v === undefined ? 14858n : o.v, r: 0x0fn, s: 0xdeadbeefn,
    chainId: o.chainId === undefined ? 7411n : o.chainId,
    blockHash: null, blockNumber: null, transactionIndex: null,
  };
}

function mkBlock(number, txs, receipts) {
  const hash = h32('block:' + number);
  const logs = receipts.flatMap(r => r.logs);
  const block = {
    number: BigInt(number),
    hash,
    parentHash: number === 0 ? Buffer.alloc(32) : h32('block:' + (number - 1)),
    nonce: hb('0000000000000007'),
    mixHash: h32('pow:' + number),
    logsBloom: bloomFor(logs),
    transactionsRoot: h32('txroot:' + number),
    stateRoot: h32('stateroot:' + number),
    receiptsRoot: h32('receiptsroot:' + number),
    miner: ADDR_MINER,
    difficulty: number === 0 ? 0n : 1_048_576n,
    totalDifficulty: BigInt(number) * 1_048_576n,
    extraData: number === 0 ? Buffer.alloc(0) : Buffer.from('hearth', 'utf8'),
    size: 517n + BigInt(number),
    gasLimit: 30_000_000n,
    gasUsed: receipts.length ? receipts[receipts.length - 1].cumulativeGasUsed : 0n,
    timestamp: BigInt(1_760_000_000 + number * 15),
    transactions: txs,
  };
  txs.forEach((t, i) => {
    t.blockHash = hash; t.blockNumber = block.number; t.transactionIndex = BigInt(i);
    TXS.set(t.hash.toString('hex'), t);
  });
  receipts.forEach(r => {
    r.blockHash = hash; r.blockNumber = block.number;
    r.logsBloom = bloomFor(r.logs);
    RECEIPTS.set(r.transactionHash.toString('hex'), r);
  });
  BLOCK_RECEIPTS.set(number, receipts);
  BLOCKS.push(block);
  return block;
}

mkBlock(0, [], []);

{
  const tx1 = mkTx({ tag: 'a', nonce: 0n, from: ADDR_ALICE, to: ADDR_TOKEN, value: 0n, input: hb('a9059cbb') });
  const tx2 = mkTx({ tag: 'b', nonce: 1n, from: ADDR_ALICE, to: ADDR_BOB, value: 10n ** 18n });
  const r1 = {
    transactionHash: tx1.hash, transactionIndex: 0n, from: ADDR_ALICE, to: ADDR_TOKEN,
    cumulativeGasUsed: 52_000n, gasUsed: 52_000n, effectiveGasPrice: 1_000_000_000n,
    contractAddress: null, status: 1,
    logs: [
      { address: ADDR_TOKEN, topics: [T_TRANSFER, T_ALICE, T_BOB], data: pad32('64'),
        blockNumber: 1n, blockHash: h32('block:1'), transactionHash: tx1.hash,
        transactionIndex: 0n, logIndex: 0n, removed: false },
      // Deliberately missing its block/transaction context, to exercise the
      // fill-from-receipt path a lenient phase-5 implementation will lean on.
      // logIndex is NOT optional though — it counts across the block, so one
      // receipt cannot derive it, and the formatter refuses rather than
      // inventing a per-receipt number that collides with the next receipt's.
      { address: ADDR_TOKEN2, topics: [T_APPROVAL, T_ALICE], data: Buffer.alloc(0), logIndex: 1n },
    ],
  };
  const r2 = {
    transactionHash: tx2.hash, transactionIndex: 1n, from: ADDR_ALICE, to: ADDR_BOB,
    cumulativeGasUsed: 73_000n, gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n,
    contractAddress: null, status: 0, logs: [],
  };
  mkBlock(1, [tx1, tx2], [r1, r2]);
}

{
  const tx3 = mkTx({ tag: 'c', nonce: 2n, from: ADDR_ALICE, to: null, value: 0n, input: CODE, chainId: null, v: 27n });
  const r3 = {
    transactionHash: tx3.hash, transactionIndex: 0n, from: ADDR_ALICE, to: null,
    cumulativeGasUsed: 120_000n, gasUsed: 120_000n, effectiveGasPrice: 1_000_000_000n,
    contractAddress: ADDR_NEW, status: 1,
    logs: [
      { address: ADDR_TOKEN, topics: [T_TRANSFER, T_BOB, T_ALICE], data: pad32('01'),
        blockNumber: 2n, blockHash: h32('block:2'), transactionHash: tx3.hash,
        transactionIndex: 0n, logIndex: 0n, removed: false },
    ],
  };
  mkBlock(2, [tx3], [r3]);
}

mkBlock(3, [], []);

const PENDING_TX = mkTx({ tag: 'pending', nonce: 3n, from: ADDR_ALICE, to: ADDR_BOB, value: 5n });
TXS.set(PENDING_TX.hash.toString('hex'), PENDING_TX);

/** Balances/nonces/code/storage as of a height; 'pending' adds the mempool. */
function stateAt(at) {
  const n = at === 'pending' ? 4 : Number(at);
  return {
    balance: a => (a.equals(ADDR_ALICE) ? (n === 0 ? 0n : 1_000n * 10n ** 18n)
      : a.equals(ADDR_BOB) ? (n >= 1 ? 10n ** 18n : 0n) : 0n),
    nonce: a => (a.equals(ADDR_ALICE) ? BigInt(Math.min(n, 4)) : 0n),
    code: a => ((a.equals(ADDR_TOKEN) && n >= 1) ? CODE : Buffer.alloc(0)),
    storage: (a, k) => ((a.equals(ADDR_TOKEN) && n >= 1 && k[31] === 1) ? pad32('2a') : Buffer.alloc(32)),
  };
}

const REVERT_STRING = Buffer.concat([
  hb('08c379a0'), pad32('20'), pad32('16'),
  Buffer.concat([Buffer.from('ERC20: transfer failed', 'utf8'), Buffer.alloc(10)]),
]);
const REVERT_CUSTOM = Buffer.concat([hb('1e4fbdf7'), Buffer.concat([Buffer.alloc(12), ADDR_BOB])]);

const chain = {
  receiptFetches: [],
  useBloomMatches: true,
  throwNext: null,

  chainId: () => 7411n,
  blockNumber: () => 3n,
  gasPrice: () => 1_000_000_000n,

  getBalance: (a, at) => stateAt(at).balance(a),
  getNonce: (a, at) => stateAt(at).nonce(a),
  getCode: (a, at) => stateAt(at).code(a),
  getStorageAt: (a, k, at) => stateAt(at).storage(a, k),

  getBlockByNumber(n, fullTx) {
    if (chain.throwNext) { const e = chain.throwNext; chain.throwNext = null; throw e; }
    const b = BLOCKS[Number(n)];
    if (!b) return null;
    // the cheap path a real chain takes when the caller only wants hashes
    return fullTx ? b : { ...b, transactions: b.transactions.map(t => t.hash) };
  },
  getBlockByHash(h, fullTx) {
    const b = BLOCKS.find(x => x.hash.equals(h));
    return b ? chain.getBlockByNumber(b.number, fullTx) : null;
  },
  getTransactionByHash: h => TXS.get(h.toString('hex')) || null,
  getTransactionReceipt: h => RECEIPTS.get(h.toString('hex')) || null,
  getBlockReceipts(n) {
    chain.receiptFetches.push(Number(n));
    return BLOCK_RECEIPTS.get(Number(n)) || [];
  },

  call(msg) {
    if (msg.data && msg.data.length >= 4) {
      const sel = msg.data.subarray(0, 4).toString('hex');
      if (sel === 'deadbeef') return { ok: false, reverted: true, returnData: REVERT_STRING };
      if (sel === 'cafebabe') return { ok: false, reverted: true, returnData: REVERT_CUSTOM };
      if (sel === 'baadf00d') return { ok: false, reverted: true, returnData: Buffer.alloc(0) };
      if (sel === '00000001') return { ok: false, error: 'out of gas' };
      // The chain gave up on its wall clock. Not an EVM outcome and not a revert;
      // the interface comment in methods.js lists it as its own ExecResult shape.
      if (sel === '00000002') return { ok: false, timeout: true, error: 'execution timeout' };
    }
    return { ok: true, returnData: pad32('7b') };
  },
  estimateGas(msg) {
    // a real estimator executes, so a reverting call reverts here too
    const r = chain.call(msg);
    if (!r.ok) return r;
    return { ok: true, returnData: Buffer.alloc(0), gas: msg.data && msg.data.length ? 53_112n : 21_000n };
  },
  sendRawTransaction(raw) {
    if (raw[0] === 0x00) return { ok: false, error: 'nonce too low' };
    return { ok: true, hash: h32('tx:pending') };
  },

  /* ---- the node, as opposed to the chain -------------------------------
   * methods.js registers net_peerCount / eth_mining / eth_hashrate /
   * eth_coinbase / txpool_status / eth_newPendingTransactionFilter ONLY when
   * the chain supplies the corresponding function. This fake supplies them all;
   * the group below also builds one that supplies none, and asserts that the
   * methods are then absent rather than answering a confident zero. */
  peerCount: () => 3n,
  mining: () => true,
  hashrate: () => 1234n,
  coinbase: () => ADDR_MINER,
  txpoolStatus: () => ({ pending: 2n, queued: 1n }),
  /** A stand-in for the mempool's bounded admission journal. */
  pendingJournal: [],
  pendingSince(cursor) {
    const end = chain.pendingJournal.length;
    if (cursor === null || cursor === undefined || cursor > end) return { cursor: end, hashes: [] };
    return { cursor: end, hashes: chain.pendingJournal.slice(cursor) };
  },
};

function bloomMatchesImpl(bloom, item) {
  const h = keccak256(item);
  for (let i = 0; i < 6; i += 2) {
    const bit = ((h[i] << 8) | h[i + 1]) & 0x7ff;
    if ((bloom[255 - (bit >> 3)] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function makeServer(extra = {}) {
  const c = extra.chain || chain;
  if (extra.bloomMatches !== false) c.bloomMatches = bloomMatchesImpl;
  else delete c.bloomMatches;
  return new JsonRpcServer({ chain: c, version: '0.2.0', ...extra });
}

const srv = makeServer();
const rpc = (method, ...params) => srv.methods[method](params);
/** Full round trip through dispatch, returning the whole response object. */
const req = (method, params, id = 1) => srv.handle({ jsonrpc: '2.0', id, method, params });

// ============================================================================

async function main() {

  // ---- hex: QUANTITY -------------------------------------------------------
  group('hex — QUANTITY encoding');
  eq(H.encodeQuantity(0n), '0x0', 'zero is "0x0", not "0x00" and not "0x"');
  eq(H.encodeQuantity(65n), '0x41', '65 encodes as 0x41');
  eq(H.encodeQuantity(1024n), '0x400', '1024 encodes as 0x400');
  eq(H.encodeQuantity(15n), '0xf', 'single digit is not padded to a byte');
  eq(H.encodeQuantity(0), '0x0', 'a Number zero encodes as 0x0');
  eq(H.encodeQuantity(10n ** 18n), '0xde0b6b3a7640000', 'one ether in wei, no leading zeros');
  eq(H.encodeQuantity(Buffer.alloc(32)), '0x0', 'a 32-byte zero word as a QUANTITY is 0x0');
  eq(H.encodeQuantity(hb('0000000000000041')), '0x41', 'leading zero bytes are stripped by QUANTITY');
  ok(!/^0x0[0-9a-f]/.test(H.encodeQuantity(255n)), 'no quantity ever starts 0x0 followed by a digit');
  await throwsCode(() => H.encodeQuantity(-1n), H.CODES.INTERNAL_ERROR, 'negative quantity is a bug, not a value');
  await throwsCode(() => H.encodeQuantity('0x1'), H.CODES.INTERNAL_ERROR, 'a hex string is not re-encodable as a quantity');

  group('hex — QUANTITY decoding is strict');
  eq(H.decodeQuantity('0x0'), 0n, '"0x0" decodes to zero');
  eq(H.decodeQuantity('0x41'), 65n, '"0x41" decodes to 65');
  eq(H.decodeQuantity('0xFF'), 255n, 'upper-case hex is accepted on input');
  await throwsCode(() => H.decodeQuantity('0x00'), H.CODES.INVALID_PARAMS, '"0x00" is rejected, not coerced to zero');
  await throwsCode(() => H.decodeQuantity('0x0a'), H.CODES.INVALID_PARAMS, 'a leading zero is rejected');
  await throwsCode(() => H.decodeQuantity('0x'), H.CODES.INVALID_PARAMS, '"0x" is not a quantity');
  await throwsCode(() => H.decodeQuantity('41'), H.CODES.INVALID_PARAMS, 'a missing 0x prefix is rejected');
  await throwsCode(() => H.decodeQuantity(65), H.CODES.INVALID_PARAMS, 'a JSON number is rejected (it cannot hold wei)');
  await throwsCode(() => H.decodeQuantity('0xzz'), H.CODES.INVALID_PARAMS, 'non-hex characters are rejected');
  await throwsCode(() => H.decodeQuantity('0x1' + '0'.repeat(64)), H.CODES.INVALID_PARAMS, 'over 256 bits is rejected');

  // ---- hex: DATA -----------------------------------------------------------
  group('hex — DATA encoding preserves width');
  eq(H.encodeData(Buffer.alloc(0)), '0x', 'the empty byte string is "0x"');
  eq(H.encodeData(Buffer.alloc(1)), '0x00', 'one zero byte is "0x00" — the opposite of the quantity rule');
  eq(H.encodeData(hb('0041')), '0x0041', 'DATA keeps its leading zero byte');
  eq(H.encodeHash(Buffer.alloc(32)), '0x' + '00'.repeat(32), 'a zero hash is 32 encoded bytes, not 0x0');
  ok(H.encodeHash(h32('anything')).length === 66, 'a 32-byte hash is always 66 characters');
  ok(H.encodeAddress(ADDR_ALICE).length === 42, 'an address is always 42 characters');
  eq(H.encodeDataFixed(42n, 32), '0x' + '2a'.padStart(64, '0'), 'an integer left-pads into fixed-width DATA');
  await throwsCode(() => H.encodeHash(hb('00'.repeat(31))), H.CODES.INTERNAL_ERROR, 'a 31-byte "hash" is refused, not padded');

  group('hex — DATA decoding');
  eq(H.decodeData('0x').length, 0, '"0x" decodes to zero bytes');
  eq([...H.decodeData('0x0041')], [0, 65], 'DATA decodes byte-wise');
  await throwsCode(() => H.decodeData('0x1'), H.CODES.INVALID_PARAMS, 'odd-length DATA is rejected');
  await throwsCode(() => H.decodeData('1234'), H.CODES.INVALID_PARAMS, 'DATA without 0x is rejected');
  await throwsCode(() => H.decodeHash('0x00'), H.CODES.INVALID_PARAMS, 'a short hash is rejected');
  await throwsCode(() => H.decodeAddress('0x' + 'aa'.repeat(21)), H.CODES.INVALID_PARAMS, 'a long address is rejected');
  eq([...H.decodeStorageKey('0x1')].slice(30), [0, 1], 'a storage key is left-padded to 32 bytes (geth-lenient)');
  await throwsCode(() => H.decodeStorageKey('0x' + 'ab'.repeat(33)), H.CODES.INVALID_PARAMS, 'an over-wide storage key is rejected');

  group('hex — block parameters');
  eq(H.parseBlockParam(undefined), { tag: 'latest' }, 'an absent block parameter means latest');
  eq(H.parseBlockParam('earliest'), { tag: 'earliest' }, 'earliest is a tag');
  eq(H.parseBlockParam('0x10').number, 16n, 'a numeric block parameter is a quantity');
  eq(H.parseBlockParam({ blockNumber: '0x2' }).number, 2n, 'EIP-1898 blockNumber form');
  ok(H.parseBlockParam({ blockHash: '0x' + 'ab'.repeat(32) }).hash.length === 32, 'EIP-1898 blockHash form');
  await throwsCode(() => H.parseBlockParam('latests'), H.CODES.INVALID_PARAMS, 'a mistyped tag is rejected, not treated as latest');
  await throwsCode(() => H.parseBlockParam('0x010'), H.CODES.INVALID_PARAMS, 'a non-canonical block number is rejected');

  // ---- chain metadata ------------------------------------------------------
  group('metadata');
  eq(await rpc('eth_chainId'), '0x1cf3', 'eth_chainId is hex 7411');
  eq(await rpc('net_version'), '7411', 'net_version is DECIMAL, not hex');
  eq(await rpc('eth_blockNumber'), '0x3', 'eth_blockNumber is a quantity');
  eq(await rpc('eth_gasPrice'), '0x3b9aca00', 'eth_gasPrice is a quantity');
  ok(/^Hearth\/v0\.2\.0\//.test(await rpc('web3_clientVersion')), 'web3_clientVersion names the client and version');
  eq(await rpc('eth_accounts'), [], 'the node custodies no accounts');
  eq(await rpc('eth_syncing'), false, 'eth_syncing is false when the chain does not report');
  eq(await rpc('web3_sha3', '0x'), '0x' + keccak256(Buffer.alloc(0)).toString('hex'), 'web3_sha3 is keccak256, not sha3');
  await throwsCode(() => rpc('eth_chainId', '0x1'), H.CODES.INVALID_PARAMS, 'extra arguments are rejected');

  // ---- state ---------------------------------------------------------------
  group('state reads');
  eq(await rpc('eth_getBalance', '0x' + ADDR_ALICE.toString('hex'), 'latest'),
    '0x3635c9adc5dea00000', 'a balance is a QUANTITY');
  eq(await rpc('eth_getBalance', '0x' + ADDR_ALICE.toString('hex'), 'earliest'),
    '0x0', 'a zero balance is "0x0" — not "0x00", not "0x", not 0');
  eq(await rpc('eth_getBalance', '0x' + 'ff'.repeat(20), 'latest'), '0x0', 'an unknown account has balance 0x0');
  eq(await rpc('eth_getBalance', '0x' + ADDR_ALICE.toString('hex').toUpperCase(), 'latest'),
    '0x3635c9adc5dea00000', 'an EIP-55 mixed-case address is accepted');
  eq(await rpc('eth_getBalance', '0x' + ADDR_ALICE.toString('hex')), '0x3635c9adc5dea00000',
    'the block parameter defaults to latest');
  eq(await rpc('eth_getTransactionCount', '0x' + ADDR_ALICE.toString('hex'), 'latest'), '0x3', 'nonce at latest');
  eq(await rpc('eth_getTransactionCount', '0x' + ADDR_ALICE.toString('hex'), 'pending'), '0x4',
    'the pending nonce counts the mempool — without this, two sends in a row collide');
  eq(await rpc('eth_getTransactionCount', '0x' + ADDR_ALICE.toString('hex'), 'earliest'), '0x0', 'nonce at earliest');
  eq(await rpc('eth_getCode', '0x' + ADDR_TOKEN.toString('hex'), 'latest'), '0x' + CODE.toString('hex'), 'code is DATA');
  eq(await rpc('eth_getCode', '0x' + ADDR_ALICE.toString('hex'), 'latest'), '0x', 'an EOA has empty code, "0x"');
  eq(await rpc('eth_getCode', '0x' + ADDR_TOKEN.toString('hex'), '0x0'), '0x', 'code is read at the requested height');

  const slot = await rpc('eth_getStorageAt', '0x' + ADDR_TOKEN.toString('hex'), '0x1', 'latest');
  eq(slot, '0x' + '2a'.padStart(64, '0'), 'a storage value is a full 32-byte word, zero-padded');
  ok(slot.length === 66, 'a storage word is always 66 characters');
  eq(await rpc('eth_getStorageAt', '0x' + ADDR_TOKEN.toString('hex'), '0x2', 'latest'),
    '0x' + '00'.repeat(32), 'an empty slot is 32 zero bytes, not "0x0"');
  eq(await rpc('eth_getStorageAt', '0x' + ADDR_TOKEN.toString('hex'),
    '0x' + '01'.padStart(64, '0'), 'latest'), '0x' + '2a'.padStart(64, '0'), 'a full-width slot key works too');

  group('block tags');
  eq(await rpc('eth_getTransactionCount', '0x' + ADDR_ALICE.toString('hex'), 'safe'), '0x0',
    'safe/finalized mean tip minus the confirmation depth (12), so height 0 here');
  {
    const deep = makeServer({ confirmations: 1 });
    eq(await deep.methods.eth_getTransactionCount([`0x${ADDR_ALICE.toString('hex')}`, 'finalized']), '0x2',
      'the confirmation depth is configurable');
    const blk = await deep.methods.eth_getBlockByNumber(['finalized', false]);
    eq(blk.number, '0x2', 'finalized resolves to a real block');
  }
  await throwsCode(() => rpc('eth_getBalance', '0x' + ADDR_ALICE.toString('hex'), '0x9'),
    H.CODES.SERVER_ERROR, 'a state read above the tip is "header not found"');
  eq(await rpc('eth_getBlockByNumber', '0x9', false), null, 'a block lookup above the tip is null, not an error');
  eq(await rpc('eth_getBlockByNumber', 'pending', false), null, 'there is no pending block on this chain');

  // ---- blocks --------------------------------------------------------------
  group('eth_getBlockByNumber — the full Ethereum block shape');
  const b1 = await rpc('eth_getBlockByNumber', '0x1', false);
  const REQUIRED = ['number', 'hash', 'parentHash', 'nonce', 'sha3Uncles', 'logsBloom',
    'transactionsRoot', 'stateRoot', 'receiptsRoot', 'miner', 'difficulty', 'totalDifficulty',
    'extraData', 'size', 'gasLimit', 'gasUsed', 'timestamp', 'transactions', 'uncles'];
  for (const f of REQUIRED) ok(b1[f] !== undefined, `block carries "${f}" — clients assume Ethereum's shape`);
  eq(b1.number, '0x1', 'block.number is a QUANTITY');
  ok(b1.hash.length === 66, 'block.hash is 32-byte DATA (66 chars)');
  ok(b1.parentHash.length === 66, 'block.parentHash is 32-byte DATA');
  eq(b1.nonce, '0x0000000000000007', 'block.nonce is 8-byte DATA — leading zeros kept, unlike a quantity');
  eq(b1.sha3Uncles, '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    'sha3Uncles is the RLP hash of the empty list');
  eq(b1.uncles, [], 'uncles is an empty array, not absent');
  ok(b1.logsBloom.length === 514, 'logsBloom is 256-byte DATA (514 chars)');
  eq(b1.miner, '0x' + ADDR_MINER.toString('hex'), 'miner is a 0x address, not a coinbase pubkey');
  eq(b1.difficulty, '0x100000', 'difficulty is a QUANTITY');
  eq(b1.totalDifficulty, '0x100000', 'totalDifficulty is a QUANTITY');
  eq(b1.extraData, '0x' + Buffer.from('hearth').toString('hex'), 'extraData is DATA');
  eq(b1.size, '0x206', 'size is a QUANTITY');
  eq(b1.gasLimit, '0x1c9c380', 'gasLimit is a QUANTITY (30M)');
  eq(b1.gasUsed, '0x11d28', 'gasUsed is a QUANTITY');
  eq(b1.timestamp, '0x' + (1_760_000_015).toString(16), 'timestamp is a QUANTITY in seconds, not milliseconds');
  ok(b1.mixHash.length === 66, 'mixHash carries the Homefire PoW digest');
  ok(b1.baseFeePerGas === undefined, 'no baseFeePerGas — v1 is legacy-priced and clients branch on its absence');
  eq(b1.transactions.length, 2, 'two transactions in block 1');
  ok(typeof b1.transactions[0] === 'string' && b1.transactions[0].length === 66,
    'fullTx=false gives transaction hashes');

  const b0 = await rpc('eth_getBlockByNumber', 'earliest', false);
  eq(b0.number, '0x0', 'the genesis block number is "0x0"');
  eq(b0.gasUsed, '0x0', 'an empty block used 0x0 gas — not "0x00"');
  eq(b0.difficulty, '0x0', 'a zero difficulty is "0x0"');
  eq(b0.extraData, '0x', 'empty extraData is "0x"');
  eq(b0.transactions, [], 'an empty block has no transactions');
  eq(b0.parentHash, '0x' + '00'.repeat(32), 'genesis parentHash is 32 zero bytes, not "0x0"');

  const b1full = await rpc('eth_getBlockByNumber', '0x1', true);
  ok(typeof b1full.transactions[0] === 'object', 'fullTx=true gives transaction objects');
  eq(b1full.transactions[0].transactionIndex, '0x0', 'the first transaction is at index 0x0');
  eq(b1full.transactions[1].transactionIndex, '0x1', 'the second transaction is at index 0x1');
  eq(await rpc('eth_getBlockByNumber', 'latest', false), await rpc('eth_getBlockByNumber', '0x3', false),
    'latest is the tip');
  const byHash = await rpc('eth_getBlockByHash', b1.hash, false);
  eq(byHash, b1, 'eth_getBlockByHash agrees with eth_getBlockByNumber');
  eq(await rpc('eth_getBlockByHash', '0x' + '99'.repeat(32), false), null, 'an unknown block hash is null');
  await throwsCode(() => rpc('eth_getBlockByNumber', '0x1', 'true'), H.CODES.INVALID_PARAMS,
    'the fullTx flag must be a boolean');
  await throwsCode(() => rpc('eth_getBlockByHash', '0x1234', false), H.CODES.INVALID_PARAMS,
    'a malformed block hash is invalid params');

  // ---- transactions --------------------------------------------------------
  group('eth_getTransactionByHash');
  const tx1hash = '0x' + h32('tx:a').toString('hex');
  const tx = await rpc('eth_getTransactionByHash', tx1hash);
  for (const f of ['blockHash', 'blockNumber', 'transactionIndex', 'hash', 'from', 'to',
    'value', 'gas', 'gasPrice', 'input', 'nonce', 'v', 'r', 's', 'type']) {
    ok(tx[f] !== undefined, `transaction carries "${f}"`);
  }
  eq(tx.nonce, '0x0', 'a zero nonce is "0x0"');
  eq(tx.value, '0x0', 'a zero value is "0x0"');
  eq(tx.gas, '0x186a0', 'gas is a QUANTITY');
  eq(tx.input, '0xa9059cbb', 'input is DATA');
  eq(tx.type, '0x0', 'type is 0x0 — legacy, which is all v1 executes');
  eq(tx.chainId, '0x1cf3', 'a protected transaction reports its chain id');
  eq(tx.r, '0xf', 'r is a quantity, so it is minimal — not zero-padded');
  eq(tx.blockNumber, '0x1', 'a mined transaction knows its block');
  eq(tx.to, '0x' + ADDR_TOKEN.toString('hex'), 'to is an address');
  const create = await rpc('eth_getTransactionByHash', '0x' + h32('tx:c').toString('hex'));
  eq(create.to, null, 'a contract creation has to: null');
  ok(create.chainId === undefined, 'a pre-155 unprotected transaction reports no chain id (§3)');
  const pending = await rpc('eth_getTransactionByHash', '0x' + h32('tx:pending').toString('hex'));
  eq([pending.blockHash, pending.blockNumber, pending.transactionIndex], [null, null, null],
    'a pending transaction has null block fields — null, not "0x0"');
  eq(await rpc('eth_getTransactionByHash', '0x' + '77'.repeat(32)), null, 'an unknown transaction is null');

  group('eth_getTransactionReceipt');
  const rec = await rpc('eth_getTransactionReceipt', tx1hash);
  for (const f of ['transactionHash', 'transactionIndex', 'blockHash', 'blockNumber', 'from', 'to',
    'cumulativeGasUsed', 'gasUsed', 'effectiveGasPrice', 'contractAddress', 'logs', 'logsBloom',
    'status', 'type']) {
    ok(rec[f] !== undefined, `receipt carries "${f}"`);
  }
  eq(rec.status, '0x1', 'a successful receipt is status 0x1');
  eq(rec.gasUsed, '0xcb20', 'gasUsed is a QUANTITY');
  eq(rec.contractAddress, null, 'a call receipt has contractAddress null');
  ok(rec.logsBloom.length === 514, 'the receipt bloom is 256-byte DATA');
  eq(rec.logs.length, 2, 'both logs are on the receipt');
  eq(rec.logs[0].logIndex, '0x0', 'logIndex is a QUANTITY');
  eq(rec.logs[1].logIndex, '0x1', 'a log missing its index is numbered by position');
  eq(rec.logs[1].blockNumber, '0x1', 'a log missing its block context is filled from the receipt');
  eq(rec.logs[0].topics.length, 3, 'topics are preserved');
  ok(rec.logs[0].topics.every(t => t.length === 66), 'every topic is 32-byte DATA');
  eq(rec.logs[1].data, '0x', 'an empty log payload is "0x"');
  eq(rec.logs[0].removed, false, 'removed is a real boolean');
  const failed = await rpc('eth_getTransactionReceipt', '0x' + h32('tx:b').toString('hex'));
  eq(failed.status, '0x0', 'a reverted transaction is a SUCCESSFUL rpc call with status 0x0');
  const created = await rpc('eth_getTransactionReceipt', '0x' + h32('tx:c').toString('hex'));
  eq(created.contractAddress, '0x' + ADDR_NEW.toString('hex'), 'a creation receipt carries the new address');
  eq(created.to, null, 'a creation receipt has to: null');
  eq(await rpc('eth_getTransactionReceipt', '0x' + '77'.repeat(32)), null,
    'an unmined transaction has a null receipt — clients poll this in a loop');

  // ---- execution -----------------------------------------------------------
  group('eth_call / eth_estimateGas');
  eq(await rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0x70a08231' }, 'latest'),
    '0x' + '7b'.padStart(64, '0'), 'a successful call returns its DATA');
  eq(await rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), input: '0x70a08231' }),
    '0x' + '7b'.padStart(64, '0'), '"input" is accepted as well as "data"');
  eq(await rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex') }), '0x' + '7b'.padStart(64, '0'),
    'a call with no data works and the block parameter is optional');
  {
    const e = await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0xdeadbeef' }),
      H.CODES.EXECUTION_REVERTED, 'a revert is error code 3, not -32000');
    ok(/ERC20: transfer failed/.test(e.message), 'the Error(string) reason is decoded into the message');
    eq(e.data, '0x' + REVERT_STRING.toString('hex'), 'the raw revert payload is in data');
  }
  {
    const e = await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0xcafebabe' }),
      H.CODES.EXECUTION_REVERTED, 'a custom error also reverts with code 3');
    eq(e.message, 'execution reverted', 'a custom error has no decodable string reason');
    eq(e.data, '0x' + REVERT_CUSTOM.toString('hex'),
      'the custom error payload survives intact — this is what lets ethers decode it');
  }
  {
    const e = await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0xbaadf00d' }),
      H.CODES.EXECUTION_REVERTED, 'a bare revert() is still code 3');
    eq(e.data, '0x', 'an empty revert payload is "0x"');
  }
  await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0x00000001' }),
    H.CODES.SERVER_ERROR, 'a non-revert failure (out of gas) is -32000, not code 3');
  {
    /* The chain refusing to spend more of its only thread. It must NOT arrive as a
     * revert: a client that read "reverted" would report the caller's contract as
     * broken, and one that read a retryable error would repeat the request that
     * caused it. */
    const e = await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0x00000002' }),
      H.CODES.SERVER_ERROR, 'an execution timeout is -32000');
    eq(e.message, 'execution timeout', '…and says so in as many words');
    eq(e.data, undefined, '…with no revert payload, because nothing reverted');
  }
  await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0x00', input: '0x11' }),
    H.CODES.INVALID_PARAMS, 'data and input that disagree are refused rather than guessed');
  await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), gassy: '0x1' }),
    H.CODES.INVALID_PARAMS, 'an unknown call field is a typo, not something to ignore');
  await throwsCode(() => rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex') }, 'latest',
    { ['0x' + ADDR_TOKEN.toString('hex')]: { balance: '0x1' } }),
    H.CODES.INVALID_PARAMS, 'state overrides are refused, not silently ignored');
  eq(await rpc('eth_call', { to: '0x' + ADDR_TOKEN.toString('hex'), maxFeePerGas: '0x3b9aca00' }),
    '0x' + '7b'.padStart(64, '0'), 'a 1559-shaped call is priced as legacy rather than rejected');
  eq(await rpc('eth_estimateGas', { to: '0x' + ADDR_BOB.toString('hex') }), '0x5208', 'a plain transfer estimates 21000');
  eq(await rpc('eth_estimateGas', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0xa9059cbb' }), '0xcf78',
    'a call with data estimates more');
  eq(await rpc('eth_estimateGas', { to: '0x' + ADDR_BOB.toString('hex') }, 'latest', {}), '0x5208',
    'an empty state-override map is treated as no override');
  await throwsCode(() => rpc('eth_estimateGas', { to: '0x' + ADDR_BOB.toString('hex') }, 'latest',
    { ['0x' + ADDR_BOB.toString('hex')]: { balance: '0x1' } }),
    H.CODES.INVALID_PARAMS, 'eth_estimateGas refuses state overrides too');
  await throwsCode(() => rpc('eth_estimateGas', { to: '0x' + ADDR_TOKEN.toString('hex'), data: '0xdeadbeef' }),
    H.CODES.EXECUTION_REVERTED, 'a revert during estimation is code 3, not a bogus gas figure');

  group('eth_sendRawTransaction');
  eq(await rpc('eth_sendRawTransaction', '0xf86c0185'), '0x' + h32('tx:pending').toString('hex'),
    'a accepted transaction returns its 32-byte hash');
  ok((await rpc('eth_sendRawTransaction', '0xf86c0185')).length === 66, 'the returned hash is 66 characters');
  {
    const e = await throwsCode(() => rpc('eth_sendRawTransaction', '0x00ff'), H.CODES.SERVER_ERROR,
      'a rejected transaction is -32000');
    eq(e.message, 'nonce too low', 'the chain\'s wording reaches the client verbatim — tools match on it');
  }
  await throwsCode(() => rpc('eth_sendRawTransaction', '0x'), H.CODES.INVALID_PARAMS, 'an empty payload is rejected');
  await throwsCode(() => rpc('eth_sendRawTransaction', '0xf86c018'), H.CODES.INVALID_PARAMS,
    'odd-length transaction hex is rejected');

  // ---- logs ----------------------------------------------------------------
  group('eth_getLogs');
  const ALL = { fromBlock: '0x0', toBlock: 'latest' };
  const all = await rpc('eth_getLogs', ALL);
  eq(all.length, 3, 'three logs across the chain');
  eq(all.map(l => l.blockNumber), ['0x1', '0x1', '0x2'], 'logs come back in block order');
  eq(all[0].logIndex, '0x0', 'the first log in a block is index 0x0');
  eq(all[1].logIndex, '0x1', 'log indices are per block, not per transaction');
  for (const f of ['address', 'topics', 'data', 'blockNumber', 'transactionHash',
    'transactionIndex', 'blockHash', 'logIndex', 'removed']) {
    ok(all[0][f] !== undefined, `log carries "${f}"`);
  }
  eq(await rpc('eth_getLogs', { ...ALL, address: '0x' + ADDR_TOKEN.toString('hex') }).then(r => r.length), 2,
    'address filtering');
  eq(await rpc('eth_getLogs', { ...ALL, address: ['0x' + ADDR_TOKEN.toString('hex'), '0x' + ADDR_TOKEN2.toString('hex')] })
    .then(r => r.length), 3, 'an address array is an OR');
  eq(await rpc('eth_getLogs', { ...ALL, address: [] }).then(r => r.length), 3, 'an empty address array is a wildcard');
  eq(await rpc('eth_getLogs', { ...ALL, address: '0x' + '99'.repeat(20) }).then(r => r.length), 0,
    'an address with no logs matches nothing');
  eq(await rpc('eth_getLogs', { ...ALL, topics: ['0x' + T_TRANSFER.toString('hex')] }).then(r => r.length), 2,
    'topic0 filtering');
  eq(await rpc('eth_getLogs', { ...ALL, topics: [null, '0x' + T_BOB.toString('hex')] }).then(r => r.length), 1,
    'a null wildcard skips a topic position');
  eq(await rpc('eth_getLogs', {
    ...ALL, topics: [['0x' + T_TRANSFER.toString('hex'), '0x' + T_APPROVAL.toString('hex')]],
  }).then(r => r.length), 3, 'an array of topics at one position is an OR');
  eq(await rpc('eth_getLogs', { ...ALL, topics: [[]] }).then(r => r.length), 3,
    'an empty topic array is a wildcard, not "match nothing"');
  eq(await rpc('eth_getLogs', {
    ...ALL, topics: ['0x' + T_TRANSFER.toString('hex'), null, '0x' + T_ALICE.toString('hex')],
  }).then(r => r.length), 1, 'positional matching across three topics');
  eq(await rpc('eth_getLogs', {
    ...ALL, topics: [null, null, null, '0x' + T_ALICE.toString('hex')],
  }).then(r => r.length), 0, 'a log with fewer topics than the filter never matches');
  eq(await rpc('eth_getLogs', { ...ALL, topics: ['0x' + T_APPROVAL.toString('hex')] }).then(r => r.length), 1,
    'the approval log is found by its own topic0');
  eq(await rpc('eth_getLogs', {
    ...ALL, address: '0x' + ADDR_TOKEN.toString('hex'), topics: ['0x' + T_APPROVAL.toString('hex')],
  }).then(r => r.length), 0, 'address and topics are ANDed, not ORed');
  eq(await rpc('eth_getLogs', { fromBlock: '0x1', toBlock: '0x1' }).then(r => r.length), 2, 'a single-block range');
  eq(await rpc('eth_getLogs', { fromBlock: '0x2' }).then(r => r.length), 1,
    'toBlock defaults to latest');
  await throwsCode(() => rpc('eth_getLogs', { toBlock: '0x1' }), H.CODES.INVALID_PARAMS,
    'fromBlock also defaults to latest, so a toBlock in the past is an inverted range');
  eq(await rpc('eth_getLogs', { fromBlock: 'earliest', toBlock: 'latest' }).then(r => r.length), 3,
    'earliest..latest is the whole chain');
  eq(await rpc('eth_getLogs', {}).then(r => r.length), 0, 'an empty filter means latest..latest');
  eq(await rpc('eth_getLogs', { blockHash: b1.hash }).then(r => r.length), 2, 'EIP-234 blockHash filtering');
  eq(await rpc('eth_getLogs', { fromBlock: '0x0', toBlock: '0x9' }).then(r => r.length), 3,
    'a toBlock past the tip is clamped, not refused — clients race block production');
  await throwsCode(() => rpc('eth_getLogs', { fromBlock: '0x2', toBlock: '0x1' }), H.CODES.INVALID_PARAMS,
    'an inverted range is rejected');
  await throwsCode(() => rpc('eth_getLogs', { blockHash: b1.hash, fromBlock: '0x0' }), H.CODES.INVALID_PARAMS,
    'blockHash cannot be combined with a range');
  await throwsCode(() => rpc('eth_getLogs', { blockHash: '0x' + '99'.repeat(32) }), H.CODES.SERVER_ERROR,
    'an unknown blockHash is an error, not an empty result');
  await throwsCode(() => rpc('eth_getLogs', { ...ALL, topics: ['0x1234'] }), H.CODES.INVALID_PARAMS,
    'a malformed topic is rejected');
  await throwsCode(() => rpc('eth_getLogs', { ...ALL, topics: [null, null, null, null, null] }),
    H.CODES.INVALID_PARAMS, 'more than four topic positions is rejected');
  await throwsCode(() => rpc('eth_getLogs', { ...ALL, fromBlockk: '0x0' }), H.CODES.INVALID_PARAMS,
    'a misspelled filter field is rejected rather than ignored');
  await throwsCode(() => rpc('eth_getLogs', { ...ALL, fromBlock: 'pending' }), H.CODES.INVALID_PARAMS,
    'pending logs are not supported in v1');
  {
    const narrow = makeServer({ maxLogRange: 2 });
    await throwsCode(() => narrow.methods.eth_getLogs([{ fromBlock: '0x0', toBlock: 'latest' }]),
      H.CODES.INVALID_PARAMS, 'an over-wide range is refused');
    const capped = makeServer({ maxLogs: 1 });
    await throwsCode(() => capped.methods.eth_getLogs([ALL]), H.CODES.SERVER_ERROR,
      'too many results is refused the way geth refuses it');
  }

  group('eth_getLogs — the bloom filter');
  {
    // A filter for an address that appears nowhere must not read a single
    // receipt: the header bloom answers it.
    chain.receiptFetches = [];
    await rpc('eth_getLogs', { ...ALL, address: '0x' + '99'.repeat(20) });
    eq(chain.receiptFetches, [], 'the bloom skips every block for an address that never logged');

    chain.receiptFetches = [];
    await rpc('eth_getLogs', { ...ALL, address: '0x' + ADDR_TOKEN2.toString('hex') });
    eq(chain.receiptFetches, [1], 'only the block whose bloom can hold the address is read');

    // and the bloom must never cost us a log: with it off, byte-identical.
    const bare = new JsonRpcServer({ chain: { ...chain, bloomMatches: undefined }, useBloom: false });
    const filters = [
      ALL,
      { ...ALL, address: '0x' + ADDR_TOKEN.toString('hex') },
      { ...ALL, topics: ['0x' + T_TRANSFER.toString('hex')] },
      { ...ALL, topics: [null, '0x' + T_BOB.toString('hex')] },
      { ...ALL, address: '0x' + ADDR_TOKEN2.toString('hex'), topics: ['0x' + T_APPROVAL.toString('hex')] },
    ];
    let same = true;
    for (const f of filters) {
      const withBloom = JSON.stringify(await rpc('eth_getLogs', f));
      const without = JSON.stringify(await bare.methods.eth_getLogs([f]));
      if (withBloom !== without) { same = false; console.log(`      differs for ${JSON.stringify(f)}`); }
    }
    ok(same, 'bloom-skipped results are identical to a full scan — a wrong bloom would lose logs silently');

    // the local fallback (no chain.bloomMatches) must agree with the chain's
    const local = new JsonRpcServer({ chain: { ...chain, bloomMatches: undefined } });
    eq(await local.methods.eth_getLogs([{ ...ALL, address: '0x' + ADDR_TOKEN2.toString('hex') }])
      .then(r => r.length), 1, 'the built-in bloom implementation matches the chain-supplied one');
    ok(M.bloomContains(bloomFor([{ address: ADDR_TOKEN, topics: [T_TRANSFER] }]), ADDR_TOKEN),
      'bloomContains finds what bloomAdd put in');
    ok(!M.bloomContains(bloomFor([{ address: ADDR_TOKEN, topics: [T_TRANSFER] }]), ADDR_BOB),
      'bloomContains rejects what was never added');
  }

  // ==========================================================================
  // The methods added for phase 5's conformance matrix (CHAIN-TESTPLAN.md §3).
  // ==========================================================================

  group('blocks by index, and uncles');
  {
    const b1 = BLOCKS[1];
    eq(await rpc('eth_getBlockTransactionCountByNumber', '0x1'), '0x2', 'a block with two transactions counts 0x2');
    eq(await rpc('eth_getBlockTransactionCountByNumber', '0x3'), '0x0', 'an empty block counts 0x0, not null');
    eq(await rpc('eth_getBlockTransactionCountByNumber', '0x63'), null, 'an unknown height is null, not 0x0');
    eq(await rpc('eth_getBlockTransactionCountByNumber', 'pending'), null, 'there is no pending block to count');
    eq(await rpc('eth_getBlockTransactionCountByHash', '0x' + b1.hash.toString('hex')), '0x2', 'and by hash');
    eq(await rpc('eth_getBlockTransactionCountByHash', '0x' + h32('nope').toString('hex')), null,
      'an unknown block hash is null');

    const byIndex = await rpc('eth_getTransactionByBlockNumberAndIndex', '0x1', '0x1');
    const byHash = await rpc('eth_getTransactionByHash', '0x' + b1.transactions[1].hash.toString('hex'));
    eq(byIndex, byHash, 'the transaction at index 1 is byte-identical to the same transaction by hash');
    eq(byIndex.transactionIndex, '0x1', 'and knows its own index');
    eq(await rpc('eth_getTransactionByBlockHashAndIndex', '0x' + b1.hash.toString('hex'), '0x0'),
      await rpc('eth_getTransactionByHash', '0x' + b1.transactions[0].hash.toString('hex')),
      'the by-block-hash form agrees with the by-number form');
    eq(await rpc('eth_getTransactionByBlockNumberAndIndex', '0x1', '0x9'), null, 'an index past the end is null');
    eq(await rpc('eth_getTransactionByBlockNumberAndIndex', '0x63', '0x0'), null, 'so is an unknown block');
    await throwsCode(() => rpc('eth_getTransactionByBlockNumberAndIndex', '0x1', '0x01'),
      H.CODES.INVALID_PARAMS, 'a non-canonical index is -32602, not a null');
    /* The index is decoded before the block is looked up on purpose: otherwise
     * the same malformed request is -32602 against a block that exists and a
     * bare null against one that does not, and a client debugging its own
     * encoding cannot tell which mistake it made. */
    await throwsCode(() => rpc('eth_getTransactionByBlockNumberAndIndex', '0x63', 'nope'),
      H.CODES.INVALID_PARAMS, '…even when the block does not exist');

    eq(await rpc('eth_getUncleCountByBlockNumber', '0x1'), '0x0', 'Hearth has no uncles, so the count is 0x0…');
    eq(await rpc('eth_getUncleCountByBlockNumber', '0x63'), null, '…but null for a block that does not exist');
    eq(await rpc('eth_getUncleCountByBlockHash', '0x' + b1.hash.toString('hex')), '0x0', 'and the same by hash');
    eq(await rpc('eth_getUncleByBlockNumberAndIndex', '0x1', '0x0'), null, 'and there is never an uncle to fetch');
  }

  group('the node, as opposed to the chain');
  {
    eq(await rpc('net_peerCount'), '0x3', 'net_peerCount is a QUANTITY, not a decimal like net_version');
    eq(await rpc('eth_mining'), true, 'eth_mining is a plain boolean');
    eq(await rpc('eth_hashrate'), '0x4d2', 'eth_hashrate is a QUANTITY');
    eq(await rpc('eth_coinbase'), '0x' + ADDR_MINER.toString('hex'), 'eth_coinbase is the mining address');
    eq(await rpc('txpool_status'), { pending: '0x2', queued: '0x1' },
      'txpool_status splits the pool the way geth does — queued is stranded above a nonce gap');

    /* THE ABSENCE IS THE FEATURE. An adapter over a bare chain has no peers and
     * no miner, and a dashboard told "0 peers" by something that simply does not
     * know reports a live network as down. -32601 lets the caller fall back. */
    const bare = makeServer({ chain: { ...chain, peerCount: undefined, mining: undefined,
      hashrate: undefined, coinbase: undefined, txpoolStatus: undefined, pendingSince: undefined } });
    for (const m of ['net_peerCount', 'eth_mining', 'eth_hashrate', 'eth_coinbase', 'txpool_status',
      'eth_newPendingTransactionFilter']) {
      ok(!bare.has(m), `${m} is ABSENT when the chain cannot answer it honestly`);
    }
    eq((await bare.handle({ jsonrpc: '2.0', id: 1, method: 'net_peerCount', params: [] })).error.code, -32601,
      '…and therefore -32601 on the wire, not a plausible zero');
    ok(!srv.has('txpool_content') && !srv.has('txpool_inspect'),
      'txpool_content/inspect stay absent: a full pool dump with senders is not an unauthenticated endpoint\'s job');
  }

  group('eth_feeHistory — off by default, and correct when it is on');
  {
    /* THE DECISION CHAIN-TESTPLAN §3 ASKS FOR, asserted rather than described.
     * On a legacy-only chain the only measured client that calls eth_feeHistory
     * is Foundry, which aborts with "try adding --legacy" when it is missing and
     * signs an unexecutable type-2 transaction when it is present (Foundry
     * 1.7.1, docs/network-config.md §5). ethers, viem, Hardhat and MetaMask
     * decide from the absence of baseFeePerGas on the BLOCK and never ask. */
    ok(!srv.has('eth_feeHistory'), 'eth_feeHistory is absent by default');
    ok(!srv.has('eth_maxPriorityFeePerGas'), 'and so is eth_maxPriorityFeePerGas');
    eq((await req('eth_feeHistory', ['0x1', 'latest'])).error.code, -32601,
      '…answering -32601, which is what makes Foundry print its own remedy');

    const fee = makeServer({ feeHistory: true });
    const rpc = (method, ...params) => fee.methods[method](params);
    const f = await rpc('eth_feeHistory', '0x3', 'latest', [50]);
    eq(f.oldestBlock, '0x1', 'a 3-block window ending at the tip (3) starts at block 1');
    eq(f.baseFeePerGas.length, 4, 'baseFeePerGas is one LONGER than the window — the extra is the next block\'s');
    ok(f.baseFeePerGas.every(v => v === '0x0'),
      'and every entry is 0x0: v1 has no fee market, so the base fee is zero and the miner keeps the whole price');
    eq(f.gasUsedRatio.length, 3, 'gasUsedRatio has one entry per block');
    ok(f.gasUsedRatio.every(v => typeof v === 'number'),
      'gasUsedRatio is a JSON float — the one number on this surface that is not a QUANTITY');
    eq(f.gasUsedRatio[2], 0, 'the empty tip used no gas');
    eq(f.reward.length, 3, 'reward has one row per block…');
    eq(f.reward[0], ['0x3b9aca00'], '…and on a chain with no base fee the reward IS the gas price');
    eq(f.reward[2], ['0x0'], 'an empty block rewards zero at every percentile');

    ok((await rpc('eth_feeHistory', '0x2', 'latest')).reward === undefined,
      'reward is omitted entirely when no percentiles were asked for — it is the only part that costs a receipt walk');
    eq((await rpc('eth_feeHistory', '0x64', '0x1')).oldestBlock, '0x0',
      'a window reaching below genesis is clamped, not refused');
    eq((await rpc('eth_feeHistory', '0x64', '0x1')).gasUsedRatio.length, 2, '…to the blocks that exist');

    /* geth types blockCount as math.HexOrDecimal64, so a JSON number and a
     * decimal string are both in the wild and both work against geth. This is
     * the one deliberate relaxation of hex.js's strictness, and it is here
     * rather than in decodeQuantity so nothing else inherits it. */
    eq((await rpc('eth_feeHistory', 2, 'latest')).oldestBlock, '0x2', 'a JSON number blockCount is accepted');
    eq((await rpc('eth_feeHistory', '2', 'latest')).oldestBlock, '0x2', 'a decimal string blockCount is accepted');
    eq((await rpc('eth_feeHistory', '0x2', 'latest')).oldestBlock, '0x2', 'and so is hex');
    await throwsCode(() => rpc('eth_feeHistory', '0x1000', 'latest'), H.CODES.INVALID_PARAMS,
      'a window wider than the cap is refused, naming the cap');
    await throwsCode(() => rpc('eth_feeHistory', '0x2', 'latest', [50, 25]), H.CODES.INVALID_PARAMS,
      'out-of-order percentiles are -32602 — the response is read positionally');
    await throwsCode(() => rpc('eth_feeHistory', '0x2', 'latest', [101]), H.CODES.INVALID_PARAMS,
      'a percentile over 100 is -32602');
    await throwsCode(() => rpc('eth_feeHistory', '0x2', '0x63'), H.CODES.SERVER_ERROR,
      'a newestBlock above the tip is "header not found"');
    eq(await rpc('eth_maxPriorityFeePerGas'), await rpc('eth_gasPrice'),
      'with no base fee the priority fee IS the gas price; zero would be refused by the mempool as underpriced');
  }

  group('filters — the ethers v6 subscription path');
  {
    /* A mutable fake, because a filter is a CURSOR and a chain that never moves
     * cannot show one advancing. Blocks 4 and 5 are appended during this group. */
    let height = 3n;
    const extraBlocks = new Map();
    const extraReceipts = new Map();
    const moving = {
      ...chain,
      blockNumber: () => height,
      getBlockByNumber(n, fullTx) {
        if (extraBlocks.has(Number(n))) return extraBlocks.get(Number(n));
        return chain.getBlockByNumber(n, fullTx);
      },
      getBlockReceipts(n) {
        if (extraReceipts.has(Number(n))) return extraReceipts.get(Number(n));
        return chain.getBlockReceipts(n);
      },
      pendingJournal: [],
      pendingSince(cursor) {
        const end = moving.pendingJournal.length;
        if (cursor === null || cursor === undefined || cursor > end) return { cursor: end, hashes: [] };
        return { cursor: end, hashes: moving.pendingJournal.slice(cursor) };
      },
    };
    const appendBlock = (n, logs, hashSeed) => {
      const hash = h32(hashSeed || ('extra:' + n));
      extraBlocks.set(n, {
        ...BLOCKS[3], number: BigInt(n), hash, parentHash: h32('extra:' + (n - 1)),
        logsBloom: bloomFor(logs), transactions: [],
      });
      extraReceipts.set(n, logs.length ? [{
        transactionHash: h32('extratx:' + n), transactionIndex: 0n, blockHash: hash, blockNumber: BigInt(n),
        from: ADDR_ALICE, to: ADDR_TOKEN, cumulativeGasUsed: 21_000n, gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n, contractAddress: null, status: 1,
        logs: logs.map((l, i) => ({ ...l, logIndex: BigInt(i) })), logsBloom: bloomFor(logs),
      }] : []);
      height = BigInt(n);
    };
    const s = makeServer({ chain: moving });
    const m = (name, ...params) => s.methods[name](params, { remote: '10.0.0.1' });

    // ---- block filter ----
    const bf = await m('eth_newBlockFilter');
    ok(/^0x[0-9a-f]{32}$/.test(bf), 'a filter id is 16 random bytes — a counter would let one caller poll another\'s');
    eq(await m('eth_getFilterChanges', bf), [], 'a fresh block filter reports nothing that happened before it');
    appendBlock(4, []);
    appendBlock(5, []);
    eq(await m('eth_getFilterChanges', bf),
      ['0x' + h32('extra:4').toString('hex'), '0x' + h32('extra:5').toString('hex')],
      'two new heads come back in order');
    eq(await m('eth_getFilterChanges', bf), [], 'and are not delivered twice — the cursor advanced');

    /* A REORG RE-DELIVERS THE REPLACED HEIGHT. The filter holds one (height,
     * hash) pair, so when a different block occupies the height it last
     * reported it says so; it cannot know how much deeper the reorg went, and
     * neither does geth's, whose feed fires once for the new head. */
    appendBlock(5, [], 'extra:5-prime');
    eq(await m('eth_getFilterChanges', bf), ['0x' + h32('extra:5-prime').toString('hex')],
      'a block filter re-delivers a height whose hash changed under it');

    // ---- pending transaction filter ----
    const pf = await m('eth_newPendingTransactionFilter');
    eq(await m('eth_getFilterChanges', pf), [], 'a fresh pending filter starts from now, not from the whole journal');
    moving.pendingJournal.push(h32('pending:1'), h32('pending:2'));
    eq(await m('eth_getFilterChanges', pf),
      ['0x' + h32('pending:1').toString('hex'), '0x' + h32('pending:2').toString('hex')],
      'newly pooled transaction hashes come back once');
    eq(await m('eth_getFilterChanges', pf), [], 'and only once');

    // ---- log filter ----
    const LOG_NEW = { address: ADDR_TOKEN, topics: [T_TRANSFER, T_ALICE, T_BOB], data: pad32('99') };
    const CRITERIA = { address: '0x' + ADDR_TOKEN.toString('hex'), fromBlock: '0x0', toBlock: 'latest' };
    const lf = await m('eth_newFilter', CRITERIA);
    /* geth's eth_newFilter is a LIVE subscription: history is eth_getLogs's job,
     * and `fromBlock` does not change that. Blocks 1 and 2 already contain
     * matching logs and must not be replayed, or every client — all of which
     * query the past separately first — sees them twice. */
    eq(await m('eth_getFilterChanges', lf), [],
      'a new log filter does not replay the logs already on chain, even with fromBlock 0');
    appendBlock(6, [LOG_NEW]);
    const changes = await m('eth_getFilterChanges', lf);
    eq(changes.length, 1, 'a log in a new block is delivered');
    eq(changes[0].data, '0x' + pad32('99').toString('hex'), '…with its data');
    eq(changes[0].blockNumber, '0x6', '…and its block');
    eq(await m('eth_getFilterChanges', lf), [], 'and is not delivered twice');

    /* eth_getFilterLogs is the OTHER half: the full declared range, every time,
     * which is what an ethers subscriber uses to backfill. */
    const all = await m('eth_getFilterLogs', lf);
    eq(all.length, 3, 'eth_getFilterLogs answers the whole DECLARED range — the two historical logs and the new one');
    eq(all, await m('eth_getLogs', CRITERIA),
      '…byte for byte the same as eth_getLogs with the criteria the filter was created from');
    eq(await m('eth_getFilterLogs', lf), all, 'and it is idempotent — it does not consume anything');

    // a filter's criteria really do filter
    const narrow = await m('eth_newFilter', { topics: ['0x' + T_APPROVAL.toString('hex')] });
    appendBlock(7, [LOG_NEW]);
    eq(await m('eth_getFilterChanges', narrow), [], 'a filter whose topic does not match delivers nothing');

    // a toBlock in the past ends the filter
    const bounded = await m('eth_newFilter', { fromBlock: '0x0', toBlock: '0x7' });
    appendBlock(8, [LOG_NEW]);
    eq(await m('eth_getFilterChanges', bounded), [],
      'a filter whose toBlock is already behind the tip delivers nothing further');

    // ---- errors ----
    await throwsCode(() => m('eth_getFilterChanges', '0x' + 'ab'.repeat(16)), H.CODES.SERVER_ERROR,
      'an unknown filter id is a server error…');
    const e = await (async () => { try { await m('eth_getFilterChanges', '0xdead'); } catch (x) { return x; } })();
    eq(e.message, 'filter not found', '…with geth\'s exact wording, which is what clients match on to re-subscribe');
    await throwsCode(() => m('eth_getFilterLogs', bf), H.CODES.SERVER_ERROR,
      'eth_getFilterLogs on a block filter is "filter not found", not an empty array that reads as "never fired"');
    await throwsCode(() => m('eth_newFilter', { blockHash: '0x' + BLOCKS[1].hash.toString('hex') }),
      H.CODES.INVALID_PARAMS, 'a blockHash filter names one existing block and cannot be watched');
    await throwsCode(() => m('eth_newFilter', { fromBlock: '0x2', toBlock: '0x1' }),
      H.CODES.INVALID_PARAMS, 'a malformed filter is refused at CREATION, not at the first poll');
    await throwsCode(() => m('eth_newFilter', { nonsense: 1 }),
      H.CODES.INVALID_PARAMS, '…including an unknown field');
    {
      /* A stored filter keeps its criteria for its whole lifetime, and `topics`
       * takes an OR-set of any length — so without a bound one caller's 32
       * filters hold 32 body limits and the global cap authorises gigabytes.
       * The same rule applies to eth_getLogs, so the two cannot disagree about
       * what a filter object may contain. */
      const many = Array.from({ length: 1001 }, (_, i) => '0x' + i.toString(16).padStart(64, '0'));
      await throwsCode(() => m('eth_newFilter', { topics: [many] }), H.CODES.INVALID_PARAMS,
        'a filter naming more than 1,000 addresses and topic values is refused…');
      await throwsCode(() => m('eth_getLogs', { topics: [many] }), H.CODES.INVALID_PARAMS,
        '…by eth_getLogs on exactly the same rule');
      ok(typeof await m('eth_newFilter', { topics: [many.slice(0, 1000)] }) === 'string',
        'and 1,000 exactly is accepted, which is far above any real indexer');
    }

    eq(await m('eth_uninstallFilter', lf), true, 'uninstalling a live filter returns true');
    eq(await m('eth_uninstallFilter', lf), false, '…and false the second time, without erroring');
    await throwsCode(() => m('eth_getFilterChanges', lf), H.CODES.SERVER_ERROR,
      'a poll after uninstall is "filter not found"');
  }

  group('filters — a log filter across a reorg');
  {
    /* A log filter is a cursor that walks FORWARD, and this chain reorgs by
     * design — test/evm-p2p-fork.js reorgs three blocks and asserts that a
     * reorg must not silently swallow a user transaction. The same rule has to
     * hold for the events in it: without the check this group pins, a filter
     * whose cursor is already past height N never goes back when a different
     * block takes height N, so the winning branch's logs are delivered TO
     * NOBODY. An ethers listener sees the transfer that was undone and never
     * the one that happened, and it cannot tell, because a filter that returns
     * [] looks exactly like a quiet chain.
     *
     * WHAT IS DELIBERATELY NOT CLAIMED: `removed: true` for the logs already
     * delivered off the losing branch. geth sends those from a feed that
     * RETAINS results per subscription, and retaining results is precisely the
     * grow-forever shape filters.js exists to refuse. A client that must
     * reconcile reads `blockHash` — the same answer the block filter gives, and
     * `removed` is on every log for exactly that purpose.
     */
    let height = 3n;
    const branch = new Map();          // height -> block
    const branchReceipts = new Map();  // height -> receipts
    const forking = {
      ...chain,
      blockNumber: () => height,
      getBlockByNumber(n, fullTx) {
        return branch.has(Number(n)) ? branch.get(Number(n)) : chain.getBlockByNumber(n, fullTx);
      },
      getBlockReceipts(n) {
        return branchReceipts.has(Number(n)) ? branchReceipts.get(Number(n)) : chain.getBlockReceipts(n);
      },
    };
    /** Put `logs` at height `n` on a branch named by `seed`, and make it the tip. */
    const put = (n, logs, seed) => {
      const hash = h32(seed + ':' + n);
      branch.set(n, {
        ...BLOCKS[3], number: BigInt(n), hash, parentHash: h32(seed + ':' + (n - 1)),
        logsBloom: bloomFor(logs), transactions: [],
      });
      branchReceipts.set(n, logs.length ? [{
        transactionHash: h32(seed + 'tx:' + n), transactionIndex: 0n, blockHash: hash, blockNumber: BigInt(n),
        from: ADDR_ALICE, to: ADDR_TOKEN, cumulativeGasUsed: 21_000n, gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n, contractAddress: null, status: 1,
        logs: logs.map((l, i) => ({ ...l, logIndex: BigInt(i) })), logsBloom: bloomFor(logs),
      }] : []);
      height = BigInt(n);
    };
    const LOG = v => ({ address: ADDR_TOKEN, topics: [T_TRANSFER, T_ALICE, T_BOB], data: pad32(v) });
    const s = makeServer({ chain: forking });
    const m = (name, ...params) => s.methods[name](params, { remote: '10.9.9.9' });
    const data = logs => logs.map(l => l.data);
    const w = v => '0x' + pad32(v).toString('hex');

    const lf = await m('eth_newFilter', { address: '0x' + ADDR_TOKEN.toString('hex') });
    put(4, [LOG('a1')], 'A'); put(5, [LOG('a2')], 'A'); put(6, [LOG('a3')], 'A');
    eq(data(await m('eth_getFilterChanges', lf)), [w('a1'), w('a2'), w('a3')],
      'three blocks of logs arrive on the first branch');

    // The reorg: a heavier branch replaces heights 5 and 6 with different blocks.
    put(5, [LOG('b2')], 'B'); put(6, [LOG('b3')], 'B');
    eq(data(await m('eth_getFilterChanges', lf)), [w('b2'), w('b3')],
      'the REPLACEMENT branch\'s logs are delivered — the cursor rewound to the deepest changed height');
    eq(await m('eth_getFilterChanges', lf), [], 'and once the branch is settled the filter goes quiet again');

    // A chain that got SHORTER, which is the same detection with no blocks to serve yet.
    branch.delete(6); branchReceipts.delete(6); height = 5n;
    eq(await m('eth_getFilterChanges', lf), [], 'a chain that lost its tip has nothing to deliver…');
    put(6, [LOG('c3')], 'C');
    eq(data(await m('eth_getFilterChanges', lf)), [w('c3')], '…and delivers the height again when it is refilled');

    /* THE MEMORY THIS COSTS, which is the reason it is bounded at all. The
     * filter remembers the hashes of the last `confirmations` heights it
     * scanned — 12 × 32 bytes — and a reorg deeper than that rewinds only as
     * far as it remembers. That boundary is asserted rather than described,
     * because "as deep as it happens to go" is how an unauthenticated endpoint
     * acquires an unbounded per-filter allocation. */
    const stored = s.filters.byId.get(lf);
    for (let n = 7; n <= 40; n++) put(n, [], 'C');
    await m('eth_getFilterChanges', lf);
    eq(stored.seen.length, 12, 'a filter remembers exactly 12 block hashes, however long it has run');
    for (let n = 20; n <= 40; n++) put(n, [LOG('d' + n)], 'D');
    const deep = await m('eth_getFilterChanges', lf);
    eq(deep.length, 12, 'a reorg deeper than the memory rewinds as far as the memory goes, and no further');
    eq(deep[0].blockNumber, '0x1d', '…which is 12 blocks back from the tip it had reached');
  }

  group('filters — bounded lifetime and a cap per caller');
  {
    /* Filters are the only server-side state in this layer, on an endpoint with
     * no auth and CORS `*`. Untouched, "one filter per request, kept forever" is
     * a memory leak with an HTTP interface in front of it. */
    let clock = 1_000_000;
    const registry = new FilterRegistry({ ttlMs: 1000, maxPerCaller: 3, maxFilters: 5, now: () => clock });
    const s = makeServer({ chain, filters: registry });
    const call = (name, params, remote) => s.handle({ jsonrpc: '2.0', id: 1, method: name, params }, { remote });
    const newFilter = remote => call('eth_newBlockFilter', [], remote);

    const mine1 = [];
    for (let i = 0; i < 4; i++) mine1.push(await newFilter('10.0.0.1'));
    eq(mine1.slice(0, 3).every(r => typeof r.result === 'string'), true, 'three filters from one address are fine');
    eq(mine1[3].error.code, -32000, 'the fourth is refused…');
    ok(/limit 3/.test(mine1[3].error.message), '…naming the limit');
    ok(/eth_uninstallFilter/.test(mine1[3].error.message), '…and the remedy');
    eq(registry.size, 3, 'and nothing was evicted to make room');

    const other = [];
    for (let i = 0; i < 3; i++) other.push(await newFilter('10.0.0.2'));
    eq(registry.size, 5, 'a second address fills the node to its global cap');
    ok(/maximum of 5 filters/.test(other[2].error.message),
      'the global cap refuses rather than evicting — evicting punishes the well-behaved client');

    clock += 1001;
    eq((await call('eth_getFilterChanges', [mine1[0].result], '10.0.0.1')).error.message, 'filter not found',
      'a filter past its TTL is gone');
    eq(registry.size, 0, 'and the sweep took every expired one with it');
    eq(registry.perCaller.size, 0, 'including the per-caller counters, which are deleted at zero');
    ok(typeof (await newFilter('10.0.0.1')).result === 'string', 'so the address can create again');

    // the TTL is measured from LAST USE, not from creation
    const live = (await newFilter('10.0.0.3')).result;
    for (let i = 0; i < 5; i++) { clock += 600; await call('eth_getFilterChanges', [live], '10.0.0.3'); }
    ok(!(await call('eth_getFilterChanges', [live], '10.0.0.3')).error,
      'a filter polled every 600 ms survives a 1000 ms TTL for as long as it is polled');
    clock += 1001;
    ok((await call('eth_getFilterChanges', [live], '10.0.0.3')).error, '…and dies once it is not');

    /* The cap is keyed on the transport's view of the caller, which is why the
     * context has to reach the method at all. Nothing else in this layer reads
     * it, and no method's ANSWER depends on it. */
    eq(registry.byId.get(live), undefined, 'an expired filter holds nothing at all');
  }

  // ---- server: dispatch, batching, errors ---------------------------------
  group('server — dispatch and id echoing');
  eq(await req('eth_chainId', []), { jsonrpc: '2.0', id: 1, result: '0x1cf3' }, 'a single call round trip');
  eq((await req('eth_chainId', [], 'abc')).id, 'abc', 'a string id is echoed unchanged');
  eq((await req('eth_chainId', [], 0)).id, 0, 'id 0 is echoed as 0, not dropped');
  eq((await req('eth_chainId', [], null)).id, null, 'an explicit null id is echoed as null');
  eq(await srv.handle({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionByHash', params: ['0x' + '77'.repeat(32)] }),
    { jsonrpc: '2.0', id: 2, result: null }, 'a null result is still a result, not an error');
  eq(await srv.handle({ jsonrpc: '2.0', id: 3, method: 'eth_chainId' }),
    { jsonrpc: '2.0', id: 3, result: '0x1cf3' }, 'omitted params default to none');
  eq(await srv.handle({ id: 4, method: 'eth_chainId', params: [] }),
    { jsonrpc: '2.0', id: 4, result: '0x1cf3' }, 'a missing jsonrpc field is tolerated');

  group('server — notifications');
  eq(await srv.handle({ jsonrpc: '2.0', method: 'eth_chainId', params: [] }), null,
    'a request with no id is a notification and gets no response');
  eq(await srv.handle({ jsonrpc: '2.0', method: 'eth_nope', params: [] }), null,
    'a notification gets no response even when it fails');
  eq(await srv.handleRaw('{"jsonrpc":"2.0","method":"eth_chainId"}'), '',
    'a notification produces an empty body');

  group('server — errors');
  eq(await srv.handleRaw('{not json'), JSON.stringify({
    jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' },
  }), 'malformed JSON is -32700 with id null');
  eq((await req('eth_nonesuch', [])).error.code, -32601, 'an unknown method is -32601');
  ok(/eth_nonesuch/.test((await req('eth_nonesuch', [])).error.message), 'the error names the method');
  eq((await req('eth_getBalance', [])).error.code, -32602, 'a missing argument is -32602');
  eq((await req('eth_getBalance', ['0xzz', 'latest'])).error.code, -32602, 'malformed hex is -32602');
  eq((await srv.handle({ jsonrpc: '2.0', id: 5, method: 'eth_chainId', params: { a: 1 } })).error.code, -32602,
    'named parameters are -32602');
  eq((await srv.handle({ jsonrpc: '2.0', id: 5, method: 'eth_chainId', params: 'x' })).error.code, -32602,
    'non-array params are -32602');
  eq((await srv.handle({ jsonrpc: '2.0', id: 6, method: 42 })).error.code, -32600, 'a non-string method is -32600');
  eq((await srv.handle({ jsonrpc: '1.0', id: 6, method: 'eth_chainId' })).error.code, -32600,
    'the wrong jsonrpc version is -32600');
  eq((await srv.handle('nonsense')).error.code, -32600, 'a non-object request is -32600');
  eq((await srv.handle([])).error.code, -32600, 'an empty batch is -32600');
  eq((await srv.handle({ jsonrpc: '2.0', id: {}, method: 'eth_chainId' })).error.code, -32600,
    'an object id is -32600');
  eq((await srv.handle('nonsense')).id, null, 'an invalid request is answered with id null');
  {
    chain.throwNext = new Error('disk on fire');
    const r = await req('eth_getBlockByNumber', ['0x1', false]);
    eq(r.error.code, -32603, 'an unexpected exception inside a handler is -32603');
    ok(/disk on fire/.test(r.error.message), 'the internal error keeps its message');
    ok(r.error.data === undefined, 'no stack leaks to the caller');
  }
  {
    const r = await req('eth_call', [{ to: '0x' + ADDR_TOKEN.toString('hex'), data: '0xdeadbeef' }, 'latest']);
    eq(r.error.code, 3, 'a revert reaches the wire as code 3');
    eq(r.error.data, '0x' + REVERT_STRING.toString('hex'), 'and carries its data — this is what ethers decodes');
    ok(r.result === undefined, 'an error response has no result member');
  }

  group('server — batching');
  {
    const batch = await srv.handle([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 'two', method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },          // notification
      { jsonrpc: '2.0', id: 4, method: 'eth_nope', params: [] },
      'garbage',
    ]);
    eq(batch.length, 4, 'a batch answers every non-notification member');
    eq(batch.map(r => r.id), [1, 'two', 4, null], 'batch ids are echoed in order, including the invalid member');
    eq(batch[0].result, '0x1cf3', 'the first batch member answered');
    eq(batch[2].error.code, -32601, 'a bad method inside a batch fails only that member');
    eq(batch[3].error.code, -32600, 'a non-object batch member is answered with -32600 and id null');
    eq(batch[4], undefined, 'the notification produced no response, so the batch is one shorter');
  }
  eq(await srv.handle([{ jsonrpc: '2.0', method: 'eth_chainId', params: [] }]), null,
    'an all-notification batch produces no response at all');
  eq(await srv.handleRaw('[{"jsonrpc":"2.0","id":9,"method":"eth_chainId","params":[]}]'),
    '[{"jsonrpc":"2.0","id":9,"result":"0x1cf3"}]', 'a batch round trips through handleRaw');

  group('server — what one request may cost');
  {
    /* A batch is executed member by member on the only thread this node has, and
     * `eth_call` executes EVM code. Unbounded, ONE POST buys as many executions as
     * fits in the 5 MB body limit: measured against the real chain, 32 blake2f
     * calls in a single 14 kB POST held the process for 359.8 seconds. */
    const member = (id) => ({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] });
    const small = makeServer({ maxBatchSize: 4 });
    const four = await small.handle([1, 2, 3, 4].map(member));
    eq(four.length, 4, 'a batch at the limit is answered in full');
    const five = await small.handle([1, 2, 3, 4, 5].map(member));
    ok(!Array.isArray(five), 'a batch over the limit is refused WHOLE — a truncated array lines up against the wrong requests');
    eq(five.error.code, -32600, '…as an invalid request');
    ok(/batch of 5 exceeds the limit of 4/.test(five.error.message), '…naming both numbers, so the fix is obvious');
    eq(five.id, null, '…with a null id, since the batch itself had none');
    eq(srv.maxBatchSize, 1000, 'and the default limit is geth\'s 1000 members');
  }
  {
    // A chain that never answers, so requests are provably still open. Anything
    // timing-based here would be a flaky test of a limit that is not about time.
    const held = [];
    const stuck = { ...chain, call: () => new Promise(resolve => held.push(resolve)) };
    const srv2 = makeServer({ chain: stuck, maxInFlightPerIp: 2 });
    const listener = srv2.listen(0, '127.0.0.1');
    await new Promise(r => listener.once('listening', r));
    const port = listener.address().port;
    const post = (body) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } },
        res => { let t = ''; res.on('data', d => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t })); });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
    const slow = () => post('{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x00000000000000000000000000000000000000aa"},"latest"]}');

    const a = slow(), b = slow();
    while (held.length < 2) await new Promise(r => setTimeout(r, 5));   // both really in flight
    const third = await slow();
    eq(third.status, 429, 'a third concurrent request from one address is refused with 429');
    eq(third.headers['retry-after'], '1', '…with a retry-after, because it is a queue and not a ban');
    ok(/limit 2/.test(JSON.parse(third.body).error.message), '…naming the limit');
    eq(JSON.parse(third.body).error.code, -32000, '…as a server error, in a well-formed JSON-RPC body');
    eq(held.length, 2, 'and the refused request never reached the chain');

    for (const resolve of held.splice(0)) resolve({ ok: true, returnData: Buffer.alloc(0) });
    await a; await b;
    const after = slow();
    while (held.length < 1) await new Promise(r => setTimeout(r, 5));
    ok(true, 'a finished request gives its slot back');
    held.splice(0).forEach(resolve => resolve({ ok: true, returnData: Buffer.alloc(0) }));
    await after;
    eq(srv2.inFlight.size, 0, 'and the counter is deleted at zero rather than kept per address forever');
    srv2.close();
    await new Promise(r => listener.close(r));
  }

  // ---- HTTP transport ------------------------------------------------------
  group('server — HTTP transport');
  {
    const httpSrv = makeServer();
    const listener = httpSrv.listen(0, '127.0.0.1');
    await new Promise(r => listener.once('listening', r));
    const port = listener.address().port;
    const post = (body, method = 'POST') => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: '/', headers: { 'content-type': 'application/json' } },
        res => {
          let t = ''; res.on('data', d => { t += d; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t }));
        });
      r.on('error', reject);
      if (body !== null) r.write(body);
      r.end();
    });
    const r1 = await post('{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
    eq(r1.status, 200, 'a POST answers 200');
    eq(JSON.parse(r1.body).result, '0x1cf3', 'and carries the result');
    eq(r1.headers['access-control-allow-origin'], '*', 'CORS is open, as for the REST API');
    const r2 = await post('{"jsonrpc":"2.0","id":1,"method":"eth_nonesuch","params":[]}');
    eq(r2.status, 200, 'an RPC-level error is still HTTP 200 — a 500 makes clients retry instead of report');
    const r3 = await post('{ bad', 'POST');
    eq(JSON.parse(r3.body).error.code, -32700, 'a bad body is a parse error over HTTP too');
    const r4 = await post(null, 'GET');
    eq(r4.status, 405, 'GET is refused with 405');
    httpSrv.close();
    await new Promise(r => listener.close(r));
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
