/* Hearth web ↔ node bridge.
 * Talks to a running hearthd over its HTTP API. If no node is reachable, callers
 * fall back to the demo generator in app.js so the pages still work offline
 * (e.g. opened straight from disk).
 *
 * Node URL resolution order:
 *   ?rpc=<url>  →  <meta name="hearth-rpc">  →  same-origin /rpc  →  :8645
 *
 * Same-origin `/rpc` is the deployed path: nginx proxies it to the node (see
 * web/nginx.conf). It used to guess `<protocol>//<hostname>:8645`, which in
 * production is explorer.cloudsforge.online:8645 — a port nothing publishes.
 * Every call failed, and the pages fell back to the demo generator, so the
 * public explorer showed invented blocks that looked exactly like real ones.
 * The :8645 guess survives only as the last resort, for a page opened straight
 * off disk with a node running locally.
 */
(function (global) {
  'use strict';

  function rpcBase() {
    const q = new URLSearchParams(location.search).get('rpc');
    if (q) return q.replace(/\/$/, '');
    const m = document.querySelector('meta[name="hearth-rpc"]');
    if (m && m.content) return m.content.replace(/\/$/, '');
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin + '/rpc';
    return `${location.protocol}//${location.hostname || 'localhost'}:8645`;
  }

  const BASE = rpcBase();

  const report = (o) => global.HearthObs && global.HearthObs.report(Object.assign({ rpc: BASE }, o));

  async function get(path) {
    const r = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('rpc ' + r.status);
    return r.json();
  }
  async function post(path, body) {
    const r = await fetch(BASE + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.json();
  }

  /** Resolve true if a node answers /info quickly, else false. */
  async function online(timeoutMs = 1200) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(BASE + '/info', { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch (e) {
      // the pages fall back to demo data here, which looks exactly like a
      // working node to a reader — so an unreachable node has to be said aloud
      report({ level: 'warn', type: 'NodeUnreachable', message: String(e && e.message || e) });
      return false;
    }
  }

  /** Subscribe to live blocks via Server-Sent Events. Returns an unsubscribe fn. */
  function onBlock(cb) {
    let es;
    try {
      es = new EventSource(BASE + '/events');
      es.onmessage = (e) => {
        try { cb(JSON.parse(e.data)); }
        catch (err) { report({ type: 'SSEHandlerError', message: String(err && err.message || err), stack: err && err.stack }); }
      };
    } catch (e) {
      report({ level: 'warn', type: 'SSEUnavailable', message: String(e && e.message || e) });
    }
    return () => es && es.close();
  }

  global.HearthAPI = { BASE, get, post, online, onBlock };
})(window);
