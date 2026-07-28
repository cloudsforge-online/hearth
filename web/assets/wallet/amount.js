/* Reading an amount a human typed, at 18 decimals, without ever touching a float.
 *
 * The rendering direction already exists — `formatUnits` in
 * assets/explorer/format.js — and this is its inverse, which the explorer never
 * needed because it only ever displays. A wallet needs both, and this is the
 * direction where a mistake costs money rather than a wrong label.
 *
 * Three rules, each of which is a real bug someone has shipped:
 *
 *   - Never `Number(str) * 1e18`. One EMBER is 10^18 wei and a double is exact
 *     only to 2^53, so `0.1` becomes 100000000000000001... and the transaction
 *     sends a different amount from the one on screen. Everything here is string
 *     slicing into BigInt.
 *   - More than 18 decimal places is REFUSED, not truncated. Truncating silently
 *     sends less than was asked for.
 *   - A comma is refused rather than guessed at. "1,5" is one and a half in half
 *     of Europe and fifteen with an American thousands separator, and the wallet
 *     prints thousands separators itself, so both spellings genuinely arrive.
 *
 * docs/evm-spec.md §1: 18 decimals, changed from 8, because every EVM tool
 * assumes 18 for a native asset.
 */

export const DECIMALS = 18;
export const WEI_PER_EMBER = 10n ** BigInt(DECIMALS);
export const GWEI = 10n ** 9n;

/**
 * A decimal string to an integer in the smallest unit.
 * @throws {Error} with a sentence fit to show a user.
 */
export function parseUnits(input, decimals = DECIMALS, what = 'amount') {
  const s = String(input === undefined || input === null ? '' : input).trim().replace(/_/g, '');
  if (!s) throw new Error(`enter an ${what}`);
  if (s.includes(',')) {
    throw new Error(`remove the commas from the ${what} — "1,5" means two different numbers in two different places, so this wallet will not guess`);
  }
  const m = s.match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`the ${what} must be a plain number, like 1.25`);
  const frac = m[2] || '';
  if (frac.length > decimals) {
    throw new Error(`EMBER has ${decimals} decimal places and that has ${frac.length} — nothing here rounds an amount for you`);
  }
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** A decimal EMBER string to wei. */
export const parseEmber = str => parseUnits(str, DECIMALS, 'amount');

/** A decimal gwei string to wei — gas prices are quoted in gwei everywhere. */
export const parseGwei = str => parseUnits(str, 9, 'gas price');

/** An integer field: gas limit, nonce. Refuses anything that is not whole. */
export function parseInteger(input, what = 'value') {
  const s = String(input === undefined || input === null ? '' : input).trim().replace(/[_\s]/g, '');
  if (!s) throw new Error(`enter a ${what}`);
  if (!/^\d+$/.test(s)) throw new Error(`the ${what} must be a whole number`);
  return BigInt(s);
}
