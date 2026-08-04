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

/**
 * A positive-integer operator knob from the environment.
 *
 * Refuses zero, a negative and anything unparseable rather than falling back to
 * the default: these bound what a stranger can make this node do, and a typo in
 * a compose file that silently restores the unbounded behaviour is precisely the
 * accident they exist to prevent. Absent is not a typo, and takes the default.
 */
function rpcBudget(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`params: ${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
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
  // These sizes keep local mining snappy, and — see the long note below — they
  // are also the sizes mainnet launches with, because the "production" ones this
  // comment used to promise were measured and cannot be verified in time.
  // On a test network the PAD and the WALK shrink further — this is the lever
  // that
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
  //
  // THE "PRODUCTION" SIZES THIS COMMENT USED TO NAME ARE NOT REACHABLE, and
  // that is a measured statement now rather than an opinion. It said
  // "production: ~2,097,152 (2 GiB) / ~2048+ steps", six other documents
  // repeated it, and listing-checklist M1 called it raising two constants
  // before launch. `test/pow-params.js` evaluated the function at increasing
  // pad sizes and found what the construction implies: Homefire's cost is
  // O(pad) with nothing amortised between attempts — every attempt fills the
  // whole pad with chained SHA-256 — so a 2 GiB pad costs ~32,768x a 64 KiB
  // one, which on the machine that measured it is minutes per evaluation
  // against a 15 s block interval. A validator pays one full evaluation per
  // block received. The numbers are in docs/pow-parameters.md.
  //
  // So the memory-hardness argument cannot be strengthened by editing these
  // two numbers. It needs an epoch-cached or otherwise amortised dataset —
  // Ethash's shape, where the expensive part is paid once per epoch and an
  // attempt is O(1) against it — which is a redesign of this file's PoW and of
  // rust/hearthd/src/pow.rs, not a retune. (A third implementation,
  // web/assets/mining/homefire.js, was deleted in 48bc28a.)
  POW_SCRATCH_KIB: IS_TEST_NETWORK ? 1 : 64,    // (dev)  and see POW_MAX_SCRATCH_KIB
  POW_WALK_STEPS: IS_TEST_NETWORK ? 8 : 256,    // (dev)  the walk IS raisable — it is the cheap half
  // The ceiling this file refuses to start above, and the reason it exists is a
  // specific foreseeable mistake: somebody reads listing-checklist M1 the day
  // before a mainnet genesis, edits POW_SCRATCH_KIB to 2,097,152, runs the test
  // suite — which passes, because every suite mines on `hearth-test` where the
  // pad is 1 KiB — and cuts a genesis for a chain whose blocks nobody can
  // validate inside a block interval. Nothing anywhere would have said no.
  //
  // 4,096 KiB (4 MiB) is 64x the current pad and about 40 ms of evaluation on
  // the machine in docs/pow-parameters.md — still under 1% of the 15 s interval
  // once a validator's other per-block work is counted, and comfortably above
  // any value anyone has a reason to set deliberately. It is a backstop against
  // a documented plan being executed literally, not a tuning recommendation:
  // raising the pad within this ceiling buys very little hardness, and raising
  // it past the ceiling buys an unvalidatable chain.
  POW_MAX_SCRATCH_KIB: 4_096,
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
  // UTXO-ERA ONLY, and worth saying because a checklist item asks for it to be
  // raised to ~100 before mainnet. On the account model — the chain actually
  // being launched — there is no maturity at all: `_creditReward`
  // (chain/blockchain.js) adds the subsidy straight to the balance, spendable in
  // the next block. This constant is read by tx.js, wallet.js, rpc.js and
  // chain.js, all of which belong to the retired UTXO path, so raising it
  // changes nothing about the launch chain. Whether the account model SHOULD
  // have a maturity rule is a real and open question; it is not this constant.
  COINBASE_MATURITY: 10,                    // coinbase unspendable until N deep (UTXO path only)
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

  /* P2P OVER WEBSOCKET — the transport that can actually be published.
   *
   * CloudsForge runs on a home server behind a Cloudflare Tunnel and the
   * operator has no static IP, so every inbound connection arrives through the
   * tunnel or not at all. A tunnel carries HTTP and WebSocket and CANNOT carry
   * raw TCP, which makes gossip on 8646 the one service that cannot be exposed —
   * and gossip is the whole of mining, because a mined block reaches the network
   * only through `p2p.broadcast` (src/node.js `onMinedBlock`, src/evmnode.js).
   *
   * 8648, because 8645/8646/8647/8649 are taken by the REST and p2p ports of the
   * three testnet containers (docker-compose.testnet.yml) and 8546 is reserved
   * for the v2 eth_subscribe endpoint above. The path is fixed too: the
   * Cloudflare ingress and the Traefik router for `p2p.<apex>` are wired to
   * exactly `/p2p`, so changing either of these is a coordinated change with
   * deploy/, not a local one.
   *
   * OFF unless a port is configured (HEARTH_P2P_WS). TCP stays the default for
   * same-host and same-LAN peers: it is one fewer layer, and every existing
   * testnet deployment uses it. */
  DEFAULT_P2P_WS_PORT: 8648,
  P2P_WS_PATH: '/p2p',

  /* KEEPALIVE, AND WHY IT IS NOT OPTIONAL ON THIS TRANSPORT.
   *
   * Cloudflare closes a WebSocket that carries nothing. Without an
   * application-level heartbeat the seed link dies quietly and the failure is
   * the worst shape a failure can have: the miner still shows a peer, still
   * hashes, still finds blocks, and every one of them goes nowhere.
   *
   * 20 s is comfortably inside Cloudflare's ~100 s idle window and is cheap — a
   * ping frame is 2 bytes on the wire, so this is ~0.1 bps per peer. The idle
   * deadline is 70 s: three missed pings, not one, so a single dropped frame or
   * a GC pause does not cost a peer. Note the resync tick above is 20 s as well
   * and does keep a link busy, but it only runs while a node HAS peers and only
   * carries a locator — it is not a liveness check and nothing acts on its
   * absence. */
  P2P_WS_PING_MS: 20_000,
  P2P_WS_IDLE_MS: 70_000,

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

  /* THE RPC EXECUTION BUDGET — POLICY, NOT CONSENSUS, AND FAIL-CLOSED.
   *
   * `eth_call` and `eth_estimateGas` are the only unauthenticated way to make
   * this process run EVM code, and the process is single-threaded: mining, p2p
   * gossip, the REST API and the /info healthcheck compose polls all share the
   * loop that a speculative run holds. Two bounds, because neither is enough
   * alone:
   *
   *   GAS bounds the WORK a caller may buy. A third of the block gas limit is
   *   far more than anything the estate actually asks for — the fattest thing
   *   anyone deploys through this node is an ERC-20, at under 2M — and a call
   *   that genuinely needs more than a third of a whole block is asking about a
   *   transaction no sane block would carry. geth calls this --rpc.gascap and
   *   defaults it to 50M; it can afford to, because its EVM is not a BigInt
   *   interpreter.
   *
   *   TIME bounds the WORK PER UNIT OF GAS, which gas cannot, because the spread
   *   between the cheapest and dearest gas in this implementation is 135x
   *   (docs/robustness-review.md §6). 10M gas of PUSH/ADD is 160 ms; the same
   *   10M gas of blake2f is 3.5 s, and 30M of it is 10.7 seconds of a node that
   *   answers nothing and mines nothing. One second is comfortably above
   *   every honest call — a whole 30M-gas block of ordinary compute validates in
   *   0.48 s — and short enough that the miner and the healthcheck never notice.
   *
   * Both may be raised for a private or metered endpoint. There is deliberately
   * no value meaning "unlimited": that is what the defect was.
   */
  EVM_RPC_GAS_CAP: rpcBudget('HEARTH_RPC_GAS_CAP', 10_000_000),
  EVM_RPC_TIME_BUDGET_MS: rpcBudget('HEARTH_RPC_TIME_BUDGET_MS', 1_000),

  /* Whether this node serves `eth_feeHistory` and `eth_maxPriorityFeePerGas`.
   *
   * OFF, and the argument is written out where the methods are, in
   * jsonrpc/methods.js. In short: v1 has no fee market, nothing that works today
   * calls either method — ethers, viem, Hardhat and MetaMask all decide from the
   * ABSENCE of `baseFeePerGas` on the block — and the one toolchain that does
   * call it, Foundry, is better served by the error. Given zero base fees it
   * signs a type-2 transaction this chain cannot execute, trading "try adding
   * --legacy" at signing time for a refusal at broadcast that names no remedy.
   * Measured in docs/network-config.md §5 against Foundry 1.7.1.
   *
   * Turn it on for a private endpoint feeding a gas dashboard, or on the day the
   * fee market lands in v2 — the implementation and its tests are already here. */
  EVM_RPC_FEE_HISTORY: process.env.HEARTH_RPC_FEE_HISTORY === '1',

  /* THE MINING ENDPOINTS' BUDGETS — and this is the P2P argument, at a door that
   * did not have one.
   *
   * `/mining/template` and `/mining/submit` are published through the tunnel, so
   * they are the first unauthenticated surface this node exposes to the open
   * internet. They are deliberately NOT authenticated: this is a permissionless
   * chain whose whole thesis is that ordinary people mine it, a submitted block
   * still has to satisfy proof of work and full validation before it is worth
   * anything, and a credential on `submit` would shut out exactly the strangers
   * the coin exists for. What they need is not authorisation. It is a bound on
   * COST — the same bound P2P_BLOCK_VERIFY_* above puts on a gossip peer, for
   * the identical reason, because it is the identical operation:
   *
   *   submit    a well-formed body with a wrong digest costs a FULL HOMEFIRE
   *             EVALUATION (~7 ms of a core) before it can be refused. Unmetered,
   *             one curl loop is a remote denial of service on a mining node.
   *   template  `candidateFor` is memoized on the coinbase key among other
   *             things, so a caller that varies the key misses the memo every
   *             time and buys a full block of EVM execution per request — which
   *             is precisely what that memo's comment says it exists to prevent.
   *
   * METERED WITH A REFUND, exactly as p2p.js meters blocks: the token is taken
   * before the work and given back when the outcome shows nothing was wasted.
   * An honest miner submits winning proofs and is therefore never charged, and
   * a submission refused before any hashing — an expired template, a malformed
   * body — costs nothing and is charged nothing. A flat rate limit would get
   * both of those wrong, and would throttle the one caller that matters.
   *
   * GLOBAL AS WELL AS PER-CLIENT, and the global one is the real bound. Behind a
   * tunnel every request arrives from the tunnel's address, so the client is
   * identified by a forwarded header — which anything can set. Per-client
   * budgets are therefore FAIRNESS, stopping one caller starving others; they
   * are not a security boundary, because a spoofed header buys a fresh bucket.
   * The global budget is what actually caps this node's exposure, and it cannot
   * be spoofed around.
   *
   * 5 evaluations/second is ~3.5% of one core spent on junk, sustained, against
   * a 15 s block interval — and far above any honest submission rate, which is
   * a handful per block at most. */
  MINING_VERIFY_BURST: 30,
  MINING_VERIFY_PER_S: 5,
  MINING_TEMPLATE_BURST: 60,
  MINING_TEMPLATE_PER_S: 10,
  /** Callers tracked at once. A map keyed by something the caller controls is a
   *  memory leak unless it is capped; oldest-seen is evicted first. */
  MINING_MAX_CLIENTS: 1_024,

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

  /* THE SPLIT, in one place, because two numbers are quoted from it to different
   * audiences and they are not the same number. `subsidyWei` is what a block
   * MINTS; `coinbaseRewardWei` is what the miner is PAID, and the 10% between
   * them goes to the Commons (chain/blockchain.js `_creditReward`).
   *
   * A remote miner has no chain to check a balance against, so it believes
   * whatever the work template quotes it. Quoting the full subsidy made its
   * running total 10% higher than the coins it actually held — a figure that
   * never reconciles against a wallet, and whose most natural reading is that
   * something took a cut without saying so. */
  commonsShareWei(height) {
    return this.subsidyWei(height) * BigInt(Math.round(this.COMMONS_SHARE * 100)) / 100n;
  },
  coinbaseRewardWei(height) {
    return this.subsidyWei(height) - this.commonsShareWei(height);
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
  /* And the PoW pad, for the reason written at POW_MAX_SCRATCH_KIB: the failure
   * this guards is not a typo, it is a documented instruction ("raise
   * POW_SCRATCH_KIB from 64 to the production ~2 GiB") that no test would have
   * refused. Fail at require() time, so it is impossible to reach a genesis
   * with it — every entry point loads params before it does anything else.
   */
  if (!Number.isInteger(m.POW_SCRATCH_KIB) || m.POW_SCRATCH_KIB < 1) {
    throw new Error('params: POW_SCRATCH_KIB must be a positive integer number of KiB');
  }
  if (m.POW_SCRATCH_KIB > m.POW_MAX_SCRATCH_KIB) {
    throw new Error(
      `params: POW_SCRATCH_KIB ${m.POW_SCRATCH_KIB} exceeds POW_MAX_SCRATCH_KIB ${m.POW_MAX_SCRATCH_KIB}. `
      + 'Homefire pays the whole pad on every attempt and a validator pays one full evaluation per '
      + 'block received, so a pad this size cannot be verified inside TARGET_BLOCK_TIME. '
      + 'See docs/pow-parameters.md — the fix is an amortised dataset, not a larger constant.');
  }
  // The walk is the affordable parameter (test/pow-params.js measures why), but
  // it is still one SHA-256 per step inside the same per-block budget.
  if (!Number.isInteger(m.POW_WALK_STEPS) || m.POW_WALK_STEPS < 1 || m.POW_WALK_STEPS > 1_048_576) {
    throw new Error('params: POW_WALK_STEPS must be a positive integer at most 1,048,576');
  }
}
