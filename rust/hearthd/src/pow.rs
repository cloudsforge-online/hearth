//! Homefire proof-of-work — memory-hard core.
//!
//! Fill a scratchpad and take a pseudo-random walk that reads and mutates it,
//! deriving the digest from the whole pad. Dev-tuned sizes; production uses a
//! ~2 GiB dataset and more walk steps.
//!
//! # NOT CONSENSUS-COMPATIBLE
//!
//! The *shape* mirrors `node/src/pow.js`, but the seed does not. Consensus binds
//! `(headerCoreHash, nonce, coinbasePubHex)`; this module hashes whatever seed
//! bytes it is handed and the binary never puts the coinbase public key in them.
//! A digest from here therefore does not match the chain's for the same header,
//! and a "valid" proof produced with this code would be rejected by every node
//! on the network. Reconcile before wiring this to a block.
//! See docs/why-two-implementations.md.

use crate::sha256::sha256;

pub const SCRATCH_KIB: usize = 64;
pub const WORDS: usize = SCRATCH_KIB * 1024 / 8;
pub const WALK_STEPS: usize = 256;

fn sha_concat(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut v = Vec::with_capacity(a.len() + b.len());
    v.extend_from_slice(a);
    v.extend_from_slice(b);
    sha256(&v)
}

/// Memory-hard hash of `seed`.
pub fn homefire(seed: &[u8]) -> [u8; 32] {
    let mut pad = vec![0u8; WORDS * 8];

    // stretch the seed across the whole scratchpad
    let mut cur = sha256(seed);
    for word in pad.chunks_exact_mut(8) {
        cur = sha256(&cur);
        word.copy_from_slice(&cur[0..8]);
    }

    // pseudo-random walk: read, mix, write back mutated
    let mut acc = sha_concat(seed, &pad[0..64]);
    for _ in 0..WALK_STEPS {
        let idx = (u32::from_le_bytes([acc[0], acc[1], acc[2], acc[3]]) as usize) % WORDS;
        let off = idx * 8;
        let word = u64::from_le_bytes(pad[off..off + 8].try_into().unwrap());
        acc = sha_concat(&acc, &pad[off..off + 8]);
        let mix = u64::from_le_bytes(acc[0..8].try_into().unwrap());
        pad[off..off + 8].copy_from_slice(&(word ^ mix).to_le_bytes());
    }

    sha_concat(&acc, &pad[(WORDS - 8) * 8..])
}

/// Count leading zero bits of a 32-byte digest.
pub fn leading_zero_bits(h: &[u8; 32]) -> u32 {
    let mut bits = 0;
    for &b in h.iter() {
        if b == 0 {
            bits += 8;
        } else {
            bits += b.leading_zeros();
            break;
        }
    }
    bits
}

/// Does the digest satisfy a difficulty of `target_bits` leading zero bits?
pub fn meets(h: &[u8; 32], target_bits: u32) -> bool {
    leading_zero_bits(h) >= target_bits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        assert_eq!(homefire(b"seed"), homefire(b"seed"));
        assert_ne!(homefire(b"seed"), homefire(b"other"));
    }

    #[test]
    fn target_math() {
        let zero = [0u8; 32];
        assert!(meets(&zero, 256));
        let mut one = [0u8; 32];
        one[0] = 0x01;
        assert_eq!(leading_zero_bits(&one), 7);
        assert!(meets(&one, 7));
        assert!(!meets(&one, 8));
    }

    #[test]
    fn mining_finds_a_low_difficulty_block() {
        // 8 leading zero bits is quick to find and proves the loop works.
        let mut nonce: u64 = 0;
        loop {
            let mut seed = b"hearth-test-header".to_vec();
            seed.extend_from_slice(&nonce.to_le_bytes());
            if meets(&homefire(&seed), 8) {
                break;
            }
            nonce += 1;
            assert!(nonce < 1_000_000, "should find an 8-bit block quickly");
        }
    }
}
