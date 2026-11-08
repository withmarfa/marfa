//! [`write`] makes each check on the state its transaction commits, so a door, an inline write, a
//! bulk entry and a conflicted copy all meet the same rules.

use std::collections::{BTreeMap, HashSet};

use marfa_rules::catalog::{EdgeType, End, Lineage, lineage_of};
use marfa_rules::edges::{self, OnDelete, Proposed, Refused};
use marfa_rules::error::Code as RuleCode;
use marfa_rules::{js, validation};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::rows::{self, Landed, NewEdge, Store};
use super::{Edge, not_found};
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::blobs::references::{self, Naming, Row as Referencing};
use crate::app::catalog::{self, Catalog, Snapshot as Reading};
use crate::app::events::Event;
use crate::app::idempotency::{self, Claim, Need};
use crate::app::items::write::{Done, ruled};
use crate::app::items::{self, Item};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;

const FOLDER_EDGE: &str = "in-folder";
const FOLDER_PATH: &str = "path";
const MAX_FOLDER_PATH: usize = 1024;
const FOLDER_TYPE: &str = "system.folder";

pub struct Writing<'a, 't, 'c> {
    pub unit: &'a Unit<'t, 'c>,
    pub catalog: &'a Catalog,
    pub claim: Option<&'a Claim>,
    /// A page leaves its own audit entries, not one for each edge.
    pub audited: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    Caller,
    /// Whether the source goes to the bin with a binned host is judged once every listed edge
    /// stands, so listing order decides nothing.
    Inline,
    /// Held to the writer's grants and every rule but the property schema: the edge stands as
    /// stored, and each digest it names keeps the standing it has on the edge `seq`.
    Copy(i64),
    /// Written whatever the writer's edge grants.
    Link,
}

pub struct Create {
    pub id: Option<String>,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub properties: Map<String, Value>,
    pub source_version: Option<i64>,
}

pub struct Update {
    pub id: String,
    pub version: i64,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
    pub properties: Option<Map<String, Value>>,
}

pub struct Delete {
    pub id: String,
    pub source_version: Option<i64>,
}

pub enum Op {
    Create(Create),
    Update(Update),
    Delete(Delete),
}

pub enum Wrote {
    Created(Edge),
    /// A create repeating an edge that stands, written by nothing.
    Repeated(Edge),
    Updated(Edge),
    Deleted(Edge),
}

impl Wrote {
    pub fn edge(&self) -> &Edge {
        match self {
            Wrote::Created(edge)
            | Wrote::Repeated(edge)
            | Wrote::Updated(edge)
            | Wrote::Deleted(edge) => edge,
        }
    }
}

pub(crate) fn source_missing(id: &str) -> Refusal {
    Refusal::new(
        Code::ItemNotFound,
        format!("Edge source item not found: {id}"),
    )
}

pub(crate) fn target_missing(id: &str) -> Refusal {
    Refusal::new(
        Code::ItemNotFound,
        format!("Edge target item not found: {id}"),
    )
}

fn unknown_kind(edge_type: &str) -> Refusal {
    Refusal::new(
        Code::EdgeTypeNotFound,
        format!("Unknown edge type: {edge_type}"),
    )
}

fn refused(refusal: Refused, code: Code) -> Refusal {
    let mut answer = Refusal::new(code, refusal.message);
    if let Value::Object(details) = refusal.details {
        for (name, value) in details {
            answer = answer.with_detail(&name, value);
        }
    }
    answer
}

fn constraint(refusal: Refused) -> Refusal {
    refused(refusal, Code::EdgeConstraintViolation)
}

fn at_path(path: &str, message: String) -> Refusal {
    Refusal::validation(message.clone())
        .with_detail("errors", json!([{ "path": path, "message": message }]))
}

/// An unregistered type's parent and roles are not known, so only a list open to every type takes it.
fn admitted(catalog: &Catalog, constraints: &[String], type_id: &str) -> bool {
    match lineage_of(catalog.types.rows(), type_id) {
        Some(lineage) => lineage_admits(&lineage, constraints),
        None => constraints.is_empty() || constraints.iter().any(|allowed| allowed == "*"),
    }
}

