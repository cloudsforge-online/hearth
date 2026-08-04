#!/usr/bin/env node
'use strict';
/* The engine the Hearth desktop app supervises: one mining session, one key,
 * spoken as JSON lines over stdin and stdout.
 *
 * WHY A SEPARATE PROCESS AT ALL. The mining loop is `node/src/mine/session.js`,
 * and the reason it is that file and not a Rust port is written at the top of
 * it: a second implementation drifts, and this repository has already paid for
 * that once. So the app runs the same loop the command-line miner runs, in the
 * same language, from the same source.
 *
 * WHY THE KEY LIVES HERE AND NOT IN THE WINDOW. A webview is the most hostile
 * place in a desktop application to keep a secret: it renders, it can be
 * inspected, its contents end up in screenshots and in crash reports, and every
 * `innerHTML` in the UI is one bug away from being a place a key can be read
 * from. So the private key exists in exactly one process — this one — and the
 * window is told the ADDRESS and never the key.
 *
 * THE RULE THIS FILE IS BUILT AROUND, and app-desktop/test/engine.js checks it
 * by scanning every byte the process ever writes:
 *
 *     NO PRIVATE KEY, PASSPHRASE OR CIPHERTEXT EVER CROSSES STDOUT OR STDERR.
 *
 * That is why there is no "show me my private key" command. Exporting one is a
 * real need — somebody will want this address in MetaMask — and it is served by
 * `key.export`, which writes the key to a FILE the user named, at mode 600, and
 * answers with nothing but that path. A secret that never enters the IPC channel
 * cannot leak from it, cannot be logged by the supervising process, and cannot
 * be photographed off a screen during a call.
 *
 * PASSPHRASES ARRIVE ON STDIN, NEVER IN ARGV. `ps` is world-readable on every
 * platform this ships to.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* The node sources are resolved relative to THIS file, not to the working
 * directory. In a bundle the app is launched from Finder or a Start menu, where
 * the cwd is `/` or the user's home — the previous scaffolding defaulted to
 * `../../node/bin/hearthd.js` relative to cwd and could only ever have worked
 * from a dev checkout. `HEARTH_NODE_SRC` lets the packager put node/src
 * wherever the platform wants it. */
const NODE_SRC = process.env.HEARTH_NODE_SRC || path.join(__dirname, '..', '..', 'node', 'src');
const req = m => require(path.join(NODE_SRC, m));

const P = req('params');
const KS = req('mine/keystore');
const { MineSession } = req('mine/session');
const { ember } = req('coinbase');

// ---- the wire --------------------------------------------------------------

/** One JSON object per line, flushed immediately: a UI that buffers is a UI that lies. */
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
const emit = (event, data) => write({ event, data: data || {} });

/**
 * Everything this process says about a failure passes through here.
 *
 * An exception raised while a passphrase is in scope can carry it — `TypeError:
 * Cannot read properties of undefined` is harmless, a stack frame quoting an
 * argument is not — and a stack trace is no use to somebody looking at a window
 * anyway. So errors are reduced to their message, and the message is what the
 * keystore and the session were written to make fit for a person to read.
 */
function reason(e) { return String((e && e.message) || e || 'unknown error'); }

// ---- state -----------------------------------------------------------------

const state = {
  dataDir: process.env.HEARTH_APP_DATA || path.join(process.cwd(), 'hearth-desktop-data'),
  key: null,            // unlocked coinbase key, or null
  session: null,        // a running MineSession, or null
  running: null,        // the promise it resolves with
};

/** What the window may know. Deliberately enumerated rather than spread. */
function snapshot() {
  const s = state.session && state.session.stats();
  return {
    dataDir: state.dataDir,
    keystore: KS.exists(state.dataDir) ? KS.peek(state.dataDir) : null,
    unlocked: state.key !== null,
    address: state.key ? state.key.addressHex : (KS.exists(state.dataDir) ? KS.peek(state.dataDir).address : null),
    network: P.NETWORK,
    chainId: P.CHAIN_ID,
    coin: P.COIN,
    mining: s ? s.running : false,
    session: s || null,
    earned: s ? ember(BigInt(s.earnedWei)) : '0',
  };
}

// ---- commands --------------------------------------------------------------

