use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};
use clap::{Args, Subcommand};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Subcommand)]
pub enum ProfileCommand {
    /// Change the owner's name or avatar with profile write permission for each field.
    Update(ProfileUpdateArgs),
}

#[derive(Debug, Args)]
#[group(required = true)]
pub struct ProfileUpdateArgs {
    /// The owner's new display name.
    #[arg(long)]
    name: Option<String>,
    /// A PNG, JPEG or WebP picture file of 2 MiB or less. The server decides the kind from the bytes.
    #[arg(long, value_name = "FILE", conflicts_with = "clear_avatar")]
    avatar: Option<PathBuf>,
    /// Remove the owner's picture.
    #[arg(long)]
    clear_avatar: bool,
}

/// The request that stores the picture in `file`, built only once the file
/// opens, so an unreadable path fails before anything is sent.
pub(super) fn picture_request(door: &[&str], file: &Path) -> Result<Request, CliError> {
    std::fs::File::open(file)
        .map_err(|error| CliError::Invalid(format!("cannot read {}: {error}", file.display())))?;
    Ok(Request::put(door).file(file.to_path_buf(), "application/octet-stream"))
}

pub fn run(command: ProfileCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        ProfileCommand::Update(args) => {
            let picture = match &args.avatar {
                Some(file) => Some(picture_request(&["profile", "picture"], file)?),
                None => None,
            };
            let mut body = Map::new();
            if let Some(name) = args.name {
                body.insert("name".into(), Value::String(name));
            }
            if args.clear_avatar {
                body.insert("avatar".into(), Value::Null);
            }
            // The picture goes first: the server may refuse it, and a refusal
            // then leaves the name as it was.
            let mut reply = None;
            if let Some(request) = picture {
                reply = Some(remote.json(&request)?);
            }
            if !body.is_empty() {
                reply = Some(remote.json(&Request::patch(&["profile"]).json(Value::Object(body)))?);
            }
            match reply {
                Some(reply) => out.value(&reply),
                None => Ok(()),
            }
        }
    }
}
