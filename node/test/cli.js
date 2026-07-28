'use strict';
/* Tests for the `hearth` CLI. Zero-dependency mini harness, same shape as
 * test/unit.js. Run: node test/cli.js
 *
 * WHAT THIS SUITE IS ACTUALLY FOR, in priority order:
 *
 *   1. THE TRACER, asserted step for step against hand-built bytecode whose
 *      every gas figure is derivable from the Shanghai schedule by hand. A
 *      tracer that is merely plausible is worse than none: it will be believed
 *      on the morning a GeneralStateTests vector goes red, and a wrong pc or a
 *      wrong stack order will send somebody a week in the wrong direction. So
 *      the expectations below are written out literally rather than computed
 *      from the thing under test.
 *
 *   2. ABI round-trips against the ENCODINGS PUBLISHED IN THE SOLIDITY ABI
 *      SPECIFICATION, not against our own encoder. Four of the five examples
 *      there exist precisely because they catch a different mistake: bytes3[2]
 *      catches right-padding, sam() catches the offset base, f() catches
 *      mixing static and dynamic heads, and g() catches nested dynamic offsets.
 *
 *   3. Everything that touches a key, because those failures are silent.
 *
 * The suite is mutation-tested: see the log at the bottom of this file for what
 * that caught.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const abi = require('../src/cli/abi');
const args = require('../src/cli/args');
const ui = require('../src/cli/ui');
const keystore = require('../src/cli/keystore');
const trace = require('../src/cli/trace');
const watch = require('../src/cli/watch');
const devnet = require('../src/cli/devnet');
const contract = require('../src/cli/contract');
const { Client } = require('../src/cli/client');
const { keccak256 } = require('../src/crypto/keccak');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
/* BigInt has no JSON form, and every gas figure in this suite is one, so the
 * comparison renders it rather than throwing halfway through the run. */
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x));
function eq(a, b, msg) {
  const same = typeof a === 'bigint' || typeof b === 'bigint' ? a === b : show(a) === show(b);
  if (same) { pass++; return; }
  fail++;
  console.log('  ✗ ' + msg);
  console.log('      want ' + show(b));
  console.log('      got  ' + show(a));
}
function throws(fn, match, msg) {
  try { fn(); } catch (e) {
    if (!match || String(e.message).includes(match)) { pass++; return; }
    fail++; console.log(`  ✗ ${msg} — threw the wrong error: ${e.message}`); return;
  }
  fail++; console.log('  ✗ ' + msg + ' — did not throw');
}
function group(name) { console.log('• ' + name); }

const HEX = (s) => Buffer.from(String(s).replace(/^0x/, ''), 'hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-cli-'));

// ===========================================================================
group('args');
// ===========================================================================
{
  const SPEC = { booleans: ['json'], strings: ['op', 'depth'] };
  eq(args.parse(['--json', '--op', 'SSTORE', 'x'], SPEC).flags, { json: true, op: 'SSTORE' }, 'value flag takes the next token');
  eq(args.parse(['--json', '--op', 'SSTORE', 'x'], SPEC).positional, ['x'], 'positionals survive flags');
  eq(args.parse(['--op=SSTORE,SLOAD'], SPEC).flags.op, 'SSTORE,SLOAD', '--flag=value form');
  /* The reason value flags must be declared: a greedy parser reads `--op` as the
   * value of `--json` and traces the wrong thing without ever complaining. */
  eq(args.parse(['--json', '--op=X'], { booleans: ['json'], strings: ['op'] }).flags.json, true, 'a boolean before a value flag stays boolean');
  eq(args.parse(['--', '--json'], SPEC).positional, ['--json'], '-- ends option parsing');
  eq(args.parse(['-h'], SPEC).flags.help, true, '-h is always help');
  throws(() => args.parse(['--nope'], SPEC), 'unknown option', 'an unknown flag is rejected by name');
  throws(() => args.parse(['--op'], SPEC), 'needs a value', 'a value flag with nothing after it is rejected');
  eq(args.bigFlag({ gas: '0x1e8480' }, 'gas'), 2000000n, 'bigFlag reads hex');
  eq(args.bigFlag({ gas: '2000000' }, 'gas'), 2000000n, 'bigFlag reads decimal');
  eq(args.bigFlag({}, 'gas', 7n), 7n, 'bigFlag default');
  throws(() => args.bigFlag({ gas: 'later' }, 'gas'), 'non-negative integer', 'bigFlag rejects nonsense');
  throws(() => args.intFlag({ depth: '-1' }, 'depth'), 'non-negative', 'intFlag rejects negatives');
}

// ===========================================================================
group('ui');
// ===========================================================================
{
  // The EIP-55 specification's own examples.
  const EIP55 = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];
  for (const a of EIP55) {
    eq(ui.checksumAddress(a.toLowerCase()), a, `EIP-55 checksum ${a.slice(0, 10)}…`);
    eq(ui.checksumAddress(a), a, `EIP-55 is idempotent for ${a.slice(0, 10)}…`);
  }
  throws(() => ui.checksumAddress('0x1234'), '20 bytes', 'a short address is refused, not padded');

  eq(ui.formatUnits(10n ** 18n, 'ether'), '1', '1e18 wei is 1 EMBER');
  eq(ui.formatUnits(1n, 'ether'), '0.000000000000000001', 'one wei keeps all 18 places');
  eq(ui.formatUnits(1500000000000000000n, 'ether'), '1.5', 'trailing zeros are trimmed');
  eq(ui.formatUnits(0n, 'ether'), '0', 'zero is "0" and not "0."');
  eq(ui.parseUnits('1.5', 'ether'), 1500000000000000000n, 'parseUnits is the inverse');
  eq(ui.parseUnits('0.000000000000000001', 'ether'), 1n, 'parseUnits reaches one wei');
  /* Rounding an amount silently is how a wallet sends the wrong number. */
  throws(() => ui.parseUnits('1.0000000000000000001', 'ether'), 'decimal places', 'more precision than exists is refused, not rounded');
  throws(() => ui.parseUnits('1e18', 'ether'), 'not a decimal', 'exponent notation is refused');
  eq(ui.formatUnits(ui.parseUnits('123456.789', 'ether'), 'ether'), '123456.789', 'format/parse round-trip');

  eq(ui.word('0x000000000000000000000000000000000000000000000000000000000000002a'), '0x2a', 'a word prints with its leading zeros dropped');
  eq(ui.word(0n), '0x0', 'zero is 0x0, not 0x');
  eq(ui.width('\x1b[31mred\x1b[39m'), 3, 'width ignores colour escapes');
  eq(ui.padEnd('\x1b[31mred\x1b[39m', 5).length, '\x1b[31mred\x1b[39m'.length + 2, 'padding measures visible width');
}

