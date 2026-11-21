//! A plugin: the source folder it is written in, the bundle that installs it, the index a
//! release lists, and what a newer version of an installed plugin may change.

use std::collections::{BTreeSet, HashMap};

use serde_json::{Map, Value, json};

use crate::error::RuleError;
use crate::schema::{
    EdgeIssues, FolderVerdict, Judging, Obj, Problem, Registry, TypeFile, check_plugin_type_files,
    edge_id, edge_type_from_request, icon_issue, is_guidance_file, is_type_file, request_shape,
    unread_edge_keys,
};

/// The bundle format this build reads and writes.
pub const FORMAT: u64 = 1;
/// The source folder's identity file.
pub const MANIFEST: &str = "plugin.json";
/// The source folder's type definitions, each `<id>.json` with its guidance in `<id>.md`.
pub const TYPES: &str = "types";
/// The source folder's edge types, each `<id>.json`.
pub const EDGE_TYPES: &str = "edge-types";
/// A bundle's file name is the plugin's name followed by this.
pub const BUNDLE_SUFFIX: &str = ".plugin.json";
/// The release asset that lists every plugin's bundle.
pub const INDEX: &str = "plugins.json";
/// The version of a development build: a bundle built with no version, or a server that accepts any `marfa`.
pub const DEVELOPMENT: &str = "0.0.0";
/// The roots no plugin's type may sit under.
pub const RESERVED_ROOTS: [&str; 5] = ["core", "system", "marfa", "app", "user"];
/// The identity fields `plugin.json` holds, and a bundle carries as they are.
pub const IDENTITY: [&str; 6] = ["name", "title", "description", "mark", "maker", "marfa"];
/// The longest name, title or maker.
pub const NAME_CAP: usize = 64;
pub const TITLE_CAP: usize = 100;
pub const DESCRIPTION_CAP: usize = 300;

const CONNECTOR: &str = "connector";
const BUNDLE_KEYS: [&str; 11] = [
    "format",
    "name",
    "title",
    "description",
    "mark",
    "maker",
    "marfa",
    "version",
    "types",
    "edge_types",
    CONNECTOR,
];

/// A release version, `MAJOR.MINOR.PATCH`, compared by its numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u64, pub u64, pub u64);

impl Version {
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.split('.');
        let mut next = || -> Option<u64> {
            let part = parts.next()?;
            let simple = !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'));
            simple.then(|| part.parse().ok()).flatten()
        };
        let version = Version(next()?, next()?, next()?);
        parts.next().is_none().then_some(version)
    }

    pub fn is_development(self) -> bool {
        self == Version(0, 0, 0)
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Whether `name` is a plugin name: lowercase words and numbers joined by hyphens, starting with a word.
pub fn is_name(name: &str) -> bool {
    name.len() <= NAME_CAP
        && name.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
}

/// The reserved root a plugin's type `id` sits under, if any.
pub fn reserved_root(id: &str) -> Option<&'static str> {
    let root = id.split('.').next()?;
    RESERVED_ROOTS.iter().copied().find(|held| *held == root)
}

pub fn reserved_message(root: &str) -> String {
    format!(
        "A plugin's types cannot sit under {root}.*, which is kept for Marfa, apps or the owner. Name them under common.* or the plugin's own root."
    )
}

/// Whether a server at `server` takes a plugin that needs `marfa`: a development server takes any.
pub fn server_takes(server: Version, marfa: Version) -> bool {
    server.is_development() || marfa <= server
}

fn fault(path: impl Into<String>, code: &'static str, message: impl Into<String>) -> Problem {
    Problem {
        path: path.into(),
        code,
        message: message.into(),
        hint: None,
    }
}

fn text_field(object: &Obj, key: &str, cap: usize, faults: &mut Vec<Problem>) {
    match object.get(key) {
        None => faults.push(fault(
            key,
            "missing_required_field",
            format!("{key} is required"),
        )),
        Some(Value::String(text)) if !text.trim().is_empty() && text.chars().count() <= cap => {}
        Some(_) => faults.push(fault(
            key,
            "validation_error",
            format!("{key} must be text of 1 to {cap} characters"),
        )),
    }
}

/// What is wrong with a plugin's identity fields, as `plugin.json` or a bundle holds them.
fn identity_faults(object: &Obj) -> Vec<Problem> {
    let mut faults = Vec::new();
    match object.get("name") {
        None => faults.push(fault(
            "name",
            "missing_required_field",
            "name is required",
        )),
        Some(Value::String(name)) if is_name(name) => {}
        Some(_) => faults.push(fault(
            "name",
            "validation_error",
            format!(
                "name must be lowercase words and numbers joined by hyphens, starting with a word, at most {NAME_CAP} characters"
            ),
        )),
    }
    text_field(object, "title", TITLE_CAP, &mut faults);
    text_field(object, "description", DESCRIPTION_CAP, &mut faults);
    text_field(object, "maker", NAME_CAP, &mut faults);
    match object.get("mark") {
        None => faults.push(fault("mark", "missing_required_field", "mark is required")),
        Some(mark) => {
            if let Some(issue) = icon_issue(Some(mark), "mark") {
                faults.push(fault("mark", "invalid_schema", issue.message()));
            }
        }
    }
    version_field(object, "marfa", &mut faults);
    if let Some(connector) = object.get(CONNECTOR)
        && !connector.is_object()
    {
        faults.push(fault(
            CONNECTOR,
            "validation_error",
            "connector must be an object",
        ));
    }
    faults
}

fn version_field(object: &Obj, key: &str, faults: &mut Vec<Problem>) {
    match object.get(key) {
        None => faults.push(fault(
            key,
            "missing_required_field",
            format!("{key} is required"),
        )),
        Some(Value::String(text)) if Version::parse(text).is_some() => {}
        Some(_) => faults.push(fault(
            key,
            "validation_error",
            format!("{key} must be a release version such as 1.2.3"),
        )),
    }
}