fn lineage_admits(lineage: &Lineage, constraints: &[String]) -> bool {
    lineage.admitted_by(constraints).unwrap_or(false)
}

struct Stands<'a> {
    kind: &'a EdgeType,
    source: &'a Item,
    target_id: &'a str,
    properties: &'a Map<String, Value>,
    moving: Option<&'a str>,
    by: By,
}

impl<'a, 't, 'c> Writing<'a, 't, 'c> {
    pub(crate) fn of(
        unit: &'a Unit<'t, 'c>,
        catalog: &'a Catalog,
        claim: Option<&'a Claim>,
    ) -> Writing<'a, 't, 'c> {
        Writing {
            unit,
            catalog,
            claim,
            audited: true,
        }
    }

    pub(super) fn page(unit: &'a Unit<'t, 'c>, catalog: &'a Catalog) -> Writing<'a, 't, 'c> {
        Writing {
            unit,
            catalog,
            claim: None,
            audited: false,
        }
    }
}

impl<'c> Writing<'_, '_, 'c> {
    fn caller(&self) -> &Caller {
        &self.unit.caller
    }

    fn tx(&self) -> &rusqlite::Transaction<'c> {
        self.unit.tx()
    }

    fn store(&self) -> Store<'_, 'c> {
        Store {
            tx: self.tx(),
            catalog: self.catalog,
        }
    }

    pub(super) fn note(&self, need: Need) {
        if let Some(claim) = self.claim {
            claim.note(need);
        }
    }

    pub(super) fn require_edge_write(&self, edge_type: &str) -> Result<()> {
        self.note(Need::Edge {
            name: edge_type.to_string(),
            write: true,
        });
        self.caller().require_edge(edge_type, Level::Write)
    }

    fn note_edge(&self, id: &str, source: &Item) {
        self.note(Need::EdgeSource {
            id: id.to_string(),
            type_id: source.type_id.clone(),
        });
    }

    pub(super) fn require_row_write(&self, row: &Item) -> Result<()> {
        self.note(Need::Item {
            id: row.id.clone(),
            type_id: row.type_id.clone(),
            write: true,
        });
        self.caller().require_type(&row.type_id, Level::Write)
    }

    pub(super) fn source_row(&self, id: &str) -> Result<Item> {
        self.note(Need::Reach);
        self.caller().require_reach()?;
        items::row(self.tx(), id)?
            .filter(|row| row.state != "trashed" && self.caller().may_read_type(&row.type_id))
            .ok_or_else(|| source_missing(id))
    }

    /// A row in the bin takes only a part arriving late.
    fn target_row(&self, kind: &EdgeType, id: &str) -> Result<Item> {
        let row = items::row(self.tx(), id)?
            .filter(|row| self.caller().may_read_type(&row.type_id))
            .ok_or_else(|| target_missing(id))?;
        let parts = OnDelete::of(Some(&kind.cascade_on_delete)) == OnDelete::WithHosts;
        if row.state == "trashed" && !parts {
            return Err(target_missing(id));
        }
        self.note(Need::Item {
            id: row.id.clone(),
            type_id: row.type_id.clone(),
            write: false,
        });
        Ok(row)
    }

    fn readable(&self, id: &str) -> Result<(Edge, Item)> {
        self.note(Need::Reach);
        self.caller().require_reach()?;
        let held = rows::by_id(self.tx(), id)?;
        let Some(edge) = held else {
            return Err(not_found(id));
        };
        let source = items::row(self.tx(), &edge.source_id)?
            .ok_or_else(|| Refusal::internal("an edge outlived its source"))?;
        if !self
            .caller()
            .may_read_edge(&edge.edge_type, &source.type_id)
        {
            return Err(not_found(id));
        }
        self.note_edge(id, &source);
        Ok((edge, source))
    }

    fn judge_properties(
        &self,
        kind: &EdgeType,
        properties: &Map<String, Value>,
        by: By,
    ) -> Result<()> {
        if kind.id == FOLDER_EDGE {
            return judge_folder(properties);
        }
        if !matches!(by, By::Caller | By::Inline) {
            return Ok(());
        }
        let fields: BTreeMap<&str, &Value> = kind
            .properties
            .iter()
            .map(|field| (field.name.as_str(), &field.definition))
            .collect();
        validation::properties(&fields, properties, true).map_err(|error| {
            if error.code == RuleCode::InvalidProperties {
                let named: Vec<String> = error
                    .fields
                    .iter()
                    .map(|field| format!("{}: {}", field.path, field.message))
                    .collect();
                let errors: Vec<Value> = error
                    .fields
                    .iter()
                    .map(|field| json!({ "field": field.path, "message": field.message }))
                    .collect();
                Refusal::new(
                    Code::InvalidProperties,
                    format!(
                        "Invalid properties for edge \"{}\": {}",
                        kind.id,
                        named.join("; ")
                    ),
                )
                .with_detail("errors", errors)
                .with_detail("edge_type", kind.id.as_str())
            } else {
                ruled(error)
            }
        })
    }

    /// Here an edge that cascades asks for write on its target's type, so no way of making or
    /// moving an edge can leave it out.
    fn judge(&self, edge: &Stands<'_>) -> Result<()> {
        let Stands {
            kind,
            source,
            target_id,
            ..
        } = *edge;
        if source.id == target_id {
            return Err(Refusal::new(
                Code::EdgeCycle,
                "Edge source and target must be different items",
            )
            .with_detail("edge_type", kind.id.as_str()));
        }
        self.judge_properties(kind, edge.properties, edge.by)?;
        let target = self.target_row(kind, target_id)?;
        if OnDelete::of(Some(&kind.cascade_on_delete)) == OnDelete::Cascade {
            self.note(Need::CascadeTarget {
                name: target.type_id.clone(),
            });
            self.caller().require_cascade_target(&target.type_id)?;
        }
        self.judge_ends(kind, source, &target)?;
        let proposed = Proposed {
            edge_type: &kind.id,
            source: &source.id,
            target: target_id,
            moving: edge.moving,
        };
        let store = self.store();
        if edges::duplicate(&store, &proposed)?.is_some() {
            return Err(duplicate(&kind.id, &source.id, target_id));
        }
        if let Some(end) = edges::full_end(&store, kind, &proposed)? {
            let at = match end {
                End::Source => &source.id,
                End::Target => target_id,
            };
            return Err(constraint(edges::refused_cardinality(kind, end, at)));
        }
        if kind.acyclic && edges::closes_cycle(&store, &proposed, |held| held == kind.id)? {
            return Err(Refusal::new(
                Code::EdgeCycle,
                format!("Edge \"{}\" would close a cycle", kind.id),
            )
            .with_detail("edge_type", kind.id.as_str())
            .with_detail("source_id", source.id.as_str())
            .with_detail("target_id", target_id));
        }
        let parts =
            |held: &str| marfa_rules::edges::Graph::on_delete(&store, held) == OnDelete::WithHosts;
        if parts(&kind.id) && edges::closes_cycle(&store, &proposed, parts)? {
            return Err(Refusal::new(
                Code::EdgeConstraintViolation,
                format!(
                    "Edge \"{}\" would make an item a part of its own part",
                    kind.id
                ),
            )
            .with_detail("edge_type", kind.id.as_str())
            .with_detail("source_id", source.id.as_str())
            .with_detail("target_id", target_id)
            .with_detail("constraint", "cycle"));
        }
        Ok(())
    }

    fn judge_ends(&self, kind: &EdgeType, source: &Item, target: &Item) -> Result<()> {
        if !admitted(self.catalog, &kind.source_type_constraints, &source.type_id) {
            return Err(constraint(edges::refused_end(
                kind,
                End::Source,
                &source.type_id,
            )));
        }
        if !admitted(self.catalog, &kind.target_type_constraints, &target.type_id) {
            return Err(constraint(edges::refused_end(
                kind,
                End::Target,
                &target.type_id,
            )));
        }
        if kind.id == FOLDER_EDGE && target.type_id == FOLDER_TYPE && target.state == "revoked" {
            return Err(Refusal::new(
                Code::EdgeConstraintViolation,
                format!("Folder {} is revoked and takes no new placement", target.id),
            )
            .with_detail("edge_type", kind.id.as_str())
            .with_detail("target_id", target.id.as_str())
            .with_detail("constraint", "revoked"));
        }
        if kind.flat && admitted(self.catalog, &kind.target_type_constraints, &source.type_id) {
            let mut nesting = edges::refused_nesting(&kind.id, &source.id, &source.type_id);
            nesting.message = format!(
                "Edge \"{}\" does not nest collections; use \"parent-of\" for hierarchy",
                kind.id
            );
            return Err(constraint(nesting));
        }
        Ok(())
    }

    fn create(&self, create: Create, by: By) -> Result<Wrote> {
        if matches!(by, By::Caller | By::Inline) {
            check_id("source_id", &create.source_id)?;
            check_id("target_id", &create.target_id)?;
            if let Some(id) = &create.id {
                check_id("id", id)?;
            }
        }
        let source = self.source_row(&create.source_id)?;
        if by != By::Link {
            self.require_row_write(&source)?;
            self.require_edge_write(&create.edge_type)?;
        }
        items::require_version(&source, create.source_version)?;
        let held = match &create.id {
            Some(id) => rows::by_id(self.tx(), id)?,
            None => None,
        };
        if let Some(held) = &held
            && self.may_read(held)?
        {
            repeat(
                held,
                &create.source_id,
                &create.target_id,
                &create.edge_type,
            )?;
            self.note_edge(&held.id, &source);
            return Ok(Wrote::Repeated(held.clone()));
        }
        let kind = self
            .catalog
            .edge_kind(&create.edge_type)
            .ok_or_else(|| unknown_kind(&create.edge_type))?;
        self.judge(&Stands {
            kind,
            source: &source,
            target_id: &create.target_id,
            properties: &create.properties,
            moving: None,
            by,
        })?;
        if let Some(held) = &held {
            return Err(Refusal::new(
                Code::IdReused,
                format!("Edge id {} already names a different edge", held.id),
            )
            .with_detail("existing_id", held.id.as_str()));
        }
        let inherited = match by {
            By::Copy(seq) => Some(references::held(self.tx(), Referencing::Edge(seq))?),
            By::Caller | By::Inline | By::Link => None,
        };
        let decided = references::decide(
            self.tx(),
            self.caller(),
            None,
            &create.properties,
            Naming {
                inherited: inherited.as_ref(),
                ..Naming::default()
            },
        )?;
        let minted = Uuid::now_v7().to_string();
        let edge = rows::insert(
            self.tx(),
            &NewEdge {
                id: create.id.as_deref().unwrap_or(&minted),
                source_id: &source.id,
                target_id: &create.target_id,
                edge_type: &create.edge_type,
                properties: &js::canonical(&create.properties),
                at: &self.unit.at,
            },
        )?;
        decided.apply(self.tx(), Referencing::Edge(edge.seq))?;
        announce(self.unit, "edge.created", &edge, &source, None)?;
        self.record(
            "edge.create",
            &edge.id,
            json!({
                "edge_type": edge.edge_type,
                "source_id": edge.source_id,
                "target_id": edge.target_id,
            }),
        )?;
        if matches!(by, By::Caller | By::Link) {
            self.settle(kind, &source, &edge.target_id)?;
        }
        self.note_edge(&edge.id, &source);
        Ok(Wrote::Created(edge))
    }

    pub(super) fn may_read(&self, edge: &Edge) -> Result<bool> {
        Ok(items::type_of(self.tx(), &edge.source_id)?
            .is_some_and(|source| self.caller().may_read_edge(&edge.edge_type, &source)))
    }

    fn record(&self, action: &str, id: &str, details: Value) -> Result<()> {
        if self.audited {
            self.unit.audit_also(action, "edge", id, Some(details))?;
        }
        Ok(())
    }

    fn settle(&self, kind: &EdgeType, source: &Item, target_id: &str) -> Result<()> {
        if OnDelete::of(Some(&kind.cascade_on_delete)) != OnDelete::WithHosts {
            return Ok(());
        }
        items::settle_late_part(self.unit, self.catalog, &source.id, target_id)
    }

    fn update(&self, update: Update) -> Result<Wrote> {
        let (edge, source) = self.readable(&update.id)?;
        self.require_row_write(&source)?;
        self.require_edge_write(&edge.edge_type)?;
        if update.version != edge.version {
            return Err(stale(&edge, update.version)?);
        }
        let new_source = update.source_id.filter(|id| *id != edge.source_id);
        let new_target = update.target_id.filter(|id| *id != edge.target_id);
        if let Some(id) = &new_source {
            check_id("source_id", id)?;
        }
        if let Some(id) = &new_target {
            check_id("target_id", id)?;
        }
        if new_source.is_some() && new_target.is_some() {
            return Err(at_path(
                "source_id",
                "An update moves one end of an edge at a time; delete it and create the edge wanted"
                    .to_string(),
            ));
        }
        let kind = self.catalog.edge_kind(&edge.edge_type);
        let moved = new_source.is_some() || new_target.is_some();
        if moved {
            let kind = kind.ok_or_else(|| unknown_kind(&edge.edge_type))?;
            let (field, kept) = if new_source.is_some() {
                ("source_id", End::Target)
            } else {
                ("target_id", End::Source)
            };
            if !kind.one_at(kept) {
                return Err(at_path(
                    field,
                    format!(
                        "Edge \"{}\" is {}, so the end that stays can hold more than this edge and there is none to replace; create the edge wanted and delete this one",
                        kind.id, kind.cardinality
                    ),
                ));
            }
        }
        let mut stands = source;
        if let Some(id) = &new_source {
            stands = self.source_row(id)?;
            self.require_row_write(&stands)?;
        }
        let target_id = new_target.as_deref().unwrap_or(&edge.target_id).to_string();
        if let (true, Some(kind)) = (moved, kind) {
            if stands.state == "trashed" {
                return Err(source_missing(&stands.id));
            }
            self.target_row(kind, &target_id)?;
        } else if update.properties.is_none() {
            return Err(Refusal::new(
                Code::MissingRequiredField,
                "properties is required where no end moves",
            )
            .with_detail("field", "properties"));
        }
        let mut properties = items::parsed(&edge.properties)?;
        properties.extend(update.properties.unwrap_or_default());
        match kind {
            Some(kind) if moved => self.judge(&Stands {
                kind,
                source: &stands,
                target_id: &target_id,
                properties: &properties,
                moving: Some(&edge.id),
                by: By::Caller,
            })?,
            Some(kind) => self.judge_properties(kind, &properties, By::Caller)?,
            None => {}
        }
        let decided = references::decide(
            self.tx(),
            self.caller(),
            Some(Referencing::Edge(edge.seq)),
            &properties,
            Naming::default(),
        )?;
        let written = rows::advance(
            self.tx(),
            &edge,
            &Landed {
                source_id: &stands.id,
                target_id: &target_id,
                properties: &js::canonical(&properties),
                at: &self.unit.at,
            },
        )?;
        decided.apply(self.tx(), Referencing::Edge(written.seq))?;
        announce(self.unit, "edge.updated", &written, &stands, None)?;
        let details = if moved {
            json!({
                "edge_type": written.edge_type,
                "source_id": written.source_id,
                "target_id": written.target_id,
            })
        } else {
            json!({ "edge_type": written.edge_type })
        };
        self.record("edge.update", &written.id, details)?;
        if let (true, Some(kind)) = (moved, kind) {
            self.settle(kind, &stands, &written.target_id)?;
        }
        Ok(Wrote::Updated(written))
    }

    fn delete(&self, delete: Delete) -> Result<Wrote> {
        let (edge, source) = self.readable(&delete.id)?;
        self.require_row_write(&source)?;
        self.require_edge_write(&edge.edge_type)?;
        items::require_version(&source, delete.source_version)?;
        rows::delete(self.tx(), &edge)?;
        announce(self.unit, "edge.deleted", &edge, &source, None)?;
        self.record(
            "edge.delete",
            &edge.id,
            json!({ "edge_type": edge.edge_type }),
        )?;
        Ok(Wrote::Deleted(edge))
    }
}

