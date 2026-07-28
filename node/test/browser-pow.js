'use strict';
/* The browser miner must agree with the chain, bit for bit.
 *
 * web/assets/mining/{sha256,homefire}.js reimplement SHA-256 and Homefire so
 * they can run synchronously in a Worker. A digest that differs from the node's
 * in one bit is a block the network rejects — and the miner would look like it
 * was working the whole time. This test is the thing that catches that.
 *
 * Run: node test/browser-pow.js   (also part of `npm test`) */

const crypto = require('crypto');
const assert = require('assert');
const P = require('../src/params');
const POW = require('../src/pow');
const BLOCK = require('../src/block');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log('  ✓ ' + label)) : (fail++, console.log('  ✗ ' + label)); };
const section = s => console.log('\n• ' + s);

(async () => {
  const { Sha256, sha256, toHex, utf8 } = await import('../../web/assets/mining/sha256.js');
  const { Homefire, powSeed, meetsTarget, hexToBytes } = await import('../../web/assets/mining/homefire.js');

  // ---------------------------------------------------------------- sha256
  section('SHA-256 matches Node');
  {
    const nodeHash = b => crypto.createHash('sha256').update(b).digest('hex');
    const cases = [
      Buffer.alloc(0),
      Buffer.from('abc'),
      Buffer.from('a'.repeat(55)),   // one byte under the padding boundary
      Buffer.from('a'.repeat(56)),   // exactly at it — forces a second block
      Buffer.from('a'.repeat(64)),   // exact block
      Buffer.from('a'.repeat(1000)),
      crypto.randomBytes(65_536),
    ];
    let allOk = true;
    for (const c of cases) if (toHex(sha256(new Uint8Array(c))) !== nodeHash(c)) allOk = false;
    ok(allOk, `${cases.length} inputs incl. the 55/56/64-byte padding edges`);

    // Streaming in odd-sized chunks must equal a single update.
    const data = crypto.randomBytes(5000);
    const h = new Sha256();
    for (let i = 0; i < data.length; i += 7) h.update(new Uint8Array(data.subarray(i, i + 7)));
    ok(toHex(h.digest()) === nodeHash(data), 'streaming in 7-byte chunks matches one-shot');

    const reused = new Sha256();
    reused.update(new Uint8Array(Buffer.from('first'))).digest();
    reused.reset().update(new Uint8Array(Buffer.from('abc'))).digest();
    ok(toHex(reused.reset().update(new Uint8Array(Buffer.from('abc'))).digest()) === nodeHash(Buffer.from('abc')),
      'a reused instance resets cleanly (the hot path never allocates a new one)');
  }

  // ---------------------------------------------------------------- powSeed
  section('powSeed matches the node');
  {
    const h = new Sha256();
    let allOk = true;
    for (const [core, nonce, pub] of [
      ['00'.repeat(32), 0, 'ab'.repeat(44)],
      ['ff'.repeat(32), 1, '00'],
      [crypto.randomBytes(32).toString('hex'), 987654321, crypto.randomBytes(44).toString('hex')],
    ]) {
      const mine = toHex(powSeed(h, core, nonce, pub));
      const theirs = POW.powSeed(core, nonce, pub).toString('hex');
      if (mine !== theirs) allOk = false;
    }
    ok(allOk, 'hex strings are hashed as TEXT, exactly as the node does');
  }

  // ---------------------------------------------------------------- homefire
  section('Homefire digests match the node');
  {
    const hf = new Homefire(P.POW_SCRATCH_KIB, P.POW_WALK_STEPS);
    let allOk = true;
    for (let i = 0; i < 8; i++) {
      const seed = crypto.randomBytes(32);
      const mine = toHex(hf.hash(new Uint8Array(seed)));
      const theirs = POW.homefireHash(seed).toString('hex');
      if (mine !== theirs) { allOk = false; console.log(`      seed ${seed.toString('hex').slice(0,16)} → ${mine.slice(0,16)} vs ${theirs.slice(0,16)}`); }
    }
    ok(allOk, `8 random seeds at the live params (${P.POW_SCRATCH_KIB} KiB / ${P.POW_WALK_STEPS} steps)`);

    // The scratchpad is reused across calls; a leftover must not change a digest.
    const seed = crypto.randomBytes(32);
    const first = toHex(hf.hash(new Uint8Array(seed)));
    hf.hash(new Uint8Array(crypto.randomBytes(32)));
    ok(hf.hash(new Uint8Array(seed)) && toHex(hf.out) === first,
      'reusing one Homefire instance gives a stable digest (no scratchpad bleed)');
  }

  // ---------------------------------------------------------------- target
  section('target comparison matches the node');
  {
    const t = P.GENESIS_TARGET;
    const tb = hexToBytes(t);
    let allOk = true;
    for (let i = 0; i < 200; i++) {
      const d = crypto.randomBytes(32).toString('hex');
      if (meetsTarget(hexToBytes(d), tb) !== POW.meetsTarget(d, t)) allOk = false;
    }
    // and the boundaries the random sample will never hit
    for (const d of [t, '00'.repeat(32), 'ff'.repeat(32)]) {
      if (meetsTarget(hexToBytes(d), tb) !== POW.meetsTarget(d, t)) allOk = false;
    }
    ok(allOk, '200 random digests plus equal / min / max agree');
  }

  // ------------------------------------------------------------- end to end
  section('a browser-mined block verifies on the node');
  {
    const key = (() => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      return {
        priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        pub: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
      };
    })();
    const C = require('../src/crypto');
    const TX = require('../src/tx');

    const cb = TX.coinbase(1, C.addressFromPub(key.pub), 0);
    const header = {
      version: 1, prevHash: '0'.repeat(64), merkleRoot: C.merkleRoot([cb.id]),
      height: 1, timestamp: 1750000001, target: P.GENESIS_TARGET, coinbasePub: key.pub, nonce: 0,
    };
    const core = BLOCK.coreHash(header);

    // Mine it the way the browser does: our SHA-256, our Homefire, our target test.
    const hf = new Homefire(P.POW_SCRATCH_KIB, P.POW_WALK_STEPS);
    const h = new Sha256();
    const tb = hexToBytes(header.target);
    let nonce = 0, digestHex = null;
    for (; nonce < 200_000; nonce++) {
      const d = hf.hash(powSeed(h, core, nonce, key.pub));
      if (meetsTarget(d, tb)) { digestHex = toHex(d); break; }
    }
    ok(digestHex !== null, `found a nonce in the browser implementation (nonce=${nonce})`);

    header.nonce = nonce;
    header.powDigest = digestHex;
    header.powSig = C.sign(key.priv, Buffer.from(digestHex, 'hex'));

    const v = BLOCK.verifyPow({ header, txs: [cb] });
    ok(v.ok, 'the node accepts the proof of work' + (v.ok ? '' : ` (${v.err})`));

    // And the node recomputes the identical digest from the same inputs.
    const theirs = POW.homefireHash(POW.powSeed(core, nonce, key.pub)).toString('hex');
    ok(theirs === digestHex, 'node and browser agree on the winning digest');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
