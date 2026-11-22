use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::pages::{self, Notice};
use super::query;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::connector_sign_in::{self, Finished};
use crate::app::refusal::Refusal;
use crate::app::{App, instance};

pub async fn start(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    connector_sign_in::require_manager(&caller)?;
    let body = body.object(&["return_to"]).await?;
    let return_to = connector_sign_in::judged_return_to(&app, &caller, body)?;
    Ok(json_answer(
        StatusCode::CREATED,
        &connector_sign_in::start(&app, &caller, name, return_to).await?,
    ))
}

pub async fn status(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_sign_in::status(&app, &caller, name).await?,
    ))
}

/// A provider adds parameters of its own, so the query is read, never judged.
pub async fn callback(State(app): State<Arc<App>>, visit: Visit, uri: Uri) -> Answer {
    connector_sign_in::hold_callback(&app, visit.address)?;
    let pairs = query::pairs(&uri)?;
    let first = |name: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    let finished =
        connector_sign_in::callback(&app, first("state"), first("code"), first("error")).await?;
    let name = instance::name(&app).await?;
    let mut response = match finished {
        Finished::Back(location) => {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::SEE_OTHER;
            response.headers_mut().insert(
                header::LOCATION,
                HeaderValue::from_str(&location)
                    .map_err(|_| Refusal::internal("a sign-in's return_to did not form"))?,
            );
            response
        }
        Finished::SignedIn => pages::notice(&Notice::connector_signed_in(&name))?.into_response(),
        Finished::NotFinished => {
            pages::notice(&Notice::connector_sign_in_unfinished(&name, None))?.into_response()
        }
        Finished::Ended(failure) => {
            pages::notice(&Notice::connector_sign_in_unfinished(&name, Some(&failure)))?
                .into_response()
        }
        Finished::ProviderFailed(failure) => {
            pages::notice(&Notice::connector_sign_in_failed(&name, &failure))?.into_response()
        }
    };
    // The address holds the code the provider sent.
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
