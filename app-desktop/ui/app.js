'use strict';
/* The window.
 *
 * WHAT IT KNOWS. An address, some counters, and a list of things that happened.
 * That is the whole of it. The private key is in the engine process and never
 * arrives here (app-desktop/engine/engine.js explains why a webview is the worst
 * place in a desktop application to keep a secret), so there is nothing on this
 * side to leak, to inspect, or to end up in a screenshot.
 *
 * WHAT IT IS FOR. A miner that prints nothing for an hour is indistinguishable
 * from a broken one. Every element below exists to answer one of five questions
 * — am I connected, am I hashing, how fast, what have I earned, and WHICH
 * ADDRESS is being paid — and the last of those is given the most room on the
 * page because it is the one whose wrong answer is unrecoverable.
 *
 * NO FRAMEWORK AND NO BUILD STEP: this file is what ships, so what you read is
 * what runs. (The convention was inherited from web/, deleted in 48bc28a.)
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = id => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
const text = (id, v) => { $(id).textContent = v; };

let settings = { url: 'http://127.0.0.1:8645', throttle: 1, remembered: false };
let started = 0;

// ---- formatting ------------------------------------------------------------

const num = n => Number(n).toLocaleString('en-US');
function rate(h) {
  if (h >= 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
  if (h >= 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
  if (h >= 1e3) return (h / 1e3).toFixed(2) + ' kH/s';
  return num(h) + ' H/s';
}
function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map(v => String(v).padStart(2, '0')).join(':');
}
/* Wei to EMBER. Integer division would print a 5.399999-EMBER reward as "5",
 * which reads as a broken emission schedule — the same trap node/src/coinbase.js
 * calls out. BigInt because no float is wide enough for wei. */
function ember(weiString) {
  const wei = BigInt(weiString || '0');
  const unit = 10n ** 18n;
  const frac = (wei % unit).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${wei / unit}.${frac}` : String(wei / unit);
}

// ---- the log ---------------------------------------------------------------

const MAX_LOG = 200;
function say(kind, message) {
  const li = document.createElement('li');
  li.className = kind;
  const t = document.createElement('time');
  t.textContent = new Date().toLocaleTimeString();
  const s = document.createElement('span');
  s.textContent = message;              // textContent, never innerHTML
  li.append(t, s);
  const log = $('log');
  log.prepend(li);
  while (log.children.length > MAX_LOG) log.lastChild.remove();
}

// ---- rendering -------------------------------------------------------------

function render(s) {
  if (!s) return;
  text('chain', `${s.network} · chain ${s.chainId} · paid in ${s.coin}`);
  for (const el of document.querySelectorAll('.coin')) el.textContent = s.coin;

  if (!s.keystore) { screen('setup'); return; }
  text('locked-address', s.address || '');
  if (!s.unlocked) { screen('locked'); return; }

  screen('main');
  text('address', s.address);
  text('keystore-path', s.keystore.file);

  const m = s.session;
  const mining = !!(m && m.running);
  show('stop', mining);
  show('start', !mining);
  $('url').disabled = mining;
  $('throttle').disabled = mining;

  text('earned', s.earned);
  text('found', m ? num(m.found) : '0');
  text('hashrate', rate(m ? m.hashrate : 0));
  text('height', m && m.working ? '#' + num(m.height) : '—');
  text('uptime', clock(mining && started ? Date.now() - started : 0));

  const dot = $('dot');
  if (!mining) { dot.className = 'dot'; text('state', 'idle'); }
  else if (m.reachable === false) { dot.className = 'dot warn'; text('state', 'node not answering'); }
  else if (m.working) { dot.className = 'dot on'; text('state', 'mining'); }
  else { dot.className = 'dot warn'; text('state', 'waiting for work'); }
}

function screen(name) {
  for (const id of ['setup', 'locked', 'main', 'fatal']) show(id, id === name);
}

async function refresh() {
  try { render(await invoke('status')); }
  catch (e) { text('main-err', String(e)); }
}

// ---- events from the engine ------------------------------------------------

listen('hearth://fatal', e => { text('fatal-msg', e.payload.err); screen('fatal'); });
listen('hearth://engine-exit', () => {
  say('bad', 'the mining engine stopped. Nothing is being mined. Restart Hearth.');
});
/* The engine confirming it began. The click is not evidence — a session can
 * also be running before this window loaded, after a reopen. */
listen('hearth://started', e => {
  started = Date.now();
  say('good', `mining ${e.payload.url} — paid to ${e.payload.address}`);
});
listen('hearth://work', e => { text('height', '#' + num(e.payload.height)); });
listen('hearth://rate', e => { text('hashrate', rate(e.payload.hashrate)); });
listen('hearth://accepted', e => {
  const p = e.payload;
  say('good', `block #${num(p.height)} accepted — you were paid ${ember(p.paidWei)}`);
  refresh();
});
listen('hearth://stale', e => {
  say('dim', `someone else found height ${num(e.payload.height)} first — that is normal, not an error`);
});
listen('hearth://unreachable', e => say('bad', e.payload.err));
listen('hearth://reachable', e => say('good', `${e.payload.url} is answering again`));
listen('hearth://throttled', e => {
  say('dim', e.payload.kind === 'submit'
    ? 'the node is busy verifying proofs — waiting rather than hammering it'
    : 'the node is limiting work requests — asking less often');
});
listen('hearth://refused', e => say('bad', `a proof was refused: ${e.payload.err}`));
listen('hearth://lost', e => say('bad', e.payload.err));
listen('hearth://error', e => say('bad', e.payload.err));
/* The refusal worth interrupting for: the work is not ours, and every hour spent
 * on it earns nothing. It is the failure the miner cannot see for itself. */
