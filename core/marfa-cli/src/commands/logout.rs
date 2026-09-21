use serde_json::json;

use crate::auth;
use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Named, Remote};

/// Sign out of a server: the token set is revoked and forgotten.
pub fn run(named: &Named, out: &Printer) -> Result<(), CliError> {
    let url = Remote::url_named(named)?;
    let origin = Remote::public_at(&url)?.origin().to_string();
    match credentials::read(&origin)? {
        Some(kept @ Kept::Token { .. }) => {
            // The keychain decides the sign-out: the token is forgotten
            // whether or not the server took the revocation, and the
            // answer says which.
            let not_revoked = match auth::revoke(&kept) {
                Ok(()) => None,
                Err(CliError::Refused { .. }) => Some("the server did not accept the revocation"),
                Err(_) => Some("the server could not be reached to revoke it"),
            };
            credentials::forget(&origin)?;
            out.report(
                &json!({ "server": origin, "signed_out": true, "revoked": not_revoked.is_none() }),
                || match not_revoked {
                    None => format!("signed out of {origin}"),
                    Some(why) => {
                        format!(
                            "signed out of {origin}; {why}, so the token stands until it expires"
                        )
                    }
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
