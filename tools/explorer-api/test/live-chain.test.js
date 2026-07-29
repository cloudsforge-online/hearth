'use strict';
/* THE GATE. The explorer API against a REAL Hearth node, not a fake chain.
 *
 *   node test/live-chain.test.js                      # boots its own node
 *   HEARTH_LIVE_RPC_URL=http://127.0.0.1:8545 \
 *     node test/live-chain.test.js                    # the compose testnet
 *
 * explorer-api.test.js is fixture-verified: it proves the index, the reorg
 * unwind, the envelope and the supply arithmetic against blocks the test itself
 * declared. That is worth having and it is not the aggregator/listing gate,
 * because a fixture agrees with whatever the fixture's author believed. The
 * whole reason CI's Developer kit job was red is that its author believed the
 * node numbers `logIndex` per receipt; nothing in a fake chain could correct
 * him, and everything in a real one does.
 *
 * So this suite runs the SERVICE, unmodified, against a node built from
 * node/src — real Homefire proof-of-work, real signed transactions, real EVM
 * execution, real receipts — and asserts the two answers an aggregator reads:
 *
 *   module=account&action=balance   ===  eth_getBalance
 *   module=logs&action=getLogs      ===  eth_getLogs
 *
 * Both sides of each comparison are fetched independently: the left through the
 * explorer's own HTTP surface, the right by this file over plain fetch straight
 * to the node. Nothing shared decides both.
 *
 * WITH `HEARTH_LIVE_RPC_URL` SET this points at a node someone else is running —
 * the compose testnet on 8545 is the intended one — indexes a bounded window of
 * its recent history and compares the same two answers over whatever that chain
 * actually contains. It REFUSES rather than passing if that window holds no
 * logs: a gate that certifies a chain it could not query is not a gate.
 *
 * DEFAULT (no URL) it boots a node in-process on a random port, at the test
 * target, and mines a chain shaped to contain the case the fake chain got wrong:
 * one block with TWO log-emitting transactions, whose ordinals are 0 and 1
 * across the block and would both be 0 if they were numbered per receipt.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE = path.join(__dirname, '..', '..', '..', 'node');
const TX = require(path.join(NODE, 'src', 'chain', 'transaction'));
const C = require(path.join(NODE, 'test', 'evm-common'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }
const show = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
function eq(a, b, msg) {
  if (show(a) === show(b)) pass++;
  else { fail++; console.log(`  ✗ ${msg}\n      want ${show(b)}\n      got  ${show(a)}`); }
}
function group(name) { console.log('• ' + name); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-explorer-live-'));

/** How much history to index when pointed at somebody else's chain. */
const WINDOW = Number(process.env.HEARTH_LIVE_WINDOW || 500);

// ---- clients ---------------------------------------------------------------

