//! Signed confirmations bind one change to its credential and preview.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::app::clock::{Stamp, Unread, readable};
use crate::app::refusal::{Refusal, Result};

/// How long a preview's token stays good, in milliseconds.
pub const LIFE_MS: i64 = 5 * 60 * 1000;

/// Keeps a confirmation's key from being any other use of the instance's secret.
const KEY_LABEL: &[u8] = b"marfa-mcp-confirmation-key";
const MESSAGE_LABEL: &str = "marfa-mcp-confirmation\n";
const TARGET_LABEL: &str = "marfa-mcp-confirmation-target\n";
const SIGNATURE_CHARS: usize = 43;

#[derive(Clone)]
pub struct Signer(Vec<u8>);

pub struct Token {
    pub text: String,
    pub expires_at: Stamp,
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

fn expiry_of(expires: &str) -> Option<i64> {
    let whole = !expires.is_empty()
        && expires.len() <= 15
        && expires.bytes().all(|byte| byte.is_ascii_digit());
    whole.then(|| expires.parse().unwrap_or(i64::MAX))
}

fn is_signature(text: &str) -> bool {
    text.len() == SIGNATURE_CHARS
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn parse(token: &str) -> Option<Parsed> {
    let (expires, signature) = token.split_once('.')?;
    let expires_at_ms = expiry_of(expires)?;
    is_signature(signature).then(|| Parsed {
        signature: signature.to_string(),
        expires_at_ms,
    })
}

/// A confirmation of an owner's destructive tool, whose target is judged before the target is read.
pub struct Bound {
    pub expires_at_ms: i64,
    target: String,
    /// The subject's signature, which also keys the spent record.
    pub signature: String,
}

pub fn parse_bound(token: &str) -> Option<Bound> {
    let mut parts = token.split('.');
    let (Some(expires), Some(target), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    let expires_at_ms = expiry_of(expires)?;
    (is_signature(target) && is_signature(signature)).then(|| Bound {
        expires_at_ms,
        target: target.to_string(),
        signature: signature.to_string(),
    })
}

/// What a bound confirmation allows before its target is read.
#[derive(Debug, PartialEq, Eq)]
pub enum Opening {
    /// Signed for this credential and target, unspent and unexpired: read the target next.
    Open,
    /// This credential's confirmation of this target was spent on the change it allowed.
    Spent { total: i64 },
    /// Another tool's, credential's or target's, or expired.
    Stale,
}

/// Whether the token is well formed and its time has passed.
pub fn is_expired(token: &str, now_ms: i64) -> bool {
    parse(token).is_some_and(|parsed| parsed.expires_at_ms <= now_ms)
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
        self.signed(MESSAGE_LABEL, tool, credential, subject, expires_ms)
    }

    fn signed(
        &self,
        label: &str,
        tool: &str,
        credential: &str,
        subject: &str,
        expires_ms: i64,
    ) -> Result<String> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| Refusal::internal("the confirmation key was refused"))?;
        mac.update(label.as_bytes());
        for part in [tool, credential, subject, &expires_ms.to_string()] {
            mac.update(&(part.len() as u64).to_be_bytes());
            mac.update(part.as_bytes());
        }
        Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
    }

    pub fn issue(&self, tool: &str, credential: &str, subject: &str, now_ms: i64) -> Result<Token> {
        let expires_at = Stamp::from_ms(now_ms.saturating_add(LIFE_MS))?;
        let signature = self.signature(tool, credential, subject, expires_at.ms())?;
        Ok(Token {
            text: format!("{}.{signature}", expires_at.ms()),
            expires_at,
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

    /// A confirmation whose target is signed apart from its subject, to be checked unread.
    pub fn issue_bound(
        &self,
        tool: &str,
        credential: &str,
        target: &str,
        subject: &str,
        now_ms: i64,
    ) -> Result<Token> {
        let expires_at = Stamp::from_ms(now_ms.saturating_add(LIFE_MS))?;
        let ms = expires_at.ms();
        let target = self.signed(TARGET_LABEL, tool, credential, target, ms)?;
        let subject = self.signature(tool, credential, subject, ms)?;
        Ok(Token {
            text: format!("{ms}.{target}.{subject}"),
            expires_at,
        })
    }

    fn holds_target(
        &self,
        tool: &str,
        credential: &str,
        target: &str,
        bound: &Bound,
    ) -> Result<bool> {
        let expected = self.signed(TARGET_LABEL, tool, credential, target, bound.expires_at_ms)?;
        Ok(bool::from(
            expected.as_bytes().ct_eq(bound.target.as_bytes()),
        ))
    }

    /// Whether the target as read now is the subject the preview signed.
    pub fn holds_subject(
        &self,
        tool: &str,
        credential: &str,
        subject: &str,
        bound: &Bound,
    ) -> Result<bool> {
        let expected = self.signature(tool, credential, subject, bound.expires_at_ms)?;
        Ok(bool::from(
            expected.as_bytes().ct_eq(bound.signature.as_bytes()),
        ))
    }

    /// Judges a bound confirmation in the write that would spend it, without reading its target.
    pub fn open(
        &self,
        tx: &Transaction<'_>,
        tool: &str,
        credential: &str,
        target: &str,
        bound: &Bound,
        now: Stamp,
    ) -> Result<Opening> {
        if !self.holds_target(tool, credential, target, bound)? {
            return Ok(Opening::Stale);
        }
        sweep(tx, now)?;
        if let Some(spent) = spent(tx, &bound.signature)? {
            return Ok(
                if spent.credential == credential && spent.ids_digest == target {
                    Opening::Spent { total: spent.total }
                } else {
                    Opening::Stale
                },
            );
        }
        if bound.expires_at_ms <= now.ms() {
            return Ok(Opening::Stale);
        }
        Ok(Opening::Open)
    }
}

/// Records a bound confirmation as spent, in the transaction of the change it allowed.
pub fn spend_bound(
    tx: &Transaction<'_>,
    bound: &Bound,
    credential: &str,
    target: &str,
    total: i64,
) -> Result<()> {
    spend(
        tx,
        &Parsed {
            signature: bound.signature.clone(),
            expires_at_ms: bound.expires_at_ms,
        },
        credential,
        target,
        total,
    )
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
            Stamp::from_ms(parsed.expires_at_ms)?
        ],
    )?;
    Ok(())
}

pub const UNREAD: Unread<'static> = Unread {
    table: "mcp_spent_confirmations",
    time: "expires_at",
    scope: "1",
};

