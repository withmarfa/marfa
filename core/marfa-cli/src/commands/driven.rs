//! Tests that run every command in the binary, in this process, against a
//! server that answers one way: what each does when the server redirects, and
//! what each sends, held to `openapi.json`.
//!
//! Nothing here lists a command's arguments. The parser says which are
//! missing and which values it refuses, and the walk gives each the first
//! value it takes, so a command added to the tree is driven without being
//! named.

use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::{Command, CommandFactory, Parser};
use serde_json::Value;

use crate::door::{Received, read_request};

const GUESSES: [&str; 4] = ["x", "1", "{}", "2026-01-01T00:00:00Z"];

/// A server on a local port that answers every request the one way it was
/// told to, and keeps what it was asked.
struct Server {
    url: String,
    asked: Arc<Mutex<Vec<Received>>>,
}

impl Server {
    fn answering(
        status: &'static str,
        extra: &'static str,
        body: &'static str,
        root_open: bool,
    ) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let asked: Arc<Mutex<Vec<Received>>> = Arc::default();
        let kept = Arc::clone(&asked);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let kept = Arc::clone(&kept);
                std::thread::spawn(move || {
                    // The body too: an answer written over an unread one is a
                    // reset the caller sees instead of the answer.
                    let received = read_request(&mut stream);
                    // A write that mints is sent after the root names the
                    // contract, so the root is answered as a server answers it.
                    let (status, extra, body) = if root_open && received.path() == "/" {
                        ("200 OK", "", r#"{"name":"marfa"}"#)
                    } else {
                        (status, extra, body)
                    };
                    kept.lock().unwrap().push(received);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        marfa_core::http::CONTRACT_HEADER,
                        marfa_core::contract::CONTRACT_VERSION,
                        body.len(),
                    );
                });
            }
        });
        Server { url, asked }
    }

    fn take(&self) -> Vec<Received> {
        std::mem::take(&mut *self.asked.lock().unwrap())
    }
}

/// A flag of a command, with the values it takes where the parser
/// names them.
struct Flag {
    spelling: String,
    values: Vec<String>,
}

/// A command the tree holds at its leaves: the words that name it, and what
/// it takes.
struct Leaf {
    words: Vec<String>,
    flags: Vec<Flag>,
}

impl Leaf {
    fn variants(&self) -> Vec<(Vec<String>, bool)> {
        // Each flag alone, with each value the parser names, or, where
        // it takes any text, with the first of these the command accepts.
        const TEXTS: [&str; 5] = ["x", "{}", "x=x", "1", "2026-01-01T00:00:00Z"];
        let mut variants: Vec<(Vec<String>, bool)> = vec![(Vec::new(), false)];
        for flag in &self.flags {
            if flag.values.is_empty() && !flag.spelling.contains('<') {
                variants.push((vec![flag.spelling.clone()], false));
            }
            for value in &flag.values {
                variants.push((vec![flag.spelling.clone(), value.clone()], true));
            }
            if flag.values.is_empty() && flag.spelling.contains('<') {
                for text in TEXTS {
                    variants.push((vec![flag.spelling.clone(), text.into()], false));
                }
            }
        }
        variants
    }
}

fn leaves(command: &Command, words: &mut Vec<String>, found: &mut Vec<Leaf>) {
    let subcommands: Vec<&Command> = command
        .get_subcommands()
        .filter(|sub| sub.get_name() != "help")
        .collect();
    if subcommands.is_empty() {
        let flags = command
            .get_arguments()
            .filter(|argument| {
                !argument.is_global_set()
                    && !argument.is_positional()
                    && argument.get_long().is_some()
                    && !matches!(argument.get_id().as_str(), "help" | "version")
            })
            .map(|argument| {
                let long = argument.get_long().unwrap();
                Flag {
                    spelling: if argument.get_action().takes_values() {
                        format!("--{long} <VALUE>")
                    } else {
                        format!("--{long}")
                    },
                    values: argument
                        .get_possible_values()
                        .iter()
                        .map(|value| value.get_name().to_string())
                        .collect(),
                }
            })
            .collect();
        found.push(Leaf {
            words: words.clone(),
            flags,
        });
        return;
    }
    for sub in subcommands {
        words.push(sub.get_name().to_string());
        leaves(sub, words, found);
        words.pop();
    }
}

fn every_leaf() -> Vec<Leaf> {
    let tree = crate::Cli::command();
    let mut found = Vec::new();
    leaves(&tree, &mut Vec::new(), &mut found);
    found
}

