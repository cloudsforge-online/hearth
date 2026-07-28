'use strict';
/* The HTTP surface.
 *
 *   GET|POST /api                the Etherscan-compatible shim (api.js)
 *   GET  /supply/total           a bare decimal number, no JSON, no units
 *   GET  /supply/circulating     the same, with the Commons treasury removed
 *   GET  /supply                 both, labelled, with the methodology
 *   GET  /health                 index lag, node reachability, reorg counters
 *   GET  /                       a page naming every route
 *
 * THE TWO PLAIN-TEXT SUPPLY ROUTES EXIST BECAUSE AGGREGATORS ASK FOR THEM THAT
 * WAY. `docs/listing-checklist.md` §3: "a plain decimal number, no JSON
 * wrapper, no units". They return EMBER by default and wei with `?unit=wei`.
 *
 * /supply/circulating RETURNS AN ERROR RATHER THAN A NUMBER when the Commons
 * treasury cannot be subtracted. An aggregator that gets a 503 retries and
 * eventually emails us; one that gets total supply publishes a figure that is
 * wrong by the treasury balance and nobody finds out. See supply.js.
 */

const http = require('http');
const { logger } = require('./log');
const { formatEmber } = require('./supply');

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

async function readBody(req, limit = 64 * 1024) {
  let text = '', size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    text += chunk;
  }
  return text;
}

