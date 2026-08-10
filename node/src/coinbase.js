'use strict';
/* The coinbase key, and how EMBER is written down.
 *
 * Lifted out of src/evmnode.js unchanged. It is here because `require`ing it
 * from there drags in the blockchain, the mempool, the EVM, the P2P stack and
 * two HTTP servers — fine for a node, absurd for a miner that holds no chain,
 * and worse for app-desktop, whose engine process must start in a blink and
 * whose attack surface should be as small as its job. evmnode.js re-exports
 * every name below, so nothing that already imported them had to change.
 */

const fs = require('fs');
const path = require('path');

const P = require('./params');
const secp = require('./crypto/secp256k1');
const TX = require('./chain/transaction');

const KEY_FILE = 'coinbase-key.json';

/* The encrypted alternative to KEY_FILE. Named here rather than imported from
 * src/mine/keystore.js because that module requires THIS one — `keyFrom` and
 * `newKey` — and a top-level require in both directions is a cycle. The
 * keystore module is loaded lazily inside `fromKeystore` below, which also
 * keeps its 256 MiB scrypt off the path of a node that never opens one. */
const KEYSTORE_FILE = 'coinbase-keystore.json';

/**
 * Where a coinbase key may come from, most protected first.
 *
 * `HEARTH_COINBASE_SOURCE` names exactly one of these and switches off both the
 * search and the create-on-miss below. See `resolveCoinbaseKey`.
 */
const SOURCES = ['env', 'env-file', 'keystore', 'plaintext'];

/** Wei as EMBER, to six places. `wei / 10n**18n` is INTEGER division and would
 *  print a 5.999-EMBER reward as "5", which reads as a broken emission schedule. */
