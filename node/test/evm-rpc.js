'use strict';
/* The Ethereum JSON-RPC surface, over real HTTP, against a real chain.
 * Run: node test/evm-rpc.js
 *
 * test/jsonrpc.js already tests this layer exhaustively against an in-memory fake
 * chain. This suite exists to answer the one question that fake cannot: IS THE REAL
 * CHAIN A VALID STAND-IN FOR IT? The fake was written from the interface comment at
 * the top of src/jsonrpc/methods.js, so if the two disagree, one of them is wrong
 * and this is where the argument gets settled.
 *
 * The sequence in the last group is not a tidy tour of the method table — it is the
 * exact order of calls ethers v6 makes to deploy a contract, taken from
 * docs/network-config.md §5, which measured it. If that sequence works, Hardhat
 * works, and the two-and-a-half things it depends on are asserted individually:
 *
 *   - `baseFeePerGas` IS ABSENT from a block. That absence is what makes ethers
 *     conclude there is no fee market and fall back to legacy pricing. Emitting a
 *     zero would make it advertise type-2 transactions this chain cannot execute.
 *   - `eth_getTransactionCount(from, 'pending')` counts the mempool, or a second
 *     deployment in the same block reuses a nonce.
 *   - a receipt for a reverted transaction is a SUCCESSFUL call with status 0x0.
 */

const P = require('../src/params');
const TX = require('../src/chain/transaction');
const { EvmNode } = require('../src/evmnode');
const { keccak256 } = require('../src/crypto/keccak');
const C = require('./evm-common');

const T = C.harness('Hearth eth_* over HTTP');
const { ok, eq, group } = T;

const miner = C.testKey('rpc-miner');
const alice = C.testKey('rpc-alice');
const bob = C.testKey('rpc-bob');

/* `listening` may already have fired by the time we await — awaiting one server
 * gives the loop a turn in which the other binds — so the state is checked first.
 * A promise that waits for an event that has passed hangs until the timeout, which
 * is a test that fails ten seconds later for the wrong reason. */
const bound = server => new Promise((res, rej) => {
  if (server.listening) return res(server.address().port);
  const t = setTimeout(() => rej(new Error('never bound')), 10000);
  server.once('listening', () => { clearTimeout(t); res(server.address().port); });
  server.once('error', e => { clearTimeout(t); rej(e); });
});