/// Where a command has no use: what is not a request to the server, what
/// writes this machine's own state, or needs a person at a terminal. Each
/// says why.
fn skipped(words: &[String]) -> bool {
    let first = words.first().map(String::as_str);
    // A working copy is the core's, and its requests are the core's own, held
    // by the fixtures in `device/`.
    first == Some("device")
        || first == Some("operations")
        // A folder on this machine is listed in a registry of the person's own;
        // only the three that write a folder's settings to the server are
        // requests.
        || (first == Some("folders")
            && !matches!(words.get(1).map(String::as_str), Some("create" | "change" | "revoke")))
        // A browser and the keychain.
        || matches!(first, Some("login" | "logout"))
        // A password, on a terminal.
        || words == ["owner", "create"]
        // Removes this machine's stored key and sends nothing.
        || words == ["keys", "forget"]
}

/// What a command is given beyond what the parser requires, because it
/// would otherwise read it from a terminal.
fn always(words: &[String]) -> Vec<(String, Option<String>)> {
    if words == ["keys", "bootstrap"] {
        return vec![("--secret <VALUE>".into(), None)];
    }
    Vec::new()
}

/// A command line the parser takes, for `words` with `extra` given beyond what
/// it requires: each argument the parser says is missing or refuses given the
/// first value it takes.
fn command_line(
    url: &str,
    words: &[String],
    extra: &[(String, Option<String>)],
    file: &Path,
) -> Result<Vec<String>, String> {
    let mut given: Vec<(String, usize, Option<String>)> = extra
        .iter()
        .chain(always(words).iter())
        .map(|(spelling, chosen)| (spelling.clone(), 0, chosen.clone()))
        .collect();
    let line = |given: &[(String, usize, Option<String>)]| -> Vec<String> {
        let mut line: Vec<String> = ["marfa", "--json", "--url", url, "--key", "marfa_k1_x"]
            .map(String::from)
            .into();
        line.extend(words.iter().cloned());
        for (spelling, guess, chosen) in given {
            let name = spelling
                .trim_matches(|c| "<>-".contains(c))
                .to_ascii_lowercase();
            let value = match chosen {
                Some(chosen) => chosen.clone(),
                None if name.contains("file") || name.contains("path") => {
                    file.display().to_string()
                }
                // A flag that takes JSON is told so by its name: the parser takes
                // any text and the command refuses what is not JSON.
                None if *guess == 0
                    && ["json", "patch", "properties", "body"]
                        .iter()
                        .any(|word| name.contains(word)) =>
                {
                    "{}".to_string()
                }
                None => GUESSES[*guess].to_string(),
            };
            if spelling.starts_with("--") {
                line.push(spelling.split(' ').next().unwrap().to_string());
                if spelling.contains('<') {
                    line.push(value);
                }
            } else {
                line.push(value);
            }
        }
        line
    };
    for _ in 0..40 {
        let attempt = line(&given);
        let error = match crate::Cli::try_parse_from(&attempt) {
            Ok(_) => return Ok(attempt),
            Err(error) => error,
        };
        let named = |kind| match error.get(kind) {
            Some(ContextValue::Strings(names)) => names.clone(),
            Some(ContextValue::String(name)) => vec![name.clone()],
            _ => Vec::new(),
        };
        match error.kind() {
            ErrorKind::MissingRequiredArgument => {
                for name in named(ContextKind::InvalidArg) {
                    given.push((name, 0, None));
                }
            }
            ErrorKind::InvalidValue | ErrorKind::ValueValidation => {
                let refused = named(ContextKind::InvalidArg);
                let Some(entry) = refused
                    .first()
                    .and_then(|refused| given.iter_mut().find(|(name, ..)| name == refused))
                else {
                    return Err(error.to_string());
                };
                // A closed set names its values, and the first is taken.
                if let Some(valid) = named(ContextKind::ValidValue).first() {
                    entry.2 = Some(valid.clone());
                } else {
                    entry.1 += 1;
                    if entry.1 >= GUESSES.len() {
                        return Err(error.to_string());
                    }
                }
            }
            _ => return Err(error.to_string()),
        }
    }
    Err("the arguments never settled".to_string())
}