function ember(wei) {
  const whole = wei / P.WEI_PER_EMBER;
  const frac = (wei % P.WEI_PER_EMBER).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

const hexBuf = h => Buffer.from(String(h).replace(/^0x/i, ''), 'hex');

/**
 * The node's coinbase key: secp256k1, because the coinbase must RECEIVE the reward
 * and the fees and therefore has to be an account this chain can credit (spec §4).
 * Kept in its own file rather than in `wallet.json`, whose keys are Ed25519 and
 * belong to the other chain — one file, one curve, no chance of a key being read
 * as the wrong kind.
 *
 * KEPT for every caller that only wants a key and does not care where it came
 * from — src/evmnode.js is the important one. `resolveCoinbaseKey` is the same
 * thing with the provenance attached, and it is what anything that reports to an
 * operator should call.
 */
function loadCoinbaseKey(dataDir, opts) {
  return resolveCoinbaseKey(dataDir, opts).key;
}

/* ---------------------------------------------------------------------------
 * WHERE THE MINING KEY COMES FROM.  cloudsforge-online/micro-org#206
 *
 * Until 2026-08-10 there was one answer: `<data>/coinbase-key.json`, the private
 * key in the clear at mode 600, created by this file on first run. For a server
 * that must come back up unattended after a reboot that is a defensible trade —
 * a passphrase the machine can read by itself is not a passphrase — and for a
 * long time it was the whole story.
 *
 * It stopped being defensible when a measurement was put against it. On
 * 2026-08-09 the mainnet coinbase `0x980d…5b45` held 47,421.445463215 EMBER and
 * was accruing ~5.4 EMBER per block at ~49 s a block, so ~400 EMBER an hour, all
 * of it spendable by whoever reads one 240-byte file. That file was also
 * bind-mounted READ-WRITE into the miner container, so container compromise was
 * sufficient — no host account, no escape — and a compromised miner could
 * overwrite the key as well as read it, which loses the balance rather than
 * merely stealing it.
 *
 * So the file is no longer the only answer. In precedence order:
 *
 *   env        HEARTH_COINBASE_KEY        — 0x-hex, supplied at container-create
 *                                           time. Never touches a disk.
 *   env-file   HEARTH_COINBASE_KEY_FILE   — a path: a docker secret, a tmpfs, a
 *                                           read-only mount. Takes either bare
 *                                           hex or the coinbase-key.json shape,
 *                                           so an existing file can be mounted
 *                                           read-only and used unchanged.
 *   keystore   <data>/coinbase-keystore.json + HEARTH_COINBASE_PASSPHRASE[_FILE]
 *                                         — scrypt N=2^18 + AES-256-GCM,
 *                                           src/mine/keystore.js. The file at
 *                                           rest is useless without the
 *                                           passphrase, which is what makes it
 *                                           safe to back up and safe to mount.
 *   plaintext  <data>/coinbase-key.json    — what there was. Still read, so that
 *                                           nothing that works today stops.
 *
 * NONE OF THIS MAKES THE RUNNING MINER'S KEY COLD, and pretending otherwise
 * would be the dangerous half-truth. A process that signs proofs holds a
 * spendable key in memory whatever the key was wrapped in at rest, because
 * src/chain/header.js `verifyPow` recovers the coinbase FROM the proof
 * signature — the key that mines is by construction the key that is paid. What
 * these sources buy is: the key is not readable from the medium it is stored
 * on, it is not readable from a backup of that medium, and a container that can
 * write to its data directory cannot destroy it. What ROTATION buys — mining to
 * a fresh key so the old balance stops living on the mining host at all — is the
 * other half, and `hearth minerkey new` is how it is done. docs/mining-key-custody.md.
 *
 * TWO REFUSALS, both of which exist because their failure is silent:
 *
 *   HEARTH_COINBASE_ADDRESS pins the address the resolved key must derive. Get
 *   it wrong and the process refuses to start, instead of mining perfectly
 *   happily into an account nobody has the key for. This is what makes a
 *   migration checkable without ever printing a key, and it is the only guard
 *   against the worst operational accident available here: a bind mount that
 *   does not come up, an empty data directory, and a brand-new key created and
 *   mined to for three days.
 *
 *   HEARTH_COINBASE_SOURCE, when set, is the ONLY source consulted, and
 *   creation is off. An operator who has moved to a keystore is saying so; if
 *   the keystore is missing they want a refusal, not a quiet fall back to the
 *   plaintext file they thought they had deleted.
 * ------------------------------------------------------------------------- */

/**
 * The code every refusal below carries.
 *
 * bin/hearthd.js and bin/hearth-mine.js turn a tagged refusal into one line and
 * exit 2; anything untagged keeps its stack, because that is a bug in this file
 * rather than a message for an operator. The same shape as
 * src/chain/blockchain.js `GENESIS_NETWORK_MISMATCH`, for the same reason: under
 * compose a bad start is a restart loop, and a stack trace buries the one line
 * that says what is wrong.
 */
const COINBASE_KEY_REFUSED = 'COINBASE_KEY_REFUSED';

function refuse(message) {
  const e = new Error(message);
  e.code = COINBASE_KEY_REFUSED;
  return e;
}

/**
 * Resolve the coinbase key and say where it came from.
 *
 * @param {string|null} dataDir  the data directory; the file sources live in it
 * @param {object} [o]
 * @param {object} [o.env]        environment to read (injected by tests)
 * @param {boolean} [o.create]    may a key be generated when nothing is found?
 *                                Defaults true, and is forced false whenever
 *                                HEARTH_COINBASE_SOURCE or HEARTH_COINBASE_ADDRESS
 *                                is set — both mean "I have a key already".
 * @returns {{key: object, source: string, file: string|null, created: boolean}}
 */
function resolveCoinbaseKey(dataDir, o = {}) {
  const env = o.env || process.env;
  const expected = expectedAddress(env);
  const pinned = pinnedSource(env);
  const create = o.create === undefined ? !(pinned || expected) : Boolean(o.create);

  const got = pinned
    ? fromSource(pinned, dataDir, env, { required: true })
    : firstOf(SOURCES, dataDir, env);

  if (got) return checked(got, expected);

  if (!create) {
    throw refuse(
      'no coinbase key found, and this process was told not to make one'
      + (pinned ? ` — HEARTH_COINBASE_SOURCE=${pinned} names the only source it may use` : '')
      + (expected ? ` — HEARTH_COINBASE_ADDRESS pins ${expected}, and a key generated now would not be it` : '')
      + '. Check that the data directory or the secret is actually mounted.');
  }

  /* Nothing configured, nothing on disk, and nobody said not to: this is a
   * first run of a developer's node, and it gets the historical behaviour —
   * a fresh key written in the clear at mode 600, so the next start finds it.
   * `hearth minerkey new` is the same thing into a keystore instead, and is
   * what anything holding real money should use. */
  if (!dataDir) return { key: newKey(), source: 'ephemeral', file: null, created: true };
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, KEY_FILE);
  const key = newKey();
  fs.writeFileSync(file, JSON.stringify({
    warning: 'this is a mining key with spendable balance — back it up, do not share it',
    address: key.addressHex,
    privateKey: '0x' + key.privateKey.toString('hex'),
  }, null, 2) + '\n', { mode: 0o600 });
  return { key, source: 'plaintext', file, created: true };
}

