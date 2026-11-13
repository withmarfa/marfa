#![cfg(target_os = "macos")]

mod common;

#[test]
fn sqlite_takes_its_memory_from_the_allocator() {
    marfa_allocator::route_sqlite();
    assert!(common::sqlite_requests() > 500_000);
}

#[test]
fn the_allocator_is_set_to_return_memory_from_two_arenas_with_no_thread_cache() {
    assert!(!common::setting(c"opt.tcache"));
    assert_eq!(common::dirty_decay_ms(), 0);
    assert_eq!(common::arenas(), 2);
}
