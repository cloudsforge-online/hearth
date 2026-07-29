/* A canned chain, served over the real transport interface.
 *
 * WHY THIS EXISTS. The account-model chain is phase 5 (docs/evm-spec.md §8) and
 * does not exist yet. Everything in this explorer is written against the
 * interface documented at the top of node/src/jsonrpc/methods.js, and this file
 * is the same trick that layer used to test itself: an in-memory fake that
 * answers exactly what the wire would carry — hex QUANTITY and DATA strings,
 * canonically encoded — so the page has one code path whether the data is real
 * or canned. If this fake can answer something phase 5 cannot, one of the two is
 * wrong, and that argument is worth having before the chain ships.
 *
 * WHAT IS IN IT. Deliberately, the states an explorer spends most of its time
 * showing and that demos skip:
 *
 *   - a transaction that REVERTED, with a decodable `Error(string)` reason
 *   - a transaction that reverted with Panic(0x11), arithmetic overflow
 *   - a PENDING transaction: a tx object with null blockNumber and a null receipt
 *   - an address with NO history at all
 *   - a contract with no verified source and no recognisable selectors
 *   - an empty block, which is what most blocks are
 *   - a token transfer that is a mint (from the zero address)
 *   - and, via ?fixtures=down, an endpoint that answers nothing
 *
 * It is loudly labelled everywhere it is used. The old explorer's sample-data
 * mode existed to make an unreachable node look like a working one; this one is
 * opt-in from the URL and never engages on its own.
 */

import { keccak256, keccak256Hex, utf8 } from './keccak.js';
import { toBytes, toHex, qty, padTopic } from './format.js';
import { selectorOf, topicOf, TRANSFER_TOPIC, APPROVAL_TOPIC } from './abi.js';
import { RpcUnreachable } from './rpc.js';
import { chainId } from '../chain.js';

/* The canned chain answers with the id this bundle is configured for. It has to:
 * a fixture chain that reported a different id would trip the explorer's own
 * "this is not chain N" banner on every fixture tour, which is the one state
 * the fixtures exist to let a reviewer see WITHOUT a real node. */
const CHAIN_ID = BigInt(chainId());
const GAS_LIMIT = 30_000_000n;
const GWEI = 1_000_000_000n;
const ETHER = 10n ** 18n;

const A = {
  miner:   '0x1e5a7c04b2f9d3e8a06c5b4d9f2e7a1c3b8d0e64',
  alice:   '0x7b0c2e9d4a6f81b3c5d7e9f0a2b4c6d8e0f13579',
  bob:     '0x3f9a1d7c5e2b8046a9c3e5d7f1b3a5c7e9d0b246',
  dead:    '0x000000000000000000000000000000000000dead',
  wember:  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  usdf:    '0x9d4a3e7b1c5f8206d4e7a9c1b3d5f709e2a4c681',
  pair:    '0x5c8e1a3d7f9b02c46e8a0d2f4b6c8e1a3d5f7092',
  router:  '0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  proxy:   '0xdeadbeef00112233445566778899aabbccddeeff',
  // A PLACEHOLDER, and the supply view says so. docs/tokenomics.md §8 records
  // that the account-model Commons address "has not been chosen and is not in
  // the spec" — so there is no real value to put here, and inventing one that
  // looked real would be worse than an obvious stand-in.
  commons: '0x00000000000000000000000000000000000c0115',
  zero:    '0x0000000000000000000000000000000000000000',
};

// ---- a very small assembler, so the fixture's bytecode is real bytecode -----

