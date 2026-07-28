/* Queries that are more than one RPC call, and the caches that keep them cheap.
 *
 * THE STRUCTURAL GAP, stated once here because three views run into it:
 *
 * `eth_*` has no address index. There is no eth_getTransactionsByAddress, and
 * there never will be — Etherscan invented `/api?module=account&action=txlist`
 * precisely because the JSON-RPC surface cannot answer it. So "the transactions
 * of an address" can only be produced by walking blocks and filtering, which is
 * O(range) in round trips and is why every explorer in existence runs an indexer
 * beside the node.
 *
 * This file walks a BOUNDED range and says so on screen. It does not pretend the
 * result is complete history, because a page that silently shows the last 25
 * blocks of activity and calls it "Transactions" is telling the reader something
 * false. docs/listing-checklist.md §3 already lists an Etherscan-compatible
 * `/api` shim as wanted; this is the concrete argument for it.
 *
 * Logs are the exception and the reason `eth_getLogs` matters so much: it IS
 * indexed by address and topic, it is bloom-accelerated, and it answers token
 * history properly. Anything that can be a log query is one.
 */

import * as rpc from './rpc.js';
import { toBig, toNum, toChecksumAddress, padTopic, ZERO_ADDRESS } from './format.js';
import { SELECTORS, decodeString, decodeUint, asTokenTransfer, TRANSFER_TOPIC } from './abi.js';

/** How far back a view scans when it has no index to lean on. */
export const DEFAULT_TX_SCAN = 25;
/** How far back token/log discovery reaches. eth_getLogs caps at 10,000 (methods.js DEFAULTS). */
export const DEFAULT_LOG_SCAN = 2000;

export async function tip() { return toNum(await rpc.call('eth_blockNumber')); }

export async function getBlock(ref, fullTx = false) {
  const isHash = typeof ref === 'string' && ref.startsWith('0x') && ref.length === 66;
  return isHash
    ? rpc.call('eth_getBlockByHash', [ref, fullTx])
    : rpc.call('eth_getBlockByNumber', ['0x' + BigInt(ref).toString(16), fullTx]);
}

/** The newest `n` blocks, newest first. One batch, not n round trips. */
export async function latestBlocks(n, height) {
  const h = height ?? await tip();
  const calls = [];
  for (let i = 0; i < n && h - i >= 0; i++) {
    calls.push(['eth_getBlockByNumber', ['0x' + BigInt(h - i).toString(16), false]]);
  }
  const res = await rpc.batch(calls);
  return res.filter(r => r.ok && r.value).map(r => r.value);
}

// ---- token metadata --------------------------------------------------------

const metaCache = new Map();

/**
 * name / symbol / decimals / totalSupply, by eth_call.
 *
 * Every one of them is optional in practice: a token may not implement them, may
 * revert, or may return bytes32. A failed call is recorded as null and the UI
 * shows raw units — the alternative is dividing by a decimals value that was
 * never actually read, which silently misprices everything on the page.
 */
export async function tokenMeta(address) {
  const key = String(address).toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  const p = (async () => {
    const res = await rpc.batch([
      ['eth_call', [{ to: key, data: SELECTORS.name }, 'latest']],
      ['eth_call', [{ to: key, data: SELECTORS.symbol }, 'latest']],
      ['eth_call', [{ to: key, data: SELECTORS.decimals }, 'latest']],
      ['eth_call', [{ to: key, data: SELECTORS.totalSupply }, 'latest']],
    ]);
    const val = (r, fn) => (r.ok && r.value && r.value !== '0x' ? fn(r.value) : null);
    const decimals = val(res[2], decodeUint);
    return {
      address: toChecksumAddress(key),
      name: val(res[0], decodeString),
      symbol: val(res[1], decodeString),
      decimals: decimals === null ? null : Number(decimals),
      totalSupply: val(res[3], decodeUint),
      // A contract that answers none of these is not a token, and the token
      // views must not claim it is one.
      isToken: res.some((r, i) => i < 3 && r.ok && r.value && r.value !== '0x'),
    };
  })();
  metaCache.set(key, p);
  return p;
}

export async function tokenBalance(token, holder) {
  const data = SELECTORS.balanceOf + String(holder).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const r = await rpc.tryCall('eth_call', [{ to: String(token).toLowerCase(), data }, 'latest']);
  if (!r.ok || !r.value || r.value === '0x') return null;
  return decodeUint(r.value);
}

// ---- logs ------------------------------------------------------------------

/** eth_getLogs with the range clamped to what the server will accept. */
export async function getLogs({ fromBlock, toBlock, address, topics, blockHash }) {
  const filter = {};
  if (blockHash) filter.blockHash = blockHash;
  else {
    filter.fromBlock = '0x' + BigInt(Math.max(0, fromBlock)).toString(16);
    filter.toBlock = '0x' + BigInt(toBlock).toString(16);
  }
  if (address && address.length) filter.address = address;
  if (topics && topics.length) filter.topics = topics;
  return rpc.call('eth_getLogs', [filter]);
}

