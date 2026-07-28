'use strict';
/* Configuration, read once at boot. */

const path = require('path');

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return v === '1' || String(v).toLowerCase() === 'true';
};

const env = {
  port: num(process.env.HEARTH_VERIFY_PORT, 9648),
  host: process.env.HEARTH_VERIFY_HOST || '127.0.0.1',

  /** The eth_* endpoint. `eth_getCode` is the only method this service calls,
   *  plus `eth_getTransactionByHash` when a creation transaction is supplied. */
  rpcUrl: process.env.HEARTH_RPC_URL || 'http://127.0.0.1:8545',
  chainId: num(process.env.HEARTH_CHAIN_ID, 7411),

  /** Verified records. One JSON file per address; see store.js. */
  dataDir: process.env.HEARTH_VERIFY_DATA || path.join(process.cwd(), 'verified'),

  /* Where soljson-v*.js builds live. They are large (≈9 MB each) and are
   * downloaded on demand from binaries.soliditylang.org, then checked against
   * the keccak256 in that server's own list.json BEFORE being loaded — this
   * process `require`s them, so an unverified download is arbitrary code
   * execution. */
  solcDir: process.env.HEARTH_VERIFY_SOLC_DIR || path.join(process.cwd(), '.solc-cache'),
  solcListUrl: process.env.HEARTH_VERIFY_SOLC_LIST_URL || 'https://binaries.soliditylang.org/bin/list.json',
  solcBinBase: process.env.HEARTH_VERIFY_SOLC_BIN_BASE || 'https://binaries.soliditylang.org/bin',
  /** Refuse to fetch anything. Only compilers already in solcDir are usable. */
  solcOffline: bool(process.env.HEARTH_VERIFY_SOLC_OFFLINE, false),
  /** Nightlies are not reproducible in the way a release is. Off by default. */
  solcAllowNightly: bool(process.env.HEARTH_VERIFY_SOLC_ALLOW_NIGHTLY, false),
  solcListTtlMs: num(process.env.HEARTH_VERIFY_SOLC_LIST_TTL_MS, 24 * 3600 * 1000),

  /** A compile runs in a child process and is killed at this deadline. */
  compileTimeoutMs: num(process.env.HEARTH_VERIFY_COMPILE_TIMEOUT_MS, 180_000),
  /** solc output for a large project is megabytes of JSON. */
  compileMaxBuffer: num(process.env.HEARTH_VERIFY_COMPILE_MAX_BUFFER, 256 * 1024 * 1024),

  /** Largest submission accepted. A standard-JSON input for a big project is
   *  a few hundred kB; 8 MB is generous and still bounded. */
  maxBodyBytes: num(process.env.HEARTH_VERIFY_MAX_BODY, 8 * 1024 * 1024),

  /** One verification at a time by default: a solc process is CPU- and
   *  memory-hungry, and letting anonymous callers start N of them is the
   *  denial-of-service surface of this service. */
  concurrency: num(process.env.HEARTH_VERIFY_CONCURRENCY, 1),
  queueLimit: num(process.env.HEARTH_VERIFY_QUEUE_LIMIT, 32),

  /** Re-verifying an already-verified address is refused unless this is set. */
  allowOverwrite: bool(process.env.HEARTH_VERIFY_ALLOW_OVERWRITE, false),

  logLevel: process.env.HEARTH_VERIFY_LOG_LEVEL || 'info',
  logFormat: process.env.HEARTH_VERIFY_LOG_FORMAT || (process.stdout.isTTY ? 'pretty' : 'json'),

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
};

module.exports = { env, num, bool };
