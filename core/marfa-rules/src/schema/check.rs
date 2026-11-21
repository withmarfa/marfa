//! Offline validation of item type definitions.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::{
    ITEM_KIND, Obj, Registry, SchemaVerdict, early_refusal, labelled, parent_chain_fault,
    validate_type,
};
use crate::builtin;
use crate::error::RuleError;
use crate::grammar;

/// A file in the folder: its name, and its bytes or why they could not be read.
#[derive(Debug, Clone)]
pub struct TypeFile {
    pub name: String,
    pub content: Result<Vec<u8>, String>,
}

/// A file diagnostic with a server or local code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub path: String,
    pub code: &'static str,
    pub message: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileVerdict {
    pub file: String,
    pub id: Option<String>,
    pub problems: Vec<Problem>,
    /// Folder context for the server's answer.
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderVerdict {
    pub files: Vec<FileVerdict>,
}

impl FolderVerdict {
    pub fn problem_count(&self) -> usize {
        self.files.iter().map(|file| file.problems.len()).sum()
    }
}

pub fn shipped_registry() -> Result<Registry, RuleError> {
    Ok(Registry::new(builtin::shipped_types()?.iter().cloned()))
}

const PARENT_PATH: &str = "parent";
const GUIDANCE_PATH: &str = "guidance";

/// Why the Markdown file beside a definition cannot be read as its guidance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuidanceFileFault {
    ByteOrderMark,
    NotUtf8,
}

impl GuidanceFileFault {
    pub fn message(self, name: &str) -> String {
        match self {
            Self::ByteOrderMark => {
                format!("{name} starts with a byte-order mark. Save it as UTF-8 without one.")
            }
            Self::NotUtf8 => format!("{name} is not UTF-8. Save it as UTF-8."),
        }
    }
}

/// The guidance a Markdown file holds: UTF-8 with no byte-order mark, and its trailing whitespace removed so an editor's final newline does not count.
pub fn read_guidance_file(bytes: &[u8]) -> Result<String, GuidanceFileFault> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(GuidanceFileFault::ByteOrderMark);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| GuidanceFileFault::NotUtf8)?;
    Ok(text.trim_end().to_string())
}

/// The name of the Markdown file that holds the guidance of the definition in `file`: the same name with `.md` for `.json`. `None` for a file that is not a definition.
pub fn guidance_file_name(file: &str) -> Option<String> {
    let stem = file.get(..file.len().checked_sub(".json".len())?)?;
    file[stem.len()..]
        .eq_ignore_ascii_case(".json")
        .then(|| format!("{stem}.md"))
}

/// Whether `name` is the name of a Markdown file a definition's guidance can sit in: it ends in exactly `.md`, so `.MD` is not one.
pub fn is_guidance_file(name: &str) -> bool {
    !name.starts_with('.') && name.ends_with(".md")
}

pub fn is_type_file(name: &str) -> bool {
    !name.starts_with('.') && name.to_ascii_lowercase().ends_with(".json")
}

fn problem(path: &str, code: &'static str, message: impl Into<String>) -> Problem {
    Problem {
        path: path.into(),
        code,
        message: message.into(),
        hint: None,
    }
}

/// The line and column, counted as the JSON parser counts, of the byte at `offset`.
fn place(bytes: &[u8], offset: usize) -> (usize, usize) {
    let before = &bytes[..offset.min(bytes.len())];
    let line = before.iter().filter(|byte| **byte == b'\n').count() + 1;
    let column = before
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(before.len(), |newline| before.len() - newline - 1)
        + 1;
    (line, column)
}

/// The body as the server reads one, or what it refuses it for.
fn read(bytes: &[u8]) -> Result<Obj, Problem> {
    let refused = |message: &str| problem("", "validation_error", message);
    if bytes.is_empty() {
        return Err(refused("The body is empty; send a JSON object."));
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(refused("The body must be a JSON object.")),
        Err(error) => {
            let mut said = refused(&format!("The body is not valid JSON: {error}"));
            let mut hints: Vec<String> = Vec::new();
            if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                hints.push(
                    "The file starts with a byte-order mark, which the server refuses. Save it as UTF-8 without one.".into(),
                );
            }
            if let Err(bad) = std::str::from_utf8(bytes) {
                let (line, column) = place(bytes, bad.valid_up_to());
                hints.push(format!(
                    "The file is not valid UTF-8: the first byte that is not is at line {line}, column {column}."
                ));
            }
            if !hints.is_empty() {
                said.hint = Some(hints.join(" "));
            }
            Err(said)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Link {
    Parent,
    Column,
}

/// An item column may name its own type before registration.
fn column_targets<'a>(body: &'a Obj, own: &str) -> Vec<&'a str> {
    let mut found: Vec<&str> = Vec::new();
    let tables = body.get("tables").and_then(Value::as_object);
    for table in tables.into_iter().flat_map(Map::values) {
        let columns = table.get("columns").and_then(Value::as_object);
        for column in columns.into_iter().flat_map(Map::values) {
            if column.get("type").and_then(Value::as_str) != Some(ITEM_KIND) {
                continue;
            }
            let named = column.get("type_constraints").and_then(Value::as_array);
            for id in named.into_iter().flatten().filter_map(Value::as_str) {
                if id != own && !found.contains(&id) {
                    found.push(id);
                }
            }
        }
    }
    found
}

fn references<'a>(body: &'a Obj, own: &str) -> Vec<(Link, &'a str)> {
    let parent = body
        .get("parent")
        .and_then(Value::as_str)
        .filter(|parent| !parent.is_empty());
    parent
        .map(|parent| (Link::Parent, parent))
        .into_iter()
        .chain(
            column_targets(body, own)
                .into_iter()
                .map(|id| (Link::Column, id)),
        )
        .collect()
}

struct Entry {
    file: usize,
    id: String,
    body: Obj,
    /// Refused by the folder's own checks, so never registered for a later type to name.
    misnamed: bool,
    /// Refused for its guidance file before the registration rules judged it.
    unjudged: bool,
}

