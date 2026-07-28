'use strict';
// pino-shaped JSON in a container, prose at a TTY — the same convention the
// node uses (node/src/node.js), so one log pipeline reads both.

const { env } = require('./env');

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
const threshold = LEVELS[env.logLevel] || LEVELS.info;

/* Exact-match redaction.
 *
 * The first version of this matched /[0-9a-f]{64}/ — anything key-shaped — and
 * it redacted every TRANSACTION HASH the faucet logged, which are the one
 * thing an operator needs from these lines. A pattern that broad is worse than
 * useless: it destroys signal while still missing a key that arrives in some
 * other encoding.
 *
 * So the secret is registered explicitly at boot and matched exactly. There is
 * precisely one, we hold it, and there is no reason to guess. */
const secrets = new Set();

/** Register a value that must never appear in a log line. */
function protect(value) {
  if (!value) return;
  const hex = Buffer.isBuffer(value) ? value.toString('hex') : String(value).replace(/^0x/i, '');
  if (hex.length < 16) return;   // too short to be a secret, too likely to be a substring
  secrets.add(hex.toLowerCase());
  secrets.add('0x' + hex.toLowerCase());
  secrets.add(hex.toUpperCase());
  secrets.add('0x' + hex.toUpperCase());
}

function scrub(value) {
  if (value instanceof Error) value = value.message;
  if (typeof value !== 'string') return value;
  let out = value;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('[redacted]');
  return out;
}

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const safe = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = scrub(v);
  if (env.logFormat === 'json') {
    process.stdout.write(JSON.stringify({
      level: LEVELS[level], time: Date.now(), name: 'hearth-faucet', msg, ...safe,
    }) + '\n');
  } else {
    const extra = Object.keys(safe).length ? '  ' + JSON.stringify(safe) : '';
    process.stdout.write(`${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`);
  }
}

const logger = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};

module.exports = { logger, protect };
