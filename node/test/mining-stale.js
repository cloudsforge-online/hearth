'use strict';
/* WHAT A MINER IS TOLD WHEN ITS TEMPLATE IS GONE. Run: node test/mining-stale.js
 *
 * `/mining/submit` has exactly one job beyond accepting blocks: telling a miner
 * which of two things went wrong, because the two demand opposite responses.
 *
 *   400  your submission is malformed. src/mine/session.js counts these as
 *        `refused` and stops the session once enough land — "stopping rather than
 *        mining into a wall". The browser miner shows them as faults.
 *   409  your work was late. Both clients count these as `stale`, which is not an
 *        error, not a strike, and is followed by a refetch.
 *
 * micro-org#237: a template that had EXPIRED or been EVICTED left the live map and
 * so could never reach the `stale: true` branch, which only ever covered a
 * template still in the map whose tip had moved. Both `Templates` classes answered
 * a missing id with a bare `{ ok: false, err: 'unknown or expired template' }`,
 * and both routes turn that into 400. A miner whose work merely aged out was told
 * its proof was wrong, and a miner that believes that stops. Measured in a browser
 * against the public testnet on 2026-08-07: one correct 409, then four 400s that
 * were the same situation wearing the wrong code.
 *
 * WHY THIS SUITE ASSERTS OVER HTTP AND NOT ON THE RETURN VALUE. The defect was
 * never in `submit`'s answer being wrong; it was in the answer being INSUFFICIENT
 * to reach 409 at the route. A unit test on `{ ok: false, err }` would have passed
 * throughout. The status code is the entire fix, so the status code is what is
 * asserted, off a real socket.
 *
 * WHY BOTH NODES. Two independent implementations serve this endpoint —
 * src/mining.js on the UTXO node (src/rpc.js) and src/chain/miner.js on the
 * account model (src/evmnode.js). #237 names the first and was measured against
 * the second. They shared the defect, they now share src/retiredtemplates.js, and
 * the table below is run against both so they cannot drift apart again.
 *
 * FOUR CASES, AND WHY FOUR. A suite that asserted 409 on a fresh template proves
 * nothing; a suite that asserted it on expiry alone leaves eviction — the case a
 * node with many concurrent miners actually hits — untested, and eviction is the
 * one that drops LIVE work regardless of age. And a fix that answered 409 to every
 * unknown id would pass three of these while destroying the fourth: an id that was
 * never issued is a different fact from one that expired, and collapsing them is
 * the same defect this file exists to close, rebuilt on the other side.
 *
 * NO FIGURE IS TYPED IN BELOW. Every one is read from TTL_MS / TEMPLATE_TTL_MS and
 * MAX_TEMPLATES themselves, so retuning a constant retunes the test with it rather
 * than turning it red for a reason that is not a defect.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POW = require('../src/pow');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-mining-stale-'));
const bound = server => new Promise((res, rej) => {
  server.once('listening', () => res(server.address().port));
  server.once('error', rej);
});

/* A well-formed submission that is not a winning one. Both nodes check the shape
 * of these fields before they check anything expensive, so every case below can
 * hold the body constant and vary ONLY the template id — which is what makes the
 * four answers attributable to template state and to nothing else. The account
 * model wants exactly 65 bytes of r||s||v, the UTXO node any even-length hex, so
 * 65 bytes satisfies both. */
const WELL_FORMED = {
  nonce: 0,
  powDigest: 'f'.repeat(64),
  powSig: 'a'.repeat(130),
};

/**
 * The table, run once per node implementation.
 *
 * `ctx` supplies what differs — how to start the server, how to ask for work in
 * process, how to grind a winning proof — and nothing else. Every assertion is
 * shared, because the whole point is that the two nodes answer identically.
 */
