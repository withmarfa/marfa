use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Args, Subcommand};
use marfa_rules::plugin::{self, SourceFile};
use marfa_rules::schema::{Obj, Problem, shipped_registry};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Where `marfa plugins install <name>` reads the index and the bundles.
pub const DEFAULT_RELEASE: &str = "https://github.com/withmarfa/plugins/releases/latest/download";
const RELEASE_VARIABLE: &str = "MARFA_PLUGINS_URL";
const REDIRECTS: u32 = 5;
const CONNECT_BUDGET: Duration = Duration::from_secs(10);
const RESPONSE_BUDGET: Duration = Duration::from_secs(30);
const BODY_BUDGET: Duration = Duration::from_secs(60);
const BODY_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Debug, Subcommand)]
pub enum PluginsCommand {
    /// Install a plugin by name from the latest plugins release, from a bundle file, or from a source folder. Requires `schema.write` and write access to each type and each forward and reverse edge name. A bundle with a connector also requires `connectors.manage`, and `--host` assigns the connector to a connector host. A newer version may only add to its types and keeps its connector's source.
    Install(InstallArgs),
    /// Every installed plugin.
    List,
    /// One installed plugin, with the types it installed.
    Get {
        /// The plugin's name.
        name: String,
    },
    /// Remove a plugin's install record. Its types, edge types and items stay, and keep saying which plugin they came from. A connector stops: its key is revoked and its registrations go, and its source keeps its state and agreements. Needs `schema.write`, and `connectors.manage` for a plugin with a connector.
    Remove {
        /// The plugin's name.
        name: String,
    },
    /// Assign a plugin's connector to a connector host, or to none. Moving it revokes the key its former host minted for it. Requires `connectors.manage`.
    Assign(AssignArgs),
    /// A plugin connector's settings, each with its value or default, or set some with `--set`. A secret is listed as set or not, never shown, and set with `marfa plugins secret`. Requires `connectors.manage`.
    Settings(SettingsArgs),
    /// Set a secret setting of a plugin's connector from standard input, or from a prompt that does not echo at a terminal, or remove it with `--clear`. The value is never an argument and never printed. Requires `connectors.manage`.
    Secret(SecretArgs),
    /// A plugin connector's mapping: for each kind it brings, whether it comes in, the type and tier it lands as, its status words and its fields.
    Mapping {
        #[command(subcommand)]
        command: MappingCommand,
    },
    /// Start a plugin connector's sign-in to its provider and print the address to open in a browser, where the owner signs in; nothing is opened for you. With `--wait`, stay until the browser finishes this sign-in, printing a second line, or it fails, expires or a later start replaces it. Requires `connectors.manage`, and the connector's client ID and client secret set.
    #[command(name = "sign-in")]
    SignIn(SignInArgs),
    /// Judge a plugin's source folder as installing it would, with no server: `common.*` types are taken, and the roots kept for Marfa, apps and the owner are refused.
    Check {
        /// The source folder, holding `plugin.json`, `types/` and `edge-types/`.
        folder: PathBuf,
    },
    /// Build a source folder into the bundle that installs it, `<name>.plugin.json`, in the output folder.
    Bundle {
        /// The source folder.
        folder: PathBuf,
        /// The version to stamp, such as `1.4.0`.
        #[arg(long, default_value = plugin::DEVELOPMENT)]
        version: String,
        /// The folder to write the bundle in.
        #[arg(long, default_value = ".")]
        output: PathBuf,
    },
    /// Write `plugins.json`, the index a release lists, from the bundles in a folder.
    Index {
        /// The folder of `*.plugin.json` bundles; the index is written beside them.
        folder: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
pub enum MappingCommand {
    /// Show the mapping. A kind no mapping was saved for shows its default, at version 0. Works with `connectors.manage` or the connector's own key.
    Show {
        /// The plugin's name.
        name: String,
    },
    /// Replace the mapping with the `kinds` a JSON or YAML file holds, such as one `marfa plugins mapping show` printed and you edited. Sends the file's `version`, or the version read now if it names none, so a mapping saved since is refused rather than overwritten. A kind or member left out takes its default. Needs `connectors.manage`.
    Set {
        /// The plugin's name.
        name: String,
        /// The file, JSON or YAML.
        file: PathBuf,
    },
    /// Count the connector's items on each kind's target type and ask the connector to rewrite them to the mapping on its next run, as a numbered request it clears when done. Marfa changes no item itself. Needs `connectors.manage`.
    Rewrite {
        /// The plugin's name.
        name: String,
        /// Only count the items.
        #[arg(long)]
        dry_run: bool,
        /// A kind to rewrite; repeat for more. Without it, every kind that comes in.
        #[arg(long = "kind", value_name = "KIND")]
        kinds: Vec<String>,
    },
}

#[derive(Debug, Args)]
pub struct InstallArgs {
    /// A plugin's name, a `.plugin.json` bundle, or a source folder.
    #[arg(value_name = "NAME_OR_PATH")]
    pub source: String,
    /// The version a source folder is built at, such as `1.4.0`. A folder installs at `0.0.0` without it.
    #[arg(long)]
    pub version: Option<String>,
    /// The connector host, by ID or name, to assign the plugin's connector to once it is installed.
    #[arg(long)]
    pub host: Option<String>,
}

#[derive(Debug, Args)]
#[command(group = clap::ArgGroup::new("target").required(true))]
pub struct AssignArgs {
    /// The plugin's name.
    pub name: String,
    /// The connector host, by ID or name, to run the connector.
    #[arg(long, group = "target")]
    pub host: Option<String>,
    /// Assign the connector to no host.
    #[arg(long, group = "target")]
    pub none: bool,
}

#[derive(Debug, Args)]
pub struct SettingsArgs {
    /// The plugin's name.
    pub name: String,
    /// A setting to set, as `name=value`; repeat it for more. The value is sent as the setting's kind: a number, `true` or `false`, or text.
    #[arg(long = "set", value_name = "NAME=VALUE")]
    pub set: Vec<String>,
}

#[derive(Debug, Args)]
pub struct SecretArgs {
    /// The plugin's name.
    pub name: String,
    /// The secret setting's name.
    pub setting: String,
    /// Remove the value set, reading nothing.
    #[arg(long)]
    pub clear: bool,
    /// A value given here is refused: a shell history and a process list keep it.
    #[arg(hide = true)]
    pub value: Option<String>,
}

#[derive(Debug, Args)]
pub struct SignInArgs {
    /// The plugin's name.
    pub name: String,
    /// A path on the server, or an address on its sign-in address, to send the browser to once the sign-in finishes.
    #[arg(long, value_name = "PATH")]
    pub return_to: Option<String>,
    /// Stay until the browser finishes this sign-in, and exit 0 once the token is set. Exits 1 if it fails, expires or a later start replaces it.
    #[arg(long)]
    pub wait: bool,
}

pub fn list_request() -> Request {
    Request::get(&["plugins"])
}

pub fn get_request(name: &str) -> Request {
    Request::get(&["plugins", name])
}

/// The server's fingerprint is of the body's bytes, so they go as read or as built.
pub fn install_request(bundle: String) -> Request {
    Request::post(&["plugins"]).json_text(bundle)
}

pub fn remove_request(name: &str) -> Request {
    Request::delete(&["plugins", name])
}

pub fn settings_request(name: &str) -> Request {
    Request::get(&["plugins", name, "connector", "settings"])
}

pub fn update_settings_request(name: &str, body: Value) -> Request {
    Request::patch(&["plugins", name, "connector", "settings"]).json(body)
}

pub fn sign_in_request(name: &str, return_to: Option<&str>) -> Request {
    let body = match return_to {
        Some(back) => serde_json::json!({ "return_to": back }),
        None => serde_json::json!({}),
    };
    Request::post(&["plugins", name, "connector", "sign-in"]).json(body)
}

pub fn sign_in_status_request(name: &str) -> Request {
    Request::get(&["plugins", name, "connector", "sign-in"])
}

pub fn assign_request(name: &str, host: Option<&str>) -> Request {
    Request::put(&["plugins", name, "connector"]).json(serde_json::json!({ "host": host }))
}

pub fn mapping_request(name: &str) -> Request {
    Request::get(&["plugins", name, "connector", "mapping"])
}

pub fn save_mapping_request(name: &str, version: i64, kinds: Value) -> Request {
    Request::put(&["plugins", name, "connector", "mapping"])
        .json(serde_json::json!({ "version": version, "kinds": kinds }))
}

pub fn rewrite_request(name: &str, dry_run: bool, kinds: &[String]) -> Request {
    let mut body = serde_json::json!({ "dry_run": dry_run });
    if !kinds.is_empty() {
        body["kinds"] = serde_json::json!(kinds);
    }
    Request::post(&["plugins", name, "connector", "mapping", "rewrite"]).json(body)
}

impl PluginsCommand {
    /// The commands that contact no server.
    pub fn is_offline(&self) -> bool {
        matches!(
            self,
            PluginsCommand::Check { .. }
                | PluginsCommand::Bundle { .. }
                | PluginsCommand::Index { .. }
        )
    }
}

fn run_offline(command: PluginsCommand, out: &Printer) -> Result<(), CliError> {
    match command {
        PluginsCommand::Check { folder } => check(&folder, out),
        PluginsCommand::Bundle {
            folder,
            version,
            output,
        } => {
            let bundle = built(&folder, &version)?;
            let name = bundle
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let path = output.join(plugin::bundle_file_name(name));
            std::fs::write(&path, plugin::bundle_text(&bundle)).map_err(|error| {
                CliError::Invalid(format!("cannot write {}: {error}", path.display()))
            })?;
            let answer = serde_json::json!({
                "name": name,
                "version": version,
                "file": path.display().to_string(),
            });
            out.report(&answer, |_| format!("wrote {}", path.display()))
        }
        PluginsCommand::Index { folder } => {
            let index = index_of(&folder)?;
            let path = folder.join(plugin::INDEX);
            write_json(&path, &index)?;
            let count = index["plugins"].as_array().map_or(0, Vec::len);
            out.report(&index, |_| {
                format!("wrote {} listing {count}", path.display())
            })
        }
        _ => Err(CliError::Usage("this command needs a server".into())),
    }
}

pub fn run(
    command: PluginsCommand,
    remote: impl FnOnce() -> Result<Remote, CliError>,
    out: &Printer,
) -> Result<(), CliError> {
    let request = match &command {
        PluginsCommand::List => list_request(),
        PluginsCommand::Get { name } => get_request(name),
        PluginsCommand::Remove { name } => remove_request(name),
        PluginsCommand::Install(args) => install_request(bundle_for(args)?),
        PluginsCommand::Assign(args) => {
            let remote = remote()?;
            let host = match &args.host {
                Some(host) if !args.none => Some(super::hosts::resolve(&remote, host)?),
                _ => None,
            };
            let answer = remote.json(&assign_request(&args.name, host.as_deref()))?;
            return out.report(&answer, assigned_words);
        }
        PluginsCommand::Settings(args) if args.set.is_empty() => settings_request(&args.name),
        PluginsCommand::Settings(args) => {
            let remote = remote()?;
            let listing = remote.json(&settings_request(&args.name))?;
            let body = settings_body(&args.name, &args.set, &listing)?;
            let answer = remote.json(&update_settings_request(&args.name, body))?;
            let set: Vec<&str> = args
                .set
                .iter()
                .filter_map(|pair| pair.split_once('=').map(|(name, _)| name))
                .collect();
            return out.report(&answer, |_| {
                format!("set {} for {}", set.join(", "), args.name)
            });
        }
        PluginsCommand::Secret(args) => {
            if args.value.is_some() {
                return Err(CliError::Usage(format!(
                    "{} takes no value as an argument, which a process list and a shell history keep; \
                     send it on standard input or run the command with no value to be asked",
                    args.setting
                )));
            }
            let value = if args.clear {
                Value::Null
            } else {
                Value::String(super::config::secret_value(&args.setting)?)
            };
            let body = Value::Object(serde_json::Map::from_iter([(args.setting.clone(), value)]));
            let answer = remote()?.json(&update_settings_request(&args.name, body))?;
            let done = if args.clear { "removed" } else { "set" };
            return out.report(&answer, |_| {
                format!("{done} {} for {}", args.setting, args.name)
            });
        }
        PluginsCommand::Mapping { command } => return mapping(command, remote, out),
        PluginsCommand::SignIn(args) => return sign_in(&remote()?, args, out),
        _ => return run_offline(command, out),
    };
    let remote = remote()?;
    let answer = remote.json(&request)?;
    match &command {
        PluginsCommand::Install(args) => installed(&remote, args, answer, out),
        PluginsCommand::Remove { .. } => out.report(&answer, removed_words),
        PluginsCommand::Settings(_) => out.report(&answer, settings_words),
        _ => out.value(&answer),
    }
}

/// How often `--wait` reads whether the sign-in finished.
const SIGN_IN_STEP: Duration = Duration::from_secs(2);

fn sign_in(remote: &Remote, args: &SignInArgs, out: &Printer) -> Result<(), CliError> {
    let started = remote.json(&sign_in_request(&args.name, args.return_to.as_deref()))?;
    out.record(&started, |shown| {
        format!(
            "Open this address in a browser to sign in:\n{}",
            shown["url"].as_str().unwrap_or_default()
        )
    })?;
    if !args.wait {
        return Ok(());
    }
    let Some(own) = started["id"].as_str() else {
        return Err(CliError::Invalid(
            "the server answered a sign-in's start with no id".into(),
        ));
    };
    loop {
        std::thread::sleep(SIGN_IN_STEP);
        let status = remote.json(&sign_in_status_request(&args.name))?;
        if status["id"].as_str() != Some(own) {
            return Err(CliError::SignInEnded {
                plugin: args.name.clone(),
                status: "replaced".into(),
            });
        }
        match status["status"].as_str() {
            Some("pending") => {}
            Some("signed_in") => {
                return out.record(&status, |_| format!("signed in {}", args.name));
            }
            Some(ended) => {
                return Err(CliError::SignInEnded {
                    plugin: args.name.clone(),
                    status: ended.to_string(),
                });
            }
            None => {
                return Err(CliError::Invalid(
                    "the server answered a sign-in with no status".into(),
                ));
            }
        }
    }
}

/// After a plugin with a connector installs, `--host` assigns it; with no flag and one host
/// on the instance, the CLI names that host and assigns nothing.
fn installed(
    remote: &Remote,
    args: &InstallArgs,
    mut answer: Value,
    out: &Printer,
) -> Result<(), CliError> {
    let name = answer["name"].as_str().unwrap_or_default().to_string();
    let has_connector = answer["connector"].is_object();
    let mut also = None;
    if let Some(host) = &args.host {
        if !has_connector {
            return Err(CliError::Invalid(format!(
                "installed {name}, which has no connector to assign to a host"
            )));
        }
        let id = super::hosts::resolve(remote, host)?;
        let assigned = remote.json(&assign_request(&name, Some(&id)))?;
        answer["connector_host"] = assigned["host"].clone();
        also = Some(format!("its connector runs on host {host}"));
    } else if has_connector && answer["connector_host"].is_null() {
        let hosts = remote.json(&super::hosts::list_request())?;
        if let [only] = hosts["data"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let host = only["name"].as_str().unwrap_or_default();
            also = Some(format!(
                "its connector runs on no host yet; host {host} could run it: marfa plugins assign {name} --host {host:?}"
            ));
        } else {
            also = Some(format!(
                "its connector runs on no host yet: marfa plugins assign {name} --host `host`"
            ));
        }
    }
    out.report(&answer, |answer| match &also {
        Some(also) => format!("{}; {also}", installed_words(answer)),
        None => installed_words(answer),
    })
}

/// Each `name=value` as the kind the listing gives its setting. A secret named here is refused
/// before anything is sent, and its value is never repeated.
fn settings_body(plugin: &str, pairs: &[String], listing: &Value) -> Result<Value, CliError> {
    let mut body = serde_json::Map::new();
    for pair in pairs {
        let Some((name, text)) = pair.split_once('=') else {
            return Err(CliError::Usage(format!(
                "--set takes `name=value`, and {pair:?} has no `=`"
            )));
        };
        let setting = listing["settings"]
            .as_array()
            .and_then(|settings| settings.iter().find(|setting| setting["name"] == name))
            .ok_or_else(|| {
                CliError::Usage(format!(
                    "{plugin}'s connector has no setting {name}; `marfa plugins settings {plugin}` lists them"
                ))
            })?;
        if setting["secret"].as_bool() == Some(true) {
            return Err(CliError::Usage(format!(
                "{name} is a secret, so --set does not take it: a process list and a shell history keep \
                 an argument. Use `marfa plugins secret {plugin} {name}`"
            )));
        }
        let wrong = |wanted: &str| {
            CliError::Usage(format!("{name} takes {wanted}, and {text:?} is not that"))
        };
        let value = match setting["kind"].as_str() {
            Some("number") => serde_json::from_str::<Value>(text)
                .ok()
                .filter(Value::is_number)
                .ok_or_else(|| wrong("a number"))?,
            Some("boolean") => match text {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => return Err(wrong("`true` or `false`")),
            },
            _ => Value::String(text.to_string()),
        };
        body.insert(name.to_string(), value);
    }
    Ok(Value::Object(body))
}

fn settings_words(answer: &Value) -> String {
    let mut lines = Vec::new();
    for setting in answer["settings"].as_array().into_iter().flatten() {
        let name = setting["name"].as_str().unwrap_or_default();
        let required = if setting["required"].as_bool() == Some(true) {
            ", required"
        } else {
            ""
        };
        let said = if setting["secret"].as_bool() == Some(true) {
            match (setting["set"].as_bool(), setting["unreadable"].as_bool()) {
                (_, Some(true)) => "secret, unreadable here: set it again".to_string(),
                (Some(true), _) => "secret, set".to_string(),
                _ => "secret, not set".to_string(),
            }
        } else if setting["set"].as_bool() == Some(true) {
            setting["value"].to_string()
        } else if setting["value"].is_null() {
            "not set".to_string()
        } else {
            format!("{} (default)", setting["value"])
        };
        lines.push(format!("{name}: {said}{required}"));
    }
    if let Some(missing) = answer["missing"]
        .as_array()
        .filter(|missing| !missing.is_empty())
    {
        let names: Vec<&str> = missing.iter().filter_map(Value::as_str).collect();
        lines.push(format!("missing: {}", names.join(", ")));
    }
    lines.join("\n")
}

fn assigned_words(answer: &Value) -> String {
    let name = answer["plugin"].as_str().unwrap_or_default();
    match answer["host"].as_str() {
        Some(host) => format!("{name}'s connector runs on host {host}"),
        None => format!("{name}'s connector runs on no host"),
    }
}

fn mapping(
    command: &MappingCommand,
    remote: impl FnOnce() -> Result<Remote, CliError>,
    out: &Printer,
) -> Result<(), CliError> {
    match command {
        MappingCommand::Show { name } => out.value(&remote()?.json(&mapping_request(name))?),
        MappingCommand::Set { name, file } => {
            let (version, kinds) = mapping_file(file)?;
            let remote = remote()?;
            let version = match version {
                Some(version) => version,
                None => remote.json(&mapping_request(name))?["version"]
                    .as_i64()
                    .ok_or_else(|| CliError::Invalid("the mapping read names no version".into()))?,
            };
            let answer = remote.json(&save_mapping_request(name, version, kinds))?;
            out.report(&answer, |answer| {
                format!(
                    "saved the mapping of {name} at version {}",
                    answer["version"].as_i64().unwrap_or_default()
                )
            })
        }
        MappingCommand::Rewrite {
            name,
            dry_run,
            kinds,
        } => {
            let answer = remote()?.json(&rewrite_request(name, *dry_run, kinds))?;
            out.report(&answer, |answer| rewrite_words(name, answer))
        }
    }
}

fn rewrite_words(name: &str, answer: &Value) -> String {
    let counted: Vec<String> = answer["kinds"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(kind, held)| {
            format!(
                "{kind}: {} on {}",
                held["count"].as_i64().unwrap_or_default(),
                held["target_type"].as_str().unwrap_or_default()
            )
        })
        .collect();
    let counted = if counted.is_empty() {
        "no kind".to_string()
    } else {
        counted.join(", ")
    };
    if answer["dry_run"].as_bool() == Some(true) {
        format!("a rewrite of {name} would touch {counted}")
    } else {
        format!(
            "asked {name}'s connector to rewrite {counted}, as request {}",
            answer["number"].as_i64().unwrap_or_default()
        )
    }
}

/// The `kinds` of a mapping file, and its `version` where it names one.
fn mapping_file(path: &Path) -> Result<(Option<i64>, Value), CliError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| CliError::Invalid(format!("cannot read {}: {error}", path.display())))?;
    let held = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(_) => yaml_value(&text).map_err(|error| {
            CliError::Invalid(format!(
                "{} is neither JSON nor YAML: {error}",
                path.display()
            ))
        })?,
    };
    let Value::Object(held) = held else {
        return Err(CliError::Invalid(format!(
            "{} does not hold an object with kinds",
            path.display()
        )));
    };
    let kinds = held
        .get("kinds")
        .cloned()
        .ok_or_else(|| CliError::Invalid(format!("{} holds no kinds", path.display())))?;
    let version = match held.get("version") {
        None | Some(Value::Null) => None,
        Some(version) => Some(version.as_i64().ok_or_else(|| {
            CliError::Invalid(format!(
                "{} names a version that is not a whole number",
                path.display()
            ))
        })?),
    };
    Ok((version, kinds))
}

