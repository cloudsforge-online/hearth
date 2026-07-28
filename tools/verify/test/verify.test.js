'use strict';
/* Verification tests. Zero-dependency mini harness, same shape as node/test/*.
 *
 *   node test/verify.test.js
 *
 * THE TEST THAT MATTERS IS THE REJECTION. Compiling a contract and agreeing
 * with yourself proves nothing; a verifier that says yes to everything is
 * worse than no verifier, because it converts "unverified bytecode" into
 * "verified, apparently". So the round trip here is run in both directions on
 * a REAL artifact from contracts/src: compile it, verify it matches, then
 * change one byte of the deployed code and confirm it is refused — with the
 * offset of the difference, not a shrug.
 *
 * Everything runs over real HTTP against a stub node, and every compile is a
 * real solc downloaded from binaries.soliditylang.org and checked against its
 * published keccak256. THE FIRST RUN DOWNLOADS ABOUT 9 MB and caches it in
 * tools/verify/.solc-cache.
 *
 * FIXTURE-VERIFIED, NOT CHAIN-VERIFIED: there is no account-model chain yet
 * (docs/evm-spec.md §8, phase 5), so `eth_getCode` is answered by a stub. What
 * is genuinely proven is the compiler acquisition, the compilation, the
 * bytecode comparison and the API. What is not is that a real deployment of
 * these contracts produces the bytecode the stub is handed — that needs a node.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const CONTRACTS = path.join(REPO, 'contracts', 'src');

const { SolcRegistry } = require('../src/solc');
const { compile, buildInput, errorsOf } = require('../src/compile');
const { splitMetadata, maskImmutables, compareRuntime, readCbor, firstDifference } = require('../src/bytecode');
const { Store } = require('../src/store');
const { Verifier } = require('../src/verifier');
const { createServer, submissionFromForm, unwrapStandardJson } = require('../src/server');
const { Rpc } = require('../src/rpc');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }
const show = v => JSON.stringify(v);
function eq(a, b, msg) {
  if (show(a) === show(b)) pass++;
  else { fail++; console.log(`  ✗ ${msg}\n      want ${show(b)}\n      got  ${show(a)}`); }
}
function group(name) { console.log('• ' + name); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-verify-test-'));
/* Persistent across runs on purpose: a soljson build is ~9 MB and the point of
 * the cache is that CI and a developer both pay for it once. */
const SOLC_DIR = path.join(__dirname, '..', '.solc-cache');

const COMPILER = 'v0.8.26+commit.8a97fa7a';

/** The settings contracts/scripts/compile.mjs pins. Same evmVersion, same runs. */
const HEARTH_SETTINGS = {
  optimizer: { enabled: true, runs: 999999 },
  evmVersion: 'shanghai',
  metadata: { bytecodeHash: 'none', appendCBOR: false },
};

const baseEnv = {
  chainId: 7411,
  rpcUrl: '',
  dataDir: path.join(TMP, 'verified'),
  solcDir: SOLC_DIR,
  solcListUrl: 'https://binaries.soliditylang.org/bin/list.json',
  solcBinBase: 'https://binaries.soliditylang.org/bin',
  solcOffline: false,
  solcAllowNightly: false,
  solcListTtlMs: 7 * 24 * 3600 * 1000,
  compileTimeoutMs: 300_000,
  compileMaxBuffer: 256 * 1024 * 1024,
  maxBodyBytes: 8 * 1024 * 1024,
  concurrency: 1,
  queueLimit: 32,
  allowOverwrite: false,
  corsOrigins: ['*'],
};

// ---- a stub node -----------------------------------------------------------

/* Enough of an eth_* endpoint to answer a verifier: chain id, code at an
 * address, and one creation transaction. */
