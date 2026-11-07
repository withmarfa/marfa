//! Sign-in by OAuth. The rules that decide on untrusted text (`scope`,
//! `redirect`, `client`, `pkce` and their kin) need no database or HTTP; the
//! rest read and write the rows in `store` around them.

pub mod authorize;
mod bearer;
pub mod client;
pub mod clients;
pub mod device;
pub mod discovery;
pub mod grant;
pub mod metadata_document;
pub mod offer;
pub mod pkce;
pub mod redirect;
pub mod register;
pub mod resource;
pub mod revoke;
pub mod scope;
pub mod signed_link;
pub mod store;
pub mod sweep;
pub mod token;
pub mod tokens;

use serde_json::{Value, json};

use super::App;
pub use bearer::{Granted, authenticate, live_by_id};

const ACCESS_TOKEN_SECONDS: i64 = 3_600;
const CODE_SECONDS: i64 = 600;
const REFRESH_TOKEN_SECONDS: i64 = 30 * 24 * 3_600;
const DEVICE_CODE_SECONDS: i64 = 600;
const DEVICE_INTERVAL_SECONDS: i64 = 5;
const MS_PER_SECOND: i64 = 1_000;

/// A refusal in the form the OAuth RFCs give, for a door that answers one
/// rather than the error envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Problem {
    pub status: u16,
    pub error: &'static str,
    pub description: String,
}

impl Problem {
    pub fn new(error: &'static str, description: impl Into<String>) -> Problem {
        Problem {
            status: 400,
            error,
            description: description.into(),
        }
    }

    pub fn with_status(self, status: u16) -> Problem {
        Problem { status, ..self }
    }

    pub fn to_json(&self) -> Value {
        json!({ "error": self.error, "error_description": self.description })
    }
}

/// What a door's logic answers when the refusal is the outcome and whatever
/// it wrote still commits, as a replayed token ending its chain must.
pub type Answered<T> = std::result::Result<T, Problem>;

/// This instance as an authorization server names itself, as it stands now.
pub fn issuer(app: &App) -> String {
    format!("{}/auth", app.addresses().sign_in().origin())
}
