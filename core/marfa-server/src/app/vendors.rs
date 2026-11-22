//! Which OAuth client each `app.<vendor>` namespace belongs to.

use marfa_rules::time;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::App;
use super::access::Caller;
use super::auth::names;
use super::instance;
use super::oauth::store;
use super::refusal::{Code, Refusal, Result};

/// Each type under `app` with the app that made it: its client, `''` where an app made it but
/// is not known here, or none where the owner made it.
const MAKERS: &str = "SELECT substr(t.id, 1, instr(substr(t.id, 5), '.') + 3) AS vendor, \
            CASE json_extract(t.created_by, '$.kind') \
                WHEN 'app' THEN coalesce(c.client_id, '') \
                WHEN 'key' THEN CASE WHEN k.id IS NULL OR k.maker_unknown = 1 \
                    OR k.made_by_host IS NOT NULL THEN '' ELSE k.made_by_client END \
                WHEN 'local' THEN NULL WHEN 'browser' THEN NULL WHEN 'server' THEN NULL \
                ELSE '' END AS maker, \
            t.created_at AS made_at \
     FROM types AS t \
     LEFT JOIN oauth_consents AS c ON json_extract(t.created_by, '$.kind') = 'app' \
          AND c.grant_id = json_extract(t.created_by, '$.id') \
     LEFT JOIN api_keys AS k ON json_extract(t.created_by, '$.kind') = 'key' \
          AND k.id = json_extract(t.created_by, '$.id') \
     WHERE t.id GLOB 'app.*.*'";

/// The same claim migration 0004 makes: a vendor goes to an app only when that one known app
/// made every type under it; otherwise the owner holds it until they give it to one.
fn from_types() -> String {
    format!(
        "INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at) \
         SELECT vendor, CASE WHEN count(maker) = count(*) AND count(DISTINCT maker) = 1 \
                AND min(maker) <> '' THEN min(maker) END, min(made_at) \
         FROM ({MAKERS}) GROUP BY vendor"
    )
}

/// For a restore an app sends: every vendor with types under it is the owner's to give.
fn held_from_types() -> String {
    format!(
        "INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at) \
         SELECT vendor, NULL, min(made_at) FROM ({MAKERS}) GROUP BY vendor"
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

    /// An archive line's body, or the field that does not read and why.
    pub fn archived(body: &Value) -> std::result::Result<Binding, (&'static str, &'static str)> {
        let vendor = body
            .get("vendor")
            .and_then(Value::as_str)
            .filter(|vendor| is_vendor(vendor))
            .ok_or(("vendor", "vendor must be an app.<vendor> namespace"))?;
        let holder = match body.get("client_id") {
            Some(Value::Null) => Holder::Owner,
            Some(Value::String(client)) if !client.is_empty() => Holder::App(client.clone()),
            _ => return Err(("client_id", "client_id must be a client ID or null")),
        };
        let at = body.get("claimed_at").and_then(Value::as_str);
        if at.is_some_and(leap_second) {
            return Err((
                "claimed_at",
                "claimed_at must be an instant without a leap second",
            ));
        }
        let claimed_at = at
            .and_then(|at| time::read(at).ok())
            .map(time::written)
            .ok_or(("claimed_at", "claimed_at must be an RFC 3339 instant"))?;
        Ok(Binding {
            vendor: vendor.to_string(),
            holder,
            claimed_at,
        })
    }
}

/// RFC 3339 allows second 60; Marfa stores no instant inside a leap second.
fn leap_second(at: &str) -> bool {
    at.get(10..11).is_some_and(|t| t.eq_ignore_ascii_case("t"))
        && at.get(13..14) == Some(":")
        && at.get(16..19) == Some(":60")
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

/// Every vendor an app holds, which a key of unknown maker never reaches.
pub fn app_held(tx: &Connection) -> Result<Vec<String>> {
    let mut statement = tx.prepare_cached(
        "SELECT vendor FROM app_vendors WHERE client_id IS NOT NULL ORDER BY vendor",
    )?;
    let vendors = statement
        .query_map([], |row| row.get(0))?
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

/// Holds `vendor` for the owner unless someone holds it already.
pub fn hold(tx: &Connection, vendor: &str, at: &str) -> Result<bool> {
    restore(
        tx,
        &Binding {
            vendor: vendor.to_string(),
            holder: Holder::Owner,
            claimed_at: at.to_string(),
        },
    )
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

/// Records each vendor no one holds that has types: for the one known app that made them all,
/// else for the owner, or for the owner whenever `for_owner`.
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

/// A binding with the name its app registered, where the app registered one.
fn listed_with_name(tx: &Connection, binding: &Binding) -> Result<Value> {
    let name = match binding.holder.client_id() {
        Some(client) => store::client(tx, client)?.and_then(|client| {
            names::usable(client.registration.client_name.as_deref()).map(str::to_string)
        }),
        None => None,
    };
    let mut listed = binding.to_json();
    listed["client_name"] = json!(name);
    Ok(listed)
}

pub async fn listed(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    let caller = caller.clone();
    let at = app.clock.stamp();
    app.db
        .read(move |tx| {
            caller.current(tx, &at)?.require_vendor_door()?;
            list(tx)?
                .iter()
                .map(|binding| listed_with_name(tx, binding))
                .collect()
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
        listed_with_name(tx, &binding)
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

    #[test]
    fn an_archived_claim_reads_any_rfc_3339_form_and_keeps_the_instant() {
        for at in [
            "2026-11-01T00:00:00Z",
            "2026-11-01T00:00:00.000Z",
            "2026-11-01T00:00:00.000000Z",
            "2026-11-01T01:00:00+01:00",
            "2026-10-31T19:00:00-05:00",
        ] {
            let line = json!({ "vendor": "app.acme", "client_id": null, "claimed_at": at });
            let binding = Binding::archived(&line).unwrap_or_else(|why| panic!("{at}: {why:?}"));
            assert_eq!(binding.claimed_at, "2026-11-01T00:00:00.000Z", "{at}");
        }
        for at in ["yesterday", "2026-11-01", "2026-11-01T00:00:00"] {
            let line = json!({ "vendor": "app.acme", "client_id": null, "claimed_at": at });
            assert!(Binding::archived(&line).is_err(), "{at}");
        }
        let leap = json!({ "vendor": "app.acme", "client_id": null, "claimed_at": "1990-12-31T23:59:60Z" });
        assert_eq!(
            Binding::archived(&leap)
                .map(|_| ())
                .map_err(|(field, why)| (field, why.contains("leap"))),
            Err(("claimed_at", true))
        );
    }
}
