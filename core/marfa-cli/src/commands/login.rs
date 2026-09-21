use clap::Args;
use serde_json::json;

use crate::auth::{self, DeviceCode, Discovery};
use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Named, Remote};

/// Sign in to a server as the owner, with a code approved in the browser.
///
/// Under --json two records come out, one per line: the code and the page
/// to approve it on, as soon as they exist, then the outcome once the owner
/// has decided.
#[derive(Debug, Args)]
pub struct LoginArgs {
    /// What to ask for. Everything an owner can hold, narrowed to what the
    /// server supports, unless narrowed here; the consent screen is where
    /// a grant is narrowed.
    #[arg(long, value_name = "SCOPE")]
    pub scope: Option<String>,
    /// Print the page to open rather than opening it.
    #[arg(long)]
    pub no_browser: bool,
    /// Print the token set instead of keeping it in the keychain, for a
    /// process that has no keychain to keep it in.
    #[arg(long)]
    pub print_token: bool,
    /// The client id an earlier sign-in registered at this server, for a
    /// process with no keychain to remember it in; without one the binary
    /// registers again.
    #[arg(long, value_name = "ID")]
    pub client_id: Option<String>,
}

pub fn run(args: LoginArgs, named: &Named, out: &Printer) -> Result<(), CliError> {
    let url = Remote::url_named(named)?;
    let remote = Remote::public_at(&url)?;
    let origin = remote.origin().to_string();
    let discovery = auth::discover(&remote)?;

    // What is kept for this origin decides: a key is not replaced under
    // the person; a sign-in is replaced, and the set it replaces is left
    // to expire rather than revoked, because revoking a refresh token
    // ends the grant behind it, the new set included. A keychain that
    // does not answer is refused here, before the person is asked to
    // approve a token there is nowhere to keep, unless the token is to be
    // printed instead.
    match credentials::read(&origin) {
        Ok(Some(Kept::Key { .. })) => {
            return Err(CliError::Invalid(format!(
                "a key is kept for {origin}; `marfa keys forget` removes it before a sign-in replaces it"
            )));
        }
        Ok(_) => {}
        Err(CliError::NoKeychain(_)) if args.print_token => {}
        Err(CliError::NoKeychain(reason)) => {
            return Err(CliError::NoKeychain(format!(
                "{reason}; pass --print-token to receive the token set on stdout instead"
            )));
        }
        Err(error) => return Err(error),
    }
    let held = match &args.client_id {
        Some(id) => Some(id.clone()),
        None => match credentials::client_id(&origin) {
            Ok(id) => id,
            Err(CliError::NoKeychain(_)) => None,
            Err(error) => return Err(error),
        },
    };
    let scope = match &args.scope {
        Some(scope) => scope.clone(),
        None => auth::default_scope(&discovery)?,
    };
    // The client registered on an earlier sign-in to this origin is reused;
    // a server that has forgotten it says `invalid_client` and it is
    // registered again.
    let (client_id, code) = match held {
        Some(client_id) => match auth::device_code(&discovery, &client_id, &scope) {
            Ok(code) => (client_id, code),
            Err(CliError::Refused { code, .. }) if code == "invalid_client" => {
                register_and_ask(&discovery, &origin, &scope)?
            }
            Err(error) => return Err(error),
        },
        None => register_and_ask(&discovery, &origin, &scope)?,
    };

    // The pages are checked like the doors: the binary is about to hand
    // one to a browser.
    auth::on_issuer(&discovery, &code.verification_uri)?;
    if let Some(complete) = &code.verification_uri_complete {
        auth::on_issuer(&discovery, complete)?;
    }
    let page = code
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| code.verification_uri.clone());
    out.record(
        &json!({
            "user_code": code.user_code,
            "verification_uri": code.verification_uri,
            "verification_uri_complete": code.verification_uri_complete,
            "expires_in": code.expires_in,
            "scope": scope,
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
        let set = json!({
            "access_token": token.access_token,
            "refresh_token": token.refresh_token,
            "expires_in": token.expires_in,
            "scope": token.scope,
            "client_id": client_id,
        });
        return out.record(&set, || {
            serde_json::to_string_pretty(&set).unwrap_or_default()
        });
    }
    credentials::keep(&origin, &kept)?;
    out.record(
        &json!({ "server": origin, "scope": token.scope, "kept": "keychain" }),
        || format!("signed in to {origin}; the token is in the keychain"),
    )
}

/// Registers the binary at the server, keeps the client id where a keychain
/// answers, and asks for a device code under it.
fn register_and_ask(
    discovery: &Discovery,
    origin: &str,
    scope: &str,
) -> Result<(String, DeviceCode), CliError> {
    let client_id = auth::register(discovery)?;
    match credentials::keep_client_id(origin, &client_id) {
        Ok(()) | Err(CliError::NoKeychain(_)) => {}
        Err(error) => return Err(error),
    }
    let code = auth::device_code(discovery, &client_id, scope)?;
    Ok((client_id, code))
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