fn yaml_value(text: &str) -> Result<Value, String> {
    let mut documents =
        yaml_rust2::YamlLoader::load_from_str(text).map_err(|error| error.to_string())?;
    if documents.len() != 1 {
        return Err("it must hold one document".into());
    }
    json_of(documents.remove(0))
}

fn json_of(yaml: yaml_rust2::Yaml) -> Result<Value, String> {
    use yaml_rust2::Yaml;
    Ok(match yaml {
        Yaml::Null => Value::Null,
        Yaml::Boolean(held) => Value::Bool(held),
        Yaml::Integer(held) => Value::from(held),
        Yaml::Real(text) => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .ok_or_else(|| format!("{text} is not a number JSON holds"))?,
        Yaml::String(text) => Value::String(text),
        Yaml::Array(items) => {
            Value::Array(items.into_iter().map(json_of).collect::<Result<_, _>>()?)
        }
        Yaml::Hash(entries) => {
            let mut object = serde_json::Map::new();
            for (key, value) in entries {
                let Yaml::String(key) = key else {
                    return Err("every key must be text".into());
                };
                object.insert(key, json_of(value)?);
            }
            Value::Object(object)
        }
        Yaml::Alias(_) | Yaml::BadValue => return Err("it holds a value JSON cannot".into()),
    })
}

