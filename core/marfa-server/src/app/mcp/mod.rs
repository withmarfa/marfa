//! What the MCP tools need of the application beyond what every door shares: confirmations that
//! allow one change, the trash on a confirmation, and files fetched from a web address.

pub mod confirm;
pub mod fetch;
pub mod trash;

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
