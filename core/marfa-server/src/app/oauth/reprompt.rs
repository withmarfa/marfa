//! `prompt=login` and `max_age`: an authorization request only a new session satisfies.

use super::signed_link;
use super::{CODE_SECONDS, MS_PER_SECOND};
use crate::app::App;
use crate::app::auth::session::Session;
use crate::app::refusal::Result;

const LOGIN: &str = "login";
const NONE: &str = "none";
const PROMPT: &str = "prompt";
const LOGIN_AFTER: &str = "login_after";
const LOGIN_FROM: &str = "login_from";

pub(super) fn asks_login(prompt: Option<&str>) -> bool {
    prompt.is_some_and(|prompt| prompt.split(' ').any(|word| word == LOGIN))
}

pub(super) fn asks_none(prompt: Option<&str>) -> bool {
    prompt.is_some_and(|prompt| prompt.split(' ').any(|word| word == NONE))
}

pub(super) fn with_login(prompt: Option<&str>) -> String {
    match prompt {
        Some(prompt) if asks_login(Some(prompt)) => prompt.to_string(),
        Some(prompt) => format!("{prompt} {LOGIN}"),
        None => LOGIN.to_string(),
    }
}

/// OpenID Connect Core section 3.1.2.1: seconds, as digits alone.
pub(super) fn max_age(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<i64>().ok()?.checked_mul(MS_PER_SECOND)
}

/// Whether `max_age` asks for a sign-in newer than `session`'s. A sign-in dated after now
/// is not counted as recent.
pub(super) fn signed_in_too_long_ago(
    app: &App,
    max_age_text: Option<&str>,
    session: Option<&Session>,
) -> bool {
    let Some(limit) = max_age_text.and_then(max_age) else {
        return false;
    };
    let now = app.clock.now_ms();
    session
        .is_none_or(|session| !(0..=limit).contains(&now.saturating_sub(session.created_at.ms())))
}

pub(super) fn without_login(prompt: Option<&str>) -> Option<String> {
    let rest: Vec<&str> = prompt?.split(' ').filter(|word| *word != LOGIN).collect();
    (!rest.is_empty()).then(|| rest.join(" "))
}

/// The ID covers a sign-in within the same millisecond as the request; the time covers
/// a link opened in a browser that signed in earlier.
pub(super) fn signed_in_since(app: &App, query: &str, session: Option<&Session>) -> bool {
    let now = app.clock.now_ms() / MS_PER_SECOND;
    let Ok(link) = signed_link::verify(query, now, &app.settings.start.auth_secret) else {
        return false;
    };
    let after = link.get(LOGIN_AFTER).and_then(|at| at.parse::<i64>().ok());
    match (session, after, link.get(LOGIN_FROM)) {
        (Some(session), Some(after), Some(from)) => {
            from != session.id && session.created_at.ms() >= after
        }
        _ => false,
    }
}

pub(super) fn signed_request(
    app: &App,
    mut params: Vec<(String, String)>,
    prompt: &str,
    session: Option<&Session>,
) -> Result<String> {
    let now_ms = app.clock.now_ms();
    let now = now_ms / MS_PER_SECOND;
    params.push((PROMPT.to_string(), prompt.to_string()));
    params.push((LOGIN_AFTER.to_string(), now_ms.to_string()));
    params.push((
        LOGIN_FROM.to_string(),
        session.map_or_else(String::new, |session| session.id.clone()),
    ));
    signed_link::sign(&params, now + CODE_SECONDS, &app.settings.start.auth_secret)
}