fn installed_words(answer: &Value) -> String {
    let field = |key: &str| answer.get(key).and_then(Value::as_str).unwrap_or_default();
    let types = answer["types"].as_array().map_or(0, Vec::len);
    let types = &format!("{} {}", types, if types == 1 { "type" } else { "types" });
    match field("outcome") {
        "unchanged" => format!(
            "{} {} is already installed",
            field("name"),
            field("version")
        ),
        outcome => format!(
            "{outcome} {} {} with {types}",
            field("name"),
            field("version")
        ),
    }
}

fn removed_words(answer: &Value) -> String {
    let name = answer["removed"]["name"].as_str().unwrap_or_default();
    let kept = answer["kept"]["types"].as_array().map_or(0, Vec::len);
    let mut said = format!(
        "removed {}; its {kept} {} and their items stay",
        name,
        if kept == 1 { "type" } else { "types" }
    );
    let removed = &answer["removed"]["connector"];
    if removed.is_object() {
        let registrations = removed["registrations"].as_array().map_or(0, Vec::len);
        let kept = &answer["kept"]["connector"];
        let agreements = kept["agreements"].as_u64().unwrap_or_default();
        said.push_str(&format!(
            "; its connector stopped: {}, {registrations} {} removed; source {} keeps {} and {agreements} {}",
            if removed["key_id"].is_string() {
                "its key revoked"
            } else {
                "no key to revoke"
            },
            if registrations == 1 {
                "registration"
            } else {
                "registrations"
            },
            removed["source"].as_str().unwrap_or_default(),
            if kept["state"].as_bool() == Some(true) {
                "its state"
            } else {
                "no state"
            },
            if agreements == 1 {
                "agreement"
            } else {
                "agreements"
            },
        ));
    }
    said
}

