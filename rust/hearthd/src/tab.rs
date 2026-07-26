//! Tab — off-chain payment channels for instant, near-free retail payments.
//!
//! Two parties open a channel funded on-chain, then exchange **signed balance
//! updates** off-chain and settle the final state back to the base chain. This
//! is what makes "buy a coffee" instant and sub-cent while keeping the base
//! layer lean.
//!
//! Security model captured here:
//!   * every update is Ed25519-signed by the party whose balance decreases
//!     (you can only give away *your own* funds);
//!   * balances always conserve the channel capacity (no minting);
//!   * a strictly-increasing nonce makes old (already-superseded) states
//!     unusable — the replay/"cheating with a stale state" defense;
//!   * a peer independently re-verifies every received state before accepting.

use crate::crypto::{self, KeyPair};
use crate::sha256::{hex, sha256};

/// A signed channel state — the message exchanged between peers.
#[derive(Clone, Debug)]
pub struct SignedState {
    pub nonce: u64,
    pub bal_a: u64,
    pub bal_b: u64,
    pub signer: [u8; 32],
    pub sig: Vec<u8>,
}

fn state_bytes(id: &str, nonce: u64, bal_a: u64, bal_b: u64) -> Vec<u8> {
    let mut b = id.as_bytes().to_vec();
    b.extend_from_slice(&nonce.to_le_bytes());
    b.extend_from_slice(&bal_a.to_le_bytes());
    b.extend_from_slice(&bal_b.to_le_bytes());
    b
}

pub struct Channel {
    id: String,
    pub_a: [u8; 32],
    pub_b: [u8; 32],
    capacity: u64,
    nonce: u64,
    bal_a: u64,
    bal_b: u64,
}

impl Channel {
    /// Open a channel funded by A and B. The on-chain funding tx would lock
    /// `a_funding + b_funding`; here we track the resulting off-chain balances.
    pub fn open(a: &KeyPair, b: &KeyPair, a_funding: u64, b_funding: u64) -> Self {
        let pub_a = a.public();
        let pub_b = b.public();
        let id = hex(&sha256(
            &[
                pub_a.as_slice(),
                pub_b.as_slice(),
                &(a_funding + b_funding).to_le_bytes(),
            ]
            .concat(),
        ));
        Self {
            id,
            pub_a,
            pub_b,
            capacity: a_funding + b_funding,
            nonce: 0,
            bal_a: a_funding,
            bal_b: b_funding,
        }
    }

    pub fn balances(&self) -> (u64, u64) {
        (self.bal_a, self.bal_b)
    }
    pub fn nonce(&self) -> u64 {
        self.nonce
    }
    /// Settlement amounts if the channel is closed now.
    pub fn close(&self) -> (u64, u64) {
        (self.bal_a, self.bal_b)
    }

    fn side_of(&self, kp: &KeyPair) -> Option<char> {
        let p = kp.public();
        if p == self.pub_a {
            Some('a')
        } else if p == self.pub_b {
            Some('b')
        } else {
            None
        }
    }

    /// `payer` sends `amount` to the counterparty. Mutates this view and returns
    /// the signed state to hand to the peer.
    pub fn pay(&mut self, payer: &KeyPair, amount: u64) -> Result<SignedState, String> {
        let side = self.side_of(payer).ok_or("not a channel participant")?;
        let (bal_a, bal_b) = match side {
            'a' => {
                if amount > self.bal_a {
                    return Err("insufficient channel balance".into());
                }
                (self.bal_a - amount, self.bal_b + amount)
            }
            _ => {
                if amount > self.bal_b {
                    return Err("insufficient channel balance".into());
                }
                (self.bal_a + amount, self.bal_b - amount)
            }
        };
        let nonce = self.nonce + 1;
        let sig = payer
            .sign(&state_bytes(&self.id, nonce, bal_a, bal_b))
            .to_vec();
        self.nonce = nonce;
        self.bal_a = bal_a;
        self.bal_b = bal_b;
        Ok(SignedState {
            nonce,
            bal_a,
            bal_b,
            signer: payer.public(),
            sig,
        })
    }

