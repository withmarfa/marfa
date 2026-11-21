use rusqlite::{Connection, Transaction};

use super::{Axis, Caller, Grants, Level, Permission};
use crate::app::keys::Key;
use crate::app::oauth;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::vendors::{self, Holder};

/// An app's sign-in reaches its own vendors and the `app` names its grant names.
pub fn bind_sign_in(tx: &Connection, key: &mut Key) -> Result<()> {
    if let Some(client) = &key.oauth_client_id {
        let own = vendors::of_client(tx, client)?;
        key.grants = sign_in_reach(&key.grants, &own);
    }
    Ok(())
}

/// Read again at each use, never from the key's stored map: the owner can move a vendor or
/// narrow the app's grant after the key was made.
pub fn bind_app_key(tx: &Connection, key: &mut Key) -> Result<()> {
    if let Some(client) = key.made_by_client.clone() {
        key.grants = app_key_reach(tx, &client, &key.grants)?;
    }
    Ok(())
}

/// What a key `client` made reaches with `stored` as its map, as of the committed state.
pub fn app_key_reach(tx: &Connection, client: &str, stored: &Grants) -> Result<Grants> {
    let own = vendors::of_client(tx, client)?;
    let grant = oauth::standing_reach(tx, client)?;
    Ok(key_reach(stored, grant.as_ref(), &own))
}

pub fn sign_in_reach(granted: &Grants, own: &[String]) -> Grants {
    let mut reach = granted.clone();
    reach.maps[Axis::Type as usize].for_sign_in(own);
    reach
}

pub fn key_reach(stored: &Grants, grant: Option<&Grants>, own: &[String]) -> Grants {
    let mut reach = stored.clone();
    reach.maps[Axis::Type as usize] = stored
        .map(Axis::Type)
        .for_app_key(grant.map(|grant| grant.map(Axis::Type)), own);
    reach
}

/// `key` as it reaches now, for comparing one credential's reach with another's.
pub fn reaching(tx: &Connection, key: &Key) -> Result<Key> {
    let mut reach = key.clone();
    bind_app_key(tx, &mut reach)?;
    Ok(reach)
}

fn claimed_elsewhere(vendor: &str) -> Refusal {
    Refusal::new(
        Code::Forbidden,
        format!(
            "Another app registered the first type under {vendor}.*, so only it registers there."
        ),
    )
    .with_detail("namespace", vendor)
}

fn held_for_owner(vendor: &str) -> Refusal {
    Refusal::new(
        Code::Forbidden,
        format!(
            "No app is known to hold {vendor}.*, so only the owner gives it to an app, with PUT /app-vendors/{vendor}."
        ),
    )
    .with_detail("namespace", vendor)
}

/// Refuses `client` a type under `vendor` another app or the owner holds; answers whether
/// `client` holds it.
fn registrable(tx: &Connection, vendor: &str, client: &str) -> Result<bool> {
    match vendors::holder_of(tx, vendor)? {
        Some(Holder::App(holder)) if holder == client => Ok(true),
        Some(Holder::App(_)) => Err(claimed_elsewhere(vendor)),
        Some(Holder::Owner) => Err(held_for_owner(vendor)),
        None => Ok(false),
    }
}

impl Caller {
    pub fn app_client(&self) -> Option<&str> {
        match self {
            Caller::App { grant, .. } => Some(&grant.client_id),
            Caller::Key(key) => key.made_by_client.as_deref(),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => None,
        }
    }

    /// The registration needs the caller's new reach in the transaction that claims the vendor.
    pub fn claim_vendor(&self, tx: &Transaction<'_>, id: &str, at: &str) -> Result<Option<Caller>> {
        let Some(vendor) = vendors::vendor_of(id) else {
            return Ok(None);
        };
        let Some(client) = self.app_client() else {
            if !matches!(self, Caller::Server) {
                vendors::hold(tx, vendor, at)?;
            }
            return Ok(None);
        };
        if registrable(tx, vendor, client)? {
            return Ok(None);
        }
        vendors::claim(tx, vendor, client, at)?;
        self.current(tx, at).map(Some)
    }

    /// A restore registers a type under a held vendor only where direct registration would.
    pub fn require_restored_vendors<'a>(
        &self,
        tx: &Connection,
        ids: impl Iterator<Item = &'a str>,
    ) -> Result<()> {
        let Some(client) = self.app_client() else {
            return Ok(());
        };
        for vendor in ids.filter_map(vendors::vendor_of) {
            registrable(tx, vendor, client)?;
        }
        Ok(())
    }

    /// Whether the caller reads the vendor's wildcard or a type registered under it, of `ids`.
    pub fn reads_vendor<'a>(&self, vendor: &str, mut ids: impl Iterator<Item = &'a str>) -> bool {
        let wildcard = match self {
            Caller::Key(key) | Caller::App { key, .. } => key
                .grants
                .map(Axis::Type)
                .entry_level(&format!("{vendor}.*")),
            Caller::Local(_) | Caller::Server => Level::Write,
            Caller::Owner(_) => Level::None,
        };
        wildcard >= Level::Read
            || ids.any(|id| {
                vendors::vendor_of(id) == Some(vendor)
                    && self.level_on(Axis::Type, id) >= Level::Read
            })
    }

    /// The owner's browser manages vendors as the owner, holding no permission of its own.
    pub fn require_vendor_door(&self) -> Result<()> {
        match self {
            Caller::Owner(_) => Ok(()),
            _ => self.require(Permission::GrantsManage),
        }
    }

    /// Moving a vendor hands one app what another keeps for itself, which only the owner approves.
    pub fn require_vendor_move(&self) -> Result<()> {
        self.require_vendor_door()?;
        if self.app_client().is_some() {
            return Err(Refusal::new(
                Code::Forbidden,
                "Only the owner gives a vendor to an app: an app's sign-in or a key an app made cannot.",
            ));
        }
        Ok(())
    }
}
