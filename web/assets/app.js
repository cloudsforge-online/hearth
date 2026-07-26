/* Hearth — shared front-end helpers (demo, no backend required)
 * Generates a plausible live-looking chain so the explorer, wallet and
 * landing page feel real when opened from disk. In production these read
 * from a hearthd node over JSON-RPC / WebSocket. */
(function (global) {
  'use strict';

  // deterministic-ish pseudo hash for the demo
  function fakeHash(seed) {
    let x = 0x811c9dc5 ^ seed;
    let out = '';
    for (let i = 0; i < 8; i++) {
      x = Math.imul(x ^ (x >>> 15), 0x2545f491) >>> 0;
      out += ('00000000' + x.toString(16)).slice(-8);
    }
    return out;
  }

  function shortAddr(seed) {
    return 'ember1' + fakeHash(seed).slice(0, 10);
  }

  // ---- rolling demo chain ----------------------------------------
  const BLOCK_TIME = 15; // seconds
  function makeChain(height, count) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const h = height - i;
      rows.push({
        height: h,
        hash: fakeHash(h),
        miner: shortAddr(h * 7 + 3),
        txs: 3 + (fakeHash(h).charCodeAt(0) % 40),
        reward: (6 * Math.pow(2, -(h / (2 * 2103840)))).toFixed(3),
        agoSec: i * BLOCK_TIME,
      });
    }
    return rows;
  }

  function timeAgo(sec) {
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
  }

  // ---- living hearth animation -----------------------------------
  function igniteHearth(el, intensity) {
    if (!el) return;
    const embers = el.querySelector('.embers');
    if (!embers) return;
    embers.innerHTML = '';
    const n = Math.round(6 + (intensity || 1) * 6);
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'ember-dot';
      d.style.left = (35 + Math.random() * 30) + '%';
      d.style.setProperty('--dx', (Math.random() * 30 - 15) + 'px');
      d.style.animationDuration = (2 + Math.random() * 2.5) + 's';
      d.style.animationDelay = (Math.random() * 3) + 's';
      embers.appendChild(d);
    }
  }

  global.Hearth = { fakeHash, shortAddr, makeChain, timeAgo, igniteHearth, BLOCK_TIME };
})(window);
