use std::io::{self, Write};
use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Map, Value, json};

use super::{BodySource, PageArgs, insert_opt};
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
    /// The addresses a sender posts inbound webhooks to.
    Endpoints {
        #[command(subcommand)]
        command: EndpointsCommand,
    },
    /// What arrived at a connector's endpoints. Its own key only.
    Deliveries {
        #[command(subcommand)]
        command: DeliveriesCommand,
    },
    /// Take or renew the hold on the registration for one process, so no
    /// other process acts while it is live. Its own key only.
    Hold {
        /// The connector id.
        id: String,
        /// The process's own name for itself, such as a UUID.
        #[arg(long)]
        process: String,
    },
    /// Give up the hold, if this process holds it. Its own key only.
    Release {
        /// The connector id.
        id: String,
        /// The process's own name for itself.
        #[arg(long)]
        process: String,
    },
    /// The state document a connector keeps on the instance.
    State {
        #[command(subcommand)]
        command: StateCommand,
    },
    /// A connector's records of what it and its vendor last agreed about
    /// rows. Its own key only.
    Agreements {
        #[command(subcommand)]
        command: AgreementsCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum StateCommand {
    /// The state document, `{}` until one is written. Its own key only.
    Get {
        /// The connector id.
        id: String,
    },
    /// Replace the state document with a JSON object. Its own key only.
    Put {
        /// The connector id.
        id: String,
        /// The process writing, which must hold the registration if any
        /// process does.
        #[arg(long)]
        process: String,
        #[command(flatten)]
        body: BodySource,
    },
    /// Remove the state document and every agreement. The connector's own
    /// key, or the operator key.
    Clear {
        /// The connector id.
        id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum AgreementsCommand {
    /// Set and clear agreements, from a JSON object with `set` and `clear`.
    Write {
        /// The connector id.
        id: String,
        /// The process writing, which must hold the registration if any
        /// process does.
        #[arg(long)]
        process: String,
        #[command(flatten)]
        body: BodySource,
    },
    /// The agreements of the rows named, in the order named.
    Find {
        /// The connector id.
        id: String,
        /// The item ids.
        #[arg(required = true)]
        items: Vec<String>,
    },
    /// The agreements, the one written longest ago first.
    List {
        /// The connector id.
        id: String,
        /// Only the ones waiting to be carried to the vendor, or only the
        /// others.
        #[arg(long)]
        waiting: Option<bool>,
        #[command(flatten)]
        page: PageArgs,
    },
}

#[derive(Debug, Subcommand)]
pub enum EndpointsCommand {
    /// Make an endpoint. Its address is shown in full this once. The
    /// connector's own key, or the operator key.
    Create {
        /// The connector id.
        id: String,
        /// What the endpoint is for.
        #[arg(long)]
        label: Option<String>,
        /// A header whose value names a delivery, such as
        /// X-GitHub-Delivery, so a repeat is marked as one.
        #[arg(long, value_name = "HEADER")]
        duplicate_header: Option<String>,
    },
    /// A connector's endpoints, newest first, each address redacted.
    List {
        /// The connector id.
        id: String,
    },
    /// Retire an endpoint: its address stops answering.
    Retire {
        /// The connector id.
        id: String,
        /// The endpoint id.
        endpoint: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum DeliveryState {
    Pending,
    Handled,
    Any,
}

impl DeliveryState {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryState::Pending => "pending",
            DeliveryState::Handled => "handled",
            DeliveryState::Any => "any",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum DeliveryOutcome {
    Processed,
    Duplicate,
    Rejected,
}

impl DeliveryOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryOutcome::Processed => "processed",
            DeliveryOutcome::Duplicate => "duplicate",
            DeliveryOutcome::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum DeliveriesCommand {
    /// A connector's deliveries, oldest first, the unhandled ones unless
    /// --state says otherwise.
    List {
        /// The connector id.
        id: String,
        /// Which deliveries: not yet handled, handled, or both.
        #[arg(long, value_enum)]
        state: Option<DeliveryState>,
        /// Only what this endpoint received.
        #[arg(long, value_name = "ENDPOINT")]
        endpoint: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// A delivery's body, byte for byte.
    Body {
        /// The connector id.
        id: String,
        /// The delivery id.
        delivery: String,
        /// Where to write the bytes. Omitted, they go to stdout.
        #[arg(long, value_name = "PATH")]
        output: Option<PathBuf>,
    },
    /// Mark deliveries handled. The first mark stands.
    Handle {
        /// The connector id.
        id: String,
        /// The delivery ids.
        #[arg(required = true)]
        deliveries: Vec<String>,
        /// What the connector made of them.
        #[arg(long, value_enum)]
        outcome: DeliveryOutcome,
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

pub fn endpoint_create_request(
    id: &str,
    label: Option<&str>,
    duplicate_header: Option<&str>,
) -> Request {
    let mut body = Map::new();
    insert_opt(&mut body, "label", label.map(str::to_string));
    insert_opt(
        &mut body,
        "duplicate_header",
        duplicate_header.map(str::to_string),
    );
    Request::post(&["connectors", id, "endpoints"]).json(Value::Object(body))
}

pub fn deliveries_request(
    id: &str,
    state: Option<DeliveryState>,
    endpoint: Option<&str>,
    page: &PageArgs,
) -> Request {
    Request::get(&["connectors", id, "deliveries"])
        .query_opt("state", state.map(DeliveryState::as_str))
        .query_opt("endpoint_id", endpoint)
        .query_opt("limit", page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", page.cursor.clone())
}

pub fn delivery_body_request(id: &str, delivery: &str) -> Request {
    Request::get(&["connectors", id, "deliveries", delivery, "body"]).streamed()
}

pub fn handle_request(id: &str, deliveries: &[String], outcome: DeliveryOutcome) -> Request {
    Request::post(&["connectors", id, "deliveries", "handled"])
        .json(json!({ "ids": deliveries, "outcome": outcome.as_str() }))
}

pub fn hold_request(id: &str, process: &str) -> Request {
    Request::post(&["connectors", id, "hold"]).json(json!({ "process": process }))
}

pub fn release_request(id: &str, process: &str) -> Request {
    Request::delete(&["connectors", id, "hold"]).query("process", process)
}

pub fn state_put_request(id: &str, process: &str, state: Value) -> Result<Request, CliError> {
    if !state.is_object() {
        return Err(CliError::Invalid(
            "a connector's state document is a JSON object".into(),
        ));
    }
    Ok(Request::put(&["connectors", id, "state"])
        .json(json!({ "process": process, "state": state })))
}

pub fn agreements_write_request(
    id: &str,
    process: &str,
    batch: Value,
) -> Result<Request, CliError> {
    let Value::Object(mut body) = batch else {
        return Err(CliError::Invalid(
            "agreements are a JSON object with `set` and `clear`".into(),
        ));
    };
    if body.contains_key("process") {
        return Err(CliError::Invalid(
            "name the process with --process, not as `process` in --body".into(),
        ));
    }
    body.insert("process".into(), Value::String(process.to_string()));
    Ok(Request::post(&["connectors", id, "agreements"]).json(Value::Object(body)))
}

pub fn agreements_find_request(id: &str, items: &[String]) -> Request {
    Request::post(&["connectors", id, "agreements", "find"]).json(json!({ "item_ids": items }))
}

pub fn agreements_list_request(id: &str, waiting: Option<bool>, page: &PageArgs) -> Request {
    Request::get(&["connectors", id, "agreements"])
        .query_opt("waiting", waiting.map(|waiting| waiting.to_string()))
        .query_opt("limit", page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", page.cursor.clone())
}

fn state(command: StateCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match command {
        StateCommand::Get { id } => Request::get(&["connectors", &id, "state"]),
        StateCommand::Put { id, process, body } => state_put_request(&id, &process, body.read()?)?,
        StateCommand::Clear { id } => Request::delete(&["connectors", &id, "state"]),
    };
    out.value(&remote.json(&request)?)
}

fn agreements(command: AgreementsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match command {
        AgreementsCommand::Write { id, process, body } => {
            agreements_write_request(&id, &process, body.read()?)?
        }
        AgreementsCommand::Find { id, items } => agreements_find_request(&id, &items),
        AgreementsCommand::List { id, waiting, page } => {
            agreements_list_request(&id, waiting, &page)
        }
    };
    out.value(&remote.json(&request)?)
}

fn endpoints(command: EndpointsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        EndpointsCommand::Create {
            id,
            label,
            duplicate_header,
        } => {
            let mut made = remote.json(&endpoint_create_request(
                &id,
                label.as_deref(),
                duplicate_header.as_deref(),
            ))?;
            // The one answer that carries the address: joined to the
            // instance this command reached, for pasting into a sender.
            if let Some(path) = made.get("path").and_then(Value::as_str) {
                let url = format!("{}{path}", remote.url().trim_end_matches('/'));
                if let Some(object) = made.as_object_mut() {
                    object.insert("url".into(), Value::String(url));
                }
            }
            out.value(&made)
        }
        EndpointsCommand::List { id } => {
            out.value(&remote.json(&Request::get(&["connectors", &id, "endpoints"]))?)
        }
        EndpointsCommand::Retire { id, endpoint } => {
            out.value(&remote.json(&Request::delete(&[
                "connectors",
                &id,
                "endpoints",
                &endpoint,
            ]))?)
        }
    }
}

fn deliveries(command: DeliveriesCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        DeliveriesCommand::List {
            id,
            state,
            endpoint,
            page,
        } => {
            out.value(&remote.json(&deliveries_request(&id, state, endpoint.as_deref(), &page))?)
        }
        DeliveriesCommand::Body {
            id,
            delivery,
            output,
        } => {
            let (_, mut reader) = remote.stream(&delivery_body_request(&id, &delivery))?;
            let written = match &output {
                Some(path) => {
                    let mut file = std::fs::File::create(path).map_err(|error| {
                        CliError::Invalid(format!("cannot write {}: {error}", path.display()))
                    })?;
                    io::copy(&mut reader, &mut file)?
                }
                None => {
                    let mut stdout = io::stdout().lock();
                    let written = io::copy(&mut reader, &mut stdout)?;
                    stdout.flush()?;
                    written
                }
            };
            // Bytes to stdout are the answer; a report there would corrupt it.
            if let Some(path) = output {
                out.report(
                    &json!({ "delivery": delivery, "path": path, "size_bytes": written }),
                    || format!("{written} byte(s) into {}", path.display()),
                )?;
            }
            Ok(())
        }
        DeliveriesCommand::Handle {
            id,
            deliveries,
            outcome,
        } => out.value(&remote.json(&handle_request(&id, &deliveries, outcome))?),
    }
}

pub fn run(command: ConnectorsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match command {
        ConnectorsCommand::Endpoints { command } => return endpoints(command, remote, out),
        ConnectorsCommand::Deliveries { command } => return deliveries(command, remote, out),
        ConnectorsCommand::State { command } => return state(command, remote, out),
        ConnectorsCommand::Agreements { command } => return agreements(command, remote, out),
        ConnectorsCommand::Register { name, description } => {
            register_request(&name, description.as_deref())
        }
        ConnectorsCommand::List => Request::get(&["connectors"]),
        ConnectorsCommand::Get { id } => Request::get(&["connectors", &id]),
        ConnectorsCommand::Delete { id } => Request::delete(&["connectors", &id]),
        ConnectorsCommand::Heartbeat { id } => Request::post(&["connectors", &id, "heartbeat"]),
        ConnectorsCommand::Report(args) => report_request(&args),
        ConnectorsCommand::Runs { id, limit } => runs_request(&id, limit),
        ConnectorsCommand::Hold { id, process } => hold_request(&id, &process),
        ConnectorsCommand::Release { id, process } => release_request(&id, &process),
    };
    out.value(&remote.json(&request)?)
}
