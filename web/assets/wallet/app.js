/* The wallet page: panels, reads, and the send path.
 *
 * Everything that can be tested without a browser lives somewhere else —
 * secp256k1.js, rlp.js, transaction.js, amount.js, keystore.js — and is checked
 * by assets/wallet-selftest.js against the node's own modules. This file is the
 * part that can only be exercised by clicking, so it is kept as thin as it can
 * be: it reads fields, calls those modules, and puts strings on screen.
 *
 * Three rules it follows throughout:
 *
 *   - Nothing is ever invented. If a read fails the page says which read and
 *     why; there is no fallback to plausible-looking numbers. Fixture mode is
 *     the one exception and it is opt-in from the URL and labelled on screen.
 *   - Every amount is BigInt from the moment it leaves the RPC to the moment it
 *     is formatted. One EMBER is 10^18 wei and a double is exact to 2^53.
 *   - The private key is never written into the DOM except by the button called
 *     "Reveal private key", which re-asks for the passphrase rather than using
 *     the copy already unlocked in memory.
 */

import * as rpc from '../explorer/rpc.js';
import { el, clear } from '../explorer/dom.js';
import {
  toBig, qty, formatEmber, formatUnitsExact, formatGwei, formatInt, timeAgo, shorten,
  toChecksumAddress,
} from '../explorer/format.js';
import * as KS from './keystore.js';
import * as T from './transaction.js';
import { parseAddress } from './account.js';
import { parseEmber, parseGwei, parseInteger, GWEI } from './amount.js';
import { chainName } from '../chain.js';

const $ = id => document.getElementById(id);
const show = (node, on) => node.classList.toggle('hide', !on);

/* Deployment configuration, resolved once in ../chain.js and threaded through
 * transaction.js so the id this page BANNERS on and the id it SIGNS with cannot
 * be different numbers. */
const CHAIN_ID = T.CHAIN_ID;
const DEFAULT_GAS_PRICE_WEI = 10n * GWEI;     // only used if the node offers nothing
const PLAIN_TRANSFER_GAS = 21_000n;
const HISTORY_WINDOW = 200;                   // blocks per scan pass
const HISTORY_BATCH = 20;                     // blocks per JSON-RPC batch
const RECEIPT_POLL_MS = 3_000;
const RECEIPT_GIVE_UP_MS = 10 * 60 * 1000;

let account = null;             // the unlocked account, or null
let tip = 0;
let chainOk = false;
let fixtures = null;            // the fixtures module, in fixture mode
let gasPriceTouched = false;
let sendArmed = false;          // "press again to send anyway" after a warning
let scanFrom = null;            // oldest block scanned so far
let historyRows = [];

// ---- small helpers ---------------------------------------------------------

function setMode(text, tone) {
  const m = $('mode');
  m.textContent = text;
  m.style.color = tone === 'ok' ? 'var(--ok)' : tone === 'bad' ? 'var(--ember-400)' : 'var(--gold-300)';
}

function banner(text) {
  $('bannerText').textContent = text;
  show($('banner'), true);
}

function logLine(box, text, cls) {
  const d = el('div', cls, text);
  box.appendChild(d);
  return d;
}

/** Run a slow step with the button disabled — PBKDF2 and signing both take a moment. */
async function working(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}

async function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

const PANELS = ['offline', 'preEvm', 'lock', 'unreadable', 'setup', 'app'];
function panel(name) { for (const p of PANELS) show($(p), p === name); }

function readNewPassphrase(a, b, box) {
  clear(box);
  const p1 = $(a).value, p2 = $(b).value;
  if (p1.length < 8) { logLine(box, '✗ passphrase must be at least 8 characters', 'bad'); return null; }
  if (p1 !== p2) { logLine(box, '✗ the two passphrases do not match', 'bad'); return null; }
  return p1;
}

// ---- the locally-sent log --------------------------------------------------
/* The chain has no address index (docs/evm-spec.md §6), so a transaction sent
 * from here can drop out of the scan window and look as though it never
 * happened. What this wallet sent, it remembers — hashes only, no key material —
 * and merges into the table. */

const logKey = () => 'hearth.wallet.v3.sent.' + account.address.toLowerCase();

function readSent() {
  try { return JSON.parse(localStorage.getItem(logKey()) || '[]'); } catch { return []; }
}

function rememberSent(entry) {
  const all = [entry, ...readSent().filter(e => e.hash !== entry.hash)].slice(0, 50);
  localStorage.setItem(logKey(), JSON.stringify(all));
}

