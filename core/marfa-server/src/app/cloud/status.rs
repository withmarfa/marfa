//! The link as `GET /cloud/link` answers it, and as `cloud_link.changed` carries it.

use serde_json::{Map, Value, json};

use super::connector::Connector;
use super::store::{Link, Move, State};
use super::tunnel::Tunnel;
use crate::app::addresses::Address;
use crate::app::clock::Stamp;

/// A move confirmed at the start is carried out only this long after the approval.
pub const MOVE_WINDOW_MS: i64 = 15 * 60 * 1000;
/// Marfa Cloud answers an approved link this long past the link's `expires_at`.
const LATE_MS: i64 = 10 * 60 * 1000;

/// What the link is now, which time and the settings key can change without a write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    NotLinked,
    Linking,
    Linked,
    Failed,
}

pub struct Seen<'a> {
    pub link: Option<&'a Link>,
    /// Whether every secret the link keeps opens.
    pub opens: bool,
    pub sign_in: &'a Address,
    pub now_ms: i64,
    pub connector: &'a Connector,
    pub tunnel: &'a Tunnel,
    /// Whether Marfa Cloud has not been told of some unlink.
    pub untold: bool,
    /// Where putting back the sign-in address would move it, for a link that ended without.
    pub put_back: Option<Address>,
}

impl Seen<'_> {
    pub fn standing(&self) -> Standing {
        let Some(link) = self.link else {
            return Standing::NotLinked;
        };
        if !self.opens {
            return Standing::Failed;
        }
        match link.state {
            State::Linking if expired(link, self.now_ms) => Standing::Failed,
            State::Linking => Standing::Linking,
            State::Linked => Standing::Linked,
            State::Failed => Standing::Failed,
            State::Ended => Standing::NotLinked,
        }
    }

    fn failure(&self, link: &Link) -> Value {
        if !self.opens {
            return json!({ "reason": "unreadable" });
        }
        if link.state == State::Linking {
            return json!({ "reason": "expired" });
        }
        let mut failure = Map::new();
        failure.insert(
            "reason".into(),
            link.failure_reason.clone().unwrap_or_default().into(),
        );
        if let Some(message) = &link.failure_message {
            failure.insert("message".into(), message.clone().into());
        }
        Value::Object(failure)
    }

    /// Whether the sign-in address in force is the link's address.
    pub fn moved(&self) -> bool {
        self.link
            .and_then(cloud_address)
            .is_some_and(|address| address == *self.sign_in)
    }

    fn sign_in_state(&self, link: &Link) -> &'static str {
        if self.moved() {
            return "moved";
        }
        match link.sign_in_move {
            Move::Keep | Move::Done => "kept",
            Move::Waiting => "waiting",
            Move::Authorized if move_lapsed(link, self.now_ms) => "waiting",
            Move::Authorized => "pending",
        }
    }

    fn sign_in_address(&self, link: &Link, linked: bool) -> Value {
        let state = self.sign_in_state(link);
        let mut shown = Map::new();
        shown.insert("state".into(), state.into());
        shown.insert("address".into(), self.sign_in.origin().into());
        if let (true, "waiting", Some(address)) = (linked, state, cloud_address(link)) {
            shown.insert("next_step".into(), next_step(&address));
        }
        Value::Object(shown)
    }

    /// The sign-in address a link that ended left at the link's address.
    fn not_put_back(&self, link: &Link) -> Value {
        let mut shown = Map::new();
        shown.insert("state".into(), "not_put_back".into());
        shown.insert("address".into(), self.sign_in.origin().into());
        if let Some(reason) = &link.put_back_failure {
            shown.insert("failure".into(), json!({ "reason": reason }));
        }
        if let Some(address) = &self.put_back {
            shown.insert("next_step".into(), next_step(address));
        }
        Value::Object(shown)
    }

    pub fn to_json(&self) -> Value {
        let standing = self.standing();
        let mut body = Map::new();
        if standing == Standing::NotLinked && self.untold {
            body.insert("service_told".into(), false.into());
        }
        let Some(link) = self.link else {
            body.insert("state".into(), "not_linked".into());
            return Value::Object(body);
        };
        match standing {
            Standing::NotLinked => {
                body.insert("state".into(), "not_linked".into());
                let mut ended = Map::new();
                ended.insert(
                    "reason".into(),
                    link.failure_reason.clone().unwrap_or_default().into(),
                );
                if let Some(ended_at) = link.ended_at {
                    ended.insert("ended_at".into(), ended_at.text().into());
                }
                body.insert("ended".into(), Value::Object(ended));
                if self.moved() {
                    body.insert("sign_in_address".into(), self.not_put_back(link));
                }
            }
            Standing::Linking => {
                body.insert("state".into(), "linking".into());
                let mut linking = json!({
                    "user_code": link.user_code,
                    "approval_url": link.approval_url,
                    "expires_at": link.expires_at.text(),
                });
                if link.origin_port.is_some_and(|port| self.tunnel.taken(port)) {
                    linking["port_taken"] = true.into();
                }
                body.insert("linking".into(), linking);
                body.insert("sign_in_address".into(), self.sign_in_address(link, false));
            }
            Standing::Linked => {
                body.insert("state".into(), "linked".into());
                body.insert("name".into(), link.name.clone().unwrap_or_default().into());
                body.insert(
                    "address".into(),
                    link.address.clone().unwrap_or_default().into(),
                );
                if let Some(linked_at) = link.linked_at {
                    body.insert("linked_at".into(), linked_at.text().into());
                }
                body.insert("connector".into(), self.connector.to_json());
                body.insert("sign_in_address".into(), self.sign_in_address(link, true));
            }
            Standing::Failed => {
                body.insert("state".into(), "failed".into());
                body.insert("failure".into(), self.failure(link));
                if self.moved() {
                    body.insert("sign_in_address".into(), self.sign_in_address(link, false));
                }
            }
        }
        Value::Object(body)
    }
}

/// When Marfa Cloud stops answering about a link: past `expires_at` it still answers one approved late.
pub fn ceiling_ms(expires_at: Stamp) -> i64 {
    expires_at.ms().saturating_add(LATE_MS)
}

/// A link still waiting for its first approval when Marfa Cloud stopped answering about it.
pub fn expired(link: &Link, now_ms: i64) -> bool {
    link.state == State::Linking
        && link.link_credential.is_none()
        && now_ms >= ceiling_ms(link.expires_at)
}

/// An approved move that can no longer be carried out without asking again.
pub fn move_lapsed(link: &Link, now_ms: i64) -> bool {
    link.approved_at
        .is_some_and(|approved| now_ms > approved.ms().saturating_add(MOVE_WINDOW_MS))
}

pub fn cloud_address(link: &Link) -> Option<Address> {
    Address::parse(link.address.as_deref()?).ok()
}

fn next_step(address: &Address) -> Value {
    let origin = address.origin();
    json!({
        "request": {
            "method": "PATCH",
            "path": "/config",
            "body": { "sign_in_address": origin, "confirm_sign_in_address_change": true },
        },
        "command": format!("marfa config set sign_in_address {origin} --confirm-address-change"),
    })
}