listen('hearth://badwork', e => {
  say('bad', `stopped — refusing this work: ${e.payload.err}`);
  text('main-err', `Hearth stopped rather than mine work it would not be paid for: ${e.payload.err}`);
  refresh();
});
listen('hearth://stopped', e => {
  say('dim', `stopped after finding ${num(e.payload.found)} block(s) — ${e.payload.reason}`);
  refresh();
});

// ---- first run -------------------------------------------------------------

$('create').onclick = async () => {
  text('setup-err', '');
  const p1 = $('pass1').value, p2 = $('pass2').value;
  if (p1.length < 8) return text('setup-err', 'Use at least eight characters. This is the only thing protecting the key.');
  if (p1 !== p2) return text('setup-err', 'The two passphrases are not the same.');
  const remember = $('remember-new').checked;
  const file = $('import-file').value.trim();
  const priv = $('import-key').value.trim();
  try {
    if (file) await invoke('import_plaintext', { file, passphrase: p1, remember });
    else await invoke('create_keystore', { passphrase: p1, privateKey: priv || null, remember });
    $('pass1').value = $('pass2').value = $('import-key').value = '';
    say('good', 'key created. Back up the keystore file — the panel at the bottom says where it is.');
    await refresh();
  } catch (e) { text('setup-err', String(e)); }
};

$('unlock').onclick = async () => {
  text('unlock-err', '');
  try {
    await invoke('unlock', { passphrase: $('unlock-pass').value, remember: $('remember-unlock').checked });
    $('unlock-pass').value = '';
    await refresh();
  } catch (e) { text('unlock-err', String(e)); }
};

// ---- mining ----------------------------------------------------------------

$('throttle').oninput = () => { text('throttle-label', $('throttle').value + '%'); };

$('start').onclick = async () => {
  text('main-err', '');
  const url = $('url').value.trim() || settings.url;
  const throttle = Number($('throttle').value) / 100;
  try {
    await invoke('set_settings', { url, throttle });
    await invoke('start_mining', { url, throttle });
    started = Date.now();
    say('good', `mining ${url} with ${Math.round(throttle * 100)}% of a core`);
    await refresh();
  } catch (e) { text('main-err', String(e)); }
};

$('stop').onclick = async () => {
  try { await invoke('stop_mining'); started = 0; await refresh(); }
  catch (e) { text('main-err', String(e)); }
};

