use axum::http::{HeaderMap, HeaderValue, header};

use crate::app::addresses::Address;
use crate::app::auth::passkeys::CHALLENGE_LIFE_MS;
use crate::app::refusal::{Refusal, Result};

const SESSION_ON_HTTPS: &str = "__Host-marfa.auth.session_token";
const SESSION: &str = "marfa.auth.session_token";
const SETUP: &str = "marfa.setup";
const PASSKEY_ON_HTTPS: &str = "__Host-marfa.auth.passkey_challenge";
const PASSKEY: &str = "marfa.auth.passkey_challenge";
const SESSION_MAX_AGE: i64 = 400 * 24 * 3600;
const SETUP_MAX_AGE: i64 = 15 * 60;
const PASSKEY_MAX_AGE: i64 = CHALLENGE_LIFE_MS / 1000;

fn session_name(address: &Address) -> &'static str {
    if address.is_https() {
        SESSION_ON_HTTPS
    } else {
        SESSION
    }
}

fn value(text: String) -> Result<HeaderValue> {
    HeaderValue::from_str(&text).map_err(|_| Refusal::internal("a cookie did not form"))
}

fn secure(address: &Address) -> &'static str {
    if address.is_https() { "; Secure" } else { "" }
}

pub fn session(address: &Address, token: &str, remembered: bool) -> Result<HeaderValue> {
    let name = session_name(address);
    let secure = secure(address);
    let age = if remembered {
        format!("; Max-Age={SESSION_MAX_AGE}")
    } else {
        String::new()
    };
    value(format!(
        "{name}={token}; Path=/; HttpOnly; SameSite=Lax{age}{secure}"
    ))
}

pub fn session_ended(address: &Address) -> Result<HeaderValue> {
    let name = session_name(address);
    let secure = secure(address);
    value(format!(
        "{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"
    ))
}

pub fn setup(address: &Address, token: &str) -> Result<HeaderValue> {
    let secure = secure(address);
    value(format!(
        "{SETUP}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SETUP_MAX_AGE}{secure}"
    ))
}

pub fn setup_ended(address: &Address) -> Result<HeaderValue> {
    let secure = secure(address);
    value(format!(
        "{SETUP}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}"
    ))
}

fn passkey_name(address: &Address) -> &'static str {
    if address.is_https() {
        PASSKEY_ON_HTTPS
    } else {
        PASSKEY
    }
}

pub fn passkey_challenge(address: &Address, token: &str) -> Result<HeaderValue> {
    let name = passkey_name(address);
    let secure = secure(address);
    value(format!(
        "{name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={PASSKEY_MAX_AGE}{secure}"
    ))
}

fn read<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == name).then_some(value)
        })
}

pub fn session_token<'h>(headers: &'h HeaderMap, address: &Address) -> Option<&'h str> {
    read(headers, session_name(address))
}

pub fn passkey_challenge_token<'h>(headers: &'h HeaderMap, address: &Address) -> Option<&'h str> {
    read(headers, passkey_name(address))
}

pub fn setup_token(headers: &HeaderMap) -> Option<&str> {
    read(headers, SETUP)
}

pub fn holds_setup(headers: &HeaderMap) -> bool {
    setup_token(headers).is_some()
}
