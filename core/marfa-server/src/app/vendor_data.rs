//! What an app keeps under its `app.<vendor>` namespaces: the owner lists it and removes it.

use arc_swap::ArcSwap;
use rusqlite::Transaction;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::access::{Caller, Maker, Permission};
use super::catalog::{self, Catalog, Snapshot};
use super::oauth::store;
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use super::vendors::{self, Holder};
use super::{App, instance, items, keys, types, webhooks};

/// The most items one removal takes, as one purge of chosen items does.
pub const MOST_REMOVED: usize = 1_000;
const REMOVED: &str = "app_data.delete";

/// What one removal took, and how many items of the vendors it left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Removal {
    pub items: usize,
    pub types: usize,
    pub remaining: usize,
}

impl Removal {
    fn add(&mut self, other: Removal) {
        self.items += other.items;
        self.types += other.types;
        self.remaining += other.remaining;
    }
}

/// The holder's grant and every key it made, which own the webhooks that go with its types.
fn makers_of(tx: &Transaction<'_>, holder: &Holder) -> Result<Vec<Maker>> {
    let Holder::App(client) = holder else {
        return Ok(Vec::new());
    };
    let mut makers: Vec<Maker> = keys::ids_of_app(tx, client)?
        .into_iter()
        .map(Maker::Key)
        .collect();
    if let Some(owner) = instance::owner_id(tx)?
        && let Some(consent) = store::consent(tx, client, &owner)?
    {
        makers.push(Maker::Grant(consent.grant_id));
    }
    Ok(makers)
}

/// How the command line removes a vendor's data in pages.
pub const PAGED_CLI: &str = "`marfa apps vendors data delete <vendor> --confirm PURGE`";

pub(crate) fn over_cap(vendors: &str, total: usize, paged: &str) -> Refusal {
    Refusal::new(
        Code::BulkCapExceeded,
        format!(
            "{vendors}: {total} items, more than one write removes. Remove them first with {paged} for each, which takes them in pages."
        ),
    )
    .with_detail("cap", MOST_REMOVED)
}

/// The types a vendor's items hold, registered or not, and the types registered under it.
#[derive(Clone, Debug)]
struct Set {
    all: Vec<String>,
    registered: Vec<String>,
}

fn set_of(tx: &Transaction<'_>, vendor: &str) -> Result<Set> {
    let registered = types::write::ids_under_vendor(tx, vendor)?;
    let mut all = items::types_under_vendor(tx, vendor)?;
    all.extend(registered.iter().cloned());
    all.sort();
    all.dedup();
    Ok(Set { all, registered })
}

/// The vendor's set, refused unless the caller's type map reaches it as the act needs.
fn reached_set(tx: &Transaction<'_>, caller: &Caller, vendor: &str, removing: bool) -> Result<Set> {
    let set = set_of(tx, vendor)?;
    caller.require_vendor_types(vendor, &set.all, removing, !set.registered.is_empty())?;
    Ok(set)
}

fn item_total(tx: &Transaction<'_>, types: &[String]) -> Result<usize> {
    let total: i64 = items::counts_of_types(tx, types)?
        .iter()
        .map(|(_, _, count)| count)
        .sum();
    Ok(usize::try_from(total).unwrap_or(usize::MAX))
}

/// Removes up to [`MOST_REMOVED`] of the vendor's items, and its types once none is left.
fn remove_vendor(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    vendor: &str,
    holder: &Holder,
    set: &Set,
) -> Result<Removal> {
    let tx = unit.tx();
    let catalog = catalog::current(cache, tx, Snapshot::Pending)?;
    let dropping = webhooks::held_naming(tx, &makers_of(tx, holder)?, &set.registered)?;
    let dropped: Vec<String> = dropping.iter().map(|hook| hook.id.clone()).collect();
    types::write::require_set_free(tx, &catalog, &unit.caller, &set.registered, &dropped)?;
    let taken = items::write::purge_of_types(unit, cache, &set.all, MOST_REMOVED)?;
    let remaining = item_total(tx, &set.all)?;
    let mut removal = Removal {
        items: taken,
        types: 0,
        remaining,
    };
    if remaining == 0 {
        webhooks::forget(unit, &dropping)?;
        removal.types = types::write::delete_set(unit, cache, &set.registered, &dropped)?;
    }
    unit.audit_also(
        REMOVED,
        "app_vendor",
        vendor,
        Some(json!({
            "removed_items": removal.items,
            "removed_types": removal.types,
            "remaining_items": removal.remaining,
        })),
    )?;
    Ok(removal)
}

