use serde_json::json;

use crate::auth;
use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Named, Remote};

pub fn run(named: &Named, out: &Printer) -> Result<(), CliError> {
    let url = Remote::url_named(named)?;
    let origin = Remote::public_at(&url)?.origin().to_string();
    match credentials::read(&origin)? {
        Some(kept @ Kept::Token { .. }) => {
            // The token is forgotten whether or not the server took the
            // revocation. The flag says whether it is known not to have: a
            // revocation answered on another contract was sent, so it may
            // have taken effect.
            let not_revoked: Option<(&str, bool)> = match auth::revoke(&kept) {
                Ok(()) => None,
                Err(CliError::Refused { .. }) => {
                    Some(("the server did not accept the revocation", true))
                }
                Err(CliError::ContractMismatch { .. }) => Some((
                    "the server speaks another contract, so whether it took the revocation is unknown",
                    false,
                )),
                Err(_) => Some(("the server could not be reached to revoke it", true)),
            };
            credentials::forget(&origin)?;
            let revoked = match not_revoked {
                None => json!(true),
                Some((_, true)) => json!(false),
                Some((_, false)) => json!(null),
            };
            out.report(
                &json!({ "server": origin, "signed_out": true, "revoked": revoked }),
                || match not_revoked {
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
        None => out.report(&json!({ "server": origin, "signed_out": false }), || {
            format!("not signed in to {origin}")
        }),
    }
}