fn check_id(field: &str, id: &str) -> Result<()> {
    validation::id(field, id).map_err(ruled)
}

pub(super) fn check_entry_ids(entry: &super::bulk::Entry) -> Result<()> {
    check_id("source_id", &entry.source_id)?;
    check_id("target_id", &entry.target_id)?;
    match &entry.id {
        Some(id) => check_id("id", id),
        None => Ok(()),
    }
}

fn duplicate(edge_type: &str, source_id: &str, target_id: &str) -> Refusal {
    Refusal::new(
        Code::EdgeConstraintViolation,
        format!("Edge \"{edge_type}\" already exists between these items"),
    )
    .with_detail("edge_type", edge_type)
    .with_detail("source_id", source_id)
    .with_detail("target_id", target_id)
    .with_detail("constraint", "duplicate")
}

fn stale(edge: &Edge, named: i64) -> Result<Refusal> {
    Ok(Refusal::new(
        Code::VersionConflict,
        format!(
            "Version {named} is stale; the edge is now at version {}. Re-apply the change over \
             the edge returned here and send again.",
            edge.version
        ),
    )
    .with_member("current", edge.value()?))
}

pub(super) fn repeat(held: &Edge, source: &str, target: &str, edge_type: &str) -> Result<()> {
    let mut differs = Vec::new();
    if held.source_id != source {
        differs.push("source_id");
    }
    if held.target_id != target {
        differs.push("target_id");
    }
    if held.edge_type != edge_type {
        differs.push("edge_type");
    }
    let Some((last, others)) = differs.split_last() else {
        return Ok(());
    };
    let named = if others.is_empty() {
        (*last).to_string()
    } else {
        format!("{} and {last}", others.join(", "))
    };
    Err(Refusal::new(
        Code::IdReused,
        format!(
            "Edge id {} already names an edge with a different {named}",
            held.id
        ),
    )
    .with_detail("existing_id", held.id.as_str())
    .with_detail("differs", differs))
}

