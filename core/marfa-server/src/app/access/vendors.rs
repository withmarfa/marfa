use rusqlite::{Connection, Transaction};

use super::{Axis, Caller, Grants, Level, Map, Permission};
use crate::app::keys::{Key, Maker};
use crate::app::oauth;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::vendors::{self, Holder};

/// An app's sign-in reaches its own vendors and the `app` names its grant names; its grant's
/// own map stays the one it stores.
pub fn bind_sign_in(tx: &Connection, key: &mut Key) -> Result<()> {
    if let Some(client) = &key.oauth_client_id {
        let own = vendors::of_client(tx, client)?;
        key.stored_types = Some(key.grants.map(Axis::Type).clone());
        key.grants = sign_in_reach(&key.grants, &own);
    }
    Ok(())
}

/// Read again at each use, never from the key's stored map: the owner can move a vendor or
/// narrow the app's grant after the key was made.
pub fn bind_app_key(tx: &Connection, key: &mut Key) -> Result<()> {
    let stored = key
        .stored_types
        .get_or_insert_with(|| key.grants.map(Axis::Type).clone())
        .clone();
    let mut grants = key.grants.clone();
    grants.maps[Axis::Type as usize] = stored;
    key.grants = reach_of(tx, &key.made_by, &grants)?;
    Ok(())
}

/// What a key `maker` made reaches with `stored` as its map, as of the committed state.
pub fn reach_of(tx: &Connection, maker: &Maker, stored: &Grants) -> Result<Grants> {
    match maker {
        Maker::Owner => Ok(stored.clone()),
        Maker::App(client) => app_key_reach(tx, client, stored),
        Maker::Unknown | Maker::Host(_) => Ok(unknown_maker_reach(stored, &vendors::app_held(tx)?)),
    }
}

/// What a key `client` made reaches with `stored` as its map, as of the committed state.
pub fn app_key_reach(tx: &Connection, client: &str, stored: &Grants) -> Result<Grants> {
    let own = vendors::of_client(tx, client)?;
    let grant = oauth::standing_reach(tx, client)?;
    Ok(key_reach(stored, grant.as_ref(), &own))
}

/// A key no record names a maker for reaches under `app` only what its map names there, and no
/// vendor an app holds.
pub fn unknown_maker_reach(stored: &Grants, app_held: &[String]) -> Grants {
    let mut reach = stored.clone();
    reach.maps[Axis::Type as usize] = stored
        .map(Axis::Type)
        .naming_apps()
        .without_vendors(app_held);
    reach
}

pub fn sign_in_reach(granted: &Grants, own: &[String]) -> Grants {
    let mut reach = granted.clone();
    reach.maps[Axis::Type as usize].for_sign_in(own);
    reach
}

/// A key an app made reaches under `app` only what its map names there, within what the app's
/// sign-in reaches now, or only its own vendors while no grant stands.
pub fn key_reach(stored: &Grants, grant: Option<&Grants>, own: &[String]) -> Grants {
    let ceiling = match grant {
        Some(grant) => sign_in_reach(grant, own).map(Axis::Type).clone(),
        None => Map::only_vendors(own),
    };
    let mut reach = stored.clone();
    reach.maps[Axis::Type as usize] = stored.map(Axis::Type).naming_apps().within_apps(&ceiling);
    reach
}

/// The maps a key stores, read as its maker's rule reads them, for judging one stored map
/// against another.
pub fn as_stored(key: &Key) -> Grants {
    let mut stored = key.grants.clone();
    let types = key
        .stored_types
        .as_ref()
        .unwrap_or(key.grants.map(Axis::Type));
    stored.maps[Axis::Type as usize] = named_by(&key.made_by, types);
    stored
}

