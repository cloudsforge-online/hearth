'use strict';
/* `hearth devnet` — a throwaway chain for contract development.
 *
 * READ THIS BEFORE BELIEVING THE NAME. The account-model chain does not exist
 * yet. `docs/evm-spec.md` §8 puts block production on the new state model in
 * phase 5 and there is no `chain/statetransition.js`, no version-2 header and
 * nothing that mines an EVM block. So what this command can honestly do today
 * is the half that does not need consensus:
 *
 *   WORKS NOW
 *     - deterministic pre-funded accounts, with their keys, reproducible from a
 *       seed so a test fixture can hard-code an address and keep working
 *     - a genesis file in the shape §1–§2 specify: chain id 7411, 18 decimals,
 *       a 30,000,000 gas limit, an `alloc` map keyed by 0x address
 *     - `--run`, which starts the EXISTING node (`bin/hearthd.js`) on a scratch
 *       data directory, so the REST API, SSE and `hearth watch` have something
 *       to talk to
 *
 *   DOES NOT WORK YET, and will not until phase 5 lands
 *     - the node it starts is the UTXO chain. It will not execute a contract,
 *       it does not read `genesis.json`, and `eth_sendRawTransaction` has no
 *       chain behind it. `hearth deploy` against this will fail, and it should.
 *     - so the accounts are pre-funded on paper only: the alloc is a promise
 *       phase 5 keeps, not a balance anything can spend today
 *
 * Saying that plainly costs nothing and is worth a great deal: a devnet that
 * silently does not execute code is a day lost to debugging a contract that was
 * never running.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { keccak256 } = require('../crypto/keccak');
const secp = require('../crypto/secp256k1');
const TX = require('../chain/transaction');
const args = require('./args');
const keystore = require('./keystore');
const ui = require('./ui');

const { c } = ui;

const CHAIN_ID = TX.CHAIN_ID;
const BLOCK_GAS_LIMIT = 30000000n;
const DEFAULT_ACCOUNTS = 10;
const DEFAULT_BALANCE = 10000n * 10n ** 18n;      // 10,000 EMBER at 18 decimals

/**
 * Deterministic keys from a seed phrase: `priv_i = keccak256(seed || i)`,
 * rejected and re-hashed on the (astronomically unlikely) chance of landing
 * outside `[1, n)`.
 *
 * Deterministic on purpose. Hardhat's fixed accounts are the reason its examples
 * can hard-code an address, and a devnet whose addresses move every restart
 * forces every fixture to be dynamic for no benefit. The trade — these keys are
 * public and anyone can compute them — is exactly why they are only ever funded
 * on a throwaway chain, and why this prints that in red.
 */
function deriveAccounts(seed, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let material = Buffer.concat([Buffer.from(String(seed), 'utf8'), Buffer.from([i])]);
    let priv = keccak256(material);
    let guard = 0;
    while (!secp.isValidPrivateKey(priv)) {
      if (++guard > 16) throw new Error('devnet: could not derive a valid key — change the seed');
      priv = keccak256(priv);
    }
    out.push({ index: i, privateKey: ui.hex(priv), address: keystore.addressFor(priv) });
  }
  return out;
}

/** The genesis file phase 5 will read. Nothing consumes it yet; that is the point. */
function makeGenesis(accounts, balance) {
  const alloc = {};
  for (const a of accounts) alloc[a.address] = { balance: balance.toString() };
  return {
    // Named so a future reader can tell at a glance which spec this was written
    // against, and so a mismatched pair fails loudly rather than half-loading.
    format: 'hearth-genesis/1',
    spec: 'docs/evm-spec.md §1–§2',
    chainId: Number(CHAIN_ID),
    decimals: 18,
    gasLimit: BLOCK_GAS_LIMIT.toString(),
    // Phase 5 fills these from the real header; they are here so the shape is
    // settled and a loader can be written against it.
    timestamp: 0,
    extraData: '0x',
    alloc,
  };
}

const USAGE = `hearth devnet — a throwaway chain for contract development

  hearth devnet init [--dir <path>] [--accounts <n>] [--balance <ember>]
  hearth devnet accounts [--seed <phrase>] [--accounts <n>]
  hearth devnet run [--dir <path>] [--rpc-port <n>] [--p2p-port <n>]

options
  --dir <path>       devnet data directory     (default ./devnet)
  --accounts <n>     how many pre-funded keys  (default ${DEFAULT_ACCOUNTS})
  --balance <ember>  each account's balance    (default 10000)
  --seed <phrase>    key derivation seed       (default "hearth devnet")
  --rpc-port <n>     node REST/RPC port        (default 8645)
  --p2p-port <n>     node P2P port             (default 8644)
  --mine             mine blocks               (default on for run)
  --json             machine-readable output

WHAT THIS CANNOT DO YET. The account-model chain lands in phase 5
(docs/evm-spec.md §8). \`run\` starts the existing UTXO node, which does not read
genesis.json, does not execute contracts and does not serve eth_*. The accounts
and the genesis file are real and reproducible; the balances in them are a
promise phase 5 keeps, not a balance anything can spend today.`;

