'use strict';
/* Non-custodial wallet: key management, balance, and building/signing txs.
 * Keys are stored locally (data/wallet.json). Private keys never leave disk. */

const fs = require('fs');
const path = require('path');
const C = require('./crypto');
const P = require('./params');
const TX = require('./tx');
const BOX = require('./box');

class Wallet {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'wallet.json');
    this.keys = []; // [{ priv, pub, address }]
    // A separate X25519 keypair for reading messages. Deliberately not the
    // spending key: an app that needs to decrypt should never be handed the key
    // that moves money, and a leaked reading key should not cost anyone a coin.
    this.identity = null; // { priv, pub } — X25519, PEM + hex
  }

  load() {
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Wallets written before identities existed are a bare array of keys.
      if (Array.isArray(raw)) this.keys = raw;
      else { this.keys = raw.keys || []; this.identity = raw.identity || null; }
    }
    if (this.keys.length === 0) this.newAddress();
    if (!this.identity) this.newIdentity();
    return this;
  }

  save() {
    // Chain.load() happened to create this directory first in every existing
    // caller, so the wallet never had to. A wallet-only tool is not obliged to
    // open a chain.
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ keys: this.keys, identity: this.identity }, null, 2));
  }

  newIdentity() {
    this.identity = BOX.generateIdentity();
    this.save();
    return this.identity.pub;
  }

  newAddress() {
    const { priv, pub } = C.generateKeyPair();
    const address = C.addressFromPub(pub);
    this.keys.push({ priv, pub, address });
    this.save();
    return address;
  }

  get primary() { return this.keys[0].address; }
  addresses() { return this.keys.map(k => k.address); }
  keyForPub(pubHex) {
    const k = this.keys.find(k => k.pub === pubHex);
    if (!k) throw new Error('no key for pub');
    return k;
  }
  keyForAddress(addr) { return this.keys.find(k => k.address === addr); }

  balance(chain) {
    return this.addresses().reduce((s, a) => s + chain.balance(a), 0);
  }

  /**
   * Build & sign a payment. Selects UTXOs across all wallet addresses.
   * `records` rides inside the signed body, so its bytes are paid for here.
   */
  buildTx(chain, toAddress, amountSparks, records = []) {
    // checksum guard: never build a payment to a mistyped/invalid address
    if (!C.isValidAddress(toAddress)) throw new Error('invalid destination address (checksum failed)');
    if (!Number.isInteger(amountSparks) || amountSparks <= 0) throw new Error('invalid amount');
    const fee = TX.requiredFee({ records });
    const target = amountSparks + fee;
    // Gather SPENDABLE utxos. An immature coinbase is rejected by
    // TX.validateNormal, so selecting one builds a transaction that is signed,
    // broadcast and refused — the wallet said "insufficient funds" only when it
    // had genuinely nothing, and otherwise produced a payment that could not
    // land. Two shapes arrive here: the local Chain tags outputs `coinbase` and
    // `height`, while hearth-cli passes a shim over `GET /address/:addr`, which
    // has already worked the maturity out and reports `spendable`. Prefer the
    // node's own answer; otherwise compute it, since an output that is not a
    // coinbase has nothing to mature.
    const spendHeight = (chain.height != null ? chain.height : 0) + 1;
    const isSpendable = (u) => {
      if (u.spendable != null) return u.spendable;
      if (!u.coinbase) return true;
      return u.height != null && (spendHeight - u.height) >= P.COINBASE_MATURITY;
    };
    let pool = [];
    for (const k of this.keys) {
      for (const u of chain.utxosFor(k.address)) if (isSpendable(u)) pool.push({ ...u, key: k });
    }
    pool.sort((a, b) => b.amount - a.amount);
    const inputs = [];
    let sum = 0;
    for (const u of pool) {
      inputs.push({ txid: u.txid, vout: u.vout, pub: u.key.pub });
      sum += u.amount;
      if (sum >= target) break;
    }
    if (sum < target) throw new Error(`insufficient spendable funds: have ${sum}, need ${target} (freshly mined coins are locked for ${P.COINBASE_MATURITY} blocks)`);

    const outputs = [{ address: toAddress, amount: amountSparks }];
    const change = sum - target;
    if (change > 0) outputs.push({ address: this.primary, amount: change });

    const tx = { version: 1, type: 'normal', inputs, outputs };
    if (records.length) tx.records = records;
    TX.signInputs(tx, (pubHex) => this.keyForPub(pubHex));
    return tx;
  }
}

module.exports = { Wallet };
