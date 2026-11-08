use rusqlite::Transaction;

use super::{Caller, Permission, standing_key, unauthorized};
use crate::app::keys;
use crate::app::oauth;
use crate::app::refusal::Result;

/// The credential a subscription belongs to. An app's subscriptions belong to its grant, so
/// every token of the grant reaches them.
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

    /// The subscriptions a read or a redelivery reaches: a maker's own, or every one for the
    /// local command.
    pub fn webhook_reach(&self) -> Result<Option<Maker>> {
        self.require(Permission::WebhooksManage)?;
        match self {
            Caller::Local(_) => Ok(None),
            Caller::Owner(_) | Caller::Server => Err(unauthorized()),
            Caller::Key(_) | Caller::App { .. } => self.webhook_maker().map(Some),
        }
    }
}

/// The credential a subscription's deliveries are judged under as it stands at `at`, or `None`
/// once it no longer stands or no longer holds `webhooks.manage`.
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