fn list_of_objects<'a>(object: &'a Obj, key: &str, faults: &mut Vec<Problem>) -> Vec<&'a Obj> {
    match object.get(key) {
        None => {
            faults.push(fault(
                key,
                "missing_required_field",
                format!("{key} is required"),
            ));
            Vec::new()
        }
        Some(Value::Array(entries)) => {
            let mut held = Vec::new();
            for (at, entry) in entries.iter().enumerate() {
                match entry.as_object() {
                    Some(entry) => held.push(entry),
                    None => faults.push(fault(
                        format!("{key}.{at}"),
                        "validation_error",
                        format!("Each entry of {key} must be an object"),
                    )),
                }
            }
            held
        }
        Some(_) => {
            faults.push(fault(
                key,
                "validation_error",
                format!("{key} must be an array"),
            ));
            Vec::new()
        }
    }
}

/// What is wrong with a bundle's shape, before any of its types is judged: its keys, format,
/// identity, version, the shape of its lists, an id named twice and a type under a reserved root.
pub fn bundle_faults(bundle: &Obj) -> Vec<Problem> {
    let mut faults: Vec<Problem> = bundle
        .keys()
        .filter(|key| !BUNDLE_KEYS.contains(&key.as_str()))
        .map(|key| {
            fault(
                key.as_str(),
                "validation_error",
                format!("A plugin bundle holds no {key}"),
            )
        })
        .collect();
    match bundle.get("format") {
        Some(format) if format.as_u64() == Some(FORMAT) => {}
        Some(_) => faults.push(fault(
            "format",
            "validation_error",
            format!("format must be {FORMAT}, the bundle format this server reads"),
        )),
        None => faults.push(fault(
            "format",
            "missing_required_field",
            "format is required",
        )),
    }
    faults.extend(identity_faults(bundle));
    version_field(bundle, "version", &mut faults);
    let types = list_of_objects(bundle, "types", &mut faults);
    let mut seen = BTreeSet::new();
    for (at, definition) in types.iter().enumerate() {
        let Some(id) = definition.get("id").and_then(Value::as_str) else {
            faults.push(fault(
                format!("types.{at}.id"),
                "missing_required_field",
                "Each type names its id",
            ));
            continue;
        };
        if !seen.insert(id) {
            faults.push(fault(
                format!("types.{at}.id"),
                "validation_error",
                format!("The bundle names {id} more than once"),
            ));
        }
        if let Some(root) = reserved_root(id) {
            faults.push(fault(
                format!("types.{at}.id"),
                "forbidden",
                reserved_message(root),
            ));
        }
    }
    let edge_types = list_of_objects(bundle, "edge_types", &mut faults);
    let mut seen = BTreeSet::new();
    for (at, definition) in edge_types.iter().enumerate() {
        match definition.get("id").and_then(Value::as_str) {
            Some(id) if !seen.insert(id) => faults.push(fault(
                format!("edge_types.{at}.id"),
                "validation_error",
                format!("The bundle names edge type {id} more than once"),
            )),
            Some(_) => {}
            None => faults.push(fault(
                format!("edge_types.{at}.id"),
                "missing_required_field",
                "Each edge type names its id",
            )),
        }
    }
    faults
}

/// A file in a plugin's source folder, named by its path below the folder with `/` between parts.
#[derive(Debug, Clone)]
pub struct SourceFile {
    pub path: String,
    pub content: Result<Vec<u8>, String>,
}

impl SourceFile {
    /// Whether a folder reader keeps the file at `path`: the manifest, and what sits directly in `types/` or `edge-types/`.
    pub fn wanted(path: &str) -> bool {
        path == MANIFEST
            || below(path, TYPES).is_some_and(|name| is_type_file(name) || is_guidance_file(name))
            || below(path, EDGE_TYPES).is_some_and(is_type_file)
    }
}

fn below<'a>(path: &'a str, folder: &str) -> Option<&'a str> {
    let name = path.strip_prefix(folder)?.strip_prefix('/')?;
    (!name.contains('/')).then_some(name)
}

fn read_object(path: &str, content: &Result<Vec<u8>, String>) -> Result<Obj, Problem> {
    let bytes = content.as_ref().map_err(|why| {
        fault(
            path,
            "file_unreadable",
            format!("Cannot read {path}: {why}"),
        )
    })?;
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(fault(
            path,
            "validation_error",
            format!("{path} must hold a JSON object"),
        )),
        Err(error) => Err(fault(
            path,
            "validation_error",
            format!("{path} is not valid JSON: {error}"),
        )),
    }
}

/// What a source folder holds, read but not judged.
struct Source {
    manifest: Result<Obj, Problem>,
    types: Vec<TypeFile>,
    edge_types: Vec<(String, Result<Obj, Problem>)>,
    /// Each definition file whose name is not its id's.
    misnamed: Vec<Problem>,
}

fn misnamed(folder: &str, name: &str, read: &Result<Obj, Problem>) -> Option<Problem> {
    let id = read.as_ref().ok()?.get("id")?.as_str()?;
    let path = format!("{folder}/{name}");
    (name != format!("{id}.json")).then(|| {
        fault(
            path.as_str(),
            "file_name_mismatch",
            format!("{path} must be named after its id, {folder}/{id}.json"),
        )
    })
}

