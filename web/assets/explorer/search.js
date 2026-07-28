/* What did the reader type?
 *
 * Kept out of app.js so it can be tested without a DOM. One box, five shapes:
 *
 *   12345                                   a block height
 *   0x + 40 hex                             an address (EOA or contract)
 *   0x + 64 hex                             AMBIGUOUS — a transaction hash and a
 *                                           block hash are the same shape
 *   Transfer(address,address,uint256)       an event signature → log search
 *   anything else                           not a thing on this chain
 *
 * The ambiguous case is resolved by asking for both in one batch and taking
 * whichever answers, rather than by asking the reader to know which they hold.
 */

import { ADDRESS_RE, HASH_RE, toChecksumAddress } from './format.js';

export function classifyQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return { kind: 'empty' };
  if (/^\d+$/.test(q)) return { kind: 'height', value: q };
  if (ADDRESS_RE.test(q)) {
    const checksummed = toChecksumAddress(q);
    // A mixed-case address carries its own checksum. All-lowercase and
    // all-uppercase forms are both legal and carry none, so only a genuinely
    // mixed one can be checked — and a failed check means a character is wrong.
    const mixed = /[A-F]/.test(q.slice(2)) && /[a-f]/.test(q.slice(2));
    return { kind: 'address', value: checksummed, checksumFailed: mixed && checksummed !== q };
  }
  if (HASH_RE.test(q)) return { kind: 'hash', value: q.toLowerCase() };
  if (/^[A-Za-z_$][\w$]*\(.*\)$/.test(q)) return { kind: 'event', value: q };
  return { kind: 'unknown', value: q };
}
