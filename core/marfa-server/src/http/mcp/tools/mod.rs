//! Validates tool arguments and dispatches with the caller's credential.

mod audit;
mod bulk;
mod create;
mod delete;
mod docs;
mod find;
mod get;
mod health;
mod keys;
mod moving;
mod overview;
mod revoke;
mod sources;
mod types;
mod update;
mod views;
mod webhooks;

use std::sync::Arc;

use chrono::{DateTime, SecondsFormat};
use marfa_rules::validation;
use serde_json::{Map, Value};

use super::results::{Outcome, Stop, check};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::Refusal;

/// The endpoint that serves a tool: `/mcp` serves the items group at every endpoint.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Items,
    Schema,
    Admin,
}

impl Group {
    pub const fn path(self) -> &'static str {
        match self {
            Group::Items => "/mcp",
            Group::Schema => "/mcp/schema",
            Group::Admin => "/mcp/admin",
        }
    }
}

/// What a client is told about one tool.
struct Definition {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    input: Value,
    output: Value,
    annotations: Value,
    meta: Option<Value>,
}

fn definitions() -> Vec<(Group, Definition)> {
    vec![
        (Group::Items, overview::definition()),
        (Group::Items, find::definition()),
        (Group::Items, get::definition()),
        (Group::Items, create::definition()),
        (Group::Items, update::definition()),
        (Group::Items, delete::definition()),
        (Group::Schema, types::definition()),
        (Group::Schema, views::definition()),
        (Group::Schema, bulk::definition()),
        (Group::Schema, moving::definition()),
        (Group::Schema, docs::definition()),
        (Group::Schema, sources::list_definition()),
        (Group::Schema, sources::name_definition()),
        (Group::Admin, health::definition()),
        (Group::Admin, audit::definition()),
        (Group::Admin, keys::list_definition()),
        (Group::Admin, keys::manage_definition()),
        (Group::Admin, revoke::definition()),
        (Group::Admin, webhooks::list_definition()),
        (Group::Admin, webhooks::manage_definition()),
    ]
}

/// Whether the tool reads or writes items, which a credential that reaches no type cannot do.
fn works_on_items(name: &str) -> bool {
    matches!(
        name,
        overview::NAME
            | find::NAME
            | get::NAME
            | create::NAME
            | update::NAME
            | delete::NAME
            | bulk::NAME
            | moving::NAME
    )
}

fn offered(caller: &Caller, name: &str) -> bool {
    if works_on_items(name) && !caller.reaches_a_type() {
        return false;
    }
    match name {
        overview::NAME | find::NAME | get::NAME => true,
        create::NAME | update::NAME | delete::NAME | bulk::NAME | moving::NAME => {
            caller.writes_a_type()
        }
        types::NAME => caller.may_save_types(),
        views::NAME => caller.writes_views(),
        docs::NAME | sources::LIST_NAME | sources::NAME_NAME => true,
        health::NAME => caller.may_read_health(),
        audit::NAME => caller.may_read_audit(),
        keys::LIST_NAME | keys::MANAGE_NAME | revoke::NAME => caller.may_use_key_door(),
        webhooks::LIST_NAME | webhooks::MANAGE_NAME => caller.may_manage_webhooks(),
        _ => false,
    }
}

fn served(group: Group, tool: Group) -> bool {
    tool == Group::Items || tool == group
}

/// Whether the credential is offered any tool, which is whether the server declares them.
pub fn any_offered(caller: &Caller, group: Group) -> bool {
    definitions()
        .iter()
        .any(|(home, tool)| served(group, *home) && offered(caller, tool.name))
}

