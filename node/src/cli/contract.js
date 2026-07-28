'use strict';
/* `hearth call`, `hearth send`, `hearth deploy` — contract interaction.
 *
 * The three share everything except what they do with the encoded calldata:
 * `call` asks `eth_call` and decodes the answer, `send` signs and broadcasts,
 * `deploy` appends constructor arguments to a bytecode blob and broadcasts a
 * creation. So they share one argument parser and one encoder, and differ in
 * about ten lines each.
 *
 * A FUNCTION CAN BE NAMED TWO WAYS, and both matter:
 *   --fn transfer               resolved against --abi, which also gives the
 *                               output types, so the answer decodes
 *   --fn 'balanceOf(address)'   a full signature, which needs no ABI at all —
 *                               the right thing when you have an address, a
 *                               block explorer and a suspicion
 * With a bare signature there is nothing to decode the OUTPUT with, so `call`
 * prints raw words unless `--returns 'uint256'` says otherwise. Guessing would
 * be worse: `uint256` and `int256` and `bytes32` are the same 32 bytes, and a
 * wrong guess is a plausible wrong number.
 *
 * ARGUMENTS ARE POSITIONAL AND TYPED BY THE ABI. Arrays and tuples are given as
 * JSON — `--args '[1,2,3]'` — because there is no shell-safe punctuation left
 * and inventing one more mini-language to get subtly wrong helps nobody.
 */

const fs = require('fs');

const TX = require('../chain/transaction');
const abi = require('./abi');
const args = require('./args');
const keystore = require('./keystore');
const ui = require('./ui');
const wallet = require('./wallet');
const { Client, RpcError } = require('./client');

const { c } = ui;

const USAGE = `hearth call / send / deploy — contract interaction

  hearth call   --to <addr> --fn <name|sig> [args…] [--abi <file>]
  hearth send   --to <addr> --fn <name|sig> [args…] [--abi <file>] [--value <ember>]
  hearth deploy --bin <file|0x…> [--abi <file>] [args…] [--value <ember>]

options
  --abi <file>       contract ABI (a JSON array, or solc's { "abi": […] })
  --fn <name|sig>    function name from the ABI, or a full signature
  --returns <types>  output types for a bare signature, comma separated
  --to <address>     the contract
  --value <ember>    value to send                 (default 0)
  --from <sel>       which key signs               (send/deploy)
  --block <tag>      block for eth_call            (default latest)
  --gas <n>          gas limit                     (default eth_estimateGas)
  --gas-price <wei>  gas price                     (default eth_gasPrice)
  --nonce <n>        override the nonce
  --keystore <dir>   where keys live
  --rpc <url>        node JSON-RPC endpoint
  --data-only        print the encoded calldata and stop — no node needed
  --wait             wait for the receipt          (send/deploy)
  --yes              skip confirmations
  --json             machine-readable output

Arguments are positional, in ABI order. Arrays and tuples are JSON:
  hearth call --abi erc20.json --to 0x… --fn balanceOf 0xabc…
  hearth send --abi pool.json  --to 0x… --fn swap '[1,2]' 0xabc… 1700000000`;

const SPEC = {
  booleans: ['json', 'yes', 'wait', 'data-only', 'no-color'],
  strings: ['abi', 'fn', 'returns', 'to', 'value', 'from', 'block', 'gas', 'gas-price', 'nonce', 'keystore', 'rpc', 'bin'],
};

/** solc emits `{ abi, bytecode }`; hardhat emits the same; a bare array is fine too. */
function loadAbi(file) {
  if (!file) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.abi)) return parsed.abi;
  throw new Error(`${file} does not look like an ABI (expected an array, or an object with an "abi" array)`);
}

/** solc's artefact keeps the deploy bytecode in one of three places. */
function loadBytecode(spec) {
  if (/^0x[0-9a-fA-F]*$/.test(String(spec).trim())) return ui.toBuf(spec);
  const text = fs.readFileSync(spec, 'utf8').trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(text)) return ui.toBuf(text);
  const j = JSON.parse(text);
  const b = j.bytecode && j.bytecode.object ? j.bytecode.object : j.bytecode || j.bin || (j.evm && j.evm.bytecode && j.evm.bytecode.object);
  if (!b) throw new Error(`${spec} has no deploy bytecode (looked at .bytecode, .bytecode.object, .bin, .evm.bytecode.object)`);
  return ui.toBuf(b);
}

/**
 * One CLI argument -> an ABI value.
 *
 * The type decides how to read it, which is the only way this can work: `1` is a
 * number for `uint256` and a string for `string`, and `[1,2]` is JSON for an
 * array and eleven literal characters for `bytes`.
 */
function coerce(type, raw) {
  switch (type.kind) {
    case 'array': case 'tuple': {
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        throw new args.UsageError(`${abi.canonical(type)} must be given as JSON, got ${JSON.stringify(raw)}`);
      }
      if (!Array.isArray(parsed)) throw new args.UsageError(`${abi.canonical(type)} must be a JSON array, got ${JSON.stringify(raw)}`);
      const inner = type.kind === 'array' ? parsed.map(() => type.base) : type.components;
      return parsed.map((v, i) => coerce(inner[i], typeof v === 'string' ? v : JSON.stringify(v)));
    }
    case 'bool': return raw === 'true' || raw === '1';
    case 'string': return raw;
    default: return raw;
  }
}

