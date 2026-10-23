use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};

use super::insert_opt;
use crate::access;
use crate::error::CliError;
use crate::output::{Printer, printable};
use crate::remote::Remote;
use crate::remote::request::Request;

/// Outbound subscriptions that send an instance's events out.
/// Keys and apps need `webhooks.manage` and reach only their own subscriptions.
/// With --socket, list, get, deliveries and redeliver reach every subscription.
#[derive(Debug, Subcommand)]
pub enum WebhooksCommand {
    /// Register a subscription. The secret is answered once, in plaintext.
    ///
    /// The secret leads the output on a line of its own, as `keys create`
    /// leads with a new key, and with `--json` it is the `secret` field. A
    /// secret given with `--secret` is not printed back.
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

#[derive(Default, Args)]
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

impl std::fmt::Debug for WebhookCreateArgs {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebhookCreateArgs")
            .field("to", &self.to)
            .field("events", &self.events)
            .field("type_filter", &self.type_filter)
            .finish_non_exhaustive()
    }
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
    let answer = remote.json(&request)?;
    match &command {
        WebhooksCommand::Create(args) => out.report(&answer, || created_text(&answer, args)),
        _ => out.value(&answer),
    }
}

/// A created webhook, with the secret it answered on a line of its own,
/// above the rest, as `keys create` leads with a new key. The secret is not
/// in the description of the webhook, and a secret the caller supplied is
/// not printed back.
fn created_text(answer: &Value, args: &WebhookCreateArgs) -> String {
    let field = |name: &str| answer.get(name).and_then(Value::as_str).unwrap_or("");
    let events: Vec<&str> = answer
        .get("events")
        .and_then(Value::as_array)
        .map(|events| events.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut lines = vec![format!("events {}", printable(&events.join(", ")))];
    if let Some(filter) = answer.get("type_filter").and_then(Value::as_str) {
        lines.push(format!("type filter {}", printable(filter)));
    }
    let named = format!(
        "webhook {} ({})",
        printable(field("id")),
        printable(field("url"))
    );
    let first = if args.secret.is_some() {
        format!("{named}; deliveries are signed with the secret you gave")
    } else {
        format!(
            "{}\n{named}; the signing secret is shown once, keep it now",
            printable(field("secret"))
        )
    };
    access::indented(&first, &lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn created() -> Value {
        json!({
            "id": "wh_1",
            "url": "https://receiver.example/hook",
            "events": ["item.created", "item.deleted"],
            "type_filter": "core.note",
            "secret": "whsec_PLAINTEXT",
            "active": true,
        })
    }

    #[test]
    fn a_minted_secret_leads_on_its_own_line_and_is_not_in_the_description() {
        let text = created_text(&created(), &WebhookCreateArgs::default());
        assert_eq!(
            text,
            "whsec_PLAINTEXT\nwebhook wh_1 (https://receiver.example/hook); the signing secret is shown once, keep it now\n  events item.created, item.deleted\n  type filter core.note"
        );
        assert_eq!(text.matches("whsec_PLAINTEXT").count(), 1);
    }

    #[test]
    fn a_secret_the_caller_gave_is_not_printed_back() {
        let args = WebhookCreateArgs {
            secret: Some("whsec_PLAINTEXT".into()),
            ..Default::default()
        };
        let text = created_text(&created(), &args);
        assert!(!text.contains("whsec_PLAINTEXT"), "{text}");
        assert!(text.contains("the secret you gave"), "{text}");
    }

    #[test]
    fn no_debug_shows_the_secret() {
        let args = WebhookCreateArgs {
            to: "https://receiver.example/hook".into(),
            secret: Some("whsec_PLAINTEXT".into()),
            ..Default::default()
        };
        let shown = format!("{args:?}");
        assert!(!shown.contains("whsec_PLAINTEXT"), "{shown}");
        // Witness: the rest is shown.
        assert!(shown.contains("receiver.example"), "{shown}");
    }
}
