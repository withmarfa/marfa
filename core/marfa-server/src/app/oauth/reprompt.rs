//! `prompt=login` and `max_age`: an authorization request only a new session satisfies.

use super::{CODE_SECONDS, MS_PER_SECOND};
use super::{signed_link, store};
use crate::app::App;
use crate::app::auth::session::Session;
use crate::app::clock::Stamp;
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

/// A sign-in dated after now is not recent.
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

/// Whether the app's consent asks for a browser session begun after this one.
pub(super) async fn began_before_asked(
    app: &App,
    client_id: &str,
    session: Option<&Session>,
) -> Result<bool> {
    let Some(session) = session else {
        return Ok(false);
    };
    let (client_id, owner_id) = (client_id.to_string(), session.owner_id.clone());
    let asked = app
        .db
        .read(move |tx| store::login_after(tx, &client_id, &owner_id))
        .await?;
    Ok(asked.is_some_and(|after| session.created_at.ms() < after.ms()))
}

/// The later of a code's own `max_age` bound and the time the app's consent asks for.
pub(super) fn later(one: Option<Stamp>, other: Option<Stamp>) -> Option<Stamp> {
    match (one, other) {
        (Some(one), Some(other)) => Some(if one.ms() >= other.ms() { one } else { other }),
        (one, other) => one.or(other),
    }
}

/// A session dated after now is not recent.
pub(super) fn began_since(session: &Session, after: Option<Stamp>, now: Stamp) -> bool {
    after.is_none_or(|after| (after.ms()..=now.ms()).contains(&session.created_at.ms()))
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
