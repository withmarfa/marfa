use rusqlite::Transaction;

use super::{Caller, Permission, standing_holder, unauthorized};
use crate::app::attention::RAISED;
use crate::app::clock::Stamp;
use crate::app::refusal::Result;
use crate::app::webhooks::Subscription;

/// App subscriptions belong to the grant, not an individual token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Maker {
    Key(String),
    Grant(String),
}

impl Caller {
    /// A subscription belongs to a key or grant, so local authority cannot make or change one.
    pub fn webhook_maker(&self) -> Result<Maker> {
        self.require(Permission::WebhooksManage)?;
        match self {
            Caller::Key(key) => Ok(Maker::Key(key.id.clone())),
            Caller::App { grant, .. } => Ok(Maker::Grant(grant.grant_id.clone())),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => Err(unauthorized()),
        }
    }

    /// `None` reaches every maker for reads and deletion.
    pub fn webhook_reach(&self) -> Result<Option<Maker>> {
        if self.reaches_every_webhook() {
            return Ok(None);
        }
        self.webhook_redelivery_reach()
    }

    /// Redelivery reaches only the caller's own subscriptions, or every one for local authority.
    pub fn webhook_redelivery_reach(&self) -> Result<Option<Maker>> {
        self.require(Permission::WebhooksManage)?;
        match self {
            Caller::Local(_) => Ok(None),
            Caller::Owner(_) | Caller::Server => Err(unauthorized()),
            Caller::Key(_) | Caller::App { .. } => self.webhook_maker().map(Some),
        }
    }

    pub fn reaches_every_webhook(&self) -> bool {
        match self {
            Caller::Local(_) => self.holds(Permission::WebhooksManage),
            Caller::Key(_) | Caller::App { .. } => {
                self.holds(Permission::WebhooksManage) && self.holds(Permission::KeysManage)
            }
            Caller::Owner(_) | Caller::Server => false,
        }
    }
}

/// Requires a live maker that still holds `webhooks.manage`.
pub fn standing_maker(tx: &Transaction<'_>, maker: &Maker, at: &str) -> Result<Option<Caller>> {
    let caller = standing_holder(tx, maker, at)?;
    Ok(caller.filter(|caller| caller.holds(Permission::WebhooksManage)))
}

/// A subscription that may be told of a new attention entry while the database fails.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listener {
    pub webhook_id: String,
    pub maker: Maker,
    pub url: String,
    pub secret: String,
    /// When the maker's key stops standing, which a send judges against the clock.
    pub expires_at: Option<Stamp>,
}

/// Each active subscription to `attention.raised` whose maker stands, at `at`, with
/// `webhooks.manage` and `instance.read`, as a delivery from the log requires. A subscription
/// whose maker does not read is left out.
pub fn attention_listeners(
    tx: &Transaction<'_>,
    subscriptions: Vec<Subscription>,
    at: &str,
) -> Vec<Listener> {
    subscriptions
        .into_iter()
        .filter(|subscription| {
            subscription.active && subscription.events.iter().any(|name| name == RAISED)
        })
        .filter_map(
            |subscription| match listening(tx, &subscription.maker, at) {
                Ok(Some(expires_at)) => Some(Listener {
                    webhook_id: subscription.id,
                    maker: subscription.maker,
                    url: subscription.url,
                    secret: subscription.secret,
                    expires_at,
                }),
                Ok(None) => None,
                Err(refused) => {
                    tracing::warn!(error = %refused, "A webhook's maker could not be read");
                    None
                }
            },
        )
        .collect()
}

/// When a maker that may hear attention entries stops standing, if it ever does.
fn listening(tx: &Transaction<'_>, maker: &Maker, at: &str) -> Result<Option<Option<Stamp>>> {
    let Some(caller) = standing_maker(tx, maker, at)?.filter(Caller::reads_attention) else {
        return Ok(None);
    };
    Ok(Some(match &caller {
        Caller::Key(key) => key.expires_at.as_deref().map(Stamp::read).transpose()?,
        _ => None,
    }))
}
