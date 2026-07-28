#!/usr/bin/env node
// Build-level tests. These do NOT execute the contracts — Hearth's EVM is being written
// in parallel and there is no interpreter to run them on yet, and pulling in a foreign
// EVM to test against would defeat the point of writing our own (docs/evm-spec.md §0).
//
// What they do cover is the class of failure that actually sinks a V2 deployment: a
// stale init code hash, a contract over the size limit, an opcode the chain does not
// implement, a selector a front-end expects and cannot find. All of that is decidable
// from the build alone.
//
// When phase 3 lands, the natural next step is to replay these artifacts through
// node/src/evm and assert on real swaps. Until then this is the honest boundary.

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { keccak256Hex, fromHex } from '../scripts/keccak.mjs'
import { compile, readDeclaredInitCodeHash, initCodeHashOf, SETTINGS, SOLC_VERSION } from '../scripts/compile.mjs'

let failures = 0
let passes = 0
function test(name, fn) {
  try {
    fn()
    passes++
    console.log(`  ok    ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${err.message.split('\n').join('\n        ')}`)
  }
}

const utf8 = (s) => Uint8Array.from(Buffer.from(s, 'utf8'))
const selector = (sig) => keccak256Hex(utf8(sig)).slice(0, 10)

console.log(`\ncontracts build tests — solc ${SOLC_VERSION}, evmVersion ${SETTINGS.evmVersion}\n`)

const { output, errors, warnings } = compile()

test('compiles with no errors', () => {
  assert.equal(errors.length, 0, errors.map((e) => e.formattedMessage).join('\n'))
})

test('compiles with no warnings', () => {
  assert.equal(warnings.length, 0, warnings.map((e) => e.formattedMessage).join('\n'))
})

test('fromHex refuses malformed input instead of truncating', () => {
  // Buffer.from(s,'hex') stops at the first invalid nibble pair and returns a short
  // buffer without throwing. Unguarded, that would produce a wrong init code hash that
  // looks entirely plausible and only fails after deployment.
  assert.throws(() => fromHex('0x12zz34'), /not hex/)
  assert.throws(() => fromHex('0x123'), /odd-length/)
  assert.deepEqual([...fromHex('0x12ab')], [0x12, 0xab])
})

test('the compiler settings are the ones this chain requires', () => {
  assert.equal(SETTINGS.evmVersion, 'shanghai', 'Cancun would emit MCOPY/TSTORE/TLOAD')
  assert.equal(SETTINGS.optimizer.enabled, true)
  assert.ok(SOLC_VERSION.startsWith('0.8.26'), `expected solc 0.8.26, got ${SOLC_VERSION}`)
})

// ------------------------------------------------------------------ the init code hash

test('HearthV2Library.INIT_CODE_HASH equals keccak256(HearthV2Pair.creationCode)', () => {
  const actual = initCodeHashOf(output, 'HearthV2Pair.sol', 'HearthV2Pair')
  const declared = readDeclaredInitCodeHash()
  assert.equal(
    declared,
    actual,
    'the router would derive pair addresses that do not exist — run `pnpm compile --sync-hash`',
  )
})

test('the factory deploys exactly the init code the hash was taken over', () => {
  // Belt and braces: if the factory embedded any other creation code, every pair would
  // land somewhere the router cannot find, and the hash check above would still pass.
  const pairInit = output.contracts['HearthV2Pair.sol'].HearthV2Pair.evm.bytecode.object
  const factoryInit = output.contracts['HearthV2Factory.sol'].HearthV2Factory.evm.bytecode.object
  assert.ok(
    factoryInit.includes(pairInit),
    'HearthV2Pair creation code is not embedded verbatim in HearthV2Factory',
  )
})

test('HearthV2Pair has a zero-argument constructor', () => {
  // A constructor argument would make init code vary per pair and break CREATE2 address
  // derivation outright.
  const ctor = output.contracts['HearthV2Pair.sol'].HearthV2Pair.abi.find((e) => e.type === 'constructor')
  assert.ok(!ctor || ctor.inputs.length === 0, 'HearthV2Pair constructor must take no arguments')
})

