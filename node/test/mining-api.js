'use strict';
/* Remote mining, over the real HTTP endpoints.
 *
 * Stands up a node, then plays the part of a browser: ask for a template, grind
 * nonces with the BROWSER implementation (web/assets/mining/*), sign the winning
 * digest locally, and post the proof. The node must end up one block taller with
 * the reward paid to the key that did the work.
 *
 * Run: node test/mining-api.js   (also part of `npm test`) */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Node } = require('../src/node');
const C = require('../src/crypto');
const P = require('../src/params');
const BLOCK = require('../src/block');
const { MAX_TEMPLATES } = require('../src/mining');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log('  ✓ ' + label)) : (fail++, console.log('  ✗ ' + label)); };
const section = s => console.log('\n• ' + s);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-mining-'));

(async () => {
  const { Sha256, toHex } = await import('../../web/assets/mining/sha256.js');
  const { Homefire, powSeed, meetsTarget, hexToBytes } = await import('../../web/assets/mining/homefire.js');

  const node = new Node({ dataDir: tmp, quiet: true });
  const port = 18600 + (process.pid % 500);
  node.rpc.listen(port);
  await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const get = async p => (await fetch(base + p)).json();
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  // A key that exists only here — the node has never seen its private half.
  const kp = crypto.generateKeyPairSync('ed25519');
  const miner = {
    priv: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
  };
  miner.address = C.addressFromPub(miner.pub);

  // ------------------------------------------------------------- template
  section('the node hands out work that pays the asker');
  {
    const bad = await fetch(`${base}/mining/template?pub=nonsense`);
    ok(bad.status === 400, 'a malformed pubkey is refused before any work is built');

    const t = await get(`/mining/template?pub=${miner.pub}`);
    ok(!!t.templateId, 'template issued');
    ok(t.coinbaseAddress === miner.address, 'the coinbase pays the address that asked for it');
    ok(t.coinbasePub === miner.pub, 'and commits to the asking pubkey');
    ok(t.height === node.chain.height + 1, 'built on the current tip');
    ok(t.target === node.chain.nextTarget(), 'carries the live difficulty target');
    ok(t.scratchKiB === P.POW_SCRATCH_KIB && t.walkSteps === P.POW_WALK_STEPS,
      'consensus PoW params travel with the work, so a stale miner cannot drift');
    ok(typeof t.coreHash === 'string' && t.coreHash.length === 64, 'includes the header core hash to grind on');
    ok(t.txCount >= 1, 'includes at least the coinbase');

    // Nothing in the template lets a miner point the reward elsewhere: the node
    // keeps the transactions and only accepts a proof against the id.
    ok(t.txs === undefined, 'transactions stay on the node, not in the template');
  }

  // ------------------------------------------------------------ mine + submit
  section('a browser can actually mine a block');
  let solvedHeight;
  {
    const t = await get(`/mining/template?pub=${miner.pub}`);
    const hf = new Homefire(t.scratchKiB, t.walkSteps);
    const h = new Sha256();
    const target = hexToBytes(t.target);

    let nonce = 0, digestHex = null;
    for (; nonce < 500_000; nonce++) {
      const d = hf.hash(powSeed(h, t.coreHash, nonce, t.coinbasePub));
      if (meetsTarget(d, target)) { digestHex = toHex(d.slice()); break; }
    }
    ok(digestHex !== null, `browser implementation found a nonce (${nonce})`);

    // The one use of the private key. Only the signature is transmitted.
    const powSig = C.sign(miner.priv, Buffer.from(digestHex, 'hex'));

    const before = node.chain.height;
    const r = await post('/mining/submit', { templateId: t.templateId, nonce, powDigest: digestHex, powSig });
    ok(r.status === 200 && r.body.ok, 'the node accepted the block' + (r.body.ok ? '' : ` (${r.body.err})`));
    ok(node.chain.height === before + 1, 'the chain grew by one');
    solvedHeight = node.chain.height;

    const mined = node.chain.getBlock(solvedHeight);
    ok(mined.txs[0].outputs[0].address === miner.address, 'the reward was paid to the browser miner');
    ok(BLOCK.verifyPow(mined).ok, 'the stored block verifies as proof of work');
    ok(node.chain.balance(miner.address) > 0, 'and shows up as a balance');
  }

  // ------------------------------------------------------------- rejections
  section('bad and stale work is refused');
  {
    const t = await get(`/mining/template?pub=${miner.pub}`);

    const wrongDigest = await post('/mining/submit', {
      templateId: t.templateId, nonce: 1, powDigest: 'ab'.repeat(32), powSig: 'cd'.repeat(64),
    });
    ok(wrongDigest.status === 400 && !wrongDigest.body.ok, 'a made-up digest is rejected');

    const malformed = await post('/mining/submit', { templateId: t.templateId, nonce: -1, powDigest: 'zz', powSig: '' });
    ok(malformed.status === 400, 'malformed fields are rejected without touching the chain');

    const unknown = await post('/mining/submit', {
      templateId: 'ff'.repeat(16), nonce: 1, powDigest: 'ab'.repeat(32), powSig: 'cd'.repeat(64),
    });
    ok(unknown.status === 400 && /unknown or expired/.test(unknown.body.err), 'an unknown template id is rejected');

    // Mine locally so the tip moves under the template we are holding.
    const stale = await get(`/mining/template?pub=${miner.pub}`);
    const hf = new Homefire(stale.scratchKiB, stale.walkSteps);
    const h = new Sha256();
    const target = hexToBytes(stale.target);
    let nonce = 0, digestHex = null;
    for (; nonce < 500_000; nonce++) {
      const d = hf.hash(powSeed(h, stale.coreHash, nonce, stale.coinbasePub));
      if (meetsTarget(d, target)) { digestHex = toHex(d.slice()); break; }
    }
    // Advance the tip with a different template before submitting the old one.
    const other = await get(`/mining/template?pub=${miner.pub}`);
    let n2 = 0, d2 = null;
    for (; n2 < 500_000; n2++) {
      const d = hf.hash(powSeed(h, other.coreHash, n2, other.coinbasePub));
      if (meetsTarget(d, target)) { d2 = toHex(d.slice()); break; }
    }
    await post('/mining/submit', {
      templateId: other.templateId, nonce: n2, powDigest: d2,
      powSig: C.sign(miner.priv, Buffer.from(d2, 'hex')),
    });
    const late = await post('/mining/submit', {
      templateId: stale.templateId, nonce, powDigest: digestHex,
      powSig: C.sign(miner.priv, Buffer.from(digestHex, 'hex')),
    });
    ok(late.status === 409 && late.body.stale, 'work for a superseded tip is 409 stale, not a generic failure');
  }

  // -------------------------------------------------------------- the point
  section('non-outsourceability holds');
  {
    const attacker = crypto.generateKeyPairSync('ed25519');
    const attackerPub = attacker.publicKey.export({ type: 'spki', format: 'der' }).toString('hex');

    // Ask for work in the victim's name, then try to sign it with your own key.
    const t = await get(`/mining/template?pub=${miner.pub}`);
    const hf = new Homefire(t.scratchKiB, t.walkSteps);
    const h = new Sha256();
    const target = hexToBytes(t.target);
    let nonce = 0, digestHex = null;
    for (; nonce < 500_000; nonce++) {
      const d = hf.hash(powSeed(h, t.coreHash, nonce, t.coinbasePub));
      if (meetsTarget(d, target)) { digestHex = toHex(d.slice()); break; }
    }
    const attackerPriv = attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = await post('/mining/submit', {
      templateId: t.templateId, nonce, powDigest: digestHex,
      powSig: C.sign(attackerPriv, Buffer.from(digestHex, 'hex')),
    });
    ok(!r.body.ok && /signature/.test(r.body.err || ''),
      'a proof signed by anyone but the coinbase key is rejected — work cannot be stolen or pooled');
    void attackerPub;
  }

  section('the template cache is bounded');
  {
    for (let i = 0; i < MAX_TEMPLATES + 40; i++) await get(`/mining/template?pub=${miner.pub}`);
    ok(node.templates.byId.size <= MAX_TEMPLATES,
      `an unauthenticated caller cannot grow it without limit (${node.templates.byId.size} <= ${MAX_TEMPLATES})`);
  }

  node.rpc.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