fn read_source(files: &[SourceFile]) -> Source {
    let mut sorted: Vec<&SourceFile> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let manifest = sorted
        .iter()
        .find(|file| file.path == MANIFEST)
        .map_or_else(
            || {
                Err(fault(
                    MANIFEST,
                    "file_unreadable",
                    format!("The folder holds no {MANIFEST}"),
                ))
            },
            |file| read_object(MANIFEST, &file.content),
        );
    let types: Vec<TypeFile> = sorted
        .iter()
        .filter_map(|file| {
            Some(TypeFile {
                name: below(&file.path, TYPES)?.to_string(),
                content: file.content.clone(),
            })
        })
        .collect();
    let edge_types: Vec<(String, Result<Obj, Problem>)> = sorted
        .iter()
        .filter(|file| below(&file.path, EDGE_TYPES).is_some_and(is_type_file))
        .map(|file| (file.path.clone(), read_object(&file.path, &file.content)))
        .collect();
    let mut misnamed_files: Vec<Problem> = types
        .iter()
        .filter(|file| is_type_file(&file.name))
        .filter_map(|file| {
            let path = format!("{TYPES}/{}", file.name);
            misnamed(TYPES, &file.name, &read_object(&path, &file.content))
        })
        .collect();
    misnamed_files.extend(edge_types.iter().filter_map(|(path, read)| {
        misnamed(EDGE_TYPES, below(path, EDGE_TYPES)?, read)
    }));
    Source {
        manifest,
        types,
        edge_types,
        misnamed: misnamed_files,
    }
}

fn manifest_faults(manifest: &Obj) -> Vec<Problem> {
    let mut faults: Vec<Problem> = manifest
        .keys()
        .filter(|key| !IDENTITY.contains(&key.as_str()) && key.as_str() != CONNECTOR)
        .map(|key| {
            let said = if key == "version" {
                "plugin.json holds no version: a release stamps it from its tag".to_string()
            } else {
                format!("plugin.json holds no {key}")
            };
            fault(key.as_str(), "validation_error", said)
        })
        .collect();
    faults.extend(identity_faults(manifest));
    for held in &mut faults {
        held.path = format!("{MANIFEST}: {}", held.path);
    }
    faults
}

/// A source folder judged as installing it would judge it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceVerdict {
    /// What is wrong with `plugin.json` and the edge types, each path naming its file.
    pub problems: Vec<Problem>,
    /// Each file in `types/`, judged as an install registers it.
    pub types: FolderVerdict,
}

impl SourceVerdict {
    pub fn problem_count(&self) -> usize {
        self.problems.len() + self.types.problem_count()
    }
}

