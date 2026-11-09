//! Redirect URIs: what a client may register, what a request may name, and their origins.

use std::net::IpAddr;

use url::{Host, Url};

/// A registration's `application_type`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppKind {
    Web,
    Native,
}

impl AppKind {
    pub const fn word(self) -> &'static str {
        match self {
            AppKind::Web => "web",
            AppKind::Native => "native",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum Refused {
    #[error("The redirect URI is not a valid URI.")]
    Unparseable,
    #[error("A redirect URI must not carry a fragment.")]
    Fragment,
    #[error("A redirect URI must not carry credentials.")]
    Credentials,
    #[error("A web client's redirect URI must not be on the loopback.")]
    WebLoopback,
    #[error("A web client's redirect URI must use https.")]
    WebScheme,
    #[error("A native client's http redirect URI must be on the loopback.")]
    NativePlainHttp,
    #[error(
        "A native client's private-use redirect URI must use a reverse domain name as its \
         scheme, with a path and no authority."
    )]
    NativePrivateForm,
    #[error("A redirect URI must name a host that can be reached.")]
    Unreachable,
}

/// Text a browser and this parser could read differently: a backslash is a slash to WHATWG,
/// and tabs, newlines and edge spaces are stripped before parsing.
pub(super) fn is_plain(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte > 0x20 && byte != 0x7f && byte != b'\\')
}

/// RFC 8252 section 7.3.
pub fn is_loopback_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

fn ip_of(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(v4) => Some(IpAddr::V4(v4)),
        Host::Ipv6(v6) => Some(IpAddr::V6(v6)),
        Host::Domain(_) => None,
    }
}

/// Wider than the port rule's test: takes `localhost` too, with any trailing dots.
fn on_the_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(_) => ip_of(url).is_some_and(is_loopback_ip),
        None => false,
    }
}

fn is_unspecified(url: &Url) -> bool {
    ip_of(url).is_some_and(|address| match address {
        IpAddr::V4(v4) => v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_unspecified() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_unspecified())
        }
    })
}

fn is_reverse_domain(scheme: &str) -> bool {
    let label = |part: &str| {
        !part.is_empty()
            && !part.starts_with('-')
            && !part.ends_with('-')
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    };
    let mut labels = scheme.split('.');
    let first = labels.next().unwrap_or_default();
    label(first)
        && first.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.contains('.')
        && labels.all(label)
}

/// Checked on the text as sent: an empty authority (`scheme:///path`) leaves the same path once parsed.
fn is_private_use_form(uri: &str, url: &Url) -> bool {
    let after_scheme = uri.split_once(':').map_or("", |(_, rest)| rest);
    is_reverse_domain(url.scheme())
        && url.host().is_none()
        && after_scheme.starts_with('/')
        && !after_scheme.starts_with("//")
}

pub fn only_native_receives(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| match url.scheme() {
        "http" | "https" => on_the_loopback(&url),
        _ => true,
    })
}

pub fn check_registered(kind: AppKind, uri: &str) -> Result<(), Refused> {
    if !is_plain(uri) {
        return Err(Refused::Unparseable);
    }
    if uri.contains('#') {
        return Err(Refused::Fragment);
    }
    let url = Url::parse(uri).map_err(|_| Refused::Unparseable)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Refused::Credentials);
    }
    if is_unspecified(&url) {
        return Err(Refused::Unreachable);
    }
    match (kind, url.scheme()) {
        (AppKind::Web, "http" | "https") if on_the_loopback(&url) => Err(Refused::WebLoopback),
        (AppKind::Web, "https") | (AppKind::Native, "https") => Ok(()),
        (AppKind::Web, _) => Err(Refused::WebScheme),
        (AppKind::Native, "http") if on_the_loopback(&url) => Ok(()),
        (AppKind::Native, "http") => Err(Refused::NativePlainHttp),
        (AppKind::Native, _) if is_private_use_form(uri, &url) => Ok(()),
        (AppKind::Native, _) => Err(Refused::NativePrivateForm),
    }
}

/// The same text, or for a registered loopback host the same text with only the port changed,
/// since a native app binds an ephemeral one. Text, not the parsed form, because a browser goes
/// where the text says.
pub fn is_registered(registered: &[String], requested: &str) -> bool {
    registered.iter().any(|entry| entry == requested) || {
        let bare = (is_plain(requested) && !requested.contains('#'))
            .then(|| Url::parse(requested).ok())
            .flatten()
            .filter(|url| url.username().is_empty() && url.password().is_none())
            .and_then(|_| without_port(requested));
        bare.is_some_and(|bare| {
            registered.iter().any(|entry| {
                Url::parse(entry).is_ok_and(|url| takes_any_port(&url))
                    && without_port(entry).is_some_and(|entry| entry == bare)
            })
        })
    }
}

