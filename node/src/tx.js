'use strict';
/* Transactions & UTXO helpers.
 * UTXO model with Ed25519-signed inputs. Amounts are integer "sparks". */

const C = require('./crypto');
const P = require('./params');

/** The records of a tx, in the shape the body commits to. */
function txRecords(tx) {
  return (tx.records || []).map(r => ({ app: r.app, key: r.key || '', data: r.data }));
}

/** Payload bytes a record carries. `data` is hex, so two chars per byte. */
function recordBytes(r) {
  return Math.ceil(String(r.data || '').length / 2);
}

/** Total payload bytes across a tx. Priced, and bounded, by this. */
function txRecordBytes(tx) {
  return txRecords(tx).reduce((n, r) => n + recordBytes(r), 0);
}

/** Fee a tx must burn: the flat base, plus the bytes it asks everyone to store. */
function requiredFee(tx) {
  return P.BASE_FEE_SPARKS + txRecordBytes(tx) * P.FEE_PER_RECORD_BYTE_SPARKS;
}

/**
 * Canonical body used for txid and for signing (excludes input signatures).
 *
 * `records` is omitted when empty, which is what keeps every transaction ever
 * signed before records existed hashing to the same id. Adding the key
 * unconditionally would change the body of every historical tx and invalidate
 * the whole chain on replay.
 */
function txBody(tx) {
  const body = {
    // network id binds signatures to this chain (cross-network replay defense)
    net: P.NETWORK,
    version: tx.version || 1,
    type: tx.type || 'normal',
    inputs: (tx.inputs || []).map(i => ({ txid: i.txid, vout: i.vout })),
    outputs: tx.outputs.map(o => ({ address: o.address, amount: o.amount })),
    // coinbase carries the height so identical rewards get distinct ids
    height: tx.height,
  };
  const records = txRecords(tx);
  if (records.length) body.records = records;
  return body;
}

/**
 * Shape and size rules for application records.
 *
 * Called from validateNormal, so these are consensus: a node that skipped them
 * would accept a transaction its peers reject. `spendHeight` gates activation —
 * before it, a record is not a small record, it is an invalid transaction.
 */
function validateRecords(tx, spendHeight) {
  const records = txRecords(tx);
  if (!records.length) return { ok: true };
  if (spendHeight != null && spendHeight < P.RECORDS_ACTIVATION_HEIGHT)
    return { ok: false, err: 'records not active at this height' };
  if (records.length > P.MAX_TX_RECORDS) return { ok: false, err: 'too many records' };
  let total = 0;
  for (const r of records) {
    if (!P.APP_NS_RE.test(r.app || '')) return { ok: false, err: 'bad record app namespace' };
    if (r.key !== '' && !P.RECORD_KEY_RE.test(r.key)) return { ok: false, err: 'bad record key' };
    if (typeof r.data !== 'string' || !/^[0-9a-f]*$/.test(r.data) || r.data.length % 2)
      return { ok: false, err: 'record data must be hex' };
    const n = recordBytes(r);
    if (n === 0) return { ok: false, err: 'empty record' };
    if (n > P.MAX_RECORD_BYTES) return { ok: false, err: 'record too large' };
    total += n;
  }
  if (total > P.MAX_TX_RECORD_BYTES) return { ok: false, err: 'tx record data too large' };
  return { ok: true };
}

/** Serialized size of a tx, measured the one way every node agrees on. */
function txSize(tx) {
  return Buffer.byteLength(C.canonical(txBody(tx)));
}

function txid(tx) {
  return C.hashObject(txBody(tx));
}

/** Build & sign a coinbase transaction (miner reward split with the Commons). */
function coinbase(height, minerAddress, feesToMiner) {
  const subsidy = P.subsidy(height);
  const commons = Math.floor(subsidy * P.COMMONS_SHARE);
  const minerCut = subsidy - commons + feesToMiner;   // tips go to miner
  const tx = {
    version: 1, type: 'coinbase', height, inputs: [],
    outputs: [
      { address: minerAddress, amount: minerCut },
      { address: P.COMMONS_ADDRESS, amount: commons },
    ].filter(o => o.amount > 0),
  };
  tx.id = txid(tx);
  return tx;
}