const SPEC = {
  booleans: ['json', 'mine', 'no-color', 'quiet', 'force'],
  strings: ['dir', 'accounts', 'balance', 'seed', 'rpc-port', 'p2p-port'],
};

const dirOf = (flags) => path.resolve(flags.dir || process.env.HEARTH_DEVNET || 'devnet');
const seedOf = (flags) => flags.seed || 'hearth devnet';
const countOf = (flags) => args.intFlag(flags, 'accounts', DEFAULT_ACCOUNTS);

function warnPublic() {
  console.error(c.red('These keys are derived from a public seed. Anyone can compute them.'));
  console.error(c.yellow('Never send anything of value to a devnet address, and never reuse one of these keys anywhere else.'));
}

function cmdAccounts(flags) {
  const accounts = deriveAccounts(seedOf(flags), countOf(flags));
  if (flags.json) { console.log(ui.jsonStringify(accounts)); return 0; }
  warnPublic();
  console.log('');
  for (const a of accounts) console.log(`  ${c.dim('#' + String(a.index).padStart(2))} ${c.bold(a.address)}  ${c.dim(a.privateKey)}`);
  return 0;
}

function cmdInit(flags) {
  const dir = dirOf(flags);
  const accounts = deriveAccounts(seedOf(flags), countOf(flags));
  const balance = flags.balance ? ui.parseUnits(flags.balance, 'ether') : DEFAULT_BALANCE;
  const genesis = makeGenesis(accounts, balance);

  if (fs.existsSync(dir) && !flags.force) {
    const entries = fs.readdirSync(dir);
    if (entries.length) throw new Error(`${dir} is not empty — pass --force to overwrite, or --dir somewhere else`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'genesis.json'), JSON.stringify(genesis, null, 2) + '\n');
  /* Plaintext keys, deliberately, in a file whose name says so. A devnet key
   * that needs a passphrase every time defeats the purpose, and pretending these
   * are secret when they are derived from a published seed would be theatre. */
  fs.writeFileSync(
    path.join(dir, 'accounts.PUBLIC-KEYS-DO-NOT-REUSE.json'),
    JSON.stringify({ seed: seedOf(flags), warning: 'these private keys are derived from a public seed and are worthless by design', accounts }, null, 2) + '\n',
    { mode: 0o600 },
  );

  if (flags.json) { console.log(ui.jsonStringify({ dir, genesis, accounts })); return 0; }
  console.log(`${c.green('devnet initialised')} ${dir}`);
  console.log(c.dim(`  genesis.json                            chain ${genesis.chainId}, gas limit ${genesis.gasLimit}`));
  console.log(c.dim(`  accounts.PUBLIC-KEYS-DO-NOT-REUSE.json  ${accounts.length} accounts, ${ui.formatUnits(balance, 'ether')} EMBER each`));
  console.log('');
  warnPublic();
  console.log('');
  console.log(c.yellow('genesis.json is not read by anything yet: the account-model chain is phase 5'));
  console.log(c.dim('`hearth devnet run` starts the existing UTXO node so the REST API and `hearth watch` have something to talk to'));
  return 0;
}

function cmdRun(flags) {
  const dir = dirOf(flags);
  if (!fs.existsSync(path.join(dir, 'genesis.json'))) {
    throw new Error(`${dir} has no genesis.json — run \`hearth devnet init --dir ${dir}\` first`);
  }
  const rpcPort = args.intFlag(flags, 'rpc-port', 8645);
  const p2pPort = args.intFlag(flags, 'p2p-port', 8644);
  const daemon = path.join(__dirname, '..', '..', 'bin', 'hearthd.js');

  console.error(c.yellow('starting the UTXO node: it does not read genesis.json and will not execute contracts (phase 5)'));
  console.error(c.dim(`  data ${path.join(dir, 'chain')}  rpc :${rpcPort}  p2p :${p2pPort}`));
  console.error(c.dim(`  watch it with: hearth watch --rpc http://127.0.0.1:${rpcPort}`));

  const child = spawn(process.execPath, [
    daemon,
    '--data', path.join(dir, 'chain'),
    '--rpc', String(rpcPort),
    '--p2p', String(p2pPort),
    ...(flags.mine === false ? [] : ['--mine']),
    ...(flags.quiet ? ['--quiet'] : []),
  ], { stdio: 'inherit' });

  return new Promise((resolve) => {
    const stop = () => { child.kill('SIGINT'); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('exit', (code) => resolve(code === null ? 0 : code));
  });
}

async function main(argv) {
  const { flags, positional } = args.parse(argv, SPEC);
  if (flags['no-color']) ui.setColour(false);
  const sub = positional.shift() || 'init';
  if (flags.help) { console.log(USAGE); return 0; }
  switch (sub) {
    case 'init': return cmdInit(flags);
    case 'accounts': return cmdAccounts(flags);
    case 'run': return cmdRun(flags);
    default:
      throw new args.UsageError(`unknown devnet command "${sub}" — try one of: init, accounts, run`);
  }
}

module.exports = { main, USAGE, deriveAccounts, makeGenesis, CHAIN_ID, BLOCK_GAS_LIMIT, DEFAULT_BALANCE };