function updateSent(hash, patch) {
  const all = readSent().map(e => (e.hash === hash ? { ...e, ...patch } : e));
  localStorage.setItem(logKey(), JSON.stringify(all));
}

// ---- reads -----------------------------------------------------------------

async function probeChain() {
  // In fixture mode the pill already says so, and must go on saying so: the one
  // thing this page must never do is look live when it is not.
  if (!rpc.isFixture()) setMode('● connecting…', 'warn');
  const probe = await rpc.probe();
  if (!probe.ok) {
    chainOk = false;
    setMode(rpc.isFixture() ? '● FIXTURES — no node, deliberately' : '● no node', 'bad');
    $('offlineWhy').textContent = rpc.describeError(probe.error);
    panel('offline');
    return false;
  }
  const id = Number(toBig(probe.chainId));
  tip = Number(toBig(probe.height));
  chainOk = true;
  if (id !== CHAIN_ID) {
    setMode('● wrong chain — ' + id, 'bad');
    banner(`The node at ${rpc.endpointUrl()} reports chain id ${id} (${chainName(id)}). This wallet `
      + `is configured for ${CHAIN_ID} (${chainName(CHAIN_ID)}, docs/evm-spec.md §1). Signing here `
      + 'would produce transactions that chain rejects, so point the page somewhere else with '
      + '?rpc=<url> before using it. The configured id is deliberately not taken from the node: a '
      + 'link that aimed this page at somebody else\'s RPC would otherwise choose what you sign for.');
  } else if (rpc.isFixture()) {
    setMode('● FIXTURES — canned data, no chain', 'warn');
  } else {
    setMode('● LIVE — chain ' + id + ' @ ' + rpc.endpointUrl(), 'ok');
  }
  return true;
}

async function refresh() {
  if (!account || !chainOk) return;
  try {
    const [balance, nonce, height, gasPrice] = await rpc.batchStrict([
      ['eth_getBalance', [account.address, 'latest']],
      // 'pending' counts what is already in flight. Asking for 'latest' after
      // sending builds the next transaction with a nonce the last one used, and
      // the node answers "nonce too low" for something the wallet did to itself.
      ['eth_getTransactionCount', [account.address, 'pending']],
      ['eth_blockNumber', []],
      ['eth_gasPrice', []],
    ]);
    const wei = toBig(balance);
    tip = Number(toBig(height));
    $('bal').textContent = formatEmber(wei, 6);
    $('balWei').textContent = formatInt(wei);
    $('balSub').textContent = wei === 0n
      ? 'no EMBER yet — mine to this address or receive a payment'
      : formatUnitsExact(wei) + ' EMBER exactly';
    $('nonce').textContent = formatInt(toBig(nonce));
    $('height').textContent = '#' + formatInt(tip);
    $('chainIdLbl').textContent = String(CHAIN_ID);
    $('gasPriceLbl').textContent = formatGwei(toBig(gasPrice)) + ' gwei';
    if (!gasPriceTouched) $('gasPrice').value = formatGwei(toBig(gasPrice));
    updateTotals();
    if (scanFrom === null) await scanHistory(true);
    else renderHistory();
  } catch (e) {
    $('balSub').textContent = rpc.describeError(e);
    setMode('● read failed', 'bad');
  }
}

// ---- history ---------------------------------------------------------------

/**
 * A bounded backwards walk. There is no `eth_getTransactionsByAddress` and there
 * cannot cheaply be one (docs/evm-spec.md §6), so this asks for whole blocks
 * with their transactions and filters locally. Batched, and bounded, because the
 * naive version of this is a thousand round trips to a stranger's node.
 */
async function scanHistory(reset = false) {
  if (!account || !chainOk) return;
  if (reset) { historyRows = []; scanFrom = tip + 1; }
  const to = scanFrom - 1;
  const from = Math.max(0, to - HISTORY_WINDOW + 1);
  if (to < 0) return;
  const btn = $('histMoreBtn');
  await working(btn, 'Scanning…', async () => {
    const me = account.address.toLowerCase();
    for (let start = to; start >= from; start -= HISTORY_BATCH) {
      const calls = [];
      for (let n = start; n > start - HISTORY_BATCH && n >= from; n--) {
        calls.push(['eth_getBlockByNumber', [qty(n), true]]);
      }
      const out = await rpc.batch(calls);
      for (const r of out) {
        if (!r.ok || !r.value) continue;
        const b = r.value;
        for (const t of b.transactions || []) {
          if (typeof t === 'string') continue;      // a node that ignored fullTx
          const f = String(t.from || '').toLowerCase();
          const dest = String(t.to || '').toLowerCase();
          if (f !== me && dest !== me) continue;
          historyRows.push({
            hash: t.hash,
            block: Number(toBig(b.number)),
            timestamp: Number(toBig(b.timestamp)),
            out: f === me,
            other: f === me ? t.to : t.from,
            value: toBig(t.value),
            status: null,
          });
        }
      }
    }
    scanFrom = from;
  });
  renderHistory();
}

