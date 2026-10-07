use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};

use super::insert_opt;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Outbound subscriptions that send an instance's events out. Every
/// operation needs `webhooks.manage`.
#[derive(Debug, Subcommand)]
pub enum WebhooksCommand {
    /// Register a subscription. The secret is answered once, in plaintext.
    Create(WebhookCreateArgs),
    /// Every subscription.
    List,
    /// One subscription by id.
    Get {
        /// The webhook id.
        id: String,
    },
    /// Change a subscription's URL, events, type filter or whether it is active.
    Update(WebhookUpdateArgs),
    /// Remove a subscription.
    Delete {
        /// The webhook id.
        id: String,
    },
    /// The deliveries a subscription was sent, newest first.
    Deliveries {
        /// The webhook id.
        id: String,
        /// How many at most.
        #[arg(long)]
        limit: Option<u32>,
    },
    /// Queue a failed delivery again using the subscription's current address.
    Redeliver {
        /// The webhook id.
        id: String,
        /// The delivery id.
        delivery_id: String,
    },
}

#[derive(Debug, Default, Args)]
pub struct WebhookCreateArgs {
    /// Where to deliver. Named `--to` rather than `--url`, which is the server.
    #[arg(long = "to", value_name = "URL")]
    pub to: String,
    /// An event name from the vocabulary, repeatable; `*` is refused.
    #[arg(long = "event", value_name = "EVENT", required = true)]
    pub events: Vec<String>,
    /// Only events for items of this type.
    #[arg(long = "type-filter", value_name = "TYPE")]
    pub type_filter: Option<String>,
    /// The secret deliveries are signed with. Omitted, the server mints one.
    #[arg(long)]
    pub secret: Option<String>,
}

#[derive(Debug, Default, Args)]
pub struct WebhookUpdateArgs {
    /// The webhook id.
    pub id: String,
    /// Where to deliver. Named `--to` rather than `--url`, which is the server.
    #[arg(long = "to", value_name = "URL")]
    pub to: Option<String>,
    /// The events, whole; repeatable.
    #[arg(long = "event", value_name = "EVENT")]
    pub events: Vec<String>,
    /// Only events for items of this type.
    #[arg(long = "type-filter", value_name = "TYPE")]
    pub type_filter: Option<String>,
    /// Resume deliveries.
    #[arg(long, conflicts_with = "inactive")]
    pub active: bool,
    /// Pause deliveries.
    #[arg(long)]
    pub inactive: bool,
}

pub fn create_request(args: &WebhookCreateArgs) -> Request {
    let mut body = Map::new();
    body.insert("url".into(), Value::String(args.to.clone()));
    body.insert("events".into(), json!(args.events));
    insert_opt(&mut body, "type_filter", args.type_filter.clone());
    insert_opt(&mut body, "secret", args.secret.clone());
    Request::post(&["webhooks"])
        .json(Value::Object(body))
        .minting()
}

pub fn list_request() -> Request {
    Request::get(&["webhooks"])
}

pub fn get_request(id: &str) -> Request {
    Request::get(&["webhooks", id])
}

pub fn update_request(args: &WebhookUpdateArgs) -> Request {
    let mut body = Map::new();
    insert_opt(&mut body, "url", args.to.clone());
    if !args.events.is_empty() {
        body.insert("events".into(), json!(args.events));
    }
    insert_opt(&mut body, "type_filter", args.type_filter.clone());
    if args.active {
        body.insert("active".into(), Value::Bool(true));
    }
    if args.inactive {
        body.insert("active".into(), Value::Bool(false));
    }
    Request::patch(&["webhooks", &args.id]).json(Value::Object(body))
}

pub fn delete_request(id: &str) -> Request {
    Request::delete(&["webhooks", id])
}

pub fn deliveries_request(id: &str, limit: Option<u32>) -> Request {
    Request::get(&["webhooks", id, "deliveries"])
        .query_opt("limit", limit.map(|limit| limit.to_string()))
}

pub fn redeliver_request(id: &str, delivery_id: &str) -> Request {
    Request::post(&["webhooks", id, "deliveries", delivery_id, "redeliver"])
}

pub fn run(command: WebhooksCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        WebhooksCommand::Create(args) => create_request(args),
        WebhooksCommand::List => list_request(),
        WebhooksCommand::Get { id } => get_request(id),
        WebhooksCommand::Update(args) => update_request(args),
        WebhooksCommand::Delete { id } => delete_request(id),
        WebhooksCommand::Deliveries { id, limit } => deliveries_request(id, *limit),
        WebhooksCommand::Redeliver { id, delivery_id } => redeliver_request(id, delivery_id),
    };
    out.value(&remote.json(&request)?)
}
