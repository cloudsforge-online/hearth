/* Hearth web ↔ node bridge.
 * Talks to a running hearthd over its HTTP API. If no node is reachable, callers
 * fall back to the demo generator in app.js so the pages still work offline
 * (e.g. opened straight from disk).
 *
 * Node URL resolution order:  ?rpc=<url>  →  <meta name="hearth-rpc">  →  :8645
 */
(function (global) {
  'use strict';

  function rpcBase() {
    const q = new URLSearchParams(location.search).get('rpc');
    if (q) return q.replace(/\/$/, '');
    const m = document.querySelector('meta[name="hearth-rpc"]');
    if (m && m.content) return m.content.replace(/\/$/, '');
    return `${location.protocol}//${location.hostname || 'localhost'}:8645`;
  }

  const BASE = rpcBase();

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
    } catch { return false; }
  }

  /** Subscribe to live blocks via Server-Sent Events. Returns an unsubscribe fn. */
  function onBlock(cb) {
    let es;
    try {
      es = new EventSource(BASE + '/events');
      es.onmessage = (e) => { try { cb(JSON.parse(e.data)); } catch {} };
    } catch { /* SSE unsupported */ }
    return () => es && es.close();
  }

  global.HearthAPI = { BASE, get, post, online, onBlock };
})(window);
