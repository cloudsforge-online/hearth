//! Mempool: holds valid, non-conflicting pending transactions ordered by fee.
//!
//! New transactions are validated against the current UTXO set *minus* the
//! outputs already spent by pooled transactions, so a transaction that
//! double-spends a pooled input is rejected before it can reach a block.

use crate::ledger::{self, Tx, Utxo};
use std::collections::HashMap;

#[derive(Default)]
pub struct Mempool {
    entries: HashMap<String, (Tx, u64)>, // txid -> (tx, fee)
}

impl Mempool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Validate and admit a transaction. Returns its fee on success.
    pub fn add(&mut self, tx: Tx, utxo: &Utxo) -> Result<u64, String> {
        let id = tx.id();
        if self.entries.contains_key(&id) {
            return Err("already in mempool".into());
        }
        // apply already-pooled spends so conflicts are caught
        let mut scratch = utxo.clone();
        for (t, _) in self.entries.values() {
            ledger::apply(t, &mut scratch);
        }
        let fee = ledger::validate_normal(&tx, &scratch)?;
        self.entries.insert(id, (tx, fee));
        Ok(fee)
    }

    /// Highest-fee-first selection for block assembly.
    pub fn select(&self, max: usize) -> Vec<Tx> {
        let mut v: Vec<&(Tx, u64)> = self.entries.values().collect();
        v.sort_by_key(|e| std::cmp::Reverse(e.1));
        v.into_iter().take(max).map(|(t, _)| t.clone()).collect()
    }

    pub fn remove(&mut self, ids: &[String]) {
        for id in ids {
            self.entries.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::KeyPair;
    use crate::ledger::{Tx, TxIn, TxKind, TxOut, BASE_FEE_SPARKS};

    fn funded(kp: &KeyPair, outpoints: &[(&str, u64)]) -> Utxo {
        let mut u = Utxo::new();
        for (name, amount) in outpoints {
            u.insert(
                format!("{name}:0"),
                TxOut {
                    address: kp.address(),
                    amount: *amount,
                },
            );
        }
        u
    }

    fn spend(kp: &KeyPair, from: &str, to: &str, amount: u64, fee: u64) -> Tx {
        let mut tx = Tx {
            kind: TxKind::Normal,
            height: 1,
            inputs: vec![TxIn {
                txid: from.into(),
                vout: 0,
                pubkey: kp.public().to_vec(),
                sig: vec![],
            }],
            outputs: vec![TxOut {
                address: to.into(),
                amount: amount - fee,
            }],
        };
        let msg = tx.canonical();
        tx.inputs[0].sig = kp.sign(&msg).to_vec();
        tx
    }

    #[test]
    fn admits_and_orders_by_fee() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate().address();
        let utxo = funded(&alice, &[("a", 1_000_000), ("b", 2_000_000)]);
        let mut mp = Mempool::new();

        let low = spend(&alice, "a", &bob, 1_000_000, BASE_FEE_SPARKS);
        let high = spend(&alice, "b", &bob, 2_000_000, BASE_FEE_SPARKS * 5);
        assert!(mp.add(low, &utxo).is_ok());
        assert!(mp.add(high, &utxo).is_ok());
        assert_eq!(mp.len(), 2);

        // highest fee first
        let picked = mp.select(10);
        assert_eq!(picked[0].outputs[0].amount, 2_000_000 - BASE_FEE_SPARKS * 5);
    }

    #[test]
    fn rejects_pooled_double_spend() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate().address();
        let utxo = funded(&alice, &[("a", 1_000_000)]);
        let mut mp = Mempool::new();

        let t1 = spend(&alice, "a", &bob, 1_000_000, BASE_FEE_SPARKS);
        let t2 = spend(&alice, "a", &bob, 1_000_000, BASE_FEE_SPARKS * 2); // same input
        assert!(mp.add(t1, &utxo).is_ok());
        assert!(
            mp.add(t2, &utxo).is_err(),
            "double spend of a pooled input must fail"
        );
    }

    #[test]
    fn remove_clears_included() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate().address();
        let utxo = funded(&alice, &[("a", 1_000_000)]);
        let mut mp = Mempool::new();
        let t = spend(&alice, "a", &bob, 1_000_000, BASE_FEE_SPARKS);
        let id = t.id();
        mp.add(t, &utxo).unwrap();
        mp.remove(&[id]);
        assert!(mp.is_empty());
    }
}
