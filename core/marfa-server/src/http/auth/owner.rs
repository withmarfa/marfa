use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};

use super::setup::{admit_claim, make_claim};
use super::{cookies, with_cookie};
use crate::app::App;
use crate::app::auth::Visit;
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;
use crate::http::named_instance;
use crate::http::query;

pub async fn claim(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    body.require_json()?;
    query::only(&uri, &[])?;
    admit_claim(&app, &headers, &visit).await?;
    named_instance::judge(&app, &headers)?;
    let fields = body.open_object().await?;
    let (found, signed_in) = make_claim(&app, &headers, visit, fields, None).await?;
    let mut answer = json_answer(
        StatusCode::CREATED,
        &found.to_json(app.addresses().sign_in().origin()),
    );
    if cookies::holds_setup(&headers) {
        answer = with_cookie(answer, cookies::setup_ended(&app.addresses().sign_in())?);
    }
    for cookie in signed_in {
        answer = with_cookie(answer, cookie);
    }
    Ok(answer)
}