fn judge_folder(properties: &Map<String, Value>) -> Result<()> {
    if let Some(other) = properties.keys().find(|name| *name != FOLDER_PATH) {
        return Err(at_path(
            &format!("properties.{other}"),
            format!("Edge \"{FOLDER_EDGE}\" declares no property \"{other}\""),
        ));
    }
    let path = format!("properties.{FOLDER_PATH}");
    let text = properties.get(FOLDER_PATH).and_then(Value::as_str);
    let Some(text) = text.filter(|text| {
        let units = text.encode_utf16().count();
        (1..=MAX_FOLDER_PATH).contains(&units)
    }) else {
        return Err(at_path(
            &path,
            format!(
                "Edge \"{FOLDER_EDGE}\" takes a \"{FOLDER_PATH}\" of 1 to {MAX_FOLDER_PATH} characters"
            ),
        ));
    };
    if edges::depth_inside_folder(text).is_none_or(|depth| depth == 0) {
        return Err(at_path(
            &path,
            format!(
                "\"{text}\" is not a file inside the folder: write a path relative to its root, with \"/\" between names and no \"..\" name"
            ),
        ));
    }
    Ok(())
}

/// With a `claim`, the answer is recorded under it in the same transaction.
pub async fn run(app: &App, caller: &Caller, claim: Option<Claim>, op: Op) -> Result<Done> {
    let cache = app.catalog_handle();
    let action = match op {
        Op::Create(_) => "edge.create",
        Op::Update(_) => "edge.update",
        Op::Delete(_) => "edge.delete",
    };
    app.write(caller, action, move |unit| {
        let catalog = catalog::current(&cache, unit.tx(), Reading::Pending)?;
        let writing = Writing::of(unit, &catalog, claim.as_ref());
        let done = match write(&writing, op, By::Caller)? {
            Wrote::Created(edge) => Done {
                status: 201,
                body: format!("{{\"edge\":{}}}", edge.answered()?),
            },
            Wrote::Repeated(edge) => Done {
                status: 200,
                body: format!("{{\"edge\":{},\"acknowledged\":true}}", edge.answered()?),
            },
            Wrote::Updated(edge) => Done {
                status: 200,
                body: format!("{{\"edge\":{}}}", edge.answered()?),
            },
            Wrote::Deleted(_) => Done {
                status: 200,
                body: "{\"ok\":true}".to_string(),
            },
        };
        if let Some(claim) = &claim {
            idempotency::complete(unit, claim, done.status, done.body.as_bytes())?;
        }
        Ok(done)
    })
    .await
}