function get(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* plain text route */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const api = (port, params) => get(port, '/api?' + new URLSearchParams(params).toString()).then(r => r.json);

/** Straight to the node, deliberately NOT through tools/explorer-api/src/rpc.js:
 *  the point is that two independent clients agree. */
function nodeRpc(url) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

async function catchUp(indexer) {
  for (let i = 0; i < 5000; i++) {
    await indexer.syncOnce();
    if (indexer.parked) throw new Error('the indexer parked: ' + indexer.parked);
    if (indexer.lag === 0) return;
  }
  throw new Error('the indexer never caught up');
}

// ---- the chain under test --------------------------------------------------

/**
 * Boot a node and mine a chain that contains the discriminating case.
 *
 * Two accounts are pre-funded in genesis so that block 4 can hold two DIFFERENT
 * senders' calls to the same log-emitting contract. One sender could not do it:
 * a second transaction from the same account in the same block is legal, but
 * two senders is the shape an explorer actually meets and it removes any doubt
 * about nonce ordering deciding the outcome.
 */
async function bootLocalChain() {
  const { EvmNode } = require(path.join(NODE, 'src', 'evmnode'));
  const miner = C.testKey('live-miner');
  const alice = C.testKey('live-alice');
  const bob = C.testKey('live-bob');
  const fund = (100n * 10n ** 18n).toString();

  const node = new EvmNode({
    quiet: true,
    coinbaseKey: miner,
    genesis: {
      alloc: {
        [alice.addressHex]: { balance: fund },
        [bob.addressHex]: { balance: fund },
      },
      target: C.EASY_TARGET,
    },
  });
  node.listenJsonRpc(0);
  const port = await new Promise((res, rej) => {
    if (node.jsonrpcServer.listening) return res(node.jsonrpcServer.address().port);
    const t = setTimeout(() => rej(new Error('never bound')), 10000);
    node.jsonrpcServer.once('listening', () => { clearTimeout(t); res(node.jsonrpcServer.address().port); });
    node.jsonrpcServer.once('error', e => { clearTimeout(t); rej(e); });
  });
  const url = `http://127.0.0.1:${port}/`;
  const rpc = nodeRpc(url);
  const mine = () => node.onMinedBlock(C.mine(node).block);
  const send = raw => rpc('eth_sendRawTransaction', ['0x' + raw.toString('hex')]);
  const word = v => Buffer.from(BigInt(v).toString(16).padStart(64, '0'), 'hex');

  mine();                                                                   // 1: empty
  await send(C.signed(alice, { nonce: 0n, to: bob.address, value: 2n * 10n ** 18n, gasLimit: 21000n }));
  mine();                                                                   // 2: a plain transfer
  await send(C.signed(alice, { nonce: 1n, to: null, data: C.STORAGE_INITCODE, gasLimit: 200_000n }));
  mine();                                                                   // 3: the deployment
  const contract = TX.contractAddress(alice.address, 1n);
  await send(C.signed(alice, { nonce: 2n, to: contract, data: word(42), gasLimit: 100_000n }));
  await send(C.signed(bob, { nonce: 0n, to: contract, data: word(43), gasLimit: 100_000n }));
  mine();                                                                   // 4: TWO logs, TWO senders
  await send(C.signed(alice, { nonce: 3n, to: contract, data: word(44), gasLimit: 100_000n }));
  mine();                                                                   // 5: one more log

  return {
    url,
    rpc,
    chainId: Number(await rpc('eth_chainId')),
    startBlock: 0,
    logAddress: '0x' + Buffer.from(contract).toString('hex'),
    topic0: '0x' + Buffer.from(C.STORED_TOPIC).toString('hex'),
    accounts: [alice.addressHex, bob.addressHex, miner.addressHex, '0x' + Buffer.from(contract).toString('hex')],
    twoLogBlock: 4,
    close: () => node.close(),
  };
}

/**
 * Somebody else's chain — the compose testnet. Take it as it is: walk a bounded
 * window back from the tip, learn which addresses transacted and which emitted
 * logs, and refuse if there is nothing to compare.
 */
async function surveyLiveChain(url) {
  const rpc = nodeRpc(url);
  const chainId = Number(await rpc('eth_chainId'));
  const tip = Number(BigInt(await rpc('eth_blockNumber')));
  const startBlock = Math.max(0, tip - WINDOW);
  const accounts = new Set();
  const logAddresses = new Map();   // address -> topic0 of its first log

  for (let n = startBlock; n <= tip; n++) {
    const block = await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), true]);
    if (!block) continue;
    if (block.miner) accounts.add(block.miner.toLowerCase());
    for (const tx of block.transactions) {
      accounts.add(tx.from.toLowerCase());
      if (tx.to) accounts.add(tx.to.toLowerCase());
      const r = await rpc('eth_getTransactionReceipt', [tx.hash]);
      for (const log of (r && r.logs) || []) {
        if (!logAddresses.has(log.address.toLowerCase())) {
          logAddresses.set(log.address.toLowerCase(), (log.topics || [])[0] || null);
        }
      }
    }
  }

  if (logAddresses.size === 0) {
    throw new Error(
      `${url} has no logs in blocks ${startBlock}..${tip}, so the module=logs half of this gate cannot run. `
      + 'Deploy and call something that emits an event (tools/hardhat/scripts) and run this again, '
      + 'or widen the window with HEARTH_LIVE_WINDOW. Refusing to report a pass on a comparison that '
      + 'never happened.',
    );
  }

  const [logAddress, topic0] = [...logAddresses.entries()][0];
  return {
    url, rpc, chainId, startBlock, logAddress, topic0,
    accounts: [...accounts].slice(0, 8),
    twoLogBlock: null,
    close: () => {},
  };
}

