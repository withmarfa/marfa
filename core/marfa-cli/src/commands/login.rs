use clap::Args;
use serde_json::json;

use crate::auth;
use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Named, Remote};

/// Sign in to a server as the owner, with a code approved in the browser.
#[derive(Debug, Args)]
pub struct LoginArgs {
    /// What to ask for. Everything the owner can tick unless narrowed here;
    /// the consent screen is where a grant is narrowed.
    #[arg(long, value_name = "SCOPE")]
    pub scope: Option<String>,
    /// Print the page to open rather than opening it.
    #[arg(long)]
    pub no_browser: bool,
    /// Print the token set instead of keeping it in the keychain, for a
    /// process that has no keychain to keep it in.
    #[arg(long)]
    pub print_token: bool,
}

pub fn run(args: LoginArgs, named: &Named, out: &Printer) -> Result<(), CliError> {
    let url = Remote::url_named(named)?;
    let remote = Remote::public_at(&url)?;
    let origin = remote.origin().to_string();
    let discovery = auth::discover(&remote)?;

    // The client registered on an earlier sign-in to this origin is reused;
    // a server that has forgotten it says `invalid_client` and it is
    // registered again. A keychain that does not answer is refused here,
    // before the person is asked to approve a token there is nowhere to
    // keep, unless the token is to be printed instead.
    let held = match credentials::read(&origin) {
        Ok(Some(Kept::Token { client_id, .. })) => Some(client_id),
        Ok(_) => None,
        Err(CliError::NoKeychain(_)) if args.print_token => None,
        Err(CliError::NoKeychain(reason)) => {
            return Err(CliError::NoKeychain(format!(
                "{reason}; pass --print-token to receive the token set on stdout instead"
            )));
        }
        Err(error) => return Err(error),
    };
    let scope = args.scope.as_deref().unwrap_or(auth::DEFAULT_SCOPE);
    let (client_id, code) = match held {
        Some(client_id) => match auth::device_code(&discovery, &client_id, scope) {
            Ok(code) => (client_id, code),
            Err(CliError::Refused { code, .. }) if code == "invalid_client" => {
                let client_id = auth::register(&discovery)?;
                let code = auth::device_code(&discovery, &client_id, scope)?;
                (client_id, code)
            }
            Err(error) => return Err(error),
        },
        None => {
            let client_id = auth::register(&discovery)?;
            let code = auth::device_code(&discovery, &client_id, scope)?;
            (client_id, code)
        }
    };

    let page = code
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| code.verification_uri.clone());
    // The code goes out before the wait, as one record under --json so a
    // program driving this reads it the moment it exists.
    out.record(
        &json!({
            "user_code": code.user_code,
            "verification_uri": code.verification_uri,
            "verification_uri_complete": code.verification_uri_complete,
            "expires_in": code.expires_in,
        }),
        || {
            format!(
                "Open {page} and enter the code {}\nWaiting for the approval...",
                code.user_code
            )
        },
    )?;
    if !args.no_browser {
        open_browser(&page);
    }

    let token = auth::wait_for_decision(&discovery, &client_id, &code)?;
    let kept = auth::kept(&token, &client_id, &discovery);
    if args.print_token {
        return out.report(
            &json!({
                "access_token": token.access_token,
                "refresh_token": token.refresh_token,
                "expires_in": token.expires_in,
                "scope": token.scope,
                "client_id": client_id,
            }),
            || format!("signed in to {origin}; the token was printed and not kept"),
        );
    }
    credentials::keep(&origin, &kept)?;
    out.report(
        &json!({ "server": origin, "scope": token.scope, "kept": "keychain" }),
        || format!("signed in to {origin}; the token is in the keychain"),
    )
}

/// Best effort: a browser that does not open is not a failure, because the
/// page was printed.
fn open_browser(page: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(opener)
        .arg(page)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}
