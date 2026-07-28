'use strict';
/* `hearth watch` — a live view of a node, drawn with plain ANSI.
 *
 * Blocks arrive over SSE (`GET /events`) and the counters that are not
 * per-block — hashrate, peers, mempool depth — are polled from `GET /info`,
 * because they are properties of the node rather than events. Two sources, one
 * frame: whichever updates, the whole frame is redrawn.
 *
 * REDRAW STRATEGY, and why it is not the obvious one. Clearing the screen and
 * reprinting flickers, because the terminal shows the empty screen for one
 * frame. So the cursor goes home, each line is written and cleared to its own
 * end (`ESC[K`), and only the region below the last line drawn is cleared
 * (`ESC[J`). Nothing is ever blank between frames.
 *
 * THREE THINGS THAT MUST HOLD ON THE WAY OUT, because a TUI that gets them
 * wrong leaves the terminal broken after it exits:
 *   - the cursor comes back, on every path, including an uncaught throw;
 *   - the alternate screen is left, so scrollback is whatever it was before;
 *   - SIGINT exits rather than being swallowed, and does it once.
 *
 * Piped output is not a TUI at all: no alternate screen, no cursor moves, no
 * colour — one line per block, so `hearth watch | tee blocks.log` works.
 */

const args = require('./args');
const ui = require('./ui');
const { Client, TransportError } = require('./client');

const { c } = ui;

/** Spec §5: difficulty is `2^256 / (target + 1)` — the work a target implies. */
function difficultyFromTarget(targetHex) {
  if (!targetHex) return null;
  try { return (1n << 256n) / (BigInt('0x' + String(targetHex).replace(/^0x/, '')) + 1n); }
  catch { return null; }
}

