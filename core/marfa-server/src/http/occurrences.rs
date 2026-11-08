//! `GET /occurrences`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use marfa_rules::query::{declared_type, type_entries};
use marfa_rules::time;

use super::answer::{Answer, text_answer};
use super::items::invalid_field;
use super::listing::Params;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::occurrences::{self, MAX_WINDOW_DAYS, Window};
use crate::app::refusal::{Code, Refusal, Result};

fn bound(params: &Params, name: &str) -> Result<i64> {
    let value = params.one(name)?.ok_or_else(|| {
        Refusal::new(Code::MissingRequiredField, format!("{name} is required."))
            .with_detail("field", name)
    })?;
    time::epoch_ms(value).ok_or_else(|| invalid_field(name, format!("{name} is not a timestamp.")))
}

fn type_of(params: &Params) -> Result<Option<String>> {
    let Some(sent) = params.one("type")? else {
        return Ok(None);
    };
    let refused = |error: marfa_rules::error::RuleError| invalid_field("type", error.message);
    let sent = [sent.to_string()];
    let entries = type_entries(&sent).map_err(refused)?;
    let [only] = entries.as_slice() else {
        return Err(invalid_field("type", "type names one type."));
    };
    Ok(declared_type(Some(only))
        .map_err(refused)?
        .map(str::to_string))
}

fn window_of(params: &Params) -> Result<Window> {
    let from = bound(params, "from")?;
    let to = bound(params, "to")?;
    if to <= from {
        return Err(
            Refusal::validation("The window's end must be after its start")
                .with_detail("field", "to"),
        );
    }
    if to - from > MAX_WINDOW_DAYS * 86_400_000 {
        return Err(Refusal::validation(format!(
            "The window may span at most {MAX_WINDOW_DAYS} days"
        ))
        .with_detail("max_days", MAX_WINDOW_DAYS));
    }
    Ok(Window {
        from,
        to,
        type_filter: type_of(params)?,
    })
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    let params = Params::read(&uri, &["from", "to", "type"], false)?;
    let window = window_of(&params)?;
    let body = occurrences::read(&app, &caller, window).await?;
    Ok(text_answer(StatusCode::OK, body))
}
