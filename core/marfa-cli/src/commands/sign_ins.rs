use clap::Subcommand;
use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum SignInsCommand {
    /// List every browser, app and key that can reach the server, each with
    /// its name, its kind and when it was last used. Needs direct local
    /// authority (--socket).
    List,
    /// Give an app or a key a new name. A key's name is its label; a
    /// browser's comes from the browser and can't be changed. Needs direct
    /// local authority (--socket).
    Rename {
        /// The sign-in's id.
        id: String,
        /// The new name.
        name: String,
    },
    /// End a sign-in at once: its next request is refused, and an app can't
    /// refresh its tokens. What it wrote stays. Needs direct local authority
    /// (--socket).
    End {
        /// The sign-in's id.
        id: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["owner", "sign-ins"])
}

pub fn rename_request(id: &str, name: &str) -> Request {
    Request::patch(&["owner", "sign-ins", id]).json(json!({ "name": name }))
}

pub fn end_request(id: &str) -> Request {
    Request::delete(&["owner", "sign-ins", id])
}

pub fn run(command: SignInsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        SignInsCommand::List => {
            let answer = remote.json(&list_request())?;
            out.report(&answer, || listing(&answer))
        }
        SignInsCommand::Rename { id, name } => {
            let answer = remote.json(&rename_request(&id, &name))?;
            out.report(&answer, || {
                let named = answer.get("name").and_then(Value::as_str).unwrap_or("");
                format!("renamed sign-in {id} to {named}")
            })
        }
        SignInsCommand::End { id } => {
            let answer = remote.json(&end_request(&id))?;
            out.report(&answer, || format!("ended sign-in {id}"))
        }
    }
}

/// One line a sign-in: id, kind, name, and when it was last used.
fn listing(answer: &Value) -> String {
    let rows = answer
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if rows.is_empty() {
        return "no sign-ins".to_string();
    }
    rows.iter()
        .map(|row| {
            let text = |field: &str| row.get(field).and_then(Value::as_str).unwrap_or("");
            let used = match text("last_used_at") {
                "" => "never used".to_string(),
                at => format!("last used {at}"),
            };
            let current = if row.get("current").and_then(Value::as_bool) == Some(true) {
                " (this browser)"
            } else {
                ""
            };
            format!(
                "{}  {:7}  {}  {used}{current}",
                text("id"),
                text("kind"),
                text("name")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_names_each_sign_in_on_a_line() {
        let answer = json!({
            "data": [
                {"id": "s1", "kind": "browser", "name": "Safari on macOS", "current": true,
                 "last_used_at": "2026-10-10T09:00:00.000Z"},
                {"id": "g1", "kind": "app", "name": "marfa on studio", "current": false,
                 "last_used_at": null},
            ],
            "next_cursor": null,
        });
        assert_eq!(
            listing(&answer),
            "s1  browser  Safari on macOS  last used 2026-10-10T09:00:00.000Z (this browser)\n\
             g1  app      marfa on studio  never used"
        );
        assert_eq!(
            listing(&json!({"data": [], "next_cursor": null})),
            "no sign-ins"
        );
    }

    #[test]
    fn rename_sends_the_name_and_end_sends_a_delete() {
        use crate::remote::request::{Body, Method};
        let rename = rename_request("g1", "Work laptop");
        assert_eq!(rename.method, Method::Patch);
        assert_eq!(rename.segments, ["owner", "sign-ins", "g1"]);
        assert_eq!(rename.body, Body::Json(json!({ "name": "Work laptop" })));
        let end = end_request("g1");
        assert_eq!(end.method, Method::Delete);
        assert_eq!(end.segments, ["owner", "sign-ins", "g1"]);
        assert_eq!(end.body, Body::None);
    }
}