async function runTable(ctx) {
  const { label, post, templates, issue, mineWinner, TTL, MAX } = ctx;
  let expired, evicted;

  // ==========================================================================
  group(`${label} — a fresh template is accepted`);
  // ==========================================================================
  {
    const r = await mineWinner();
    assert(r.status === 200, `a winning proof against live work answers 200 (got ${r.status})`);
    assert(r.body.ok === true, 'and the body says so');
  }

  // ==========================================================================
  group(`${label} — a malformed field on LIVE work is still 400`);
  // ==========================================================================
  {
    /* The control. Without it, "everything is 409 now" would pass this file, and
     * that is a defect of exactly the same kind: one answer for two situations. */
    const id = issue();
    const r = await post('/mining/submit', { ...WELL_FORMED, templateId: id, nonce: -1 });
    assert(r.status === 400, `a negative nonce on a live template answers 400 (got ${r.status})`);
    assert(r.body.stale !== true, 'and is not dressed up as stale work');
  }

  // ==========================================================================
  group(`${label} — an EXPIRED template is stale work, not a bad proof`);
  // ==========================================================================
  {
    const id = issue();
    /* Age it past the lifetime the node published with it, rather than waiting
     * the lifetime out. The offset is TTL itself — nothing here knows or asserts
     * how many milliseconds that is. */
    templates().byId.get(id).createdAt -= TTL + 1;
    expired = await post('/mining/submit', { ...WELL_FORMED, templateId: id });
    assert(expired.status === 409, `an expired template answers 409, not 400 (got ${expired.status})`);
    assert(expired.body.stale === true, 'with stale: true, which is what the client branches on');
    assert(expired.body.reason === 'expired', `and names the reason (${expired.body.reason})`);
    assert(String(expired.body.err).includes(String(TTL)),
      'the message quotes the configured lifetime rather than a literal');
    assert(!templates().byId.has(id), 'and the template is gone from the live map');
  }

  // ==========================================================================
  group(`${label} — an EVICTED template is answered the SAME way`);
  // ==========================================================================
  {
    /* Eviction is the half a TTL-only fix misses, and it is the half a busy node
     * hits: MAX_TEMPLATES overflowing drops the OLDEST template whatever its age,
     * so a miner one second into a template it will win can lose it to strangers
     * asking for work. Issued in process rather than over HTTP because
     * `/mining/template` is rate limited on the account model and MAX + 1 requests
     * would answer 429 long before they answered anything about eviction. */
    const first = issue();
    for (let i = 0; i < MAX; i++) issue();
    assert(!templates().byId.has(first), `${MAX} further templates push the first out of the map`);

    evicted = await post('/mining/submit', { ...WELL_FORMED, templateId: first });
    assert(evicted.status === 409, `an evicted template answers 409, not 400 (got ${evicted.status})`);
    assert(evicted.body.stale === true, 'with stale: true');
    assert(evicted.body.reason === 'evicted', `and names eviction, not expiry (${evicted.body.reason})`);
    assert(String(evicted.body.err).includes(String(MAX)),
      'the message quotes the configured template ceiling rather than a literal');

    /* THE ASSERTION THIS GROUP EXISTS FOR. A miner cannot see why its work went
     * away and must not have to: expiry and eviction are one situation to it, and
     * every field it branches on has to match. `reason` is the operator's, and is
     * deliberately excluded — it is the only field allowed to differ. */
    assert(evicted.status === expired.status && evicted.body.ok === expired.body.ok
      && evicted.body.stale === expired.body.stale,
    'eviction and expiry are indistinguishable to a miner: same status, same ok, same stale');
  }

  // ==========================================================================
  group(`${label} — an id that was NEVER ISSUED stays distinguishable`);
  // ==========================================================================
  {
    /* The same body, the same node, one field different: an id this node has
     * never handed out. "Answer 409 to anything unknown" is the cheap fix, it
     * passes every group above, and it is wrong — a fabricated id and expired
     * work are different facts, and telling a confused client to refetch forever
     * is the same failure as telling an honest miner it has a bug. */
    const never = crypto.randomBytes(16).toString('hex');
    const r = await post('/mining/submit', { ...WELL_FORMED, templateId: never });
    assert(r.status === 400, `an id never issued answers 400 (got ${r.status})`);
    assert(r.body.stale === false, 'stale is present and false — not merely absent, which is what #237 was');
    assert(r.body.reason === 'unknown', `and the reason says unknown (${r.body.reason})`);
    /* The named hole: the ring is bounded, so this answer also covers an id
     * retired too long ago to be remembered. The message has to admit that,
     * because an operator who reads "never issued" about an id they watched this
     * node issue stops believing the 409s too. */
    assert(/not issued by this node, or was retired too long ago/.test(String(r.body.err)),
      'and the message admits it cannot tell that from an id forgotten long ago');
  }

  // ==========================================================================
  group(`${label} — a SUPERSEDED template stays stale on a retry`);
  // ==========================================================================
  {
    /* The tip-moved branch already answered 409 before #237 — and then deleted
     * the id, so the second submission of the same template fell through to the
     * unknown-id path and got 400. A client that refreshes and resubmits (both of
     * ours can) saw the defect one step later than the issue describes it. */
    const id = issue();
    const before = await mineWinner();          // moves the tip under `id`
    assert(before.status === 200, 'a block lands, moving the tip');

    const first = await post('/mining/submit', { ...WELL_FORMED, templateId: id });
    assert(first.status === 409, `work built on the old tip answers 409 (got ${first.status})`);
    assert(first.body.reason === 'superseded', `and names the moved tip (${first.body.reason})`);

    const again = await post('/mining/submit', { ...WELL_FORMED, templateId: id });
    assert(again.status === 409, `and the SAME id answers 409 a second time (got ${again.status})`);
    assert(again.body.stale === true, 'a retry of stale work is still stale work');
  }
}

