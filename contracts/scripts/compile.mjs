#!/usr/bin/env node
// Compiles everything under src/ into out/, with the settings Hearth's chain requires.
//
//   pnpm compile               compile and verify the router's init code hash
//   pnpm compile --sync-hash   compile, rewrite the init code hash, recompile
//
// Settings are pinned deliberately and every one of them changes the CREATE2 init code
// hash if touched. See contracts/README.md.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { keccak256Hex } from './keccak.mjs'

const require = createRequire(import.meta.url)
const solc = require('solc')

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const SRC = resolve(root, 'src')
const OUT = resolve(root, 'out')

export const SETTINGS = {
  optimizer: { enabled: true, runs: 999999 },
  // Hearth targets Shanghai exactly (docs/evm-spec.md §1). The default for solc 0.8.26
  // is Cancun, which would emit MCOPY/TSTORE/TLOAD — opcodes this chain does not have.
  evmVersion: 'shanghai',
  // No CBOR metadata trailer. The init code hash is hard-coded into HearthV2Library and
  // duplicated on-chain; with metadata appended it would also depend on source file
  // paths and on the text of every comment, so a docstring edit would silently point the
  // router at addresses where no pair exists. Without it, the hash tracks the code alone.
  metadata: { bytecodeHash: 'none', appendCBOR: false },
  outputSelection: {
    '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] },
  },
}

export const SOLC_VERSION = solc.version()

function collectSources(dir = SRC, acc = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSources(full, acc)
    else if (entry.name.endsWith('.sol')) {
      acc[relative(SRC, full).split('\\').join('/')] = { content: readFileSync(full, 'utf8') }
    }
  }
  return acc
}

export function compile() {
  const sources = collectSources()
  const input = { language: 'Solidity', sources, settings: SETTINGS }
  const output = JSON.parse(solc.compile(JSON.stringify(input)))

  const problems = output.errors ?? []
  const errors = problems.filter((e) => e.severity === 'error')
  const warnings = problems.filter((e) => e.severity !== 'error')
  return { output, errors, warnings, sourceCount: Object.keys(sources).length }
}

const LIBRARY_FILE = resolve(SRC, 'libraries/HearthV2Library.sol')
const HASH_RE = /(bytes32 internal constant INIT_CODE_HASH = )(0x[0-9a-fA-F]{64})(;)/

export function readDeclaredInitCodeHash() {
  const m = HASH_RE.exec(readFileSync(LIBRARY_FILE, 'utf8'))
  if (!m) throw new Error('could not find INIT_CODE_HASH in HearthV2Library.sol')
  return m[2].toLowerCase()
}

function writeDeclaredInitCodeHash(hash) {
  const src = readFileSync(LIBRARY_FILE, 'utf8')
  writeFileSync(LIBRARY_FILE, src.replace(HASH_RE, `$1${hash}$3`))
}

export function initCodeHashOf(output, file, name) {
  const creation = output.contracts[file][name].evm.bytecode.object
  if (!creation || creation.length < 100) throw new Error(`${name} produced no creation code`)
  // An unlinked external library leaves a `__$<34 hex>$__` placeholder in the object.
  // Hashing that would hard-code an init code hash for code that does not exist. Every
  // library here is `internal` and inlines, so this should be unreachable — which is
  // exactly why it is worth asserting rather than assuming.
  if (!/^[0-9a-fA-F]+$/.test(creation)) {
    throw new Error(`${name} creation code contains a link placeholder; cannot hash unlinked bytecode`)
  }
  return keccak256Hex('0x' + creation)
}

function report(result) {
  for (const w of result.warnings) console.warn(w.formattedMessage)
  if (result.errors.length) {
    for (const e of result.errors) console.error(e.formattedMessage)
    process.exit(1)
  }
}

function writeArtifacts(output) {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const written = []
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      const creation = c.evm.bytecode.object ?? ''
      const deployed = c.evm.deployedBytecode.object ?? ''
      if (!creation) continue // pure interface or library with no code
      writeFileSync(
        resolve(OUT, `${name}.json`),
        JSON.stringify(
          {
            contractName: name,
            sourceName: file,
            compiler: { version: SOLC_VERSION, settings: SETTINGS },
            abi: c.abi,
            bytecode: '0x' + creation,
            deployedBytecode: '0x' + deployed,
          },
          null,
          2,
        ) + '\n',
      )
      written.push({ name, creation: creation.length / 2, deployed: deployed.length / 2 })
    }
  }
  return written
}

function main() {
  const sync = process.argv.includes('--sync-hash')

  let result = compile()
  report(result)

  const actual = initCodeHashOf(result.output, 'HearthV2Pair.sol', 'HearthV2Pair')
  const declared = readDeclaredInitCodeHash()

  if (actual !== declared) {
    if (!sync) {
      console.error('')
      console.error('  INIT CODE HASH MISMATCH')
      console.error(`    HearthV2Library.INIT_CODE_HASH = ${declared}`)
      console.error(`    keccak256(HearthV2Pair.creationCode) = ${actual}`)
      console.error('')
      console.error('  The router would derive pair addresses that do not exist.')
      console.error('  Fix with:  pnpm compile --sync-hash   (then update contracts/README.md)')
      console.error('')
      process.exit(1)
    }
    console.log(`init code hash: ${declared} -> ${actual}, rewriting HearthV2Library.sol`)
    writeDeclaredInitCodeHash(actual)
    result = compile()
    report(result)
    const recheck = initCodeHashOf(result.output, 'HearthV2Pair.sol', 'HearthV2Pair')
    if (recheck !== actual) {
      // Would mean the Pair's code depends on the library, which it must not.
      console.error(`  hash is not a fixed point: ${actual} -> ${recheck}`)
      process.exit(1)
    }
  }

  const written = writeArtifacts(result.output)

  console.log(`solc ${SOLC_VERSION}`)
  console.log(`  evmVersion ${SETTINGS.evmVersion}, optimizer ${SETTINGS.optimizer.runs} runs, metadata hash ${SETTINGS.metadata.bytecodeHash}`)
  console.log(`  ${result.sourceCount} sources -> ${written.length} artifacts in out/`)
  console.log('')
  for (const w of written.sort((a, b) => b.deployed - a.deployed)) {
    console.log(`  ${w.name.padEnd(20)} deployed ${String(w.deployed).padStart(6)} B   creation ${String(w.creation).padStart(6)} B`)
  }
  console.log('')
  console.log(`  INIT_CODE_HASH = ${actual}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