fn write_json(path: &Path, value: &Value) -> Result<(), CliError> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    std::fs::write(path, text)
        .map_err(|error| CliError::Invalid(format!("cannot write {}: {error}", path.display())))
}

/// The bytes to install: a source folder built, a bundle file read, or a name fetched.
fn bundle_for(args: &InstallArgs) -> Result<String, CliError> {
    let path = Path::new(&args.source);
    match std::fs::metadata(path) {
        Ok(held) if held.is_dir() => {
            let version = args.version.as_deref().unwrap_or(plugin::DEVELOPMENT);
            let text = plugin::bundle_text(&built(path, version)?);
            crate::errln!(
                "built {} at {version}, SHA-256 {}",
                path.display(),
                hex::encode(Sha256::digest(text.as_bytes()))
            );
            Ok(text)
        }
        Ok(_) if args.version.is_some() => Err(CliError::Usage(
            "--version builds a source folder, and a bundle carries its own version".into(),
        )),
        Ok(_) => read_bundle(path),
        Err(_) if plugin::is_name(&args.source) => {
            if args.version.is_some() {
                return Err(CliError::Usage(
                    "--version builds a source folder, and a release's bundle carries its own version".into(),
                ));
            }
            Release::from_environment()?.fetch(&args.source)
        }
        Err(error) => Err(CliError::Usage(format!(
            "{} is neither a plugin's name nor a file or folder this command can read: {error}",
            args.source
        ))),
    }
}