/// The types of the folder in an order that registers each after the types it names, and the ones left that wait on a loop.
struct Order {
    ready: Vec<usize>,
    stuck: Vec<usize>,
}

fn order_of(entries: &[Entry], links: &[Vec<(usize, Link)>]) -> Order {
    let mut waiting: Vec<usize> = links.iter().map(Vec::len).collect();
    let mut by_dependency: Vec<Vec<usize>> = vec![Vec::new(); entries.len()];
    for (entry, needs) in links.iter().enumerate() {
        for (dependency, _) in needs {
            by_dependency[*dependency].push(entry);
        }
    }
    let mut ready: Vec<usize> = Vec::new();
    let mut queue: Vec<usize> = (0..entries.len()).filter(|n| waiting[*n] == 0).collect();
    while let Some(next) = queue.pop() {
        ready.push(next);
        for dependent in &by_dependency[next] {
            waiting[*dependent] -= 1;
            if waiting[*dependent] == 0 {
                queue.push(*dependent);
            }
        }
    }
    let stuck = (0..entries.len()).filter(|n| waiting[*n] > 0).collect();
    Order { ready, stuck }
}

/// The loop of links among `stuck` that `start` is on, `start` first, or `None` where it only waits on one.
fn loop_through(
    start: usize,
    links: &[Vec<(usize, Link)>],
    stuck: &[usize],
) -> Option<Vec<(usize, Link)>> {
    let mut came_from: HashMap<usize, (usize, Link)> = HashMap::new();
    let mut frontier = vec![start];
    while let Some(at) = frontier.pop() {
        for (next, link) in &links[at] {
            if !stuck.contains(next) {
                continue;
            }
            if *next == start {
                let mut path = vec![(at, *link)];
                let mut cursor = at;
                while cursor != start {
                    let (before, via) = came_from[&cursor];
                    path.push((before, via));
                    cursor = before;
                }
                path.reverse();
                return Some(path);
            }
            if let std::collections::hash_map::Entry::Vacant(slot) = came_from.entry(*next) {
                slot.insert((at, *link));
                frontier.push(*next);
            }
        }
    }
    None
}

pub fn check_type_files(
    files: &[TypeFile],
    shipped: &Registry,
) -> Result<FolderVerdict, RuleError> {
    let mut candidates: Vec<&TypeFile> = files
        .iter()
        .filter(|file| is_type_file(&file.name))
        .collect();
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    let mut verdicts: Vec<FileVerdict> = candidates
        .iter()
        .map(|file| FileVerdict {
            file: file.name.clone(),
            id: None,
            problems: Vec::new(),
            context: None,
        })
        .collect();
    let guidance_files: HashMap<&str, &TypeFile> = files
        .iter()
        .filter(|file| is_guidance_file(&file.name))
        .map(|file| (file.name.as_str(), file))
        .collect();
    let mut paired: Vec<String> = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (at, file) in candidates.iter().enumerate() {
        let sibling = guidance_file_name(&file.name)
            .filter(|name| guidance_files.contains_key(name.as_str()));
        if let Some(name) = &sibling {
            paired.push(name.clone());
        }
        let body = match &file.content {
            Err(why) => {
                verdicts[at].problems.push(problem(
                    "",
                    "file_unreadable",
                    format!("Cannot read the file: {why}"),
                ));
                verdicts[at].context = unjudged_guidance(sibling.as_deref());
                continue;
            }
            Ok(bytes) => match read(bytes) {
                Ok(body) => body,
                Err(refused) => {
                    verdicts[at].problems.push(refused);
                    verdicts[at].context = unjudged_guidance(sibling.as_deref());
                    continue;
                }
            },
        };
        let declared = body.get("id").and_then(Value::as_str);
        let mut misnamed = false;
        if let Some(id) = declared
            && file.name != format!("{id}.json")
        {
            misnamed = true;
            let message = if id.is_empty() {
                format!(
                    "The file is named \"{}\" but its id is empty: give the type an id and name the file after it.",
                    file.name
                )
            } else {
                format!(
                    "The file is named \"{}\" but its id is \"{id}\": name the file \"{id}.json\".",
                    file.name
                )
            };
            verdicts[at]
                .problems
                .push(problem("id", "file_name_mismatch", message));
        }
        let id = declared.unwrap_or_default().to_string();
        if !id.is_empty() {
            verdicts[at].id = Some(id.clone());
        }
        let mut body = body;
        let mut unjudged = false;
        if let Some(name) = &sibling
            && let Some(guidance) = guidance_files.get(name.as_str())
            && let Err(refused) = with_guidance(&mut body, name, guidance)
        {
            verdicts[at].problems.push(refused);
            unjudged = true;
        }
        entries.push(Entry {
            file: at,
            id,
            body,
            misnamed: misnamed || unjudged,
            unjudged,
        });
    }
    let mut strays: Vec<&TypeFile> = guidance_files
        .values()
        .copied()
        .filter(|file| !paired.contains(&file.name) && names_a_type(&file.name))
        .collect();
    strays.sort_by(|a, b| a.name.cmp(&b.name));
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.id.is_empty() {
            continue;
        }
        let exact = candidates[entry.file].name == format!("{}.json", entry.id);
        if exact || !by_id.contains_key(entry.id.as_str()) {
            by_id.insert(&entry.id, index);
        }
    }
    let links: Vec<Vec<(usize, Link)>> = entries
        .iter()
        .enumerate()
        .map(|(own, entry)| {
            let mut found: Vec<(usize, Link)> = Vec::new();
            for (link, named) in references(&entry.body, &entry.id) {
                if !shipped.contains(named)
                    && let Some(index) = by_id.get(named)
                    && (!entries[*index].misnamed || *index == own)
                    && !found.contains(&(*index, link))
                {
                    found.push((*index, link));
                }
            }
            found
        })
        .collect();
    let order = order_of(&entries, &links);
    let mut working = shipped.clone();
    for &index in order.ready.iter().chain(&order.stuck) {
        let entry = &entries[index];
        if entry.unjudged {
            continue;
        }
        let looped = loop_through(index, &links, &order.stuck);
        let held = judge(entry, &working)?;
        verdicts[entry.file].context =
            context_of(entry, &working, &by_id, looped.as_deref(), &entries);
        match held {
            Ok(stored) if !entry.misnamed => working = working.with(stored),
            Ok(_) => {}
            Err(problems) => verdicts[entry.file].problems.extend(problems),
        }
    }
    for file in strays {
        let stem = &file.name[..file.name.len() - ".md".len()];
        verdicts.push(FileVerdict {
            file: file.name.clone(),
            id: None,
            problems: vec![problem(
                "",
                "guidance_file_without_definition",
                format!(
                    "No {stem}.json sits beside {}, so its text is guidance for no type. Add the definition, or rename the file if it belongs to another type.",
                    file.name
                ),
            )],
            context: None,
        });
    }
    Ok(FolderVerdict { files: verdicts })
}

