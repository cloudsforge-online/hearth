#!/usr/bin/env node
'use strict';
/* A probe stub for the `eth_*` JSON-RPC layer. NOT A NODE. NOT A CHAIN.
 *
 * ============================================================================
 * READ THIS BEFORE YOU POINT ANYTHING VALUABLE AT IT
 * ============================================================================
 *
 * This serves the REAL RPC layer — `node/src/jsonrpc/{server,methods,hex}.js`,
 * unmodified — over a FAKE chain that holds no state, executes no code and
 * mines no transactions. It exists for exactly one job: to let Hardhat,
 * Foundry, MetaMask, ethers and viem be pointed at Hearth's method surface
 * BEFORE phase 5 (consensus) lands, so that we find out which methods those
 * tools actually call, in what order, and what they do when one is missing.
 *
 * What it CAN tell you:
 *   - whether a client accepts the chain id, the block shape and the hex
 *     encoding this repository produces;
 *   - which methods a client probes that are not in the v1 surface;
 *   - whether the absence of `baseFeePerGas` makes a client fall back to
 *     legacy (type 0) pricing, which is the behaviour v1 depends on.
 *
 * What it CANNOT tell you, and will not pretend to:
 *   - anything about execution. `eth_call` with calldata is refused rather
 *     than answered with a plausible zero, because a stub that returns
 *     "success, empty" is indistinguishable from a contract that returned zero
 *     and that is the worst available failure mode (spec §5 makes the same
 *     argument about the unimplemented precompiles).
 *   - anything about deployment. `eth_sendRawTransaction` decodes and hashes
 *     the transaction with the real codec and then drops it. Every receipt
 *     poll returns null forever, so a deploy will hang and then time out. That
 *     is the correct, visible failure for "there is no chain yet".
 *
 * Every request is logged to stderr, which is the point of the tool.
 *
 *   node tools/rpc-probe/stub.js --port 8645
 *
 * Environment:
 *   HEARTH_PROBE_PORT       default 8645
 *   HEARTH_PROBE_BLOCK_MS   default 1000 — how often an empty block appears
 *   HEARTH_PROBE_BALANCE    default 1000 EMBER, granted to EVERY address, so a
 *                           client's "can this account afford it" check passes
 *   HEARTH_PROBE_GAS_PRICE  default 1 gwei
 *   HEARTH_PROBE_QUIET      set to 1 to stop logging each call
 */

const path = require('path');
const NODE_SRC = path.join(__dirname, '..', '..', 'node', 'src');

const { JsonRpcServer } = require(path.join(NODE_SRC, 'jsonrpc', 'server'));
const { keccak256 } = require(path.join(NODE_SRC, 'crypto', 'keccak'));
const TX = require(path.join(NODE_SRC, 'chain', 'transaction'));

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const argv = process.argv.slice(2);
const argOf = name => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const CFG = {
  port: num(argOf('--port') ?? process.env.HEARTH_PROBE_PORT, 8645),
  blockMs: num(process.env.HEARTH_PROBE_BLOCK_MS, 1000),
  balance: BigInt(process.env.HEARTH_PROBE_BALANCE || '1000000000000000000000'),
  gasPrice: BigInt(process.env.HEARTH_PROBE_GAS_PRICE || '1000000000'),
  quiet: process.env.HEARTH_PROBE_QUIET === '1',
};

/** Deterministic 32 bytes from a label, so block hashes are stable per run. */
const h32 = s => Buffer.from(keccak256(Buffer.from(s, 'utf8')));

const GENESIS_TIME = 1_760_000_000n;
const started = Date.now();

/** Height advances with wall clock so that "wait for the next block" terminates. */
function height() {
  return BigInt(Math.floor((Date.now() - started) / CFG.blockMs));
}

function blockAt(n) {
  return {
    number: n,
    hash: h32('probe:block:' + n),
    parentHash: n === 0n ? Buffer.alloc(32) : h32('probe:block:' + (n - 1n)),
    nonce: Buffer.alloc(8),
    mixHash: h32('probe:pow:' + n),
    logsBloom: Buffer.alloc(256),
    transactionsRoot: h32('probe:txroot:' + n),
    stateRoot: h32('probe:stateroot:' + n),
    receiptsRoot: h32('probe:receiptsroot:' + n),
    miner: Buffer.alloc(20),
    difficulty: 1_048_576n,
    totalDifficulty: (n + 1n) * 1_048_576n,
    extraData: Buffer.from('hearth-rpc-probe', 'utf8'),
    size: 517n,
    gasLimit: 30_000_000n,
    gasUsed: 0n,
    // SECONDS. The v1 header stores milliseconds and phase 5 must divide
    // (spec §4); the probe emits what the RPC contract requires.
    timestamp: GENESIS_TIME + n * 15n,
    transactions: [],
    // NOTE the absence of `baseFeePerGas`. It is not omitted by oversight:
    // ethers and viem read its absence as "this chain has no EIP-1559" and
    // fall back to legacy pricing, which is the only thing v1 can execute.
  };
}

/** Accepted-and-forgotten transactions, so a client at least gets its hash back. */
const seen = new Map();
/** The same hashes as an ordered journal, for `eth_newPendingTransactionFilter`. */
const announced = [];
let announcedBase = 0;