const OP = {
  STOP: 0x00, ADD: 0x01, SUB: 0x03, LT: 0x10, GT: 0x11, EQ: 0x14, ISZERO: 0x15,
  AND: 0x16, SHR: 0x1c, KECCAK256: 0x20, CALLER: 0x33, CALLVALUE: 0x34,
  CALLDATALOAD: 0x35, CALLDATASIZE: 0x36, CODECOPY: 0x39, POP: 0x50, MLOAD: 0x51,
  MSTORE: 0x52, SLOAD: 0x54, SSTORE: 0x55, JUMP: 0x56, JUMPI: 0x57, JUMPDEST: 0x5b,
  PUSH0: 0x5f, DUP1: 0x80, DUP2: 0x81, DUP3: 0x82, SWAP1: 0x90, SWAP2: 0x91,
  LOG3: 0xa3, RETURN: 0xf3, REVERT: 0xfd, INVALID: 0xfe,
};
const push = (n, hex) => [0x5f + n, ...toBytes('0x' + hex.replace(/^0x/, '').padStart(n * 2, '0'))];
const push1 = v => push(1, v.toString(16));
const push2 = v => push(2, v.toString(16));
const push4 = sel => push(4, sel);

/** A plausible solc-shaped dispatcher over the ERC-20 selectors, plus a body. */
function tokenCode() {
  const b = [
    ...push1(0x80), ...push1(0x40), OP.MSTORE,            // free memory pointer
    OP.CALLVALUE, OP.DUP1, OP.ISZERO, ...push2(0x0010), OP.JUMPI,
    OP.PUSH0, OP.DUP1, OP.REVERT,                          // non-payable guard
    OP.JUMPDEST, OP.POP,
    ...push1(0x04), OP.CALLDATASIZE, OP.LT, ...push2(0x00b4), OP.JUMPI,
    OP.PUSH0, OP.CALLDATALOAD, ...push1(0xe0), OP.SHR,      // selector
  ];
  const targets = [
    ['balanceOf(address)', 0x00c0], ['transfer(address,uint256)', 0x0100],
    ['totalSupply()', 0x0140], ['symbol()', 0x0160], ['name()', 0x0180],
    ['decimals()', 0x01a0], ['approve(address,uint256)', 0x01c0],
    ['allowance(address,address)', 0x0200], ['transferFrom(address,address,uint256)', 0x0220],
  ];
  for (const [sig, dest] of targets) {
    b.push(OP.DUP1, ...push4(selectorOf(sig).slice(2)), OP.EQ, ...push2(dest), OP.JUMPI);
  }
  b.push(OP.JUMPDEST, OP.PUSH0, OP.DUP1, OP.REVERT);        // fallback
  // one function body, so the disassembly has storage reads, a log and a return
  b.push(OP.JUMPDEST, ...push1(0x04), OP.CALLDATALOAD, OP.PUSH0, OP.MSTORE,
    ...push1(0x20), OP.PUSH0, OP.KECCAK256, OP.SLOAD, OP.PUSH0, OP.MSTORE,
    ...push1(0x20), OP.PUSH0, OP.RETURN);
  b.push(OP.JUMPDEST, OP.CALLER, ...push1(0x24), OP.CALLDATALOAD, OP.DUP2, OP.SLOAD,
    OP.SUB, OP.DUP2, OP.SSTORE, ...push(32, TRANSFER_TOPIC.slice(2)), OP.LOG3,
    ...push1(0x01), OP.PUSH0, OP.MSTORE, ...push1(0x20), OP.PUSH0, OP.RETURN);
  b.push(OP.INVALID);
  // solc appends CBOR metadata after the runtime code; a disassembler walking
  // past the end of executable code and printing rubbish is normal and expected.
  b.push(...toBytes('0xa2646970667358221220' + '5f'.repeat(32) + '64736f6c6343000814' + '0033'));
  return toHex(Uint8Array.from(b));
}

/** EIP-1167 minimal proxy: a real contract with no dispatcher and no selectors. */
function proxyCode(impl) {
  return '0x363d3d373d3d3d363d73' + impl.replace(/^0x/, '') + '5af43d82803e903d91602b57fd5bf3';
}

const CODE = {
  [A.wember]: tokenCode(),
  [A.usdf]: tokenCode(),
  [A.pair]: tokenCode(),
  [A.router]: tokenCode(),
  [A.proxy]: proxyCode(A.router),
};

// ---- bloom (go-ethereum bloom9, matching node/src/chain/bloom.js) -----------

