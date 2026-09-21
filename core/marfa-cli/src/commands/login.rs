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
    // does not answer a read is refused here, before the person is asked
    // to approve a token there is nowhere to keep, unless the token is to
    // be printed instead; one that answers the read and refuses the write
    // is met after the approval, where the set is printed rather than
    // lost.
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

    auth::pages_on_issuer(&discovery, &code)?;
    let page = code
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| code.verification_uri.clone());
    let sentence = format!(
        "Open {page} and enter the code {}\nWaiting for the approval...",
        code.user_code
    );
    if args.print_token && !out.json {
        // The token set is the one document on stdout, so the sentence
        // goes beside it.
        eprintln!("{sentence}");
    } else {
        out.record(
            &json!({
                "user_code": code.user_code,
                "verification_uri": code.verification_uri,
                "verification_uri_complete": code.verification_uri_complete,
                "expires_in": code.expires_in,
                "scope": scope,
            }),
            || sentence.clone(),
        )?;
    }
    if !args.no_browser {
        open_browser(&page);
    }

    let token = auth::wait_for_decision(&discovery, &client_id, &code)?;
    let kept = auth::kept(&token, &client_id, &discovery);
    if args.print_token {
        return print_set(&token, &client_id, out);
    }
    match credentials::keep(&origin, &kept) {
        Ok(()) => out.record(
            &json!({ "server": origin, "scope": token.scope, "kept": "keychain" }),
            || format!("signed in to {origin}; the token is in the keychain"),
        ),
        // The person has approved; a set the keychain would not take is
        // theirs to keep by hand rather than lost.
        Err(CliError::NoKeychain(reason)) => {
            eprintln!(
                "marfa: the keychain did not take the token ({reason}); it is printed instead"
            );
            print_set(&token, &client_id, out)
        }
        Err(error) => Err(error),
    }
}

/// The token set as JSON, pretty without `--json` and one line under it.
fn print_set(token: &auth::TokenSet, client_id: &str, out: &Printer) -> Result<(), CliError> {
    let set = json!({
        "access_token": token.access_token,
        "refresh_token": token.refresh_token,
        "expires_in": token.expires_in,
        "scope": token.scope,
        "client_id": client_id,
    });
    out.record(&set, || {
        serde_json::to_string_pretty(&set).unwrap_or_default()
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::door::{Answer, Door};

    /// A discovery document on the door's own origin, listing the scopes the
    /// default narrows to.
    fn discovery(origin: &str) -> String {
        json!({
            "issuer": format!("{origin}/auth"),
            "token_endpoint": format!("{origin}/auth/oauth2/token"),
            "device_authorization_endpoint": format!("{origin}/auth/device/code"),
            "registration_endpoint": format!("{origin}/auth/oauth2/register"),
            "revocation_endpoint": format!("{origin}/auth/oauth2/revoke"),
            "userinfo_endpoint": format!("{origin}/auth/oauth2/userinfo"),
            "scopes_supported": ["openid", "offline_access", "*:read", "keys.mint"]
        })
        .to_string()
    }

    fn device_code(page_origin: &str) -> String {
        json!({
            "device_code": "dc",
            "user_code": "ABCD1234",
            "verification_uri": format!("{page_origin}/auth/device"),
            "verification_uri_complete": format!("{page_origin}/auth/device?user_code=ABCD1234"),
            "expires_in": 600,
            "interval": 1
        })
        .to_string()
    }

    fn args(print_token: bool) -> LoginArgs {
        LoginArgs {
            scope: None,
            no_browser: true,
            print_token,
            client_id: Some("client".into()),
        }
    }

    /// The whole sign-in against a scripted door: discovery read, the
    /// device code asked for under the held client and the narrowed scope,
    /// the token polled for, and the set printed rather than kept.
    #[test]
    fn a_sign_in_reads_discovery_asks_for_a_code_and_polls_for_the_token() {
        let door = Door::open_at(|origin| {
            vec![
                Answer::json("200 OK", &discovery(origin)),
                Answer::json("200 OK", &device_code(origin)),
                Answer::json(
                    "200 OK",
                    r#"{"access_token":"marfa_at_1","refresh_token":"marfa_rt_1","expires_in":3600,"token_type":"Bearer","scope":"*:read"}"#,
                ),
            ]
        });
        let named = Named {
            url: Some(door.url.clone()),
            key: None,
        };
        run(args(true), &named, &Printer { json: true }).unwrap();
        let sent = door.received();
        assert_eq!(sent.len(), 3);
        assert_eq!(
            sent[0].path(),
            "/auth/.well-known/oauth-authorization-server"
        );
        assert_eq!(sent[1].path(), "/auth/device/code");
        assert!(
            sent[1].body.contains("client_id=client"),
            "{}",
            sent[1].body
        );
        assert!(
            sent[1]
                .body
                .contains("scope=openid+offline_access+*%3Aread+keys.mint"),
            "{}",
            sent[1].body
        );
        assert_eq!(sent[2].path(), "/auth/oauth2/token");
        assert!(sent[2].body.contains("device_code=dc"), "{}", sent[2].body);
    }

    /// A device code whose page is off the issuer is refused before the
    /// token door is polled: the door has no third answer to give.
    #[test]
    fn a_page_off_the_issuer_is_refused_before_the_poll() {
        let door = Door::open_at(|origin| {
            vec![
                Answer::json("200 OK", &discovery(origin)),
                Answer::json("200 OK", &device_code("https://elsewhere.invalid")),
            ]
        });
        let named = Named {
            url: Some(door.url.clone()),
            key: None,
        };
        let outcome = run(args(true), &named, &Printer { json: true });
        assert!(
            matches!(&outcome, Err(CliError::Invalid(message)) if message.contains("off the issuer")),
            "{outcome:?}"
        );
        assert_eq!(door.received().len(), 2);
    }

    /// A kept key is not replaced under the person: the sign-in is refused
    /// after discovery and before a code is asked for.
    #[test]
    fn a_kept_key_is_not_replaced_by_a_sign_in() {
        let door = Door::open_at(|origin| vec![Answer::json("200 OK", &discovery(origin))]);
        let origin = crate::remote::Remote::public_at(&door.url)
            .unwrap()
            .origin()
            .to_string();
        let _keychain = credentials::hold(&origin);
        match credentials::keep(
            &origin,
            &Kept::Key {
                key: "marfa_k1_kept".into(),
            },
        ) {
            Ok(()) => {}
            Err(CliError::NoKeychain(reason)) => {
                credentials::skipped(&reason);
                drop(door);
                return;
            }
            Err(error) => panic!("{error}"),
        }
        let named = Named {
            url: Some(door.url.clone()),
            key: None,
        };
        let outcome = run(args(false), &named, &Printer { json: true });
        assert!(
            matches!(&outcome, Err(CliError::Invalid(message)) if message.contains("a key is kept")),
            "{outcome:?}"
        );
        assert_eq!(door.received().len(), 1);
    }
}