fn object(bytes: &[u8], said: &str) -> Result<Obj, CliError> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(CliError::Invalid(format!("{said} is not a JSON object"))),
        Err(error) => Err(CliError::Invalid(format!(
            "{said} is not valid JSON: {error}"
        ))),
    }
}

/// The bytes as text, once they read as one JSON object.
fn object_text(bytes: Vec<u8>, said: &str) -> Result<(Obj, String), CliError> {
    let bundle = object(&bytes, said)?;
    let text =
        String::from_utf8(bytes).map_err(|_| CliError::Invalid(format!("{said} is not UTF-8")))?;
    Ok((bundle, text))
}

fn read_bundle(path: &Path) -> Result<String, CliError> {
    let bytes = std::fs::read(path)
        .map_err(|error| CliError::Invalid(format!("cannot read {}: {error}", path.display())))?;
    Ok(object_text(bytes, &path.display().to_string())?.1)
}

/// The files of a source folder that a bundle is built from.
fn source_files(folder: &Path) -> Result<Vec<SourceFile>, CliError> {
    match std::fs::metadata(folder) {
        Ok(held) if held.is_dir() => {}
        Ok(_) => {
            return Err(CliError::Usage(format!(
                "{} is not a folder: name a plugin's source folder",
                folder.display()
            )));
        }
        Err(error) => {
            return Err(CliError::Usage(format!(
                "cannot read {}: {error}",
                folder.display()
            )));
        }
    }
    let mut files = Vec::new();
    for (below, path) in [
        (None, folder.to_path_buf()),
        (Some(plugin::TYPES), folder.join(plugin::TYPES)),
        (Some(plugin::EDGE_TYPES), folder.join(plugin::EDGE_TYPES)),
    ] {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if below.is_some() && error.kind() == std::io::ErrorKind::NotFound => {
                continue;
            }
            Err(error) => {
                return Err(CliError::Invalid(format!(
                    "cannot read the folder {}: {error}",
                    path.display()
                )));
            }
        };
        for entry in entries {
            let entry = entry.map_err(|error| {
                CliError::Invalid(format!(
                    "cannot read the folder {}: {error}",
                    path.display()
                ))
            })?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = match below {
                Some(folder) => format!("{folder}/{name}"),
                None => name,
            };
            if !SourceFile::wanted(&relative) {
                continue;
            }
            let content = match std::fs::metadata(entry.path()) {
                Ok(held) if held.is_file() => {
                    std::fs::read(entry.path()).map_err(|error| error.to_string())
                }
                Ok(_) => Err("it is not a regular file".to_string()),
                Err(error) => Err(error.to_string()),
            };
            files.push(SourceFile {
                path: relative,
                content,
            });
        }
    }
    Ok(files)
}