function renderHistory() {
  const tb = clear($('histBody'));
  const pending = readSent().filter(e => !historyRows.some(r => r.hash === e.hash));
  const rows = [
    ...pending.map(e => ({
      hash: e.hash, block: e.block ?? null, timestamp: Math.floor(e.at / 1000),
      out: true, other: e.to, value: BigInt(e.value), status: e.status ?? null,
      local: true,
    })),
    ...historyRows,
  ].sort((a, b) => (b.block ?? Infinity) - (a.block ?? Infinity));

  $('histRange').textContent = scanFrom === null ? ''
    : `scanned blocks ${formatInt(scanFrom)}–${formatInt(tip)}`;

  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'nothing involving this address in the blocks scanned so far');
    td.colSpan = 6;
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }

  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', 'muted', r.block === null ? 'pending' : timeAgo(r.timestamp)));
    const hashTd = el('td');
    hashTd.appendChild(el('span', 'mono', shorten(r.hash, 12, 8)));
    tr.appendChild(hashTd);
    tr.appendChild(el('td', r.out ? 'bad' : 'good', r.out ? 'sent' : 'received'));
    tr.appendChild(el('td', 'muted mono', r.other ? shorten(toChecksumAddress(r.other), 12, 6) : 'contract creation'));
    tr.appendChild(el('td', null, (r.out ? '−' : '+') + formatEmber(r.value, 6) + ' EMBER'));
    const status = r.block === null ? 'in the mempool'
      : r.status === 0 ? 'reverted'
        : `#${formatInt(r.block)}`;
    tr.appendChild(el('td', r.status === 0 ? 'bad' : 'muted', status));
    tb.appendChild(tr);
  }
}

// ---- the send form ---------------------------------------------------------

/** Read the four fields. Returns `{ok:false, why}` rather than throwing at the UI. */
function readSendForm() {
  const dest = parseAddress($('to').value);
  if (!dest.ok) return { ok: false, why: dest.why };
  let value, gasPrice, gasLimit;
  try { value = parseEmber($('amt').value); } catch (e) { return { ok: false, why: e.message }; }
  if (value <= 0n) return { ok: false, why: 'the amount must be greater than zero' };
  try { gasPrice = parseGwei($('gasPrice').value); } catch (e) { return { ok: false, why: e.message }; }
  try { gasLimit = parseInteger($('gasLimit').value, 'gas limit'); } catch (e) { return { ok: false, why: e.message }; }
  if (gasLimit < PLAIN_TRANSFER_GAS) {
    return { ok: false, why: `a plain transfer costs ${formatInt(PLAIN_TRANSFER_GAS)} gas and cannot be sent with less` };
  }
  return { ok: true, to: dest.address, value, gasPrice, gasLimit, checksummed: dest.checksummed };
}

/** The two lines under the form: the maximum fee, and the most this can debit. */
function updateTotals() {
  let gasPrice = 0n, gasLimit = 0n, value = 0n;
  try { gasPrice = parseGwei($('gasPrice').value); } catch { /* half-typed */ }
  try { gasLimit = parseInteger($('gasLimit').value, 'gas limit'); } catch { /* half-typed */ }
  try { value = parseEmber($('amt').value); } catch { /* half-typed */ }
  const fee = gasPrice * gasLimit;
  $('feeLbl').textContent = fee > 0n ? formatEmber(fee, 9) + ' EMBER' : '—';
  $('totalLbl').textContent = fee + value > 0n ? formatEmber(fee + value, 9) + ' EMBER' : '—';
}

