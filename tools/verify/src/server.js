'use strict';
/* The HTTP surface. Two APIs on purpose.
 *
 *   NATIVE                              ETHERSCAN-COMPATIBLE
 *   POST /verify                        POST /api  module=contract&action=verifysourcecode
 *   GET  /contract/:address             GET  /api  module=contract&action=checkverifystatus&guid=…
 *   GET  /contract/:address/abi         GET  /api  module=contract&action=getabi&address=…
 *   GET  /contracts                     GET  /api  module=contract&action=getsourcecode&address=…
 *   GET  /compilers
 *   GET  /health
 *   GET  /
 *
 * THE ETHERSCAN ROUTE IS NOT DECORATION. `forge verify-contract` and
 * `@nomicfoundation/hardhat-verify` both speak exactly it: POST a form, get a
 * GUID back, poll until it says `Pass - Verified`. Reproducing that contract —
 * including the misspelled `constructorArguements` field, which is in the wire
 * format and cannot be fixed — is the difference between "run this command"
 * and "write an integration".
 *
 * `GET /contract/:address` is what tools/explorer-api reads to answer
 * `module=contract&action=getabi` and `getsourcecode`.
 */

const http = require('http');
const { logger } = require('./log');
const { VerifyError } = require('./verifier');

const OK = result => ({ status: '1', message: 'OK', result });
const NOTOK = why => ({ status: '0', message: 'NOTOK', result: why });

/** Etherscan's numeric licence codes, in its own order. */
const LICENSES = [
  'None', 'Unlicense', 'MIT', 'GNU GPLv2', 'GNU GPLv3', 'GNU LGPLv2.1', 'GNU LGPLv3',
  'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', 'OSL-3.0', 'Apache-2.0', 'GNU AGPLv3', 'BSL 1.1',
];

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  const text = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isText
      ? (text.startsWith('<') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8')
      : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let text = '', size = 0, over = false;
    req.on('data', d => {
      if (over) return;
      size += d.length;
      if (size > limit) { over = true; reject(new Error(`body larger than ${limit} bytes`)); return; }
      text += d;
    });
    req.on('end', () => { if (!over) resolve(text); });
    req.on('error', reject);
  });
}

