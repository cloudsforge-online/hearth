'use strict';
/* Argument parsing for `hearth`.
 *
 * Small on purpose: no dependencies, and one shape of surprise removed. A flag
 * that takes a value must be DECLARED, because `--json --op SSTORE` is
 * unparseable otherwise — a greedy parser eats `--op` as the value of `--json`
 * and a lazy one eats nothing, and the user finds out from a wrong trace rather
 * than an error. So every command hands us the two sets it knows about and
 * anything outside them is rejected by name.
 *
 *   --flag              boolean, must be in `booleans`
 *   --flag=value        always a value, whatever the sets say
 *   --flag value        value form, must be in `strings`
 *   --                  everything after is a positional, verbatim
 *   -h / --help         always accepted
 */

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

/**
 * @param {string[]} argv        tokens, already stripped of node and script
 * @param {object}   spec
 * @param {string[]} spec.booleans   flags that take no value
 * @param {string[]} spec.strings    flags that take exactly one value
 * @param {object}   [spec.alias]    { short: 'long' }
 * @returns {{flags: object, positional: string[]}}
 */
function parse(argv, spec = {}) {
  const booleans = new Set(spec.booleans || []);
  const strings = new Set(spec.strings || []);
  const alias = spec.alias || {};
  booleans.add('help');
  const flags = Object.create(null);
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (tok === '-h') { flags.help = true; continue; }
    if (tok.length < 2 || tok[0] !== '-') { positional.push(tok); continue; }

    let name = tok.replace(/^--?/, '');
    let value = null;
    const eq = name.indexOf('=');
    if (eq !== -1) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    if (alias[name]) name = alias[name];

    if (value !== null) {
      if (!strings.has(name) && !booleans.has(name)) throw new UsageError(`unknown option --${name}`);
      flags[name] = booleans.has(name) && !strings.has(name) ? value !== 'false' && value !== '0' : value;
      continue;
    }
    if (booleans.has(name)) { flags[name] = true; continue; }
    if (strings.has(name)) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      flags[name] = argv[++i];
      continue;
    }
    throw new UsageError(`unknown option --${name}`);
  }
  return { flags, positional };
}

/** A required flag, or a UsageError naming it. */
function need(flags, name, what) {
  const v = flags[name];
  if (v === undefined || v === null || v === '') throw new UsageError(`--${name} is required${what ? ' (' + what + ')' : ''}`);
  return v;
}

/** A flag as a BigInt, accepting decimal and 0x-hex; `def` when absent. */
function bigFlag(flags, name, def = null) {
  const v = flags[name];
  if (v === undefined) return def;
  const s = String(v).trim().replace(/_/g, '');
  try {
    const n = /^0[xX]/.test(s) ? BigInt(s) : BigInt(s);
    if (n < 0n) throw new RangeError('negative');
    return n;
  } catch {
    throw new UsageError(`--${name} must be a non-negative integer, got ${JSON.stringify(String(v))}`);
  }
}

/** A flag as a plain integer; `def` when absent. */
function intFlag(flags, name, def = null) {
  const v = flags[name];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer, got ${JSON.stringify(String(v))}`);
  return n;
}

module.exports = { parse, need, bigFlag, intFlag, UsageError };
