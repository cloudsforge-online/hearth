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
      /* solc's offsets for the immutable slots, kept so the runtime index can
       * mask a stranger's code exactly the way this comparison masked ours.
       * Nothing on a contract page reads it; recovering it later would mean a
       * full recompile, and it is a few dozen bytes. */
      immutableReferences: (evm.deployedBytecode || {}).immutableReferences || null,
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
    /* Index by the code itself, so the next address carrying these exact bytes
     * inherits this source without anybody re-submitting it. See the long note
     * in `store.js`. The write is best-effort on purpose: the record above is
     * already on disk, and failing the submission now would tell the submitter
     * their verification did not happen when it did. */
    try {
      this.store.indexRuntime({
        address: lower,
        runtimeCode: onchain,
        immutableReferences: (evm.deployedBytecode || {}).immutableReferences,
      });
    } catch (e) {
      logger.warn('runtime index not written', { address: lower, error: String(e.message || e) });
    }
    logger.info('verified', {
      address: lower, contract: `${picked.file}:${picked.name}`, matchType: record.matchType,
      compiler: record.compilerVersion, ms: compiled.ms,
    });
    return record;
  }

  /**
   * The source for an address: verified there, or inherited from a twin.
   *
   * This is what every read path should call instead of `store.get`. A direct
   * record always wins — it is the stronger claim, since it was checked against
   * that address's own code and may carry constructor arguments a derived record
   * cannot have. Only when there is none does the deployed code get looked up in
   * the runtime index.
   *
   * Returns null the same way `store.get` does, so a caller that treats a miss
   * as "not verified" needs no other change.
   */
  async resolve(address) {
    const lower = String(address || '').toLowerCase();
    if (!ADDR_RE.test(lower)) return null;

    const direct = this.store.get(lower);
    if (direct) return direct;

    let onchain;
    try {
      onchain = await this.rpc.getCode(lower, 'latest');
    } catch (e) {
      /* The node is the thing that failed, not the lookup. Saying "not verified"
       * here would be a claim about the contract that we did not check. */
      logger.warn('could not read code while resolving', { address: lower, error: String(e.message || e) });
      return null;
    }
    if (!onchain || norm(onchain).length === 0) return null;

    const twin = this.store.findByRuntime(onchain);
    if (!twin) return null;
    return derivedRecord({ address: lower, twin });
  }

  /**
   * Index the records that were verified before the index existed.
   *
   * Without this, the runtime index only covers contracts verified after the
   * upgrade, and the first customer whose token would have resolved against an
   * older submission still reads as an anonymous blob — a silent gap that looks
   * exactly like the bug this index fixes.
   *
   * Best-effort, and it re-reads the chain rather than trusting the record: the
   * index has to key on the bytes that are deployed NOW, which is what a lookup
   * will present. Records verified against a since-self-destructed address are
   * skipped rather than indexed against nothing.
   */
  async backfillIndex() {
    const pending = this.store.unindexed();
    if (!pending.length) return { indexed: 0, skipped: 0, pending: 0 };
    let indexed = 0, skipped = 0;
    for (const address of pending) {
      const record = this.store.get(address);
      if (!record) { skipped++; continue; }
      let onchain;
      try {
        onchain = await this.rpc.getCode(address, 'latest');
      } catch (e) {
        logger.warn('backfill could not read code', { address, error: String(e.message || e) });
        skipped++;
        continue;
      }
      if (!onchain || norm(onchain).length === 0) { skipped++; continue; }
      try {
        this.store.indexRuntime({
          address,
          runtimeCode: onchain,
          /* Null for records written by a build that did not keep them. Such a
           * record still gets its exact key, which is the case that matters for
           * a factory; only the immutables-differ case is lost, and only until
           * somebody re-verifies. */
          immutableReferences: record.immutableReferences,
        });
        indexed++;
      } catch (e) {
        logger.warn('backfill could not write the index', { address, error: String(e.message || e) });
        skipped++;
      }
    }
    return { indexed, skipped, pending: pending.length };
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

/**
 * A verified twin's record, restated as a claim about a different address.
 *
 * The source, the compiler, the settings and the ABI transfer intact: they are
 * properties of the CODE, and the code is the same code. Everything that is a
 * property of the DEPLOYMENT does not transfer, and is cleared rather than
 * copied — a derived record that carried the twin's constructor arguments would
 * be stating this token's supply and name as the other token's, which is the one
 * thing about a factory-built contract that is guaranteed to be different.
 *
 * `verifiedAt` stays the twin's. It is when the source was proven against these
 * bytes, and no proof happened at this address.
 */
function derivedRecord({ address, twin }) {
  const r = twin.record;
  return {
    ...r,
    address,
    matchType: twin.match === 'exact' ? 'twin-exact' : 'twin-immutables',
    // These are read off THIS address's code, not copied. With an exact match
    // they are identical to the twin's by definition; with an immutables match
    // they are exactly what differs.
    immutableRanges: twin.immutableRanges,
    immutableValues: twin.immutableValues,
    constructorArguments: null,
    constructorArgumentsVerified: false,
    constructorArgumentsNote:
      'not checked: this source was verified at another address with the same runtime bytecode, and '
      + 'runtime bytecode does not carry constructor arguments. Verify this address directly, with its '
      + 'creation transaction, to check them.',
    creationTxHash: null,
    twinOf: r.address,
    twinSourceMatchType: r.matchType,
  };
}

module.exports = {
  Verifier, VerifyError, VERIFIER_VERSION, licenseFrom, allContracts, derivedRecord,
};
