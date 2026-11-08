//! Signed confirmations bind one change to its credential and preview.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::app::refusal::{Refusal, Result};

/// How long a preview's token stays good, in milliseconds.
pub const LIFE_MS: i64 = 5 * 60 * 1000;

/// Keeps a confirmation's key from being any other use of the instance's secret.
const KEY_LABEL: &[u8] = b"marfa-mcp-confirmation-key";
const MESSAGE_LABEL: &str = "marfa-mcp-confirmation\n";
const SIGNATURE_CHARS: usize = 43;

#[derive(Clone)]
pub struct Signer(Vec<u8>);

pub struct Token {
    pub text: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    /// Signed for this credential and subject, and not yet expired.
    Valid,
    Malformed,
    Expired,
    /// Another tool's, another credential's, or over something that has since changed.
    Changed,
}

/// The signed token's expiry and signature.
pub struct Parsed {
    pub signature: String,
    pub expires_at_ms: i64,
}

pub fn parse(token: &str) -> Option<Parsed> {
    let (expires, signature) = token.split_once('.')?;
    let whole = !expires.is_empty()
        && expires.len() <= 15
        && expires.bytes().all(|byte| byte.is_ascii_digit());
    let plain = signature.len() == SIGNATURE_CHARS
        && signature
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    (whole && plain).then(|| Parsed {
        signature: signature.to_string(),
        expires_at_ms: expires.parse().unwrap_or(i64::MAX),
    })
}

/// What a preview covered, as text: the same items in any order give the same text.
pub fn subject_digest(ids: &[String], digest: &str) -> String {
    let mut sorted: Vec<&str> = ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.dedup();
    hex::encode(Sha256::digest(
        format!("{}\n{digest}", sorted.join("\n")).as_bytes(),
    ))
}

/// Hashes only requested IDs so retries match after the trash changes.
pub fn ids_digest(ids: &[String]) -> String {
    let mut sorted: Vec<&str> = ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.dedup();
    hex::encode(Sha256::digest(sorted.join("\n").as_bytes()))
}

impl Signer {
    pub fn derive(secret: &str) -> Result<Signer> {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .map_err(|_| Refusal::internal("the confirmation key was refused"))?;
        mac.update(KEY_LABEL);
        Ok(Signer(mac.finalize().into_bytes().to_vec()))
    }

    fn signature(
        &self,
        tool: &str,
        credential: &str,
        subject: &str,
        expires_ms: i64,
    ) -> Result<String> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| Refusal::internal("the confirmation key was refused"))?;
        mac.update(MESSAGE_LABEL.as_bytes());
        for part in [tool, credential, subject, &expires_ms.to_string()] {
            mac.update(&(part.len() as u64).to_be_bytes());
            mac.update(part.as_bytes());
        }
        Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
    }

    pub fn issue(&self, tool: &str, credential: &str, subject: &str, now_ms: i64) -> Result<Token> {
        let expires_at_ms = now_ms.saturating_add(LIFE_MS);
        let signature = self.signature(tool, credential, subject, expires_at_ms)?;
        Ok(Token {
            text: format!("{expires_at_ms}.{signature}"),
            expires_at_ms,
        })
    }

    pub fn check(
        &self,
        tool: &str,
        credential: &str,
        subject: &str,
        token: &str,
        now_ms: i64,
    ) -> Result<Check> {
        let Some(parsed) = parse(token) else {
            return Ok(Check::Malformed);
        };
        if parsed.expires_at_ms <= now_ms {
            return Ok(Check::Expired);
        }
        let expected = self.signature(tool, credential, subject, parsed.expires_at_ms)?;
        Ok(
            if bool::from(expected.as_bytes().ct_eq(parsed.signature.as_bytes())) {
                Check::Valid
            } else {
                Check::Changed
            },
        )
    }
}

/// A confirmation that was spent, and what it allowed.
pub struct Spent {
    pub credential: String,
    pub ids_digest: String,
    pub total: i64,
}

pub fn spent(tx: &Transaction<'_>, signature: &str) -> Result<Option<Spent>> {
    Ok(tx
        .query_row(
            "SELECT credential, subject_digest, total FROM mcp_spent_confirmations \
             WHERE token = ?1",
            params![signature],
            |row| {
                Ok(Spent {
                    credential: row.get(0)?,
                    ids_digest: row.get(1)?,
                    total: row.get(2)?,
                })
            },
        )
        .optional()?)
}

pub fn spend(
    tx: &Transaction<'_>,
    parsed: &Parsed,
    credential: &str,
    ids_digest: &str,
    total: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO mcp_spent_confirmations (token, credential, subject_digest, total, \
         expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            parsed.signature,
            credential,
            ids_digest,
            total,
            parsed.expires_at_ms
        ],
    )?;
    Ok(())
}

/// Removes expired records during the next confirmation write.
pub fn sweep(tx: &Transaction<'_>, now_ms: i64) -> Result<()> {
    tx.execute(
        "DELETE FROM mcp_spent_confirmations WHERE expires_at <= ?1",
        params![now_ms],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signer() -> Signer {
        Signer::derive(&format!("instance-{}", std::process::id())).unwrap()
    }

    #[test]
    fn a_token_holds_for_the_credential_and_subject_it_was_issued_for() {
        let signer = signer();
        let token = signer
            .issue("marfa_delete", "key-a", "subject", 1_000)
            .unwrap();
        assert_eq!(
            signer
                .check("marfa_delete", "key-a", "subject", &token.text, 2_000)
                .unwrap(),
            Check::Valid
        );
        for (tool, credential, subject) in [
            ("marfa_other", "key-a", "subject"),
            ("marfa_delete", "key-b", "subject"),
            ("marfa_delete", "key-a", "another"),
        ] {
            assert_eq!(
                signer
                    .check(tool, credential, subject, &token.text, 2_000)
                    .unwrap(),
                Check::Changed,
                "{tool} {credential} {subject}"
            );
        }
    }

    #[test]
    fn a_token_expires_five_minutes_after_it_was_issued() {
        let signer = signer();
        let token = signer
            .issue("marfa_delete", "key-a", "subject", 1_000)
            .unwrap();
        assert_eq!(token.expires_at_ms, 1_000 + LIFE_MS);
        assert_eq!(
            signer
                .check(
                    "marfa_delete",
                    "key-a",
                    "subject",
                    &token.text,
                    1_000 + LIFE_MS - 1
                )
                .unwrap(),
            Check::Valid
        );
        assert_eq!(
            signer
                .check(
                    "marfa_delete",
                    "key-a",
                    "subject",
                    &token.text,
                    1_000 + LIFE_MS
                )
                .unwrap(),
            Check::Expired
        );
    }

    #[test]
    fn a_token_that_is_not_one_is_malformed() {
        let signer = signer();
        for text in [
            "",
            "abc",
            "1.2",
            "x.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert_eq!(
                signer
                    .check("marfa_delete", "key-a", "subject", text, 0)
                    .unwrap(),
                Check::Malformed,
                "{text}"
            );
        }
    }

    #[test]
    fn the_same_items_in_any_order_are_one_subject() {
        let one = vec!["b".to_string(), "a".to_string()];
        let other = vec!["a".to_string(), "b".to_string(), "a".to_string()];
        assert_eq!(subject_digest(&one, "d"), subject_digest(&other, "d"));
        assert_ne!(subject_digest(&one, "d"), subject_digest(&one, "e"));
        assert_eq!(ids_digest(&one), ids_digest(&other));
    }
}
