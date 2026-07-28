'use strict';
/* Terminal output for `hearth`: colour, the cursor, and the few formatters
 * every command shares.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: everything degrades to plain text. A
 * trace is something you pipe into `grep`, `diff` and a bug report, so when
 * stdout is not a TTY there are no escape sequences at all — not colour, not
 * cursor moves, not the alternate screen. `NO_COLOR` (any value) and
 * `--no-color` turn colour off even on a TTY, because a terminal that reports
 * itself as one is not a promise that the reader wants ANSI.
 *
 * Plain ANSI, by the brief: no chalk, no blessed, no ink, no dependencies.
 */

const ESC = '\x1b[';

let colourOn = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
let cursorOn = Boolean(process.stdout.isTTY);

/** Force colour on or off; the CLI calls this once for `--no-color`. */
function setColour(on) { colourOn = Boolean(on) && !process.env.NO_COLOR; }
function colourEnabled() { return colourOn; }
/** True when cursor moves, clears and the alternate screen are safe to emit. */
function interactive() { return cursorOn; }
function setInteractive(on) { cursorOn = Boolean(on); }

function wrap(open, close) {
  return (s) => (colourOn ? ESC + open + 'm' + s + ESC + close + 'm' : String(s));
}

const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  grey: wrap('90', '39'),
  inverse: wrap('7', '27'),
};

// ---- cursor and screen -----------------------------------------------------

const out = (s) => { if (cursorOn) process.stdout.write(s); };
const hideCursor = () => out(ESC + '?25l');
const showCursor = () => out(ESC + '?25h');
const clearScreen = () => out(ESC + '2J' + ESC + 'H');
const home = () => out(ESC + 'H');
const clearLine = () => out(ESC + '2K');
const clearBelow = () => out(ESC + 'J');
const altScreen = (on) => out(ESC + (on ? '?1049h' : '?1049l'));
const size = () => ({
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
});

// ---- text ------------------------------------------------------------------

/** Visible width, ignoring the escape sequences `c.*` may have added. */
function width(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, '').length; }

function padEnd(s, n) { const w = width(s); return w >= n ? String(s) : String(s) + ' '.repeat(n - w); }
function padStart(s, n) { const w = width(s); return w >= n ? String(s) : ' '.repeat(n - w) + String(s); }

/** Truncate to `n` visible columns. Only safe on strings with no colour in them. */
function truncate(s, n) {
  const t = String(s);
  return t.length <= n ? t : (n <= 1 ? t.slice(0, n) : t.slice(0, n - 1) + '…');
}

// ---- values ----------------------------------------------------------------

const hex = (b) => '0x' + Buffer.from(b).toString('hex');

/** A hex string or Buffer as a Buffer. Odd-length hex is left-padded. */
function toBuf(v) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'bigint' || typeof v === 'number') {
    let h = BigInt(v).toString(16);
    if (h.length % 2) h = '0' + h;
    return Buffer.from(h, 'hex');
  }
  let h = String(v).replace(/^0[xX]/, '');
  if (h.length % 2) h = '0' + h;
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new TypeError('not hex: ' + JSON.stringify(String(v)));
  return Buffer.from(h, 'hex');
}

/**
 * EIP-55 mixed-case checksumming. Every EVM tool renders addresses this way and
 * several refuse an address whose case is wrong-but-not-uniform, so this is the
 * only form the CLI ever prints.
 */
function checksumAddress(addr) {
  const { keccak256 } = require('../crypto/keccak');
  const raw = toBuf(addr);
  if (raw.length !== 20) throw new TypeError('address must be 20 bytes, got ' + raw.length);
  const lower = raw.toString('hex');
  const h = keccak256(Buffer.from(lower, 'ascii')).toString('hex');
  let s = '0x';
  for (let i = 0; i < 40; i++) s += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return s;
}

