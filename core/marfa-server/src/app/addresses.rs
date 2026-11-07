//! The instance's addresses. Each is stored, so nothing here or anywhere else
//! builds one from a request's `Host` header.

use std::fmt;
use std::sync::Arc;

use url::Url;

use crate::settings::registry::{ADDRESSES, SIGN_IN_ADDRESS};
use crate::settings::{Settings, Snapshot};

const LOOPBACK_IP: &str = "127.0.0.1";

/// One origin, normalized: lowercase host, IDN in its ASCII form, no default
/// port and no trailing slash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    scheme: &'static str,
    host: String,
    port: u16,
    origin: String,
}

impl Address {
    /// Reads an origin, or gives the rule it breaks.
    pub fn parse(text: &str) -> Result<Address, String> {
        let refuse = |rule: &str| Err(format!("must {rule}"));
        if text.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return refuse("have no whitespace");
        }
        if !text.contains("://") {
            return refuse("start with http:// or https://");
        }
        let Ok(url) = Url::parse(text) else {
            return refuse("be an origin such as https://marfa.example");
        };
        let scheme = match url.scheme() {
            "http" => "http",
            "https" => "https",
            _ => return refuse("start with http:// or https://"),
        };
        if !url.username().is_empty() || url.password().is_some() {
            return refuse("have no user name or password");
        }
        if url.path() != "/" {
            return refuse("have no path");
        }
        if url.query().is_some() {
            return refuse("have no query");
        }
        if url.fragment().is_some() {
            return refuse("have no fragment");
        }
        let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
            return refuse("be an origin such as https://marfa.example");
        };
        if port == 0 {
            return refuse("have a port from 1 to 65535");
        }
        Ok(Address {
            scheme,
            host: host.to_string(),
            port,
            origin: url.origin().ascii_serialization(),
        })
    }

    fn loopback(host: &str, port: u16) -> Address {
        let origin = if port == 80 {
            format!("http://{host}")
        } else {
            format!("http://{host}:{port}")
        };
        Address {
            scheme: "http",
            host: host.to_string(),
            port,
            origin,
        }
    }

    pub fn scheme(&self) -> &str {
        self.scheme
    }

    /// The host, with an IPv6 address in its brackets.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The port, which is the scheme's default when the origin names none.
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn is_https(&self) -> bool {
        self.scheme == "https"
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.origin)
    }
}

/// Reads a JSON array of origins, keeping the first of any that normalize to
/// the same one.
pub fn parse_list(text: &str) -> Result<Vec<Address>, String> {
    let texts: Vec<String> = serde_json::from_str(text)
        .map_err(|_| "must be a JSON array of origins such as https://marfa.example")?;
    let mut list = Vec::with_capacity(texts.len());
    for text in texts {
        let address = Address::parse(&text)?;
        if !list.contains(&address) {
            list.push(address);
        }
    }
    Ok(list)
}

/// The instance's addresses at one moment.
pub struct Addresses {
    live: Arc<Snapshot>,
    loopback_host: &'static str,
    port: u16,
}

impl Addresses {
    /// `bound_port` is the port the server really bound, once it has.
    pub fn read(settings: &Settings, bound_port: Option<u16>) -> Addresses {
        Addresses::in_snapshot(settings, settings.live(), bound_port)
    }

    /// The addresses the settings in `snapshot` would give.
    pub fn in_snapshot(
        settings: &Settings,
        snapshot: Arc<Snapshot>,
        bound_port: Option<u16>,
    ) -> Addresses {
        let start = &settings.start;
        Addresses {
            live: snapshot,
            loopback_host: match start.listen_host.as_deref() {
                Some(LOOPBACK_IP) => LOOPBACK_IP,
                _ => "localhost",
            },
            port: bound_port.unwrap_or(start.port),
        }
    }

    /// The address the issuer, cookies, passkeys and discovery use.
    pub fn sign_in(&self) -> Address {
        self.live
            .get(SIGN_IN_ADDRESS)
            .unwrap_or_else(|| Address::loopback(self.loopback_host, self.port))
    }

