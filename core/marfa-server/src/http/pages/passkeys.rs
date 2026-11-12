use askama::Template;

use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

#[derive(Debug, Clone)]
pub struct OwnerPasskey {
    pub id: String,
    pub name: String,
    pub added: String,
    pub last_used: Option<String>,
    pub made_for: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OwnerPasskeys {
    pub instance_name: String,
    /// For a password manager to file the new password under.
    pub email: String,
    pub rows: Vec<OwnerPasskey>,
}

#[derive(Template)]
#[template(path = "passkeys.html")]
struct PasskeysBody<'a> {
    email: &'a str,
    rows: &'a [OwnerPasskey],
}

pub fn owner_passkeys(view: &OwnerPasskeys) -> Result<Page> {
    let body = render_body(&PasskeysBody {
        email: &view.email,
        rows: &view.rows,
    })?;
    document(
        "Passkeys and password",
        &view.instance_name,
        &body,
        Needs {
            connect: true,
            confirm_dialog: true,
        },
    )
}
