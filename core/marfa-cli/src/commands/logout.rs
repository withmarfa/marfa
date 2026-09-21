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
            // The keychain decides the sign-out; a revocation the server
            // refuses is reported, not obeyed.
            let revoked = match auth::revoke(&kept) {
                Ok(()) => true,
                Err(CliError::Refused { .. }) => false,
                Err(error) => return Err(error),
            };
            credentials::forget(&origin)?;
            out.report(
                &json!({ "server": origin, "signed_out": true, "revoked": revoked }),
                || {
                    if revoked {
                        format!("signed out of {origin}")
                    } else {
                        format!(
                            "signed out of {origin}; the server did not accept the revocation, so the token stands until it expires"
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
