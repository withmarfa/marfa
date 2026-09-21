use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Map, Value, json};

use super::insert_opt;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum ConnectorsCommand {
    /// Register the key this command runs under as a connector, or answer
    /// its registration if it has one: the key is the identity.
    Register {
        /// What the connector is called.
        #[arg(long)]
        name: String,
        /// What it does.
        #[arg(long)]
        description: Option<String>,
    },
    /// Every registered connector, newest first.
    List,
    /// One connector's registration.
    Get {
        /// The connector id.
        id: String,
    },
    /// Remove a registration. The connector's own key, or the operator key.
    Delete {
        /// The connector id.
        id: String,
    },
    /// Say the connector is alive. Its own key only.
    Heartbeat {
        /// The connector id.
        id: String,
    },
    /// Report one run of the connector. Its own key only.
    Report(ReportArgs),
    /// The runs a connector has reported, newest first.
    Runs {
        /// The connector id.
        id: String,
        /// How many at most.
        #[arg(long)]
        limit: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Outcome {
    Succeeded,
    Failed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Succeeded => "succeeded",
            Outcome::Failed => "failed",
        }
    }
}

#[derive(Debug, Args)]
pub struct ReportArgs {
    /// The connector id.
    pub id: String,
    /// How the run ended.
    #[arg(long)]
    pub outcome: Outcome,
    /// When the run started, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub started_at: String,
    /// When the run finished, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub finished_at: String,
    /// What the run did, in a sentence.
    #[arg(long)]
    pub summary: Option<String>,
    /// What went wrong, for a run that failed.
    #[arg(long)]
    pub error: Option<String>,
}

pub fn register_request(name: &str, description: Option<&str>) -> Request {
    let mut body = Map::new();
    body.insert("name".into(), Value::String(name.to_string()));
    insert_opt(&mut body, "description", description.map(str::to_string));
    Request::post(&["connectors"]).json(Value::Object(body))
}

pub fn report_request(args: &ReportArgs) -> Request {
    let mut body = Map::new();
    body.insert("outcome".into(), json!(args.outcome.as_str()));
    body.insert("started_at".into(), json!(args.started_at));
    body.insert("finished_at".into(), json!(args.finished_at));
    insert_opt(&mut body, "summary", args.summary.clone());
    insert_opt(&mut body, "error", args.error.clone());
    Request::post(&["connectors", &args.id, "runs"]).json(Value::Object(body))
}

pub fn runs_request(id: &str, limit: Option<u32>) -> Request {
    Request::get(&["connectors", id, "runs"])
        .query_opt("limit", limit.map(|limit| limit.to_string()))
}

pub fn run(command: ConnectorsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        ConnectorsCommand::Register { name, description } => {
            register_request(name, description.as_deref())
        }
        ConnectorsCommand::List => Request::get(&["connectors"]),
        ConnectorsCommand::Get { id } => Request::get(&["connectors", id]),
        ConnectorsCommand::Delete { id } => Request::delete(&["connectors", id]),
        ConnectorsCommand::Heartbeat { id } => Request::post(&["connectors", id, "heartbeat"]),
        ConnectorsCommand::Report(args) => report_request(args),
        ConnectorsCommand::Runs { id, limit } => runs_request(id, *limit),
    };
    out.value(&remote.json(&request)?)
}
