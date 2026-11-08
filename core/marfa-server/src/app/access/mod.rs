//! Every decision of reach is made here; nothing else reads a map or names a permission as text.
//! A decision takes the state it decides on, so a write can make it inside its own transaction.

mod blobs;
mod connectors;
mod edges;
mod items;
mod levers;
mod maps;
mod overview;
mod profile;
pub mod reach;
mod schema;
mod webhooks;

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::auth::session::{self, Session};
use super::auth::{millis_of, seconds_of};
use super::config;
use super::keys::{self, Key};
use super::oauth;
use super::refusal::{Code, Refusal, Result};
pub use items::printable;
pub use levers::{Levers, OwnLevers, Standing, report_unread};
pub use maps::{Axis, Level, Map};
pub use overview::Described;
pub use schema::{Door, SchemaKind};
pub use webhooks::{Maker, standing_maker};

pub const SIGN_IN_AGAIN: &str = "Sign in again to perform this operation";

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

    /// The holder may grant its own source and its claims.
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
            Caller::Key(key) => {
                let key = keys::live_by_id(tx, &key.id, at)?.ok_or_else(unauthorized)?;
                Ok(Caller::Key(Box::new(standing_key(tx, key)?)))
            }
            Caller::Owner(session) => {
                let mut session = session::live_by_id(tx, &session.id, seconds_of(at)?)?
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

    pub fn is_direct(&self) -> bool {
        matches!(self, Caller::Local(_) | Caller::Owner(_))
    }

    pub fn session(&self) -> Option<&Session> {
        match self {
            Caller::Owner(session) => Some(session),
            _ => None,
        }
    }

    pub fn require_recent(&self, at: &str) -> Result<()> {
        match self.session() {
            Some(session) if !session.is_recent(millis_of(at)?) => {
                Err(Refusal::new(Code::Forbidden, SIGN_IN_AGAIN))
            }
            _ => Ok(()),
        }
    }

    pub fn key(&self) -> Option<&Key> {
        match self {
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => None,
            Caller::Key(key) | Caller::App { key, .. } => Some(key),
        }
    }

    pub fn holds(&self, permission: Permission) -> bool {
        match self {
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => true,
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

    pub fn require_direct(&self) -> Result<()> {
        if self.is_direct() {
            Ok(())
        } else {
            Err(Refusal::new(Code::Forbidden, "Only the owner can do this."))
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
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => true,
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
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => Grants::everything(),
            Caller::Key(key) | Caller::App { key, .. } => key.grants.clone(),
        }
    }

    pub fn check_ceiling(&self, wanted: &Grants) -> Result<()> {
        let Some(key) = self.key() else {
            return Ok(());
        };
        match key.grants.first_beyond(&key.source, wanted) {
            Some(beyond) => Err(beyond.into()),
            None => Ok(()),
        }
    }

    pub fn check_life(&self, wanted: Option<&str>) -> Result<()> {
        let limit = self.key().and_then(|key| key.expires_at.as_deref());
        if outlives(wanted, limit) {
            Err(longer_life(limit))
        } else {
            Ok(())
        }
    }

    pub fn may_grant(&self, source: &str) -> bool {
        match self {
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => true,
            Caller::Key(key) | Caller::App { key, .. } => key.grants.may_grant(&key.source, source),
        }
    }

    pub fn check_own_source(&self, source: &str, claimed_elsewhere: bool) -> Result<()> {
        if claimed_elsewhere && !self.may_grant(source) {
            Err(source_refused(source.to_string()))
        } else {
            Ok(())
        }
    }

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
                .is_some_and(|levers| !target.levers.already(levers))
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

    pub fn audit_id(&self) -> String {
        match self {
            Caller::Local(_) => "local:process".to_string(),
            Caller::Server => "server".to_string(),
            Caller::Key(key) | Caller::App { key, .. } => key.id.clone(),
            Caller::Owner(session) => format!("owner:{}", session.id),
        }
    }

    pub fn actor(&self) -> Value {
        match self {
            Caller::Local(_) => json!({ "kind": "local", "id": "local", "name": "Local command" }),
            Caller::Server => json!({ "kind": "server", "id": "server", "name": "Marfa" }),
            Caller::Key(key) => json!({ "kind": "key", "id": key.id, "name": key.label }),
            Caller::Owner(session) => {
                json!({ "kind": "browser", "id": session.id, "name": session.name() })
            }
            Caller::App { key, grant } => {
                json!({ "kind": "app", "id": grant.grant_id, "name": key.label })
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
                user_id: "owner".into(),
                grant_id: "grant".into(),
            }),
        };
        for credential in [Caller::Key(Box::new(wide)), app] {
            let refused = credential
                .require_type("system.connection", Level::Write)
                .unwrap_err();
            assert_eq!(refused.code, Code::TypeNotPermitted);
            credential.require_type("core.note", Level::Write).unwrap();
            credential
                .require_type("system.connection", Level::Read)
                .unwrap();
        }
        for direct in [Caller::local(), Caller::Server] {
            direct
                .require_type("system.connection", Level::Write)
                .unwrap();
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
            Caller::local()
                .check_update(&target, &change(&wider, false))
                .is_ok()
        );
        assert!(
            Caller::local()
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
            Caller::local()
                .check_update(&app_key, &change(&wider, false))
                .is_err()
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
        let link = |source_type: &str| Lender::Edge {
            edge_type: "core.links".into(),
            source_type: source_type.into(),
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
