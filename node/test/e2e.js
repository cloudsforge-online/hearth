'use strict';
/* End-to-end test: boot a node in-process, mine, pay, and verify the ledger,
 * emission, commons split, fee burn, coinbase maturity, anti-inflation, and
 * chain reorganization (fork choice). Run: node test/e2e.js */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Node } = require('../src/node');
const POW = require('../src/pow');
const BLOCK = require('../src/block');
const C = require('../src/crypto');
const P = require('../src/params');
const TX = require('../src/tx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-e2e-'));
const node = new Node({ dataDir: tmp, quiet: true });

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}

// brute-force a block on top of `parentId` paying `key`; returns {block,res}
function mineOn(parentId, key) {
  const parent = node.chain.store.get(parentId);
  const height = parent.height + 1;
  const cb = TX.coinbase(height, key.address, 0);
  const txs = [cb];
  const header = {
    version: 1, prevHash: parentId, merkleRoot: C.merkleRoot(txs.map(t => t.id)),
    height,
    // parent+1 rather than wall clock: LWMA weighs solve times, so a fork whose
    // blocks take real seconds to brute-force would get a looser target and could
    // carry less work than the shorter main branch it is supposed to outweigh.
    timestamp: parent.block.header.timestamp + 1,
    target: node.chain._nextTarget(parentId), coinbasePub: key.pub, nonce: 0,
  };
  const coreHash = BLOCK.coreHash(header);
  for (;;) {
    const nonce = header.nonce++;
    const seed = POW.powSeed(coreHash, nonce, header.coinbasePub);
    const digest = POW.homefireHash(seed).toString('hex');
    if (POW.meetsTarget(digest, header.target)) {
      header.nonce = nonce;
      header.powDigest = digest;
      header.powSig = C.sign(key.priv, Buffer.from(digest, 'hex'));
      break;
    }
  }
  const block = { header, txs };
  return { block, res: node.chain.addBlock(block) };
}

const minerKey = node.wallet.keys[0];

// extend the active tip using the real miner candidate (pulls mempool txs)
function mineBlock() {
  const cand = node.miner._candidate();
  for (;;) {
    const nonce = cand.header.nonce++;
    const seed = POW.powSeed(cand.coreHash, nonce, cand.header.coinbasePub);
    const digest = POW.homefireHash(seed).toString('hex');
    if (POW.meetsTarget(digest, cand.header.target)) {
      cand.header.nonce = nonce;
      cand.header.powDigest = digest;
      cand.header.powSig = C.sign(cand.key.priv, Buffer.from(digest, 'hex'));
      const block = { header: cand.header, txs: cand.txs };
      const r = node.chain.addBlock(block);
      if (!r.ok) throw new Error('mineBlock rejected: ' + r.err);
      node.mempool.removeIncluded(block.txs.slice(1));
      return block;
    }
  }
}

console.log('\nHearth end-to-end test\ndata dir:', tmp, '\n');

// 1. genesis / fair launch
assert(node.chain.height === 0, 'genesis loaded at height 0');
assert(node.chain.balance(node.minerAddress) === 0, 'wallet starts empty (no premine)');

// 2. mine 12 blocks (so early coinbases mature; maturity=10)
console.log('mining 12 blocks...');
for (let i = 0; i < 12; i++) mineBlock();
assert(node.chain.height === 12, 'height is 12 after mining');

let expectMiner = 0, expectCommons = 0;
for (let h = 1; h <= 12; h++) {
  const s = P.subsidy(h), c = Math.floor(s * P.COMMONS_SHARE);
  expectMiner += s - c; expectCommons += c;
}
assert(node.chain.balance(node.minerAddress) === expectMiner, 'miner earned subsidy minus commons');
assert(node.chain.balance(P.COMMONS_ADDRESS) === expectCommons, 'commons treasury got 10%');

// 3. deterministic + continuous emission
assert(P.subsidy(1) === P.subsidy(1), 'subsidy is deterministic');
assert(P.subsidy(1) > P.subsidy(P.BLOCKS_PER_YEAR * 3), 'subsidy decays over time');

// 4. coinbase maturity (C3): the newest coinbase can't be spent yet
{
  let immatureKey = null;
  for (const [k, o] of node.chain.utxo) if (o.coinbase && o.height === 12) { immatureKey = k; break; }
  const [txid, vout] = immatureKey.split(':');
  const tx = { version: 1, type: 'normal',
    inputs: [{ txid, vout: Number(vout), pub: minerKey.pub }],
    outputs: [{ address: C.addressFromPub(C.generateKeyPair().pub), amount: 1 * P.SPARKS_PER_EMBER }] };
  TX.signInputs(tx, pub => node.wallet.keyForPub(pub));
  const r = TX.validateNormal(tx, node.chain.utxo, node.chain.height + 1);
  assert(!r.ok && /matured/.test(r.err), 'immature coinbase spend rejected');
}

