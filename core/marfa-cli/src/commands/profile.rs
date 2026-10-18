use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};
use clap::{Args, Subcommand};
use serde_json::{Map, Value};

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
    /// An HTTP or HTTPS avatar URL. Marfa does not fetch it.
    #[arg(long, conflicts_with = "clear_avatar")]
    avatar: Option<String>,
    /// Clear the avatar URL.
    #[arg(long)]
    clear_avatar: bool,
}

pub fn run(command: ProfileCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        ProfileCommand::Update(args) => {
            let mut body = Map::new();
            if let Some(name) = args.name {
                body.insert("name".into(), Value::String(name));
            }
            if let Some(avatar) = args.avatar {
                body.insert("avatar".into(), Value::String(avatar));
            }
            if args.clear_avatar {
                body.insert("avatar".into(), Value::Null);
            }
            out.value(&remote.json(&Request::patch(&["profile"]).json(Value::Object(body)))?)
        }
    }
}