pub fn write(writing: &Writing<'_, '_, '_>, op: Op, by: By) -> Result<Wrote> {
    match op {
        Op::Create(create) => writing.create(create, by),
        Op::Update(update) => writing.update(update),
        Op::Delete(delete) => writing.delete(delete),
    }
}

/// `purged_with` names the purge that took the edge.
pub(crate) fn announce(
    unit: &Unit<'_, '_>,
    event_type: &'static str,
    edge: &Edge,
    source: &Item,
    purged_with: Option<&str>,
) -> Result<()> {
    let also = purged_with.map_or_else(String::new, |id| {
        format!(",\"purged_with\":{}", Value::from(id))
    });
    unit.announce(&Event {
        event_type,
        item_id: &edge.source_id,
        type_id: &source.type_id,
        source: &source.source,
        payload: format!(
            "{{\"event_type\":\"{event_type}\",\"edge\":{},\"source_type\":{}{also}}}",
            edge.answered()?,
            Value::from(source.type_id.as_str())
        ),
    })
}

pub(crate) fn purge_edge(
    unit: &Unit<'_, '_>,
    edge: &Edge,
    source: &Item,
    purged_with: &str,
) -> Result<()> {
    rows::delete(unit.tx(), edge)?;
    announce(unit, "edge.deleted", edge, source, Some(purged_with))
}

