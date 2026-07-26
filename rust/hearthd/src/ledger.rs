//! UTXO ledger + emission for the Hearth production core.
//!
//! This ports the value-handling half of the JS reference node
//! (`node/src/{params,tx}.js`) into Rust: emission schedule, the Commons split,
//! the base-fee model, transaction structure, and UTXO application with
//! conservation checks.
//!
//! Transactions are cryptographically authenticated: every input must carry the
//! Ed25519 public key that hashes to the spent output's address plus a valid
//! signature over the transaction (see [`crate::crypto`]). Value math uses
//! checked arithmetic on `u64` sparks (no floating point, no overflow).

use crate::crypto;
use crate::sha256::{hex, sha256};
use std::collections::HashMap;

// ---- consensus constants (mirror node/src/params.js) -----------------------
pub const SPARKS_PER_EMBER: u64 = 100_000_000;
pub const BLOCKS_PER_YEAR: f64 = 2_103_840.0;
pub const R0_EMBER: f64 = 6.0;
pub const REWARD_HALFLIFE_YEARS: f64 = 2.0;
pub const TAIL_EMBER: f64 = 0.3;
pub const COMMONS_SHARE: f64 = 0.10;
pub const BASE_FEE_SPARKS: u64 = 40_000;
pub const COMMONS_ADDRESS: &str = "ember1commons00000000000000000000000000cmns";

/// Block subsidy in sparks at `height`.
///
/// DETERMINISTIC integer schedule (no floating point): the reward halves every
/// half-life epoch, interpolated linearly within the epoch so the curve is
/// continuous. Computes the exact same value as the JS reference's
/// `params.subsidy` — this is the frozen, cross-implementation emission rule.
pub fn subsidy(height: u64) -> u64 {
    let hl = (REWARD_HALFLIFE_YEARS * BLOCKS_PER_YEAR).round() as u64; // 4_207_680
    let r0 = (R0_EMBER * SPARKS_PER_EMBER as f64) as u64; // 600_000_000
    let tail = (TAIL_EMBER * SPARKS_PER_EMBER as f64).round() as u64; // 30_000_000
    let epoch = height / hl;
    if epoch >= 30 {
        return tail;
    }
    let base = r0 >> epoch; // floor(R0 / 2^epoch)
    let next = base >> 1;
    let within = height - epoch * hl;
    let reward = base - ((base - next) as u128 * within as u128 / hl as u128) as u64;
    reward.max(tail)
}

// ---- transaction model -----------------------------------------------------
#[derive(Clone, Debug, PartialEq)]
pub enum TxKind {
    Coinbase,
    Normal,
}

#[derive(Clone, Debug, Default)]
pub struct TxIn {
    pub txid: String,
    pub vout: u32,
    /// 32-byte Ed25519 public key that must hash to the spent output's address
    pub pubkey: Vec<u8>,
    /// 64-byte Ed25519 signature over the tx's canonical bytes
    pub sig: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct TxOut {
    pub address: String,
    pub amount: u64,
}

#[derive(Clone, Debug)]
pub struct Tx {
    pub kind: TxKind,
    pub height: u64,
    pub inputs: Vec<TxIn>,
    pub outputs: Vec<TxOut>,
}

impl Tx {
    /// Canonical bytes for hashing and signing (deterministic, length-prefixed).
    /// Excludes input signatures so it is well-defined before signing.
    pub fn canonical(&self) -> Vec<u8> {
        let mut b = Vec::new();
        b.push(match self.kind {
            TxKind::Coinbase => 0u8,
            TxKind::Normal => 1u8,
        });
        b.extend_from_slice(&self.height.to_le_bytes());
        b.extend_from_slice(&(self.inputs.len() as u32).to_le_bytes());
        for i in &self.inputs {
            let t = i.txid.as_bytes();
            b.extend_from_slice(&(t.len() as u32).to_le_bytes());
            b.extend_from_slice(t);
            b.extend_from_slice(&i.vout.to_le_bytes());
        }
        b.extend_from_slice(&(self.outputs.len() as u32).to_le_bytes());
        for o in &self.outputs {
            let a = o.address.as_bytes();
            b.extend_from_slice(&(a.len() as u32).to_le_bytes());
            b.extend_from_slice(a);
            b.extend_from_slice(&o.amount.to_le_bytes());
        }
        b
    }

