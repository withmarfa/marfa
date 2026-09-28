// The generator's output, held to the generator by CI's freshness check
// rather than to this workspace's lints: a lint fixed here would be undone
// by the next generation.
#![allow(unused_imports)]
#![allow(clippy::all)]

extern crate reqwest;
extern crate serde;
extern crate serde_json;
extern crate serde_repr;
extern crate url;

pub mod apis;
pub mod models;

/// The contract version this client was generated for: the document's
/// `info.version`, which the instance's root answers as `contract`.
pub const CONTRACT_VERSION: u64 = 3;
