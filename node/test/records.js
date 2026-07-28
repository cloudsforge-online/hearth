'use strict';
/* Records + chat: the consensus rules for application data, and one whole
 * conversation carried by them.
 *
 * Run: node test/records.js   (also part of `npm test`) */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const C = require('../src/crypto');
const P = require('../src/params');
const TX = require('../src/tx');
const POW = require('../src/pow');
const BOX = require('../src/box');
const CHAT = require('../src/apps/chat');
const { Node } = require('../src/node');
const { Wallet } = require('../src/wallet');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}
function section(s) { console.log('\n• ' + s); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-records-'));

/** Mine the real miner's candidate onto the tip, so mempool txs get included. */
function mineBlock(node) {
  const cand = node.miner._candidate();
  for (;;) {
    const nonce = cand.header.nonce++;
    const seed = POW.powSeed(cand.coreHash, nonce, cand.header.coinbasePub);
    const digest = POW.homefireHash(seed).toString('hex');
    if (!POW.meetsTarget(digest, cand.header.target)) continue;
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

// ---------------------------------------------------------------- body/commit
section('records are committed, not attached');
{
  const base = { version: 1, type: 'normal', inputs: [{ txid: 'a'.repeat(64), vout: 0 }], outputs: [{ address: 'ember1x', amount: 5 }] };
  const withoutRecords = TX.txid(base);
  const emptyRecords = TX.txid({ ...base, records: [] });
  ok(withoutRecords === emptyRecords,
    'an empty records list does not change the txid (old txs still hash the same)');

  const withRecord = TX.txid({ ...base, records: [{ app: 'chat', key: 'k', data: 'ab' }] });
  ok(withRecord !== withoutRecords, 'a record changes the txid — it is inside the signed body');

  const flipped = TX.txid({ ...base, records: [{ app: 'chat', key: 'k', data: 'ac' }] });
  ok(flipped !== withRecord, 'changing one payload byte changes the txid');

  ok(TX.txBody({ ...base, records: [] }).records === undefined,
    'the body omits records entirely when there are none');
}

// ---------------------------------------------------------------- shape rules
section('shape and size are consensus');
const rec = (over = {}) => ({ app: 'chat', key: 'k', data: 'abcd', ...over });
{
  const v = r => TX.validateRecords({ records: [r] }, 100);
  ok(v(rec()).ok, 'a well-formed record validates');
  ok(!v(rec({ app: 'Chat' })).ok, 'namespace must be lowercase');
  ok(!v(rec({ app: 'x' })).ok, 'namespace must be at least two characters');
  ok(!v(rec({ app: '' })).ok, 'namespace is required');
  ok(!v(rec({ data: 'abc' })).ok, 'payload must be whole bytes');
  ok(!v(rec({ data: 'zz' })).ok, 'payload must be hex');
  ok(!v(rec({ data: '' })).ok, 'an empty record is not a record');
  ok(!v(rec({ key: 'NOPE' })).ok, 'index key charset is enforced');
  ok(!v(rec({ data: 'ab'.repeat(P.MAX_RECORD_BYTES + 1) })).ok, 'oversized record rejected');
  ok(v(rec({ key: '' })).ok, 'the index key is optional');

  const many = { records: Array.from({ length: P.MAX_TX_RECORDS + 1 }, () => rec()) };
  ok(!TX.validateRecords(many, 100).ok, 'too many records in one tx rejected');

  const big = { records: Array.from({ length: 4 }, () => rec({ data: 'ab'.repeat(P.MAX_RECORD_BYTES) })) };
  ok(!TX.validateRecords(big, 100).ok, 'total payload across a tx is capped');
}

section('activation height gates records');
{
  const tx = { records: [rec()] };
  const saved = P.RECORDS_ACTIVATION_HEIGHT;
  P.RECORDS_ACTIVATION_HEIGHT = 50;
  ok(!TX.validateRecords(tx, 49).ok, 'a record below the activation height is invalid');
  ok(TX.validateRecords(tx, 50).ok, 'and valid at it');
  ok(TX.validateRecords({ records: [] }, 0).ok, 'a tx with no records is unaffected');
  P.RECORDS_ACTIVATION_HEIGHT = saved;
}

// ---------------------------------------------------------------------- fees
section('data is paid for by the byte, and burned');
{
  const bare = TX.requiredFee({});
  ok(bare === P.BASE_FEE_SPARKS, 'a tx with no records owes exactly the base fee');
  const withData = TX.requiredFee({ records: [rec({ data: 'ab'.repeat(1000) })] });
  ok(withData === P.BASE_FEE_SPARKS + 1000 * P.FEE_PER_RECORD_BYTE_SPARKS,
    'a 1000-byte payload owes the base fee plus 1000 byte-fees');
  ok(withData > bare, 'carrying data costs more than not carrying it');
}

// ------------------------------------------------------------------ box/crypto
section('sealed boxes');
{
  const alice = BOX.generateIdentity();
  const bob = BOX.generateIdentity();
  const sealed = BOX.seal(bob.pub, 'the grid went dark');
  ok(BOX.open(bob.priv, sealed).toString() === 'the grid went dark', 'recipient opens the box');
  assert.throws(() => BOX.open(alice.priv, sealed), 'wrong key throws');
  ok(true, 'a third party cannot open it');

  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => BOX.open(bob.priv, tampered), 'tampering throws');
  ok(true, 'a flipped ciphertext byte fails the auth tag');

  const a = BOX.seal(bob.pub, 'same'), b = BOX.seal(bob.pub, 'same');
  ok(!a.equals(b), 'sealing the same text twice gives different bytes');
}

// ------------------------------------------------------------- end to end
section('a conversation on the chain');
{
  const node = new Node({ dataDir: path.join(tmp, 'alice'), quiet: true });
  const chain = node.chain, mempool = node.mempool;
  const alice = node.wallet;
  const bob = new Wallet(path.join(tmp, 'bob')).load();

  // Alice mines enough to spend (coinbase maturity + a few to spare).
  for (let i = 0; i < P.COINBASE_MATURITY + 3; i++) mineBlock(node);
  ok(chain.height >= P.COINBASE_MATURITY, `alice mined to height ${chain.height}`);
  ok(chain.balance(alice.primary) > 0, 'alice has coins to pay the data fee with');

  // Bob needs his own coins: an announcement is only trustworthy because the
  // address it names is the address that signed it.
  const fund = alice.buildTx(chain, bob.primary, 50_000_000);
  ok(mempool.add(fund).ok, 'alice funds bob');
  mineBlock(node);

  const ann = bob.buildTx(chain, bob.primary, 1, [CHAT.announceRecord(bob.primary, bob.identity.pub)]);
  ok(mempool.add(ann).ok, 'bob announces his reading key');
  mineBlock(node);

  const announced = chain.getRecords(CHAT.APP, bob.primary);
  ok(announced.length === 1, 'the announcement is indexed under bob address');
  ok(announced[0].from === bob.primary, 'and attributed to the address that signed it');
  const bobKey = CHAT.resolveReadingKey(announced, bob.primary);
  ok(bobKey === bob.identity.pub, 'alice resolves bob reading key from the chain');

  // Alice writes to Bob.
  const text = 'ninety days after, the hearth is still lit';
  const msg = alice.buildTx(chain, alice.primary, 1, [CHAT.messageRecord(bob.primary, bobKey, text)]);
  ok(mempool.add(msg).ok, 'alice broadcasts an encrypted message');
  mineBlock(node);

  const inboxRecords = chain.getRecords(CHAT.APP, bob.primary);
  const inbox = CHAT.readInbox(inboxRecords, bob.identity.priv);
  ok(inbox.length === 1, 'bob inbox has exactly one message (the announcement is not one)');
  ok(inbox[0].body === text, 'and it decrypts to what alice wrote');
  ok(inbox[0].from === alice.primary, 'sender is read off the signed inputs');

  const eavesdrop = CHAT.readInbox(inboxRecords, alice.identity.priv);
  ok(eavesdrop.length === 0, 'alice cannot read the message she sent (no key escrow)');

  // The message is findable the way an app would look for it.
  const found = chain.getTx(msg.id);
  ok(found && found.tx.id === msg.id, 'GET /tx/:txid finds the carrying transaction');
  ok(found.confirmations >= 1, 'and reports its confirmation depth');

  // The bytes are really in the block, not bolted onto it.
  const block = chain.getBlock(found.height);
  const inBlock = block.txs.find(t => t.id === msg.id);
  ok(TX.txRecords(inBlock).length === 1, 'the record is in the stored block');
  ok(TX.txid(inBlock) === inBlock.id, 'and the stored tx still hashes to its id with the record in it');

  // An unauthenticated rewrite must not survive.
  const rewritten = JSON.parse(JSON.stringify(inBlock));
  rewritten.records[0].data = rewritten.records[0].data.replace(/^../, 'ff');
  ok(TX.txid(rewritten) !== rewritten.id, 'a relay that edits a record breaks the txid');

  ok(chain.burned > 0, 'data fees were burned, not paid to the miner');
}

section('reorg unwrites records');
{
  const node = new Node({ dataDir: path.join(tmp, 'reorg'), quiet: true });
  const chain = node.chain, w = node.wallet;
  for (let i = 0; i < P.COINBASE_MATURITY + 2; i++) mineBlock(node);

  const tx = w.buildTx(chain, w.primary, 1, [{ app: 'notes', key: 'x', data: 'c0ffee' }]);
  node.mempool.add(tx);
  mineBlock(node);
  ok(chain.getRecords('notes', 'x').length === 1, 'record indexed on the active chain');
  ok(chain.getTx(tx.id) !== null, 'and its tx is findable');

  // Rebuild the index from a parent that never saw it.
  const parent = chain.chainIndex[chain.height - 1];
  chain._reindex(parent);
  ok(chain.getRecords('notes', 'x').length === 0, 'a record on an abandoned branch is gone');
  ok(chain.getTx(tx.id) === null, 'and so is its transaction');
}

section('a block cannot smuggle unbounded bytes');
{
  const node = new Node({ dataDir: path.join(tmp, 'limits'), quiet: true });
  const chain = node.chain, w = node.wallet;
  for (let i = 0; i < P.COINBASE_MATURITY + 2; i++) mineBlock(node);

  const huge = () => ({ app: 'spam', key: 'x', data: 'ab'.repeat(P.MAX_RECORD_BYTES) });
  const tx = w.buildTx(chain, w.primary, 1, [huge(), huge(), huge()]);
  const r = node.mempool.add(tx);
  ok(!r.ok, `mempool rejects a tx over the payload cap (${r.err})`);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
