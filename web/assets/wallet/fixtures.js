/* A canned account-model chain, served over the real JSON-RPC transport.
 *
 * WHY THIS EXISTS. The account-model chain is phase 5 (docs/evm-spec.md §8) and
 * does not exist yet, so there is nothing for this wallet to talk to and no way
 * to see whether it works. The explorer solved that with an in-memory fake that
 * answers exactly what the wire would carry, written against the interface
 * documented at the top of node/src/jsonrpc/methods.js; this is the same trick
 * for the wallet's half of that surface.
 *
 * WHAT IT IS NOT. It is not a demo mode and it never engages on its own: it is
 * opt-in from the URL (`?fixtures=1`), and every view is loudly labelled while it
 * is on. The old wallet's predecessor fell back to invented numbers when the node
 * was unreachable, which is how a page ends up lying to somebody about a balance.
 *
 * WHAT IS WORTH HAVING IN IT — the states a happy-path demo skips:
 *
 *   - a real signature check: eth_sendRawTransaction DECODES the raw bytes with
 *     the same module the node uses and RECOVERS the sender. A wallet bug that
 *     signs for the wrong account is rejected here exactly as the node would
 *     reject it, which is most of the value of this file.
 *   - nonce too low, and insufficient funds, in geth's own words, because
 *     clients match on those strings
 *   - a transaction that sits PENDING for a few seconds before it is mined
 *   - a transaction that reverted: mined, receipt status 0x0, gas spent
 *   - an account with no history at all, which is what a new wallet is
 *
 * The owner's account is whatever key is unlocked, so `adoptOwner()` seeds that
 * address rather than a hardcoded one — otherwise fixture mode would show an
 * empty wallet and prove nothing.
 */

import { keccak256 } from '../explorer/keccak.js';
import { qty, toHex } from '../explorer/format.js';
import { RpcUnreachable } from '../explorer/rpc.js';
import * as T from './transaction.js';

const CHAIN_ID = 7411;
const GWEI = 1_000_000_000n;
const EMBER = 10n ** 18n;
const BLOCK_GAS_LIMIT = 30_000_000n;
const GAS_PRICE = 12n * GWEI;
const BLOCK_TIME_MS = 15_000;
const MINE_DELAY_MS = 6_000;          // how long a submitted tx stays pending

const COUNTERPARTY = '0x3f9a1d7c5e2b8046a9c3e5d7f1b3a5c7e9d0b246';
const FAUCET = '0x1e5a7c04b2f9d3e8a06c5b4d9f2e7a1c3b8d0e64';
/* A contract, so "send to a contract" and a reverting call have somewhere to go.
 * The wallet only ever reads its code length, to warn before a plain transfer. */
const CONTRACT = '0x9d4a3e7b1c5f8206d4e7a9c1b3d5f709e2a4c681';

const lower = a => String(a || '').toLowerCase();
const hashHex = (...parts) => toHex(keccak256(new TextEncoder().encode(parts.join('|'))));

const state = {
  height: 4204,
  t0: Date.now(),
  lastBlockAt: Date.now(),
  blocks: new Map(),        // number -> block
  txs: new Map(),           // hash -> { tx, blockNumber, index, status, gasUsed }
  pending: new Map(),       // hash -> { tx, raw, submittedAt }
  accounts: new Map(),      // lower(address) -> { balance, nonce }
  owner: null,
};

function account(addr) {
  const k = lower(addr);
  if (!state.accounts.has(k)) state.accounts.set(k, { balance: 0n, nonce: 0n });
  return state.accounts.get(k);
}

function makeBlock(number, txHashes, timestamp) {
  const b = {
    number,
    hash: hashHex('block', number),
    parentHash: number > 0 ? hashHex('block', number - 1) : '0x' + '00'.repeat(32),
    timestamp,
    transactions: txHashes,
    gasUsed: 0n,
  };
  state.blocks.set(number, b);
  return b;
}

/**
 * Seed the chain around the account that is actually unlocked, and give it the
 * history a wallet spends its life displaying. Called once, when a key is opened.
 */
