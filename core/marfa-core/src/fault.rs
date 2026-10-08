//! Faults a debug build injects where `MARFA_TEST_FAULT` names them, so the
//! device suite can stand a crash, a store that fails, or another process's
//! change at the moment it matters, which no fixture can time from outside.
//! A release build has none.

/// The argument of the named fault, empty where it takes none.
#[cfg(debug_assertions)]
pub(crate) fn named(fault: &str) -> Option<String> {
    std::env::var("MARFA_TEST_FAULT")
        .ok()?
        .split(',')
        .find_map(|one| {
            let (name, argument) = one.split_once('=').unwrap_or((one, ""));
            (name == fault).then(|| argument.to_string())
        })
}

#[cfg(not(debug_assertions))]
pub(crate) fn named(_fault: &str) -> Option<String> {
    None
}
