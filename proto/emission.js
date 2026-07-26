#!/usr/bin/env node
/*
 * Hearth — Ember (EMBER) emission & supply simulator
 * -------------------------------------------------------------
 * Runnable model of the coinnomics described in docs/coinnomics.md.
 * No dependencies. Run:  node proto/emission.js
 *
 * The point of this file is honesty: every number in the whitepaper
 * is produced here so anyone can re-run and check it.
 */

'use strict';

// ---- Network constants -------------------------------------------------
const BLOCK_TIME_S = 15;                         // target seconds per block
const BLOCKS_PER_YEAR = Math.round((365.25 * 24 * 3600) / BLOCK_TIME_S); // ~2,103,840

// ---- Emission curve ----------------------------------------------------
// reward(h) = max(TAIL, R0 * 2^(-h / HALFLIFE_BLOCKS))
// Smooth, halving-free decay to a *perpetual* tail. The tail never ends,
// so there is always a security budget — Hearth never faces a "fee cliff".
const R0 = 6.0;                                  // EMBER/block at genesis
const HALFLIFE_YEARS = 2.0;                      // reward halves every 2 years
const HALFLIFE_BLOCKS = HALFLIFE_YEARS * BLOCKS_PER_YEAR;
const TAIL = 0.30;                               // perpetual tail, EMBER/block

// ---- Splits ------------------------------------------------------------
const COMMONS_SHARE = 0.10;                       // 10% of reward -> Commons treasury
                                                  // remaining 90% -> the miner

function reward(height) {
  const decayed = R0 * Math.pow(2, -height / HALFLIFE_BLOCKS);
  return Math.max(TAIL, decayed);
}

// ---- Fee-burn model ----------------------------------------------------
// EIP-1559-style base fee is burned. At steady real-world usage the burn
// offsets a large part of tail emission, so *net* supply flattens and
// EMBER behaves like circulating money rather than a scarce collectible.
// We model burn as a fraction of tail issuance once the network is mature.
function annualBurn(year, annualIssuance) {
  // Adoption ramp: burn climbs from 0% to ~85% of issuance over ~8 years.
  const maturity = Math.min(1, year / 8);
  return annualIssuance * 0.85 * maturity;
}

function fmt(n, d = 0) {
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function simulate(years) {
  let supply = 0;
  let commons = 0;
  let height = 0;
  const rows = [];

  for (let y = 1; y <= years; y++) {
    let issued = 0;
    for (let b = 0; b < BLOCKS_PER_YEAR; b++) {
      const r = reward(height++);
      issued += r;
    }
    const burned = annualBurn(y, issued);
    const net = issued - burned;

    supply += net;
    commons += issued * COMMONS_SHARE;

    const grossInfl = (issued / (supply - net + issued)) * 100; // pre-burn
    const netInfl = (net / (supply)) * 100;                     // post-burn

    rows.push({
      y,
      reward: reward(height - 1),
      issued,
      burned,
      supply,
      commons,
      grossInfl,
      netInfl,
    });
  }
  return rows;
}

console.log('\n  HEARTH — EMBER emission simulation');
console.log('  block time %ss   ~%s blocks/year', BLOCK_TIME_S, fmt(BLOCKS_PER_YEAR));
console.log('  R0=%s EMBER/blk   reward half-life=%syr   tail=%s EMBER/blk   commons=%s%%\n',
  R0, HALFLIFE_YEARS, TAIL, COMMONS_SHARE * 100);

const rows = simulate(30);
const header = ['yr', 'reward', 'issued/yr', 'burned/yr', 'supply', 'commons', 'gross%', 'net%'];
console.log('  ' + header.map(h => h.padStart(12)).join(''));
console.log('  ' + '-'.repeat(12 * header.length));
for (const r of rows) {
  if (![1, 2, 3, 5, 8, 10, 15, 20, 30].includes(r.y)) continue;
  console.log('  ' + [
    String(r.y),
    fmt(r.reward, 2),
    fmt(r.issued),
    fmt(r.burned),
    fmt(r.supply),
    fmt(r.commons),
    fmt(r.grossInfl, 2),
    fmt(r.netInfl, 2),
  ].map(c => c.padStart(12)).join(''));
}

const last = rows[rows.length - 1];
console.log('\n  After %s years:', last.y);
console.log('   • circulating supply ....... %s EMBER', fmt(last.supply));
console.log('   • Commons treasury (cum) ... %s EMBER', fmt(last.commons));
console.log('   • gross inflation .......... %s%%  (pre-burn issuance)', fmt(last.grossInfl, 2));
console.log('   • NET inflation ............ %s%%  (after fee burn)\n', fmt(last.netInfl, 2));
console.log('  Takeaway: emission is disinflationary into a perpetual tail; the');
console.log('  base-fee burn drives *net* inflation toward ~0%% as usage grows, so');
console.log('  EMBER stabilizes as spendable money instead of a deflationary asset.\n');
