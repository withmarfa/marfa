use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::{Printer, printable};
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
        /// The new name, which may start with `-`.
        #[arg(allow_hyphen_values = true)]
        name: String,
    },
    /// End a sign-in at once: its next request is refused, and an app can't
    /// refresh its tokens. What it wrote stays, and so do the keys an app
    /// minted unless --revoke-keys is given. Needs direct local authority
    /// (--socket).
    End {
        /// The sign-in's id.
        id: String,
        /// For an app, also revoke every key it minted. Refused for a browser
        /// or a key.
        #[arg(long)]
        revoke_keys: bool,
    },
    /// End every sign-in of the chosen kinds at once, except the ones named
    /// with --keep. With no --kind it ends every browser. It ends them one
    /// at a time, carries on past one it cannot end, and says how many it
    /// ended. Needs direct local authority (--socket).
    EndAll {
        /// The kinds to end. Repeat it for several; the default is browser.
        #[arg(long, value_enum, value_name = "KIND")]
        kind: Vec<Kind>,
        /// A sign-in to leave as it is. Repeat it for several.
        #[arg(long, value_name = "ID")]
        keep: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Kind {
    Browser,
    App,
    Key,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Browser => "browser",
            Kind::App => "app",
            Kind::Key => "key",
        }
    }
}

pub fn list_request() -> Request {
    Request::get(&["owner", "sign-ins"])
}

pub fn rename_request(id: &str, name: &str) -> Request {
    Request::patch(&["owner", "sign-ins", id]).json(json!({ "name": name }))
}

pub fn end_request(id: &str, revoke_keys: bool) -> Request {
    Request::delete(&["owner", "sign-ins", id]).query_flag("revoke_keys", revoke_keys)
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
                format!("renamed sign-in {} to {}", printable(&id), printable(named))
            })
        }
        SignInsCommand::EndAll { kind, keep } => end_all(&kind, &keep, remote, out),
        SignInsCommand::End { id, revoke_keys } => {
            let answer = remote.json(&end_request(&id, revoke_keys))?;
            out.report(&answer, || format!("ended sign-in {}", printable(&id)))
        }
    }
}

/// The sign-ins `kinds` names, less the ones kept, from a listing.
fn chosen(answer: &Value, kinds: &[Kind], keep: &[String]) -> Vec<String> {
    let kinds = if kinds.is_empty() {
        &[Kind::Browser]
    } else {
        kinds
    };
    answer
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|row| {
            let kind = row.get("kind").and_then(Value::as_str).unwrap_or_default();
            kinds.iter().any(|wanted| wanted.word() == kind)
        })
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|id| !keep.iter().any(|kept| kept == id))
        .map(str::to_string)
        .collect()
}

fn end_all(
    kinds: &[Kind],
    keep: &[String],
    remote: &Remote,
    out: &Printer,
) -> Result<(), CliError> {
    let found = chosen(&remote.json(&list_request())?, kinds, keep);
    let mut ended = Vec::new();
    let mut failed = Vec::new();
    for id in found {
        match remote.json(&end_request(&id, false)) {
            Ok(_) => ended.push(id),
            Err(error) => failed.push((id, error)),
        }
    }
    let answer = json!({
        "ended": ended.len(),
        "ids": ended,
        "failed": failed
            .iter()
            .map(|(id, error)| json!({ "id": id, "error": error.to_string() }))
            .collect::<Vec<_>>(),
    });
    out.report(&answer, || match ended.len() {
        1 => "ended 1 sign-in".to_string(),
        count => format!("ended {count} sign-ins"),
    })?;
    match failed.into_iter().next() {
        Some((_, error)) => Err(error),
        None => Ok(()),
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
            let text =
                |field: &str| printable(row.get(field).and_then(Value::as_str).unwrap_or(""));
            let used = match text("last_used_at").as_str() {
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
    fn end_all_chooses_browsers_unless_told_otherwise_and_spares_what_is_kept() {
        let answer = json!({ "data": [
            {"id": "b1", "kind": "browser"},
            {"id": "b2", "kind": "browser"},
            {"id": "a1", "kind": "app"},
            {"id": "k1", "kind": "key"},
        ], "next_cursor": null });
        assert_eq!(chosen(&answer, &[], &[]), ["b1", "b2"]);
        assert_eq!(chosen(&answer, &[], &["b2".to_string()]), ["b1"]);
        assert_eq!(chosen(&answer, &[Kind::App, Kind::Key], &[]), ["a1", "k1"]);
    }

    #[test]
    fn rename_sends_the_name_and_end_sends_a_delete() {
        use crate::remote::request::{Body, Method};
        let rename = rename_request("g1", "Work laptop");
        assert_eq!(rename.method, Method::Patch);
        assert_eq!(rename.segments, ["owner", "sign-ins", "g1"]);
        assert_eq!(rename.body, Body::Json(json!({ "name": "Work laptop" })));
        let end = end_request("g1", false);
        assert_eq!(end.method, Method::Delete);
        assert_eq!(end.segments, ["owner", "sign-ins", "g1"]);
        assert_eq!(end.body, Body::None);
        assert!(end.query.is_empty());
        let with_keys = end_request("g1", true);
        assert_eq!(
            with_keys.query,
            [("revoke_keys".to_string(), "true".to_string())]
        );
    }

    #[test]
    fn a_listing_escapes_a_name_that_would_forge_a_row() {
        let answer = json!({
            "data": [
                {"id": "g1", "kind": "app",
                 "name": "marfa\r\u{1b}[2Kk1  key  trusted\u{202e}",
                 "current": false, "last_used_at": null},
            ],
            "next_cursor": null,
        });
        let line = listing(&answer);
        assert!(!line.contains('\r') && !line.contains('\u{1b}') && !line.contains('\u{202e}'));
        assert_eq!(
            line,
            "g1  app      marfa\\u{d}\\u{1b}[2Kk1  key  trusted\\u{202e}  never used"
        );
    }

    #[test]
    fn rename_takes_a_name_that_starts_with_a_hyphen() {
        use clap::Parser;
        let cli = crate::Cli::try_parse_from(["marfa", "sign-ins", "rename", "g1", "-studio-"])
            .expect("a name starting with a hyphen parses");
        match cli.command {
            crate::Command::SignIns {
                command: SignInsCommand::Rename { id, name },
            } => {
                assert_eq!(id, "g1");
                assert_eq!(name, "-studio-");
            }
            other => panic!("parsed as {other:?}"),
        }
    }
}
