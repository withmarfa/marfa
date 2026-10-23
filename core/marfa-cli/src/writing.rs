//! Before a command first sends a server a request that can change data, it
//! says which server on stderr, and which profile named it, so a write meant
//! for a test server is not made to another unseen. Under `--json` it says
//! nothing, so that stderr holds a refusal alone.

use std::io::Write;
use std::sync::{Mutex, OnceLock};

static SAID: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PROFILE: OnceLock<(String, String)> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static ANNOUNCED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The profile this run's server came from, by origin and name.
pub fn chosen(origin: &str, name: &str) {
    let _ = PROFILE.set((origin.to_string(), name.to_string()));
}

/// Says, once for each server in a run, that the command writes to it.
pub fn announce(origin: &str) {
    #[cfg(test)]
    ANNOUNCED.with(|announced| announced.borrow_mut().push(origin.to_string()));
    if crate::style::json() {
        return;
    }
    let mut said = SAID
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if said.iter().any(|seen| seen == origin) {
        return;
    }
    said.push(origin.to_string());
    let profile = PROFILE
        .get()
        .filter(|(chosen, _)| chosen == origin)
        .map(|(_, name)| name.as_str());
    let _ = writeln!(std::io::stderr(), "{}", line(origin, profile));
}

fn line(origin: &str, profile: Option<&str>) -> String {
    match profile {
        Some(name) => format!("marfa: writing to {origin} (profile {name})"),
        None => format!("marfa: writing to {origin}"),
    }
}

/// The origins `announce` was called with on this thread, oldest first.
#[cfg(test)]
pub fn announced() -> Vec<String> {
    ANNOUNCED.with(|announced| announced.borrow().clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_names_the_server_and_the_profile_that_chose_it() {
        assert_eq!(
            line("https://marfa.example", None),
            "marfa: writing to https://marfa.example"
        );
        assert_eq!(
            line("http://127.0.0.1:8600", Some("demo")),
            "marfa: writing to http://127.0.0.1:8600 (profile demo)"
        );
    }
}
