//! Before the command sends a credential over `http` to a host that is not
//! this machine, it warns once per address and goes on: an owner's private
//! network may already be encrypted below the address.

use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use url::{Host, Url};

static ALLOWED: AtomicBool = AtomicBool::new(false);
static WARNED: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[cfg(test)]
thread_local! {
    static GUARDED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Silences the warning for the rest of the run.
pub fn allow() {
    ALLOWED.store(true, Ordering::Relaxed);
}

/// `MARFA_ALLOW_HTTP` set to a true word; empty, unset or any other value
/// leaves the warning on.
pub fn allowed_by_environment() -> bool {
    std::env::var("MARFA_ALLOW_HTTP").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// `localhost`, `127.0.0.0/8` and `::1`, which never leave the machine.
pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost",
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => {
            address.is_loopback()
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|address| address.is_loopback())
        }
        None => false,
    }
}

/// The origin and the warning for a plain `http` address on another host;
/// nothing for `https`, for this machine, or for what is no URL.
fn notice(address: &str) -> Option<(String, String)> {
    let url = Url::parse(address).ok()?;
    if url.scheme() != "http" || is_loopback(&url) {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    let text = format!(
        "marfa: warning: {origin} is plain http on a host that is not this machine, so a credential sent to it can be read on the way; use an https address, or pass --allow-http (or set MARFA_ALLOW_HTTP=1) if the network is private and this is intended"
    );
    Some((origin, text))
}

/// Warns, once per origin, before a credential, a device code or a refresh
/// token is sent to `address`.
pub fn guard(address: &str) {
    #[cfg(test)]
    GUARDED.with(|guarded| guarded.borrow_mut().push(address.to_string()));
    if ALLOWED.load(Ordering::Relaxed) {
        return;
    }
    let Some((origin, text)) = notice(address) else {
        return;
    };
    let mut warned = WARNED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if warned.contains(&origin) {
        return;
    }
    warned.push(origin);
    let _ = writeln!(std::io::stderr(), "{text}");
}

/// The addresses `guard` was called with on this thread, oldest first.
#[cfg(test)]
pub fn guarded() -> Vec<String> {
    GUARDED.with(|guarded| guarded.borrow().clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_machine_is_loopback() {
        for address in [
            "http://localhost:8600",
            "http://LOCALHOST",
            "http://127.0.0.1",
            "http://127.1.2.3:80",
            "http://[::1]:8600",
            "http://[::ffff:127.0.0.1]",
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
        ] {
            assert!(!is_loopback(&Url::parse(address).unwrap()), "{address}");
        }
    }

    #[test]
    fn a_warning_is_for_plain_http_to_another_host_and_names_only_its_origin() {
        let (origin, text) = notice("http://user:secret@10.0.0.5:8600/path?q=1").unwrap();
        assert_eq!(origin, "http://10.0.0.5:8600");
        assert!(
            text.contains("http://10.0.0.5:8600 is plain http"),
            "{text}"
        );
        assert!(
            !text.contains("secret") && !text.contains("/path"),
            "{text}"
        );
        assert!(text.contains("--allow-http") && text.contains("MARFA_ALLOW_HTTP"));
        assert!(notice("http://marfa.example").is_some());
        for quiet in [
            "https://marfa.example",
            "https://10.0.0.5",
            "http://localhost:8600",
            "http://127.0.0.1:1",
            "http://[::1]",
            "not a url",
            "",
        ] {
            assert_eq!(notice(quiet), None, "{quiet}");
        }
    }
}
