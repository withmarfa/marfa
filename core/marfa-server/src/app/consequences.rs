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

type Counter = fn(&Transaction<'_>, &Address, i64) -> Result<i64>;

struct Registered {
    code: &'static str,
    sentence: &'static str,
    count: Counter,
}

fn live_browser_sessions(tx: &Transaction<'_>, _: &Address, now_ms: i64) -> Result<i64> {
    session::live_count(tx, Stamp::from_ms(now_ms)?)
}

fn stranded_passkeys(tx: &Transaction<'_>, sign_in: &Address, _: i64) -> Result<i64> {
    passkeys::stranded_by(tx, sign_in.host())
}

fn connected_apps(tx: &Transaction<'_>, _: &Address, _: i64) -> Result<i64> {
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

pub fn of_change(
    tx: &Transaction<'_>,
    before: &Addresses,
    after: &Addresses,
    now_ms: i64,
) -> Result<Vec<Consequence>> {
    let mut found = Vec::new();
    if before.sign_in() != after.sign_in() {
        let sign_in = after.sign_in();
        for registered in SIGN_IN_CHANGED {
            let count = u64::try_from((registered.count)(tx, &sign_in, now_ms)?).unwrap_or(0);
            if count == 0 {
                continue;
            }
            found.push(Consequence {
                code: registered.code,
                sentence: registered.sentence.to_string(),
                count: Some(count),
            });
        }
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

fn removed(address: &Address) -> Consequence {
    Consequence {
        code: ADDRESS_REMOVED,
        sentence: format!("Links that use {address} stop working."),
        count: None,
    }
}
