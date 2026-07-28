'use strict';
/* Signing and broadcasting, with one transaction in flight at a time.
 *
 * The signing itself is NOT reimplemented here. It is
 * `node/src/chain/transaction.js` — the tree's own codec, the one whose
 * canonicality rules, low-S enforcement and EIP-155 `v` are pinned against
 * published vectors and exercised by `node/test/transaction.js`. A faucet that
 * hand-rolled RLP would be the one place in the repository where a transaction
 * is built by code nobody tests.
 *
 * NONCES ARE THE HARD PART, and they are why sends are serialised.
 * `eth_getTransactionCount(addr, "pending")` counts what the node has seen. Ask
 * it twice before the first transaction reaches the mempool and it answers the
 * same number twice; the second transaction then replaces the first instead of
 * following it, and one of the two users never gets paid. So: one send at a
 * time, a locally held counter as the source of truth, and a resync from the
 * node whenever the queue drains or a send fails.
 */

const path = require('path');
const NODE_SRC = path.join(__dirname, '..', '..', '..', 'node', 'src');
const TX = require(path.join(NODE_SRC, 'chain', 'transaction'));
const secp = require(path.join(NODE_SRC, 'crypto', 'secp256k1'));

const { toChecksum } = require('./address');

class Sender {
  /**
   * @param {object} o
   * @param {Buffer} o.privateKey
   * @param {import('./rpc').Rpc} o.rpc
   * @param {number} o.chainId
   * @param {bigint} o.gasPriceWei
   * @param {bigint} o.gasLimit
   */
  constructor(o) {
    if (!secp.isValidPrivateKey(o.privateKey)) throw new Error('the faucet key is not a valid secp256k1 scalar');
    this.key = o.privateKey;
    this.rpc = o.rpc;
    this.chainId = o.chainId;
    this.gasPriceWei = o.gasPriceWei;
    this.gasLimit = o.gasLimit;

    const pub = secp.publicKeyFromPrivate(this.key, false);
    this.addressBytes = Buffer.from(TX.addressFromPublicKey(pub));
    this.address = toChecksum('0x' + this.addressBytes.toString('hex'));

    this.nonce = null;        // null means "ask the node"
    this.queue = Promise.resolve();
  }

  /** The most a single drip can cost: the value plus the whole gas allowance. */
  maxCostWei(valueWei) { return valueWei + this.gasLimit * this.gasPriceWei; }

  /** Serialise everything through one promise chain — one nonce at a time. */
  _serialise(fn) {
    const run = this.queue.then(fn, fn);
    // Swallow here so a rejection does not poison the chain for the next caller;
    // the caller still sees it through `run`.
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  async send(toBytes, valueWei) {
    return this._serialise(async () => {
      if (this.nonce === null) this.nonce = await this.rpc.getNonce(this.address, 'pending');

      const unsigned = {
        nonce: this.nonce,
        gasPrice: this.gasPriceWei,
        gasLimit: this.gasLimit,
        to: toBytes,
        value: valueWei,
        data: Buffer.alloc(0),
      };

      // EIP-155 signing. Every drip is chain-bound; an unprotected signature
      // here would be replayable on any chain that accepts pre-155, and the
      // faucet holds the only key that matters.
      const signed = TX.sign(unsigned, this.key, { chainId: this.chainId });
      const raw = TX.encode(signed);
      const hash = '0x' + Buffer.from(TX.hash(raw)).toString('hex');

      try {
        const returned = await this.rpc.sendRawTransaction(raw);
        /* The node returns keccak256(raw), which we already computed. If they
         * disagree, one of the two encodings is wrong and continuing would mean
         * reporting a hash that never existed. */
        if (returned && returned.toLowerCase() !== hash) {
          throw new Error(`node returned hash ${returned}, we computed ${hash}`);
        }
        this.nonce += 1n;
        return { hash, nonce: unsigned.nonce };
      } catch (e) {
        /* Resync on any failure. "nonce too low" means the node saw something
         * we did not; a transport error means we do not know whether it landed.
         * Both are answered by asking rather than guessing. */
        this.nonce = null;
        throw e;
      }
    });
  }

  balance() { return this.rpc.getBalance(this.address); }
}

module.exports = { Sender };
