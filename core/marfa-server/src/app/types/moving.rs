//! Moving a type's items to another type, and the folder, view and webhook settings that name it.

use arc_swap::ArcSwap;
use marfa_rules::type_move::{self, Holder, Reason};
use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::write::subtypes_of;
use super::{check_id, not_found};
use crate::app::access::{Caller, Level, Setting};
use crate::app::catalog::{self, Catalog, Snapshot};
use crate::app::idempotency::{self, Claim, Need};
use crate::app::items::write::{Change, apply_server_own};
use crate::app::jobs::{self, Action, Queued};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::app::{App, items, keys, oauth, query, webhooks};

const FOLDER_TYPE: &str = "system.folder";

#[derive(Debug)]
pub struct Move {
    pub to: String,
    pub properties: Option<Map<String, Value>>,
    pub dry_run: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Why {
    NotPermitted,
    FilterTerm,
    PlacementConflict,
    Subtypes,
}

impl Why {
    const fn word(self) -> &'static str {
        match self {
            Why::NotPermitted => "not_permitted",
            Why::FilterTerm => "filter_term",
            Why::PlacementConflict => "placement_conflict",
            Why::Subtypes => "subtypes",
        }
    }

    const fn message(self) -> &'static str {
        match self {
            Why::NotPermitted => {
                "This credential can't change this setting. Change it with a credential that can, then move."
            }
            Why::FilterTerm => {
                "Its filter tests the type in a way a move can't rewrite. Change the filter, then move."
            }
            Why::PlacementConflict => {
                "It places the two types in different directories. Give them one directory, then move."
            }
            Why::Subtypes => {
                "Its type filter names a type with subtypes, and one filter can't name both types. Change the filter, then move."
            }
        }
    }
}

/// One field of a folder, view or webhook that names the type.
#[derive(Clone, Debug)]
struct Named {
    kind: &'static str,
    id: String,
    shown: bool,
    field: &'static str,
    why: Option<Why>,
}

impl Named {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("kind".into(), json!(self.kind));
        if self.shown {
            out.insert("id".into(), json!(self.id));
        }
        out.insert("field".into(), json!(self.field));
        if let Some(why) = self.why {
            out.insert("reason".into(), json!(why.word()));
            out.insert("message".into(), json!(why.message()));
        }
        Value::Object(out)
    }
}

enum Rewrite {
    Settings { id: String, settings: Map<String, Value> },
    Webhook { id: String },
}

struct Plan {
    named: Vec<Named>,
    rewrites: Vec<Rewrite>,
}

impl Plan {
    fn blocked(&self) -> bool {
        self.named.iter().any(|named| named.why.is_some())
    }

    fn settings(&self) -> Value {
        Value::Array(self.named.iter().map(Named::to_json).collect())
    }

    fn refusal(&self, from: &str) -> Refusal {
        Refusal::new(
            Code::TypeMoveBlocked,
            format!(
                "A folder, view or webhook names \"{from}\" in a way the move can't rewrite. Change each setting listed, then move."
            ),
        )
        .with_detail(
            "settings",
            Value::Array(
                self.named
                    .iter()
                    .filter(|named| named.why.is_some())
                    .map(Named::to_json)
                    .collect(),
            ),
        )
    }
}

fn holder_of(type_id: &str) -> (Holder, &'static str) {
    if type_id == FOLDER_TYPE {
        (Holder::Folder, "folder")
    } else {
        (Holder::View, "view")
    }
}

fn setting_of(holder: Holder) -> Setting<'static> {
    match holder {
        Holder::Folder => Setting::Folder,
        Holder::View => Setting::View,
    }
}

fn settings_of(item: &items::Item) -> Result<Map<String, Value>> {
    match serde_json::from_str(&item.properties) {
        Ok(Value::Object(settings)) => Ok(settings),
        _ => Err(Refusal::internal("a folder's or view's settings did not read")),
    }
}

