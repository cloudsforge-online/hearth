'use strict';
/* The verification itself: fetch, recompile, compare, record.
 *
 * THE ONLY CLAIM THIS SERVICE EVER MAKES is "compiling this source with this
 * compiler and these settings produces the code at this address". Everything
 * it cannot check is named in the record rather than left to be assumed —
 * `matchType`, `metadataMatched`, `constructorArgumentsVerified` and
 * `immutableValues` all exist so that a reader can tell exactly how strong the
 * claim is.
 *
 * A verifier that cannot reject is worse than none, so every step that could
 * pass by accident fails closed: no code at the address is a refusal, a
 * compile error is a refusal, an ambiguous contract name is a refusal, and an
 * unlinked library is a refusal.
 */

const { compile, buildInput, errorsOf, CompileError } = require('./compile');
const { compareRuntime, checkConstructorArguments, norm } = require('./bytecode');
const { SolcError } = require('./solc');
const { logger } = require('./log');

const VERIFIER_VERSION = '0.1.0';

class VerifyError extends Error {
  constructor(message, detail) { super(message); this.name = 'VerifyError'; this.detail = detail; }
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** The SPDX line solc requires, so a submitter rarely needs to send a licence. */
function licenseFrom(sources) {
  for (const src of Object.values(sources || {})) {
    const m = /SPDX-License-Identifier:\s*([^\s*/]+)/.exec(src.content || '');
    if (m) return m[1];
  }
  return null;
}

/** Every `file.sol:Name` in a standard-JSON output. */
function allContracts(output) {
  const out = [];
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, c] of Object.entries(contracts)) out.push({ file, name, contract: c });
  }
  return out;
}

class Verifier {
  constructor({ env, rpc, registry, store }) {
    this.env = env;
    this.rpc = rpc;
    this.registry = registry;
    this.store = store;
    this.running = 0;
    this.queued = 0;
    this.completed = 0;
    this.rejected = 0;
  }

  /** Bounded concurrency: a solc process is expensive and this is unauthenticated. */
  async submit(submission) {
    if (this.queued >= this.env.queueLimit) {
      throw new VerifyError(`the verification queue is full (${this.env.queueLimit}); try again shortly`);
    }
    this.queued++;
    try {
      while (this.running >= this.env.concurrency) {
        await new Promise(r => setTimeout(r, 50));
      }
      this.running++;
      try {
        const record = await this.verify(submission);
        this.completed++;
        return record;
      } catch (e) {
        this.rejected++;
        throw e;
      } finally {
        this.running--;
      }
    } finally {
      this.queued--;
    }
  }

