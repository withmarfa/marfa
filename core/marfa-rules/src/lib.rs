//! Marfa's pure rules: what a client and a server both judge, with no
//! database, network, runtime or client code. A refusal is data: see
//! [`RuleError`]. The one record on disk is the self-update's, which
//! the server and `marfa server run` both keep ([`update_record`]).

#![forbid(unsafe_code)]

pub mod builtin;
pub mod catalog;
pub mod conflict;
pub mod contract;
pub mod display;
pub mod edges;
pub mod environment;
pub mod error;
pub mod filter;
pub mod folder;
pub mod grammar;
pub mod integers;
pub mod json_text;
pub mod names;
pub mod number;
pub mod pattern;
pub mod plugin;
pub mod query;
pub mod recurrence;
pub mod release;
pub mod rows;
pub mod schema;
pub mod search;
pub mod server_log;
pub mod thumbnail;
pub mod time;
pub mod type_move;
#[cfg(unix)]
pub mod update_record;
pub mod url_host;
pub mod validation;
pub mod wire;

pub use error::{Code, FieldError, Result, RuleError};
