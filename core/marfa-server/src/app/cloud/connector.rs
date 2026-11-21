//! The connector that carries a linked instance's traffic through Marfa Cloud.

use serde_json::{Value, json};

use crate::app::clock::Stamp;

/// The server runs no connector yet, so it stays stopped from the server's start.
pub struct Connector {
    since: Stamp,
}

impl Connector {
    pub fn new(since: Stamp) -> Connector {
        Connector { since }
    }

    pub fn to_json(&self) -> Value {
        json!({ "state": "stopped", "since": self.since.text() })
    }
}
