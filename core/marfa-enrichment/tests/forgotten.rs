//! A program that never called `serve_child_if_asked`. It has to stop at its first
//! `read`, and neither start a child nor read the file in itself. The file would
//! read as text, so an answer would show that one of those had happened.

use std::fs::File;
use std::io::Write;
use std::panic::{AssertUnwindSafe, catch_unwind};

use libtest_mimic::{Arguments, Failed, Trial};
use marfa_enrichment::{Options, read};

fn read_stops_and_starts_nothing() -> Result<(), Failed> {
    let options = Options::default();
    let mut named = tempfile::NamedTempFile::new().map_err(|error| error.to_string())?;
    named
        .write_all(b"words")
        .map_err(|error| error.to_string())?;
    let file = File::open(named.path()).map_err(|error| error.to_string())?;
    let outcome = catch_unwind(AssertUnwindSafe(|| read(&file, "text/plain", &options)));
    let Err(panic) = outcome else {
        return Err("read went ahead without serve_child_if_asked".into());
    };
    let message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .unwrap_or_default();
    if !message.contains("serve_child_if_asked") {
        return Err(format!("the panic does not say what to do: {message}").into());
    }

    // SAFETY: a plain query of this process's children.
    let children = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
    if children != -1 {
        return Err("a child was started".into());
    }
    Ok(())
}

fn main() {
    let trial = Trial::test(
        "read_stops_and_starts_nothing",
        read_stops_and_starts_nothing,
    );
    libtest_mimic::run(&Arguments::from_args(), vec![trial]).exit();
}
