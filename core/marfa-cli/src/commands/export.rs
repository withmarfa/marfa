use std::io::{self, Write};
use std::path::PathBuf;

use clap::{Args, ValueEnum};
use serde_json::json;

use super::StateFilter;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Export the instance's data: items as NDJSON, or everything as an archive.
#[derive(Debug, Default, Args)]
pub struct ExportArgs {
    /// `ndjson` for items one per line, `archive` for the whole instance.
    #[arg(long)]
    pub format: Option<ExportFormat>,
    /// Where to write. Omitted, the export goes to stdout.
    #[arg(long, value_name = "PATH")]
    pub output: Option<PathBuf>,
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// One state, or `any`.
    #[arg(long)]
    pub state: Option<StateFilter>,
    /// The source the items were written under.
    #[arg(long)]
    pub source: Option<String>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_before: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ExportFormat {
    Ndjson,
    Archive,
}

impl ExportFormat {
    fn as_str(self) -> &'static str {
        match self {
            ExportFormat::Ndjson => "ndjson",
            ExportFormat::Archive => "archive",
        }
    }
}

pub fn request(args: &ExportArgs) -> Request {
    Request::get(&["export"])
        .query_opt("format", args.format.map(ExportFormat::as_str))
        .query_opt("type", args.type_.clone())
        .query_opt("state", args.state.map(StateFilter::as_str))
        .query_opt("source", args.source.clone())
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .streamed()
}

pub fn run(args: ExportArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let (content_type, mut reader) = remote.stream(&request(&args))?;
    match &args.output {
        Some(path) => {
            let mut file = std::fs::File::create(path).map_err(|error| {
                CliError::Invalid(format!("cannot write {}: {error}", path.display()))
            })?;
            let written = io::copy(&mut reader, &mut file)?;
            out.report(
                &json!({ "path": path, "size_bytes": written, "content_type": content_type }),
                || {
                    format!(
                        "{written} byte(s) of {content_type} into {}",
                        path.display()
                    )
                },
            )
        }
        None => {
            // The export is the answer, whatever the mode: NDJSON is already
            // one record per line, and an archive is bytes to redirect.
            let mut stdout = io::stdout().lock();
            io::copy(&mut reader, &mut stdout)?;
            stdout.flush()?;
            Ok(())
        }
    }
}