fn edge_type_problem(path: &str, issues: EdgeIssues) -> Problem {
    match issues {
        EdgeIssues::Missing { field } => fault(
            format!("{path}: {field}"),
            "missing_required_field",
            format!("{field} is required"),
        ),
        EdgeIssues::Validation { message, field } => fault(
            format!("{path}: {}", field.unwrap_or_default()),
            "validation_error",
            message,
        ),
        EdgeIssues::Schema(issues) => fault(
            path,
            "invalid_schema",
            issues
                .iter()
                .map(|issue| issue.message())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        EdgeIssues::Conflict { message, .. } => fault(path, "conflict", message),
    }
}

fn is_shipped_edge(id: &str) -> bool {
    crate::builtin::shipped_edge_types().is_ok_and(|held| {
        held.iter()
            .any(|edge| edge.get("id").and_then(Value::as_str) == Some(id))
    })
}

/// Judges an edge type as installing registers it, against the names `taken` already holds.
pub fn judge_edge_type(
    definition: &Obj,
    taken: &dyn Fn(&str) -> Option<String>,
) -> Result<Obj, EdgeIssues> {
    let id = definition
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if is_shipped_edge(id) {
        return Err(EdgeIssues::Conflict {
            message: format!("{id} is a core edge type and cannot be redefined"),
            field: Some("id"),
            held_by: Some(id.to_string()),
        });
    }
    request_shape(definition)?;
    if !edge_id(id) {
        return Err(EdgeIssues::Validation {
            message: "Invalid edge-type identifier".into(),
            field: Some("id".into()),
        });
    }
    if definition.contains_key("extends") || definition.contains_key("evolve_constraints") {
        return Err(EdgeIssues::Validation {
            message: "A plugin's edge type does not support `extends` or `evolve_constraints`"
                .into(),
            field: None,
        });
    }
    let unread = unread_edge_keys(definition);
    if !unread.is_empty() {
        return Err(EdgeIssues::Schema(unread));
    }
    edge_type_from_request(definition, taken, Judging::Register)
}

/// Judges a source folder as installing its bundle would, against `registry`, with no server.
pub fn check_source(files: &[SourceFile], registry: &Registry) -> Result<SourceVerdict, RuleError> {
    let source = read_source(files);
    let mut problems = match &source.manifest {
        Ok(manifest) => manifest_faults(manifest),
        Err(refused) => vec![refused.clone()],
    };
    let types = check_plugin_type_files(&source.types, registry)?;
    // A misnamed type file is in `types`, as `marfa types check` reports it.
    problems.extend(
        source
            .misnamed
            .iter()
            .filter(|held| held.path.starts_with(EDGE_TYPES))
            .cloned(),
    );
    let mut names: HashMap<String, String> = HashMap::new();
    for (path, read) in &source.edge_types {
        let definition = match read {
            Ok(definition) => definition,
            Err(refused) => {
                problems.push(refused.clone());
                continue;
            }
        };
        let id = definition.get("id").and_then(Value::as_str).unwrap_or("");
        let taken = |name: &str| names.get(name).cloned();
        match judge_edge_type(definition, &taken) {
            Ok(built) => {
                for key in ["id", "reverse_name"] {
                    if let Some(name) = built.get(key).and_then(Value::as_str) {
                        names.insert(name.to_string(), id.to_string());
                    }
                }
            }
            Err(issues) => problems.push(edge_type_problem(path, issues)),
        }
    }
    Ok(SourceVerdict { problems, types })
}

/// Builds the bundle a source folder installs as, stamped with `version`, or says what stops it.
/// It judges no type: `check_source` does.
pub fn build_bundle(files: &[SourceFile], version: &str) -> Result<Obj, Vec<Problem>> {
    let source = read_source(files);
    let mut problems = source.misnamed.clone();
    if Version::parse(version).is_none() {
        problems.push(fault(
            "version",
            "validation_error",
            "version must be a release version such as 1.2.3",
        ));
    }
    let manifest = match source.manifest {
        Ok(manifest) => {
            problems.extend(manifest_faults(&manifest));
            manifest
        }
        Err(refused) => {
            problems.push(refused);
            Obj::new()
        }
    };
    let guidance: HashMap<&str, &TypeFile> = source
        .types
        .iter()
        .filter(|file| is_guidance_file(&file.name))
        .map(|file| (file.name.as_str(), file))
        .collect();
    let mut types = Vec::new();
    for file in source.types.iter().filter(|file| is_type_file(&file.name)) {
        let path = format!("{TYPES}/{}", file.name);
        let mut definition = match read_object(&path, &file.content) {
            Ok(definition) => definition,
            Err(refused) => {
                problems.push(refused);
                continue;
            }
        };
        if let Some(name) = crate::schema::guidance_file_name(&file.name)
            && let Some(held) = guidance.get(name.as_str())
        {
            match crate::schema::joined_guidance(&mut definition, &name, held) {
                Ok(()) => {}
                Err(mut refused) => {
                    refused.path = format!("{TYPES}/{name}");
                    problems.push(refused);
                }
            }
        }
        types.push(Value::Object(definition));
    }
    let mut edge_types = Vec::new();
    for (_, read) in source.edge_types {
        match read {
            Ok(definition) => edge_types.push(Value::Object(definition)),
            Err(refused) => problems.push(refused),
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut bundle = Map::new();
    bundle.insert("format".into(), FORMAT.into());
    for key in IDENTITY {
        if let Some(value) = manifest.get(key) {
            bundle.insert(key.into(), value.clone());
        }
    }
    bundle.insert("version".into(), version.into());
    bundle.insert("types".into(), Value::Array(types));
    bundle.insert("edge_types".into(), Value::Array(edge_types));
    if let Some(connector) = manifest.get(CONNECTOR) {
        bundle.insert(CONNECTOR.into(), connector.clone());
    }
    Ok(bundle)
}

/// The bytes of a bundle as `marfa plugins bundle` writes it, which a release's digest is of.
pub fn bundle_text(bundle: &Obj) -> String {
    let mut text = serde_json::to_string_pretty(bundle).unwrap_or_default();
    text.push('\n');
    text
}

/// A bundle's file name in a release.
pub fn bundle_file_name(name: &str) -> String {
    format!("{name}{BUNDLE_SUFFIX}")
}

/// The index entry of one bundle, written as a release lists it.
pub fn index_entry(bundle: &Obj, sha256: &str) -> Value {
    let mut entry = Map::new();
    for key in IDENTITY {
        if let Some(value) = bundle.get(key) {
            entry.insert(key.into(), value.clone());
        }
    }
    entry.insert(
        "version".into(),
        bundle.get("version").cloned().unwrap_or(Value::Null),
    );
    entry.insert(
        "has_connector".into(),
        bundle.get(CONNECTOR).is_some().into(),
    );
    let name = bundle.get("name").and_then(Value::as_str).unwrap_or("");
    entry.insert("bundle".into(), bundle_file_name(name).into());
    entry.insert("sha256".into(), sha256.into());
    Value::Object(entry)
}

/// The index a release lists: its format and one entry per bundle, ordered by name.
pub fn index(mut entries: Vec<Value>) -> Value {
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json!({ "format": FORMAT, "plugins": entries })
}

/// A SHA-256 as a plugin's fingerprint is written: 64 lowercase hexadecimal digits.
pub fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The entry an index lists under `name`, with its bundle file and digest, or why it cannot be used.
pub fn index_lookup<'a>(index: &'a Value, name: &str) -> Result<(&'a str, &'a str), String> {
    if index.get("format").and_then(Value::as_u64) != Some(FORMAT) {
        return Err(format!(
            "{INDEX} is not in index format {FORMAT}, which this build reads"
        ));
    }
    let entry = index
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        .ok_or_else(|| format!("{INDEX} lists no plugin named {name}"))?;
    let file = entry
        .get("bundle")
        .and_then(Value::as_str)
        .filter(|file| *file == bundle_file_name(name))
        .ok_or_else(|| {
            format!(
                "{INDEX} names no bundle file {} for {name}",
                bundle_file_name(name)
            )
        })?;
    let digest = entry
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| format!("{INDEX} gives no SHA-256 for {name}"))?;
    Ok((file, digest))
}

/// A change that a newer plugin version cannot make to a type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Narrowing {
    /// Where in the definition, such as `fields.priority` or `fields.status.status_values.done`.
    pub path: String,
    pub message: String,
}

fn narrowing(path: String, message: String) -> Narrowing {
    Narrowing { path, message }
}

fn objects(definition: &Obj, key: &str) -> Map<String, Value> {
    definition
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn required_names(definition: &Obj) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = definition
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    for (name, field) in objects(definition, "fields") {
        if field.get("required") == Some(&Value::Bool(true)) {
            names.insert(name);
        }
    }
    names
}

fn words(field: &Value, key: &str) -> Vec<String> {
    field
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|word| match word {
            Value::String(word) => Some(word.clone()),
            Value::Object(word) => word
                .get("value")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect()
}

fn number(field: &Value, key: &str) -> Option<f64> {
    field.get(key).and_then(Value::as_f64)
}

fn is_required(field: &Value) -> bool {
    field.get("required") == Some(&Value::Bool(true))
}

fn group_of(field: &Value, key: &str, word: &str) -> Option<Value> {
    field
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|held| held.get("value").and_then(Value::as_str) == Some(word))
        .and_then(|held| held.get("group").cloned())
}

