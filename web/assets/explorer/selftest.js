/* The explorer's self-test. Zero dependencies, no framework, no build step.
 *
 *   node web/assets/explorer/selftest.js
 *
 * There is no test runner in `web/` and there is not going to be one — the whole
 * point of this front-end is that it is plain files served by nginx. So the
 * checks that matter are written as assertions against published vectors and
 * against the node's own modules, and they run under plain node.
 *
 * Under node it additionally cross-checks two things this directory only has
 * COPIES of, which is where a front-end quietly goes wrong:
 *
 *   - keccak.js against node/src/crypto/keccak.js
 *   - disasm.js's mnemonic table against node/src/evm/opcodes.js
 *   - emission.js against node/src/params.js
 *
 * Those three files are the authority. This one is the alarm that goes off when
 * the copies drift.
 */

import { keccak256, keccak256Hex, utf8 } from './keccak.js';
import {
  toBig, toBytes, toHex, qty, padTopic, toChecksumAddress, addressFromTopic,
  formatUnits, formatGwei, formatBytes, percent, timeAgo, timestampLooksWrong, asAscii,
} from './format.js';
import * as ABI from './abi.js';
import * as DIS from './disasm.js';
import * as E from './emission.js';

let pass = 0;
const failures = [];

function ok(cond, msg) { if (cond) pass++; else failures.push(msg); }
function eq(actual, expected, msg) {
  const a = typeof actual === 'bigint' ? actual + 'n' : JSON.stringify(actual);
  const b = typeof expected === 'bigint' ? expected + 'n' : JSON.stringify(expected);
  if (a === b) pass++; else failures.push(`${msg}\n      want ${b}\n      got  ${a}`);
}

