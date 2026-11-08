//! A request to `MARFA_HEARTBEAT_URL`, so that something else can notice when the requests stop.
//! A receiver that does not answer is a heartbeat that says so, not a failed run.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::oneshot;

use super::super::App;
use super::super::refusal::{Refusal, Result};
use super::{Report, Run};
use crate::settings::registry::HEARTBEAT_ENABLED;

const TIMEOUT: Duration = Duration::from_secs(10);

pub fn configured(app: &App) -> bool {
    app.settings.start.heartbeat_url.is_some()
}

fn request(url: &str) -> Option<u16> {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_global(Some(TIMEOUT))
        .user_agent(concat!("marfa-server/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    agent
        .get(url)
        .call()
        .ok()
        .map(|response| response.status().as_u16())
}

/// The request runs on a thread of its own: it blocks, and a stop must be able
/// to leave it behind, which the runtime's blocking pool would wait for.
pub async fn beat(app: Arc<App>, run: Run) -> Result<Report> {
    let url = app.settings.start.heartbeat_url.clone();
    let Some(url) = url.filter(|_| app.settings.live().get(HEARTBEAT_ENABLED)) else {
        return Ok(Report::done(json!({ "skipped": true })));
    };
    let (answer, answered) = oneshot::channel();
    std::thread::Builder::new()
        .name("marfa-heartbeat".to_string())
        .spawn(move || {
            let _ = answer.send(request(&url));
        })
        .map_err(|_| Refusal::internal("the heartbeat's thread did not start"))?;
    let status = tokio::select! {
        status = answered => status.ok().flatten(),
        () = run.stopped() => None,
    };
    let ok = status.is_some_and(|status| (200..300).contains(&status));
    Ok(Report::done(json!({ "ok": ok, "status": status })))
}
