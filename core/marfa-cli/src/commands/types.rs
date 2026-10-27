use std::time::Duration;

use clap::{Args, Subcommand};
use marfa_core::ScaffoldField;
use serde_json::{Map, Value};

use super::{BodySource, object};
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
    /// Needs no server, working copy or key, sends nothing, and takes none of `--url`, `--key` and `--socket`. An id, field or parent the registry would refuse for its form is refused here with the reason. What only a server knows is left to it: whether a parent exists, and whether a key may register the type.
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
    /// Set the icon the owner wants for a type, one Marfa ships included. Reads of the type then answer it in place of the author's icon, and a subtype with no icon of its own inherits it. Needs `schema.write` and write on the type in the key's type map; a connector's key is refused. The owner's own sign-in and a local command can always set it.
    ///
    /// The icon is the kebab-case name of an icon in the Lucide release Marfa pins, such as `calendar-days`. Marfa refuses any other name.
    SetIcon {
        /// The type id.
        id: String,
        /// The Lucide icon name, such as `book-open`.
        icon: String,
    },
    /// Remove the icon the owner set for a type, so the author's shows again. Needs the same access as `set-icon`.
    ClearIcon {
        /// The type id.
        id: String,
    },
    /// Remove a registered type. Needs `schema.write` and write on the type in the key's type map. Refused while items of the type exist or a folder, view or webhook names it. `marfa types move` moves the items and changes those settings.
    Delete {
        /// The type id.
        id: String,
        /// Remove it even where items of the type exist or a setting names it, leaving both as they are.
        #[arg(long)]
        force: bool,
    },
    /// Move every item of a type, in any state, to another type. Needs write on both types in the key's type map.
    ///
    /// It moves only the items the key can see. Once no item of the type remains, the folders, views and webhooks that name it are changed to name the new one. An item the new type refuses stays where it is, and the command names it. The command waits for the move to finish, and exits with an error, saying why, when it leaves the settings unchanged: an item it couldn't move, one written while it ran, one the key can't see, or a setting it can't change. Run it again once those are dealt with.
    Move(MoveArgs),
    /// The retired platform types: shipped types this instance carries that the build no longer does. Requires `instance.read`.
    Retired,
    /// Delete one retired platform type. Requires `instance.maintain`.
    DeleteRetired {
        /// The type id.
        id: String,
    },
}

#[derive(Debug, Args)]
pub struct MoveArgs {
    /// The type the items are in now.
    pub from: String,
    /// The type to move them to.
    pub to: String,
    /// Show what would move and change, and change nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Properties to merge into every item as it moves, as a JSON object, such as a field the new type requires.
    #[arg(long, value_name = "JSON")]
    pub properties: Option<String>,
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
    Request::post(&["types", "normalize"])
        .json(definition)
        .reading()
}

pub fn replace_request(id: &str, definition: serde_json::Value) -> Request {
    Request::put(&["types", id]).json(definition)
}

pub fn delete_request(id: &str, force: bool) -> Request {
    Request::delete(&["types", id]).query_flag("force", force)
}

pub fn set_icon_request(id: &str, icon: &str) -> Request {
    Request::put(&["types", id, "icon"]).json(serde_json::json!({ "icon": icon }))
}

pub fn clear_icon_request(id: &str) -> Request {
    Request::delete(&["types", id, "icon"])
}

pub fn move_request(args: &MoveArgs) -> Result<Request, CliError> {
    let mut body = Map::new();
    body.insert("to".into(), Value::String(args.to.clone()));
    if let Some(properties) = &args.properties {
        body.insert(
            "properties".into(),
            Value::Object(object(properties, "--properties")?),
        );
    }
    let request = Request::post(&["types", &args.from, "move"]);
    Ok(if args.dry_run {
        body.insert("dry_run".into(), Value::Bool(true));
        request.json(Value::Object(body)).reading()
    } else {
        request.json(Value::Object(body))
    })
}

pub fn job_request(id: &str) -> Request {
    Request::get(&["items", "bulk-actions", "jobs", id])
}

pub fn retired_request() -> Request {
    Request::get(&["platform-types", "retired"])
}

pub fn delete_retired_request(id: &str) -> Request {
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
        TypesCommand::Move(args) => return move_type(args, &remote()?, out),
        TypesCommand::List => list_request(),
        TypesCommand::Get { id } => get_request(id),
        TypesCommand::Register(body) => register_request(body.read()?),
        TypesCommand::Normalize(body) => normalize_request(body.read()?),
        TypesCommand::Replace { id, body } => replace_request(id, body.read()?),
        TypesCommand::Delete { id, force } => delete_request(id, *force),
        TypesCommand::SetIcon { id, icon } => set_icon_request(id, icon),
        TypesCommand::ClearIcon { id } => clear_icon_request(id),
        TypesCommand::Retired => retired_request(),
        TypesCommand::DeleteRetired { id } => delete_retired_request(id),
    };
    let answer = remote()?.json(&request)?;
    match &command {
        TypesCommand::Delete { id, .. } => out.report(&answer, || format!("removed type {id}")),
        _ => out.value(&answer),
    }
}

/// How often a move's job is asked how it stands.
const JOB_POLL: Duration = Duration::from_millis(500);

