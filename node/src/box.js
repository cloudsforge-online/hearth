'use strict';
/* Sealed boxes: encrypt a payload to an address's reading key.
 *
 * A record on the chain is public and permanent, so anything private that goes
 * into one has to be encrypted before it is signed. This is the primitive every
 * application uses to do that; it is not chat-specific.
 *
 * X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM, all from Node's built-in crypto,
 * because the node has no dependencies and is not about to grow one for this.
 *
 * A fresh ephemeral keypair per message means a recipient's key being stolen
 * tomorrow does not decrypt what was sent today from the sender's side — the
 * sender's half of each exchange is discarded the moment the box is sealed.
 * The recipient's static key still decrypts everything addressed to it, which
 * is what makes an inbox possible at all; rotating it is how you end that.
 *
 * What this does NOT hide: that a message happened, its size, its block, and —
 * because the index key is the recipient's address — who it was for. The chain
 * is a public ledger; metadata is the price of the record being findable.
 */

const crypto = require('crypto');

const VERSION = 1;
const INFO = Buffer.from('hearth-box-v1');
const EPH_LEN = 32, SALT_LEN = 16, NONCE_LEN = 12, TAG_LEN = 16;

/** A reading identity: X25519, private as PEM, public as raw 32-byte hex. */
function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: rawPub(publicKey),
  };
}

/** Raw 32 bytes out of an X25519 public key, whatever form it arrived in. */
function rawPub(key) {
  const der = key.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('hex');
}

function pubKeyFromHex(hex) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('x25519 public key must be 32 bytes');
  // SPKI prefix for X25519, then the raw point.
  const der = Buffer.concat([
    Buffer.from('302a300506032b656e032100', 'hex'),
    raw,
  ]);
  return crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
}

function derive(privateKey, publicKey, salt) {
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, INFO, 32));
}

/**
 * Seal `plaintext` to a recipient's public reading key.
 * Wire format: version | ephemeral pub 32 | salt 16 | nonce 12 | tag 16 | ciphertext
 */
function seal(recipientPubHex, plaintext) {
  const recipient = pubKeyFromHex(recipientPubHex);
  const eph = crypto.generateKeyPairSync('x25519');
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const key = derive(eph.privateKey, recipient, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    Buffer.from(rawPub(eph.publicKey), 'hex'),
    salt, nonce, cipher.getAuthTag(), body,
  ]);
}

/** Open a sealed box with the recipient's private reading key (PEM). */
function open(privPem, sealed) {
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed, 'hex');
  const head = 1 + EPH_LEN + SALT_LEN + NONCE_LEN + TAG_LEN;
  if (buf.length < head) throw new Error('sealed box truncated');
  if (buf[0] !== VERSION) throw new Error('unsupported sealed box version ' + buf[0]);
  let at = 1;
  const eph = buf.subarray(at, at += EPH_LEN);
  const salt = buf.subarray(at, at += SALT_LEN);
  const nonce = buf.subarray(at, at += NONCE_LEN);
  const tag = buf.subarray(at, at += TAG_LEN);
  const key = derive(crypto.createPrivateKey(privPem), pubKeyFromHex(eph.toString('hex')), salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  // Throws on a wrong key or a tampered box, which is the point: there is no
  // "probably yours" outcome to accidentally treat as success.
  return Buffer.concat([decipher.update(buf.subarray(at)), decipher.final()]);
}

/** Bytes a sealed box adds on top of the plaintext. */
const OVERHEAD = 1 + EPH_LEN + SALT_LEN + NONCE_LEN + TAG_LEN;

module.exports = { generateIdentity, seal, open, rawPub, pubKeyFromHex, OVERHEAD, VERSION };