function bloomAdd(bloom, itemHex) {
  const h = keccak256(toBytes(itemHex));
  for (let i = 0; i < 6; i += 2) {
    const bit = ((h[i] << 8) | h[i + 1]) & 0x7ff;
    bloom[255 - (bit >> 3)] |= 1 << (bit & 7);
  }
  return bloom;
}
function bloomFor(logs) {
  const b = new Uint8Array(256);
  for (const l of logs) { bloomAdd(b, l.address); for (const t of l.topics) bloomAdd(b, t); }
  return toHex(b);
}

// ---- the chain -------------------------------------------------------------

const h32 = seed => keccak256Hex(utf8('hearth-fixture:' + seed));
/* Hashes are derived from height alone, so they are reproducible; the tip's
 * timestamp is not, because a fixed one would make every block on the page read
 * as days old (or, worse, in the future) and hide whether ages render at all. */
const TIP_TIME = Math.floor(Date.now() / 15000) * 15;
const BASE_HEIGHT = 4200;

const log = (address, topics, data) => ({ address, topics, data });
const tokenTransferLog = (token, from, to, value) =>
  log(token, [TRANSFER_TOPIC, padTopic(from), padTopic(to)], padTopic(value.toString(16)));

/** Definitions, in block order. Everything below is derived from this. */
const PLAN = [
  { height: 4200, txs: [] },
  { height: 4201, txs: [
    { tag: 'send', from: A.alice, to: A.bob, value: 25n * ETHER / 10n, gas: 21000n, gasUsed: 21000n,
      gasPrice: 12n * GWEI, nonce: 7n, input: '0x', status: 1, logs: [] },
  ] },
  { height: 4202, txs: [
    { tag: 'wrap', from: A.alice, to: A.wember, value: 100n * ETHER, gas: 60000n, gasUsed: 45238n,
      gasPrice: 12n * GWEI, nonce: 8n, input: selectorOf('deposit()'), status: 1,
      logs: [
        log(A.wember, [topicOf('Deposit(address,uint256)'), padTopic(A.alice)], padTopic((100n * ETHER).toString(16))),
        tokenTransferLog(A.wember, A.zero, A.alice, 100n * ETHER),
      ] },
    { tag: 'erc20', from: A.alice, to: A.usdf, value: 0n, gas: 80000n, gasUsed: 51_284n,
      gasPrice: 13n * GWEI, nonce: 9n, status: 1,
      input: selectorOf('transfer(address,uint256)') + padTopic(A.bob).slice(2) + padTopic((1500n * 10n ** 6n).toString(16)).slice(2),
      logs: [tokenTransferLog(A.usdf, A.alice, A.bob, 1500n * 10n ** 6n)] },
  ] },
  { height: 4203, txs: [
    { tag: 'deploy', from: A.bob, to: null, value: 0n, gas: 1_200_000n, gasUsed: 1_043_772n,
      gasPrice: 14n * GWEI, nonce: 2n, status: 1, created: A.proxy,
      input: '0x608060405234801561000f575f80fd5b50' + '61' + '02' + 'a4' + '80' + '61001d5f395ff3fe' + proxyCode(A.router).slice(2),
      logs: [] },
  ] },
  { height: 4204, txs: [
    { tag: 'swap', from: A.bob, to: A.router, value: 0n, gas: 220000n, gasUsed: 154_912n,
      gasPrice: 15n * GWEI, nonce: 3n, status: 1,
      input: selectorOf('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)')
        + padTopic((1000n * 10n ** 6n).toString(16)).slice(2) + padTopic((49n * ETHER / 100n).toString(16)).slice(2)
        + padTopic('a0').slice(2) + padTopic(A.bob).slice(2) + padTopic((TIP_TIME + 600).toString(16)).slice(2),
      logs: [
        tokenTransferLog(A.usdf, A.bob, A.pair, 1000n * 10n ** 6n),
        tokenTransferLog(A.wember, A.pair, A.bob, 4987n * ETHER / 10000n),
        log(A.pair, [topicOf('Sync(uint112,uint112)')],
          padTopic((84210n * 10n ** 6n).toString(16)) + padTopic((41_500n * ETHER).toString(16)).slice(2)),
        log(A.pair, [topicOf('Swap(address,uint256,uint256,uint256,uint256,address)'),
          padTopic(A.router), padTopic(A.bob)],
        padTopic((1000n * 10n ** 6n).toString(16)) + padTopic('0').slice(2)
            + padTopic('0').slice(2) + padTopic((4987n * ETHER / 10000n).toString(16)).slice(2)),
      ] },
    { tag: 'approve', from: A.bob, to: A.usdf, value: 0n, gas: 50000n, gasUsed: 46_182n,
      gasPrice: 15n * GWEI, nonce: 4n, status: 1,
      input: selectorOf('approve(address,uint256)') + padTopic(A.router).slice(2) + 'f'.repeat(64),
      logs: [log(A.usdf, [APPROVAL_TOPIC, padTopic(A.bob), padTopic(A.router)], '0x' + 'f'.repeat(64))] },
  ] },
  { height: 4205, txs: [
    // The one every demo skips: mined, paid for, and it failed.
    { tag: 'revert', from: A.alice, to: A.router, value: 0n, gas: 250000n, gasUsed: 61_204n,
      gasPrice: 15n * GWEI, nonce: 10n, status: 0,
      input: selectorOf('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)')
        + padTopic((5000n * 10n ** 6n).toString(16)).slice(2) + padTopic((99n * ETHER).toString(16)).slice(2)
        + padTopic('a0').slice(2) + padTopic(A.alice).slice(2) + padTopic((TIP_TIME - 60).toString(16)).slice(2),
      logs: [],
      revert: errorString('EmberSwap: INSUFFICIENT_OUTPUT_AMOUNT') },
    { tag: 'panic', from: A.bob, to: A.usdf, value: 0n, gas: 90000n, gasUsed: 24_318n,
      gasPrice: 15n * GWEI, nonce: 5n, status: 0,
      input: selectorOf('transfer(address,uint256)') + padTopic(A.alice).slice(2) + 'f'.repeat(64),
      logs: [],
      revert: '0x4e487b71' + padTopic('11').slice(2) },
  ] },
  { height: 4206, txs: [
    { tag: 'mint', from: A.miner, to: A.usdf, value: 0n, gas: 70000n, gasUsed: 52_100n,
      gasPrice: 11n * GWEI, nonce: 41n, status: 1,
      input: selectorOf('mint(address,uint256)') + padTopic(A.alice).slice(2) + padTopic((250_000n * 10n ** 6n).toString(16)).slice(2),
      logs: [tokenTransferLog(A.usdf, A.zero, A.alice, 250_000n * 10n ** 6n)] },
  ] },
  { height: 4207, txs: [] },       // the tip, empty — which most blocks are
];

