//! A confirmation binds removing a vendor's data to what its preview showed.

use std::sync::Arc;

use super::confirm::{self, Bound};
use super::connector::{self, Confirmed};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::vendor_data::{self, Held, Removal};

pub const TOOL: &str = "marfa_app_data";
const REMOVED: &str = "app_data.delete";

/// What a repeated confirmation answers: the items it removed, and those left if still listable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Repeat {
    pub items: i64,
    pub remaining: Option<usize>,
}

fn target(vendor: &str) -> String {
    confirm::ids_digest(&[format!("vendor {vendor}")])
}

pub fn token(app: &App, caller: &Caller, held: &Held) -> Result<confirm::Token> {
    connector::issue(app, caller, TOOL, &target(&held.vendor), &held.digest)
}

/// Removes one page of the vendor's data while the token holds, answering what the write did.
pub async fn remove_confirmed(
    app: &Arc<App>,
    caller: &Caller,
    vendor: String,
    bound: Bound,
) -> Result<Confirmed<Removal, Repeat>> {
    let cache = app.catalog_handle();
    let (reading, repeating) = (vendor.clone(), vendor.clone());
    let confirmed = connector::confirmed_as(
        app,
        caller,
        (TOOL, REMOVED, target(&vendor)),
        bound,
        move |unit| match vendor_data::held(unit.tx(), &unit.caller, &reading) {
            Ok(held) => Ok(Some(held.digest)),
            Err(Refusal {
                code: Code::NotFound,
                ..
            }) => Ok(None),
            Err(refused) => Err(refused),
        },
        move |unit| {
            let removal = vendor_data::remove_in(unit, &cache, &vendor)?;
            Ok((i64::try_from(removal.items).unwrap_or(i64::MAX), removal))
        },
        move |unit, items| {
            Ok(Repeat {
                items,
                remaining: vendor_data::remaining_for(unit.tx(), &unit.caller, &repeating)?,
            })
        },
    )
    .await?;
    if matches!(confirmed, Confirmed::Done { total } if total.types > 0) {
        app.publish_catalog().await;
    }
    Ok(confirmed)
}