/// A colon with no digits after it is no port, so it stays.
fn without_port(uri: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host = match authority.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty()
                && port.bytes().all(|byte| byte.is_ascii_digit())
                && (!host.starts_with('[') || host.ends_with(']')) =>
        {
            host
        }
        _ => authority,
    };
    Some(format!("{scheme}://{host}{tail}"))
}

/// RFC 9700 section 4.1.3 lets the port vary for localhost URIs. RFC 8252 section 7.3 names only
/// IP addresses, but real clients register `http://localhost/callback` and listen on an ephemeral
/// port. Only the name exactly: not a subdomain and not a trailing dot.
fn takes_any_port(registered: &Url) -> bool {
    registered.host_str() == Some("localhost") || ip_of(registered).is_some_and(is_loopback_ip)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Destination(String);

impl Destination {
    pub fn of(registered: &[String], requested: &str) -> Option<Destination> {
        is_registered(registered, requested).then(|| Destination(requested.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Adds `pairs` and the `issuer` (RFC 9207). A query on the registered URI stays.
    pub fn with(&self, pairs: &[(&str, &str)], issuer: &str) -> String {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query.extend_pairs(pairs);
        query.append_pair("iss", issuer);
        let joiner = if self.0.contains('?') { '&' } else { '?' };
        format!("{}{joiner}{}", self.0, query.finish())
    }
}

/// The host the parser read, never the text or a private-use scheme. A loopback URI names none.
pub fn shown_destination(uri: &str) -> Option<String> {
    let url = Url::parse(uri).ok()?;
    if on_the_loopback(&url) {
        return None;
    }
    Some(url.host_str().unwrap_or(url.scheme()).to_string())
}

/// Scheme, lowercase host and port, with the scheme's default port left out. Only `https` has one.
pub fn origin(uri: &str) -> Option<String> {
    let url = Url::parse(uri).ok()?;
    (url.scheme() == "https").then(|| url.origin().ascii_serialization())
}

/// A native app's redirect URI is where a program listens, not a page.
pub fn web_origins(kind: AppKind, uris: &[String]) -> Vec<String> {
    if kind == AppKind::Native {
        return Vec::new();
    }
    let mut origins = Vec::new();
    for found in uris.iter().filter_map(|uri| origin(uri)) {
        if !origins.contains(&found) {
            origins.push(found);
        }
    }
    origins
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_destination_is_only_a_uri_the_client_registered() {
        let registered = ["https://app.example/back".to_string()];
        assert!(Destination::of(&registered, "https://evil.example/back").is_none());
        let destination = Destination::of(&registered, "https://app.example/back").unwrap();
        assert_eq!(
            destination.with(
                &[("code", "a b"), ("state", "&x=1")],
                "https://m.example/auth"
            ),
            "https://app.example/back?code=a+b&state=%26x%3D1&iss=https%3A%2F%2Fm.example%2Fauth"
        );
    }

    #[test]
    fn a_destination_keeps_a_registered_query() {
        let registered = ["https://app.example/back?tenant=1".to_string()];
        let destination = Destination::of(&registered, &registered[0]).unwrap();
        assert_eq!(
            destination.with(&[("code", "c")], "i"),
            "https://app.example/back?tenant=1&code=c&iss=i"
        );
    }

    #[test]
    fn a_shown_destination_comes_from_the_parser() {
        assert_eq!(
            shown_destination("https://APP.example:8443/back").as_deref(),
            Some("app.example")
        );
        assert_eq!(
            shown_destination("https://user@app.example/back").as_deref(),
            Some("app.example")
        );
        assert_eq!(
            shown_destination("com.example.app:/callback").as_deref(),
            Some("com.example.app")
        );
        assert_eq!(shown_destination("http://127.0.0.1:9/callback"), None);
        assert_eq!(shown_destination("http://localhost/callback"), None);
    }
    use proptest::prelude::*;

    fn list(uris: &[&str]) -> Vec<String> {
        uris.iter().map(|uri| uri.to_string()).collect()
    }

    #[test]
    fn a_web_client_registers_https_off_the_loopback() {
        for uri in [
            "https://app.example/callback",
            "https://app.example:8443/callback?from=marfa",
            "https://claude.ai/api/mcp/auth_callback",
            "https://10.0.0.5/callback",
        ] {
            assert_eq!(check_registered(AppKind::Web, uri), Ok(()), "{uri}");
        }
        for (uri, refused) in [
            ("http://app.example/callback", Refused::WebScheme),
            ("http://127.0.0.1/callback", Refused::WebLoopback),
            ("https://127.0.0.1/callback", Refused::WebLoopback),
            ("https://127.1.2.3/callback", Refused::WebLoopback),
            ("https://[::1]/callback", Refused::WebLoopback),
            ("https://[::ffff:127.0.0.1]/callback", Refused::WebLoopback),
            ("https://localhost/callback", Refused::WebLoopback),
            ("https://LOCALHOST./callback", Refused::WebLoopback),
            ("https://tenant.localhost/callback", Refused::WebLoopback),
            ("https://0x7f.1/callback", Refused::WebLoopback),
            ("https://2130706433/callback", Refused::WebLoopback),
            ("https://%6c%6f%63alhost/callback", Refused::WebLoopback),
            ("com.example.app:/callback", Refused::WebScheme),
            ("javascript:alert(1)", Refused::WebScheme),
            ("https://0.0.0.0/callback", Refused::Unreachable),
            ("https://[::]/callback", Refused::Unreachable),
        ] {
            assert_eq!(check_registered(AppKind::Web, uri), Err(refused), "{uri}");
        }
    }

    #[test]
    fn a_native_client_registers_the_loopback_and_a_reverse_domain_scheme() {
        for uri in [
            "http://127.0.0.1/callback",
            "http://127.0.0.1:53682/callback",
            "http://[::1]:8080/callback",
            "http://localhost:3118/callback",
            "https://app.example/universal",
            "com.example.app:/callback",
            "so.marfa.mapp:/signed-in",
            "Com.Example.App:/callback",
            "com.example-app.ios:/a/b?c=d",
        ] {
            assert_eq!(check_registered(AppKind::Native, uri), Ok(()), "{uri}");
        }
        for (uri, refused) in [
            ("http://app.example/callback", Refused::NativePlainHttp),
            ("http://10.0.0.5/callback", Refused::NativePlainHttp),
            ("myapp:/callback", Refused::NativePrivateForm),
            ("myapp://callback", Refused::NativePrivateForm),
            (
                "cursor://anysphere.cursor-mcp/oauth/callback",
                Refused::NativePrivateForm,
            ),
            ("com.example.app://host/path", Refused::NativePrivateForm),
            ("com.example.app:///path", Refused::NativePrivateForm),
            ("com.example.app:path", Refused::NativePrivateForm),
            ("com.-example.app:/callback", Refused::NativePrivateForm),
            ("com..app:/callback", Refused::NativePrivateForm),
            ("javascript:/alert(1)", Refused::NativePrivateForm),
            ("data:/text", Refused::NativePrivateForm),
            ("file:///etc/passwd", Refused::NativePrivateForm),
            ("ftp://example.com/x", Refused::NativePrivateForm),
            ("wss://example.com/x", Refused::NativePrivateForm),
            ("http://0.0.0.0:80/callback", Refused::Unreachable),
        ] {
            assert_eq!(
                check_registered(AppKind::Native, uri),
                Err(refused),
                "{uri}"
            );
        }
    }

    #[test]
    fn what_either_kind_refuses_whatever_the_host() {
        for kind in [AppKind::Web, AppKind::Native] {
            for (uri, refused) in [
                ("", Refused::Unparseable),
                ("not a uri", Refused::Unparseable),
                ("/relative/path", Refused::Unparseable),
                ("https://", Refused::Unparseable),
                ("https://app.example\\@evil.example/", Refused::Unparseable),
                ("https://app.example/\tcallback", Refused::Unparseable),
                ("https://app.example/\ncallback", Refused::Unparseable),
                (" https://app.example/callback", Refused::Unparseable),
                ("https://[fe80::1%25en0]/", Refused::Unparseable),
                ("https://app.example/cb#frag", Refused::Fragment),
                ("https://app.example/cb#", Refused::Fragment),
                ("https://user@app.example/cb", Refused::Credentials),
                ("https://user:pw@app.example/cb", Refused::Credentials),
            ] {
                assert_eq!(check_registered(kind, uri), Err(refused), "{uri}");
            }
        }
    }

    #[test]
    fn a_request_matches_exactly_or_on_another_port_of_the_loopback() {
        let registered = list(&[
            "https://app.example/callback",
            "http://127.0.0.1/callback",
            "http://127.0.0.1:1000/other?keep=1",
            "http://[::1]/callback",
            "http://localhost:3118/callback",
            "com.example.app:/callback",
        ]);
        for requested in [
            "https://app.example/callback",
            "http://127.0.0.1/callback",
            "http://127.0.0.1:53682/callback",
            "http://127.0.0.1:2000/other?keep=1",
            "http://[::1]:53682/callback",
            "http://localhost:3118/callback",
            "http://localhost:53682/callback",
            "com.example.app:/callback",
        ] {
            assert!(is_registered(&registered, requested), "{requested}");
        }
        for requested in [
            "",
            "https://app.example/callback/",
            "https://APP.example/callback",
            "https://app.example:443/callback",
            "https://app.example/callback?x=1",
            "http://app.example/callback",
            "https://127.0.0.1:53682/callback",
            "http://127.0.0.1:53682/callback/",
            "http://127.0.0.1:53682/Callback",
            "http://127.0.0.1:53682/callback?x=1",
            "http://127.0.0.1:53682/callback#x",
            "http://127.0.0.2:53682/callback",
            "http://user@127.0.0.1:53682/callback",
            "http://127.0.0.1:53682\\@evil.example/callback",
            "http://localhost:53682/other",
            "https://localhost:53682/callback",
            "http://evil.example:53682/callback",
            "com.example.app:/other",
            "com.example.app://callback",
            "com.example.evil:/callback",
        ] {
            assert!(!is_registered(&registered, requested), "{requested}");
        }
        assert!(!is_registered(&[], "https://app.example/callback"));
    }

    #[test]
    fn the_port_rule_is_for_the_loopback_and_stays_on_the_host_that_was_registered() {
        let claude_code = list(&["http://localhost/callback", "http://127.0.0.1/callback"]);
        assert!(is_registered(
            &claude_code,
            "http://localhost:49152/callback"
        ));
        assert!(is_registered(
            &claude_code,
            "http://127.0.0.1:49152/callback"
        ));

        let address = list(&["http://127.0.0.1/callback"]);
        assert!(!is_registered(&address, "http://localhost:9/callback"));
        let name = list(&["http://localhost/callback"]);
        assert!(!is_registered(&name, "http://127.0.0.1:9/callback"));
        assert!(!is_registered(&name, "http://localhost.:9/callback"));
        assert!(!is_registered(&name, "http://a.localhost:9/callback"));

        for elsewhere in [
            "http://a.localhost/callback",
            "http://localhost./callback",
            "https://app.example/callback",
        ] {
            let requested = elsewhere.replace("/callback", ":9/callback");
            assert!(
                !is_registered(&list(&[elsewhere]), &requested),
                "{elsewhere}"
            );
        }
    }

    #[test]
    fn only_the_port_may_differ_from_the_text_that_was_registered() {
        let registered = list(&[
            "http://127.0.0.1/callback",
            "http://localhost/callback",
            "http://[::1]/callback",
        ]);
        for requested in [
            "http://2130706433:9/callback",
            "http://0x7f.0.0.1:9/callback",
            "http://127.1:9/callback",
            "http://127.0.0.1:9/%2e/callback",
            "http://127.0.0.1:9/./callback",
            "http://127.0.0.1:9/a/../callback",
            "HTTP://127.0.0.1:9/callback",
            "http://LOCALHOST:9/callback",
            "http://[0:0:0:0:0:0:0:1]:9/callback",
            "http://127.0.0.1:/callback",
        ] {
            assert!(!is_registered(&registered, requested), "{requested}");
        }
        for requested in [
            "http://127.0.0.1:9/callback",
            "http://127.0.0.1:65535/callback",
            "http://localhost:9/callback",
            "http://[::1]:9/callback",
        ] {
            assert!(is_registered(&registered, requested), "{requested}");
        }
        assert!(!is_registered(
            &registered,
            "http://127.0.0.1:65536/callback"
        ));
    }

    #[test]
    fn an_origin_is_scheme_host_and_port() {
        for (uri, expected) in [
            ("https://App.Example/callback", "https://app.example"),
            ("https://app.example:443/a?b=c", "https://app.example"),
            ("https://app.example:8443/", "https://app.example:8443"),
            ("https://app.example", "https://app.example"),
        ] {
            assert_eq!(origin(uri).as_deref(), Some(expected), "{uri}");
        }
        for uri in [
            "http://127.0.0.1/callback",
            "com.example.app:/callback",
            "not a uri",
        ] {
            assert_eq!(origin(uri), None, "{uri}");
        }
    }

    #[test]
    fn a_web_client_has_each_origin_once_and_a_native_client_none() {
        let uris = list(&[
            "https://app.example/a",
            "https://APP.example:443/b",
            "https://other.example/c",
        ]);
        assert_eq!(
            web_origins(AppKind::Web, &uris),
            ["https://app.example", "https://other.example"]
        );
        assert!(web_origins(AppKind::Native, &uris).is_empty());
    }

    fn uriish() -> impl Strategy<Value = String> {
        prop_oneof![
            any::<String>(),
            "(https?|HTTPS?|com\\.a\\.b|myapp|javascript):[/\\\\]{0,3}[a-zA-Z0-9.:@%\\[\\]\\\\/?#-]{0,30}",
        ]
    }

    fn loopback_host() -> impl Strategy<Value = String> {
        prop_oneof![
            Just("localhost".to_string()),
            Just("LocalHost".to_string()),
            Just("localhost.".to_string()),
            Just("localhost..".to_string()),
            Just("a.localhost".to_string()),
            Just("%6c%6f%63%61%6c%68%6f%73%74".to_string()),
            Just("127.0.0.1".to_string()),
            Just("127.1".to_string()),
            Just("0177.0.0.1".to_string()),
            Just("0x7f.0.0.1".to_string()),
            Just("2130706433".to_string()),
            Just("[::1]".to_string()),
            Just("[0:0:0:0:0:0:0:1]".to_string()),
            Just("[::ffff:127.0.0.1]".to_string()),
            Just("[::FFFF:7F00:1]".to_string()),
            (0u8..=255, 0u8..=255, 0u8..=255).prop_map(|(a, b, c)| format!("127.{a}.{b}.{c}")),
        ]
    }

    proptest! {
        #[test]
        fn nothing_panics_on_any_text(uri in uriish(), other in uriish()) {
            let _ = check_registered(AppKind::Web, &uri);
            let _ = check_registered(AppKind::Native, &uri);
            let _ = is_registered(std::slice::from_ref(&other), &uri);
            let _ = origin(&uri);
            let _ = only_native_receives(&uri);
        }

        #[test]
        fn the_loopback_stays_refused_for_a_web_client_in_every_spelling(
            host in loopback_host(),
            scheme in prop_oneof![Just("https"), Just("HTTPS"), Just("hTTpS"), Just("http")],
            port in prop_oneof![Just(String::new()), Just(":443".to_string()), Just(":8080".to_string())],
        ) {
            let uri = format!("{scheme}://{host}{port}/callback");
            prop_assert_eq!(check_registered(AppKind::Web, &uri), Err(Refused::WebLoopback));
        }

        #[test]
        fn a_refused_uri_stays_refused_when_dressed_up(
            host in "[a-z]{1,8}\\.example",
            trick in 0usize..6,
        ) {
            let uri = match trick {
                0 => format!("https://{host}\\callback"),
                1 => format!("https://{host}/call\tback"),
                2 => format!("https://user@{host}/callback"),
                3 => format!("https://{host}/callback#fragment"),
                4 => format!("https://{host}\\@evil.example/callback"),
                _ => format!("https://{host}/callback\n"),
            };
            prop_assert!(check_registered(AppKind::Web, &uri).is_err());
            prop_assert!(check_registered(AppKind::Native, &uri).is_err());
        }

        #[test]
        fn a_match_is_exact_unless_the_registered_uri_is_on_the_loopback(
            registered in uriish(),
            requested in uriish(),
        ) {
            let entries = std::slice::from_ref(&registered);
            if registered != requested && is_registered(entries, &requested) {
                let entry = Url::parse(&registered).expect("a port match parsed");
                let asked = Url::parse(&requested).expect("a port match parsed");
                prop_assert!(takes_any_port(&entry));
                prop_assert_eq!(entry.host(), asked.host());
                prop_assert_eq!(entry.path(), asked.path());
            }
        }

        #[test]
        fn any_port_of_a_registered_loopback_address_matches(
            last in 0u8..=255,
            port in 1u16..=65535,
            other in 1u16..=65535,
        ) {
            let entry = format!("http://127.0.0.{last}:{other}/callback");
            let asked = format!("http://127.0.0.{last}:{port}/callback");
            prop_assert!(is_registered(&[entry], &asked));
        }
    }
}
