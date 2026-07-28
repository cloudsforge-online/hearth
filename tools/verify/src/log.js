'use strict';
// Same convention as the node and the faucet: pino-shaped JSON in a container,
// prose at a TTY.

const { env } = require('./env');

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
const threshold = LEVELS[env.logLevel] || LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = v instanceof Error ? String(v.message || v) : typeof v === 'bigint' ? String(v) : v;
  }
  if (env.logFormat === 'json') {
    process.stdout.write(JSON.stringify({
      level: LEVELS[level], time: Date.now(), name: 'hearth-verify', msg, ...safe,
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

module.exports = { logger };
