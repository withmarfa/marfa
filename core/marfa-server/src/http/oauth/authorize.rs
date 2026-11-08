use std::sync::Arc;

use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use serde_json::json;

use super::{Browser, Fields, problem_answer};
use crate::app::App;
use crate::app::auth::Visit;
use crate::app::instance;
use crate::app::oauth::authorize::{self, Decided, Screen};
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::auth::redirect;
use crate::http::body::JsonBody;
use crate::http::pages::{self, Answering, Consent, Notice};

pub async fn begin(
    State(app): State<Arc<App>>,
    visit: Visit,
    Browser(owner): Browser,
    RawQuery(query): RawQuery,
) -> Answer {
    let query = query.unwrap_or_default();
    match authorize::begin(&app, &query, owner, &visit).await? {
        Ok(location) => redirect(StatusCode::FOUND, &location),
        Err(problem) => problem_answer(&problem),
    }
}

async fn refused_link(app: &App, expired: bool) -> Answer {
    let name = instance::name(app).await?;
    let notice = if expired {
        Notice::expired_request(&name)
    } else {
        Notice::unverified_request(&name)
    };
    Ok(pages::notice(&notice)?.into_response())
}

pub async fn screen(
    State(app): State<Arc<App>>,
    Browser(owner): Browser,
    RawQuery(query): RawQuery,
) -> Answer {
    let query = query.unwrap_or_default();
    match authorize::screen(&app, &query, owner.as_ref()).await? {
        Screen::Unverified => refused_link(&app, false).await,
        Screen::Expired => refused_link(&app, true).await,
        Screen::SignIn(location) => redirect(StatusCode::FOUND, &location),
        Screen::ClientGone => Err(Refusal::new(Code::NotFound, "This app is gone.").into()),
        Screen::Offered(offer) => {
            let view = Consent {
                instance_name: instance::name(&app).await?,
                offer: *offer,
                answering: Answering::Authorization(query),
            };
            Ok(pages::consent(&view)?.into_response())
        }
    }
}

fn asks_for_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("application/json"))
}

pub async fn decide(
    State(app): State<Arc<App>>,
    Browser(owner): Browser,
    headers: HeaderMap,
    body: JsonBody,
) -> Answer {
    let fields = Fields(body.form_pairs().await?);
    let link = fields
        .get("oauth_query")
        .ok_or_else(|| Refusal::validation("Provide `oauth_query` as text."))?;
    let accept = fields.get("accept") == Some("true");
    match authorize::decide(&app, owner.as_ref(), link, accept, fields.post()).await? {
        Decided::Unverified => refused_link(&app, false).await,
        Decided::Expired => refused_link(&app, true).await,
        Decided::SignIn(location) => redirect(StatusCode::FOUND, &location),
        Decided::Answered(url) if asks_for_json(&headers) => {
            Ok(json_answer(StatusCode::OK, &json!({ "url": url })))
        }
        Decided::Answered(location) => redirect(StatusCode::FOUND, &location),
    }
}
