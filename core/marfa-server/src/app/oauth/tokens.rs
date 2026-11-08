//! The secrets sign-in hands out. Each is stored only as its digest.

use crate::app::refusal::{Refusal, Result};

const ACCESS_PREFIX: &str = "marfa_at_";
const REFRESH_PREFIX: &str = "marfa_rt_";
const SECRET_BYTES: usize = 32;
const SECRET_HEX_LEN: usize = SECRET_BYTES * 2;

/// No `I`, `O`, `0` or `1`, which a person reading a code can confuse. Its 32
/// letters divide a byte evenly, so a modulo leaves no letter likelier.
const USER_CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LEN: usize = 8;

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(bytes)
}

fn secret() -> Result<String> {
    Ok(hex::encode(random::<SECRET_BYTES>()?))
}

pub fn new_access_token() -> Result<String> {
    Ok(format!("{ACCESS_PREFIX}{}", secret()?))
}

pub fn new_refresh_token() -> Result<String> {
    Ok(format!("{REFRESH_PREFIX}{}", secret()?))
}

pub fn new_authorization_code() -> Result<String> {
    secret()
}

pub fn new_device_code() -> Result<String> {
    secret()
}

pub fn new_user_code() -> Result<String> {
    let letters = random::<USER_CODE_LEN>()?
        .iter()
        .map(|byte| char::from(USER_CODE_ALPHABET[usize::from(byte % 32)]))
        .collect();
    Ok(letters)
}

fn is_secret(text: &str) -> bool {
    text.len() == SECRET_HEX_LEN
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn looks_like_access_token(text: &str) -> bool {
    text.strip_prefix(ACCESS_PREFIX).is_some_and(is_secret)
}

pub fn looks_like_refresh_token(text: &str) -> bool {
    text.strip_prefix(REFRESH_PREFIX).is_some_and(is_secret)
}

pub fn looks_like_code(text: &str) -> bool {
    is_secret(text)
}

/// A user code as a person may type it, as the one code it stands for: any
/// case, with dashes and spaces.
pub fn normalize_user_code(typed: &str) -> String {
    typed
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn each_token_has_its_shape_and_no_other() {
        let access = new_access_token().expect("a token");
        let refresh = new_refresh_token().expect("a token");
        let code = new_authorization_code().expect("a code");
        let device = new_device_code().expect("a code");
        assert!(looks_like_access_token(&access));
        assert!(!looks_like_refresh_token(&access));
        assert!(looks_like_refresh_token(&refresh));
        assert!(!looks_like_access_token(&refresh));
        assert_eq!(access.len(), "marfa_at_".len() + 64);
        assert!(looks_like_code(&code));
        assert!(looks_like_code(&device));
        assert!(!looks_like_code(&access));
    }

    #[test]
    fn a_token_refuses_what_is_not_quite_one() {
        let good = format!("marfa_rt_{}", "0".repeat(64));
        assert!(looks_like_refresh_token(&good));
        for text in [
            "",
            "marfa_rt_",
            "marfa_rt_never-issued-1",
            &format!("marfa_rt_{}", "0".repeat(63)),
            &format!("marfa_rt_{}", "0".repeat(65)),
            &format!("marfa_rt_{}", "A".repeat(64)),
            &format!("MARFA_RT_{}", "0".repeat(64)),
            &format!("{good}\n"),
        ] {
            assert!(!looks_like_refresh_token(text), "{text:?}");
        }
    }

    #[test]
    fn tokens_do_not_repeat() {
        let drawn: HashSet<String> = (0..1000)
            .map(|_| new_access_token().expect("a token"))
            .collect();
        assert_eq!(drawn.len(), 1000);
    }

    #[test]
    fn a_user_code_is_eight_clear_letters() {
        let mut seen = HashSet::new();
        for _ in 0..2000 {
            let code = new_user_code().expect("a code");
            assert_eq!(code.len(), 8);
            assert_eq!(normalize_user_code(&code), code);
            for letter in code.bytes() {
                assert!(USER_CODE_ALPHABET.contains(&letter));
                seen.insert(letter);
            }
        }
        assert_eq!(seen.len(), 32);
    }

    #[test]
    fn a_user_code_is_read_as_a_person_types_it() {
        for typed in ["abcd-2345", "ABCD 2345", " abcd2345\n", "ab-cd-23-45"] {
            assert_eq!(normalize_user_code(typed), "ABCD2345");
        }
        assert_eq!(normalize_user_code("\u{e9}\u{4e2d}-"), "");
    }
}