/** `0x1234…abcd` — for tables where a full address does not fit. */
function shortHex(v, keep = 4) {
  const s = typeof v === 'string' && v.startsWith('0x') ? v : hex(toBuf(v));
  const body = s.slice(2);
  if (body.length <= keep * 2 + 1) return s;
  return '0x' + body.slice(0, keep) + '…' + body.slice(-keep);
}

/** A 256-bit word with its leading zeros dropped, as a debugger prints it. */
function word(v) {
  if (typeof v === 'bigint' || typeof v === 'number') return '0x' + BigInt(v).toString(16);
  const b = toBuf(v);
  return '0x' + (b.length ? BigInt('0x' + b.toString('hex')).toString(16) : '0');
}

const UNITS = { wei: 0n, gwei: 9n, ether: 18n };

/** wei -> a decimal string in `unit`, trailing zeros trimmed, never rounded. */
function formatUnits(value, unit = 'ether') {
  const dp = UNITS[unit] !== undefined ? UNITS[unit] : BigInt(unit);
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const div = 10n ** dp;
  const whole = (abs / div).toString();
  if (dp === 0n) return (neg ? '-' : '') + whole;
  const frac = (abs % div).toString().padStart(Number(dp), '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

/** A decimal string in `unit` -> wei, exactly. Rejects more precision than exists. */
function parseUnits(text, unit = 'ether') {
  const dp = UNITS[unit] !== undefined ? UNITS[unit] : BigInt(unit);
  const s = String(text).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') {
    throw new TypeError(`not a decimal amount: ${JSON.stringify(String(text))}`);
  }
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  if (BigInt(frac.length) > dp) throw new TypeError(`${text} has more than ${dp} decimal places for ${unit}`);
  const padded = frac.padEnd(Number(dp), '0');
  const v = BigInt(whole || '0') * 10n ** dp + BigInt(padded || '0');
  return neg ? -v : v;
}

/** 1234567 -> "1,234,567". Applied to gas and step counts, never to money. */
function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** JSON with BigInt and Buffer rendered the way the rest of the CLI prints them. */
function jsonStringify(value, indent = 2) {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (Buffer.isBuffer(v)) return hex(v);
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return hex(Buffer.from(v.data));
    return v;
  }, indent);
}

// ---- prompting -------------------------------------------------------------

/**
 * Read a line from stdin with the echo turned off.
 *
 * Raw mode rather than `readline`'s `hideEchoBack`, because raw mode is the only
 * way to be sure nothing reaches the terminal — and because it lets the handler
 * put the terminal back on Ctrl-C, which a half-configured readline does not.
 *
 * `HEARTH_PASSPHRASE` short-circuits the whole thing for scripts and tests. That
 * is a documented convenience with a real cost — the environment of a process is
 * readable by its owner and lands in shell history — so it is never the default
 * and never silently used when a terminal is available.
 */
function promptSecret(prompt, { env = 'HEARTH_PASSPHRASE', allowEnv = true } = {}) {
  if (allowEnv && env && process.env[env] !== undefined) return Promise.resolve(process.env[env]);
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      process.stdin.on('error', reject);
      process.stdin.resume();
    });
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err, out) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      err ? reject(err) : resolve(out);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(null, value);
        if (ch === '\u0003') return done(new Error('cancelled'));       // ctrl-c
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** A visible line of input — for confirmations, never for secrets. */
function promptLine(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let buf = '';
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      stdin.removeListener('data', onData);
      stdin.pause();
      resolve(buf.slice(0, nl).replace(/\r$/, ''));
    };
    stdin.on('data', onData);
  });
}

module.exports = {
  c, setColour, colourEnabled, interactive, setInteractive,
  promptSecret, promptLine,
  hideCursor, showCursor, clearScreen, clearLine, clearBelow, home, altScreen, size,
  width, padEnd, padStart, truncate,
  hex, toBuf, checksumAddress, shortHex, word,
  formatUnits, parseUnits, group, jsonStringify,
};
