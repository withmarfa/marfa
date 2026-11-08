//! Telling a password-protected Office file before anything tries to read it.

use std::io::Cursor;

use crate::Refusal;

/// The first bytes of a compound file, which is what Office wraps an encrypted
/// package in.
const COMPOUND_FILE: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/// Refuses a compound file that holds an encrypted package. Any other bytes
/// pass, for the reader to judge.
pub(crate) fn refuse_if_wrapped(bytes: &[u8]) -> Result<(), Refusal> {
    if !bytes.starts_with(&COMPOUND_FILE) {
        return Ok(());
    }
    // A compound file that cannot be opened is not an encrypted package, and
    // the reader that was meant to take it says why.
    match cfb::CompoundFile::open(Cursor::new(bytes)) {
        Ok(file) if file.exists("/EncryptionInfo") => Err(Refusal::Encrypted),
        _ => Ok(()),
    }
}