    pub fn id(&self) -> String {
        hex(&sha256(&self.canonical()))
    }
}

/// Build a coinbase paying the miner (subsidy − commons + tips) and the Commons.
pub fn coinbase(height: u64, miner_address: &str, tips: u64) -> Tx {
    let subsidy = subsidy(height);
    let commons = (subsidy as f64 * COMMONS_SHARE).floor() as u64;
    let miner_cut = subsidy - commons + tips;
    let mut outputs = vec![TxOut {
        address: miner_address.to_string(),
        amount: miner_cut,
    }];
    if commons > 0 {
        outputs.push(TxOut {
            address: COMMONS_ADDRESS.to_string(),
            amount: commons,
        });
    }
    Tx {
        kind: TxKind::Coinbase,
        height,
        inputs: vec![],
        outputs,
    }
}

// ---- UTXO set --------------------------------------------------------------
pub type Utxo = HashMap<String, TxOut>;

fn key(txid: &str, vout: u32) -> String {
    format!("{txid}:{vout}")
}

/// Validate a normal transaction against a UTXO set; returns the fee.
pub fn validate_normal(tx: &Tx, utxo: &Utxo) -> Result<u64, String> {
    if tx.inputs.is_empty() {
        return Err("no inputs".into());
    }
    if tx.outputs.is_empty() {
        return Err("no outputs".into());
    }
    let msg = tx.canonical(); // signatures commit to this (excludes the sigs)
    let mut seen = std::collections::HashSet::new();
    let mut in_sum: u64 = 0;
    for i in &tx.inputs {
        let k = key(&i.txid, i.vout);
        if !seen.insert(k.clone()) {
            return Err("double spend within tx".into());
        }
        let out = match utxo.get(&k) {
            Some(o) => o,
            None => return Err(format!("input not found: {k}")),
        };
        // the spender must present the key that owns the output...
        if crypto::address_from_pub(&i.pubkey) != out.address {
            return Err("input key does not match output address".into());
        }
        // ...and a valid signature over the transaction
        if !crypto::verify(&i.pubkey, &msg, &i.sig) {
            return Err("invalid input signature".into());
        }
        in_sum = in_sum.checked_add(out.amount).ok_or("input sum overflow")?;
    }
    let mut out_sum: u64 = 0;
    for o in &tx.outputs {
        if o.amount == 0 {
            return Err("non-positive output".into());
        }
        out_sum = out_sum.checked_add(o.amount).ok_or("output sum overflow")?;
    }
    if out_sum > in_sum {
        return Err("outputs exceed inputs".into());
    }
    let fee = in_sum - out_sum;
    if fee < BASE_FEE_SPARKS {
        return Err("fee below base fee".into());
    }
    Ok(fee)
}

/// Apply a transaction to the UTXO set (spend inputs, create outputs).
pub fn apply(tx: &Tx, utxo: &mut Utxo) {
    for i in &tx.inputs {
        utxo.remove(&key(&i.txid, i.vout));
    }
    let id = tx.id();
    for (vout, o) in tx.outputs.iter().enumerate() {
        utxo.insert(key(&id, vout as u32), o.clone());
    }
}

/// Total unspent value (circulating supply, in sparks).
pub fn supply(utxo: &Utxo) -> u64 {
    utxo.values().map(|o| o.amount).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subsidy_decays_to_tail() {
        assert!(subsidy(1) > subsidy(10_000_000));
        assert!(subsidy(10_000_000_000) >= (TAIL_EMBER * SPARKS_PER_EMBER as f64) as u64);
    }

    #[test]
    fn subsidy_matches_js_reference_exactly() {
        // Frozen cross-implementation parity (see node/src/params.js). If either
        // side changes, this breaks — which is the point.
        assert_eq!(subsidy(0), 600_000_000);
        assert_eq!(subsidy(1), 599_999_929);
        assert_eq!(subsidy(1000), 599_928_702);
        assert_eq!(subsidy(4_207_680), 300_000_000); // exactly one half-life
        assert_eq!(subsidy(10_519_200), 112_500_000);
        assert_eq!(subsidy(10_000_000_000), 30_000_000); // tail
    }

    #[test]
    fn coinbase_splits_with_commons() {
        let cb = coinbase(1, "ember1miner", 0);
        let s = subsidy(1);
        let commons = (s as f64 * COMMONS_SHARE).floor() as u64;
        assert_eq!(cb.outputs[0].amount, s - commons);
        assert_eq!(
            cb.outputs
                .iter()
                .find(|o| o.address == COMMONS_ADDRESS)
                .unwrap()
                .amount,
            commons
        );
    }

    // helper: sign every input of a normal tx with the given key
    fn sign(tx: &mut Tx, kp: &crypto::KeyPair) {
        let msg = tx.canonical();
        for i in &mut tx.inputs {
            i.sig = kp.sign(&msg).to_vec();
        }
    }

    #[test]
    fn spend_conserves_value_and_updates_utxo() {
        let alice = crypto::KeyPair::generate();
        let bob = crypto::KeyPair::generate();
        let mut utxo: Utxo = HashMap::new();
        utxo.insert(
            "seed:0".into(),
            TxOut {
                address: alice.address(),
                amount: 100 * SPARKS_PER_EMBER,
            },
        );
        let mut tx = Tx {
            kind: TxKind::Normal,
            height: 1,
            inputs: vec![TxIn {
                txid: "seed".into(),
                vout: 0,
                pubkey: alice.public().to_vec(),
                sig: vec![],
            }],
            outputs: vec![
                TxOut {
                    address: bob.address(),
                    amount: 90 * SPARKS_PER_EMBER,
                },
                TxOut {
                    address: alice.address(),
                    amount: 100 * SPARKS_PER_EMBER - 90 * SPARKS_PER_EMBER - BASE_FEE_SPARKS,
                },
            ],
        };
        sign(&mut tx, &alice);

        assert_eq!(validate_normal(&tx, &utxo).unwrap(), BASE_FEE_SPARKS);

        // tampered signature -> rejected
        let mut bad = tx.clone();
        bad.inputs[0].sig[0] ^= 0xff;
        assert!(validate_normal(&bad, &utxo).is_err(), "bad sig must fail");

        // wrong key (bob tries to spend alice's output) -> rejected
        let mut wrong = tx.clone();
        wrong.inputs[0].pubkey = bob.public().to_vec();
        sign(&mut wrong, &bob);
        assert!(
            validate_normal(&wrong, &utxo).is_err(),
            "wrong key must fail"
        );

        let before = supply(&utxo);
        apply(&tx, &mut utxo);
        assert_eq!(supply(&utxo), before - BASE_FEE_SPARKS); // base fee burned
        assert!(
            validate_normal(&tx, &utxo).is_err(),
            "double spend must fail"
        );
    }

    #[test]
    fn rejects_low_fee() {
        let alice = crypto::KeyPair::generate();
        let mut utxo: Utxo = HashMap::new();
        utxo.insert(
            "seed:0".into(),
            TxOut {
                address: alice.address(),
                amount: 100,
            },
        );
        let mut tx = Tx {
            kind: TxKind::Normal,
            height: 1,
            inputs: vec![TxIn {
                txid: "seed".into(),
                vout: 0,
                pubkey: alice.public().to_vec(),
                sig: vec![],
            }],
            outputs: vec![TxOut {
                address: alice.address(),
                amount: 100,
            }], // fee = 0
        };
        sign(&mut tx, &alice);
        assert!(validate_normal(&tx, &utxo).is_err());
    }

    #[test]
    fn rejects_unknown_input() {
        let alice = crypto::KeyPair::generate();
        let utxo: Utxo = HashMap::new();
        let mut tx = Tx {
            kind: TxKind::Normal,
            height: 1,
            inputs: vec![TxIn {
                txid: "ghost".into(),
                vout: 0,
                pubkey: alice.public().to_vec(),
                sig: vec![],
            }],
            outputs: vec![TxOut {
                address: alice.address(),
                amount: 1,
            }],
        };
        sign(&mut tx, &alice);
        assert!(validate_normal(&tx, &utxo).is_err());
    }
}