/// One page of the vendor's removal in the caller's write, judged at the vendor's own door.
pub(crate) fn remove_in(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    vendor: &str,
) -> Result<Removal> {
    let holder = unit.caller.require_vendor_data(unit.tx(), vendor, true)?;
    let set = reached_set(unit.tx(), &unit.caller, vendor, true)?;
    remove_vendor(unit, cache, vendor, &holder, &set)
}

/// Each vendor the app holds with its set, refused as removing them with the app would be.
fn client_sets(
    tx: &Transaction<'_>,
    caller: &Caller,
    client_id: &str,
) -> Result<(Holder, Vec<(String, Set)>)> {
    let holder = Holder::App(client_id.to_string());
    let mut sets = Vec::new();
    for vendor in vendors::of_client(tx, client_id)? {
        caller.require_vendor_reach(&vendor, &holder)?;
        let set = reached_set(tx, caller, &vendor, true)?;
        sets.push((vendor, set));
    }
    Ok((holder, sets))
}

/// Removes every vendor the app holds in the caller's write, all of it or nothing.
pub(crate) fn remove_of_client(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    client_id: &str,
) -> Result<Removal> {
    unit.caller.require(Permission::ItemsPurge)?;
    let (holder, sets) = client_sets(unit.tx(), &unit.caller, client_id)?;
    let mut total = 0;
    for (_, set) in &sets {
        total += item_total(unit.tx(), &set.all)?;
    }
    if total > MOST_REMOVED {
        let names: Vec<&str> = sets.iter().map(|(vendor, _)| vendor.as_str()).collect();
        return Err(over_cap(&names.join(", "), total, PAGED_CLI));
    }
    let mut removal = Removal::default();
    for (vendor, set) in &sets {
        removal.add(remove_vendor(unit, cache, vendor, &holder, set)?);
    }
    Ok(removal)
}

fn counts_json(types: &[String], counts: &[(String, String, i64)]) -> Vec<Value> {
    types
        .iter()
        .map(|id| {
            let of = |state: &str| -> i64 {
                counts
                    .iter()
                    .filter(|(type_id, held, _)| type_id == id && held == state)
                    .map(|(_, _, count)| count)
                    .sum()
            };
            json!({
                "type": id,
                "active": of("active"),
                "archived": of("archived"),
                "trashed": of("trashed"),
            })
        })
        .collect()
}

/// What a vendor holds, as a preview shows it and its confirmation binds it.
#[derive(Clone, Debug)]
pub struct Held {
    pub vendor: String,
    pub client_id: Option<String>,
    /// Each type with its items counted by state.
    pub types: Vec<Value>,
    pub items: usize,
    /// Covers the registered types, the counts and the versions of the items one removal takes.
    pub digest: String,
}

impl Held {
    pub fn to_json(&self) -> Value {
        json!({
            "vendor": self.vendor,
            "client_id": self.client_id,
            "types": self.types,
            "items": self.items,
        })
    }
}

fn held_of_set(tx: &Transaction<'_>, vendor: &str, holder: &Holder, set: &Set) -> Result<Held> {
    let counts = items::counts_of_types(tx, &set.all)?;
    let bound = i64::try_from(MOST_REMOVED).unwrap_or(i64::MAX);
    let versions = items::versions_of_types(tx, &set.all, bound)?;
    let digest = hex::encode(Sha256::digest(
        json!([vendor, holder_id(holder), set.registered, counts, versions])
            .to_string()
            .as_bytes(),
    ));
    let total: i64 = counts.iter().map(|(_, _, count)| count).sum();
    Ok(Held {
        vendor: vendor.to_string(),
        client_id: holder_id(holder),
        types: counts_json(&set.all, &counts),
        items: usize::try_from(total).unwrap_or(usize::MAX),
        digest,
    })
}