/// A directory for the files the commands read.
fn fixture(label: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("marfa-driven-{label}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("bytes.bin");
    (dir, file)
}

/// What a command that takes its body from a file is given in it: the body
/// it can read and send.
fn file_body(words: &[String]) -> &'static str {
    match words.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["items", "bulk"] => r#"{"items":[]}"#,
        ["edges", "bulk"] => r#"{"edges":[]}"#,
        ["connectors", "agreements", "write"] => r#"{"clear":[]}"#,
        ["types", "register"] | ["edge-types", "register"] => r#"{"id":"user.x"}"#,
        _ => "{}",
    }
}

#[test]
fn every_command_refuses_a_redirect_the_same_way() {
    use crate::error::CliError;
    let server = Server::answering(
        "302 Found",
        "Location: https://elsewhere.example/\r\n",
        "",
        false,
    );
    let (dir, file) = fixture("redirects");
    let mut driven = 0;
    let mut elsewhere = Vec::new();
    for leaf in every_leaf() {
        if skipped(&leaf.words) {
            continue;
        }
        let name = leaf.words.join(" ");
        std::fs::write(&file, file_body(&leaf.words)).unwrap();
        let argv = match command_line(&server.url, &leaf.words, &[], &file) {
            Ok(argv) => argv,
            Err(error) => {
                elsewhere.push(format!(
                    "`marfa {name}`: no command line the parser takes: {error}"
                ));
                continue;
            }
        };
        let cli = crate::Cli::try_parse_from(&argv).unwrap();
        match crate::run(cli) {
            Err(CliError::Redirected {
                status: 302,
                location,
                ..
            }) => {
                assert_eq!(location.as_deref(), Some("https://elsewhere.example/"));
                driven += 1;
            }
            other => elsewhere.push(format!("`marfa {name}` answered {:?}", other.map(|_| ()))),
        }
    }
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(elsewhere.is_empty(), "{}", elsewhere.join("\n"));
    assert!(
        driven > 60,
        "only {driven} commands were driven, which is too few to be every command"
    );
}

/// The document the server publishes, read as the commands are held to it.
struct Document(Value);

