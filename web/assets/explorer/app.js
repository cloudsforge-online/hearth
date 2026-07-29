/* Router, boot and the search box.
 *
 * Routes live in the hash so this stays a static file served by nginx with no
 * try_files rewrite — web/nginx.conf deliberately answers a bad path with a 404
 * rather than with index.html, and a path-routed explorer would need the
 * opposite. Every link is a real anchor: middle-clickable, copyable, and the
 * back button works.
 */

import * as rpc from './rpc.js';
import * as V from './views.js';
import { el, clear, link } from './dom.js';
import { classifyQuery } from './search.js';
import { chainId, chainName } from '../chain.js';

const outlet = document.getElementById('view');
const modePill = document.getElementById('mode');
const banner = document.getElementById('banner');
const searchInput = document.getElementById('q');
const searchForm = document.getElementById('searchForm');
const searchMsg = document.getElementById('searchMsg');

let FIXTURE_TOUR = null;
let refreshTimer = null;

// ---- mode ------------------------------------------------------------------

function setMode(kind, text) {
  modePill.textContent = text;
  modePill.className = 'pill x-mode x-mode-' + kind;
}

function showBanner(nodes) {
  clear(banner);
  banner.classList.remove('hide');
  for (const n of nodes) banner.appendChild(n);
}

// ---- routing ---------------------------------------------------------------

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = {};
  if (query) for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { view: parts[0] || 'home', arg: parts[1] ? decodeURIComponent(parts[1]) : null, params };
}

const ROUTES = {
  home: (root) => V.home(root),
  blocks: (root, arg, params) => V.blockList(root, params),
  block: (root, arg) => V.block(root, arg),
  tx: (root, arg) => V.transaction(root, arg),
  address: (root, arg, params) => V.address(root, arg, params),
  token: (root, arg) => V.token(root, arg),
  tokens: (root) => V.tokens(root),
  logs: (root, arg, params) => V.logs(root, params),
  supply: (root, arg, params) => V.supply(root, params),
  gallery: (root) => V.gallery(root, FIXTURE_TOUR),
};

let renderToken = 0;

async function render(quiet = false) {
  const { view, arg, params } = parseHash();
  const mine = ++renderToken;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  const fn = ROUTES[view];
  // On the home page's own refresh the old content stays put until the new
  // content is ready; flashing a loading state under a reader every 12 seconds
  // is worse than a slightly stale number.
  if (!quiet) {
    clear(outlet);
    outlet.appendChild(el('div', 'x-loading', 'Reading the chain…'));
  }
  markNav(view);

  if (!fn) {
    clear(outlet);
    V.errorState(outlet, new Error('No such view: ' + view), 'Unknown page');
    return;
  }
  if (view === 'gallery' && !FIXTURE_TOUR) {
    clear(outlet);
    const c = el('div', 'card');
    c.appendChild(el('h3', null, 'The gallery is fixture-only'));
    c.appendChild(el('p', null, 'It links to canned transactions and addresses that exist only in '
      + 'the fixture chain. Open it with fixtures enabled.'));
    const a = link('?fixtures=1#/gallery', 'Open the fixture gallery', 'btn btn-ghost');
    c.appendChild(a);
    outlet.appendChild(c);
    return;
  }

  const root = el('div');
  try {
    await fn(root, arg, params);
    if (mine !== renderToken) return;      // a newer navigation won
    clear(outlet);
    outlet.appendChild(root);
  } catch (e) {
    if (mine !== renderToken) return;
    clear(outlet);
    V.errorState(outlet, e, 'Could not load this page');
    if (window.HearthObs) {
      window.HearthObs.report({ type: 'ExplorerViewError', message: String(e && e.message || e), view });
    }
  }

  if (view === 'home') {
    // The chain moves; the front page should too. Every other view is a point in
    // time and re-rendering it under the reader would be hostile.
    refreshTimer = setInterval(() => {
      if (parseHash().view === 'home' && !document.hidden) render(true);
    }, 12000);
  }
}

function markNav(view) {
  for (const a of document.querySelectorAll('[data-view]')) {
    a.classList.toggle('x-nav-on', a.dataset.view === view);
  }
}

// ---- search ----------------------------------------------------------------

/**
 * One box, four shapes, dispatched on form.
 *
 * A 0x-prefixed 64-hex string is ambiguous — a transaction hash and a block hash
 * are the same shape — so both are asked in ONE batch and whichever answers
 * wins. Asking sequentially would be a round trip slower for every block hash
 * anyone ever pastes.
 */
