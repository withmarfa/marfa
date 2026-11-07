//! A key's secret text, and the hash the database holds in its place.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::app::refusal::{Refusal, Result};

const PREFIX: &str = "marfa_k1_";
const SECRET_BYTES: usize = 32;
const SECRET_HEX_LEN: usize = SECRET_BYTES * 2;

pub fn new_secret() -> Result<String> {
    let mut bytes = [0u8; SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(format!("{PREFIX}{}", hex::encode(bytes)))
}

/// Whether `text` has the shape [`new_secret`] gives, so nothing else is
/// hashed or looked up.
pub fn looks_like_a_key(text: &str) -> bool {
    text.strip_prefix(PREFIX).is_some_and(|rest| {
        rest.len() == SECRET_HEX_LEN
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub fn hash(salt: &str, secret: &str) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(salt.as_bytes())
        .map_err(|_| Refusal::internal("the key hash refused its salt"))?;
    mac.update(secret.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_shape_of_a_secret_is_taken_for_a_key() {
        let good = new_secret().unwrap();
        assert!(looks_like_a_key(&good));
        let same_length = format!("marfa_k2_{}", "0".repeat(SECRET_HEX_LEN));
        assert_eq!(same_length.len(), good.len());
        for text in [
            same_length.as_str(),
            PREFIX,
            "marfa_k1_short",
            &good[..good.len() - 1],
            &format!("{good}0"),
            &good.to_uppercase(),
            &format!("{}{}", PREFIX, "g".repeat(SECRET_HEX_LEN)),
            &format!("{}{}", PREFIX, "é".repeat(SECRET_HEX_LEN / 2)),
        ] {
            assert!(!looks_like_a_key(text), "{text}");
        }
    }
}
