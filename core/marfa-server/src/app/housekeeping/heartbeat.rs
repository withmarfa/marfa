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
    let mut config = ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_global(Some(TIMEOUT))
        .user_agent(concat!("marfa-server/", env!("CARGO_PKG_VERSION")));
    // A proxy from the environment cannot reach this machine.
    if !marfa_telemetry::host::may_use_proxy(url) {
        config = config.proxy(None);
    }
    let agent: ureq::Agent = config.build().into();
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

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::request;

    /// Answers each connection it takes with `200` and counts it.
    fn listen(counted: Arc<AtomicUsize>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                counted.fetch_add(1, Ordering::SeqCst);
                let mut head = [0u8; 1024];
                let _ = stream.read(&mut head);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        port
    }

    #[test]
    fn a_receiver_on_this_machine_is_reached_directly_and_one_elsewhere_through_the_environment_proxy()
     {
        let through_proxy = Arc::new(AtomicUsize::new(0));
        let proxy = listen(through_proxy.clone());
        let received = Arc::new(AtomicUsize::new(0));
        let receiver = listen(received.clone());
        let named = format!("http://127.0.0.1:{proxy}");
        // Nextest runs each test in a process of its own.
        unsafe {
            std::env::set_var("HTTP_PROXY", &named);
            std::env::set_var("http_proxy", &named);
            std::env::remove_var("NO_PROXY");
            std::env::remove_var("no_proxy");
        }

        assert_eq!(request(&format!("http://127.0.0.1:{receiver}/")), Some(200));
        assert_eq!(received.load(Ordering::SeqCst), 1);
        assert_eq!(through_proxy.load(Ordering::SeqCst), 0);

        // This proxy only counts what it is asked, so it gives no answer to pass on.
        let _ = request("http://heartbeat.example.test/");
        assert_eq!(through_proxy.load(Ordering::SeqCst), 1);
        assert_eq!(received.load(Ordering::SeqCst), 1);
    }
}
