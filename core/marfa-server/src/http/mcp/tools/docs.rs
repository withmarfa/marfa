//! `marfa_search_docs`: where to search Marfa's documentation, which the instance does not hold.

use serde_json::{Map, Value, json};
use url::Url;

use super::{Definition, text};
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_search_docs";

const SITE: &str = "https://docs.marfa.so";
const SEARCH: &str = "https://docs.marfa.so/api/docs/search";
const MAX_QUERY: usize = 200;

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Find Marfa's documentation",
        description: "Use to learn how Marfa works, such as the field types a type can have or a view's filter expressions. Returns where to search the documentation for your query; this instance holds no copy and fetches nothing.",
        input: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "minLength": 1, "maxLength": MAX_QUERY,
                    "description": "What to look up." },
            },
            "required": ["query"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "search_url": { "type": "string" },
                "docs_mcp": { "type": "string" },
                "llms_txt": { "type": "string" },
                "next": { "type": "string" },
            },
            "required": ["query", "search_url", "docs_mcp", "llms_txt", "next"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn run(arguments: Map<String, Value>) -> Outcome {
    let query = text(&arguments, "query").unwrap_or_default();
    if query.chars().count() > MAX_QUERY {
        return Err(Stop::invalid(format!(
            "query must be at most {MAX_QUERY} characters."
        )));
    }
    let search = Url::parse_with_params(SEARCH, [("q", query.as_str())])
        .map_err(|_| Stop::invalid("query cannot be put in an address."))?;
    Ok(json!({
        "query": query,
        "search_url": search.as_str(),
        "docs_mcp": format!("{SITE}/mcp"),
        "llms_txt": format!("{SITE}/llms.txt"),
        "next": "Fetch search_url if you can reach the web, or add docs_mcp as an MCP server to search the documentation there.",
    }))
}
