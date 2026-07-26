#!/usr/bin/env node
'use strict';
/* hearth-cli — a small wallet/query client that talks to a running hearthd.
 *
 *   hearth-cli [--rpc URL] [--data DIR] <command>
 *     info                     network status
 *     supply                   supply / commons / burned
 *     newaddress               create a new wallet address
 *     addresses                list wallet addresses
 *     balance [address]        balance (defaults to whole wallet)
 *     send <toAddress> <EMBER> build, sign & broadcast a payment
 *     blocks [n]               latest n block summaries
 */

const path = require('path');
const { Wallet } = require('../src/wallet');
const P = require('../src/params');

const args = process.argv.slice(2);
let rpc = process.env.HEARTH_RPC_URL || 'http://127.0.0.1:8645';
let dataDir = process.env.HEARTH_DATA || path.join(process.cwd(), 'data');
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--rpc') rpc = args[++i];
  else if (args[i] === '--data') dataDir = path.resolve(args[++i]);
  else rest.push(args[i]);
}
const [cmd, ...params] = rest;

const api = {
  async get(p) { const r = await fetch(rpc + p); return r.json(); },
  async post(p, body) { const r = await fetch(rpc + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); },
};
const EM = n => (n / P.SPARKS_PER_EMBER).toLocaleString('en-US', { maximumFractionDigits: 8 });

async function main() {
  switch (cmd) {
    case 'info': return console.log(await api.get('/info'));
    case 'supply': {
      const s = await api.get('/supply');
      console.log(`height ............ ${s.height}`);
      console.log(`circulating ....... ${EM(s.circulating)} EMBER`);
      console.log(`commons treasury .. ${EM(s.commonsTreasury)} EMBER`);
      console.log(`burned (base fees)  ${EM(s.burnedTotal)} EMBER`);
      console.log(`next block reward . ${EM(s.blockReward)} EMBER`);
      return;
    }
    case 'newaddress': {
      const w = new Wallet(dataDir).load();
      console.log(w.newAddress());
      return;
    }
    case 'addresses': {
      const w = new Wallet(dataDir).load();
      w.addresses().forEach(a => console.log(a));
      return;
    }
    case 'balance': {
      const w = new Wallet(dataDir).load();
      const addrs = params[0] ? [params[0]] : w.addresses();
      let total = 0;
      for (const a of addrs) { const r = await api.get('/address/' + a); total += r.balance; console.log(`${a}  ${EM(r.balance)} EMBER`); }
      console.log(`total ............. ${EM(total)} EMBER`);
      return;
    }
    case 'send': {
      const [to, amountStr] = params;
      if (!to || !amountStr) { console.error('usage: send <toAddress> <EMBER>'); process.exit(1); }
      const amount = Math.round(parseFloat(amountStr) * P.SPARKS_PER_EMBER);
      const w = new Wallet(dataDir).load();
      // fetch utxos for all wallet addresses, build a shim chain view
      const byAddr = {};
      for (const a of w.addresses()) byAddr[a] = (await api.get('/address/' + a)).utxos || [];
      const shim = {
        utxosFor: a => byAddr[a] || [],
        balance: a => (byAddr[a] || []).reduce((s, u) => s + u.amount, 0),
      };
      const tx = w.buildTx(shim, to, amount);
      const r = await api.post('/tx', { tx });
      console.log(r.ok ? `broadcast ✓  tx ${tx.id.slice(0, 16)}…` : `rejected: ${r.err}`);
      return;
    }
    case 'blocks': {
      const n = Number(params[0] || 10);
      const { blocks } = await api.get('/blocks?limit=' + n);
      for (const b of blocks) console.log(`#${b.height}  ${b.hashPreview}…  ${b.txCount} tx  ${EM(b.reward)} EMBER  ${b.miner.slice(0, 16)}…`);
      return;
    }
    default:
      console.log('commands: info supply newaddress addresses balance send blocks');
  }
}
main().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
