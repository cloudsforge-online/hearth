/* Hearth browser wallet core — the in-page mirror of node/src/crypto.js,
 * node/src/tx.js and node/src/wallet.js.
 *
 * Everything here runs on the user's device. The private key is generated with
 * crypto.getRandomValues(), signed with the vendored noble-ed25519, and never
 * transmitted: only the public key, the address and finished signed
 * transactions ever hit the network.
 *
 * The canonical()/txBody() pair below MUST stay byte-identical to the node's,
 * or the signature covers different bytes and every send is rejected.
 */

import * as ed from './vendor/noble-ed25519.js';

export const SPARKS_PER_EMBER = 100000000;
export const BASE_FEE_SPARKS = 40000;

const SPKI_PREFIX = '302a300506032b6570032100';
const PKCS8_PREFIX = '302e020100300506032b657004220420';

const enc = new TextEncoder();

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Deterministic JSON: object keys sorted recursively. Mirrors crypto.js. */
export function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(v => canonical(v)).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function hashObject(obj) {
  return sha256Hex(canonical(obj));
}

// ---- addresses (crypto.js addressFromPub / isValidAddress) ------------------
export async function addressFromPub(pubHex) {
  const body = (await sha256Hex(fromHex(pubHex))).slice(0, 40);
  const check = (await sha256Hex(body)).slice(0, 6);
  return 'ember1' + body + check;
}

export async function isValidAddress(addr) {
  if (typeof addr !== 'string' || !addr.startsWith('ember1')) return false;
  const rest = addr.slice(6);
  if (rest.length !== 46 || !/^[0-9a-f]+$/.test(rest)) return false;
  return rest.slice(40) === (await sha256Hex(rest.slice(0, 40))).slice(0, 6);
}

// ---- keys ------------------------------------------------------------------
// The node stores PKCS#8 PEM private keys and SPKI DER hex public keys. Ed25519
// makes both a fixed prefix + the 32 raw bytes, so a key made here can be
// pasted straight into a hearthd data/wallet.json and vice versa.
function pemFromSeed(seed) {
  const der = fromHex(PKCS8_PREFIX + toHex(seed));
  const b64 = btoa(String.fromCharCode(...der));
  return '-----BEGIN PRIVATE KEY-----\n' + (b64.match(/.{1,64}/g) || []).join('\n') + '\n-----END PRIVATE KEY-----\n';
}

export function seedFromPem(pem) {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  let der;
  try {
    der = toHex(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  } catch (e) { throw new Error('not a valid PEM private key', { cause: e }); }
  if (!der.startsWith(PKCS8_PREFIX) || der.length !== PKCS8_PREFIX.length + 64)
    throw new Error('not an Ed25519 PKCS#8 key');
  return der.slice(PKCS8_PREFIX.length);
}

async function keyFromSeed(seed) {
  const pub = SPKI_PREFIX + toHex(await ed.getPublicKeyAsync(seed));
  return { seed, pub, priv: pemFromSeed(seed), address: await addressFromPub(pub) };
}

export function generateKey() {
  return keyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
}

export function importKey(pem) {
  return keyFromSeed(fromHex(seedFromPem(pem)));
}

// ---- transactions (tx.js txBody / txid / signInputs) -----------------------
export function txBody(tx, net) {
  return {
    net,
    version: tx.version || 1,
    type: tx.type || 'normal',
    inputs: (tx.inputs || []).map(i => ({ txid: i.txid, vout: i.vout })),
    outputs: tx.outputs.map(o => ({ address: o.address, amount: o.amount })),
    height: tx.height,
  };
}

export function txid(tx, net) {
  return hashObject(txBody(tx, net));
}

/** Build & sign a payment from one key's UTXOs. Mirrors wallet.js buildTx. */
export async function buildTx({ key, utxos, to, amountSparks, net, fee = BASE_FEE_SPARKS }) {
  if (!(await isValidAddress(to))) throw new Error('invalid destination address (checksum failed)');
  if (!Number.isInteger(amountSparks) || amountSparks <= 0) throw new Error('invalid amount');

  const target = amountSparks + fee;
  const pool = [...utxos].sort((a, b) => b.amount - a.amount);
  const inputs = [];
  let sum = 0;
  for (const u of pool) {
    inputs.push({ txid: u.txid, vout: u.vout, pub: key.pub });
    sum += u.amount;
    if (sum >= target) break;
  }
  if (sum < target) {
    throw new Error(`insufficient spendable funds: have ${emberStr(sum)}, need ${emberStr(target)} EMBER`);
  }

  const outputs = [{ address: to, amount: amountSparks }];
  const change = sum - target;
  if (change > 0) outputs.push({ address: key.address, amount: change });

  const tx = { version: 1, type: 'normal', inputs, outputs };
  const msg = enc.encode(canonical(txBody(tx, net)));
  const sig = toHex(await ed.signAsync(msg, key.seed));
  tx.inputs = tx.inputs.map(i => ({ ...i, sig }));
  tx.id = await txid(tx, net);
  return tx;
}

// ---- amount formatting -----------------------------------------------------
/** Decimal EMBER string -> integer sparks, without ever touching a float. */
export function emberToSparks(str) {
  const m = String(str).trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error('amount must be a number');
  const frac = (m[2] || '').slice(0, 8).padEnd(8, '0');
  if ((m[2] || '').length > 8) throw new Error('EMBER has at most 8 decimal places');
  return Number(m[1] || '0') * SPARKS_PER_EMBER + Number(frac);
}

export function emberStr(sparks, dp = 8) {
  const neg = sparks < 0;
  const v = Math.abs(sparks);
  const whole = Math.floor(v / SPARKS_PER_EMBER);
  const frac = String(v % SPARKS_PER_EMBER).padStart(8, '0').slice(0, dp).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toLocaleString() + (frac ? '.' + frac : '');
}
