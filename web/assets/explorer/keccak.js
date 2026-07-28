/* Keccak-256 for the browser — the explorer's one piece of real cryptography.
 *
 * This is NOT SHA3-256. Ethereum uses the original Keccak padding (0x01);
 * NIST SHA3 uses 0x06, and they produce different digests. The node says the
 * same thing at node/src/crypto/keccak.js and docs/evm-spec.md §5; this file is
 * the browser's copy of that fact, and node/src/crypto/keccak.js is the
 * authority. If they ever disagree, this one is wrong.
 *
 * The explorer needs it for three things and would be noticeably worse without
 * any of them:
 *   - EIP-55 mixed-case address checksums, which is how a reader spots a
 *     mistyped address;
 *   - the code hash of a contract, which `eth_getCode` does not return;
 *   - hashing an event signature typed into the log search box, so someone can
 *     search for `Transfer(address,address,uint256)` instead of pasting 32 bytes.
 *
 * Lanes are BigInt rather than 32-bit halves. That is perhaps 5× slower than
 * js-sha3 and completely irrelevant here — the largest thing this ever hashes is
 * a contract's runtime code, once, on one page load — and it is short enough to
 * read against the reference permutation, which the split-word version is not.
 */

const MASK64 = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** rho offsets, in the pi-walk order used by the loop below. */
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
/** the pi permutation, as lane indices. */
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

function keccakF(st) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    // rho + pi
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = st[j];
      st[j] = rotl(t, ROTC[i]);
      t = tmp;
    }
    // chi
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = st[j + i];
      for (let i = 0; i < 5; i++) st[j + i] ^= (bc[(i + 1) % 5] ^ MASK64) & bc[(i + 2) % 5];
    }
    // iota
    st[0] ^= RC[round];
  }
  return st;
}

/** Keccak-256 over bytes. Returns a Uint8Array(32). */
export function keccak256(input) {
  const msg = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input));
  const RATE = 136;                       // 1600 - 2*256 bits, in bytes
  const st = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / RATE) * RATE);
  padded.set(msg);
  padded[msg.length] = 0x01;              // Keccak padding, NOT 0x06
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      st[i] ^= lane;
    }
    keccakF(st);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = st[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

/** Keccak-256 as a 0x-prefixed hex string. */
export function keccak256Hex(input) {
  const d = keccak256(input);
  let s = '0x';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** UTF-8 bytes of a string — event signatures are hashed as UTF-8. */
export function utf8(s) { return new TextEncoder().encode(s); }