export function adoptOwner(address) {
  if (state.owner) return;
  state.owner = lower(address);
  const me = account(address);
  me.balance = 128n * EMBER + 500_000_000_000_000_000n;    // 128.5 EMBER
  account(COUNTERPARTY).balance = 40n * EMBER;
  account(FAUCET).balance = 1_000_000n * EMBER;

  const now = Date.now();
  // Three historical blocks, oldest first, each one block-time apart.
  const seed = [
    { from: FAUCET, to: address, value: 100n * EMBER, status: 1, at: state.height - 900 },
    { from: FAUCET, to: address, value: 30n * EMBER, status: 1, at: state.height - 420 },
    { from: address, to: COUNTERPARTY, value: 15n * EMBER / 10n, status: 1, at: state.height - 96 },
    { from: address, to: CONTRACT, value: 0n, status: 0, at: state.height - 40, data: '0x38ed1739' },
  ];
  for (let i = 0; i < seed.length; i++) {
    const s = seed[i];
    const h = hashHex('seed', i, s.from, s.to, String(s.value));
    const gasUsed = s.data ? 47_213n : 21_000n;
    state.txs.set(h, {
      hash: h,
      from: lower(s.from),
      to: lower(s.to),
      value: s.value,
      nonce: BigInt(i),
      gasPrice: GAS_PRICE,
      gas: s.data ? 120_000n : 21_000n,
      input: s.data || '0x',
      v: BigInt(CHAIN_ID) * 2n + 35n,
      r: hashHex('r', h),
      s: hashHex('s', h),
      blockNumber: s.at,
      index: 0,
      status: s.status,
      gasUsed,
    });
    makeBlock(s.at, [h], Math.floor((now - (state.height - s.at) * BLOCK_TIME_MS) / 1000));
  }
  // The account's nonce is how many transactions it has SENT, which is two of
  // the four above. Getting this wrong is how a wallet builds an unspendable
  // transaction, so the fixture is careful about it.
  me.nonce = 2n;
  makeBlock(state.height, [], Math.floor(now / 1000));
}

/** Advance the chain: empty blocks on the clock, and pending transactions when due. */
function tick() {
  const now = Date.now();
  const due = [...state.pending.entries()].filter(([, p]) => now - p.submittedAt >= MINE_DELAY_MS);
  if (due.length) {
    state.height += 1;
    const hashes = [];
    for (const [h, p] of due) {
      state.pending.delete(h);
      const rec = state.txs.get(h);
      rec.blockNumber = state.height;
      rec.index = hashes.length;
      rec.status = 1;
      rec.gasUsed = rec.input && rec.input !== '0x' ? 21_000n + BigInt(rec.input.length / 2 - 1) * 16n : 21_000n;
      // The mined nonce advances here, and only here.
      const sender = account(rec.from);
      if (rec.nonce + 1n > sender.nonce) sender.nonce = rec.nonce + 1n;
      hashes.push(h);
    }
    makeBlock(state.height, hashes, Math.floor(now / 1000));
    state.lastBlockAt = now;
    return;
  }
  if (now - state.lastBlockAt >= BLOCK_TIME_MS) {
    state.height += 1;
    makeBlock(state.height, [], Math.floor(now / 1000));
    state.lastBlockAt = now;
  }
}

// ---- response shapes, matching node/src/jsonrpc/methods.js formatTx ---------

function formatTx(rec) {
  return {
    blockHash: rec.blockNumber === null ? null : hashHex('block', rec.blockNumber),
    blockNumber: rec.blockNumber === null ? null : qty(rec.blockNumber),
    transactionIndex: rec.blockNumber === null ? null : qty(rec.index),
    hash: rec.hash,
    from: rec.from,
    to: rec.to || null,
    value: qty(rec.value),
    gas: qty(rec.gas),
    gasPrice: qty(rec.gasPrice),
    input: rec.input || '0x',
    nonce: qty(rec.nonce),
    type: '0x0',
    v: qty(rec.v),
    r: rec.r,
    s: rec.s,
    chainId: qty(CHAIN_ID),
  };
}

