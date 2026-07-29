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
    /* A quarter of the shipped budget, so the last group's checks cost a second
     * rather than five. The GAS cap is left at the real default on purpose —
     * that one is measured below rather than asserted from a constant. */
    rpcTimeBudgetMs: 250,
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
  group('a speculative call cannot touch consensus state, and cannot run forever');
  // -------------------------------------------------------------------------
  /* eth_call and eth_estimateGas are the only way an unauthenticated stranger can
   * make this process execute EVM code — the endpoint above answers CORS `*` with
   * no auth and no rate limit — so the two bounds on a speculative run are asserted
   * here, over real HTTP, against the real chain. Both were absent once:
   *
   *   - the run used the chain's own never-pruned node store, so one SSTORE-loop
   *     eth_call retained 7,135 nodes / 1.6 MB for the life of the process. The
   *     store is content-addressed, so REPEATING a call cost nothing and only
   *     varying the payload grew it; the checks below therefore vary it.
   *   - eth_call took the caller's `gas` verbatim while eth_estimateGas clamped,
   *     so `gas: 0x11e1a300` bought 300M gas of execution — ten times any block —
   *     on a single-threaded node, from one request.
   */
  {
    /* A contract whose runtime is `GAS PUSH1 00 MSTORE PUSH1 20 PUSH1 00 RETURN`:
     * it returns the gas left at its first opcode, so the word an `eth_call` gets
     * back IS the limit the adapter handed the run, less the intrinsic cost. It has
     * to be deployed and called rather than run as initcode, because `eth_call` on
     * a creation returns the empty create-frame return data, not the code. */
    const reportGas = C.deployer(C.hex('5a', '6000', '52', '6020', '6000', 'f3'));
    const gasNonce = BigInt(await rpc('eth_getTransactionCount', [alice.addressHex, 'pending']));
    await rpc('eth_sendRawTransaction', ['0x' + C.signed(alice, {
      nonce: gasNonce, to: null, data: reportGas, gasLimit: 200_000n,
    }).toString('hex')]);
    mine();
    const reporter = '0x' + TX.contractAddress(alice.address, gasNonce).toString('hex');
    ok((await rpc('eth_getCode', [reporter, 'latest'])).length > 2, 'the gas-reporting contract deployed');

    /* An SSTORE loop, as initcode: PUSH1 nn JUMPDEST DUP1 DUP1 SSTORE PUSH1 01 ADD
     * PUSH1 02 JUMP. It runs out of gas having written thousands of slots, which is
     * the point — every one of them is a trie node somebody has to not keep. */
    const sstoreLoop = n => '0x60' + n.toString(16).padStart(2, '0') + '5b808055600101600256';
    const before = node.chain.db.size;
    for (let i = 1; i <= 8; i++) {
      await rpc('eth_call', [{ data: sstoreLoop(i), gas: '0x1c9c380' }, 'latest']);
    }
    await rpc('eth_estimateGas', [{ data: sstoreLoop(9), gas: '0x1c9c380' }]);
    eq(node.chain.db.size, before, 'eight distinct SSTORE-loop eth_calls add NOTHING to the chain node store');

    // The sharper statement of the same property: a call that writes a storage
    // slot cannot be observed by anything that reads consensus state afterwards.
    const word = n => '0x' + n.toString(16).padStart(64, '0');
    eq(await rpc('eth_call', [{ to: contract, data: word(99) }, 'latest']), word(99),
      'a call that SSTOREs still returns the right answer');
    eq(await rpc('eth_getStorageAt', [contract, '0x0', 'latest']), word(42),
      'and the slot it wrote still holds what the last MINED transaction put there');
    eq(node.chain.db.size, before, 'with the node store still exactly where it was');

    /* The gas cap, measured rather than inferred: the word the reporter returns IS
     * the limit the adapter applied. Asking for 300M must not buy 300M. */
    const cap = BigInt(P.EVM_RPC_GAS_CAP);
    const seen = async gas => BigInt(await rpc('eth_call', [{ to: reporter, ...(gas ? { gas } : {}) }, 'latest']));
    const huge = await seen('0x11e1a300');
    ok(cap < node.chain.gasLimit, `the RPC gas cap is BELOW the block gas limit (${cap} of ${node.chain.gasLimit})`);
    ok(huge < cap, `eth_call gas is clamped to that cap (saw ${huge}, cap ${cap})`);
    ok(huge > cap - 100_000n, 'and clamped TO it, not to something smaller');
    const modest = await seen('0x186a0');
    ok(modest < 100_000n && modest > 50_000n, 'a request under the cap is still honoured verbatim');
    const dflt = await seen(null);
    ok(dflt > cap - 100_000n && dflt < cap, 'and omitting gas means the cap, not the block gas limit');
  }

  // -------------------------------------------------------------------------
  group('one request cannot stop the node (CF-09)');
  // -------------------------------------------------------------------------
  /* The gas cap above bounds ordinary compute. It does not bound TIME, because the
   * spread between the cheapest and dearest gas in this interpreter is 135x
   * (docs/robustness-review.md §6): 10M gas of PUSH/ADD is 160 ms and 10M gas of
   * blake2f is three and a half seconds. Measured on this machine before the
   * deadline existed, against this same node:
   *
   *     one eth_call, blake2f at the block gas limit    11,284 ms frozen
   *     one eth_estimateGas, a tenth of that            15,216 ms frozen (26 probes,
   *                                                     14 of which really ran)
   *     one POST, a 32-member batch of the first       359,777 ms frozen
   *
   * "Frozen" is the number that matters and it is measured here the way it was
   * measured then: an interval that should tick every 25 ms, whose worst gap IS
   * the outage — the miner's tick, p2p gossip and the /info healthcheck compose
   * polls all share this loop.
   */
  {
    const budget = node.rpcChain.rpcTimeBudgetMs;

    /** 213 bytes of EIP-152 input. Gas is one per round, so the caller picks both
     *  the work and the price; 9M rounds is inside the 10M gas cap and is roughly
     *  three seconds of uninterruptible compression. */
    const blake2f = rounds => '0x' + (() => {
      const b = Buffer.alloc(213); b.writeUInt32BE(rounds, 0); b[212] = 1; return b;
    })().toString('hex');
    const BLAKE = '0x0000000000000000000000000000000000000009';

    /** Runs `fn`, returning how long it took and the worst tick the loop missed. */
    const watched = async (fn) => {
      let last = Date.now(), worst = 0;
      const h = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last - 25); last = n; }, 25);
      const t0 = Date.now();
      const value = await fn();
      const ms = Date.now() - t0;
      clearInterval(h);
      return { value, ms, worst };
    };

    {
      const { value, ms, worst } = await watched(() => rpcErr('eth_call', [{ to: BLAKE, data: blake2f(9_000_000) }, 'latest']));
      eq(value.code, -32000, 'a 9,000,000-round blake2f eth_call — inside the gas cap — is refused');
      eq(value.message, 'execution timeout', '…as an execution timeout, not as a revert or an EVM error');
      ok(ms < budget * 8, `…in ${ms} ms rather than the three seconds of work it asked for`);
      ok(worst < budget * 8, `…and the event loop kept running: worst missed tick ${worst} ms`);
    }

    {
      /* The bisection is up to 33 executions of the same message. One budget covers
       * the whole request, so estimateGas cannot cost 33 times what a call costs —
       * that amplification is what turned 3M rounds, one second of work, into
       * 15.2 seconds. */
      const { ms, worst } = await watched(() => rpcErr('eth_estimateGas', [{ to: BLAKE, data: blake2f(9_000_000) }, 'latest']));
      ok(ms < budget * 8, `eth_estimateGas of the same message costs one budget, not 33 (${ms} ms)`);
      ok(worst < budget * 8, `…with the loop still turning: worst missed tick ${worst} ms`);
    }

    {
      /* A batch is many executions in ONE request. Two things bound it: a member
       * limit, and — the one that matters — a yield to the event loop between
       * members, without which the whole batch is a single uninterrupted stall
       * however short each member is.
       *
       * SIX MEMBERS AND A FOUR-BUDGET BOUND, both chosen so that DELETING the
       * yield fails this check. The stall with the yield does not grow with the
       * batch: it is two budgets, because the first `setImmediate` is scheduled
       * from inside the poll phase and so runs in the same loop iteration,
       * putting members one and two back to back. Without the yield the stall is
       * the whole batch — six budgets — so anything between three and six
       * separates them. A bound of `ms` (the request's own length) would not:
       * without the yield the stall IS `ms`, and the check would still pass. */
      const body = [];
      for (let i = 0; i < 6; i++) {
        body.push({ jsonrpc: '2.0', id: 500 + i, method: 'eth_call', params: [{ to: BLAKE, data: blake2f(9_000_000 - i) }, 'latest'] });
      }
      const { value, ms, worst } = await watched(async () => {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return res.json();
      });
      eq(value.length, 6, 'every member of a six-member batch is answered');
      ok(value.every(r => r.error && r.error.message === 'execution timeout'), '…each one timed out on its own budget');
      ok(ms > budget * 4, `…so the batch really did take several budgets end to end (${ms} ms)`);
      ok(worst < budget * 4, `…and yet the loop never stalled for more than two of them: worst missed tick ${worst} ms`);
    }

    {
      const over = [];
      for (let i = 0; i < 1001; i++) over.push({ jsonrpc: '2.0', id: i, method: 'eth_chainId', params: [] });
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(over) });
      const b = await res.json();
      ok(!Array.isArray(b), 'a 1001-member batch is refused whole rather than truncated');
      ok(/exceeds the limit of 1000/.test(b.error.message), '…naming the limit');
    }

    {
      /* THE OTHER HALF, and the one that would be a chain split if it were wrong:
       * the deadline is the RPC path's alone. The same message MINED must execute
       * every round it paid for, however long that takes, because a validator that
       * gave up because its machine was busy would fork away from one that did
       * not. This transaction takes far longer than the budget above. */
      const nonce = BigInt(await rpc('eth_getTransactionCount', [alice.addressHex, 'pending']));
      const raw = C.signed(alice, {
        nonce, to: Buffer.alloc(20, 0).fill(9, 19), data: Buffer.from(blake2f(2_000_000).slice(2), 'hex'),
        gasLimit: 2_100_000n,
      });
      const hash = await rpc('eth_sendRawTransaction', ['0x' + raw.toString('hex')]);
      const t0 = Date.now();
      mine();
      const took = Date.now() - t0;
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      eq(receipt.status, '0x1', 'a MINED 2,000,000-round blake2f succeeds — consensus has no deadline');
      ok(took > budget, `…having really run for ${took} ms, well past the RPC budget of ${budget} ms`);
      // 2,000,000 rounds at one gas each, plus 21,900 intrinsic (21,000 + 209 zero
      // calldata bytes at 4 and 4 non-zero at 16). Exact, because the whole point
      // is that this run was not cut short.
      eq(receipt.gasUsed, '0x1eda0c', '…and burned exactly its 2,000,000 rounds plus 21,900 intrinsic');
    }
  }

  // -------------------------------------------------------------------------
  group('what MetaMask, ethers and an explorer also ask for');
  // -------------------------------------------------------------------------
  /* test/jsonrpc.js drives every one of these against the fake chain, where the
   * semantics are pinned. This group answers the question the fake cannot: does
   * the REAL adapter stand in for it. Each check below is therefore about the
   * chain agreeing with the interface, not about the encoding. */
  {
    const info = await (await fetch(`http://127.0.0.1:${restPort}/info`)).json();
    eq(await rpc('net_peerCount'), '0x' + info.peers.toString(16), 'net_peerCount agrees with /info');
    eq(await rpc('eth_mining'), info.mining, 'eth_mining agrees with /info');
    eq(await rpc('eth_coinbase'), info.minerAddress, 'eth_coinbase is the address this node mines to');
    eq(await rpc('eth_hashrate'), '0x0', 'a node that is not mining hashes at 0x0');

    /* txpool_status splits the pool the way geth does. A transaction two nonces
     * above the account's is QUEUED — it cannot be mined until the gap is
     * filled — and reporting it as pending is how an operator concludes the
     * miner is stuck when it is the sender that is. */
    const n = BigInt(await rpc('eth_getTransactionCount', [alice.addressHex, 'pending']));
    await rpc('eth_sendRawTransaction',
      ['0x' + C.signed(alice, { nonce: n, to: bob.address, value: 1n, gasLimit: 21_000n }).toString('hex')]);
    await rpc('eth_sendRawTransaction',
      ['0x' + C.signed(alice, { nonce: n + 2n, to: bob.address, value: 1n, gasLimit: 21_000n }).toString('hex')]);
    eq(await rpc('txpool_status'), { pending: '0x1', queued: '0x1' },
      'one executable transaction is pending and one stranded above a nonce gap is queued');
    mine();
    eq(await rpc('txpool_status'), { pending: '0x0', queued: '0x1' },
      'mining the executable one leaves the stranded one queued');
  }

  {
    // the block-transaction-by-index family, against a block that really has one
    const height = await rpc('eth_blockNumber');
    const block = await rpc('eth_getBlockByNumber', [height, false]);
    eq(await rpc('eth_getBlockTransactionCountByNumber', [height]), '0x1', 'the tip carries one transaction');
    eq(await rpc('eth_getBlockTransactionCountByHash', [block.hash]), '0x1', 'and the same by block hash');
    const byIndex = await rpc('eth_getTransactionByBlockNumberAndIndex', [height, '0x0']);
    eq(byIndex.hash, block.transactions[0], 'index 0 is the block\'s first transaction');
    eq(byIndex, await rpc('eth_getTransactionByHash', [block.transactions[0]]),
      '…and is byte-identical to the same transaction fetched by hash');
    eq(byIndex.blockNumber, height, '…knowing its block');
    eq(byIndex.transactionIndex, '0x0', '…and its index');
    eq(await rpc('eth_getTransactionByBlockHashAndIndex', [block.hash, '0x0']), byIndex,
      'the by-block-hash form agrees');
    eq(await rpc('eth_getTransactionByBlockNumberAndIndex', [height, '0x5']), null, 'an index past the end is null');
    eq(await rpc('eth_getUncleCountByBlockNumber', [height]), '0x0', 'a Hearth block has no uncles');
    eq(await rpc('eth_getUncleByBlockNumberAndIndex', [height, '0x0']), null, 'and none to fetch');
  }

  {
    /* eth_feeHistory is OFF on a default node, because on a legacy-only chain
     * the only toolchain that calls it — Foundry — is better served by the error
     * (docs/network-config.md §5). So this measures it through a second server
     * built over the SAME chain with the option on, which is how an operator
     * running a private endpoint for a gas dashboard would get it. */
    eq((await rpcErr('eth_feeHistory', ['0x1', 'latest'])).code, -32601,
      'a default node does not serve eth_feeHistory');
    eq((await rpcErr('eth_maxPriorityFeePerGas', [])).code, -32601, 'nor eth_maxPriorityFeePerGas');
    const { JsonRpcServer } = require('../src/jsonrpc/server');
    const withFees = new JsonRpcServer({ chain: node.rpcChain, feeHistory: true });
    const rpc = (m, p = []) => withFees.methods[m](p, { remote: 'test' });

    // over real blocks, whose gas figures are the chain's own
    const f = await rpc('eth_feeHistory', ['0x3', 'latest', [50]]);
    const tipNo = BigInt(await rpc('eth_blockNumber'));
    eq(BigInt(f.oldestBlock), tipNo - 2n, 'the window ends at the requested block');
    eq(f.gasUsedRatio.length, 3, 'one gasUsedRatio per block');
    eq(f.baseFeePerGas.length, 4, 'and one more baseFeePerGas than that');
    ok(f.baseFeePerGas.every(v => v === '0x0'), 'every base fee is zero — v1 has no fee market');
    /* The value that has to come from the chain rather than from a constant:
     * the tip contains one 21,000-gas transfer in a 30,000,000-gas block. */
    const tipBlock = await rpc('eth_getBlockByNumber', ['latest', false]);
    eq(f.gasUsedRatio[2], Number(BigInt(tipBlock.gasUsed)) / Number(BigInt(tipBlock.gasLimit)),
      'and the ratio is the block\'s own gasUsed over its own gasLimit');
    eq(f.reward[2], ['0x' + C.GWEI.toString(16)],
      'with no base fee the reward at every percentile is the price the sender paid');
    eq(await rpc('eth_maxPriorityFeePerGas'), await rpc('eth_gasPrice'),
      'and eth_maxPriorityFeePerGas is that same whole price');
  }

  {
    /* THE FILTER FAMILY, END TO END OVER HTTP — the path ethers v6's
     * JsonRpcProvider takes before it falls back to polling eth_getLogs. */
    const blockFilter = await rpc('eth_newBlockFilter');
    const pendingFilter = await rpc('eth_newPendingTransactionFilter');
    const logFilter = await rpc('eth_newFilter', [{ address: contract }]);
    eq(await rpc('eth_getFilterChanges', [blockFilter]), [], 'a fresh block filter reports nothing yet');
    eq(await rpc('eth_getFilterChanges', [logFilter]), [],
      'and a fresh log filter does not replay the log already on this chain');

    const n = BigInt(await rpc('eth_getTransactionCount', [alice.addressHex, 'pending']));
    const set = C.signed(alice, {
      nonce: n, to: Buffer.from(contract.slice(2), 'hex'),
      data: Buffer.alloc(32).fill(7), gasLimit: 100_000n,
    });
    const setHash = await rpc('eth_sendRawTransaction', ['0x' + set.toString('hex')]);
    eq(await rpc('eth_getFilterChanges', [pendingFilter]), [setHash],
      'the pending filter reports the transaction the moment the pool admits it');
    eq(await rpc('eth_getFilterChanges', [pendingFilter]), [], '…exactly once');

    mine();
    const heads = await rpc('eth_getFilterChanges', [blockFilter]);
    eq(heads, [(await rpc('eth_getBlockByNumber', ['latest', false])).hash], 'the block filter reports the new head');
    const logs = await rpc('eth_getFilterChanges', [logFilter]);
    eq(logs.length, 1, 'and the log filter reports the log the transaction emitted');
    eq(logs[0].topics[0], '0x' + C.STORED_TOPIC.toString('hex'), '…under the right topic');
    eq(logs[0].data, '0x' + '07'.repeat(32), '…with the right data');
    eq(logs[0].transactionHash, setHash, '…naming the transaction it came from');
    eq(await rpc('eth_getFilterChanges', [logFilter]), [], 'and the cursor advanced past it');

    /* eth_getFilterLogs is the other half and does NOT consume: the full range
     * the filter declared, every time. Here that is `latest` at creation time,
     * which is why this asks the equivalent eth_getLogs rather than a constant. */
    eq(await rpc('eth_getFilterLogs', [logFilter]), await rpc('eth_getLogs', [{ address: contract }]),
      'eth_getFilterLogs answers the filter\'s whole declared range, identically to eth_getLogs');

    eq(await rpc('eth_uninstallFilter', [logFilter]), true, 'uninstalling a live filter is true');
    eq(await rpc('eth_uninstallFilter', [logFilter]), false, '…and false the second time, without an error');
    eq((await rpcErr('eth_getFilterChanges', [logFilter])).message, 'filter not found',
      'polling an uninstalled filter is geth\'s "filter not found", which is what makes ethers re-subscribe');
    eq((await rpcErr('eth_getFilterChanges', [logFilter])).code, -32000, '…as -32000');
    await rpc('eth_uninstallFilter', [blockFilter]);
    await rpc('eth_uninstallFilter', [pendingFilter]);
    eq(node.jsonrpc.filters.size, 0, 'and the node is holding no filters afterwards');
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
