use clap::Args;

use super::{PageArgs, StateFilter, TierFilter};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;
use crate::values::SortDirection;

/// Full-text search on the server, best match first unless a sort is given.
#[derive(Debug, Default, Args)]
pub struct SearchArgs {
    /// What to look for.
    #[arg(allow_hyphen_values = true)]
    pub query: String,
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// One state, or `any`. Unset answers the active state.
    #[arg(long)]
    pub state: Option<StateFilter>,
    /// The source the items were written under.
    #[arg(long)]
    pub source: Option<String>,
    /// One tier, or `all`.
    #[arg(long)]
    pub tier: Option<TierFilter>,
    /// Hits must carry every tag given.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// A property filter in the server's filter grammar.
    #[arg(long)]
    pub filter: Option<String>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_before: Option<String>,
    /// Inclusive lower bound on the modification time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub updated_after: Option<String>,
    /// Exclusive upper bound on the modification time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub updated_before: Option<String>,
    /// What to order by: `relevance` (the default), `created-at`, `updated-at`,
    /// `occurred-at` or `properties.<field>`.
    #[arg(long, value_name = "FIELD", value_parser = parse_sort)]
    pub sort: Option<String>,
    /// `asc` or `desc`; the server's default is best match or newest first.
    #[arg(long)]
    pub direction: Option<SortDirection>,
    /// Extra to include: `system` also returns `system.*` items, which are left
    /// out by default.
    #[arg(long, value_name = "NAME")]
    pub include: Vec<String>,
    #[command(flatten)]
    pub page: PageArgs,
}

/// A sort as typed, in the server's spelling: the kebab names of the times
/// that `items list` takes are accepted too, and a property keeps its field.
fn parse_sort(text: &str) -> Result<String, String> {
    match text {
        "relevance" | "created_at" | "updated_at" | "occurred_at" => Ok(text.to_owned()),
        "created-at" | "updated-at" | "occurred-at" => Ok(text.replace('-', "_")),
        other => match other.strip_prefix("properties.") {
            Some(field)
                if !field.is_empty()
                    && field
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') =>
            {
                Ok(other.to_owned())
            }
            _ => Err(format!(
                "`{other}` is not a sort: use `relevance`, `created-at`, `updated-at`, \
                 `occurred-at` or `properties.<field>` with a lowercase field name"
            )),
        },
    }
}

pub fn request(args: &SearchArgs) -> Request {
    Request::get(&["search"])
        .query("q", args.query.clone())
        .query_opt("type", args.type_.clone())
        .query_opt("state", args.state.map(StateFilter::as_str))
        .query_opt("source", args.source.clone())
        .query_opt("tier", args.tier.map(TierFilter::as_str))
        .query_list("tags", &args.tags)
        .query_opt("filter", args.filter.clone())
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .query_opt("updated_after", args.updated_after.clone())
        .query_opt("updated_before", args.updated_before.clone())
        .query_opt("sort", args.sort.clone())
        .query_opt("direction", args.direction.map(SortDirection::as_str))
        .query_list("include", &args.include)
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone())
}

pub fn run(args: SearchArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    out.value(&remote.json(&request(&args))?)
}
