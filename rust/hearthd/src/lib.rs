//! Hearth production node core (library).
//!
//! Modules build up a full node from a zero-fragile-dependency base:
//!   * [`sha256`]     — FIPS 180-4 hash (pure std)
//!   * [`pow`]        — Homefire memory-hard proof-of-work (pure std)
//!   * [`crypto`]     — Ed25519 keys, checksummed addresses, signatures
//!   * [`ledger`]     — UTXO model, emission, Commons split, base-fee, signatures
//!   * [`mempool`]    — fee-ordered pending transactions, double-spend safe
//!   * [`difficulty`] — LWMA retargeting
//!   * [`netmsg`]     — P2P wire framing
//!   * [`tab`]        — off-chain payment channels
//!
//! The binary (`main.rs`) is a thin CLI/benchmark over this library.

pub mod crypto;
pub mod difficulty;
pub mod ledger;
pub mod mempool;
pub mod netmsg;
pub mod pow;
pub mod sha256;
pub mod tab;
