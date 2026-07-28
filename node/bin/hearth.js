#!/usr/bin/env node
'use strict';
/* hearth — the terminal tool for the Ember EVM chain.
 *
 *   hearth trace   replay an execution opcode by opcode   <- the reason this exists
 *   hearth watch   a live view of a node
 *   hearth wallet  secp256k1 keys, encrypted at rest
 *   hearth call    read a contract
 *   hearth send    write to a contract
 *   hearth deploy  put a contract on chain
 *   hearth devnet  a throwaway chain for development
 *
 * This file does three things and nothing else: pick a command, load only that
 * command's module, and turn whatever comes back into an exit code. Commands are
 * required lazily so that `hearth trace` never pays for the wallet's crypto and
 * `hearth wallet` never pays for the interpreter — and so that a syntax error in
 * one command cannot stop the others from running.
 *
 * `bin/hearth-cli.js` — the UTXO-era wallet and query client — is untouched and
 * still installed. It talks to the Ed25519/`ember1…` chain, which this tool does
 * not; they are two tools for two chains, and merging them would mean one of the
 * two address formats silently accepting the other's addresses.
 */

const COMMANDS = {
  trace: () => require('../src/cli/trace').main,
  watch: () => require('../src/cli/watch').main,
  wallet: () => require('../src/cli/wallet').main,
  call: () => (argv) => require('../src/cli/contract').main('call', argv),
  send: () => (argv) => require('../src/cli/contract').main('send', argv),
  deploy: () => (argv) => require('../src/cli/contract').main('deploy', argv),
  devnet: () => require('../src/cli/devnet').main,
};

const USAGE = `hearth — the terminal tool for the Ember EVM chain

  hearth trace <txhash>            replay a transaction opcode by opcode
  hearth trace --vector <file>     replay a conformance vector
  hearth watch                     a live view of a node
  hearth wallet <new|list|send|…>  secp256k1 keys, encrypted at rest
  hearth call   --to … --fn …      read a contract
  hearth send   --to … --fn …      write to a contract
  hearth deploy --bin …            put a contract on chain
  hearth devnet <init|accounts|run>  a throwaway chain for development

  hearth <command> --help          the options for one command
  hearth --version

environment
  HEARTH_RPC_URL     node endpoint      (default http://127.0.0.1:8645)
  HEARTH_KEYSTORE    where keys live    (default ~/.hearth/keys)
  HEARTH_PASSPHRASE  unattended unlock — readable by anything that can read
                     your environment, so use it only where that is already true
  NO_COLOR           turn off colour, as does --no-color`;

async function main(argv) {
  const [name, ...rest] = argv;

  if (!name || name === '-h' || name === '--help' || name === 'help') {
    console.log(USAGE);
    return name ? 0 : 2;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    console.log(require('../package.json').version);
    return 0;
  }

  const load = COMMANDS[name];
  if (!load) {
    console.error(`hearth: no command "${name}"`);
    const near = Object.keys(COMMANDS).filter((k) => k.startsWith(name[0]));
    if (near.length) console.error(`did you mean: ${near.join(', ')}?`);
    console.error('`hearth --help` lists them all');
    return 2;
  }

  return load()(rest);
}

/* An exit code is part of the interface: 0 succeeded, 1 the thing you asked
 * about failed (a revert, an unreachable node), 2 you asked wrongly. Scripts
 * depend on telling the second from the third. */
main(process.argv.slice(2))
  .then((code) => { process.exitCode = typeof code === 'number' ? code : 0; })
  .catch((err) => {
    if (err && err.name === 'UsageError') {
      console.error(`hearth: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`hearth: ${err && err.message ? err.message : err}`);
    if (process.env.HEARTH_DEBUG && err && err.stack) console.error(err.stack);
    process.exitCode = 1;
  });