/** ABI-encode Error(string) exactly as Solidity's `require(cond, "…")` does. */
function errorString(msg) {
  const bytes = utf8(msg);
  const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  padded.set(bytes);
  return selectorOf('Error(string)') + padTopic('20').slice(2)
    + padTopic(bytes.length.toString(16)).slice(2) + toHex(padded).slice(2);
}

const BLOCKS = [];
const TXS = new Map();
const RECEIPTS = new Map();
const BY_NUMBER = new Map();
const BY_HASH = new Map();

(function build() {
  let totalDifficulty = 0n;
  let parentHash = h32('parent:4199');
  for (const spec of PLAN) {
    const hash = h32('block:' + spec.height);
    const difficulty = 18_446_744_073_709_551_616n + BigInt(spec.height) * 1_000_003n;
    totalDifficulty += difficulty;
    const timestamp = TIP_TIME - (4207 - spec.height) * 15;
    const txs = [];
    const receipts = [];
    let cumulative = 0n;
    let logIndex = 0;
    const allLogs = [];
    spec.txs.forEach((t, i) => {
      const txHash = h32('tx:' + t.tag);
      cumulative += t.gasUsed;
      const tx = {
        hash: txHash, nonce: t.nonce, from: t.from, to: t.to ?? null, value: t.value,
        gas: t.gas, gasPrice: t.gasPrice, input: t.input || '0x',
        v: CHAIN_ID * 2n + 35n + BigInt(i % 2), r: BigInt(h32('r:' + t.tag)), s: BigInt(h32('s:' + t.tag)),
        chainId: CHAIN_ID, blockHash: hash, blockNumber: BigInt(spec.height), transactionIndex: BigInt(i),
      };
      const logs = (t.logs || []).map(l => ({
        ...l,
        blockNumber: BigInt(spec.height), blockHash: hash, transactionHash: txHash,
        transactionIndex: BigInt(i), logIndex: BigInt(logIndex++), removed: false,
      }));
      allLogs.push(...logs);
      const receipt = {
        transactionHash: txHash, transactionIndex: BigInt(i), blockHash: hash,
        blockNumber: BigInt(spec.height), from: t.from, to: t.to ?? null,
        cumulativeGasUsed: cumulative, gasUsed: t.gasUsed, effectiveGasPrice: t.gasPrice,
        contractAddress: t.created || null, logs, logsBloom: bloomFor(logs), status: t.status,
      };
      txs.push(tx);
      receipts.push(receipt);
      TXS.set(txHash, { tx, revert: t.revert || null });
      RECEIPTS.set(txHash, receipt);
    });
    const gasUsed = cumulative;
    const block = {
      number: BigInt(spec.height), hash, parentHash,
      nonce: '0x' + h32('nonce:' + spec.height).slice(2, 18),
      mixHash: h32('homefire:' + spec.height),
      logsBloom: bloomFor(allLogs),
      transactionsRoot: h32('txroot:' + spec.height),
      stateRoot: h32('stateroot:' + spec.height),
      receiptsRoot: h32('receiptsroot:' + spec.height),
      miner: A.miner, difficulty, totalDifficulty,
      extraData: toHex(utf8('hearth/homefire')),
      size: BigInt(541 + txs.length * 312),
      gasLimit: GAS_LIMIT, gasUsed, timestamp: BigInt(timestamp),
      transactions: txs, receipts,
    };
    BLOCKS.push(block);
    BY_NUMBER.set(spec.height, block);
    BY_HASH.set(hash, block);
    parentHash = hash;
  }
})();

