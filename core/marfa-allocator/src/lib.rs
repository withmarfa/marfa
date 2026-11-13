//! The allocator of the two programs that run on their own, `marfa` and `marfa-server`.
//! The core and its bindings, which an app embeds, keep the allocator the app has.
//!
//! macOS's own allocator keeps the memory a program frees, so a program holds its busiest moment
//! for good. Elsewhere the system's allocator returns it, and nothing here changes.

#[cfg(not(target_os = "macos"))]
pub use std::alloc::System as Allocator;

#[cfg(not(target_os = "macos"))]
pub fn route_sqlite() {}

#[cfg(target_os = "macos")]
mod jemalloc;

#[cfg(target_os = "macos")]
pub use jemalloc::{Allocator, route_sqlite};
