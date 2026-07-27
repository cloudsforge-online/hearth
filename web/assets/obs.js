/* Hearth web — browser error reporting.
 *
 * Until this existed, a failure in these pages produced no record anywhere: a
 * throw was a blank panel, and nobody found out unless someone described it.
 * Errors now go to the console and, best effort, to Lantern's /ingest/client.
 *
 * A plain-JS translation of the stack's canonical `web-obs.tsx`. These pages
 * are hand-written and have no bundler, so it cannot simply be imported — fix
 * the canonical copy first, then mirror it here.
 */
(function (global) {
  'use strict';

  const KNOWN_SUBS = new Set([
    'play', 'admin', 'hearth', 'mint', 'nimbus', 'account', 'api', 'pay',
    'explorer', 'vault', 'lantern', 'www',
  ]);

  const APP = 'hearth-web';

  /* Resolved in the browser, never baked in at build time, so one copy of these
   * files serves localhost, a preview host and production alike. */
  function lanternUrl() {
    const host = location.hostname;
    if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
      return 'http://localhost:4010';
    }
    const parts = host.split('.');
    const apex = parts.length > 2 && KNOWN_SUBS.has(parts[0]) ? parts.slice(1).join('.') : host;
    return 'https://lantern.' + apex;
  }

  // One broken handler can fire the same error hundreds of times a second.
  // Report each distinct fault once per session and cap the total: the point is
  // to learn that it happened, not to flood the log service from the browser.
  const seen = new Set();
  let sent = 0;
  const MAX_REPORTS = 40;

  /** Best effort by design: reporting a failure must never cause one. */
  function report(payload) {
    try {
      const key = (payload.type || '') + '|' + payload.message + '|' + String(payload.stack || '').slice(0, 200);
      if (seen.has(key) || sent >= MAX_REPORTS) return;
      seen.add(key);
      sent++;

      console.error('[hearth]', payload.type || 'Error', payload.message, payload.stack || '');

      const body = JSON.stringify(Object.assign({
        app: APP,
        level: 'error',
        url: location.href,
        route: location.pathname,
      }, payload));

      const endpoint = lanternUrl() + '/ingest/client';

      // sendBeacon survives the page being torn down, which is exactly when the
      // interesting errors happen. It cannot set a content type, so the server
      // parses the body without relying on one.
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;

      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true,
        mode: 'cors',
      }).catch(function () {
        // Lantern being unreachable is not the reader's problem and must not
        // surface as one.
      });
    } catch (e) {
      // Ditto for anything above throwing.
    }
  }

  // Errors nobody caught, and rejected promises nobody awaited. Both silent before.
  global.addEventListener('error', function (event) {
    // failed <img>/<script> loads arrive here too and are not page faults
    if (!event.error && !event.message) return;
    report({
      type: (event.error && event.error.name) || 'WindowError',
      message: (event.error && event.error.message) || event.message,
      stack: (event.error && event.error.stack) || (event.filename + ':' + event.lineno + ':' + event.colno),
    });
  });

  global.addEventListener('unhandledrejection', function (event) {
    const reason = event.reason;
    report({
      type: (reason && reason.name) || 'UnhandledRejection',
      message: (reason && reason.message) || String(reason),
      stack: (reason && reason.stack) || null,
    });
  });

  global.HearthObs = { report: report, lanternUrl: lanternUrl };
})(window);
