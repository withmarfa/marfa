//! Proof Key for Code Exchange (RFC 7636), by S256 alone.

use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const METHOD: &str = "S256";

const CHALLENGE_LEN: usize = 43;
const VERIFIER_LEN: std::ops::RangeInclusive<usize> = 43..=128;

/// Whether a request's `code_challenge_method` is the one this server takes.
/// One left out means `plain` (RFC 7636 section 4.3), which it does not.
pub fn takes_method(method: Option<&str>) -> bool {
    method == Some(METHOD)
}

/// A SHA-256 digest in unpadded base64url is always 43 characters.
pub fn is_challenge(text: &str) -> bool {
    text.len() == CHALLENGE_LEN
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

/// `code-verifier` of RFC 7636 section 4.1.
pub fn is_verifier(text: &str) -> bool {
    VERIFIER_LEN.contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
}

/// Whether `verifier` proves `challenge`.
pub fn proves(verifier: &str, challenge: &str) -> bool {
    if !is_verifier(verifier) {
        return false;
    }
    let digest = BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    digest.as_bytes().ct_eq(challenge.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    #[test]
    fn rfc_7636_appendix_b() {
        assert!(is_verifier(VERIFIER));
        assert!(is_challenge(CHALLENGE));
        assert!(proves(VERIFIER, CHALLENGE));
    }

    #[test]
    fn another_verifier_or_challenge_proves_nothing() {
        let other = VERIFIER.replace('d', "e");
        assert!(is_verifier(&other));
        assert!(!proves(&other, CHALLENGE));
        assert!(!proves(VERIFIER, &CHALLENGE.replace('E', "F")));
        assert!(!proves(VERIFIER, ""));
        assert!(!proves(VERIFIER, VERIFIER));
    }

    #[test]
    fn plain_never_passes_for_s256() {
        assert!(!proves(VERIFIER, VERIFIER));
        for method in [None, Some("plain"), Some("s256"), Some("S256 "), Some("")] {
            assert!(!takes_method(method), "{method:?}");
        }
        assert!(takes_method(Some("S256")));
    }

    #[test]
    fn the_grammars_hold_at_their_edges() {
        assert!(is_verifier(&"a".repeat(43)));
        assert!(is_verifier(&"a".repeat(128)));
        assert!(!is_verifier(&"a".repeat(42)));
        assert!(!is_verifier(&"a".repeat(129)));
        assert!(!is_verifier(&format!("{}+", "a".repeat(42))));
        assert!(!is_verifier(&format!("{}\u{e9}", "a".repeat(41))));
        assert!(is_challenge("0123456789012345678901234567890123456789012"));
        assert!(!is_challenge(&"a".repeat(42)));
        assert!(!is_challenge(&"a".repeat(44)));
        assert!(!is_challenge(&format!("{}=", "a".repeat(42))));
        assert!(!is_challenge(&format!("{}+", "a".repeat(42))));
    }

    proptest! {
        #[test]
        fn nothing_panics_on_any_text(verifier in any::<String>(), challenge in any::<String>()) {
            let _ = is_verifier(&verifier);
            let _ = is_challenge(&challenge);
            prop_assert!(!proves(&verifier, &challenge) || is_verifier(&verifier));
        }

        #[test]
        fn a_verifier_proves_the_challenge_made_from_it(verifier in "[A-Za-z0-9._~-]{43,128}") {
            let challenge = BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            prop_assert!(is_challenge(&challenge));
            prop_assert!(proves(&verifier, &challenge));
        }
    }
}
