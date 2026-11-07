//! What a caller may do to the registries of types and edge types.

use serde_json::json;

use super::{Axis, Caller, Level, Permission};
use crate::app::refusal::{Code, Refusal, Result};

/// How a caller means to change a registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Door {
    Register,
    Replace,
    Change,
}

/// The two registries a map names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaKind {
    Types,
    EdgeTypes,
}

impl SchemaKind {
    const fn subresource(self) -> &'static str {
        match self {
            SchemaKind::Types => "types",
            SchemaKind::EdgeTypes => "edge_types",
        }
    }
}

fn grant(kind: &str, name: &str, level: Level) -> serde_json::Value {
    json!({ "kind": kind, "name": name, "level": level.word() })
}

impl Caller {
    pub(super) fn level_on(&self, axis: Axis, name: &str) -> Level {
        match self {
            Caller::Local => Level::Write,
            Caller::Key(key) => axis.level(key.grants.map(axis), name),
        }
    }

    /// Refuses a caller whose metadata map does not reach `registry` at
    /// `level`.
    pub fn require_metadata(&self, registry: SchemaKind, level: Level) -> Result<()> {
        let subresource = registry.subresource();
        if self.level_on(Axis::Metadata, subresource) >= level {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Forbidden,
            format!("Missing metadata.{subresource}:{} permission", level.word()),
        )
        .with_detail("metadata_subresource", subresource)
        .with_detail("required", level.word()))
    }

    /// Refuses a caller that may not use `door` on `registry`: registering
    /// takes the metadata map, replacing a type takes it too where
    /// `schema.write` is not held, and everything else takes `schema.write`.
    pub fn require_door(&self, registry: SchemaKind, door: Door) -> Result<()> {
        let by_map = match door {
            Door::Register => true,
            Door::Replace => {
                registry == SchemaKind::Types && !self.holds(Permission::SchemaWrite) && {
                    self.level_on(Axis::Metadata, registry.subresource()) >= Level::Write
                }
            }
            Door::Change => false,
        };
        if door == Door::Replace && by_map {
            return Ok(());
        }
        if by_map {
            self.require_metadata(registry, Level::Write)
        } else {
            self.require(Permission::SchemaWrite)
        }
    }

    /// Refuses a caller whose type map does not reach `name` at `level`.
    /// Platform-managed `system.*` types are written by the platform alone.
    pub fn require_type(&self, name: &str, level: Level) -> Result<()> {
        let Caller::Key(key) = self else {
            return Ok(());
        };
        if level == Level::Write && name.split('.').next() == Some("system") {
            return Err(Refusal::new(
                Code::TypeNotPermitted,
                "Reserved namespace: platform-managed operations write system.* items; \
                 credentials cannot write them directly.",
            ));
        }
        let held = Axis::Type.level(key.grants.map(Axis::Type), name);
        if held >= level {
            return Ok(());
        }
        let message = if held == Level::None {
            format!("No access to type \"{name}\"")
        } else {
            format!("Write access to type \"{name}\" denied")
        };
        Err(Refusal::new(Code::TypeNotPermitted, message)
            .with_detail("grant", grant("type", name, level)))
    }

    /// Refuses a caller whose edge map does not reach `name` at `level`.
    pub fn require_edge(&self, name: &str, level: Level) -> Result<()> {
        if self.level_on(Axis::Edge, name) >= level {
            return Ok(());
        }
        Err(Refusal::new(
            Code::EdgePermissionDenied,
            format!("Missing edge.{name}:{} permission", level.word()),
        )
        .with_detail("edge_type", name)
        .with_detail("required", level.word())
        .with_detail("grant", grant("edge_type", name, level)))
    }

    /// A type a type may name as its parent or as a `compatible_with` target:
    /// one Marfa ships is open to all, any other takes write on it.
    pub fn require_dependency(&self, name: &str, shipped: bool) -> Result<()> {
        if shipped {
            Ok(())
        } else {
            self.require_type(name, Level::Write)
        }
    }
}
