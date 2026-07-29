'use strict';
/* Explorer API tests. Zero-dependency mini harness, same shape as node/test/*.
 *
 *   node test/explorer-api.test.js
 *
 * Everything runs over REAL HTTP in both directions: the service talks to a
 * fake chain served by the tree's own JSON-RPC layer (test/fakechain.js), and
 * the assertions talk to the service through its own socket. Calling the
 * handlers directly would skip the two things most likely to be wrong — the
 * wire encoding and the Etherscan envelope, both of which clients string-match.
 *
 * WHAT IS PROVEN HERE AND WHAT IS NOT. There is no account-model chain yet
 * (docs/evm-spec.md §8, phase 5), so every one of these is fixture-verified:
 * the blocks, receipts and logs are declared by the test and encoded by
 * node/src/jsonrpc. That is enough to prove the index, the reorg handling, the
 * envelope and the supply arithmetic. It is not a claim that anything has run
 * against a node, and the README says so in the same words.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FakeChain, serve, addrOf, hex, topicOf, word, TRANSFER, h32 } = require('./fakechain');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }
const show = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
function eq(a, b, msg) {
  if (show(a) === show(b)) pass++;
  else { fail++; console.log(`  ✗ ${msg}\n      want ${show(b)}\n      got  ${show(a)}`); }
}
function group(name) { console.log('• ' + name); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-explorer-test-'));
const E = n => BigInt(Math.round(n * 1e6)) * (10n ** 12n);

// ---- an http client --------------------------------------------------------

function get(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'GET', headers }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* plain text route */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port, url, body, contentType = 'application/x-www-form-urlencoded') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: url, method: 'POST',
      headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) },
    }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** GET /api with query parameters, returning the parsed envelope. */
const api = (port, params) => get(port, '/api?' + new URLSearchParams(params).toString()).then(r => r.json);

// ---- ABI encoding, just enough for token metadata --------------------------

function abiString(s) {
  const b = Buffer.from(s, 'utf8');
  const padded = Buffer.alloc(Math.ceil(b.length / 32) * 32 || 32);
  b.copy(padded);
  return Buffer.concat([word(32), word(b.length), padded]);
}

const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd' };

function registerToken(chain, addr, { name, symbol, decimals, totalSupply }) {
  chain.setCall(addr, SEL.name, abiString(name));
  chain.setCall(addr, SEL.symbol, abiString(symbol));
  chain.setCall(addr, SEL.decimals, word(decimals));
  if (totalSupply !== undefined) chain.setCall(addr, SEL.totalSupply, word(totalSupply));
}

// ---- the fixture chain -----------------------------------------------------

const ALICE = addrOf('alice'), BOB = addrOf('bob'), CAROL = addrOf('carol');
const DAVE = addrOf('dave'), ERIN = addrOf('erin');
const TOKEN_A = addrOf('tokenA'), TOKEN_B = addrOf('tokenB');
const COMMONS = addrOf('commons'), CREATED = addrOf('created');

function transferLog(token, from, to, amount) {
  return { address: token, topics: [TRANSFER, topicOf(from), topicOf(to)], data: word(amount) };
}

function buildFixture() {
  const chain = new FakeChain();                         // block 0 = genesis
  chain.addBlock({ txs: [{ from: ALICE, to: BOB, value: E(1) }] });                       // 1
  chain.addBlock({ txs: [
    { from: BOB, to: ALICE, value: E(0.5) },
    { from: ALICE, to: TOKEN_A, input: Buffer.from('a9059cbb' + '00'.repeat(64), 'hex'),
      logs: [transferLog(TOKEN_A, ALICE, CAROL, 100)] },
  ] });                                                                                   // 2
  chain.addBlock({ txs: [{ from: ALICE, to: null, creates: CREATED, gasUsed: 120000 }] }); // 3
  /* Block 4 is the one that matters for log ordinals: THREE logs across TWO
   * transactions, so the second transaction's only log is the block's THIRD.
   * An index that numbered logs from zero inside each receipt would file it as
   * ordinal 0 and then resolve Bob's transfer to Token A's first log — the
   * wrong contract, the wrong amount, the wrong counterparties. The block-wide
   * numbering is asserted directly over the wire below. */
  chain.addBlock({ txs: [
    { from: CAROL, to: TOKEN_A, logs: [
      transferLog(TOKEN_A, CAROL, ALICE, 7),
      { address: TOKEN_A, topics: [h32('Approval(address,address,uint256)')], data: word(1) },
    ] },
    { from: ALICE, to: TOKEN_B, logs: [transferLog(TOKEN_B, ALICE, BOB, 5)] },
  ] });                                                                                   // 4
  chain.addBlock({ txs: [{ from: ALICE, to: BOB, value: E(2), status: 0 }] });             // 5 reverted
  for (let i = 6; i <= 9; i++) chain.addBlock({ txs: [] });                                // 6..9
  chain.addBlock({ txs: [{ from: ALICE, to: DAVE, value: E(7) }] });                       // 10 — orphaned later

  registerToken(chain, TOKEN_A, { name: 'Token A', symbol: 'TKA', decimals: 18, totalSupply: 1000n * 10n ** 18n });
  registerToken(chain, TOKEN_B, { name: 'Token B', symbol: 'TKB', decimals: 6 });
  return chain;
}