fn move_type(args: &MoveArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let mut answer = remote.json(&move_request(args)?)?;
    if args.dry_run {
        return out.report(&answer, || dry_run_words(&answer));
    }
    while matches!(
        answer.get("status").and_then(Value::as_str),
        Some("queued" | "in_progress")
    ) {
        std::thread::sleep(JOB_POLL);
        answer = remote.json(&job_request(field(&answer, "id")))?;
    }
    out.report(&answer, || moved_words(args, &answer))?;
    match move_shortfall(&args.from, &answer) {
        Some(why) => Err(CliError::Invalid(why)),
        None => Ok(()),
    }
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Why a move's job left the settings naming `from` unchanged, or `None` when
/// it rewrote them.
pub fn move_shortfall(from: &str, job: &Value) -> Option<String> {
    let status = field(job, "status");
    if status != "completed" {
        return Some(format!(
            "the move {status}: {}. Run it again to move what remains.",
            field(job, "error")
        ));
    }
    let result = job.get("result").unwrap_or(&Value::Null);
    if result.get("settings_rewritten") == Some(&Value::Bool(true)) {
        return None;
    }
    let mut why = Vec::new();
    let errored = count(result, "errored");
    if errored > 0 {
        why.push(format!(
            "it couldn't move {}",
            plural(errored, "item", "items")
        ));
    }
    let remaining = count(result, "remaining");
    if remaining > 0 {
        why.push(format!(
            "{} you can see {} still {from}, counting any written while it ran",
            plural(remaining, "item", "items"),
            if remaining == 1 { "is" } else { "are" }
        ));
    }
    if result.get("remaining_hidden") == Some(&Value::Bool(true)) {
        why.push(format!(
            "items of {from} that your key can't see remain, which only a key that sees them can move"
        ));
    }
    let blocked = list(result, "settings")
        .iter()
        .filter(|setting| setting.get("reason").is_some())
        .count() as u64;
    if blocked > 0 {
        why.push(format!(
            "{} can't be changed",
            plural(blocked, "setting", "settings")
        ));
    }
    Some(format!(
        "the move left {from} in use: {}. Deal with these, then run the move again.",
        why.join("; ")
    ))
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or_default()
}

fn count(value: &Value, name: &str) -> u64 {
    value.get(name).and_then(Value::as_u64).unwrap_or_default()
}

fn list<'a>(value: &'a Value, name: &str) -> &'a [Value] {
    value
        .get(name)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

pub fn setting_line(setting: &Value) -> String {
    let id = setting
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("(one your key can't read)");
    let mut line = format!(
        "{} {id} {}",
        field(setting, "kind"),
        field(setting, "field")
    );
    if let Some(reason) = setting.get("reason").and_then(Value::as_str) {
        line.push_str(&format!(", {reason}: {}", field(setting, "message")));
    }
    line
}

fn dry_run_words(answer: &Value) -> String {
    let mut lines = vec![format!(
        "would move {} items from {} to {}",
        count(answer, "matched"),
        field(answer, "from"),
        field(answer, "to")
    )];
    let settings = list(answer, "settings");
    if !settings.is_empty() {
        lines.push("would change these settings once every item has moved:".into());
        lines.extend(
            settings
                .iter()
                .map(|setting| format!("  {}", setting_line(setting))),
        );
    }
    let grants = list(answer, "grants");
    if !grants.is_empty() {
        lines.push("these keys and apps name the type and are left as they are:".into());
        lines.extend(grants.iter().map(|grant| {
            format!(
                "  {} {} {}",
                field(grant, "kind"),
                field(grant, "id"),
                field(grant, "label")
            )
            .trim_end()
            .to_string()
        }));
    }
    lines.join("\n")
}

fn moved_words(args: &MoveArgs, job: &Value) -> String {
    let status = field(job, "status");
    let mut lines = vec![format!(
        "moved {} of {} items from {} to {}",
        count(job, "succeeded"),
        count(job, "matched"),
        args.from,
        args.to
    )];
    if status != "completed" {
        lines.push(format!("the move {status}: {}", field(job, "error")));
    }
    let result = job.get("result").unwrap_or(&Value::Null);
    let refused = list(result, "errors");
    let errored = count(result, "errored");
    if errored > 0 {
        lines.push(format!(
            "it couldn't move {}:",
            plural(errored, "item", "items")
        ));
        lines.extend(refused.iter().map(|error| {
            format!(
                "  {} {}: {}",
                field(error, "id"),
                field(error, "code"),
                field(error, "message")
            )
        }));
        let unlisted = errored.saturating_sub(refused.len() as u64);
        if unlisted > 0 {
            lines.push(format!("  and {unlisted} more"));
        }
    }
    let remaining = count(result, "remaining");
    if remaining > 0 {
        lines.push(format!(
            "{} you can see {} still {}",
            plural(remaining, "item", "items"),
            if remaining == 1 { "is" } else { "are" },
            args.from
        ));
    }
    if result.get("remaining_hidden") == Some(&Value::Bool(true)) {
        lines.push(format!(
            "items of {} that your key can't see remain, and the move left them",
            args.from
        ));
    }
    let settings = list(result, "settings");
    if result.get("settings_rewritten") == Some(&Value::Bool(true)) {
        if !settings.is_empty() {
            lines.push(format!(
                "changed {} to name {}",
                plural(settings.len() as u64, "setting", "settings"),
                args.to
            ));
        }
    } else if !settings.is_empty() {
        lines.push(format!(
            "these settings still name {}, and change once no item of it remains:",
            args.from
        ));
        lines.extend(
            settings
                .iter()
                .map(|setting| format!("  {}", setting_line(setting))),
        );
    }
    lines.join("\n")
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