/** The first source that has anything, in the order SOURCES lists them. */
function firstOf(order, dataDir, env) {
  for (const name of order) {
    const got = fromSource(name, dataDir, env, { required: false });
    if (got) return got;
  }
  return null;
}

/**
 * One source. `required` is the difference between "not configured, try the
 * next" and "you named this one and it is not there", which must not be the
 * same answer: the second is how a miner falls back onto a plaintext file the
 * operator believes they have removed.
 */
function fromSource(name, dataDir, env, { required }) {
  switch (name) {
    case 'env': return fromEnv(env, required);
    case 'env-file': return fromEnvFile(env, required);
    case 'keystore': return fromKeystore(dataDir, env, required);
    case 'plaintext': return fromPlaintext(dataDir, required);
    default:
      throw refuse(`unknown coinbase key source "${name}" — one of ${SOURCES.join(', ')}`);
  }
}

function fromEnv(env, required) {
  const raw = env.HEARTH_COINBASE_KEY;
  if (raw === undefined || raw === '') {
    if (required) throw refuse('HEARTH_COINBASE_SOURCE=env, but HEARTH_COINBASE_KEY is not set');
    return null;
  }
  const key = keyFrom(privateFromHex(raw, 'HEARTH_COINBASE_KEY'));
  /* Take it out of the environment now that it is a Buffer we hold. This does
   * NOT undo the exposure — the original environment is still in /proc/<pid>/environ
   * for anything that can read it, and in whatever created the container — so it
   * is worth exactly one thing and no more: a child process spawned later does
   * not inherit the key. Say that plainly rather than let the line read as a fix. */
  delete env.HEARTH_COINBASE_KEY;
  return { key, source: 'env', file: null, created: false };
}

function fromEnvFile(env, required) {
  const file = env.HEARTH_COINBASE_KEY_FILE;
  if (!file) {
    if (required) throw refuse('HEARTH_COINBASE_SOURCE=env-file, but HEARTH_COINBASE_KEY_FILE is not set');
    return null;
  }
  /* Set but absent is ALWAYS an error, whether or not this source was the one
   * named — the same rule as a keystore with no passphrase, for the same
   * reason. An operator who has pointed at /run/secrets/coinbase-key and finds
   * the mount missing wants a refusal; the alternative is a silent fall back
   * onto whatever is still lying in the data directory. */
  if (!fs.existsSync(file)) throw refuse(`HEARTH_COINBASE_KEY_FILE points at ${file}, which does not exist`);
  return { key: keyFrom(privateFromFileBody(fs.readFileSync(file, 'utf8'), file)), source: 'env-file', file, created: false };
}

