//! Validates tool arguments and dispatches with the caller's credential.

mod create;
mod delete;
mod find;
mod get;
mod update;

use std::sync::Arc;

use marfa_rules::validation;
use serde_json::{Map, Value};

use super::results::{Outcome, Stop, check};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::Refusal;

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

fn definitions() -> Vec<Definition> {
    vec![
        find::definition(),
        get::definition(),
        create::definition(),
        update::definition(),
        delete::definition(),
    ]
}

/// Write tools require write access to a type.
fn offered(caller: &Caller, name: &str) -> bool {
    if !caller.reaches_a_type() {
        return false;
    }
    matches!(name, find::NAME | get::NAME) || caller.writes_a_type()
}

/// Whether the credential is offered any tool, which is whether the server declares them.
pub fn any_offered(caller: &Caller) -> bool {
    caller.reaches_a_type()
}

pub fn listing(caller: &Caller) -> Vec<Value> {
    definitions()
        .into_iter()
        .filter(|tool| offered(caller, tool.name))
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
    name: &str,
    arguments: Map<String, Value>,
) -> Option<Outcome> {
    let tool = definitions()
        .into_iter()
        .find(|tool| tool.name == name && offered(caller, tool.name))?;
    let arguments = Value::Object(arguments);
    if let Err(message) = check(&tool.input, &arguments, "") {
        return Some(Err(Stop::invalid(message)));
    }
    let Value::Object(arguments) = arguments else {
        return None;
    };
    Some(run(app, caller, tool.name, arguments).await)
}

async fn run(
    app: &Arc<App>,
    caller: &Caller,
    name: &str,
    arguments: Map<String, Value>,
) -> Outcome {
    caller.require_reach()?;
    match name {
        find::NAME => find::run(app, caller, arguments).await,
        get::NAME => get::run(app, caller, arguments).await,
        create::NAME => create::run(app, caller, arguments).await,
        update::NAME => update::run(app, caller, arguments).await,
        delete::NAME => delete::run(app, caller, arguments).await,
        _ => Err(Stop::invalid("No tool has this name.")),
    }
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