function corsHeaders(env, req) {
  const origin = req.headers.origin;
  if (!env.corsOrigins.length) return {};
  if (env.corsOrigins.includes('*')) {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    };
  }
  if (!origin || !env.corsOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

/**
 * Etherscan wraps a standard-JSON input in one extra pair of braces so that a
 * single `sourceCode` field can carry either a flat file or a whole project.
 * Every client that supports multi-file verification detects it exactly this
 * way, so the unwrapping has to be exactly this too.
 */
function unwrapStandardJson(text) {
  const t = String(text || '').trim();
  if (t.startsWith('{{') && t.endsWith('}}')) return JSON.parse(t.slice(1, -1));
  return JSON.parse(t);
}

/** libraryname1..10 / libraryaddress1..10 → { "name": "0x…" } */
function librariesFromForm(q) {
  const out = {};
  for (let i = 1; i <= 10; i++) {
    const name = q.get(`libraryname${i}`);
    const addr = q.get(`libraryaddress${i}`);
    if (name && addr) out[name] = addr.startsWith('0x') ? addr : '0x' + addr;
  }
  return out;
}

function submissionFromForm(q) {
  const format = String(q.get('codeformat') || 'solidity-single-file').toLowerCase();
  const source = q.get('sourceCode') || q.get('sourcecode') || '';
  const licenseRaw = q.get('licenseType');
  const licenseNum = Number(licenseRaw);
  const s = {
    address: q.get('contractaddress') || q.get('address'),
    contractName: q.get('contractname') || q.get('contractName') || '',
    compilerVersion: q.get('compilerversion') || q.get('compilerVersion'),
    optimizationUsed: String(q.get('optimizationUsed') || q.get('optimizationused') || '0') === '1',
    runs: Number(q.get('runs') || 200),
    evmVersion: q.get('evmversion') || q.get('evmVersion') || '',
    /* `constructorArguements` — Etherscan's own misspelling. It is part of the
     * wire format that every client sends, so both spellings are read. */
    constructorArguments: q.get('constructorArguements') || q.get('constructorArguments') || '',
    creationTxHash: q.get('creationTxHash') || null,
    license: Number.isInteger(licenseNum) && licenseNum >= 1 && licenseNum <= LICENSES.length
      ? LICENSES[licenseNum - 1] : (licenseRaw || null),
    libraries: librariesFromForm(q),
  };
  if (format.includes('standard-json')) {
    s.standardJsonInput = unwrapStandardJson(source);
  } else {
    s.sourceCode = source;
    s.sourceName = q.get('sourceName') || `${(s.contractName || 'Contract').split(':').pop()}.sol`;
  }
  if (s.constructorArguments && !s.constructorArguments.startsWith('0x')) {
    s.constructorArguments = '0x' + s.constructorArguments;
  }
  return s;
}

const PAGE = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hearth contract verification</title>
<style>
 body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:4rem auto;padding:0 1rem;background:#12100e;color:#e8e2d9}
 h1{font-size:1.4rem} h2{font-size:1.05rem;margin-top:2rem}
 code,pre{background:#231f1b;padding:.1rem .3rem;border-radius:3px;font-family:ui-monospace,monospace;font-size:.86rem}
 pre{padding:.8rem;overflow-x:auto} a{color:#fb923c}
 .warn{border-left:3px solid #c2410c;padding-left:1rem;color:#c9bfb2}
</style>
<h1>Hearth contract verification</h1>
<p class="warn">Recompiles a submitted source with the exact compiler it names and
compares the result against the runtime bytecode at an address. It publishes one
claim and no more: <b>this source compiles to that code</b>.</p>

<h2>With Foundry</h2>
<pre>forge verify-contract &lt;address&gt; src/Thing.sol:Thing \\
  --verifier-url http://127.0.0.1:9648/api \\
  --etherscan-api-key any \\
  --compiler-version v0.8.26+commit.8a97fa7a \\
  --num-of-optimizations 999999</pre>

<h2>Directly</h2>
<pre>POST /verify
{
  "address": "0x…",
  "compilerVersion": "v0.8.26+commit.8a97fa7a",
  "standardJsonInput": { "language": "Solidity", "sources": { … }, "settings": { … } },
  "contractName": "src/Thing.sol:Thing",
  "constructorArguments": "0x…",
  "creationTxHash": "0x…"
}</pre>

<h2>What a match means</h2>
<p><code>exact</code> — byte-identical, metadata trailer included.<br>
<code>partial</code> — identical once the CBOR metadata trailer is removed. The
code is the same; the metadata hash covers comments, source paths and settings,
so the source is <i>equivalent</i>, not proven identical.</p>
<p><b>Constructor arguments are recorded but not verified</b> unless you supply
<code>creationTxHash</code>. Immutable values are read out of the deployed code
and reported, but masked for comparison rather than proven.</p>

<h2>One submission, every identical deployment</h2>
<p>Verification proves a source against <i>runtime</i> bytecode, which carries no
constructor arguments. So a contract deployed a thousand times with different
names, supplies and owners is a thousand addresses holding one bytecode, and
verifying any one of them answers for all of them.</p>
<p><code>twin-exact</code> — this address holds the same bytes as a verified
contract.<br>
<code>twin-immutables</code> — the same bytes apart from its
<code>immutable</code> values, which are read from its own code.</p>
<p>A derived answer names its source in <code>twinOf</code> and carries <b>no</b>
constructor arguments — those are the part that differs. Verify an address
directly, with its creation transaction, to have them checked.</p>
<p><a href="/health">/health</a> · <a href="/contracts">/contracts</a> · <a href="/compilers">/compilers</a></p>`;

function createServer({ env, verifier, store, registry }) {
  /** Etherscan's asynchronous shape: a GUID now, a verdict when polled. */
  const jobs = new Map();
  const JOB_TTL_MS = 30 * 60 * 1000;
  const newGuid = () => (
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.padEnd(20, '0').slice(0, 50)
  );
  const sweepJobs = () => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [k, v] of jobs) if (v.at < cutoff) jobs.delete(k);
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'verify'}`);
    const cors = corsHeaders(env, req);

    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);

      // ---- native ---------------------------------------------------------

      if (url.pathname === '/verify') {
        if (req.method !== 'POST') {
          return send(res, 405, { ok: false, error: 'POST a JSON submission' }, { allow: 'POST', ...cors });
        }
        let submission;
        try {
          submission = JSON.parse(await readBody(req, env.maxBodyBytes));
        } catch (e) {
          return send(res, 400, { ok: false, error: `invalid JSON body: ${e.message}` }, cors);
        }
        try {
          const record = await verifier.submit(submission);
          return send(res, 200, { ok: true, ...record }, cors);
        } catch (e) {
          if (e instanceof VerifyError) {
            /* 422, not 500: the request was understood and the answer is "no".
             * A 500 reads as an outage and gets retried. */
            return send(res, 422, { ok: false, error: e.message, detail: e.detail || null }, cors);
          }
          logger.error('verification failed unexpectedly', { err: e });
          return send(res, 500, { ok: false, error: String(e.message || e) }, cors);
        }
      }

      const contractMatch = /^\/contract\/(0x[0-9a-fA-F]{40})(\/abi)?$/.exec(url.pathname);
      if (contractMatch && req.method === 'GET') {
        /* `verifier.resolve`, not `store.get`: an address that carries the same
         * runtime bytecode as a verified contract has the same source, and this
         * is the route the explorer reads. See `derivedRecord` in verifier.js
         * for what such an answer does and does not claim. */
        const record = await verifier.resolve(contractMatch[1]);
        if (!record) return send(res, 404, { error: 'not verified' }, cors);
        return send(res, 200, contractMatch[2] ? record.abi : record, cors);
      }

      if (url.pathname === '/contracts' && req.method === 'GET') {
        /* Deliberately `store` and not the resolver: this lists what somebody
         * SUBMITTED. Derived records have no list — they are discovered by
         * asking about an address, and enumerating them would mean walking every
         * account on the chain. */
        return send(res, 200, { count: store.count, contracts: store.list() }, cors);
      }

      if (url.pathname === '/compilers' && req.method === 'GET') {
        try {
          return send(res, 200, { compilers: await registry.releases() }, cors);
        } catch (e) {
          return send(res, 503, { error: String(e.message || e) }, cors);
        }
      }

      if (url.pathname === '/health') {
        let listOk = true, listError = null;
        try { await registry.loadList(); } catch (e) { listOk = false; listError = String(e.message || e); }
        return send(res, listOk ? 200 : 503, {
          ok: listOk,
          service: 'hearth-verify',
          chainId: env.chainId,
          rpcUrl: env.rpcUrl,
          solcDir: env.solcDir,
          solcOffline: env.solcOffline,
          compilerListAvailable: listOk,
          compilerListError: listError,
          ...verifier.stats(),
        }, cors);
      }

      if (url.pathname === '/' && req.method === 'GET') return send(res, 200, PAGE, cors);

      // ---- Etherscan-compatible -------------------------------------------

      if (url.pathname === '/api') {
        let q = url.searchParams;
        if (req.method === 'POST') {
          const body = await readBody(req, env.maxBodyBytes);
          const ct = String(req.headers['content-type'] || '');
          if (ct.includes('application/json')) {
            try {
              const obj = JSON.parse(body);
              q = new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
            } catch (e) {
              return send(res, 200, NOTOK(`Error! Malformed JSON body: ${e.message}`), cors);
            }
          } else {
            q = new URLSearchParams(body);
          }
          for (const [k, v] of url.searchParams) if (!q.has(k)) q.append(k, v);
        }

        const action = String(q.get('action') || '').toLowerCase();
        const module = String(q.get('module') || '').toLowerCase();
        if (module !== 'contract') return send(res, 200, NOTOK('Error! Missing Or invalid Module name'), cors);

        if (action === 'verifysourcecode') {
          let submission;
          try {
            submission = submissionFromForm(q);
          } catch (e) {
            return send(res, 200, NOTOK(`Error! ${e.message}`), cors);
          }
          sweepJobs();
          const guid = newGuid();
          jobs.set(guid, { at: Date.now(), state: 'pending', address: submission.address });
          /* Answer immediately with the GUID, exactly as Etherscan does, and do
           * the work in the background. A client that polls sees `Pending in
           * queue` until it resolves. */
          verifier.submit(submission).then(
            record => jobs.set(guid, { at: Date.now(), state: 'pass', address: record.address, record }),
            e => jobs.set(guid, { at: Date.now(), state: 'fail', address: submission.address, error: String(e.message || e) }),
          );
          return send(res, 200, OK(guid), cors);
        }

        if (action === 'checkverifystatus') {
          const job = jobs.get(String(q.get('guid') || ''));
          if (!job) return send(res, 200, NOTOK('Unable to locate this GUID in the database'), cors);
          if (job.state === 'pending') return send(res, 200, NOTOK('Pending in queue'), cors);
          if (job.state === 'pass') {
            /* The exact string clients match on. Foundry and hardhat-verify
             * both compare it literally. */
            return send(res, 200, OK('Pass - Verified'), cors);
          }
          return send(res, 200, NOTOK(`Fail - Unable to verify: ${job.error}`), cors);
        }

        if (action === 'getabi') {
          const address = String(q.get('address') || '').toLowerCase();
          const record = /^0x[0-9a-f]{40}$/.test(address) ? await verifier.resolve(address) : null;
          if (!record) return send(res, 200, NOTOK('Contract source code not verified'), cors);
          return send(res, 200, OK(JSON.stringify(record.abi)), cors);
        }

        if (action === 'getsourcecode') {
          const address = String(q.get('address') || '').toLowerCase();
          const record = /^0x[0-9a-f]{40}$/.test(address) ? await verifier.resolve(address) : null;
          if (!record) {
            return send(res, 200, OK([{
              SourceCode: '', ABI: 'Contract source code not verified', ContractName: '',
              CompilerVersion: '', OptimizationUsed: '', Runs: '', ConstructorArguments: '',
              EVMVersion: 'Default', Library: '', LicenseType: 'Unknown', Proxy: '0',
              Implementation: '', SwarmSource: '',
            }]), cors);
          }
          return send(res, 200, OK([{
            SourceCode: '{' + JSON.stringify(record.standardJsonInput) + '}',
            ABI: JSON.stringify(record.abi),
            ContractName: record.contractName,
            CompilerVersion: record.compilerVersion,
            OptimizationUsed: record.optimizationUsed ? '1' : '0',
            Runs: String(record.runs === null ? '' : record.runs),
            ConstructorArguments: (record.constructorArguments || '').replace(/^0x/, ''),
            EVMVersion: record.evmVersion,
            Library: record.libraries
              ? Object.entries(record.libraries).map(([k, v]) => `${k}:${String(v).replace(/^0x/, '')}`).join(';')
              : '',
            LicenseType: record.license,
            Proxy: '0',
            Implementation: '',
            SwarmSource: '',
            HearthMatchType: record.matchType,
            HearthVerifiedAt: record.verifiedAt,
            /* Empty for a directly verified contract. Where it is set, the
             * source above was proven against THAT address's code, and this
             * address carries the same bytes — so `ConstructorArguments` is
             * empty on purpose rather than missing. */
            HearthTwinOf: record.twinOf || '',
          }]), cors);
        }

        return send(res, 200, NOTOK(`Error! Missing Or invalid Action name (${action})`), cors);
      }

      return send(res, 404, { error: 'no such route; try POST /verify, GET /contract/0x…, or /api' }, cors);
    } catch (e) {
      logger.error('request failed', { path: url.pathname, err: e });
      if (!res.headersSent) send(res, 500, { error: String(e.message || e) }, cors);
      else res.end();
    }
  });
}

module.exports = { createServer, submissionFromForm, unwrapStandardJson, LICENSES };
