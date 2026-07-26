#!/usr/bin/env node
'use strict';
/*
 * Hearth — reference solo miner (proof-of-concept)
 * ---------------------------------------------------------------------------
 * Demonstrates the home-mining loop end to end:
 *   - generates a coinbase key (your wallet)
 *   - mines a toy block with the Homefire PoW
 *   - proves the solution is non-outsourceable (signed by the coinbase key)
 *   - verifies it the way any node would
 *
 * Run:  node proto/mine.js [difficultyBits]
 */

const crypto = require('crypto');
const pow = require('./pow');

const bits = parseInt(process.argv[2] || '18', 10);
const target = pow.bitsToTarget(bits);

// Your wallet = an Ed25519 keypair. The miner and the reward recipient are
// the same key on purpose (that is what kills pools).
const coinbaseKey = {
  ...(() => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { publicKey, privateKey };
  })(),
};

// A stand-in block header (height, prev hash, merkle root, timestamp).
const header = Buffer.concat([
  Buffer.from('HEARTH', 'utf8'),
  crypto.randomBytes(32),      // prev block hash
  crypto.randomBytes(32),      // tx merkle root
]);

console.log('\n  Hearth reference miner');
console.log('  scratchpad %s KiB · %s walk steps/attempt · difficulty %s bits',
  pow.SCRATCH_KIB, pow.WALK_STEPS, bits);
console.log('  tending the fire...\n');

const start = process.hrtime.bigint();
let nonce = 0;
let sol = null;
let lastReport = start;

while (!sol) {
  sol = pow.attempt(header, nonce, coinbaseKey, target);
  nonce++;
  if (nonce % 200 === 0) {
    const now = process.hrtime.bigint();
    if (now - lastReport > 1_000_000_000n) {
      const secs = Number(now - start) / 1e9;
      process.stdout.write('\r  ' + nonce + ' attempts · ' +
        (nonce / secs).toFixed(0) + ' H/s   ');
      lastReport = now;
    }
  }
}

const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
const ok = pow.verify(header, sol, target);

console.log('\n\n  BLOCK FOUND');
console.log('   • nonce ............. %d', sol.nonce);
console.log('   • attempts .......... %d in %ss', nonce, elapsed.toFixed(2));
console.log('   • digest ............ %s…', sol.digest.toString('hex').slice(0, 24));
console.log('   • coinbase (you) .... %s…', sol.pub.toString('hex').slice(0, 24));
console.log('   • signed by coinbase  %s', sol.sig.toString('hex').slice(0, 24) + '…');
console.log('   • node verifies ..... %s', ok ? 'VALID ✓' : 'INVALID ✗');
console.log('\n  A pool operator can not mine this for you without your private');
console.log('  key — so there is nobody to centralize around. That is the point.\n');

process.exit(ok ? 0 : 1);
