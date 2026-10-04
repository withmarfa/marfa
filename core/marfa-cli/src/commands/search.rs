use clap::Args;

use super::{PageArgs, StateFilter, TierFilter};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Full-text search on the server, best match first.
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
    /// Extra to hydrate onto each hit: `edges`, `metadata`.
    #[arg(long, value_name = "NAME")]
    pub include: Vec<String>,
    #[command(flatten)]
    pub page: PageArgs,
}

pub fn request(args: &SearchArgs) -> Request {
    Request::get(&["search"])
        .query("q", args.query.clone())
        .query_opt("type", args.type_.clone())
        .query_opt("state", args.state.map(StateFilter::as_str))
        .query_opt("tier", args.tier.map(TierFilter::as_str))
        .query_list("tags", &args.tags)
        .query_opt("filter", args.filter.clone())
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .query_list("include", &args.include)
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone())
}

pub fn run(args: SearchArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    out.value(&remote.json(&request(&args))?)
}
