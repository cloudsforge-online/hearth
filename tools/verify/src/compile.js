'use strict';
/* Driving solc.
 *
 * WHY A CHILD PROCESS. Three reasons, each of which alone would be enough:
 *
 *   1. A `solidity_compile` call is SYNCHRONOUS and cannot be interrupted.
 *      In-process, a pathological submission blocks the event loop until it
 *      finishes — the HTTP surface stops answering, /health included. A child
 *      can be killed at a deadline.
 *   2. An emscripten heap GROWS AND NEVER SHRINKS, and a long-lived verifier
 *      would accumulate one per compiler version it has ever loaded. A process
 *      per compile hands the memory back to the operating system.
 *   3. This is the only place in either service that executes code chosen by
 *      an anonymous caller. Putting it behind a process boundary is the
 *      cheapest isolation available and costs about 400 ms of startup.
 *
 * The settings are normalised rather than trusted: whatever the submitter
 * sends, the output selection is overwritten with what a comparison needs.
 * `immutableReferences` in particular is easy to omit and impossible to work
 * around — without it an immutable-bearing contract can never match.
 */

const path = require('path');
const { spawn } = require('child_process');

const CHILD = path.join(__dirname, 'compile-child.js');

/** Everything a bytecode comparison needs, and nothing more. */
const OUTPUT_SELECTION = {
  '*': {
    '*': [
      'abi',
      'metadata',
      'evm.bytecode.object',
      'evm.bytecode.linkReferences',
      'evm.deployedBytecode.object',
      'evm.deployedBytecode.linkReferences',
      'evm.deployedBytecode.immutableReferences',
    ],
  },
};

class CompileError extends Error {}

/**
 * Build a standard-JSON input from a submission.
 *
 * @param {object} s
 * @param {object} [s.standardJsonInput]  a complete input, used as-is (modulo
 *   outputSelection). This is the form `forge verify-contract` and Hardhat
 *   send, and the only form that reproduces a multi-file project exactly.
 * @param {string} [s.sourceCode]         a single flattened file
 * @param {string} [s.sourceName]         its path, default `Contract.sol`
 * @param {boolean} [s.optimizationUsed]
 * @param {number} [s.runs]
 * @param {string} [s.evmVersion]
 * @param {object} [s.libraries]          { "file.sol:Lib": "0x…" }
 */
function buildInput(s) {
  let input;
  if (s.standardJsonInput) {
    input = JSON.parse(JSON.stringify(s.standardJsonInput));
    if (input.language && input.language !== 'Solidity') {
      throw new CompileError(
        `language ${input.language} is not supported. This verifier compiles Solidity only — `
        + 'Vyper and standalone Yul are out of scope and are refused rather than mis-verified.',
      );
    }
    input.language = 'Solidity';
    input.settings = input.settings || {};
  } else {
    if (typeof s.sourceCode !== 'string' || !s.sourceCode.trim()) {
      throw new CompileError('supply either standardJsonInput or sourceCode');
    }
    input = {
      language: 'Solidity',
      sources: { [s.sourceName || 'Contract.sol']: { content: s.sourceCode } },
      settings: {},
    };
  }

  if (!input.sources || typeof input.sources !== 'object' || Object.keys(input.sources).length === 0) {
    throw new CompileError('the standard-JSON input has no sources');
  }
  for (const [name, src] of Object.entries(input.sources)) {
    if (!src || typeof src.content !== 'string') {
      /* `urls` would make the compiler read the local filesystem. The child
       * passes no import callback, so this could not work anyway — refusing by
       * name gives a submitter an error they can act on. */
      throw new CompileError(`source ${name} must carry inline \`content\`; \`urls\` are not read`);
    }
  }

  // Single-file submissions carry the settings as separate fields, the way
  // Etherscan's form does. A standard-JSON submission carries its own and they
  // are left alone.
  if (!s.standardJsonInput) {
    input.settings.optimizer = { enabled: !!s.optimizationUsed, runs: Number(s.runs || 200) };
    if (s.evmVersion && s.evmVersion !== 'Default' && s.evmVersion !== 'default') {
      input.settings.evmVersion = s.evmVersion;
    }
  }
  if (s.libraries && Object.keys(s.libraries).length) {
    input.settings.libraries = toSolcLibraries(s.libraries, input.sources);
  }
  input.settings.outputSelection = OUTPUT_SELECTION;
  return input;
}

/**
 * solc wants `{ "file.sol": { "Lib": "0x…" } }`. Submissions arrive as
 * `{ "file.sol:Lib": "0x…" }` (Etherscan, Foundry) or as a bare `{ "Lib": … }`
 * when the submitter did not know the file. The bare form is resolved against
 * the sources only when it is unambiguous — guessing which file a library
 * lives in would link the wrong address.
 */
function toSolcLibraries(libs, sources) {
  const out = {};
  for (const [key, address] of Object.entries(libs)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) {
      throw new CompileError(`library ${key} needs a 0x address, got ${address}`);
    }
    const at = key.lastIndexOf(':');
    if (at > 0) {
      const file = key.slice(0, at), name = key.slice(at + 1);
      out[file] = out[file] || {};
      out[file][name] = address;
      continue;
    }
    const candidates = Object.keys(sources).filter(f => new RegExp(`\\b(library|contract)\\s+${key}\\b`).test(sources[f].content));
    if (candidates.length !== 1) {
      throw new CompileError(
        `library "${key}" has no file. Give it as "path/to/File.sol:${key}" — `
        + `${candidates.length} sources declare that name, so it cannot be resolved.`,
      );
    }
    out[candidates[0]] = out[candidates[0]] || {};
    out[candidates[0]][key] = address;
  }
  return out;
}

/**
 * Compile in a child process.
 * @returns {Promise<{output: object, version: string, ms: number}>}
 */
function compile({ soljson, input, timeoutMs = 180_000, maxBuffer = 256 * 1024 * 1024 }) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', size = 0, killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', d => {
      size += d.length;
      if (size > maxBuffer) { killed = true; child.kill('SIGKILL'); return; }
      out += d;
    });
    child.stderr.on('data', d => { err += d; });

    child.on('error', e => { clearTimeout(timer); reject(new CompileError(`could not start solc: ${e.message}`)); });

    child.on('close', code => {
      clearTimeout(timer);
      if (killed) {
        return reject(new CompileError(
          size > maxBuffer
            ? `solc produced more than ${maxBuffer} bytes of output`
            : `solc did not finish within ${timeoutMs}ms and was killed`,
        ));
      }
      if (code !== 0) {
        // A non-zero exit from a compiler that reports its own errors on stdout
        // is a crash — out of memory, most often.
        return reject(new CompileError(`solc exited with code ${code}${err ? `: ${err.slice(0, 500)}` : ''}`));
      }
      let parsed;
      try { parsed = JSON.parse(out); } catch (e) {
        return reject(new CompileError(`solc produced unparseable output: ${e.message}`));
      }
      if (!parsed.ok) return reject(new CompileError(parsed.error));
      let output;
      try { output = JSON.parse(parsed.output); } catch (e) {
        return reject(new CompileError(`solc produced unparseable standard-JSON: ${e.message}`));
      }
      resolve({ output, version: parsed.version, ms: Date.now() - started });
    });

    child.stdin.end(JSON.stringify({ soljson, input }));
  });
}

/** solc reports warnings and errors in one array; only `severity: error` fails. */
function errorsOf(output) {
  return (output.errors || []).filter(e => e.severity === 'error');
}

module.exports = { compile, buildInput, toSolcLibraries, errorsOf, CompileError, OUTPUT_SELECTION };
