use std::io::{IsTerminal, Read};

use clap::{Args, Subcommand};
use serde_json::{Map, Value};

use super::BodySource;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// The instance configuration: the name, enforcement levers and live
    /// settings. Needs `config.manage`.
    Get,
    /// Replace the instance configuration whole. Needs `config.manage`.
    Replace(WriteArgs),
    /// Change only the settings the body names; `null` removes one. Needs
    /// `config.manage`.
    Update(WriteArgs),
    /// Change one setting by name. The value is sent as the setting's own
    /// kind: a number, `true` or `false`, a comma-separated list or text. A
    /// secret setting never takes its value as an argument: it is read from
    /// standard input, or asked for with no echo at a terminal. Needs
    /// `config.manage`.
    Set(SetArgs),
    /// Remove one setting's stored value, so it takes its default. Needs
    /// `config.manage`.
    Unset {
        /// The setting's key, as `config settings` lists it.
        name: String,
    },
    /// Every stored setting with its value, default and rule, and the
    /// settings only the environment sets. Needs `config.manage` or
    /// `instance.read`.
    Settings,
    /// What changing the addresses would do, whether a write needs
    /// confirming, and whether a new sign-in address answers as this
    /// instance; nothing is written. Needs `config.manage`.
    CheckAddress(BodySource),
}

#[derive(Debug, Args)]
pub struct SetArgs {
    /// The setting's key, as `config settings` lists it.
    name: String,
    /// The new value. Leave it out for a secret setting.
    value: Option<String>,
    /// Confirm a change to the sign-in address, which signs everyone out and
    /// can strand passkeys and apps. Without this the server answers what the
    /// change would do and writes nothing.
    #[arg(long)]
    confirm_address_change: bool,
}

#[derive(Debug, Args)]
pub struct WriteArgs {
    #[command(flatten)]
    body: BodySource,
    /// Confirm a change to the sign-in address, which signs out every browser
    /// and app, and leaves passkeys made for the old address unusable until it
    /// moves back. It needs a sign-in from the last fifteen minutes, or the private
    /// local command (`--socket`). Without this the server answers what the
    /// change would do and writes nothing.
    #[arg(long)]
    confirm_address_change: bool,
    /// Move the sign-in address without first checking that it answers as
    /// this instance, for a host that answers only after the move. Only the
    /// private local command (`--socket`) may skip the check.
    #[arg(long)]
    skip_sign_in_address_check: bool,
}

impl WriteArgs {
    fn read(&self) -> Result<serde_json::Value, CliError> {
        let mut body = self.body.read()?;
        for (set, flag, field) in [
            (
                self.confirm_address_change,
                "--confirm-address-change",
                "confirm_sign_in_address_change",
            ),
            (
                self.skip_sign_in_address_check,
                "--skip-sign-in-address-check",
                "skip_sign_in_address_check",
            ),
        ] {
            if set {
                body.as_object_mut()
                    .ok_or_else(|| {
                        CliError::Invalid(format!("{flag} needs a JSON object as the body"))
                    })?
                    .insert(field.into(), true.into());
            }
        }
        Ok(body)
    }
}

pub fn get_request() -> Request {
    Request::get(&["config"])
}

pub fn replace_request(body: serde_json::Value) -> Request {
    Request::put(&["config"]).json(body)
}

pub fn update_request(body: serde_json::Value) -> Request {
    Request::patch(&["config"]).json(body)
}

pub fn settings_request() -> Request {
    Request::get(&["config", "settings"])
}

pub fn check_address_request(body: serde_json::Value) -> Request {
    Request::post(&["config", "address-check"]).json(body)
}

/// Standard input, or a prompt with no echo at a terminal, for a value that
/// no command line may carry.
pub(crate) fn secret_value(name: &str) -> Result<String, CliError> {
    if std::io::stdin().is_terminal() {
        return Ok(rpassword::prompt_password(format!("Value for {name}: "))?);
    }
    let mut text = String::new();
    std::io::stdin().take(65_537).read_to_string(&mut text)?;
    if text.len() > 65_536 {
        return Err(CliError::Invalid("input exceeds 64 KiB".into()));
    }
    let value = text
        .strip_suffix('\n')
        .map(|text| text.strip_suffix('\r').unwrap_or(text))
        .unwrap_or(&text);
    if value.is_empty() {
        return Err(CliError::Usage(format!(
            "{name} is a secret: send its value on standard input"
        )));
    }
    Ok(value.to_string())
}

/// `text` as the kind of value `setting` holds, which its listed value shows:
/// a number, a boolean or a list, and otherwise text, where nothing is set yet.
fn typed(name: &str, setting: &Value, text: &str) -> Result<Value, CliError> {
    let wrong = |wanted: &str| {
        CliError::Usage(format!(
            "{name} takes {wanted}, and {text:?} is not that; `marfa config settings` states its rule"
        ))
    };
    Ok(match setting.get("value") {
        Some(Value::Number(_)) => text
            .parse::<u64>()
            .map(Value::from)
            .map_err(|_| wrong("a whole number"))?,
        Some(Value::Bool(_)) => match text {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => return Err(wrong("`true` or `false`")),
        },
        Some(Value::Array(_)) => Value::Array(
            text.split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(|entry| Value::String(entry.to_string()))
                .collect(),
        ),
        _ => Value::String(text.to_string()),
    })
}

