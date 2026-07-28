/* DOM construction helpers.
 *
 * Every string that reaches the page goes through `textContent`. There is no
 * innerHTML in this explorer and there must never be one: almost everything
 * rendered here — a contract's return data, an event's decoded string argument,
 * a miner's extraData — is chosen by whoever sent the transaction, and this page
 * shares an origin with a non-custodial wallet holding real value.
 */

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/** An internal link. Routing is hash-based, so this is a real anchor: it is
 *  middle-clickable, copyable and works with the back button. */
export function link(href, text, cls) {
  const a = el('a', cls, text);
  a.href = href;
  return a;
}

export const blockLink = (n, text) => link('#/block/' + n, text ?? '#' + n, 'x-link mono');
export const txLink = (h, text) => link('#/tx/' + h, text ?? h, 'x-link mono');
export const addrLink = (a, text) => link('#/address/' + a, text ?? a, 'x-link mono');

/** A definition row inside a detail card. `value` may be a node or a string. */
export function kv(parent, label, value, opts = {}) {
  const row = el('div', 'x-kv');
  const k = el('div', 'x-kv-k', label);
  if (opts.hint) k.title = opts.hint;
  const v = el('div', 'x-kv-v' + (opts.mono === false ? '' : ' mono'));
  if (value instanceof Node) v.appendChild(value);
  else v.textContent = value === undefined || value === null ? '—' : String(value);
  if (opts.tone) v.classList.add('x-' + opts.tone);
  row.appendChild(k);
  row.appendChild(v);
  parent.appendChild(row);
  return row;
}

/** A one-line span with a copy button, for hashes and addresses. */
export function copyable(text, opts = {}) {
  const wrap = el('span', 'x-copy');
  const span = el('span', 'x-copy-t' + (opts.break === false ? '' : ' brk'), opts.display ?? text);
  wrap.appendChild(span);
  const btn = el('button', 'x-copy-b', 'copy');
  btn.type = 'button';
  btn.title = 'Copy to clipboard';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(text));
      btn.textContent = 'copied';
    } catch {
      // Clipboard access is refused on an insecure origin and in some embedded
      // views. Select the text instead of silently doing nothing.
      const r = document.createRange();
      r.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      btn.textContent = 'selected';
    }
    setTimeout(() => { btn.textContent = 'copy'; }, 1400);
  });
  wrap.appendChild(btn);
  return wrap;
}

export function card(title, opts = {}) {
  const c = el('div', 'card x-card');
  if (title) {
    const head = el('div', 'x-card-head');
    head.appendChild(el('h3', null, title));
    if (opts.badge) head.appendChild(badge(opts.badge, opts.badgeTone));
    if (opts.aside) head.appendChild(opts.aside);
    c.appendChild(head);
  }
  return c;
}

export function badge(text, tone) {
  return el('span', 'x-badge' + (tone ? ' x-badge-' + tone : ''), text);
}

/**
 * A table. `cols` is an array of header labels; returns the tbody so rows can be
 * appended. Empty tables render an explicit empty state rather than a bare
 * header — "no rows" and "failed to load" look identical otherwise.
 */
export function table(parent, cols, opts = {}) {
  const wrap = el('div', 'x-tablewrap');
  const t = el('table', 'blocks');
  const thead = el('thead');
  const tr = el('tr');
  for (const c of cols) tr.appendChild(el('th', null, c));
  thead.appendChild(tr);
  t.appendChild(thead);
  const tb = el('tbody');
  t.appendChild(tb);
  wrap.appendChild(t);
  parent.appendChild(wrap);
  if (opts.empty) {
    tb.dataset.empty = opts.empty;
  }
  return tb;
}

/** Fill a table body's empty state, if it has one and no rows were added. */
export function finishTable(tb, cols) {
  if (tb.children.length || !tb.dataset.empty) return;
  const tr = el('tr');
  const td = el('td', 'x-empty', tb.dataset.empty);
  td.colSpan = cols;
  tr.appendChild(td);
  tb.appendChild(tr);
}

export function row(tb, cells) {
  const tr = el('tr');
  for (const c of cells) {
    const td = el('td', c && c.cls ? c.cls : null);
    if (c === null || c === undefined) td.textContent = '—';
    else if (c instanceof Node) td.appendChild(c);
    else if (c.node instanceof Node) td.appendChild(c.node);
    else td.textContent = String(c.text ?? c);
    tr.appendChild(td);
  }
  tb.appendChild(tr);
  return tr;
}

export function note(parent, text, tone = 'muted') {
  const p = el('p', 'x-note x-' + tone, text);
  parent.appendChild(p);
  return p;
}

/** A labelled meter, used for gas used against gas limit. */
export function meter(pct, label) {
  const wrap = el('div', 'x-meter');
  const bar = el('div', 'x-meter-bar');
  const fill = el('div', 'x-meter-fill');
  fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (pct >= 95) fill.classList.add('x-meter-hot');
  bar.appendChild(fill);
  wrap.appendChild(bar);
  wrap.appendChild(el('span', 'x-meter-l', label));
  return wrap;
}

/** A block of bytes, wrapped, with a byte count. */
export function hexBlock(hex, opts = {}) {
  const wrap = el('div', 'x-hexblock');
  const body = el('pre', 'x-hex mono');
  body.textContent = hex && hex !== '0x' ? hex : '0x  (empty)';
  if (opts.max) body.classList.add('x-hex-clamp');
  wrap.appendChild(body);
  return wrap;
}

/** Tabs that swap which of a set of panels is visible. Pure DOM, no router. */
export function tabs(parent, panels) {
  const bar = el('div', 'x-tabs');
  const bodies = [];
  panels.forEach((p, i) => {
    const b = el('button', 'x-tab' + (i === 0 ? ' x-tab-on' : ''), p.label);
    b.type = 'button';
    const body = el('div', 'x-tabbody' + (i === 0 ? '' : ' hide'));
    p.render(body);
    bodies.push({ b, body });
    b.addEventListener('click', () => {
      bodies.forEach((x, j) => {
        x.b.classList.toggle('x-tab-on', i === j);
        x.body.classList.toggle('hide', i !== j);
      });
    });
    bar.appendChild(b);
  });
  parent.appendChild(bar);
  for (const x of bodies) parent.appendChild(x.body);
  return bar;
}