const commands = {
  /** Everything the window needs to draw itself, and nothing more. */
  status() { return snapshot(); },

  /** Where the keystore lives. Changing it locks whatever was open. */
  'data.set'({ dir }) {
    if (!dir) throw new Error('a data directory is required');
    if (state.session) throw new Error('stop mining before changing the data directory');
    state.dataDir = path.resolve(dir);
    state.key = null;
    return snapshot();
  },

  /**
   * First run. Creates an encrypted keystore for a fresh key, or for one the
   * user is bringing with them, and leaves it UNLOCKED — nobody wants to type a
   * passphrase they invented four seconds ago.
   */
  'keystore.create'({ passphrase, privateKey }) {
    state.key = KS.create(state.dataDir, passphrase, privateKey || null);
    return snapshot();
  },

  'keystore.unlock'({ passphrase }) {
    state.key = KS.open(state.dataDir, passphrase);
    return snapshot();
  },

  /** Forget the key without exiting. What the window's "lock" button means. */
  'keystore.lock'() {
    if (state.session) throw new Error('stop mining before locking the key');
    state.key = null;
    return snapshot();
  },

  'keystore.changePassphrase'({ passphrase, newPassphrase }) {
    state.key = KS.changePassphrase(state.dataDir, passphrase, newPassphrase);
    return snapshot();
  },

  /** Adopt the plaintext coinbase-key.json that `hearth-mine` and `hearthd` write. */
  'keystore.importPlaintext'({ file, passphrase }) {
    state.key = KS.importPlaintext(state.dataDir, file, passphrase);
    return snapshot();
  },

  /**
   * Write the private key to a file the user chose, and answer with the path.
   *
   * The key does NOT come back over this channel — see the header. The
   * passphrase is required again so that a window somebody walked away from is
   * not an export.
   */
  'key.export'({ file, passphrase }) {
    if (!file) throw new Error('choose where to save the key first');
    const target = path.resolve(file);
    if (fs.existsSync(target)) throw new Error(`${target} already exists — choose another name`);
    const hex = KS.revealPrivateKey(state.dataDir, passphrase);
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${hex}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chmodSync(target, 0o600);
    return { file: target, address: snapshot().address };
  },

  /** Copy the keystore somewhere the user will still have it if this disk dies. */
  'keystore.backup'({ file }) {
    if (!file) throw new Error('choose where to save the backup first');
    const target = path.resolve(file);
    if (fs.existsSync(target)) throw new Error(`${target} already exists — choose another name`);
    fs.copyFileSync(KS.keystorePath(state.dataDir), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    return { file: target };
  },

  'mine.start'({ url, throttle }) {
    if (!state.key) throw new Error('unlock the mining key first');
    if (state.session) throw new Error('already mining');
    if (!url) throw new Error('a node to take work from is required');

    const session = new MineSession({ url, key: state.key, throttle: Number(throttle) || 1 });
    /* Forwarded verbatim. The session's payloads are already free of key
     * material by construction (node/test/mine-session.js checks the whole
     * stream), so there is nothing to filter and nothing to get wrong here. */
    for (const e of ['started', 'work', 'rate', 'accepted', 'stale', 'refused',
      'throttled', 'unreachable', 'reachable', 'badwork', 'lost', 'error']) {
      session.on(e, d => emit(e, d));
    }
    session.on('stopped', d => { state.session = null; state.running = null; emit('stopped', d); });

    state.session = session;
    state.running = session.run().catch(e => { emit('error', { err: reason(e) }); });
    return snapshot();
  },

  async 'mine.stop'() {
    if (!state.session) return snapshot();
    const running = state.running;
    state.session.stop('asked to stop');
    await running;
    return snapshot();
  },
};

// ---- the loop --------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async line => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return write({ ok: false, err: 'not JSON' }); }
  const fn = commands[msg.cmd];
  if (!fn) return write({ id: msg.id, ok: false, err: `unknown command ${msg.cmd}` });
  try {
    const result = await fn(msg.args || {});
    write({ id: msg.id, ok: true, result });
  } catch (e) {
    write({ id: msg.id, ok: false, err: reason(e) });
  }
});

/* Stdin closing means the app is gone. Stop mining and go, rather than leaving a
 * core spinning for an owner that no longer exists — an orphaned miner is
 * invisible on a laptop until the fan tells you. */
rl.on('close', () => {
  if (state.session) state.session.stop('the app closed');
  setTimeout(() => process.exit(0), 100).unref();
});

/* Nothing here writes to stderr on purpose, but a Node internal might, and stderr
 * is where a supervisor's logging looks. Reduce anything unexpected to a message
 * on the same channel as everything else. */
process.on('uncaughtException', e => { write({ event: 'error', data: { err: reason(e) } }); });
process.on('unhandledRejection', e => { write({ event: 'error', data: { err: reason(e) } }); });

emit('ready', { pid: process.pid, network: P.NETWORK, chainId: P.CHAIN_ID, coin: P.COIN, nodeSrc: NODE_SRC });
