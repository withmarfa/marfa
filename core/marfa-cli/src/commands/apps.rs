use clap::Subcommand;
use serde_json::{Value, json};

use super::PageArgs;
use crate::error::CliError;
use crate::output::{self, Printer, printable};
use crate::remote::{Remote, request::Request};

#[derive(Debug, Subcommand)]
pub enum AppsCommand {
    /// List approved apps, each with the `app.<vendor>` namespaces it holds.
    /// Requires `grants.manage`.
    List,
    /// Reduce an app's access. Ends tokens and refresh chains that exceed it.
    /// Requires `grants.manage`.
    Narrow {
        /// The app grant's ID.
        id: String,
        /// One scope to keep; repeat for the complete resulting set.
        #[arg(long, required_unless_present = "clear", conflicts_with = "clear")]
        scope: Vec<String>,
        /// Remove every scope.
        #[arg(long)]
        clear: bool,
    },
    /// End an app's grant. Its keys and its own data stay unless asked.
    /// Requires `grants.manage`. With --remove-data, also `items.purge`; a key
    /// also needs write on every type under the app's namespaces, and
    /// `schema.write` while a type is registered there.
    Revoke {
        /// The app grant's ID.
        id: String,
        /// Also revoke every key the app minted, and every key those keys
        /// minted, but an owner's key.
        #[arg(long)]
        revoke_keys: bool,
        /// Also delete for good, in the same write, every item and type of the
        /// `app.<vendor>` namespaces the app holds, as `marfa apps vendors data
        /// delete` does. Run `marfa backups run` first: only a backup taken
        /// before brings them back. Refused, ending nothing, above 1,000 items.
        #[arg(long, requires = "confirm")]
        remove_data: bool,
        /// Confirm --remove-data with `PURGE`.
        #[arg(long, value_name = "WORD", value_parser = ["PURGE"], requires = "remove_data")]
        confirm: Option<String>,
    },
    /// The `app.<vendor>` namespaces apps hold. An app holds the namespace it
    /// registered the first type under; the owner holds one no single app is
    /// known to have made, until they give it to an app. Requires
    /// `grants.manage`.
    Vendors {
        #[command(subcommand)]
        command: VendorsCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum VendorsCommand {
    /// List each vendor and the client ID of the app that holds it, or `null`
    /// for one the owner holds and has not given to an app.
    List,
    /// Give a vendor to an app, such as one that registered again and got a
    /// new client ID, or one the owner holds. The app named then reaches the
    /// vendor's items in place of whoever held it. Only the owner's own
    /// credentials may: an app's sign-in or a key an app made is refused.
    Move {
        /// The namespace, such as `app.acme`.
        vendor: String,
        /// The client ID of the app to give it to, as `marfa apps list` shows it.
        client_id: String,
    },
    /// What an app keeps under one of its namespaces, hidden from ordinary
    /// listings: list it, or delete it for good. An app's sign-in or a key an
    /// app made reaches only its own namespaces.
    Data {
        #[command(subcommand)]
        command: DataCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum DataCommand {
    /// List the namespace's types, with how many items each holds by state,
    /// and its items in every state, the bin included. Requires
    /// `grants.manage`; a key also needs read on the namespace's types.
    List {
        /// The namespace, such as `app.acme`.
        vendor: String,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Delete for good every item of the namespace in every state, the bin
    /// included, then its types, 1,000 items a request, saying how many have
    /// gone as it does. Run `marfa backups run` first: only a backup taken
    /// before brings them back, and `marfa items restore` cannot. Items of
    /// other types that link to them stay and lose the link. The namespace
    /// stays with the app that holds it. Requires `grants.manage` and
    /// `items.purge`; a key also needs write on every type under the
    /// namespace, and `schema.write` while a type is registered there.
    Delete {
        /// The namespace, such as `app.acme`.
        vendor: String,
        /// Confirm permanent deletion with `PURGE`.
        #[arg(long, value_name = "WORD", value_parser = ["PURGE"])]
        confirm: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["grants"])
}

pub fn narrow_request(id: &str, scopes: &[String], expected: &Value) -> Request {
    Request::patch(&["grants", id]).json(json!({ "scopes": scopes, "expected_scopes": expected }))
}

pub fn revoke_request(id: &str, revoke_keys: bool, remove_data: bool) -> Request {
    Request::delete(&["grants", id])
        .query_flag("revoke_keys", revoke_keys)
        .query_flag("remove_data", remove_data)
}

pub fn vendors_request() -> Request {
    Request::get(&["app-vendors"])
}

pub fn move_request(vendor: &str, client_id: &str) -> Request {
    Request::put(&["app-vendors", vendor]).json(json!({ "client_id": client_id }))
}

pub fn data_request(vendor: &str, page: &PageArgs) -> Request {
    Request::get(&["app-vendors", vendor, "data"])
        .query_opt("limit", page.limit.map(|n| n.to_string()))
        .query_opt("cursor", page.cursor.as_deref())
}

pub fn data_delete_request(vendor: &str) -> Request {
    Request::delete(&["app-vendors", vendor, "data"])
}

/// The types with their counts, then the page of items with each one's state.
fn data_text(answer: &Value) -> String {
    let text = |value: &Value, name: &str| match &value[name] {
        Value::String(held) => printable(held),
        Value::Number(count) => count.to_string(),
        _ => "-".to_string(),
    };
    let rows = |name: &str| answer[name].as_array().cloned().unwrap_or_default();
    let head = |names: &[&str]| {
        names
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>()
    };
    let mut lines = vec![format!(
        "{} is held by {}",
        text(answer, "vendor"),
        match &answer["client_id"] {
            Value::String(client) => format!("the app {}", printable(client)),
            _ => "the owner".to_string(),
        }
    )];
    let types: Vec<Vec<String>> = rows("types")
        .iter()
        .map(|row| {
            ["type", "active", "archived", "trashed"]
                .map(|name| text(row, name))
                .to_vec()
        })
        .collect();
    if types.is_empty() {
        lines.push("it holds no types or items".to_string());
        return lines.join("\n");
    }
    lines.push(String::new());
    lines.extend(output::table_with_head(
        &head(&["type", "active", "archived", "trashed"]),
        &types,
    ));
    let items: Vec<Vec<String>> = rows("data")
        .iter()
        .map(|row| {
            ["id", "type", "state", "name", "created_at"]
                .map(|name| text(row, name))
                .to_vec()
        })
        .collect();
    if !items.is_empty() {
        lines.push(String::new());
        lines.extend(output::table_with_head(
            &head(&["id", "type", "state", "name", "created"]),
            &items,
        ));
    }
    if let Some(cursor) = answer["next_cursor"].as_str() {
        lines.push(format!("more: --cursor {}", printable(cursor)));
    }
    lines.join("\n")
}

/// The removed items, removed types and remaining items one removal answered.
fn removal_counts(vendor: &str, answer: &Value) -> Result<(u64, u64, u64), CliError> {
    let count = |name: &str| {
        answer.get(name).and_then(Value::as_u64).ok_or_else(|| {
            CliError::Invalid(format!(
                "the server's answer to deleting {vendor}'s data gave no readable {name}, so deleting stopped"
            ))
        })
    };
    Ok((
        count("removed_items")?,
        count("removed_types")?,
        count("remaining_items")?,
    ))
}

/// A failure after some pages, which only a request that got no answer may carry on from.
fn partly_deleted(vendor: &str, items: u64, error: CliError) -> CliError {
    if items == 0 {
        return error;
    }
    let answered = matches!(error, CliError::Refused { .. } | CliError::Invalid(_));
    let again = if answered {
        ""
    } else {
        " Run this again to carry on."
    };
    CliError::Invalid(format!(
        "{items} items of {vendor} were deleted, then: {error}.{again}"
    ))
}

/// Each request takes up to 1,000 items; the types go with the one that empties the namespace.
fn delete_data(vendor: &str, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let (mut items, mut types) = (0_u64, 0_u64);
    loop {
        let after = |error: CliError| partly_deleted(vendor, items, error);
        let answer = remote.json(&data_delete_request(vendor)).map_err(after)?;
        let (removed, removed_types, remaining) = removal_counts(vendor, &answer).map_err(after)?;
        items += removed;
        types += removed_types;
        if remaining == 0 {
            break;
        }
        if removed == 0 {
            return Err(CliError::Invalid(format!(
                "the server deleted nothing of {vendor} while {remaining} items remain, so deleting stopped"
            )));
        }
        if !out.json {
            out.line(&format!("{items} items deleted so far, {remaining} left"))?;
        }
    }
    out.report(
        &json!({ "vendor": vendor, "removed_items": items, "removed_types": types }),
        |_| {
            let plural = |count: u64, one: &str| {
                if count == 1 {
                    format!("1 {one}")
                } else {
                    format!("{count} {one}s")
                }
            };
            format!(
                "deleted {} and {} of {vendor}",
                plural(items, "item"),
                plural(types, "type")
            )
        },
    )
}

pub fn run(command: AppsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        AppsCommand::List => out.value(&remote.json(&list_request())?),
        AppsCommand::Narrow { id, scope, .. } => {
            let listed = remote.json(&list_request())?;
            let expected = listed
                .get("data")
                .and_then(Value::as_array)
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
                })
                .and_then(|row| row.get("scopes"))
                .cloned()
                .unwrap_or(json!([]));
            let answer = remote.json(&narrow_request(&id, &scope, &expected))?;
            out.report(&answer, |answer| {
                match answer.get("revoked_keys").and_then(Value::as_u64) {
                    None | Some(0) => format!("narrowed the app {id}"),
                    Some(1) => format!("narrowed the app {id} and revoked 1 key it made"),
                    Some(count) => {
                        format!("narrowed the app {id} and revoked {count} keys it made")
                    }
                }
            })
        }
        AppsCommand::Revoke {
            id,
            revoke_keys,
            remove_data,
            ..
        } => {
            let answer = remote.json(&revoke_request(&id, revoke_keys, remove_data))?;
            out.report(&answer, |_| {
                if remove_data {
                    format!("revoked the app {id} and deleted its data")
                } else {
                    format!("revoked the app {id}")
                }
            })
        }
        AppsCommand::Vendors {
            command: VendorsCommand::List,
        } => out.value(&remote.json(&vendors_request())?),
        AppsCommand::Vendors {
            command: VendorsCommand::Move { vendor, client_id },
        } => {
            let answer = remote.json(&move_request(&vendor, &client_id))?;
            out.report(&answer, |_| format!("gave {vendor} to the app {client_id}"))
        }
        AppsCommand::Vendors {
            command:
                VendorsCommand::Data {
                    command: DataCommand::List { vendor, page },
                },
        } => out.report(
            &remote.pages(&data_request(&vendor, &page), page.all)?,
            data_text,
        ),
        AppsCommand::Vendors {
            command:
                VendorsCommand::Data {
                    command: DataCommand::Delete { vendor, .. },
                },
        } => delete_data(&vendor, remote, out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revoke_sends_remove_data_only_when_asked_and_data_names_the_vendor() {
        assert!(revoke_request("g1", false, false).query.is_empty());
        assert_eq!(
            revoke_request("g1", false, true).query,
            [("remove_data".to_string(), "true".to_string())]
        );
        let page = PageArgs {
            limit: Some(5),
            cursor: None,
            all: false,
        };
        assert_eq!(
            data_request("app.acme", &page).segments,
            ["app-vendors", "app.acme", "data"]
        );
        assert_eq!(
            data_delete_request("app.acme").method,
            crate::remote::request::Method::Delete
        );
    }

    #[test]
    fn remove_data_needs_the_confirm_word() {
        use clap::Parser;
        let refused =
            crate::Cli::try_parse_from(["marfa", "apps", "revoke", "g1", "--remove-data"]);
        assert!(refused.is_err());
        let taken = crate::Cli::try_parse_from([
            "marfa",
            "apps",
            "revoke",
            "g1",
            "--remove-data",
            "--confirm",
            "PURGE",
        ]);
        assert!(taken.is_ok());
        let deleted = crate::Cli::try_parse_from([
            "marfa",
            "apps",
            "vendors",
            "data",
            "delete",
            "app.acme",
            "--confirm",
            "yes",
        ]);
        assert!(deleted.is_err());
    }

    #[test]
    fn a_removal_answer_without_readable_counts_is_an_error_not_an_end() {
        let full = json!({ "removed_items": 3, "removed_types": 1, "remaining_items": 0 });
        assert_eq!(removal_counts("app.acme", &full).unwrap(), (3, 1, 0));
        for broken in [
            json!({ "removed_items": 3, "removed_types": 1 }),
            json!({ "removed_items": 3, "removed_types": 1, "remaining_items": "none" }),
            json!({ "removed_types": 1, "remaining_items": 0 }),
            json!({ "removed_items": 3, "remaining_items": -1 }),
        ] {
            assert!(removal_counts("app.acme", &broken).is_err(), "{broken}");
        }
    }

    #[test]
    fn a_partial_delete_says_to_carry_on_only_after_a_request_that_got_no_answer() {
        let refused = |status: u16| CliError::Refused {
            status,
            code: "type_in_use".into(),
            message: "named".into(),
            retry_after_seconds: None,
            details: None,
            request_id: None,
        };
        for answered in [
            refused(403),
            refused(409),
            CliError::Invalid("unreadable".into()),
        ] {
            let said = partly_deleted("app.acme", 1_000, answered).to_string();
            assert!(said.starts_with("1000 items of app.acme were deleted, then: "));
            assert!(said.ends_with('.') && !said.contains("carry on"), "{said}");
        }
        let lost = CliError::Io(std::io::Error::other("connection reset"));
        assert!(
            partly_deleted("app.acme", 1_000, lost)
                .to_string()
                .ends_with("Run this again to carry on.")
        );
        assert_eq!(
            partly_deleted("app.acme", 0, refused(403)).to_string(),
            refused(403).to_string()
        );
    }

    #[test]
    fn sends_the_complete_choice_and_the_grant_seen_before_it() {
        let req = narrow_request(
            "app-1",
            &["core.note:read".into()],
            &json!(["core.note:write"]),
        );
        assert_eq!(req.segments, ["grants", "app-1"]);
        assert_eq!(
            req.body,
            crate::remote::request::Body::Json(
                json!({"scopes":["core.note:read"], "expected_scopes":["core.note:write"]})
            )
        );
    }
}
