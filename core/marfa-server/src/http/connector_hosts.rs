use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::connector_hosts;

pub async fn create(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    connector_hosts::require_manager(&caller)?;
    let mut body = body.object(&["name"]).await?;
    let made = connector_hosts::create(&app, &caller, body.remove("name")).await?;
    Ok(json_answer(StatusCode::CREATED, &made))
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_hosts::list(&app, &caller).await?,
    ))
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_hosts::get(&app, &caller, id).await?,
    ))
}

pub async fn link(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_hosts::link(&app, &caller, id).await?,
    ))
}

pub async fn remove(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_hosts::remove(&app, &caller, id).await?,
    ))
}

pub async fn redeem(State(app): State<Arc<App>>, visit: Visit, uri: Uri, body: JsonBody) -> Answer {
    query::only(&uri, &[])?;
    connector_hosts::hold_redeem(&app, visit.address)?;
    let mut body = body.object(&["code"]).await?;
    let redeemed = connector_hosts::redeem(&app, body.remove("code")).await?;
    Ok(json_answer(StatusCode::CREATED, &redeemed))
}

pub async fn own(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_hosts::own(&app, &caller).await?,
    ))
}

pub async fn mint(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(plugin): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::CREATED,
        &connector_hosts::mint(&app, &caller, plugin).await?,
    ))
}

pub async fn assign(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(plugin): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    connector_hosts::require_manager(&caller)?;
    let body = body.object(&["host"]).await?;
    let host = match body.get("host") {
        Some(serde_json::Value::String(id)) => Some(id.clone()),
        Some(serde_json::Value::Null) => None,
        _ => {
            return Err(crate::app::refusal::Refusal::validation(
                "host must name a connector host's id, or be null.",
            )
            .into());
        }
    };
    Ok(json_answer(
        StatusCode::OK,
        &connector_hosts::assign(&app, &caller, plugin, host).await?,
    ))
}
