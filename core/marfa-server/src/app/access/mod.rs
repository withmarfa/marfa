//! Every decision of reach is made here; nothing else reads a map or names a permission as text.
//! A decision takes the state it decides on, so a write can make it inside its own transaction.

mod blobs;
mod connectors;
mod edges;
mod items;
mod jobs;
mod levers;
mod maps;
mod overview;
mod profile;
pub mod reach;
mod schema;
mod tools;
mod webhooks;

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::auth::session::{self, Session};
use super::clock::Stamp;
use super::config;
use super::keys::{self, Key};
use super::oauth;
use super::refusal::{Code, Refusal, Result};
use super::sources;
pub use items::printable;
pub use jobs::{Setting, standing_holder};
pub use levers::{Holding, Levers, OwnLevers, Standing, report_unread};
pub use maps::{Axis, Level, Map};
pub use overview::Described;
pub use schema::{Door, SchemaKind};
pub use webhooks::{Listener, Maker, attention_listeners, standing_maker};

macro_rules! permissions {
    ($($variant:ident = $wire:literal;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Permission {
            $($variant,)*
        }

        impl Permission {
            pub const ALL: [Permission; 14] = [$(Permission::$variant,)*];

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
    BackupsManage = "backups.manage";
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
    SignInsManage = "sign_ins.manage";
    WebhooksManage = "webhooks.manage";
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grants {
    pub permissions: Vec<Permission>,
    pub maps: [Map; 5],
    pub sources: Vec<String>,
}

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

    /// The first map entry or permission `wanted` holds beyond these, its sources aside.
    pub fn first_scope_beyond(&self, wanted: &Grants) -> Option<String> {
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
    }

    /// What `wanted` holds beyond these, where a key holding `own` holds that source too.
    pub fn first_beyond(&self, own: &str, wanted: &Grants) -> Option<Beyond> {
        self.first_scope_beyond(wanted)
            .map(Beyond::Scope)
            .or_else(|| first_source(wanted, |source| self.holds_source(own, source)))
    }

    fn holds_source(&self, own: &str, source: &str) -> bool {
        source == own || self.sources.iter().any(|claim| claim == source)
    }
}

fn first_source(wanted: &Grants, granted: impl Fn(&str) -> bool) -> Option<Beyond> {
    wanted
        .sources
        .iter()
        .find(|source| !granted(source))
        .map(|source| Beyond::Source(source.clone()))
}

/// Why a key may only be narrowed, worded for a change that widens it.
fn narrows_only(beyond: Beyond, why: &str) -> Refusal {
    match beyond {
        Beyond::Scope(scope) => Refusal::new(
            Code::Forbidden,
            format!("This gives the key {scope}, which it does not hold, and {why}"),
        )
        .with_detail("required_scope", scope),
        Beyond::Source(source) => Refusal::new(
            Code::Forbidden,
            format!("This gives the key the source {source}, which it does not hold, and {why}"),
        )
        .with_detail("source", source),
    }
}

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

#[derive(Debug)]
pub struct Change<'a> {
    pub grants: &'a Grants,
    pub life: Option<Option<&'a str>>,
    pub levers: Option<Option<&'a Levers>>,
    pub narrow_only: bool,
}

#[derive(Clone, Debug)]
pub enum Caller {
    Local(Standing),
    Key(Box<Key>),
    Owner(Box<Session>),
    App {
        key: Box<Key>,
        grant: Box<oauth::Granted>,
    },
    /// Outlives any request that started the work, so what a job does stands on no credential.
    Server,
}

impl Caller {
    pub fn local() -> Caller {
        Caller::Local(Standing::default())
    }

    /// Asked of a key that has since ended, it refuses as a request bearing that key would.
    pub fn current(&self, tx: &Transaction<'_>, at: &str) -> Result<Caller> {
        match self {
            Caller::Local(_) => Ok(Caller::Local(config::standing(tx, None)?)),
            Caller::Server => Ok(Caller::Server),
            Caller::Key(key) => match keys::live_by_id(tx, &key.id, at)? {
                Some(key) => Ok(Caller::Key(Box::new(standing_key(tx, key)?))),
                None => Err(match keys::expired_at(tx, &key.id, at)? {
                    Some(end) => expired(&end),
                    None => unauthorized(),
                }),
            },
            Caller::Owner(session) => {
                let mut session = session::live_by_id(tx, &session.id, Stamp::read(at)?)?
                    .ok_or_else(unauthorized)?;
                session.standing = config::standing(tx, None)?;
                Ok(Caller::Owner(Box::new(session)))
            }
            Caller::App { key, .. } => match oauth::live_by_id(tx, &key.id, at)? {
                Some(Caller::App { mut key, grant }) => {
                    key.standing = config::standing(tx, None)?;
                    Ok(Caller::App { key, grant })
                }
                _ => Err(unauthorized()),
            },
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Caller::Local(_))
    }

    pub fn session(&self) -> Option<&Session> {
        match self {
            Caller::Owner(session) => Some(session),
            _ => None,
        }
    }

    pub fn require_recent(&self, at: &str) -> Result<()> {
        match self.session() {
            Some(session) if !session.is_recent(Stamp::read(at)?) => {
                Err(Refusal::needs_recent_sign_in())
            }
            _ => Ok(()),
        }
    }

    /// A restore stores settings only for a caller that may change them at `/config`.
    pub fn require_settings_restore(&self, settings: &[String]) -> Result<()> {
        if settings.is_empty() || self.holds(Permission::ConfigManage) {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Forbidden,
            format!(
                "Restoring this archive would store settings, which requires the config.manage permission: {}.",
                settings.join(", ")
            ),
        )
        .with_detail("required_scope", Permission::ConfigManage.word())
        .with_detail("settings", settings.to_vec()))
    }

    /// A key has no sign-in to renew, so it is refused rather than challenged.
    pub fn require_step_up(&self, permission: Permission, at: &str) -> Result<()> {
        match self {
            Caller::Local(_) => Ok(()),
            Caller::Owner(_) => self.require(permission),
            Caller::Key(_) => {
                self.require(permission)?;
                Err(Refusal::app_sign_in_required())
            }
            Caller::Server => Err(Refusal::app_sign_in_required()),
            Caller::App { grant, .. } => {
                self.require(permission)?;
                let now = Stamp::read(at)?;
                let recent = grant
                    .authenticated_at
                    .is_some_and(|signed_in| session::recent(signed_in, now));
                if recent {
                    Ok(())
                } else {
                    Err(Refusal::insufficient_user_authentication(
                        session::RECENT_SECONDS,
                    ))
                }
            }
        }
    }

    pub fn key(&self) -> Option<&Key> {
        match self {
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => None,
            Caller::Key(key) | Caller::App { key, .. } => Some(key),
        }
    }

    /// A browser session holds nothing: it acts only on the sign-in pages, as the owner.
    pub fn holds(&self, permission: Permission) -> bool {
        match self {
            Caller::Local(_) | Caller::Server => true,
            Caller::Owner(_) => false,
            Caller::Key(key) | Caller::App { key, .. } => key.grants.holds(permission),
        }
    }

    pub fn require(&self, permission: Permission) -> Result<()> {
        if self.holds(permission) {
            Ok(())
        } else {
            Err(requires(permission))
        }
    }

    pub fn require_local(&self) -> Result<()> {
        if self.is_local() {
            Ok(())
        } else {
            Err(Refusal::needs_local(
                "Only the private local command can do this.",
            ))
        }
    }

    /// For adding a passkey, which only the owner's own browser does.
    pub fn require_owner(&self) -> Result<()> {
        if matches!(self, Caller::Local(_) | Caller::Owner(_)) {
            Ok(())
        } else {
            Err(Refusal::new(Code::Forbidden, "Only the owner can do this."))
        }
    }

    /// The owner's passkeys and password, which the passkey page manages as well as any holder of `sign_ins.manage`.
    pub fn require_passkeys(&self) -> Result<()> {
        match self {
            Caller::Owner(_) => Ok(()),
            _ => self.require(Permission::SignInsManage),
        }
    }

    pub fn manages_keys(&self) -> bool {
        self.holds(Permission::KeysManage)
    }

    pub fn require_key_door(&self) -> Result<()> {
        if self.manages_keys() {
            Ok(())
        } else {
            self.require(Permission::KeysMint)
        }
    }

    pub fn reaches(&self, target: &Key) -> bool {
        match self {
            Caller::Local(_) | Caller::Server => true,
            Caller::Owner(_) => false,
            Caller::Key(key) | Caller::App { key, .. } => {
                key.id == target.id
                    || key.grants.holds(Permission::KeysManage)
                    || key
                        .grants
                        .first_beyond(&key.source, &target.grants)
                        .is_none()
            }
        }
    }

    pub fn whole_set(&self) -> Grants {
        match self {
            Caller::Local(_) | Caller::Server => Grants::everything(),
            Caller::Owner(_) => Grants::default(),
            Caller::Key(key) | Caller::App { key, .. } => key.grants.clone(),
        }
    }

    pub fn check_ceiling(&self, wanted: &Grants) -> Result<()> {
        let nothing = Grants::default();
        let held = match self {
            Caller::Local(_) | Caller::Server => return Ok(()),
            Caller::Owner(_) => &nothing,
            Caller::Key(key) | Caller::App { key, .. } => &key.grants,
        };
        let beyond = held
            .first_scope_beyond(wanted)
            .map(Beyond::Scope)
            .or_else(|| first_source(wanted, |source| self.may_grant(source)));
        beyond.map_or(Ok(()), |beyond| Err(beyond.into()))
    }

    pub fn check_life(&self, wanted: Option<&str>) -> Result<()> {
        let limit = self.key().and_then(|key| key.expires_at.as_deref());
        if outlives(wanted, limit) {
            Err(longer_life(limit))
        } else {
            Ok(())
        }
    }

    /// A write names the caller's own source or one it claims.
    pub fn writes_under(&self, source: &str) -> bool {
        match self {
            Caller::Local(_) | Caller::Server => true,
            Caller::Owner(_) => false,
            Caller::Key(key) | Caller::App { key, .. } => {
                key.grants.holds_source(&key.source, source)
            }
        }
    }

    /// Whoever reaches every key may hand any of them any source the server does not keep for itself.
    pub fn may_grant(&self, source: &str) -> bool {
        self.writes_under(source) || (self.manages_keys() && !sources::reserved(source))
    }

    pub fn check_own_source(&self, source: &str, claimed_elsewhere: bool) -> Result<()> {
        if claimed_elsewhere && !self.may_grant(source) {
            Err(source_refused(source.to_string()))
        } else {
            Ok(())
        }
    }

    /// Whoever takes a held source as its own takes over what a connector keeps there.
    pub fn check_held_source(&self, source: &str, held: bool) -> Result<()> {
        if held && !self.manages_keys() {
            Err(requires(Permission::KeysManage).with_detail("source", source))
        } else {
            Ok(())
        }
    }

    /// `keys.manage` narrows any key and `keys.mint` widens one within the caller; holding both gives either.
    pub fn check_update(&self, target: &Key, change: &Change<'_>) -> Result<()> {
        if change.levers.is_some() {
            self.require(Permission::ConfigManage)?;
        }
        let limit = target.expires_at.as_deref();
        let widening = target.grants.first_beyond(&target.source, change.grants);
        let lengthens = change.life.is_some_and(|wanted| outlives(wanted, limit));
        if widening.is_some() || lengthens {
            let why = if target.oauth_client_id.is_some() {
                Some("a key an app made can only be narrowed.")
            } else if change.narrow_only {
                Some("narrow_only refuses a widening.")
            } else if !self.is_local() && !self.holds(Permission::KeysMint) {
                Some("keys.manage only narrows a key. Widening a key needs keys.mint.")
            } else {
                None
            };
            if let Some(why) = why {
                return Err(match widening {
                    Some(beyond) => narrows_only(beyond, why),
                    None => longer_life(limit),
                });
            }
        }
        if change.narrow_only
            && change
                .levers
                .is_some_and(|levers| !target.levers.already(levers))
        {
            return Err(Refusal::new(
                Code::Forbidden,
                "narrow_only refuses a change to enforcement_override.",
            )
            .with_detail("field", "enforcement_override"));
        }
        let narrows = widening.is_none() && !lengthens;
        if self.is_local() || (narrows && self.manages_keys()) {
            return Ok(());
        }
        self.require(Permission::KeysMint)?;
        self.check_ceiling(change.grants)?;
        match change.life {
            Some(wanted) => self.check_life(wanted),
            None if widening.is_some() => self.check_life(limit),
            None => Ok(()),
        }
    }

    pub fn sees_source(&self, source: &str) -> bool {
        self.manages_keys() || self.may_grant(source)
    }

    pub fn require_may_name(&self, source: &str) -> Result<()> {
        if self.sees_source(source) {
            Ok(())
        } else {
            Err(requires(Permission::KeysManage))
        }
    }

    /// The credential an audit entry names; the server's own writes name none.
    pub fn audit_id(&self) -> Option<String> {
        match self {
            Caller::Local(_) => Some("local:process".to_string()),
            Caller::Server => None,
            Caller::Key(key) | Caller::App { key, .. } => Some(key.id.clone()),
            Caller::Owner(session) => Some(format!("owner:{}", session.id)),
        }
    }

    pub fn actor(&self) -> Value {
        match self {
            Caller::Local(_) => json!({ "kind": "local", "id": "local", "name": "Local command" }),
            Caller::Server => json!({ "kind": "server", "id": "server", "name": "Marfa" }),
            Caller::Key(key) => json!({ "kind": "key", "id": key.id, "name": key.shown_name() }),
            Caller::Owner(session) => {
                json!({ "kind": "browser", "id": session.id, "name": session.name() })
            }
            Caller::App { key, grant } => {
                json!({ "kind": "app", "id": grant.grant_id, "name": key.shown_name() })
            }
        }
    }
}

fn standing_key(tx: &Transaction<'_>, mut key: Key) -> Result<Key> {
    key.standing = match &key.levers {
        OwnLevers::Unread(text) => {
            report_unread(&key.id, text);
            Standing::closed()
        }
        own => config::standing(tx, own.readable())?,
    };
    Ok(key)
}

pub fn unauthorized() -> Refusal {
    Refusal::new(Code::Unauthorized, "A valid credential is required.")
}

/// Told only to a request bearing the key's own secret.
pub fn expired(at: &str) -> Refusal {
    Refusal::new(
        Code::Unauthorized,
        format!("This key expired at {at}. Use a key that has not expired."),
    )
    .with_detail("expired_at", at)
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
            levers: OwnLevers::Unset,
            standing: Standing::default(),
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
    fn an_apps_sign_in_stands_for_fifteen_minutes_and_the_challenge_says_so() {
        const NOW: i64 = 1_800_000_000_000;
        const FIFTEEN_MINUTES_MS: i64 = 900_000;
        let at = |ms: i64| Stamp::from_ms(ms).unwrap().text();
        let app = Caller::App {
            key: Box::new(key("app", "mine", &[Permission::BackupsManage], &[])),
            grant: Box::new(oauth::Granted {
                client_id: "client".into(),
                owner_id: "owner".into(),
                grant_id: "grant".into(),
                authenticated_at: Some(Stamp::from_ms(NOW).unwrap()),
            }),
        };
        let step_up = |ms: i64| app.require_step_up(Permission::BackupsManage, &at(ms));
        step_up(NOW).unwrap();
        step_up(NOW + FIFTEEN_MINUTES_MS).unwrap();
        let refused = step_up(NOW + FIFTEEN_MINUTES_MS + 1).unwrap_err();
        assert_eq!(refused.code, Code::InsufficientUserAuthentication);
        assert_eq!(
            refused.details.and_then(|d| d.get("max_age").cloned()),
            Some(json!(900))
        );
    }

    #[test]
    fn a_credential_cannot_write_a_system_type_whatever_its_map_says() {
        let wide = with_map(
            key("wide", "mine", &[], &[]),
            Axis::Type,
            json!({ "*": "write" }),
        );
        let app = Caller::App {
            key: Box::new(wide.clone()),
            grant: Box::new(oauth::Granted {
                client_id: "client".into(),
                owner_id: "owner".into(),
                grant_id: "grant".into(),
                authenticated_at: None,
            }),
        };
        for credential in [Caller::Key(Box::new(wide)), app] {
            let refused = credential
                .require_type("system.connection", Level::Write)
                .unwrap_err();
            assert_eq!(refused.code, Code::TypeNotPermitted);
            credential.require_type("core.note", Level::Write).unwrap();
            credential.require_type("system.view", Level::Read).unwrap();
        }
        for direct in [Caller::local(), Caller::Server] {
            direct
                .require_type("system.connection", Level::Write)
                .unwrap();
        }
    }

    #[test]
    fn a_credential_reads_system_connection_items_only_with_grants_manage() {
        let every = |permissions: &[Permission]| {
            Caller::Key(Box::new(with_map(
                key("k", "mine", permissions, &[]),
                Axis::Type,
                json!({ "*": "read" }),
            )))
        };
        let plain = every(&[]);
        assert!(plain.may_read_type("core.note"));
        assert!(plain.may_read_type("system.folder"));
        assert!(!plain.may_read_type("system.connection"));
        assert!(!plain.may_read_every_type());
        let refused = plain
            .require_type("system.connection", Level::Read)
            .unwrap_err();
        assert_eq!(refused.code, Code::Forbidden);
        assert_eq!(
            refused
                .details
                .and_then(|d| d.get("required_scope").cloned()),
            Some(json!("grants.manage"))
        );

        let manager = every(&[Permission::GrantsManage]);
        assert!(manager.may_read_type("system.connection"));
        assert!(manager.may_read_every_type());
        manager
            .require_type("system.connection", Level::Read)
            .unwrap();
        let unmapped = Caller::Key(Box::new(key("m", "mine", &[Permission::GrantsManage], &[])));
        assert!(!unmapped.may_read_type("system.connection"));
        assert_eq!(
            unmapped
                .require_type("system.connection", Level::Read)
                .unwrap_err()
                .code,
            Code::TypeNotPermitted
        );
        for direct in [Caller::local(), Caller::Server] {
            assert!(direct.may_read_type("system.connection"));
            assert!(direct.may_read_every_type());
        }
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
        assert!(Caller::local().reaches(&wide_types(key("t", "t", &[KeysManage], &["x"]))));
    }

    fn app(key: Key) -> Caller {
        Caller::App {
            key: Box::new(key),
            grant: Box::new(oauth::Granted {
                client_id: "client".into(),
                owner_id: "owner".into(),
                grant_id: "grant".into(),
                authenticated_at: None,
            }),
        }
    }

    fn app_key(mut key: Key) -> Key {
        key.source = "oauth:client".into();
        key.oauth_client_id = Some("client".into());
        key
    }

    fn refusal_detail(refusal: &Refusal, name: &str) -> Option<Value> {
        refusal.details.as_ref().and_then(|d| d.get(name).cloned())
    }

    #[test]
    fn an_update_is_held_to_the_caller_and_to_the_key() {
        use Permission::{AuditRead, ConfigManage, KeysManage, KeysMint, WebhooksManage};
        let target = key("t", "t", &[AuditRead], &[]);
        let wider = key("t", "t", &[AuditRead, KeysMint], &[]).grants;
        let beyond_minter = key("t", "t", &[AuditRead, WebhooksManage], &[]).grants;
        let nothing = Grants::default();
        let change = |grants, narrow_only| Change {
            grants,
            life: None,
            levers: None,
            narrow_only,
        };
        let held = |permissions: &[Permission]| {
            let mut all = vec![AuditRead];
            all.extend_from_slice(permissions);
            key("c", "c", &all, &[])
        };
        let mut made_by_an_app = target.clone();
        made_by_an_app.oauth_client_id = Some("client".into());
        let local = Caller::local();
        let plain = Caller::Key(Box::new(held(&[])));
        let manager = Caller::Key(Box::new(held(&[KeysManage])));
        let minter = Caller::Key(Box::new(held(&[KeysMint])));
        let both = Caller::Key(Box::new(held(&[KeysManage, KeysMint])));
        let app_manager = app(app_key(held(&[KeysManage])));
        let app_minter = app(app_key(held(&[KeysMint])));
        let app_both = app(app_key(held(&[KeysManage, KeysMint])));
        for (name, caller, target, grants, narrow_only, allowed) in [
            ("local widens", &local, &target, &wider, false, true),
            ("local, narrow_only", &local, &target, &wider, true, false),
            (
                "local, a key an app made",
                &local,
                &made_by_an_app,
                &wider,
                false,
                false,
            ),
            (
                "a key holding neither",
                &plain,
                &target,
                &nothing,
                false,
                false,
            ),
            ("manage narrows", &manager, &target, &nothing, false, true),
            (
                "manage alone widens",
                &manager,
                &target,
                &wider,
                false,
                false,
            ),
            ("mint narrows", &minter, &target, &nothing, false, true),
            (
                "mint widens within itself",
                &minter,
                &target,
                &wider,
                false,
                true,
            ),
            (
                "mint widens beyond itself",
                &minter,
                &target,
                &beyond_minter,
                false,
                false,
            ),
            (
                "both widen within the caller",
                &both,
                &target,
                &wider,
                false,
                true,
            ),
            (
                "both widen beyond the caller",
                &both,
                &target,
                &beyond_minter,
                false,
                false,
            ),
            ("both narrow", &both, &target, &nothing, false, true),
            ("both, narrow_only", &both, &target, &wider, true, false),
            (
                "both, a key an app made",
                &both,
                &made_by_an_app,
                &wider,
                false,
                false,
            ),
            (
                "both narrow a key an app made",
                &both,
                &made_by_an_app,
                &nothing,
                false,
                true,
            ),
            (
                "an app's manage alone widens",
                &app_manager,
                &target,
                &wider,
                false,
                false,
            ),
            (
                "an app's manage narrows",
                &app_manager,
                &target,
                &nothing,
                false,
                true,
            ),
            (
                "an app's mint widens",
                &app_minter,
                &target,
                &wider,
                false,
                true,
            ),
            (
                "an app's mint and manage widen",
                &app_both,
                &target,
                &wider,
                false,
                true,
            ),
            (
                "an app's both widen beyond it",
                &app_both,
                &target,
                &beyond_minter,
                false,
                false,
            ),
        ] {
            assert_eq!(
                caller
                    .check_update(target, &change(grants, narrow_only))
                    .is_ok(),
                allowed,
                "{name}"
            );
        }

        let refused = manager
            .check_update(&target, &change(&wider, false))
            .unwrap_err();
        assert_eq!(refused.code, Code::Forbidden);
        assert!(
            refused.message.contains("keys.manage only narrows"),
            "{}",
            refused.message
        );
        assert!(
            !refused.message.contains("you do not hold"),
            "{}",
            refused.message
        );
        assert_eq!(
            refusal_detail(&refused, "required_scope"),
            Some(json!("keys.mint"))
        );
        let claiming = key("t", "t", &[AuditRead], &["theirs"]).grants;
        let refused = manager
            .check_update(&target, &change(&claiming, false))
            .unwrap_err();
        assert!(
            refused.message.contains("keys.manage only narrows"),
            "{}",
            refused.message
        );
        assert_eq!(refusal_detail(&refused, "source"), Some(json!("theirs")));
        let refused = minter
            .check_update(&target, &change(&beyond_minter, false))
            .unwrap_err();
        assert!(
            refused.message.contains("which you do not hold"),
            "{}",
            refused.message
        );
        assert_eq!(
            refusal_detail(&refused, "required_scope"),
            Some(json!("webhooks.manage"))
        );

        let levers = Levers::from_row("{}").unwrap();
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
    fn keys_manage_grants_any_source_the_server_does_not_keep() {
        use Permission::{KeysManage, KeysMint};
        let claiming = |sources: &[&str]| key("w", "w", &[], sources).grants;
        let minter = Caller::Key(Box::new(key("n", "n", &[KeysMint], &["ours"])));
        let both = Caller::Key(Box::new(key("b", "b", &[KeysManage, KeysMint], &[])));
        let app_both = app(app_key(key("a", "a", &[KeysManage, KeysMint], &[])));
        let at = Stamp::from_ms(0).unwrap();
        let browser = Caller::Owner(Box::new(Session {
            id: "s".into(),
            owner_id: "owner".into(),
            created_at: at,
            last_used_at: at,
            expires_at: at,
            user_agent: None,
            standing: Standing::default(),
        }));
        for (name, caller, source, granted) in [
            ("mint, its own source", &minter, "n", true),
            ("mint, its claim", &minter, "ours", true),
            ("mint, another source", &minter, "theirs", false),
            ("manage, another source", &both, "theirs", true),
            (
                "manage, a connector's source",
                &both,
                "connector:github",
                true,
            ),
            ("manage, an app's source", &both, "oauth:client", false),
            ("manage, a restored source", &both, "Restored:device", false),
            ("an app's manage, another source", &app_both, "theirs", true),
            (
                "an app's manage, its own app's source",
                &app_both,
                "oauth:client",
                true,
            ),
            (
                "an app's manage, another app's source",
                &app_both,
                "oauth:other",
                false,
            ),
            ("a browser session", &browser, "theirs", false),
            ("local authority", &Caller::local(), "theirs", true),
        ] {
            assert_eq!(caller.may_grant(source), granted, "{name}");
            assert_eq!(
                caller.check_ceiling(&claiming(&[source])).is_ok(),
                granted,
                "{name}"
            );
        }
        assert!(!both.writes_under("theirs"));
        assert!(both.writes_under("b"));
        assert!(both.sees_source("oauth:client"));
    }

    #[test]
    fn a_widening_update_is_held_to_the_callers_life() {
        use Permission::{AuditRead, KeysManage, KeysMint};
        let held_until = |id: &str, permissions: &[Permission], end: Option<&str>| {
            let mut key = key(id, id, permissions, &[]);
            key.expires_at = end.map(Into::into);
            key
        };
        let expiring = |id: &str, end: Option<&str>| {
            let mut key = key(id, id, &[KeysMint, AuditRead], &[]);
            key.expires_at = end.map(Into::into);
            key
        };
        let wider = key("t", "t", &[AuditRead, KeysMint], &[]).grants;
        let narrower = Grants::default();
        let change = |grants, life| Change {
            grants,
            life,
            levers: None,
            narrow_only: false,
        };
        let minter = Caller::Key(Box::new(expiring("w", Some("2030"))));
        let lasting = Caller::Key(Box::new(expiring("l", None)));
        let both = Caller::Key(Box::new(held_until(
            "b",
            &[KeysManage, KeysMint, AuditRead],
            Some("2030"),
        )));
        let manager = Caller::Key(Box::new(held_until("m", &[KeysManage, AuditRead], None)));
        let open = key("t", "t", &[AuditRead], &[]);
        let mut shorter = open.clone();
        shorter.expires_at = Some("2029".into());
        for (caller, target, grants, life, allowed) in [
            (&minter, &open, &wider, None, false),
            (&minter, &open, &wider, Some(None), false),
            (&minter, &open, &wider, Some(Some("2030")), true),
            (&minter, &open, &narrower, None, true),
            (&minter, &open, &open.grants, None, true),
            (&minter, &shorter, &wider, None, true),
            (&lasting, &open, &wider, None, true),
            (&both, &open, &wider, None, false),
            (&both, &open, &wider, Some(Some("2030")), true),
            (&both, &open, &wider, Some(Some("2031")), false),
            (
                &both,
                &shorter,
                &shorter.grants,
                Some(Some("2029-06")),
                true,
            ),
            (&both, &open, &narrower, Some(None), true),
            (&manager, &shorter, &shorter.grants, Some(None), false),
            (
                &manager,
                &shorter,
                &shorter.grants,
                Some(Some("2028")),
                true,
            ),
            (&manager, &open, &narrower, Some(Some("2028")), true),
        ] {
            assert_eq!(
                caller.check_update(target, &change(grants, life)).is_ok(),
                allowed,
                "{:?} {:?} {life:?}",
                target.expires_at,
                grants.permissions
            );
        }
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
    fn a_blob_is_read_only_through_a_row_that_lends_it_and_that_the_caller_may_read() {
        use crate::app::blobs::Lender;

        fn reads<const N: usize>(caller: &Caller, lenders: [Lender; N]) -> bool {
            caller.may_read_blob(lenders.map(Ok)).unwrap()
        }

        let note = || Lender::Item {
            type_id: "core.note".into(),
        };
        let link = |from_type: &str| Lender::Edge {
            edge_type: "core.links".into(),
            from_type: from_type.into(),
        };
        let extension = |item_type: &str| Lender::Extension {
            namespace: "acme".into(),
            item_type: item_type.into(),
        };
        let reader = |types: Value, edges: Value, extensions: Value| {
            let key = with_map(key("r", "mine", &[], &[]), Axis::Type, types);
            let key = with_map(key, Axis::Edge, edges);
            Caller::Key(Box::new(with_map(key, Axis::Extension, extensions)))
        };
        let notes = json!({ "core.note": "read" });
        let nothing = json!({});
        let every_edge = json!({ "*": "read" });

        let narrow = reader(notes.clone(), nothing.clone(), nothing.clone());
        assert!(reads(&narrow, [note()]));
        assert!(!reads(&narrow, []));
        assert!(!reads(
            &narrow,
            [Lender::Item {
                type_id: "core.file".into()
            }]
        ));
        assert!(!reads(&narrow, [link("core.note")]));
        assert!(!reads(&narrow, [extension("core.note")]));

        let edges = reader(notes.clone(), every_edge.clone(), nothing.clone());
        assert!(reads(&edges, [link("core.note")]));
        assert!(!reads(&edges, [link("core.file")]));

        let extensions = reader(notes, nothing.clone(), json!({ "acme": "read" }));
        assert!(reads(&extensions, [extension("core.note")]));
        assert!(!reads(&extensions, [extension("core.file")]));

        let manager = key("m", "mine", &[Permission::BlobsManage], &[]);
        for every in [Caller::Key(Box::new(manager)), Caller::local()] {
            assert!(reads(&every, []));
        }

        let unread = || Err(Refusal::internal("unread"));
        assert!(narrow.may_read_blob([Ok(note()), unread()]).unwrap());
        assert!(narrow.may_read_blob([unread(), Ok(note())]).is_err());
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
