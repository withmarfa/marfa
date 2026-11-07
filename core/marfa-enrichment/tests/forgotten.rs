//! A program that never called `serve_child_if_asked`. It has to stop at its first
//! `read`, and neither start a child nor read the file in itself. The bytes would
//! read as text, so an answer would show that one of those had happened.

use std::panic::{AssertUnwindSafe, catch_unwind};

use marfa_enrichment::{Options, read};

fn main() {
    let options = Options::default();
    let outcome = catch_unwind(AssertUnwindSafe(|| read(b"words", "text/plain", &options)));
    let panic = outcome.expect_err("read went ahead without serve_child_if_asked");
    let message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .unwrap_or_default();
    assert!(
        message.contains("serve_child_if_asked"),
        "the panic does not say what to do: {message}"
    );

    // SAFETY: a plain query of this process's children.
    let children = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
    assert_eq!(children, -1, "a child was started");
    println!("read stopped and started nothing");
}