function formatReceipt(rec) {
  return {
    transactionHash: rec.hash,
    transactionIndex: qty(rec.index),
    blockHash: hashHex('block', rec.blockNumber),
    blockNumber: qty(rec.blockNumber),
    from: rec.from,
    to: rec.to || null,
    cumulativeGasUsed: qty(rec.gasUsed),
    gasUsed: qty(rec.gasUsed),
    effectiveGasPrice: qty(rec.gasPrice),
    contractAddress: null,
    logs: [],
    logsBloom: '0x' + '00'.repeat(256),
    status: rec.status ? '0x1' : '0x0',
    type: '0x0',
  };
}

function formatBlock(b, full) {
  return {
    number: qty(b.number),
    hash: b.hash,
    parentHash: b.parentHash,
    nonce: '0x0000000000000000',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x' + '00'.repeat(256),
    transactionsRoot: hashHex('txroot', b.number),
    stateRoot: hashHex('stateroot', b.number),
    receiptsRoot: hashHex('receiptsroot', b.number),
    miner: FAUCET,
    difficulty: qty(1_500_000n),
    totalDifficulty: qty(BigInt(b.number) * 1_500_000n),
    extraData: '0x686561727468',
    size: qty(540 + b.transactions.length * 110),
    gasLimit: qty(BLOCK_GAS_LIMIT),
    gasUsed: qty(b.transactions.reduce((s, h) => s + Number(state.txs.get(h)?.gasUsed || 0n), 0)),
    timestamp: qty(b.timestamp),
    mixHash: hashHex('mix', b.number),
    transactions: b.transactions.map(h => (full ? formatTx(state.txs.get(h)) : h)),
    uncles: [],
  };
}

// ---- the method table ------------------------------------------------------

const err = (code, message, data) => ({ error: { code, message, ...(data ? { data } : {}) } });

function resolveTag(tag) {
  if (tag === undefined || tag === null) return state.height;
  if (tag === 'latest' || tag === 'safe' || tag === 'finalized') return state.height;
  if (tag === 'earliest') return 0;
  if (tag === 'pending') return state.height;
  return Number(BigInt(tag));
}

