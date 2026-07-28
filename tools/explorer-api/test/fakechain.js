'use strict';
/* A fake chain, served over REAL HTTP by the tree's REAL JSON-RPC layer.
 *
 * `node/src/jsonrpc/{server,methods,hex}.js` is used unmodified, exactly as
 * tools/rpc-probe does. That matters more than it looks: it means the fixtures
 * this service is tested against are encoded by the same code that will encode
 * the real thing, so a QUANTITY/DATA mistake in the explorer's parsing shows up
 * here rather than on a running chain. Hand-rolled JSON fixtures would have
 * agreed with whatever the explorer expected, which is worth nothing.
 *
 * There is no account-model chain yet (phase 5), so this is the closest thing
 * to a node that exists. What it is NOT: it does not execute, does not mine,
 * and its state is whatever a test declared.
 */

const path = require('path');
const NODE_SRC = path.join(__dirname, '..', '..', '..', 'node', 'src');
const { JsonRpcServer } = require(path.join(NODE_SRC, 'jsonrpc', 'server'));
const { keccak256 } = require(path.join(NODE_SRC, 'crypto', 'keccak'));

const h32 = s => Buffer.from(keccak256(Buffer.from(String(s), 'utf8')));
const addrOf = s => h32('addr:' + s).subarray(12);
const hex = b => '0x' + Buffer.from(b).toString('hex');

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER = h32('Transfer(address,address,uint256)');

/** A 32-byte topic holding a left-padded address. */
const topicOf = addr => Buffer.concat([Buffer.alloc(12), Buffer.from(addr)]);
/** A 32-byte word holding a uint. */
const word = v => {
  const b = Buffer.alloc(32);
  let h = BigInt(v).toString(16);
  if (h.length % 2) h = '0' + h;
  Buffer.from(h, 'hex').copy(b, 32 - h.length / 2);
  return b;
};

class FakeChain {
  constructor({ chainId = 7411, genesisTime = 1_760_000_000 } = {}) {
    this.id = BigInt(chainId);
    this.genesisTime = BigInt(genesisTime);
    /** @type {object[]} canonical blocks, index === height */
    this.blocks = [];
    this.balances = new Map();     // lowercase 0x address -> bigint
    this.codes = new Map();
    this.callResults = new Map();  // `${to}:${dataHex}` -> Buffer
    this.traces = new Map();       // txHash hex -> callTracer frame
    this.tracing = false;
    this.branch = 'a';
    this.addBlock({ txs: [] });    // genesis
  }

  setBalance(addr, wei) { this.balances.set(hex(addr).toLowerCase(), BigInt(wei)); }
  setCode(addr, code) { this.codes.set(hex(addr).toLowerCase(), Buffer.from(code)); }
  setCall(to, data, ret) { this.callResults.set(`${hex(to).toLowerCase()}:${data}`, Buffer.from(ret)); }

  /**
   * @param {object} spec
   * @param {Array} spec.txs  [{from, to, value, input, logs:[{address,topics,data}],
   *                            status, creates}]
   */
  addBlock(spec = {}) {
    const number = BigInt(this.blocks.length);
    const parent = this.blocks[this.blocks.length - 1];
    const hash = h32(`${this.branch}:block:${number}`);
    const txs = [];
    const receipts = [];
    let cumulative = 0n;

    (spec.txs || []).forEach((t, i) => {
      const txHash = h32(`${this.branch}:tx:${number}:${i}`);
      const gasUsed = BigInt(t.gasUsed || 21000);
      cumulative += gasUsed;
      const tx = {
        hash: txHash,
        nonce: BigInt(t.nonce || i),
        from: t.from,
        to: t.to || null,
        value: BigInt(t.value || 0),
        gasPrice: BigInt(t.gasPrice || 1_000_000_000),
        gas: BigInt(t.gas || 100000),
        input: t.input ? Buffer.from(t.input) : Buffer.alloc(0),
        v: BigInt(this.id) * 2n + 35n,
        r: BigInt('0x' + h32('r' + txHash.toString('hex')).toString('hex')),
        s: BigInt('0x' + h32('s' + txHash.toString('hex')).toString('hex')) >> 1n,
        chainId: this.id,
        blockHash: hash,
        blockNumber: number,
        transactionIndex: BigInt(i),
      };
      txs.push(tx);
      receipts.push({
        transactionHash: txHash,
        transactionIndex: BigInt(i),
        blockHash: hash,
        blockNumber: number,
        from: t.from,
        to: t.to || null,
        cumulativeGasUsed: cumulative,
        gasUsed,
        effectiveGasPrice: tx.gasPrice,
        contractAddress: t.creates || null,
        logs: (t.logs || []).map(l => ({
          address: l.address, topics: l.topics || [], data: l.data || Buffer.alloc(0),
        })),
        logsBloom: Buffer.alloc(256),
        status: t.status === undefined ? 1 : t.status,
      });
      if (t.trace) this.traces.set(hex(txHash), t.trace);
    });

    this.blocks.push({
      number,
      hash,
      parentHash: parent ? parent.hash : Buffer.alloc(32),
      nonce: Buffer.alloc(8),
      mixHash: h32(`${this.branch}:pow:${number}`),
      logsBloom: Buffer.alloc(256),
      transactionsRoot: h32(`txroot:${number}`),
      stateRoot: h32(`stateroot:${number}`),
      receiptsRoot: h32(`receiptsroot:${number}`),
      miner: addrOf('miner'),
      difficulty: 1_048_576n,
      totalDifficulty: (number + 1n) * 1_048_576n,
      extraData: Buffer.from('hearth-fake-chain', 'utf8'),
      size: 517n,
      gasLimit: 30_000_000n,
      gasUsed: cumulative,
      timestamp: this.genesisTime + number * 15n,
      transactions: txs,
      receipts,
    });
    return this.blocks[this.blocks.length - 1];
  }

