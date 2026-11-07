//! Who is asking and what they may reach. Every decision of reach is made
//! here; nothing else reads a map or names a permission as text. A decision
//! takes the state it decides on, so a write can make it inside its own
//! transaction.

mod edges;
mod items;
mod levers;
mod maps;
mod schema;

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::keys::{self, Key};
use super::refusal::{Code, Refusal, Result};
pub use levers::Levers;
pub use maps::{Axis, Level, Map};
pub use schema::{Door, SchemaKind};

macro_rules! permissions {
    ($($variant:ident = $wire:literal;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Permission {
            $($variant,)*
        }

        impl Permission {
            pub const ALL: [Permission; 12] = [$(Permission::$variant,)*];

            pub const fn word(self) -> &'static str {
                match self {
                    $(Permission::$variant => $wire,)*
                }
            }

            pub fn from_word(word: &str) -> Option<Permission> {
                match word {
                    $($wire => Some(Permission::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

permissions! {
    AuditRead = "audit.read";
    BlobsManage = "blobs.manage";
    ConfigManage = "config.manage";
    ConnectorsManage = "connectors.manage";
    GrantsManage = "grants.manage";
    InstanceMaintain = "instance.maintain";
    InstanceRead = "instance.read";
    ItemsPurge = "items.purge";
    KeysManage = "keys.manage";
    KeysMint = "keys.mint";
    SchemaWrite = "schema.write";
    WebhooksManage = "webhooks.manage";
}

/// What a credential holds: the same whether it is a key, a mint's request or
/// the ceiling a mint is held to.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grants {
    pub permissions: Vec<Permission>,
    pub maps: [Map; 5],
    pub sources: Vec<String>,
}

/// What a request asked for that its caller does not hold.
#[derive(Debug, PartialEq, Eq)]
pub enum Beyond {
    Scope(String),
    Source(String),
}

impl From<Beyond> for Refusal {
    fn from(beyond: Beyond) -> Refusal {
        match beyond {
            Beyond::Scope(scope) => Refusal::new(
                Code::Forbidden,
                format!("This reaches {scope}, which you do not hold."),
            )
            .with_detail("required_scope", scope),
            Beyond::Source(source) => source_refused(source),
        }
    }
}

fn source_refused(source: String) -> Refusal {
    Refusal::new(
        Code::Forbidden,
        format!("You cannot grant the source {source}."),
    )
    .with_detail("source", source)
}

impl Grants {
    /// What the owner holds, and so what a direct mint naming nothing gives.
    pub fn everything() -> Grants {
        Grants {
            permissions: Permission::ALL.to_vec(),
            maps: std::array::from_fn(|_| Map::everything()),
            sources: Vec::new(),
        }
    }

    pub fn map(&self, axis: Axis) -> &Map {
        &self.maps[axis as usize]
    }

    pub fn holds(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    /// The first thing `wanted` holds that a holder of these grants, whose
    /// own source is `own`, does not. The holder may grant its own source
    /// and its claims.
    pub fn first_beyond(&self, own: &str, wanted: &Grants) -> Option<Beyond> {
        [
            Axis::Extension,
            Axis::Type,
            Axis::Edge,
            Axis::Metadata,
            Axis::Profile,
        ]
        .into_iter()
        .find_map(|axis| axis.first_beyond(self.map(axis), wanted.map(axis)))
        .or_else(|| {
            wanted
                .permissions
                .iter()
                .find(|permission| !self.holds(**permission))
                .map(|permission| permission.word().to_string())
        })
        .map(Beyond::Scope)
        .or_else(|| {
            wanted
                .sources
                .iter()
                .find(|source| !self.may_grant(own, source))
                .map(|source| Beyond::Source(source.clone()))
        })
    }

    fn may_grant(&self, own: &str, source: &str) -> bool {
        source == own || self.sources.iter().any(|claim| claim == source)
    }
}

/// Whether a life of `wanted` runs past `limit`. `None` is no end, so it is
/// the longest life of all.
fn outlives(wanted: Option<&str>, limit: Option<&str>) -> bool {
    match (wanted, limit) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(wanted), Some(limit)) => wanted > limit,
    }
}

fn longer_life(limit: Option<&str>) -> Refusal {
    let refusal = Refusal::new(Code::Forbidden, "A key can't outlive what it is held to.");
    match limit {
        Some(limit) => refusal.with_detail("expires_at", limit),
        None => refusal,
    }
}

fn requires(permission: Permission) -> Refusal {
    Refusal::new(
        Code::Forbidden,
        format!(
            "This operation requires the {} permission.",
            permission.word()
        ),
    )
    .with_detail("required_scope", permission.word())
}

/// What an update would leave a key with: all it will hold, and the life and
/// levers only if the update names them.
#[derive(Debug)]
pub struct Change<'a> {
    pub grants: &'a Grants,
    pub life: Option<Option<&'a str>>,
    pub levers: Option<Option<&'a Levers>>,
    pub narrow_only: bool,
}

/// What is asking. A signed-in app or a browser session is another variant,
/// answering these same questions from what it holds.
#[derive(Clone, Debug)]
pub enum Caller {
    /// The private local command, on the control socket with no credential.
    Local,
    Key(Box<Key>),
    /// The server, in the work it does on itself. It outlives any request
    /// that started the work, so what a job does stands on no credential.
    Server,
}

impl Caller {
    /// The caller as `tx` holds it at `at`, for a decision that state must
    /// bear out. Asked of a key that has since ended, it refuses as a request
    /// bearing that key would be refused.
    pub fn current(&self, tx: &Transaction<'_>, at: &str) -> Result<Caller> {
        match self {
            Caller::Local => Ok(Caller::Local),
            Caller::Server => Ok(Caller::Server),
            Caller::Key(key) => keys::live_by_id(tx, &key.id, at)?
                .map(|key| Caller::Key(Box::new(key)))
                .ok_or_else(unauthorized),
        }
    }

    pub fn is_direct(&self) -> bool {
        matches!(self, Caller::Local)
    }

    pub fn key(&self) -> Option<&Key> {
        match self {
            Caller::Local | Caller::Server => None,
            Caller::Key(key) => Some(key),
        }
    }

    pub fn holds(&self, permission: Permission) -> bool {
        match self {
            Caller::Local | Caller::Server => true,
            Caller::Key(key) => key.grants.holds(permission),
        }
    }

    pub fn require(&self, permission: Permission) -> Result<()> {
        if self.holds(permission) {
            Ok(())
        } else {
            Err(requires(permission))
        }
    }

    /// Refuses all but the owner and the local command.
    pub fn require_direct(&self) -> Result<()> {
        if self.is_direct() {
            Ok(())
        } else {
            Err(Refusal::new(Code::Forbidden, "Only the owner can do this."))
        }
    }

    /// Every key is within reach, whatever it holds.
    pub fn manages_keys(&self) -> bool {
        self.holds(Permission::KeysManage)
    }

    /// Refuses a caller that may not list, change or revoke keys at all.
    pub fn require_key_door(&self) -> Result<()> {
        if self.manages_keys() {
            Ok(())
        } else {
            self.require(Permission::KeysMint)
        }
    }

    /// Whether `target` is a key this caller may list, change or revoke. The
    /// one decision behind every such door.
    pub fn reaches(&self, target: &Key) -> bool {
        match self {
            Caller::Local | Caller::Server => true,
            Caller::Key(key) => {
                key.id == target.id
                    || key.grants.holds(Permission::KeysManage)
                    || key
                        .grants
                        .first_beyond(&key.source, &target.grants)
                        .is_none()
            }
        }
    }

    /// What a mint naming no family gives.
    pub fn whole_set(&self) -> Grants {
        match self {
            Caller::Local | Caller::Server => Grants::everything(),
            Caller::Key(key) => key.grants.clone(),
        }
    }

    /// Holds `wanted` to what this caller could give.
    pub fn check_ceiling(&self, wanted: &Grants) -> Result<()> {
        let Caller::Key(key) = self else {
            return Ok(());
        };
        match key.grants.first_beyond(&key.source, wanted) {
            Some(beyond) => Err(beyond.into()),
            None => Ok(()),
        }
    }

    /// Holds a key's life to this caller's own.
    pub fn check_life(&self, wanted: Option<&str>) -> Result<()> {
        let limit = self.key().and_then(|key| key.expires_at.as_deref());
        if outlives(wanted, limit) {
            Err(longer_life(limit))
        } else {
            Ok(())
        }
    }

    /// Whether this caller could give a key `source`.
    pub fn may_grant(&self, source: &str) -> bool {
        match self {
            Caller::Local | Caller::Server => true,
            Caller::Key(key) => key.grants.may_grant(&key.source, source),
        }
    }

    /// Holds a new key's own source, which another key claims, to what this
    /// caller could grant.
    pub fn check_own_source(&self, source: &str, claimed_elsewhere: bool) -> Result<()> {
        if claimed_elsewhere && !self.may_grant(source) {
            Err(source_refused(source.to_string()))
        } else {
            Ok(())
        }
    }

    /// Holds an update of `target` to what this caller may do to it.
    pub fn check_update(&self, target: &Key, change: &Change<'_>) -> Result<()> {
        if change.levers.is_some() {
            self.require(Permission::ConfigManage)?;
        }
        let acting_by_manage = !self.is_direct() && self.manages_keys();
        if change.narrow_only || acting_by_manage || target.oauth_client_id.is_some() {
            if let Some(beyond) = target.grants.first_beyond(&target.source, change.grants) {
                return Err(beyond.into());
            }
            let limit = target.expires_at.as_deref();
            if change.life.is_some_and(|wanted| outlives(wanted, limit)) {
                return Err(longer_life(limit));
            }
        }
        if change.narrow_only
            && change
                .levers
                .is_some_and(|levers| levers != target.levers.as_ref())
        {
            return Err(Refusal::new(
                Code::Forbidden,
                "narrow_only refuses a change to enforcement_override.",
            )
            .with_detail("field", "enforcement_override"));
        }
        if !self.is_direct() && !self.manages_keys() {
            self.require(Permission::KeysMint)?;
            self.check_ceiling(change.grants)?;
            if let Some(wanted) = change.life {
                self.check_life(wanted)?;
            }
        }
        Ok(())
    }

    /// Whether this caller may read `source`.
    pub fn sees_source(&self, source: &str) -> bool {
        self.manages_keys() || self.may_grant(source)
    }

    /// Refuses a caller that may not set the name and mark of `source`.
    pub fn require_may_name(&self, source: &str) -> Result<()> {
        if self.sees_source(source) {
            Ok(())
        } else {
            Err(requires(Permission::KeysManage))
        }
    }

    /// The `key_id` of an audit entry this caller's write leaves.
    pub fn audit_id(&self) -> String {
        match self {
            Caller::Local => "local:process".to_string(),
            Caller::Server => "server".to_string(),
            Caller::Key(key) => key.id.clone(),
        }
    }

    /// The `actor` of an audit entry, as the caller stands when it acts.
    pub fn actor(&self) -> Value {
        match self {
            Caller::Local => json!({ "kind": "local", "id": "local", "name": "Local command" }),
            Caller::Server => json!({ "kind": "server", "id": "server", "name": "Marfa" }),
            Caller::Key(key) => json!({ "kind": "key", "id": key.id, "name": key.label }),
        }
    }
}

pub fn unauthorized() -> Refusal {
    Refusal::new(Code::Unauthorized, "A valid credential is required.")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map(axis: Axis, value: Value) -> Map {
        axis.from_body(&value).expect("a good map")
    }

    fn key(id: &str, source: &str, permissions: &[Permission], sources: &[&str]) -> Key {
        Key {
            id: id.into(),
            label: id.into(),
            source: source.into(),
            default_tier: "library".into(),
            oauth_client_id: None,
            grants: Grants {
                permissions: permissions.to_vec(),
                maps: Default::default(),
                sources: sources.iter().map(ToString::to_string).collect(),
            },
            levers: None,
            created_at: String::new(),
            expires_at: None,
            last_used_at: None,
        }
    }

    fn with_map(mut key: Key, axis: Axis, value: Value) -> Key {
        key.grants.maps[axis as usize] = map(axis, value);
        key
    }

    #[test]
    fn a_key_reaches_what_holds_nothing_beyond_it() {
        use Permission::{AuditRead, KeysManage, KeysMint};
        let minter = |sources: &[&str]| key("minter", "mine", &[KeysMint], sources);
        let wide_types = |key: Key| with_map(key, Axis::Type, json!({ "*": "write" }));
        let bare = key("target", "t", &[], &[]);
        for (name, caller, target, reached) in [
            ("nothing is within reach", minter(&[]), bare.clone(), true),
            (
                "itself",
                minter(&[]),
                key("minter", "mine", &[KeysMint], &[]),
                true,
            ),
            (
                "a wider self",
                key("minter", "mine", &[], &[]),
                wide_types(key("minter", "mine", &[], &[])),
                true,
            ),
            (
                "a permission beyond it",
                minter(&[]),
                key("t", "t", &[AuditRead], &[]),
                false,
            ),
            (
                "the same permission",
                minter(&[]),
                key("t", "t", &[KeysMint], &[]),
                true,
            ),
            (
                "a wider type map",
                minter(&[]),
                wide_types(bare.clone()),
                false,
            ),
            (
                "a wider edge map",
                minter(&[]),
                with_map(bare.clone(), Axis::Edge, json!({ "about": "read" })),
                false,
            ),
            (
                "a wider extension map",
                minter(&[]),
                with_map(bare.clone(), Axis::Extension, json!({ "x": "read" })),
                false,
            ),
            (
                "a wider metadata map",
                minter(&[]),
                with_map(bare.clone(), Axis::Metadata, json!({ "types": "write" })),
                false,
            ),
            (
                "a wider profile map",
                minter(&[]),
                with_map(bare.clone(), Axis::Profile, json!({ "name": "read" })),
                false,
            ),
            (
                "a claim it can't grant",
                minter(&[]),
                key("t", "t", &[], &["theirs"]),
                false,
            ),
            (
                "a claim of its own source",
                minter(&[]),
                key("t", "t", &[], &["mine"]),
                true,
            ),
            (
                "a claim it holds",
                minter(&["ours"]),
                key("t", "t", &[], &["ours"]),
                true,
            ),
            (
                "a claim differing in case",
                minter(&["ours"]),
                key("t", "t", &[], &["Ours"]),
                false,
            ),
            (
                "a wider key, through keys.manage",
                key("m", "m", &[KeysManage], &[]),
                wide_types(key("t", "t", &[AuditRead], &["x"])),
                true,
            ),
            (
                "a target carved out of what the caller denies",
                with_map(
                    minter(&[]),
                    Axis::Type,
                    json!({ "*": "write", "core.note": "none" }),
                ),
                with_map(bare.clone(), Axis::Type, json!({ "*": "read" })),
                false,
            ),
            (
                "a target that carries the caller's denial",
                with_map(
                    minter(&[]),
                    Axis::Type,
                    json!({ "*": "write", "core.note": "none" }),
                ),
                with_map(
                    bare.clone(),
                    Axis::Type,
                    json!({ "*": "read", "core.note": "none" }),
                ),
                true,
            ),
        ] {
            assert_eq!(
                Caller::Key(Box::new(caller)).reaches(&target),
                reached,
                "{name}"
            );
        }
        assert!(Caller::Local.reaches(&wide_types(key("t", "t", &[KeysManage], &["x"]))));
    }

    #[test]
    fn an_update_is_held_to_the_caller_and_to_the_key() {
        use Permission::{AuditRead, ConfigManage, KeysManage, KeysMint};
        let target = key("t", "t", &[AuditRead], &[]);
        let wider = key("t", "t", &[AuditRead, KeysMint], &[]).grants;
        let change = |grants, narrow_only| Change {
            grants,
            life: None,
            levers: None,
            narrow_only,
        };
        let manager = Caller::Key(Box::new(key("m", "m", &[KeysManage, KeysMint], &[])));
        let minter = Caller::Key(Box::new(key("n", "n", &[KeysMint, AuditRead], &[])));
        assert!(
            Caller::Local
                .check_update(&target, &change(&wider, false))
                .is_ok()
        );
        assert!(
            Caller::Local
                .check_update(&target, &change(&wider, true))
                .is_err()
        );
        assert!(
            manager
                .check_update(&target, &change(&wider, false))
                .is_err()
        );
        let nothing = Grants::default();
        assert!(
            manager
                .check_update(&target, &change(&nothing, false))
                .is_ok()
        );
        assert!(minter.check_update(&target, &change(&wider, false)).is_ok());

        let mut app_key = target.clone();
        app_key.oauth_client_id = Some("client".into());
        assert!(
            Caller::Local
                .check_update(&app_key, &change(&wider, false))
                .is_err()
        );

        let levers = Levers::from_stored(serde_json::Map::new());
        let naming_levers = Change {
            grants: &target.grants,
            life: None,
            levers: Some(Some(&levers)),
            narrow_only: false,
        };
        assert!(minter.check_update(&target, &naming_levers).is_err());
        let holder = Caller::Key(Box::new(key(
            "h",
            "h",
            &[KeysMint, ConfigManage, AuditRead],
            &[],
        )));
        assert!(holder.check_update(&target, &naming_levers).is_ok());
        let narrow = Change {
            narrow_only: true,
            ..naming_levers
        };
        assert!(holder.check_update(&target, &narrow).is_err());
    }

    #[test]
    fn a_life_is_held_to_what_limits_it() {
        for (wanted, limit, longer) in [
            (None, None, false),
            (Some("2030"), None, false),
            (None, Some("2030"), true),
            (Some("2031"), Some("2030"), true),
            (Some("2030"), Some("2030"), false),
            (Some("2029"), Some("2030"), false),
        ] {
            assert_eq!(outlives(wanted, limit), longer, "{wanted:?} {limit:?}");
        }
    }

    #[test]
    fn a_permission_is_known_by_its_word_alone() {
        assert_eq!(
            Permission::from_word("keys.mint"),
            Some(Permission::KeysMint)
        );
        assert_eq!(Permission::from_word("KEYS.MINT"), None);
        assert_eq!(Permission::from_word("*"), None);
        for permission in Permission::ALL {
            assert_eq!(Permission::from_word(permission.word()), Some(permission));
        }
    }
}
