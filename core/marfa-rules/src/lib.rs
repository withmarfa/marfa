//! Marfa's pure rules: what a client and a server both judge, with no
//! storage, network, runtime or client code. A refusal is data: see
//! [`RuleError`].

pub mod builtin;
pub mod catalog;
pub mod display;
pub mod error;
pub mod filter;
pub mod grammar;
pub mod integers;
pub mod js;
pub mod names;
pub mod query;
pub mod search;
pub mod thumbnail;
pub mod time;
pub mod url_host;
pub mod validation;
pub mod wire;

pub use error::{Code, FieldError, Result, RuleError};
