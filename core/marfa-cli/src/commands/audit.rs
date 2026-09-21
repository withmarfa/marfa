use clap::Args;

use super::PageArgs;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Default, Args)]
pub struct AuditArgs {
    /// Only entries with this action, such as `item.create`.
    #[arg(long)]
    pub action: Option<String>,
    /// Only entries about this kind of resource.
    #[arg(long = "resource-type", value_name = "TYPE")]
    pub resource_type: Option<String>,
    /// Only entries about this resource.
    #[arg(long = "resource-id", value_name = "ID")]
    pub resource_id: Option<String>,
    /// Exclusive lower bound on the entry's time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub created_after: Option<String>,
    /// Exclusive upper bound on the entry's time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub created_before: Option<String>,
    #[command(flatten)]
    pub page: PageArgs,
}

pub fn request(args: &AuditArgs) -> Request {
    Request::get(&["audit"])
        .query_opt("action", args.action.clone())
        .query_opt("resource_type", args.resource_type.clone())
        .query_opt("resource_id", args.resource_id.clone())
        .query_opt("created_after", args.created_after.clone())
        .query_opt("created_before", args.created_before.clone())
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone())
}

pub fn run(args: AuditArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    out.value(&remote.json(&request(&args))?)
}
