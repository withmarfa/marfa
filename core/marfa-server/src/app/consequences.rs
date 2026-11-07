//! What changing the instance's addresses does to people and apps, said before
//! it is done. The words are the app's to show, so they follow Apple's
//! writing guidelines: plain, short, and about what a person will see.

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::addresses::{Address, Addresses};
use super::auth::passkeys;
use super::refusal::Result;

/// One thing a change of address does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Consequence {
    pub code: &'static str,
    pub sentence: String,
    /// How many people, sessions or apps it reaches, when something counts them.
    pub count: Option<u64>,
}

impl Consequence {
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "sentence": self.sentence, "count": self.count })
    }
}

/// A count a later area registers where it owns the table, of what a move to
/// the address it is given reaches: it gives `None` until there is something to
/// count.
type Counter = fn(&Transaction<'_>, &Address) -> Result<Option<u64>>;

struct Registered {
    code: &'static str,
    sentence: &'static str,
    count: Counter,
}

fn not_counted(_: &Transaction<'_>, _: &Address) -> Result<Option<u64>> {
    Ok(None)
}

fn stranded_passkeys(tx: &Transaction<'_>, sign_in: &Address) -> Result<Option<u64>> {
    let count = passkeys::stranded_by(tx, sign_in.host())?;
    Ok(Some(u64::try_from(count).unwrap_or(0)))
}

/// What a change of the sign-in address does, and where each is counted.
const SIGN_IN_CHANGED: &[Registered] = &[
    Registered {
        code: "browser_sessions_end",
        sentence: "Everyone signed in on a browser is signed out.",
        count: not_counted,
    },
    Registered {
        code: "passkeys_unusable",
        sentence: "Passkeys stop working until they are added again at the new address.",
        count: stranded_passkeys,
    },
    Registered {
        code: "apps_sign_in_again",
        sentence: "Apps connected to this instance have to sign in again.",
        count: not_counted,
    },
];

pub const ADDRESS_REMOVED: &str = "address_removed";

/// What moving from `before` to `after` does.
pub fn of_change(
    tx: &Transaction<'_>,
    before: &Addresses,
    after: &Addresses,
) -> Result<Vec<Consequence>> {
    let mut found = Vec::new();
    if before.sign_in() != after.sign_in() {
        let sign_in = after.sign_in();
        for registered in SIGN_IN_CHANGED {
            let count = (registered.count)(tx, &sign_in)?;
            if count == Some(0) {
                continue;
            }
            found.push(Consequence {
                code: registered.code,
                sentence: registered.sentence.to_string(),
                count,
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