    /// Apply a state received from the peer, re-verifying every invariant.
    pub fn apply(&mut self, s: &SignedState) -> Result<(), String> {
        if s.nonce <= self.nonce {
            return Err("stale or replayed state".into());
        }
        if s.bal_a + s.bal_b != self.capacity {
            return Err("state does not conserve capacity".into());
        }
        // the signer must be the party whose balance decreased (they authorized
        // giving away their own funds)
        let signer_must_be = if s.bal_a < self.bal_a {
            self.pub_a
        } else if s.bal_b < self.bal_b {
            self.pub_b
        } else {
            return Err("no party debited".into());
        };
        if s.signer != signer_must_be {
            return Err("state signed by the wrong party".into());
        }
        if !crypto::verify(
            &s.signer,
            &state_bytes(&self.id, s.nonce, s.bal_a, s.bal_b),
            &s.sig,
        ) {
            return Err("invalid state signature".into());
        }
        self.nonce = s.nonce;
        self.bal_a = s.bal_a;
        self.bal_b = s.bal_b;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (KeyPair, KeyPair) {
        (KeyPair::generate(), KeyPair::generate())
    }

    #[test]
    fn pay_conserves_and_updates() {
        let (a, b) = pair();
        let mut ch = Channel::open(&a, &b, 100, 0);
        ch.pay(&a, 30).unwrap();
        assert_eq!(ch.balances(), (70, 30));
        assert_eq!(ch.nonce(), 1);
        let (x, y) = ch.balances();
        assert_eq!(x + y, 100); // conserved
    }

    #[test]
    fn cannot_overspend() {
        let (a, b) = pair();
        let mut ch = Channel::open(&a, &b, 100, 0);
        assert!(ch.pay(&a, 1000).is_err());
        assert!(ch.pay(&b, 1).is_err()); // b has zero balance
    }

    #[test]
    fn peer_applies_signed_state() {
        let (a, b) = pair();
        let mut alice_view = Channel::open(&a, &b, 100, 0);
        let mut bob_view = Channel::open(&a, &b, 100, 0);
        let s = alice_view.pay(&a, 40).unwrap();
        bob_view.apply(&s).unwrap();
        assert_eq!(bob_view.balances(), (60, 40));
        assert_eq!(bob_view.close(), (60, 40));
    }

    #[test]
    fn rejects_replayed_state() {
        let (a, b) = pair();
        let mut alice_view = Channel::open(&a, &b, 100, 0);
        let mut bob_view = Channel::open(&a, &b, 100, 0);
        let s = alice_view.pay(&a, 40).unwrap();
        bob_view.apply(&s).unwrap();
        assert!(
            bob_view.apply(&s).is_err(),
            "replaying an old state must fail"
        );
    }

    #[test]
    fn rejects_tampered_signature() {
        let (a, b) = pair();
        let mut alice_view = Channel::open(&a, &b, 100, 0);
        let mut bob_view = Channel::open(&a, &b, 100, 0);
        let mut s = alice_view.pay(&a, 40).unwrap();
        s.sig[0] ^= 0xff;
        assert!(bob_view.apply(&s).is_err());
    }

    #[test]
    fn rejects_theft_by_wrong_signer() {
        // Bob signs a state that debits Alice — must be rejected.
        let (a, b) = pair();
        let mut bob_view = Channel::open(&a, &b, 100, 0);
        let bal_a = 10u64;
        let bal_b = 90u64; // Bob tries to grab Alice's funds
        let nonce = 1u64;
        let sig = b
            .sign(&state_bytes(&bob_view.id, nonce, bal_a, bal_b))
            .to_vec();
        let forged = SignedState {
            nonce,
            bal_a,
            bal_b,
            signer: b.public(),
            sig,
        };
        assert!(
            bob_view.apply(&forged).is_err(),
            "theft by counterparty must fail"
        );
    }
}