/// What the vendor holds now, as the caller may read it at the vendor's own door.
pub(crate) fn held(tx: &Transaction<'_>, caller: &Caller, vendor: &str) -> Result<Held> {
    let holder = caller.require_vendor_data(tx, vendor, false)?;
    let set = reached_set(tx, caller, vendor, false)?;
    held_of_set(tx, vendor, &holder, &set)
}

/// What every vendor the app holds keeps, refused as ending it with its data would be.
pub(crate) fn held_of_client(
    tx: &Transaction<'_>,
    caller: &Caller,
    client_id: &str,
) -> Result<Vec<Held>> {
    let (holder, sets) = client_sets(tx, caller, client_id)?;
    sets.iter()
        .map(|(vendor, set)| held_of_set(tx, vendor, &holder, set))
        .collect()
}

/// A vendor's preview, with the refusal a removal by the caller would meet, if any.
pub async fn preview(app: &App, caller: &Caller, vendor: String) -> Result<(Held, Result<()>)> {
    let caller = caller.clone();
    let at = app.clock.stamp();
    app.db
        .read(move |tx| {
            let caller = caller.current(tx, &at)?;
            let held = held(tx, &caller, &vendor)?;
            let removable = caller
                .require_vendor_data(tx, &vendor, true)
                .and_then(|_| reached_set(tx, &caller, &vendor, true).map(|_| ()));
            Ok((held, removable))
        })
        .await
}

fn holder_id(holder: &Holder) -> Option<String> {
    match holder {
        Holder::App(client) => Some(client.clone()),
        Holder::Owner => None,
    }
}

/// The vendor's types with their items counted by state, and a page of its items.
pub async fn listed(
    app: &App,
    caller: &Caller,
    vendor: String,
    cursor: Option<String>,
    limit: i64,
) -> Result<Value> {
    items::reading(app, caller, move |read| {
        let holder = read.caller.require_vendor_data(read.tx, &vendor, false)?;
        let set = reached_set(read.tx, &read.caller, &vendor, false)?;
        let counts = items::counts_of_types(read.tx, &set.all)?;
        let (data, next) = read.of_types_page(&set.all, cursor.as_deref(), limit)?;
        Ok(json!({
            "vendor": vendor,
            "client_id": holder_id(&holder),
            "types": counts_json(&set.all, &counts),
            "data": data,
            "next_cursor": next,
        }))
    })
    .await
}

/// Removes up to [`MOST_REMOVED`] of the vendor's items, and its types in the call that empties it.
pub async fn remove(app: &App, caller: &Caller, vendor: String) -> Result<Value> {
    let cache = app.catalog_handle();
    let named = vendor.clone();
    let removal = app
        .write(caller, REMOVED, move |unit| {
            remove_in(unit, &cache, &vendor)
        })
        .await?;
    if removal.types > 0 {
        app.publish_catalog().await;
    }
    Ok(json!({
        "vendor": named,
        "removed_items": removal.items,
        "removed_types": removal.types,
        "remaining_items": removal.remaining,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_type_counts_its_items_by_state_and_a_type_with_none_counts_zero() {
        let types = vec!["app.acme.a".to_string(), "app.acme.b".to_string()];
        let counts = vec![
            ("app.acme.a".to_string(), "active".to_string(), 2),
            ("app.acme.a".to_string(), "trashed".to_string(), 1),
        ];
        assert_eq!(
            counts_json(&types, &counts),
            vec![
                json!({ "type": "app.acme.a", "active": 2, "archived": 0, "trashed": 1 }),
                json!({ "type": "app.acme.b", "active": 0, "archived": 0, "trashed": 0 }),
            ]
        );
    }
}
