//! The server releases a device core works with.

/// The oldest server release this core works with, as the root's `version`
/// writes it. A change that makes the core depend on a server change raises it.
/// 0.0.91 is the first release that leaves `app.*` items out of a listing and takes `include=hidden`.
pub const OLDEST_SERVER: &str = "0.0.91";

/// Whether the release a server names is older than [`OLDEST_SERVER`]. A name
/// that is not three whole numbers, and `0.0.0`, which an unstamped build
/// answers, say nothing about what the server does, so neither is older.
pub fn is_too_old(served: &str) -> bool {
    match (numbers(served), numbers(OLDEST_SERVER)) {
        (Some(served), Some(oldest)) => served != [0, 0, 0] && served < oldest,
        _ => false,
    }
}

fn numbers(release: &str) -> Option<[u64; 3]> {
    let mut parts = release.split('.');
    let mut next = || {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let release = [next()?, next()?, next()?];
    parts.next().is_none().then_some(release)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constant_is_a_release() {
        assert!(numbers(OLDEST_SERVER).is_some());
    }

    #[test]
    fn an_older_release_is_too_old_and_the_oldest_and_newer_are_not() {
        assert!(is_too_old("0.0.74"));
        assert!(is_too_old("0.0.70"));
        assert!(!is_too_old(OLDEST_SERVER));
        assert!(is_too_old("0.0.90"));
        assert!(!is_too_old("0.0.92"));
        assert!(!is_too_old("0.1.0"));
        assert!(!is_too_old("1.0.0"));
    }

    #[test]
    fn numbers_compare_as_numbers_not_as_text() {
        assert!(is_too_old("0.0.9"));
        assert!(!is_too_old("0.0.100"));
    }

    #[test]
    fn an_unstamped_or_unreadable_release_is_not_judged() {
        for release in [
            "0.0.0",
            "dev",
            "",
            "0.0",
            "0.0.74.1",
            "0.0.x",
            "v0.0.74",
            "0.0.-1",
            "0.0.74-rc1",
            "0.0.+4",
        ] {
            assert!(!is_too_old(release), "{release}");
        }
    }
}
