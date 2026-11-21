use rusqlite::{Connection, Transaction};

use super::{Axis, Caller, Grants, Level, Permission};
use crate::app::keys::Key;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::vendors;

/// An app's credential reaches `app.*` only where its grant names it, and its own vendors as
/// far as it reaches anything; a key no app made reaches what its map says.
pub fn bind_to_app(tx: &Connection, key: &mut Key) -> Result<()> {
    if let Some(client) = &key.oauth_client_id {
        let own = vendors::of_client(tx, client)?;
        key.grants.maps[Axis::Type as usize].bound_to_app(&own);
    }
    Ok(())
}

/// What an app's new key stores: its own vendors are read again each time it is used, so
/// moving a vendor to another client moves the key's reach with it.
pub fn stored_for_app(tx: &Connection, client: &str, grants: &mut Grants) -> Result<()> {
    let own = vendors::of_client(tx, client)?;
    let map = &mut grants.maps[Axis::Type as usize];
    map.without_vendors(&own);
    map.bound_to_app(&[]);
    Ok(())
}

fn claimed_elsewhere(vendor: &str) -> Refusal {
    Refusal::new(
        Code::Forbidden,
        format!("Another app registered the first type under {vendor}.*, so only it registers there."),
    )
    .with_detail("namespace", vendor)
}

impl Caller {
    /// The OAuth client an app's sign-in or an app's key acts for.
    pub fn app_client(&self) -> Option<&str> {
        match self {
            Caller::App { grant, .. } => Some(&grant.client_id),
            Caller::Key(key) => key.oauth_client_id.as_deref(),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => None,
        }
    }

    /// Before an app registers `id`: claims its vendor for the app when no client holds it,
    /// answering the caller read again with that reach, and refuses a vendor another client holds.
    pub fn claim_vendor(&self, tx: &Transaction<'_>, id: &str, at: &str) -> Result<Option<Caller>> {
        let (Some(vendor), Some(client)) = (vendors::vendor_of(id), self.app_client()) else {
            return Ok(None);
        };
        match vendors::claim_of(tx, vendor)? {
            Some(holder) if holder == client => Ok(None),
            Some(_) => Err(claimed_elsewhere(vendor)),
            None => {
                vendors::claim(tx, vendor, client, at)?;
                self.current(tx, at).map(Some)
            }
        }
    }

    /// Whether an export carries the binding of `vendor`.
    pub fn reads_vendor(&self, vendor: &str) -> bool {
        self.level_on(Axis::Type, vendor) >= Level::Read
    }

    /// Moving a vendor moves an app's data to another app.
    pub fn require_vendor_door(&self) -> Result<()> {
        self.require(Permission::GrantsManage)
    }
}
