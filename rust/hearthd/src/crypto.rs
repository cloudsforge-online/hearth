//! Ed25519 keys, checksummed addresses, and signatures for the production core.
//!
//! This closes the biggest gap in the earlier ledger: transactions are now
//! cryptographically authenticated. Addresses carry a checksum so funds can't be
//! lost to a typo'd destination.

use crate::sha256::{hex, sha256};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

pub const ADDR_PREFIX: &str = "ember1";
const BODY_HEX: usize = 40; // 20 bytes of pubkey hash
const CHECK_HEX: usize = 6; // 3-byte checksum

/// A signing keypair (wallet key).
pub struct KeyPair {
    signing: SigningKey,
}

impl KeyPair {
    pub fn generate() -> Self {
        let mut secret = [0u8; 32];
        getrandom::getrandom(&mut secret).expect("OS CSPRNG unavailable");
        Self {
            signing: SigningKey::from_bytes(&secret),
        }
    }

    pub fn from_secret(secret: &[u8; 32]) -> Self {
        Self {
            signing: SigningKey::from_bytes(secret),
        }
    }

    pub fn public(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn address(&self) -> String {
        address_from_pub(&self.public())
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }
}

/// Verify a signature over `msg` by the given 32-byte public key.
pub fn verify(pub_bytes: &[u8], msg: &[u8], sig_bytes: &[u8]) -> bool {
    let pk: [u8; 32] = match pub_bytes.try_into() {
        Ok(b) => b,
        Err(_) => return false,
    };
    let vk = match VerifyingKey::from_bytes(&pk) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let sg: [u8; 64] = match sig_bytes.try_into() {
        Ok(b) => b,
        Err(_) => return false,
    };
    vk.verify(msg, &Signature::from_bytes(&sg)).is_ok()
}

/// Derive a checksummed address from a public key.
/// address = "ember1" + hex(sha256(pub))[..40] + hex(sha256(body))[..6]
pub fn address_from_pub(pub_bytes: &[u8]) -> String {
    let body = &hex(&sha256(pub_bytes))[..BODY_HEX];
    let check = &hex(&sha256(body.as_bytes()))[..CHECK_HEX];
    format!("{ADDR_PREFIX}{body}{check}")
}

/// Validate an address's format and checksum (protects against typos).
pub fn valid_address(addr: &str) -> bool {
    let Some(rest) = addr.strip_prefix(ADDR_PREFIX) else {
        return false;
    };
    if rest.len() != BODY_HEX + CHECK_HEX || !rest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let (body, check) = rest.split_at(BODY_HEX);
    check == &hex(&sha256(body.as_bytes()))[..CHECK_HEX]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip() {
        let kp = KeyPair::generate();
        let msg = b"pay 5 EMBER to alice";
        let sig = kp.sign(msg);
        assert!(verify(&kp.public(), msg, &sig));
        assert!(!verify(&kp.public(), b"pay 500 EMBER", &sig));
    }

    #[test]
    fn wrong_key_fails() {
        let a = KeyPair::generate();
        let b = KeyPair::generate();
        let sig = a.sign(b"x");
        assert!(!verify(&b.public(), b"x", &sig));
    }

    #[test]
    fn address_is_checksummed() {
        let kp = KeyPair::generate();
        let addr = kp.address();
        assert!(addr.starts_with("ember1"));
        assert!(valid_address(&addr));
        // flip one character in the body -> checksum must reject it
        let mut chars: Vec<char> = addr.chars().collect();
        let i = 7;
        chars[i] = if chars[i] == 'a' { 'b' } else { 'a' };
        let typo: String = chars.into_iter().collect();
        assert!(!valid_address(&typo), "typo should fail checksum");
    }

    #[test]
    fn rejects_garbage_addresses() {
        assert!(!valid_address("ember1"));
        assert!(!valid_address("bc1qxyz"));
        assert!(!valid_address("ember1zzzz"));
    }
}