/// `stored` as a key `maker` made reads it.
pub fn named_by(maker: &Maker, stored: &Map) -> Map {
    match maker {
        Maker::Owner => stored.clone(),
        Maker::App(_) | Maker::Host(_) | Maker::Unknown => stored.naming_apps(),
    }
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

/// Refuses a key of unknown maker a type under a vendor an app holds.
fn outside_apps(tx: &Connection, vendor: &str) -> Result<()> {
    match vendors::holder_of(tx, vendor)? {
        Some(Holder::App(_)) => Err(claimed_elsewhere(vendor)),
        Some(Holder::Owner) | None => Ok(()),
    }
}

pub(super) fn unknown_maker(action: &str) -> Refusal {
    Refusal::new(
        Code::Forbidden,
        format!(
            "No record shows the owner made this key, so it cannot {action}. Mint a new key with an owner credential."
        ),
    )
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
            Caller::Key(key) => key.made_by.client(),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => None,
        }
    }

    /// Who a key this caller mints is made by: a key's maker passes to the keys it mints.
    pub fn maker(&self) -> Maker {
        match self {
            Caller::App { grant, .. } => Maker::App(grant.client_id.clone()),
            Caller::Key(key) => key.made_by.clone(),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => Maker::Owner,
        }
    }

    /// Whether the caller is a key no record shows the owner or an app made, a host's included.
    pub fn maker_unknown(&self) -> bool {
        matches!(self, Caller::Key(key) if matches!(key.made_by, Maker::Unknown | Maker::Host(_)))
    }

    /// The registration needs the caller's new reach in the transaction that claims the vendor.
    pub fn claim_vendor(&self, tx: &Transaction<'_>, id: &str, at: &str) -> Result<Option<Caller>> {
        let Some(vendor) = vendors::vendor_of(id) else {
            return Ok(None);
        };
        let Some(client) = self.app_client() else {
            if self.maker_unknown() {
                outside_apps(tx, vendor)?;
            }
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

    /// Listing or removing a vendor's data at its own door, decided on who holds it now.
    pub fn require_vendor_data(
        &self,
        tx: &Connection,
        vendor: &str,
        removing: bool,
    ) -> Result<Holder> {
        self.require_vendor_door()?;
        if removing && !matches!(self, Caller::Owner(_)) {
            self.require(Permission::ItemsPurge)?;
        }
        let holder = vendors::holder_of(tx, vendor)?.ok_or_else(|| {
            Refusal::new(
                Code::NotFound,
                format!("No app or owner holds {vendor}, so it has no data."),
            )
            .with_detail("vendor", vendor)
        })?;
        self.require_vendor_reach(vendor, &holder)?;
        Ok(holder)
    }

    /// An app reaches only its own vendors' data, and a key of unknown maker none an app holds.
    pub fn require_vendor_reach(&self, vendor: &str, holder: &Holder) -> Result<()> {
        if let Some(client) = self.app_client() {
            if *holder != Holder::App(client.to_string()) {
                return Err(Refusal::new(
                    Code::Forbidden,
                    format!(
                        "An app's sign-in or a key an app made reaches only the data of its own vendors, and {vendor} is not one."
                    ),
                )
                .with_detail("namespace", vendor));
            }
        } else if self.maker_unknown() && matches!(holder, Holder::App(_)) {
            return Err(unknown_maker("reach the data of a vendor an app holds"));
        }
        Ok(())
    }

    /// A credential reaches a vendor's data only as its type map reaches every type in it.
    pub fn require_vendor_types(
        &self,
        vendor: &str,
        types: &[String],
        removing: bool,
        deletes_types: bool,
    ) -> Result<()> {
        if self.key().is_none() {
            return Ok(());
        }
        let level = if removing { Level::Write } else { Level::Read };
        if types
            .iter()
            .any(|type_id| self.level_on(Axis::Type, type_id) < level)
        {
            let pattern = format!("{vendor}.*");
            return Err(Refusal::new(
                Code::TypeNotPermitted,
                format!(
                    "This credential's type map does not give {} on every type under {vendor}.",
                    level.word()
                ),
            )
            .with_detail("grant", super::schema::grant("type", &pattern, level)));
        }
        if removing && deletes_types {
            self.require(Permission::SchemaWrite)?;
        }
        Ok(())
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
        if self.maker_unknown() {
            return Err(unknown_maker("give a vendor to an app"));
        }
        Ok(())
    }
}