/// Every setting that names `from`, what stops the move from rewriting each, and the rewrites.
fn plan(tx: &Transaction<'_>, caller: &Caller, from: &str, to: &str) -> Result<Plan> {
    let subtypes = !subtypes_of(tx, from)?.is_empty();
    let mut plan = Plan {
        named: Vec::new(),
        rewrites: Vec::new(),
    };
    for item in items::settings(tx)? {
        let (holder, kind) = holder_of(&item.type_id);
        let moved = type_move::settings(holder, &settings_of(&item)?, from, to, subtypes);
        if moved.named.is_empty() {
            continue;
        }
        let setting = setting_of(holder);
        let changes = caller.may_change_setting(setting);
        let shown = caller.may_read_setting(setting);
        for named in &moved.named {
            let why = match named.reason {
                _ if !changes => Some(Why::NotPermitted),
                Some(Reason::FilterTerm) => Some(Why::FilterTerm),
                Some(Reason::PlacementConflict) => Some(Why::PlacementConflict),
                None => None,
            };
            plan.named.push(Named {
                kind,
                id: item.id.clone(),
                shown,
                field: named.field,
                why,
            });
        }
        plan.rewrites.push(Rewrite::Settings {
            id: item.id,
            settings: moved.settings,
        });
    }
    for hook in webhooks::naming_type(tx, from)? {
        let setting = Setting::Webhook(&hook.maker);
        let why = if !caller.may_change_setting(setting) {
            Some(Why::NotPermitted)
        } else if subtypes {
            Some(Why::Subtypes)
        } else {
            None
        };
        plan.named.push(Named {
            kind: "webhook",
            id: hook.id.clone(),
            shown: caller.may_read_setting(setting),
            field: "type_filter",
            why,
        });
        plan.rewrites.push(Rewrite::Webhook { id: hook.id });
    }
    Ok(plan)
}

/// The settings that name `type_id` as a move would rewrite them, for a delete to refuse.
pub(super) fn naming(tx: &Transaction<'_>, caller: &Caller, type_id: &str) -> Result<Value> {
    let mut named = Vec::new();
    for item in items::settings(tx)? {
        let (holder, kind) = holder_of(&item.type_id);
        let shown = caller.may_read_setting(setting_of(holder));
        for field in type_move::names(holder, &settings_of(&item)?, type_id) {
            named.push(Named {
                kind,
                id: item.id.clone(),
                shown,
                field,
                why: None,
            });
        }
    }
    for hook in webhooks::naming_type(tx, type_id)? {
        named.push(Named {
            kind: "webhook",
            shown: caller.may_read_setting(Setting::Webhook(&hook.maker)),
            id: hook.id,
            field: "type_filter",
            why: None,
        });
    }
    Ok(Value::Array(named.iter().map(Named::to_json).collect()))
}

/// The keys and apps whose type map names `from`, as far as the caller may list them.
fn grants(tx: &Transaction<'_>, caller: &Caller, from: &str, at: &str) -> Result<Value> {
    let mut out = Vec::new();
    if caller.lists_key_grants() {
        for (id, label) in keys::naming_type(tx, from, at)? {
            out.push(json!({ "kind": "key", "id": id, "label": label }));
        }
    }
    if caller.lists_app_grants() {
        for client in oauth::store::clients_naming_type(tx, from)? {
            out.push(json!({ "kind": "app", "id": client }));
        }
    }
    Ok(Value::Array(out))
}

/// Refuses in the order a caller can act on: the source type, then the target, then reach.
fn judge(caller: &Caller, catalog: &Catalog, from: &str, to: &str) -> Result<()> {
    caller.require_reach()?;
    if !catalog.holds(from) {
        return Err(not_found(from));
    }
    if Catalog::ships(from) {
        return Err(Refusal::new(
            Code::CoreTypeImmutable,
            format!("Marfa ships \"{from}\", and its items stay in it."),
        ));
    }
    check_id(to, "to")?;
    if to == from {
        return Err(Refusal::validation("to names the type the items are in.")
            .with_detail("field", "to"));
    }
    if !catalog.holds(to) {
        return Err(
            Refusal::new(Code::UnknownType, format!("Unknown type: {to}")).with_detail("type", to)
        );
    }
    caller.require_type(from, Level::Write)?;
    caller.require_type(to, Level::Write)
}