function fromKeystore(dataDir, env, required) {
  if (!dataDir) {
    if (required) throw refuse('HEARTH_COINBASE_SOURCE=keystore, but this process has no data directory to find one in');
    return null;
  }
  const file = path.join(dataDir, KEYSTORE_FILE);
  if (!fs.existsSync(file)) {
    if (required) throw refuse(`HEARTH_COINBASE_SOURCE=keystore, but there is no keystore at ${file}`);
    return null;
  }
  const passphrase = passphraseFrom(env);
  if (passphrase === null) {
    /* A keystore with no way to open it is ALWAYS an error, even when this
     * source was not the one named. Falling through to the plaintext file here
     * would mine on the key the operator is in the middle of retiring, and the
     * only symptom would be that nothing looked wrong. */
    throw refuse(
      `there is an encrypted coinbase keystore at ${file} and no passphrase to open it — `
      + 'set HEARTH_COINBASE_PASSPHRASE_FILE to a path holding it, or HEARTH_COINBASE_PASSPHRASE');
  }
  const KS = require('./mine/keystore');            // lazy: see KEYSTORE_FILE
  return { key: KS.open(dataDir, passphrase), source: 'keystore', file, created: false };
}

function fromPlaintext(dataDir, required) {
  if (!dataDir) {
    if (required) throw refuse('HEARTH_COINBASE_SOURCE=plaintext, but this process has no data directory');
    return null;
  }
  const file = path.join(dataDir, KEY_FILE);
  if (!fs.existsSync(file)) {
    if (required) throw refuse(`HEARTH_COINBASE_SOURCE=plaintext, but there is no key at ${file}`);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw.privateKey !== 'string') throw refuse(`${file} does not look like a coinbase-key.json`);
  return { key: keyFrom(privateFromHex(raw.privateKey, file)), source: 'plaintext', file, created: false };
}

/**
 * The passphrase, from a FILE first.
 *
 * A path is better than a value for the same reason a docker secret is better
 * than an environment variable: `docker inspect`, a crash reporter and every
 * child process see the environment, and none of them see the contents of
 * /run/secrets. Both are supported because not every deployment has a secrets
 * mount, and an unopenable keystore helps nobody.
 */
function passphraseFrom(env) {
  const file = env.HEARTH_COINBASE_PASSPHRASE_FILE;
  if (file) {
    if (!fs.existsSync(file)) throw refuse(`HEARTH_COINBASE_PASSPHRASE_FILE points at ${file}, which does not exist`);
    // A trailing newline is what every editor and `printf … >` leaves behind and
    // is never part of a passphrase anyone meant to type.
    const body = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    if (body.length === 0) throw refuse(`${file} is empty, so it holds no passphrase`);
    return body;
  }
  const value = env.HEARTH_COINBASE_PASSPHRASE;
  if (value !== undefined && value !== '') return value;
  return null;
}

/** `HEARTH_COINBASE_ADDRESS`, validated as an address before it is trusted as one. */
function expectedAddress(env) {
  const raw = env.HEARTH_COINBASE_ADDRESS;
  if (raw === undefined || raw === '') return null;
  const a = String(raw).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    throw refuse(`HEARTH_COINBASE_ADDRESS is not an address: it must be 0x followed by 40 hex characters`);
  }
  return a;
}

function pinnedSource(env) {
  const raw = env.HEARTH_COINBASE_SOURCE;
  if (raw === undefined || raw === '') return null;
  const name = String(raw).trim();
  if (!SOURCES.includes(name)) {
    throw refuse(`HEARTH_COINBASE_SOURCE=${name} is not a source — one of ${SOURCES.join(', ')}`);
  }
  return name;
}

/**
 * The pin, enforced. Both addresses are public facts and are named in the
 * message on purpose: an operator staring at a restart loop needs to see which
 * two disagree, and neither of them is a secret.
 */
