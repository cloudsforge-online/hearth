'use strict';
/* Genesis for the account model — the one block nobody mines.
 *
 * A genesis block is a set of decisions frozen into a hash: the chain id, the gas
 * limit, who holds what before anybody has mined anything, and where the Commons
 * share goes. Two nodes that disagree about any of them have different genesis
 * hashes and simply never talk to each other, which is the failure this file is
 * built to make loud rather than subtle.
 *
 * THE FILE FORMAT IS `hearth-genesis/1`, which node/src/cli/devnet.js already
 * writes and documents as "a promise phase 5 keeps". This is that promise:
 *
 *   { format: 'hearth-genesis/1', chainId, decimals: 18, gasLimit,
 *     timestamp, extraData, alloc: { '0x…': { balance: '<decimal wei>' } } }
 *
 * plus two fields this module adds, because they are consensus and the CLI could
 * not have known them yet:
 *
 *   commonsAddress   where the 10% Commons share of every subsidy is paid
 *   target           the genesis difficulty target
 *
 * An older file without them loads with the defaults from params.js, so a devnet
 * directory created before phase 5 still works.
 *
 * WHY THE ALLOC IS HASHED RATHER THAN TRUSTED. The genesis state root is computed
 * from the alloc, and the genesis header commits to that root, so the block hash
 * changes if a single balance does. That is what makes "wipe the volume and
 * restart" produce a chain that cannot silently merge with the old one.
 */

const fs = require('fs');
const path = require('path');

const P = require('../params');
const HDR = require('./header');
const TX = require('./transaction');
const { StateDB, MemoryDB } = require('../state/statedb');
const { EMPTY_TRIE_ROOT } = require('../state/trie');
const bloom = require('./bloom');

const GENESIS_FORMAT = 'hearth-genesis/1';
const GENESIS_FILE = 'genesis.json';

/** The empty-trie root as a hex string, for the header's `txRoot`/`receiptsRoot`. */
const EMPTY_ROOT_HEX = EMPTY_TRIE_ROOT.toString('hex');

function normalizeAddress(a, what) {
  const b = HDR.hexToBuf(a, what, 20);
  return '0x' + b.toString('hex');
}

/**
 * The default chain configuration: no allocation at all.
 *
 * NO PREMINE, exactly as the UTXO chain has none (MAP.md §1). An empty alloc is a
 * deliberate statement and not an oversight — every EMBER on the account model is
 * mined, and a fixture that wants funded accounts passes them in.
 *
 * THE GENESIS EXTRADATA NAMES THE NETWORK, AND THAT IS LOAD-BEARING. The chain id
 * protects TRANSACTIONS from replay across networks (EIP-155), but an EMPTY BLOCK
 * contains no transactions and is therefore network-agnostic: with an identical
 * genesis, identical difficulty rules and no chain id in the header, a cheaply
 * mined empty block from the testnet is a structurally valid mainnet block. Only
 * the p2p handshake's `net` field would stand between them, and a peer that lies
 * about that costs nothing.
 *
 * Ethereum solves this the same way — no chain id in the header, divergent genesis
 * — so the fix is to make the genesis DIFFER, and the honest place to put the
 * difference is the field that exists for exactly this: `extraData`. Every block
 * on one network then descends from a hash no block on the other can reach.
 */
function defaultConfig() {
  return {
    format: GENESIS_FORMAT,
    chainId: TX.CHAIN_ID,
    decimals: 18,
    gasLimit: P.EVM_BLOCK_GAS_LIMIT,
    /* Fixed, not `now`: a genesis whose timestamp is the moment the node first
     * started gives every node a different genesis hash and therefore no peers.
     *
     * THIS IS A CONSENSUS CONSTANT AND IT IS NOT WHEN THE CHAIN STARTED. It is a
     * round number somebody picked (2025-06-15T15:06:40Z) so that every node
     * derives the same genesis hash. EMBER mainnet's block 1 was mined on
     * 2026-08-04T19:12:21Z, 415 days later, and nothing here moves when that
     * changes — a chain relaunched tomorrow would still carry this number.
     *
     * So anything computing chain age, uptime or a realised block time as
     * `tip.timestamp - genesis.timestamp` is wrong by that whole gap, and wrong in
     * the direction that looks plausible. Measured against mainnet on 2026-08-12
     * at height 16,457: the chain is 7.2 days old and that subtraction calls it
     * 422.4; the mean block time is 38 s and that subtraction calls it 2,218 s.
     * Neither reads as a bug. That is micro-org#396.
     *
     * The real start is `Blockchain#launchedAt()` — the timestamp of block 1, one
     * source — exposed over JSON-RPC as `hearth_chainStart` so that no consumer
     * has to infer it. `test/chain-start.js` fails if anything in this tree
     * subtracts a genesis timestamp to produce a duration. DO NOT change this
     * literal to make an age come out right. */
    timestamp: 1750000000,
    extraData: '0x' + Buffer.from(`${P.NETWORK}/${TX.CHAIN_ID}`, 'utf8').toString('hex'),
    target: P.GENESIS_TARGET,
    commonsAddress: P.EVM_COMMONS_ADDRESS,
    alloc: {},
  };
}

/**
 * Read, validate and complete a config. Everything that is consensus is either
 * present or defaulted here and nowhere else, so there is exactly one place a
 * network's parameters come from.
 */
