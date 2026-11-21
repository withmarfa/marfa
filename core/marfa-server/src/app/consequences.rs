use rusqlite::Transaction;
use serde_json::{Value, json};

use super::addresses::{Address, Addresses};
use super::auth::{passkeys, session};
use super::oauth::grants;
use super::refusal::Result;
use crate::app::clock::Stamp;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Consequence {
    pub code: &'static str,
    pub sentence: String,
    pub count: Option<u64>,
}

impl Consequence {
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "sentence": self.sentence, "count": self.count })
    }
}

/// Counts against the host of the new sign-in address.
type Counter = fn(&Transaction<'_>, &str, i64) -> Result<i64>;

struct Registered {
    code: &'static str,
    sentence: &'static str,
    count: Counter,
}

fn live_browser_sessions(tx: &Transaction<'_>, _: &str, now_ms: i64) -> Result<i64> {
    session::live_count(tx, Stamp::from_ms(now_ms)?)
}

fn stranded_passkeys(tx: &Transaction<'_>, host: &str, _: i64) -> Result<i64> {
    passkeys::stranded_by(tx, host)
}

fn connected_apps(tx: &Transaction<'_>, _: &str, _: i64) -> Result<i64> {
    Ok(i64::try_from(grants::all_of_owner(tx)?.len()).unwrap_or(i64::MAX))
}

const SIGN_IN_CHANGED: &[Registered] = &[
    Registered {
        code: "browser_sessions_end",
        sentence: "Everyone signed in on a browser is signed out.",
        count: live_browser_sessions,
    },
    Registered {
        code: "passkeys_unusable",
        sentence: "Passkeys stop working until they are added again at the new address.",
        count: stranded_passkeys,
    },
    Registered {
        code: "apps_sign_in_again",
        sentence: "Apps connected to this instance have to sign in again.",
        count: connected_apps,
    },
];

pub const ADDRESS_REMOVED: &str = "address_removed";

/// What the owner does once the sign-in address has moved to `sign_in`.
pub fn next_steps(sign_in: &Address) -> Vec<Value> {
    let origin = sign_in.origin();
    vec![
        json!({
            "code": "sign_in",
            "sentence": "Sign in again at the new address.",
            "url": format!("{origin}/auth/sign-in"),
        }),
        json!({
            "code": "add_passkey",
            "sentence": "Add a passkey at the new address. Passkeys made for the old address work again only if the sign-in address moves back.",
            "url": passkeys::add_url(origin),
        }),
    ]
}

pub fn of_change(
    tx: &Transaction<'_>,
    before: &Addresses,
    after: &Addresses,
    now_ms: i64,
) -> Result<Vec<Consequence>> {
    let mut found = Vec::new();
    if before.sign_in() != after.sign_in() {
        found = of_sign_in_move(tx, after.sign_in().host(), now_ms)?;
    }
    let kept = after.all();
    for gone in before
        .all()
        .iter()
        .filter(|address| !kept.contains(address))
    {
        found.push(removed(gone));
    }
    Ok(found)
}

/// What moving the sign-in address to a host not yet known does, as a link to Marfa Cloud
/// does before Marfa Cloud names the address.
pub fn of_move_to_unknown_host(tx: &Transaction<'_>, now_ms: i64) -> Result<Vec<Consequence>> {
    of_sign_in_move(tx, "", now_ms)
}

fn of_sign_in_move(tx: &Transaction<'_>, host: &str, now_ms: i64) -> Result<Vec<Consequence>> {
    let mut found = Vec::new();
    for registered in SIGN_IN_CHANGED {
        let count = u64::try_from((registered.count)(tx, host, now_ms)?).unwrap_or(0);
        if count == 0 {
            continue;
        }
        found.push(Consequence {
            code: registered.code,
            sentence: registered.sentence.to_string(),
            count: Some(count),
        });
    }
    Ok(found)
}

fn removed(address: &Address) -> Consequence {
    Consequence {
        code: ADDRESS_REMOVED,
        sentence: format!("Links that use {address} stop working."),
        count: None,
    }
}
