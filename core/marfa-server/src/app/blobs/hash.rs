use crate::app::refusal::{Refusal, Result};

const PREFIX: &str = "sha256:";
const HEX_LEN: usize = 64;

/// A blob's name: `sha256:` and the 64 lowercase hex characters of a digest.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hash(String);

impl Hash {
    /// Takes the prefixed form and the bare 64 characters, and nothing else.
    pub fn parse(text: &str) -> Result<Hash> {
        let hex = text.strip_prefix(PREFIX).unwrap_or(text);
        let lowercase_hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
        if hex.len() == HEX_LEN && hex.bytes().all(lowercase_hex) {
            Ok(Hash(format!("{PREFIX}{hex}")))
        } else {
            Err(Refusal::validation("Invalid blob hash").with_detail("field", "hash"))
        }
    }

    pub fn from_digest(digest: &[u8]) -> Hash {
        Hash(format!("{PREFIX}{}", hex::encode(digest)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn hex(&self) -> &str {
        self.0.strip_prefix(PREFIX).unwrap_or(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn takes_the_prefixed_and_the_bare_form_as_one_hash() {
        let prefixed = Hash::parse(&format!("sha256:{HEX}")).unwrap();
        assert_eq!(prefixed, Hash::parse(HEX).unwrap());
        assert_eq!(prefixed.as_str(), format!("sha256:{HEX}"));
        assert_eq!(prefixed.hex(), HEX);
    }

    #[test]
    fn refuses_every_other_form() {
        let upper = HEX.to_uppercase();
        for form in [
            &HEX[1..],
            &format!("{HEX}0"),
            upper.as_str(),
            &format!("sha256:{upper}"),
            &format!("SHA256:{HEX}"),
            &format!("sha512:{HEX}"),
            &format!("sha256:{}", &HEX[1..]),
            &format!("sha256:sha256:{HEX}"),
            "not-a-hash",
            "",
        ] {
            let refused = Hash::parse(form).unwrap_err();
            assert_eq!(refused.code.wire(), "validation_error", "{form}");
        }
    }
}