const TIP = BLOCKS[BLOCKS.length - 1];

/** A transaction sitting in the mempool: real tx object, null receipt. */
const PENDING = {
  hash: h32('tx:pending'), nonce: 11n, from: A.alice, to: A.bob, value: ETHER / 2n,
  gas: 21000n, gasPrice: 18n * GWEI, input: '0x', v: CHAIN_ID * 2n + 35n,
  r: BigInt(h32('r:pending')), s: BigInt(h32('s:pending')), chainId: CHAIN_ID,
  blockHash: null, blockNumber: null, transactionIndex: null,
};
TXS.set(PENDING.hash, { tx: PENDING, revert: null });

/** Balances and nonces. Anything not listed is a zero account, which is correct. */
const STATE = {
  [A.alice]: { balance: 812n * ETHER + 431000000000000000n, nonce: 11n },
  [A.bob]: { balance: 194n * ETHER, nonce: 6n },
  [A.miner]: { balance: 5321n * ETHER, nonce: 42n },
  [A.wember]: { balance: 41_500n * ETHER, nonce: 1n },
  [A.usdf]: { balance: 0n, nonce: 1n },
  [A.pair]: { balance: 0n, nonce: 1n },
  [A.router]: { balance: 0n, nonce: 1n },
  [A.proxy]: { balance: 0n, nonce: 1n },
  [A.commons]: { balance: 1_284_600n * ETHER, nonce: 0n },
};

