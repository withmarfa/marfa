use clap::Subcommand;

use super::BodySource;
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
    },
    /// Remove one namespace.
    Delete {
        /// The item id.
        id: String,
        /// The namespace, such as `app.cursor`.
        namespace: String,
    },
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
        } => write_request(id, namespace, body.read()?)?,
        ExtensionsCommand::Delete { id, namespace } => delete_request(id, namespace),
    };
    out.value(&remote.json(&request)?)
}