function normalizeConfig(raw = {}) {
  const c = { ...defaultConfig(), ...raw };
  if (raw.format && raw.format !== GENESIS_FORMAT) {
    throw new Error(`genesis: unknown format "${raw.format}", expected ${GENESIS_FORMAT}`);
  }
  c.format = GENESIS_FORMAT;
  c.chainId = Number(c.chainId);
  if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0) throw new Error('genesis: chainId must be a positive integer');
  /* 18 is not configurable. It is the reason this chain exists in this shape at
   * all (spec §1), and a genesis claiming 8 would produce a chain every wallet
   * displays wrongly while looking entirely healthy. */
  if (Number(c.decimals) !== 18) throw new Error('genesis: decimals must be 18 (docs/evm-spec.md §1)');
  c.decimals = 18;
  c.gasLimit = Number(c.gasLimit);
  if (!Number.isSafeInteger(c.gasLimit) || c.gasLimit < 21000) throw new Error('genesis: gasLimit must be at least 21000');
  c.timestamp = Number(c.timestamp);
  if (!Number.isSafeInteger(c.timestamp) || c.timestamp < 0) throw new Error('genesis: timestamp must be a non-negative integer');
  if (c.timestamp >= HDR.MAX_TIMESTAMP) throw new Error('genesis: timestamp must be in SECONDS, not milliseconds');
  c.extraData = '0x' + HDR.hexToBuf(c.extraData || '0x', 'extraData').toString('hex');
  c.target = HDR.hexToBuf(c.target, 'target', 32).toString('hex');
  c.commonsAddress = normalizeAddress(c.commonsAddress, 'commonsAddress');

  const alloc = {};
  for (const [addr, entry] of Object.entries(c.alloc || {})) {
    const key = normalizeAddress(addr, 'alloc address');
    const e = entry || {};
    const balance = BigInt(e.balance === undefined || e.balance === null || e.balance === '' ? 0 : e.balance);
    if (balance < 0n) throw new Error('genesis: a balance cannot be negative');
    const out = { balance: balance.toString() };
    if (e.nonce !== undefined && e.nonce !== null) out.nonce = String(BigInt(e.nonce));
    if (e.code) out.code = '0x' + HDR.hexToBuf(e.code, 'alloc code').toString('hex');
    if (e.storage) {
      out.storage = {};
      for (const [slot, value] of Object.entries(e.storage)) {
        out.storage['0x' + HDR.hexToBuf(slot, 'alloc storage slot', 32).toString('hex')] =
          '0x' + HDR.hexToBuf(value, 'alloc storage value', 32).toString('hex');
      }
    }
    if (alloc[key]) throw new Error(`genesis: address ${key} is allocated twice`);
    alloc[key] = out;
  }
  c.alloc = alloc;
  return c;
}

/**
 * Write the allocation into a fresh state and return `{ state, db, stateRoot }`.
 * The StateDB is the live one the chain goes on to use, and the MemoryDB it is
 * built over is the store every later block's state is written into — which is
 * what makes an old state root still readable after a hundred blocks, and
 * therefore what makes a reorg cost nothing.
 */
function buildState(config, db = new MemoryDB()) {
  const state = new StateDB(db);
  for (const [addr, entry] of Object.entries(config.alloc)) {
    const a = Buffer.from(addr.slice(2), 'hex');
    state.setAccount(a, {
      nonce: BigInt(entry.nonce || 0),
      balance: BigInt(entry.balance || 0),
    });
    if (entry.code) state.setCode(a, Buffer.from(entry.code.slice(2), 'hex'));
    for (const [slot, value] of Object.entries(entry.storage || {})) {
      state.setStorage(a, Buffer.from(slot.slice(2), 'hex'), Buffer.from(value.slice(2), 'hex'));
    }
  }
  state.commit();
  return { state, db, stateRoot: state.root() };
}

/**
 * The genesis block: a header v2 with an empty transaction list, no proof and no
 * signature.
 *
 * It carries `nonce: 0` and a zero `mixHash` because nobody mined it. That zero
 * digest is also what `PREVRANDAO` reads in block 1, which is honest — there is
 * no randomness before the first proof of work and pretending otherwise would
 * hand a contract a value it could mistake for one.
 */
function genesisBlock(config, stateRoot) {
  const header = HDR.normalize({
    version: HDR.HEADER_VERSION,
    prevHash: HDR.ZERO_HASH,
    height: 0,
    timestamp: config.timestamp,
    target: config.target,
    /* 65 zero bytes: not a key, and provably not one anybody holds. The genesis
     * block pays no reward, so there is nothing for it to receive. */
    coinbasePub: Buffer.alloc(65),
    txRoot: EMPTY_ROOT_HEX,
    stateRoot,
    receiptsRoot: EMPTY_ROOT_HEX,
    logsBloom: bloom.empty(),
    gasLimit: config.gasLimit,
    gasUsed: 0,
    extraData: config.extraData,
    nonce: 0,
    mixHash: HDR.ZERO_HASH,
    powSig: '',
  });
  return { header, txs: [] };
}

/** Everything a chain needs to start: the config, the state and block 0. */
function build(rawConfig, db) {
  const config = normalizeConfig(rawConfig);
  const { state, stateRoot } = buildState(config, db);
  const block = genesisBlock(config, stateRoot);
  return { config, state, db: state.db, block, hash: HDR.hashHex(block.header) };
}

/**
 * Load `<dataDir>/genesis.json`, writing the defaults there if it is absent.
 *
 * Persisting it matters more than it looks: the alloc is consensus, so a node
 * that regenerated it from code each time would silently change chains the day
 * somebody edited a default. On disk it is a file a peer can be sent and diffed.
 */
function loadOrCreate(dataDir, overrides = null) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, GENESIS_FILE);
  if (fs.existsSync(file)) {
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeConfig(overrides ? { ...onDisk, ...overrides } : onDisk);
  }
  const config = normalizeConfig(overrides || {});
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return config;
}

module.exports = {
  GENESIS_FORMAT, GENESIS_FILE, EMPTY_ROOT_HEX,
  defaultConfig, normalizeConfig, buildState, genesisBlock, build, loadOrCreate,
};
