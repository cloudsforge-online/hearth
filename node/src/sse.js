/* The `/events` stream, held open — and the two things a held-open stream needs
 * that a request/response route does not.
 *
 * Both node implementations serve `GET /events`: the account-model node
 * (src/evmnode.js) and the legacy UTXO one (src/rpc.js). Both did it the same
 * way, in six lines each, and both were missing the same two things. This module
 * exists so the fix is written once rather than twice — a second copy of a
 * connection-lifecycle rule is how the two drift into one of them leaking.
 *
 * ── 1. A CAP, BECAUSE AN OPEN SOCKET IS THE ONE THING A STRANGER CAN SPEND ──
 *
 * `sseClients` was an unbounded `Set`. Every other unbounded structure reachable
 * from an unauthenticated caller in this node is capped and says so —
 * `MAX_TEMPLATES = 256` in src/mining.js ("Bounded so an unauthenticated caller
 * cannot grow this without limit"), `MINING_MAX_CLIENTS = 1_024` in params.js
 * ("A map keyed by something the caller controls is a memory leak unless it is
 * capped") — and this one was not, only because nothing published it. That
 * changes with micro-org#236: the estate's gateway now routes `/events` on
 * `rpc.<apex>`, so the set is reachable from the public internet for the first
 * time.
 *
 * A rate limit does not help here and the gateway's `cf-mining-throttle` is one:
 * it bounds DIALS PER SECOND, and a held connection is not a dial per second —
 * it is one dial, once, that never ends. Two hundred connections opened over two
 * minutes pass every rate limit ever written. The bound that matters for a
 * long-lived stream is a bound on CONCURRENCY, and it belongs in both places:
 * `cf-sse-inflight` per client IP at the gateway (which the node cannot see,
 * because every request arrives from cloudflared's address), and this one on the
 * node's total (which the gateway cannot enforce, because it does not know what
 * else is already attached).
 *
 * Refusal is 503 with `retry-after`, not a queue and not a silent drop of an
 * older client. Evicting the oldest subscriber to admit a new one lets anybody
 * disconnect everybody, which is a worse failure than being told to come back.
 *
 * **A refusal is FATAL to an `EventSource`** — a non-200 sets `readyState` to
 * CLOSED and the browser does not retry — and that is deliberate rather than
 * overlooked. A client that silently retried a full node forever would be
 * indistinguishable from the outage it is in; a client that is told once is one
 * that can fall back and say so, which is what network-site's miner now does.
 *
 * ── 2. A HEARTBEAT, BECAUSE THE STREAM IS SILENT BETWEEN BLOCKS ─────────────
 *
 * The only thing ever written to an idle `/events` stream was `: connected\n\n`,
 * at open, and then nothing until a block landed — a 15-second target on this
 * chain, but an arbitrarily long silence on a node that is not being mined, on a
 * filtered `?app=` record stream, or during any gap in block production.
 *
 * Nothing in this estate's own gateway would close that: Traefik v3 sets no
 * write deadline unless `respondingTimeouts` is configured and
 * `compose/docker-compose.gateway.yml` configures none. **Cloudflare's edge is
 * the clock this node cannot set**, and micro-deploy's `/p2p` block says so in
 * as many words about the WebSocket transport — "CLOUDFLARE IS THE ONE CLOCK
 * THIS FILE CANNOT SET … it is answered by application-level keepalive on
 * Hearth's side". A plain streaming response is owed exactly the same answer,
 * and this is it.
 *
 * The frame is an SSE COMMENT — a line beginning `:` — and not a named event,
 * because a named event would be delivered to `addEventListener` and a `data:`
 * frame would reach `onmessage`. src/rpc.js already documents that trap for
 * block frames: "An SSE frame with `event:` only reaches addEventListener(name),
 * not onmessage — so naming these would have silently stopped every existing
 * client's live updates". A comment reaches neither, which is the point: it
 * keeps the socket warm and is invisible to every client that already exists.
 * network-site's miner refreshes its template on `onmessage`, so a heartbeat
 * that reached it would make every miner in the world re-pull a template on the
 * same 20-second cadence — a self-inflicted version of the template-eviction
 * griefing `cf-mining-throttle` exists to bound.
 *
 * The timer is `unref`'d, following src/ws.js's keepalive: a heartbeat must
 * never be the reason a process refuses to exit.
 */

'use strict';

const P = require('./params.js');

/**
 * Attach one response to a subscriber set as an SSE stream.
 *
 * Returns `true` when the stream is open and `false` when it was refused — the
 * caller has already had its response written either way, so a `false` needs no
 * further handling and is returned only so a caller can count it.
 *
 * @param {object} o
 * @param {import('http').IncomingMessage} o.req
 * @param {import('http').ServerResponse} o.res
 * @param {Set<import('http').ServerResponse>} o.clients
 * @param {(res: import('http').ServerResponse) => void} [o.decorate]
 *   Called after the headers are sent and before the response joins `clients`,
 *   for per-stream filter state. src/rpc.js uses it for `?app=`/`?key=`.
 */
function openSseStream({ req, res, clients, decorate }) {
  if (clients.size >= P.SSE_MAX_CLIENTS) {
    res.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '30',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({
      err: 'too many event subscribers on this node — try again shortly',
      limit: P.SSE_MAX_CLIENTS,
      retryAfterMs: 30_000,
    }));
    return false;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    /* Cloudflare and every intermediate proxy buffer a response by default,
     * which for a stream means the client sees nothing until the buffer fills —
     * i.e. never. This is the header nginx and Cloudflare both honour. */
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  if (decorate) decorate(res);
  clients.add(res);

  /* Comment frames only — see the header. A `data:` frame here would reach every
   * client's `onmessage` and be read as a new block. */
  let beat = null;
  if (P.SSE_HEARTBEAT_MS > 0) {
    beat = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch { close(); }
    }, P.SSE_HEARTBEAT_MS);
    if (beat.unref) beat.unref();
  }

  const close = () => {
    if (beat) { clearInterval(beat); beat = null; }
    clients.delete(res);
  };

  /* `close` on the REQUEST fires when the client goes away; `close` on the
   * RESPONSE fires when this node ends the stream itself, which is what
   * `EvmNode.close()` does on shutdown. Only the first was listened for, so a
   * node that ended its own streams left one live interval per subscriber
   * behind — invisible with `unref`, and a leak all the same. */
  req.on('close', close);
  res.on('close', close);

  return true;
}

module.exports = { openSseStream };
