use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::mapping;
use crate::app::plugins::{self, Outcome};

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let data = plugins::list(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &plugins::get(&app, &caller, name).await?,
    ))
}

pub async fn install(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let (bundle, bytes) = body.open_object_and_bytes().await?;
    let fingerprint = hex::encode(Sha256::digest(&bytes));
    let (outcome, mut installed) = plugins::install(&app, &caller, bundle, fingerprint).await?;
    installed["outcome"] = json!(outcome.word());
    let status = match outcome {
        Outcome::Installed => StatusCode::CREATED,
        Outcome::Updated | Outcome::Unchanged => StatusCode::OK,
    };
    Ok(json_answer(status, &installed))
}

pub async fn remove(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &plugins::remove(&app, &caller, name).await?,
    ))
}

pub async fn mapping(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &mapping::read(&app, &caller, name).await?,
    ))
}

pub async fn save_mapping(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let body = Value::Object(body.open_object().await?);
    Ok(json_answer(
        StatusCode::OK,
        &mapping::save(&app, &caller, name, body).await?,
    ))
}

pub async fn rewrite(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let body = Value::Object(body.open_object().await?);
    Ok(json_answer(
        StatusCode::OK,
        &mapping::rewrite(&app, &caller, name, body).await?,
    ))
}

pub async fn rewrite_done(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let body = Value::Object(body.open_object().await?);
    Ok(json_answer(
        StatusCode::OK,
        &mapping::rewrite_done(&app, &caller, name, body).await?,
    ))
}
