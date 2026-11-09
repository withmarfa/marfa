//! `prompt=login`: an authorization request only a new session satisfies.

use super::signed_link;
use super::{CODE_SECONDS, MS_PER_SECOND};
use crate::app::App;
use crate::app::auth::session::Session;
use crate::app::refusal::Result;

const LOGIN: &str = "login";
const PROMPT: &str = "prompt";
const LOGIN_AFTER: &str = "login_after";
const LOGIN_FROM: &str = "login_from";

pub(super) fn asks_login(prompt: Option<&str>) -> bool {
    prompt.is_some_and(|prompt| prompt.split(' ').any(|word| word == LOGIN))
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
    prompt: Option<&str>,
    session: Option<&Session>,
) -> Result<String> {
    let now_ms = app.clock.now_ms();
    let now = now_ms / MS_PER_SECOND;
    params.push((PROMPT.to_string(), prompt.unwrap_or(LOGIN).to_string()));
    params.push((LOGIN_AFTER.to_string(), now_ms.to_string()));
    params.push((
        LOGIN_FROM.to_string(),
        session.map_or_else(String::new, |session| session.id.clone()),
    ));
    signed_link::sign(&params, now + CODE_SECONDS, &app.settings.start.auth_secret)
}
