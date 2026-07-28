'use strict';
// Configuration, read once at boot. Everything except the key has a default
// that works; the key has no default and never will.

const fs = require('fs');
const path = require('path');

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
};

/** EMBER has 18 decimals (docs/evm-spec.md §1). Parse without floating point. */
function ember(v, fallback) {
  const s = String(v === undefined || v === '' ? fallback : v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not an EMBER amount: ${s}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 18) throw new Error(`more than 18 decimal places: ${s}`);
  return BigInt(whole + frac.padEnd(18, '0'));
}

/**
 * THE KEY. There is exactly one way in and it is an environment variable, or a
 * file named by one. Three rules, and each exists because of a specific way
 * faucet keys leak:
 *
 *   1. No default, and no start without it. A faucet that boots with a
 *      generated key looks healthy and silently funds nobody.
 *   2. The key file may NOT live inside this git repository. `.env` is
 *      gitignored, but `git add -f`, an editor backup, a `cp` to a scratch
 *      file and a subsequent `git add .` all defeat that. Refusing any path
 *      under the working tree is a rule that cannot be defeated by a habit.
 *   3. It is never logged, never echoed, never included in an error message
 *      and never served on /health. Only the derived address is.
 */
function readKey() {
  const inline = process.env.HEARTH_FAUCET_PRIVATE_KEY;
  const file = process.env.HEARTH_FAUCET_KEY_FILE;

  if (inline && file) {
    throw new Error('set HEARTH_FAUCET_PRIVATE_KEY or HEARTH_FAUCET_KEY_FILE, not both');
  }

  let hex;
  if (inline) {
    hex = inline.trim();
  } else if (file) {
    const abs = path.resolve(file);
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    if (abs.startsWith(repoRoot + path.sep)) {
      throw new Error(
        `HEARTH_FAUCET_KEY_FILE points inside the repository (${abs}).\n`
        + '  Refusing. Put it somewhere a `git add` cannot reach — ~/.hearth/faucet.key,\n'
        + '  a mounted secret, or your platform\'s secret store.',
      );
    }
    const stat = fs.statSync(abs);
    // 0o077 = any permission for group or other.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(`${abs} is readable by group or other (mode ${(stat.mode & 0o777).toString(8)}). chmod 600 it.`);
    }
    hex = fs.readFileSync(abs, 'utf8').trim();
  } else {
    throw new Error(
      'no faucet key.\n'
      + '  Set HEARTH_FAUCET_PRIVATE_KEY=0x<64 hex>, or HEARTH_FAUCET_KEY_FILE=/path/outside/the/repo.\n'
      + '  See tools/faucet/README.md — and tools/faucet/.env.example, which contains\n'
      + '  a deliberately invalid placeholder rather than a working key.',
    );
  }

  const clean = hex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    // Note the absence of the value in this message.
    throw new Error('the faucet key is not 32 bytes of hex');
  }
  return Buffer.from(clean, 'hex');
}

const env = {
  port: num(process.env.HEARTH_FAUCET_PORT, 8646 + 1000),   // 9646
  host: process.env.HEARTH_FAUCET_HOST || '127.0.0.1',

  /* The node to send through. There is no public Hearth endpoint yet — phase 5
   * has not landed — so this has no useful default and the faucet will simply
   * fail its first health check against a URL that answers nothing. */
  rpcUrl: process.env.HEARTH_RPC_URL || 'http://127.0.0.1:8645',

  chainId: num(process.env.HEARTH_CHAIN_ID, 7411),

  /* THE DRIP IS FIXED AND IS NEVER TAKEN FROM THE REQUEST. A caller supplies
   * an address and nothing else. Every faucet that has ever been drained let
   * the caller influence the amount. */
  dripWei: ember(process.env.HEARTH_FAUCET_DRIP_EMBER, '10'),

  gasPriceWei: BigInt(process.env.HEARTH_FAUCET_GAS_PRICE_WEI || '1000000000'),   // 1 gwei
  /** A plain value transfer is exactly 21,000 gas — no calldata, no creation. */
  gasLimit: 21000n,

  /* Per-address cooldown. The primary control, and the only one an honest user
   * ever meets. */
  addressCooldownS: num(process.env.HEARTH_FAUCET_ADDRESS_COOLDOWN_S, 86400),

  /* Per-IP limit. Weak on its own — anyone with an IPv6 /64 has more addresses
   * than the chain has blocks — but it stops the lazy case at zero cost. */
  ipLimit: num(process.env.HEARTH_FAUCET_IP_LIMIT, 3),
  ipWindowS: num(process.env.HEARTH_FAUCET_IP_WINDOW_S, 86400),

  /* THE CONTROL THAT ACTUALLY BOUNDS THE LOSS. Address and IP limits both
   * assume the attacker is finite. This one does not care: however many
   * addresses and however many IPs, the faucet cannot pay out more than this
   * per rolling window, full stop. */
  dailyCapWei: ember(process.env.HEARTH_FAUCET_DAILY_CAP_EMBER, '1000'),
  dailyWindowS: num(process.env.HEARTH_FAUCET_DAILY_WINDOW_S, 86400),

  /* Refuse an address that is already funded. A faucet exists to unblock
   * someone who has nothing; topping up someone who has plenty is pure leak. */
  maxRecipientBalanceWei: ember(process.env.HEARTH_FAUCET_MAX_BALANCE_EMBER, '100'),

  /* Keep a reserve so the faucet stops cleanly instead of broadcasting
   * transactions that fail the balance check at the node. */
  reserveWei: ember(process.env.HEARTH_FAUCET_RESERVE_EMBER, '1'),

  /* X-Forwarded-For is a request header: a client sets it. Trust it ONLY when
   * something in front of you overwrites it. Behind nginx and off, every user
   * shares the proxy's IP and the per-IP limit locks the whole world out after
   * three drips. Directly exposed and on, the per-IP limit is decorative. */
  trustProxy: bool(process.env.HEARTH_FAUCET_TRUST_PROXY, false),

  /* Limiter state on disk. Without it a restart is a reset, and "restart the
   * faucet" is a thing that happens on every deploy. */
  statePath: process.env.HEARTH_FAUCET_STATE || path.join(process.cwd(), 'faucet-state.json'),

  logLevel: process.env.HEARTH_FAUCET_LOG_LEVEL || 'info',
  logFormat: process.env.HEARTH_FAUCET_LOG_FORMAT || (process.stdout.isTTY ? 'pretty' : 'json'),

  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
};

module.exports = { env, readKey, ember, num, bool };
