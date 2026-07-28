#!/usr/bin/env node
'use strict';
/* hearth-chat — messaging that lives in blocks, over a running hearthd.
 *
 *   hearth-chat [--rpc URL] [--data DIR] <command>
 *     announce                 publish your reading key so others can write you
 *     whois <address>          show the reading key an address has announced
 *     send <address> <text…>   encrypt to that address and broadcast
 *     inbox [--since N]        decrypt everything addressed to you
 *     watch                    stream your inbox as blocks arrive
 *
 * A message is a record inside an ordinary payment, so sending one costs the
 * base fee plus its bytes, and it confirms when the block does — around 15s,
 * not instantly. That is the trade for it being on the chain at all.
 */

const path = require('path');
const { Wallet } = require('../src/wallet');
const CHAT = require('../src/apps/chat');
const TX = require('../src/tx');
const P = require('../src/params');

const args = process.argv.slice(2);
let rpc = process.env.HEARTH_RPC_URL || 'http://127.0.0.1:8645';
let dataDir = process.env.HEARTH_DATA || path.join(process.cwd(), 'data');
let since = 0;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--rpc') rpc = args[++i];
  else if (args[i] === '--data') dataDir = path.resolve(args[++i]);
  else if (args[i] === '--since') since = Number(args[++i]) || 0;
  else rest.push(args[i]);
}
const [cmd, ...params] = rest;

const api = {
  async get(p) { const r = await fetch(rpc + p); return r.json(); },
  async post(p, body) {
    const r = await fetch(rpc + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.json();
  },
};
const EM = n => (n / P.SPARKS_PER_EMBER).toLocaleString('en-US', { maximumFractionDigits: 8 });

/** A chain-shaped view over the RPC, so Wallet.buildTx works unchanged. */
async function shimFor(w) {
  const byAddr = {};
  for (const a of w.addresses()) byAddr[a] = (await api.get('/address/' + a)).utxos || [];
  return {
    utxosFor: a => byAddr[a] || [],
    balance: a => (byAddr[a] || []).reduce((s, u) => s + u.amount, 0),
  };
}

/** Build, sign and broadcast a tx carrying one record. */
async function sendRecord(w, record, note) {
  const shim = await shimFor(w);
  // The payment is to yourself: the record is the point, the coins are the
  // vehicle. Dust rather than zero, because an output must be positive.
  const tx = w.buildTx(shim, w.primary, 1, [record]);
  const r = await api.post('/tx', { tx });
  if (!r.ok) { console.error(`rejected: ${r.err}`); process.exit(1); }
  console.log(`${note} ✓  tx ${tx.id.slice(0, 16)}…  fee ${EM(TX.requiredFee(tx))} EMBER`);
  return tx;
}

async function announcedKeyFor(address) {
  const { records } = await api.get(`/records?app=${CHAT.APP}&key=${address}&limit=500`);
  return CHAT.resolveReadingKey(records || [], address);
}

function render(m) {
  const when = m.minedAt ? new Date(m.minedAt * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';
  console.log(`\n[#${m.height} ${when}]  from ${m.from || 'unknown'}`);
  console.log(`  ${m.body}`);
}

async function main() {
  switch (cmd) {
    case 'announce': {
      const w = new Wallet(dataDir).load();
      await sendRecord(w, CHAT.announceRecord(w.primary, w.identity.pub), `announced ${w.primary}`);
      console.log('others can write to you once this confirms');
      return;
    }

    case 'whois': {
      const addr = params[0];
      if (!addr) { console.error('usage: whois <address>'); process.exit(1); }
      const key = await announcedKeyFor(addr);
      console.log(key ? `${addr}\n  reading key ${key}` : `${addr} has not announced a reading key`);
      return;
    }

    case 'send': {
      const [to, ...words] = params;
      const body = words.join(' ');
      if (!to || !body) { console.error('usage: send <address> <text…>'); process.exit(1); }
      const key = await announcedKeyFor(to);
      if (!key) {
        console.error(`${to} has not announced a reading key — nothing to encrypt to.`);
        console.error('They need to run: hearth-chat announce');
        process.exit(1);
      }
      const w = new Wallet(dataDir).load();
      await sendRecord(w, CHAT.messageRecord(to, key, body), 'sent');
      return;
    }

    case 'inbox': {
      const w = new Wallet(dataDir).load();
      let count = 0;
      for (const addr of w.addresses()) {
        const { records } = await api.get(
          `/records?app=${CHAT.APP}&key=${addr}&since=${since}&limit=500`);
        for (const m of CHAT.readInbox(records || [], w.identity.priv)) { render(m); count++; }
      }
      console.log(count ? `\n${count} message(s)` : 'no messages');
      return;
    }

    case 'watch': {
      const w = new Wallet(dataDir).load();
      const mine = new Set(w.addresses());
      console.log(`watching ${rpc} for ${mine.size} address(es) — ctrl-c to stop`);
      // One stream, filtered to this app; the node decides what is relevant
      // rather than shipping every block and making the client diff it.
      const res = await fetch(`${rpc}/events?app=${CHAT.APP}`, { headers: { accept: 'text/event-stream' } });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop();
        for (const f of frames) {
          const line = f.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let rec;
          try { rec = JSON.parse(line.slice(6)); } catch { continue; }
          if (!mine.has(rec.key)) continue;
          const m = CHAT.openMessage(rec, w.identity.priv);
          if (m) render(m);
        }
      }
      return;
    }

    default:
      console.log('commands: announce whois send inbox watch');
  }
}
main().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
