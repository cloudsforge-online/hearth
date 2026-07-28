/* Hearth Pay — MOCKUP. This does not take a payment.
 * ------------------------------------------------------------------
 * It renders the merchant button an "Accept EMBER" SDK would render, builds a
 * real `hearth:` payment URI from the data attributes, and then **simulates**
 * settlement on a timer. No wallet is opened, no transaction is broadcast, no
 * node is consulted, and the txid it reports is invented.
 *
 * The file is named, labelled and evented for exactly that. It used to be called
 * hearth-pay.js, emit `hearth:paid`, and hand back a `Math.random()` txid after
 * 1200ms — while the site sold it as "a two-line Accept EMBER SDK". Anyone
 * copying those two lines onto a real shop would have shipped a checkout that
 * tells every visitor "Paid" and receives nothing. The disclaimer belongs in the
 * artifact, not only in a page footer.
 *
 * A real SDK needs three things this does not have: a wallet handoff (open the
 * URI and learn whether anything happened), a node to watch, and a merchant-side
 * check that the transaction paying `to` is for `amount` and is buried deeply
 * enough to act on. The node already exposes what the third one needs —
 * `GET /address/:addr` reports per-UTXO height and `GET /tx/:txid` reports
 * confirmations — so the missing piece is the wallet handoff, not the chain.
 *
 *   <script src="hearth-pay-demo.js"></script>
 *   <div data-hearth-pay-demo data-amount="12.50" data-to="ember1..."
 *        data-label="Coffee"></div>
 *   window.addEventListener('hearth:demo-paid', e => …)   // e.detail.demo === true
 */
(function (global) {
  'use strict';

  const SCHEME = 'hearth:'; // hearth:pay/<to>?amount=..&label=..&memo=..

  function buildURI({ to, amount, label, memo }) {
    const q = new URLSearchParams();
    q.set('amount', amount);
    if (label) q.set('label', label);
    if (memo) q.set('memo', memo);
    return `${SCHEME}pay/${to}?${q.toString()}`;
  }

  function render(el) {
    const cfg = {
      to: el.dataset.to,
      amount: el.dataset.amount,
      label: el.dataset.label || 'Payment',
      memo: el.dataset.memo || '',
    };
    const uri = buildURI(cfg);
    el.innerHTML = '';

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = `Simulate paying ${cfg.amount} EMBER`;
    btn.addEventListener('click', () => pay(el, cfg, uri, btn));
    el.appendChild(btn);

    // Said on the control itself, so it survives being screenshotted, embedded
    // or read without the surrounding page.
    const warn = document.createElement('div');
    warn.className = 'muted';
    warn.style.cssText = 'font-size:.8rem;margin-top:8px';
    warn.textContent = 'Demo only — nothing is charged, nothing is broadcast, and the '
      + 'confirmation it reports is fabricated.';
    el.appendChild(warn);

    const small = document.createElement('div');
    small.className = 'muted';
    small.style.cssText = 'font-size:.8rem;margin-top:6px;font-family:var(--mono)';
    small.textContent = uri.slice(0, 46) + '…';
    el.appendChild(small);
  }

  function pay(el, cfg, uri, btn) {
    btn.disabled = true;
    btn.textContent = 'Pretending to wait for a wallet…';
    const started = performance.now();
    setTimeout(() => {
      // Deliberately NOT 64 hex characters. A real txid is, and this must never
      // be mistaken for one — by a reader or by a paste into the explorer.
      const txid = 'demo-not-a-real-txid-' + Math.random().toString(16).slice(2, 10);
      const ms = Math.round(performance.now() - started);
      btn.textContent = 'Demo settled — no payment was made';
      const ev = new CustomEvent('hearth:demo-paid', {
        detail: { ...cfg, txid, confirmMs: ms, uri, demo: true },
      });
      el.dispatchEvent(ev);
      global.dispatchEvent(ev);
    }, 1200);
  }

  function scan(root) {
    (root || document).querySelectorAll('[data-hearth-pay-demo]').forEach(render);
  }

  if (document.readyState !== 'loading') scan();
  else document.addEventListener('DOMContentLoaded', () => scan());

  global.HearthPayDemo = { buildURI, scan, render };
})(window);
