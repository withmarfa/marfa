use askama::Template;

use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

/// One of the owner's passkeys as the page shows it.
#[derive(Debug, Clone)]
pub struct OwnerPasskey {
    pub id: String,
    pub name: String,
    pub added: String,
    pub last_used: Option<String>,
    /// The host it was made for, if that is no longer the sign-in address's.
    pub made_for: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OwnerPasskeys {
    pub instance_name: String,
    pub rows: Vec<OwnerPasskey>,
}

#[derive(Template)]
#[template(path = "passkeys.html")]
struct PasskeysBody<'a> {
    rows: &'a [OwnerPasskey],
}

pub fn owner_passkeys(view: &OwnerPasskeys) -> Result<Page> {
    let body = render_body(&PasskeysBody { rows: &view.rows })?;
    document(
        "Password and passkeys",
        &view.instance_name,
        &body,
        Needs {
            connect: true,
            confirm_dialog: true,
        },
    )
}