/** Canned eth_call answers, keyed by `to:selector`. */
const TOKEN_META = {
  [A.wember]: { name: 'Wrapped EMBER', symbol: 'WEMBER', decimals: 18n, totalSupply: 41_500n * ETHER },
  [A.usdf]: { name: 'Forge USD', symbol: 'USDF', decimals: 6n, totalSupply: 12_400_000n * 10n ** 6n },
  [A.pair]: { name: 'EmberSwap V2', symbol: 'EMB-V2', decimals: 18n, totalSupply: 1834n * ETHER },
};
const TOKEN_BALANCES = {
  [A.usdf]: { [A.alice]: 248_500n * 10n ** 6n, [A.bob]: 2500n * 10n ** 6n, [A.pair]: 84_210n * 10n ** 6n },
  [A.wember]: { [A.alice]: 100n * ETHER, [A.bob]: 4987n * ETHER / 10000n, [A.pair]: 41_500n * ETHER },
};

// ---- wire encoding ---------------------------------------------------------

const D = hex => String(hex || '0x').toLowerCase();
const fixed = (hex, bytes) => '0x' + String(hex).replace(/^0x/, '').toLowerCase().padStart(bytes * 2, '0');

function wireLog(l) {
  return {
    address: D(l.address), topics: (l.topics || []).map(t => fixed(t, 32)), data: D(l.data || '0x'),
    blockNumber: qty(l.blockNumber), blockHash: fixed(l.blockHash, 32),
    transactionHash: fixed(l.transactionHash, 32), transactionIndex: qty(l.transactionIndex),
    logIndex: qty(l.logIndex), removed: !!l.removed,
  };
}

function wireTx(tx) {
  const out = {
    blockHash: tx.blockHash ? fixed(tx.blockHash, 32) : null,
    blockNumber: tx.blockNumber === null ? null : qty(tx.blockNumber),
    transactionIndex: tx.transactionIndex === null ? null : qty(tx.transactionIndex),
    hash: fixed(tx.hash, 32), from: D(tx.from), to: tx.to ? D(tx.to) : null,
    value: qty(tx.value), gas: qty(tx.gas), gasPrice: qty(tx.gasPrice),
    input: D(tx.input || '0x'), nonce: qty(tx.nonce), type: '0x0',
    v: qty(tx.v), r: qty(tx.r), s: qty(tx.s),
  };
  if (tx.chainId !== null && tx.chainId !== undefined) out.chainId = qty(tx.chainId);
  return out;
}

function wireReceipt(r) {
  return {
    transactionHash: fixed(r.transactionHash, 32), transactionIndex: qty(r.transactionIndex),
    blockHash: fixed(r.blockHash, 32), blockNumber: qty(r.blockNumber),
    from: D(r.from), to: r.to ? D(r.to) : null,
    cumulativeGasUsed: qty(r.cumulativeGasUsed), gasUsed: qty(r.gasUsed),
    effectiveGasPrice: qty(r.effectiveGasPrice),
    contractAddress: r.contractAddress ? D(r.contractAddress) : null,
    logs: r.logs.map(wireLog), logsBloom: fixed(r.logsBloom, 256),
    status: r.status ? '0x1' : '0x0', type: '0x0',
  };
}

const EMPTY_UNCLE_HASH = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347';

function wireBlock(b, fullTx) {
  return {
    number: qty(b.number), hash: fixed(b.hash, 32), parentHash: fixed(b.parentHash, 32),
    nonce: fixed(b.nonce, 8), sha3Uncles: EMPTY_UNCLE_HASH, logsBloom: fixed(b.logsBloom, 256),
    transactionsRoot: fixed(b.transactionsRoot, 32), stateRoot: fixed(b.stateRoot, 32),
    receiptsRoot: fixed(b.receiptsRoot, 32), miner: D(b.miner),
    difficulty: qty(b.difficulty), totalDifficulty: qty(b.totalDifficulty),
    extraData: D(b.extraData), size: qty(b.size), gasLimit: qty(b.gasLimit),
    gasUsed: qty(b.gasUsed), timestamp: qty(b.timestamp), mixHash: fixed(b.mixHash, 32),
    transactions: b.transactions.map(t => (fullTx ? wireTx(t) : fixed(t.hash, 32))),
    uncles: [],
  };
}

