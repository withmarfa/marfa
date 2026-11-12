//! The mark a browser keeps once the right password signed in from it: a random id and the time
//! it was given, under a signature from the instance's secret. It names no one.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::app::refusal::{Refusal, Result};

pub const LIFE_MS: i64 = 400 * 24 * 3600 * 1000;
const ID_BYTES: usize = 16;
/// Keeps the mark's key from being any other use of the instance's secret.
const KEY_LABEL: &[u8] = b"marfa-known-device-key";
const MESSAGE_LABEL: &[u8] = b"marfa-known-device\n";

/// A device the right password signed in from, by the id its mark carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Known(String);

impl Known {
    pub fn id(&self) -> &str {
        &self.0
    }
}

fn signature(secret: &str, id: &str, issued_ms: i64) -> Result<Vec<u8>> {
    let refused = |_| Refusal::internal("the device mark's key was refused");
    let mut key = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(refused)?;
    key.update(KEY_LABEL);
    let mut mac = Hmac::<Sha256>::new_from_slice(&key.finalize().into_bytes()).map_err(refused)?;
    mac.update(MESSAGE_LABEL);
    mac.update(id.as_bytes());
    mac.update(b"\n");
    mac.update(issued_ms.to_string().as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

/// A fresh mark for `known`, or for a new device.
pub fn mark(secret: &str, known: Option<&Known>, now_ms: i64) -> Result<String> {
    let id = match known {
        Some(known) => known.0.clone(),
        None => {
            let mut bytes = [0u8; ID_BYTES];
            getrandom::fill(&mut bytes)
                .map_err(|_| Refusal::internal("no randomness was available"))?;
            hex::encode(bytes)
        }
    };
    let signed = hex::encode(signature(secret, &id, now_ms)?);
    Ok(format!("{id}.{now_ms}.{signed}"))
}

/// The device a mark names, if this instance signed it and it has not run out.
pub fn read(secret: &str, mark: &str, now_ms: i64) -> Option<Known> {
    let mut parts = mark.split('.');
    let (id, issued, signed) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some()
        || id.len() != ID_BYTES * 2
        || !id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        || !issued.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let issued_ms: i64 = issued.parse().ok()?;
    if issued != issued_ms.to_string() || now_ms >= issued_ms.saturating_add(LIFE_MS) {
        return None;
    }
    let expected = signature(secret, id, issued_ms).ok()?;
    let given = hex::decode(signed).ok()?;
    bool::from(expected.ct_eq(&given)).then(|| Known(id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "an instance secret for these tests only";

    #[test]
    fn a_mark_names_its_device_until_it_runs_out() {
        let value = mark(SECRET, None, 1_000).unwrap();
        let known = read(SECRET, &value, 1_000).expect("known");
        assert_eq!(
            read(SECRET, &value, 1_000 + LIFE_MS - 1),
            Some(known.clone())
        );
        assert_eq!(read(SECRET, &value, 1_000 + LIFE_MS), None);
        let renewed = mark(SECRET, Some(&known), 1_000 + LIFE_MS).unwrap();
        assert_eq!(read(SECRET, &renewed, 1_000 + LIFE_MS), Some(known));
    }

    #[test]
    fn a_mark_another_secret_signed_or_anyone_altered_is_no_mark() {
        let value = mark(SECRET, None, 1_000).unwrap();
        assert_eq!(read("another instance's secret", &value, 1_000), None);
        let (id, rest) = value.split_once('.').unwrap();
        let (_, signed) = rest.split_once('.').unwrap();
        let later = format!("{id}.{}.{signed}", 1_000 + LIFE_MS);
        assert_eq!(read(SECRET, &later, 1_500), None);
        let padded = format!("{id}.01000.{signed}");
        assert_eq!(read(SECRET, &padded, 1_500), None);
        let other = format!("{}.1000.{signed}", "0".repeat(ID_BYTES * 2));
        assert_eq!(read(SECRET, &other, 1_500), None);
        for broken in [
            "",
            "..",
            "x.1000.y",
            &format!("{value}.more"),
            &format!("{id}.1000"),
        ] {
            assert_eq!(read(SECRET, broken, 1_500), None, "{broken}");
        }
    }

    #[test]
    fn every_new_mark_names_a_new_device() {
        let one = read(SECRET, &mark(SECRET, None, 0).unwrap(), 0).unwrap();
        let two = read(SECRET, &mark(SECRET, None, 0).unwrap(), 0).unwrap();
        assert_ne!(one, two);
    }
}