pub fn listing(caller: &Caller, group: Group) -> Vec<Value> {
    definitions()
        .into_iter()
        .filter(|(home, tool)| served(group, *home) && offered(caller, tool.name))
        .map(|(_, tool)| tool)
        .map(|tool| {
            let mut listed = Map::new();
            listed.insert("name".into(), tool.name.into());
            listed.insert("title".into(), tool.title.into());
            listed.insert("description".into(), tool.description.into());
            listed.insert("inputSchema".into(), tool.input);
            listed.insert("outputSchema".into(), tool.output);
            listed.insert("annotations".into(), tool.annotations);
            if let Some(meta) = tool.meta {
                listed.insert("_meta".into(), meta);
            }
            Value::Object(listed)
        })
        .collect()
}

/// The answer to a call, or nothing where the credential is offered no such tool.
pub async fn call(
    app: &Arc<App>,
    caller: &Caller,
    group: Group,
    name: &str,
    arguments: Map<String, Value>,
    exact: Result<(), Refusal>,
) -> Option<Outcome> {
    let (_, tool) = definitions().into_iter().find(|(home, tool)| {
        tool.name == name && served(group, *home) && offered(caller, tool.name)
    })?;
    let arguments = Value::Object(arguments);
    if let Err(message) = check(&tool.input, &arguments, "") {
        return Some(Err(Stop::invalid(message)));
    }
    let Value::Object(arguments) = arguments else {
        return None;
    };
    Some(run(app, caller, tool.name, arguments, exact).await)
}

async fn run(
    app: &Arc<App>,
    caller: &Caller,
    name: &str,
    arguments: Map<String, Value>,
    exact: Result<(), Refusal>,
) -> Outcome {
    if works_on_items(name) {
        caller.require_reach()?;
    }
    if matches!(name, keys::LIST_NAME | keys::MANAGE_NAME | revoke::NAME)
        && let Some(seconds) = crate::http::keys::key_operation_wait(app, caller)
    {
        return Err(Stop::coded(
            "rate_limited",
            "Too many requests to the key operations; try again later.",
        )
        .with("retry_after_seconds", seconds));
    }
    match name {
        overview::NAME => overview::run(app, caller, arguments).await,
        find::NAME => find::run(app, caller, arguments).await,
        get::NAME => get::run(app, caller, arguments).await,
        create::NAME => create::run(app, caller, arguments, exact).await,
        update::NAME => update::run(app, caller, arguments, exact).await,
        delete::NAME => delete::run(app, caller, arguments).await,
        bulk::NAME => bulk::run(app, caller, arguments, exact).await,
        moving::NAME => moving::run(app, caller, arguments, exact).await,
        types::NAME => types::run(app, caller, arguments).await,
        views::NAME => views::run(app, caller, arguments).await,
        docs::NAME => docs::run(arguments),
        sources::LIST_NAME => sources::list(app, caller, arguments).await,
        sources::NAME_NAME => sources::name(app, caller, arguments).await,
        health::NAME => health::run(app, caller).await,
        audit::NAME => audit::run(app, caller, arguments).await,
        keys::LIST_NAME => keys::list(app, caller).await,
        keys::MANAGE_NAME => keys::manage(app, caller, arguments).await,
        revoke::NAME => revoke::run(app, caller, arguments).await,
        webhooks::LIST_NAME => webhooks::list(app, caller).await,
        webhooks::MANAGE_NAME => webhooks::manage(app, caller, arguments).await,
        _ => Err(Stop::invalid("No tool has this name.")),
    }
}

fn instant(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or(DateTime::<chrono::Utc>::MAX_UTC)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// An argument that must be a UUIDv7 item identifier.
fn item_id(value: &str) -> Result<(), Stop> {
    validation::id("id", value).map_err(|_| {
        Stop::coded(
            "validation_error",
            format!("{value} is not an ID: an ID is a UUIDv7."),
        )
    })
}

fn text(arguments: &Map<String, Value>, name: &str) -> Option<String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn texts(arguments: &Map<String, Value>, name: &str) -> Vec<String> {
    arguments
        .get(name)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The words an item's answer carries that a tool reads, from the application's JSON text.
fn parsed(text: &str) -> Result<Value, Stop> {
    serde_json::from_str(text)
        .map_err(|_| Stop::refused(Refusal::internal("an item answer did not read")))
}
