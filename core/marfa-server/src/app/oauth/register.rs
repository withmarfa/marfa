//! `POST /auth/oauth2/register`.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::client::{RegistrationError, parse_registration};
use super::clients::CLIENT_CREATED;
use super::scope::Registries;
use super::store;
use crate::app::App;
use crate::app::audit::{self, Entry};
use crate::app::auth::Visit;
use crate::app::refusal::Result;
use crate::db::Write;

/// Registers a client. What a person's browser sends makes no difference: the
/// door takes no credential, and nothing it reads names one.
pub async fn register(
    app: &Arc<App>,
    body: &[u8],
    visit: &Visit,
) -> Result<std::result::Result<Map<String, Value>, RegistrationError>> {
    let allowed = Registries::of(&app.catalog_handle().load()).allowed();
    let registration = match parse_registration(body, &allowed) {
        Ok(registration) => registration,
        Err(refused) => return Ok(Err(refused)),
    };
    let id = Uuid::now_v7().to_string();
    let now = app.clock.now_ms();
    let at = app.clock.stamp();
    let ip = visit.client_ip();
    let mut answer = registration.to_json();
    answer.insert("client_id".to_string(), Value::from(id.clone()));
    answer.insert(
        "client_id_issued_at".to_string(),
        Value::from(now / super::MS_PER_SECOND),
    );
    app.db
        .write(Write::caller(CLIENT_CREATED), move |tx| {
            store::put_client(tx, &id, &registration, now)?;
            audit::record_from(
                tx,
                &at,
                None,
                ip.as_deref(),
                Entry {
                    action: CLIENT_CREATED,
                    resource_type: "oauth_client",
                    resource_id: Some(&id),
                    details: Some(json!({
                        "client_id": id,
                        "client_name": registration.client_name,
                        "application_type": registration.application_type.word(),
                    })),
                },
            )
        })
        .await?;
    Ok(Ok(answer))
}