/** 4_500_000 -> "4.50 MH/s". Hashrate spans nine orders of magnitude here. */
function rate(hs) {
  const n = Number(hs || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 H/s';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0, v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
}

/** A big integer in engineering notation, for difficulty. */
function big(n) {
  if (n === null || n === undefined) return '—';
  const s = BigInt(n).toString();
  if (s.length <= 6) return s;
  return `${s[0]}.${s.slice(1, 3)}e${s.length - 1}`;
}

function clock(ms) {
  if (!ms) return '--:--:--';
  // The v1 header stores MILLISECONDS (spec §4 says v2 must move to seconds), so
  // a value that is plainly seconds is scaled rather than rendered in 1970.
  const t = new Date(Number(ms) < 1e11 ? Number(ms) * 1000 : Number(ms));
  return t.toTimeString().slice(0, 8);
}

/**
 * The whole frame as an array of lines. Pure, so it is testable without a
 * terminal — which is the only reason a TUI is testable at all.
 */
function render(state, cols = 80) {
  const L = [];
  const info = state.info || {};
  const width = Math.max(48, Math.min(cols, 160));

  const title = ` ${c.bold('HEARTH')} ${c.dim('·')} ${info.network || '—'} ${c.dim(info.coin ? '· ' + info.coin : '')}`;
  L.push(title + ui.padStart(c.dim(new Date().toTimeString().slice(0, 8)), Math.max(1, width - ui.width(title) - 1)));
  L.push('');

  if (state.error) L.push(' ' + c.red(state.error));
  else L.push(' ' + c.dim(state.connected ? 'connected  ' + state.url : 'connecting…  ' + state.url));
  L.push('');

  const cell = (label, value) => c.dim(ui.padEnd(label, 12)) + ui.padEnd(String(value), 18);
  L.push(' ' + cell('height', info.height === undefined ? '—' : info.height) + cell('peers', info.peers === undefined ? '—' : info.peers));
  L.push(' ' + cell('difficulty', big(difficultyFromTarget(info.difficultyTarget))) + cell('mempool', info.mempool === undefined ? '—' : `${info.mempool} tx`));
  L.push(' ' + cell('hashrate', rate(info.hashrate)) + cell('mining', info.mining ? c.green('yes') : c.dim('no')));
  L.push('');

  L.push(' ' + c.bold(
    ui.padEnd('height', 9) + ui.padEnd('time', 10) + ui.padEnd('id', 18) +
    ui.padStart('txs', 5) + ui.padStart('gas used', 12) + ui.padStart('reward', 18),
  ));

  const rows = Math.max(3, (state.rows || 24) - L.length - 3);
  for (const b of state.blocks.slice(0, rows)) {
    /* `gasUsed` only exists once the header is v2 (spec §4). Until phase 5 there
     * is nothing to show, and an invented zero would be a lie about a number
     * people will read as consensus. */
    const gas = b.gasUsed === undefined || b.gasUsed === null ? c.dim('—') : ui.group(b.gasUsed);
    const reward = b.reward === undefined ? c.dim('—') : ui.formatUnits(BigInt(b.reward), state.decimals) + ' ' + (info.coin || '');
    L.push(' ' +
      ui.padEnd(String(b.height), 9) +
      ui.padEnd(clock(b.timestamp), 10) +
      ui.padEnd(ui.truncate(String(b.id || ''), 16), 18) +
      ui.padStart(String(b.txCount === undefined ? '—' : b.txCount), 5) +
      ui.padStart(gas, 12) +
      ui.padStart(reward, 18));
  }
  if (state.blocks.length === 0) L.push(' ' + c.dim(' waiting for a block…'));

  L.push('');
  if (!state.once) L.push(' ' + c.dim('ctrl-c to quit'));
  return L;
}

// ---------------------------------------------------------------------------

const USAGE = `hearth watch — a live view of a node

  hearth watch [--rpc <url>] [--interval <ms>] [--rows <n>]

options
  --rpc <url>        node REST API                 (default $HEARTH_RPC_URL)
  --interval <ms>    how often to poll /info       (default 2000)
  --once             print one frame and exit — for scripts and screenshots
  --no-color         plain text even on a terminal

Piped output is not a TUI: one line per block, no escapes at all.`;

async function main(argv) {
  const { flags } = args.parse(argv, {
    booleans: ['once', 'no-color'],
    strings: ['rpc', 'interval', 'rows'],
  });
  if (flags.help) { console.log(USAGE); return 0; }
  if (flags['no-color']) ui.setColour(false);

  const client = new Client(flags.rpc);
  const interval = args.intFlag(flags, 'interval', 2000);
  const tty = ui.interactive();

  const state = {
    url: client.url,
    info: null,
    blocks: [],
    connected: false,
    error: null,
    rows: args.intFlag(flags, 'rows', null) || ui.size().rows,
    // The chain is 8-decimal EMBER today; spec §1 moves the native asset to 18
    // when the EVM lands. `/info` does not publish it, so it is read from params
    // rather than assumed.
    decimals: Math.round(Math.log10(require('../params').SPARKS_PER_EMBER)),
  };

  let stop = false;
  const controller = new AbortController();
  let lastLines = 0;

  const restore = () => {
    if (!tty) return;
    ui.showCursor();
    ui.altScreen(false);
  };
  process.on('exit', restore);

  const draw = () => {
    if (!tty) return;
    const { cols, rows } = ui.size();
    state.rows = args.intFlag(flags, 'rows', null) || rows;
    const lines = render(state, cols);
    ui.home();
    let outStr = '';
    for (const line of lines) outStr += line + '\x1b[K\n';
    // Clear only what the previous, taller frame left behind — never the whole
    // screen, which is what makes this flicker-free.
    process.stdout.write(outStr);
    if (lines.length < lastLines) ui.clearBelow();
    lastLines = lines.length;
  };

  const pushBlock = (b) => {
    if (!b || b.height === undefined) return;
    if (state.blocks.length && state.blocks[0].height === b.height && state.blocks[0].id === b.id) return;
    state.blocks.unshift(b);
    state.blocks.length = Math.min(state.blocks.length, 200);
    if (state.info) state.info.height = Math.max(state.info.height || 0, b.height);
  };

  const pollInfo = async () => {
    try {
      state.info = await client.get('/info');
      state.error = null;
      state.connected = true;
    } catch (e) {
      state.error = e instanceof TransportError ? e.message : String(e.message || e);
      state.connected = false;
    }
  };

  await pollInfo();
  try {
    const { blocks } = await client.get('/blocks?limit=50');
    for (const b of (blocks || []).slice().reverse()) pushBlock(b);
  } catch { /* the counters alone are still worth showing */ }

  if (flags.once || !tty) {
    if (flags.once) {
      state.once = true;
      console.log(render(state, ui.size().cols).join('\n'));
      return state.connected ? 0 : 1;
    }
    // Piped: a plain, appendable log. No frame, no escapes.
    console.log(`# hearth watch ${client.url} — network ${state.info ? state.info.network : '?'} height ${state.info ? state.info.height : '?'}`);
    console.log('# height\ttime\tid\ttxs\tgasUsed');
  } else {
    ui.altScreen(true);
    ui.hideCursor();
    ui.clearScreen();
    draw();
  }

  const timer = setInterval(async () => { if (stop) return; await pollInfo(); draw(); }, interval);
  if (timer.unref) timer.unref();

  const quit = () => {
    if (stop) return;
    stop = true;
    clearInterval(timer);
    controller.abort();
    restore();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  if (tty) process.stdout.on('resize', draw);

  for (;;) {
    try {
      await client.events({
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          // src/rpc.js emits blocks with NO `event:` line, so they arrive as the
          // default `message`; records arrive as `event: record`.
          if (event !== 'message' && event !== 'block') return;
          pushBlock(data);
          if (tty) draw();
          else console.log(`${data.height}\t${clock(data.timestamp)}\t${data.id}\t${data.txCount}\t${data.gasUsed === undefined ? '-' : data.gasUsed}`);
        },
      });
      if (stop) break;
      // The server closed the stream. Reconnecting is the whole point of a watch
      // command: a node restart should show up as a gap, not as an exit.
      state.connected = false;
      state.error = 'event stream closed; reconnecting…';
    } catch (e) {
      if (stop || controller.signal.aborted) break;
      state.connected = false;
      state.error = String(e.message || e);
    }
    if (tty) draw();
    await new Promise((r) => setTimeout(r, Math.max(500, interval)));
    if (stop) break;
  }

  restore();
  return 0;
}

module.exports = { main, USAGE, render, difficultyFromTarget, rate, big, clock };