// ---- catching the indexer up deterministically -----------------------------

async function catchUp(indexer) {
  for (let i = 0; i < 200; i++) {
    await indexer.syncOnce();
    if (indexer.parked) return;
    if (indexer.lag === 0) return;
  }
  throw new Error('the indexer never caught up');
}

async function main() {
  const chain = buildFixture();
  chain.setBalance(ALICE, E(100));
  chain.setBalance(BOB, E(3));
  chain.setBalance(COMMONS, E(6.6));
  const node = await serve(chain);

  // env.js reads process.env once, at require time.
  process.env.HEARTH_RPC_URL = `http://127.0.0.1:${node.port}`;
  process.env.HEARTH_EXPLORER_API_DATA = path.join(TMP, 'index');
  process.env.HEARTH_COMMONS_ADDRESS = hex(COMMONS);
  process.env.HEARTH_EXPLORER_API_LOG_LEVEL = 'error';
  process.env.HEARTH_EXPLORER_API_LOG_FORMAT = 'json';
  process.env.HEARTH_EXPLORER_API_POLL_MS = '5';

  const { env } = require('../src/env');
  const { build } = require('../src/index');
  const { createServer } = require('../src/server');
  const { Store, KIND } = require('../src/store');
  const { Supply, Emission, formatEmber } = require('../src/supply');

  const stack = build();
  stack.indexer.tracing = await stack.rpc.supportsTracing();
  await catchUp(stack.indexer);

  const server = createServer({ ...stack, env, api: stack.api, supply: stack.supply });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // ==========================================================================
  group('the index ingests the chain');
  {
    eq(stack.store.headNumber, 10, 'head is block 10');
    eq(stack.indexer.lag, 0, 'no lag after catching up');
    ok(stack.store.stats().postings > 0, 'postings were written');
    ok(stack.store.count(hex(ALICE).slice(2)) >= 6, 'alice has postings from several blocks');
    eq(stack.store.count(hex(addrOf('nobody')).slice(2)), 0, 'an address with no activity has none');
    const alice = stack.store.scan(hex(ALICE).slice(2), { kinds: [KIND.TX] });
    eq(alice.map(p => p.block), [1, 2, 2, 3, 4, 5, 10], 'alice appears in exactly the blocks she transacted in');
    ok(alice.every((p, i) => i === 0 || p.ordinal > alice[i - 1].ordinal), 'postings come back in block order');
  }

  // ==========================================================================
  group('the Etherscan envelope');
  {
    const r = await api(port, { module: 'account', action: 'balance', address: hex(ALICE) });
    eq(r.status, '1', 'status is the STRING "1", not a number or a boolean');
    eq(r.message, 'OK', 'message is OK');
    eq(r.result, E(100).toString(), 'balance is a decimal wei string');
    ok(typeof r.result === 'string', 'and a string — a wei value does not survive JSON.parse as a Number');

    const bad = await api(port, { module: 'account', action: 'balance', address: '0xnope' });
    eq(bad, { status: '0', message: 'NOTOK', result: 'Error! Invalid address format' }, 'a bad address is Etherscan-shaped NOTOK');

    const noModule = await api(port, { action: 'balance' });
    eq(noModule.status, '0', 'a missing module is status 0');
    ok(/Missing Or invalid Module name/.test(noModule.result), 'and names the problem');

    const noAction = await api(port, { module: 'account', action: 'nosuchthing', address: hex(ALICE) });
    ok(/Missing Or invalid Action name/.test(noAction.result), 'so is a missing action');

    const raw = await get(port, `/api?module=account&action=balance&address=${hex(ALICE)}`);
    eq(raw.status, 200, 'even a refusal is HTTP 200 — clients read `status`, not the status line');
  }

  // ==========================================================================
  group('module=account');
  {
    const multi = await api(port, {
      module: 'account', action: 'balancemulti', address: `${hex(ALICE)},${hex(BOB)}`,
    });
    eq(multi.result.map(x => x.balance), [E(100).toString(), E(3).toString()], 'balancemulti answers in order');
    eq(multi.result[0].account, hex(ALICE), 'and echoes the address as given');

    const tx = await api(port, { module: 'account', action: 'txlist', address: hex(ALICE) });
    eq(tx.status, '1', 'txlist finds alice');
    eq(tx.result.map(t => t.blockNumber), ['1', '2', '2', '3', '4', '5', '10'], 'every block she appears in, ascending');
    ok(tx.result.every(t => typeof t.value === 'string' && !/^0x/.test(t.value)), 'values are decimal strings');

    const sent = tx.result[0];
    eq(sent.from, hex(ALICE), 'from');
    eq(sent.to, hex(BOB), 'to');
    eq(sent.value, E(1).toString(), 'value in wei');
    eq(sent.isError, '0', 'a successful transaction has isError 0');
    eq(sent.txreceipt_status, '1', 'and txreceipt_status 1');
    eq(sent.confirmations, '9', 'confirmations count from the head');
    eq(sent.methodId, '0x', 'a plain transfer has no method id');

    const reverted = tx.result.find(t => t.blockNumber === '5');
    eq(reverted.isError, '1', 'a REVERTED transaction is isError 1 — included, gas spent, no value moved');
    eq(reverted.txreceipt_status, '0', 'and txreceipt_status 0');

    const creation = tx.result.find(t => t.blockNumber === '3');
    eq(creation.to, '', 'a contract creation has an empty `to`');
    eq(creation.contractAddress, hex(CREATED), 'and names the address it created');
    const byCreated = await api(port, { module: 'account', action: 'txlist', address: hex(CREATED) });
    eq(byCreated.result.length, 1, 'the created contract is indexed under its own address');
    eq(byCreated.result[0].hash, creation.hash, 'pointing at the transaction that created it');

    const desc = await api(port, { module: 'account', action: 'txlist', address: hex(ALICE), sort: 'desc' });
    eq(desc.result.map(t => t.blockNumber), ['10', '5', '4', '3', '2', '2', '1'], 'sort=desc reverses');

    const page2 = await api(port, {
      module: 'account', action: 'txlist', address: hex(ALICE), page: '2', offset: '2',
    });
    eq(page2.result.map(t => t.blockNumber), ['2', '3'], 'page/offset walks the same list');

    const ranged = await api(port, {
      module: 'account', action: 'txlist', address: hex(ALICE), startblock: '3', endblock: '4',
    });
    eq(ranged.result.map(t => t.blockNumber), ['3', '4'], 'startblock/endblock bound the scan');

    const none = await api(port, { module: 'account', action: 'txlist', address: hex(addrOf('nobody')) });
    eq(none, { status: '0', message: 'No transactions found', result: [] },
      'an address with nothing gets Etherscan\'s exact empty envelope');

    const capped = await api(port, { module: 'account', action: 'txlist', address: hex(ALICE), offset: '999999' });
    ok(capped.result.length <= env.maxOffset, 'offset is capped rather than honoured');
  }

  // ==========================================================================
  group('token transfers, and the log-index trap');
  {
    const bob = await api(port, { module: 'account', action: 'tokentx', address: hex(BOB) });
    eq(bob.status, '1', 'bob received a token transfer');
    eq(bob.result.length, 1, 'exactly one');
    /* THE ASSERTION THIS FIXTURE EXISTS FOR. Bob's transfer is the THIRD log in
     * block 4 but the FIRST log of its own receipt. An index keyed on the
     * node's per-receipt logIndex resolves it to Token A's log and reports the
     * wrong contract, the wrong amount and the wrong counterparties. */
    eq(bob.result[0].contractAddress, hex(TOKEN_B), 'and it is Token B, not the first log in the block');
    eq(bob.result[0].value, '5', 'with the right amount');
    eq(bob.result[0].from, hex(ALICE), 'and the right sender');
    eq(bob.result[0].tokenSymbol, 'TKB', 'symbol read from the contract');
    eq(bob.result[0].tokenDecimal, '6', 'decimals read from the contract, not assumed to be 18');

    const alice = await api(port, { module: 'account', action: 'tokentx', address: hex(ALICE) });
    eq(alice.result.length, 3, 'alice sent two and received one');
    eq(alice.result.map(t => t.contractAddress),
      [hex(TOKEN_A), hex(TOKEN_A), hex(TOKEN_B)], 'across both tokens');

    const filtered = await api(port, {
      module: 'account', action: 'tokentx', address: hex(ALICE), contractaddress: hex(TOKEN_B),
    });
    eq(filtered.result.length, 1, 'contractaddress narrows to one token');

    const nft = await api(port, { module: 'account', action: 'tokennfttx', address: hex(ALICE) });
    eq(nft.message, 'No transactions found', 'no ERC-721 transfers, and ERC-20 ones are not miscounted as such');
  }

  // ==========================================================================
  group('logIndex is numbered across the BLOCK, on every path that serves it');
  {
    /* THE CHECK THAT WOULD HAVE CAUGHT THE DEFECT THIS SUITE SHIPPED WITH.
     *
     * The fixture used to omit `logIndex` on the belief that the node numbers
     * logs per receipt; node/src/jsonrpc/methods.js `formatReceipt` instead
     * refuses to invent an ordinal it cannot derive from one receipt, so the
     * whole suite threw on the first block with a log and the Developer kit CI
     * job was red on every push. Asserting the values makes the contract
     * explicit: the fixture cannot go back to omitting them, and it cannot
     * start numbering them per receipt either.
     *
     * Block 4 is the discriminating case — two transactions, three logs. Per
     * BLOCK the ordinals are 0, 1, 2; per RECEIPT they would be 0, 1, 0. */
    const [tx0, tx1] = chain.blocks[4].transactions;

    const r0 = await api(port, { module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hex(tx0.hash) });
    ok(!r0.error, 'a receipt carrying logs is served rather than erroring');
    eq(r0.result.logs.map(l => l.logIndex), ['0x0', '0x1'], "the first transaction's two logs are 0 and 1");

    const r1 = await api(port, { module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hex(tx1.hash) });
    eq(r1.result.logs.map(l => l.logIndex), ['0x2'],
      "and the second transaction's ONE log is the block's THIRD — 0x2, not 0x0");

    /* eth_getLogs numbers the same logs itself when a chain omits the value
     * (methods.js `scanLogs`), so it is the one path that would have kept
     * working with a broken fixture. Requiring the two to agree pins them
     * together: a chain that numbers per receipt now disagrees with itself. */
    const scan = await api(port, {
      module: 'proxy', action: 'eth_getLogs',
      params: JSON.stringify([{ fromBlock: '0x4', toBlock: '0x4' }]),
    });
    eq(scan.result.map(l => l.logIndex), ['0x0', '0x1', '0x2'], 'eth_getLogs agrees, in block order');
    eq(scan.result.map(l => l.transactionIndex), ['0x0', '0x0', '0x1'],
      'and the ordinals cross the transaction boundary rather than restarting at it');

    // The index derives its own ordinal (hydrate.js flattenLogs) and must land
    // on the same number the node reports, or /api and eth_getLogs disagree
    // about which log a token transfer is.
    const bobtx = await api(port, { module: 'account', action: 'tokentx', address: hex(BOB) });
    eq(bobtx.result[0].logIndex, '2', "the index files Bob's transfer as the block's third log");
  }

  // ==========================================================================
  group('module=logs');
  {
    const byAddress = await api(port, {
      module: 'logs', action: 'getLogs', address: hex(TOKEN_A), fromBlock: '0', toBlock: 'latest',
    });
    eq(byAddress.result.length, 3, 'token A emitted three logs');
    ok(byAddress.result.every(l => /^0x[0-9a-f]+$/.test(l.blockNumber)), 'log fields are hex QUANTITY');
    eq(byAddress.result[0].logIndex, '0x0', 'zero is 0x0, not the bare 0x Etherscan emits');

    const byTopic = await api(port, {
      module: 'logs', action: 'getLogs', topic0: hex(TRANSFER), fromBlock: '0', toBlock: 'latest',
    });
    eq(byTopic.result.length, 3, 'the topic index finds every Transfer across both tokens');

    const both = await api(port, {
      module: 'logs', action: 'getLogs', address: hex(TOKEN_A), topic0: hex(TRANSFER),
      fromBlock: '0', toBlock: 'latest',
    });
    eq(both.result.length, 2, 'address and topic0 together intersect');
    eq(both.result.every(l => l.address === hex(TOKEN_A)), true, 'and the address really is filtered');

    const byIndexedFrom = await api(port, {
      module: 'logs', action: 'getLogs', address: hex(TOKEN_A), topic0: hex(TRANSFER),
      topic1: hex(topicOf(ALICE)), fromBlock: '0', toBlock: 'latest',
    });
    eq(byIndexedFrom.result.length, 1, 'topic1 narrows to transfers alice sent');

    const neither = await api(port, { module: 'logs', action: 'getLogs', fromBlock: '0', toBlock: '5' });
    ok(/Supply an address, a topic0, or both/.test(neither.result), 'an unfiltered scan is refused, not served');

    const wide = await api(port, { module: 'logs', action: 'getLogs', address: hex(TOKEN_A), fromBlock: '0', toBlock: '99999999' });
    ok(/Block range too wide/.test(wide.result), 'a range wider than the cap is refused');

    const orOperator = await api(port, {
      module: 'logs', action: 'getLogs', address: hex(TOKEN_A), topic0: hex(TRANSFER),
      topic1: hex(topicOf(ALICE)), topic0_1_opr: 'or', fromBlock: '0', toBlock: 'latest',
    });
    ok(/not supported/.test(orOperator.result), 'an OR operator is refused rather than silently ANDed');
  }

  // ==========================================================================
  group('module=transaction');
  {
    const good = chain.blocks[1].transactions[0].hash;
    const bad = chain.blocks[5].transactions[0].hash;
    const s1 = await api(port, { module: 'transaction', action: 'getstatus', txhash: hex(good) });
    eq(s1.result, { isError: '0', errDescription: '' }, 'a successful transaction');
    const s2 = await api(port, { module: 'transaction', action: 'getstatus', txhash: hex(bad) });
    eq(s2.result, { isError: '1', errDescription: 'Reverted' }, 'a reverted one');
    const r1 = await api(port, { module: 'transaction', action: 'gettxreceiptstatus', txhash: hex(good) });
    eq(r1.result, { status: '1' }, 'gettxreceiptstatus 1');
    const r2 = await api(port, { module: 'transaction', action: 'gettxreceiptstatus', txhash: hex(bad) });
    eq(r2.result, { status: '0' }, 'gettxreceiptstatus 0');
    const missing = await api(port, { module: 'transaction', action: 'getstatus', txhash: hex(h32('nothing')) });
    eq(missing.status, '0', 'an unknown transaction is an error');
    ok(/not found/.test(missing.result), 'and says so rather than reporting success');
  }

  // ==========================================================================
  group('module=proxy is raw JSON-RPC, not the envelope');
  {
    const r = await api(port, { module: 'proxy', action: 'eth_blockNumber' });
    eq(r.jsonrpc, '2.0', 'proxy answers JSON-RPC 2.0');
    eq(r.result, '0xa', 'with the tip as hex QUANTITY');
    ok(!('status' in r), 'and NOT the {status,message,result} envelope — its clients parse JSON-RPC');

    const blk = await api(port, { module: 'proxy', action: 'eth_getBlockByNumber', tag: '0x1', boolean: 'true' });
    eq(blk.result.number, '0x1', 'named Etherscan parameters map to positional JSON-RPC ones');
    eq(blk.result.transactions.length, 1, 'boolean=true gives full transactions');

    const code = await api(port, { module: 'proxy', action: 'eth_getCode', address: hex(TOKEN_A) });
    eq(code.result, '0x', 'eth_getCode passes through');

    const escape = await api(port, { module: 'proxy', action: 'eth_getBlockByHash', params: JSON.stringify([hex(chain.blocks[2].hash), false]) });
    eq(escape.result.number, '0x2', 'params= reaches a method with no Etherscan parameter mapping');

    const unknown = await api(port, { module: 'proxy', action: 'eth_nonsense' });
    eq(unknown.error.code, -32601, 'an unmapped method is a JSON-RPC method-not-found');

    const badAddr = await api(port, { module: 'proxy', action: 'eth_getCode', address: 'nope' });
    eq(badAddr.error.code, -32602, 'and a malformed address is invalid-params, still JSON-RPC shaped');
  }

  // ==========================================================================
  group('module=stats and the supply endpoints');
  {
    const supply = await stack.supply.read();
    eq(supply.height, 10, 'supply is computed at the tip');

    const e = new Emission({ r0Ember: '6', tailEmber: '0.3', halflifeYears: 2, blockTimeS: 15 });
    eq(e.subsidyWei(0), 6n * 10n ** 18n, 'the genesis subsidy is exactly 6 EMBER');
    eq(e.totalWei(0), 6n * 10n ** 18n, 'so is the total at height 0');
    ok(e.subsidyWei(1) < e.subsidyWei(0), 'the reward decays');
    eq(e.subsidyWei(500_000_000), 3n * 10n ** 17n, 'and floors at the 0.3 EMBER tail, forever');
    const eleven = e.totalWei(10);
    ok(eleven > 65_999_000_000_000_000_000n && eleven < 66_000_000_000_000_000_000n,
      'eleven blocks is a shade under 66 EMBER');
    eq(e.totalWei(10), supply.totalWei, 'the service uses the same model');

    eq(supply.commonsWei, E(6.6), 'the Commons balance is read from the chain, not modelled');
    eq(supply.circulatingWei, supply.totalWei - supply.commonsWei,
      'circulating = total − commons, exactly (docs/tokenomics.md §7)');
    eq(supply.unavailable, null, 'and it is available');

    const ethsupply = await api(port, { module: 'stats', action: 'ethsupply' });
    eq(ethsupply.result, supply.totalWei.toString(), 'stats.ethsupply is total supply in wei');
    const circ = await api(port, { module: 'stats', action: 'circulatingsupply' });
    eq(circ.result, supply.circulatingWei.toString(), 'stats.circulatingsupply is the subtracted figure');
    ok(BigInt(circ.result) < BigInt(ethsupply.result), 'and it is SMALLER than total — the whole point');

    const breakdown = await api(port, { module: 'stats', action: 'supplybreakdown' });
    eq(breakdown.result.maxSupply, 'none (uncapped)', 'max supply is stated, not omitted');
    ok(/tokenomics.md §7/.test(breakdown.result.methodology), 'the methodology cites its source');

    const total = await get(port, '/supply/total');
    ok(/^\d+(\.\d+)?\n$/.test(total.text), 'GET /supply/total is a bare decimal — no JSON, no units');
    eq(total.text.trim(), formatEmber(supply.totalWei), 'in EMBER');
    const totalWei = await get(port, '/supply/total?unit=wei');
    eq(totalWei.text.trim(), supply.totalWei.toString(), '?unit=wei switches to wei');
    const circulating = await get(port, '/supply/circulating');
    eq(circulating.status, 200, 'GET /supply/circulating answers');
    ok(Number(circulating.text) < Number(total.text), 'and is strictly less than total');

    const json = await get(port, '/supply');
    eq(json.json.maxSupply, null, '/supply reports no max supply');
    ok(json.json.circulatingSupply !== json.json.totalSupply,
      'total and circulating are DISTINCT fields with distinct values');

    const ts = await api(port, { module: 'stats', action: 'tokensupply', contractaddress: hex(TOKEN_A) });
    eq(ts.result, (1000n * 10n ** 18n).toString(), 'tokensupply calls totalSupply()');
    const tsBad = await api(port, { module: 'stats', action: 'tokensupply', contractaddress: hex(ALICE) });
    eq(tsBad.status, '0', 'a non-token address is an error, not a zero');
  }

  // ==========================================================================
  group('circulating supply REFUSES rather than reporting total');
  {
    /* The defect this service exists to fix: the node's /supply reports the
     * whole UTXO set — treasury included — under the name `circulating`. If we
     * cannot subtract the treasury we must not publish a number at all. */
    const blind = new Supply({ env: { ...env, commonsAddress: null }, rpc: stack.rpc });
    const s = await blind.read();
    eq(s.circulatingWei, null, 'with no Commons address there is no circulating figure');
    ok(s.totalWei > 0n, 'total is still served — it does not depend on the treasury');
    ok(/Refusing to serve total supply under the name "circulating"/.test(s.unavailable),
      'and the reason says exactly that');

    const blindServer = createServer({
      env: { ...env, commonsAddress: null }, api: stack.api, supply: blind,
      store: stack.store, indexer: stack.indexer, rpc: stack.rpc, hydrator: stack.hydrator,
    });
    await new Promise(r => blindServer.listen(0, '127.0.0.1', r));
    const bp = blindServer.address().port;
    const r = await get(bp, '/supply/circulating');
    eq(r.status, 503, 'and the endpoint is 503, not a number an aggregator would publish');
    ok(!/^\d/.test(r.text), 'the body is a reason, not a figure');
    eq((await get(bp, '/supply/total')).status, 200, 'total still answers 200');
    blindServer.close();

    // Rule 2: the model and the chain disagreeing is also a refusal.
    chain.setBalance(COMMONS, E(1000));
    const drifted = new Supply({ env, rpc: stack.rpc });
    const d = await drifted.read();
    eq(d.circulatingWei, null, 'a Commons balance larger than the model allows makes supply unavailable');
    ok(/exceeds what the emission model says/.test(d.unavailable), 'naming the disagreement');
    chain.setBalance(COMMONS, E(6.6));
  }

  // ==========================================================================
  group('internal transactions are refused, not faked');
  {
    const r = await api(port, { module: 'account', action: 'txlistinternal', address: hex(ALICE) });
    eq(r.status, '0', 'txlistinternal does not claim success');
    eq(r.message, 'NOTOK', 'it is an error envelope');
    ok(/not indexed/.test(r.result) && /debug_traceTransaction/.test(r.result),
      'and names the missing capability rather than returning an empty list');
    ok(!/No transactions found/.test(r.message),
      'because "no transactions found" would assert something we cannot know');
  }

  // ==========================================================================
  group('internal transactions ARE indexed when a node can trace');
  {
    const traced = new FakeChain();
    traced.addBlock({ txs: [{
      from: ALICE, to: CREATED, value: E(1),
      trace: {
        type: 'CALL', from: hex(ALICE), to: hex(CREATED), value: '0xde0b6b3a7640000', gas: '0x5208', gasUsed: '0x5208',
        calls: [{ type: 'CALL', from: hex(CREATED), to: hex(ERIN), value: '0x1bc16d674ec80000', gas: '0x0', gasUsed: '0x0' }],
      },
    }] });
    const tracedNode = await serve(traced, { tracing: true });
    const tracedStack = build({
      ...env, rpcUrl: `http://127.0.0.1:${tracedNode.port}`, dataDir: path.join(TMP, 'index-traced'),
    });
    tracedStack.indexer.tracing = await tracedStack.rpc.supportsTracing();
    ok(tracedStack.indexer.tracing, 'the capability probe detects debug_traceTransaction');
    await catchUp(tracedStack.indexer);

    const ts = createServer({
      ...tracedStack, env: tracedStack.env, api: tracedStack.api, supply: tracedStack.supply,
    });
    await new Promise(r => ts.listen(0, '127.0.0.1', r));
    const tp = ts.address().port;

    const erin = await api(tp, { module: 'account', action: 'txlistinternal', address: hex(ERIN) });
    eq(erin.status, '1', 'erin received value she never appears in a top-level transaction for');
    eq(erin.result.length, 1, 'one internal transfer');
    eq(erin.result[0].from, hex(CREATED), 'from the contract');
    eq(erin.result[0].value, E(2).toString(), 'for the traced amount');
    const top = await api(tp, { module: 'account', action: 'txlist', address: hex(ERIN) });
    eq(top.message, 'No transactions found',
      'and she has NO top-level transactions — which is exactly the deposit an exchange would miss');

    ts.close();
    tracedStack.indexer.stop();
    tracedStack.store.close();
    tracedNode.http.close();
  }

  // ==========================================================================
  group('the index refuses to answer while it is behind');
  {
    for (let i = 0; i < 20; i++) chain.addBlock({ txs: [] });
    // Learn the node's height without indexing anything: exactly the state a
    // freshly-started service is in for as long as its initial sync takes.
    stack.indexer.nodeHead = await stack.rpc.blockNumber();
    ok(stack.indexer.lag > env.maxLagBlocks, 'the index is now well behind the node');

    const r = await api(port, { module: 'account', action: 'txlist', address: hex(ALICE) });
    eq(r.status, '0', 'an address query refuses');
    ok(/blocks behind the node/.test(r.result), 'naming the lag');
    ok(!/No transactions found/.test(r.message),
      'rather than an empty list that is indistinguishable from the truth');

    const health = await get(port, '/health');
    eq(health.status, 503, '/health is 503 while behind');

    // Balances go straight to the node and are unaffected by the index.
    const bal = await api(port, { module: 'account', action: 'balance', address: hex(ALICE) });
    eq(bal.status, '1', 'balance still answers — it reads the node, not the index');

    await catchUp(stack.indexer);
    eq((await get(port, '/health')).status, 200, 'and /health recovers once caught up');
  }

  // ==========================================================================
  group('REORG — the index unwinds and stops serving orphaned transactions');
  {
    const orphanHash = hex(chain.blocks[10].transactions[0].hash);
    const before = await api(port, { module: 'account', action: 'txlist', address: hex(DAVE) });
    eq(before.result.length, 1, 'dave has one transaction on the original branch');
    eq(before.result[0].hash, orphanHash, 'the one that is about to be orphaned');
    const headBefore = stack.store.headNumber;
    const hash10Before = stack.store.blockAt(10).hash;

    /* Rewrite from height 8 on a different branch. Every hash from there up
     * changes, which is what makes this a reorg rather than a renumbering. The
     * new branch is longer, so this is the ordinary "someone out-hashed us"
     * case rather than the node-went-backwards one. */
    const specs = [{ txs: [] }, { txs: [{ from: ERIN, to: DAVE, value: E(4) }] }];
    while (specs.length < 25) specs.push({ txs: [] });
    chain.reorg(8, specs, 'b');

    await catchUp(stack.indexer);

    ok(stack.indexer.reorgs >= 1, 'the indexer noticed');
    ok(stack.indexer.deepestReorg >= headBefore - 7,
      'and rewound every block above the fork point, not just the tip');
    eq(stack.store.blockAt(7).hash, hex(chain.blocks[7].hash), 'blocks below the fork are untouched');
    ok(stack.store.blockAt(10).hash !== hash10Before, 'block 10 is now a different block');
    eq(stack.store.headNumber, chain.blocks.length - 1, 'the head follows the new branch');

    const after = await api(port, { module: 'account', action: 'txlist', address: hex(DAVE) });
    eq(after.result.length, 1, 'dave still has exactly one transaction');
    ok(after.result[0].hash !== orphanHash,
      'but NOT the orphaned one — an append-only index would still be serving it');
    eq(after.result[0].from, hex(ERIN), 'it is the transaction from the new branch');
    eq(after.result[0].value, E(4).toString(), 'with the new amount');

    const alice = await api(port, { module: 'account', action: 'txlist', address: hex(ALICE) });
    eq(alice.result.map(t => t.blockNumber), ['1', '2', '2', '3', '4', '5'],
      'alice keeps every transaction below the fork point and loses the one above it');

    // The hydrator caches blocks by number; those numbers now name different
    // blocks. If the cache were not invalidated with the index, this would
    // serve the orphaned block's contents from memory.
    const nine = await api(port, {
      module: 'account', action: 'txlist', address: hex(DAVE), startblock: '9', endblock: '9',
    });
    eq(nine.result.length, 1, 'block 9 on the new branch resolves through a cache that was invalidated');
  }

  // ==========================================================================
  group('a reorg deeper than the limit parks rather than rewriting history');
  {
    const parkDir = path.join(TMP, 'index-park');
    const parkChain = new FakeChain();
    for (let i = 0; i < 30; i++) parkChain.addBlock({ txs: [] });
    const parkNode = await serve(parkChain);
    const s = build({ ...env, rpcUrl: `http://127.0.0.1:${parkNode.port}`, dataDir: parkDir, maxReorgDepth: 3 });
    s.indexer.tracing = false;
    await catchUp(s.indexer);
    eq(s.store.headNumber, 30, 'indexed the chain');

    parkChain.reorg(5, new Array(26).fill({ txs: [] }), 'z');
    await s.indexer.syncOnce();
    ok(s.indexer.parked !== null, 'a 25-block reorg past a 3-block limit parks the indexer');
    ok(/refusing to rewind automatically/.test(s.indexer.parked), 'and says why');

    const ps = createServer({ ...s, env: s.env, api: s.api, supply: s.supply });
    await new Promise(r => ps.listen(0, '127.0.0.1', r));
    const pp = ps.address().port;
    const r = await api(pp, { module: 'account', action: 'txlist', address: hex(ALICE) });
    ok(/The index has stopped/.test(r.result), 'and every address query says so instead of answering');
    eq((await get(pp, '/health')).status, 503, '/health is 503');
    ps.close(); s.indexer.stop(); s.store.close(); parkNode.http.close();
  }

  // ==========================================================================
  group('the index survives a crash mid-write');
  {
    const dir = path.join(TMP, 'index-crash');
    const s1 = new Store({ dir, chainId: 7411, startBlock: 0, syncEvery: 1 }).open();
    const key = Buffer.from(hex(ALICE).slice(2), 'hex');
    for (let n = 0; n <= 5; n++) {
      s1.appendBlock({
        number: n, hash: hex(h32('c' + n)), parentHash: hex(h32('c' + (n - 1))),
        timestamp: 1000 + n, txCount: 1,
        postings: [{ key, kind: KIND.TX, flags: 1, txIndex: 0, subIndex: undefined }],
      });
    }
    eq(s1.headNumber, 5, 'six blocks written');
    s1.close();

    // Simulate a crash between the postings write and the chain record: extra
    // postings on disk, plus a half-written record on top of them.
    const postPath = path.join(dir, 'postings.idx');
    fs.appendFileSync(postPath, Buffer.alloc(48 + 17, 7));

    const s2 = new Store({ dir, chainId: 7411, startBlock: 0, syncEvery: 1 }).open();
    eq(s2.headNumber, 5, 'reopening recovers the last committed block, not the torn one');
    eq(s2.postCount, 6, 'and the uncommitted postings are gone');
    ok(s2.repaired.postTorn, 'the repair is reported rather than silent');
    eq(s2.count(hex(ALICE).slice(2)), 6, 'the in-memory index was rebuilt from the file');
    s2.close();

    // A chain record that survived without its postings.
    fs.truncateSync(postPath, 3 * 48);
    const s3 = new Store({ dir, chainId: 7411, startBlock: 0, syncEvery: 1 }).open();
    eq(s3.headNumber, 2, 'a chain record naming postings that are not there is dropped');
    eq(s3.count(hex(ALICE).slice(2)), 3, 'leaving a consistent index');
    s3.close();

    let refused = false;
    try { new Store({ dir, chainId: 999, startBlock: 0 }).open(); } catch { refused = true; }
    ok(refused, 'an index built for another chain id is refused, not reinterpreted');
  }

  // ==========================================================================
  group('module=contract, with and without a verifier');
  {
    const none = await api(port, { module: 'contract', action: 'getabi', address: hex(TOKEN_A) });
    eq(none, { status: '0', message: 'NOTOK', result: 'Contract source code not verified' },
      'with no verifier configured, getabi is Etherscan\'s exact "not verified"');

    const src = await api(port, { module: 'contract', action: 'getsourcecode', address: hex(TOKEN_A) });
    eq(src.status, '1', 'getsourcecode is status 1 even when unverified — Etherscan does this');
    eq(src.result[0].ABI, 'Contract source code not verified', 'with the string clients branch on');

    // A stand-in for tools/verify, exercising the same HTTP contract.
    const record = {
      address: hex(TOKEN_A),
      contractName: 'TokenA',
      compilerVersion: 'v0.8.26+commit.8a97fa7a',
      evmVersion: 'shanghai',
      optimizationUsed: true,
      runs: 999999,
      matchType: 'exact',
      verifiedAt: '2026-07-29T00:00:00.000Z',
      license: 'MIT',
      constructorArguments: '0x',
      constructorArgumentsVerified: false,
      libraries: { 'src/L.sol:L': '0x' + '11'.repeat(20) },
      abi: [{ type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }] }],
      standardJsonInput: { language: 'Solidity', sources: { 'A.sol': { content: 'contract A {}' } }, settings: {} },
    };
    const verifier = http.createServer((req, res) => {
      if (req.url === `/contract/${hex(TOKEN_A).toLowerCase()}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(record));
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise(r => verifier.listen(0, '127.0.0.1', r));

    const vs = build({ ...env, dataDir: path.join(TMP, 'index-verify'), verifyUrl: `http://127.0.0.1:${verifier.address().port}` });
    vs.indexer.tracing = false;
    await catchUp(vs.indexer);
    const vserver = createServer({ ...vs, env: vs.env, api: vs.api, supply: vs.supply });
    await new Promise(r => vserver.listen(0, '127.0.0.1', r));
    const vp = vserver.address().port;

    const abi = await api(vp, { module: 'contract', action: 'getabi', address: hex(TOKEN_A) });
    eq(abi.status, '1', 'a verified contract returns its ABI');
    eq(JSON.parse(abi.result)[0].name, 'totalSupply', 'as a JSON STRING, which is what Etherscan does');

    const s = await api(vp, { module: 'contract', action: 'getsourcecode', address: hex(TOKEN_A) });
    eq(s.result[0].ContractName, 'TokenA', 'getsourcecode carries the name');
    eq(s.result[0].CompilerVersion, 'v0.8.26+commit.8a97fa7a', 'the pinned compiler');
    eq(s.result[0].OptimizationUsed, '1', 'optimizer as "1"/"0"');
    eq(s.result[0].Runs, '999999', 'and the run count');
    ok(s.result[0].SourceCode.startsWith('{{'), 'multi-file sources use the {{…}} standard-JSON form');
    eq(s.result[0].Library, 'src/L.sol:L:1111111111111111111111111111111111111111', 'libraries in Etherscan\'s form');
    eq(s.result[0].HearthMatchType, 'exact', 'and the match type is exposed rather than hidden');

    const other = await api(vp, { module: 'contract', action: 'getabi', address: hex(TOKEN_B) });
    eq(other.result, 'Contract source code not verified', 'an unverified contract is still unverified');

    vserver.close(); vs.indexer.stop(); vs.store.close(); verifier.close();
  }

  // ==========================================================================
  group('routes and transport');
  {
    const formPost = await post(port, '/api', new URLSearchParams({
      module: 'account', action: 'balance', address: hex(ALICE),
    }).toString());
    eq(formPost.json.result, E(100).toString(), 'POST with a form body works, as Etherscan allows');

    const jsonPost = await post(port, '/api', JSON.stringify({
      module: 'account', action: 'balance', address: hex(ALICE),
    }), 'application/json');
    eq(jsonPost.json.result, E(100).toString(), 'so does a JSON body');

    eq((await get(port, '/nope')).status, 404, 'an unknown route is 404');
    const home = await get(port, '/');
    ok(home.status === 200 && /Hearth explorer API/.test(home.text), 'GET / serves a page');
    ok(/Circulating is not total/.test(home.text), 'that says circulating is not total');

    const health = await get(port, '/health');
    eq(health.json.ok, true, '/health is ok');
    eq(health.json.chainId, 7411, 'and reports the chain id');
    ok(health.json.index.postings > 0, 'with index statistics');
  }

  // ==========================================================================
  server.close();
  stack.indexer.stop();
  stack.store.close();
  node.http.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} explorer-api checks`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