/// Absent, empty or naming `*` takes every type.
fn constraints(field: &Value) -> Option<Vec<String>> {
    let named: Vec<String> = field
        .get("type_constraints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    (!named.is_empty() && !named.iter().any(|held| held == "*")).then_some(named)
}

fn members(field: &Value, key: &str) -> Map<String, Value> {
    field
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Compares each member `before` holds with `after`, and refuses a member `after` adds as required.
fn members_narrowings(
    path: &str,
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    out: &mut Vec<Narrowing>,
) {
    for (name, member) in before {
        let at = format!("{path}.{name}");
        match after.get(name) {
            Some(next) => field_narrowings(&at, member, next, out),
            None => out.push(narrowing(
                at.clone(),
                format!("{at} is removed, which a newer version cannot do"),
            )),
        }
    }
    for (name, member) in after {
        if !before.contains_key(name) && is_required(member) {
            let at = format!("{path}.{name}");
            out.push(narrowing(
                at.clone(),
                format!("{at} is added as required, which a newer version cannot do"),
            ));
        }
    }
}

fn field_narrowings(path: &str, before: &Value, after: &Value, out: &mut Vec<Narrowing>) {
    for key in ["type", "items_type", "format"] {
        if before.get(key) != after.get(key) {
            out.push(narrowing(
                path.to_string(),
                format!("{path} changes its {key}, which a newer version cannot do"),
            ));
            return;
        }
    }
    if !is_required(before) && is_required(after) {
        out.push(narrowing(
            path.to_string(),
            format!("{path} becomes required, which a newer version cannot do"),
        ));
    }
    for key in ["status_values", "enum_values"] {
        let kept = words(after, key);
        for word in words(before, key) {
            if !kept.contains(&word) {
                out.push(narrowing(
                    format!("{path}.{key}.{word}"),
                    format!("{path} drops {word} from {key}, which a newer version cannot do"),
                ));
            } else if group_of(before, key, &word) != group_of(after, key, &word) {
                out.push(narrowing(
                    format!("{path}.{key}.{word}"),
                    format!(
                        "{path} moves {word} to another group, which a newer version cannot do"
                    ),
                ));
            }
        }
    }
    for key in ["max_length", "max_items", "maximum"] {
        let tighter = match (number(before, key), number(after, key)) {
            (None, Some(_)) => true,
            (Some(held), Some(next)) => next < held,
            _ => false,
        };
        if tighter {
            out.push(narrowing(
                format!("{path}.{key}"),
                format!("{path} lowers {key}, which a newer version cannot do"),
            ));
        }
    }
    let tighter = match (number(before, "minimum"), number(after, "minimum")) {
        (None, Some(_)) => true,
        (Some(held), Some(next)) => next > held,
        _ => false,
    };
    if tighter {
        out.push(narrowing(
            format!("{path}.minimum"),
            format!("{path} raises minimum, which a newer version cannot do"),
        ));
    }
    let narrower = match (constraints(before), constraints(after)) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(held), Some(next)) => held.iter().any(|named| !next.contains(named)),
    };
    if narrower {
        out.push(narrowing(
            format!("{path}.type_constraints"),
            format!("{path} takes fewer types, which a newer version cannot do"),
        ));
    }
    members_narrowings(
        &format!("{path}.items_fields"),
        &members(before, "items_fields"),
        &members(after, "items_fields"),
        out,
    );
}

