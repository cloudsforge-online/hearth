'use strict';
/* The HTTP surface. Three routes and nothing else.
 *
 *   GET  /health   liveness, balance, and what the limits are set to
 *   POST /drip     { "address": "0x…" }  → { txHash, amount }
 *   GET  /         a one-page form, so a human with a browser is not stuck
 *
 * node:http rather than a framework, matching the rest of the estate: this
 * service exists to be trusted with a funded key, and the smallest possible
 * amount of other people's code is the point.
 *
 * THE ORDER OF CHECKS IN /drip IS DELIBERATE and runs cheapest-first, exactly
 * as the node orders block validation (MAP.md §3.1): parse, then the free
 * local limits, then the two RPC round trips, then the broadcast. Everything an
 * anonymous caller can make this service do is gated behind something it had to
 * pass first.
 */

const http = require('http');
const { parseAddress } = require('./address');
const { logger } = require('./log');

const ONE_EMBER = 10n ** 18n;

/** 18 decimals, printed without floating point. */
function formatEmber(wei) {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / ONE_EMBER;
  const frac = (v % ONE_EMBER).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function readBody(req, limit = 4096) {
  let text = '', size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    text += chunk;
  }
  return text;
}

/**
 * The client's IP, and the one place a faucet is usually wrong.
 *
 * `x-forwarded-for` is a request header — the client writes it. Trusting it
 * unconditionally makes the per-IP limit decorative, because every attacker
 * simply sets a different one per request. Not trusting it behind a reverse
 * proxy makes every user in the world share the proxy's address, so the third
 * visitor is locked out. There is no default that is right in both places, so
 * it is a setting, and it is documented as one.
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      // Leftmost is the original client — correct only because we have said we
      // trust the proxy in front to have rewritten the rest.
      return xff.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function corsHeaders(env, req) {
  const origin = req.headers.origin;
  if (!origin || !env.corsOrigins.length) return {};
  if (!env.corsOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

const PAGE = (env, addr) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hearth faucet</title>
<style>
 body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1rem;background:#12100e;color:#e8e2d9}
 h1{font-size:1.4rem} code{background:#231f1b;padding:.1rem .3rem;border-radius:3px}
 input{width:100%;padding:.6rem;font:inherit;font-family:ui-monospace,monospace;background:#1c1917;color:inherit;border:1px solid #4a4038;border-radius:6px}
 button{margin-top:.8rem;padding:.6rem 1.2rem;font:inherit;background:#c2410c;color:#fff;border:0;border-radius:6px;cursor:pointer}
 #out{margin-top:1.2rem;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.9rem}
 .warn{border-left:3px solid #c2410c;padding-left:1rem;color:#c9bfb2}
</style>
<h1>Hearth testnet faucet</h1>
<p class="warn">Testnet EMBER. It has no value, it is not tradeable, and the chain it
funds may be reset without notice.</p>
<p>Drip: <b>${formatEmber(env.dripWei)} EMBER</b>, once per address per
${Math.round(env.addressCooldownS / 3600)}h. Faucet address: <code>${addr}</code></p>
<form id="f"><input id="a" placeholder="0x…" spellcheck="false" autocomplete="off">
<button>Send me EMBER</button></form>
<div id="out"></div>
<script>
const f=document.getElementById('f'),a=document.getElementById('a'),o=document.getElementById('out');
f.onsubmit=async e=>{e.preventDefault();o.textContent='…';
 try{const r=await fetch('/drip',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({address:a.value})});const j=await r.json();
  o.textContent=r.ok?('sent '+j.amount+' EMBER\\ntx '+j.txHash):('refused: '+j.error);
 }catch(err){o.textContent='request failed: '+err.message}};
</script>`;

/**
 * @param {object} o
 * @param {object} o.env
 * @param {import('./limits').Limits} o.limits
 * @param {import('./sender').Sender} o.sender
 */