fn problems_said(problems: &[Problem]) -> String {
    problems
        .iter()
        .map(|problem| match problem.path.as_str() {
            "" => problem.message.clone(),
            path => format!("{path}: {}", problem.message),
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn built(folder: &Path, version: &str) -> Result<Obj, CliError> {
    let files = source_files(folder)?;
    plugin::build_bundle(&files, version).map_err(|problems| {
        let said = format!(
            "{} does not build into a bundle: {}",
            folder.display(),
            problems_said(&problems)
        );
        if problems
            .iter()
            .any(|problem| problem.code == "file_name_mismatch")
        {
            CliError::FileNameMismatch(said)
        } else {
            CliError::Invalid(said)
        }
    })
}

fn problem_json(problem: &Problem) -> Value {
    serde_json::json!({ "path": problem.path, "code": problem.code, "message": problem.message })
}

fn check(folder: &Path, out: &Printer) -> Result<(), CliError> {
    let files = source_files(folder)?;
    let registry = shipped_registry().map_err(marfa_core::CoreError::from)?;
    let verdict = plugin::check_source(&files, &registry).map_err(marfa_core::CoreError::from)?;
    let types: Vec<Value> = verdict
        .types
        .files
        .iter()
        .map(|file| {
            serde_json::json!({
                "file": format!("{}/{}", plugin::TYPES, file.file),
                "id": file.id,
                "ok": file.problems.is_empty(),
                "problems": file.problems.iter().map(problem_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    let count = verdict.problem_count();
    let answer = serde_json::json!({
        "ok": count == 0,
        "problems": verdict.problems.iter().map(problem_json).collect::<Vec<_>>(),
        "types": types,
    });
    out.report(&answer, |answer| {
        let mut lines = Vec::new();
        for problem in answer["problems"].as_array().into_iter().flatten() {
            lines.push(format!(
                "{}: {} ({})",
                problem["path"].as_str().unwrap_or_default(),
                problem["message"].as_str().unwrap_or_default(),
                problem["code"].as_str().unwrap_or_default()
            ));
        }
        for file in answer["types"].as_array().into_iter().flatten() {
            let name = file["file"].as_str().unwrap_or_default();
            if file["ok"] == Value::Bool(true) {
                lines.push(format!("{name}: ok"));
                continue;
            }
            lines.push(format!("{name}: refused"));
            for problem in file["problems"].as_array().into_iter().flatten() {
                lines.push(format!(
                    "  {}: {} ({})",
                    problem["path"].as_str().unwrap_or_default(),
                    problem["message"].as_str().unwrap_or_default(),
                    problem["code"].as_str().unwrap_or_default()
                ));
            }
        }
        lines.push(if count == 0 {
            "the plugin passes".to_string()
        } else {
            format!(
                "{count} {}",
                if count == 1 { "problem" } else { "problems" }
            )
        });
        lines.join("\n")
    })?;
    match count {
        0 => Ok(()),
        count => Err(CliError::Invalid(format!(
            "the plugin has {count} {}",
            if count == 1 { "problem" } else { "problems" }
        ))),
    }
}

fn index_of(folder: &Path) -> Result<Value, CliError> {
    let entries = std::fs::read_dir(folder).map_err(|error| {
        CliError::Usage(format!(
            "cannot read the folder {}: {error}",
            folder.display()
        ))
    })?;
    let mut listed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            CliError::Invalid(format!(
                "cannot read the folder {}: {error}",
                folder.display()
            ))
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(plugin::BUNDLE_SUFFIX) {
            continue;
        }
        let bytes = std::fs::read(entry.path())
            .map_err(|error| CliError::Invalid(format!("cannot read {name}: {error}")))?;
        let bundle = object(&bytes, &name)?;
        let faults = plugin::bundle_faults(&bundle);
        if !faults.is_empty() {
            return Err(CliError::Invalid(format!(
                "{name} is not a bundle a server installs: {}",
                problems_said(&faults)
            )));
        }
        let named = bundle
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if name != plugin::bundle_file_name(named) {
            return Err(CliError::Invalid(format!(
                "{name} holds the plugin {named}, so name it {}",
                plugin::bundle_file_name(named)
            )));
        }
        listed.push(plugin::index_entry(
            &bundle,
            &hex::encode(Sha256::digest(&bytes)),
        ));
    }
    Ok(plugin::index(listed))
}

/// The release a plugin is fetched from, with a client that sends no credential.
struct Release {
    base: String,
    agents: marfa_core::http::Agents,
}

impl Release {
    /// `MARFA_PLUGINS_URL` where it is set and not empty, else the plugins repository's latest release.
    fn from_environment() -> Result<Release, CliError> {
        match std::env::var(RELEASE_VARIABLE) {
            Ok(address) => Release::at(Some(address)),
            Err(std::env::VarError::NotPresent) => Release::at(None),
            Err(std::env::VarError::NotUnicode(_)) => Err(CliError::Invalid(format!(
                "{RELEASE_VARIABLE} is not text this command can read: set it to the release address alone"
            ))),
        }
    }

    fn at(address: Option<String>) -> Result<Release, CliError> {
        let address = match address {
            Some(address) if !address.trim().is_empty() => address,
            _ => DEFAULT_RELEASE.to_string(),
        };
        let base = address.trim().trim_end_matches('/').to_string();
        let parsed = Url::parse(&base).ok();
        if parsed
            .as_ref()
            .is_some_and(|url| !url.username().is_empty() || url.password().is_some())
        {
            return Err(CliError::Invalid(format!(
                "{RELEASE_VARIABLE} carries a user name or password, which this command never sends: set it to the release address alone"
            )));
        }
        let usable = parsed.is_some_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.query().is_none()
                && url.fragment().is_none()
        });
        if !usable {
            // An address that does not parse may still carry a password, so it is never printed.
            return Err(CliError::Invalid(format!(
                "{RELEASE_VARIABLE} is not an http or https address with a host and no query or fragment"
            )));
        }
        let tls = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let agents = marfa_core::http::Agents::new(|| {
            ureq::Agent::config_builder()
                .tls_config(tls.clone())
                .http_status_as_error(false)
                .timeout_connect(Some(CONNECT_BUDGET))
                .timeout_recv_response(Some(RESPONSE_BUDGET))
                .timeout_recv_body(Some(BODY_BUDGET))
                .user_agent(concat!("marfa/", env!("CARGO_PKG_VERSION")))
        });
        Ok(Release { base, agents })
    }

    fn unreachable(&self, reason: impl Into<String>) -> CliError {
        CliError::PluginsUnreachable {
            address: self.base.clone(),
            reason: reason.into(),
        }
    }

    fn get(&self, file: &str) -> Result<Vec<u8>, CliError> {
        let url = format!("{}/{file}", self.base);
        let mut response = self
            .agents
            .get(&url, &[], REDIRECTS)
            .map_err(|error| self.unreachable(error.to_string()))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(self.unreachable(format!("answered {status} for {file}")));
        }
        response
            .body_mut()
            .with_config()
            .limit(BODY_LIMIT)
            .read_to_vec()
            .map_err(|error| self.unreachable(format!("{file}: {error}")))
    }

    fn fetch(&self, name: &str) -> Result<String, CliError> {
        crate::errln!("reading {}/{}", self.base, plugin::INDEX);
        let listed = self.get(plugin::INDEX)?;
        let index: Value = serde_json::from_slice(&listed)
            .map_err(|error| self.unreachable(format!("{} is not JSON: {error}", plugin::INDEX)))?;
        let (file, digest) =
            plugin::index_lookup(&index, name).map_err(|why| self.unreachable(why))?;
        crate::errln!("reading {}/{file}", self.base);
        let bytes = self.get(file)?;
        let found = hex::encode(Sha256::digest(&bytes));
        if !found.eq_ignore_ascii_case(digest) {
            return Err(self.unreachable(format!(
                "{file} has the SHA-256 {found}, and {} lists {digest}",
                plugin::INDEX
            )));
        }
        let (bundle, text) = object_text(bytes, file)?;
        if bundle.get("name").and_then(Value::as_str) != Some(name) {
            return Err(self.unreachable(format!("{file} holds another plugin than {name}")));
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_that_does_not_parse_is_refused_without_printing_it() {
        for address in [
            "http://reader:hunter2@[not-a-host",
            "reader:hunter2@example.com",
            "http://reader:hunter2@example.com:99999",
        ] {
            let Err(refused) = Release::at(Some(address.into())) else {
                panic!("{address} was taken");
            };
            let said = refused.to_string();
            assert!(said.contains(RELEASE_VARIABLE), "{said}");
            assert!(!said.contains("hunter2"), "{said}");
        }
        assert!(Release::at(Some("https://example.com/download".into())).is_ok());
    }
}
