//! A folder of type definitions judged as a server judges each at registration, with no instance behind it.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{
    CIRCULAR_INHERITANCE, Obj, Registry, SchemaVerdict, early_refusal, labelled,
    parent_chain_fault, validate_type,
};
use crate::builtin;
use crate::error::RuleError;

/// A file in the folder: its name, and its bytes or why they could not be read.
#[derive(Debug, Clone)]
pub struct TypeFile {
    pub name: String,
    pub content: Result<Vec<u8>, String>,
}

/// One thing wrong in a file. `code` is the one the server answers the registration with.
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

/// A type definition, by file name; anything else in the folder is not one.
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

fn with_hint(mut problem: Problem, hint: impl Into<String>) -> Problem {
    problem.hint = Some(hint.into());
    problem
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
    Compat,
}

/// The ids a definition names in `compatible_with`.
fn compat_targets(body: &Obj) -> Vec<&str> {
    match body.get("compatible_with") {
        Some(Value::String(target)) => vec![target.as_str()],
        Some(Value::Array(targets)) => targets.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

struct Entry {
    file: usize,
    id: String,
    body: Obj,
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
        })
        .collect();
    let mut entries: Vec<Entry> = Vec::new();
    for (at, file) in candidates.iter().enumerate() {
        let body = match &file.content {
            Err(why) => {
                verdicts[at].problems.push(problem(
                    "",
                    "file_unreadable",
                    format!("Cannot read the file: {why}"),
                ));
                continue;
            }
            Ok(bytes) => match read(bytes) {
                Ok(body) => body,
                Err(refused) => {
                    verdicts[at].problems.push(refused);
                    continue;
                }
            },
        };
        match body.get("id").and_then(Value::as_str) {
            Some(id) => {
                verdicts[at].id = Some(id.to_string());
                entries.push(Entry {
                    file: at,
                    id: id.to_string(),
                    body,
                });
            }
            None => entries.push(Entry {
                file: at,
                id: String::new(),
                body,
            }),
        }
    }
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
        .map(|entry| {
            let mut found: Vec<(usize, Link)> = Vec::new();
            let parent = entry
                .body
                .get("parent")
                .and_then(Value::as_str)
                .filter(|parent| !shipped.contains(parent));
            let targets = compat_targets(&entry.body)
                .into_iter()
                .filter(|target| !shipped.contains(target))
                .map(|target| (target, Link::Compat));
            for (named, link) in parent.map(|p| (p, Link::Parent)).into_iter().chain(targets) {
                if let Some(index) = by_id.get(named)
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
    let mut refused: HashSet<usize> = HashSet::new();
    for &index in &order.ready {
        let entry = &entries[index];
        let found = judge(
            entry,
            &candidates[entry.file].name,
            &working,
            &refused,
            &links[index],
            &entries,
        )?;
        match found {
            Ok(stored) => working = working.with(stored),
            Err(problems) => {
                refused.insert(index);
                verdicts[entry.file].problems.extend(problems);
            }
        }
    }
    for &index in &order.stuck {
        let entry = &entries[index];
        let found = match loop_through(index, &links, &order.stuck) {
            Some(path) => {
                let parents_only = path.iter().all(|(_, link)| *link == Link::Parent);
                let mut names: Vec<&str> = path
                    .iter()
                    .map(|(at, _)| entries[*at].id.as_str())
                    .collect();
                names.push(entry.id.as_str());
                let shown = names.join(" -> ");
                if parents_only {
                    with_hint(
                        problem(PARENT_PATH, "validation_error", CIRCULAR_INHERITANCE),
                        format!("The loop is {shown}."),
                    )
                } else {
                    with_hint(
                        problem(
                            "compatible_with",
                            "compatible_with_violation",
                            "Types that name each other as a parent or in compatible_with cannot be registered in any order.",
                        ),
                        format!("The loop is {shown}."),
                    )
                }
            }
            None => {
                let (blocker, link) = links[index]
                    .iter()
                    .find(|(dependency, _)| order.stuck.contains(dependency))
                    .copied()
                    .unwrap_or((index, Link::Parent));
                refusal_of_dependency(&entries[blocker].id, link)
            }
        };
        verdicts[entry.file].problems.push(found);
    }
    Ok(FolderVerdict { files: verdicts })
}

fn refusal_of_dependency(id: &str, link: Link) -> Problem {
    match link {
        Link::Parent => problem(
            PARENT_PATH,
            "parent_refused",
            format!(
                "Parent type \"{id}\" is refused, so this type cannot be checked until \"{id}\" is fixed."
            ),
        ),
        Link::Compat => problem(
            "compatible_with",
            "compatible_with_refused",
            format!(
                "compatible_with names \"{id}\", which is refused, so this type cannot be checked until \"{id}\" is fixed."
            ),
        ),
    }
}

/// One type as the server registers it, against the types that registered before it: what it would store, or what it would be refused for.
fn judge(
    entry: &Entry,
    file_name: &str,
    working: &Registry,
    refused: &HashSet<usize>,
    links: &[(usize, Link)],
    entries: &[Entry],
) -> Result<Result<Obj, Vec<Problem>>, RuleError> {
    let mut problems: Vec<Problem> = Vec::new();
    if !entry.id.is_empty() && file_name != format!("{}.json", entry.id) {
        problems.push(problem(
            "id",
            "file_name_mismatch",
            format!(
                "The file is named \"{file_name}\" but its id is \"{}\": name the file \"{}.json\".",
                entry.id, entry.id
            ),
        ));
    }
    if let Some(early) = early_refusal(&entry.body)? {
        problems.push(problem(early.path(), early.code(), early.message()));
        return Ok(Err(problems));
    }
    if let Some((blocker, link)) = links
        .iter()
        .find(|(dependency, _)| refused.contains(dependency))
    {
        problems.push(refusal_of_dependency(&entries[*blocker].id, *link));
        return Ok(Err(problems));
    }
    let parent = entry
        .body
        .get("parent")
        .and_then(Value::as_str)
        .filter(|parent| !parent.is_empty());
    if let Some(parent) = parent
        && !working.contains(parent)
        && let Some(fault) = parent_chain_fault(working, &entry.id, parent, 0)
    {
        problems.push(problem(PARENT_PATH, "validation_error", fault));
        return Ok(Err(problems));
    }
    match validate_type(&Value::Object(entry.body.clone()), working) {
        Err(issues) => {
            let code = SchemaVerdict::of(&issues).code();
            problems.extend(
                issues
                    .iter()
                    .map(|issue| problem(&issue.field, code, issue.message())),
            );
            Ok(Err(problems))
        }
        Ok(schema) => {
            let schema = labelled(schema);
            if let Some(parent) = schema.get("parent").and_then(Value::as_str)
                && let Some(fault) = parent_chain_fault(working, &entry.id, parent, 0)
            {
                problems.push(problem(PARENT_PATH, "validation_error", fault));
            }
            Ok(if problems.is_empty() {
                Ok(schema)
            } else {
                Err(problems)
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

    #[test]
    fn a_missing_parent_is_named_alone() {
        let verdict = check(&[definition(
            "user.orphan",
            json!({ "parent": "user.gone", "fields": { "x": { "type": "string" } } }),
        )]);
        let found = problems_of(&verdict, "user.orphan.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "validation_error");
        assert_eq!(found[0].path, "parent");
        assert_eq!(found[0].message, "Parent type \"user.gone\" not found");
    }

    #[test]
    fn a_parent_cycle_is_named_for_each_type_in_it_and_not_for_a_type_below() {
        let child = |id: &str, parent: &str| {
            definition(
                id,
                json!({ "parent": parent, "fields": { "x": { "type": "string" } } }),
            )
        };
        let verdict = check(&[
            child("user.a", "user.b"),
            child("user.b", "user.a"),
            child("user.below", "user.a"),
            child("user.fine", "core.note"),
        ]);
        for name in ["user.a.json", "user.b.json"] {
            let found = problems_of(&verdict, name);
            assert_eq!(found.len(), 1, "{name}: {found:?}");
            assert_eq!(found[0].message, "Circular inheritance detected");
            assert_eq!(found[0].path, "parent");
            assert!(found[0].hint.as_deref().unwrap().contains("user.a"));
        }
        let below = problems_of(&verdict, "user.below.json");
        assert_eq!(below.len(), 1, "{below:?}");
        assert_eq!(below[0].code, "parent_refused");
        assert!(below[0].message.contains("user.a"), "{below:?}");
        assert!(problems_of(&verdict, "user.fine.json").is_empty());
    }

    #[test]
    fn a_type_is_judged_after_the_folder_type_it_claims_to_be_compatible_with() {
        let target = definition(
            "user.z-target",
            json!({ "fields": { "x": { "type": "string", "required": true } } }),
        );
        let claimant = |claims: &str| {
            definition(
                "user.a-claimant",
                json!({ "compatible_with": claims, "fields": {
                    "x": { "type": "string", "required": true },
                    "y": { "type": "string" }
                } }),
            )
        };
        let verdict = check(&[claimant("user.z-target"), target.clone()]);
        assert_eq!(verdict.problem_count(), 0, "{verdict:?}");
        let looped = check(&[
            claimant("user.z-target"),
            definition(
                "user.z-target",
                json!({ "compatible_with": "user.a-claimant", "fields": { "x": { "type": "string", "required": true } } }),
            ),
        ]);
        for name in ["user.a-claimant.json", "user.z-target.json"] {
            let found = problems_of(&looped, name);
            assert_eq!(found.len(), 1, "{name}: {found:?}");
            assert_eq!(found[0].code, "compatible_with_violation");
            assert_eq!(found[0].path, "compatible_with");
        }
        let broken = check(&[claimant("user.nothing"), target]);
        assert!(!problems_of(&broken, "user.a-claimant.json").is_empty());
    }

    #[test]
    fn a_type_naming_itself_as_its_parent_is_a_cycle() {
        let verdict = check(&[definition(
            "user.self",
            json!({ "parent": "user.self", "fields": { "x": { "type": "string" } } }),
        )]);
        let found = problems_of(&verdict, "user.self.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].message, "Circular inheritance detected");
    }

    #[test]
    fn a_child_of_a_refused_parent_says_so_and_not_what_the_parent_got_wrong() {
        let verdict = check(&[
            definition(
                "user.parent",
                json!({ "fields": { "x": { "type": "colour" } } }),
            ),
            definition(
                "user.child",
                json!({ "parent": "user.parent", "fields": { "y": { "type": "string" } } }),
            ),
        ]);
        assert!(!problems_of(&verdict, "user.parent.json").is_empty());
        let found = problems_of(&verdict, "user.child.json");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "parent_refused");
        assert_eq!(found[0].path, "parent");
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
}
