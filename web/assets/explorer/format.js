/* Pure formatting. No DOM, no network — everything here is testable by calling it.
 *
 * The rule this file exists to enforce: values arrive from the RPC as hex
 * strings and become BigInt exactly once, here. Nothing downstream does
 * arithmetic on a string, and nothing turns a wei value into a Number, because
 * a balance of 1 EMBER is 10^18 wei and Number stops being exact at 2^53.
 */

import { keccak256 } from './keccak.js';

/** 18 decimals — docs/evm-spec.md §1 changed this from 8, because every EVM tool assumes 18. */
export const DECIMALS = 18;
export const WEI_PER_EMBER = 10n ** BigInt(DECIMALS);

// ---- hex ------------------------------------------------------------------

/** A QUANTITY ("0x1f") to BigInt. Tolerates the leading zeros a lax server may send. */
export function toBig(hex) {
  if (typeof hex === 'bigint') return hex;
  if (hex === null || hex === undefined || hex === '') return 0n;
  if (typeof hex === 'number') return BigInt(hex);
  const s = String(hex);
  return BigInt(s.startsWith('0x') || s.startsWith('0X') ? (s === '0x' ? '0x0' : s) : '0x' + s);
}

/** A QUANTITY to Number. Only for things that are genuinely small: heights, gas, indexes. */
export function toNum(hex) { return Number(toBig(hex)); }

/** DATA ("0xdeadbeef") to Uint8Array. Odd-length or non-hex input throws — better than guessing. */
export function toBytes(hex) {
  if (hex instanceof Uint8Array) return hex;
  let s = String(hex || '0x').replace(/^0[xX]/, '');
  if (s.length % 2) throw new Error('odd-length hex: ' + s.slice(0, 16));
  if (s.length && !/^[0-9a-fA-F]+$/.test(s)) throw new Error('not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function toHex(bytes) {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Encode a BigInt as a canonical QUANTITY: 0x0, never 0x00, never leading zeros. */
export function qty(v) { return '0x' + BigInt(v).toString(16); }

/** 32-byte left-padded word for an address or a number, as a log topic. */
export function padTopic(v) {
  const s = typeof v === 'string' ? v.replace(/^0x/, '') : BigInt(v).toString(16);
  return '0x' + s.toLowerCase().padStart(64, '0');
}

// ---- addresses -------------------------------------------------------------

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * EIP-55 checksum casing. This is the only spelling of an address that should
 * ever be rendered: a reader comparing two addresses by eye is comparing the
 * capitalisation as much as the characters, and a lowercase address throws that
 * away. Non-addresses are returned untouched rather than mangled.
 */
export function toChecksumAddress(addr) {
  if (!ADDRESS_RE.test(String(addr || ''))) return String(addr || '');
  const lower = addr.toLowerCase().slice(2);
  const hash = keccak256(new TextEncoder().encode(lower));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = i % 2 === 0 ? hash[i >> 1] >> 4 : hash[i >> 1] & 0x0f;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/** The 20-byte address carried in a 32-byte log topic. */
export function addressFromTopic(topic) {
  const s = String(topic || '').replace(/^0x/, '').padStart(64, '0');
  return toChecksumAddress('0x' + s.slice(24));
}

// ---- amounts ---------------------------------------------------------------

/**
 * Fixed-point render of a base-unit integer. Pure integer arithmetic: the
 * fractional part is produced by string slicing, never by dividing in floating
 * point, so a balance is exact no matter how large.
 */
export function formatUnits(value, decimals = DECIMALS, maxFrac = 6) {
  let v = BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = (v / base).toString();
  let frac = (v % base).toString().padStart(Number(d), '0');
  if (maxFrac !== null && frac.length > maxFrac) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

/** The full, un-truncated value — for the "exact" line under a rounded one. */
export function formatUnitsExact(value, decimals = DECIMALS) {
  return formatUnits(value, decimals, null);
}

export const formatEmber = (wei, maxFrac = 6) => formatUnits(wei, DECIMALS, maxFrac);

/** Gas prices read in gwei everywhere in the ecosystem; showing wei helps nobody. */
export function formatGwei(wei) { return formatUnits(wei, 9, 4); }

export function formatInt(v) {
  return BigInt(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatBytes(n) {
  const b = Number(n);
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KiB';
  return (b / (1024 * 1024)).toFixed(2) + ' MiB';
}

/**
 * Difficulty and total difficulty get large enough that the digits stop being
 * readable. 2^64 is "18.45 E" — an order of magnitude is the useful part.
 */
export function formatBigApprox(v) {
  const n = BigInt(v);
  const units = [['Q', 10n ** 30n], ['R', 10n ** 27n], ['Y', 10n ** 24n], ['Z', 10n ** 21n],
    ['E', 10n ** 18n], ['P', 10n ** 15n], ['T', 10n ** 12n], ['G', 10n ** 9n], ['M', 10n ** 6n]];
  for (const [suffix, div] of units) {
    if (n >= div) return (Number((n * 1000n) / div) / 1000).toFixed(2) + ' ' + suffix;
  }
  return formatInt(n);
}

// ---- time ------------------------------------------------------------------

/**
 * `secondsAgo` from a UNIX-SECONDS timestamp. The header stores milliseconds
 * today and docs/evm-spec.md §4 requires phase 5 to convert at the header; if
 * that conversion is missed, every age here reads as a large negative number
 * rather than quietly rendering a plausible date, which is the point.
 */
export function timeAgo(unixSeconds, now = Math.floor(Date.now() / 1000)) {
  const s = now - Number(unixSeconds);
  if (!Number.isFinite(s)) return '—';
  if (s < 0) return 'in ' + timeAgo(now, Number(unixSeconds));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function formatTimestamp(unixSeconds) {
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

/** Flags the millisecond-timestamp bug from docs/evm-spec.md §4 on sight. */
export function timestampLooksWrong(unixSeconds) {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 4102444800;      // 2100-01-01
}

// ---- misc ------------------------------------------------------------------

export function shorten(s, head = 10, tail = 8) {
  const v = String(s || '');
  return v.length <= head + tail + 1 ? v : v.slice(0, head) + '…' + v.slice(-tail);
}

/** A percentage with one decimal, clamped — used for gas used against gas limit. */
export function percent(part, whole) {
  const w = BigInt(whole);
  if (w === 0n) return 0;
  return Number((BigInt(part) * 10000n) / w) / 100;
}

/** Printable ASCII inside a data blob, the way `extraData` usually carries a miner tag. */
export function asAscii(bytes) {
  if (!bytes || !bytes.length) return '';
  let s = '';
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) return '';
    s += String.fromCharCode(b);
  }
  return s;
}
