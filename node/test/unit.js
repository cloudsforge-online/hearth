'use strict';
/* Unit tests for the Hearth node primitives. Zero-dependency mini harness.
 * Run: node test/unit.js */

const C = require('../src/crypto');
const P = require('../src/params');
const TX = require('../src/tx');
const POW = require('../src/pow');
const { Chain } = require('../src/chain');
const { Wallet } = require('../src/wallet');
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

// The difficulty CEILING has to sit far above any plausible network, or the
// chain silently stops being able to get harder, block time falls below target
// and emission accelerates. Stated as work-per-block so the number means
// something: 2^40 attempts is already ~7e10 H/s sustained at 15s blocks.
{
  const work = (1n << 256n) / (BigInt('0x' + P.MIN_TARGET) + 1n);
  ok(work > (1n << 40n), 'difficulty ceiling leaves headroom well past a planet of CPUs');
  /* THE FLOOR MUST NOT BE EASIER THAN THE LAUNCH DIFFICULTY, and this assertion
   * used to require the opposite — it read "easiest target is easier than genesis"
   * and passed, which is how a four-times-free side branch survived review. The
   * LWMA walks a self-fed branch down to MAX_TARGET within about three blocks, and
   * every block it then produces is valid, stored, persisted and relayed while
   * costing a quarter of what an honest one does. */
  ok(BigInt('0x' + P.MAX_TARGET) <= BigInt('0x' + P.GENESIS_TARGET),
    'the difficulty FLOOR is no easier than the genesis target');
  ok(BigInt('0x' + P.MIN_TARGET) <= BigInt('0x' + P.GENESIS_TARGET),
    'and the ceiling is no harder than it');
}

// ---- the mempool must not buy an O(UTXO-set) copy per message ---------------
{
  const { Mempool, UtxoView } = require('../src/mempool');
  const base = new Map([['spent:0', { address: 'a', amount: 5 }]]);
  const view = new UtxoView(() => base);
  ok(view.get('spent:0').amount === 5, 'a view reads through to the live UTXO map');
  view.delete('spent:0');
  ok(view.get('spent:0') === undefined, 'a delete is visible through the view');
  ok(base.get('spent:0').amount === 5, 'and does NOT touch the chain\'s own map');
  view.set('new:0', { address: 'b', amount: 7 });
  ok(view.get('new:0').amount === 7 && !base.has('new:0'), 'nor does a create');

  /* The base is read through a FUNCTION because `chain.utxo` is replaced whole on
   * a reorg (chain.js `_activate`); a view holding the old Map would validate
   * against a chain that no longer exists. */
  let live = new Map([['x:0', { amount: 1 }]]);
  const following = new UtxoView(() => live);
  live = new Map([['x:0', { amount: 2 }]]);
  ok(following.get('x:0').amount === 2, 'the view follows a reorg that replaces the map');

  // and the pool itself never copies: 1,000 junk messages against a large set
  const utxo = new Map();
  for (let i = 0; i < 200_000; i++) utxo.set('u' + i + ':0', { address: 'a', amount: 1, height: 1 });
  const pool = new Mempool({ utxo, height: 1 });
  const started = Date.now();
  for (let i = 0; i < 1000; i++) pool.add({ id: String(i).padStart(64, '0'), inputs: [], outputs: [] });
  const ms = Date.now() - started;
  ok(pool.size === 0, 'a transaction with no inputs is refused');
  /* 1,000 of them used to be 1,000 copies of the UTXO set — ~75 ms at this size
   * and 354 ms EACH at a million. The bound is deliberately loose; it is here to
   * fail if the copy ever comes back, not to measure a machine. */
  ok(ms < 1000, `1,000 junk transactions cost ${ms} ms against a 200k-UTXO set, not a copy each`);
}

group('wallet');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-unit-w-'));
  const w = new Wallet(dir).load();
  const dest = C.addressFromPub(C.generateKeyPair().pub);
  const coin = { txid: 'a'.repeat(64), vout: 0, amount: 10 * P.SPARKS_PER_EMBER, coinbase: true, height: 5 };
  const shim = { height: 5, utxosFor: a => (a === w.primary ? [coin] : []) };
  let refused = false;
  try { w.buildTx(shim, dest, P.SPARKS_PER_EMBER); } catch { refused = true; }
  ok(refused, 'wallet refuses to spend an immature coinbase rather than build a tx the chain rejects');
  shim.height = coin.height + P.COINBASE_MATURITY - 1;   // spendHeight - height === MATURITY
  const tx = w.buildTx(shim, dest, P.SPARKS_PER_EMBER);
  ok(tx.inputs.length === 1, 'wallet spends the same coinbase once it has matured');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} unit checks`);
process.exit(fail === 0 ? 0 : 1);
