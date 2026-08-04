//! The OS keychain, used for the one thing it is actually good at.
//!
//! # What is stored here, and what is not
//!
//! NOT the private key. The key lives in `coinbase-keystore.json`, encrypted
//! under the user's passphrase (`node/src/mine/keystore.js`). What is stored
//! here is that PASSPHRASE, and only when the user ticks "remember on this
//! device", so that a machine which reboots at 4am starts mining again without
//! somebody typing into it.
//!
//! # Why that way round
//!
//! The tempting design is to put the key itself in the keychain and have no file
//! at all. It is stronger against a stolen laptop and much weaker against a dead
//! one: a keychain entry is not portable, is not obviously part of a backup, and
//! is gone when the disk is. The failure mode of "too weak" is a thief who needs
//! a passphrase; the failure mode of "not recoverable" is coins nobody can ever
//! spend again. A backup the user can copy — one file plus one passphrase they
//! know — is the design that survives the second one, and the keychain is a
//! convenience layered on top of it rather than the thing holding the money.
//!
//! Which is why every function here is ALLOWED TO FAIL. A Linux box with no
//! Secret Service, a locked login keychain, a user who says no to the prompt:
//! all of these mean "type your passphrase" and none of them may mean "you
//! cannot mine". The app degrades to asking, and says why.

const SERVICE: &str = "online.cloudsforge.hearth";

/// The account name for a given data directory, so two wallets on one machine
/// do not overwrite each other's remembered passphrase.
fn account(data_dir: &std::path::Path) -> String {
    format!("mining-keystore:{}", data_dir.display())
}

fn entry(data_dir: &std::path::Path) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &account(data_dir)).map_err(|e| e.to_string())
}

/// Remember the passphrase. An error here is reported and then ignored: the
/// keystore is already written, and failing the whole operation because a
/// convenience did not work would be worse than the convenience being absent.
pub fn remember(data_dir: &std::path::Path, passphrase: &str) -> Result<(), String> {
    entry(data_dir)?.set_password(passphrase).map_err(|e| e.to_string())
}

/// The remembered passphrase, or `None` when there is not one — which includes
/// every case where the platform has no keychain to ask.
pub fn recall(data_dir: &std::path::Path) -> Option<String> {
    entry(data_dir).ok()?.get_password().ok()
}

/// Forget it. Called when the user turns the setting off, and when the
/// passphrase changes — a stale entry that no longer opens the keystore is a
/// mystery ("it stopped remembering me") rather than an error.
pub fn forget(data_dir: &std::path::Path) -> Result<(), String> {
    match entry(data_dir)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Is there anything remembered for this directory? Answers the window's
/// "unlock automatically" tick box without pulling the secret out to look.
pub fn is_remembered(data_dir: &std::path::Path) -> bool {
    matches!(entry(data_dir).map(|e| e.get_password()), Ok(Ok(_)))
}