impl Document {
    fn read() -> Document {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../openapi.json");
        Document(
            serde_json::from_str(
                &std::fs::read_to_string(&path)
                    .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display())),
            )
            .unwrap(),
        )
    }

    /// The operation a request is for: the template with the most fixed
    /// segments that the path fits, so `/items/stats` is not `/items/{id}`.
    fn operation(&self, method: &str, path: &str) -> Option<(&str, &Value)> {
        let method = method.to_ascii_lowercase();
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        let mut best: Option<(usize, &str, &Value)> = None;
        for (template, methods) in self.0["paths"].as_object().unwrap() {
            let Some(operation) = methods.get(&method) else {
                continue;
            };
            let fixed: Vec<&str> = template.trim_matches('/').split('/').collect();
            if fixed.len() != segments.len()
                || !fixed
                    .iter()
                    .zip(&segments)
                    .all(|(want, got)| (want.starts_with('{') && !got.is_empty()) || want == got)
            {
                continue;
            }
            let literal = fixed.iter().filter(|word| !word.starts_with('{')).count();
            if best.is_none_or(|(held, ..)| literal > held) {
                best = Some((literal, template, operation));
            }
        }
        best.map(|(_, template, operation)| (template, operation))
    }

    /// A schema with its references followed.
    fn resolved<'a>(&'a self, schema: &'a Value) -> &'a Value {
        let mut schema = schema;
        while let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            schema = reference
                .strip_prefix("#/")
                .unwrap()
                .split('/')
                .fold(&self.0, |at, key| &at[key]);
        }
        schema
    }

    /// What is wrong with `value` against `schema`: a key the schema does not
    /// declare, or a value outside an enum. Where a schema leaves a part of
    /// the value open, as `additionalProperties: {}` does, the part is not read.
    fn mismatches(&self, schema: &Value, value: &Value, at: &str, found: &mut Vec<String>) {
        let schema = self.resolved(schema);
        for combined in ["oneOf", "anyOf"] {
            if let Some(branches) = schema.get(combined).and_then(Value::as_array) {
                let passing = branches.iter().any(|branch| {
                    let mut own = Vec::new();
                    self.mismatches(branch, value, at, &mut own);
                    own.is_empty()
                });
                if !passing {
                    found.push(format!("{at}: {value} fits none of the schema's branches"));
                }
                return;
            }
        }
        if let Some(branches) = schema.get("allOf").and_then(Value::as_array) {
            for branch in branches {
                self.mismatches(branch, value, at, found);
            }
        }
        if let Some(values) = schema.get("enum").and_then(Value::as_array)
            && !values.contains(value)
        {
            found.push(format!("{at}: {value} is not one of {values:?}"));
        }
        match value {
            Value::Object(fields) => {
                let declared = schema.get("properties").and_then(Value::as_object);
                let open = schema.get("additionalProperties");
                for (key, held) in fields {
                    match (declared.and_then(|declared| declared.get(key)), open) {
                        (Some(property), _) => {
                            self.mismatches(property, held, &format!("{at}.{key}"), found)
                        }
                        (None, Some(Value::Object(extra))) if !extra.is_empty() => self.mismatches(
                            &Value::Object(extra.clone()),
                            held,
                            &format!("{at}.{key}"),
                            found,
                        ),
                        (None, Some(Value::Object(_) | Value::Bool(true))) => {}
                        (None, _) if declared.is_none() => {}
                        (None, _) => found.push(format!("{at}: `{key}` is not declared")),
                    }
                }
            }
            Value::Array(elements) => {
                if let Some(items) = schema.get("items") {
                    for (index, element) in elements.iter().enumerate() {
                        self.mismatches(items, element, &format!("{at}[{index}]"), found);
                    }
                }
            }
            _ => {}
        }
    }

    /// What a request sent is wrong with, against the operation it is for.
    /// A value outside an enum is the command's only where the command named
    /// the value (`values_named`): a flag that takes any text leaves the
    /// refusal to the server.
    fn held(&self, request: &Received, values_named: bool) -> Result<String, String> {
        let method = request.method();
        let (path, query) = request
            .path()
            .split_once('?')
            .unwrap_or((request.path(), ""));
        // The health door is for whatever watches the server, and the document
        // leaves it out.
        if (method, path) == ("GET", "/health") {
            return Ok("health".into());
        }
        let (template, operation) = self
            .operation(method, path)
            .ok_or_else(|| format!("{method} {path} is no operation the document publishes"))?;
        let id = operation["operationId"].as_str().unwrap().to_string();
        let mut found = Vec::new();
        let parameters: Vec<&Value> = operation
            .get("parameters")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|parameter| self.resolved(parameter))
            .collect();
        for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
            let declared = parameters
                .iter()
                .find(|parameter| parameter["in"] == "query" && parameter["name"] == name.as_ref());
            match declared {
                None => found.push(format!("query `{name}` is not declared")),
                Some(parameter) => self.mismatches(
                    &parameter["schema"],
                    &Value::String(value.to_string()),
                    &format!("query `{name}`"),
                    &mut found,
                ),
            }
        }
        let json = request
            .header("content-type")
            .is_some_and(|kind| kind.starts_with("application/json"));
        if json && !request.body.is_empty() {
            let body: Value = serde_json::from_str(&request.body)
                .map_err(|error| format!("{id}: the body is not JSON: {error}"))?;
            match operation["requestBody"]["content"]["application/json"].get("schema") {
                Some(schema) => self.mismatches(schema, &body, "body", &mut found),
                None => found.push("a JSON body the operation does not take".into()),
            }
        }
        if !values_named {
            found.retain(|line| !line.contains("is not one of") && !line.contains("fits none of"));
        }
        if found.is_empty() {
            Ok(format!("{id} ({template})"))
        } else {
            Err(format!("{id}: {}", found.join("; ")))
        }
    }
}

/// The operations no request in the walk reaches, each with its reason. The
/// walk keeps a command's first request and stops at the server's refusal, so
/// a command whose first request is another door's, and a command not driven,
/// do not reach theirs.
const MISSED: &[&str] = &[
    // `login`: found by discovery and sent in a browser flow.
    "registerOAuthClient",
    // `owner create`: asks for the password on a terminal first.
    "createOwner",
];

