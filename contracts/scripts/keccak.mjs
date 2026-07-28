// Keccak-256, dependency-free.
//
// Needed to compute the CREATE2 init code hash from the build. Node's built-in
// crypto has 'sha3-256', which is NOT this: SHA3 uses the NIST padding byte 0x06,
// Ethereum uses the original Keccak padding byte 0x01, and the two produce different
// digests for every input. See docs/evm-spec.md §5.
//
// Correctness is asserted at import time against the empty-string vector.

const MASK = (1n << 64n) - 1n

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

// Rho rotation offsets, lane index i = x + 5y.
const R = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
].map(BigInt)

const rotl = (x, n) => n === 0n ? x : ((x << n) | (x >> (64n - n))) & MASK

function keccakF1600(A) {
  const C = new Array(5)
  const B = new Array(25)
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n)
      for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D
    }
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x + 5 * y])
      }
    }
    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[x + 5 * y] = B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK) & B[((x + 2) % 5) + 5 * y])
      }
    }
    // iota
    A[0] ^= RC[round]
  }
}

/** @param {Uint8Array} input @returns {Uint8Array} 32 bytes */
export function keccak256(input) {
  const RATE = 136 // 1088 bits, the rate for Keccak-256
  const padLen = RATE - (input.length % RATE)
  const padded = new Uint8Array(input.length + padLen)
  padded.set(input)
  padded[input.length] = 0x01 // Keccak padding, not SHA3's 0x06
  padded[padded.length - 1] |= 0x80

  const A = new Array(25).fill(0n)
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b])
      A[i] ^= lane
    }
    keccakF1600(A)
  }

  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    let lane = A[i]
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn)
      lane >>= 8n
    }
  }
  return out
}

export const toHex = (bytes) => '0x' + Buffer.from(bytes).toString('hex')

export function fromHex(hex) {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex
  if (s.length % 2) throw new Error('odd-length hex')
  // Buffer.from(s, 'hex') stops at the first invalid nibble pair and returns a SHORT
  // buffer without throwing. That is unusable here: this feeds the init code hash, and a
  // silently truncated input would produce a plausible-looking but wrong hash that only
  // surfaces after deployment, when the router cannot find any pair.
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error(`not hex: ${hex.slice(0, 32)}…`)
  const bytes = Uint8Array.from(Buffer.from(s, 'hex'))
  if (bytes.length !== s.length / 2) throw new Error('hex decoded to the wrong length')
  return bytes
}

export const keccak256Hex = (hexOrBytes) =>
  toHex(keccak256(typeof hexOrBytes === 'string' ? fromHex(hexOrBytes) : hexOrBytes))

// Self-test at import. If this ever fails, every hash this module produced is wrong.
{
  const empty = toHex(keccak256(new Uint8Array(0)))
  const EXPECTED = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  if (empty !== EXPECTED) {
    throw new Error(`keccak256 self-test failed: keccak256("") = ${empty}, expected ${EXPECTED}`)
  }
  const abc = toHex(keccak256(Uint8Array.from(Buffer.from('abc', 'utf8'))))
  const EXPECTED_ABC = '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'
  if (abc !== EXPECTED_ABC) {
    throw new Error(`keccak256 self-test failed: keccak256("abc") = ${abc}, expected ${EXPECTED_ABC}`)
  }
}
