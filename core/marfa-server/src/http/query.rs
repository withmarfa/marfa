use axum::extract::Query;
use axum::http::Uri;

use crate::app::refusal::{Refusal, Result};

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

pub fn flag(uri: &Uri, name: &str) -> Result<Option<bool>> {
    let mut named = pairs(uri)?.into_iter().filter(|(key, _)| key == name);
    let Some((_, value)) = named.next() else {
        return Ok(None);
    };
    if named.next().is_some() {
        return Err(
            Refusal::validation(format!("{name} is named once.")).with_detail("field", name)
        );
    }
    match value.as_str() {
        "true" => Ok(Some(true)),
        "false" => Ok(Some(false)),
        _ => {
            Err(Refusal::validation(format!("{name} is true or false.")).with_detail("field", name))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(query: &str) -> Result<Option<bool>> {
        let uri: Uri = format!("/x{query}").parse().unwrap();
        flag(&uri, "revoke_keys")
    }

    #[test]
    fn a_flag_is_true_false_or_absent_and_never_named_twice() {
        assert_eq!(read("").unwrap(), None);
        assert_eq!(read("?other=yes").unwrap(), None);
        assert_eq!(read("?revoke_keys=true").unwrap(), Some(true));
        assert_eq!(read("?revoke_keys=false").unwrap(), Some(false));
        for refused in [
            "?revoke_keys=yes",
            "?revoke_keys=",
            "?revoke_keys=true&revoke_keys=true",
            "?revoke_keys=false&revoke_keys=yes",
            "?revoke_keys=yes&revoke_keys=false",
            "?revoke_keys=false&other=1&revoke_keys=true",
        ] {
            assert!(read(refused).is_err(), "{refused}");
        }
    }
}
