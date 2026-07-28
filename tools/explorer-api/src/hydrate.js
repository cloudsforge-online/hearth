'use strict';
/* Turning postings back into rows.
 *
 * The index stores (key, block, txIndex, subIndex) and nothing else — see the
 * header of store.js for why. Everything a client actually reads is fetched
 * from the node here, through a small block-plus-receipts cache so that paging
 * an address costs one round trip per distinct block rather than one per row.
 *
 * ERC-20 metadata (name / symbol / decimals) is read with `eth_call` and
 * cached forever: a token's symbol is immutable in every implementation anyone
 * ships, and re-reading it per row would make `tokentx` the most expensive
 * endpoint here by an order of magnitude.
 */

/** A Map with a size cap and least-recently-inserted eviction. */
class Lru {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k, v) {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  delete(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get size() { return this.m.size; }
}

const SELECTOR = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
};

/** Decode an ABI-encoded string, tolerating the bytes32 form old tokens use. */
function decodeString(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return '';
  const b = Buffer.from(hex.slice(2), 'hex');
  if (b.length === 0) return '';
  if (b.length === 32) {
    /* A bare bytes32 — MKR and friends. Distinguishable from a dynamic string
     * only by length, because a dynamic string is always at least 64 bytes. */
    const end = b.indexOf(0);
    return b.subarray(0, end === -1 ? 32 : end).toString('utf8');
  }
  if (b.length < 64) return '';
  const offset = Number(BigInt('0x' + b.subarray(0, 32).toString('hex')));
  if (!Number.isSafeInteger(offset) || offset + 32 > b.length) return '';
  const len = Number(BigInt('0x' + b.subarray(offset, offset + 32).toString('hex')));
  if (!Number.isSafeInteger(len) || offset + 32 + len > b.length) return '';
  return b.subarray(offset + 32, offset + 32 + len).toString('utf8');
}

/**
 * Every log in a block, numbered from 0 across the whole block.
 *
 * THIS IS NOT `log.logIndex` AND MUST NOT BE. The specification says logIndex
 * is per block (docs/evm-spec.md §6), but the node's own formatter numbers the
 * logs inside a single `eth_getTransactionReceipt` response from zero
 * (node/src/jsonrpc/methods.js, `formatReceipt`), so the third transaction's
 * first log also arrives as logIndex 0. Indexing on a value whose meaning
 * depends on which RPC method fetched it produces an index that resolves to
 * the wrong log — silently, and only for blocks with more than one
 * log-emitting transaction.
 *
 * So the index derives its own block-wide ordinal here, and the indexer and
 * the hydrator both call this one function to get it.
 */
function flattenLogs(receipts) {
  const out = [];
  let ordinal = 0;
  for (let txIndex = 0; txIndex < receipts.length; txIndex++) {
    const r = receipts[txIndex];
    for (const log of (r && r.logs) || []) {
      out.push({ blockLogIndex: ordinal++, txIndex, log, receipt: r });
    }
  }
  return out;
}

function decodeUint(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x') || hex.length < 4) return null;
  try { return BigInt(hex); } catch { return null; }
}

class Hydrator {
  constructor({ rpc, blockCache = 256 }) {
    this.rpc = rpc;
    this.blocks = new Lru(blockCache);
    this.tokens = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * One block plus its receipts, cached.
   * @returns {Promise<{block: object, receipts: object[]}|null>}
   */
  async block(n) {
    const hit = this.blocks.get(n);
    if (hit) { this.hits++; return hit; }
    this.misses++;
    const block = await this.rpc.getBlockByNumber(n, true);
    if (!block) return null;
    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    const receipts = txs.length
      ? await this.rpc.getBlockReceipts(n, txs.map(t => t.hash))
      : [];
    const entry = { block, receipts, logs: flattenLogs(receipts) };
    this.blocks.set(n, entry);
    return entry;
  }

  /** Drop cached blocks at or above `from` — called when the index unwinds. */
  invalidateFrom(from) {
    for (const k of [...this.blocks.m.keys()]) if (k >= from) this.blocks.delete(k);
  }

  async tokenMeta(address) {
    const key = address.toLowerCase();
    const hit = this.tokens.get(key);
    if (hit) return hit;
    const call = async (selector, decode) => {
      try { return decode(await this.rpc.ethCall({ to: key, data: selector }, 'latest')); } catch { return null; }
    };
    const [name, symbol, decimals] = await Promise.all([
      call(SELECTOR.name, decodeString),
      call(SELECTOR.symbol, decodeString),
      call(SELECTOR.decimals, decodeUint),
    ]);
    const meta = {
      name: name || '',
      symbol: symbol || '',
      /* Empty string, not "18". A token whose decimals() is unreadable is not
       * an 18-decimal token; it is a token whose decimals we do not know, and
       * a client that divides by a guessed 1e18 shows a wrong balance. */
      decimals: decimals === null ? '' : String(decimals),
    };
    this.tokens.set(key, meta);
    return meta;
  }

  async totalSupply(address) {
    const raw = await this.rpc.ethCall({ to: address.toLowerCase(), data: SELECTOR.totalSupply }, 'latest');
    const v = decodeUint(raw);
    if (v === null) throw new Error('the contract did not return a totalSupply()');
    return v;
  }

  stats() {
    return { blockCache: this.blocks.size, blockCacheHits: this.hits, blockCacheMisses: this.misses, tokens: this.tokens.size };
  }
}

module.exports = { Hydrator, Lru, flattenLogs, decodeString, decodeUint, SELECTOR };
