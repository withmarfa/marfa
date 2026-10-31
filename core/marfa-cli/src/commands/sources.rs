use clap::Subcommand;
use serde_json::{Map, Value};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};

#[derive(Debug, Subcommand)]
pub enum SourcesCommand {
    /// List the sources you can see, each with the name and mark it's shown
    /// by: your own, those you claim, and those of items you can read. With
    /// keys.manage, every source in use or named.
    List,
    /// Show a source's name, where the name comes from, and its mark.
    Get {
        /// The source code, as items carry it in `source`.
        source: String,
    },
    /// Set the name or mark a source is shown by. A key can set its own
    /// source and the sources it claims; any other needs keys.manage.
    ///
    /// The mark is an Iconify icon ID from the sets a type's icon uses:
    /// `lucide`, such as `lucide:book-open`, or `simple-icons` for brand
    /// marks, such as `simple-icons:github`.
    Set {
        /// The source code, as items carry it in `source`.
        source: String,
        /// The name to show, such as `GitHub`.
        #[arg(long, required_unless_present = "mark")]
        name: Option<String>,
        /// The icon ID to show, such as `simple-icons:github`.
        #[arg(long)]
        mark: Option<String>,
    },
    /// Clear a source's name or mark, so the name falls back to the app's
    /// sign-in name, the key's label or the code. Needs the same access as
    /// `set`.
    Clear {
        /// The source code, as items carry it in `source`.
        source: String,
        /// Clear the name.
        #[arg(long, required_unless_present = "mark")]
        name: bool,
        /// Clear the mark.
        #[arg(long)]
        mark: bool,
    },
}

pub fn list_request() -> Request {
    Request::get(&["sources"])
}

pub fn get_request(source: &str) -> Request {
    Request::get(&["source"]).query("source", source)
}

/// A field left out of the body keeps its value; `null` clears it.
pub fn update_request(source: &str, name: Option<Value>, mark: Option<Value>) -> Request {
    let mut body = Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name);
    }
    if let Some(mark) = mark {
        body.insert("mark".into(), mark);
    }
    Request::patch(&["source"])
        .query("source", source)
        .json(Value::Object(body))
}

pub fn request(command: &SourcesCommand) -> Request {
    match command {
        SourcesCommand::List => list_request(),
        SourcesCommand::Get { source } => get_request(source),
        SourcesCommand::Set { source, name, mark } => update_request(
            source,
            name.clone().map(Value::String),
            mark.clone().map(Value::String),
        ),
        SourcesCommand::Clear { source, name, mark } => update_request(
            source,
            name.then_some(Value::Null),
            mark.then_some(Value::Null),
        ),
    }
}

pub fn run(command: SourcesCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    out.value(&remote.json(&request(&command))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::request::Body;
    use serde_json::json;

    #[test]
    fn carries_the_code_in_the_query_where_a_path_would_rewrite_it() {
        let req = get_request("../a/b");
        assert_eq!(req.segments, ["source"]);
        assert_eq!(req.query, [("source".to_string(), "../a/b".to_string())]);
    }

    #[test]
    fn sets_only_the_fields_named() {
        let req = request(&SourcesCommand::Set {
            source: "github".into(),
            name: None,
            mark: Some("simple-icons:github".into()),
        });
        assert_eq!(req.segments, ["source"]);
        assert_eq!(
            req.body,
            Body::Json(json!({ "mark": "simple-icons:github" }))
        );
    }

    #[test]
    fn clears_a_field_by_sending_null_and_leaves_the_other_out() {
        let req = request(&SourcesCommand::Clear {
            source: "github".into(),
            name: true,
            mark: false,
        });
        assert_eq!(req.body, Body::Json(json!({ "name": null })));
    }
}