  /**
   * Reorg: drop every block from `fromHeight` and mine a different branch.
   * Changing `branch` changes every hash, which is what makes the discarded
   * blocks genuinely different rather than renumbered.
   */
  reorg(fromHeight, specs, branch) {
    this.blocks.length = fromHeight;
    this.branch = branch;
    for (const s of specs) this.addBlock(s);
  }

  // ---- the chain interface methods.js documents -----------------------------

  chainId() { return this.id; }
  blockNumber() { return BigInt(this.blocks.length - 1); }
  gasPrice() { return 1_000_000_000n; }
  syncing() { return false; }

  getBalance(addr) { return this.balances.get(hex(addr).toLowerCase()) || 0n; }
  getNonce() { return 0n; }
  getCode(addr) { return this.codes.get(hex(addr).toLowerCase()) || Buffer.alloc(0); }
  getStorageAt() { return Buffer.alloc(32); }

  getBlockByNumber(n) {
    const i = Number(n);
    return i >= 0 && i < this.blocks.length ? this.blocks[i] : null;
  }

  getBlockByHash(h) {
    const want = Buffer.from(h);
    return this.blocks.find(b => b.hash.equals(want)) || null;
  }

  getTransactionByHash(h) {
    const want = Buffer.from(h);
    for (const b of this.blocks) for (const t of b.transactions) if (t.hash.equals(want)) return t;
    return null;
  }

  getTransactionReceipt(h) {
    const want = Buffer.from(h);
    for (const b of this.blocks) for (const r of b.receipts) if (r.transactionHash.equals(want)) return r;
    return null;
  }

  getBlockReceipts(n) {
    const b = this.getBlockByNumber(n);
    return b ? b.receipts : [];
  }

  call(msg) {
    const key = `${hex(msg.to || Buffer.alloc(20)).toLowerCase()}:${hex(msg.data || Buffer.alloc(0))}`;
    const hit = this.callResults.get(key);
    if (!hit) return { ok: false, error: 'the fake chain has no answer for that call' };
    return { ok: true, returnData: hit };
  }

  estimateGas() { return { ok: true, returnData: Buffer.alloc(0), gas: 21000n }; }
  sendRawTransaction() { return { ok: false, error: 'the fake chain does not accept transactions' }; }
}

/**
 * Serve a FakeChain on a random loopback port.
 * @param {object} o
 * @param {boolean} [o.blockReceipts] expose eth_getBlockReceipts (evm-spec §6
 *   adds it to v1; the node does not implement it yet, so both paths matter)
 * @param {boolean} [o.tracing]       expose debug_traceTransaction
 */
function serve(chain, { blockReceipts = false, tracing = false } = {}) {
  const server = new JsonRpcServer({ chain, clientVersion: 'Hearth-fake-chain/test' });

  if (blockReceipts) {
    server.methods.eth_getBlockReceipts = async params => {
      const b = chain.getBlockByNumber(BigInt(params[0]));
      if (!b) return null;
      const out = [];
      for (const r of b.receipts) {
        out.push(await server.methods.eth_getTransactionReceipt([hex(r.transactionHash)]));
      }
      return out;
    };
  }
  if (tracing) {
    chain.tracing = true;
    server.methods.debug_traceTransaction = async params => {
      const t = chain.traces.get(String(params[0]).toLowerCase());
      if (!t) throw Object.assign(new Error('transaction not found'), { code: -32000 });
      return t;
    };
  }

  const http = server.listen(0, '127.0.0.1');
  return new Promise(resolve => {
    http.on('listening', () => resolve({ server, http, port: http.address().port }));
    if (http.listening) resolve({ server, http, port: http.address().port });
  });
}

module.exports = { FakeChain, serve, h32, addrOf, hex, topicOf, word, TRANSFER };
