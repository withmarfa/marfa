//! Which OAuth client each `app.<vendor>` namespace belongs to.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::App;
use super::access::Caller;
use super::instance;
use super::oauth::store;
use super::refusal::{Code, Refusal, Result};

/// As migration 3 claims them.
const FROM_TYPES: &str = "INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at) \
     SELECT substr(t.id, 1, instr(substr(t.id, 5), '.') + 3), \
            COALESCE(c.client_id, k.oauth_client_id), t.created_at \
     FROM types AS t \
     LEFT JOIN oauth_consents AS c ON json_extract(t.created_by, '$.kind') = 'app' \
          AND c.grant_id = json_extract(t.created_by, '$.id') \
     LEFT JOIN api_keys AS k ON json_extract(t.created_by, '$.kind') = 'key' \
          AND k.id = json_extract(t.created_by, '$.id') \
     WHERE t.id GLOB 'app.*.*' AND t.created_by IS NOT NULL \
          AND COALESCE(c.client_id, k.oauth_client_id) IS NOT NULL \
     ORDER BY t.created_at, t.id";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub vendor: String,
    pub client_id: String,
    pub claimed_at: String,
}

impl Binding {
    pub fn to_json(&self) -> Value {
        json!({
            "vendor": self.vendor,
            "client_id": self.client_id,
            "claimed_at": self.claimed_at,
        })
    }

    /// An archive line's body, or none when it does not read as one.
    pub fn archived(body: &Value) -> Option<Binding> {
        let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_string);
        let binding = Binding {
            vendor: text("vendor")?,
            client_id: text("client_id")?,
            claimed_at: text("claimed_at")?,
        };
        is_vendor(&binding.vendor).then_some(binding)
    }
}

/// `app.<vendor>` for an `app.<vendor>.<name>` id.
pub fn vendor_of(id: &str) -> Option<&str> {
    let mut parts = id.splitn(3, '.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("app"), Some(vendor), Some(name))
            if !vendor.is_empty() && !name.is_empty() && !name.contains('.') =>
        {
            Some(&id[.."app.".len() + vendor.len()])
        }
        _ => None,
    }
}

/// Whether `name` is an `app.<vendor>` namespace a type id could sit under.
pub fn is_vendor(name: &str) -> bool {
    vendor_of(&format!("{name}.x")) == Some(name)
        && marfa_rules::grammar::type_id(&format!("{name}.x")).unwrap_or(false)
}

fn binding(row: &rusqlite::Row<'_>) -> rusqlite::Result<Binding> {
    Ok(Binding {
        vendor: row.get(0)?,
        client_id: row.get(1)?,
        claimed_at: row.get(2)?,
    })
}

pub fn claim_of(tx: &Connection, vendor: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT client_id FROM app_vendors WHERE vendor = ?1",
            [vendor],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn of_client(tx: &Connection, client_id: &str) -> Result<Vec<String>> {
    let mut statement =
        tx.prepare_cached("SELECT vendor FROM app_vendors WHERE client_id = ?1 ORDER BY vendor")?;
    let vendors = statement
        .query_map([client_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(vendors)
}

pub fn get(tx: &Connection, vendor: &str) -> Result<Option<Binding>> {
    Ok(tx
        .query_row(
            "SELECT vendor, client_id, claimed_at FROM app_vendors WHERE vendor = ?1",
            [vendor],
            binding,
        )
        .optional()?)
}

pub fn list(tx: &Connection) -> Result<Vec<Binding>> {
    let mut statement =
        tx.prepare("SELECT vendor, client_id, claimed_at FROM app_vendors ORDER BY vendor")?;
    let rows = statement
        .query_map([], binding)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Claims `vendor` for `client_id` unless a client holds it; answers whether it did.
pub fn claim(tx: &Connection, vendor: &str, client_id: &str, at: &str) -> Result<bool> {
    let added = tx.execute(
        "INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at) VALUES (?1, ?2, ?3)",
        params![vendor, client_id, at],
    )?;
    Ok(added > 0)
}

pub fn set(tx: &Connection, vendor: &str, client_id: &str, at: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO app_vendors (vendor, client_id, claimed_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (vendor) DO UPDATE SET client_id = excluded.client_id, \
         claimed_at = excluded.claimed_at",
        params![vendor, client_id, at],
    )?;
    Ok(())
}

/// Claims each vendor no client holds for the client whose app made its first type.
pub fn claim_from_types(tx: &Connection) -> Result<usize> {
    Ok(tx.execute(FROM_TYPES, [])?)
}

pub fn check_vendor(vendor: &str) -> Result<()> {
    if is_vendor(vendor) {
        return Ok(());
    }
    Err(
        Refusal::validation(format!("{vendor} is not an app.<vendor> namespace."))
            .with_detail("field", "vendor"),
    )
}

pub async fn listed(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    let caller = caller.clone();
    let at = app.clock.stamp();
    app.db
        .read(move |tx| {
            caller.current(tx, &at)?.require_vendor_door()?;
            Ok(list(tx)?.iter().map(Binding::to_json).collect())
        })
        .await
}

/// Gives `vendor` to `client_id`, which reaches it from then on in place of the client that held it.
pub async fn give(app: &App, caller: &Caller, vendor: String, client_id: String) -> Result<Value> {
    app.write(caller, "app_vendor.move", move |unit| {
        unit.caller.require_vendor_door()?;
        let tx = unit.tx();
        if store::client(tx, &client_id)?.is_none() {
            return Err(Refusal::new(
                Code::NotFound,
                format!("No app with the client ID {client_id} has registered here."),
            )
            .with_detail("client_id", client_id));
        }
        let before = claim_of(tx, &vendor)?;
        set(tx, &vendor, &client_id, &unit.at)?;
        instance::raise_reach(tx)?;
        unit.audit(
            "app_vendor",
            &vendor,
            Some(json!({ "from": before, "to": client_id })),
        )?;
        let binding = get(tx, &vendor)?
            .ok_or_else(|| Refusal::internal("a vendor just given is not held"))?;
        Ok(binding.to_json())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vendor_is_the_first_two_parts_of_a_three_part_app_id() {
        assert_eq!(vendor_of("app.acme.setting"), Some("app.acme"));
        assert_eq!(vendor_of("app.acme"), None);
        assert_eq!(vendor_of("app.acme.a.b"), None);
        assert_eq!(vendor_of("core.note"), None);
        assert_eq!(vendor_of("application.acme.x"), None);
        assert!(is_vendor("app.acme"));
        assert!(!is_vendor("app.acme.x"));
        assert!(!is_vendor("app"));
        assert!(!is_vendor("core.note"));
        assert!(!is_vendor("app.Acme"));
    }
}
