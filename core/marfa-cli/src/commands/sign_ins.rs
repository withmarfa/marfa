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
        /// For an app, also revoke every key it minted, and every key those
        /// keys minted. Refused for a browser or a key.
        #[arg(long)]
        revoke_keys: bool,
    },
    /// End every sign-in of the chosen kinds at once, except the ones named
    /// with --keep. With no --kind it ends every browser. It refuses, ending
    /// nothing, when a --keep names no sign-in. It ends them one at a time,
    /// carries on past one it cannot end, says how many it ended and names
    /// each one it could not. Needs direct local authority (--socket).
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

/// The `--keep` ids a listing does not hold, so a typo can't leave a sign-in
/// it meant to spare to be ended.
fn unknown_keeps<'a>(answer: &Value, keep: &'a [String]) -> Vec<&'a String> {
    let listed: Vec<&str> = answer
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .collect();
    let mut unknown: Vec<&String> = Vec::new();
    for id in keep {
        if !listed.contains(&id.as_str()) && !unknown.contains(&id) {
            unknown.push(id);
        }
    }
    unknown
}

/// A sign-in that is gone by the time its turn comes was ended by someone else.
fn is_already_ended(error: &CliError) -> bool {
    matches!(error, CliError::Refused { status: 404, code, .. } if code == "sign_in_not_found")
}

/// What `end-all` did: the sign-ins it ended and the ones it could not.
struct Outcome {
    ended: Vec<String>,
    failed: Vec<(String, CliError)>,
}

impl Outcome {
    fn json(&self) -> Value {
        json!({
            "ended": self.ended.len(),
            "ids": self.ended,
            "failed": self.failed
                .iter()
                .map(|(id, error)| json!({ "id": id, "error": error.to_string() }))
                .collect::<Vec<_>>(),
        })
    }

    fn text(&self) -> String {
        let mut lines = vec![match self.ended.len() {
            1 => "ended 1 sign-in".to_string(),
            count => format!("ended {count} sign-ins"),
        }];
        lines.extend(self.failed.iter().map(|(id, error)| {
            format!(
                "could not end {}: {}",
                printable(id),
                printable(&error.to_string())
            )
        }));
        lines.join("\n")
    }
}

fn end_chosen(kinds: &[Kind], keep: &[String], remote: &Remote) -> Result<Outcome, CliError> {
    let listing = remote.json(&list_request())?;
    let unknown = unknown_keeps(&listing, keep);
    if !unknown.is_empty() {
        return Err(CliError::Refused {
            status: 400,
            code: "validation_error".to_string(),
            message: format!(
                "--keep names no sign-in: {}; nothing was ended",
                unknown
                    .iter()
                    .map(|id| printable(id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            retry_after_seconds: None,
            details: None,
        });
    }
    let found = chosen(&listing, kinds, keep);
    let mut outcome = Outcome {
        ended: Vec::new(),
        failed: Vec::new(),
    };
    for id in found {
        match remote.json(&end_request(&id, false)) {
            Ok(_) => outcome.ended.push(id),
            Err(error) if is_already_ended(&error) => outcome.ended.push(id),
            Err(error) => outcome.failed.push((id, error)),
        }
    }
    Ok(outcome)
}

fn end_all(
    kinds: &[Kind],
    keep: &[String],
    remote: &Remote,
    out: &Printer,
) -> Result<(), CliError> {
    let outcome = end_chosen(kinds, keep, remote)?;
    out.report(&outcome.json(), || outcome.text())?;
    match outcome.failed.into_iter().next() {
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
            format!(
                "{}  {:7}  {}  {used}",
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
                {"id": "s1", "kind": "browser", "name": "Safari on macOS",
                 "last_used_at": "2026-10-10T09:00:00.000Z"},
                {"id": "g1", "kind": "app", "name": "marfa on studio",
                 "last_used_at": null},
            ],
            "next_cursor": null,
        });
        assert_eq!(
            listing(&answer),
            "s1  browser  Safari on macOS  last used 2026-10-10T09:00:00.000Z\n\
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

    fn refused(status: &'static str, code: &str) -> crate::door::Answer {
        crate::door::Answer::json(
            status,
            &format!(r#"{{"error":{{"code":"{code}","message":"no"}}}}"#),
        )
    }

    fn listing_of(rows: &[(&str, &str)]) -> crate::door::Answer {
        let data: Vec<Value> = rows
            .iter()
            .map(|(id, kind)| json!({ "id": id, "kind": kind }))
            .collect();
        crate::door::Answer::json(
            "200 OK",
            &json!({ "data": data, "next_cursor": null }).to_string(),
        )
    }

    fn ended() -> crate::door::Answer {
        crate::door::Answer::json("200 OK", r#"{"ended":true}"#)
    }

    #[test]
    fn a_keep_that_names_no_sign_in_ends_nothing() {
        use crate::door::Door;
        let door = Door::open(vec![listing_of(&[("b1", "browser"), ("b2", "browser")])]);
        let remote = Remote::keyed(&door.url, "key").unwrap();
        let keep = ["b3".to_string(), "b2".to_string(), "b4".to_string()];
        let error = match end_chosen(&[], &keep, &remote) {
            Ok(_) => panic!("a misspelled --keep ended sign-ins"),
            Err(error) => error,
        };
        match &error {
            CliError::Refused {
                status,
                code,
                message,
                ..
            } => {
                assert_eq!((*status, code.as_str()), (400, "validation_error"));
                assert!(
                    message.contains("b3") && message.contains("b4"),
                    "{message}"
                );
                assert!(!message.contains("b2"), "{message}");
            }
            other => panic!("refused as {other:?}"),
        }
        assert_eq!(error.exit(), crate::error::Exit::Refused);
        let calls = door.received();
        assert_eq!(calls.len(), 1, "only the listing was asked for");
        assert_eq!(calls[0].method(), "GET");
    }

    #[test]
    fn a_keep_that_names_a_listed_sign_in_of_another_kind_is_accepted() {
        use crate::door::Door;
        let door = Door::open(vec![
            listing_of(&[("b1", "browser"), ("a1", "app")]),
            ended(),
        ]);
        let remote = Remote::keyed(&door.url, "key").unwrap();
        let outcome = end_chosen(&[], &["a1".to_string()], &remote).unwrap();
        assert_eq!(outcome.ended, ["b1"]);
        let calls = door.received();
        assert_eq!(calls[1].method(), "DELETE");
        assert_eq!(calls[1].path(), "/owner/sign-ins/b1");
    }

    #[test]
    fn a_failure_is_named_after_the_count_and_one_already_ended_is_not_a_failure() {
        use crate::door::Door;
        let door = Door::open(vec![
            listing_of(&[("b1", "browser"), ("b2", "browser"), ("b3", "browser")]),
            refused("404 Not Found", "sign_in_not_found"),
            refused("403 Forbidden", "forbidden"),
            ended(),
        ]);
        let remote = Remote::keyed(&door.url, "key").unwrap();
        let outcome = end_chosen(&[], &[], &remote).unwrap();
        assert_eq!(outcome.ended, ["b1", "b3"]);
        assert_eq!(outcome.failed.len(), 1);
        let text = outcome.text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert_eq!(lines[0], "ended 2 sign-ins");
        assert!(lines[1].starts_with("could not end b2: "), "{text}");
        assert_eq!(outcome.json()["failed"][0]["id"], "b2");
        assert_eq!(door.received().len(), 4);
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
                 "last_used_at": null},
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