/// What `next` changes in `stored` beyond adding: a removed field, status word, enum value,
/// table or column, a word moved to another group, a field whose kind changes, a limit made
/// tighter anywhere, or a field, member or column made or added as required.
pub fn narrowings(stored: &Obj, next: &Obj) -> Vec<Narrowing> {
    let mut out = Vec::new();
    if stored.get("parent") != next.get("parent") {
        out.push(narrowing(
            "parent".into(),
            "The type's parent changes, which a newer version cannot do".into(),
        ));
    }
    // Either spelling of a field's requirement counts, so it is compared through `required_names`.
    let unrequired = |definition: &Obj| -> Map<String, Value> {
        objects(definition, "fields")
            .into_iter()
            .map(|(name, mut field)| {
                if let Some(field) = field.as_object_mut() {
                    field.remove("required");
                }
                (name, field)
            })
            .collect()
    };
    members_narrowings("fields", &unrequired(stored), &unrequired(next), &mut out);
    let was_required = required_names(stored);
    for name in required_names(next) {
        if !was_required.contains(&name) {
            out.push(narrowing(
                format!("fields.{name}"),
                format!("fields.{name} becomes required, which a newer version cannot do"),
            ));
        }
    }
    let after = objects(next, "tables");
    for (name, table) in objects(stored, "tables") {
        let path = format!("tables.{name}");
        let Some(next) = after.get(&name) else {
            out.push(narrowing(
                path.clone(),
                format!("{path} is removed, which a newer version cannot do"),
            ));
            continue;
        };
        members_narrowings(
            &format!("{path}.columns"),
            &members(&table, "columns"),
            &members(next, "columns"),
            &mut out,
        );
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// A type outside the bundle, below one the bundle changes, that would then declare a field
/// or a status word in another shape than the bundle's type gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildClash {
    pub type_id: String,
    pub field: String,
    pub attribute: String,
    pub inherited_from: String,
    pub inherited: String,
    pub declared: String,
}

/// A bundle's definition with its fields in the shape a registration stores, before it is
/// judged, so a clash below it can be named before the registration rules refuse it.
pub fn provisional(definition: &Obj) -> Obj {
    let mut shaped = definition.clone();
    if let Some(Value::Object(fields)) = definition.get("fields") {
        let normalized: Map<String, Value> = fields
            .iter()
            .map(|(name, field)| match field.as_object() {
                Some(field) => (
                    name.clone(),
                    Value::Object(crate::schema::normalize_field(field, None)),
                ),
                None => (name.clone(), field.clone()),
            })
            .collect();
        shaped.insert("fields".into(), Value::Object(normalized));
    }
    shaped
}

/// The nearest type at or above `from` whose own `field` declares the status word `word`.
fn declaring(registry: &Registry, from: &str, field: &str, word: &str) -> Option<String> {
    let mut seen = BTreeSet::new();
    let mut cursor = Some(from);
    while let Some(at) = cursor {
        if !seen.insert(at) {
            return None;
        }
        let row = registry.get(at)?;
        if let Some(own) = row.get("fields").and_then(|fields| fields.get(field))
            && words(own, "status_values").iter().any(|held| held == word)
        {
            return Some(at.to_string());
        }
        cursor = row.get("parent").and_then(Value::as_str);
    }
    None
}

fn clashes_in(registry: &Registry, child: &Obj, child_id: &str) -> Vec<ChildClash> {
    let mut clashes: Vec<ChildClash> = crate::schema::stored_shape_conflicts(child, registry)
        .into_iter()
        .map(|conflict| ChildClash {
            type_id: child_id.into(),
            field: conflict.field,
            attribute: conflict.attribute.to_string(),
            inherited_from: conflict.owner,
            inherited: conflict.inherited,
            declared: conflict.declared,
        })
        .collect();
    let Some(parent) = child.get("parent").and_then(Value::as_str) else {
        return clashes;
    };
    let ancestry = registry.ancestry(parent);
    for (field, definition) in objects(child, "fields") {
        let Some(held) = ancestry.get(&field) else {
            continue;
        };
        let inherited = words(&Value::Object(held.definition.clone()), "status_values");
        for word in words(&definition, "status_values") {
            if inherited.contains(&word) {
                clashes.push(ChildClash {
                    type_id: child_id.into(),
                    field: format!("{field}.status_values"),
                    attribute: "status_values".into(),
                    inherited_from: declaring(registry, parent, &field, &word)
                        .unwrap_or_else(|| held.owner.clone()),
                    inherited: word.clone(),
                    declared: word,
                });
            }
        }
    }
    clashes
}

/// Each clash below the types in `changed` that `next`, the catalog with the bundle's types in
/// it, holds and `before` did not.
pub fn child_clashes(before: &Registry, next: &Registry, changed: &[&str]) -> Vec<ChildClash> {
    let mut clashes = Vec::new();
    let mut seen = BTreeSet::new();
    for id in changed {
        for child in next.descendants(id) {
            let Some(child_id) = child.get("id").and_then(Value::as_str) else {
                continue;
            };
            if changed.contains(&child_id) || !seen.insert(child_id.to_string()) {
                continue;
            }
            let standing = before
                .get(child_id)
                .map(|held| clashes_in(before, held, child_id))
                .unwrap_or_default();
            clashes.extend(
                clashes_in(next, child, child_id)
                    .into_iter()
                    .filter(|clash| !standing.contains(clash)),
            );
        }
    }
    clashes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::shipped_registry;

    fn obj(value: Value) -> Obj {
        match value {
            Value::Object(object) => object,
            _ => panic!("not an object"),
        }
    }

    fn file(path: &str, value: Value) -> SourceFile {
        SourceFile {
            path: path.into(),
            content: Ok(value.to_string().into_bytes()),
        }
    }

    fn manifest() -> Value {
        json!({
            "name": "tickets",
            "title": "Tickets",
            "description": "Tickets for tracking work.",
            "mark": "lucide:ticket",
            "maker": "Marfa",
            "marfa": "0.0.90",
        })
    }

    fn ticket() -> Value {
        json!({
            "id": "common.ticket",
            "parent": "core.task",
            "description": "A piece of work someone asked for.",
            "fields": { "reporter": { "type": "string" } },
        })
    }

    fn folder() -> Vec<SourceFile> {
        vec![
            file(MANIFEST, manifest()),
            file("types/common.ticket.json", ticket()),
            SourceFile {
                path: "types/common.ticket.md".into(),
                content: Ok(b"File one per request.\n".to_vec()),
            },
            file(
                "edge-types/blocks.json",
                json!({ "id": "blocks", "cardinality": "many-to-many", "reverse_name": "blocked-by" }),
            ),
        ]
    }

    #[test]
    fn versions_compare_by_their_numbers_and_refuse_other_shapes() {
        assert!(Version::parse("0.0.10").unwrap() > Version::parse("0.0.9").unwrap());
        for text in ["1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.2.x", "", "1..3"] {
            assert_eq!(Version::parse(text), None, "{text}");
        }
        assert!(server_takes(Version(0, 0, 0), Version(9, 0, 0)));
        assert!(server_takes(Version(0, 0, 90), Version(0, 0, 90)));
        assert!(!server_takes(Version(0, 0, 90), Version(0, 0, 91)));
    }

    #[test]
    fn names_are_lowercase_words_joined_by_hyphens() {
        for good in ["tickets", "git-hub2", "a"] {
            assert!(is_name(good), "{good}");
        }
        for bad in ["Tickets", "-a", "a-", "a--b", "2a", "a_b", "a.b", ""] {
            assert!(!is_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_folder_builds_a_bundle_with_guidance_joined_and_the_version_stamped() {
        let bundle = build_bundle(&folder(), "1.2.3").unwrap();
        assert_eq!(bundle["format"], json!(1));
        assert_eq!(bundle["version"], json!("1.2.3"));
        assert_eq!(bundle["name"], json!("tickets"));
        assert_eq!(
            bundle["types"][0]["guidance"],
            json!("File one per request.")
        );
        assert_eq!(bundle["edge_types"][0]["id"], json!("blocks"));
        assert!(!bundle.contains_key("connector"));
        assert!(
            bundle_faults(&bundle).is_empty(),
            "{:?}",
            bundle_faults(&bundle)
        );
    }

    #[test]
    fn a_manifest_that_names_a_version_is_refused() {
        let mut files = folder();
        let mut named = manifest();
        named["version"] = json!("1.0.0");
        files[0] = file(MANIFEST, named);
        let refused = build_bundle(&files, "1.0.0").unwrap_err();
        assert!(
            refused
                .iter()
                .any(|held| held.path == "plugin.json: version"),
            "{refused:?}"
        );
    }

    #[test]
    fn the_check_takes_common_types_and_refuses_reserved_roots() {
        let verdict = check_source(&folder(), &shipped_registry().unwrap()).unwrap();
        assert_eq!(verdict.problem_count(), 0, "{verdict:?}");
        let mut files = folder();
        let mut owned = ticket();
        owned["id"] = json!("user.ticket");
        files[1] = file("types/user.ticket.json", owned);
        files.remove(2);
        let verdict = check_source(&files, &shipped_registry().unwrap()).unwrap();
        let problems = &verdict.types.files[0].problems;
        assert!(
            problems.iter().any(|held| held.code == "forbidden"),
            "{problems:?}"
        );
    }

    #[test]
    fn a_bundle_with_an_unknown_key_or_a_reserved_type_is_faulted_and_connector_is_opaque() {
        let mut bundle = build_bundle(&folder(), "1.0.0").unwrap();
        bundle.insert("connector".into(), json!({ "anything": [1, 2] }));
        assert!(bundle_faults(&bundle).is_empty());
        bundle.insert("extra".into(), json!(true));
        bundle["types"][0]["id"] = json!("app.acme.ticket");
        let faults = bundle_faults(&bundle);
        assert!(faults.iter().any(|held| held.path == "extra"), "{faults:?}");
        assert!(
            faults
                .iter()
                .any(|held| held.path == "types.0.id" && held.code == "forbidden")
        );
    }

    #[test]
    fn a_newer_version_may_add_and_never_remove_or_narrow() {
        let stored = obj(json!({
            "id": "common.ticket",
            "fields": {
                "reporter": { "type": "string", "max_length": 100 },
                "kind": { "type": "enum", "enum_values": ["bug", "chore"] },
                "stage": { "type": "status", "status_values": [
                    { "value": "open", "group": "not_started" },
                    { "value": "done", "group": "completed" }
                ] }
            }
        }));
        let mut grown = stored.clone();
        grown["fields"]["kind"]["enum_values"] = json!(["bug", "chore", "spike"]);
        grown["fields"]["reporter"]["max_length"] = json!(200);
        grown["fields"]["extra"] = json!({ "type": "string" });
        assert!(narrowings(&stored, &grown).is_empty());
        let mut cut = stored.clone();
        cut["fields"].as_object_mut().unwrap().remove("reporter");
        cut["fields"]["kind"]["enum_values"] = json!(["bug"]);
        cut["fields"]["stage"]["status_values"] =
            json!([{ "value": "open", "group": "not_started" }]);
        let paths: Vec<String> = narrowings(&stored, &cut)
            .into_iter()
            .map(|held| held.path)
            .collect();
        assert_eq!(
            paths,
            [
                "fields.kind.enum_values.chore",
                "fields.reporter",
                "fields.stage.status_values.done"
            ]
        );
        let mut retyped = stored.clone();
        retyped["fields"]["reporter"] = json!({ "type": "integer" });
        retyped["fields"]["kind"]["required"] = json!(true);
        let paths: Vec<String> = narrowings(&stored, &retyped)
            .into_iter()
            .map(|held| held.path)
            .collect();
        assert_eq!(paths, ["fields.kind", "fields.reporter"]);
    }

    fn paths(stored: &Obj, next: &Obj) -> Vec<String> {
        narrowings(stored, next)
            .into_iter()
            .map(|held| held.path)
            .collect()
    }

    #[test]
    fn a_newer_version_may_not_add_a_requirement_tighten_a_column_or_move_a_word() {
        let stored = obj(json!({
            "id": "shapes.thing",
            "fields": {
                "stage": { "type": "status", "status_values": [
                    { "value": "open", "group": "not_started" },
                    { "value": "shut", "group": "completed" }
                ] },
                "parts": { "type": "array", "items_type": "object",
                    "items_fields": { "name": { "type": "string" } } },
                "link": { "type": "item", "type_constraints": ["core.note", "core.task"] }
            },
            "tables": { "lines": { "columns": { "note": { "type": "string", "max_length": 100 } } } }
        }));
        let mut grown = stored.clone();
        grown["fields"]["due"] = json!({ "type": "date" });
        grown["fields"]["parts"]["items_fields"]["size"] = json!({ "type": "integer" });
        grown["tables"]["lines"]["columns"]["extra"] = json!({ "type": "string" });
        grown["fields"]["link"]["type_constraints"] = json!(["*"]);
        assert!(
            paths(&stored, &grown).is_empty(),
            "{:?}",
            paths(&stored, &grown)
        );
        let changed = |change: &dyn Fn(&mut Obj)| {
            let mut next = stored.clone();
            change(&mut next);
            paths(&stored, &next)
        };
        assert_eq!(
            changed(&|next| next["fields"]["due"] = json!({ "type": "date", "required": true })),
            ["fields.due"]
        );
        assert_eq!(
            changed(&|next| {
                next.insert("required".into(), json!(["due"]));
            }),
            ["fields.due"]
        );
        assert_eq!(
            changed(
                &|next| next["fields"]["parts"]["items_fields"]["name"]["required"] = json!(true)
            ),
            ["fields.parts.items_fields.name"]
        );
        assert_eq!(
            changed(&|next| next["fields"]["parts"]["items_fields"]["size"] =
                json!({ "type": "integer", "required": true })),
            ["fields.parts.items_fields.size"]
        );
        assert_eq!(
            changed(&|next| next["tables"]["lines"]["columns"]["note"]["max_length"] = json!(50)),
            ["tables.lines.columns.note.max_length"]
        );
        assert_eq!(
            changed(&|next| next["tables"]["lines"]["columns"]["extra"] =
                json!({ "type": "string", "required": true })),
            ["tables.lines.columns.extra"]
        );
        assert_eq!(
            changed(
                &|next| next["fields"]["stage"]["status_values"][1]["group"] = json!("canceled")
            ),
            ["fields.stage.status_values.shut"]
        );
        assert_eq!(
            changed(&|next| next["fields"]["link"]["type_constraints"] = json!(["core.note"])),
            ["fields.link.type_constraints"]
        );
    }

    fn registry(rows: Vec<Value>) -> Registry {
        Registry::new(rows.into_iter().map(obj))
    }

    fn stage(words: &[&str]) -> Value {
        json!({ "type": "status", "status_values": words
            .iter()
            .map(|word| json!({ "value": word, "group": "not_started" }))
            .collect::<Vec<_>>() })
    }

    #[test]
    fn a_word_clash_names_the_type_that_declared_the_word_and_a_standing_clash_is_not_reported() {
        let middle = json!({ "id": "user.middle", "parent": "family.base",
            "fields": { "stage": stage(&["waiting"]) } });
        let low = json!({ "id": "user.low", "parent": "user.middle",
            "fields": { "stage": stage(&["parked"]) } });
        let base =
            |words: &[&str]| json!({ "id": "family.base", "fields": { "stage": stage(words) } });
        let before = registry(vec![base(&["open"]), middle.clone(), low.clone()]);
        let next = registry(vec![base(&["open", "parked"]), middle.clone(), low.clone()]);
        let clashes = child_clashes(&before, &next, &["family.base"]);
        assert_eq!(clashes.len(), 1, "{clashes:?}");
        assert_eq!(clashes[0].type_id, "user.low");
        assert_eq!(clashes[0].inherited, "parked");
        assert_eq!(clashes[0].inherited_from, "family.base");
        // The same clash, already standing before the change, is not this version's.
        assert!(child_clashes(&next, &next, &["family.base"]).is_empty());
    }

    #[test]
    fn an_edge_type_is_judged_as_installing_does_and_the_check_applies_it() {
        let none = |_: &str| None;
        for (definition, said) in [
            (
                json!({ "id": "about", "cardinality": "many-to-many" }),
                "conflict",
            ),
            (
                json!({ "id": "cites", "cardinality": "many-to-many", "reverse_name": "about" }),
                "conflict",
            ),
            (
                json!({ "id": "Bad_Name", "cardinality": "many-to-many" }),
                "validation",
            ),
            (
                json!({ "id": "cites", "cardinality": "many-to-many", "extends": "about" }),
                "validation",
            ),
            (
                json!({ "id": "cites", "cardinality": "many-to-many", "stray": true }),
                "schema",
            ),
        ] {
            let judged = judge_edge_type(&obj(definition.clone()), &none);
            let kind = match judged {
                Err(EdgeIssues::Conflict { .. }) => "conflict",
                Err(EdgeIssues::Validation { .. }) => "validation",
                Err(EdgeIssues::Schema(_)) => "schema",
                other => panic!("{definition}: {other:?}"),
            };
            assert_eq!(kind, said, "{definition}");
        }
        assert!(
            judge_edge_type(
                &obj(json!({ "id": "cites", "cardinality": "many-to-many" })),
                &none
            )
            .is_ok()
        );
        let mut files = folder();
        files[3] = file(
            "edge-types/about.json",
            json!({ "id": "about", "cardinality": "many-to-many" }),
        );
        let verdict = check_source(&files, &shipped_registry().unwrap()).unwrap();
        assert!(
            verdict.problems.iter().any(|held| held.code == "conflict"),
            "{verdict:?}"
        );
    }

    #[test]
    fn the_check_refuses_a_type_with_no_fields_as_installing_does() {
        let mut files = folder();
        files[1] = file(
            "types/common.ticket.json",
            json!({ "id": "common.ticket", "parent": "core.task", "description": "No fields." }),
        );
        let verdict = check_source(&files, &shipped_registry().unwrap()).unwrap();
        let problems = &verdict.types.files[0].problems;
        assert!(
            problems
                .iter()
                .any(|held| held.code == "missing_required_field"),
            "{problems:?}"
        );
    }

    #[test]
    fn an_index_finds_a_bundle_by_name_with_its_digest() {
        let bundle = build_bundle(&folder(), "1.0.0").unwrap();
        let digest = "a".repeat(64);
        let listed = index(vec![index_entry(&bundle, &digest)]);
        assert_eq!(listed["plugins"][0]["has_connector"], json!(false));
        assert_eq!(
            index_lookup(&listed, "tickets").unwrap(),
            ("tickets.plugin.json", digest.as_str())
        );
        assert!(index_lookup(&listed, "other").is_err());
    }

    #[test]
    fn a_requirement_moved_between_the_required_list_and_the_field_is_no_narrowing() {
        let listed = obj(json!({
            "id": "common.ticket",
            "required": ["title"],
            "fields": { "title": { "type": "string" } },
        }));
        let in_field = obj(json!({
            "id": "common.ticket",
            "fields": { "title": { "type": "string", "required": true } },
        }));
        assert_eq!(narrowings(&listed, &in_field), Vec::new());
        assert_eq!(narrowings(&in_field, &listed), Vec::new());
        let optional = obj(json!({
            "id": "common.ticket",
            "fields": { "title": { "type": "string" } },
        }));
        let made = narrowings(&optional, &in_field);
        assert_eq!(made.len(), 1, "{made:?}");
        assert_eq!(made[0].path, "fields.title");
    }

    #[test]
    fn a_file_not_named_after_its_id_is_refused_by_the_check_and_the_build() {
        let mut files = folder();
        files[3] = file(
            "edge-types/first.json",
            json!({ "id": "second", "cardinality": "many-to-many" }),
        );
        let verdict = check_source(&files, &shipped_registry().unwrap()).unwrap();
        assert!(
            verdict
                .problems
                .iter()
                .any(|held| held.code == "file_name_mismatch" && held.path == "edge-types/first.json"),
            "{verdict:?}"
        );
        let refused = build_bundle(&files, "1.0.0").unwrap_err();
        assert!(
            refused
                .iter()
                .any(|held| held.code == "file_name_mismatch" && held.path == "edge-types/first.json"),
            "{refused:?}"
        );
        let mut files = folder();
        files[1] = file("types/common.other.json", ticket());
        files.remove(2);
        let refused = build_bundle(&files, "1.0.0").unwrap_err();
        assert!(
            refused
                .iter()
                .any(|held| held.code == "file_name_mismatch" && held.path == "types/common.other.json"),
            "{refused:?}"
        );
    }
}
