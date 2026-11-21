use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};

use super::{PageArgs, insert_opt};
use crate::access;
use crate::error::CliError;
use crate::output::{Printer, printable, table_with_head};
use crate::remote::Remote;
use crate::remote::request::Request;

/// Outbound subscriptions that send an instance's events out.
/// Keys and apps need `webhooks.manage` and reach their own subscriptions. With
/// `keys.manage` too, list, get, deliveries and delete reach every subscription,
/// and with --socket, every command but create and update does.
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
        #[command(flatten)]
        page: PageArgs,
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
    /// Where to deliver. Named `--delivery-url` because `--url` is the server.
    #[arg(long, value_name = "URL")]
    pub delivery_url: String,
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
            .field("delivery_url", &self.delivery_url)
            .field("events", &self.events)
            .field("type_filter", &self.type_filter)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Default, Args)]
pub struct WebhookUpdateArgs {
    /// The webhook id.
    pub id: String,
    /// Where to deliver. Named `--delivery-url` because `--url` is the server.
    #[arg(long, value_name = "URL")]
    pub delivery_url: Option<String>,
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
    body.insert("url".into(), Value::String(args.delivery_url.clone()));
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
    insert_opt(&mut body, "url", args.delivery_url.clone());
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

pub fn deliveries_request(id: &str, page: &PageArgs) -> Request {
    Request::get(&["webhooks", id, "deliveries"])
        .query_opt("limit", page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", page.cursor.clone())
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
        WebhooksCommand::Deliveries { id, page } => deliveries_request(id, page),
        WebhooksCommand::Redeliver { id, delivery_id } => redeliver_request(id, delivery_id),
    };
    let all = matches!(&command, WebhooksCommand::Deliveries { page, .. } if page.all);
    let answer = remote.pages(&request, all)?;
    match &command {
        WebhooksCommand::Create(args) => out.report(&answer, |answer| created_text(answer, args)),
        WebhooksCommand::Update(_) => out.report(&answer, |answer| {
            let text = |name: &str| answer.get(name).and_then(Value::as_str).unwrap_or("");
            format!(
                "updated webhook {} ({})",
                printable(text("id")),
                printable(text("url"))
            )
        }),
        WebhooksCommand::Delete { id } => out.report(&answer, |_| format!("removed webhook {id}")),
        WebhooksCommand::List if !out.json => out.line(&listed_text(&answer)),
        _ => out.value(&answer),
    }
}

fn listed_text(answer: &Value) -> String {
    let hooks = answer
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if hooks.is_empty() {
        return "no webhooks".to_string();
    }
    let text = |value: &Value, name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let head = ["id", "url", "active", "maker"].map(String::from);
    let rows: Vec<Vec<String>> = hooks
        .iter()
        .map(|hook| {
            let active = match hook.get("active").and_then(Value::as_bool) {
                Some(true) => "on",
                Some(false) => "off",
                None => "",
            };
            let maker = hook.get("maker").unwrap_or(&Value::Null);
            let named = match text(maker, "name") {
                name if name.is_empty() => text(maker, "id"),
                name => name,
            };
            vec![
                text(hook, "id"),
                text(hook, "url"),
                active.to_string(),
                format!("{} {named}", text(maker, "kind"))
                    .trim()
                    .to_string(),
            ]
        })
        .collect();
    table_with_head(&head, &rows).join("\n")
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
            "events": ["item.created", "item.trashed"],
            "type_filter": "core.note",
            "secret": "whsec_PLAINTEXT",
            "active": true,
        })
    }

    #[test]
    fn a_listing_names_each_webhooks_maker() {
        let answer = json!({ "data": [
            { "id": "wh_1", "url": "https://receiver.example/a", "active": true,
              "maker": { "kind": "key", "id": "key_1", "name": "Backup" } },
            { "id": "wh_2", "url": "https://receiver.example/b", "active": false,
              "maker": { "kind": "app", "id": "client_1", "name": null } },
        ], "next_cursor": null });
        assert_eq!(
            listed_text(&answer),
            "id    url                         active  maker\n\
             wh_1  https://receiver.example/a  on      key Backup\n\
             wh_2  https://receiver.example/b  off     app client_1"
        );
        assert_eq!(listed_text(&json!({ "data": [] })), "no webhooks");
    }

    #[test]
    fn a_minted_secret_leads_on_its_own_line_and_is_not_in_the_description() {
        let text = created_text(&created(), &WebhookCreateArgs::default());
        assert_eq!(
            text,
            "whsec_PLAINTEXT\nwebhook wh_1 (https://receiver.example/hook); the signing secret is shown once, keep it now\n  events item.created, item.trashed\n  type filter core.note"
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
            delivery_url: "https://receiver.example/hook".into(),
            secret: Some("whsec_PLAINTEXT".into()),
            ..Default::default()
        };
        let shown = format!("{args:?}");
        assert!(!shown.contains("whsec_PLAINTEXT"), "{shown}");
        // Witness: the rest is shown.
        assert!(shown.contains("receiver.example"), "{shown}");
    }
}
