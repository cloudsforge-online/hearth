'use strict';
/* Unit tests for the Hearth node primitives. Zero-dependency mini harness.
 * Run: node test/unit.js */

const C = require('../src/crypto');
const P = require('../src/params');
const TX = require('../src/tx');
const POW = require('../src/pow');
const { Chain } = require('../src/chain');
const fs = require('fs'); const os = require('os'); const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function group(name) { console.log('• ' + name); }

// ---- crypto ----------------------------------------------------------------
group('crypto');
ok(C.canonical({ b: 1, a: 2 }) === C.canonical({ a: 2, b: 1 }), 'canonical is key-order independent');
ok(C.hashObject({ x: 1 }) === C.hashObject({ x: 1 }), 'hashObject deterministic');
ok(C.hashObject({ x: 1 }) !== C.hashObject({ x: 2 }), 'hashObject sensitive to content');
{
  const { priv, pub } = C.generateKeyPair();
  const msg = Buffer.from('hello hearth');
  const sig = C.sign(priv, msg);
  ok(C.verify(pub, msg, sig), 'ed25519 sign/verify roundtrip');
  ok(!C.verify(pub, Buffer.from('tampered'), sig), 'verify rejects wrong message');
  ok(C.pubFromPriv(priv) === pub, 'public key derivable from private');
  const addr = C.addressFromPub(pub);
  ok(addr.startsWith('ember1') && addr.length === 52, 'address format (checksummed)');
  ok(C.isValidAddress(addr), 'valid address passes checksum');
  const typo = addr.slice(0, 10) + (addr[10] === 'a' ? 'b' : 'a') + addr.slice(11);
  ok(!C.isValidAddress(typo), 'mistyped address fails checksum');
  ok(!C.isValidAddress('ember1zzz') && !C.isValidAddress('bc1qxyz'), 'garbage addresses rejected');
}
ok(C.merkleRoot(['a'.repeat(64), 'b'.repeat(64)]) === C.merkleRoot(['a'.repeat(64), 'b'.repeat(64)]), 'merkle root deterministic');
ok(C.merkleRoot(['a'.repeat(64)]) !== C.merkleRoot(['b'.repeat(64)]), 'merkle root content-sensitive');

// ---- pow -------------------------------------------------------------------
group('pow');
{
  const seed = POW.h('seed');
  ok(POW.homefireHash(seed).equals(POW.homefireHash(seed)), 'homefireHash deterministic');
  ok(!POW.homefireHash(seed).equals(POW.homefireHash(POW.h('other'))), 'homefireHash seed-sensitive');
  ok(POW.meetsTarget('00'.repeat(32), 'ff'.repeat(32)), 'meetsTarget: min digest passes max target');
  ok(!POW.meetsTarget('ff'.repeat(32), '00'.repeat(31) + '01'), 'meetsTarget: max digest fails tiny target');
}

// ---- emission --------------------------------------------------------------
group('emission');
ok(P.subsidy(1) > P.subsidy(1000000), 'subsidy decays with height');
ok(P.subsidy(10 ** 9) >= Math.round(P.TAIL_EMBER * P.SPARKS_PER_EMBER), 'subsidy never below tail');
ok(Math.floor(P.subsidy(1) * P.COMMONS_SHARE) > 0, 'commons share positive');

// ---- transactions ----------------------------------------------------------
group('tx');
{
  const cb = TX.coinbase(1, 'ember1' + 'a'.repeat(40), 0);
  const subsidy = P.subsidy(1), commons = Math.floor(subsidy * P.COMMONS_SHARE);
  ok(cb.outputs[0].amount === subsidy - commons, 'coinbase pays miner subsidy minus commons');
  ok(cb.outputs.find(o => o.address === P.COMMONS_ADDRESS).amount === commons, 'coinbase funds commons');

  // craft a spendable utxo and a valid spend
  const k = C.generateKeyPair(); const addr = C.addressFromPub(k.pub);
  const utxo = new Map([['deadbeef:0', { address: addr, amount: 100 * P.SPARKS_PER_EMBER }]]);
  const to = 'ember1' + 'c'.repeat(40);
  const spend = { version: 1, type: 'normal',
    inputs: [{ txid: 'deadbeef', vout: 0, pub: k.pub }],
    outputs: [{ address: to, amount: 90 * P.SPARKS_PER_EMBER },
              { address: addr, amount: 100 * P.SPARKS_PER_EMBER - 90 * P.SPARKS_PER_EMBER - P.BASE_FEE_SPARKS }] };
  TX.signInputs(spend, () => k);
  ok(TX.validateNormal(spend, utxo).ok, 'valid signed spend accepted');

  // bad signature
  const bad = JSON.parse(JSON.stringify(spend));
  bad.inputs[0].sig = bad.inputs[0].sig.replace(/^../, '00');
  ok(!TX.validateNormal(bad, utxo).ok, 'tampered signature rejected');

  // insufficient fee
  const greedy = { version: 1, type: 'normal',
    inputs: [{ txid: 'deadbeef', vout: 0, pub: k.pub }],
    outputs: [{ address: to, amount: 100 * P.SPARKS_PER_EMBER }] }; // no fee left
  TX.signInputs(greedy, () => k);
  ok(!TX.validateNormal(greedy, utxo).ok, 'fee below base fee rejected');

  // spending a non-existent input
  const ghost = JSON.parse(JSON.stringify(spend));
  ghost.inputs[0].txid = 'cafe';
  TX.signInputs(ghost, () => k);
  ok(!TX.validateNormal(ghost, utxo).ok, 'unknown input rejected');
}

// ---- chain difficulty ------------------------------------------------------
group('chain');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-unit-'));
  const chain = new Chain(dir).load();
  ok(chain.height === 0, 'fresh chain at genesis');
  const t = BigInt('0x' + chain.nextTarget());
  ok(t >= BigInt('0x' + P.MIN_TARGET) && t <= BigInt('0x' + P.MAX_TARGET), 'nextTarget within bounds');
  ok(chain.supply() === 0, 'genesis creates no spendable supply');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} unit checks`);
process.exit(fail === 0 ? 0 : 1);