/** Sign every input of a normal tx with the matching private key (PEM). */
function signInputs(tx, keyForPub) {
  const body = txBody(tx);
  const msg = Buffer.from(C.canonical(body));
  tx.inputs = tx.inputs.map(inp => {
    const { priv, pub } = keyForPub(inp.pub);
    return { ...inp, pub, sig: C.sign(priv, msg) };
  });
  tx.id = txid(tx);
  return tx;
}

/**
 * Validate a normal tx against a UTXO set (Map "txid:vout" -> {address, amount}).
 * Returns { ok, fee } or { ok:false, err }.
 */
function validateNormal(tx, utxo, spendHeight) {
  if (!tx.inputs || tx.inputs.length === 0) return { ok: false, err: 'no inputs' };
  if (!tx.outputs || tx.outputs.length === 0) return { ok: false, err: 'no outputs' };
  if (tx.inputs.length > P.MAX_TX_INPUTS) return { ok: false, err: 'too many inputs' };
  if (tx.outputs.length > P.MAX_TX_OUTPUTS) return { ok: false, err: 'too many outputs' };
  const rec = validateRecords(tx, spendHeight);
  if (!rec.ok) return rec;
  if (txSize(tx) > P.MAX_TX_BYTES) return { ok: false, err: 'tx too large' };
  const msg = Buffer.from(C.canonical(txBody(tx)));
  let inSum = 0;
  const seen = new Set();
  for (const inp of tx.inputs) {
    const key = inp.txid + ':' + inp.vout;
    if (seen.has(key)) return { ok: false, err: 'double spend within tx' };
    seen.add(key);
    const out = utxo.get(key);
    if (!out) return { ok: false, err: 'input not found / already spent: ' + key };
    if (C.addressFromPub(inp.pub) !== out.address) return { ok: false, err: 'wrong key for input' };
    if (!C.verify(inp.pub, msg, inp.sig)) return { ok: false, err: 'bad signature' };
    // coinbase maturity: freshly-mined coins can't be spent until N blocks deep
    if (out.coinbase && spendHeight != null && (spendHeight - out.height) < P.COINBASE_MATURITY)
      return { ok: false, err: 'coinbase not matured' };
    inSum += out.amount;
  }
  let outSum = 0;
  for (const o of tx.outputs) {
    if (!Number.isInteger(o.amount) || o.amount <= 0) return { ok: false, err: 'invalid output amount' };
    if (o.amount > P.MAX_MONEY) return { ok: false, err: 'output exceeds MAX_MONEY' };
    outSum += o.amount;
  }
  const fee = inSum - outSum;
  const required = requiredFee(tx);
  if (fee < required) return { ok: false, err: 'fee below required fee' };
  if (txid(tx) !== tx.id) return { ok: false, err: 'txid mismatch' };
  return { ok: true, fee, required };
}

/** Apply a tx to a UTXO map in place (spend inputs, create outputs).
 *  `blockHeight` tags outputs so coinbase maturity can be enforced. */
function applyToUtxo(tx, utxo, blockHeight) {
  for (const inp of (tx.inputs || [])) utxo.delete(inp.txid + ':' + inp.vout);
  const coinbase = tx.type === 'coinbase';
  tx.outputs.forEach((o, vout) => utxo.set(tx.id + ':' + vout, {
    address: o.address, amount: o.amount, coinbase, height: blockHeight,
  }));
}

module.exports = {
  txBody, txid, coinbase, signInputs, validateNormal, applyToUtxo,
  txRecords, txRecordBytes, requiredFee, validateRecords, txSize,
};