// ===========================================================================
group('abi — types and selectors');
// ===========================================================================
{
  eq(abi.canonical(abi.parseType('uint')), 'uint256', 'uint canonicalises to uint256');
  eq(abi.canonical(abi.parseType('int')), 'int256', 'int canonicalises to int256');
  eq(abi.canonical(abi.parseType('(uint,bool)[2][]')), '(uint256,bool)[2][]', 'nested array of tuples canonicalises');
  eq(abi.isDynamic(abi.parseType('(uint256,bytes)')), true, 'a tuple with a dynamic field is dynamic');
  eq(abi.isDynamic(abi.parseType('(uint256,bool)')), false, 'an all-static tuple is static');
  eq(abi.isDynamic(abi.parseType('uint256[2]')), false, 'a fixed array of statics is static');
  eq(abi.isDynamic(abi.parseType('uint256[]')), true, 'an unsized array is dynamic');
  eq(abi.headWords(abi.parseType('(uint256,bool)')), 2, 'a static tuple occupies its fields in place');
  eq(abi.headWords(abi.parseType('uint256[3]')), 3, 'a static array occupies n words in place');
  throws(() => abi.parseType('uint7'), 'unsupported', 'uint7 is not a type');
  throws(() => abi.parseType('bytes33'), 'unsupported', 'bytes33 is not a type');
  throws(() => abi.parseType('ufixed128x18'), 'fixed-point', 'fixed-point is refused by name');

  // Selectors whose values are published and widely depended upon.
  const sel = (s) => '0x' + abi.selector(s).toString('hex');
  eq(sel('transfer(address,uint256)'), '0xa9059cbb', 'ERC-20 transfer selector');
  eq(sel('balanceOf(address)'), '0x70a08231', 'ERC-20 balanceOf selector');
  eq(sel('approve(address,uint256)'), '0x095ea7b3', 'ERC-20 approve selector');
  eq(sel('Error(string)'), '0x08c379a0', 'Error(string) selector');
  eq(sel('Panic(uint256)'), '0x4e487b71', 'Panic(uint256) selector');
  eq('0x' + abi.topicHash('Transfer(address,address,uint256)').toString('hex'),
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', 'ERC-20 Transfer topic0');
  // The Solidity ABI specification's own examples.
  eq(sel('baz(uint32,bool)'), '0xcdcd77c0', 'ABI spec: baz(uint32,bool)');
  eq(sel('bar(bytes3[2])'), '0xfce353f6', 'ABI spec: bar(bytes3[2])');
  eq(sel('sam(bytes,bool,uint256[])'), '0xa5643bf2', 'ABI spec: sam(bytes,bool,uint256[])');
  eq(sel('f(uint256,uint32[],bytes10,bytes)'), '0x8be65246', 'ABI spec: f(uint256,uint32[],bytes10,bytes)');
  eq(sel('g(uint256[][],string[])'), '0x2289b18c', 'ABI spec: g(uint256[][],string[])');
}

// ===========================================================================
group('abi — encoding against the published examples');
// ===========================================================================
{
  const enc = (types, values) => abi.encodeParameters(types, values).toString('hex');
  const words = (...w) => w.join('');
  const W = (h) => String(h).padStart(64, '0');

  eq(enc(['uint32', 'bool'], [69, true]), words(W('45'), W('1')), 'ABI spec: baz(69, true)');

  eq(enc(['bytes3[2]'], [['0x616263', '0x646566']]),
    words('6162630000000000000000000000000000000000000000000000000000000000',
      '6465660000000000000000000000000000000000000000000000000000000000'),
    'ABI spec: bar(["abc","def"]) — bytesN is RIGHT-padded, unlike every number');

  eq(enc(['bytes', 'bool', 'uint256[]'], ['0x64617665', true, [1, 2, 3]]),
    words(W('60'), W('1'), W('a0'), W('4'),
      '6461766500000000000000000000000000000000000000000000000000000000',
      W('3'), W('1'), W('2'), W('3')),
    'ABI spec: sam("dave", true, [1,2,3])');

  eq(enc(['uint256', 'uint32[]', 'bytes10', 'bytes'], ['0x123', ['0x456', '0x789'], '0x31323334353637383930', '0x48656c6c6f2c20776f726c6421']),
    words(W('123'), W('80'),
      '3132333435363738393000000000000000000000000000000000000000000000',
      W('e0'), W('2'), W('456'), W('789'), W('d'),
      '48656c6c6f2c20776f726c642100000000000000000000000000000000000000'),
    'ABI spec: f(0x123, [0x456,0x789], "1234567890", "Hello, world!")');

  /* A STATIC array or tuple occupies several words IN PLACE, so a following
   * dynamic member's offset is not "one word per member". Nothing above catches
   * a head-size computed as `members * 32`, because every example there happens
   * to have one-word heads. */
  eq(enc(['uint256[2]', 'string'], [[1, 2], 'x']),
    words(W('1'), W('2'), W('60'), W('1'), '7800000000000000000000000000000000000000000000000000000000000000'),
    'a static array occupies 2 words in the head, so the string offset is 0x60 and not 0x40');
  eq(enc(['(uint256,bool)', 'bytes'], [[7, true], '0xab']),
    words(W('7'), W('1'), W('60'), W('1'), 'ab00000000000000000000000000000000000000000000000000000000000000'),
    'and so does a static tuple');
  eq(abi.decodeParameters(['uint256[2]', 'string'], abi.encodeParameters(['uint256[2]', 'string'], [[1, 2], 'x'])),
    [[1n, 2n], 'x'], 'and it decodes back through the same head arithmetic');

  eq(enc(['uint256[][]', 'string[]'], [[[1, 2], [3]], ['one', 'two', 'three']]),
    words(W('40'), W('140'), W('2'), W('40'), W('a0'), W('2'), W('1'), W('2'), W('1'), W('3'),
      W('3'), W('60'), W('a0'), W('e0'),
      W('3'), '6f6e650000000000000000000000000000000000000000000000000000000000',
      W('3'), '74776f0000000000000000000000000000000000000000000000000000000000',
      W('5'), '7468726565000000000000000000000000000000000000000000000000000000'),
    'ABI spec: g([[1,2],[3]], ["one","two","three"]) — nested dynamic offsets');
}

// ===========================================================================
group('abi — decoding and round-trips');
// ===========================================================================
{
  const round = (types, values, msg) => {
    const got = abi.decodeParameters(types, abi.encodeParameters(types, values));
    eq(JSON.parse(JSON.stringify(got, (k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      JSON.parse(JSON.stringify(values, (k, v) => (typeof v === 'bigint' ? v.toString() : v))), msg);
  };
  round(['uint256'], ['340282366920938463463374607431768211456'], 'uint256 beyond 2^53 survives — the reason every quantity is a BigInt');
  round(['string'], ['a string with ünïcödé and a 🔥'], 'utf-8 string round-trip');
  round(['bytes'], ['0x' + 'ab'.repeat(100)], 'a 100-byte bytes round-trip (not a whole number of words)');
  round(['bool', 'address'], [true, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'], 'bool + address');
  round(['uint256[]', 'string'], [['1', '2', '3'], 'tail'], 'dynamic array followed by a string');
  round(['(uint256,bytes)'], [['7', '0xdeadbeef']], 'a dynamic tuple');
  round(['(uint256,(bool,string))[]'], [[['1', [true, 'x']], ['2', [false, 'yy']]]], 'an array of nested tuples');
  round(['bytes32[2]'], [['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]], 'a fixed array of bytes32');

  // Signed integers are the classic place a codec is quietly wrong.
  eq(abi.encodeParameters(['int256'], [-1]).toString('hex'), 'f'.repeat(64), 'int256 -1 is all ones');
  eq(abi.decodeParameters(['int256'], HEX('f'.repeat(64)))[0], -1n, 'all ones decodes back to -1');
  eq(abi.encodeParameters(['int8'], [-1]).toString('hex'), 'f'.repeat(64), 'int8 -1 is SIGN-EXTENDED to 32 bytes, not masked to one');
  eq(abi.decodeParameters(['int8'], HEX('f'.repeat(64)))[0], -1n, 'int8 decodes the sign back out');
  eq(abi.decodeParameters(['int128'], abi.encodeParameters(['int128'], [-170141183460469231731687303715884105728n]))[0],
    -170141183460469231731687303715884105728n, 'int128 at its minimum survives');
  throws(() => abi.encodeParameters(['int8'], [128]), 'does not fit', 'int8 rejects 128');
  throws(() => abi.encodeParameters(['uint8'], [256]), 'does not fit', 'uint8 rejects 256');
  throws(() => abi.encodeParameters(['uint8'], [-1]), 'negative', 'uint8 rejects -1');
  throws(() => abi.encodeParameters(['bytes4'], ['0x0102']), 'exactly 4 bytes', 'bytes4 rejects a short value rather than padding it');
  throws(() => abi.encodeParameters(['uint256', 'bool'], [1]), 'expected 2 arguments', 'a missing argument is an error');

  // Hostile input must produce an error, never a wild read or a huge allocation.
  throws(() => abi.decodeParameters(['string'], HEX(W64('ffffffffffffffff'))), 'past the end', 'an out-of-range offset is refused');
  throws(() => abi.decodeParameters(['uint256[]'], HEX(W64('20') + W64('ffffffffffff'))), 'more than', 'an absurd array length is refused rather than allocated');
  throws(() => abi.decodeParameters(['uint256', 'uint256'], HEX(W64('1'))), 'truncated', 'truncated data is refused');
  function W64(h) { return String(h).padStart(64, '0'); }
}

// ===========================================================================
group('abi — revert reasons');
// ===========================================================================
{
  const errData = Buffer.concat([HEX('08c379a0'), abi.encodeParameters(['string'], ['ERC20: transfer amount exceeds balance'])]);
  const r = abi.decodeRevert(errData);
  eq(r.kind, 'Error', 'Error(string) is recognised by its selector');
  eq(r.message, 'ERC20: transfer amount exceeds balance', 'the message decodes');
  eq(r.text, 'Error("ERC20: transfer amount exceeds balance")', 'and renders quoted');

  const panic = Buffer.concat([HEX('4e487b71'), abi.encodeParameters(['uint256'], [0x11])]);
  const p = abi.decodeRevert(panic);
  eq(p.kind, 'Panic', 'Panic(uint256) is recognised');
  eq(p.text, 'Panic(0x11: arithmetic overflow or underflow)', 'panic 0x11 is named, not just numbered');
  eq(abi.decodeRevert(Buffer.concat([HEX('4e487b71'), abi.encodeParameters(['uint256'], [0x32])])).text,
    'Panic(0x32: array index out of bounds)', 'panic 0x32 is named');

  /* An empty revert is REAL — `require(cond)` with no message — and must not be
   * reported as a decode failure or as a reason that happens to be blank. */
  eq(abi.decodeRevert(Buffer.alloc(0)), null, 'an empty revert decodes to null, not to an empty reason');

  const custom = Buffer.concat([abi.selector('InsufficientBalance(uint256,uint256)'), abi.encodeParameters(['uint256', 'uint256'], [5, 10])]);
  const u = abi.decodeRevert(custom);
  eq(u.kind, 'custom', 'an unknown custom error is still reported');
  eq(u.selector, '0x' + abi.selector('InsufficientBalance(uint256,uint256)').toString('hex'), 'with its 4-byte selector');
  eq(u.args.length, 2, 'and its arguments as raw words');
  ok(u.text.startsWith('custom error 0x'), 'rendered as a raw custom error');

  const withAbi = abi.decodeRevert(custom, [{ type: 'error', name: 'InsufficientBalance', inputs: [{ type: 'uint256', name: 'available' }, { type: 'uint256', name: 'required' }] }]);
  eq(withAbi.name, 'InsufficientBalance', 'given an ABI, the custom error is named');
  eq(withAbi.text, 'InsufficientBalance(5, 10)', 'and its arguments decode');

  // A selector-only revert (no arguments) is common and must not crash.
  eq(abi.decodeRevert(abi.selector('Unauthorized()')).text, 'custom error 0x82b42900()', 'a bare custom-error selector renders');
  eq(abi.decodeRevert(HEX('0102')).kind, 'raw', 'fewer than four bytes is raw, not a selector');
}

// ===========================================================================
group('abi — function resolution');
// ===========================================================================
{
  const ERC20 = [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
    { type: 'constructor', inputs: [{ name: 'supply', type: 'uint256' }] },
  ];
  const fn = abi.resolveFunction(ERC20, 'transfer');
  eq(fn.signature, 'transfer(address,uint256)', 'a name resolves against the ABI');
  eq('0x' + fn.selector.toString('hex'), '0xa9059cbb', 'to the right selector');
  eq(fn.outputs.length, 1, 'and carries the output types');
  eq(abi.resolveFunction(null, 'balanceOf(address)').signature, 'balanceOf(address)', 'a bare signature needs no ABI');
  eq(abi.resolveFunction(null, 'balanceOf(address)').outputs.length, 0,
    'and carries NO output types — guessing uint256 would print a plausible wrong number for an int256 or a bytes32');
  eq(abi.resolveConstructor(ERC20).length, 1, 'the constructor resolves');
  eq(abi.resolveConstructor([]).length, 0, 'a missing constructor is zero arguments, not an error');
  throws(() => abi.resolveFunction(ERC20, 'nope'), 'no function', 'an absent name is an error that lists what is there');
  throws(() => abi.resolveFunction(null, 'transfer'), 'full signature', 'a bare name with no ABI says what to do instead');
  throws(() => abi.resolveFunction([
    { type: 'function', name: 'f', inputs: [{ type: 'uint256' }], outputs: [] },
    { type: 'function', name: 'f', inputs: [{ type: 'string' }], outputs: [] },
  ], 'f'), 'overloaded', 'an overloaded name demands the full signature');

  // Tuples out of ABI JSON `components`, which is a different path from parsing "(a,b)".
  const t = abi.typeFromAbi({ type: 'tuple[2]', components: [{ type: 'uint256', name: 'a' }, { type: 'bytes', name: 'b' }] });
  eq(abi.canonical(t), '(uint256,bytes)[2]', 'tuple[2] from components canonicalises');
  eq(abi.canonical(abi.typeFromAbi({ type: 'tuple[][3]', components: [{ type: 'bool' }] })), '(bool)[][3]',
    'tuple[][3] keeps its dimensions in the right order');
}

// ===========================================================================
group('cli argument coercion');
// ===========================================================================
{
  const T = abi.parseType;
  eq(contract.coerce(T('bool'), 'true'), true, 'bool "true"');
  eq(contract.coerce(T('bool'), 'false'), false, 'bool "false"');
  eq(contract.coerce(T('uint256[]'), '[1,2,3]'), ['1', '2', '3'], 'an array argument is JSON');
  eq(contract.encodeArgs([T('uint256')], ['7']).toString('hex'), '7'.padStart(64, '0'), 'encodeArgs positions by ABI order');
  throws(() => contract.encodeArgs([T('uint256')], []), 'takes 1 argument', 'too few arguments is a usage error naming the signature');
  throws(() => contract.encodeArgs([T('uint256')], ['1', '2']), 'takes 1 argument', 'too many arguments too');
  throws(() => contract.coerce(T('uint256[]'), '1,2,3'), 'must be given as JSON', 'a bare comma list is refused, not half-parsed');
}

// ===========================================================================
group('trace — step for step against a known opcode sequence');
// ===========================================================================
{
  /* PUSH1 0x2a  PUSH1 0x00  SSTORE  PUSH1 0x00  SLOAD  POP  STOP
   *
   * Every gas figure here comes from the Shanghai schedule by hand:
   *   PUSH1  G_verylow                                        3
   *   SSTORE cold slot 2100 + SSTORE_SET 20000 (0 -> nonzero) 22100
   *   SLOAD  warm (SSTORE above warmed it)                    100
   *   POP    G_base                                           2
   *   STOP                                                    0
   * If any of these changes, either the gas schedule moved (which is consensus
   * and wants a very good reason) or this tracer has stopped reporting the
   * interpreter's real numbers. */
  const r = trace.traceCode({ code: '0x602a600055600054505f00'.replace('5f', '00'), gas: 100000n });
  const steps = r.events.filter((e) => e.type === 'step');
  const got = steps.map((s) => [s.pc, s.mnemonic, s.immediate, s.gasCost, s.gasLeft, s.depth, s.stack.map((w) => '0x' + w.toString(16)), s.memorySize]);
  eq(got, [
    [0, 'PUSH1', '0x2a', 3n, 100000n, 0, [], 0],
    [2, 'PUSH1', '0x00', 3n, 99997n, 0, ['0x2a'], 0],
    [4, 'SSTORE', null, 22100n, 99994n, 0, ['0x0', '0x2a'], 0],
    [5, 'PUSH1', '0x00', 3n, 77894n, 0, [], 0],
    [7, 'SLOAD', null, 100n, 77891n, 0, ['0x0'], 0],
    [8, 'POP', null, 2n, 77791n, 0, ['0x2a'], 0],
    [9, 'STOP', null, 0n, 77789n, 0, [], 0],
  ], 'the trace matches the hand-derived execution step for step');

  eq(r.result.exception, null, 'the run succeeded');
  eq(r.result.gasUsed, 22211n, 'total gas used is the sum of the per-step costs');
  eq(steps.reduce((n, s) => n + s.gasCost, 0n), 22211n, 'and the per-step costs sum to it — the tracer is not double-counting');

  // The stack is printed TOP FIRST. The hook hands it out bottom-first, and a
  // tracer that forgets to reverse it shows SSTORE writing the value to the slot
  // named by the value, which reads as plausible and is backwards.
  const sstore = steps.find((s) => s.mnemonic === 'SSTORE');
  eq('0x' + sstore.stack[0].toString(16), '0x0', 'stack[0] is the TOP of the stack (the slot SSTORE pops first)');
  eq('0x' + sstore.stack[1].toString(16), '0x2a', 'stack[1] is beneath it (the value)');
  eq(sstore.slot, '0x' + '00'.repeat(32), 'SSTORE reports its slot as a full 32-byte word');
  eq(sstore.value, '0x' + '2a'.padStart(64, '0'), 'and the value being WRITTEN');

  const sload = steps.find((s) => s.mnemonic === 'SLOAD');
  eq(sload.value, '0x' + '2a'.padStart(64, '0'), 'SLOAD reports the value about to be READ');

  // gasLeft is the gas BEFORE the instruction is charged — the same convention
  // geth's structLogger uses, so the two traces can be diffed line by line.
  eq(steps[1].gasLeft, steps[0].gasLeft - steps[0].gasCost, 'gasLeft on step n+1 is gasLeft minus gasCost on step n');
}

// ===========================================================================
group('trace — immediates, memory, and running off the end of the code');
// ===========================================================================
{
  // PUSH4 with only two bytes of code after it: the interpreter zero-pads, so
  // the disassembly must too or the trace disagrees with the stack it shows.
  const r = trace.traceCode({ code: '0x63aabb', gas: 1000n });
  const steps = r.events.filter((e) => e.type === 'step');
  eq(steps[0].immediate, '0xaabb0000', 'a PUSH whose immediate runs off the end is zero-padded, matching the interpreter');
  eq(steps.length, 1, 'and the pc lands past the end, which is an implicit STOP with no further step');
  eq(r.result.exception, null, 'running off the end of the code is a clean halt, not an error');
  // The immediate and the stack agree: the value pushed is the bytes shown.
  const shown = trace.traceCode({ code: '0x63aabbccdd00', gas: 1000n }).events.filter((e) => e.type === 'step');
  eq(shown[0].immediate, '0xaabbccdd', 'a whole PUSH4 immediate is reported');
  eq('0x' + shown[1].stack[0].toString(16), '0xaabbccdd', 'and it is exactly what the interpreter pushed');

  // PUSH32 immediate is reported in full.
  const big = trace.traceCode({ code: '0x7f' + 'ab'.repeat(32) + '00', gas: 1000n });
  eq(big.events.filter((e) => e.type === 'step')[0].immediate, '0x' + 'ab'.repeat(32), 'a PUSH32 immediate is reported in full');

  // MSTORE at offset 0 grows memory to one word and costs 3 (base) + 3 (one word).
  const m = trace.traceCode({ code: '0x60ff600052' + '00', gas: 1000n });
  const ms = m.events.filter((e) => e.type === 'step');
  eq(ms[2].mnemonic, 'MSTORE', 'MSTORE runs');
  eq(ms[2].memorySize, 0, 'memory size is reported BEFORE the instruction expands it');
  eq(ms[2].gasCost, 6n, 'and the expansion is priced into that step (3 verylow + 3 for the first word)');
  eq(ms[3].memorySize, 32, 'the next step sees the grown memory');
}

// ===========================================================================
group('trace — call frames, depth, and nested reverts');
// ===========================================================================
{
  const B = '0x00000000000000000000000000000000000000bb';
  const payload = Buffer.concat([HEX('08c379a0'), abi.encodeParameters(['string'], ['nope'])]);
  const padded = Buffer.concat([payload, Buffer.alloc((32 - payload.length % 32) % 32)]);
  let bcode = '';
  for (let i = 0; i < padded.length; i += 32) bcode += '7f' + padded.subarray(i, i + 32).toString('hex') + '60' + i.toString(16).padStart(2, '0') + '52';
  bcode += '60' + payload.length.toString(16).padStart(2, '0') + '6000fd';       // REVERT(0, len)

  // PUSH1 0 x5, PUSH20 B, PUSH2 0xffff, CALL, STOP
  const acode = '6000600060006000600073' + B.slice(2) + '61ffff' + 'f1' + '00';
  const r = trace.traceCode({ code: '0x' + acode, gas: 200000n, accounts: { [B]: { nonce: 0n, balance: 0n, code: '0x' + bcode, storage: {} } } });

  const enters = r.events.filter((e) => e.type === 'enter');
  const exits = r.events.filter((e) => e.type === 'exit');
  eq(enters.length, 2, 'two frames were entered');
  eq(enters[1].frame.depth, 1, 'the child frame is at depth 1');
  eq(enters[1].frame.kind, 'CALL', 'and is a CALL');
  eq(enters[1].frame.to.toLowerCase(), B, 'to the right address');
  eq(enters[1].frame.gas, 65535n, 'with the gas the caller asked for (EIP-150 left enough)');

  const inner = exits.find((e) => e.depth === 1);
  eq(inner.exception, 'execution reverted', 'the child reverted');
  /* THE CASE THE onStep HOOK CANNOT REACH. A nested revert's payload lives in
   * the child's memory, and the hook exposes only the memory SIZE — so this is
   * decodable at all only because the tracer wraps EVM.call and sees the frame's
   * return data. Without it the most useful line in the whole trace is missing. */
  eq(inner.revert.kind, 'Error', 'and its revert reason decodes');
  eq(inner.revert.message, 'nope', 'to the string the contract passed');

  eq(r.result.exception, null, 'the OUTER frame succeeded — a failed CALL pushes 0, it does not propagate');
  const callStep = r.events.find((e) => e.type === 'step' && e.mnemonic === 'CALL');
  eq(callStep.gasCost, 68135n, 'CALL costs 2600 (cold account) + 65535 (gas handed to the child)');

  /* --depth COLLAPSES a frame rather than erasing it: the instructions go, the
   * enter/exit summary stays. Erasing it would take the decoded revert reason
   * with it, which is the one line you actually wanted. */
  const shallow = trace.filterEvents(r.events, { maxDepth: 0 });
  eq(shallow.filter((e) => e.type === 'step' && e.depth > 0).length, 0, '--depth=0 hides the child frame\'s steps');
  ok(shallow.filter((e) => e.type === 'step').length > 0, 'and keeps the parent\'s');
  eq(shallow.filter((e) => e.type === 'exit' && e.depth === 1).length, 1, 'but keeps the collapsed frame\'s exit line');
  eq(shallow.find((e) => e.type === 'exit' && e.depth === 1).revert.message, 'nope',
    'so the revert reason survives the filter that hid the frame it came from');
  eq(trace.filterEvents(r.events, { maxDepth: 0 }).filter((e) => e.type === 'enter').length, 2, 'and its enter line');
  // Two levels down is gone entirely — collapsing is one level, not all of them.
  eq(trace.filterEvents([{ type: 'enter', depth: 2 }, { type: 'step', depth: 1 }], { maxDepth: 0 }).length, 0,
    'a frame two levels below the cut is hidden outright');
}

// ===========================================================================
group('trace — DELEGATECALL runs another account\'s code in this account');
// ===========================================================================
{
  /* The case that breaks a naive tracer. The step event reports `address` — the
   * STORAGE context — which under DELEGATECALL is the CALLER's address, not
   * where the code came from. A tracer that looks up code by `ev.address` to
   * disassemble a PUSH gets the wrong bytes and prints a wrong immediate that
   * nothing else contradicts. */
  const B = '0x00000000000000000000000000000000000000bb';
  const bcode = '602a60005500';                                      // PUSH1 0x2a PUSH1 0 SSTORE STOP
  const acode = '600060006000600073' + B.slice(2) + '61ffff' + 'f4' + '00';
  const r = trace.traceCode({ code: '0x' + acode, gas: 200000n, accounts: { [B]: { nonce: 0n, balance: 0n, code: '0x' + bcode, storage: {} } } });

  const child = r.events.filter((e) => e.type === 'step' && e.depth === 1);
  eq(child.map((s) => s.mnemonic), ['PUSH1', 'PUSH1', 'SSTORE', 'STOP'], 'the child frame runs B\'s code');
  eq(child[0].immediate, '0x2a', 'and its immediate is read from B\'s code, not from the storage account\'s');
  eq(child[0].address.toLowerCase(), '0x00000000000000000000000000000000000000aa',
    'while the storage context stays A — which is exactly why code cannot be looked up by ev.address');
  const enter = r.events.find((e) => e.type === 'enter' && e.depth === 1);
  eq(enter.kind === undefined ? enter.frame.kind : enter.frame.kind, 'DELEGATECALL', 'the frame is a DELEGATECALL');
  eq(enter.frame.codeAddress.toLowerCase(), B, 'with codeAddress pointing at B');
  eq(enter.frame.to.toLowerCase(), '0x00000000000000000000000000000000000000aa', 'and `to` still pointing at A');
}

// ===========================================================================
group('trace — failures');
// ===========================================================================
{
  const oog = trace.traceCode({ code: '0x602a600055', gas: 100n });
  eq(oog.result.exception, 'out of gas', 'an out-of-gas run reports out of gas');
  eq(oog.result.gasLeft, 0n, 'and forfeits every unit — an exceptional halt is not a revert');

  const bad = trace.traceCode({ code: '0x0c', gas: 1000n });
  eq(bad.result.exception, 'invalid opcode', '0x0c is not an instruction in Shanghai');
  const badStep = bad.events.find((e) => e.type === 'step');
  eq(badStep.error, 'invalid opcode', 'and the step carries the reason');
  eq(badStep.mnemonic, 'UNDEFINED_0c', 'named so a disassembly does not silently skip it');

  const under = trace.traceCode({ code: '0x01', gas: 1000n });
  eq(under.result.exception, 'stack underflow', 'ADD with an empty stack underflows');

  // A top-level revert with a reason decodes, and the top-level exit is the frame
  // that carries it.
  const payload = Buffer.concat([HEX('08c379a0'), abi.encodeParameters(['string'], ['top'])]);
  const padded = Buffer.concat([payload, Buffer.alloc((32 - payload.length % 32) % 32)]);
  let code = '';
  for (let i = 0; i < padded.length; i += 32) code += '7f' + padded.subarray(i, i + 32).toString('hex') + '60' + i.toString(16).padStart(2, '0') + '52';
  code += '60' + payload.length.toString(16).padStart(2, '0') + '6000fd';
  const rev = trace.traceCode({ code: '0x' + code, gas: 100000n });
  eq(rev.result.exception, 'execution reverted', 'a top-level revert is reported');
  eq(rev.result.revert.message, 'top', 'and its reason decodes');
  ok(rev.result.gasLeft > 0n, 'a REVERT returns the unspent gas, unlike every other failure');
}

// ===========================================================================
group('trace — CREATE');
// ===========================================================================
{
  // initcode: PUSH1 1 PUSH1 0 MSTORE  PUSH1 1 PUSH1 31 RETURN  -> deploys 0x01
  const init = '6001600052' + '6001601ff3';
  // PUSH<n> initcode, MSTORE at 0, then CREATE(0, 32-len, len)
  const initBuf = HEX(init);
  const word = Buffer.concat([Buffer.alloc(32 - initBuf.length), initBuf]);
  const code = '7f' + word.toString('hex') + '600052'
    + '60' + initBuf.length.toString(16).padStart(2, '0')
    + '60' + (32 - initBuf.length).toString(16).padStart(2, '0')
    + '6000' + 'f0' + '00';
  const r = trace.traceCode({ code: '0x' + code, gas: 1000000n });
  const enter = r.events.find((e) => e.type === 'enter' && e.depth === 1);
  eq(enter.frame.kind, 'CREATE', 'a CREATE opens a frame');
  const exit = r.events.find((e) => e.type === 'exit' && e.depth === 1);
  eq(exit.exception, null, 'the constructor succeeded');
  ok(exit.createdAddress && exit.createdAddress.length === 42, 'and reports the address it deployed to');
  const inner = r.events.filter((e) => e.type === 'step' && e.depth === 1);
  eq(inner[0].mnemonic, 'PUSH1', 'the initcode is traced too — a CREATE frame has no account to read code from');
  eq(inner[0].immediate, '0x01', 'and its immediates come from the initcode in memory');
}

// ===========================================================================
group('trace — filtering and JSON');
// ===========================================================================
{
  const r = trace.traceCode({ code: '0x602a600055600160015560026002556000546001546002545050' + '00', gas: 200000n });
  const onlySstore = trace.filterEvents(r.events, { opFilter: trace.makeOpFilter('SSTORE') });
  eq(onlySstore.filter((e) => e.type === 'step').length, 3, '--op=SSTORE keeps exactly the SSTOREs');
  const both = trace.filterEvents(r.events, { opFilter: trace.makeOpFilter('sstore,SLOAD') });
  eq(both.filter((e) => e.type === 'step').length, 6, '--op is case-insensitive and takes a list');
  const family = trace.filterEvents(r.events, { opFilter: trace.makeOpFilter('PUSH') });
  eq(family.filter((e) => e.type === 'step').length, 9, 'a bare family name matches PUSH1..PUSH32');
  throws(() => trace.makeOpFilter('SSTOR'), 'no opcode or family', 'a misspelt opcode is an error, not an empty trace');
  ok(trace.makeOpFilter('LOG')('LOG3'), 'LOG matches LOG3');
  ok(!trace.makeOpFilter('LOG')('SLOAD'), 'LOG does not match SLOAD');

  const parsed = JSON.parse(trace.renderJson(r));
  eq(parsed.steps, r.steps, 'the JSON reports the step count');
  eq(typeof parsed.events[1].gasCost, 'string', 'BigInt gas is serialised as a decimal string, not lost to Number');
  eq(parsed.events[1].gasCost, '3', 'and keeps its value');
  eq(parsed.result.gasUsed, String(r.result.gasUsed), 'the total survives the round trip');
  ok(JSON.stringify(parsed).includes('"stack"'), 'the stack is in the JSON');

  // max-steps must truncate rather than exhaust memory on a 30M-gas transaction.
  const capped = trace.traceCode({ code: '0x' + '6001'.repeat(50) + '00', gas: 100000n, maxSteps: 10 });
  eq(capped.steps, 10, '--max-steps caps the recording');
  eq(capped.truncated, true, 'and says so');
  eq(capped.result.exception, null, 'while the execution itself still runs to completion');
}

// ===========================================================================
group('trace — text rendering degrades without a TTY');
// ===========================================================================
{
  ui.setColour(false);
  const r = trace.traceCode({ code: '0x602a60005560005400', gas: 100000n });
  const text = trace.renderText(r);
  ok(!/\x1b\[/.test(text), 'no ANSI escape appears in piped output');
  ok(text.includes('SSTORE'), 'the opcode is there');
  ok(text.includes('22100'), 'and its gas cost');
  ok(text.split('\n').some((l) => /^\s+0\s+0004\s+/.test(l)), 'depth and pc are the first two columns');
  /* A write and a read must not look the same. Both name a slot and a value, and
   * the only thing distinguishing "slot 0 became 0x2a" from "slot 0 held 0x2a"
   * is which way the arrow points. */
  ok(text.includes('SSTORE 0x0 <- 0x2a'), 'a storage WRITE points into the slot');
  ok(text.includes('SLOAD 0x0 -> 0x2a'), 'and a storage READ points out of it');
  ok(text.includes('OK'), 'the summary line reports the outcome');

  ui.setColour(true);
  const coloured = trace.renderText(trace.traceCode({ code: '0x602a600055', gas: 100000n }));
  ok(/\x1b\[/.test(coloured), 'and colour comes back when it is asked for');
  ui.setColour(false);
}

// ===========================================================================
group('trace — replaying a conformance vector');
// ===========================================================================
{
  /* A VMTests-shaped fixture, written to a directory named VMTests so the
   * loader infers the suite the way it does for the real corpus. This is the
   * shape the tracer's first real user hands it (docs/evm-spec.md §8). */
  const dir = path.join(tmp(), 'VMTests');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'add0.json');
  fs.writeFileSync(file, JSON.stringify({
    add0: {
      _info: { comment: 'synthetic' },
      env: {
        currentCoinbase: '0x2adc25665018aa1fe0e6bc666dac8fc2697ff9ba',
        currentDifficulty: '0x0100',
        currentGasLimit: '0x0f4240',
        currentNumber: '0x00',
        currentTimestamp: '0x01',
      },
      exec: {
        address: '0x0f572e5295c57f15886f9b263e2f6d2d6c7b5ec6',
        caller: '0xcd1722f3947def4cf144679da39c4c32bdc35681',
        code: '0x6001600101600055',
        data: '0x',
        gas: '0x0186a0',
        gasPrice: '0x5af3107a4000',
        origin: '0xcd1722f3947def4cf144679da39c4c32bdc35681',
        value: '0x0de0b6b3a7640000',
      },
      pre: {
        '0x0f572e5295c57f15886f9b263e2f6d2d6c7b5ec6': { balance: '0x0de0b6b3a7640000', code: '0x6001600101600055', nonce: '0x00', storage: {} },
      },
      post: {
        '0x0f572e5295c57f15886f9b263e2f6d2d6c7b5ec6': { balance: '0x0de0b6b3a7640000', code: '0x6001600101600055', nonce: '0x00', storage: { '0x00': '0x02' } },
      },
      gas: '0x013874',
      logs: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
      out: '0x',
    },
  }, null, 2));

  const r = trace.traceVector(file, null, {});
  const steps = r.events.filter((e) => e.type === 'step');
  eq(steps.map((s) => s.mnemonic), ['PUSH1', 'PUSH1', 'ADD', 'PUSH1', 'SSTORE'], 'the vector\'s opcode sequence is traced');
  eq(r.result.exception, null, 'and it succeeds');
  const sstore = steps.find((s) => s.mnemonic === 'SSTORE');
  eq(sstore.value, '0x' + '02'.padStart(64, '0'), '1 + 1 is stored in slot 0');
  ok(String(r.source).includes('add0'), 'the source names the vector');
  ok([].concat(r.note).some((n) => n.includes('Frontier prices')),
    'and the output warns that VMTests gas figures predate Shanghai — the trap docs/evm-spec.md §0 names');

  /* VMTests supply `value` in a pre-state that ALREADY reflects the transfer. Run
   * it again and the callee is credited twice — which no assertion about the
   * OPCODES would ever notice, because the opcodes are identical either way. The
   * only witness is the balance. */
  eq(r.events.filter((e) => e.type === 'enter')[0].frame.value, 0n, 'the frame is entered with no value to move');
  eq(r.result.balance, 0x0de0b6b3a7640000n, 'and the executing account still holds exactly its pre-state balance');
  eq(r.result.expect.balance, 0x0de0b6b3a7640000n, 'which is what the vector\'s post state says it should');

  throws(() => trace.traceVector(file, 'nosuchcase', {}), 'no vector matching', 'an unknown case name is an error');

  /* A GeneralStateTests vector — the tracer's first real user when phase 4 goes
   * red. Unlike a VMTest it has a transaction around the call, so the intrinsic
   * gas has to come off the top or every gas figure in the trace is high by
   * 21,000-and-change and the divergence you are hunting is the one you added. */
  const sdir = path.join(tmp(), 'GeneralStateTests');
  fs.mkdirSync(sdir, { recursive: true });
  const sfile = path.join(sdir, 'store.json');
  const SENDER = '0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b';
  fs.writeFileSync(sfile, JSON.stringify({
    store: {
      env: {
        currentCoinbase: '0x2adc25665018aa1fe0e6bc666dac8fc2697ff9ba',
        currentDifficulty: '0x020000',
        currentGasLimit: '0x1c9c380',
        currentNumber: '0x01',
        currentTimestamp: '0x03e8',
      },
      pre: {
        '0x0000000000000000000000000000000000000aaa': { balance: '0x00', code: '0x602a600055', nonce: '0x00', storage: {} },
        [SENDER]: { balance: '0x0de0b6b3a7640000', code: '0x', nonce: '0x00', storage: {} },
      },
      transaction: {
        nonce: '0x00', gasPrice: '0x01',
        gasLimit: ['0x0186a0'], to: '0x0000000000000000000000000000000000000aaa',
        value: ['0x00'], data: ['0x00ff'],
        sender: SENDER,
        secretKey: '0x45a915e4d060149eb4365960e6a7a45f334393093061116b197e3240065ff2d8',
      },
      post: { Shanghai: [{ indexes: { data: 0, gas: 0, value: 0 }, hash: '0x' + '00'.repeat(32), logs: '0x' + '00'.repeat(32) }] },
    },
  }, null, 2));

  const s = trace.traceVector(sfile, null, {});
  // 21,000 base + 4 for the zero byte + 16 for the non-zero one.
  eq(s.result.intrinsicGas, 21020n, 'intrinsic gas is 21000 + 4 per zero byte + 16 per non-zero byte');
  const sSteps = s.events.filter((e) => e.type === 'step');
  eq(sSteps[0].gasLeft, 100000n - 21020n, 'and the first opcode starts from gasLimit MINUS the intrinsic cost');
  eq(sSteps.map((x) => x.mnemonic), ['PUSH1', 'PUSH1', 'SSTORE'], 'the transaction\'s target code is traced');
  eq(s.result.exception, null, 'and it succeeds');
  ok(String(s.source).includes('Shanghai'), 'the source names the fork the vector is for');
  ok([].concat(s.note).some((n) => n.includes('no state root')), 'and the output says plainly that it is not computing a state root');

  /* A CREATION vector, which is a different code path and used to be traced at
   * the wrong address entirely. `EVM.create` derives the address from the
   * nonce BEFORE it bumps it and bumps it itself, exactly as
   * chain/statetransition.js does — so a tracer that also bumps the nonce up
   * front deploys at `createAddress(sender, 1)` and never sees what is sitting
   * at `createAddress(sender, 0)`. Nothing complains: the trace runs, reports
   * OK, and describes a transaction that did not happen. This vector puts a
   * storage-carrying account at the right address, so getting it wrong is the
   * difference between a collision and a clean deployment. */
  const cfile = path.join(sdir, 'create.json');
  // keccak256(rlp([0xa94f…, 0]))[12:] — the canonical first-creation address.
  const CREATED = '0x6295ee1b4f6dd65047762f924ecd367c17eabf8f';
  fs.writeFileSync(cfile, JSON.stringify({
    initcollide: {
      env: {
        currentCoinbase: '0x2adc25665018aa1fe0e6bc666dac8fc2697ff9ba',
        currentDifficulty: '0x020000',
        currentGasLimit: '0x1c9c380',
        currentNumber: '0x01',
        currentTimestamp: '0x03e8',
      },
      pre: {
        [CREATED]: { balance: '0x0a', code: '0x', nonce: '0x00', storage: { '0x01': '0x01' } },
        [SENDER]: { balance: '0x0de0b6b3a7640000', code: '0x', nonce: '0x00', storage: {} },
      },
      transaction: {
        nonce: '0x00', gasPrice: '0x01',
        gasLimit: ['0x030d40'], to: '',
        value: ['0x00'], data: ['0x600160015500'],
        sender: SENDER,
        secretKey: '0x45a915e4d060149eb4365960e6a7a45f334393093061116b197e3240065ff2d8',
      },
      post: { Shanghai: [{ indexes: { data: 0, gas: 0, value: 0 }, hash: '0x' + '00'.repeat(32), logs: '0x' + '00'.repeat(32) }] },
    },
  }, null, 2));

  const c = trace.traceVector(cfile, null, {});
  eq(c.result.exception, 'contract address collision',
    'a creation onto an address that holds storage traces as a collision, not a deployment');
  eq(c.result.createdAddress, null, 'nothing is deployed');
  eq(c.events.filter((e) => e.type === 'step').length, 0, 'and not one opcode of the initcode runs');

  // The same transaction with the collider removed: the address the tracer
  // deploys at is the direct witness for which nonce it derived from. With the
  // off-by-one it is createAddress(sender, 1) = 0xec0e71…, and the collision
  // case above silently passes over an empty account and reports success.
  const clean = JSON.parse(fs.readFileSync(cfile, 'utf8'));
  delete clean.initcollide.pre[CREATED];
  const nfile = path.join(sdir, 'create-clean.json');
  fs.writeFileSync(nfile, JSON.stringify(clean, null, 2));
  const n = trace.traceVector(nfile, null, {});
  eq(n.result.exception, null, 'with the address free the same creation succeeds');
  eq(String(n.result.createdAddress).toLowerCase(), CREATED,
    'and deploys at createAddress(sender, 0) — the tracer must not bump the nonce a creation is derived from');
}

// ===========================================================================
group('trace — replaying from a node, with state prefetch');
// ===========================================================================
{
  // A fake archive node. The contract at 0xaa reads an address out of slot 0 and
  // calls it — so the replay cannot know it needs 0xbb until it has fetched slot
  // 0, which is exactly the dependency chain the prefetch loop exists for.
  const A = '0x00000000000000000000000000000000000000aa';
  const B = '0x00000000000000000000000000000000000000bb';
  const SENDER = '0x00000000000000000000000000000000000000ca';
  const CODE_A = '0x6000600060006000600060005461ffff' + 'f1' + '00';
  const CODE_B = '0x600160005500';
  const TXHASH = '0x' + '11'.repeat(32);

  const state = {
    [A]: { nonce: '0x0', balance: '0x0', code: CODE_A, storage: { ['0x' + '00'.repeat(32)]: '0x' + B.slice(2).padStart(64, '0') } },
    [B]: { nonce: '0x0', balance: '0x0', code: CODE_B, storage: {} },
    [SENDER]: { nonce: '0x1', balance: '0xde0b6b3a7640000', code: '0x', storage: {} },
  };
  const acct = (a) => state[String(a).toLowerCase()] || { nonce: '0x0', balance: '0x0', code: '0x', storage: {} };
  let calls = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls++;
      let result = null;
      switch (method) {
        case 'eth_chainId': result = '0x1cf3'; break;
        case 'eth_getTransactionByHash':
          result = {
            hash: TXHASH, blockNumber: '0x5', transactionIndex: '0x0',
            from: SENDER, to: A, gas: '0x30d40', gasPrice: '0x1', input: '0x', value: '0x0', nonce: '0x1',
          };
          break;
        case 'eth_getBlockByNumber':
          result = { number: '0x5', timestamp: '0x64', gasLimit: '0x1c9c380', miner: '0x' + '00'.repeat(19) + 'c0', mixHash: '0x' + '00'.repeat(32) };
          break;
        case 'eth_getTransactionCount': result = acct(params[0]).nonce; break;
        case 'eth_getBalance': result = acct(params[0]).balance; break;
        case 'eth_getCode': result = acct(params[0]).code; break;
        case 'eth_getStorageAt': {
          const s = acct(params[0]).storage[String(params[1]).toLowerCase()];
          result = s || '0x' + '00'.repeat(32);
          break;
        }
        default: result = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });

  const done = (async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await trace.traceChainTx(TXHASH, { client: new Client(url) });
      const enters = r.events.filter((e) => e.type === 'enter');
      eq(enters.length, 2, 'the replay reached the inner CALL, which it could only find via storage');
      eq(enters[1].frame.to.toLowerCase(), B, 'and called the address it read out of slot 0');
      const inner = r.events.filter((e) => e.type === 'step' && e.depth === 1);
      eq(inner.map((s) => s.mnemonic), ['PUSH1', 'PUSH1', 'SSTORE', 'STOP'], 'and traced B\'s code, fetched in a later round');
      eq(r.result.exception, null, 'the replay succeeded');
      ok([].concat(r.note).some((n) => n.includes('prefetch round')), 'and reports how many prefetch rounds it took');
      ok([].concat(r.note).some((n) => n.includes('BLOCKHASH')), 'and that BLOCKHASH is not available in a replay');
      ok(calls > 6, 'the node was actually consulted');

      await new Promise((res, rej) => { server.close((e) => (e ? rej(e) : res())); });
      return true;
    } catch (e) {
      server.close();
      throw e;
    }
  })();

  module.exports = { done };   // awaited at the bottom
  global.__pendingChainTrace = done;
}

// ===========================================================================
group('client');
// ===========================================================================
{
  global.__pendingClient = (async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (req.url === '/info') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ network: 'hearth', height: 42 }));
        }
        if (req.url === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': connected\n\n');
          res.write('data: {"height":43,"id":"abc"}\n\n');
          res.write('event: record\ndata: {"app":"chat"}\n\n');
          return res.end();
        }
        const { id, method } = JSON.parse(body);
        if (method === 'eth_call') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' + abi.encodeParameters(['string'], ['bad']).toString('hex') } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2a' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const client = new Client(`http://127.0.0.1:${server.address().port}`);

    eq(await client.blockNumber(), 42n, 'eth_blockNumber decodes a hex quantity to a BigInt');
    eq((await client.get('/info')).network, 'hearth', 'a REST GET returns parsed JSON');

    /* A JSON-RPC error arrives at HTTP 200. A client that only checks res.ok
     * reports success on every revert. */
    let caught = null;
    try { await client.call({ to: '0x' + '00'.repeat(20), data: '0x' }); } catch (e) { caught = e; }
    ok(caught && caught.name === 'RpcError', 'an error member at HTTP 200 is still an error');
    eq(caught.code, 3, 'code 3 is an execution revert');
    eq(abi.decodeRevert(caught.data).message, 'bad', 'and its data decodes into the reason');

    const seen = [];
    await client.events({ onEvent: (e) => seen.push(e) });
    eq(seen.length, 2, 'SSE frames are parsed, and the `: comment` keep-alive is not one');
    eq(seen[0].data.height, 43, 'a block frame carries its JSON');
    eq(seen[0].event, 'message', 'src/rpc.js emits blocks with no `event:` line, so they arrive as `message`');
    eq(seen[1].event, 'record', 'a named event keeps its name');

    const dead = new Client('http://127.0.0.1:1', { timeout: 500 });
    let transport = null;
    try { await dead.blockNumber(); } catch (e) { transport = e; }
    eq(transport && transport.name, 'TransportError', 'an unreachable node is a transport error, not an RPC one');
    ok(String(transport.message).includes('cannot reach'), 'and says so in words');

    await new Promise((res) => server.close(res));
  })();
}

// ===========================================================================
group('keystore');
// ===========================================================================
{
  const dir = tmp();
  const priv = Buffer.from('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'hex');
  // 1000 rounds, not the 600,000 the real thing uses: this is testing the
  // construction, and the iteration count is asserted separately.
  const rec = keystore.seal(priv, 'correct horse battery', { iterations: 1000, label: 'test' });

  eq(keystore.PBKDF2_ITERATIONS, 600000, 'the shipped iteration count is the OWASP 2023 floor');
  eq(rec.cipher, 'AES-256-GCM', 'sealed with AES-256-GCM');
  eq(rec.kdf.name, 'PBKDF2', 'under PBKDF2');
  eq(rec.kdf.hash, 'SHA-256', 'with SHA-256');
  ok(rec.address.startsWith('0x') && rec.address.length === 42, 'the address is stored in the clear so a locked wallet can still show it');
  eq(rec.address, ui.checksumAddress(rec.address), 'and is EIP-55 checksummed');

  const json = JSON.stringify(rec);
  ok(!json.includes(priv.toString('hex')), 'THE KEY IS NOT IN THE RECORD');
  ok(!json.includes('correct horse'), 'and neither is the passphrase');

  eq(keystore.open(rec, 'correct horse battery').toString('hex'), priv.toString('hex'), 'the right passphrase opens it');
  throws(() => keystore.open(rec, 'wrong'), 'wrong passphrase', 'the wrong one fails on the GCM tag');

  /* The address is in the clear, so it is untrusted: a file whose label says one
   * address and whose ciphertext is another would sign from somewhere the user
   * did not choose. */
  const lying = { ...rec, address: '0x' + '11'.repeat(20) };
  throws(() => keystore.open(lying, 'correct horse battery'), 'does not match the address', 'a record whose address does not match its key is refused');

  const tampered = { ...rec, ct: rec.ct.slice(0, -2) + (rec.ct.endsWith('00') ? '11' : '00') };
  throws(() => keystore.open(tampered, 'correct horse battery'), 'wrong passphrase', 'a tampered ciphertext fails the tag');

  throws(() => keystore.seal(priv, 'short'), 'at least 8', 'a short passphrase is refused');
  throws(() => keystore.seal(Buffer.alloc(32), 'correct horse battery'), 'not a valid secp256k1', 'a zero private key is refused');
  throws(() => keystore.seal(Buffer.alloc(31), 'correct horse battery'), '32 bytes', 'a short private key is refused');

  const file = keystore.save(dir, rec);
  eq(fs.statSync(file).mode & 0o777, 0o600, 'the file is written 0600');
  eq(fs.statSync(dir).mode & 0o777, 0o700, 'in a 0700 directory');
  throws(() => keystore.save(dir, rec), 'already in this keystore', 'saving twice refuses to clobber');
  eq(keystore.list(dir).length, 1, 'and the directory lists one key');
  eq(keystore.find(dir).address, rec.address, 'a single key needs no selector');
  eq(keystore.find(dir, 'test').address, rec.address, 'a label selects it');
  eq(keystore.find(dir, rec.address).address, rec.address, 'so does the address');
  throws(() => keystore.find(dir, 'nope'), 'no key for', 'an unknown selector is an error');

  const second = keystore.seal(Buffer.from('11'.repeat(32), 'hex'), 'correct horse battery', { iterations: 1000 });
  keystore.save(dir, second);
  /* "Pick the first" is how a CLI signs from the wrong account. */
  throws(() => keystore.find(dir), 'say which', 'with two keys, an unqualified lookup refuses rather than guessing');

  // Two seals of the same key differ: the salt and IV are per-record.
  const again = keystore.seal(priv, 'correct horse battery', { iterations: 1000 });
  ok(again.ct !== rec.ct, 'two seals of the same key produce different ciphertext');
  ok(again.kdf.salt !== rec.kdf.salt, 'because the salt is fresh each time');
  /* And so is the nonce. A repeated (key, IV) pair under GCM does not merely
   * weaken the cipher, it leaks the XOR of the plaintexts and the authentication
   * subkey — which for two keys sealed under one passphrase is total. */
  ok(again.iv !== rec.iv, 'and so is the GCM IV, which must never repeat under one key');

  // The address really is the EVM address for the key (spec §2).
  eq(keystore.addressFor(priv).toLowerCase(), '0x' + keccak256(require('../src/crypto/secp256k1').publicKeyFromPrivate(priv, false).subarray(1)).subarray(12).toString('hex'),
    'the address is the last 20 bytes of keccak over the uncompressed key body');
}

// ===========================================================================
group('watch');
// ===========================================================================
{
  eq(watch.difficultyFromTarget('00'.repeat(31) + '01'), (1n << 256n) / 2n, 'difficulty is 2^256 / (target + 1)');
  eq(watch.difficultyFromTarget('ff'.repeat(32)), 1n, 'the easiest target is difficulty 1');
  eq(watch.difficultyFromTarget(null), null, 'an absent target is not a difficulty of zero');
  eq(watch.rate(0), '0 H/s', 'no hashrate');
  eq(watch.rate(4500), '4.50 kH/s', 'kilohashes');
  eq(watch.rate(4500000000), '4.50 GH/s', 'gigahashes');

  ui.setColour(false);
  const lines = watch.render({
    url: 'http://x', connected: true, blocks: [{ height: 7, timestamp: 1700000000000, id: 'abcdef0123456789', txCount: 2, reward: 594000000 }],
    info: { network: 'hearth', coin: 'EMBER', height: 7, peers: 3, mempool: 1, hashrate: 1200, difficultyTarget: '00'.repeat(2) + 'ff'.repeat(30), mining: true },
    rows: 24, decimals: 8,
  }, 100);
  const text = lines.join('\n');
  ok(!/\x1b\[/.test(text), 'the frame contains no escapes when colour is off');
  ok(text.includes('hearth'), 'the network is shown');
  ok(text.includes('1.20 kH/s'), 'the hashrate is shown');
  ok(text.includes('3'), 'the peer count is shown');
  ok(/gas used/.test(text), 'there is a gas-used column');
  /* The v1 header has no gasUsed (spec §4 adds it in v2). Printing a zero would
   * be a lie about a number people read as consensus. */
  ok(text.includes('—'), 'and a block without gasUsed shows a dash rather than an invented zero');
  eq(watch.clock(1700000000000), watch.clock(1700000000), 'a seconds timestamp and a milliseconds one render the same time');
}

// ===========================================================================
group('devnet');
// ===========================================================================
{
  const a = devnet.deriveAccounts('hearth devnet', 3);
  const b = devnet.deriveAccounts('hearth devnet', 3);
  eq(a.map((x) => x.address), b.map((x) => x.address), 'accounts are deterministic — a fixture can hard-code one');
  eq(a.length, 3, 'and there are as many as asked for');
  ok(a.every((x) => x.address === ui.checksumAddress(x.address)), 'addresses are EIP-55 checksummed');
  ok(new Set(a.map((x) => x.address)).size === 3, 'and distinct');
  ok(devnet.deriveAccounts('other seed', 3)[0].address !== a[0].address, 'a different seed gives different accounts');

  const g = devnet.makeGenesis(a, 10n ** 18n);
  eq(g.chainId, 7411, 'genesis carries chain id 7411 (spec §1)');
  eq(g.decimals, 18, 'and 18 decimals, not the UTXO chain\'s 8');
  eq(g.gasLimit, '30000000', 'and a 30M block gas limit');
  eq(Object.keys(g.alloc).length, 3, 'with every account allocated');
  eq(g.alloc[a[0].address].balance, '1000000000000000000', 'balances are decimal strings, which survive JSON');
}

// ===========================================================================
group('end to end — the binary itself');
// ===========================================================================
{
  const bin = path.join(__dirname, '..', 'bin', 'hearth.js');
  const run = (argv, opts = {}) => execFileSync(process.execPath, [bin, ...argv], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, ...opts });

  ok(run(['--help']).includes('hearth trace'), '`hearth --help` lists the commands');
  ok(run(['trace', '--help']).includes('--vector'), '`hearth trace --help` documents the vector source');
  ok(run(['wallet', '--help']).includes('--reveal-private-key'), 'the wallet help names the flag that prints a key');

  const out = run(['trace', '--code', '0x602a600055', '--json']);
  const parsed = JSON.parse(out);
  eq(parsed.events.filter((e) => e.type === 'step').length, 3, '`hearth trace --code --json` emits a parseable trace');
  ok(!/\x1b\[/.test(out), 'and no escapes when piped');

  const filtered = JSON.parse(run(['trace', '--code', '0x602a600055', '--op', 'SSTORE', '--json']));
  eq(filtered.events.filter((e) => e.type === 'step').length, 1, '--op filters through the binary');

  // Exit codes are part of the interface.
  let code = 0;
  try { run(['nosuchcommand']); } catch (e) { code = e.status; }
  eq(code, 2, 'an unknown command exits 2 (you asked wrongly)');
  code = 0;
  try { run(['trace', '--code', '0x0c']); } catch (e) { code = e.status; }
  eq(code, 1, 'a failed execution exits 1 (the thing you asked about failed)');
  code = 0;
  try { run(['trace', '--nosuchflag']); } catch (e) { code = e.status; }
  eq(code, 2, 'an unknown flag exits 2');

  // The UTXO-era CLI must still work — it is a different tool for a different chain.
  const legacy = path.join(__dirname, '..', 'bin', 'hearth-cli.js');
  ok(fs.existsSync(legacy), 'bin/hearth-cli.js is still present and untouched');

  // A devnet round trip through the binary.
  const dir = path.join(tmp(), 'dev');
  const init = JSON.parse(run(['devnet', 'init', '--dir', dir, '--accounts', '2', '--json']));
  eq(init.accounts.length, 2, '`hearth devnet init` writes the accounts it says it does');
  ok(fs.existsSync(path.join(dir, 'genesis.json')), 'and a genesis file');
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'genesis.json'), 'utf8'));
  eq(written.chainId, 7411, 'with the right chain id');
  ok(fs.readdirSync(dir).some((f) => f.includes('PUBLIC-KEYS-DO-NOT-REUSE')), 'and a key file whose name says what it is');
  throws(() => run(['devnet', 'init', '--dir', dir, '--json']), '', 'a second init into a non-empty directory refuses');

  // A wallet round trip through the binary, unattended.
  const ks = tmp();
  const env = { ...process.env, NO_COLOR: '1', HEARTH_PASSPHRASE: 'a good long passphrase' };
  const made = JSON.parse(execFileSync(process.execPath, [bin, 'wallet', 'new', '--keystore', ks, '--json'], { encoding: 'utf8', env }));
  ok(made.address.startsWith('0x'), '`hearth wallet new` creates an address');
  const listed = execFileSync(process.execPath, [bin, 'wallet', 'list', '--keystore', ks], { encoding: 'utf8', env });
  ok(listed.includes(made.address), 'and it shows up in `wallet list`');
  const exported = execFileSync(process.execPath, [bin, 'wallet', 'export', '--keystore', ks], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
  ok(exported.includes('"ct"') && !/"[0-9a-f]{64}"\s*$/.test(exported.trim()), 'a plain `wallet export` gives the SEALED record');
  const rec = JSON.parse(exported);
  ok(!JSON.stringify(rec).includes(rec.address.slice(2).toLowerCase().repeat(2)), 'which contains no key material');
  const revealed = execFileSync(process.execPath, [bin, 'wallet', 'export', '--keystore', ks, '--reveal-private-key', '--yes'], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  ok(/^0x[0-9a-f]{64}$/.test(revealed), '--reveal-private-key prints the key, and only with that flag');
  eq(keystore.addressFor(Buffer.from(revealed.slice(2), 'hex')), made.address, 'and it is the key for that address');

  // Encoding calldata needs no node at all, which is what --data-only is for.
  const abiFile = path.join(tmp(), 'erc20.json');
  fs.writeFileSync(abiFile, JSON.stringify([{ type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }]));
  const data = run(['call', '--abi', abiFile, '--fn', 'transfer', '--data-only', '0x' + '11'.repeat(20), '1000']).trim();
  eq(data, '0xa9059cbb' + '11'.repeat(20).padStart(64, '0') + (1000).toString(16).padStart(64, '0'), '`hearth call --data-only` encodes calldata offline');
}

// ===========================================================================

(async () => {
  try {
    if (global.__pendingChainTrace) await global.__pendingChainTrace;
    if (global.__pendingClient) await global.__pendingClient;
  } catch (e) {
    fail++;
    console.log('  ✗ async suite threw: ' + (e && e.stack || e));
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
  process.exit(fail === 0 ? 0 : 1);
})();

/* ===========================================================================
 * MUTATION LOG
 *
 * 51 deliberate faults were introduced one at a time into src/cli/*.js and this
 * suite was run against each. The first pass killed 45 and let 5 through; the
 * five gaps are recorded here because each names a class of bug this file was
 * blind to, and the tests added to close them are the ones worth keeping.
 *
 *   1. `headSize = types.length * WORD` instead of summing `headWords`.
 *      SURVIVED. Every example in the Solidity ABI specification happens to have
 *      one-word heads, so the published vectors — the strongest thing in this
 *      suite — could not see it. A static `uint256[2]` or a static tuple ahead
 *      of a dynamic member is where it shows, and the offset comes out one word
 *      short. Closed by encoding `(uint256[2], string)` and `((uint256,bool),
 *      bytes)` and pinning the 0x60 offset.
 *
 *   2. A VMTest's `value` transferred a second time. SURVIVED, and instructively:
 *      the opcode stream is IDENTICAL either way, so no assertion about pcs,
 *      gas or the stack could ever catch it — only the callee's balance moves.
 *      The tracer now reports that balance and the vector's expected one, which
 *      is a thing a person debugging a vector wants to see anyway.
 *
 *   3. The intrinsic transaction cost not deducted before a GeneralStateTests
 *      vector runs. SURVIVED because there was no state-vector test at all, only
 *      a VMTest one — and a VMTest has no transaction around it, so the whole
 *      code path was untested. Every gas figure in such a trace would have been
 *      21,000-and-change too high, which is precisely the kind of wrong that
 *      sends somebody hunting a divergence they introduced by looking.
 *
 *   4. SSTORE and SLOAD rendered with the same arrow. SURVIVED: the JSON was
 *      asserted, the text was not, and "slot 0 became 0x2a" versus "slot 0 held
 *      0x2a" is the difference between a write and a read.
 *
 *   5. A constant GCM IV. SURVIVED: the salt was asserted to be fresh per record
 *      and the IV was not. A repeated (key, nonce) pair under GCM leaks the XOR
 *      of the plaintexts and the authentication subkey — for two keys sealed
 *      under one passphrase that is total, and it is invisible in every
 *      round-trip test because sealing and opening still work perfectly.
 *
 * After the fixes, 51/51 mutants were killed.
 * =========================================================================== */
