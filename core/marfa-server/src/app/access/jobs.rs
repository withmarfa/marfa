use rusqlite::Transaction;

use super::{Axis, Caller, Level, Maker, Permission, standing_key, unauthorized};
use crate::app::keys;
use crate::app::oauth;
use crate::app::refusal::{Code, Refusal, Result};

const FOLDER_TYPE: &str = "system.folder";
const VIEW_TYPE: &str = "system.view";

/// Which of a type move's settings a credential may name and change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Setting<'a> {
    Folder,
    View,
    Webhook(&'a Maker),
}

impl Caller {
    /// A job acts for one key, or for one app and person whichever token they hold.
    pub fn job_holder(&self) -> Result<Maker> {
        match self {
            Caller::Key(key) => Ok(Maker::Key(key.id.clone())),
            Caller::App { grant, .. } => Ok(Maker::Grant(grant.grant_id.clone())),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => Err(unauthorized()),
        }
    }

    fn holds_job(&self, holder: &Maker) -> bool {
        self.job_holder().is_ok_and(|own| own == *holder)
    }

    pub fn require_job_read(&self, holder: &Maker) -> Result<()> {
        self.require_job(holder, Permission::InstanceRead)
    }

    pub fn require_job_cancel(&self, holder: &Maker) -> Result<()> {
        self.require_job(holder, Permission::InstanceMaintain)
    }

    fn require_job(&self, holder: &Maker, permission: Permission) -> Result<()> {
        if matches!(self, Caller::Local(_)) || self.holds_job(holder) || self.holds(permission) {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Forbidden,
            format!(
                "Another credential queued this job, and this one does not hold {}.",
                permission.word()
            ),
        )
        .with_detail("required_scope", permission.word()))
    }

    /// Whether the job's purge may go on: a key that lost `items.purge` purges nothing further.
    pub fn purges(&self) -> bool {
        self.holds(Permission::ItemsPurge)
    }

    pub fn may_read_setting(&self, setting: Setting<'_>) -> bool {
        match setting {
            Setting::Folder => self.level_on(Axis::Type, FOLDER_TYPE) >= Level::Read,
            Setting::View => self.level_on(Axis::Type, VIEW_TYPE) >= Level::Read,
            Setting::Webhook(maker) => self.makes(maker),
        }
    }

    /// As the setting's own door would decide it.
    pub fn may_change_setting(&self, setting: Setting<'_>) -> bool {
        match setting {
            Setting::Folder => self.level_on(Axis::Type, FOLDER_TYPE) >= Level::Write,
            Setting::View => self.level_on(Axis::Type, VIEW_TYPE) >= Level::Write,
            Setting::Webhook(maker) => self.makes(maker),
        }
    }

    fn makes(&self, maker: &Maker) -> bool {
        matches!(self, Caller::Local(_))
            || self
                .webhook_maker()
                .is_ok_and(|own| own == *maker)
    }

    pub fn lists_key_grants(&self) -> bool {
        self.holds(Permission::KeysManage)
    }

    pub fn lists_app_grants(&self) -> bool {
        self.holds(Permission::GrantsManage)
    }
}

/// App jobs outlive their access tokens while the grant stands.
pub fn standing_holder(tx: &Transaction<'_>, holder: &Maker, at: &str) -> Result<Option<Caller>> {
    Ok(match holder {
        Maker::Key(id) => match keys::live_by_id(tx, id, at)? {
            Some(key) => Some(Caller::Key(Box::new(standing_key(tx, key)?))),
            None => None,
        },
        Maker::Grant(grant_id) => oauth::grant_caller(tx, grant_id)?,
    })
}
