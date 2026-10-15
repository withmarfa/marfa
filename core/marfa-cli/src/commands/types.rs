use clap::{Args, Subcommand};
use marfa_core::ScaffoldField;

use super::BodySource;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum TypesCommand {
    /// Every type the instance holds.
    List,
    /// One type by id, with its schema.
    Get {
        /// The type id, such as `core.note` or `user.recipe`.
        id: String,
    },
    /// Print a starting definition for a type, ready for `types register` or `device types declare`.
    ///
    /// Needs no server, working copy or key, sends nothing, and takes neither `--url` nor `--key`. The id and the fields are checked as a registration checks them, and one that would be refused is refused here with the reason.
    ///
    /// A field is `NAME:TYPE`, given once for each field, in the order it is printed. An `enum` field takes its allowed values after a second colon, as `status:enum:open,closed`, and an `array` field the type of its elements, as `tags:array:string`.
    Scaffold(ScaffoldArgs),
    /// Register a type from its definition. Needs `metadata.types:write` and write on the type in the key's type map.
    Register(BodySource),
    /// Normalize a definition and compare it with the registered type. Any authenticated key can use this command.
    Normalize(BodySource),
    /// Replace a registered type's definition. Needs write on the type in the key's type map and `schema.write` or `metadata.types:write`.
    ///
    /// `metadata.types:write` alone covers adding optional fields that no stored row holds a value under, and changing the label, description, display hints and version. Any other change, removing a field included, needs `schema.write`.
    Replace {
        /// The type id.
        id: String,
        #[command(flatten)]
        body: BodySource,
    },
    /// Remove a registered type. Needs `schema.write` and write on the type in the key's type map.
    Delete {
        /// The type id.
        id: String,
        /// Remove it even where items of the type exist.
        #[arg(long)]
        force: bool,
    },
    /// Shipped types this instance carries that the build no longer does. Requires `instance.read`.
    Drift,
    /// Remove one shipped type the build no longer carries. Requires `instance.maintain`.
    Prune {
        /// The type id.
        id: String,
    },
}

#[derive(Debug, Args)]
pub struct ScaffoldArgs {
    /// The type id, such as `user.recipe` or `app.notes.entry`.
    id: String,
    /// A field of the type, as `NAME:TYPE`, `NAME:enum:VALUE,VALUE` or `NAME:array:TYPE`. Repeatable.
    #[arg(long = "field", value_name = "SPEC")]
    fields: Vec<String>,
    /// A field an item of the type must have. Repeatable; each names a field given with `--field`.
    #[arg(long, value_name = "NAME")]
    required: Vec<String>,
    /// The id of the type this one inherits from. A parent Marfa ships is checked against its fields; any other is taken as named.
    #[arg(long, value_name = "ID")]
    parent: Option<String>,
    /// What the type is for.
    #[arg(long, value_name = "TEXT")]
    description: Option<String>,
}

impl ScaffoldArgs {
    fn fields(&self) -> Result<Vec<ScaffoldField>, CliError> {
        let mut fields = Vec::new();
        for spec in &self.fields {
            let mut parts = spec.splitn(3, ':');
            let (name, kind, detail) =
                (parts.next().unwrap_or_default(), parts.next(), parts.next());
            let Some(kind) = kind.filter(|kind| !kind.is_empty()) else {
                return Err(CliError::Usage(format!(
                    "--field takes NAME:TYPE, such as title:string, not {spec:?}"
                )));
            };
            let mut field = ScaffoldField {
                name: name.to_string(),
                kind: kind.to_string(),
                required: false,
                enum_values: Vec::new(),
                items_type: None,
            };
            match (kind, detail) {
                ("enum", Some(values)) => {
                    field.enum_values = values.split(',').map(str::to_string).collect();
                }
                ("array", Some(items)) => field.items_type = Some(items.to_string()),
                (_, None) => {}
                (_, Some(_)) => {
                    return Err(CliError::Usage(format!(
                        "--field {spec:?} gives a third part, which only an enum (its values) and an array (its element type) take"
                    )));
                }
            }
            fields.push(field);
        }
        for name in &self.required {
            let Some(field) = fields.iter_mut().find(|field| field.name == *name) else {
                return Err(CliError::Usage(format!(
                    "--required {name} names no field given with --field"
                )));
            };
            field.required = true;
        }
        Ok(fields)
    }
}

pub fn list_request() -> Request {
    Request::get(&["types"])
}

pub fn get_request(id: &str) -> Request {
    Request::get(&["types", id])
}

pub fn register_request(definition: serde_json::Value) -> Request {
    Request::post(&["types"]).json(definition)
}

pub fn normalize_request(definition: serde_json::Value) -> Request {
    Request::post(&["types", "normalize"]).json(definition)
}

pub fn replace_request(id: &str, definition: serde_json::Value) -> Request {
    Request::put(&["types", id]).json(definition)
}

pub fn delete_request(id: &str, force: bool) -> Request {
    Request::delete(&["types", id]).query_flag("force", force)
}

pub fn drift_request() -> Request {
    Request::get(&["platform-types", "drift"])
}

pub fn prune_request(id: &str) -> Request {
    Request::delete(&["platform-types", id])
}

/// `remote` resolves the server and the credential, for the commands that
/// send: `scaffold` resolves neither.
pub fn run(
    command: TypesCommand,
    remote: impl FnOnce() -> Result<Remote, CliError>,
    out: &Printer,
) -> Result<(), CliError> {
    let request = match &command {
        TypesCommand::Scaffold(args) => return scaffold(args, out),
        TypesCommand::List => list_request(),
        TypesCommand::Get { id } => get_request(id),
        TypesCommand::Register(body) => register_request(body.read()?),
        TypesCommand::Normalize(body) => normalize_request(body.read()?),
        TypesCommand::Replace { id, body } => replace_request(id, body.read()?),
        TypesCommand::Delete { id, force } => delete_request(id, *force),
        TypesCommand::Drift => drift_request(),
        TypesCommand::Prune { id } => prune_request(id),
    };
    let answer = remote()?.json(&request)?;
    match &command {
        TypesCommand::Delete { id, .. } => out.report(&answer, || format!("removed type {id}")),
        _ => out.value(&answer),
    }
}

fn scaffold(args: &ScaffoldArgs, out: &Printer) -> Result<(), CliError> {
    let definition = marfa_core::scaffold_type(
        &args.id,
        args.parent.as_deref(),
        args.description.as_deref(),
        &args.fields()?,
    )?;
    out.raw(&format!("{}\n", serde_json::to_string_pretty(&definition)?))
}
