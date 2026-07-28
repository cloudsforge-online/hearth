'use strict';
/* Address parsing, with the EIP-55 rule stated once.
 *
 * The rule that matters for a faucet: a MIXED-CASE address must pass the
 * checksum, and an all-one-case address has no checksum to check. Rejecting
 * all-lowercase would refuse the output of half the tooling in the ecosystem;
 * accepting a failed mixed-case checksum would send EMBER to an address a user
 * typo'd, which is unrecoverable.
 */

const { keccak256 } = require('../../../node/src/crypto/keccak');

/** EIP-55: uppercase nibble i where the i-th hex digit of keccak(lowerhex) >= 8. */
function toChecksum(address) {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak256(Buffer.from(lower, 'utf8'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * @returns {{ok: true, address: string, bytes: Buffer} | {ok: false, reason: string}}
 */
function parseAddress(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'address must be a string' };
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    return {
      ok: false,
      reason: s.startsWith('ember1')
        // Worth naming explicitly: the UTXO-era format is retired and cannot
        // receive funds on the account-model chain (docs/evm-spec.md §2).
        ? 'that is an `ember1…` address from the pre-EVM chain; it cannot receive funds here. Use a 0x address.'
        : 'address must be 0x followed by 40 hex characters',
    };
  }
  const body = s.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && toChecksum(s) !== s) {
    return { ok: false, reason: 'EIP-55 checksum failed — check for a typo rather than lowercasing it' };
  }
  const bytes = Buffer.from(body, 'hex');
  if (bytes.equals(Buffer.alloc(20))) return { ok: false, reason: 'refusing to fund the zero address' };
  return { ok: true, address: toChecksum(s), bytes };
}

module.exports = { toChecksum, parseAddress };
