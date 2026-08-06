'use strict';
/* Header v2 and block encoding — what proof-of-work commits to on the account model.
 *
 *   { version: 2, prevHash, height, timestamp, target, coinbasePub,
 *     txRoot, stateRoot, receiptsRoot, logsBloom, gasLimit, gasUsed, extraData,
 *     nonce, mixHash, powSig }
 *
 * The header is carried between nodes as JSON with hex strings, exactly as the v1
 * header was, because the P2P layer is newline-delimited JSON and a Buffer does not
 * survive JSON.stringify. NOTHING is hashed from that JSON: every hash in this file
 * is taken over RLP of canonically-encoded fields, so the wire form can change
 * without moving a single block id.
 *
 * FOUR THINGS HERE ARE CONSENSUS AND EACH ONE IS A SILENT CHAIN SPLIT IF WRONG.
 *
 * 1. `timestamp` IS SECONDS. Not milliseconds. A millisecond timestamp puts every
 *    explorer date in the year 57,000 and makes every Solidity `deadline` compare
 *    against a number a thousand times too large — Uniswap V2's Router rejects every
 *    swap as expired, and nothing anywhere reports an error. `decode` refuses a
 *    timestamp that looks like milliseconds (see MAX_TIMESTAMP) rather than trusting
 *    a producer to have divided. (The v1 header in ../block.js is, contrary to what
 *    docs/evm-spec.md §4 says, already in seconds — ../miner.js divides. The rule
 *    still has to be enforced here, because nothing enforced it there.)
 *
 * 2. THE PROOF BINDS A secp256k1 KEY. Homefire itself is untouched — the same pad
 *    fill, the same walk, the same digest, the same `POW.powSeed(coreHash, nonce,
 *    coinbasePubHex)`. What changed is the key: the coinbase must RECEIVE the reward
 *    and the fees, so it has to be an account this chain can credit, and that means
 *    secp256k1 and a 0x address. The block signature moves with it. The browser
 *    miner's loop is unaffected — it grinds nonces over a template and never
 *    executes a transaction — but its keystore is Ed25519 and must be swapped.
 *
 * 3. THE BLOCK HASH EXCLUDES THE SIGNATURE, and includes the nonce and the digest.
 *    A signature is malleable and two encodings of one signature would give one
 *    block two ids. `coreHash` (what Homefire runs over) excludes nonce, digest and
 *    signature, because the miner varies the nonce and the core must not move under
 *    it.
 *
 * 4. SCALARS ARE MINIMAL AND FIXED-WIDTH FIELDS ARE FIXED-WIDTH. RLP is untyped, so
 *    it cannot know `height` is a number; the decoder enforces it (spec §5). `nonce`
 *    is the one deliberate exception: it is a fixed 8 bytes, because the RPC surface
 *    types it as DATA(8) and a client reads it as bytes rather than as a quantity.
 */

const { keccak256 } = require('../crypto/keccak');
const RLP = require('../crypto/rlp');
const secp = require('../crypto/secp256k1');
const POW = require('../pow');
const TX = require('./transaction');

const HEADER_VERSION = 2;

/** 2^256, so `difficulty = TWO256 / (target + 1)`. */
const TWO256 = 1n << 256n;

/**
 * A ceiling on the timestamp that no honest second-denominated header can reach
 * until the year 5138, and that every millisecond-denominated one exceeds today.
 * This is rule 1 above given teeth: it is the check that would have caught a
 * producer that forgot to divide, on the first block it produced.
 */
const MAX_TIMESTAMP = 100_000_000_000;     // ≈ year 5138 in seconds; Date.now() is ≈1.7e12

const ZERO_HASH = Buffer.alloc(32);

// ---- coercions -------------------------------------------------------------

function hexToBuf(v, what, len = null) {
  let b;
  if (Buffer.isBuffer(v)) b = v;
  else if (v instanceof Uint8Array) b = Buffer.from(v);
  else if (typeof v === 'string') {
    const h = v.replace(/^0x/i, '');
    if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new TypeError(`header: malformed hex ${what}`);
    b = Buffer.from(h, 'hex');
  } else if (v === null || v === undefined) b = Buffer.alloc(0);
  else throw new TypeError(`header: ${what} must be bytes or hex`);
  if (len !== null && b.length !== len) throw new TypeError(`header: ${what} must be ${len} bytes, got ${b.length}`);
  return b;
}

function uint(v, what) {
  const n = typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : BigInt(String(v || 0));
  if (n < 0n) throw new TypeError(`header: ${what} must not be negative`);
  return n;
}

/** A quantity as a JS number, refusing anything that would lose precision. */
function num(v, what) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`header: ${what} must be a non-negative safe integer`);
  return n;
}