async function search(raw) {
  clear(searchMsg);
  const q = classifyQuery(raw);

  if (q.kind === 'empty') return;
  if (q.kind === 'height') { location.hash = '#/block/' + q.value; return; }
  if (q.kind === 'address') {
    // A failed checksum is said out loud and then followed anyway: the reader
    // may have retyped one character, and refusing to look would hide the very
    // thing that is wrong.
    if (q.checksumFailed) {
      searchMsg.appendChild(el('div', 'x-warn',
        '⚠ That address does not pass its own EIP-55 checksum — one character may be wrong. '
        + 'Showing it anyway.'));
    }
    location.hash = '#/address/' + q.value;
    return;
  }
  if (q.kind === 'event') { location.hash = '#/logs?event=' + encodeURIComponent(q.value); return; }
  if (q.kind !== 'hash') {
    searchMsg.appendChild(el('div', 'x-bad',
      '✗ Not a block height, a 0x address, a 0x hash, or an event signature.'));
    return;
  }

  const h = q.value;
  searchMsg.appendChild(el('div', 'x-mute', 'Looking up ' + h + '…'));
  try {
    const [tx, block] = await rpc.batch([
      ['eth_getTransactionByHash', [h]],
      ['eth_getBlockByHash', [h, false]],
    ]);
    clear(searchMsg);
    if (tx.ok && tx.value) { location.hash = '#/tx/' + h; return; }
    if (block.ok && block.value) { location.hash = '#/block/' + h; return; }
    searchMsg.appendChild(el('div', 'x-bad',
      '✗ Nothing on this chain has that hash — not a transaction and not a block.'));
  } catch (e) {
    clear(searchMsg);
    searchMsg.appendChild(el('div', 'x-bad', '✗ ' + rpc.describeError(e)));
  }
}

// ---- boot ------------------------------------------------------------------

async function boot() {
  const qs = new URLSearchParams(location.search);
  const fixtures = qs.get('fixtures');

  if (fixtures) {
    const F = await import('./fixtures.js');
    FIXTURE_TOUR = F.TOUR;
    rpc.useTransport(fixtures === 'down' ? F.deadTransport : F.fixtureTransport);
    if (fixtures === 'down') {
      setMode('bad', '● FIXTURES — simulating an unreachable node');
      showBanner([
        el('strong', null, 'Fixture mode, with the node deliberately unreachable. '),
        el('span', null, 'Every view below will fail, which is the point: this is what the explorer '
          + 'does when there is no chain to read. It invents nothing.'),
      ]);
    } else {
      setMode('warn', '● FIXTURES — canned data, no chain');
      showBanner([
        el('strong', null, 'Nothing on this page is real. '),
        el('span', null, 'The chain is not running, so these blocks, transactions and balances come '
          + 'from a canned set of JSON-RPC responses in assets/explorer/fixtures.js. They exist so '
          + 'every view — including the failure states — can be reviewed before the account-model '
          + 'chain ships. '),
        link('#/gallery', 'Open the gallery of every state', 'x-link'),
      ]);
    }
    window.addEventListener('hashchange', render);
    render();
    return;
  }

  setMode('warn', '● connecting…');
  const probe = await rpc.probe();
  if (probe.ok) {
    const seen = parseInt(probe.chainId, 16);
    // The expected id is deployment configuration (../chain.js), not a literal:
    // one image serves the testnet and, later, mainnet. It is compared against
    // the node's answer and never replaced by it.
    const want = chainId();
    setMode('ok', '● LIVE — chain ' + seen);
    if (seen !== want) {
      showBanner([
        el('strong', null, `This is not chain ${want}. `),
        el('span', null, `The node at ${rpc.endpointUrl()} reports chain id ${seen} `
          + `(${chainName(seen)}). This explorer is configured for ${want} `
          + `(${chainName(want)}, docs/evm-spec.md §1) — you are looking at a different network.`),
      ]);
    }
  } else {
    setMode('bad', '● NO NODE — nothing below is invented');
    showBanner([
      el('strong', null, 'No node answered at ' + rpc.endpointUrl() + '. '),
      el('span', null, rpc.describeError(probe.error) + ' '),
      el('span', null, 'This explorer does not fall back to invented blocks. Point it at a node with '),
      el('code', 'mono', '?rpc=<url>'),
      el('span', null, ', or '),
      link('?fixtures=1#/gallery', 'browse the canned fixture chain', 'x-link'),
      el('span', null, ' to see what every view looks like.'),
    ]);
  }

  window.addEventListener('hashchange', render);
  render();
}

searchForm.addEventListener('submit', ev => { ev.preventDefault(); search(searchInput.value); });

document.getElementById('endpoint').textContent = rpc.endpointUrl();

boot().catch(e => {
  setMode('bad', '● explorer failed to start');
  clear(outlet);
  V.errorState(outlet, e, 'The explorer could not start');
});