(async () => {
  console.log('\nHearth /mining/submit — stale work is 409, a bad proof is 400, and a fabricated id is neither\n');

  // ==========================================================================
  // The account model (src/chain/miner.js behind src/evmnode.js) — the node that
  // serves the public testnet and the one micro-org#237 was measured against.
  // ==========================================================================
  {
    const HDR = require('../src/chain/header');
    const secp = require('../src/crypto/secp256k1');
    const { EvmNode, keyFrom } = require('../src/evmnode');
    const { TEMPLATE_TTL_MS, MAX_TEMPLATES } = require('../src/chain/miner');
    const C = require('./evm-common');

    const node = new EvmNode({ dataDir: path.join(dir, 'evm'), quiet: true, genesis: { target: C.EASY_TARGET } });
    node.listenRest(0);
    const port = await bound(node.restServer);
    const base = `http://127.0.0.1:${port}`;
    const key = keyFrom(secp.randomPrivateKey());
    const pub = key.publicKey.toString('hex');

    const post = async (p, body) => {
      const r = await fetch(base + p, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    await runTable({
      label: 'account model',
      post,
      TTL: TEMPLATE_TTL_MS,
      MAX: MAX_TEMPLATES,
      templates: () => node.templates,
      issue: () => node.templates.issue(pub).templateId,
      async mineWinner() {
        const t = node.templates.issue(pub);
        for (let nonce = 0; nonce < 2_000_000; nonce++) {
          const d = POW.homefireHash(POW.powSeed(t.coreHash, nonce, t.coinbasePub)).toString('hex');
          if (POW.meetsTarget(d, t.target)) {
            return post('/mining/submit', {
              templateId: t.templateId, nonce, powDigest: d, powSig: HDR.signProof(d, key.privateKey),
            });
          }
        }
        throw new Error('no nonce found');
      },
    });

    node.restServer.close();
    if (node.p2p && node.p2p.close) node.p2p.close();
  }

  // ==========================================================================
  // The UTXO node (src/mining.js behind src/rpc.js) — the file #237 names.
  // ==========================================================================
  {
    const CRYPTO = require('../src/crypto');
    const BLOCK = require('../src/block');
    const { Node } = require('../src/node');
    const { TTL_MS, MAX_TEMPLATES } = require('../src/mining');

    const node = new Node({ dataDir: path.join(dir, 'utxo'), quiet: true, p2pPort: 0 });
    node.rpc.listen(0);
    const port = await bound(node.rpc.server);
    const base = `http://127.0.0.1:${port}`;
    const key = node.wallet.keys[0];

    const post = async (p, body) => {
      const r = await fetch(base + p, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    await runTable({
      label: 'utxo',
      post,
      TTL: TTL_MS,
      MAX: MAX_TEMPLATES,
      templates: () => node.templates,
      issue: () => node.templates.issue(key.pub).templateId,
      async mineWinner() {
        const t = node.templates.issue(key.pub);
        for (let nonce = 0; nonce < 2_000_000; nonce++) {
          const d = POW.homefireHash(POW.powSeed(t.coreHash, nonce, t.coinbasePub)).toString('hex');
          if (POW.meetsTarget(d, t.target)) {
            return post('/mining/submit', {
              templateId: t.templateId, nonce, powDigest: d,
              powSig: CRYPTO.sign(key.priv, Buffer.from(d, 'hex')),
            });
          }
        }
        throw new Error('no nonce found');
      },
    });

    node.rpc.server.close();
    if (node.p2p && node.p2p.close) node.p2p.close();
    // The tip is real work, so prove the accepted submissions actually built a chain.
    assert(node.chain.height >= 2, `the utxo chain grew from remote submissions (height ${node.chain.height})`);
    assert(BLOCK.blockId(node.chain.tip).length === 64, 'and its tip is a real block id');
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