// ---- the method implementations -------------------------------------------

function resolveRef(param) {
  if (param === undefined || param === null || param === 'latest' || param === 'safe' || param === 'finalized') {
    return Number(TIP.number);
  }
  if (param === 'earliest') return BASE_HEIGHT;
  if (param === 'pending') return 'pending';
  return Number(BigInt(param));
}

function topicsMatch(log, topics) {
  if (topics.length > log.topics.length) return false;
  for (let i = 0; i < topics.length; i++) {
    const rule = topics[i];
    if (rule === null || rule === undefined) continue;
    const set = Array.isArray(rule) ? rule : [rule];
    if (!set.length) continue;
    if (!set.some(t => fixed(t, 32) === fixed(log.topics[i], 32))) return false;
  }
  return true;
}

function abiWord(v) { return padTopic(BigInt(v).toString(16)); }
function abiString(s) {
  const bytes = utf8(s);
  const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32 || 32);
  padded.set(bytes);
  return abiWord(32) + abiWord(bytes.length).slice(2) + toHex(padded).slice(2);
}

function doCall(msg) {
  const to = D(msg && msg.to);
  const data = D((msg && (msg.data || msg.input)) || '0x');
  const sel = data.slice(0, 10);
  const meta = TOKEN_META[to];
  if (meta) {
    if (sel === selectorOf('name()')) return abiString(meta.name);
    if (sel === selectorOf('symbol()')) return abiString(meta.symbol);
    if (sel === selectorOf('decimals()')) return abiWord(meta.decimals);
    if (sel === selectorOf('totalSupply()')) return abiWord(meta.totalSupply);
    if (sel === selectorOf('balanceOf(address)')) {
      const who = '0x' + data.slice(10).slice(24, 64);
      const bal = (TOKEN_BALANCES[to] || {})[who] ?? 0n;
      return abiWord(bal);
    }
  }
  // A call into something that is not a token: empty return, which in the EVM is
  // what a call to an address with no code does. The UI must not read that as 0.
  return '0x';
}