function encodeArgs(inputs, positional) {
  if (positional.length !== inputs.length) {
    throw new args.UsageError(`this function takes ${inputs.length} argument${inputs.length === 1 ? '' : 's'} (${inputs.map(abi.canonical).join(', ') || 'none'}), got ${positional.length}`);
  }
  return abi.encodeParameters(inputs, inputs.map((t, i) => coerce(t, positional[i])));
}

/** `--returns 'uint256,address'`, or the ABI's own output types. */
function outputTypes(fn, flags) {
  if (flags.returns) return abi.splitTop(flags.returns).map(abi.parseType);
  return fn.outputs;
}

function printOutputs(types, names, data, flags) {
  if (types.length === 0) {
    const words = [];
    for (let i = 0; i + 32 <= data.length; i += 32) words.push(ui.hex(data.subarray(i, i + 32)));
    if (flags.json) { console.log(ui.jsonStringify({ raw: ui.hex(data), words })); return; }
    if (data.length === 0) { console.log(c.dim('(no return data)')); return; }
    console.log(c.dim('no output types known — pass --abi or --returns to decode'));
    for (const w of words) console.log('  ' + w);
    if (data.length % 32) console.log('  ' + ui.hex(data.subarray(data.length - (data.length % 32))) + c.dim(' (partial word)'));
    return;
  }
  const values = abi.decodeParameters(types, data);
  if (flags.json) { console.log(ui.jsonStringify({ raw: ui.hex(data), values })); return; }
  values.forEach((v, i) => {
    const label = (names && names[i]) || abi.canonical(types[i]);
    console.log(`  ${c.dim(ui.padEnd(label, 18))} ${abi.formatValue(v)}`);
  });
}

/** An RPC error of code 3 carries the revert payload; that is what makes it readable. */
function explainRpcError(e, abiList) {
  if (!(e instanceof RpcError)) return null;
  const reason = e.data ? abi.decodeRevert(e.data, abiList) : null;
  return reason ? `${e.message}\n  ${c.yellow(reason.text)}` : null;
}

// ---------------------------------------------------------------------------

async function cmdCall(flags, positional) {
  const abiList = loadAbi(flags.abi);
  const fn = abi.resolveFunction(abiList, args.need(flags, 'fn', 'the function to call'));
  const data = Buffer.concat([fn.selector, encodeArgs(fn.inputs, positional)]);

  if (flags['data-only']) { console.log(ui.hex(data)); return 0; }

  const client = new Client(flags.rpc);
  const tx = { to: ui.checksumAddress(args.need(flags, 'to', 'the contract address')), data: ui.hex(data) };
  if (flags.value) tx.value = '0x' + ui.parseUnits(flags.value, 'ether').toString(16);
  if (flags.from) tx.from = keystore.read(keystore.find(wallet.dirOf(flags), flags.from).file).address;

  let out;
  try {
    out = await client.call(tx, flags.block || 'latest');
  } catch (e) {
    const why = explainRpcError(e, abiList);
    if (why) { console.error(c.red(why)); return 1; }
    throw e;
  }
  if (!flags.json) console.log(c.dim(`${fn.signature} @ ${tx.to}`));
  printOutputs(outputTypes(fn, flags), fn.outputNames, out, flags);
  return 0;
}

async function broadcast(client, flags, { to, data, value, abiList, label }) {
  const { rec, priv } = await wallet.unlock(flags);
  try {
    const chainId = await client.chainId().catch(() => BigInt(TX.CHAIN_ID));
    const nonce = flags.nonce !== undefined ? args.bigFlag(flags, 'nonce') : await client.getNonce(rec.address, 'pending');
    const gasPrice = flags['gas-price'] !== undefined ? args.bigFlag(flags, 'gas-price') : await client.gasPrice();
    const draft = { from: rec.address, data: ui.hex(data), value: '0x' + value.toString(16) };
    if (to) draft.to = to;

    let gasLimit;
    if (flags.gas !== undefined) gasLimit = args.bigFlag(flags, 'gas');
    else {
      try { gasLimit = (await client.estimateGas(draft) * 12n) / 10n; }   // 20% headroom
      catch (e) {
        const why = explainRpcError(e, abiList);
        throw new Error(`gas estimation failed — the call would revert.\n  ${why || e.message}\n  pass --gas <n> to send it anyway`);
      }
    }

    if (!flags.yes && process.stdin.isTTY && !flags.json) {
      console.log(`  ${label}`);
      console.log(`  from   ${rec.address}`);
      if (to) console.log(`  to     ${to}`);
      console.log(`  value  ${ui.formatUnits(value, 'ether')} EMBER`);
      console.log(`  fee    up to ${ui.formatUnits(gasLimit * gasPrice, 'ether')} EMBER (${gasLimit} gas @ ${gasPrice} wei)`);
      const yn = await ui.promptLine('send? [y/N] ');
      if (!/^y(es)?$/i.test(yn.trim())) { console.log('cancelled'); return null; }
    }

    const signed = TX.sign({ nonce, gasPrice, gasLimit, to: to || null, value, data }, priv, { chainId: Number(chainId) });
    const raw = TX.encode(signed);
    const hash = await client.sendRawTransaction(raw) || ui.hex(TX.hash(raw));
    return { hash, from: rec.address, nonce, gasLimit, gasPrice };
  } finally {
    priv.fill(0);
  }
}

