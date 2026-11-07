//! The private local command's doors, served on the control socket alone.

use argon2::Argon2;
use argon2::password_hash::PasswordHasher;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use rusqlite::TransactionBehavior;
use serde_json::{Value, json};

use crate::app::App;
use crate::body::JsonBody;
use crate::clock;
use crate::error::{ApiError, ApiResult};
use crate::storage::{instance, owner};
use crate::write::audit;

/// The sign-in provider's bounds on a password, in characters.
const PASSWORD_LENGTH: std::ops::RangeInclusive<usize> = 8..=128;

pub fn router() -> Router<App> {
    Router::new()
        .route("/_control/setup/status", get(status))
        .route("/_control/setup/claim", post(claim))
}

async fn status(State(app): State<App>) -> ApiResult<impl IntoResponse> {
    let answer = app
        .db
        .write(|conn| {
            Ok(match owner::get(conn)? {
                Some(owner) => json!({ "claimed": true, "owner_id": owner.id, "generation": null }),
                None => {
                    let generation = match instance::get(conn, "setup_generation")? {
                        Some(generation) => generation,
                        None => {
                            let generation = uuid::Uuid::now_v7().to_string();
                            instance::set(conn, "setup_generation", &generation)?;
                            generation
                        }
                    };
                    json!({ "claimed": false, "owner_id": null, "generation": generation })
                }
            })
        })
        .await?;
    Ok(axum::Json(answer))
}

async fn claim(State(app): State<App>, body: JsonBody) -> ApiResult<impl IntoResponse> {
    let body = body.object(&["email", "password", "name"]).await?;
    let email = match body.get("email") {
        Some(Value::String(email)) if valid_email(email.trim()) => email.trim().to_lowercase(),
        _ => return Err(ApiError::validation("email: Must be an email address.")),
    };
    let password = match body.get("password") {
        Some(Value::String(password)) if PASSWORD_LENGTH.contains(&password.chars().count()) => {
            password.clone()
        }
        _ => {
            return Err(ApiError::validation(format!(
                "password: Must be {} to {} characters.",
                PASSWORD_LENGTH.start(),
                PASSWORD_LENGTH.end()
            )));
        }
    };
    let name = match body.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) if !name.trim().is_empty() => Some(name.trim().to_string()),
        Some(_) => return Err(ApiError::validation("name: Must be text.")),
    };
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|hash| hash.to_string())
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(ApiError::internal)?;

    let created = app
        .db
        .write(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if owner::get(&tx)?.is_some() {
                return Err(ApiError::conflict(
                    "owner_exists",
                    "This instance already has an owner.",
                ));
            }
            let created = owner::Owner {
                id: uuid::Uuid::now_v7().to_string(),
                email,
                name,
                created_at: clock::now_stamp(),
            };
            owner::insert(&tx, &created, &hash)?;
            tx.execute("DELETE FROM settings WHERE key = 'setup_generation'", [])?;
            audit(&tx, "owner.claim", "local", "owner", &created.id, json!({}))?;
            tx.commit()?;
            Ok(created)
        })
        .await?;
    Ok((StatusCode::CREATED, axum::Json(created)))
}

fn valid_email(email: &str) -> bool {
    match email.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !email.chars().any(char::is_whitespace)
        }
        None => false,
    }
}