/// `POST /types/{id}/move`: answers a dry run, or queues the move.
pub async fn move_type(
    app: &App,
    caller: &Caller,
    from: String,
    asked: Move,
    claim: Option<Claim>,
) -> Result<(u16, String)> {
    let cache = app.catalog_handle();
    if asked.dry_run {
        let at = app.clock.stamp();
        let named = [from.clone(), asked.to.clone()];
        let answer = crate::app::items::reading(app, caller, move |read| {
            let (caller, tx) = (&read.caller, read.tx);
            judge(caller, &read.catalog, &from, &asked.to)?;
            let plan = plan(tx, caller, &from, &asked.to)?;
            if plan.blocked() {
                return Err(plan.refusal(&from));
            }
            let ids = query::of_exact_type(tx, caller, &read.catalog, &from)?;
            Ok(json!({
                "dry_run": true,
                "from": from,
                "to": asked.to,
                "matched": ids.len(),
                "ids": ids,
                "settings": plan.settings(),
                "grants": grants(tx, caller, &from, &at)?,
            }))
        })
        .await?;
        let body = answer.to_string();
        let Some(claim) = claim else {
            return Ok((200, body));
        };
        let kept = app
            .write(caller, "items.bulk_action", move |unit| {
                claim.note(Need::Reach);
                for name in named {
                    claim.note(Need::Type { name, write: true });
                }
                idempotency::complete(unit, &claim, 200, body.as_bytes())?;
                Ok(body)
            })
            .await?;
        return Ok((200, kept));
    }
    let answered = app
        .write(caller, "items.bulk_action", move |unit| {
            let tx = unit.tx();
            let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
            judge(&unit.caller, &catalog, &from, &asked.to)?;
            let plan = plan(tx, &unit.caller, &from, &asked.to)?;
            if plan.blocked() {
                return Err(plan.refusal(&from));
            }
            let ids = query::of_exact_type(tx, &unit.caller, &catalog, &from)?;
            if let Some(claim) = &claim {
                claim.note(Need::Reach);
                for name in [&from, &asked.to] {
                    claim.note(Need::Type {
                        name: name.clone(),
                        write: true,
                    });
                }
            }
            let queued = Queued {
                action: Action::TypeMove {
                    from,
                    to: asked.to,
                    properties: asked.properties,
                },
                fanout: false,
            };
            let body = jobs::enqueue(unit, &queued, &ids)?;
            if let Some(claim) = &claim {
                idempotency::complete(unit, claim, 202, body.as_bytes())?;
            }
            Ok(body)
        })
        .await?;
    app.jobs.wake();
    Ok((202, answered))
}

/// What a finished move leaves of its type, and the settings it rewrites once none remains.
pub(crate) fn finish_move(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    from: &str,
    to: &str,
    result: &mut Map<String, Value>,
) -> Result<()> {
    let tx = unit.tx();
    let catalog = catalog::current(cache, tx, Snapshot::Pending)?;
    let remaining = query::count_of_exact_type(tx, &unit.caller, &catalog, from)?;
    let hidden = items::count_of_type(tx, from)? > remaining;
    let plan = plan(tx, &unit.caller, from, to)?;
    let rewritten = remaining == 0 && !hidden && !plan.blocked();
    if rewritten {
        for rewrite in &plan.rewrites {
            match rewrite {
                Rewrite::Settings { id, settings } => {
                    apply_server_own(
                        unit,
                        cache,
                        Change::Retarget {
                            id: id.clone(),
                            settings: settings.clone(),
                        },
                    )?;
                }
                Rewrite::Webhook { id } => webhooks::retarget(unit, &catalog.rules, id, to)?,
            }
        }
    }
    result.insert("settings".into(), plan.settings());
    result.insert("remaining".into(), json!(remaining));
    result.insert("remaining_hidden".into(), json!(hidden));
    result.insert("settings_rewritten".into(), json!(rewritten));
    Ok(())
}