/** Poll for the receipt. Never an error while it is null: that means "not yet". */
function watchReceipt(hash, box) {
  const line = logLine(box, '⋯ waiting for a block to include it…');
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > RECEIPT_GIVE_UP_MS) {
      line.textContent = '⋯ still not mined after ten minutes. It may be under-priced; the wallet '
        + 'has stopped watching but the transaction is still valid.';
      return;
    }
    let receipt = null;
    try { receipt = await rpc.call('eth_getTransactionReceipt', [hash]); }
    catch { /* a transient read failure is not a verdict; try again */ }
    if (!receipt) { setTimeout(poll, RECEIPT_POLL_MS); return; }
    const status = receipt.status === '0x1';
    const block = Number(toBig(receipt.blockNumber));
    const gasUsed = toBig(receipt.gasUsed);
    const paid = gasUsed * toBig(receipt.effectiveGasPrice);
    line.className = status ? 'good' : 'bad';
    line.textContent = status
      ? `✓ mined in block #${formatInt(block)} — ${formatInt(gasUsed)} gas, fee ${formatEmber(paid, 9)} EMBER`
      : `✗ mined in block #${formatInt(block)} but REVERTED — the fee of ${formatEmber(paid, 9)} EMBER `
        + 'was still paid and the value was not transferred';
    updateSent(hash, { block, status: status ? 1 : 0 });
    refresh();
  };
  setTimeout(poll, RECEIPT_POLL_MS);
}

async function doSend() {
  const box = clear($('sendLog'));
  const form = readSendForm();
  if (!form.ok) { logLine(box, '✗ ' + form.why, 'bad'); sendArmed = false; return; }

  // Warnings that should stop a first click but not a second. Each one is a real
  // way to lose money that no amount of validation can decide for the user.
  const warnings = [];
  if (!form.checksummed) {
    warnings.push('that address is all lowercase, so it carries no EIP-55 checksum and nothing here '
      + 'can tell whether it is the one you meant');
  }
  try {
    const code = await rpc.call('eth_getCode', [form.to, 'latest']);
    if (code && code !== '0x') {
      warnings.push('the destination has contract code. A plain transfer runs its receive function '
        + 'with 21,000 gas, and if it has none the transaction reverts and the fee is still paid');
    }
  } catch { /* eth_getCode is optional for this check; not being able to ask is not a warning */ }

  if (warnings.length && !sendArmed) {
    for (const w of warnings) logLine(box, '⚠ ' + w, 'warn');
    logLine(box, 'Press Sign & broadcast again to send anyway.', 'warn');
    sendArmed = true;
    return;
  }
  sendArmed = false;

  await working($('sendBtn'), 'Signing…', async () => {
    try {
      const [balanceHex, nonceHex] = await rpc.batchStrict([
        ['eth_getBalance', [account.address, 'latest']],
        ['eth_getTransactionCount', [account.address, 'pending']],
      ]);
      const balance = toBig(balanceHex);
      const nonce = toBig(nonceHex);
      const maxCost = form.value + form.gasLimit * form.gasPrice;
      if (balance < maxCost) {
        logLine(box, `✗ this needs ${formatEmber(maxCost, 9)} EMBER at most (value plus gasLimit × gasPrice) `
          + `and the account holds ${formatEmber(balance, 9)}`, 'bad');
        return;
      }

      const draft = {
        nonce, gasPrice: form.gasPrice, gasLimit: form.gasLimit,
        to: form.to, value: form.value, data: '0x',
      };
      const need = T.intrinsicGas(draft);
      if (form.gasLimit < need) {
        logLine(box, `✗ gas limit ${formatInt(form.gasLimit)} is below the intrinsic cost ${formatInt(need)}`, 'bad');
        return;
      }

      /* signAndCheck decodes its own output and recovers the sender from it.
       * If this wallet has a bug that signs for a different key, it stops here
       * rather than at the far end of a broadcast. */
      const signed = T.signAndCheck(draft, account.priv, account.addressBytes, { chainId: CHAIN_ID });
      logLine(box, `· signed locally — nonce ${formatInt(nonce)}, EIP-155 chain ${CHAIN_ID}, v=${signed.tx.v}`);
      logLine(box, `· recovers to ${toChecksumAddress(T.toHex(signed.sender))}`, 'good');
      logLine(box, `· hash ${signed.hashHex}`);
      logLine(box, `· broadcasting ${signed.raw.length} bytes to ${rpc.endpointUrl()} …`);

      let accepted;
      try {
        accepted = await rpc.call('eth_sendRawTransaction', [signed.rawHex]);
      } catch (e) {
        logLine(box, '✗ the node refused it: ' + rpc.describeError(e), 'bad');
        return;
      }
      if (String(accepted).toLowerCase() !== signed.hashHex.toLowerCase()) {
        // The hash is keccak over the exact bytes sent. A node returning a
        // different one has not accepted the transaction that was signed.
        logLine(box, `⚠ the node returned hash ${accepted}, not ${signed.hashHex}. Those bytes are not `
          + 'the ones this wallet signed — do not treat this as sent.', 'bad');
        return;
      }

      logLine(box, '✓ accepted into the mempool', 'good');
      rememberSent({
        hash: signed.hashHex, to: form.to, value: form.value.toString(),
        nonce: Number(nonce), at: Date.now(), block: null, status: null,
      });
      $('amt').value = '';
      updateTotals();
      renderHistory();
      refresh();
      watchReceipt(signed.hashHex, box);
    } catch (e) {
      logLine(box, '✗ ' + String(e && e.message || e), 'bad');
    }
  });
}