export async function run({ verbose = true } = {}) {
  const say = verbose ? (s) => console.log(s) : () => {};

  // ---- keccak ---------------------------------------------------------------
  say('• keccak-256');
  eq(keccak256Hex(utf8('')), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    'keccak256("") — the vector docs/evm-spec.md §5 names first');
  eq(keccak256Hex(utf8('abc')), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    'keccak256("abc")');
  // Rate boundaries: 135, 136 and 137 bytes are where a padding bug hides.
  for (const n of [135, 136, 137, 272]) {
    ok(keccak256(new Uint8Array(n)).length === 32, `keccak over ${n} zero bytes returns 32 bytes`);
  }
  eq(ABI.TRANSFER_TOPIC, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    'the ERC-20 Transfer topic — token detection is entirely this constant');
  eq(ABI.selectorOf('balanceOf(address)'), '0x70a08231', 'balanceOf selector');
  eq(ABI.selectorOf('transfer(address,uint256)'), '0xa9059cbb', 'transfer selector');

  // ---- EIP-55 ---------------------------------------------------------------
  say('• EIP-55 checksums');
  for (const a of [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]) {
    eq(toChecksumAddress(a.toLowerCase()), a, 'EIP-55 vector ' + a);
    eq(toChecksumAddress(a.toUpperCase().replace('0X', '0x')), a, 'EIP-55 from upper ' + a);
  }
  eq(addressFromTopic('0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'address out of a 32-byte topic');

  // ---- hex and quantities ---------------------------------------------------
  say('• hex encoding');
  eq(qty(0n), '0x0', 'zero is 0x0, never 0x00 — clients are strict about this');
  eq(qty(255n), '0xff', 'no leading zeros');
  eq(toBig('0x0'), 0n, '0x0 decodes');
  eq(toBig('0x'), 0n, 'empty quantity decodes as zero');
  eq(toHex(toBytes('0xdeadBEEF')), '0xdeadbeef', 'bytes round-trip, lowercased');
  ok((() => { try { toBytes('0xabc'); return false; } catch { return true; } })(),
    'odd-length hex throws rather than silently losing a nibble');
  eq(padTopic('0x1'), '0x' + '0'.repeat(63) + '1', 'topics are left-padded to 32 bytes');

  // ---- amounts --------------------------------------------------------------
  say('• amounts');
  eq(formatUnits(10n ** 18n, 18, 6), '1', 'one EMBER');
  eq(formatUnits(1n, 18, 18), '0.000000000000000001', 'one wei, exactly — no floating point anywhere');
  eq(formatUnits(123456789n * 10n ** 12n, 18, 6), '123.456789', 'truncation, not rounding');
  eq(formatUnits(2n ** 96n, 18, 4), '79,228,162,514.2643', 'a value far past 2^53 stays exact');
  eq(formatUnits(1500n * 10n ** 6n, 6, 6), '1,500', 'a 6-decimal token');
  eq(formatGwei(12n * 10n ** 9n), '12', 'gas price in gwei');
  eq(formatBytes(2048), '2.00 KiB', 'byte sizes');
  eq(percent(15n, 30n), 50, 'percentages are computed in BigInt then narrowed');
  eq(percent(1n, 0n), 0, 'a zero denominator does not divide by zero');
  eq(asAscii(utf8('hearth/homefire')), 'hearth/homefire', 'printable extraData is shown as text');
  eq(asAscii(new Uint8Array([0xff, 0x00])), '', 'non-printable extraData is not mangled into text');

  // ---- timestamps -----------------------------------------------------------
  say('• timestamps');
  eq(timeAgo(1000, 1015), '15s ago', 'age in seconds');
  ok(timestampLooksWrong(Date.now()), 'a millisecond timestamp is flagged, not rendered as the year 55000');
  ok(!timestampLooksWrong(Math.floor(Date.now() / 1000)), 'a seconds timestamp is not flagged');

  // ---- log decoding ---------------------------------------------------------
  say('• log decoding');
  const from = '0x7b0c2e9d4a6f81b3c5d7e9f0a2b4c6d8e0f13579';
  const to = '0x3f9a1d7c5e2b8046a9c3e5d7f1b3a5c7e9d0b246';
  const transferLog = {
    address: '0x9d4a3e7b1c5f8206d4e7a9c1b3d5f709e2a4c681',
    topics: [ABI.TRANSFER_TOPIC, padTopic(from), padTopic(to)],
    data: padTopic((1500n * 10n ** 6n).toString(16)),
  };
  const decoded = ABI.decodeLog(transferLog);
  eq(decoded.name, 'Transfer', 'a Transfer decodes');
  eq(decoded.args.map(a => a.name), ['from', 'to', 'value'], 'argument names');
  eq(decoded.args[2].value, 1500000000n, 'the non-indexed value comes out of data');
  eq(decoded.args[0].value, toChecksumAddress(from), 'indexed addresses come out of topics');

  const t20 = ABI.asTokenTransfer(transferLog);
  ok(t20 && t20.value === 1500000000n, 'and it reads as a token movement');
  ok(!t20.mint && !t20.burn, 'neither a mint nor a burn');
  ok(ABI.asTokenTransfer({ ...transferLog, topics: [...transferLog.topics, padTopic('0x1')], data: '0x' }) === null,
    'a FOUR-topic Transfer is ERC-721 and is NOT counted as a token amount');
  ok(ABI.decodeLog({ topics: ['0x' + '11'.repeat(32)], data: '0x' }) === null,
    'an unknown topic0 decodes to null rather than to a guess');
  ok(ABI.decodeLog({ address: '0x0', topics: [ABI.TRANSFER_TOPIC, padTopic(from), padTopic(to)], data: '0x' }) === null,
    'a Transfer with truncated data refuses to decode rather than inventing a zero');

  // ---- revert reasons -------------------------------------------------------
  say('• revert reasons');
  const errString = (msg) => {
    const b = utf8(msg);
    const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
    padded.set(b);
    return ABI.selectorOf('Error(string)') + padTopic('20').slice(2)
      + padTopic(b.length.toString(16)).slice(2) + toHex(padded).slice(2);
  };
  eq(ABI.decodeRevert(errString('EmberSwap: INSUFFICIENT_OUTPUT_AMOUNT')).text,
    'EmberSwap: INSUFFICIENT_OUTPUT_AMOUNT', 'Error(string) decodes to the require message');
  eq(ABI.decodeRevert('0x4e487b71' + padTopic('11').slice(2)).kind, 'Panic', 'Panic(uint256) is recognised');
  ok(ABI.decodeRevert('0x4e487b71' + padTopic('11').slice(2)).text.includes('overflow'),
    'and 0x11 is named as arithmetic overflow');
  eq(ABI.decodeRevert('0x').kind, 'empty', 'an empty revert is its own case, not an error');
  eq(ABI.decodeRevert('0xdeadbeef').kind, 'custom', 'a custom error stays raw — decoding needs an ABI');
  eq(ABI.decodeString('0x' + errString('hi').slice(10)), 'hi', 'ABI string decoding');
  eq(ABI.decodeString('0x'), null, 'an empty return decodes to null, not to an empty name');

  // ---- disassembly ----------------------------------------------------------
  say('• disassembly');
  eq(DIS.nameOf(0x5f), 'PUSH0', 'PUSH0 exists — this is Shanghai (EIP-3855)');
  eq(DIS.nameOf(0x5e), 'UNDEFINED_5e', 'MCOPY is Cancun and must NOT be defined here');
  eq(DIS.nameOf(0x5c), 'UNDEFINED_5c', 'TLOAD is Cancun');
  eq(DIS.nameOf(0x44), 'PREVRANDAO', 'the mnemonic Shanghai disassemblers emit at 0x44');
  eq(DIS.nameOf(0x48), 'BASEFEE', 'BASEFEE exists even though v1 has no fee market');
  eq(DIS.pushBytes(0x60), 1, 'PUSH1 takes one immediate byte');
  eq(DIS.pushBytes(0x7f), 32, 'PUSH32 takes thirty-two');
  eq(DIS.pushBytes(0x5f), 0, 'PUSH0 takes none');

  // The bug this guards: 0x5b inside PUSH data is NOT a jump destination.
  const trap = DIS.disassemble('0x' + '605b' + '5b' + '00');
  eq(trap.ops.map(o => o.name), ['PUSH1', 'JUMPDEST', 'STOP'], 'PUSH data is consumed, not decoded');
  eq([...trap.jumpdests], [2], 'only the real JUMPDEST is counted');
  const cut = DIS.disassemble('0x61ab');
  ok(cut.truncated && cut.ops[0].immediate === '0xab', 'PUSH data running past the end is reported, not dropped');
  eq(DIS.disassemble('0x').ops.length, 0, 'empty code disassembles to nothing');

  const dispatcher = '0x' + '63' + ABI.selectorOf('balanceOf(address)').slice(2) + '14' + '6000' + '57';
  eq(DIS.extractSelectors(dispatcher), ['0x70a08231'], 'a PUSH4 followed by EQ is read as a selector');
  eq(DIS.extractSelectors('0x' + '63' + '70a08231' + '50'), [],
    'a PUSH4 followed by POP is not — the heuristic stays narrow on purpose');
  eq(DIS.SELECTOR_NAMES.get('0x70a08231'), 'balanceOf(address)', 'known selectors are named');

  // ---- emission -------------------------------------------------------------
  say('• emission');
  eq(E.subsidy(0), 600000000, 'the genesis subsidy is 6 EMBER in sparks');
  eq(E.commonsCut(600000000), 60000000, '10% to the Commons');
  ok(E.subsidy(E.BLOCKS_PER_YEAR * 2) < E.subsidy(0), 'the reward has halved by the half-life');
  ok(E.subsidy(10 ** 9) === Math.round(E.TAIL_EMBER * E.SPARKS_PER_EMBER), 'and floors at the tail');
  const cum = E.cumulative(100);
  eq(cum.totalSparks, cum.minerSparks + cum.commonsSparks, 'the split adds back up');
  ok(cum.commonsSparks * 11n > cum.totalSparks && cum.commonsSparks * 9n < cum.totalSparks,
    'the Commons is about a tenth of everything issued');
  eq(E.sparksToEmber(600000000n), '6', 'sparks render as EMBER');
  eq(E.sparksToEmber(150000000n), '1.5', 'and keep their fraction');

  // ---- the fixture chain ----------------------------------------------------
  say('• fixtures');
  const F = await import('./fixtures.js');
  const call = async (method, params = []) => {
    const r = await F.fixtureTransport({ jsonrpc: '2.0', id: 1, method, params });
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
    return r.result;
  };
  // The fixture chain reports the CONFIGURED id, not a literal — see
  // assets/chain.js. Under node there is no document and no query string, so
  // this is DEFAULT_CHAIN_ID (7412, hearth-testnet).
  const { chainId, DEFAULT_CHAIN_ID } = await import('../chain.js');
  eq(chainId(), DEFAULT_CHAIN_ID, 'with no meta and no ?chainid=, the default applies');
  eq(await call('eth_chainId'), '0x' + chainId().toString(16),
    'the fixture chain reports the configured chain id (' + chainId() + ')');
  const tipHex = await call('eth_blockNumber');
  const tip = Number(toBig(tipHex));
  const tipBlock = await call('eth_getBlockByNumber', [tipHex, true]);
  eq(tipBlock.transactions.length, 0, 'the tip is an empty block — most blocks are');
  ok(!timestampLooksWrong(Number(toBig(tipBlock.timestamp))), 'fixture timestamps are SECONDS');
  ok(toBig(tipBlock.gasLimit) === 30000000n, 'the block gas limit is 30M (docs/evm-spec.md §1)');
  eq(await call('eth_getBlockByNumber', ['0xffffff', false]), null, 'a height above the tip is null, not an error');
  eq(await call('eth_getBlockByNumber', ['pending', false]), null, 'there is no pending block on this chain');

  const rev = await call('eth_getTransactionReceipt', [F.TOUR.txs.revert]);
  eq(rev.status, '0x0', 'a reverted transaction has a receipt with status 0x0');
  ok(rev.logs.length === 0, 'and no logs, because they were rolled back');
  const revTx = await call('eth_getTransactionByHash', [F.TOUR.txs.revert]);
  let reason = null;
  try { await call('eth_call', [{ to: revTx.to, from: revTx.from, data: revTx.input }, revTx.blockNumber]); }
  catch (e) { reason = ABI.decodeRevert(e.data).text; }
  eq(reason, 'EmberSwap: INSUFFICIENT_OUTPUT_AMOUNT', 'and its reason is recoverable by replaying the call');

  eq(await call('eth_getTransactionReceipt', [F.TOUR.txs.pending]), null,
    'a pending transaction has a NULL receipt — never an error, because every client polls it');
  const pend = await call('eth_getTransactionByHash', [F.TOUR.txs.pending]);
  eq(pend.blockNumber, null, 'and a null block number');
  eq(await call('eth_getTransactionByHash', [F.TOUR.txs.unknown]), null, 'an unknown hash is null');

  eq(await call('eth_getBalance', [F.TOUR.addresses.dead, 'latest']), '0x0', 'an unused account has zero balance');
  eq(await call('eth_getCode', [F.TOUR.addresses.dead, 'latest']), '0x', 'and no code');

  const code = await call('eth_getCode', [F.TOUR.addresses.usdf, 'latest']);
  ok(code.length > 200, 'the fixture token has real bytecode');
  eq(DIS.classifyCode(code), 'looks like ERC-20', 'whose dispatcher reads as ERC-20');
  const proxy = await call('eth_getCode', [F.TOUR.addresses.proxy, 'latest']);
  eq(DIS.extractSelectors(proxy).length, 0, 'and the minimal proxy has no selectors at all');
  ok(DIS.disassemble(proxy).ops.length > 5, 'but still disassembles');

  const allTransfers = await call('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest', topics: [ABI.TRANSFER_TOPIC] }]);
  ok(allTransfers.length >= 5, 'Transfer logs are found across the range');
  const aliceOut = await call('eth_getLogs', [{
    fromBlock: '0x0', toBlock: 'latest', topics: [ABI.TRANSFER_TOPIC, padTopic(F.TOUR.addresses.alice)],
  }]);
  ok(aliceOut.length > 0 && aliceOut.every(l => l.topics[1] === padTopic(F.TOUR.addresses.alice)),
    'positional topic matching constrains topic1 and only topic1');
  const orQuery = await call('eth_getLogs', [{
    fromBlock: '0x0', toBlock: 'latest',
    topics: [[ABI.TRANSFER_TOPIC, ABI.APPROVAL_TOPIC]],
  }]);
  ok(orQuery.length > allTransfers.length, 'an array in one position is an OR, not an AND');
  eq(await call('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest', topics: ['0x' + '22'.repeat(32)] }]), [],
    'a filter that matches nothing returns an empty array, which is a valid answer');

  const meta = await call('eth_call', [{ to: F.TOUR.addresses.usdf, data: ABI.SELECTORS.symbol }, 'latest']);
  eq(ABI.decodeString(meta), 'USDF', 'token symbol reads back over eth_call');
  eq(ABI.decodeUint(await call('eth_call', [{ to: F.TOUR.addresses.usdf, data: ABI.SELECTORS.decimals }, 'latest'])), 6n,
    'and its decimals are 6, not an assumed 18');
  eq(await call('eth_call', [{ to: F.TOUR.addresses.dead, data: ABI.SELECTORS.symbol }, 'latest']), '0x',
    'a call into an address with no code SUCCEEDS and returns empty — the UI must not read that as a value');

  // Every gallery link must resolve to something.
  for (const [name, hash] of Object.entries(F.TOUR.txs)) {
    if (name === 'unknown') continue;
    ok(await call('eth_getTransactionByHash', [hash]) !== null, `gallery tx "${name}" exists`);
  }
  for (const [name, addr] of Object.entries(F.TOUR.addresses)) {
    ok(/^0x[0-9a-f]{40}$/.test(addr), `gallery address "${name}" is a well-formed 20-byte address`);
  }
  for (const h of Object.values(F.TOUR.blocks)) {
    ok(await call('eth_getBlockByNumber', [qty(BigInt(h)), false]) !== null, `gallery block ${h} exists`);
  }

  // ---- search dispatch ------------------------------------------------------
  say('• search');
  const { classifyQuery } = await import('./search.js');
  eq(classifyQuery('4204').kind, 'height', 'digits are a block height');
  eq(classifyQuery('  0x' + '11'.repeat(20) + ' ').kind, 'address', 'an address, whitespace and all');
  eq(classifyQuery('0x' + '11'.repeat(32)).kind, 'hash', '64 hex is a hash — tx or block, decided by asking both');
  eq(classifyQuery('Transfer(address,address,uint256)').kind, 'event', 'an event signature goes to log search');
  eq(classifyQuery('ember1qqqq').kind, 'unknown', 'a bech32 address is not a thing on this chain any more');
  eq(classifyQuery('0x123').kind, 'unknown', 'a hex string of the wrong length is refused, not truncated');
  eq(classifyQuery('').kind, 'empty', 'an empty box does nothing');
  eq(classifyQuery('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').checksumFailed, false,
    'a valid EIP-55 address passes');
  eq(classifyQuery('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD').checksumFailed, true,
    'one flipped character fails its checksum and is reported');
  eq(classifyQuery('0x' + '11'.repeat(20)).checksumFailed, false,
    'an all-lowercase address carries no checksum and is not accused of failing one');

  // ---- the rpc client's batch discipline ------------------------------------
  say('• rpc client');
  const rpc = await import('./rpc.js');

  // WHICH PREFIX THE PAGES DEFAULT TO, which is the whole of CF-13. `/rpc/` is
  // the REST + SSE proxy that mine.html needs; `/eth-rpc/` is the JSON-RPC one.
  // Defaulting to the first meant every eth_* call reached the REST server,
  // which answers HTTP 404 with a body carrying neither `result` nor `error` —
  // reported as MalformedResponse, and read by a visitor as a dead chain.
  const deployed = { search: '', protocol: 'https:', origin: 'https://explorer.cloudsforge.online' };
  eq(rpc.resolveEndpoint('', deployed), 'https://explorer.cloudsforge.online/eth-rpc/',
    'the same-origin default is the JSON-RPC proxy');
  ok(!rpc.resolveEndpoint('', deployed).endsWith('/rpc/'),
    'and it is NOT /rpc/, which is the REST prefix mine.html reads /info and /events through');
  eq(rpc.resolveEndpoint('?rpc=http://127.0.0.1:8545/', deployed), 'http://127.0.0.1:8545',
    '?rpc= still overrides it, trailing slash trimmed');
  eq(rpc.resolveEndpoint('', null), 'http://localhost:8545',
    'a page opened straight off disk falls back to the JSON-RPC port, not the REST one');
  rpc.useTransport(async (payload) => {
    // Answer a batch in REVERSE order. The spec allows any order and the server
    // comment says so; a client that matches by position instead of by id will
    // return the wrong answers here and nowhere else.
    const res = payload.map(p => ({ jsonrpc: '2.0', id: p.id, result: p.method }));
    return res.reverse();
  });
  const batched = await rpc.batch([['eth_chainId', []], ['eth_blockNumber', []], ['eth_gasPrice', []]]);
  eq(batched.map(r => r.value), ['eth_chainId', 'eth_blockNumber', 'eth_gasPrice'],
    'batch responses are matched by id, not by position');

  rpc.useTransport(async (payload) => payload.map(p => (p.method === 'eth_gasPrice'
    ? { jsonrpc: '2.0', id: p.id, error: { code: -32000, message: 'boom' } }
    : { jsonrpc: '2.0', id: p.id, result: '0x1' })));
  const mixed = await rpc.batch([['eth_chainId', []], ['eth_gasPrice', []]]);
  ok(mixed[0].ok && !mixed[1].ok, 'one failing member of a batch does not blank the others');
  ok(mixed[1].error instanceof rpc.RpcError, 'and it arrives as an RpcError');

  rpc.useTransport(async () => ({ jsonrpc: '2.0', id: 1, result: null }));
  eq(await rpc.call('eth_getTransactionByHash', ['0x0']), null, 'a null result is a result, not an error');

  rpc.useTransport(async () => ({ nonsense: true }));
  let malformed = false;
  try { await rpc.call('eth_chainId'); } catch (e) { malformed = e instanceof rpc.MalformedResponse; }
  ok(malformed, 'a response with neither result nor error is MalformedResponse, not an empty chain');

  rpc.useTransport(F.fixtureTransport);   // leave it somewhere harmless

  // ---- cross-checks against the node ---------------------------------------
  if (typeof window === 'undefined') {
    say('• cross-checks against node/src (the authority)');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);

    const nodeKeccak = require('../../../node/src/crypto/keccak.js');
    let keccakDrift = 0;
    for (let i = 0; i < 300; i++) {
      const len = (i * 7) % 400;
      const buf = new Uint8Array(len).map((_, j) => (i * 31 + j * 17) & 0xff);
      if (keccak256Hex(buf) !== '0x' + nodeKeccak.keccak256(Buffer.from(buf)).toString('hex')) keccakDrift++;
    }
    eq(keccakDrift, 0, 'keccak.js agrees with node/src/crypto/keccak.js over 300 inputs');

    const nodeOps = require('../../../node/src/evm/opcodes.js');
    let opDrift = [];
    for (let op = 0; op < 256; op++) {
      const theirs = nodeOps.opcodeAt(op);
      if (theirs.name !== DIS.nameOf(op)) opDrift.push(`0x${op.toString(16)}: node says ${theirs.name}, disasm.js says ${DIS.nameOf(op)}`);
      if (theirs.defined !== DIS.isDefined(op)) opDrift.push(`0x${op.toString(16)}: defined flag differs`);
      if (nodeOps.pushBytes(op) !== DIS.pushBytes(op)) opDrift.push(`0x${op.toString(16)}: immediate width differs`);
    }
    eq(opDrift, [], 'disasm.js matches node/src/evm/opcodes.js for all 256 bytes');

    const P = require('../../../node/src/params.js');
    let subsidyDrift = 0;
    for (const h of [0, 1, 1000, 999999, P.BLOCKS_PER_YEAR, P.BLOCKS_PER_YEAR * 2,
      P.BLOCKS_PER_YEAR * 2 - 1, P.BLOCKS_PER_YEAR * 7, 10 ** 8]) {
      if (P.subsidy(h) !== E.subsidy(h)) subsidyDrift++;
    }
    eq(subsidyDrift, 0, 'emission.js reproduces node/src/params.js subsidy() exactly');
    eq(E.BLOCKS_PER_YEAR, P.BLOCKS_PER_YEAR, 'and the same blocks-per-year');
    eq(E.SPARKS_PER_EMBER, P.SPARKS_PER_EMBER, 'and the same base unit');
  }

  say('');
  if (failures.length) {
    console.log(`${pass} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log('  ✗ ' + f);
  } else {
    console.log(`${pass} checks passed.`);
  }
  return { pass, failures };
}

// Running under node: execute and set the exit code. In a browser this file is
// inert until something imports and calls run().
if (typeof window === 'undefined' && typeof process !== 'undefined') {
  run().then(r => { process.exitCode = r.failures.length ? 1 : 0; });
}