/**
 * Every ERC-20 Transfer touching `address`, in one pair of queries: one where it
 * is topic1 (out) and one where it is topic2 (in). This is what `eth_getLogs`
 * is for, and it is exact within the range rather than a scan.
 */
export async function tokenTransfersFor(address, fromBlock, toBlock) {
  const t = padTopic(address);
  const [out, incoming] = await Promise.all([
    getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, t] }),
    getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, t] }),
  ]);
  const seen = new Set();
  const all = [];
  for (const l of [...out, ...incoming]) {
    const k = l.transactionHash + ':' + l.logIndex;
    if (seen.has(k)) continue;
    seen.add(k);
    const t20 = asTokenTransfer(l);
    if (t20) all.push(t20);
  }
  all.sort((a, b) => (toNum(b.log.blockNumber) - toNum(a.log.blockNumber))
    || (toNum(b.log.logIndex) - toNum(a.log.logIndex)));
  return all;
}

/** Tokens seen moving in a block range, with a transfer count and holder set. */
export async function discoverTokens(fromBlock, toBlock) {
  const logs = await getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC] });
  const byToken = new Map();
  for (const l of logs) {
    const t = asTokenTransfer(l);
    if (!t) continue;                       // 4-topic Transfer: ERC-721, not this list
    const key = t.token.toLowerCase();
    let e = byToken.get(key);
    if (!e) { e = { address: t.token, transfers: 0, holders: new Set(), mints: 0, lastBlock: 0 }; byToken.set(key, e); }
    e.transfers++;
    if (t.mint) e.mints++;
    if (t.from !== ZERO_ADDRESS) e.holders.add(t.from);
    if (t.to !== ZERO_ADDRESS) e.holders.add(t.to);
    e.lastBlock = Math.max(e.lastBlock, toNum(l.blockNumber));
  }
  return [...byToken.values()].sort((a, b) => b.transfers - a.transfers);
}

// ---- transactions by address: the bounded scan ----------------------------

/**
 * Walk back `depth` blocks collecting transactions where `address` is the sender
 * or the recipient. Returns the transactions AND the range actually covered, so
 * the caller can say what was looked at rather than implying it was everything.
 */
export async function scanTransactions(address, { depth = DEFAULT_TX_SCAN, height } = {}) {
  const h = height ?? await tip();
  const a = String(address).toLowerCase();
  const from = Math.max(0, h - depth + 1);
  const calls = [];
  for (let n = h; n >= from; n--) calls.push(['eth_getBlockByNumber', ['0x' + BigInt(n).toString(16), true]]);
  const res = await rpc.batch(calls);
  const found = [];
  let scanned = 0;
  for (const r of res) {
    if (!r.ok || !r.value) continue;
    scanned++;
    for (const tx of r.value.transactions || []) {
      if (typeof tx === 'string') continue;   // the node ignored fullTx; nothing to filter on
      if (String(tx.from).toLowerCase() === a || String(tx.to || '').toLowerCase() === a) {
        found.push({ ...tx, timestamp: r.value.timestamp });
      }
    }
  }
  return { txs: found, from, to: h, scanned };
}

/** The most recent transactions on the chain, for the front page. */
export async function recentTransactions(limit, height) {
  const h = height ?? await tip();
  const out = [];
  let n = h;
  // Walk back until enough transactions are found or the walk gets silly. Most
  // blocks on a new chain are empty, so a fixed window would usually show none.
  for (let steps = 0; steps < 40 && out.length < limit && n >= 0; steps += 8) {
    const calls = [];
    for (let i = 0; i < 8 && n - i >= 0; i++) calls.push(['eth_getBlockByNumber', ['0x' + BigInt(n - i).toString(16), true]]);
    const res = await rpc.batch(calls);
    for (const r of res) {
      if (!r.ok || !r.value) continue;
      for (const tx of r.value.transactions || []) {
        if (typeof tx === 'string') continue;
        out.push({ ...tx, timestamp: r.value.timestamp });
      }
    }
    n -= 8;
    if (n < 0) break;
  }
  return out.slice(0, limit);
}

/** Is this an EOA or a contract? The only thing that distinguishes them. */
export async function accountKind(address) {
  const [balance, nonce, code] = await rpc.batchStrict([
    ['eth_getBalance', [address, 'latest']],
    ['eth_getTransactionCount', [address, 'latest']],
    ['eth_getCode', [address, 'latest']],
  ]);
  const isContract = code && code !== '0x';
  return { balance: toBig(balance), nonce: toBig(nonce), code: code || '0x', isContract };
}
