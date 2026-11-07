//! What a listener says about itself, and whom it believes about a caller's
//! address. Names no HTTP type: `http` acts on these.

use ipnet::IpNet;

const RANGES_RULE: &str =
    "must be comma-separated CIDR ranges, IPv4 or IPv6, with no IPv4-mapped range";
const HEADER_RULE: &str = "must be an HTTP header name";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Http,
    LocalSocket,
}

impl Transport {
    pub fn name(self) -> &'static str {
        match self {
            Transport::Http => "http",
            Transport::LocalSocket => "local_socket",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trust {
    Nothing,
    /// The lowercase name of a header the platform's edge overwrites with the
    /// caller's address. Believed from any peer: it says nothing reaches this
    /// listener except through that edge.
    EdgeHeader(String),
    /// The ranges of the proxies whose `X-Forwarded-For` is believed.
    Proxies(Vec<IpNet>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declaration {
    pub name: &'static str,
    pub transport: Transport,
    pub trust: Trust,
}

impl Declaration {
    pub fn public(trust: Trust) -> Declaration {
        Declaration {
            name: "public",
            transport: Transport::Http,
            trust,
        }
    }

    pub fn control() -> Declaration {
        Declaration {
            name: "control",
            transport: Transport::LocalSocket,
            trust: Trust::Nothing,
        }
    }
}

fn proxy_range(entry: &str) -> Option<IpNet> {
    let range: IpNet = entry.trim().parse().ok()?;
    // Addresses are compared as IPv4 once mapped, so a mapped range would
    // never match anything.
    (range.addr().to_canonical() == range.addr()).then_some(range)
}

pub fn proxy_ranges(text: &str) -> Result<Vec<IpNet>, String> {
    text.split(',')
        .map(proxy_range)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| RANGES_RULE.to_string())
}

/// A header name is an RFC 9110 token.
pub fn header_name(text: &str) -> Result<String, String> {
    let token = |byte: u8| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte);
    text.bytes()
        .all(token)
        .then(|| text.to_ascii_lowercase())
        .ok_or_else(|| HEADER_RULE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Environment, Refused, Settings};

    fn trust(pairs: &[(&str, &str)]) -> Result<Trust, Refused> {
        Settings::read(Environment::from_pairs(pairs))
            .map(|settings| settings.start.public_listener.trust.clone())
    }

    #[test]
    fn ranges_are_held_to_cidr_form() {
        let parsed = proxy_ranges("10.0.0.0/8, fd00::/8").unwrap();
        assert_eq!(parsed.len(), 2);
        for wrong in [
            "10.0.0.1",
            "10.0.0.0/33",
            "10.0.0.0/8,",
            ",",
            "10.0.0.0/8 fd00::/8",
            "::ffff:10.0.0.0/104",
            "localhost/8",
        ] {
            assert!(proxy_ranges(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn a_header_name_is_a_token_and_is_held_in_lowercase() {
        assert_eq!(header_name("X-Real_IP.1").unwrap(), "x-real_ip.1");
        for wrong in ["x client", " x-client", "x:client", "x-clíent"] {
            assert!(header_name(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn trust_is_read_with_or_without_test_hooks_and_the_header_takes_precedence() {
        let cidrs = ("TRUSTED_PROXY_CIDRS", "10.0.0.0/8");
        let header = ("TRUSTED_PROXY_HEADER", "X-Client");
        let hooks = ("MARFA_TEST_HOOKS", "true");
        let ranges = Trust::Proxies(proxy_ranges("10.0.0.0/8").unwrap());
        assert_eq!(trust(&[]), Ok(Trust::Nothing));
        assert_eq!(trust(&[cidrs]), Ok(ranges.clone()));
        assert_eq!(trust(&[cidrs, hooks]), Ok(ranges));
        assert_eq!(
            trust(&[cidrs, header]),
            Ok(Trust::EdgeHeader("x-client".to_string()))
        );
    }

    #[test]
    fn each_malformed_trust_setting_is_refused_on_its_own_line() {
        let refused = trust(&[
            ("TRUSTED_PROXY_CIDRS", "10.0.0.0/8,nonsense"),
            ("TRUSTED_PROXY_HEADER", "not a header"),
        ])
        .unwrap_err();
        assert_eq!(refused.lines.len(), 2, "{refused}");
        assert!(refused.lines[0].starts_with("TRUSTED_PROXY_CIDRS must"));
        assert!(refused.lines[1].starts_with("TRUSTED_PROXY_HEADER must"));
    }
}