async function waitForReceipt(client, hash, { timeoutMs = 120000, everyMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await client.getTransactionReceipt(hash).catch(() => null);
    if (r) return r;
    if (Date.now() > deadline) throw new Error(`no receipt for ${hash} after ${timeoutMs}ms — it may still be pending`);
    await new Promise((res) => setTimeout(res, everyMs));
  }
}

async function cmdSend(flags, positional) {
  const abiList = loadAbi(flags.abi);
  const fn = abi.resolveFunction(abiList, args.need(flags, 'fn', 'the function to call'));
  const data = Buffer.concat([fn.selector, encodeArgs(fn.inputs, positional)]);
  if (flags['data-only']) { console.log(ui.hex(data)); return 0; }

  if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') {
    console.error(c.yellow(`${fn.signature} is ${fn.stateMutability} — \`hearth call\` reads it for free; sending burns gas to no effect`));
  }

  const client = new Client(flags.rpc);
  const to = ui.checksumAddress(args.need(flags, 'to', 'the contract address'));
  const value = flags.value ? ui.parseUnits(flags.value, 'ether') : 0n;

  const sent = await broadcast(client, flags, { to, data, value, abiList, label: fn.signature });
  if (!sent) return 1;
  return report(client, flags, sent, abiList);
}

async function cmdDeploy(flags, positional) {
  const abiList = loadAbi(flags.abi);
  const code = loadBytecode(args.need(flags, 'bin', 'the deploy bytecode or artefact'));
  const ctor = abi.resolveConstructor(abiList);
  const data = Buffer.concat([code, encodeArgs(ctor, positional)]);
  if (flags['data-only']) { console.log(ui.hex(data)); return 0; }

  const client = new Client(flags.rpc);
  const value = flags.value ? ui.parseUnits(flags.value, 'ether') : 0n;
  const sent = await broadcast(client, flags, { to: null, data, value, abiList, label: `deploy ${data.length} bytes` });
  if (!sent) return 1;

  // The address is a pure function of sender and nonce, so it is knowable now —
  // and worth printing before the receipt, because that is the value you need to
  // paste into the next command whether or not you wait.
  const predicted = ui.checksumAddress(TX.contractAddress(ui.toBuf(sent.from), sent.nonce));
  if (!flags.json) console.log(`${c.dim('address')} ${c.bold(predicted)} ${c.dim('(from sender + nonce ' + sent.nonce + ')')}`);
  return report(client, flags, { ...sent, contractAddress: predicted }, abiList);
}

async function report(client, flags, sent, abiList) {
  if (!flags.wait) {
    if (flags.json) { console.log(ui.jsonStringify(sent)); return 0; }
    console.log(`${c.green('sent')} ${sent.hash}`);
    console.log(c.dim('--wait blocks until the receipt lands'));
    return 0;
  }
  const receipt = await waitForReceipt(client, sent.hash);
  const ok = receipt.status === '0x1' || receipt.status === 1;
  if (flags.json) { console.log(ui.jsonStringify({ ...sent, receipt })); return ok ? 0 : 1; }
  console.log(`${ok ? c.green('mined') : c.red('reverted')} ${sent.hash}  block ${BigInt(receipt.blockNumber)}  gas used ${BigInt(receipt.gasUsed)}`);
  if (receipt.contractAddress) console.log(`${c.dim('deployed')} ${ui.checksumAddress(receipt.contractAddress)}`);
  for (const log of receipt.logs || []) {
    console.log(c.dim(`  log ${ui.shortHex(log.address, 6)} topics ${(log.topics || []).length} data ${(log.data || '0x').length / 2 - 1}B`));
  }
  if (!ok) console.log(c.dim(`\`hearth trace ${sent.hash}\` shows the opcode it failed on`));
  return ok ? 0 : 1;
}

async function main(which, argv) {
  const { flags, positional } = args.parse(argv, SPEC);
  if (flags['no-color']) ui.setColour(false);
  if (flags.help) { console.log(USAGE); return 0; }
  if (which === 'call') return cmdCall(flags, positional);
  if (which === 'send') return cmdSend(flags, positional);
  if (which === 'deploy') return cmdDeploy(flags, positional);
  throw new args.UsageError(`unknown contract command ${which}`);
}

module.exports = { main, USAGE, loadAbi, loadBytecode, encodeArgs, coerce, outputTypes, waitForReceipt };