/// The witness for the walk's claim that nothing it sends is off the document:
/// a request that is held is let through, and each way of being off it is
/// refused.
#[test]
fn the_document_check_lets_a_held_request_through_and_refuses_each_way_off_it() {
    let document = Document::read();
    let asking = |line: &str, body: &str| Received {
        line: format!("{line} HTTP/1.1"),
        headers: vec![("content-type".into(), "application/json".into())],
        body: body.into(),
    };
    assert!(document.held(&asking("GET /items/stats", ""), true).is_ok());
    for (what, request) in [
        ("a path", asking("GET /itemz/stats", "")),
        ("a method", asking("PUT /items/stats", "")),
        ("a query name", asking("GET /items/stats?bogus=1", "")),
        ("a body key", asking("POST /items", r#"{"bogus":1}"#)),
        ("an enum value", asking("GET /items?direction=bogus", "")),
    ] {
        assert!(
            document.held(&request, true).is_err(),
            "{what} off the document was let through"
        );
    }
}

#[test]
fn required_enum_flags_are_driven_and_held_to_the_document() {
    let leaf = every_leaf()
        .into_iter()
        .find(|leaf| leaf.words == ["items", "transition"])
        .unwrap();
    let flag = leaf
        .flags
        .iter()
        .find(|flag| flag.spelling.starts_with("--state "))
        .expect("a required enum flag was excluded from the walk");
    assert_eq!(flag.values, ["active", "archived", "trashed"]);
    let server = Server::answering("400 Bad Request", "", "{}", true);
    let (dir, file) = fixture("required-enum");
    let document = Document::read();
    let mut renamed = Document(document.0.clone());
    renamed.0["paths"]["/items/{id}/transition"]["post"]["requestBody"]["content"]["application/json"]
        ["schema"]["properties"]["state"]["enum"] = serde_json::json!(["renamed"]);
    let variants: Vec<_> = leaf
        .variants()
        .into_iter()
        .filter(|(given, _)| given.first() == Some(&flag.spelling))
        .collect();
    assert_eq!(variants.len(), flag.values.len());
    for (given, named) in variants {
        let argv = command_line(
            &server.url,
            &leaf.words,
            &[(given[0].clone(), Some(given[1].clone()))],
            &file,
        )
        .unwrap();
        let _ = crate::run(crate::Cli::try_parse_from(argv).unwrap());
        let asked = server.take();
        assert_eq!(asked.len(), 1);
        assert!(document.held(&asked[0], named).is_ok());
        assert!(renamed.held(&asked[0], named).is_err());
    }
    std::fs::remove_dir_all(dir).unwrap();
}

/// A command's every request, sent in turn: the leaf by itself, and then with
/// each flag, and each value a flag names, including required flags.
#[test]
fn every_request_a_command_sends_is_one_the_document_publishes() {
    let server = Server::answering(
        "400 Bad Request",
        "",
        r#"{"error":{"code":"validation_error","message":"refused"}}"#,
        true,
    );
    let document = Document::read();
    let (dir, file) = fixture("wire");
    let mut reached: Vec<String> = Vec::new();
    let mut wrong = Vec::new();
    let mut sent = 0;
    for leaf in every_leaf() {
        if skipped(&leaf.words) {
            continue;
        }
        let name = leaf.words.join(" ");
        std::fs::write(&file, file_body(&leaf.words)).unwrap();
        let variants = leaf.variants();
        // A flag whose text a command refused before sending anything is tried
        // again with the next, so one is kept per flag.
        let mut satisfied: Vec<String> = Vec::new();
        for (flag, named) in variants {
            let spelling = flag.first().cloned().unwrap_or_default();
            if !named && flag.len() == 2 && satisfied.contains(&spelling) {
                continue;
            }
            let extra: Vec<(String, Option<String>)> = match flag.as_slice() {
                [] => Vec::new(),
                [spelling] => vec![(spelling.clone(), None)],
                [spelling, value] => vec![(spelling.clone(), Some(value.clone()))],
                _ => unreachable!(),
            };
            // A flag that cannot stand with what the leaf requires is a
            // combination the parser refuses, which is not the command's.
            let Ok(argv) = command_line(&server.url, &leaf.words, &extra, &file) else {
                continue;
            };
            let cli = crate::Cli::try_parse_from(&argv).unwrap();
            let _ = crate::run(cli);
            let asked = server.take();
            if !asked.is_empty() && !named {
                satisfied.push(spelling);
            }
            for request in asked {
                sent += 1;
                match document.held(&request, named) {
                    Ok(operation) => {
                        if !reached.contains(&operation) {
                            reached.push(operation);
                        }
                    }
                    Err(error) => {
                        let line = format!("`marfa {name} {}`: {error}", flag.join(" "));
                        if !wrong.contains(&line) {
                            wrong.push(line);
                        }
                    }
                }
            }
        }
    }
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    // Every operation a command is named for is sent by some command, but
    // the ones whose first request is another, or that are not driven here.
    let missing: Vec<&str> = super::operations::OPERATIONS
        .iter()
        .filter(|operation| {
            !reached
                .iter()
                .any(|reached| reached.starts_with(&format!("{} (", operation.id)))
        })
        .map(|operation| operation.id)
        .collect();
    assert_eq!(
        missing,
        MISSED,
        "{sent} requests reached {} operations",
        reached.len()
    );
}
