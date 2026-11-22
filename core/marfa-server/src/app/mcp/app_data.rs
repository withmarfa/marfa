//! A confirmation binds removing a vendor's data to the types and item versions its preview
//! showed, and the removal runs in the write that spends it.

use std::sync::Arc;

use super::confirm::{self, Bound};
use super::connector::{self, Confirmed};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::vendor_data::{self, Held};

pub const TOOL: &str = "marfa_app_data";
const REMOVED: &str = "app_data.delete";

fn target(vendor: &str) -> String {
    confirm::ids_digest(&[format!("vendor {vendor}")])
}

pub fn token(app: &App, caller: &Caller, held: &Held) -> Result<confirm::Token> {
    connector::issue(app, caller, TOOL, &target(&held.vendor), &held.digest)
}

/// Removes one page of the vendor's data once the token holds for what it holds now; answers
/// how many items went.
pub async fn remove_confirmed(
    app: &Arc<App>,
    caller: &Caller,
    vendor: String,
    bound: Bound,
) -> Result<Confirmed> {
    let cache = app.catalog_handle();
    let reading = vendor.clone();
    let confirmed = connector::confirmed(
        app,
        caller,
        (TOOL, REMOVED, target(&vendor)),
        bound,
        move |unit| {
            let holder = match unit.caller.require_vendor_data(unit.tx(), &reading, true) {
                Ok(holder) => holder,
                Err(Refusal {
                    code: Code::NotFound,
                    ..
                }) => return Ok(None),
                Err(refused) => return Err(refused),
            };
            Ok(Some(vendor_data::held(unit.tx(), &reading, &holder)?.digest))
        },
        move |unit| {
            let removal = vendor_data::remove_in(unit, &cache, &vendor)?;
            Ok(i64::try_from(removal.items).unwrap_or(i64::MAX))
        },
    )
    .await?;
    if matches!(confirmed, Confirmed::Done { .. }) {
        app.publish_catalog().await;
    }
    Ok(confirmed)
}
