//! The mark a browser keeps once the right password signed in from it: a random id and the time
//! it was given, signed for the owner's credentials as they stood. It names no one.

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

/// Who a mark is for: the owner, and their credentials as they stand.
#[derive(Clone, Copy, Debug)]
pub struct Holder<'a> {
    pub owner_id: &'a str,
    pub credentials: i64,
}

pub struct Signer(Vec<u8>);

impl Signer {
    pub fn derive(secret: &str) -> Result<Signer> {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .map_err(|_| Refusal::internal("the device mark's key was refused"))?;
        mac.update(KEY_LABEL);
        Ok(Signer(mac.finalize().into_bytes().to_vec()))
    }

    fn signature(&self, holder: Holder<'_>, id: &str, issued_ms: i64) -> Result<Vec<u8>> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| Refusal::internal("the device mark's key was refused"))?;
        mac.update(MESSAGE_LABEL);
        for part in [
            holder.owner_id,
            &holder.credentials.to_string(),
            id,
            &issued_ms.to_string(),
        ] {
            mac.update(part.as_bytes());
            mac.update(b"\n");
        }
        Ok(mac.finalize().into_bytes().to_vec())
    }

    /// A fresh mark for `known`, or for a new device.
    pub fn mark(&self, holder: Holder<'_>, known: Option<&Known>, now_ms: i64) -> Result<String> {
        let id = match known {
            Some(known) => known.0.clone(),
            None => {
                let mut bytes = [0u8; ID_BYTES];
                getrandom::fill(&mut bytes)
                    .map_err(|_| Refusal::internal("no randomness was available"))?;
                hex::encode(bytes)
            }
        };
        let signed = hex::encode(self.signature(holder, &id, now_ms)?);
        Ok(format!("{id}.{now_ms}.{signed}"))
    }

    /// The device a mark names, if it was signed for `holder` and has not run out.
    pub fn read(&self, holder: Holder<'_>, mark: &str, now_ms: i64) -> Option<Known> {
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
        let expected = self.signature(holder, id, issued_ms).ok()?;
        let given = hex::decode(signed).ok()?;
        bool::from(expected.ct_eq(&given)).then(|| Known(id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOLDER: Holder<'static> = Holder {
        owner_id: "owner",
        credentials: 0,
    };

    fn signer() -> Signer {
        Signer::derive("an instance secret for these tests only").unwrap()
    }

    #[test]
    fn a_mark_names_its_device_until_it_runs_out() {
        let signer = signer();
        let value = signer.mark(HOLDER, None, 1_000).unwrap();
        let known = signer.read(HOLDER, &value, 1_000).expect("known");
        assert_eq!(
            signer.read(HOLDER, &value, 1_000 + LIFE_MS - 1),
            Some(known.clone())
        );
        assert_eq!(signer.read(HOLDER, &value, 1_000 + LIFE_MS), None);
        let renewed = signer.mark(HOLDER, Some(&known), 1_000 + LIFE_MS).unwrap();
        assert_eq!(signer.read(HOLDER, &renewed, 1_000 + LIFE_MS), Some(known));
    }

    #[test]
    fn a_mark_stands_only_for_the_credentials_it_was_signed_for() {
        let signer = signer();
        let value = signer.mark(HOLDER, None, 1_000).unwrap();
        assert!(signer.read(HOLDER, &value, 1_000).is_some());
        let renewed = Holder {
            credentials: 1,
            ..HOLDER
        };
        assert_eq!(signer.read(renewed, &value, 1_000), None);
        let other = Holder {
            owner_id: "another owner",
            ..HOLDER
        };
        assert_eq!(signer.read(other, &value, 1_000), None);
    }

    #[test]
    fn a_mark_another_secret_signed_or_anyone_altered_is_no_mark() {
        let signer = signer();
        let value = signer.mark(HOLDER, None, 1_000).unwrap();
        let elsewhere = Signer::derive("another instance's secret").unwrap();
        assert_eq!(elsewhere.read(HOLDER, &value, 1_000), None);
        let (id, rest) = value.split_once('.').unwrap();
        let (_, signed) = rest.split_once('.').unwrap();
        let later = format!("{id}.{}.{signed}", 1_000 + LIFE_MS);
        assert_eq!(signer.read(HOLDER, &later, 1_500), None);
        let padded = format!("{id}.01000.{signed}");
        assert_eq!(signer.read(HOLDER, &padded, 1_500), None);
        let other = format!("{}.1000.{signed}", "0".repeat(ID_BYTES * 2));
        assert_eq!(signer.read(HOLDER, &other, 1_500), None);
        for broken in [
            "",
            "..",
            "x.1000.y",
            &format!("{value}.more"),
            &format!("{id}.1000"),
        ] {
            assert_eq!(signer.read(HOLDER, broken, 1_500), None, "{broken}");
        }
    }

    #[test]
    fn every_new_mark_names_a_new_device() {
        let signer = signer();
        let one = signer
            .read(HOLDER, &signer.mark(HOLDER, None, 0).unwrap(), 0)
            .unwrap();
        let two = signer
            .read(HOLDER, &signer.mark(HOLDER, None, 0).unwrap(), 0)
            .unwrap();
        assert_ne!(one, two);
    }
}
