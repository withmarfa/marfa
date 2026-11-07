//! The `resource` parameter (RFC 8707): which audiences a token may name.

pub const MCP_PATHS: [&str; 3] = ["/mcp", "/mcp/schema", "/mcp/admin"];

/// How a request's `resource` goes wrong at the token endpoint or at
/// authorization. The answer is `invalid_target` either way.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum Refused {
    #[error("The resource is not this server or one of its MCP endpoints.")]
    NotThisServer,
    #[error("A token request names at most one resource.")]
    MoreThanOne,
}

fn without_slash(origin: &str) -> &str {
    origin.trim_end_matches('/')
}

/// Whether `value` names this server: its origin, with or without one
/// trailing slash, or an MCP endpoint exactly as spelled. The scheme and host
/// compare without case (RFC 3986 section 6.2.2.1), the path exactly. It
/// compares text and parses nothing, so an encoded path, a query, a fragment
/// or userinfo is simply not equal.
pub fn is_accepted(origin: &str, value: &str) -> bool {
    let origin = without_slash(origin);
    if origin.is_empty() {
        return false;
    }
    let (Some(head), Some(rest)) = (value.get(..origin.len()), value.get(origin.len()..)) else {
        return false;
    };
    head.eq_ignore_ascii_case(origin)
        && (rest.is_empty() || rest == "/" || MCP_PATHS.contains(&rest))
}

/// The audience a token names for a `resource` the server accepted: spelled
/// as the server spells itself, so a differently cased request and the
/// instance compare equal later.
pub fn audience(origin: &str, value: &str) -> String {
    let origin = without_slash(origin);
    let rest = value.get(origin.len()..).unwrap_or_default();
    format!("{origin}{}", rest.trim_end_matches('/'))
}

/// `keys-and-oauth/resource-one-value` and `resource-other-server`: every
/// `resource` of a token request, as many times as it came. Answers the
/// audience the token will name, if the request named one.
pub fn at_token(origin: &str, values: &[String]) -> Result<Option<String>, Refused> {
    match values {
        [] => Ok(None),
        [value] if is_accepted(origin, value) => Ok(Some(audience(origin, value))),
        [_] => Err(Refused::NotThisServer),
        _ => Err(Refused::MoreThanOne),
    }
}

/// Every `resource` of an authorization request. Where this refuses, the door
/// sends the browser back only if the redirect URI is the client's
/// (`resource-authorize-refused`), and otherwise answers `400`
/// (`resource-authorize-unregistered`).
pub fn at_authorize(origin: &str, values: &[String]) -> Result<Vec<String>, Refused> {
    values
        .iter()
        .map(|value| {
            is_accepted(origin, value)
                .then(|| audience(origin, value))
                .ok_or(Refused::NotThisServer)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const ORIGIN: &str = "https://marfa.example";

    #[test]
    fn this_server_and_its_endpoints_are_accepted() {
        for value in [
            "https://marfa.example",
            "https://marfa.example/",
            "https://marfa.example/mcp",
            "https://marfa.example/mcp/schema",
            "https://marfa.example/mcp/admin",
            "HTTPS://MARFA.example/mcp",
        ] {
            assert!(is_accepted(ORIGIN, value), "{value}");
            assert!(is_accepted("https://marfa.example/", value), "{value}");
        }
    }

    #[test]
    fn anything_else_is_refused() {
        for value in [
            "",
            "https://other.example",
            "https://marfa.example.evil.example",
            "https://marfa.example:443",
            "https://marfa.example//",
            "https://marfa.example/MCP",
            "https://marfa.example/mcp/",
            "https://marfa.example/mcp/other",
            "https://marfa.example/%6dcp",
            "https://marfa.example/mcp?x=1",
            "https://marfa.example/mcp#x",
            "https://marfa.example/mcp/../mcp",
            "https://user@marfa.example/mcp",
            "http://marfa.example/mcp",
            "https://marfa\u{e9}.example/mcp",
        ] {
            assert!(!is_accepted(ORIGIN, value), "{value}");
        }
        assert!(!is_accepted("", "/mcp"));
    }

    #[test]
    fn an_audience_is_spelled_as_the_instance_spells_itself() {
        for (value, expected) in [
            ("HTTPS://MARFA.example/mcp", "https://marfa.example/mcp"),
            ("https://marfa.example/", "https://marfa.example"),
            ("https://marfa.example", "https://marfa.example"),
        ] {
            assert_eq!(audience(ORIGIN, value), expected, "{value}");
        }
    }

    #[test]
    fn a_token_request_names_at_most_one() {
        let one = |value: &str| vec![value.to_string()];
        assert_eq!(at_token(ORIGIN, &[]), Ok(None));
        assert_eq!(
            at_token(ORIGIN, &one("https://marfa.example/mcp")),
            Ok(Some("https://marfa.example/mcp".to_string()))
        );
        assert_eq!(
            at_token(ORIGIN, &one("https://other.example")),
            Err(Refused::NotThisServer)
        );
        assert_eq!(
            at_token(
                ORIGIN,
                &[
                    "https://marfa.example/mcp".to_string(),
                    "https://marfa.example/mcp/admin".to_string()
                ]
            ),
            Err(Refused::MoreThanOne)
        );
    }

    #[test]
    fn an_authorization_refuses_if_any_value_is_not_this_server() {
        let good = "https://marfa.example/mcp".to_string();
        assert_eq!(at_authorize(ORIGIN, &[]), Ok(vec![]));
        assert_eq!(
            at_authorize(ORIGIN, std::slice::from_ref(&good)),
            Ok(vec![good.clone()])
        );
        assert_eq!(
            at_authorize(ORIGIN, &[good, "https://other.example".to_string()]),
            Err(Refused::NotThisServer)
        );
    }

    proptest! {
        #[test]
        fn nothing_panics_and_what_is_accepted_is_one_of_the_forms(value in any::<String>()) {
            if is_accepted(ORIGIN, &value) {
                let lowered = value.to_ascii_lowercase();
                prop_assert!(lowered.starts_with(ORIGIN));
            }
        }

        #[test]
        fn a_path_is_accepted_only_exactly(path in "/[a-zA-Z/%.]{0,12}") {
            let value = format!("{ORIGIN}{path}");
            prop_assert_eq!(
                is_accepted(ORIGIN, &value),
                path == "/" || MCP_PATHS.contains(&path.as_str())
            );
        }
    }
}
