use rusqlite::Transaction;

use super::{Caller, Permission, standing_key, unauthorized};
use crate::app::keys;
use crate::app::oauth;
use crate::app::refusal::Result;

/// App subscriptions belong to the grant, not an individual token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Maker {
    Key(String),
    Grant(String),
}

impl Caller {
    /// Only a key or an app registers, changes or removes a subscription, since each belongs to one.
    pub fn webhook_maker(&self) -> Result<Maker> {
        self.require(Permission::WebhooksManage)?;
        match self {
            Caller::Key(key) => Ok(Maker::Key(key.id.clone())),
            Caller::App { grant, .. } => Ok(Maker::Grant(grant.grant_id.clone())),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => Err(unauthorized()),
        }
    }

    /// Local authority reaches every maker for reads and redelivery.
    pub fn webhook_reach(&self) -> Result<Option<Maker>> {
        self.require(Permission::WebhooksManage)?;
        match self {
            Caller::Local(_) => Ok(None),
            Caller::Owner(_) | Caller::Server => Err(unauthorized()),
            Caller::Key(_) | Caller::App { .. } => self.webhook_maker().map(Some),
        }
    }
}

/// Requires a live maker that still holds `webhooks.manage`.
pub fn standing_maker(tx: &Transaction<'_>, maker: &Maker, at: &str) -> Result<Option<Caller>> {
    let caller = match maker {
        Maker::Key(id) => match keys::live_by_id(tx, id, at)? {
            Some(key) => Some(Caller::Key(Box::new(standing_key(tx, key)?))),
            None => None,
        },
        Maker::Grant(grant_id) => oauth::grant_caller(tx, grant_id)?,
    };
    Ok(caller.filter(|caller| caller.holds(Permission::WebhooksManage)))
}