fn named<'a>(listing: &'a Value, name: &str) -> Result<&'a Value, CliError> {
    listing
        .get("data")
        .and_then(Value::as_array)
        .and_then(|settings| {
            settings
                .iter()
                .find(|setting| setting.get("key").and_then(Value::as_str) == Some(name))
        })
        .ok_or_else(|| {
            CliError::Usage(format!(
                "no stored setting is named {name}; `marfa config settings` lists them"
            ))
        })
}

/// The body that changes one setting. A secret's value is asked for only once
/// the listing says it is a secret, and a value given beside it is refused.
fn one_setting(name: &str, value: Option<&str>, listing: &Value) -> Result<Value, CliError> {
    let setting = named(listing, name)?;
    let sent = if setting.get("secret").and_then(Value::as_bool) == Some(true) {
        if value.is_some() {
            return Err(CliError::Usage(format!(
                "{name} is a secret, so it takes no value as an argument, which a process list and a shell history keep; \
                 send it on standard input or run the command with no value to be asked"
            )));
        }
        Value::String(secret_value(name)?)
    } else {
        let value = value.ok_or_else(|| {
            CliError::Usage(format!(
                "give {name} a value, or use `marfa config unset {name}`"
            ))
        })?;
        typed(name, setting, value)?
    };
    Ok(Value::Object(Map::from_iter([(name.to_string(), sent)])))
}

fn with_confirmation(mut body: Value, confirmed: bool) -> Value {
    if confirmed && let Some(fields) = body.as_object_mut() {
        fields.insert("confirm_sign_in_address_change".into(), true.into());
    }
    body
}

pub fn run(command: ConfigCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        ConfigCommand::Get => get_request(),
        ConfigCommand::Replace(args) => replace_request(args.read()?),
        ConfigCommand::Update(args) => update_request(args.read()?),
        ConfigCommand::Set(args) => {
            let listing = remote.json(&settings_request())?;
            let body = one_setting(&args.name, args.value.as_deref(), &listing)?;
            update_request(with_confirmation(body, args.confirm_address_change))
        }
        ConfigCommand::Unset { name } => {
            update_request(Value::Object(Map::from_iter([(name.clone(), Value::Null)])))
        }
        ConfigCommand::Settings => settings_request(),
        ConfigCommand::CheckAddress(body) => check_address_request(body.read()?),
    };
    let answer = remote.json(&request)?;
    match &command {
        ConfigCommand::Replace(_) | ConfigCommand::Update(_) => out.report(&answer, |_| {
            "updated the instance configuration".to_string()
        }),
        ConfigCommand::Set(args) => out.report(&answer, |_| format!("set {}", args.name)),
        ConfigCommand::Unset { name } => out.report(&answer, |_| format!("unset {name}")),
        _ => out.value(&answer),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listing() -> Value {
        json!({"data": [
            {"key": "max_request_bytes", "value": 1048576, "secret": false},
            {"key": "reporting", "value": false, "secret": false},
            {"key": "allowed_hosts", "value": [], "secret": false},
            {"key": "notice", "value": null, "secret": false},
            {"key": "backup_secret", "value": null, "secret": true},
        ]})
    }

    fn body(name: &str, value: Option<&str>) -> Result<Value, CliError> {
        one_setting(name, value, &listing())
    }

    #[test]
    fn a_value_is_sent_as_the_kind_the_setting_holds() {
        assert_eq!(
            body("max_request_bytes", Some("2048")).unwrap(),
            json!({"max_request_bytes": 2048})
        );
        assert_eq!(
            body("reporting", Some("true")).unwrap(),
            json!({"reporting": true})
        );
        assert_eq!(
            body("allowed_hosts", Some("a.example, b.example,")).unwrap(),
            json!({"allowed_hosts": ["a.example", "b.example"]})
        );
        assert_eq!(
            body("allowed_hosts", Some("")).unwrap(),
            json!({"allowed_hosts": []})
        );
        assert_eq!(
            body("notice", Some("true")).unwrap(),
            json!({"notice": "true"})
        );
        assert_eq!(
            body("notice", Some("[1, 2]")).unwrap(),
            json!({"notice": "[1, 2]"})
        );
    }

    #[test]
    fn a_value_of_another_kind_is_refused_before_anything_is_sent() {
        for (name, value) in [
            ("max_request_bytes", "many"),
            ("max_request_bytes", "-1"),
            ("max_request_bytes", "1.5"),
            ("reporting", "yes"),
            ("reporting", "1"),
        ] {
            assert!(
                matches!(body(name, Some(value)), Err(CliError::Usage(_))),
                "{name} {value}"
            );
        }
    }

    #[test]
    fn a_secret_given_as_an_argument_is_refused_and_a_plain_setting_needs_its_value() {
        let refused = body("backup_secret", Some("hunter2")).unwrap_err();
        let CliError::Usage(message) = refused else {
            panic!("{refused:?}");
        };
        assert!(
            message.contains("takes no value as an argument"),
            "{message}"
        );
        assert!(!message.contains("hunter2"), "{message}");
        assert!(matches!(
            body("notice", None),
            Err(CliError::Usage(message)) if message.contains("config unset notice")
        ));
    }

    #[test]
    fn a_name_the_server_does_not_list_is_refused() {
        assert!(matches!(
            body("no_such_setting", Some("1")),
            Err(CliError::Usage(message)) if message.contains("no_such_setting")
        ));
    }

    #[test]
    fn the_address_confirmation_is_added_only_when_given() {
        let held = json!({"sign_in_address": "https://marfa.example"});
        assert_eq!(with_confirmation(held.clone(), false), held);
        assert_eq!(
            with_confirmation(held, true),
            json!({"sign_in_address": "https://marfa.example", "confirm_sign_in_address_change": true})
        );
    }
}