// 5. a real payment from a matured coinbase, mined into a block
const recipient = C.addressFromPub(C.generateKeyPair().pub);
assert(C.isValidAddress(recipient), 'recipient address has valid checksum');
const sendAmount = 5 * P.SPARKS_PER_EMBER;
const tx = node.wallet.buildTx(node.chain, recipient, sendAmount);
assert(node.submitTx(tx).ok, 'payment accepted into mempool');
console.log('mining block with the payment...');
const payBlock = mineBlock();
assert(payBlock.txs.length === 2, 'block contains coinbase + payment');
assert(node.chain.balance(recipient) === sendAmount, `recipient received exactly ${sendAmount / P.SPARKS_PER_EMBER} EMBER`);
assert(node.chain.burned === P.BASE_FEE_SPARKS, 'base fee burned');

// 6. anti-inflation (C1): a coinbase minting an extra output is rejected
{
  const attacker = C.addressFromPub(C.generateKeyPair().pub);
  const parentId = node.chain.tipId;
  const parent = node.chain.store.get(parentId);
  const height = node.chain.height + 1;
  const cb = TX.coinbase(height, minerKey.address, 0);
  cb.outputs.push({ address: attacker, amount: 1_000_000 * P.SPARKS_PER_EMBER }); // steal
  cb.id = TX.txid(cb);
  const header = { version: 1, prevHash: parentId, merkleRoot: C.merkleRoot([cb.id]),
    height, timestamp: Math.max(Math.floor(Date.now() / 1000), parent.block.header.timestamp + 1),
    target: node.chain._nextTarget(parentId), coinbasePub: minerKey.pub, nonce: 0 };
  const core = BLOCK.coreHash(header);
  for (;;) { const n = header.nonce++; const d = POW.homefireHash(POW.powSeed(core, n, header.coinbasePub)).toString('hex');
    if (POW.meetsTarget(d, header.target)) { header.nonce = n; header.powDigest = d; header.powSig = C.sign(minerKey.priv, Buffer.from(d, 'hex')); break; } }
  const r = node.chain.addBlock({ header, txs: [cb] });
  assert(!r.ok && /over-mint|coinbase/.test(r.err), 'coinbase minting extra coins rejected');
}

// 7. conservation: circulating + burned == total issued
let issued = 0;
for (let h = 1; h <= node.chain.height; h++) issued += P.subsidy(h);
assert(node.chain.supply() + node.chain.burned === issued, 'supply + burned == total issued');

// 8. FORK CHOICE / REORG (C2): a heavier branch replaces the active chain
{
  const heightBefore = node.chain.height;                 // main tip
  assert(node.chain.balance(recipient) === sendAmount, 'payment present before reorg');
  const mainTipId = node.chain.tipId;
  const forkParent = node.chain.chainIndex[heightBefore - 2]; // fork 2 blocks back
  // A distinct miner, so the fork's coinbase (and thus every fork block id) differs
  // from the main branch. Reusing keys[0] reproduced the main chain block-for-block
  // and the first "fork" block came back rejected as 'known'.
  node.wallet.newAddress();
  const forkKey = node.wallet.keys[node.wallet.keys.length - 1];
  let last = forkParent, accepted = 0;
  for (let i = 0; i < 3; i++) {
    const m = mineOn(last, forkKey);
    if (!m.res.ok) { console.log('  ! fork block ' + i + ' rejected: ' + m.res.err); break; }
    accepted++; last = m.res.id;
  }
  assert(accepted === 3, 'all three fork blocks accepted');
  assert(node.chain.store.get(last).work > node.chain.store.get(mainTipId).work,
    'fork branch carries more cumulative work than the branch it replaces');
  assert(node.chain.height === heightBefore + 1, 'chain reorged to the heavier branch');
  assert(node.chain.tipId === last, 'active tip is the new branch tip');
  assert(node.chain.balance(recipient) === 0, 'orphaned payment removed by reorg');
}

// 9. tamper detection
{
  const blk = node.chain.getBlock(1);
  const bad = JSON.parse(JSON.stringify(blk));
  bad.header.powSig = bad.header.powSig.slice(0, -2) + (bad.header.powSig.endsWith('00') ? '01' : '00');
  assert(!BLOCK.verifyPow(bad).ok, 'tampered PoW signature rejected');
}

// 10. persistence: reload replays (and re-validates) from disk to the same tip
const node2 = new Node({ dataDir: tmp, quiet: true });
assert(node2.chain.height === node.chain.height, 'chain reloads from disk at same height');
assert(node2.chain.tipId === node.chain.tipId, 'reloaded chain converges on the same tip');

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
