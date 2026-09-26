use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Map, Value, json};

use super::{insert_opt, object, pairs};
use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::request::Request;
use crate::remote::{Remote, Transport};
use crate::values::Tier;

#[derive(Debug, Subcommand)]
pub enum KeysCommand {
    /// Mint a fresh instance's operator key with the one-time secret it
    /// printed to its log. The operator key is not a working key: the next
    /// call is `keys create` with it.
    Bootstrap {
        /// The bootstrap secret from the server's log.
        #[arg(long, value_name = "SECRET")]
        secret: String,
    },
    /// Mint a key. Needs `keys.mint`, or the operator key.
    Create(KeyCreateArgs),
    /// Every key, without plaintext. Needs `keys.mint`, or the operator key.
    List,
    /// Change a key's label, tier or permission maps. Needs `keys.mint`.
    Update(KeyUpdateArgs),
    /// Revoke a key; the next request bearing it is refused. Needs
    /// `keys.mint`, or the operator key.
    Revoke {
        /// The key id.
        id: String,
    },
    /// Keep a key for this server in the operating system's keychain, and
    /// make this server the one a bare command talks to. The key is read
    /// from `--key`, from MARFA_API_KEY, or from stdin; never from a file.
    Keep,
    /// Forget the key kept for this server.
    Forget,
}

/// The seven permissions, named by what they permit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Permission {
    #[value(name = "schema.write")]
    SchemaWrite,
    #[value(name = "keys.mint")]
    KeysMint,
    #[value(name = "items.purge")]
    ItemsPurge,
    #[value(name = "webhooks.manage")]
    WebhooksManage,
    #[value(name = "config.manage")]
    ConfigManage,
    #[value(name = "audit.read")]
    AuditRead,
    #[value(name = "grants.manage")]
    GrantsManage,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::SchemaWrite => "schema.write",
            Permission::KeysMint => "keys.mint",
            Permission::ItemsPurge => "items.purge",
            Permission::WebhooksManage => "webhooks.manage",
            Permission::ConfigManage => "config.manage",
            Permission::AuditRead => "audit.read",
            Permission::GrantsManage => "grants.manage",
        }
    }
}

/// The maps a key's reach is made of, and its permissions. Naming a map is
/// naming exactly what the key holds, its permissions included; naming
/// only permissions narrows those and takes the creator's maps; naming
/// nothing takes the creator's whole set.
#[derive(Debug, Default, Args)]
pub struct PermissionMapArgs {
    /// A permission, repeatable.
    #[arg(long = "permission", value_name = "PERMISSION")]
    pub permissions: Vec<Permission>,
    /// A type pattern and its level, `core.note=write`, repeatable.
    #[arg(long = "type-permission", value_name = "PATTERN=LEVEL")]
    pub type_permissions: Vec<String>,
    /// An extension namespace and its level, `app.cursor=write`, repeatable.
    #[arg(long = "extension-permission", value_name = "NAMESPACE=LEVEL")]
    pub extension_permissions: Vec<String>,
    /// An edge type and its level, `references=write`, repeatable.
    #[arg(long = "edge-permission", value_name = "TYPE=LEVEL")]
    pub edge_permissions: Vec<String>,
    /// A metadata subresource and its level, `tags=write`, repeatable.
    #[arg(long = "metadata-permission", value_name = "NAME=LEVEL")]
    pub metadata_permissions: Vec<String>,
    /// A profile field and its level, `email=read`, repeatable.
    #[arg(long = "profile-permission", value_name = "FIELD=LEVEL")]
    pub profile_permissions: Vec<String>,
    /// The enforcement override, as the JSON object the door takes.
    #[arg(long, value_name = "JSON")]
    pub enforcement_override: Option<String>,
}

