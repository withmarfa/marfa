use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Args, Subcommand};
use marfa_core::ScaffoldField;
use marfa_rules::schema::{
    FolderVerdict, Problem, TypeFile, check_type_files, guidance_file_name, is_guidance_file,
    is_type_file, read_guidance_file, shipped_registry,
};
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
    /// One type by id, with its schema, its guidance and the guidance of the types above it.
    Get {
        /// The type id, such as `core.note` or `user.recipe`.
        id: String,
    },
    /// Print a starting definition for a type, ready for `types register` or `device types declare`.
    ///
    /// Needs no server, working copy or key, sends nothing, and takes none of `--url`, `--key` and `--socket`. An id, field or parent the registry would refuse for its form is refused here with the reason. What only a server knows is left to it: whether a parent exists, and whether a key may register the type.
    ///
    /// A field is `NAME:TYPE`, given once for each field, in the order it is printed. An `enum` field takes its allowed values after a second colon, as `effort:enum:easy,hard`, an `array` field the type of its elements, as `tags:array:string`, and a `status` field its words, each with its group, as `stage:status:open=not_started,closed=completed`. The groups are `not_started`, `in_progress`, `completed` and `canceled`. A type that inherits a status field may give it without words, or with only the words it adds.
    Scaffold(ScaffoldArgs),
    /// Check a folder of type definitions the way a server checks each at registration, with no server.
    ///
    /// Reads each `*.json` file directly in the folder (not its subfolders, and not a file whose name starts with a dot) as an item type definition, in the body `types register --file` sends. The file is named `ID.json`, after the type's `id`. The Markdown file beside it with the same name (`ID.md`) is read as the type's `guidance`, as `register --file` reads it: UTF-8 with no byte-order mark, trailing whitespace removed, and no `guidance` also in the definition. A `.md` file named for a type with no `ID.json` beside it is refused. Other files are ignored. An edge type is not checked.
    ///
    /// Needs no server, key or keychain, sends nothing, and takes none of `--url`, `--key`, `--profile` and `--socket`. Each type is judged with the registration rules that need no instance, against the types Marfa ships and the types of the folder that passed before it: a type goes after the folder types it names, as its `parent`, in a `compatible_with` list of strings or in a table column's `type_constraints`, except a type that names itself and the types in a loop. A file refused for any reason supplies no type to the others. Types that name one another in a loop cannot be registered in any order, so each is judged with the others absent, which is the answer a server gives whichever it is given first. Every problem is reported, each with its file, its path in the definition, and the code and message a server gives for that file; a type whose parent or other named type is absent also says why, beside the server's answer. The command reports its own codes, `file_name_mismatch`, `file_unreadable`, `guidance_file_unreadable`, `guidance_named_twice` and `guidance_file_without_definition`, first. What only an instance knows is left to it: whether the type already exists, what a key may register, and the body size an instance allows. Exits 1 when any file is refused or none is found, and 2 when the path is not a folder.
    Check(CheckArgs),
    /// Register a type from its definition. Needs `metadata.types:write` and write on the type in the key's type map, and `schema.write` for a type that carries guidance.
    ///
    /// Given `--file PATH.json`, the Markdown file beside it with the same name (`PATH.md`) is sent as the type's `guidance`, with its trailing whitespace removed. A `.md` file that is not UTF-8, or that starts with a byte-order mark, is refused, and so is a definition that also names `guidance`. An empty `.md` file means no guidance. `--body` and `--file -` read no Markdown file.
    Register(BodySource),
    /// Normalize a definition and compare it with the registered type. Any authenticated key can use this command. A `PATH.md` beside `--file PATH.json` is read as guidance, as `register` reads it.
    Normalize(BodySource),
    /// Replace a registered type's definition. Needs write on the type in the key's type map and `schema.write` or `metadata.types:write`. A `PATH.md` beside `--file PATH.json` is read as guidance, as `register` reads it.
    ///
    /// A replacement without guidance removes the type's guidance, and adding, changing or removing guidance needs `schema.write`. A replacement that leaves it as it is needs nothing more.
    ///
    /// `metadata.types:write` alone covers adding optional fields that no stored item holds a value under, adding a table or an optional column, and naming an order for a table without one. It also covers changes to the type's label, plural, description, display hints and version, to field, table and column labels and descriptions, and to status word descriptions. Removing a field, table or column needs `schema.write`.
    Replace {
        /// The type id.
        id: String,
        #[command(flatten)]
        body: BodySource,
    },
    /// Set the icon the owner wants for a type, one Marfa ships included. Reads of the type then answer it in place of the author's icon, and a subtype with no icon of its own inherits it. Needs `schema.write` and write on the type in the key's type map, as replacing the type does. The owner's own sign-in and a local command can always set it.
    ///
    /// The icon is an Iconify icon ID, `<set>:<name>`, from a set and version Marfa pins: `lucide`, such as `lucide:calendar-days`, or `simple-icons` for brand marks, such as `simple-icons:github`. Marfa refuses any other value, a bare name included.
    SetIcon {
        /// The type id.
        id: String,
        /// The icon ID, such as `lucide:book-open`.
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
    /// A field of the type, as `NAME:TYPE`, `NAME:enum:VALUE,VALUE`, `NAME:array:TYPE` or `NAME:status:WORD=GROUP,WORD=GROUP`. Repeatable.
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

#[derive(Debug, Args)]
pub struct CheckArgs {
    /// The folder that holds the type definitions, one `ID.json` for each type.
    folder: PathBuf,
}

impl TypesCommand {
    pub fn is_offline(&self) -> bool {
        matches!(self, TypesCommand::Scaffold(_) | TypesCommand::Check(_))
    }
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
                status_values: Vec::new(),
            };
            match (kind, detail) {
                ("enum", Some(values)) => {
                    field.enum_values = values.split(',').map(str::to_string).collect();
                }
                ("array", Some(items)) => field.items_type = Some(items.to_string()),
                ("status", Some(words)) => {
                    for pair in words.split(',') {
                        let Some((word, group)) = pair.split_once('=') else {
                            return Err(CliError::Usage(format!(
                                "--field {spec:?} gives the status word {pair:?} with no group: write each as WORD=GROUP, such as open=not_started"
                            )));
                        };
                        field
                            .status_values
                            .push((word.to_string(), group.to_string()));
                    }
                }
                (_, None) => {}
                (_, Some(_)) => {
                    return Err(CliError::Usage(format!(
                        "--field {spec:?} gives a third part, which only an enum (its values), an array (its element type) and a status (its words with their groups) take"
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

/// `remote` resolves the server and the credential, for the commands that
/// send: `scaffold` and `check` resolve neither.
pub fn run(
    command: TypesCommand,
    remote: impl FnOnce() -> Result<Remote, CliError>,
    out: &Printer,
) -> Result<(), CliError> {
    let request = match &command {
        TypesCommand::Scaffold(args) => return scaffold(args, out),
        TypesCommand::Check(args) => return check(args, out),
        TypesCommand::Move(args) => return move_type(args, &remote()?, out),
        TypesCommand::List => list_request(),
        TypesCommand::Get { id } => get_request(id),
        TypesCommand::Register(body) => register_request(definition(body)?),
        TypesCommand::Normalize(body) => normalize_request(definition(body)?),
        TypesCommand::Replace { id, body } => replace_request(id, definition(body)?),
        TypesCommand::Delete { id, force } => delete_request(id, *force),
        TypesCommand::SetIcon { id, icon } => set_icon_request(id, icon),
        TypesCommand::ClearIcon { id } => clear_icon_request(id),
    };
    let answer = remote()?.json(&request)?;
    match &command {
        TypesCommand::Delete { id, .. } => out.report(&answer, |_| format!("removed type {id}")),
        TypesCommand::Register(_) => out.report(&answer, |answer| type_line("registered", answer)),
        TypesCommand::Replace { .. } => out.report(&answer, |answer| type_line("replaced", answer)),
        TypesCommand::SetIcon { id, .. } => {
            out.report(&answer, |_| format!("set the icon of type {id}"))
        }
        TypesCommand::ClearIcon { id } => {
            out.report(&answer, |_| format!("cleared the icon of type {id}"))
        }
        TypesCommand::Get { .. } if !out.json => guided(&answer, out),
        _ => out.value(&answer),
    }
}

/// The Markdown file beside `file`: the entry of its folder named exactly `<stem>.md`, followed if it is a link.
fn guidance_text(file: &Path) -> Result<Option<String>, CliError> {
    let Some(name) = file
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(guidance_file_name)
    else {
        return Ok(None);
    };
    let folder = file
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let shown = folder.join(&name).display().to_string();
    let found = folder_files(folder, |held| held == OsStr::new(&name))?;
    let Some(sibling) = found.into_iter().next() else {
        return Ok(None);
    };
    let refused = |why: String| {
        CliError::Invalid(format!(
            "cannot read {shown} as guidance (guidance_file_unreadable): {why}"
        ))
    };
    let bytes = sibling.content.map_err(refused)?;
    read_guidance_file(&bytes)
        .map(Some)
        .map_err(|fault| refused(fault.message(&shown)))
}

fn definition(body: &BodySource) -> Result<Value, CliError> {
    let mut definition = body.read()?;
    let Some(file) = body.file.as_deref() else {
        return Ok(definition);
    };
    let (Some(text), Value::Object(held)) = (guidance_text(file)?, &mut definition) else {
        return Ok(definition);
    };
    if held.contains_key("guidance") {
        return Err(CliError::Invalid(format!(
            "the definition names guidance and the Markdown file beside {} holds it too (guidance_named_twice). Keep it in one place.",
            file.display()
        )));
    }
    if !text.is_empty() {
        held.insert("guidance".into(), Value::String(text));
    }
    Ok(definition)
}

fn guided(answer: &Value, out: &Printer) -> Result<(), CliError> {
    let mut rest = answer.clone();
    let own = rest
        .as_object_mut()
        .and_then(|held| held.remove("guidance"));
    let above = rest
        .as_object_mut()
        .and_then(|held| held.remove("ancestor_guidance"));
    out.value(&rest)?;
    if let Some(text) = own.as_ref().and_then(Value::as_str) {
        out.line(&format!(
            "\nguidance:\n{}",
            crate::output::printable_lines(text)
        ))?;
    }
    for entry in above
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        out.line(&format!(
            "\nguidance of {}:\n{}",
            crate::output::printable(field(entry, "type")),
            crate::output::printable_lines(field(entry, "guidance"))
        ))?;
    }
    Ok(())
}

fn type_line(verb: &str, answer: &Value) -> String {
    let text = |name: &str| answer.get(name).and_then(Value::as_str).unwrap_or("");
    let label = match text("label") {
        "" => String::new(),
        label => format!(" \"{}\"", crate::output::printable(label)),
    };
    format!(
        "{verb} type {}{label} (version {})",
        crate::output::printable(text("id")),
        answer.get("version").and_then(Value::as_u64).unwrap_or(0)
    )
}

/// How often a move's job is asked how it stands.
const JOB_POLL: Duration = Duration::from_millis(500);

fn move_type(args: &MoveArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let mut answer = remote.json(&move_request(args)?)?;
    if args.dry_run {
        return out.report(&answer, dry_run_words);
    }
    while matches!(
        answer.get("status").and_then(Value::as_str),
        Some("queued" | "in_progress")
    ) {
        std::thread::sleep(JOB_POLL);
        answer = remote.json(&job_request(field(&answer, "id")))?;
    }
    out.report(&answer, |answer| moved_words(args, answer))?;
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

/// The files of `folder` that `wanted` names, read as the folder check and `register --file` both read them: a link is followed, a folder or anything else that is not a regular file at a Markdown name is a file that cannot be read, and one at a definition's name is left alone.
fn folder_files(folder: &Path, wanted: impl Fn(&OsStr) -> bool) -> Result<Vec<TypeFile>, CliError> {
    let cannot = |error: std::io::Error| {
        CliError::Invalid(format!(
            "cannot read the folder {}: {error}",
            folder.display()
        ))
    };
    let mut files = Vec::new();
    for entry in std::fs::read_dir(folder).map_err(cannot)? {
        let entry = entry.map_err(cannot)?;
        if !wanted(&entry.file_name()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let content = match std::fs::metadata(&path) {
            Ok(held) if !held.is_file() && is_guidance_file(&name) => {
                Err("it is not a regular file".to_string())
            }
            Ok(held) if !held.is_file() => continue,
            Ok(_) => std::fs::read(&path).map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        files.push(TypeFile { name, content });
    }
    Ok(files)
}

fn type_files(folder: &Path) -> Result<Vec<TypeFile>, CliError> {
    folder_files(folder, |held| {
        let name = held.to_string_lossy();
        is_type_file(&name) || is_guidance_file(&name)
    })
}

fn problem_json(problem: &Problem) -> Value {
    let mut shown = serde_json::json!({
        "path": problem.path,
        "code": problem.code,
        "message": problem.message,
    });
    if let Some(hint) = &problem.hint {
        shown["hint"] = Value::String(hint.clone());
    }
    shown
}

fn verdict_json(verdict: &FolderVerdict) -> Value {
    let refused = verdict
        .files
        .iter()
        .filter(|file| !file.problems.is_empty())
        .count();
    let files: Vec<Value> = verdict
        .files
        .iter()
        .map(|file| {
            let mut shown = serde_json::json!({
                "file": file.file,
                "id": file.id,
                "ok": file.problems.is_empty(),
                "problems": file.problems.iter().map(problem_json).collect::<Vec<_>>(),
            });
            if let Some(context) = &file.context {
                shown["context"] = Value::String(context.clone());
            }
            shown
        })
        .collect();
    serde_json::json!({
        "ok": refused == 0,
        "checked": verdict.files.len(),
        "refused": refused,
        "files": files,
    })
}

fn verdict_words(answer: &Value) -> String {
    let mut lines = Vec::new();
    for file in answer["files"].as_array().into_iter().flatten() {
        let name = field(file, "file");
        if file["ok"] == Value::Bool(true) {
            lines.push(format!("{name}: ok"));
            continue;
        }
        lines.push(format!("{name}: refused"));
        for problem in file["problems"].as_array().into_iter().flatten() {
            let path = match field(problem, "path") {
                "" => String::new(),
                path => format!("{path}: "),
            };
            lines.push(format!(
                "  {path}{} ({})",
                field(problem, "message"),
                field(problem, "code")
            ));
            if let Some(hint) = problem.get("hint").and_then(Value::as_str) {
                lines.push(format!("    {hint}"));
            }
        }
        if let Some(context) = file.get("context").and_then(Value::as_str) {
            lines.push(format!("  {context}"));
        }
    }
    let checked = count(answer, "checked");
    let refused = count(answer, "refused");
    lines.push(if refused == 0 {
        format!("checked {}: all pass", plural(checked, "file", "files"))
    } else {
        format!(
            "checked {}: {refused} refused",
            plural(checked, "file", "files")
        )
    });
    lines.join("\n")
}

fn no_definitions(folder: &Path) -> CliError {
    CliError::Invalid(format!("no *.json files found in {}", folder.display()))
}

fn check(args: &CheckArgs, out: &Printer) -> Result<(), CliError> {
    let folder = &args.folder;
    match std::fs::metadata(folder) {
        Err(error) => {
            return Err(CliError::Usage(format!(
                "cannot read {}: {error}",
                folder.display()
            )));
        }
        Ok(held) if !held.is_dir() => {
            return Err(CliError::Usage(format!(
                "{} is not a folder: name the folder that holds the type definitions",
                folder.display()
            )));
        }
        Ok(_) => {}
    }
    let files = type_files(folder)?;
    let verdict = check_type_files(
        &files,
        &shipped_registry().map_err(marfa_core::CoreError::from)?,
    )
    .map_err(marfa_core::CoreError::from)?;
    let found_definitions = files.iter().any(|file| is_type_file(&file.name));
    if verdict.files.is_empty() && !found_definitions {
        return Err(no_definitions(folder));
    }
    let answer = verdict_json(&verdict);
    out.report(&answer, verdict_words)?;
    if !found_definitions {
        return Err(no_definitions(folder));
    }
    match count(&answer, "refused") {
        0 => Ok(()),
        refused => Err(CliError::Invalid(format!(
            "{} of {} refused, with {}",
            plural(refused, "file", "files"),
            verdict.files.len(),
            plural(verdict.problem_count() as u64, "problem", "problems")
        ))),
    }
}

#[cfg(test)]
mod said_tests {
    use super::{MoveArgs, dry_run_words, moved_words};
    use crate::output::said;
    use serde_json::json;

    const FORGED: &str = "fine\nwould move 0 items from user.a to user.b\u{1b}[2K";

    fn only_drawn(text: &str) -> bool {
        !text.contains('\u{1b}') && !text.contains('\r')
    }

    #[test]
    fn a_dry_run_cannot_start_a_line_from_a_key_label_or_a_setting_message() {
        let answer = json!({
            "matched": 2, "from": "user.a", "to": "user.b",
            "settings": [{"kind": "view", "id": "v1", "field": "type",
                          "reason": "unreadable", "message": FORGED}],
            "grants": [{"kind": "key", "id": "k1", "label": FORGED}],
        });
        let text = said(&answer, dry_run_words);
        assert!(only_drawn(&text), "{text:?}");
        assert_eq!(text.lines().count(), 5, "{text:?}");
        assert!(text.contains("fine\\u{a}would move 0 items"), "{text:?}");
    }

    #[test]
    fn a_finished_move_cannot_start_a_line_from_a_stored_message() {
        let args = MoveArgs {
            from: "user.a".into(),
            to: "user.b".into(),
            dry_run: false,
            properties: None,
        };
        let job = json!({
            "status": "failed", "error": FORGED, "matched": 1, "succeeded": 0,
            "result": {"errored": 1, "errors": [{"id": "i1", "code": "refused", "message": FORGED}]},
        });
        let text = said(&job, |job| moved_words(&args, job));
        assert!(only_drawn(&text), "{text:?}");
        assert_eq!(text.lines().count(), 4, "{text:?}");
    }
}

#[cfg(test)]
mod guidance_file_tests {
    use super::{BodySource, definition};
    use serde_json::{Value, json};

    fn source(
        dir: &std::path::Path,
        name: &str,
        json: &str,
        markdown: Option<&[u8]>,
    ) -> BodySource {
        let path = dir.join(name);
        std::fs::write(&path, json).unwrap();
        if let Some(markdown) = markdown {
            std::fs::write(path.with_extension("md"), markdown).unwrap();
        }
        BodySource {
            file: Some(path),
            body: None,
        }
    }

    const TYPE: &str = r#"{"id": "user.note", "fields": {}}"#;

    #[test]
    fn the_markdown_file_beside_the_json_is_sent_as_guidance_without_its_final_newline() {
        let dir = tempfile::tempdir().unwrap();
        let body = source(
            dir.path(),
            "user.note.json",
            TYPE,
            Some("Use it.\n\nTwo parts.\n".as_bytes()),
        );
        assert_eq!(
            definition(&body).unwrap(),
            json!({"id": "user.note", "fields": {}, "guidance": "Use it.\n\nTwo parts."})
        );
    }

    #[test]
    fn a_json_file_with_no_markdown_beside_it_is_sent_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let body = source(dir.path(), "user.note.json", TYPE, None);
        assert_eq!(
            definition(&body).unwrap(),
            json!({"id": "user.note", "fields": {}})
        );
        let inline = BodySource {
            file: None,
            body: Some(TYPE.into()),
        };
        assert!(definition(&inline).unwrap().get("guidance").is_none());
    }

    #[test]
    fn an_empty_markdown_file_is_no_guidance() {
        let dir = tempfile::tempdir().unwrap();
        let body = source(dir.path(), "user.note.json", TYPE, Some(b"\n \n"));
        assert!(definition(&body).unwrap().get("guidance").is_none());
    }

    #[test]
    fn a_definition_that_names_guidance_beside_a_markdown_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let body = source(
            dir.path(),
            "user.note.json",
            r#"{"id": "user.note", "fields": {}, "guidance": "x"}"#,
            Some(b"Use it."),
        );
        let refused = definition(&body).unwrap_err().to_string();
        assert!(refused.contains("Keep it in one place"), "{refused}");
        let alone = source(
            dir.path(),
            "user.other.json",
            r#"{"id": "user.other", "fields": {}, "guidance": "x"}"#,
            None,
        );
        assert_eq!(definition(&alone).unwrap()["guidance"], Value::from("x"));
    }

    #[test]
    fn a_markdown_file_that_is_not_utf8_or_starts_with_a_byte_order_mark_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("user.a.json", &b"\xEF\xBB\xBFUse it."[..]),
            ("user.b.json", &b"Use \xFF it."[..]),
        ] {
            let body = source(dir.path(), name, TYPE, Some(bytes));
            let refused = definition(&body).unwrap_err().to_string();
            assert!(
                refused.contains("byte-order mark") || refused.contains("not UTF-8"),
                "{refused}"
            );
        }
        let witness = source(
            dir.path(),
            "user.c.json",
            TYPE,
            Some("Use it. é 😀".as_bytes()),
        );
        assert_eq!(definition(&witness).unwrap()["guidance"], "Use it. é 😀");
    }

    fn named(dir: &std::path::Path, name: &str) -> BodySource {
        let path = dir.join(name);
        std::fs::write(&path, TYPE).unwrap();
        BodySource {
            file: Some(path),
            body: None,
        }
    }

    #[test]
    fn a_markdown_name_that_differs_by_case_is_not_the_guidance_file() {
        let dir = tempfile::tempdir().unwrap();
        let body = named(dir.path(), "user.note.json");
        std::fs::write(dir.path().join("user.note.MD"), "Use it.").unwrap();
        assert!(definition(&body).unwrap().get("guidance").is_none());
        let witness = source(dir.path(), "user.other.json", TYPE, Some(b"Use it."));
        assert_eq!(definition(&witness).unwrap()["guidance"], "Use it.");
    }

    #[cfg(unix)]
    #[test]
    fn a_markdown_link_is_followed_and_a_dangling_one_or_a_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::write(elsewhere.path().join("text.md"), "Use it.").unwrap();
        let body = named(dir.path(), "user.note.json");
        let link = dir.path().join("user.note.md");
        std::os::unix::fs::symlink(elsewhere.path().join("text.md"), &link).unwrap();
        assert_eq!(definition(&body).unwrap()["guidance"], "Use it.");
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(elsewhere.path().join("missing.md"), &link).unwrap();
        let refused = definition(&body).unwrap_err().to_string();
        assert!(refused.contains("guidance_file_unreadable"), "{refused}");
        std::fs::remove_file(&link).unwrap();
        std::fs::create_dir(&link).unwrap();
        let refused = definition(&body).unwrap_err().to_string();
        assert!(refused.contains("guidance_file_unreadable"), "{refused}");
        assert!(refused.contains("not a regular file"), "{refused}");
    }

    #[test]
    fn an_unreadable_markdown_file_is_refused_before_the_definition_is_found_to_name_guidance() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("user.a.json", &b"\xEF\xBB\xBF"[..]),
            ("user.b.json", &b"\xFF"[..]),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, r#"{"id": "user.x", "fields": {}, "guidance": "x"}"#).unwrap();
            std::fs::write(path.with_extension("md"), bytes).unwrap();
            let body = BodySource {
                file: Some(path),
                body: None,
            };
            let refused = definition(&body).unwrap_err().to_string();
            assert!(refused.contains("guidance_file_unreadable"), "{refused}");
        }
        let empty = source(
            dir.path(),
            "user.c.json",
            r#"{"id": "user.x", "fields": {}, "guidance": "x"}"#,
            Some(b""),
        );
        let refused = definition(&empty).unwrap_err().to_string();
        assert!(refused.contains("guidance_named_twice"), "{refused}");
    }
}
