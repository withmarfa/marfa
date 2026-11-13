//! For `marfa` and `marfa-server` only: macOS's own allocator keeps the memory a program frees.

#[cfg(not(target_os = "macos"))]
pub use std::alloc::System as Allocator;

#[cfg(not(target_os = "macos"))]
pub fn route_sqlite() {}

#[cfg(target_os = "macos")]
mod jemalloc;

#[cfg(target_os = "macos")]
pub use jemalloc::{Allocator, route_sqlite};
