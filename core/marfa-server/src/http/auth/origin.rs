use axum::http::header::{ORIGIN, REFERER};
use axum::http::{HeaderMap, HeaderValue};

use crate::app::refusal::{Code, Refusal};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Own,
    Elsewhere,
    Unsaid,
}

fn origin_of(url: &str) -> Option<&str> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(&url[..scheme.len() + "://".len() + host])
}

fn judged(value: Option<&str>, own: &[String]) -> Source {
    match value {
        Some(origin) if own.iter().any(|allowed| allowed == origin) => Source::Own,
        _ => Source::Elsewhere,
    }
}

fn text(value: &HeaderValue) -> Option<&str> {
    value.to_str().ok()
}

/// What `Origin` says. A value that is no origin, such as `null`, is not one
/// of `own`.
pub fn said(headers: &HeaderMap, own: &[String]) -> Source {
    match headers.get(ORIGIN) {
        Some(origin) => judged(text(origin), own),
        None => Source::Unsaid,
    }
}

/// What `Origin` says, or the origin of `Referer` where a form's post has no
/// `Origin`.
pub fn said_by_form(headers: &HeaderMap, own: &[String]) -> Source {
    match (said(headers, own), headers.get(REFERER)) {
        (Source::Unsaid, Some(referer)) => judged(text(referer).and_then(origin_of), own),
        (source, _) => source,
    }
}

pub fn not_our_page() -> Refusal {
    Refusal::new(
        Code::Forbidden,
        "This request must come from Marfa's own page.",
    )
}
