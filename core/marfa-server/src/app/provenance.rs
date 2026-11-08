//! Where a request came from, carried to the audit entries its writes make.

use std::future::Future;

use serde_json::{Map, Value};

#[derive(Clone, Debug, Default)]
pub struct Origin {
    pub client_ip: Option<String>,
    pub via: Option<&'static str>,
}

tokio::task_local! {
    static ORIGIN: Origin;
}

pub fn current() -> Origin {
    ORIGIN.try_with(Clone::clone).unwrap_or_default()
}

pub async fn within<F: Future>(origin: Origin, work: F) -> F::Output {
    ORIGIN.scope(origin, work).await
}

pub async fn through<F: Future>(via: &'static str, work: F) -> F::Output {
    let origin = Origin {
        via: Some(via),
        ..current()
    };
    within(origin, work).await
}

impl Origin {
    pub fn mark(&self, details: Option<Value>) -> Option<Value> {
        let Some(via) = self.via else {
            return details;
        };
        let mut object = match details {
            None => Map::new(),
            Some(Value::Object(object)) => object,
            other => return other,
        };
        object.insert("via".into(), Value::String(via.into()));
        Some(Value::Object(object))
    }
}