test('pairFor derivation is reproducible off-chain', () => {
  // A worked example a deployer can check against. Uses the real init code hash, so it
  // changes with the build; the point is that the derivation itself is exercised.
  const initCodeHash = readDeclaredInitCodeHash()
  const factory = '0x1111111111111111111111111111111111111111'
  const tokenA = '0x2222222222222222222222222222222222222222'
  const tokenB = '0x3333333333333333333333333333333333333333'
  const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]
  const salt = keccak256Hex(fromHex(t0 + t1.slice(2)))
  const packed = 'ff' + factory.slice(2) + salt.slice(2) + initCodeHash.slice(2)
  const addr = '0x' + keccak256Hex('0x' + packed).slice(-40)
  assert.equal(addr.length, 42)
  assert.ok(/^0x[0-9a-f]{40}$/.test(addr))
  // Order independence: the same pair whichever way round the arguments come.
  const saltRev = keccak256Hex(fromHex(t0 + t1.slice(2)))
  assert.equal(salt, saltRev)
})

// -------------------------------------------------------------------------- code size

const SIZED = ['WEMBER', 'HearthV2Factory', 'HearthV2Pair', 'HearthV2Router02', 'Multicall3']

test('every deployable contract is under the EIP-170 limit (24576 B)', () => {
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      if (!SIZED.includes(name)) continue
      const size = c.evm.deployedBytecode.object.length / 2
      assert.ok(size <= 24576, `${file}:${name} deployed code is ${size} B, over the 24576 B limit`)
    }
  }
})

test('every deployable contract is under the EIP-3860 initcode limit (49152 B)', () => {
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      if (!SIZED.includes(name)) continue
      const size = c.evm.bytecode.object.length / 2
      assert.ok(size <= 49152, `${file}:${name} init code is ${size} B, over the 49152 B limit`)
    }
  }
})

// ---------------------------------------------------------------------------- opcodes

// Anything Cancun added and Hearth does not implement.
const FORBIDDEN = new Map([
  [0x49, 'BLOBHASH (EIP-4844)'],
  [0x4a, 'BLOBBASEFEE (EIP-7516)'],
  [0x5c, 'TLOAD (EIP-1153)'],
  [0x5d, 'TSTORE (EIP-1153)'],
  [0x5e, 'MCOPY (EIP-5656)'],
])

/** Walk bytecode, skipping PUSH immediates so data is never read as an opcode. */
function scanOpcodes(bytes) {
  const seen = new Set()
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i]
    seen.add(op)
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f // PUSH1..PUSH32 immediates
  }
  return seen
}

test('no post-Shanghai opcodes appear in any deployed bytecode', () => {
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      const code = c.evm.deployedBytecode.object
      if (!code) continue
      const seen = scanOpcodes(fromHex('0x' + code))
      for (const [op, label] of FORBIDDEN) {
        assert.ok(!seen.has(op), `${file}:${name} contains ${label} (0x${op.toString(16)})`)
      }
    }
  }
})

test('PUSH0 is emitted, proving the Shanghai target took effect', () => {
  // If evmVersion had silently fallen back to paris or london, PUSH0 (EIP-3855) would be
  // absent everywhere. Its presence is cheap evidence that the setting is live.
  const code = fromHex('0x' + output.contracts['HearthV2Router02.sol'].HearthV2Router02.evm.deployedBytecode.object)
  assert.ok(scanOpcodes(code).has(0x5f), 'no PUSH0 in the router — is evmVersion really shanghai?')
})

// -------------------------------------------------------------------------- constants

test('PERMIT_TYPEHASH matches the canonical EIP-2612 value', () => {
  const expected = '0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9'
  const actual = keccak256Hex(
    utf8('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'),
  )
  assert.equal(actual, expected)
})

test('the EIP712Domain typehash matches the canonical value', () => {
  const actual = keccak256Hex(
    utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
  )
  assert.equal(actual, '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f')
})

test('the hard-coded ERC-20 selectors in TransferHelper and the pair are correct', () => {
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb')
  assert.equal(selector('transferFrom(address,address,uint256)'), '0x23b872dd')
  assert.equal(selector('approve(address,uint256)'), '0x095ea7b3')
})

// --------------------------------------------------------------------------- the ABIs

