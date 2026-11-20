//! Writes the list of icons a type's `display_hints.icon` may name from one Iconify set.
//!
//! Usage: `icon_set <package.json> <icons.json> <prefix> <package> <version> <output>`.
//! `scripts/icon-sets.sh` runs it on a tarball it has checked against its pinned hash.
//!
//! The set's icons exclude the ones it marks hidden, and its aliases keep only the names that
//! resolve, through any chain of aliases, to a listed icon.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use serde::Serialize;
use serde_json::{Map, Value};

/// Names in UTF-16 code unit order, as JavaScript sorts them.
fn sort_names(names: &mut [String]) {
    names.sort_by_key(|name| name.encode_utf16().collect::<Vec<u16>>());
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{what} is not a JSON object"))
}

fn text<'a>(value: &'a Value, key: &str, what: &str) -> Result<&'a str, String> {
    object(value, what)?
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{what} has no `{key}` that is text"))
}

/// The file's text for one set, or the reason the set is refused.
fn build(
    package_json: &str,
    icons_json: &str,
    prefix: &str,
    package: &str,
    version: &str,
) -> Result<String, String> {
    let manifest: Value =
        serde_json::from_str(package_json).map_err(|e| format!("package.json: {e}"))?;
    let (name, held) = (
        text(&manifest, "name", "package.json")?,
        text(&manifest, "version", "package.json")?,
    );
    if name != package || held != version {
        return Err(format!(
            "the tarball holds {name} {held}, not the pinned {package} {version}"
        ));
    }
    let set: Value = serde_json::from_str(icons_json).map_err(|e| format!("icons.json: {e}"))?;
    let held_prefix = text(&set, "prefix", "icons.json")?;
    if held_prefix != prefix {
        return Err(format!(
            "{package} holds the set \"{held_prefix}\", not \"{prefix}\""
        ));
    }
    let icons = object(
        set.get("icons").unwrap_or(&Value::Null),
        "icons.json `icons`",
    )?;
    let empty = Map::new();
    let aliases = match set.get("aliases") {
        None => &empty,
        Some(held) => object(held, "icons.json `aliases`")?,
    };

    let mut listed: Vec<String> = icons
        .iter()
        .filter(|(_, icon)| icon.get("hidden") != Some(&Value::Bool(true)))
        .map(|(name, _)| name.clone())
        .collect();
    sort_names(&mut listed);
    let shown: HashSet<&str> = listed.iter().map(String::as_str).collect();

    let mut names: Vec<String> = aliases.keys().cloned().collect();
    sort_names(&mut names);
    let mut resolved = Map::new();
    for alias in names {
        let mut target = alias.as_str();
        let mut seen: HashSet<&str> = HashSet::new();
        while seen.insert(target) {
            let Some(entry) = aliases.get(target) else {
                break;
            };
            target = text(entry, "parent", &format!("the alias \"{target}\""))?;
        }
        if shown.contains(target) {
            resolved.insert(alias.clone(), Value::String(target.to_string()));
        }
    }

    let mut document = Map::new();
    document.insert("prefix".into(), prefix.into());
    document.insert("package".into(), package.into());
    document.insert("version".into(), version.into());
    document.insert(
        "icons".into(),
        Value::Array(listed.into_iter().map(Value::String).collect()),
    );
    document.insert("aliases".into(), Value::Object(resolved));

    let mut bytes = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    Value::Object(document)
        .serialize(&mut serializer)
        .map_err(|e| e.to_string())?;
    let mut out = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// The file is replaced whole or not at all: it is written beside the output and renamed onto it.
fn write_whole(output: &Path, text: &str) -> Result<(), String> {
    let mut staged = output.as_os_str().to_owned();
    staged.push(".partial");
    let staged = Path::new(&staged);
    let renamed = fs::write(staged, text).and_then(|()| fs::rename(staged, output));
    renamed.map_err(|e| {
        let _ = fs::remove_file(staged);
        format!("{}: {e}", output.display())
    })
}

fn run(args: &[String]) -> Result<(), String> {
    let [package_json, icons_json, prefix, package, version, output] = args else {
        return Err(
            "usage: icon_set <package.json> <icons.json> <prefix> <package> <version> <output>"
                .into(),
        );
    };
    let read = |path: &String| fs::read_to_string(path).map_err(|e| format!("{path}: {e}"));
    let text = build(
        &read(package_json)?,
        &read(icons_json)?,
        prefix,
        package,
        version,
    )?;
    write_whole(Path::new(output), &text)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("icon_set: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const MANIFEST: &str = r#"{"name": "@iconify-json/demo", "version": "1.2.3"}"#;

    fn set(extra: Value) -> String {
        let mut document = json!({
            "prefix": "demo",
            "icons": {
                "zebra": {"body": "<path/>"},
                "apple": {"body": "<path/>"},
                "old": {"body": "<path/>", "hidden": true},
                "pear": {"body": "<path/>", "hidden": false}
            }
        });
        document
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        document.to_string()
    }

    fn built(extra: Value) -> Result<Value, String> {
        build(MANIFEST, &set(extra), "demo", "@iconify-json/demo", "1.2.3")
            .map(|text| serde_json::from_str(&text).unwrap())
    }

    #[test]
    fn hidden_icons_are_left_out_and_names_are_sorted() {
        let written = built(json!({})).unwrap();
        assert_eq!(written["icons"], json!(["apple", "pear", "zebra"]));
        assert_eq!(written["aliases"], json!({}));
        assert_eq!(written["package"], "@iconify-json/demo");
        assert_eq!(written["version"], "1.2.3");
    }

    #[test]
    fn an_alias_is_kept_when_it_resolves_to_a_listed_icon_through_any_chain() {
        let written = built(json!({"aliases": {
            "fruit": {"parent": "apple"},
            "snack": {"parent": "fruit"},
            "treat": {"parent": "snack"},
            "retired": {"parent": "old"},
            "retired-too": {"parent": "retired"},
            "missing": {"parent": "no-such-icon"}
        }}))
        .unwrap();
        assert_eq!(
            written["aliases"],
            json!({"fruit": "apple", "snack": "apple", "treat": "apple"})
        );
        let names: Vec<&String> = written["aliases"].as_object().unwrap().keys().collect();
        assert_eq!(names, ["fruit", "snack", "treat"]);
    }

    #[test]
    fn an_alias_cycle_ends_and_is_left_out() {
        let written = built(json!({"aliases": {
            "ping": {"parent": "pong"},
            "pong": {"parent": "ping"},
            "self": {"parent": "self"},
            "kept": {"parent": "apple"}
        }}))
        .unwrap();
        assert_eq!(written["aliases"], json!({"kept": "apple"}));
    }

    #[test]
    fn an_alias_without_a_parent_that_is_text_is_refused() {
        let refused = built(json!({"aliases": {"odd": {"parent": 7}}})).unwrap_err();
        assert!(refused.contains("\"odd\""), "{refused}");
    }

    #[test]
    fn the_output_is_indented_by_one_space_and_ends_in_a_newline() {
        let text = build(
            MANIFEST,
            &set(json!({})),
            "demo",
            "@iconify-json/demo",
            "1.2.3",
        )
        .unwrap();
        assert!(text.starts_with("{\n \"prefix\": \"demo\",\n"));
        assert!(text.ends_with("\n \"aliases\": {}\n}\n"));
    }

    #[test]
    fn a_set_that_is_not_the_pinned_one_is_refused() {
        let wrong = |manifest: &str, prefix: &str, version: &str| {
            build(
                manifest,
                &set(json!({})),
                prefix,
                "@iconify-json/demo",
                version,
            )
            .unwrap_err()
        };
        assert!(wrong(MANIFEST, "other", "1.2.3").contains("holds the set \"demo\""));
        assert!(wrong(MANIFEST, "demo", "9.9.9").contains("not the pinned"));
        assert!(
            wrong(
                r#"{"name": "@iconify-json/other", "version": "1.2.3"}"#,
                "demo",
                "1.2.3"
            )
            .contains("not the pinned")
        );
    }

    #[test]
    fn a_file_that_is_not_what_it_should_be_is_named() {
        let package = "@iconify-json/demo";
        let refused = |manifest: &str, icons: &str| {
            build(manifest, icons, "demo", package, "1.2.3").unwrap_err()
        };
        assert!(refused("{ nope", &set(json!({}))).starts_with("package.json"));
        assert!(refused(MANIFEST, "{ nope").starts_with("icons.json"));
        assert!(refused("[]", &set(json!({}))).contains("package.json is not a JSON object"));
        assert!(refused(MANIFEST, r#"{"prefix": "demo"}"#).contains("`icons`"));
        assert!(refused(MANIFEST, r#"{"icons": {}}"#).contains("`prefix`"));
    }

    struct Folder(std::path::PathBuf);

    impl Folder {
        fn new(name: &str) -> Folder {
            let path =
                std::env::temp_dir().join(format!("marfa-icon-set-{}-{name}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Folder(path)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_failed_run_leaves_the_output_as_it_was_and_no_partial_file() {
        let folder = Folder::new("failed");
        let output = folder.0.join("icon-set-demo.json");
        fs::write(folder.0.join("package.json"), MANIFEST).unwrap();
        fs::write(folder.0.join("icons.json"), set(json!({}))).unwrap();
        let at = |name: &str| folder.0.join(name).to_string_lossy().into_owned();
        let run_with = |prefix: &str| {
            run(&[
                at("package.json"),
                at("icons.json"),
                prefix.into(),
                "@iconify-json/demo".into(),
                "1.2.3".into(),
                output.to_string_lossy().into_owned(),
            ])
        };
        run_with("demo").unwrap();
        let first = fs::read_to_string(&output).unwrap();
        assert!(first.contains("\"apple\""));
        run_with("other").unwrap_err();
        assert_eq!(fs::read_to_string(&output).unwrap(), first);
        let mut names: Vec<String> = fs::read_dir(&folder.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["icon-set-demo.json", "icons.json", "package.json"]);
    }

    #[test]
    fn an_output_that_cannot_be_written_is_named_and_leaves_nothing() {
        let folder = Folder::new("unwritable");
        let output = folder.0.join("missing-folder").join("icon-set-demo.json");
        let refused = write_whole(&output, "text").unwrap_err();
        assert!(refused.contains("icon-set-demo.json"), "{refused}");
        assert!(!folder.0.join("missing-folder").exists());
    }

    #[test]
    fn a_missing_argument_or_input_is_refused() {
        assert!(run(&[]).unwrap_err().starts_with("usage:"));
        let args: Vec<String> = ["/no/such/package.json", "i", "p", "n", "v", "o"]
            .map(String::from)
            .to_vec();
        assert!(run(&args).unwrap_err().starts_with("/no/such/package.json"));
    }
}