fn unjudged_guidance(sibling: Option<&str>) -> Option<String> {
    sibling.map(|name| {
        format!("{name} sits beside this file as its guidance. It was not judged, because the definition was refused.")
    })
}

/// Whether a Markdown file is named as guidance for a type: its name before `.md` is a well-formed type id.
fn names_a_type(name: &str) -> bool {
    let stem = &name[..name.len() - ".md".len()];
    grammar::type_id(stem).unwrap_or(false)
}

/// Sets the definition's `guidance` from the Markdown file beside it, as `types register --file` does: an empty file sets none, and a definition that also names `guidance` is refused.
fn with_guidance(body: &mut Obj, name: &str, file: &TypeFile) -> Result<(), Problem> {
    let refused = |code: &'static str, message: String| problem(GUIDANCE_PATH, code, message);
    let bytes = file.content.as_ref().map_err(|why| {
        refused(
            "guidance_file_unreadable",
            format!("Cannot read {name}: {why}"),
        )
    })?;
    let text = read_guidance_file(bytes)
        .map_err(|fault| refused("guidance_file_unreadable", fault.message(name)))?;
    if body.contains_key(GUIDANCE_PATH) {
        return Err(refused(
            "guidance_named_twice",
            format!("The definition names guidance and {name} holds it too. Keep it in one place."),
        ));
    }
    if !text.is_empty() {
        body.insert(GUIDANCE_PATH.into(), Value::String(text));
    }
    Ok(())
}

fn context_of(
    entry: &Entry,
    working: &Registry,
    by_id: &HashMap<&str, usize>,
    looped: Option<&[(usize, Link)]>,
    entries: &[Entry],
) -> Option<String> {
    let mut sentences: Vec<String> = Vec::new();
    for (link, named) in references(&entry.body, &entry.id) {
        if working.contains(named) || named == entry.id {
            continue;
        }
        let subject = match link {
            Link::Parent => "The parent",
            Link::Column => "A table column's type_constraints names",
        };
        let why = if by_id.contains_key(named) {
            "was refused in this folder"
        } else {
            "is not shipped or in this folder"
        };
        sentences.push(match link {
            Link::Parent => format!("{subject} \"{named}\" {why}."),
            _ => format!("{subject} \"{named}\", which {why}."),
        });
    }
    if let Some(path) = looped {
        let mut names: Vec<&str> = path
            .iter()
            .map(|(at, _)| entries[*at].id.as_str())
            .collect();
        names.push(entry.id.as_str());
        sentences.push(format!(
            "The type is in a loop of types that name one another, so none can be registered first: {}.",
            names.join(" -> ")
        ));
    }
    (!sentences.is_empty()).then(|| sentences.join(" "))
}