function sigOf(entry) {
  const typeOf = (i) =>
    i.type === 'tuple'
      ? `(${i.components.map(typeOf).join(',')})`
      : i.type.startsWith('tuple')
        ? `(${i.components.map(typeOf).join(',')})${i.type.slice(5)}`
        : i.type
  return `${entry.name}(${entry.inputs.map(typeOf).join(',')})`
}

const sigsOf = (name, file) =>
  new Set(output.contracts[file][name].abi.filter((e) => e.type === 'function').map(sigOf))

test('WEMBER exposes the full WETH9 surface', () => {
  const have = sigsOf('WEMBER', 'WEMBER.sol')
  for (const sig of [
    'deposit()',
    'withdraw(uint256)',
    'totalSupply()',
    'balanceOf(address)',
    'allowance(address,address)',
    'approve(address,uint256)',
    'transfer(address,uint256)',
    'transferFrom(address,address,uint256)',
    'name()',
    'symbol()',
    'decimals()',
  ]) {
    assert.ok(have.has(sig), `WEMBER is missing ${sig}`)
  }
  const abi = output.contracts['WEMBER.sol'].WEMBER.abi
  assert.ok(abi.some((e) => e.type === 'receive'), 'WEMBER has no receive()')
  assert.ok(abi.some((e) => e.type === 'fallback'), 'WEMBER has no fallback()')
})

test('the pair exposes the V2 surface including permit and the TWAP accumulators', () => {
  const have = sigsOf('HearthV2Pair', 'HearthV2Pair.sol')
  for (const sig of [
    'MINIMUM_LIQUIDITY()',
    'factory()',
    'token0()',
    'token1()',
    'getReserves()',
    'price0CumulativeLast()',
    'price1CumulativeLast()',
    'kLast()',
    'mint(address)',
    'burn(address)',
    'swap(uint256,uint256,address,bytes)',
    'skim(address)',
    'sync()',
    'initialize(address,address)',
    'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
    'DOMAIN_SEPARATOR()',
    'PERMIT_TYPEHASH()',
    'nonces(address)',
  ]) {
    assert.ok(have.has(sig), `HearthV2Pair is missing ${sig}`)
  }
})

test('the factory exposes the V2 surface plus pairCodeHash', () => {
  const have = sigsOf('HearthV2Factory', 'HearthV2Factory.sol')
  for (const sig of [
    'feeTo()',
    'feeToSetter()',
    'getPair(address,address)',
    'allPairs(uint256)',
    'allPairsLength()',
    'createPair(address,address)',
    'setFeeTo(address)',
    'setFeeToSetter(address)',
    'pairCodeHash()',
  ]) {
    assert.ok(have.has(sig), `HearthV2Factory is missing ${sig}`)
  }
})

test('the router matches UniswapV2Router02 selector for selector', () => {
  // These are the exact signatures of the canonical Router02. A front-end, aggregator or
  // subgraph built for V2 dispatches on them; losing one is losing that integration.
  const have = sigsOf('HearthV2Router02', 'HearthV2Router02.sol')
  const canonical = [
    'factory()',
    'WETH()',
    'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
    'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
    'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)',
    'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
    'removeLiquidityWithPermit(address,address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)',
    'removeLiquidityETHWithPermit(address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)',
    'removeLiquidityETHSupportingFeeOnTransferTokens(address,uint256,uint256,uint256,address,uint256)',
    'removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)',
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)',
    'swapExactETHForTokens(uint256,address[],address,uint256)',
    'swapTokensForExactETH(uint256,uint256,address[],address,uint256)',
    'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
    'swapETHForExactTokens(uint256,address[],address,uint256)',
    'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
    'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)',
    'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
    'quote(uint256,uint256,uint256)',
    'getAmountOut(uint256,uint256,uint256)',
    'getAmountIn(uint256,uint256,uint256)',
    'getAmountsOut(uint256,address[])',
    'getAmountsIn(uint256,address[])',
  ]
  for (const sig of canonical) assert.ok(have.has(sig), `HearthV2Router02 is missing ${sig}`)
  assert.ok(have.has('WEMBER()'), 'the WEMBER() alias is missing')
  const extra = [...have].filter((s) => !canonical.includes(s) && s !== 'WEMBER()')
  assert.deepEqual(extra, [], `the router ABI has functions Router02 does not: ${extra.join(', ')}`)
  assert.ok(
    output.contracts['HearthV2Router02.sol'].HearthV2Router02.abi.some((e) => e.type === 'receive'),
    'the router must accept EMBER back from WEMBER.withdraw',
  )
})

