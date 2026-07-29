/* The JSON-RPC client. One transport, one place where an error becomes a type.
 *
 * ENDPOINT RESOLUTION.
 *
 *   ?rpc=<url>  →  <meta name="hearth-eth-rpc">  →  same-origin /eth-rpc/  →  :8545
 *
 * The same-origin default matches web/nginx.conf, which proxies
 * `location /eth-rpc/` to the node's JSON-RPC port and is the reason the
 * deployed explorer talks to the origin it loaded from rather than to a second
 * hostname the CSP would have to allow.
 *
 * IT IS `/eth-rpc/`, NOT `/rpc/`, AND THE DIFFERENCE IS THE WHOLE POINT. The
 * node runs two servers: REST + SSE on 8645 (`/info`, `/events`, `/mining/*`,
 * which assets/api.js and assets/mining/miner.js reach through the `/rpc/`
 * proxy) and Ethereum JSON-RPC on 8545, which is the only one that answers
 * eth_*. This client used to default to `/rpc/`, so every call landed on the
 * REST server, which replies HTTP 404 with `{"err": "this is the REST API — the
 * Ethereum JSON-RPC endpoint is a different port"}`. That parses as JSON and
 * carries neither `result` nor `error`, so `unwrap` raised MalformedResponse and
 * the whole explorer read as a dead chain while the chain was healthy.
 *
 * Three failure modes, three types, because the UI has to tell them apart:
 *   RpcUnreachable  — no answer at all: node down, wrong port, CSP refusal
 *   RpcError        — a JSON-RPC error object: the node answered and said no
 *   MalformedResponse — something answered but it was not this protocol
 */

export class RpcUnreachable extends Error {
  constructor(message, cause) { super(message); this.name = 'RpcUnreachable'; this.cause = cause; }
}
export class RpcError extends Error {
  constructor(code, message, data) { super(message); this.name = 'RpcError'; this.code = code; this.data = data; }
}
export class MalformedResponse extends Error {
  constructor(message) { super(message); this.name = 'MalformedResponse'; }
}

/** JSON-RPC code 3 is `execution reverted`, and `data` carries the revert payload. */
export const EXECUTION_REVERTED = 3;

/**
 * `loc` is injectable so the resolution order can be asserted under node, where
 * there is no `location` at all — see selftest.js. It is the same object shape
 * `window.location` has: `{ search, protocol, origin }`.
 */
export function resolveEndpoint(search, loc = typeof location === 'undefined' ? null : location) {
  const q = new URLSearchParams(search ?? loc?.search ?? '').get('rpc');
  if (q) return q.replace(/\/$/, '') || '/';
  const m = typeof document === 'undefined' ? null : document.querySelector('meta[name="hearth-eth-rpc"]');
  if (m && m.content) return m.content.replace(/\/$/, '') || '/';
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) return loc.origin + '/eth-rpc/';
  return 'http://localhost:8545';
}

let transport = null;         // set by fixtures.js in fixture mode
let endpoint = null;
let nextId = 1;

export function useTransport(fn) { transport = fn; }
export function isFixture() { return transport !== null; }
export function endpointUrl() { return transport ? '(fixtures)' : (endpoint || (endpoint = resolveEndpoint())); }

/** Every request that has gone out, newest last — surfaced in the debug panel. */
export const log = [];
const LOG_MAX = 200;

async function send(payload) {
  const started = performance.now();
  let out;
  if (transport) {
    out = await transport(payload);
  } else {
    const url = endpoint || (endpoint = resolveEndpoint());
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // A CSP refusal, a DNS failure and a dead node all land here, and the
      // browser deliberately does not say which. Say so rather than guess.
      throw new RpcUnreachable('no answer from ' + url, e);
    }
    if (res.status === 204) out = null;
    else {
      const text = await res.text();
      if (!res.ok && !text) throw new RpcUnreachable(`HTTP ${res.status} from ${url}`);
      try { out = JSON.parse(text); } catch {
        throw new MalformedResponse(`HTTP ${res.status}: response was not JSON — ${text.slice(0, 120)}`);
      }
    }
  }
  const ms = performance.now() - started;
  const names = Array.isArray(payload) ? payload.map(p => p.method) : [payload.method];
  log.push({ at: Date.now(), ms: Math.round(ms), methods: names });
  if (log.length > LOG_MAX) log.shift();
  return out;
}

function unwrap(res, method) {
  if (!res || typeof res !== 'object') throw new MalformedResponse(`${method}: empty response`);
  if (res.error) {
    const e = res.error;
    throw new RpcError(e.code, e.message || 'rpc error', e.data);
  }
  if (!('result' in res)) throw new MalformedResponse(`${method}: response carried neither result nor error`);
  return res.result;
}

/** One call. Returns the result; `null` is a legitimate result meaning not-found. */
export async function call(method, params = []) {
  const id = nextId++;
  const res = await send({ jsonrpc: '2.0', id, method, params });
  return unwrap(Array.isArray(res) ? res[0] : res, method);
}

/**
 * A batch. Responses may come back in any order — the spec allows it and the
 * server's own comment says so — so they are matched by id, never by position.
 * Each entry resolves to `{ ok, value }` or `{ ok: false, error }`: one failing
 * call in a batch must not blank an entire page.
 */
export async function batch(calls) {
  if (!calls.length) return [];
  const payload = calls.map(c => ({ jsonrpc: '2.0', id: nextId++, method: c[0], params: c[1] || [] }));
  const res = await send(payload);
  if (!Array.isArray(res)) throw new MalformedResponse('batch: expected an array of responses');
  const byId = new Map(res.map(r => [r && r.id, r]));
  return payload.map(p => {
    const r = byId.get(p.id);
    try { return { ok: true, value: unwrap(r, p.method) }; }
    catch (e) { return { ok: false, error: e }; }
  });
}

/** batch(), but a failed member throws. For calls that must all succeed. */
export async function batchStrict(calls) {
  const out = await batch(calls);
  for (const r of out) if (!r.ok) throw r.error;
  return out.map(r => r.value);
}

/** A call whose "not available" answer is not an error — used for optional probes. */
export async function tryCall(method, params = []) {
  try { return { ok: true, value: await call(method, params) }; }
  catch (e) { return { ok: false, error: e }; }
}

/** Is anything answering? Used once at boot to choose between live and the offline state. */
export async function probe() {
  try {
    const [chainId, height] = await batchStrict([['eth_chainId', []], ['eth_blockNumber', []]]);
    return { ok: true, chainId, height };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** A human sentence for any of the three failure types. */
export function describeError(e) {
  if (e instanceof RpcUnreachable) return 'No node answered at ' + endpointUrl() + '. ' + (e.message || '');
  if (e instanceof MalformedResponse) return 'The endpoint answered, but not with JSON-RPC 2.0: ' + e.message;
  if (e instanceof RpcError) return `The node refused the call (code ${e.code}): ${e.message}`;
  return String(e && e.message || e);
}
