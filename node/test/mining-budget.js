'use strict';
/* What an anonymous caller may make the mining endpoints DO.
 * Run: node test/mining-budget.js
 *
 * `/mining/template` and `/mining/submit` are now published through the tunnel,
 * which makes them the first unauthenticated door to this node from the open
 * internet. They are deliberately NOT authenticated — see the note in
 * src/evmnode.js: this is a permissionless chain whose entire thesis is that
 * ordinary people mine it, a submitted block still has to satisfy proof of work
 * and full validation, and a credential on `submit` would exclude exactly the
 * strangers the coin exists for. The exposure is not authorisation. It is COST.
 *
 * And the cost is the same one src/p2p.js already treats as the threat it is.
 * Every P2P connection carries a `cfVerify` token budget because "one
 * verification is a full Homefire evaluation, so an unmetered peer buys a core
 * with a stream of junk" (params.js). The HTTP path reaches the identical
 * `HDR.verifyPow` — ~7 ms of a core per call — and had NO budget of any kind.
 * One `curl` loop was a remote denial of service on a mining node.
 *
 *   submit    a well-formed body with a wrong digest costs a full evaluation
 *             before it can be refused. That is the expensive one.
 *   template  `candidateFor` is memoized on (tip, mempool version, coinbase pub),
 *             so a caller that varies the pubkey misses the memo every time and
 *             buys a full block of EVM EXECUTION per request. The memo's own
 *             comment says it exists to stop "any stranger buying a full block of
 *             execution per HTTP request"; varying the key walks straight past it.
 *
 * The metering copies p2p's rule rather than inventing one, INCLUDING THE REFUND:
 * a token is taken before the work and given back when the outcome shows the
 * caller did not waste it. That matters here for the same reason it does there —
 * an honest miner submitting winning proofs must never be throttled, and every
 * check below that says "honest work is never charged" is the half of this that
 * a naive rate limit would get wrong.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/params');
const POW = require('../src/pow');
const HDR = require('../src/chain/header');
const secp = require('../src/crypto/secp256k1');
const { EvmNode, keyFrom } = require('../src/evmnode');
const C = require('./evm-common');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-mining-budget-'));

(async () => {
  console.log('\nHearth mining endpoints — what a stranger may make this node do\n');

  const node = new EvmNode({ dataDir: dir, quiet: true, genesis: { target: C.EASY_TARGET } });
  node.listenRest(0);
  const port = await new Promise((res, rej) => {
    node.restServer.once('listening', () => res(node.restServer.address().port));
    node.restServer.once('error', rej);
  });
  const base = `http://127.0.0.1:${port}`;
  const get = async p => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const key = keyFrom(secp.randomPrivateKey());
  const pub = key.publicKey.toString('hex');

  /** Ask for work, grind it, and post a real winning proof. */
  async function mineOne() {
    const t = (await get(`/mining/template?pub=${pub}`)).body;
    if (!t.templateId) return { status: 0, body: t };
    for (let nonce = 0; nonce < 2_000_000; nonce++) {
      const d = POW.homefireHash(POW.powSeed(t.coreHash, nonce, t.coinbasePub)).toString('hex');
      if (POW.meetsTarget(d, t.target)) {
        return post('/mining/submit', {
          templateId: t.templateId, nonce, powDigest: d, powSig: HDR.signProof(d, key.privateKey),
        });
      }
    }
    throw new Error('no nonce found');
  }

  // ==========================================================================
  group('honest mining is never throttled — the half a rate limit gets wrong');
  // ==========================================================================
  {
    let accepted = 0, throttled = 0;
    for (let i = 0; i < 12; i++) {
      const r = await mineOne();
      if (r.status === 429) throttled++;
      else if (r.body && r.body.ok) accepted++;
    }
    assert(throttled === 0, 'twelve winning proofs in a row, none throttled');
    assert(accepted === 12, `and all twelve accepted (${accepted}) — a token spent on useful work is refunded`);
    assert(node.chain.height === 12, `the chain is twelve blocks taller (${node.chain.height})`);
  }

  // ==========================================================================
  group('junk submissions are metered, because each one costs a full Homefire');
  // ==========================================================================
  {
    const t = (await get(`/mining/template?pub=${pub}`)).body;
    assert(!!t.templateId, 'a template to submit against');

    /* Well-formed and wrong: the digest passes every cheap check, so the node
     * must evaluate Homefire over the real seed before it can say no. This is
     * the exact shape of the attack, and the only cheap defence is a budget. */
    const junk = n => ({
      templateId: t.templateId, nonce: n, powDigest: 'ab'.repeat(32),
      powSig: HDR.signProof('ab'.repeat(32), key.privateKey),
    });

    let served = 0, refused = 0;
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      const r = await post('/mining/submit', junk(i));
      if (r.status === 429) refused++;
      else served++;
    }
    const secs = (Date.now() - t0) / 1000;
    console.log(`    200 junk submissions in ${secs.toFixed(1)}s: ${served} evaluated, ${refused} refused`);

    assert(refused > 0, 'a burst of junk is eventually refused rather than evaluated');
    const ceiling = P.MINING_VERIFY_BURST + Math.ceil(P.MINING_VERIFY_PER_S * secs) + 2;
    assert(served <= ceiling,
      `at most the budget was ever evaluated (${served} <= ${ceiling}) — the rest cost nothing`);
    assert(node.chain.height === 12, 'and none of it touched the chain');
  }

  // ==========================================================================
  group('…and what costs nothing is not charged for');
  // ==========================================================================
  {
    /* An unknown template is refused from `submit`'s first line, before any
     * hashing. Charging for it would let a caller exhaust its own budget on
     * free calls — and, worse, would throttle a miner whose template merely
     * expired, which is ordinary and not its fault. */
    for (let i = 0; i < 300; i++) await post('/mining/submit', { templateId: 'ff'.repeat(16), nonce: i, powDigest: 'ab'.repeat(32), powSig: 'ab'.repeat(65) });
    const after = await mineOne();
    assert(after.status !== 429 && after.body.ok,
      'three hundred unknown-template submissions later, an honest proof is still accepted');
  }
  {
    // A malformed body never reaches the hash either.
    for (let i = 0; i < 200; i++) await post('/mining/submit', { templateId: 5, nonce: 'x' });
    const after = await mineOne();
    assert(after.status !== 429 && after.body.ok, 'and malformed submissions do not consume the budget either');
  }

  // ==========================================================================
  group('template issuance is metered too — the memo does not cover a stranger');
  // ==========================================================================
  {
    /* `candidateFor` is memoized on the coinbase pub among other things, so a
     * caller that sends a DIFFERENT key each time misses the memo and buys a
     * full block of EVM execution per request. */
    let served = 0, refused = 0;
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      const other = keyFrom(secp.randomPrivateKey()).publicKey.toString('hex');
      const r = await get(`/mining/template?pub=${other}`);
      if (r.status === 429) refused++;
      else served++;
    }
    const secs = (Date.now() - t0) / 1000;
    console.log(`    200 distinct-key templates in ${secs.toFixed(1)}s: ${served} built, ${refused} refused`);
    assert(refused > 0, 'a caller varying its coinbase key is eventually refused');
    const ceiling = P.MINING_TEMPLATE_BURST + Math.ceil(P.MINING_TEMPLATE_PER_S * secs) + 2;
    assert(served <= ceiling, `at most the budget was ever built (${served} <= ${ceiling})`);
  }

  // ==========================================================================
  group('the bookkeeping is itself bounded');
  // ==========================================================================
  {
    // A per-caller budget is a map keyed by something the caller controls, so
    // it is a memory leak unless it is capped. It is reached directly here
    // because no test can produce a thousand source addresses.
    for (let i = 0; i < P.MINING_MAX_CLIENTS + 500; i++) node._miningBudget(`10.0.${i >> 8}.${i & 255}`, 'verify');
    assert(node.miningClients.size <= P.MINING_MAX_CLIENTS,
      `the per-caller table is capped (${node.miningClients.size} <= ${P.MINING_MAX_CLIENTS})`);
  }

  // ==========================================================================
  group('and the node is still a node');
  // ==========================================================================
  {
    /* The buckets refill, which is the difference between a budget and a ban.
     * The sections above deliberately emptied both, so this waits one refill
     * period — if it did not come back, the endpoint would be a one-shot fuse. */
    await new Promise(r => setTimeout(r, 2000));
    const info = await get('/info');
    assert(info.status === 200 && Number.isInteger(info.body.height), 'it still answers /info after all of that');
    const still = await mineOne();
    assert(still.body.ok, 'and an honest miner can still mine');
  }

  node.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\nFAIL —', e); process.exit(1); });