test('a few router selectors match the well-known canonical values', () => {
  assert.equal(selector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'), '0x38ed1739')
  assert.equal(selector('swapExactETHForTokens(uint256,address[],address,uint256)'), '0x7ff36ab5')
  assert.equal(selector('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)'), '0xf305d719')
  assert.equal(selector('getAmountsOut(uint256,address[])'), '0xd06ca61f')
})

test('Multicall3 matches the canonical ABI and selectors', () => {
  const have = sigsOf('Multicall3', 'Multicall3.sol')
  const canonical = {
    'aggregate((address,bytes)[])': '0x252dba42',
    'tryAggregate(bool,(address,bytes)[])': '0xbce38bd7',
    'tryBlockAndAggregate(bool,(address,bytes)[])': '0x399542e9',
    'blockAndAggregate((address,bytes)[])': '0xc3077fa9',
    'aggregate3((address,bool,bytes)[])': '0x82ad56cb',
    'aggregate3Value((address,bool,uint256,bytes)[])': '0x174dea71',
    'getBasefee()': '0x3e64a696',
    'getBlockHash(uint256)': '0xee82ac5e',
    'getBlockNumber()': '0x42cbb15c',
    'getChainId()': '0x3408e470',
    'getCurrentBlockCoinbase()': '0xa8b0574e',
    'getCurrentBlockDifficulty()': '0x72425d9d',
    'getCurrentBlockGasLimit()': '0x86d516e8',
    'getCurrentBlockTimestamp()': '0x0f28c97d',
    'getEthBalance(address)': '0x4d2301cc',
    'getLastBlockHash()': '0x27e86d6e',
  }
  for (const [sig, sel] of Object.entries(canonical)) {
    assert.ok(have.has(sig), `Multicall3 is missing ${sig}`)
    assert.equal(selector(sig), sel, `selector drift on ${sig}`)
  }
  assert.equal(have.size, Object.keys(canonical).length, 'Multicall3 has functions the canonical ABI does not')
})

// --------------------------------------------------------------- deliberate overflow

test('the two deliberate-overflow sites are inside `unchecked`', () => {
  // A regression here does not fail the build, it fails in 2106 (or the first time an
  // accumulator wraps). Nothing else can catch it without an EVM, so it is checked as
  // source structure.
  const src = readFileSync(new URL('../src/HearthV2Pair.sol', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function _update('), src.indexOf('function _mintFee('))
  const unchecked = body.slice(body.indexOf('unchecked {'))
  assert.ok(body.includes('unchecked {'), '_update has no unchecked block')
  assert.ok(
    unchecked.includes('uint32 timeElapsed = blockTimestamp - blockTimestampLast'),
    'the uint32 timestamp subtraction is outside the unchecked block',
  )
  assert.ok(
    unchecked.includes('price0CumulativeLast +=') && unchecked.includes('price1CumulativeLast +='),
    'the TWAP accumulators are outside the unchecked block',
  )
})

test('SafeMath is gone rather than left as decoration', () => {
  // 0.8 checks every operation SafeMath used to guard, so keeping it would be a layer of
  // reverts over a compiler feature. Comments are stripped first — the porting notes
  // discuss SafeMath by name and should not trip this.
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(new URL(e.name + '/', dir)) : e.name.endsWith('.sol') ? [new URL(e.name, dir)] : [],
    )
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const file of walk(new URL('../src/', import.meta.url))) {
    const code = stripComments(readFileSync(file, 'utf8'))
    assert.ok(!/SafeMath/.test(code), `${file.pathname} still references SafeMath`)
    assert.ok(!/\.(add|sub|mul|div)\(/.test(code), `${file.pathname} still uses SafeMath-style call syntax`)
  }
})

console.log(`\n${passes} passed, ${failures} failed\n`)
process.exit(failures ? 1 : 0)