  async verify(s) {
    const address = String(s.address || '').trim();
    if (!ADDR_RE.test(address)) throw new VerifyError('address must be 0x followed by 40 hex characters');
    const lower = address.toLowerCase();

    const existing = this.store.get(lower);
    if (existing && !this.env.allowOverwrite) {
      throw new VerifyError(
        `${lower} is already verified as ${existing.contractName} (${existing.matchType} match, `
        + `${existing.verifiedAt}). Re-verification is off; set HEARTH_VERIFY_ALLOW_OVERWRITE=1 to replace it.`,
      );
    }

    // ---- 1. what is actually deployed -------------------------------------
    let onchain;
    try {
      onchain = await this.rpc.getCode(lower, 'latest');
    } catch (e) {
      throw new VerifyError(`could not read the code at ${lower}: ${String(e.message || e)}`);
    }
    if (!onchain || norm(onchain).length === 0) {
      throw new VerifyError(
        `there is no code at ${lower}. Nothing is deployed there, it is an externally-owned account, `
        + 'or the contract self-destructed.',
      );
    }

    // ---- 2. the exact compiler --------------------------------------------
    let solc;
    try {
      solc = await this.registry.ensure(s.compilerVersion);
    } catch (e) {
      if (e instanceof SolcError) throw new VerifyError(e.message);
      throw e;
    }

    // ---- 3. recompile ------------------------------------------------------
    let input;
    try {
      input = buildInput(s);
    } catch (e) {
      if (e instanceof CompileError) throw new VerifyError(e.message);
      throw e;
    }

    let compiled;
    try {
      compiled = await compile({
        soljson: solc.path,
        input,
        timeoutMs: this.env.compileTimeoutMs,
        maxBuffer: this.env.compileMaxBuffer,
      });
    } catch (e) {
      throw new VerifyError(`compilation failed: ${String(e.message || e)}`);
    }

    const errors = errorsOf(compiled.output);
    if (errors.length) {
      throw new VerifyError(
        'the source does not compile with the compiler and settings given:\n'
        + errors.map(e => '  ' + (e.formattedMessage || e.message).trim()).join('\n'),
        { errors: errors.map(e => e.formattedMessage || e.message) },
      );
    }

    // ---- 4. which contract? ------------------------------------------------
    const candidates = allContracts(compiled.output);
    if (candidates.length === 0) throw new VerifyError('the sources compiled to no contracts at all');

    const picked = this._pick(candidates, s.contractName, onchain);

    // ---- 5. the comparison -------------------------------------------------
    const evm = picked.contract.evm || {};
    const deployed = (evm.deployedBytecode || {}).object || '';
    const result = compareRuntime({
      onchain,
      compiled: deployed,
      immutableReferences: (evm.deployedBytecode || {}).immutableReferences,
      linkReferences: (evm.deployedBytecode || {}).linkReferences,
    });

    if (!result.matched) {
      throw new VerifyError(`${picked.file}:${picked.name} does not match: ${result.reason}`, result.detail);
    }

    // ---- 6. constructor arguments -----------------------------------------
    let creationInput = null;
    if (s.creationTxHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(s.creationTxHash))) {
        throw new VerifyError('creationTxHash must be 0x followed by 64 hex characters');
      }
      const tx = await this.rpc.getTransactionByHash(String(s.creationTxHash).toLowerCase()).catch(() => null);
      if (!tx) throw new VerifyError(`creation transaction ${s.creationTxHash} was not found`);
      if (tx.to !== null && tx.to !== undefined) {
        throw new VerifyError(
          `${s.creationTxHash} has a \`to\` address, so it is not a contract creation. A contract deployed `
          + 'by a factory has no top-level creation transaction and its constructor arguments cannot be '
          + 'checked this way.',
        );
      }
      creationInput = tx.input;
    }
    const args = checkConstructorArguments({
      creationInput,
      compiledCreation: (evm.bytecode || {}).object || '',
      declared: s.constructorArguments,
    });
    if (args.contradiction) {
      /* The bytecode matched, but the submitter told us something the
       * deployment disproves. Recording it as "unverified" would leave a wrong
       * value on the contract page; the honest response is to refuse the whole
       * submission and let them correct it. */
      throw new VerifyError(`the runtime bytecode matches, but ${args.reason}`);
    }

    // ---- 7. record ---------------------------------------------------------
    const meta = safeJson(picked.contract.metadata);
    const settings = (meta && meta.settings) || {};
    const record = {
      address: lower,
      chainId: this.env.chainId,
      contractName: picked.name,
      sourceName: picked.file,
      // The compiler's own account of itself, not the submitter's.
      compilerVersion: 'v' + compiled.version.replace('.Emscripten.clang', ''),
      compilerKeccak256: solc.build.keccak256,
      evmVersion: settings.evmVersion || 'default',
      optimizationUsed: !!(settings.optimizer && settings.optimizer.enabled),
      runs: settings.optimizer ? settings.optimizer.runs : null,
      metadataBytecodeHash: (settings.metadata && settings.metadata.bytecodeHash) || 'ipfs',
      matchType: result.matchType,
      metadataMatched: result.metadataMatched,
      immutableRanges: result.immutableRanges,
      immutableValues: result.immutableValues,
      constructorArguments: args.arguments,
      constructorArgumentsVerified: args.verified,
      constructorArgumentsNote: args.reason,
      creationTxHash: s.creationTxHash ? String(s.creationTxHash).toLowerCase() : null,
      libraries: s.libraries || (input.settings && input.settings.libraries) || null,
      license: s.license || licenseFrom(input.sources) || 'Unknown',
      abi: picked.contract.abi || [],
      standardJsonInput: input,
      verifiedAt: new Date().toISOString(),
      verifier: `hearth-verify/${VERIFIER_VERSION}`,
      compileMs: compiled.ms,
      warnings: (compiled.output.errors || [])
        .filter(e => e.severity !== 'error')
        .map(e => (e.formattedMessage || e.message).trim())
        .slice(0, 50),
    };
    this.store.put(record);
    logger.info('verified', {
      address: lower, contract: `${picked.file}:${picked.name}`, matchType: record.matchType,
      compiler: record.compilerVersion, ms: compiled.ms,
    });
    return record;
  }

  /**
   * Choose the contract to compare.
   *
   * With a name, that name and no other — including when the name is ambiguous
   * across files, which is a refusal rather than a coin toss. Without one, every
   * compiled contract is tried and the one whose runtime bytecode matches wins;
   * that is a convenience, not a weakening, because a match is a match.
   */
  _pick(candidates, contractName, onchain) {
    if (contractName) {
      const raw = String(contractName).trim();
      const at = raw.lastIndexOf(':');
      const file = at > 0 ? raw.slice(0, at) : null;
      const name = at > 0 ? raw.slice(at + 1) : raw;
      const hits = candidates.filter(c => c.name === name && (!file || c.file === file));
      if (hits.length === 0) {
        throw new VerifyError(
          `no contract named ${raw} in these sources. Found: `
          + candidates.map(c => `${c.file}:${c.name}`).join(', '),
        );
      }
      if (hits.length > 1) {
        throw new VerifyError(
          `${name} is declared in more than one source. Name it as "path/File.sol:${name}". Candidates: `
          + hits.map(c => `${c.file}:${c.name}`).join(', '),
        );
      }
      return hits[0];
    }

    const on = norm(onchain);
    for (const c of candidates) {
      const evm = c.contract.evm || {};
      const r = compareRuntime({
        onchain: on,
        compiled: (evm.deployedBytecode || {}).object || '',
        immutableReferences: (evm.deployedBytecode || {}).immutableReferences,
        linkReferences: (evm.deployedBytecode || {}).linkReferences,
      });
      if (r.matched) return c;
    }
    throw new VerifyError(
      'no contractName was given and none of the compiled contracts matches the deployed code. '
      + `Tried: ${candidates.map(c => `${c.file}:${c.name}`).join(', ')}`,
    );
  }

  stats() {
    return {
      verified: this.store.count,
      running: this.running,
      queued: this.queued,
      completed: this.completed,
      rejected: this.rejected,
    };
  }
}

function safeJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = { Verifier, VerifyError, VERIFIER_VERSION, licenseFrom, allContracts };
