use clap::{Args, Subcommand};

use super::BodySource;
use super::items::IdempotencyArgs;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum ExtensionsCommand {
    /// The extension namespaces an item carries.
    List {
        /// The item id.
        id: String,
    },
    /// One namespace's contents.
    Get {
        /// The item id.
        id: String,
        /// The namespace, such as `app.cursor`.
        namespace: String,
    },
    /// Write one namespace whole.
    Write {
        /// The item id.
        id: String,
        /// The namespace, such as `app.cursor`.
        namespace: String,
        #[command(flatten)]
        body: BodySource,
        #[command(flatten)]
        read: ReadRevisionArgs,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Remove one namespace.
    Delete {
        /// The item id.
        id: String,
        /// The namespace, such as `app.cursor`.
        namespace: String,
        #[command(flatten)]
        read: ReadRevisionArgs,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
}

#[derive(Debug, Args)]
pub struct ReadRevisionArgs {
    /// The namespace's `revision` as `extensions get` printed it. If the
    /// namespace changed since, Marfa refuses the change.
    #[arg(long, value_name = "REVISION")]
    pub read_revision: Option<String>,
}

impl ReadRevisionArgs {
    fn apply(&self, request: Request) -> Request {
        request.query_opt("read_revision", self.read_revision.clone())
    }
}

pub fn list_request(id: &str) -> Request {
    Request::get(&["items", id, "extensions"])
}

pub fn get_request(id: &str, namespace: &str) -> Request {
    Request::get(&["items", id, "extensions", namespace])
}

pub fn write_request(
    id: &str,
    namespace: &str,
    body: serde_json::Value,
) -> Result<Request, CliError> {
    if !body.is_object() {
        return Err(CliError::Invalid(
            "an extension namespace is a JSON object".into(),
        ));
    }
    Ok(Request::put(&["items", id, "extensions", namespace]).json(body))
}

pub fn delete_request(id: &str, namespace: &str) -> Request {
    Request::delete(&["items", id, "extensions", namespace])
}

pub fn run(command: ExtensionsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        ExtensionsCommand::List { id } => list_request(id),
        ExtensionsCommand::Get { id, namespace } => get_request(id, namespace),
        ExtensionsCommand::Write {
            id,
            namespace,
            body,
            read,
            idempotency,
        } => idempotency.apply(read.apply(write_request(id, namespace, body.read()?)?)),
        ExtensionsCommand::Delete {
            id,
            namespace,
            read,
            idempotency,
        } => idempotency.apply(read.apply(delete_request(id, namespace))),
    };
    let answer = remote.json(&request)?;
    match &command {
        ExtensionsCommand::Write { id, namespace, .. } => out.report(&answer, |_| {
            format!("wrote the namespace {namespace} of {id}")
        }),
        ExtensionsCommand::Delete { id, namespace, .. } => out.report(&answer, |_| {
            format!("removed the namespace {namespace} of {id}")
        }),
        _ => out.value(&answer),
    }
}
