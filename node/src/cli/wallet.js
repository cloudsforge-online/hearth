'use strict';
/* `hearth wallet` — secp256k1 keys, sealed at rest.
 *
 * THE ONE RULE. A private key is never printed, never logged and never written
 * in the clear unless the user asked for exactly that with a flag whose name
 * says what it does — `--reveal-private-key` — and, on a terminal, confirmed it
 * by typing the address back. There is no `--verbose` that leaks it, no error
 * path that echoes it, and `hearth wallet export` without the flag exports the
 * SEALED record, which is the thing people actually want to back up.
 *
 * The keystore format and its parameters are in `keystore.js`, chosen to match
 * the browser wallet's so that one threat model covers both.
 *
 * WHAT THIS DOES NOT DO YET, honestly:
 *   - no HD derivation (BIP-32/39). One key, one file. A seed phrase is a
 *     different backup story and a different threat model, and doing it badly is
 *     worse than not doing it.
 *   - no hardware wallets, and no ForgeKeyvault integration, though the latter
 *     is the natural next step since it already signs secp256k1 for EVM chains.
 *   - `balance` and `send` need the `eth_*` RPC, which needs the account-model
 *     chain (phase 5/6). Until then they will report that the node does not
 *     answer `eth_getBalance`, which is the truth and not a bug in this file.
 */

const secp = require('../crypto/secp256k1');
const TX = require('../chain/transaction');
const args = require('./args');
const keystore = require('./keystore');
const ui = require('./ui');
const { Client } = require('./client');

const { c } = ui;

const USAGE = `hearth wallet — secp256k1 keys, encrypted at rest

  hearth wallet new [--label <name>]        generate and seal a new key
  hearth wallet import [--label <name>]     seal a key read from stdin
  hearth wallet list                        addresses in the keystore
  hearth wallet address [--from <sel>]      one address
  hearth wallet balance [<address>]         balance via eth_getBalance
  hearth wallet send --to <addr> --value <ember>
  hearth wallet export [--from <sel>] [--reveal-private-key]

options
  --keystore <dir>   where keys live         (default $HEARTH_KEYSTORE or ~/.hearth/keys)
  --from <sel>       which key, by address or label
  --rpc <url>        node JSON-RPC endpoint
  --key <0x…>        import this key instead of reading stdin — NOTE: an argv is
                     visible to every process on the machine via \`ps\`, so this is
                     for automation you already trust, not for daily use
  --gas <n>          gas limit for send      (default 21000)
  --gas-price <wei>  gas price for send      (default eth_gasPrice)
  --nonce <n>        override the nonce
  --yes              skip confirmations
  --json             machine-readable output

The passphrase is read from the terminal with the echo off. \$HEARTH_PASSPHRASE
overrides that for scripts; it is readable by anything that can read your
environment, so it is never the default.`;

const SPEC = {
  booleans: ['reveal-private-key', 'json', 'yes', 'overwrite', 'no-color'],
  strings: ['keystore', 'from', 'rpc', 'label', 'key', 'gas', 'gas-price', 'nonce', 'to', 'value', 'data'],
};

async function newPassphrase() {
  const p1 = await ui.promptSecret('passphrase (this is the only thing protecting the key): ');
  if (p1.length < keystore.MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${keystore.MIN_PASSPHRASE} characters`);
  // A typo in a passphrase you never see is a key you can never open again, so
  // it is confirmed at creation and only at creation.
  if (process.env.HEARTH_PASSPHRASE === undefined && process.stdin.isTTY) {
    const p2 = await ui.promptSecret('confirm: ', { allowEnv: false });
    if (p1 !== p2) throw new Error('the two passphrases do not match');
  }
  return p1;
}

function dirOf(flags) { return flags.keystore || keystore.defaultDir(); }

async function unlock(flags) {
  const dir = dirOf(flags);
  const entry = keystore.find(dir, flags.from || null);
  const rec = keystore.read(entry.file);
  const pass = await ui.promptSecret(`passphrase for ${rec.address}: `);
  return { rec, priv: keystore.open(rec, pass), file: entry.file };
}

// ---------------------------------------------------------------------------

async function cmdNew(flags) {
  const priv = secp.randomPrivateKey();
  const pass = await newPassphrase();
  const rec = keystore.seal(priv, pass, { label: flags.label || null });
  priv.fill(0);
  const file = keystore.save(dirOf(flags), rec, { overwrite: Boolean(flags.overwrite) });
  if (flags.json) { console.log(ui.jsonStringify({ address: rec.address, file, label: rec.label })); return 0; }
  console.log(`${c.green('created')} ${c.bold(rec.address)}`);
  console.log(c.dim(`sealed in ${file}`));
  console.log(c.dim('the passphrase is not recoverable — if it is lost, so is the key'));
  return 0;
}

async function cmdImport(flags) {
  let raw = flags.key;
  if (!raw) raw = await ui.promptSecret('private key (0x…, not echoed): ', { env: 'HEARTH_PRIVATE_KEY' });
  const priv = Buffer.from(String(raw).trim().replace(/^0x/i, ''), 'hex');
  if (priv.length !== 32) throw new Error('a private key is 32 bytes of hex');
  const pass = await newPassphrase();
  const rec = keystore.seal(priv, pass, { label: flags.label || null });
  priv.fill(0);
  const file = keystore.save(dirOf(flags), rec, { overwrite: Boolean(flags.overwrite) });
  if (flags.json) { console.log(ui.jsonStringify({ address: rec.address, file, label: rec.label })); return 0; }
  console.log(`${c.green('imported')} ${c.bold(rec.address)}`);
  console.log(c.dim(`sealed in ${file}`));
  if (flags.key) console.log(c.yellow('the key was passed on the command line and is in your shell history — rotate it if that matters'));
  return 0;
}

function cmdList(flags) {
  const dir = dirOf(flags);
  const all = keystore.list(dir);
  if (flags.json) { console.log(ui.jsonStringify(all)); return 0; }
  if (all.length === 0) { console.log(c.dim(`no keys in ${dir} — \`hearth wallet new\` makes one`)); return 0; }
  console.log(c.dim(dir));
  for (const e of all) {
    if (!e.ok) { console.log(`  ${c.red('unreadable')} ${e.file}${e.error ? c.dim(' — ' + e.error) : ''}`); continue; }
    console.log(`  ${c.bold(e.address)}${e.label ? '  ' + e.label : ''}${e.created ? c.dim('  ' + new Date(e.created).toISOString().slice(0, 10)) : ''}`);
  }
  return 0;
}