    /// The stored addresses, and the sign-in address if they do not name it.
    pub fn all(&self) -> Vec<Address> {
        let mut list = self.live.get(ADDRESSES);
        let sign_in = self.sign_in();
        if !list.contains(&sign_in) {
            list.push(sign_in);
        }
        list
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Environment;

    fn origin(text: &str) -> String {
        Address::parse(text).unwrap().origin
    }

    fn rule(text: &str) -> String {
        Address::parse(text).unwrap_err()
    }

    #[test]
    fn normalizes_untidy_input() {
        for (given, wanted) in [
            ("https://marfa.example", "https://marfa.example"),
            ("HTTPS://MARFA.Example", "https://marfa.example"),
            ("https://marfa.example/", "https://marfa.example"),
            ("https://marfa.example:443", "https://marfa.example"),
            ("http://marfa.example:80/", "http://marfa.example"),
            ("http://marfa.example:443", "http://marfa.example:443"),
            ("https://marfa.example:80", "https://marfa.example:80"),
            ("https://bücher.example", "https://xn--bcher-kva.example"),
            ("http://[::1]:8600/", "http://[::1]:8600"),
            ("http://[0:0:0:0:0:0:0:1]", "http://[::1]"),
            ("http://127.0.0.1:8600", "http://127.0.0.1:8600"),
        ] {
            assert_eq!(origin(given), wanted);
        }
    }

    #[test]
    fn gives_its_parts() {
        let https = Address::parse("https://Marfa.Example").unwrap();
        assert_eq!(
            (https.scheme(), https.host(), https.port(), https.is_https()),
            ("https", "marfa.example", 443, true)
        );
        let ipv6 = Address::parse("http://[::1]:8600").unwrap();
        assert_eq!(
            (ipv6.scheme(), ipv6.host(), ipv6.port(), ipv6.is_https()),
            ("http", "[::1]", 8600, false)
        );
        assert_eq!(ipv6.to_string(), "http://[::1]:8600");
    }

    #[test]
    fn refuses_what_is_not_an_origin_naming_the_rule() {
        for (given, broken) in [
            ("marfa.example", "start with"),
            ("localhost:8600", "start with"),
            ("javascript:alert(1)", "start with"),
            ("javascript://marfa.example", "start with"),
            ("ftp://marfa.example", "start with"),
            ("https:marfa.example", "start with"),
            ("https://marfa example", "whitespace"),
            (" https://marfa.example", "whitespace"),
            ("https://marfa.example\n", "whitespace"),
            ("https://user@marfa.example", "user name"),
            ("https://user:pass@marfa.example", "user name"),
            ("https://marfa.example/app", "no path"),
            ("https://marfa.example//", "no path"),
            ("https://marfa.example?", "no query"),
            ("https://marfa.example/?a=1", "no query"),
            ("https://marfa.example#", "no fragment"),
            ("https://marfa.example/#top", "no fragment"),
            ("http://marfa.example:0", "port"),
            ("https://", "origin"),
            ("http://[::1", "origin"),
            ("http://marfa.example:70000", "origin"),
        ] {
            let line = rule(given);
            assert!(line.starts_with("must "), "{given}: {line}");
            assert!(line.contains(broken), "{given}: {line}");
        }
    }

    #[test]
    fn a_list_is_a_json_array_of_origins_without_repeats() {
        let list =
            parse_list(r#"["https://a.example/", "HTTPS://A.example:443", "http://b.example"]"#);
        let origins: Vec<_> = list.unwrap().into_iter().map(|a| a.origin).collect();
        assert_eq!(origins, ["https://a.example", "http://b.example"]);
        assert!(parse_list("https://a.example").is_err());
        assert!(parse_list(r#"["a.example"]"#).is_err());
    }

    fn settings(pairs: &[(&str, &str)]) -> Settings {
        let pairs = [&[("SQLITE_PATH", ":memory:")], pairs].concat();
        Settings::read(Environment::from_pairs(&pairs))
            .ok()
            .unwrap()
            .open_secrets()
            .unwrap()
    }

    #[test]
    fn with_nothing_stored_it_is_the_loopback_at_the_port_bound() {
        let sign_in = |pairs: &[(&str, &str)], bound| {
            Addresses::read(&settings(pairs), bound).sign_in().origin
        };
        assert_eq!(sign_in(&[], None), "http://localhost:8600");
        assert_eq!(
            sign_in(&[("PORT", "0")], Some(51234)),
            "http://localhost:51234"
        );
        assert_eq!(
            sign_in(
                &[("MARFA_LISTEN_HOST", "127.0.0.1"), ("PORT", "0")],
                Some(51234)
            ),
            "http://127.0.0.1:51234"
        );
        assert_eq!(
            sign_in(&[("MARFA_LISTEN_HOST", "0.0.0.0")], None),
            "http://localhost:8600"
        );
        assert_eq!(sign_in(&[("PORT", "80")], None), "http://localhost");
    }

    #[test]
    fn a_stored_sign_in_address_replaces_the_loopback_and_joins_the_list() {
        let settings = settings(&[]);
        let rows = [
            (
                "sign_in_address".to_string(),
                "https://b.example".to_string(),
            ),
            (
                "addresses".to_string(),
                r#"["https://a.example"]"#.to_string(),
            ),
        ];
        settings.apply_stored(&rows);
        let addresses = Addresses::read(&settings, Some(51234));
        assert_eq!(addresses.sign_in().origin(), "https://b.example");
        let all: Vec<_> = addresses.all().into_iter().map(|a| a.origin).collect();
        assert_eq!(all, ["https://a.example", "https://b.example"]);
    }
}
