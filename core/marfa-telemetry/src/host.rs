use std::time::Duration;

use url::{Host, Url};

pub const CONNECT_LIMIT: Duration = Duration::from_secs(1);

/// `localhost`, `127.0.0.0/8` and `::1`, which never leave the machine.
pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name.trim_end_matches('.') == "localhost",
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

/// A proxy cannot reach this machine, and the post must not leave in the clear.
pub fn may_use_proxy(target: &str) -> bool {
    !Url::parse(target).is_ok_and(|url| is_loopback(&url))
}

/// PostHog capture v1, which takes a batch and the token in `Authorization`.
const CAPTURE_PATH: [&str; 4] = ["i", "v1", "analytics", "events"];

/// `https` only, as the token travels with every post; `http` only to this machine.
/// `None` for any other host, or one with a user name or password.
pub fn capture_url(host: &str) -> Option<String> {
    let mut url = Url::parse(host).ok()?;
    let private = match url.scheme() {
        "https" => true,
        "http" => is_loopback(&url),
        _ => false,
    };
    if !private
        || url.host_str().is_none()
        || url.cannot_be_a_base()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .ok()?
        .pop_if_empty()
        .extend(CAPTURE_PATH);
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_machine_is_loopback() {
        for address in [
            "http://localhost:8600",
            "http://LOCALHOST",
            "http://localhost.:8600",
            "http://127.0.0.1",
            "http://127.1.2.3:80",
            "http://[::1]:8600",
        ] {
            assert!(is_loopback(&Url::parse(address).unwrap()), "{address}");
        }
        for address in [
            "http://marfa.example",
            "http://localhost.example",
            "http://128.0.0.1",
            "http://0.0.0.0",
            "http://10.0.0.5",
            "http://[::2]",
            "http://[::ffff:10.0.0.5]",
            "http://[::ffff:127.0.0.1]",
        ] {
            assert!(!is_loopback(&Url::parse(address).unwrap()), "{address}");
        }
    }

    #[test]
    fn a_post_to_this_machine_skips_the_proxy() {
        assert!(!may_use_proxy(
            "http://127.0.0.1:8123/i/v1/analytics/events"
        ));
        assert!(may_use_proxy(
            "https://eu.i.posthog.com/i/v1/analytics/events"
        ));
        assert!(may_use_proxy("not a url"));
    }

    #[test]
    fn events_go_to_the_capture_path_under_the_host_as_written() {
        let events = |host| capture_url(host).unwrap();
        assert_eq!(
            events("https://proxy.example/ingest/?key=x#top"),
            "https://proxy.example/ingest/i/v1/analytics/events"
        );
        assert_eq!(
            events("https://eu.i.posthog.com"),
            "https://eu.i.posthog.com/i/v1/analytics/events"
        );
        assert_eq!(
            events("http://127.0.0.1:8123/"),
            "http://127.0.0.1:8123/i/v1/analytics/events"
        );
        assert_eq!(
            events("http://[::1]:8123"),
            "http://[::1]:8123/i/v1/analytics/events"
        );
        assert_eq!(
            events("http://localhost"),
            "http://localhost/i/v1/analytics/events"
        );
    }

    #[test]
    fn the_token_is_never_sent_in_the_clear_or_to_an_address_with_a_login() {
        for host in [
            "http://us.i.posthog.com",
            "http://10.0.0.5",
            "http://localhost.example",
            "ftp://us.i.posthog.com",
            "us.i.posthog.com",
            "not a url",
            "https://user:pass@us.i.posthog.com",
            "https://user@us.i.posthog.com",
            "https://",
        ] {
            assert_eq!(capture_url(host), None, "{host}");
        }
    }
}
