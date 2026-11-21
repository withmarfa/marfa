//! Which OAuth client each `app.<vendor>` namespace belongs to.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::App;
use super::access::Caller;
use super::clock::Stamp;
use super::instance;
use super::oauth::store;
use super::refusal::{Code, Refusal, Result};

/// Each type under `app` with the app that made it: its client, `''` where an app made it but
/// is not known here, or none where the owner made it.
const MAKERS: &str = "SELECT substr(t.id, 1, instr(substr(t.id, 5), '.') + 3) AS vendor, \
            CASE json_extract(t.created_by, '$.kind') \
                WHEN 'app' THEN coalesce(c.client_id, '') \
                WHEN 'key' THEN CASE WHEN k.id IS NULL THEN '' ELSE k.oauth_client_id END \
                WHEN 'local' THEN NULL WHEN 'browser' THEN NULL WHEN 'server' THEN NULL \
                ELSE '' END AS maker, \
            t.created_at AS made_at \
     FROM types AS t \
     LEFT JOIN oauth_consents AS c ON json_extract(t.created_by, '$.kind') = 'app' \
          AND c.grant_id = json_extract(t.created_by, '$.id') \
     LEFT JOIN api_keys AS k ON json_extract(t.created_by, '$.kind') = 'key' \
          AND k.id = json_extract(t.created_by, '$.id') \
     WHERE t.id GLOB 'app.*.*'";

/// The same claim migration 0004 makes: a vendor goes to an app only when exactly one known app
/// made its types; otherwise the owner holds it until they give it to one.
fn from_types() -> String {
    format!(
        "INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at) \
         SELECT vendor, CASE WHEN count(DISTINCT maker) = 1 AND min(maker) <> '' \
                THEN min(maker) END, min(made_at) \
         FROM ({MAKERS}) WHERE maker IS NOT NULL GROUP BY vendor"
    )
}

/// For a restore an app sends: every vendor an app made types under is the owner's to give.
fn held_from_types() -> String {
    format!(
        "INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at) \
         SELECT vendor, NULL, min(made_at) FROM ({MAKERS}) WHERE maker IS NOT NULL GROUP BY vendor"
    )
}

/// Who holds a vendor: an app's OAuth client, or the owner until they give it to an app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Holder {
    App(String),
    Owner,
}

impl Holder {
    fn of(client_id: Option<String>) -> Holder {
        client_id.map_or(Holder::Owner, Holder::App)
    }

    fn client_id(&self) -> Option<&str> {
        match self {
            Holder::App(client) => Some(client),
            Holder::Owner => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub vendor: String,
    pub holder: Holder,
    pub claimed_at: String,
}

impl Binding {
    pub fn to_json(&self) -> Value {
        json!({
            "vendor": self.vendor,
            "client_id": self.holder.client_id(),
            "claimed_at": self.claimed_at,
        })
    }

    /// An archive line's body, or why it does not read as one.
    pub fn archived(body: &Value) -> std::result::Result<Binding, &'static str> {
        let vendor = body
            .get("vendor")
            .and_then(Value::as_str)
            .filter(|vendor| is_vendor(vendor))
            .ok_or("vendor must be an app.<vendor> namespace")?;
        let holder = match body.get("client_id") {
            Some(Value::Null) => Holder::Owner,
            Some(Value::String(client)) if !client.is_empty() => Holder::App(client.clone()),
            _ => return Err("client_id must be a client ID or null"),
        };
        let claimed_at = body
            .get("claimed_at")
            .and_then(Value::as_str)
            .filter(|at| Stamp::parsed(at).is_some())
            .ok_or("claimed_at must be an RFC 3339 instant")?;
        Ok(Binding {
            vendor: vendor.to_string(),
            holder,
            claimed_at: claimed_at.to_string(),
        })
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
        holder: Holder::of(row.get(1)?),
        claimed_at: row.get(2)?,
    })
}

pub fn holder_of(tx: &Connection, vendor: &str) -> Result<Option<Holder>> {
    Ok(tx
        .query_row(
            "SELECT client_id FROM app_vendors WHERE vendor = ?1",
            [vendor],
            |row| row.get(0).map(Holder::of),
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

/// Claims `vendor` for `client_id` unless it is held; answers whether it did.
pub fn claim(tx: &Connection, vendor: &str, client_id: &str, at: &str) -> Result<bool> {
    restore(
        tx,
        &Binding {
            vendor: vendor.to_string(),
            holder: Holder::App(client_id.to_string()),
            claimed_at: at.to_string(),
        },
    )
}

/// Writes `binding` unless its vendor is held; answers whether it did.
pub fn restore(tx: &Connection, binding: &Binding) -> Result<bool> {
    let added = tx.execute(
        "INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at) VALUES (?1, ?2, ?3)",
        params![
            binding.vendor,
            binding.holder.client_id(),
            binding.claimed_at
        ],
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

/// Records each vendor no one holds whose types an app made: for that app when exactly one known
/// app made them, else for the owner, or for the owner whenever `for_owner`.
pub fn claim_from_types(tx: &Connection, for_owner: bool) -> Result<usize> {
    let sql = if for_owner {
        held_from_types()
    } else {
        from_types()
    };
    Ok(tx.execute(&sql, [])?)
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
        unit.caller.require_vendor_move()?;
        let tx = unit.tx();
        if store::client(tx, &client_id)?.is_none() {
            return Err(Refusal::new(
                Code::NotFound,
                format!("No app with the client ID {client_id} has registered here."),
            )
            .with_detail("client_id", client_id));
        }
        let before = holder_of(tx, &vendor)?.and_then(|held| held.client_id().map(str::to_string));
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