const chain = {
  chainId: () => BigInt(TX.CHAIN_ID),
  blockNumber: () => height(),
  gasPrice: () => CFG.gasPrice,
  syncing: () => false,

  // Every address is rich and has never sent anything. Enough for a client's
  // affordability and nonce checks; not a claim about any real account.
  getBalance: () => CFG.balance,
  getNonce: () => 0n,
  getCode: () => Buffer.alloc(0),
  getStorageAt: () => Buffer.alloc(32),

  getBlockByNumber(n) {
    if (typeof n !== 'bigint' || n < 0n || n > height()) return null;
    return blockAt(n);
  },
  getBlockByHash(hash) {
    // Only the recent window is searched; a probe has no index and does not
    // need one.
    const tip = height();
    for (let n = tip; n >= 0n && n > tip - 512n; n--) {
      const b = blockAt(n);
      if (b.hash.equals(Buffer.from(hash))) return b;
    }
    return null;
  },
  getTransactionByHash: () => null,
  getTransactionReceipt: () => null,
  getBlockReceipts: () => [],

  call(msg) {
    if (msg.data && msg.data.length > 0) {
      return { ok: false, error: 'the rpc probe cannot execute code — there is no chain behind it' };
    }
    return { ok: true, returnData: Buffer.alloc(0) };
  },

  estimateGas(msg) {
    // The real intrinsic-gas function, so the number is at least the true
    // floor for this payload rather than a guess.
    try {
      const g = TX.intrinsicGas({
        to: msg.to || null,
        data: msg.data || Buffer.alloc(0),
        nonce: 0n, gasPrice: 0n, gasLimit: 0n, value: 0n,
      });
      return { ok: true, returnData: Buffer.alloc(0), gas: g };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },

  /* ---- the node, as opposed to the chain ------------------------------
   * The JSON-RPC layer registers net_peerCount / eth_mining / eth_hashrate /
   * eth_coinbase / txpool_status / eth_newPendingTransactionFilter only when
   * the chain supplies these, and a probe that 404s a method the real node
   * serves records the wrong answer about a client. So they are here — and
   * every value is TRUE OF THIS PROBE rather than a stand-in: it really has no
   * peers, really is not mining, and really has no pool.
   */
  peerCount: () => 0n,
  mining: () => false,
  hashrate: () => 0n,
  coinbase: () => Buffer.alloc(20),
  txpoolStatus: () => ({ pending: 0n, queued: 0n }),
  /** Hashes this probe has been handed, so a pending filter has something real
   *  to deliver. A ring with a base, exactly like the mempool's journal. */
  pendingSince(cursor) {
    const end = announcedBase + announced.length;
    if (cursor === null || cursor === undefined || cursor > end) return { cursor: end, hashes: [] };
    return { cursor: end, hashes: announced.slice(Math.max(cursor, announcedBase) - announcedBase) };
  },

  sendRawTransaction(raw) {
    let tx;
    try {
      tx = TX.decode(raw);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    const hash = Buffer.from(TX.hash(raw));
    seen.set(hash.toString('hex'), tx);
    announced.push(hash);
    if (announced.length > 1024) { announcedBase += announced.length - 1024; announced.splice(0, announced.length - 1024); }
    process.stderr.write(
      `  accepted and DROPPED (no chain): hash=0x${hash.toString('hex')} `
      + `nonce=${tx.nonce} to=${tx.to ? '0x' + Buffer.from(tx.to).toString('hex') : '(creation)'} `
      + `chainId=${tx.chainId === null ? 'unprotected/pre-155' : tx.chainId}\n`,
    );
    return { ok: true, hash };
  },
};

// ---- the server ------------------------------------------------------------

const server = new JsonRpcServer({
  chain,
  clientVersion: `Hearth-rpc-probe/NOT-A-NODE/node${process.versions.node}`,
});

/* Wrap every method so the call log shows what a client actually asks for —
 * including the ones we do not have, which is the whole reason this exists. */
const KNOWN = new Set(Object.keys(server.methods));
const originalHas = server.has.bind(server);
server.has = name => {
  if (!CFG.quiet && !KNOWN.has(name)) process.stderr.write(`→ ${name}  ** NOT IMPLEMENTED (v1 surface) **\n`);
  return originalHas(name);
};
for (const name of KNOWN) {
  const fn = server.methods[name];
  // `ctx` is forwarded, not dropped: the filter methods key their per-caller cap
  // on it, and a wrapper that swallowed it would put every client in one bucket.
  server.methods[name] = async (params, ctx) => {
    if (!CFG.quiet) process.stderr.write(`→ ${name} ${JSON.stringify(params)}\n`);
    return fn(params, ctx);
  };
}

server.listen(CFG.port, '127.0.0.1');
process.stderr.write(
  `hearth rpc probe on http://127.0.0.1:${CFG.port}  chainId=${TX.CHAIN_ID} (0x${TX.CHAIN_ID.toString(16)})\n`
  + 'THIS IS NOT A NODE. No state, no execution, no mining. Deployments will hang.\n',
);