pub(crate) fn touching(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<Vec<Edge>> {
    rows::touching(tx, id)
}

pub type Inline = Vec<(String, Vec<String>)>;

fn once(targets: &[String]) -> Vec<&String> {
    let mut seen = HashSet::new();
    targets
        .iter()
        .filter(|target| seen.insert(target.as_str()))
        .collect()
}

pub(crate) fn inline_gates(writing: &Writing<'_, '_, '_>, inline: &Inline) -> Result<()> {
    for (edge_type, _) in inline {
        writing.require_edge_write(edge_type)?;
    }
    for (edge_type, targets) in inline {
        for target in targets {
            if validation::id("target_id", target).is_err() {
                return Err(Refusal::new(
                    Code::InvalidId,
                    format!("Invalid target id in edges.{edge_type}: {target}"),
                ));
            }
        }
    }
    for (_, targets) in inline {
        for target in targets {
            let readable = items::row(writing.tx(), target)?
                .is_some_and(|row| writing.caller().may_read_type(&row.type_id));
            if !readable {
                return Err(target_missing(target));
            }
        }
    }
    Ok(())
}

/// The edges `inline` replaces are judged only after the old ones go, so a replaced edge counts for
/// nothing against them.
pub(crate) fn inline_replace(
    writing: &Writing<'_, '_, '_>,
    source: &Item,
    inline: &Inline,
) -> Result<()> {
    let mut wanted = Vec::new();
    for (edge_type, targets) in inline {
        let held = rows::leaving(writing.tx(), &source.id, edge_type)?;
        for edge in &held {
            if !targets.contains(&edge.target_id) {
                writing.delete(Delete {
                    id: edge.id.clone(),
                    source_version: None,
                })?;
            }
        }
        for target in once(targets) {
            if !held.iter().any(|edge| edge.target_id == *target) {
                wanted.push((edge_type, target));
            }
        }
    }
    for (edge_type, target) in &wanted {
        writing.create(
            Create {
                id: None,
                source_id: source.id.clone(),
                target_id: (*target).clone(),
                edge_type: (*edge_type).clone(),
                properties: Map::new(),
                source_version: None,
            },
            By::Inline,
        )?;
    }
    for (edge_type, target) in wanted {
        let binned = items::row(writing.tx(), &source.id)?.is_none_or(|row| row.state == "trashed");
        if binned {
            break;
        }
        if let Some(kind) = writing.catalog.edge_kind(edge_type) {
            writing.settle(kind, source, target)?;
        }
    }
    Ok(())
}

/// The edges `inline` replaces are not held, and an edge of a type no longer registered has no rule
/// to meet.
pub(crate) fn judge_retype(
    writing: &Writing<'_, '_, '_>,
    item: &Item,
    next_type: &str,
    inline: &[(String, Vec<String>)],
) -> Result<()> {
    let id = &item.id;
    for edge in rows::touching(writing.tx(), id)? {
        let Some(kind) = writing.catalog.edge_kind(&edge.edge_type) else {
            continue;
        };
        let replaced = edge.source_id == *id
            && inline.iter().any(|(edge_type, targets)| {
                *edge_type == edge.edge_type && !targets.contains(&edge.target_id)
            });
        if replaced {
            continue;
        }
        let name = &kind.id;
        if edge.source_id == *id
            && !admitted(writing.catalog, &kind.source_type_constraints, next_type)
        {
            let refusal = edges::refused_end(kind, End::Source, next_type);
            return Err(constraint(Refused {
                message: format!(
                    "Item {id} can't become \"{next_type}\": {}",
                    lowered(&refusal)
                ),
                details: refusal.details,
            }));
        }
        if edge.target_id == *id
            && !admitted(writing.catalog, &kind.target_type_constraints, next_type)
        {
            let refusal = edges::refused_end(kind, End::Target, next_type);
            return Err(constraint(Refused {
                message: format!(
                    "Item {id} can't become \"{next_type}\": {}",
                    lowered(&refusal)
                ),
                details: refusal.details,
            }));
        }
        if edge.source_id == *id
            && kind.flat
            && admitted(writing.catalog, &kind.target_type_constraints, next_type)
        {
            let refusal = edges::refused_nesting(name, id, next_type);
            return Err(constraint(Refused {
                message: format!(
                    "Item {id} can't become \"{next_type}\": edge \"{name}\" does not nest collections"
                ),
                details: refusal.details,
            }));
        }
    }
    Ok(())
}

fn lowered(refusal: &Refused) -> String {
    let mut message = refusal.message.clone();
    if let Some(first) = message.get_mut(0..1) {
        first.make_ascii_lowercase();
    }
    message
}

/// An edge the copy may not hold is left out without a word, so a repeat of the write owes nothing
/// to what was left out.
pub(crate) fn copy_edges(
    writing: &Writing<'_, '_, '_>,
    original: &Item,
    copy: &Item,
) -> Result<()> {
    let writing = &Writing::of(writing.unit, writing.catalog, None);
    let store = writing.store();
    for edge in rows::touching(writing.tx(), &original.id)? {
        let Some(kind) = writing.catalog.edge_kind(&edge.edge_type) else {
            continue;
        };
        let outbound = edge.source_id == original.id;
        let on_delete = OnDelete::of(Some(&kind.cascade_on_delete));
        let written = match kind.written_at.end() {
            Some(end) => end == if outbound { End::Source } else { End::Target },
            None => outbound,
        };
        let other = if outbound {
            &edge.target_id
        } else {
            &edge.source_id
        };
        if !written
            || marfa_rules::edges::Graph::in_bin(&store, other)?
            || on_delete == OnDelete::Block
            || (outbound && on_delete == OnDelete::Cascade)
            || (outbound && kind.id == DERIVED_FROM)
        {
            continue;
        }
        let (source_id, target_id) = if outbound {
            (copy.id.clone(), edge.target_id.clone())
        } else {
            (edge.source_id.clone(), copy.id.clone())
        };
        let made = writing.create(
            Create {
                id: None,
                source_id,
                target_id,
                edge_type: edge.edge_type.clone(),
                properties: items::parsed(&edge.properties)?,
                source_version: None,
            },
            By::Copy(edge.seq),
        );
        match made {
            Err(refusal) if refusal.code == Code::InternalError => return Err(refusal),
            _ => {}
        }
    }
    writing.create(
        Create {
            id: None,
            source_id: copy.id.clone(),
            target_id: original.id.clone(),
            edge_type: DERIVED_FROM.to_string(),
            properties: Map::new(),
            source_version: None,
        },
        By::Link,
    )?;
    Ok(())
}

const DERIVED_FROM: &str = "derived-from";