/// Removes expired records during the next confirmation write.
pub fn sweep(tx: &Transaction<'_>, now: Stamp) -> Result<()> {
    tx.execute(
        &format!(
            "DELETE FROM mcp_spent_confirmations WHERE {} AND expires_at <= ?1",
            readable("expires_at")
        ),
        params![now],
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
        assert_eq!(token.expires_at.ms(), 1_000 + LIFE_MS);
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

    #[test]
    fn a_bound_token_signs_its_target_apart_from_its_subject() {
        let signer = signer();
        let token = signer
            .issue_bound("marfa_purge", "key-a", "target", "subject", 1_000)
            .unwrap();
        let bound = parse_bound(&token.text).unwrap();
        assert!(
            signer
                .holds_target("marfa_purge", "key-a", "target", &bound)
                .unwrap()
        );
        assert!(
            signer
                .holds_subject("marfa_purge", "key-a", "subject", &bound)
                .unwrap()
        );
        for (tool, credential, target) in [
            ("marfa_other", "key-a", "target"),
            ("marfa_purge", "key-b", "target"),
            ("marfa_purge", "key-a", "subject"),
        ] {
            assert!(
                !signer
                    .holds_target(tool, credential, target, &bound)
                    .unwrap(),
                "{tool} {credential} {target}"
            );
        }
        assert!(
            !signer
                .holds_subject("marfa_purge", "key-a", "changed", &bound)
                .unwrap()
        );
    }

    #[test]
    fn a_bound_token_and_a_plain_one_are_never_read_as_each_other() {
        let signer = signer();
        let bound = signer
            .issue_bound("marfa_purge", "key-a", "target", "subject", 1_000)
            .unwrap();
        let plain = signer
            .issue("marfa_delete", "key-a", "subject", 1_000)
            .unwrap();
        assert!(parse(&bound.text).is_none());
        assert!(parse_bound(&plain.text).is_none());
        let signature = "A".repeat(SIGNATURE_CHARS);
        assert!(parse_bound(&format!("1.{signature}.{signature}.{signature}")).is_none());
        assert!(parse_bound(&format!("x.{signature}.{signature}")).is_none());
    }

    fn spent_table() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE mcp_spent_confirmations (token TEXT PRIMARY KEY NOT NULL, \
                 credential TEXT NOT NULL, subject_digest TEXT NOT NULL, \
                 total INTEGER NOT NULL, expires_at TEXT NOT NULL) STRICT, WITHOUT ROWID;",
            )
            .unwrap();
        connection
    }

    #[test]
    fn a_bound_token_is_judged_by_its_target_then_its_spend_then_its_expiry() {
        let signer = signer();
        let mut connection = spent_table();
        let tx = connection.transaction().unwrap();
        let token = signer
            .issue_bound("marfa_purge", "key-a", "target", "subject", 1_000)
            .unwrap();
        let bound = parse_bound(&token.text).unwrap();
        let at = |ms: i64| Stamp::from_ms(ms).unwrap();
        let open = |credential: &str, target: &str, ms: i64| {
            signer
                .open(&tx, "marfa_purge", credential, target, &bound, at(ms))
                .unwrap()
        };
        assert_eq!(open("key-a", "target", 2_000), Opening::Open);
        assert_eq!(open("key-b", "target", 2_000), Opening::Stale);
        assert_eq!(open("key-a", "other", 2_000), Opening::Stale);
        assert_eq!(open("key-a", "target", 1_000 + LIFE_MS), Opening::Stale);
        spend_bound(&tx, &bound, "key-a", "target", 3).unwrap();
        assert_eq!(open("key-a", "target", 2_000), Opening::Spent { total: 3 });
        assert_eq!(open("key-b", "target", 2_000), Opening::Stale);
        // A spent record lasts as long as the token, and no longer.
        assert_eq!(open("key-a", "target", 1_000 + LIFE_MS), Opening::Stale);
        assert_eq!(open("key-a", "target", 2_000), Opening::Open);
    }
}