// ---- the comparison --------------------------------------------------------

async function main() {
  const live = process.env.HEARTH_LIVE_RPC_URL;
  console.log(`\nExplorer API against a real chain — ${live ? live : 'a node booted in-process'}\n`);
  const target = live ? await surveyLiveChain(live) : await bootLocalChain();
  const { rpc } = target;
  const tip = Number(BigInt(await rpc('eth_blockNumber')));
  const latestTag = '0x' + tip.toString(16);

  process.env.HEARTH_RPC_URL = target.url;
  process.env.HEARTH_EXPLORER_API_DATA = path.join(TMP, 'index');
  process.env.HEARTH_EXPLORER_API_LOG_LEVEL = 'error';
  process.env.HEARTH_EXPLORER_API_LOG_FORMAT = 'json';
  const { env } = require('../src/env');
  const { build } = require('../src/index');
  const { createServer } = require('../src/server');

  const stack = build({
    ...env,
    rpcUrl: target.url,
    chainId: target.chainId,
    startBlock: target.startBlock,
    dataDir: path.join(TMP, 'index'),
    /* A live chain keeps mining while we index it, and the service refuses to
     * answer an address query while it is more than maxLagBlocks behind. The
     * window is small; the tolerance is not the thing under test. */
    maxLagBlocks: Math.max(env.maxLagBlocks, 64),
  });
  stack.indexer.tracing = false;
  await catchUp(stack.indexer);

  const server = createServer({ ...stack, env: stack.env, api: stack.api, supply: stack.supply });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // ==========================================================================
  group('the service is indexing the node it was pointed at');
  {
    const health = await get(port, '/health');
    eq(health.status, 200, '/health is 200 — the index is caught up with the node');
    eq(health.json.chainId, target.chainId, 'and reports the chain id the node reports');
    ok(stack.store.headNumber >= target.startBlock, 'blocks were indexed');
  }

  // ==========================================================================
  group('module=account&action=balance agrees with eth_getBalance');
  {
    /* The aggregator-facing claim: the number an exchange or a tax tool reads
     * out of the Etherscan shim is the number the chain holds. Decimal wei on
     * the left, hex QUANTITY on the right — the encodings differ on purpose,
     * because a shim that echoed the node's hex would pass this and break every
     * client. */
    for (const addr of target.accounts) {
      const shim = await api(port, { module: 'account', action: 'balance', address: addr });
      const chain = BigInt(await rpc('eth_getBalance', [addr, latestTag]));
      eq(shim.status, '1', `balance(${addr}) is answered`);
      eq(shim.result, chain.toString(), `balance(${addr}) matches eth_getBalance exactly`);
      ok(typeof shim.result === 'string' && !/^0x/.test(shim.result),
        `balance(${addr}) is a DECIMAL string, not the node's hex`);
    }

    const multi = await api(port, {
      module: 'account', action: 'balancemulti', address: target.accounts.join(','),
    });
    const each = [];
    for (const a of target.accounts) each.push(BigInt(await rpc('eth_getBalance', [a, latestTag])).toString());
    eq(multi.result.map(x => x.balance), each, 'balancemulti agrees for every address, in order');
  }

  // ==========================================================================
  group('module=logs&action=getLogs agrees with eth_getLogs');
  {
    const filter = { fromBlock: '0x' + target.startBlock.toString(16), toBlock: latestTag, address: target.logAddress };
    const chainLogs = await rpc('eth_getLogs', [filter]);
    const shim = await api(port, {
      module: 'logs', action: 'getLogs', address: target.logAddress,
      fromBlock: String(target.startBlock), toBlock: String(tip),
    });

    eq(shim.status, '1', 'the shim found logs');
    ok(chainLogs.length > 0, 'and so did the node — this comparison is not vacuous');
    eq(shim.result.length, chainLogs.length, 'the same NUMBER of logs');

    const norm = l => ({
      address: String(l.address).toLowerCase(),
      topics: (l.topics || []).map(t => String(t).toLowerCase()),
      data: String(l.data).toLowerCase(),
      blockNumber: BigInt(l.blockNumber).toString(),
      transactionHash: String(l.transactionHash).toLowerCase(),
      transactionIndex: BigInt(l.transactionIndex).toString(),
      logIndex: BigInt(l.logIndex).toString(),
    });
    eq(shim.result.map(norm), chainLogs.map(norm),
      'and the same logs, field for field — address, topics, data, position and ORDINAL');

    const byTopic = await api(port, {
      module: 'logs', action: 'getLogs', topic0: target.topic0,
      fromBlock: String(target.startBlock), toBlock: String(tip),
    });
    const chainByTopic = await rpc('eth_getLogs', [{
      fromBlock: filter.fromBlock, toBlock: latestTag, topics: [target.topic0],
    }]);
    eq(byTopic.result.map(norm), chainByTopic.map(norm), 'a topic0 filter agrees too');
  }

  // ==========================================================================
  group('the real chain numbers logIndex across the BLOCK');
  {
    /* The defect this gate exists to catch, asserted against a chain that
     * executed the transactions rather than a fixture that declared them.
     *
     * Only the in-process chain can be MADE to contain the discriminating
     * shape; against somebody else's chain we assert the weaker property that
     * always holds — ordinals are dense from zero within each block, regardless
     * of how the logs are spread across transactions. Per-receipt numbering
     * fails that too as soon as one block has two log-emitting transactions,
     * which is exactly when it matters. */
    if (target.twoLogBlock !== null) {
      const n = '0x' + target.twoLogBlock.toString(16);
      const block = await rpc('eth_getBlockByNumber', [n, true]);
      eq(block.transactions.length, 2, 'the shaped block holds two transactions');
      const r0 = await rpc('eth_getTransactionReceipt', [block.transactions[0].hash]);
      const r1 = await rpc('eth_getTransactionReceipt', [block.transactions[1].hash]);
      eq(r0.logs.map(l => l.logIndex), ['0x0'], "the first transaction's log is ordinal 0");
      eq(r1.logs.map(l => l.logIndex), ['0x1'],
        "the second transaction's log is ordinal 1 — per receipt it would also be 0");
    }

    const byBlock = new Map();
    const all = await rpc('eth_getLogs', [{
      fromBlock: '0x' + target.startBlock.toString(16), toBlock: latestTag, address: target.logAddress,
    }]);
    for (const l of all) {
      const k = BigInt(l.blockNumber).toString();
      if (!byBlock.has(k)) byBlock.set(k, []);
      byBlock.get(k).push(Number(BigInt(l.logIndex)));
    }
    let dense = true;
    for (const ordinals of byBlock.values()) {
      ordinals.sort((a, b) => a - b);
      if (ordinals.some((v, i) => v !== i)) dense = false;
    }
    ok(dense, 'every block\'s ordinals run 0,1,2… with no repeats — they are block-wide, not per receipt');
  }

  // ==========================================================================
  group('a receipt with logs is SERVED, not refused');
  {
    /* The literal failure the Developer kit job died on: indexing a block threw
     * `receipt.logs[0].logIndex is missing`. It came from the node's own
     * formatter (node/src/jsonrpc/methods.js), which is right to refuse, and
     * the real chain has never given it cause to. */
    const l = (await rpc('eth_getLogs', [{
      fromBlock: '0x' + target.startBlock.toString(16), toBlock: latestTag, address: target.logAddress,
    }]))[0];
    const receipt = await rpc('eth_getTransactionReceipt', [l.transactionHash]);
    ok(receipt && receipt.logs.length > 0, 'eth_getTransactionReceipt returns the logs rather than erroring');
    ok(receipt.logs.every(x => /^0x[0-9a-f]+$/.test(x.logIndex)),
      'every log carries a logIndex, as QUANTITY');
  }

  // ==========================================================================
  server.close();
  stack.indexer.stop();
  stack.store.close();
  target.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} live-chain checks`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
