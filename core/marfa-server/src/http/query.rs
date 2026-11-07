//! A query string holds only what an operation declares.

use axum::extract::Query;
use axum::http::Uri;

use crate::app::refusal::{Refusal, Result};

/// The query's names and values, decoded.
pub fn pairs(uri: &Uri) -> Result<Vec<(String, String)>> {
    let Query(pairs) = Query::<Vec<(String, String)>>::try_from_uri(uri)
        .map_err(|_| Refusal::validation("The query string could not be read."))?;
    Ok(pairs)
}

/// Refuses a key outside `allowed`. A key that begins with `_` is a caller's
/// own, and passes.
pub fn only(uri: &Uri, allowed: &[&str]) -> Result<()> {
    only_where(uri, |key| allowed.contains(&key))
}

/// As [`only`], for an operation whose keys follow a pattern.
pub fn only_where(uri: &Uri, allowed: impl Fn(&str) -> bool) -> Result<()> {
    let pairs = pairs(uri)?;
    let mut unknown: Vec<&str> = pairs
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| !key.starts_with('_') && !allowed(key))
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

/// A parameter that is `true` or `false`, where the query names it.
pub fn flag(uri: &Uri, name: &str) -> Result<Option<bool>> {
    let Some((_, value)) = pairs(uri)?.into_iter().find(|(key, _)| key == name) else {
        return Ok(None);
    };
    match value.as_str() {
        "true" => Ok(Some(true)),
        "false" => Ok(Some(false)),
        _ => {
            Err(Refusal::validation(format!("{name} is true or false.")).with_detail("field", name))
        }
    }
}