const METHODS = {
  eth_chainId: () => qty(CHAIN_ID),
  net_version: () => String(CHAIN_ID),
  web3_clientVersion: () => 'hearth-fixtures/wallet',
  eth_blockNumber: () => qty(state.height),
  eth_gasPrice: () => qty(GAS_PRICE),

  eth_getBalance: ([addr]) => qty(account(addr).balance),

  /* 'pending' must count the transactions in flight, or a wallet that sends
   * twice in a row builds the second one with a nonce the first already used. */
  eth_getTransactionCount: ([addr, tag]) => {
    const base = account(addr).nonce;
    if (tag !== 'pending') return qty(base);
    let extra = 0n;
    for (const p of state.pending.values()) if (p.from === lower(addr)) extra += 1n;
    return qty(base + extra);
  },

  eth_getCode: ([addr]) => (lower(addr) === lower(CONTRACT) ? '0x6080604052348015' : '0x'),

  eth_estimateGas: ([call]) => {
    const data = call && call.data ? String(call.data).replace(/^0x/, '') : '';
    if (lower(call?.to) === lower(CONTRACT)) return qty(47_213n);
    return qty(21_000n + BigInt(Math.ceil(data.length / 2)) * 16n);
  },

  eth_sendRawTransaction: ([raw]) => {
    /* The point of the whole file: the fixture validates with the same module
     * the node validates with, so a signing bug fails HERE rather than in
     * production. Every rejection string below is geth's, verbatim, because
     * every client matches on them. */
    const check = T.validate(raw, { chainId: CHAIN_ID });
    if (!check.ok) return err(-32000, `invalid transaction: ${check.code} — ${check.error}`);

    const from = lower(toHex(check.sender));
    const acct = account(from);
    let expected = acct.nonce;
    for (const p of state.pending.values()) if (p.from === from) expected += 1n;

    if (check.tx.nonce < expected) return err(-32000, 'nonce too low');
    if (check.tx.nonce > expected) return err(-32000, 'nonce too high');

    const cost = check.tx.value + check.tx.gasLimit * check.tx.gasPrice;
    if (acct.balance < cost) return err(-32000, 'insufficient funds for gas * price + value');

    const h = toHex(check.hash);
    if (state.txs.has(h)) return err(-32000, 'already known');

    /* Debit optimistically, exactly as a mempool does, so the balance the UI
     * shows after sending is the one the chain will agree with. The NONCE is
     * not touched here: `eth_getTransactionCount(…, 'pending')` is the mined
     * nonce plus what is in flight, and advancing both would double-count and
     * have the wallet build its next transaction with a nonce nobody wants. */
    acct.balance -= check.tx.value + check.tx.gasLimit * check.tx.gasPrice;
    const to = check.tx.to ? lower(toHex(check.tx.to)) : null;
    if (to) account(to).balance += check.tx.value;
    // Refund the gas that will not be used; the fixture charges 21,000 + data.
    const gasUsed = 21_000n + BigInt(check.tx.data.length) * 16n;
    acct.balance += (check.tx.gasLimit - gasUsed) * check.tx.gasPrice;

    state.txs.set(h, {
      hash: h,
      from,
      to,
      value: check.tx.value,
      nonce: check.tx.nonce,
      gasPrice: check.tx.gasPrice,
      gas: check.tx.gasLimit,
      input: toHex(check.tx.data),
      v: check.tx.v,
      r: '0x' + check.tx.r.toString(16).padStart(64, '0'),
      s: '0x' + check.tx.s.toString(16).padStart(64, '0'),
      blockNumber: null,
      index: 0,
      status: null,
      gasUsed,
    });
    state.pending.set(h, { from, submittedAt: Date.now() });
    return h;
  },

  eth_getTransactionByHash: ([h]) => {
    const rec = state.txs.get(lower(h));
    return rec ? formatTx(rec) : null;
  },

  /* null while pending or unknown — never an error, because every client polls
   * this in a loop and reads null as "not mined yet". */
  eth_getTransactionReceipt: ([h]) => {
    const rec = state.txs.get(lower(h));
    return rec && rec.blockNumber !== null ? formatReceipt(rec) : null;
  },

  eth_getBlockByNumber: ([tag, full]) => {
    if (tag === 'pending') return null;         // no pending block on this chain
    const n = resolveTag(tag);
    const b = state.blocks.get(n);
    return b ? formatBlock(b, !!full) : null;
  },

  eth_getBlockByHash: ([h, full]) => {
    for (const b of state.blocks.values()) if (b.hash === lower(h)) return formatBlock(b, !!full);
    return null;
  },
};

/** The transport `rpc.useTransport()` takes. Handles single calls and batches. */
export async function fixtureTransport(payload) {
  tick();
  const one = (req) => {
    const fn = METHODS[req.method];
    if (!fn) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `the method ${req.method} does not exist` } };
    try {
      const out = fn(req.params || []);
      if (out && typeof out === 'object' && out.error) return { jsonrpc: '2.0', id: req.id, ...out };
      return { jsonrpc: '2.0', id: req.id, result: out };
    } catch (e) {
      return { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e && e.message || e) } };
    }
  };
  return Array.isArray(payload) ? payload.map(one) : one(payload);
}

/** `?fixtures=down`: something is configured, nothing answers. */
export async function deadTransport() {
  throw new RpcUnreachable('fixture mode is simulating an unreachable node');
}

export const FIXTURE = { CHAIN_ID, COUNTERPARTY, CONTRACT, FAUCET, GAS_PRICE, MINE_DELAY_MS };

/** For the self-test: a clean chain, so assertions do not depend on order. */
export function reset() {
  state.height = 4204;
  state.blocks.clear();
  state.txs.clear();
  state.pending.clear();
  state.accounts.clear();
  state.owner = null;
  state.lastBlockAt = Date.now();
}