function corsHeaders(env, req) {
  const origin = req.headers.origin;
  if (!env.corsOrigins.length) return {};
  if (env.corsOrigins.includes('*')) {
    return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
  }
  if (!origin || !env.corsOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

const PAGE = env => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hearth explorer API</title>
<style>
 body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:4rem auto;padding:0 1rem;background:#12100e;color:#e8e2d9}
 h1{font-size:1.4rem} h2{font-size:1.05rem;margin-top:2rem}
 code,pre{background:#231f1b;padding:.1rem .3rem;border-radius:3px;font-family:ui-monospace,monospace;font-size:.88rem}
 pre{padding:.8rem;overflow-x:auto}
 .warn{border-left:3px solid #c2410c;padding-left:1rem;color:#c9bfb2}
 a{color:#fb923c}
</style>
<h1>Hearth explorer API</h1>
<p class="warn">An Etherscan-compatible <code>/api</code> shim for chain ${env.chainId}.
Point any tool that speaks the Etherscan API at <code>/api</code>; an
<code>apikey</code> parameter is accepted and ignored.</p>

<h2>Supply — what an aggregator should read</h2>
<pre>GET /supply/total          &rarr; a bare decimal, EMBER
GET /supply/circulating    &rarr; total &minus; the Commons treasury
GET /supply?unit=wei       &rarr; both, labelled, with the methodology</pre>
<p><b>Circulating is not total.</b> The Commons treasury accrues 10% of every
block and has no spend path, so it is excluded — see
<code>docs/tokenomics.md</code> §7. If this service cannot subtract it, the
circulating routes return an error rather than a number.</p>

<h2>Etherscan-compatible</h2>
<pre>/api?module=account&amp;action=balance&amp;address=0x…
/api?module=account&amp;action=balancemulti&amp;address=0x…,0x…
/api?module=account&amp;action=txlist&amp;address=0x…&amp;startblock=0&amp;endblock=99999999&amp;sort=asc
/api?module=account&amp;action=tokentx&amp;address=0x…
/api?module=contract&amp;action=getabi&amp;address=0x…
/api?module=contract&amp;action=getsourcecode&amp;address=0x…
/api?module=stats&amp;action=ethsupply
/api?module=stats&amp;action=tokensupply&amp;contractaddress=0x…
/api?module=transaction&amp;action=gettxreceiptstatus&amp;txhash=0x…
/api?module=logs&amp;action=getLogs&amp;address=0x…&amp;fromBlock=0&amp;toBlock=latest
/api?module=proxy&amp;action=eth_blockNumber</pre>

<h2>Two answers that are refusals, on purpose</h2>
<p><code>txlistinternal</code> returns an error, not an empty list: internal
transfers need execution traces and this chain's v1 RPC has none, so "no
results" would be a claim we cannot make. Address queries also refuse while the
index is behind the node, for the same reason.</p>

<p><a href="/health">/health</a></p>`;

function createServer({ env, api, supply, store, indexer, rpc, hydrator }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'explorer-api'}`);
    const cors = corsHeaders(env, req);

    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);

      if (url.pathname === '/api') {
        let q = url.searchParams;
        if (req.method === 'POST') {
          /* Etherscan accepts the same parameters as a form body, and some
           * clients POST because a long `data=` overflows a URL. */
          const body = await readBody(req);
          const ct = String(req.headers['content-type'] || '');
          if (ct.includes('application/json')) {
            try {
              const obj = JSON.parse(body);
              q = new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)]));
            } catch {
              return send(res, 200, { status: '0', message: 'NOTOK', result: 'Error! Malformed JSON body' }, cors);
            }
          } else {
            q = new URLSearchParams(body);
          }
          for (const [k, v] of url.searchParams) if (!q.has(k)) q.append(k, v);
        } else if (req.method !== 'GET') {
          return send(res, 405, { status: '0', message: 'NOTOK', result: 'Error! Use GET or POST' }, { allow: 'GET, POST', ...cors });
        }
        /* ALWAYS HTTP 200, even for a refusal. Etherscan does, and a client
         * that sees a 400 typically retries the whole batch instead of reading
         * the reason we put in `result`. */
        return send(res, 200, await api.handle(q), cors);
      }

      if (url.pathname === '/supply/total' || url.pathname === '/supply/circulating') {
        const wei = url.searchParams.get('unit') === 'wei';
        const s = await supply.read();
        if (url.pathname.endsWith('circulating')) {
          if (s.circulatingWei === null) return send(res, 503, s.unavailable + '\n', cors);
          return send(res, 200, (wei ? s.circulatingWei.toString() : formatEmber(s.circulatingWei)) + '\n', cors);
        }
        return send(res, 200, (wei ? s.totalWei.toString() : formatEmber(s.totalWei)) + '\n', cors);
      }

      if (url.pathname === '/supply') {
        const s = await supply.read();
        return send(res, s.unavailable ? 503 : 200, {
          height: s.height,
          totalSupply: formatEmber(s.totalWei),
          totalSupplyWei: s.totalWei.toString(),
          commonsTreasury: s.commonsWei === null ? null : formatEmber(s.commonsWei),
          commonsTreasuryWei: s.commonsWei === null ? null : s.commonsWei.toString(),
          circulatingSupply: s.circulatingWei === null ? null : formatEmber(s.circulatingWei),
          circulatingSupplyWei: s.circulatingWei === null ? null : s.circulatingWei.toString(),
          maxSupply: null,
          methodology: 'circulating = total − Commons treasury balance. total = Σ subsidy(h) for h = 0..tip. '
            + 'See docs/tokenomics.md §7. The Commons treasury is excluded because it has no spend path; '
            + 'coins disbursed from it become circulating on disbursement.',
          source: s.source,
          unavailable: s.unavailable,
        }, cors);
      }

      if (url.pathname === '/health') {
        const ix = indexer.stats();
        const ok = !ix.parked && ix.lag !== null && ix.lag <= env.maxLagBlocks;
        return send(res, ok ? 200 : 503, {
          ok,
          service: 'hearth-explorer-api',
          chainId: env.chainId,
          rpcUrl: env.rpcUrl,
          index: store.stats(),
          indexer: ix,
          cache: hydrator.stats(),
          rpcCalls: rpc.calls,
          commonsAddressConfigured: !!env.commonsAddress,
          verifyUrl: env.verifyUrl || null,
        }, cors);
      }

      if (url.pathname === '/' && req.method === 'GET') return send(res, 200, PAGE(env), cors);

      return send(res, 404, { error: 'no such route; try /api, /supply or /health' }, cors);
    } catch (e) {
      logger.error('request failed', { path: url.pathname, err: e });
      if (!res.headersSent) send(res, 500, { error: 'internal error' }, cors);
      else res.end();
    }
  });
}

module.exports = { createServer };