function checked(got, expected) {
  if (expected && got.key.addressHex.toLowerCase() !== expected) {
    throw refuse(
      `the coinbase key from ${got.source}${got.file ? ` (${got.file})` : ''} derives ${got.key.addressHex}, `
      + `but HEARTH_COINBASE_ADDRESS pins ${expected}. Refusing to mine to an address that was not asked for.`);
  }
  return got;
}

/** 32 bytes of hex, or a message naming WHERE the bad value came from, never what it was. */
function privateFromHex(v, whence) {
  const hex = String(v).trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw refuse(`the private key in ${whence} is not 32 bytes of hex — 64 hex characters, optionally 0x-prefixed`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * A key file's body, in either shape it is found in.
 *
 * Bare hex is what `openssl`, a secrets manager and a here-string produce. The
 * `{ address, privateKey, warning }` JSON is what this file has always written,
 * and taking it means the existing plaintext key can be re-mounted READ-ONLY at
 * a path nothing else can reach, unchanged, as a first step that costs nothing.
 */
function privateFromFileBody(body, whence) {
  const text = String(body).trim();
  if (text.startsWith('{')) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw.privateKey !== 'string') throw refuse(`${whence} is JSON but has no privateKey`);
    return privateFromHex(raw.privateKey, whence);
  }
  return privateFromHex(text, whence);
}

function keyFrom(priv) {
  const publicKey = secp.publicKeyFromPrivate(priv, false);   // uncompressed; see header.js
  const address = TX.addressFromPublicKey(publicKey);
  return { privateKey: priv, publicKey, address, addressHex: '0x' + address.toString('hex') };
}

function newKey() { return keyFrom(secp.randomPrivateKey()); }

/**
 * What each source would contribute, WITHOUT opening anything.
 *
 * For `hearth minerkey status` and for a startup line: it answers "which of
 * these is configured and present" using only `existsSync` and the presence of
 * environment variables, so it costs nothing, needs no passphrase, and cannot
 * leak a key because it never reads one. The VALUE of a variable is never part
 * of the result — only whether it is set.
 */
function describeSources(dataDir, env = process.env) {
  const keystoreFile = dataDir ? path.join(dataDir, KEYSTORE_FILE) : null;
  const plaintextFile = dataDir ? path.join(dataDir, KEY_FILE) : null;
  return {
    pinnedSource: pinnedSource(env),
    expectedAddress: expectedAddress(env),
    sources: [
      { name: 'env', configured: Boolean(env.HEARTH_COINBASE_KEY), present: Boolean(env.HEARTH_COINBASE_KEY), file: null },
      {
        name: 'env-file',
        configured: Boolean(env.HEARTH_COINBASE_KEY_FILE),
        present: Boolean(env.HEARTH_COINBASE_KEY_FILE) && fs.existsSync(env.HEARTH_COINBASE_KEY_FILE),
        file: env.HEARTH_COINBASE_KEY_FILE || null,
      },
      {
        name: 'keystore',
        configured: Boolean(keystoreFile) && fs.existsSync(keystoreFile),
        present: Boolean(keystoreFile) && fs.existsSync(keystoreFile),
        file: keystoreFile,
        passphrase: env.HEARTH_COINBASE_PASSPHRASE_FILE ? 'file' : (env.HEARTH_COINBASE_PASSPHRASE ? 'env' : null),
      },
      {
        name: 'plaintext',
        configured: Boolean(plaintextFile) && fs.existsSync(plaintextFile),
        present: Boolean(plaintextFile) && fs.existsSync(plaintextFile),
        file: plaintextFile,
      },
    ],
  };
}

module.exports = {
  KEY_FILE, KEYSTORE_FILE, SOURCES, COINBASE_KEY_REFUSED,
  ember, hexBuf, loadCoinbaseKey, resolveCoinbaseKey, describeSources, keyFrom, newKey,
};
