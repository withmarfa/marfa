//! A key's secret text, and the hash the database holds in its place.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::app::refusal::{Refusal, Result};

const PREFIX: &str = "marfa_k1_";

pub fn new_secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(format!("{PREFIX}{}", hex::encode(bytes)))
}

pub fn looks_like_a_key(text: &str) -> bool {
    text.starts_with(PREFIX)
}

pub fn hash(salt: &str, secret: &str) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(salt.as_bytes())
        .map_err(|_| Refusal::internal("the key hash refused its salt"))?;
    mac.update(secret.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}
