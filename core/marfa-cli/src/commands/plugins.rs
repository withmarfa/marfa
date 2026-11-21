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
    /// Install a plugin: by name from the latest release of the plugins repository, or from a bundle file or a source folder on this machine. Needs `schema.write` and write on each of its types and edge types. A newer version of an installed plugin may only add to its types.
    Install(InstallArgs),
    /// Every installed plugin.
    List,
    /// One installed plugin, with the types it installed.
    Get {
        /// The plugin's name.
        name: String,
    },
    /// Remove a plugin's install record. Its types, edge types and items stay, and keep saying which plugin they came from. Needs `schema.write`.
    Remove {
        /// The plugin's name.
        name: String,
    },
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

#[derive(Debug, Args)]
pub struct InstallArgs {
    /// A plugin's name, a `.plugin.json` bundle, or a source folder.
    #[arg(value_name = "NAME_OR_PATH")]
    pub source: String,
    /// The version a source folder is built at, such as `1.4.0`. A folder installs at `0.0.0` without it.
    #[arg(long)]
    pub version: Option<String>,
}

pub fn list_request() -> Request {
    Request::get(&["plugins"])
}

pub fn get_request(name: &str) -> Request {
    Request::get(&["plugins", name])
}

pub fn install_request(bundle: Obj) -> Request {
    Request::post(&["plugins"]).json(Value::Object(bundle))
}

pub fn remove_request(name: &str) -> Request {
    Request::delete(&["plugins", name])
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
            write_json(&path, &Value::Object(bundle.clone()))?;
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
        _ => return run_offline(command, out),
    };
    let answer = remote()?.json(&request)?;
    match &command {
        PluginsCommand::Install(_) => out.report(&answer, installed_words),
        PluginsCommand::Remove { .. } => out.report(&answer, removed_words),
        _ => out.value(&answer),
    }
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
    format!(
        "removed {}; its {kept} {} and their items stay",
        name,
        if kept == 1 { "type" } else { "types" }
    )
}

fn write_json(path: &Path, value: &Value) -> Result<(), CliError> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    std::fs::write(path, text)
        .map_err(|error| CliError::Invalid(format!("cannot write {}: {error}", path.display())))
}

/// The bundle to install: a source folder built, a bundle file read, or a name fetched.
fn bundle_for(args: &InstallArgs) -> Result<Obj, CliError> {
    let path = Path::new(&args.source);
    match std::fs::metadata(path) {
        Ok(held) if held.is_dir() => {
            built(path, args.version.as_deref().unwrap_or(plugin::DEVELOPMENT))
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

fn read_bundle(path: &Path) -> Result<Obj, CliError> {
    let bytes = std::fs::read(path)
        .map_err(|error| CliError::Invalid(format!("cannot read {}: {error}", path.display())))?;
    object(&bytes, &path.display().to_string())
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
        CliError::Invalid(format!(
            "{} does not build into a bundle: {}",
            folder.display(),
            problems_said(&problems)
        ))
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
        let address = match std::env::var(RELEASE_VARIABLE) {
            Ok(address) if !address.trim().is_empty() => address,
            _ => DEFAULT_RELEASE.to_string(),
        };
        let base = address.trim().trim_end_matches('/').to_string();
        let parsed = Url::parse(&base).ok().filter(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.query().is_none()
                && url.fragment().is_none()
        });
        if parsed.is_none() {
            return Err(CliError::Invalid(format!(
                "{RELEASE_VARIABLE} is {address:?}, which is not an http or https address with a host and no query or fragment"
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

    fn fetch(&self, name: &str) -> Result<Obj, CliError> {
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
        let bundle = object(&bytes, file)?;
        if bundle.get("name").and_then(Value::as_str) != Some(name) {
            return Err(self.unreachable(format!("{file} holds another plugin than {name}")));
        }
        Ok(bundle)
    }
}
