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
 * THIS IS DERIVED, NOT TAKEN FROM `log.logIndex`, and the reason is not the one
 * an earlier version of this comment gave. Hearth's node is correct: logIndex
 * is per block (docs/evm-spec.md §6), the chain numbers it that way
 * (node/src/chain/rpcadapter.js, `_receiptsFor`) and the RPC layer refuses to
 * serve a receipt whose logs lack it rather than restart the count at zero
 * (node/src/jsonrpc/methods.js, `formatReceipt`).
 *
 * We derive it anyway because this service indexes whatever node it is pointed
 * at, and getting this wrong is silent: a node that numbered per receipt would
 * report the third transaction's first log as logIndex 0, the index would key
 * it as such, and every lookup in a block with more than one log-emitting
 * transaction would resolve to the wrong log — wrong contract, wrong amount,
 * wrong counterparties, with a status of "1" on top. A derived ordinal also
 * cannot depend on WHICH method fetched the receipts, and this service fetches
 * them two ways (`eth_getBlockReceipts`, or a batch of per-transaction
 * receipts; see rpc.js).
 *
 * The indexer and the hydrator both call this one function, so the two can
 * never drift apart. Against a correct node the derived value equals the
 * node's, and the suite asserts that equality over the wire rather than
 * assuming it.
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