function cmdAddress(flags) {
  const entry = keystore.find(dirOf(flags), flags.from || null);
  const rec = keystore.read(entry.file);
  console.log(flags.json ? ui.jsonStringify({ address: rec.address }) : rec.address);
  return 0;
}

async function cmdBalance(flags, positional) {
  const client = new Client(flags.rpc);
  let address = positional[0];
  if (!address) address = keystore.read(keystore.find(dirOf(flags), flags.from || null).file).address;
  const wei = await client.getBalance(address);
  if (flags.json) { console.log(ui.jsonStringify({ address: ui.checksumAddress(address), wei })); return 0; }
  console.log(`${ui.checksumAddress(address)}  ${c.bold(ui.formatUnits(wei, 'ether'))} EMBER`);
  return 0;
}

async function cmdSend(flags) {
  const client = new Client(flags.rpc);
  const to = args.need(flags, 'to', 'the recipient');
  const value = ui.parseUnits(args.need(flags, 'value', 'the amount in EMBER'), 'ether');
  const data = flags.data ? ui.toBuf(flags.data) : Buffer.alloc(0);

  const { rec, priv } = await unlock(flags);
  try {
    const chainId = await client.chainId().catch(() => BigInt(TX.CHAIN_ID));
    const nonce = flags.nonce !== undefined ? args.bigFlag(flags, 'nonce') : await client.getNonce(rec.address, 'pending');
    const gasPrice = flags['gas-price'] !== undefined ? args.bigFlag(flags, 'gas-price') : await client.gasPrice();
    const gasLimit = flags.gas !== undefined ? args.bigFlag(flags, 'gas') : 21000n;

    const signed = TX.sign({ nonce, gasPrice, gasLimit, to, value, data }, priv, { chainId: Number(chainId) });
    const raw = TX.encode(signed);
    const hash = ui.hex(TX.hash(raw));

    if (!flags.yes && process.stdin.isTTY && !flags.json) {
      console.log(`  from   ${rec.address}`);
      console.log(`  to     ${ui.checksumAddress(to)}`);
      console.log(`  value  ${ui.formatUnits(value, 'ether')} EMBER`);
      console.log(`  fee    up to ${ui.formatUnits(gasLimit * gasPrice, 'ether')} EMBER (${gasLimit} gas @ ${gasPrice} wei)`);
      const yn = await ui.promptLine('send? [y/N] ');
      if (!/^y(es)?$/i.test(yn.trim())) { console.log('cancelled'); return 1; }
    }

    const sent = await client.sendRawTransaction(raw);
    if (flags.json) { console.log(ui.jsonStringify({ hash: sent || hash, from: rec.address, to: ui.checksumAddress(to), value })); return 0; }
    console.log(`${c.green('sent')} ${sent || hash}`);
    return 0;
  } finally {
    priv.fill(0);
  }
}

async function cmdExport(flags) {
  const entry = keystore.find(dirOf(flags), flags.from || null);
  const rec = keystore.read(entry.file);

  if (!flags['reveal-private-key']) {
    // The default export is the SEALED record — which is what a backup is.
    console.log(JSON.stringify(rec, null, 2));
    console.error(c.dim('this is the encrypted keystore record; --reveal-private-key prints the key itself'));
    return 0;
  }

  console.error(c.red(c.bold('This prints the raw private key.')));
  console.error(c.yellow('Anyone who sees it — over your shoulder, in a scrollback buffer, in a screen share, in a log — can spend everything this address holds, for ever. There is no revocation.'));
  if (!flags.yes && process.stdin.isTTY) {
    const typed = await ui.promptLine(`type the address to confirm (${rec.address}): `);
    if (typed.trim().toLowerCase() !== String(rec.address).toLowerCase()) { console.error('cancelled'); return 1; }
  }
  const pass = await ui.promptSecret(`passphrase for ${rec.address}: `);
  const priv = keystore.open(rec, pass);
  try {
    console.log(ui.hex(priv));
  } finally {
    priv.fill(0);
  }
  return 0;
}

async function main(argv) {
  const { flags, positional } = args.parse(argv, SPEC);
  if (flags['no-color']) ui.setColour(false);
  const sub = positional.shift();
  if (flags.help || !sub) { console.log(USAGE); return flags.help ? 0 : 2; }

  switch (sub) {
    case 'new': return cmdNew(flags);
    case 'import': return cmdImport(flags);
    case 'list': case 'ls': return cmdList(flags);
    case 'address': return cmdAddress(flags);
    case 'balance': return cmdBalance(flags, positional);
    case 'send': return cmdSend(flags);
    case 'export': return cmdExport(flags);
    default:
      throw new args.UsageError(`unknown wallet command "${sub}" — try one of: new, import, list, address, balance, send, export`);
  }
}

module.exports = { main, USAGE, unlock, dirOf };
