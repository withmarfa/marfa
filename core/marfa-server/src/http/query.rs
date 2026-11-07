//! A query string holds only what an operation declares.

use axum::extract::Query;
use axum::http::Uri;

use crate::app::refusal::{Refusal, Result};

/// Refuses a key outside `allowed`. A key that begins with `_` is a caller's
/// own, and passes.
pub fn only(uri: &Uri, allowed: &[&str]) -> Result<()> {
    let Query(pairs) = Query::<Vec<(String, String)>>::try_from_uri(uri)
        .map_err(|_| Refusal::validation("The query string could not be read."))?;
    let mut unknown: Vec<&str> = pairs
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| !key.starts_with('_') && !allowed.contains(key))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    unknown.sort_unstable();
    unknown.dedup();
    Err(Refusal::validation(format!(
        "The query names parameters this operation does not take: {}.",
        unknown.join(", ")
    ))
    .with_detail("unknown_parameters", unknown))
}
