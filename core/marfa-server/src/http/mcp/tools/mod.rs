//! Validates tool arguments and dispatches with the caller's credential.

mod apps;
mod audit;
mod backups;
mod bulk;
mod connectors;
mod create;
mod delete;
mod docs;
mod files;
mod find;
mod get;
mod health;
mod keys;
mod maintain;
mod moving;
mod overview;
mod purge;
mod revoke;
mod rows;
mod settings;
mod sign_ins;
mod sources;
mod trash;
mod types;
mod update;
mod views;
mod webhooks;

use std::sync::Arc;

use marfa_rules::validation;
use serde_json::{Map, Value};

use super::results::{Outcome, Stop, check};
use crate::app::App;
use crate::app::access::{AdminTask, Caller};
use crate::app::refusal::Refusal;

/// An MCP endpoint; each serves the items tools as well as its own.
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

/// Where a tool lives: an admin tool names the task whose permissions open it.
#[derive(Clone, Copy)]
enum Home {
    Items,
    Schema,
    Admin(AdminTask),
}

fn definitions() -> Vec<(Home, Definition)> {
    use AdminTask as Task;
    vec![
        (Home::Items, overview::definition()),
        (Home::Items, find::definition()),
        (Home::Items, get::definition()),
        (Home::Items, rows::read_definition()),
        (Home::Items, create::definition()),
        (Home::Items, update::definition()),
        (Home::Items, rows::write_definition()),
        (Home::Items, delete::definition()),
        (Home::Schema, types::definition()),
        (Home::Schema, views::definition()),
        (Home::Schema, bulk::definition()),
        (Home::Schema, moving::definition()),
        (Home::Schema, docs::definition()),
        (Home::Schema, sources::list_definition()),
        (Home::Schema, sources::name_definition()),
        (Home::Admin(Task::Health), health::definition()),
        (Home::Admin(Task::Audit), audit::definition()),
        (Home::Admin(Task::Keys), keys::list_definition()),
        (Home::Admin(Task::Keys), keys::manage_definition()),
        (Home::Admin(Task::Keys), revoke::definition()),
        (Home::Admin(Task::Webhooks), webhooks::list_definition()),
        (Home::Admin(Task::Webhooks), webhooks::manage_definition()),
        (Home::Admin(Task::Settings), settings::read_definition()),
        (Home::Admin(Task::Settings), settings::change_definition()),
        (Home::Admin(Task::Trash), trash::definition()),
        (Home::Admin(Task::Trash), purge::definition()),
        (Home::Admin(Task::Apps), apps::list_definition()),
        (Home::Admin(Task::Apps), apps::narrow_definition()),
        (Home::Admin(Task::Backups), backups::list_definition()),
        (Home::Admin(Task::Backups), backups::take_definition()),
        (Home::Admin(Task::Maintain), maintain::definition()),
        (Home::Admin(Task::Connectors), connectors::list_definition()),
        (
            Home::Admin(Task::Connectors),
            connectors::endpoint_definition(),
        ),
        (Home::Admin(Task::Files), files::definition()),
        (Home::Admin(Task::SignIns), sign_ins::list_definition()),
        (Home::Admin(Task::SignIns), sign_ins::rename_definition()),
    ]
}

/// Whether the tool reads or writes items, which a credential that reaches no type cannot do.
fn works_on_items(name: &str) -> bool {
    matches!(
        name,
        overview::NAME
            | find::NAME
            | get::NAME
            | rows::READ_NAME
            | create::NAME
            | update::NAME
            | rows::WRITE_NAME
            | delete::NAME
            | bulk::NAME
            | moving::NAME
    )
}

fn offered(caller: &Caller, home: Home, name: &str) -> bool {
    if let Home::Admin(task) = home {
        return caller.may_do(task);
    }
    if works_on_items(name) && !caller.reaches_a_type() {
        return false;
    }
    match name {
        overview::NAME | find::NAME | get::NAME | rows::READ_NAME => true,
        create::NAME
        | update::NAME
        | rows::WRITE_NAME
        | delete::NAME
        | bulk::NAME
        | moving::NAME => caller.writes_a_type(),
        types::NAME => caller.may_save_types(),
        views::NAME => caller.writes_views(),
        docs::NAME | sources::LIST_NAME | sources::NAME_NAME => true,
        _ => false,
    }
}

fn served(group: Group, home: Home) -> bool {
    match home {
        Home::Items => true,
        Home::Schema => group == Group::Schema,
        Home::Admin(_) => group == Group::Admin,
    }
}

/// Whether the credential is offered any tool, which is whether the server declares them.
pub fn any_offered(caller: &Caller, group: Group) -> bool {
    definitions()
        .iter()
        .any(|(home, tool)| served(group, *home) && offered(caller, *home, tool.name))
}

pub fn listing(caller: &Caller, group: Group) -> Vec<Value> {
    definitions()
        .into_iter()
        .filter(|(home, tool)| served(group, *home) && offered(caller, *home, tool.name))
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
        tool.name == name && served(group, *home) && offered(caller, *home, tool.name)
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
        rows::READ_NAME => rows::read(app, caller, arguments).await,
        rows::WRITE_NAME => rows::write(app, caller, arguments, exact).await,
        delete::NAME => delete::run(app, caller, arguments).await,
        bulk::NAME => bulk::run(app, caller, arguments, exact).await,
        moving::NAME => moving::run(app, caller, arguments, exact).await,
        types::NAME => types::run(app, caller, arguments).await,
        views::NAME => views::run(app, caller, arguments).await,
        docs::NAME => docs::run(arguments),
        sources::LIST_NAME => sources::list(app, caller, arguments).await,
        sources::NAME_NAME => sources::name(app, caller, arguments).await,
        health::NAME => health::run(app, caller, arguments).await,
        audit::NAME => audit::run(app, caller, arguments).await,
        keys::LIST_NAME => keys::list(app, caller).await,
        keys::MANAGE_NAME => keys::manage(app, caller, arguments).await,
        revoke::NAME => revoke::run(app, caller, arguments).await,
        webhooks::LIST_NAME => webhooks::list(app, caller).await,
        webhooks::MANAGE_NAME => webhooks::manage(app, caller, arguments).await,
        settings::READ_NAME => settings::read(app, caller).await,
        settings::CHANGE_NAME => settings::change(app, caller, arguments).await,
        trash::NAME => trash::run(app, caller, arguments).await,
        purge::NAME => purge::run(app, caller, arguments).await,
        apps::LIST_NAME => apps::list(app, caller).await,
        apps::NARROW_NAME => apps::narrow(app, caller, arguments).await,
        backups::LIST_NAME => backups::list(app, caller).await,
        backups::TAKE_NAME => backups::take(app, caller).await,
        maintain::NAME => maintain::run(app, caller, arguments).await,
        connectors::LIST_NAME => connectors::list(app, caller, arguments).await,
        connectors::ENDPOINT_NAME => connectors::make_endpoint(app, caller, arguments).await,
        files::NAME => files::run(app, caller, arguments).await,
        sign_ins::LIST_NAME => sign_ins::list(app, caller).await,
        sign_ins::RENAME_NAME => sign_ins::rename(app, caller, arguments).await,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_admin_task_has_a_tool_at_admin() {
        let homes: Vec<Home> = definitions().into_iter().map(|(home, _)| home).collect();
        for task in AdminTask::ALL {
            assert!(
                homes
                    .iter()
                    .any(|home| matches!(home, Home::Admin(listed) if listed == task)),
                "{task:?} opens no tool"
            );
        }
    }
}
