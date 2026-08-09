'use strict';
/* The browser miner's winning proof, handed to the node that has to accept it.
 *
 * test/browser-pow.js pins the browser's HASH loop against src/pow.js, digest
 * for digest. That is half of a submission. The other half is the SIGNATURE over
 * the winning digest — the thing that stops a proof handed to you being redeemed
 * by someone else — and for months nothing anywhere checked that the two sides
 * agreed about its shape.
 *
 * THEY DID NOT. The browser named its format in an exported constant so that "a
 * mismatch with the node is a grep, not an investigation", and the constant said
 * `secp256k1-r||s-64-lowS`. The node requires 65: `r || s || recoveryId`
 * (`src/chain/miner.js` `submit`, `src/chain/header.js` `verifyPow`), because the
 * header carries no separate public key and the verifier recovers one from the
 * signature. So every block the browser miner ever found was answered
 * `bad signature` after it had done all the work — indistinguishable, from the
 * miner's side, from never having won. A constant that names a format is
 * documentation, and documentation cannot be wrong loudly.
 *
 * AND THEN THE CHECK ITSELF WENT MISSING, which is the same failure one level up.
 * The original of this file was deleted with `web/` in `48bc28a` (2026-08-04).
 * The browser miner returned on 2026-08-06 in `micro-network-site`, carrying the
 * corrected `POW_SIG_FORM`; the suite did not return with it, while SECURITY.md
 * and docs/listing-checklist.md M16 went on citing this filename as the reason
 * the defect could not recur.
 *
 * So: this drives the browser's OWN signing code — imported from
 * `micro-network-site/src/mining/miner.js`, not reimplemented here — through the
 * node's real template flow, and requires a block to come out of it. A test that
 * reimplements the thing it is testing agrees with itself, which is exactly how
 * the 64-vs-65 defect survived being "covered".
 *
 * Run: node test/browser-proof.js  (or `npm run test:browser`; NOT part of
 * `npm test` — see test/browser-mining-src.js for why).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const POW = require('../src/pow');
const HDR = require('../src/chain/header');
const { EvmNode } = require('../src/evmnode');
const C = require('./evm-common');
const { resolveBrowserMining, importBrowser } = require('./browser-mining-src');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

/** Grind with the NODE's implementation. What is under test here is the
 *  signature, and browser-pow.js already owns the claim that the two hash
 *  loops agree — repeating it slowly would only make this suite slower. */
function grind(work) {
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const d = POW.homefireHash(POW.powSeed(work.coreHash, nonce, work.coinbasePub)).toString('hex');
    if (POW.meetsTarget(d, work.target)) return { nonce, digest: d };
  }
  return { nonce: -1, digest: null };
}

(async () => {
  const src = resolveBrowserMining();
  console.log('\nHearth browser-miner proof, against the node that must accept it');
  console.log('browser source: ' + src + '\n');

  // The browser's OWN crypto and the browser's OWN signing step.
  const secp = await importBrowser(src, 'secp256k1.js');
  const mining = await importBrowser(src, 'miner.js');

  group('the browser and the node agree on what a proof signature is');
  assert(typeof mining.proofSignature === 'function',
    'the browser exposes the signing step on its own, so it can be tested without a Worker');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-browser-proof-'));
  const node = new EvmNode({ dataDir: dir, quiet: true, genesis: { target: C.EASY_TARGET } });

  try {
    // A key that only the "browser" holds. The node never sees it — that is the
    // whole point of remote mining, and why the node cannot sign on its behalf.
    const priv = secp.randomPrivateKey();
    const pubHex = Buffer.from(secp.publicKeyFromPrivate(priv, false)).toString('hex');

    const work = node.templates.issue(pubHex);
    assert(Boolean(work.templateId && work.coreHash && work.target),
      'the node issues work for a key it does not hold');
    assert(work.scratchKiB === P.POW_SCRATCH_KIB && work.walkSteps === P.POW_WALK_STEPS,
      'and the PoW parameters travel with it, so a retune stops a stale miner rather than silencing it');

    const won = grind(work);
    assert(won.digest !== null, `a winning nonce was found (${won.nonce})`);

    group('the signature the browser makes is the signature the node checks');
    const powSig = mining.proofSignature(won.digest, priv);
    assert(/^[0-9a-f]+$/.test(powSig), 'the browser produced a lowercase hex signature');
    assert(powSig.length === 130,
      `and it is 65 bytes — r || s || recoveryId (got ${powSig.length / 2} bytes)`);
    assert(mining.POW_SIG_FORM.includes('65') && /recover/i.test(mining.POW_SIG_FORM),
      `POW_SIG_FORM names the format the node actually requires (${mining.POW_SIG_FORM})`);

    // The claim under test is not "the strings are the same length". It is that
    // the node can recover the coinbase from what the browser signed — which is
    // what `verifyPow` does and what the 64-byte form made impossible.
    assert(HDR.signProof(won.digest, Buffer.from(priv)) === powSig,
      'and byte for byte it is what src/chain/header.js `signProof` would have produced');

    const before = node.chain.height;
    const r = node.templates.submit({ templateId: work.templateId, nonce: won.nonce, powDigest: won.digest, powSig });
    assert(r.ok === true, `THE NODE ACCEPTS IT${r.ok ? '' : ' — ' + r.err}`);
    assert(node.chain.height === before + 1, 'and the chain grew by the block a browser mined');

    group('and the proof is still not transferable');
    {
      // The reason the signature exists at all: work issued to one key must not
      // be redeemable by another. If this passed, the format above would be
      // cosmetic — a 65-byte signature nobody checks is a 65-byte decoration.
      const work2 = node.templates.issue(pubHex);
      const won2 = grind(work2);
      const thief = secp.randomPrivateKey();
      const stolen = node.templates.submit({
        templateId: work2.templateId,
        nonce: won2.nonce,
        powDigest: won2.digest,
        powSig: mining.proofSignature(won2.digest, thief),
      });
      assert(stolen.ok === false, `a proof signed by another key is refused (${stolen.err})`);
      assert(node.chain.height === before + 1, 'and nothing was added to the chain');
    }
  } finally {
    node.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL — ' + (e && e.stack || e)); process.exit(1); });
