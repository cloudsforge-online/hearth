'use strict';
/* The coinbase key, and how EMBER is written down.
 *
 * Lifted out of src/evmnode.js unchanged. It is here because `require`ing it
 * from there drags in the blockchain, the mempool, the EVM, the P2P stack and
 * two HTTP servers — fine for a node, absurd for a miner that holds no chain,
 * and worse for app-desktop, whose engine process must start in a blink and
 * whose attack surface should be as small as its job. evmnode.js re-exports
 * every name below, so nothing that already imported them had to change.
 */

const fs = require('fs');
const path = require('path');

const P = require('./params');
const secp = require('./crypto/secp256k1');
const TX = require('./chain/transaction');

const KEY_FILE = 'coinbase-key.json';

/** Wei as EMBER, to six places. `wei / 10n**18n` is INTEGER division and would
 *  print a 5.999-EMBER reward as "5", which reads as a broken emission schedule. */
function ember(wei) {
  const whole = wei / P.WEI_PER_EMBER;
  const frac = (wei % P.WEI_PER_EMBER).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

const hexBuf = h => Buffer.from(String(h).replace(/^0x/i, ''), 'hex');

/**
 * The node's coinbase key: secp256k1, because the coinbase must RECEIVE the reward
 * and the fees and therefore has to be an account this chain can credit (spec §4).
 * Kept in its own file rather than in `wallet.json`, whose keys are Ed25519 and
 * belong to the other chain — one file, one curve, no chance of a key being read
 * as the wrong kind.
 *
 * THE KEY IS IN THE CLEAR HERE, at mode 600, and that is the right trade for a
 * server process that must come back up unattended after a reboot: a passphrase
 * it could read by itself is not a passphrase. It is the WRONG trade for a
 * desktop application a person carries around and syncs, which is why
 * src/mine/keystore.js exists and app-desktop uses that instead.
 */
function loadCoinbaseKey(dataDir) {
  if (!dataDir) return newKey();
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, KEY_FILE);
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return keyFrom(hexBuf(raw.privateKey));
  }
  const key = newKey();
  fs.writeFileSync(file, JSON.stringify({
    warning: 'this is a mining key with spendable balance — back it up, do not share it',
    address: key.addressHex,
    privateKey: '0x' + key.privateKey.toString('hex'),
  }, null, 2) + '\n', { mode: 0o600 });
  return key;
}

function keyFrom(priv) {
  const publicKey = secp.publicKeyFromPrivate(priv, false);   // uncompressed; see header.js
  const address = TX.addressFromPublicKey(publicKey);
  return { privateKey: priv, publicKey, address, addressHex: '0x' + address.toString('hex') };
}

function newKey() { return keyFrom(secp.randomPrivateKey()); }

module.exports = { KEY_FILE, ember, hexBuf, loadCoinbaseKey, keyFrom, newKey };
