use marfa_rules::connector::{Connector, DEFAULT_TIER, Kinds};

use super::{Caller, Level, Permission};
use crate::app::refusal::{Code, Refusal, Result};

impl Caller {
    /// Whether this is the key a registration was made under. An app's token is no key's.
    pub fn is_connector_key(&self, key_id: &str) -> bool {
        matches!(self, Caller::Key(key) if key.id == key_id)
    }

    /// The host whose own key this is: only a host's key holds `connectors.host`.
    pub fn host_id(&self) -> Option<&str> {
        match self {
            Caller::Key(key) if key.grants.permissions.contains(&Permission::ConnectorsHost) => {
                key.made_by.host()
            }
            _ => None,
        }
    }

    pub fn manages_connectors(&self) -> bool {
        self.holds(Permission::ConnectorsManage)
    }

    /// A registration is made under a working key and no other credential.
    pub fn require_registering_key(&self) -> Result<()> {
        if matches!(self, Caller::Key(_)) {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::Forbidden,
                "Only a key registers a connector.",
            ))
        }
    }

    /// Whether the registration is one this caller may see.
    pub fn sees_connector(&self, key_id: &str) -> bool {
        self.is_connector_key(key_id) || self.manages_connectors()
    }

    pub fn require_own_connector_key(&self, key_id: &str) -> Result<()> {
        if self.is_connector_key(key_id) {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::Forbidden,
                "Only the connector's own key can do this.",
            ))
        }
    }

    pub fn require_connector_key_or_manager(&self, key_id: &str) -> Result<()> {
        if self.sees_connector(key_id) {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::Forbidden,
                "Only the connector's own key or a manager can do this.",
            ))
        }
    }
}

/// What a plugin's connector key reaches through its mapping, read from the mapping in force.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Mapped {
    /// Each enabled kind's target type, with the tier a new item of it takes.
    tiers: Vec<(String, String)>,
    /// The enabled target types that are none of the kinds' own types: the key's type map alone
    /// decides those.
    reach: Vec<String>,
}

impl Mapped {
    /// Kinds landing on one type at two tiers give it the feed.
    pub fn of(kinds: &Kinds, connector: &Connector) -> Mapped {
        let mut mapped = Mapped::default();
        for kind in &connector.kinds {
            let Some(entry) = kinds.get(&kind.name).filter(|entry| entry.enabled) else {
                continue;
            };
            let target = &entry.target_type;
            if target.split('.').next() == Some("system") {
                continue;
            }
            match mapped.tiers.iter_mut().find(|(held, _)| held == target) {
                Some((_, held)) if *held != entry.tier => *held = DEFAULT_TIER.to_string(),
                Some(_) => {}
                None => mapped.tiers.push((target.clone(), entry.tier.clone())),
            }
            let own = connector.kinds.iter().any(|kind| kind.own_type == *target);
            if !own && !mapped.reach.contains(target) {
                mapped.reach.push(target.clone());
            }
        }
        mapped
    }

    pub fn writes(&self, type_id: &str) -> bool {
        self.reach.iter().any(|held| held == type_id)
    }

    fn tier(&self, type_id: &str) -> &str {
        self.tiers
            .iter()
            .find(|(held, _)| held == type_id)
            .map_or(DEFAULT_TIER, |(_, tier)| tier.as_str())
    }

    fn reaches_any(&self) -> bool {
        !self.reach.is_empty()
    }
}

impl Caller {
    /// A plugin's connector key, on a type its mapping lands a kind on, for an item under its own source.
    fn mapped_onto(&self, type_id: &str, source: &str) -> bool {
        matches!(self, Caller::Key(key) if key.source == source) && self.maps_onto(type_id)
    }

    /// A plugin's connector key whose mapping lands a kind on `type_id`.
    pub fn maps_onto(&self, type_id: &str) -> bool {
        matches!(self, Caller::Key(key)
            if key.mapped.as_ref().is_some_and(|mapped| mapped.writes(type_id)))
    }

    /// Reads an item of `type_id` under `source`, through the type map or the mapping.
    pub fn may_read_item(&self, type_id: &str, source: &str) -> bool {
        self.may_read_type(type_id) || self.mapped_onto(type_id, source)
    }

    /// Writes an item of `type_id` under `source`, through the type map or the mapping.
    pub fn require_item_type(&self, type_id: &str, source: &str, level: Level) -> Result<()> {
        if self.mapped_onto(type_id, source) {
            return Ok(());
        }
        self.require_type(type_id, level)
    }

    /// A cascading edge onto an item of `type_id` under `source`, through the type map or the mapping.
    pub fn require_cascade_onto(&self, type_id: &str, source: &str) -> Result<()> {
        if self.mapped_onto(type_id, source) {
            return Ok(());
        }
        self.require_cascade_to(type_id)
    }

    /// The caller as a door that reads by the type map alone answers it.
    pub fn by_type_map(&self) -> Caller {
        match self {
            Caller::Key(key) => {
                let mut key = key.clone();
                key.mapped = None;
                key.by_type_map = true;
                Caller::Key(key)
            }
            other => other.clone(),
        }
    }

    /// A plugin's connector key: what its trash, restore and purge carry is what it could write itself.
    pub fn is_plugin_connector(&self) -> bool {
        matches!(self, Caller::Key(key) if key.mapped.is_some())
    }

    pub(super) fn mapping_reaches_any(&self) -> bool {
        matches!(self, Caller::Key(key)
            if key.mapped.as_ref().is_some_and(Mapped::reaches_any))
    }

    /// The tier a new item takes when its write names none: a plugin's connector key's mapping
    /// decides it, any other key's `default_tier`.
    pub fn tier_for(&self, type_id: &str) -> Option<&str> {
        let key = self.key()?;
        match &key.mapped {
            Some(mapped) if matches!(self, Caller::Key(_)) => Some(mapped.tier(type_id)),
            _ => Some(key.default_tier.as_str()),
        }
    }

    /// The connector's own key reads its mapping as it runs; otherwise it takes `connectors.manage`.
    pub fn require_mapping_reader(&self, source: Option<&str>) -> Result<()> {
        let own =
            matches!((self, source), (Caller::Key(key), Some(source)) if key.source == source);
        if own {
            return Ok(());
        }
        self.require(Permission::ConnectorsManage)
    }

    pub fn require_connector_source(&self, source: &str) -> Result<()> {
        if self.is_local() || matches!(self, Caller::Key(key) if key.source == source) {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::Forbidden,
                "Only the connector's own key can do this.",
            ))
        }
    }
}
