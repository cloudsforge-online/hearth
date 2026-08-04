'use strict';
/* The browser miner's winning proof, handed to the node that has to accept it.
 * Run: node test/browser-proof.js
 *
 * test/browser-pow.js already pins the browser's HASH loop against src/pow.js,
 * digest for digest. That is half of a submission. The other half is the
 * SIGNATURE over the winning digest, which is what stops a proof handed to you
 * being redeemed by someone else — and nothing anywhere checked that the two
 * sides agreed about its shape.
 *
 * They did not. `web/assets/mining/miner.js` named its format in an exported
 * constant so that "a mismatch with the node is a grep, not an investigation",
 * and the constant said `secp256k1-r||s-64-lowS` — 64 bytes. The node requires
 * 65: `r || s || recoveryId` (src/chain/miner.js `submit`, src/chain/header.js
 * `verifyPow`), because the header carries no separate public key and the
 * verifier recovers one from the signature. So every block the browser miner
 * ever found was answered `bad signature`, after it had done all the work.
 *
 * A constant naming a format is documentation, and documentation cannot be
 * wrong loudly. This drives the browser's own signing code — imported from
 * `web/`, not reimplemented here — through the node's real template flow, and
 * requires a block to come out of it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const POW = require('../src/pow');
const { EvmNode } = require('../src/evmnode');
const C = require('./evm-common');

const WEB = path.join(__dirname, '..', '..', 'web', 'assets');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

(async () => {
  console.log('\nHearth browser-miner proof, against the node that must accept it\n');

  // The browser's OWN crypto and the browser's OWN signing step. Imported rather
  // than copied: a test that reimplements the thing it is testing agrees with
  // itself, which is exactly how this defect survived.
  const secp = await import('file://' + path.join(WEB, 'wallet', 'secp256k1.js'));
  const mining = await import('file://' + path.join(WEB, 'mining', 'miner.js'));

  group('the browser and the node agree on what a proof signature is');
  assert(typeof mining.proofSignature === 'function',
    'the browser exposes the signing step on its own, so it can be tested without a Worker');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-browser-proof-'));
  const node = new EvmNode({ dataDir: dir, quiet: true, genesis: { target: C.EASY_TARGET } });

  // A key that only the "browser" holds. The node never sees it — that is the
  // whole point of remote mining, and why the node cannot sign on its behalf.
  const priv = secp.randomPrivateKey();
  const pub = secp.publicKeyFromPrivate(priv, false);
  const pubHex = Buffer.from(pub).toString('hex');

  const work = node.templates.issue(pubHex);
  assert(work.templateId && work.coreHash && work.target, 'the node issues work for a key it does not hold');
  assert(work.scratchKiB === P.POW_SCRATCH_KIB && work.walkSteps === P.POW_WALK_STEPS,
    'and the PoW parameters travel with it');

  // Grind it — the hash loop itself is already pinned by test/browser-pow.js.
  let nonce = 0, digest = null;
  for (; nonce < 5_000_000; nonce++) {
    const d = POW.homefireHash(POW.powSeed(work.coreHash, nonce, work.coinbasePub)).toString('hex');
    if (POW.meetsTarget(d, work.target)) { digest = d; break; }
  }
  assert(digest !== null, `a winning nonce was found (${nonce})`);

  group('the signature the browser makes is the signature the node checks');
  const powSig = mining.proofSignature(digest, priv);
  assert(/^[0-9a-f]+$/.test(powSig), 'the browser produced a hex signature');
  assert(powSig.length === 130,
    `and it is 65 bytes — r || s || recoveryId (got ${powSig.length / 2} bytes)`);
  assert(mining.POW_SIG_FORM.includes('65') && /recover/i.test(mining.POW_SIG_FORM),
    `POW_SIG_FORM names the format the node actually requires (${mining.POW_SIG_FORM})`);

  const before = node.chain.height;
  const r = node.templates.submit({ templateId: work.templateId, nonce, powDigest: digest, powSig });
  assert(r.ok === true, `THE NODE ACCEPTS IT${r.ok ? '' : ' — ' + r.err}`);
  assert(node.chain.height === before + 1, 'and the chain grew by the block a browser mined');

  group('and the proof is still not transferable');
  {
    // The reason the signature exists at all: work issued to one key must not be
    // redeemable by another. If this passed, the format above would be cosmetic.
    const work2 = node.templates.issue(pubHex);
    let n2 = 0, d2 = null;
    for (; n2 < 5_000_000; n2++) {
      const d = POW.homefireHash(POW.powSeed(work2.coreHash, n2, work2.coinbasePub)).toString('hex');
      if (POW.meetsTarget(d, work2.target)) { d2 = d; break; }
    }
    const thief = secp.randomPrivateKey();
    const stolen = node.templates.submit({
      templateId: work2.templateId, nonce: n2, powDigest: d2, powSig: mining.proofSignature(d2, thief),
    });
    assert(stolen.ok === false, `a proof signed by another key is refused (${stolen.err})`);
    assert(node.chain.height === before + 1, 'and nothing was added to the chain');
  }

  node.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
