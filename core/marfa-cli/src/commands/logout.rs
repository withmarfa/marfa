use clap::Args;
use serde_json::json;

use crate::auth;
use crate::cleartext;
use crate::credentials::{self, Kept};
use crate::error::{CliError, Exit};
use crate::output::Printer;
use crate::remote::request::Request;
use crate::remote::{Named, Remote};

#[derive(Debug, Args)]
pub struct LogoutArgs {
    /// With the keychain off, the client id the token was issued to, as `marfa login --print-token`
    /// printed it. The server revokes a token only for that client.
    #[arg(long, value_name = "ID")]
    pub client_id: Option<String>,
}

pub fn run(args: &LogoutArgs, named: &Named, out: &Printer) -> Result<(), CliError> {
    if credentials::is_off() {
        let environment = std::env::var("MARFA_API_KEY").ok();
        return without_keychain(args, named, environment, out);
    }
    if args.client_id.is_some() {
        return Err(CliError::Usage(
            "--client-id is for a token passed with the keychain off: the keychain keeps the client id of a sign-in".into(),
        ));
    }
    let url = Remote::url_named(named)?;
    let origin = Remote::public_at(&url)?.origin().to_string();
    auth::with_credential_lock(&origin, || sign_out(&origin, out))
}

fn sign_out(origin: &str, out: &Printer) -> Result<(), CliError> {
    match credentials::read(origin)? {
        Some(kept @ Kept::Token { .. }) => {
            // The token is forgotten whether or not the server took the
            // revocation. The flag says whether it is known not to have: a
            // revocation answered on another contract was sent, so it may
            // have taken effect.
            let not_revoked: Option<(&str, bool)> = match auth::revoke(&kept) {
                Ok(true) => None,
                Ok(false) => Some(("no revocation endpoint was kept for this sign-in", true)),
                Err(CliError::Refused { .. }) => {
                    Some(("the server did not accept the revocation", true))
                }
                Err(CliError::ContractMismatch { .. }) => Some((
                    "the server speaks another contract, so whether it took the revocation is unknown",
                    false,
                )),
                Err(_) => Some(("the server could not be reached to revoke it", true)),
            };
            credentials::forget(origin)?;
            let revoked = match not_revoked {
                None => json!(true),
                Some((_, true)) => json!(false),
                Some((_, false)) => json!(null),
            };
            out.report(
                &json!({ "server": origin, "signed_out": true, "revoked": revoked }),
                |_| match not_revoked {
                    None => format!("signed out of {origin}"),
                    Some((why, true)) => {
                        format!(
                            "signed out of {origin}; {why}, so the token stands until it expires"
                        )
                    }
                    Some((why, false)) => format!("signed out of {origin}; {why}"),
                },
            )
        }
        Some(Kept::Key { .. }) => Err(CliError::Invalid(format!(
            "a key is kept for {origin}, not a sign-in; `marfa keys forget` removes it"
        ))),
        None => out.report(&json!({ "server": origin, "signed_out": false }), |_| {
            format!("not signed in to {origin}")
        }),
    }
}

/// A token passed with `--key` or `MARFA_API_KEY` and revoked at the server, with nothing in the
/// keychain to read or forget.
fn without_keychain(
    args: &LogoutArgs,
    named: &Named,
    environment: Option<String>,
    out: &Printer,
) -> Result<(), CliError> {
    let token = named
        .key
        .clone()
        .or(environment)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            credentials::refusal(
                "to revoke a token, pass it with --key or MARFA_API_KEY and the client id it was issued to with --client-id, as `marfa login --print-token` printed them",
            )
        })?;
    let Some(kind) = auth::token_kind(&token) else {
        return Err(CliError::Invalid(
            "the credential passed is not a sign-in token (marfa_at_ or marfa_rt_): `marfa keys revoke` ends a key".into(),
        ));
    };
    let client_id = args.client_id.as_deref().ok_or_else(|| {
        CliError::Usage(
            "pass the client id the token was issued to with --client-id; `marfa login --print-token` prints it".into(),
        )
    })?;
    let url = Remote::url_named(named)?;
    cleartext::guard(&url);
    let remote = Remote::public_at(&url)?;
    let origin = remote.origin().to_string();
    let discovery = auth::discover(&remote)?;
    let Some(endpoint) = &discovery.revocation_endpoint else {
        return Err(CliError::Invalid(format!(
            "{origin} advertises no revocation endpoint, so the token cannot be revoked there"
        )));
    };
    auth::revoke_token(endpoint, &token, kind, client_id)?;
    // The door answers alike for a token it did not end, so an access token is tried once.
    let revoked = if kind == auth::ACCESS_TOKEN {
        match Remote::keyed(&url, &token)?.json(&Request::get(&["profile"])) {
            Ok(_) => {
                return Err(CliError::Invalid(format!(
                    "{origin} still accepts the token: --client-id is not the client it was issued to"
                )));
            }
            Err(error) if error.exit() == Exit::Credential => json!(true),
            Err(_) => json!(null),
        }
    } else {
        json!(null)
    };
    out.report(
        &json!({ "server": origin, "signed_out": false, "revoked": revoked }),
        |_| match revoked {
            serde_json::Value::Bool(_) => format!("revoked the token at {origin}"),
            _ => format!(
                "asked {origin} to revoke the token; the server answers alike for a token it did not end, so this cannot confirm it"
            ),
        },
    )
}

#[cfg(test)]
mod keychain_off_tests {
    use super::*;

    #[test]
    fn with_the_keychain_off_a_token_and_its_client_are_asked_for() {
        credentials::turn_off();
        let named = Named {
            url: Some("https://marfa.example".into()),
            key: None,
            profile: None,
        };
        let args = LogoutArgs { client_id: None };
        let outcome = without_keychain(&args, &named, None, &Printer { json: true });
        assert!(
            matches!(&outcome, Err(CliError::Usage(message)) if message.contains("the keychain is off") && message.contains("--client-id")),
            "{outcome:?}"
        );
        let key = Named {
            key: Some("marfa_k1_abc".into()),
            ..named
        };
        let outcome = without_keychain(&args, &key, None, &Printer { json: true });
        assert!(
            matches!(&outcome, Err(CliError::Invalid(message)) if message.contains("marfa keys revoke")),
            "{outcome:?}"
        );
    }
}
