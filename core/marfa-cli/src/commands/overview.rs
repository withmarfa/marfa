use serde_json::Value;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

pub fn request() -> Request {
    Request::get(&["overview"])
}

pub fn run(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let overview = remote.json(&request())?;
    out.report(&overview, || describe(&overview))
}

fn text<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or_default()
}

fn rows<'a>(value: &'a Value, name: &str) -> &'a [Value] {
    value
        .get(name)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// A section of the answer: its heading, one line per row, and how many more
/// the server held than it sent.
fn section(
    lines: &mut Vec<String>,
    overview: &Value,
    heading: &str,
    name: &str,
    row: impl Fn(&Value) -> String,
) {
    let list = rows(overview, name);
    if list.is_empty() {
        return;
    }
    lines.push(String::new());
    lines.push(heading.to_string());
    lines.extend(list.iter().map(|entry| format!("  {}", row(entry))));
    let held = overview
        .get("truncated")
        .and_then(|cut| cut.get(name))
        .and_then(Value::as_u64);
    if let Some(held) = held {
        lines.push(format!(
            "  and {} more, {held} in all",
            held.saturating_sub(list.len() as u64)
        ));
    }
}

fn with_description(head: String, entry: &Value) -> String {
    match entry.get("description").and_then(Value::as_str) {
        Some(description) => format!("{head}  {description}"),
        None => head,
    }
}

/// The overview as text for a person: the instance, the credential, then one
/// section for each list the server sent.
pub fn describe(overview: &Value) -> String {
    let empty = Value::Null;
    let instance = overview.get("instance").unwrap_or(&empty);
    let credential = overview.get("credential").unwrap_or(&empty);
    let mut lines = vec![format!(
        "instance {} ({})",
        text(instance, "name"),
        match instance.get("release").and_then(Value::as_str) {
            Some(release) => format!("{release}, build {}", text(instance, "build")),
            None => text(instance, "build").to_string(),
        }
    )];
    let kind = match text(credential, "kind") {
        "app" => "app".to_string(),
        _ => match credential.get("label").and_then(Value::as_str) {
            Some(label) => format!("key {label}"),
            None => "key".to_string(),
        },
    };
    lines.push(format!("credential {kind}"));
    let held = overview.get("truncated");
    for (level, words) in [
        ("write", "can read and write"),
        ("read", "can read"),
        ("none", "is denied"),
    ] {
        if let Some(patterns) = credential
            .get("type_permissions")
            .and_then(|map| map.get(level))
        {
            let more = held
                .and_then(|cut| cut.get(format!("credential.type_permissions.{level}")))
                .and_then(Value::as_u64)
                .map_or(String::new(), |all| format!(" (and others, {all} in all)"));
            lines.push(format!("  {words} {}{more}", strings(patterns).join(", ")));
        }
    }
    if let Some(permissions) = credential.get("permissions") {
        lines.push(format!("  permissions {}", strings(permissions).join(", ")));
    }
    section(&mut lines, overview, "types", "types", |entry| {
        with_description(format!("{} ({})", text(entry, "id"), entry["count"]), entry)
    });
    section(&mut lines, overview, "edge types", "edge_types", |entry| {
        with_description(
            format!("{} ({})", text(entry, "id"), text(entry, "access")),
            entry,
        )
    });
    section(&mut lines, overview, "tags", "tags", |entry| {
        format!("{} ({})", text(entry, "tag"), entry["count"])
    });
    for (heading, name) in [("views", "views"), ("folders", "folders")] {
        section(&mut lines, overview, heading, name, |entry| {
            format!("{}  {}", text(entry, "id"), text(entry, "title"))
        });
    }
    lines.join("\n")
}
