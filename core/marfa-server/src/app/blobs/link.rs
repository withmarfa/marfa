//! The links the instance serves: a blob's hash and an expiry under a signature.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::hash::Hash;
use crate::app::refusal::{Refusal, Result};

/// The most seconds a link lives.
pub const MAX_TTL_SECONDS: u64 = 604_800;
pub const DEFAULT_TTL_SECONDS: u64 = 3600;

/// Keeps a link's key from being any other use of the instance's secret.
const KEY_LABEL: &[u8] = b"marfa-blob-link-key";
const MESSAGE_LABEL: &str = "marfa-blob-link\n";

pub struct Signer(Vec<u8>);

impl Signer {
    pub fn derive(secret: &str) -> Result<Signer> {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .map_err(|_| Refusal::internal("the link key was refused"))?;
        mac.update(KEY_LABEL);
        Ok(Signer(mac.finalize().into_bytes().to_vec()))
    }

    fn mac(&self, hash: &Hash, expires_ms: i64) -> Result<Hmac<Sha256>> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| Refusal::internal("the link key was refused"))?;
        mac.update(MESSAGE_LABEL.as_bytes());
        mac.update(hash.as_str().as_bytes());
        mac.update(b"\n");
        mac.update(expires_ms.to_string().as_bytes());
        Ok(mac)
    }

    pub fn sign(&self, hash: &Hash, expires_ms: i64) -> Result<String> {
        Ok(hex::encode(
            self.mac(hash, expires_ms)?.finalize().into_bytes(),
        ))
    }

    /// Whether `signature` is the one for these two values.
    pub fn verifies(&self, hash: &Hash, expires_ms: i64, signature: &str) -> bool {
        self.sign(hash, expires_ms)
            .is_ok_and(|expected| bool::from(expected.as_bytes().ct_eq(signature.as_bytes())))
    }
}

/// A `ttl` as seconds: a whole number of at least 1, held to the cap.
pub fn ttl_seconds(text: Option<&str>) -> Result<u64> {
    let Some(text) = text else {
        return Ok(DEFAULT_TTL_SECONDS);
    };
    let digits = text.trim_start_matches('0');
    let whole = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if !whole || digits.is_empty() {
        let message = "ttl must be a whole number of seconds, 1 or more.";
        return Err(Refusal::validation(message).with_detail(
            "errors",
            serde_json::json!([{ "path": "ttl", "message": message }]),
        ));
    }
    Ok(digits
        .parse::<u64>()
        .map_or(MAX_TTL_SECONDS, |seconds| seconds.min(MAX_TTL_SECONDS)))
}

pub fn url(origin: &str, hash: &Hash, expires_ms: i64, signature: &str) -> String {
    format!(
        "{origin}/blobs/{}/fetch?expires={expires_ms}&signature={signature}",
        hash.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash() -> Hash {
        Hash::parse(&format!("sha256:{}", "a".repeat(64))).unwrap()
    }

    fn secret(name: &str) -> String {
        format!("{name}-{}", std::process::id())
    }

    #[test]
    fn a_signature_holds_for_its_hash_and_expiry_only() {
        let signer = Signer::derive(&secret("instance")).unwrap();
        let signature = signer.sign(&hash(), 1_000).unwrap();
        assert!(signer.verifies(&hash(), 1_000, &signature));
        assert!(!signer.verifies(&hash(), 1_001, &signature));
        assert!(!signer.verifies(
            &Hash::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
            1_000,
            &signature
        ));
        let mut altered = signature.clone();
        altered.replace_range(0..1, if signature.starts_with('0') { "1" } else { "0" });
        assert!(!signer.verifies(&hash(), 1_000, &altered));
        assert!(!signer.verifies(&hash(), 1_000, ""));
    }

    #[test]
    fn another_instances_secret_signs_differently() {
        let one = Signer::derive(&secret("first")).unwrap();
        let other = Signer::derive(&secret("second")).unwrap();
        let signature = one.sign(&hash(), 5).unwrap();
        assert!(!other.verifies(&hash(), 5, &signature));
    }

    #[test]
    fn a_lifetime_defaults_to_an_hour_and_stops_at_the_cap() {
        assert_eq!(ttl_seconds(None).unwrap(), 3600);
        assert_eq!(ttl_seconds(Some("1")).unwrap(), 1);
        assert_eq!(ttl_seconds(Some("604800")).unwrap(), 604_800);
        assert_eq!(ttl_seconds(Some("604801")).unwrap(), 604_800);
        assert_eq!(
            ttl_seconds(Some("99999999999999999999999")).unwrap(),
            604_800
        );
        for wrong in ["0", "00", "-1", "1.5", "abc", "", "+5", " 5"] {
            assert!(ttl_seconds(Some(wrong)).is_err(), "{wrong:?}");
        }
    }
}
