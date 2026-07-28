'use strict';
/* Hearth consensus parameters — the single source of truth for the node.
 * These mirror docs/coinnomics.md. Values marked (dev) are tuned so a single
 * laptop produces a lively local chain; production values are noted alongside. */

const SPARKS_PER_EMBER = 100_000_000;          // 1e8, smallest unit = "spark"

const NETWORK = process.env.HEARTH_NETWORK || 'hearth';

/* A test network mines cheaply (see POW_SCRATCH_KIB). Matched by suffix, so
 * `hearth-test` and `hearth-test-evm` qualify while `hearth` and
 * `hearth-testnet` — the real ones — deliberately do not. Note `hearth-testnet`
 * ends in "testnet", not "-test": exactly the near-miss worth being explicit
 * about, since getting it wrong would make a real network trivial to mine. */
const IS_TEST_NETWORK = NETWORK === 'hearth-test' || NETWORK.startsWith('hearth-test-');

/* EIP-155 CHAIN IDS, PER NETWORK — and the separation is mandatory, not tidy.
 *
 * The retired UTXO scheme put a `net` field INSIDE the signed transaction body
 * (`tx.js` `txBody`), so a testnet signature was structurally invalid on mainnet:
 * different bytes, different txid, no replay. EIP-155 replaces that protection
 * with exactly one number. If both networks declare 7411 then every testnet
 * transaction is replayable on mainnet and back — same key, same nonce, the same
 * bytes valid on both — and a faucet becomes a way to drain the account it funds.
 *
 * So the id follows the network the node is running as, the way every other
 * parameter here does. An unknown network is a hard error rather than a default:
 * a node that GUESSES its chain id signs transactions that are valid somewhere it
 * did not intend, and ForgeKeyvault resolves the expected id when it signs, so a
 * mismatch surfaces as `403 binding_mismatch` with no obvious cause. Set
 * HEARTH_CHAIN_ID explicitly for a private network.
 *
 * These go into ethereum-lists/chains alongside the RPC URL and are fixed at
 * publication. docs/evm-spec.md §1.
 */
const CHAIN_IDS = Object.freeze({
  hearth: 7411,
  'hearth-testnet': 7412,
  // The in-process test chain. Its own id for the same reason testnet has one:
  // it mines with a different PoW cost and a different genesis, so nothing
  // signed against it may be valid anywhere real. Registered here rather than
  // left to HEARTH_CHAIN_ID so suites need no environment beyond the name.
  'hearth-test': 7413,
});

function resolveChainId(network) {
  if (process.env.HEARTH_CHAIN_ID) {
    const n = Number(process.env.HEARTH_CHAIN_ID);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('params: HEARTH_CHAIN_ID must be a positive integer');
    return n;
  }
  const id = CHAIN_IDS[network];
  if (id === undefined) {
    throw new Error(
      `params: no chain id is registered for network "${network}". `
      + `Known: ${Object.keys(CHAIN_IDS).join(', ')}. `
      + 'Set HEARTH_CHAIN_ID for a private network — a node must never guess, '
      + 'or its signatures are replayable somewhere it did not intend.');
  }
  return id;
}

