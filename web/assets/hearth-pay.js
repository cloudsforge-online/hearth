/* Hearth Pay — merchant SDK (web integration)
 * ------------------------------------------------------------------
 * Drop-in "Accept EMBER" button for any website. One script tag, one
 * data-attribute. No custodians, no chargebacks — the customer's Hearth
 * wallet (web or desktop) pays a payment request over the Tab channel
 * layer, and your page gets a callback when it confirms.
 *
 *   <script src="hearth-pay.js"></script>
 *   <div data-hearth-pay data-amount="12.50" data-to="ember1..."
 *        data-label="Coffee"></div>
 *
 * This demo simulates confirmation locally. In production the button
 * opens a hearth: payment URI and the SDK subscribes to the merchant's
 * hearthd node for the settling transaction.
 */
(function (global) {
  'use strict';

  const SCHEME = 'hearth:'; // hearth:pay?to=..&amount=..&label=..

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
    btn.innerHTML = `🔥 Pay ${cfg.amount} EMBER`;
    btn.addEventListener('click', () => pay(el, cfg, uri, btn));
    el.appendChild(btn);
    const small = document.createElement('div');
    small.className = 'muted';
    small.style.cssText = 'font-size:.8rem;margin-top:8px;font-family:var(--mono)';
    small.textContent = uri.slice(0, 46) + '…';
    el.appendChild(small);
  }

  function pay(el, cfg, uri, btn) {
    btn.disabled = true;
    btn.innerHTML = 'Waiting for wallet…';
    // Production: window.location = uri (opens wallet) + subscribe to node.
    // Demo: simulate a Tab-channel instant confirmation.
    const started = performance.now();
    setTimeout(() => {
      const txid = (Math.random().toString(16) + '0000000').slice(2, 18);
      const ms = Math.round(performance.now() - started);
      btn.innerHTML = '✓ Paid';
      btn.style.background = 'linear-gradient(100deg,#57d38c,#2fae6b)';
      const ev = new CustomEvent('hearth:paid', {
        detail: { ...cfg, txid, confirmMs: ms, uri },
      });
      el.dispatchEvent(ev);
      global.dispatchEvent(ev);
    }, 1200);
  }

  function scan(root) {
    (root || document).querySelectorAll('[data-hearth-pay]').forEach(render);
  }

  if (document.readyState !== 'loading') scan();
  else document.addEventListener('DOMContentLoaded', () => scan());

  global.HearthPay = { buildURI, scan, render };
})(window);
