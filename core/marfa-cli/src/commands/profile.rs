use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};
use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Subcommand)]
pub enum ProfileCommand {
    /// Show the owner's name, username, email address and avatar, as far as profile read permission reaches.
    Show,
    /// Change the owner's username, email address, name or avatar with profile write permission for each field.
    Update(ProfileUpdateArgs),
    /// Fetch the owner's avatar. Needs profile read permission for the avatar.
    Avatar {
        /// Where to write the avatar. Omitted, its bytes go to stdout.
        #[arg(long, value_name = "PATH")]
        output: Option<PathBuf>,
    },
}

#[derive(Debug, Args)]
#[group(required = true)]
pub struct ProfileUpdateArgs {
    /// The username the owner signs in with. Signing in with the old one stops at once.
    #[arg(long)]
    username: Option<String>,
    /// The owner's email address. It plays no part in signing in.
    #[arg(long, conflicts_with = "clear_email")]
    email: Option<String>,
    /// Remove the owner's email address.
    #[arg(long)]
    clear_email: bool,
    /// The owner's new display name.
    #[arg(long)]
    name: Option<String>,
    /// A PNG, JPEG or WebP avatar file of 2 MiB or less. The server decides the kind from the bytes.
    #[arg(long, value_name = "FILE", conflicts_with = "clear_avatar")]
    avatar: Option<PathBuf>,
    /// Remove the owner's avatar.
    #[arg(long)]
    clear_avatar: bool,
}

/// The largest avatar the server accepts, so a larger file is refused here
/// before the upload starts and the server's reply is cut off.
const AVATAR_LIMIT_BYTES: u64 = 2 * 1024 * 1024;

/// The request that stores the avatar in `file`, built only once the file
/// opens, is a regular file and fits the limit, so a bad path fails before
/// anything is sent.
pub(super) fn avatar_request(file: &Path) -> Result<Request, CliError> {
    let unreadable = |reason: &dyn std::fmt::Display| {
        CliError::Invalid(format!("cannot read {}: {reason}", file.display()))
    };
    let metadata = std::fs::File::open(file)
        .and_then(|handle| handle.metadata())
        .map_err(|error| unreadable(&error))?;
    if !metadata.is_file() {
        return Err(unreadable(&"not a file"));
    }
    if metadata.len() > AVATAR_LIMIT_BYTES {
        return Err(CliError::Invalid(format!(
            "{} is over 2 MiB; use an avatar of 2 MiB or less",
            file.display()
        )));
    }
    Ok(Request::put(&["profile", "avatar"]).file(file.to_path_buf(), "application/octet-stream"))
}

pub fn run(command: ProfileCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        ProfileCommand::Show => out.value(&remote.json(&Request::get(&["profile"]))?),
        ProfileCommand::Update(args) => {
            let avatar = match &args.avatar {
                Some(file) => Some(avatar_request(file)?),
                None => None,
            };
            let mut body = Map::new();
            if let Some(username) = args.username {
                body.insert("username".into(), Value::String(username));
            }
            if let Some(email) = args.email {
                body.insert("email".into(), Value::String(email));
            }
            if args.clear_email {
                body.insert("email".into(), Value::Null);
            }
            if let Some(name) = args.name {
                body.insert("name".into(), Value::String(name));
            }
            if args.clear_avatar {
                body.insert("avatar".into(), Value::Null);
            }
            // The avatar goes first: the server may refuse it, and a refusal
            // then leaves the other fields as they were.
            let mut reply = None;
            if let Some(request) = avatar {
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
        ProfileCommand::Avatar { output } => {
            let (content_type, mut reader) =
                remote.stream(&Request::get(&["profile", "avatar"]).streamed())?;
            let written = super::blobs::save(&mut reader, output.as_deref(), None)?;
            // Bytes to stdout are the answer; a report there would corrupt it.
            if let Some(path) = output {
                out.report(
                    &json!({ "path": path, "size_bytes": written, "mime_type": content_type }),
                    |_| {
                        format!(
                            "{} byte(s) of {} into {}",
                            written,
                            crate::output::printable(&content_type),
                            path.display()
                        )
                    },
                )?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    #[test]
    fn the_email_is_set_or_cleared_never_both() {
        let parse = |words: &[&str]| {
            let mut argv = vec!["marfa", "profile", "update"];
            argv.extend(words);
            crate::Cli::try_parse_from(argv)
        };
        assert!(parse(&["--email", "a@example.com"]).is_ok());
        assert!(parse(&["--clear-email"]).is_ok());
        assert!(parse(&["--username", "alex"]).is_ok());
        assert!(parse(&["--email", "a@example.com", "--clear-email"]).is_err());
        assert!(parse(&[]).is_err());
    }
}
