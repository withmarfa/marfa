//! Confirmation and fetch operations used by MCP tools.

pub mod app_data;
pub mod confirm;
pub mod connector;
pub mod fetch;
pub mod guard;
pub mod instance;
pub mod moving;
pub mod purge;
pub mod revoke;
pub mod sign_in;
pub mod trash;
pub mod webhook;

use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::app::refusal::Result;

pub struct Mcp {
    pub signer: confirm::Signer,
    pub fetches: Arc<Semaphore>,
}

impl Mcp {
    pub fn new(auth_secret: &str) -> Result<Mcp> {
        Ok(Mcp {
            signer: confirm::Signer::derive(auth_secret)?,
            fetches: Arc::new(Semaphore::new(fetch::AT_ONCE)),
        })
    }
}