function createServer({ env, limits, sender }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'faucet'}`);
    const cors = corsHeaders(env, req);

    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);

      if (url.pathname === '/health') {
        let balance = null, reachable = true, err = null;
        try {
          balance = await sender.balance();
        } catch (e) { reachable = false; err = String(e.message || e); }
        const dry = balance !== null && balance < sender.maxCostWei(env.dripWei) + env.reserveWei;
        return send(res, reachable && !dry ? 200 : 503, {
          ok: reachable && !dry,
          service: 'hearth-faucet',
          faucetAddress: sender.address,
          rpcUrl: env.rpcUrl,
          rpcReachable: reachable,
          rpcError: err,
          chainId: env.chainId,
          balanceEmber: balance === null ? null : formatEmber(balance),
          dry,
          dripEmber: formatEmber(env.dripWei),
          remainingThisWindowEmber: formatEmber(limits.remainingWei()),
          addressCooldownS: env.addressCooldownS,
          ipLimit: env.ipLimit,
        }, cors);
      }

      if (url.pathname === '/' && req.method === 'GET') {
        return send(res, 200, PAGE(env, sender.address), cors);
      }

      if (url.pathname === '/drip') {
        if (req.method !== 'POST') {
          return send(res, 405, { error: 'POST a JSON body: {"address":"0x…"}' }, { allow: 'POST', ...cors });
        }
        return await handleDrip(req, res, { env, limits, sender, cors });
      }

      return send(res, 404, { error: 'no such route; try GET /health or POST /drip' }, cors);
    } catch (e) {
      logger.error('request failed', { path: url.pathname, err: e });
      if (!res.headersSent) send(res, 500, { error: 'internal error' }, cors);
      else res.end();
    }
  });
  return server;
}

async function handleDrip(req, res, { env, limits, sender, cors }) {
  const ip = clientIp(req, env.trustProxy);

  // ---- 1. parse. Free, and rejects most abuse. ----
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: `invalid JSON body: ${e.message}` }, cors);
  }
  if (!payload || typeof payload !== 'object') {
    return send(res, 400, { error: 'expected {"address":"0x…"}' }, cors);
  }
  /* NOTHING ELSE IN THE BODY IS READ. Not an amount, not a token, not a chain
   * id. The drip is a server-side constant and a caller has no way to raise it. */
  const parsed = parseAddress(payload.address);
  if (!parsed.ok) return send(res, 400, { error: parsed.reason }, cors);

  if (parsed.bytes.equals(sender.addressBytes)) {
    return send(res, 400, { error: 'that is the faucet\'s own address' }, cors);
  }

  // ---- 2. local limits. Still free, and this is the reservation. ----
  const reservation = limits.reserve(parsed.address, ip, env.dripWei);
  if (!reservation.ok) {
    logger.info('refused', { reason: reservation.reason, address: parsed.address, ip });
    return send(res, reservation.status, {
      error: reservation.reason,
      retryAfterSeconds: reservation.retryAfterS,
    }, { 'retry-after': String(reservation.retryAfterS), ...cors });
  }

  // From here on, any refusal must release the reservation — otherwise a user
  // who hit a transient RPC error is locked out for a day for nothing.
  const giveBack = () => limits.release(parsed.address, ip, env.dripWei);

  try {
    // ---- 3. is the faucet able to pay? ----
    const balance = await sender.balance();
    const needed = sender.maxCostWei(env.dripWei) + env.reserveWei;
    if (balance < needed) {
      giveBack();
      logger.warn('faucet is dry', {
        balanceEmber: formatEmber(balance), neededEmber: formatEmber(needed), address: sender.address,
      });
      /* An explicit, unambiguous refusal. Not a 500, not a timeout, not a
       * transaction that fails at the node — the caller is told the faucet is
       * out and told where to look. */
      return send(res, 503, {
        error: 'the faucet is out of EMBER',
        detail: `balance ${formatEmber(balance)} EMBER, needs ${formatEmber(needed)} to serve one drip`,
        faucetAddress: sender.address,
      }, { 'retry-after': '3600', ...cors });
    }

    // ---- 4. does the recipient already have enough? ----
    const recipientBalance = await sender.rpc.getBalance(parsed.address);
    if (recipientBalance >= env.maxRecipientBalanceWei) {
      giveBack();
      return send(res, 400, {
        error: `that address already holds ${formatEmber(recipientBalance)} EMBER`,
        detail: `the faucet funds accounts below ${formatEmber(env.maxRecipientBalanceWei)} EMBER`,
      }, cors);
    }

    // ---- 5. broadcast. ----
    const { hash, nonce } = await sender.send(parsed.bytes, env.dripWei);
    logger.info('dripped', {
      to: parsed.address, amountEmber: formatEmber(env.dripWei), txHash: hash, nonce: String(nonce), ip,
    });
    return send(res, 200, {
      ok: true,
      txHash: hash,
      to: parsed.address,
      amount: formatEmber(env.dripWei),
      /* The transaction is broadcast, not mined. Say so — a caller that treats
       * a 200 here as "funded" and immediately deploys will fail on a nonce it
       * cannot pay for. */
      status: 'broadcast — poll eth_getTransactionReceipt until it is non-null',
    }, cors);
  } catch (e) {
    giveBack();
    logger.error('drip failed', { to: parsed.address, err: e });
    return send(res, 502, { error: `could not send: ${String(e.message || e)}` }, cors);
  }
}

module.exports = { createServer, formatEmber, clientIp };
