'use strict';
/* Cryptographic primitives + canonical serialization for Hearth.
 * Uses only Node's built-in crypto (no dependencies). */

const crypto = require('crypto');

/** Deterministic JSON: object keys sorted recursively, so hashes are stable. */
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(Buffer.isBuffer(p) ? p : Buffer.from(String(p)));
  return h.digest();
}

/** hex sha256 of the canonical form of any JSON-able value. */
function hashObject(obj) {
  return sha256(canonical(obj)).toString('hex');
}

// ---- Ed25519 keys ----------------------------------------------------------
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
  };
}

function pubFromPriv(privPem) {
  const priv = crypto.createPrivateKey(privPem);
  const pub = crypto.createPublicKey(priv);
  return pub.export({ type: 'spki', format: 'der' }).toString('hex');
}

function sign(privPem, msgBuf) {
  return crypto.sign(null, msgBuf, crypto.createPrivateKey(privPem)).toString('hex');
}

function verify(pubHex, msgBuf, sigHex) {
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.from(pubHex, 'hex'), type: 'spki', format: 'der',
    });
    return crypto.verify(null, msgBuf, pub, Buffer.from(sigHex, 'hex'));
  } catch { return false; }
}

// ---- Addresses -------------------------------------------------------------
// address = "ember1" + body(40 hex = 20-byte pubkey hash) + checksum(6 hex).
// The checksum makes a mistyped address detectable, so funds can't be lost to a
// typo. Identical scheme in the Rust core (rust/hearthd/src/crypto.rs).
function addressFromPub(pubHex) {
  const body = sha256(Buffer.from(pubHex, 'hex')).toString('hex').slice(0, 40);
  const check = sha256(Buffer.from(body)).toString('hex').slice(0, 6);
  return 'ember1' + body + check;
}

function isValidAddress(addr) {
  if (typeof addr !== 'string' || !addr.startsWith('ember1')) return false;
  const rest = addr.slice(6);
  if (rest.length !== 46 || !/^[0-9a-f]+$/.test(rest)) return false;
  const body = rest.slice(0, 40);
  const check = rest.slice(40);
  return check === sha256(Buffer.from(body)).toString('hex').slice(0, 6);
}

// ---- Merkle root -----------------------------------------------------------
function merkleRoot(hashesHex) {
  if (hashesHex.length === 0) return sha256('empty').toString('hex');
  let layer = hashesHex.map(h => Buffer.from(h, 'hex'));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = layer[i + 1] || layer[i]; // duplicate last if odd
      next.push(sha256(a, b));
    }
    layer = next;
  }
  return layer[0].toString('hex');
}

module.exports = {
  canonical, sha256, hashObject,
  generateKeyPair, pubFromPriv, sign, verify,
  addressFromPub, isValidAddress, merkleRoot,
};