(async () => {
  const node = new EvmNode({
    quiet: true,
    coinbaseKey: miner,
    genesis: {
      alloc: { [alice.addressHex]: { balance: (100n * 10n ** 18n).toString() } },
      target: C.EASY_TARGET,
    },
  });
  node.listenJsonRpc(0);
  node.listenRest(0);
  const port = await bound(node.jsonrpcServer);
  const restPort = await bound(node.restServer);
  const url = `http://127.0.0.1:${port}/`;

  let id = 0;
  const call = async (method, params = []) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.json();
    return { status: res.status, body };
  };
  const rpc = async (method, params = []) => (await call(method, params)).body.result;
  const rpcErr = async (method, params = []) => (await call(method, params)).body.error;
  const mine = () => node.onMinedBlock(C.mine(node).block);

  // -------------------------------------------------------------------------
  group('the endpoint');
  // -------------------------------------------------------------------------
  eq(await rpc('eth_chainId'), '0x1cf3', 'eth_chainId is 7411 in hex');
  eq(await rpc('net_version'), '7411', 'net_version is DECIMAL — the one place hex is wrong');
  ok(String(await rpc('web3_clientVersion')).startsWith('Hearth/'), 'web3_clientVersion names this client');
  eq(await rpc('eth_blockNumber'), '0x0', 'a fresh chain is at height 0');
  eq(await rpc('eth_gasPrice'), '0x' + P.EVM_MIN_GAS_PRICE.toString(16), 'eth_gasPrice suggests the pool minimum');
  eq(await rpc('eth_accounts'), [], 'the node holds no keys for callers');
  eq(await rpc('eth_syncing'), false, 'and is not syncing');

  {
    const res = await fetch(url, { method: 'GET' });
    eq(res.status, 405, 'GET is refused with 405 and an Allow header');
    const opt = await fetch(url, { method: 'OPTIONS' });
    eq(opt.status, 204, 'OPTIONS answers the CORS preflight');
    eq(opt.headers.get('access-control-allow-origin'), '*', 'CORS is open, so a browser wallet can reach a local node');
  }
  {
    // a batch, which is what Hardhat sends
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 'b', method: 'eth_blockNumber', params: [] },
      ]),
    });
    const body = await res.json();
    eq(body.length, 2, 'a batch is answered as an array');
    eq(body.map(r => r.id).sort(), ['a', 'b'], 'with every id echoed unchanged');
  }
  eq((await rpcErr('eth_nonsense')).code, -32601, 'an unknown method is -32601');
  eq((await rpcErr('eth_getBalance', [])).code, -32602, 'a missing argument is -32602');

  // -------------------------------------------------------------------------
  group('state and blocks');
  // -------------------------------------------------------------------------
  eq(await rpc('eth_getBalance', [alice.addressHex, 'latest']), '0x' + (100n * 10n ** 18n).toString(16),
    'the genesis allocation is readable');
  eq(await rpc('eth_getBalance', [bob.addressHex, 'latest']), '0x0', 'an unknown account is 0x0, not an error');
  eq(await rpc('eth_getTransactionCount', [bob.addressHex, 'latest']), '0x0', 'and its nonce is 0x0');
  eq(await rpc('eth_getCode', [alice.addressHex, 'latest']), '0x', 'an EOA has no code');
  eq(await rpc('eth_getStorageAt', [alice.addressHex, '0x0', 'latest']), '0x' + '00'.repeat(32),
    'a storage read is always a full, zero-padded 32-byte word');

  mine();
  eq(await rpc('eth_blockNumber'), '0x1', 'a mined block moves the height');
  {
    const b = await rpc('eth_getBlockByNumber', ['0x1', false]);
    ok(b !== null, 'the block is served');
    eq(b.number, '0x1', 'number');
    eq(b.miner, miner.addressHex, 'miner is a 0x ADDRESS, not the coinbase public key');
    eq(b.transactions, [], 'an empty block has an empty transaction list');
    eq(b.uncles, [], 'uncles is always empty');
    eq(b.sha3Uncles, '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
      'and sha3Uncles is the RLP hash of the empty list, which clients assume exists');
    eq(b.nonce.length, 18, 'nonce is DATA(8) — 0x plus sixteen hex digits');
    eq(b.logsBloom.length, 514, 'logsBloom is DATA(256)');
    eq('baseFeePerGas' in b, false,
      'baseFeePerGas is ABSENT — its absence is what makes ethers fall back to legacy pricing');
    eq('withdrawals' in b || 'withdrawalsRoot' in b, false, 'and no beacon-chain artefacts');
    eq(Number(b.timestamp), node.chain.tip.header.timestamp, 'timestamp is seconds');
    ok(Number(b.timestamp) < 4_000_000_000, 'and is a plausible date, not a millisecond value');
    ok(BigInt(b.totalDifficulty) > 0n, 'totalDifficulty is present and non-zero');
    eq(b.gasLimit, '0x1c9c380', 'the gas limit is 30,000,000');
    const byHash = await rpc('eth_getBlockByHash', [b.hash, false]);
    eq(byHash.number, '0x1', 'and the same block is reachable by hash');
  }
  eq(await rpc('eth_getBlockByNumber', ['0x99', false]), null, 'a block above the tip is null, not an error');
  eq(await rpc('eth_getBlockByNumber', ['pending', false]), null, 'there is no pending block');
  eq((await rpcErr('eth_getBalance', [alice.addressHex, '0x99'])).message, 'header not found',
    'but a state read above the tip is an error, as geth does');

  // -------------------------------------------------------------------------
  group('a transaction, end to end');
  // -------------------------------------------------------------------------
  const transfer = C.signed(alice, { nonce: 0n, to: bob.address, value: 2n * 10n ** 18n, gasLimit: 21000n });
  const transferHash = '0x' + keccak256(transfer).toString('hex');
  eq(await rpc('eth_sendRawTransaction', ['0x' + transfer.toString('hex')]), transferHash,
    'eth_sendRawTransaction answers with the transaction hash');
  eq((await rpcErr('eth_sendRawTransaction', ['0x' + transfer.toString('hex')])).message, 'already known',
    'and a resend says "already known", the string clients match on');
  eq(await rpc('eth_getTransactionCount', [alice.addressHex, 'pending']), '0x1',
    "'pending' counts the mempool, or a wallet's second send reuses a nonce");
  eq(await rpc('eth_getTransactionCount', [alice.addressHex, 'latest']), '0x0', 'while "latest" is the mined nonce');
  {
    const pending = await rpc('eth_getTransactionByHash', [transferHash]);
    ok(pending !== null, 'a pooled transaction is visible immediately');
    eq(pending.blockNumber, null, 'with a null blockNumber');
    eq(pending.type, '0x0', 'and it is legacy, type 0x0');
    eq(pending.chainId, '0x1cf3', 'with the chain id it was signed for');
    eq(await rpc('eth_getTransactionReceipt', [transferHash]), null, 'and no receipt until it is mined');
  }

  mine();
  {
    const r = await rpc('eth_getTransactionReceipt', [transferHash]);
    eq(r.status, '0x1', 'the receipt says success');
    eq(r.blockNumber, '0x2', 'in block 2');
    eq(r.gasUsed, '0x5208', 'a plain transfer costs 21,000 gas');
    eq(r.cumulativeGasUsed, '0x5208', 'and is the only gas in the block');
    eq(r.effectiveGasPrice, '0x' + C.GWEI.toString(16), 'at the price it was signed with');
    eq(r.contractAddress, null, 'a transfer creates no contract');
    eq(r.from, alice.addressHex, 'from is recovered from the signature');
    eq(r.to, bob.addressHex, 'to is the recipient');
    eq(r.logs, [], 'and it logged nothing');
    eq(await rpc('eth_getBalance', [bob.addressHex, 'latest']), '0x' + (2n * 10n ** 18n).toString(16), 'the money moved');
    const tx = await rpc('eth_getTransactionByHash', [transferHash]);
    eq(tx.blockNumber, '0x2', 'and the transaction now names its block');
    eq(tx.transactionIndex, '0x0', 'and its index');
  }

  // -------------------------------------------------------------------------
  group('contracts: deploy, call, log, revert');
  // -------------------------------------------------------------------------
  const deploy = C.signed(alice, { nonce: 1n, to: null, data: C.STORAGE_INITCODE, gasLimit: 200_000n });
  const deployHash = '0x' + keccak256(deploy).toString('hex');
  const contract = '0x' + TX.contractAddress(alice.address, 1n).toString('hex');
  await rpc('eth_sendRawTransaction', ['0x' + deploy.toString('hex')]);
  mine();
  {
    const r = await rpc('eth_getTransactionReceipt', [deployHash]);
    eq(r.status, '0x1', 'the deployment succeeded');
    eq(r.contractAddress, contract, 'and the receipt names the contract address');
    eq(await rpc('eth_getCode', [contract, 'latest']), '0x' + C.STORAGE_RUNTIME.toString('hex'),
      'eth_getCode returns exactly the runtime that was deployed');
  }

  const word = n => '0x' + n.toString(16).padStart(64, '0');
  {
    const est = await rpc('eth_estimateGas', [{ from: alice.addressHex, to: contract, data: word(42) }]);
    ok(BigInt(est) > 21000n, 'eth_estimateGas is above the intrinsic cost');
    const set = C.signed(alice, { nonce: 2n, to: TX.contractAddress(alice.address, 1n), data: Buffer.from(word(42).slice(2), 'hex'), gasLimit: BigInt(est) });
    await rpc('eth_sendRawTransaction', ['0x' + set.toString('hex')]);
    mine();
    const r = await rpc('eth_getTransactionReceipt', ['0x' + keccak256(set).toString('hex')]);
    eq(r.status, '0x1', 'the estimate was enough gas to succeed');
    eq(r.logs.length, 1, 'the call emitted one log');
    eq(r.logs[0].topics[0], '0x' + C.STORED_TOPIC.toString('hex'), 'under the expected topic');
    eq(r.logs[0].data, word(42), 'with the value as data');
    eq(r.logs[0].logIndex, '0x0', 'numbered within the block');
    eq(r.logs[0].removed, false, 'and not removed');
    eq(await rpc('eth_getStorageAt', [contract, '0x0', 'latest']), word(42), 'and the storage slot was written');
    eq(await rpc('eth_call', [{ to: contract, data: word(42) }, 'latest']), word(42), 'eth_call reads it back');
  }

  // logs, the way an indexer asks for them
  {
    const all = await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }]);
    eq(all.length, 1, 'eth_getLogs finds the log across the whole chain');
    eq(all[0].address, contract, 'from the right contract');
    const byAddress = await rpc('eth_getLogs', [{ address: contract, fromBlock: '0x0', toBlock: 'latest' }]);
    eq(byAddress.length, 1, 'filtering by address matches');
    const byTopic = await rpc('eth_getLogs', [{ topics: ['0x' + C.STORED_TOPIC.toString('hex')], fromBlock: '0x0' }]);
    eq(byTopic.length, 1, 'filtering by topic matches');
    const wrongTopic = await rpc('eth_getLogs', [{ topics: ['0x' + '11'.repeat(32)], fromBlock: '0x0' }]);
    eq(wrongTopic.length, 0, 'and a wrong topic matches nothing');
    const wrongAddress = await rpc('eth_getLogs', [{ address: bob.addressHex, fromBlock: '0x0' }]);
    eq(wrongAddress.length, 0, 'as does a wrong address');
    /* The bloom is an optimisation that must be invisible: turning it off has to
     * produce the same answer, or it is silently losing logs. */
    const { buildMethods } = require('../src/jsonrpc/methods');
    const noBloom = await buildMethods({ chain: node.rpcChain, useBloom: false })
      .eth_getLogs([{ fromBlock: '0x0', toBlock: 'latest' }]);
    eq(noBloom, all, 'and skipping blocks by header bloom returns byte-identical results');
  }

  // eth_getBlockReceipts — the two-line addition that saves an explorer N round trips
  {
    const rs = await rpc('eth_getBlockReceipts', ['0x4']);
    eq(rs.length, 1, 'eth_getBlockReceipts answers a whole block at once');
    eq(rs[0].logs.length, 1, 'with logs');
    const byHash = await rpc('eth_getBlockReceipts', [(await rpc('eth_getBlockByNumber', ['0x4', false])).hash]);
    eq(byHash[0].transactionHash, rs[0].transactionHash, 'and takes a block hash as well as a number');
    eq(await rpc('eth_getBlockReceipts', ['0x99']), null, 'an unknown block is null, not an empty list');
    eq(await rpc('eth_getBlockReceipts', ['0x1']), [], 'and an empty block is an empty list');
  }

  // a revert, which is the case clients get wrong most often
  {
    const dep = C.signed(alice, { nonce: 3n, to: null, data: C.REVERT_INITCODE, gasLimit: 300_000n });
    await rpc('eth_sendRawTransaction', ['0x' + dep.toString('hex')]);
    mine();
    const reverter = '0x' + TX.contractAddress(alice.address, 3n).toString('hex');

    const err = await rpcErr('eth_call', [{ to: reverter, data: '0x' }, 'latest']);
    eq(err.code, 3, 'a revert is JSON-RPC code 3');
    eq(err.message, 'execution reverted: nope', 'with the Solidity reason decoded into the message');
    ok(err.data.startsWith('0x08c379a0'), 'and the raw payload in data, so ethers can decode a custom error');

    const gasErr = await rpcErr('eth_estimateGas', [{ to: reverter, data: '0x' }]);
    eq(gasErr.code, 3, 'estimating gas for a reverting call reports the revert, not a gas figure');

    // a transaction that reverts is MINED, and its receipt is a successful call
    const bad = C.signed(alice, { nonce: 4n, to: TX.contractAddress(alice.address, 3n), gasLimit: 100_000n });
    await rpc('eth_sendRawTransaction', ['0x' + bad.toString('hex')]);
    mine();
    const r = await rpc('eth_getTransactionReceipt', ['0x' + keccak256(bad).toString('hex')]);
    ok(r !== null, 'a reverted transaction has a receipt');
    eq(r.status, '0x0', 'whose status is 0x0 — a failed transaction, not a failed RPC call');
    ok(BigInt(r.gasUsed) > 21000n, 'and it paid for the gas it burned');
    eq(await rpc('eth_getTransactionCount', [alice.addressHex, 'latest']), '0x5', 'its nonce increment stands');
  }

  // -------------------------------------------------------------------------
  group('what ethers actually does to deploy (docs/network-config.md §5)');
  // -------------------------------------------------------------------------
  {
    const steps = [];
    const seq = async (m, p) => { steps.push(m); return rpc(m, p); };
    eq(await seq('eth_chainId'), '0x1cf3', 'eth_chainId');
    const latest = await seq('eth_getBlockByNumber', ['latest', false]);
    eq('baseFeePerGas' in latest, false, 'no fee market is advertised');
    const nonce = await seq('eth_getTransactionCount', [alice.addressHex, 'pending']);
    const price = await seq('eth_gasPrice');
    const data = '0x' + C.STORAGE_INITCODE.toString('hex');
    const estimate = await seq('eth_estimateGas', [{ from: alice.addressHex, data }]);
    const raw = C.signed(alice, {
      nonce: BigInt(nonce), gasPrice: BigInt(price), gasLimit: BigInt(estimate), to: null, data: C.STORAGE_INITCODE,
    });
    const hash = await seq('eth_sendRawTransaction', ['0x' + raw.toString('hex')]);
    eq(await rpc('eth_getTransactionReceipt', [hash]), null, 'the receipt is null while it is pending');
    mine();
    const receipt = await seq('eth_getTransactionReceipt', [hash]);
    eq(receipt.status, '0x1', 'and the deployment succeeds on the estimated gas');
    const code = await seq('eth_getCode', [receipt.contractAddress, 'latest']);
    ok(code.length > 2, 'with code at the reported address');
    eq(steps.length, 8, 'eight calls, no eth_feeHistory and no eth_maxPriorityFeePerGas');
  }

  // -------------------------------------------------------------------------
  group('the REST port is a different protocol, and says so');
  // -------------------------------------------------------------------------
  {
    const info = await (await fetch(`http://127.0.0.1:${restPort}/info`)).json();
    eq(info.chainId, 7411, '/info reports the chain id');
    eq(info.model, 'account', 'and which model this node runs');
    const supply = await (await fetch(`http://127.0.0.1:${restPort}/supply`)).json();
    eq(supply.decimals, 18, '/supply is in 18 decimals');
    eq(supply.totalSupply, (P.subsidyWei(1) * 0n + node.chain.supply().minted).toString(), 'and totals the emission schedule');
    ok(supply.commonsIsBurnAddress, 'and says plainly that the Commons address is still the burn address');

    const wrong = await fetch(`http://127.0.0.1:${restPort}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    eq(wrong.status, 404, 'eth_* pointed at the REST port is refused');
    const body = await wrong.json();
    ok(String(body.jsonRpc).includes('8545'), 'with a pointer to the right port rather than a silent empty chain');
  }

  node.close();
  T.done();
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