// ---- key lifecycle ---------------------------------------------------------

async function adopt(acc) {
  account = acc;
  $('addr').textContent = acc.address;
  $('pubKey').textContent = acc.pubHex;
  if (fixtures) fixtures.adoptOwner(acc.address);
  scanFrom = null;
  panel('app');
  await refresh();
}

function wireKeyPanels() {
  $('unlockBtn').addEventListener('click', async () => {
    const box = clear($('unlockMsg'));
    try {
      const k = await working($('unlockBtn'), 'Unlocking…', () => KS.unlock($('unlockPass').value));
      $('unlockPass').value = '';
      await adopt(k);
    } catch (e) { logLine(box, '✗ ' + e.message, 'bad'); }
  });
  $('unlockPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('unlockBtn').click(); });

  $('lockForgetBtn').addEventListener('click', () => {
    if (!confirm('Delete this key from this browser? Without a backup of the private key, anything it holds is gone for good.')) return;
    KS.forget();
    location.reload();
  });
  $('unreadableForgetBtn').addEventListener('click', () => {
    if (!confirm('Delete the stored keystore this page cannot read? If it holds a key, it is gone for good.')) return;
    KS.forget();
    location.reload();
  });

  $('createBtn').addEventListener('click', async () => {
    const box = $('setupMsg');
    const pass = readNewPassphrase('newPass', 'newPass2', box);
    if (pass === null) return;
    try {
      const k = await working($('createBtn'), 'Sealing…', () => KS.create(pass));
      $('newPass').value = $('newPass2').value = '';
      await adopt(k);
    } catch (e) { logLine(box, '✗ ' + e.message, 'bad'); }
  });
  $('showImportBtn').addEventListener('click', () => show($('importBox'), true));
  $('importBtn').addEventListener('click', async () => {
    const box = $('setupMsg');
    const pass = readNewPassphrase('newPass', 'newPass2', box);
    if (pass === null) return;
    try {
      const k = await working($('importBtn'), 'Sealing…', () => KS.adopt($('importKey').value, pass));
      $('importKey').value = $('newPass').value = $('newPass2').value = '';
      await adopt(k);
    } catch (e) { logLine(box, '✗ ' + e.message, 'bad'); }
  });
}

function wireWallet() {
  $('refreshBtn').addEventListener('click', refresh);
  $('retryBtn').addEventListener('click', boot);
  $('histMoreBtn').addEventListener('click', () => scanHistory(false));
  $('copyAddrBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(account.address);
    flash($('copyAddrBtn'), 'Copied');
  });

  for (const id of ['amt', 'gasPrice', 'gasLimit']) {
    $(id).addEventListener('input', () => {
      if (id === 'gasPrice') gasPriceTouched = true;
      sendArmed = false;
      updateTotals();
    });
  }
  $('to').addEventListener('input', () => {
    sendArmed = false;
    const box = clear($('toMsg'));
    const v = $('to').value.trim();
    if (!v) return;
    const r = parseAddress(v);
    if (!r.ok) logLine(box, '✗ ' + r.why, 'bad');
    else if (!r.checksummed) logLine(box, '⚠ no EIP-55 checksum on that address — nothing can verify it for you', 'warn');
    else logLine(box, '✓ ' + r.address, 'good');
  });
  $('sendBtn').addEventListener('click', doSend);

  /* "Send everything" leaves exactly the maximum fee behind, which is the most
   * the transaction can cost. Anything the transaction does not burn comes back
   * to the account, so this is a floor on what is left, never a shortfall. */
  $('maxBtn').addEventListener('click', async () => {
    const box = clear($('sendLog'));
    try {
      const balance = toBig(await rpc.call('eth_getBalance', [account.address, 'latest']));
      const gasPrice = parseGwei($('gasPrice').value);
      const gasLimit = parseInteger($('gasLimit').value, 'gas limit');
      const fee = gasPrice * gasLimit;
      if (balance <= fee) {
        logLine(box, `✗ the balance of ${formatEmber(balance, 9)} EMBER does not cover the maximum fee `
          + `of ${formatEmber(fee, 9)}`, 'bad');
        return;
      }
      $('amt').value = formatUnitsExact(balance - fee);
      updateTotals();
      logLine(box, `· amount set to the balance minus the maximum fee (${formatEmber(fee, 9)} EMBER). `
        + 'Unused gas is refunded, so the account will keep a little.', 'good');
    } catch (e) { logLine(box, '✗ ' + String(e && e.message || e), 'bad'); }
  });

  // ---- the reveal path, and the only place a private key reaches the DOM ----
  $('revealBtn').addEventListener('click', () => {
    const opening = $('revealBox').classList.contains('hide');
    show($('revealBox'), opening);
    if (!opening) hideReveal();
  });
  $('revealHideBtn').addEventListener('click', () => { show($('revealBox'), false); hideReveal(); });
  $('revealGoBtn').addEventListener('click', async () => {
    const box = clear($('revealMsg'));
    try {
      // Deliberately re-derives from storage under the passphrase rather than
      // printing `account.privHex`: seeing the key requires proving, again, that
      // you are the person who sealed it.
      const opened = await working($('revealGoBtn'), 'Opening…', () => KS.unlock($('revealPass').value));
      $('revealPass').value = '';
      $('revealOut').value = opened.privHex;
      show($('revealOut'), true);
      show($('revealActions'), true);
      logLine(box, '⚠ this line is the account. Close it as soon as it is written down.', 'warn');
    } catch (e) { logLine(box, '✗ ' + e.message, 'bad'); }
  });
  $('downloadBtn').addEventListener('click', () => {
    const text = $('revealOut').value;
    if (!text) return;
    const blob = new Blob([text + '\n'], { type: 'text/plain' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = account.address.slice(0, 12) + '.hearth-key.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('forgetBtn').addEventListener('click', () => {
    if (!confirm('Delete this key from this browser? Without a backup of the private key, anything it holds is gone for good.')) return;
    KS.forget();
    location.reload();
  });
}

function hideReveal() {
  $('revealOut').value = '';
  show($('revealOut'), false);
  show($('revealActions'), false);
  clear($('revealMsg'));
  $('revealPass').value = '';
}

// ---- boot ------------------------------------------------------------------

async function boot() {
  const qs = new URLSearchParams(location.search);
  const fixtureMode = qs.get('fixtures');
  if (fixtureMode && !fixtures) {
    fixtures = await import('./fixtures.js');
    rpc.useTransport(fixtureMode === 'down' ? fixtures.deadTransport : fixtures.fixtureTransport);
    if (fixtureMode === 'down') {
      setMode('● FIXTURES — simulating an unreachable node', 'bad');
      banner('Fixture mode, with the node deliberately unreachable. Every read below will fail, '
        + 'which is the point: this is what the wallet does when there is no chain. It invents nothing.');
    } else {
      setMode('● FIXTURES — canned data, no chain', 'warn');
      banner('Nothing on this page is real. The account-model chain is phase 5 of docs/evm-spec.md '
        + 'and is not running, so these balances and transactions come from assets/wallet/fixtures.js. '
        + 'Signing IS real: the fixture decodes and verifies every transaction with the same module '
        + 'the node uses, so a signing bug fails here too.');
    }
  }

  if (!(await probeChain())) return;

  const stored = KS.peek();
  if (stored.kind === 'locked') {
    $('lockAddr').textContent = stored.address || 'this browser';
    panel('lock');
    $('unlockPass').focus();
  } else if (stored.kind === 'unreadable') {
    $('unreadableVer').textContent = String(stored.version);
    panel('unreadable');
  } else if (stored.kind === 'pre-evm') {
    $('preEvmAddr').textContent = stored.address || 'an ember1… address';
    panel('preEvm');
    // The notice is a header on the setup panel, not a dead end.
    show($('setup'), true);
  } else {
    panel('setup');
  }
}

wireKeyPanels();
wireWallet();
document.querySelectorAll('.hearth').forEach(h => window.Hearth && window.Hearth.igniteHearth(h, 1));
setInterval(() => { if (account && chainOk) refresh(); }, 12_000);
boot();