impl PermissionMapArgs {
    fn apply(&self, body: &mut Map<String, Value>) -> Result<(), CliError> {
        if !self.permissions.is_empty() {
            body.insert(
                "permissions".into(),
                json!(
                    self.permissions
                        .iter()
                        .map(|p| p.as_str())
                        .collect::<Vec<_>>()
                ),
            );
        }
        for (key, values, flag) in [
            (
                "type_permissions",
                &self.type_permissions,
                "--type-permission",
            ),
            (
                "extension_permissions",
                &self.extension_permissions,
                "--extension-permission",
            ),
            (
                "edge_permissions",
                &self.edge_permissions,
                "--edge-permission",
            ),
            (
                "metadata_permissions",
                &self.metadata_permissions,
                "--metadata-permission",
            ),
            (
                "profile_permissions",
                &self.profile_permissions,
                "--profile-permission",
            ),
        ] {
            if !values.is_empty() {
                body.insert(key.into(), Value::Object(pairs(values, flag)?));
            }
        }
        if let Some(text) = &self.enforcement_override {
            body.insert(
                "enforcement_override".into(),
                Value::Object(object(text, "--enforcement-override")?),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Default, Args)]
pub struct KeyCreateArgs {
    /// What the key is for.
    #[arg(long)]
    pub label: String,
    /// The key's own source, which a row written under the key is keyed by
    /// and stamped with unless the write names one the key claims.
    #[arg(long)]
    pub source: String,
    #[command(flatten)]
    pub maps: PermissionMapArgs,
    #[command(flatten)]
    pub claims: ClaimArgs,
    /// The tier a write under the key lands at when it names none.
    #[arg(long)]
    pub default_tier: Option<Tier>,
    /// Mint a second operator key, which holds nothing. Operator only.
    #[arg(long)]
    pub operator: bool,
    /// A key that holds nothing at all, asked for out loud.
    #[arg(long, conflicts_with_all = ["permissions", "type_permissions", "extension_permissions", "edge_permissions", "metadata_permissions", "profile_permissions"])]
    pub no_permissions: bool,
}

#[derive(Debug, Default, Args)]
pub struct KeyUpdateArgs {
    /// The key id.
    pub id: String,
    /// What the key is for.
    #[arg(long)]
    pub label: Option<String>,
    #[command(flatten)]
    pub maps: PermissionMapArgs,
    #[command(flatten)]
    pub claims: ClaimArgs,
    /// The tier a write under the key lands at when it names none.
    #[arg(long)]
    pub default_tier: Option<Tier>,
}

/// The sources a key may name on a write besides its own. Named, they are
/// all it claims; left unnamed on a mint that names no map either, the key
/// takes the caller's claims, as it takes the caller's maps.
#[derive(Debug, Default, Args)]
pub struct ClaimArgs {
    /// A source a write under the key may name, so its rows are keyed by it.
    /// Repeatable.
    #[arg(long = "claim", value_name = "SOURCE")]
    pub claims: Vec<String>,
    /// Claim no source besides the key's own, asked for out loud. On a mint
    /// naming no map, naming the claims is naming what the key holds: it
    /// holds no map and no permission either.
    #[arg(long, conflicts_with = "claims")]
    pub no_claims: bool,
}

impl ClaimArgs {
    fn apply(&self, body: &mut Map<String, Value>) {
        if self.no_claims {
            body.insert("sources".into(), json!([]));
        } else if !self.claims.is_empty() {
            body.insert("sources".into(), json!(self.claims));
        }
    }
}

pub fn bootstrap_request() -> Request {
    // The operator key's label and source are the door's convention; the
    // secret rides as the bearer, which `run` below sets on the transport.
    Request::post(&["keys"])
        .json(json!({ "label": "operator", "source": "operator" }))
        .minting()
}

pub fn create_request(args: &KeyCreateArgs) -> Result<Request, CliError> {
    let mut body = Map::new();
    body.insert("label".into(), Value::String(args.label.clone()));
    body.insert("source".into(), Value::String(args.source.clone()));
    args.maps.apply(&mut body)?;
    args.claims.apply(&mut body);
    if args.no_permissions {
        // Every family named empty: the door takes the creator's maps for a
        // body naming none of them, whatever it names of the permissions.
        body.insert("permissions".into(), json!([]));
        for map in [
            "type_permissions",
            "extension_permissions",
            "edge_permissions",
            "metadata_permissions",
            "profile_permissions",
        ] {
            body.insert(map.into(), json!({}));
        }
    }
    insert_opt(
        &mut body,
        "default_tier",
        args.default_tier.map(Tier::as_str),
    );
    if args.operator {
        body.insert("is_operator".into(), Value::Bool(true));
    }
    Ok(Request::post(&["keys"]).json(Value::Object(body)).minting())
}

pub fn list_request() -> Request {
    Request::get(&["keys"])
}

pub fn update_request(args: &KeyUpdateArgs) -> Result<Request, CliError> {
    let mut body = Map::new();
    insert_opt(&mut body, "label", args.label.clone());
    args.maps.apply(&mut body)?;
    args.claims.apply(&mut body);
    insert_opt(
        &mut body,
        "default_tier",
        args.default_tier.map(Tier::as_str),
    );
    Ok(Request::patch(&["keys", &args.id]).json(Value::Object(body)))
}

pub fn revoke_request(id: &str) -> Request {
    Request::delete(&["keys", id])
}

pub fn run(command: KeysCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        KeysCommand::Bootstrap { secret } => {
            // The secret is the credential for this one call, whatever key
            // the environment holds: a fresh instance has no key yet.
            let http = Transport::new(remote.url(), Some(secret))?;
            let minted = Remote::with(http).json(&bootstrap_request())?;
            return print_minted(&minted, out);
        }
        KeysCommand::Create(args) => create_request(args)?,
        KeysCommand::List => list_request(),
        KeysCommand::Update(args) => update_request(args)?,
        KeysCommand::Revoke { id } => revoke_request(id),
        KeysCommand::Keep => return keep(remote, out),
        KeysCommand::Forget => {
            let had = credentials::forget(remote.origin())?;
            return out.report(
                &json!({ "origin": remote.origin(), "forgotten": had }),
                || {
                    if had {
                        format!("forgot the key kept for {}", remote.origin())
                    } else {
                        format!("nothing was kept for {}", remote.origin())
                    }
                },
            );
        }
    };
    let answer = remote.json(&request)?;
    if matches!(command, KeysCommand::Create(_)) {
        return print_minted(&answer, out);
    }
    out.value(&answer)
}

/// Keeps the key the call resolved, or one read from stdin, for this origin.
///
/// Checked against the server first: a key kept unverified is a key that
/// fails on the next command with nothing saying it was wrong when kept.
fn keep(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let key = match remote.credential() {
        Some(source) if source != crate::remote::CredentialSource::Keychain => remote.bearer(),
        _ => None,
    };
    let key = match key {
        Some(key) => key,
        None => {
            let mut line = String::new();
            std::io::stdin().read_line(&mut line)?;
            let line = line.trim().to_string();
            if line.is_empty() {
                return Err(CliError::Invalid(
                    "no key to keep: pass --key, set MARFA_API_KEY, or write the key on stdin"
                        .into(),
                ));
            }
            line
        }
    };
    let checked = Remote::with(Transport::new(remote.url(), Some(&key))?);
    checked.json(&Request::get(&["items", "stats"]))?;
    credentials::keep(remote.origin(), &Kept::Key { key })?;
    out.report(&json!({ "origin": remote.origin(), "kept": "key" }), || {
        format!(
            "kept a key for {} in the keychain; it is now the server a bare command talks to",
            remote.origin()
        )
    })
}

/// A minted key is shown once, so the plaintext is the first thing on the
/// line rather than a field in a record somebody scrolls past.
fn print_minted(answer: &Value, out: &Printer) -> Result<(), CliError> {
    out.report(answer, || {
        let key = answer.get("key").and_then(Value::as_str).unwrap_or("");
        let id = answer.get("id").and_then(Value::as_str).unwrap_or("");
        let label = answer.get("label").and_then(Value::as_str).unwrap_or("");
        format!("{key}\nkey {id} ({label}); the plaintext is shown once, keep it now")
    })
}