function bytes8(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

// ---- the header ------------------------------------------------------------

/**
 * Normalise a header into the canonical in-memory shape: hex strings without an
 * `0x` prefix (matching the v1 header and the JSON that crosses the wire), numbers
 * for the small quantities. `normalize` is the single door in — everything else in
 * this module assumes it has run.
 */
function normalize(h) {
  const out = {
    version: num(h.version === undefined ? HEADER_VERSION : h.version, 'version'),
    prevHash: hexToBuf(h.prevHash, 'prevHash', 32).toString('hex'),
    height: num(h.height, 'height'),
    timestamp: num(h.timestamp, 'timestamp'),
    target: hexToBuf(h.target, 'target', 32).toString('hex'),
    coinbasePub: hexToBuf(h.coinbasePub, 'coinbasePub').toString('hex'),
    txRoot: hexToBuf(h.txRoot, 'txRoot', 32).toString('hex'),
    stateRoot: hexToBuf(h.stateRoot, 'stateRoot', 32).toString('hex'),
    receiptsRoot: hexToBuf(h.receiptsRoot, 'receiptsRoot', 32).toString('hex'),
    logsBloom: hexToBuf(h.logsBloom, 'logsBloom', 256).toString('hex'),
    gasLimit: num(h.gasLimit, 'gasLimit'),
    gasUsed: num(h.gasUsed, 'gasUsed'),
    extraData: hexToBuf(h.extraData === undefined ? '' : h.extraData, 'extraData').toString('hex'),
    nonce: num(h.nonce === undefined ? 0 : h.nonce, 'nonce'),
    mixHash: hexToBuf(h.mixHash === undefined ? ZERO_HASH : h.mixHash, 'mixHash', 32).toString('hex'),
    powSig: hexToBuf(h.powSig === undefined ? '' : h.powSig, 'powSig').toString('hex'),
  };
  return out;
}

/**
 * The fields Homefire commits to. Everything the miner may NOT vary while grinding:
 * no nonce, no digest, no signature.
 */
function coreFields(h) {
  return [
    h.version,
    Buffer.from(h.prevHash, 'hex'),
    h.height,
    h.timestamp,
    Buffer.from(h.target, 'hex'),
    Buffer.from(h.coinbasePub, 'hex'),
    Buffer.from(h.txRoot, 'hex'),
    Buffer.from(h.stateRoot, 'hex'),
    Buffer.from(h.receiptsRoot, 'hex'),
    Buffer.from(h.logsBloom, 'hex'),
    h.gasLimit,
    h.gasUsed,
    Buffer.from(h.extraData, 'hex'),
  ];
}

/** The core plus the proof — everything the block id commits to. */
function sealFields(h) {
  return [...coreFields(h), bytes8(h.nonce), Buffer.from(h.mixHash, 'hex')];
}

function encodeCore(h) { return RLP.encode(coreFields(normalize(h))); }

/** What the miner grinds against. Hex, because `POW.powSeed` hashes strings. */
function coreHash(h) { return keccak256(encodeCore(h)).toString('hex'); }

/** The full header as served and stored, signature included. */
function encode(h) {
  const n = normalize(h);
  return RLP.encode([...sealFields(n), Buffer.from(n.powSig, 'hex')]);
}

/** The block id: keccak256 over the sealed header, WITHOUT the signature. */
function hash(h) { return keccak256(RLP.encode(sealFields(normalize(h)))); }

function hashHex(h) { return hash(h).toString('hex'); }

/** `difficulty` for the RPC: the expected number of Homefire attempts. */
function difficulty(targetHex) {
  return TWO256 / (BigInt('0x' + String(targetHex).replace(/^0x/i, '')) + 1n);
}

// ---- blocks ----------------------------------------------------------------

/**
 * A block is `{ header, txs }` where `txs` is an array of hex-encoded signed
 * transaction RLP. Raw bytes rather than decoded objects, because the transaction
 * hash and the txRoot are both taken over exactly those bytes and re-encoding a
 * decoded transaction is the one place a byte could change.
 */
function txBuffers(block) {
  return (block.txs || []).map((t, i) => hexToBuf(t, `txs[${i}]`));
}

/** The header's `txRoot`: the same non-secure, rlp(index)-keyed trie as receipts. */
function txRoot(rawTxs) {
  return require('./receipt').trieRoot(rawTxs.map(t => hexToBuf(t, 'transaction')));
}

/** RLP of the whole block, which is what `size` reports to a client. */
function encodeBlock(block) {
  return RLP.encode([
    [...sealFields(normalize(block.header)), Buffer.from(normalize(block.header).powSig, 'hex')],
    txBuffers(block),
  ]);
}

function blockSize(block) { return BigInt(encodeBlock(block).length); }

// ---- the proof -------------------------------------------------------------

/** The address a coinbase public key pays: keccak256(pub[1:])[12:], per spec §2. */
function coinbaseAddress(coinbasePubHex) {
  return TX.addressFromPublicKey(Buffer.from(String(coinbasePubHex).replace(/^0x/i, ''), 'hex'));
}

/**
 * Sign a winning digest with the coinbase key. 65 bytes, `r || s || recoveryId`,
 * so the signature carries its own recovery and a verifier needs no public key
 * beyond the one already in the header.
 */
function signProof(mixHashHex, privateKey) {
  const sig = secp.sign(Buffer.from(mixHashHex, 'hex'), privateKey);
  return Buffer.concat([
    secp.bigToBuf32(sig.r), secp.bigToBuf32(sig.s), Buffer.from([sig.recoveryId]),
  ]).toString('hex');
}

/**
 * Verify a header's proof of work end to end:
 *
 *   1. the digest really is Homefire over (coreHash, nonce, coinbasePub)
 *   2. the digest meets the target
 *   3. the digest is signed by the coinbase key
 *
 * (3) is what stops a winning proof being redeemed by anyone but the key it was
 * issued to — on the account model there is no coinbase transaction to check, so
 * the signature is the whole of that binding. It is NOT non-outsourceability; see
 * the note at the top of ../pow.js, which is unchanged and still true.
 *
 * Returns `{ok:false, err}` rather than throwing: this is fed arbitrary bytes by
 * anonymous peers.
 */
function verifyPow(header) {
  let h;
  try { h = normalize(header); } catch (e) { return { ok: false, err: 'malformed header: ' + e.message }; }
  if (h.version !== HEADER_VERSION) return { ok: false, err: `header version ${h.version}, want ${HEADER_VERSION}` };
  let pub;
  try {
    pub = Buffer.from(h.coinbasePub, 'hex');
    /* Uncompressed only. The address is keccak256(pub[1:])[12:] over exactly these
     * 64 bytes (spec §2); accepting the compressed form as well would give one key
     * two header encodings and therefore two block ids for one block. */
    if (pub.length !== 65 || pub[0] !== 4) return { ok: false, err: 'coinbasePub must be a 65-byte uncompressed secp256k1 key' };
    if (secp.decodePoint(pub) === null) return { ok: false, err: 'coinbasePub is not a point on secp256k1' };
  } catch { return { ok: false, err: 'coinbasePub is not a valid secp256k1 key' }; }

  const seed = POW.powSeed(coreHash(h), h.nonce, h.coinbasePub);
  const digest = POW.homefireHash(seed).toString('hex');
  if (digest !== h.mixHash) return { ok: false, err: 'pow digest mismatch' };
  if (!POW.meetsTarget(digest, h.target)) return { ok: false, err: 'pow does not meet target' };

  const sig = Buffer.from(h.powSig, 'hex');
  if (sig.length !== 65) return { ok: false, err: 'pow signature must be 65 bytes' };
  const r = BigInt('0x' + sig.subarray(0, 32).toString('hex'));
  const s = BigInt('0x' + sig.subarray(32, 64).toString('hex'));
  /* `lowS: false`, matching what a signature over a digest needs: this signature is
   * not part of the block id (see the header note), so its malleability cannot give
   * one block two ids and rejecting the high-s form would only reject valid work. */
  if (!secp.verify(Buffer.from(h.mixHash, 'hex'), { r, s }, pub, { lowS: false })) {
    return { ok: false, err: 'pow signature invalid' };
  }
  return { ok: true, id: hashHex(h) };
}

// ---- decoding a peer's header ----------------------------------------------

/**
 * Structural validation of a header that arrived from a stranger, before any
 * hashing. Everything here is a pure shape check — the expensive rules (the proof,
 * the difficulty target, the state transition) live in blockchain.js and are gated
 * behind this.
 */
function check(header) {
  let h;
  try { h = normalize(header); } catch (e) { return { ok: false, err: e.message }; }
  if (h.version !== HEADER_VERSION) return { ok: false, err: 'wrong header version' };
  if (h.timestamp >= MAX_TIMESTAMP) {
    return { ok: false, err: 'timestamp is not in seconds (it exceeds the year 5138 — milliseconds?)' };
  }
  if (h.gasUsed > h.gasLimit) return { ok: false, err: 'gasUsed exceeds gasLimit' };
  const pub = Buffer.from(h.coinbasePub, 'hex');
  if (pub.length !== 65 || pub[0] !== 4) return { ok: false, err: 'coinbasePub must be a 65-byte uncompressed secp256k1 key' };
  return { ok: true, header: h };
}

module.exports = {
  HEADER_VERSION, MAX_TIMESTAMP, TWO256, ZERO_HASH,
  normalize, coreFields, sealFields,
  encodeCore, coreHash, encode, hash, hashHex, difficulty,
  txBuffers, txRoot, encodeBlock, blockSize,
  coinbaseAddress, signProof, verifyPow, check,
  hexToBuf, uint, num, bytes8,
};
