'use strict';
/* Transactions & UTXO helpers.
 * UTXO model with Ed25519-signed inputs. Amounts are integer "sparks". */

const C = require('./crypto');
const P = require('./params');

/** Canonical body used for txid and for signing (excludes input signatures). */
function txBody(tx) {
  return {
    // network id binds signatures to this chain (cross-network replay defense)
    net: P.NETWORK,
    version: tx.version || 1,
    type: tx.type || 'normal',
    inputs: (tx.inputs || []).map(i => ({ txid: i.txid, vout: i.vout })),
    outputs: tx.outputs.map(o => ({ address: o.address, amount: o.amount })),
    // coinbase carries the height so identical rewards get distinct ids
    height: tx.height,
  };
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
  if (fee < P.BASE_FEE_SPARKS) return { ok: false, err: 'fee below base fee' };
  if (txid(tx) !== tx.id) return { ok: false, err: 'txid mismatch' };
  return { ok: true, fee };
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

module.exports = { txBody, txid, coinbase, signInputs, validateNormal, applyToUtxo };
