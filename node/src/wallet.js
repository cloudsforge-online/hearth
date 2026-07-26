'use strict';
/* Non-custodial wallet: key management, balance, and building/signing txs.
 * Keys are stored locally (data/wallet.json). Private keys never leave disk. */

const fs = require('fs');
const path = require('path');
const C = require('./crypto');
const P = require('./params');
const TX = require('./tx');

class Wallet {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'wallet.json');
    this.keys = []; // [{ priv, pub, address }]
  }

  load() {
    if (fs.existsSync(this.file)) this.keys = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (this.keys.length === 0) this.newAddress();
    return this;
  }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.keys, null, 2)); }

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

  /** Build & sign a payment. Selects UTXOs across all wallet addresses. */
  buildTx(chain, toAddress, amountSparks) {
    // checksum guard: never build a payment to a mistyped/invalid address
    if (!C.isValidAddress(toAddress)) throw new Error('invalid destination address (checksum failed)');
    if (!Number.isInteger(amountSparks) || amountSparks <= 0) throw new Error('invalid amount');
    const fee = P.BASE_FEE_SPARKS;
    const target = amountSparks + fee;
    // gather spendable utxos
    let pool = [];
    for (const k of this.keys) {
      for (const u of chain.utxosFor(k.address)) pool.push({ ...u, key: k });
    }
    pool.sort((a, b) => b.amount - a.amount);
    const inputs = [];
    let sum = 0;
    for (const u of pool) {
      inputs.push({ txid: u.txid, vout: u.vout, pub: u.key.pub });
      sum += u.amount;
      if (sum >= target) break;
    }
    if (sum < target) throw new Error(`insufficient funds: have ${sum}, need ${target}`);

    const outputs = [{ address: toAddress, amount: amountSparks }];
    const change = sum - target;
    if (change > 0) outputs.push({ address: this.primary, amount: change });

    const tx = { version: 1, type: 'normal', inputs, outputs };
    TX.signInputs(tx, (pubHex) => this.keyForPub(pubHex));
    return tx;
  }
}

module.exports = { Wallet };