const METHODS = {
  eth_chainId: () => qty(CHAIN_ID),
  net_version: () => CHAIN_ID.toString(10),
  net_listening: () => true,
  web3_clientVersion: () => 'Hearth/v0.2.0-fixtures/explorer',
  eth_syncing: () => false,
  eth_accounts: () => [],
  eth_blockNumber: () => qty(TIP.number),
  eth_gasPrice: () => qty(12n * GWEI),

  eth_getBalance: ([addr]) => qty((STATE[D(addr)] || {}).balance ?? 0n),
  eth_getTransactionCount: ([addr, at]) => {
    const base = (STATE[D(addr)] || {}).nonce ?? 0n;
    // 'pending' counts the queued mempool transaction, which is the whole reason
    // the tag exists — see the note on 'pending' in methods.js.
    return qty(at === 'pending' && D(addr) === A.alice ? base + 1n : base);
  },
  eth_getCode: ([addr]) => CODE[D(addr)] || '0x',
  eth_getStorageAt: ([addr, key]) => fixed(keccak256Hex(utf8('slot:' + D(addr) + ':' + D(key))), 32),

  eth_getBlockByNumber: ([param, full]) => {
    const ref = resolveRef(param);
    if (ref === 'pending') return null;      // no pending block on this chain
    const b = BY_NUMBER.get(ref);
    return b ? wireBlock(b, !!full) : null;
  },
  eth_getBlockByHash: ([hash, full]) => {
    const b = BY_HASH.get(fixed(hash, 32));
    return b ? wireBlock(b, !!full) : null;
  },
  eth_getTransactionByHash: ([hash]) => {
    const e = TXS.get(fixed(hash, 32));
    return e ? wireTx(e.tx) : null;
  },
  eth_getTransactionReceipt: ([hash]) => {
    const r = RECEIPTS.get(fixed(hash, 32));
    return r ? wireReceipt(r) : null;        // null while pending — never an error
  },
  eth_getBlockReceipts: ([param]) => {
    const b = BY_NUMBER.get(resolveRef(param));
    return b ? b.receipts.map(wireReceipt) : null;
  },

  eth_call: ([msg, at]) => {
    // Replaying a failed transaction is how the reason for a revert is
    // recovered: the receipt does not carry one.
    const to = D(msg && msg.to);
    const data = D((msg && (msg.data || msg.input)) || '0x');
    for (const [, e] of TXS) {
      if (!e.revert) continue;
      if (D(e.tx.to) === to && D(e.tx.input) === data) {
        const err = new Error('execution reverted');
        err.rpcError = { code: 3, message: 'execution reverted', data: e.revert };
        throw err;
      }
    }
    return doCall(msg);
  },
  eth_estimateGas: ([msg]) => qty(msg && msg.data && msg.data !== '0x' ? 68_000n : 21_000n),

  eth_getLogs: ([filter]) => {
    const f = filter || {};
    let from = BASE_HEIGHT, to = Number(TIP.number);
    if (f.blockHash) {
      const b = BY_HASH.get(fixed(f.blockHash, 32));
      if (!b) { const e = new Error('unknown block'); e.rpcError = { code: -32000, message: 'unknown block' }; throw e; }
      from = to = Number(b.number);
    } else {
      if (f.fromBlock !== undefined) from = resolveRef(f.fromBlock) === 'pending' ? to : resolveRef(f.fromBlock);
      if (f.toBlock !== undefined) to = resolveRef(f.toBlock) === 'pending' ? to : resolveRef(f.toBlock);
    }
    const addrs = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map(a => D(a)) : [];
    const topics = f.topics || [];
    const out = [];
    for (let n = from; n <= to; n++) {
      const b = BY_NUMBER.get(n);
      if (!b) continue;
      for (const r of b.receipts) {
        for (const l of r.logs) {
          if (addrs.length && !addrs.includes(D(l.address))) continue;
          if (!topicsMatch(l, topics)) continue;
          out.push(wireLog(l));
        }
      }
    }
    return out;
  },
};

/**
 * The transport. Same signature as the real one in rpc.js: takes a JSON-RPC
 * payload (single or batch) and resolves to the envelope, errors included. It
 * deliberately answers `method not found` for anything unimplemented rather than
 * throwing, because that is what a node does and the UI has to cope with it.
 */
export function fixtureTransport(payload) {
  const one = msg => {
    const id = 'id' in msg ? msg.id : null;
    const fn = METHODS[msg.method];
    if (!fn) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `the method ${msg.method} does not exist/is not available` } };
    }
    try {
      const result = fn(msg.params || []);
      return { jsonrpc: '2.0', id, result: result === undefined ? null : result };
    } catch (e) {
      if (e && e.rpcError) return { jsonrpc: '2.0', id, error: e.rpcError };
      return { jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error: ' + e.message } };
    }
  };
  const res = Array.isArray(payload) ? payload.map(one) : one(payload);
  // A promise, because the real transport is async and code that accidentally
  // depends on synchronous resolution would work here and fail against a node.
  return new Promise(resolve => setTimeout(() => resolve(res), 0));
}

/** The transport for `?fixtures=down`: an endpoint that is simply not there. */
export function deadTransport() {
  return Promise.reject(new RpcUnreachable('fixture mode: simulating an unreachable node'));
}

/** Everything the gallery links to, so a reviewer can reach every state. */
export const TOUR = {
  addresses: A,
  commonsAddress: A.commons,
  blocks: { withTxs: 4204, empty: 4207, first: 4200 },
  txs: {
    send: h32('tx:send'), wrap: h32('tx:wrap'), erc20: h32('tx:erc20'),
    deploy: h32('tx:deploy'), swap: h32('tx:swap'), approve: h32('tx:approve'),
    revert: h32('tx:revert'), panic: h32('tx:panic'), mint: h32('tx:mint'),
    pending: PENDING.hash,
    unknown: '0x' + '9'.repeat(64),
  },
  tokens: [A.usdf, A.wember, A.pair],
};