module.exports = {
  NETWORK,
  COIN: 'EMBER',
  SPARKS_PER_EMBER,
  CHAIN_IDS,
  /** The EIP-155 chain id for THIS node's network. Nothing else may hardcode it. */
  CHAIN_ID: resolveChainId(NETWORK),

  // ---- timing ----
  TARGET_BLOCK_TIME: 15,                        // seconds (production & dev)
  BLOCKS_PER_YEAR: Math.round((365.25 * 24 * 3600) / 15), // ~2,103,840
  LWMA_WINDOW: 60,                              // blocks used to retarget difficulty

  // ---- emission (see docs/coinnomics.md) ----
  R0_EMBER: 6,                                  // genesis block reward
  REWARD_HALFLIFE_YEARS: 2,
  TAIL_EMBER: 0.3,                              // perpetual tail reward
  COMMONS_SHARE: 0.10,                          // 10% of subsidy -> Commons treasury

  // ---- fees ----
  BASE_FEE_SPARKS: 40_000,                      // 0.0004 EMBER, BURNED, per tx
  //                                               excess over base fee = miner tip
  // Data is priced by the byte and BURNED like the base fee, not tipped to the
  // miner. A miner who is paid for data has an incentive to fill blocks with it.
  FEE_PER_RECORD_BYTE_SPARKS: 100,              // 0.000001 EMBER per byte of record data

  // ---- application records (see docs/records.md) ----
  // Records are the only consensus-committed place to put application bytes:
  // they are inside the signed tx body, so they are covered by the txid, the
  // input signatures, the merkle root and the block hash. Everything about them
  // is bounded, because unbounded data on a chain with a flat fee is a DoS.
  //
  // Enabling records is a HARD FORK: a pre-records node rebuilds the tx body
  // without them, computes a different txid, and rejects the block. Nodes must
  // agree on this height before it passes.
  RECORDS_ACTIVATION_HEIGHT: 0,
  MAX_TX_RECORDS: 16,                       // records per transaction
  MAX_RECORD_BYTES: 4_096,                  // payload bytes in one record
  MAX_TX_RECORD_BYTES: 8_192,               // payload bytes across one tx
  MAX_RECORD_KEY_LEN: 72,                   // index key, e.g. an ember1… address
  // A namespace so two applications cannot read each other's records by accident.
  APP_NS_RE: /^[a-z][a-z0-9-]{1,15}$/,
  RECORD_KEY_RE: /^[0-9a-z._-]{1,72}$/,

  // ---- Proof of work (Homefire) ----
  // dev sizes keep local mining snappy; production ≈ 2 GiB / thousands of steps.
  // On a test network the PAD and the WALK shrink — this is the lever that
  // actually makes tests fast, and the obvious alternative does not work.
  //
  // Making the difficulty TARGET easier buys nothing: LWMA drives blocks toward
  // TARGET_BLOCK_TIME whatever it starts at, so after a few blocks the work per
  // block is the same. Freezing the target instead (MIN=GENESIS=MAX) is worse —
  // it makes any test that exercises retargeting spin forever. Both were tried
  // and measured.
  //
  // What costs the time is one ATTEMPT: Homefire fills a 64 KiB pad with chained
  // SHA-256 and then walks it 256 times, and at ~1-in-256 that is roughly 2.2M
  // hashes per block. Shrinking the pad and the walk makes each attempt cheap
  // while leaving difficulty, retargeting and every consensus rule untouched.
  //
  // It does change the PoW function, so a test chain's digests are its own —
  // which is correct, and consistent with it having its own chain id and genesis.
  POW_SCRATCH_KIB: IS_TEST_NETWORK ? 1 : 64,    // (dev)  production: ~2,097,152 (2 GiB)
  POW_WALK_STEPS: IS_TEST_NETWORK ? 8 : 256,    // (dev)  production: ~2048+
  // genesis difficulty target (32-byte big-endian threshold, as hex).
  // Easy on purpose so the first blocks come in ~seconds on one machine.
  // ~8 leading zero bits ⇒ ≈1/256 chance/hash ⇒ a block every ~1–2s at dev hashrate
  GENESIS_TARGET: '00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  // The hardest target the retarget is allowed to reach, i.e. the difficulty
  // CEILING. This used to be ~2^-20, which capped a block at ~1.1M attempts.
  // At a couple of hundred hashes per second per core that is roughly 300–500
  // cores of total network hashrate — past that, _nextTarget (chain.js) clamps,
  // blocks come in faster than the 15s target, and emission permanently
  // accelerates because the schedule is indexed by height, not by time. For a
  // coin whose whole thesis is that ordinary people mine it, a ceiling that
  // binds at a few hundred CPUs is the launch blocker.
  //
  // 2^-64 instead: ~1.8e19 attempts per block, ~1.2e18 H/s sustained. Every CPU
  // on Earth is on the order of 1e13 H/s, so this is five orders of magnitude of
  // headroom and the clamp is what it should be — an arithmetic backstop against
  // a runaway retarget, not a cap on how big the network may get.
  //
  // CONSEQUENCE, PLAINLY: this is a hard consensus break and it discards every
  // existing chain. `_validate` recomputes the expected target for each block
  // (`hdr.target !== this._nextTarget(parent.id)`), and disk replay runs the same
  // validation — so a data directory containing any block whose target was
  // clamped at the old ceiling will now fail to load, and two nodes on either
  // side of this change will reject each other's blocks with 'wrong difficulty
  // target'. There is no migration and none is wanted: nothing but throwaway
  // testnets has ever run. Wipe the volumes (`docker compose down -v`) and mine
  // a fresh genesis. Doing this before launch is free; doing it after is a fork.
  MIN_TARGET: '0000000000000000ffffffffffffffffffffffffffffffffffffffffffffffff',
  // The EASIEST target the retarget may reach — the difficulty FLOOR.
  //
  // It must never be easier than GENESIS_TARGET, and it used to be: at
  // 03ffff… it was four times easier than the 00ffff… the chain launches at.
  // That is not a slack constant, it is a free branch. Simulating the LWMA
  // recurrence, a miner feeding its own side branch closely-spaced timestamps
  // walks the target to this clamp within three blocks and then pins there at
  // 1-in-64 — about 0.44 s of work per block — while every block it produces is
  // valid, is stored, is persisted, is relayed, and refunds its verification
  // token because `_acceptFrom` counts it as useful work. Meanwhile the honest
  // side pays O(L²) to `_stateAt` for a branch that cost O(L) to make.
  //
  // Pinning the floor at GENESIS_TARGET means difficulty can never fall below
  // what the chain launched at, so the cheapest block anyone can ever make is a
  // genesis-difficulty block. The invariant is asserted below rather than left
  // to a reader to notice, because the two constants are eight lines apart and
  // a future retune of one is exactly how this came about.
  MAX_TARGET: '00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',

  // ---- safety limits (consensus + DoS) ----
  MAX_MONEY: 90_000_000 * SPARKS_PER_EMBER, // sane per-output ceiling
  MAX_BLOCK_TXS: 5_000,                     // reject oversized blocks before doing work
  MAX_TX_INPUTS: 1_000,
  MAX_TX_OUTPUTS: 1_000,
  // Byte ceilings. There were none: a tx was bounded only by input/output COUNT,
  // so a block could be arbitrarily large in bytes and still pass. That was
  // survivable while an output was two fixed fields; it is not once a tx can
  // carry a payload. MAX_BLOCK_BYTES is well under P2P_MAX_LINE so a full block
  // still fits one frame.
  MAX_TX_BYTES: 100_000,
  MAX_BLOCK_BYTES: 2_000_000,
  COINBASE_MATURITY: 10,                    // (dev) coinbase unspendable until N deep; prod ~100
  MAX_FUTURE_DRIFT_S: 7200,                 // reject timestamps >2h in the future (Bitcoin-like)
  MEDIAN_TIME_SPAN: 11,                     // median-time-past window
  P2P_MAX_LINE: 4 * 1024 * 1024,            // drop peers that send >4MiB without a newline
  P2P_MAX_PEERS: 64,
  P2P_MAX_LOCATOR: 32,                      // hashes a peer may put in a getblocks locator
  P2P_MAX_BLOCKS: 200,                      // blocks served per getblocks round trip
  P2P_MAX_ORPHANS: 32,                      // parentless blocks held while ancestors arrive (× P2P_MAX_LINE = memory bound)
  P2P_RESYNC_MS: 20_000,                    // pull from every peer this often (converges equal-height forks)
  // Verifying one proof costs a full Homefire evaluation — the same ~8,450
  // sequential SHA-256 rounds a miner pays per attempt, so ~5ms of a core here.
  // A peer may put P2P_MAX_BLOCKS of them in a single frame and pipeline frames
  // as fast as the wire allows, which is a free remote DoS: one socket can pin
  // a core with garbage that fails on the very check it paid for.
  //
  // Two limits, because they answer different attacks, and both meter WASTED
  // verification only — p2p.js refunds the token whenever a block turns out to
  // be useful or to have cost no hashing at all. That matters: initial sync is
  // the one time an honest peer legitimately pushes thousands of blocks at us as
  // fast as the wire allows, and a flat rate cap would turn a long chain into an
  // hours-long sync while stopping nothing an attacker cares about.
  //
  // The token bucket bounds the STEADY rate of junk an anonymous peer can make
  // us hash; the burst is one full getblocks page. The invalid-block budget
  // bounds the TOTAL before disconnection — 16 × ~5ms is the entire wasted-CPU
  // budget of a hostile connection, after which it is gone.
  P2P_BLOCK_VERIFY_BURST: 200,              // wasted proofs a peer may buy back-to-back
  P2P_BLOCK_VERIFY_PER_S: 25,               // …then this many per second, sustained
  P2P_MAX_INVALID_BLOCKS: 16,               // invalid blocks before the peer is dropped
  // The same metering for TRANSACTIONS, which had none at all: `tx` messages were
  // gated on `typeof tx.id === 'string'` and nothing else. Validating one costs a
  // signature verification per input, the p2p read loop drains every newline in a
  // frame in ONE synchronous event, and a 4 MiB frame holds ~107,000 of them — so
  // an anonymous peer could hold the event loop for as long as it liked.
  //
  // Metered the same way blocks are, and for the same reason: the token is REFUNDED
  // when a transaction turns out to be useful (accepted) or free (already known),
  // so honest relay never touches the limiter and only junk is charged. 200/s
  // sustained is far above any real relay rate and far below what hurts.
  P2P_TX_VERIFY_BURST: 1_000,               // wasted validations a peer may buy back-to-back
  P2P_TX_VERIFY_PER_S: 200,                 // …then this many per second, sustained
  P2P_MAX_INVALID_TXS: 128,                 // invalid txs before the peer is dropped
  // A getblocks page is bounded by COUNT and now also by BYTES. It was only
  // bounded by count, and the two limits contradicted each other: 200 blocks
  // averaging over 20.5 KB is a frame larger than the receiver's own
  // P2P_MAX_LINE, so the receiver drops the sender for an oversized frame and
  // then asks again — an honest chain that reaches that average size can never
  // finish syncing, and nothing in the logs says why. 3 MiB leaves a megabyte of
  // headroom under P2P_MAX_LINE for the envelope and for a partially-buffered
  // next frame; one block may still be MAX_BLOCK_BYTES, so a page always carries
  // at least one whatever its size.
  P2P_MAX_FRAME_BYTES: 3 * 1024 * 1024,
  MEMPOOL_MAX_TXS: 50_000,                  // cap pending txs (DoS)

  // ---- special addresses ----
  COMMONS_ADDRESS: 'ember1commons00000000000000000000000000cmns',

  // ---- ports ----
  DEFAULT_RPC_PORT: 8645,                       // HTTP REST + legacy JSON-RPC + SSE
  DEFAULT_P2P_PORT: 8646,                       // TCP peer gossip

  /* THE ETHEREUM JSON-RPC ENDPOINT — settled (docs/evm-spec.md §6).
   *
   *   port 8545, path `/`.
   *
   * 8545 is the port the ecosystem already defaults to: MetaMask's localhost
   * default, and what every Hardhat and Foundry tutorial assumes, so a
   * developer's first guess is correct. The REST API stays on 8645 exactly as
   * it is, because `rpc.js:152` answers `POST /rpc` with the legacy
   * `{method:'getinfo'}` shape and mounting eth_* alongside it would hand a
   * client a 200 that is not JSON-RPC 2.0 — which reads as an empty chain
   * rather than as a misconfiguration. Two ports, two protocols, no ambiguity.
   *
   * This is published in `ethereum-lists/chains` and cached by MetaMask in
   * every user's saved networks, so it cannot be changed afterwards without
   * stranding all of them at once.
   *
   * 8546 IS RESERVED and must not be taken: it is the paired convention for the
   * WebSocket endpoint (`eth_subscribe`), which is v2. */
  DEFAULT_JSONRPC_PORT: 8545,
  RESERVED_WS_PORT: 8546,

  // ==========================================================================
  // THE ACCOUNT MODEL (docs/evm-spec.md). Everything above this line belongs to
  // the UTXO chain and is untouched, because both have to run side by side
  // until the ecosystem — browser wallet, browser miner, Forge Pay — is ported.
  // ==========================================================================

  /* 18 DECIMALS, AND WHY THE EMISSION NUMBERS DO NOT MOVE.
   *
   * Every EVM tool assumes 18 decimals for a native asset (spec §1), so the
   * account model's smallest unit is a wei, not a spark. `SPARKS_PER_EMBER`
   * above stays 1e8 because it is the UTXO chain's consensus and changing it
   * would rewrite that chain's history; the account model simply uses a
   * different unit for the same coin.
   *
   * The conversion is exact — 1 spark = 1e10 wei — so `subsidyWei` is
   * `subsidy` scaled, not re-derived. THE EMISSION CURVE IS UNCHANGED: every
   * figure in docs/tokenomics.md that is denominated in EMBER (6 at genesis,
   * the 2-year half-life, the 0.3 tail, the 10% Commons share, the ~90M cap)
   * is still exactly right. What moves is only the smallest-unit column: a
   * figure quoted in *sparks* describes the UTXO chain, and its account-model
   * equivalent is that number times 1e10. Nothing in that document has to
   * change except the unit name where it appears.
   */
  WEI_PER_EMBER: 10n ** 18n,
  WEI_PER_SPARK: 10n ** 10n,

  /** Spec §1. Fixed in v1; the header carries it so a later fork can move it. */
  EVM_BLOCK_GAS_LIMIT: 30_000_000,

  /* The Commons sink on the account model. `COMMONS_ADDRESS` above is a bech32
   * string that has no meaning here, and docs/tokenomics.md:253-254 records
   * that a 0x address HAS NOT BEEN CHOSEN. That is a governance decision, not
   * one a node can make, so the default is the zero address — universally
   * rendered as a burn — and the 10% is destroyed rather than paid to a key
   * somebody invented. It is consensus: it lives in genesis.json as
   * `commonsAddress` and every node on a network must agree on it. Set it
   * before a network that matters is launched; changing it afterwards forks. */
  EVM_COMMONS_ADDRESS: process.env.HEARTH_COMMONS_ADDRESS || '0x0000000000000000000000000000000000000000',

  /* Mempool POLICY, not consensus: a block containing a cheaper transaction is
   * perfectly valid and this node will accept it from a peer. It is the price
   * below which this node will not relay or mine one. 1 gwei matches what
   * tools/hardhat/hardhat.config.js pins and what eth_gasPrice suggests. */
  EVM_MIN_GAS_PRICE: 1_000_000_000n,

  /** Pending transactions one sender may occupy, so one funded key cannot fill
   *  the pool with a nonce ladder nobody will ever mine. */
  EVM_MEMPOOL_PER_SENDER: 64,

  /** How far above an account's current nonce a pending transaction may sit. */
  EVM_MEMPOOL_NONCE_GAP: 256,

  /** Replacement rule: a same-nonce transaction must beat the pooled one by
   *  this many percent, or a free re-broadcast loop evicts it forever. */
  EVM_REPLACE_BUMP_PERCENT: 10,

  /** Subsidy in WEI at a given height — the identical schedule, scaled. */
  subsidyWei(height) {
    return BigInt(this.subsidy(height)) * this.WEI_PER_SPARK;
  },

  // Subsidy in sparks at a given height.
  //
  // (See the invariant assertion at the foot of this file.)
  //
  // DETERMINISTIC integer schedule (no floating point in consensus): the reward
  // halves every half-life epoch, interpolated *linearly* within the epoch so the
  // curve is continuous (no cliff) and reproducible bit-for-bit on any engine.
  // All intermediates stay < 2^53, so JS Number is exact; the Rust core computes
  // the identical value with u64/u128. See docs/coinnomics.md.
  subsidy(height) {
    const HL = Math.round(this.REWARD_HALFLIFE_YEARS * this.BLOCKS_PER_YEAR); // integer blocks
    const R0 = this.R0_EMBER * SPARKS_PER_EMBER;      // 600,000,000 sparks
    const TAIL = Math.round(this.TAIL_EMBER * SPARKS_PER_EMBER);
    const epoch = Math.floor(height / HL);
    if (epoch >= 30) return TAIL;                     // base has decayed below tail
    const base = Math.floor(R0 / Math.pow(2, epoch)); // 2^int is exact in a double
    const next = Math.floor(base / 2);
    const within = height - epoch * HL;               // 0..HL-1
    const reward = base - Math.floor(((base - next) * within) / HL);
    return Math.max(TAIL, reward);
  },
};

/* The three targets are a single ordered relationship, and each of them is one
 * hex literal that a retune could edit in isolation. Hardest ≤ launch ≤ easiest,
 * asserted at load: a node with an inconsistent difficulty ladder should refuse
 * to start rather than mine a chain nobody else will accept.
 */
{
  const n = (h) => BigInt('0x' + h);
  const m = module.exports;
  if (!(n(m.MIN_TARGET) <= n(m.GENESIS_TARGET) && n(m.GENESIS_TARGET) <= n(m.MAX_TARGET))) {
    throw new Error('params: difficulty ladder is inconsistent — require MIN_TARGET <= GENESIS_TARGET <= MAX_TARGET');
  }
}