/// One type as the server registers it, against the types that registered before it: what it would store, or what it would be refused for.
fn judge(entry: &Entry, working: &Registry) -> Result<Result<Obj, Vec<Problem>>, RuleError> {
    if let Some(early) = early_refusal(&entry.body)? {
        return Ok(Err(vec![problem(
            early.path(),
            early.code(),
            early.message(),
        )]));
    }
    match validate_type(&Value::Object(entry.body.clone()), working) {
        Err(issues) => {
            let code = SchemaVerdict::of(&issues).code();
            Ok(Err(issues
                .iter()
                .map(|issue| problem(&issue.field, code, issue.message()))
                .collect()))
        }
        Ok(schema) => {
            let schema = labelled(schema);
            let fault = schema
                .get("parent")
                .and_then(Value::as_str)
                .and_then(|parent| parent_chain_fault(working, &entry.id, parent, 0));
            Ok(match fault {
                Some(fault) => Err(vec![problem(PARENT_PATH, "validation_error", fault)]),
                None => Ok(schema),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn file(name: &str, text: impl AsRef<[u8]>) -> TypeFile {
        TypeFile {
            name: name.into(),
            content: Ok(text.as_ref().to_vec()),
        }
    }

    fn definition(id: &str, value: Value) -> TypeFile {
        let mut body = value;
        body["id"] = json!(id);
        file(&format!("{id}.json"), body.to_string())
    }

    fn check(files: &[TypeFile]) -> FolderVerdict {
        check_type_files(files, &shipped_registry().unwrap()).unwrap()
    }

    fn problems_of<'a>(verdict: &'a FolderVerdict, name: &str) -> &'a [Problem] {
        &verdict
            .files
            .iter()
            .find(|file| file.file == name)
            .unwrap_or_else(|| panic!("no verdict for {name}"))
            .problems
    }

    /// Checks the one file `broken` makes and the same folder with `valid` in its place.
    fn refused_with_witness(valid: Value, broken: Value, path: &str, said: &str) -> Problem {
        let id = "user.sample";
        let passed = check(&[definition(id, valid)]);
        assert_eq!(passed.problem_count(), 0, "witness: {passed:?}");
        let refused = check(&[definition(id, broken)]);
        let found = problems_of(&refused, "user.sample.json");
        let problem = found
            .iter()
            .find(|problem| problem.path == path && problem.message.contains(said))
            .unwrap_or_else(|| panic!("no problem at {path} saying {said}: {found:?}"));
        problem.clone()
    }

    fn task_child() -> Value {
        json!({
            "parent": "core.task",
            "fields": { "sprint": { "type": "integer" } }
        })
    }

    #[test]
    fn a_type_under_a_shipped_parent_and_a_child_of_it_pass() {
        let verdict = check(&[
            definition("user.sprint-task", task_child()),
            definition(
                "user.bug",
                json!({ "parent": "user.sprint-task", "fields": { "severity": { "type": "string" } } }),
            ),
        ]);
        assert_eq!(verdict.problem_count(), 0, "{verdict:?}");
        assert_eq!(verdict.files.len(), 2);
        assert_eq!(verdict.files[0].id.as_deref(), Some("user.bug"));
    }

    #[test]
    fn a_child_is_judged_whatever_order_the_files_sort_in() {
        let verdict = check(&[
            definition(
                "user.a-child",
                json!({ "parent": "user.z-parent", "fields": { "x": { "type": "string" } } }),
            ),
            definition(
                "user.z-parent",
                json!({ "fields": { "x": { "type": "string" } } }),
            ),
        ]);
        assert_eq!(verdict.problem_count(), 0, "{verdict:?}");
    }

    #[test]
    fn a_redefined_inherited_field_is_refused() {
        let problem = refused_with_witness(
            json!({ "parent": "core.task", "fields": { "title": { "type": "string", "required": true } } }),
            json!({ "parent": "core.task", "fields": { "title": { "type": "integer", "required": true } } }),
            "fields.title.type",
            "inherited from \"core.task\"",
        );
        assert_eq!(problem.code, "inheritance_violation");
    }

    #[test]
    fn a_status_word_in_a_group_the_field_does_not_have_is_refused() {
        let status = |group: &str| {
            json!({ "fields": { "stage": { "type": "status", "status_values": [
                { "value": "open", "group": group }
            ] } } })
        };
        let problem = refused_with_witness(
            status("not_started"),
            status("underway"),
            "fields.stage.status_values.0.group",
            "underway",
        );
        assert_eq!(problem.code, "invalid_schema");
    }

    #[test]
    fn two_thumbnail_fields_are_refused() {
        let thumbnails = |second: &str| {
            json!({ "fields": {
                "cover": { "type": "thumbnail" },
                "banner": { "type": second }
            } })
        };
        let problem = refused_with_witness(
            thumbnails("string"),
            thumbnails("thumbnail"),
            "fields.banner",
            "thumbnail",
        );
        assert_eq!(problem.code, "invalid_schema");
    }

    #[test]
    fn a_loosened_minimum_is_refused() {
        let parent = definition(
            "user.floor",
            json!({ "fields": { "count": { "type": "integer", "minimum": 5 } } }),
        );
        let child = |minimum: i64| {
            definition(
                "user.lower",
                json!({ "parent": "user.floor", "fields": { "count": { "type": "integer", "minimum": minimum } } }),
            )
        };
        let tightened = check(&[parent.clone(), child(7)]);
        assert_eq!(tightened.problem_count(), 0, "witness: {tightened:?}");
        let loosened = check(&[parent, child(1)]);
        let found = problems_of(&loosened, "user.lower.json");
        assert!(
            found
                .iter()
                .any(|problem| problem.code == "inheritance_violation"
                    && problem.path == "fields.count.minimum"),
            "{found:?}"
        );
        assert!(problems_of(&loosened, "user.floor.json").is_empty());
    }

    #[test]
    fn an_unknown_field_type_is_refused() {
        let kind = |kind: &str| json!({ "fields": { "x": { "type": kind } } });
        let problem = refused_with_witness(kind("string"), kind("colour"), "fields.x.type", "");
        assert_eq!(problem.code, "invalid_schema");
    }

    #[test]
    fn an_enum_with_no_values_is_refused() {
        let field = |extra: Value| {
            let mut field = json!({ "type": "enum" });
            for (key, value) in extra.as_object().unwrap() {
                field[key] = value.clone();
            }
            json!({ "fields": { "x": field } })
        };
        let problem = refused_with_witness(
            field(json!({ "enum_values": ["a", "b"] })),
            field(json!({})),
            "fields.x.enum_values",
            "",
        );
        assert_eq!(problem.code, "invalid_schema");
    }

    #[test]
    fn an_unknown_key_is_refused() {
        let body = |extra: Option<(&str, Value)>| {
            let mut body = json!({ "fields": { "x": { "type": "string" } } });
            if let Some((key, value)) = extra {
                body[key] = value;
            }
            body
        };
        let problem = refused_with_witness(
            body(Some(("description", json!("What it is")))),
            body(Some(("colour", json!("red")))),
            "colour",
            "",
        );
        assert_eq!(problem.code, "invalid_schema");
    }

    #[test]
    fn a_reserved_root_is_refused_as_the_server_refuses_it() {
        let body = json!({ "fields": { "x": { "type": "string" } } });
        let valid = check(&[definition("user.x", body.clone())]);
        assert_eq!(valid.problem_count(), 0, "witness: {valid:?}");
        let platform = check(&[definition("core.x", body.clone())]);
        let found = problems_of(&platform, "core.x.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "forbidden");
        assert_eq!(
            found[0].message,
            "Reserved namespace: core.* types are platform-shipped and cannot be registered at runtime"
        );
        let reserved = check(&[definition("audit.x", body)]);
        let found = problems_of(&reserved, "audit.x.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "validation_error");
        assert_eq!(found[0].path, "id");
        assert!(found[0].message.starts_with("Invalid type identifier"));
    }

    #[test]
    fn a_missing_fields_key_is_refused_as_the_server_refuses_it() {
        let verdict = check(&[file("user.x.json", r#"{"id": "user.x"}"#)]);
        let found = problems_of(&verdict, "user.x.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "missing_required_field");
        assert_eq!(found[0].message, "fields is required");
        assert_eq!(found[0].path, "fields");
    }

    fn child_of(id: &str, parent: &str) -> TypeFile {
        definition(
            id,
            json!({ "parent": parent, "fields": { "x": { "type": "string" } } }),
        )
    }

    fn holder(id: &str, target: &str) -> TypeFile {
        definition(
            id,
            json!({ "fields": { "x": { "type": "string" } }, "tables": { "rows": { "columns": {
                "who": { "type": "item", "type_constraints": [target] }
            } } } }),
        )
    }

    fn plain(id: &str) -> TypeFile {
        definition(id, json!({ "fields": { "x": { "type": "string" } } }))
    }

    fn context_of_file<'a>(verdict: &'a FolderVerdict, name: &str) -> Option<&'a str> {
        verdict
            .files
            .iter()
            .find(|file| file.file == name)
            .and_then(|file| file.context.as_deref())
    }

    #[test]
    fn a_missing_parent_gets_the_servers_answer_and_the_folder_says_why() {
        let verdict = check(&[child_of("user.orphan", "user.gone")]);
        let found = problems_of(&verdict, "user.orphan.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "validation_error");
        assert_eq!(found[0].path, "parent");
        assert_eq!(found[0].message, "Parent type \"user.gone\" not found");
        assert_eq!(
            context_of_file(&verdict, "user.orphan.json"),
            Some("The parent \"user.gone\" is not shipped or in this folder.")
        );
    }

    #[test]
    fn a_missing_parent_does_not_hide_another_fault_the_server_gives() {
        let enum_without_values = json!({ "x": { "type": "enum" } });
        let verdict = check(&[definition(
            "user.orphan",
            json!({ "parent": "user.gone", "fields": enum_without_values }),
        )]);
        let found = problems_of(&verdict, "user.orphan.json");
        assert!(
            found.iter().any(|problem| problem.code == "invalid_schema"
                && problem.path == "fields.x.enum_values"),
            "{found:?}"
        );
        assert!(found.iter().all(|problem| problem.code == "invalid_schema"));
        assert!(
            context_of_file(&verdict, "user.orphan.json")
                .unwrap()
                .contains("user.gone")
        );
    }

    #[test]
    fn a_parent_cycle_gives_each_type_in_it_the_answer_of_an_absent_parent() {
        let verdict = check(&[
            child_of("user.a", "user.b"),
            child_of("user.b", "user.a"),
            child_of("user.below", "user.a"),
            child_of("user.fine", "core.note"),
        ]);
        for (name, parent) in [
            ("user.a.json", "user.b"),
            ("user.b.json", "user.a"),
            ("user.below.json", "user.a"),
        ] {
            let found = problems_of(&verdict, name);
            assert_eq!(found.len(), 1, "{name}: {found:?}");
            assert_eq!(found[0].code, "validation_error");
            assert_eq!(found[0].path, "parent");
            assert_eq!(
                found[0].message,
                format!("Parent type \"{parent}\" not found")
            );
        }
        for name in ["user.a.json", "user.b.json"] {
            let context = context_of_file(&verdict, name).unwrap();
            assert!(
                context.contains("user.a -> user.b -> user.a")
                    || context.contains("user.b -> user.a -> user.b"),
                "{context}"
            );
        }
        let below = context_of_file(&verdict, "user.below.json").unwrap();
        assert!(
            below.contains("\"user.a\" was refused in this folder"),
            "{below}"
        );
        assert!(!below.contains("loop"), "{below}");
        assert!(problems_of(&verdict, "user.fine.json").is_empty());
        assert!(context_of_file(&verdict, "user.fine.json").is_none());
    }

    #[test]
    fn a_table_column_is_judged_after_the_type_it_names_whatever_order_the_files_sort_in() {
        for (referrer, target) in [
            ("user.a-holder", "user.z-person"),
            ("user.z-holder", "user.a-person"),
        ] {
            let verdict = check(&[holder(referrer, target), plain(target)]);
            assert_eq!(verdict.problem_count(), 0, "{referrer}: {verdict:?}");
        }
        let chained = check(&[
            holder("user.a-holder", "user.m-holder"),
            holder("user.m-holder", "user.z-person"),
            plain("user.z-person"),
        ]);
        assert_eq!(chained.problem_count(), 0, "{chained:?}");
    }

    #[test]
    fn a_table_column_naming_its_own_type_passes() {
        let verdict = check(&[holder("user.tree", "user.tree")]);
        assert_eq!(verdict.problem_count(), 0, "{verdict:?}");
    }

    #[test]
    fn a_table_column_naming_a_type_that_is_not_there_gets_the_servers_answer() {
        let verdict = check(&[holder("user.dangling", "user.nowhere")]);
        let found = problems_of(&verdict, "user.dangling.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "invalid_schema");
        assert_eq!(found[0].path, "tables.rows.columns.who.type_constraints");
        assert!(found[0].message.contains("which is not registered"));
        assert_eq!(
            context_of_file(&verdict, "user.dangling.json"),
            Some(
                "A table column's type_constraints names \"user.nowhere\", which is not shipped or in this folder."
            )
        );
    }

    #[test]
    fn table_columns_that_name_each_other_are_each_refused_as_the_other_is_absent() {
        let verdict = check(&[
            holder("user.col-a", "user.col-b"),
            holder("user.col-b", "user.col-a"),
            holder("user.below", "user.col-a"),
        ]);
        for name in ["user.col-a.json", "user.col-b.json", "user.below.json"] {
            let found = problems_of(&verdict, name);
            assert_eq!(found.len(), 1, "{name}: {found:?}");
            assert_eq!(found[0].code, "invalid_schema");
            assert!(found[0].message.contains("which is not registered"));
        }
        assert!(
            context_of_file(&verdict, "user.col-a.json")
                .unwrap()
                .contains("loop")
        );
        assert!(
            !context_of_file(&verdict, "user.below.json")
                .unwrap()
                .contains("loop")
        );
    }

    #[test]
    fn a_type_naming_itself_as_its_parent_gets_the_servers_answer() {
        let verdict = check(&[child_of("user.self", "user.self")]);
        let found = problems_of(&verdict, "user.self.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "validation_error");
        assert_eq!(found[0].message, "Circular inheritance detected");
        let reserved = check(&[child_of("core.unshipped", "core.unshipped")]);
        let found = problems_of(&reserved, "core.unshipped.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "forbidden");
    }

    #[test]
    fn a_name_that_differs_from_the_id_is_reported_for_a_type_in_a_cycle_too() {
        let body = json!({ "id": "user.self", "parent": "user.self", "fields": { "x": { "type": "string" } } })
            .to_string();
        let verdict = check(&[file("Wrong.json", &body)]);
        let found = problems_of(&verdict, "Wrong.json");
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].code, "file_name_mismatch");
        assert_eq!(found[1].message, "Circular inheritance detected");
    }

    #[test]
    fn a_child_of_a_refused_parent_gets_the_servers_answer_and_the_folder_says_the_parent_was_refused()
     {
        let verdict = check(&[
            definition(
                "user.parent",
                json!({ "fields": { "x": { "type": "colour" } } }),
            ),
            child_of("user.child", "user.parent"),
            definition(
                "user.child-enum",
                json!({ "parent": "user.parent", "fields": { "y": { "type": "enum" } } }),
            ),
        ]);
        assert!(!problems_of(&verdict, "user.parent.json").is_empty());
        let found = problems_of(&verdict, "user.child.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "validation_error");
        assert_eq!(found[0].path, "parent");
        assert_eq!(found[0].message, "Parent type \"user.parent\" not found");
        assert_eq!(
            context_of_file(&verdict, "user.child.json"),
            Some("The parent \"user.parent\" was refused in this folder.")
        );
        let found = problems_of(&verdict, "user.child-enum.json");
        assert!(
            found.iter().all(|problem| problem.code == "invalid_schema"
                && problem.path == "fields.y.enum_values"),
            "{found:?}"
        );
        assert!(!found.is_empty());
    }

    #[test]
    fn a_file_refused_for_its_name_gives_later_types_nothing_to_stand_on() {
        let body = |parent: Option<&str>| {
            let mut body =
                json!({ "id": "review.parent", "fields": { "x": { "type": "string" } } });
            if let Some(parent) = parent {
                body["parent"] = json!(parent);
            }
            body.to_string()
        };
        let witness = check(&[
            file("review.parent.json", body(None)),
            child_of("review.child", "review.parent"),
        ]);
        assert_eq!(witness.problem_count(), 0, "witness: {witness:?}");

        let verdict = check(&[
            file("Wrong.json", body(None)),
            child_of("review.child", "review.parent"),
            holder("review.holder", "review.parent"),
        ]);
        let found = problems_of(&verdict, "Wrong.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "file_name_mismatch");
        let found = problems_of(&verdict, "review.child.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "validation_error");
        assert_eq!(found[0].message, "Parent type \"review.parent\" not found");
        assert_eq!(
            context_of_file(&verdict, "review.child.json"),
            Some("The parent \"review.parent\" was refused in this folder.")
        );
        let found = problems_of(&verdict, "review.holder.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].message.contains("which is not registered"));

        let named_by_the_child = check(&[
            file("Wrong.json", body(Some("review.child"))),
            child_of("review.child", "review.parent"),
        ]);
        for name in ["Wrong.json", "review.child.json"] {
            let context = context_of_file(&named_by_the_child, name).unwrap_or_default();
            assert!(!context.contains("loop"), "{name}: {context}");
            let found = problems_of(&named_by_the_child, name);
            assert!(
                found
                    .iter()
                    .any(|problem| problem.message.starts_with("Parent type ")
                        && problem.message.ends_with(" not found")),
                "{name}: {found:?}"
            );
        }
    }

    #[test]
    fn a_file_whose_id_is_empty_is_refused_for_its_name_beside_the_servers_answer() {
        let verdict = check(&[file(
            "Empty.json",
            r#"{"id": "", "fields": {"x": {"type": "string"}}}"#,
        )]);
        let found = problems_of(&verdict, "Empty.json");
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].code, "file_name_mismatch");
        assert_eq!(found[0].path, "id");
        assert_eq!(found[1].code, "validation_error");
        assert!(found[1].message.starts_with("Invalid type identifier"));
    }

    #[test]
    fn a_file_with_no_id_or_an_id_that_is_not_a_string_has_only_the_servers_answer() {
        for text in [
            r#"{"fields": {"x": {"type": "string"}}}"#,
            r#"{"id": 7, "fields": {"x": {"type": "string"}}}"#,
            r#"{"id": null, "fields": {"x": {"type": "string"}}}"#,
        ] {
            let verdict = check(&[file("Any.json", text)]);
            let found = problems_of(&verdict, "Any.json");
            assert!(!found.is_empty(), "{text}");
            assert!(
                found
                    .iter()
                    .all(|problem| problem.code != "file_name_mismatch"),
                "{text}: {found:?}"
            );
        }
    }

    #[test]
    fn a_file_name_that_differs_from_the_id_is_refused_including_by_case() {
        let body =
            json!({ "id": "user.recipe", "fields": { "x": { "type": "string" } } }).to_string();
        let witness = check(&[file("user.recipe.json", &body)]);
        assert_eq!(witness.problem_count(), 0, "{witness:?}");
        for name in [
            "recipe.json",
            "User.recipe.json",
            "user.recipe.JSON",
            "user.recipes.json",
        ] {
            let verdict = check(&[file(name, &body)]);
            let found = problems_of(&verdict, name);
            assert!(
                found
                    .iter()
                    .any(|problem| problem.code == "file_name_mismatch" && problem.path == "id"),
                "{name}: {found:?}"
            );
        }
    }

    #[test]
    fn files_that_are_not_type_files_are_left_out() {
        let verdict = check(&[
            file("README.md", "not json"),
            file(".hidden.json", "not json"),
            file("notes.txt", "{"),
            definition(
                "user.ok",
                json!({ "fields": { "x": { "type": "string" } } }),
            ),
        ]);
        assert_eq!(verdict.files.len(), 1, "{verdict:?}");
        assert_eq!(verdict.problem_count(), 0);
    }

    #[test]
    fn a_file_that_cannot_be_read_is_reported_and_the_others_still_checked() {
        let verdict = check(&[
            TypeFile {
                name: "user.locked.json".into(),
                content: Err("Permission denied".into()),
            },
            definition(
                "user.bad",
                json!({ "fields": { "x": { "type": "colour" } } }),
            ),
            definition(
                "user.good",
                json!({ "fields": { "x": { "type": "string" } } }),
            ),
        ]);
        let found = problems_of(&verdict, "user.locked.json");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].code, "file_unreadable");
        assert!(found[0].message.contains("Permission denied"));
        assert!(!problems_of(&verdict, "user.bad.json").is_empty());
        assert!(problems_of(&verdict, "user.good.json").is_empty());
    }

    #[test]
    fn invalid_json_names_the_line_and_column() {
        let verdict = check(&[file(
            "user.x.json",
            "{\n  \"id\": \"user.x\",\n  \"fields\": }\n",
        )]);
        let found = problems_of(&verdict, "user.x.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "validation_error");
        assert!(found[0].message.starts_with("The body is not valid JSON: "));
        assert!(found[0].message.contains("line 3 column 13"), "{found:?}");
    }

    #[test]
    fn invalid_utf8_is_reported_with_where_it_is() {
        let mut bytes = b"{\"id\": \"user.x\",\n \"description\": \"caf".to_vec();
        bytes.extend_from_slice(&[0xE9, b'"', b',', b' ']);
        bytes.extend_from_slice(b"\"fields\": {}}");
        let verdict = check(&[file("user.x.json", bytes)]);
        let found = problems_of(&verdict, "user.x.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].message.starts_with("The body is not valid JSON: "));
        let hint = found[0].hint.as_deref().unwrap();
        assert!(hint.contains("UTF-8") && hint.contains("line 2"), "{hint}");
    }

    #[test]
    fn a_byte_order_mark_is_refused_as_the_servers_parsing_refuses_it() {
        let body = json!({ "id": "user.x", "fields": { "x": { "type": "string" } } }).to_string();
        let witness = check(&[file("user.x.json", &body)]);
        assert_eq!(witness.problem_count(), 0, "{witness:?}");
        let mut marked = vec![0xEF, 0xBB, 0xBF];
        marked.extend_from_slice(body.as_bytes());
        let verdict = check(&[file("user.x.json", marked)]);
        let found = problems_of(&verdict, "user.x.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].message.starts_with("The body is not valid JSON: "));
        assert!(
            found[0]
                .hint
                .as_deref()
                .unwrap()
                .contains("byte-order mark")
        );
    }

    #[test]
    fn a_value_that_is_not_an_object_and_an_empty_file_are_refused() {
        for (text, said) in [
            ("[]", "The body must be a JSON object."),
            ("\"user.x\"", "The body must be a JSON object."),
            ("null", "The body must be a JSON object."),
            ("", "The body is empty; send a JSON object."),
        ] {
            let verdict = check(&[file("user.x.json", text)]);
            let found = problems_of(&verdict, "user.x.json");
            assert_eq!(found.len(), 1, "{text}: {found:?}");
            assert_eq!(found[0].code, "validation_error");
            assert_eq!(found[0].message, said);
        }
    }

    #[test]
    fn every_problem_is_reported_not_only_the_first() {
        let verdict = check(&[definition(
            "user.many",
            json!({ "colour": "red", "fields": {
                "a": { "type": "colour" },
                "b": { "type": "enum" }
            } }),
        )]);
        let paths: Vec<&str> = problems_of(&verdict, "user.many.json")
            .iter()
            .map(|problem| problem.path.as_str())
            .collect();
        for expected in ["colour", "fields.a.type", "fields.b.enum_values"] {
            assert!(
                paths.contains(&expected),
                "{expected} missing from {paths:?}"
            );
        }
    }

    #[test]
    fn a_folder_with_nothing_to_check_has_no_files() {
        assert!(check(&[]).files.is_empty());
        assert!(check(&[file("README.md", "x")]).files.is_empty());
    }

    fn markdown(id: &str, text: impl AsRef<[u8]>) -> TypeFile {
        file(&format!("{id}.md"), text)
    }

    #[test]
    fn a_markdown_file_beside_a_definition_is_its_guidance_trimmed_and_judged() {
        let sample = || {
            definition(
                "user.note",
                json!({ "fields": { "a": { "type": "string" } } }),
            )
        };
        let at_limit = "\u{1F600}".repeat(1000);
        let passed = check(&[sample(), markdown("user.note", format!("{at_limit}\n\n"))]);
        assert_eq!(passed.problem_count(), 0, "{passed:?}");
        let over = check(&[sample(), markdown("user.note", format!("{at_limit}x"))]);
        assert_eq!(problems_of(&over, "user.note.json")[0].path, "guidance");
        let app = definition(
            "app.acme.note",
            json!({ "fields": { "a": { "type": "string" } } }),
        );
        let refused = check(&[app, markdown("app.acme.note", "Use it.")]);
        assert_eq!(
            problems_of(&refused, "app.acme.note.json")[0].path,
            "guidance"
        );
        let none = definition(
            "app.acme.quiet",
            json!({ "fields": { "a": { "type": "string" } } }),
        );
        assert_eq!(
            check(&[none, markdown("app.acme.quiet", " \n")]).problem_count(),
            0
        );
    }

    #[test]
    fn a_markdown_file_that_cannot_be_read_or_is_named_twice_refuses_the_definition() {
        let sample = || {
            definition(
                "user.note",
                json!({ "fields": { "a": { "type": "string" } } }),
            )
        };
        let named = definition(
            "user.note",
            json!({ "guidance": "x", "fields": { "a": { "type": "string" } } }),
        );
        assert_eq!(check(std::slice::from_ref(&named)).problem_count(), 0);
        let twice = check(&[named, markdown("user.note", "")]);
        assert_eq!(
            problems_of(&twice, "user.note.json")[0].code,
            "guidance_named_twice"
        );
        for (bytes, said) in [
            (vec![0xEF, 0xBB, 0xBF, b'x'], "byte-order mark"),
            (vec![b'x', 0xE9], "not UTF-8"),
        ] {
            let refused = check(&[sample(), markdown("user.note", bytes)]);
            let found = problems_of(&refused, "user.note.json");
            assert_eq!(found[0].code, "guidance_file_unreadable");
            assert!(found[0].message.contains(said), "{found:?}");
        }
        let unread = TypeFile {
            name: "user.note.md".into(),
            content: Err("denied".into()),
        };
        let refused = check(&[sample(), unread]);
        assert!(
            problems_of(&refused, "user.note.json")[0]
                .message
                .contains("denied")
        );
    }

    #[test]
    fn a_markdown_file_named_for_a_type_without_a_definition_is_refused_and_others_are_left() {
        let sample = || {
            definition(
                "user.note",
                json!({ "fields": { "a": { "type": "string" } } }),
            )
        };
        let verdict = check(&[
            sample(),
            markdown("user.note", "x"),
            markdown("user.other", "x"),
            markdown("README", "x"),
            file(".user.hidden.md", "x"),
        ]);
        assert_eq!(verdict.files.len(), 2, "{verdict:?}");
        assert_eq!(
            problems_of(&verdict, "user.other.md")[0].code,
            "guidance_file_without_definition"
        );
        assert_eq!(problems_of(&verdict, "user.note.json").len(), 0);
    }

    fn said<'a>(verdict: &'a FolderVerdict, name: &str) -> &'a str {
        context_of_file(verdict, name).unwrap_or_default()
    }

    #[test]
    fn a_markdown_file_beside_a_refused_definition_is_paired_with_it_not_orphaned() {
        let sample = || {
            definition(
                "user.note",
                json!({ "fields": { "a": { "type": "string" } } }),
            )
        };
        let unreadable = TypeFile {
            name: "user.broken.json".into(),
            content: Err("denied".into()),
        };
        for broken in [file("user.broken.json", "{ not json"), unreadable] {
            let verdict = check(&[sample(), broken, markdown("user.broken", "Use it.")]);
            assert_eq!(verdict.files.len(), 2, "{verdict:?}");
            assert!(
                said(&verdict, "user.broken.json").contains("user.broken.md"),
                "{verdict:?}"
            );
        }
        let orphan = check(&[sample(), markdown("user.broken", "Use it.")]);
        assert_eq!(
            problems_of(&orphan, "user.broken.md")[0].code,
            "guidance_file_without_definition"
        );
    }

    #[test]
    fn a_parent_refused_for_its_guidance_file_is_refused_in_the_folder_not_missing_from_it() {
        let parent = definition(
            "user.base",
            json!({ "fields": { "a": { "type": "string" } } }),
        );
        let child = definition(
            "user.leaf",
            json!({ "parent": "user.base", "fields": { "b": { "type": "string" } } }),
        );
        let verdict = check(&[parent.clone(), child.clone(), markdown("user.base", [0xE9])]);
        assert_eq!(
            problems_of(&verdict, "user.base.json")[0].code,
            "guidance_file_unreadable"
        );
        let text = said(&verdict, "user.leaf.json");
        assert!(text.contains("was refused in this folder"), "{text}");
        assert!(!text.contains("is not shipped or in this folder"), "{text}");
        let witness = check(&[child]);
        assert!(said(&witness, "user.leaf.json").contains("is not shipped or in this folder"));
    }

    #[test]
    fn a_markdown_name_that_differs_by_case_is_not_the_guidance_file() {
        let sample = definition(
            "user.note",
            json!({ "fields": { "a": { "type": "string" } } }),
        );
        let over = "a".repeat(1001);
        let verdict = check(&[
            sample.clone(),
            file("user.note.MD", &over),
            file("user.other.MD", &over),
        ]);
        assert_eq!(verdict.problem_count(), 0, "{verdict:?}");
        assert_eq!(verdict.files.len(), 1);
        let witness = check(&[sample, markdown("user.note", over)]);
        assert_eq!(witness.problem_count(), 1);
    }

    #[test]
    fn a_definition_with_a_markdown_file_is_judged_in_one_order() {
        let named = |text: &str| {
            definition(
                "user.note",
                json!({ "guidance": text, "fields": { "a": { "type": "string" } } }),
            )
        };
        let code = |verdict: &FolderVerdict| {
            let found = problems_of(verdict, "user.note.json");
            assert_eq!(found.len(), 1, "{found:?}");
            found[0].code
        };
        for sibling in [vec![], b" \n".to_vec(), b"Use it.".to_vec()] {
            assert_eq!(
                code(&check(&[named("x"), markdown("user.note", sibling)])),
                "guidance_named_twice"
            );
        }
        for sibling in [
            vec![0xEF, 0xBB, 0xBF],
            vec![0xEF, 0xBB, 0xBF, b'x'],
            vec![0xE9],
        ] {
            assert_eq!(
                code(&check(&[named("x"), markdown("user.note", sibling)])),
                "guidance_file_unreadable"
            );
        }
        let unread = TypeFile {
            name: "user.note.md".into(),
            content: Err("denied".into()),
        };
        assert_eq!(
            code(&check(&[named("x"), unread])),
            "guidance_file_unreadable"
        );
    }

    #[test]
    fn the_markdown_file_of_a_definition_has_the_same_name_with_md() {
        assert_eq!(
            guidance_file_name("user.note.json").as_deref(),
            Some("user.note.md")
        );
        assert_eq!(guidance_file_name("User.JSON").as_deref(), Some("User.md"));
        assert_eq!(guidance_file_name("user.note.md"), None);
        assert_eq!(guidance_file_name("json"), None);
        assert_eq!(
            read_guidance_file(b"Use it.\r\n\n").as_deref(),
            Ok("Use it.")
        );
    }
}
