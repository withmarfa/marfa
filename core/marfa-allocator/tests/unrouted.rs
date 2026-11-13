#![cfg(target_os = "macos")]

mod common;

#[test]
fn sqlite_asks_the_allocator_for_nothing_unless_it_is_routed() {
    assert!(common::sqlite_requests() < 100_000);
}