function startStubNode() {
  const codes = new Map();
  const txs = new Map();
  const state = {
    chainId: 7411,
    setCode(addr, hex) { codes.set(addr.toLowerCase(), hex.startsWith('0x') ? hex : '0x' + hex); },
    setTx(hash, tx) { txs.set(hash.toLowerCase(), tx); },
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const reply = result => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      switch (msg.method) {
        case 'eth_chainId': return reply('0x' + state.chainId.toString(16));
        case 'eth_getCode': return reply(codes.get(String(msg.params[0]).toLowerCase()) || '0x');
        case 'eth_getTransactionByHash': return reply(txs.get(String(msg.params[0]).toLowerCase()) || null);
        default:
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no ${msg.method}` },
          }));
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

// ---- an http client --------------------------------------------------------

function request(port, method, urlPath, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: payload === null ? {} : { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ---- sources ---------------------------------------------------------------

function readSources(dir, base = dir, acc = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readSources(full, base, acc);
    else if (entry.name.endsWith('.sol')) {
      acc[path.relative(base, full).split(path.sep).join('/')] = { content: fs.readFileSync(full, 'utf8') };
    }
  }
  return acc;
}

const standardJson = (sources, settings) => ({ language: 'Solidity', sources, settings });

const A = n => '0x' + n.toString(16).padStart(40, '0');

async function main() {
  console.log(`  compiler cache: ${SOLC_DIR}`);
  const registry = new SolcRegistry(baseEnv);

  // ==========================================================================
  group('acquiring a compiler');
  let solc;
  {
    const t = Date.now();
    solc = await registry.ensure(COMPILER);
    ok(fs.existsSync(solc.path), `soljson is on disk (${Date.now() - t} ms)`);
    eq(solc.build.longVersion, '0.8.26+commit.8a97fa7a', 'resolved to the exact release');
    ok(/^0x[0-9a-f]{64}$/.test(solc.build.keccak256), 'with a published keccak256');
    eq(registry._digest(solc.path), solc.build.keccak256, 'and the file on disk hashes to it');

    const byVersion = await registry.resolve('0.8.26');
    eq(byVersion.longVersion, '0.8.26+commit.8a97fa7a', 'a bare version resolves to its release build');

    let refusedOld = null;
    try { await registry.resolve('0.5.16'); } catch (e) { refusedOld = e.message; }
    ok(/older than 0.6.0/.test(String(refusedOld)), 'solc before 0.6.0 is refused by name, not obscurely');

    let refusedJunk = null;
    try { await registry.resolve('../../etc/passwd'); } catch (e) { refusedJunk = e.message; }
    ok(/not a solc version string/.test(String(refusedJunk)), 'a version string that is a path is refused');

    let refusedUnknown = null;
    try { await registry.resolve('0.8.999'); } catch (e) { refusedUnknown = e.message; }
    ok(/not a published release/.test(String(refusedUnknown)), 'an unpublished version is refused');

    let refusedNightly = null;
    try { await registry.resolve('0.8.27-nightly.2024.8.1+commit.abcdef12'); } catch (e) { refusedNightly = e.message; }
    ok(/nightly/.test(String(refusedNightly)), 'nightlies are off by default');

    // A corrupted cache must never be loaded. Offline, so there is no way for
    // a re-download to paper over it.
    const corruptDir = path.join(TMP, 'corrupt-solc');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.copyFileSync(registry.listPath, path.join(corruptDir, 'list.json'));
    fs.writeFileSync(path.join(corruptDir, path.basename(solc.path)), 'module.exports={};// not solc');
    const offline = new SolcRegistry({ ...baseEnv, solcDir: corruptDir, solcOffline: true });
    let refusedCorrupt = null;
    try { await offline.ensure(COMPILER); } catch (e) { refusedCorrupt = e.message; }
    ok(/fetching is disabled/.test(String(refusedCorrupt)),
      'a cached compiler whose keccak256 is wrong is deleted, not required');
    ok(!fs.existsSync(path.join(corruptDir, path.basename(solc.path))), 'and the bad file is gone');
  }

  // ==========================================================================
  group('compiling a real artifact from contracts/src');
  const wemberSource = fs.readFileSync(path.join(CONTRACTS, 'WEMBER.sol'), 'utf8');
  let wember;
  {
    const input = buildInput({
      standardJsonInput: standardJson({ 'WEMBER.sol': { content: wemberSource } }, HEARTH_SETTINGS),
    });
    const out = await compile({ soljson: solc.path, input, timeoutMs: baseEnv.compileTimeoutMs });
    eq(errorsOf(out.output).length, 0, 'WEMBER.sol compiles clean');
    wember = out.output.contracts['WEMBER.sol'].WEMBER;
    ok(wember.evm.deployedBytecode.object.length > 1000, 'and produces runtime bytecode');
    eq(splitMetadata(wember.evm.deployedBytecode.object).metadata, null,
      'with no CBOR trailer, because the repo pins metadata.bytecodeHash: none');
  }

  const node = await startStubNode();
  const rpc = new Rpc(`http://127.0.0.1:${node.port}`);
  const store = new Store(path.join(TMP, 'verified'));
  const env = { ...baseEnv, rpcUrl: `http://127.0.0.1:${node.port}` };
  const verifier = new Verifier({ env, rpc, registry, store });
  const server = createServer({ env, verifier, store, registry });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const WEMBER_AT = A(0x1001);
  const submission = {
    address: WEMBER_AT,
    compilerVersion: COMPILER,
    contractName: 'WEMBER.sol:WEMBER',
    standardJsonInput: standardJson({ 'WEMBER.sol': { content: wemberSource } }, HEARTH_SETTINGS),
  };

  // ==========================================================================
  group('the round trip: it verifies');
  {
    node.state.setCode(WEMBER_AT, wember.evm.deployedBytecode.object);
    const r = await request(port, 'POST', '/verify', submission);
    eq(r.status, 200, 'POST /verify accepts it');
    eq(r.json.ok, true, 'and reports success');
    eq(r.json.matchType, 'exact', 'as an EXACT match — byte-identical including the metadata trailer');
    eq(r.json.contractName, 'WEMBER', 'naming the contract');
    eq(r.json.compilerVersion, COMPILER, 'and the compiler that produced it');
    eq(r.json.evmVersion, 'shanghai', 'with the evm version read out of solc metadata, not the submission');
    eq(r.json.optimizationUsed, true, 'optimizer');
    eq(r.json.runs, 999999, 'and its run count');
    eq(r.json.license, 'GPL-3.0-or-later', 'the licence is read from the SPDX line');
    ok(r.json.abi.some(x => x.name === 'deposit'), 'the ABI is stored');
    eq(r.json.constructorArgumentsVerified, false, 'constructor arguments are NOT claimed as verified');
    ok(/not verified/.test(r.json.constructorArgumentsNote), 'and the record says why');

    const fetched = await request(port, 'GET', `/contract/${WEMBER_AT}`);
    eq(fetched.status, 200, 'GET /contract/:address serves the record');
    eq(fetched.json.contractName, 'WEMBER', 'with the name the explorer will display');
    const abi = await request(port, 'GET', `/contract/${WEMBER_AT}/abi`);
    ok(Array.isArray(abi.json), 'GET /contract/:address/abi serves the ABI alone');
  }

  // ==========================================================================
  group('THE ROUND TRIP IN REVERSE: it rejects');
  {
    /* One byte, in the middle of the runtime code, changed. This is the whole
     * point of the service: if this passes, nothing the verifier says means
     * anything. */
    const good = wember.evm.deployedBytecode.object;
    const at = 200;
    const mutated = good.slice(0, at * 2)
      + (good.slice(at * 2, at * 2 + 2) === 'ff' ? 'fe' : 'ff')
      + good.slice(at * 2 + 2);
    ok(mutated.length === good.length && mutated !== good, 'the fixture really is one byte different');

    const MUT_AT = A(0x1002);
    node.state.setCode(MUT_AT, mutated);
    const r = await request(port, 'POST', '/verify', { ...submission, address: MUT_AT });
    eq(r.status, 422, 'a mismatch is 422 — understood, and the answer is no');
    eq(r.json.ok, false, 'not verified');
    ok(/does not match/.test(r.json.error), 'and it says so');
    eq(r.json.detail.firstDifferenceByte, at, 'naming the exact byte that differs');
    eq(store.get(MUT_AT), null, 'and nothing is written to the store');

    const TRUNC_AT = A(0x1003);
    node.state.setCode(TRUNC_AT, good.slice(0, good.length - 20));
    const t = await request(port, 'POST', '/verify', { ...submission, address: TRUNC_AT });
    eq(t.status, 422, 'truncated code is rejected');
    ok(/does not match/.test(t.json.error), 'with the same reason');

    const EMPTY_AT = A(0x1004);
    const e = await request(port, 'POST', '/verify', { ...submission, address: EMPTY_AT });
    eq(e.status, 422, 'an address with no code is rejected');
    ok(/no code at/.test(e.json.error), 'and is told there is nothing there rather than "mismatch"');

    const OTHER_AT = A(0x1005);
    node.state.setCode(OTHER_AT, good);
    const other = await request(port, 'POST', '/verify', {
      address: OTHER_AT,
      compilerVersion: COMPILER,
      contractName: 'Other.sol:Other',
      standardJsonInput: standardJson(
        { 'Other.sol': { content: '// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\ncontract Other { uint256 public x = 42; }' } },
        HEARTH_SETTINGS,
      ),
    });
    eq(other.status, 422, 'a completely different contract is rejected');
    ok(/does not match/.test(other.json.error), 'not accepted because it happens to compile');

    const NAME_AT = A(0x1008);
    node.state.setCode(NAME_AT, good);
    const wrongName = await request(port, 'POST', '/verify', { ...submission, address: NAME_AT, contractName: 'WEMBER.sol:Nope' });
    ok(/no contract named/.test(wrongName.json.error), 'a name that is not in the sources is refused');

    const BROKEN_AT = A(0x1006);
    node.state.setCode(BROKEN_AT, good);
    const brokenSource = await request(port, 'POST', '/verify', {
      ...submission, address: BROKEN_AT,
      standardJsonInput: standardJson({ 'WEMBER.sol': { content: 'contract Broken { !!! }' } }, HEARTH_SETTINGS),
    });
    eq(brokenSource.status, 422, 'source that does not compile is rejected');
    ok(/does not compile/.test(brokenSource.json.error), 'with the compiler\'s own errors');
  }

  // ==========================================================================
  group('re-verification, and finding the contract without a name');
  {
    const again = await request(port, 'POST', '/verify', submission);
    eq(again.status, 422, 'an already-verified address is refused by default');
    ok(/already verified/.test(again.json.error), 'rather than silently overwritten');

    const NONAME_AT = A(0x1007);
    node.state.setCode(NONAME_AT, wember.evm.deployedBytecode.object);
    const r = await request(port, 'POST', '/verify', {
      ...submission, address: NONAME_AT, contractName: undefined,
    });
    eq(r.json.ok, true, 'with no contractName, every compiled contract is tried');
    eq(r.json.contractName, 'WEMBER', 'and the one that matches wins');
  }

  // ==========================================================================
  group('the metadata hash — the same code, a different comment');
  {
    /* solc appends a CBOR blob whose hash covers source paths, settings and
     * the text of every comment. Change a docstring and the bytecode changes
     * without one instruction changing. This is why a partial match exists. */
    const withCbor = { optimizer: HEARTH_SETTINGS.optimizer, evmVersion: 'shanghai' };

    const deployedOut = await compile({
      soljson: solc.path,
      input: buildInput({ standardJsonInput: standardJson({ 'WEMBER.sol': { content: wemberSource } }, withCbor) }),
      timeoutMs: baseEnv.compileTimeoutMs,
    });
    const deployed = deployedOut.output.contracts['WEMBER.sol'].WEMBER.evm.deployedBytecode.object;
    const split = splitMetadata(deployed);
    ok(split.metadata !== null, 'with default settings solc DOES append a CBOR trailer');
    ok(split.fields.ipfs || split.fields.bzzr1, 'containing a content hash');
    ok(split.fields.solc, 'and the compiler version');

    const commented = wemberSource.replace(
      'function deposit() public payable {',
      '/// @dev One extra line of documentation. No instruction changes.\n    function deposit() public payable {',
    );
    ok(commented !== wemberSource, 'the fixture really does differ only in a comment');

    const META_AT = A(0x2001);
    node.state.setCode(META_AT, deployed);
    const r = await request(port, 'POST', '/verify', {
      address: META_AT,
      compilerVersion: COMPILER,
      contractName: 'WEMBER.sol:WEMBER',
      standardJsonInput: standardJson({ 'WEMBER.sol': { content: commented } }, withCbor),
    });
    eq(r.json.ok, true, 'it still verifies');
    eq(r.json.matchType, 'partial', 'as a PARTIAL match, because the metadata trailer differs');
    eq(r.json.metadataMatched, false, 'and that is stated in the record, not hidden');

    const EXACT_AT = A(0x2002);
    node.state.setCode(EXACT_AT, deployed);
    const exact = await request(port, 'POST', '/verify', {
      address: EXACT_AT,
      compilerVersion: COMPILER,
      contractName: 'WEMBER.sol:WEMBER',
      standardJsonInput: standardJson({ 'WEMBER.sol': { content: wemberSource } }, withCbor),
    });
    eq(exact.json.matchType, 'exact', 'the unmodified source is still an exact match');
    eq(exact.json.metadataMatched, true, 'metadata and all');
  }

  // ==========================================================================
  group('immutables and constructor arguments, on the real Router');
  {
    const sources = readSources(CONTRACTS);
    const out = await compile({
      soljson: solc.path,
      input: buildInput({ standardJsonInput: standardJson(sources, HEARTH_SETTINGS) }),
      timeoutMs: baseEnv.compileTimeoutMs,
    });
    eq(errorsOf(out.output).length, 0, 'the whole of contracts/src compiles');
    const router = out.output.contracts['HearthV2Router02.sol'].HearthV2Router02;
    const refs = router.evm.deployedBytecode.immutableReferences;
    ok(refs && Object.keys(refs).length === 2, 'the Router has two immutables (factory, WEMBER)');

    // Simulate what the constructor does: write the two addresses into the
    // slots the compiler left as zeros.
    const factory = A(0xf00d), wemberAddr = A(0xbeef);
    const buf = Buffer.from(router.evm.deployedBytecode.object, 'hex');
    const astIds = Object.keys(refs);
    const values = [factory, wemberAddr];
    astIds.forEach((id, i) => {
      for (const r of refs[id]) {
        Buffer.from(values[i].slice(2).padStart(64, '0'), 'hex').copy(buf, r.start);
      }
    });
    const asDeployed = buf.toString('hex');
    ok(asDeployed !== router.evm.deployedBytecode.object, 'the deployed code differs from the compiled code');

    const ROUTER_AT = A(0x3001);
    node.state.setCode(ROUTER_AT, asDeployed);

    const args = values.map(v => v.slice(2).padStart(64, '0')).join('');
    const creationTx = '0x' + '5c'.repeat(32);
    node.state.setTx(creationTx, { to: null, input: '0x' + router.evm.bytecode.object + args });

    const r = await request(port, 'POST', '/verify', {
      address: ROUTER_AT,
      compilerVersion: COMPILER,
      contractName: 'HearthV2Router02.sol:HearthV2Router02',
      standardJsonInput: standardJson(sources, HEARTH_SETTINGS),
      constructorArguments: '0x' + args,
      creationTxHash: creationTx,
    });
    eq(r.json.ok, true, 'a contract with immutables verifies once they are masked');
    eq(r.json.matchType, 'exact', 'as an exact match');
    eq(r.json.immutableRanges, astIds.reduce((n, id) => n + refs[id].length, 0), 'every immutable range is accounted for');
    ok(r.json.immutableValues.some(v => v.endsWith('f00d')), 'and the values read out of the deployed code are reported');
    eq(r.json.constructorArgumentsVerified, true,
      'constructor arguments ARE verified when a creation transaction is supplied');
    eq(r.json.constructorArguments, '0x' + args, 'and are the ones the deployment carried');

    // The same deployment, with the submitter claiming different arguments.
    const WRONG_AT = A(0x3002);
    node.state.setCode(WRONG_AT, asDeployed);
    const wrongTx = '0x' + '5d'.repeat(32);
    node.state.setTx(wrongTx, { to: null, input: '0x' + router.evm.bytecode.object + args });
    const wrong = await request(port, 'POST', '/verify', {
      address: WRONG_AT,
      compilerVersion: COMPILER,
      contractName: 'HearthV2Router02.sol:HearthV2Router02',
      standardJsonInput: standardJson(sources, HEARTH_SETTINGS),
      constructorArguments: '0x' + 'ab'.repeat(64),
      creationTxHash: wrongTx,
    });
    eq(wrong.status, 422, 'declared arguments that contradict the deployment are a REJECTION');
    ok(/different constructor arguments/.test(wrong.json.error), 'naming the disagreement');

    // Immutables are masked, not proven: a contract deployed with different
    // constructor arguments still matches the same source.
    const OTHER_IMM = A(0x3003);
    const buf2 = Buffer.from(router.evm.deployedBytecode.object, 'hex');
    astIds.forEach(id => {
      for (const rr of refs[id]) Buffer.from('11'.repeat(32), 'hex').copy(buf2, rr.start);
    });
    node.state.setCode(OTHER_IMM, buf2.toString('hex'));
    const imm = await request(port, 'POST', '/verify', {
      address: OTHER_IMM,
      compilerVersion: COMPILER,
      contractName: 'HearthV2Router02.sol:HearthV2Router02',
      standardJsonInput: standardJson(sources, HEARTH_SETTINGS),
    });
    eq(imm.json.ok, true, 'a different deployment of the same source also matches');
    ok(imm.json.immutableValues.every(v => /^0x1+$/.test(v)),
      'with ITS immutable values reported — masked for comparison, never claimed as verified');
  }

  // ==========================================================================
  group('unlinked libraries are refused, not reported as a mismatch');
  {
    const libSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
library BigMath {
    function twice(uint256 a) external pure returns (uint256) { return a * 2; }
}
contract UsesLib {
    function go(uint256 a) external pure returns (uint256) { return BigMath.twice(a); }
}`;
    const LIB_AT = A(0x4001);
    node.state.setCode(LIB_AT, '60806040523415600e57600080fd5b00');
    const r = await request(port, 'POST', '/verify', {
      address: LIB_AT,
      compilerVersion: COMPILER,
      contractName: 'Lib.sol:UsesLib',
      standardJsonInput: standardJson({ 'Lib.sol': { content: libSource } }, HEARTH_SETTINGS),
    });
    eq(r.status, 422, 'refused');
    ok(/unlinked library placeholders/.test(r.json.error), 'because the bytecode still has a placeholder');
    ok(/Lib\.sol:BigMath/.test(r.json.error), 'and the library that needs an address is named');

    // With the library linked, the placeholder is gone and the comparison is
    // a real one — here it correctly fails, because the stub code is nonsense.
    const linked = await request(port, 'POST', '/verify', {
      address: LIB_AT,
      compilerVersion: COMPILER,
      contractName: 'Lib.sol:UsesLib',
      standardJsonInput: standardJson({ 'Lib.sol': { content: libSource } }, {
        ...HEARTH_SETTINGS, libraries: { 'Lib.sol': { BigMath: A(0xabc) } },
      }),
    });
    ok(/does not match/.test(linked.json.error), 'once linked it becomes an ordinary mismatch');
    ok(!/unlinked/.test(linked.json.error), 'and no longer complains about linking');
  }

  // ==========================================================================
  group('the Etherscan-compatible verification API (what forge speaks)');
  {
    const FORGE_AT = A(0x5001);
    node.state.setCode(FORGE_AT, wember.evm.deployedBytecode.object);
    const form = new URLSearchParams({
      apikey: 'anything',
      module: 'contract',
      action: 'verifysourcecode',
      contractaddress: FORGE_AT,
      // The `{{…}}` wrapper is how Etherscan carries a standard-JSON input.
      sourceCode: '{' + JSON.stringify(standardJson({ 'WEMBER.sol': { content: wemberSource } }, HEARTH_SETTINGS)) + '}',
      codeformat: 'solidity-standard-json-input',
      contractname: 'WEMBER.sol:WEMBER',
      compilerversion: COMPILER,
      optimizationUsed: '1',
      runs: '999999',
      constructorArguements: '',
      evmversion: 'shanghai',
      licenseType: '5',
    }).toString();

    const submitted = await request(port, 'POST', '/api', form, 'application/x-www-form-urlencoded');
    eq(submitted.json.status, '1', 'verifysourcecode is accepted');
    eq(submitted.json.message, 'OK', 'with the Etherscan envelope');
    const guid = submitted.json.result;
    ok(typeof guid === 'string' && guid.length > 10, 'and returns a GUID');

    let status = null;
    for (let i = 0; i < 600; i++) {
      status = (await request(port, 'GET', `/api?module=contract&action=checkverifystatus&guid=${guid}`)).json;
      if (status.result !== 'Pending in queue') break;
      await new Promise(r => setTimeout(r, 100));
    }
    eq(status.result, 'Pass - Verified', 'checkverifystatus returns the exact string forge matches on');
    eq(status.status, '1', 'with status 1');

    const unknown = await request(port, 'GET', '/api?module=contract&action=checkverifystatus&guid=nope');
    ok(/Unable to locate this GUID/.test(unknown.json.result), 'an unknown GUID is Etherscan-shaped');

    const abi = await request(port, 'GET', `/api?module=contract&action=getabi&address=${FORGE_AT}`);
    eq(abi.json.status, '1', 'getabi answers for a verified contract');
    ok(JSON.parse(abi.json.result).some(x => x.name === 'withdraw'), 'with the ABI as a JSON string');

    const src = await request(port, 'GET', `/api?module=contract&action=getsourcecode&address=${FORGE_AT}`);
    eq(src.json.result[0].ContractName, 'WEMBER', 'getsourcecode names the contract');
    ok(src.json.result[0].SourceCode.startsWith('{{'), 'and uses the {{…}} multi-file form');
    eq(src.json.result[0].LicenseType, 'GNU GPLv3', 'licenseType=5 maps to Etherscan\'s fifth licence');

    const missing = await request(port, 'GET', `/api?module=contract&action=getabi&address=${A(0x9999)}`);
    eq(missing.json.result, 'Contract source code not verified', 'and an unverified one gets the exact string');

    // A rejection has to travel through the same asynchronous shape.
    const BAD_AT = A(0x5002);
    node.state.setCode(BAD_AT, '0xdeadbeef');
    const badForm = new URLSearchParams({
      module: 'contract', action: 'verifysourcecode', contractaddress: BAD_AT,
      sourceCode: '{' + JSON.stringify(standardJson({ 'WEMBER.sol': { content: wemberSource } }, HEARTH_SETTINGS)) + '}',
      codeformat: 'solidity-standard-json-input', contractname: 'WEMBER.sol:WEMBER',
      compilerversion: COMPILER,
    }).toString();
    const badGuid = (await request(port, 'POST', '/api', badForm, 'application/x-www-form-urlencoded')).json.result;
    let badStatus = null;
    for (let i = 0; i < 600; i++) {
      badStatus = (await request(port, 'GET', `/api?module=contract&action=checkverifystatus&guid=${badGuid}`)).json;
      if (badStatus.result !== 'Pending in queue') break;
      await new Promise(r => setTimeout(r, 100));
    }
    eq(badStatus.status, '0', 'a failed verification comes back as status 0');
    ok(/^Fail - Unable to verify/.test(badStatus.result), 'with forge\'s expected prefix');
  }

  // ==========================================================================
  group('form parsing');
  {
    const q = new URLSearchParams({
      contractaddress: A(1), compilerversion: COMPILER, contractname: 'A.sol:A',
      codeformat: 'solidity-single-file', sourceCode: 'contract A {}',
      optimizationUsed: '1', runs: '250', constructorArguements: 'aabb'.repeat(16),
      licenseType: '3', libraryname1: 'L', libraryaddress1: '11'.repeat(20),
    });
    const s = submissionFromForm(q);
    eq(s.address, A(1), 'address');
    eq(s.optimizationUsed, true, 'optimizationUsed is "1"/"0" on the wire');
    eq(s.runs, 250, 'runs');
    eq(s.license, 'MIT', 'licenseType 3 is MIT');
    ok(s.constructorArguments.startsWith('0x'), 'Etherscan\'s misspelled constructorArguements is read and 0x-prefixed');
    eq(s.libraries.L, '0x' + '11'.repeat(20), 'libraryname/libraryaddress pairs become a libraries map');

    const wrapped = unwrapStandardJson('{{"language":"Solidity","sources":{},"settings":{}}}');
    eq(wrapped.language, 'Solidity', 'the {{…}} wrapper is unwrapped');
    const plain = unwrapStandardJson('{"language":"Solidity"}');
    eq(plain.language, 'Solidity', 'and a plain JSON object still parses');
  }

  // ==========================================================================
  group('bytecode primitives');
  {
    eq(readCbor(Buffer.from('a164736f6c634300081a', 'hex')), { solc: '00081a' },
      'the CBOR reader handles solc\'s map-of-byte-strings trailer');
    eq(splitMetadata('60806040').metadata, null, 'code with no trailer is left alone');
    eq(splitMetadata('6080604000ff').metadata, null, 'and a plausible length that is not CBOR is not treated as one');

    const withTrailer = '6080604080' + 'a164736f6c634300081a' + '000a';
    const s = splitMetadata(withTrailer);
    eq(s.code, '6080604080', 'a real trailer is split off');
    eq(s.fields.solc, '00081a', 'and parsed');

    const masked = maskImmutables('aabbccddeeff', { 1: [{ start: 1, length: 2 }] });
    eq(masked.hex, 'aa0000ddeeff', 'immutable ranges are zeroed');
    eq(masked.values, ['0xbbcc'], 'and their values reported');

    eq(firstDifference('aabbcc', 'aabdcc'), 1, 'firstDifference is a byte offset, not a nibble one');

    const r = compareRuntime({ onchain: '0x', compiled: '6080' });
    ok(/no code at that address/.test(r.reason), 'an empty address is named as such');
    const r2 = compareRuntime({ onchain: '6080', compiled: '' });
    ok(/no runtime bytecode/.test(r2.reason), 'so is an interface or abstract contract');
  }

  // ==========================================================================
  group('routes');
  {
    const health = await request(port, 'GET', '/health');
    eq(health.json.ok, true, '/health is ok');
    eq(health.json.service, 'hearth-verify', 'and names the service');
    ok(health.json.verified >= 1, 'reporting how many contracts are verified');

    const list = await request(port, 'GET', '/contracts');
    ok(list.json.contracts.some(c => c.address === WEMBER_AT), '/contracts lists them');

    const home = await request(port, 'GET', '/');
    ok(home.status === 200 && /forge verify-contract/.test(home.text), 'GET / documents the forge command');

    eq((await request(port, 'GET', '/contract/0xnot-an-address')).status, 404, 'a malformed address is 404, not a path');
    eq((await request(port, 'GET', '/nope')).status, 404, 'an unknown route is 404');
    eq((await request(port, 'GET', '/verify')).status, 405, 'GET /verify is 405');
    const badJson = await request(port, 'POST', '/verify', 'not json');
    eq(badJson.status, 400, 'a malformed body is 400');
  }

  server.close();
  node.server.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} verify checks`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