$('lock').onclick = async () => {
  try { await invoke('lock'); await invoke('forget_passphrase'); await refresh(); }
  catch (e) { text('key-err', String(e)); }
};

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('address').textContent);
  say('dim', 'address copied');
};

// ---- the two things that ask again -----------------------------------------

let asking = null;
function ask({ title, note, file, needsFile = true, needsPass, needsNewPass = false, ok = 'Save', run }) {
  asking = run;
  text('ask-title', title);
  text('ask-note', note);
  $('ask-file').value = file || '';
  $('ask-pass').value = $('ask-pass2').value = '';
  show('ask-file-row', needsFile);
  show('ask-pass-row', needsPass);
  show('ask-pass2-row', needsNewPass);
  $('ask-ok').textContent = ok;
  text('ask-err', '');
  show('ask');
}
/* Clearing both fields on every exit, not only on success: a passphrase left in
 * a form field survives until the window is closed, and the sheet can be
 * dismissed far more often than it is completed. */
function closeAsk() {
  asking = null;
  $('ask-pass').value = $('ask-pass2').value = '';
  show('ask', false);
}
$('ask-cancel').onclick = closeAsk;
$('ask-ok').onclick = async () => {
  if (!asking) return;
  const run = asking;
  try {
    await run($('ask-file').value.trim(), $('ask-pass').value, $('ask-pass2').value);
    closeAsk();
  } catch (e) { text('ask-err', String(e)); }
};

$('backup').onclick = () => ask({
  title: 'Save a backup copy',
  note: 'The copy is encrypted with the same passphrase. Put it somewhere that is not this computer — '
    + 'a backup on the disk that dies is not a backup.',
  file: (settings.layout ? settings.layout.data_dir : '.') + '/hearth-keystore-backup.json',
  needsPass: false,
  run: async file => {
    const r = await invoke('backup_keystore', { file });
    text('key-note', `Backup written to ${r.file}. It needs the same passphrase to open.`);
    say('good', 'keystore backed up');
  },
});

$('change-pass').onclick = () => ask({
  title: 'Change the passphrase',
  note: 'The key does not change and neither does your address — only what encrypts the file. '
    + 'Any backup copy you have already made still needs the OLD passphrase, so make a fresh one afterwards.',
  needsFile: false,
  needsPass: true,
  needsNewPass: true,
  ok: 'Change it',
  run: async (_file, passphrase, newPassphrase) => {
    if (!newPassphrase || newPassphrase.length < 8) throw new Error('the new passphrase needs at least eight characters');
    await invoke('change_passphrase', {
      passphrase, newPassphrase, remember: !!settings.remembered,
    });
    text('key-note', 'Passphrase changed. Older backup copies still open with the old one — make a new backup.');
    say('good', 'passphrase changed');
  },
});

$('export').onclick = () => ask({
  title: 'Export the raw private key',
  note: 'The key is written to this file and is NOT shown on screen — a key on a screen is a key in a '
    + 'screenshot. Anyone who reads that file can spend everything this address holds. Delete it once '
    + 'you have put it where it is going.',
  file: (settings.layout ? settings.layout.data_dir : '.') + '/hearth-private-key.txt',
  needsPass: true,
  run: async (file, passphrase) => {
    const r = await invoke('export_key', { file, passphrase });
    text('key-note', `Private key written to ${r.file}, readable only by you. Move it and delete it.`);
    say('bad', 'a raw private key was exported to a file — delete it once it is where it is going');
  },
});

// ---- start -----------------------------------------------------------------

(async () => {
  try {
    settings = await invoke('get_settings');
    $('url').value = settings.url || 'http://127.0.0.1:8645';
    const pct = Math.round((settings.throttle || 1) * 100);
    $('throttle').value = pct;
    text('throttle-label', pct + '%');
    $('remember-unlock').checked = !!settings.remembered;
    if (settings.remembered) {
      // A machine that reboots at 4am should come back mining, not asking.
      try { await invoke('auto_unlock'); }
      catch (e) { say('dim', String(e)); }
    }
  } catch (e) { say('bad', String(e)); }
  await refresh();
  setInterval(refresh, 1000);
})();
