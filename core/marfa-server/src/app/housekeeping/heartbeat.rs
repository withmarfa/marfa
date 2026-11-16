//! A request to `heartbeat_url`, so that something else can notice when the requests stop.
//! A receiver that does not answer is a heartbeat that says so, not a failed run.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::oneshot;

use super::super::App;
use super::super::refusal::{Refusal, Result};
use super::{Report, Run};
use crate::app::outbound;
use crate::settings::registry::{ALLOW_PRIVATE_ADDRESSES, HEARTBEAT_ENABLED, HEARTBEAT_URL};

const TIMEOUT: Duration = Duration::from_secs(10);

pub fn configured(app: &App) -> bool {
    app.settings.live().get(HEARTBEAT_URL).is_some()
}

fn request(url: &str, private_allowed: bool) -> Option<u16> {
    outbound::notice_agent(url, TIMEOUT, TIMEOUT, private_allowed)?
        .get(url)
        .call()
        .ok()
        .map(|response| response.status().as_u16())
}

/// The request runs on a thread of its own: it blocks, and a stop must be able
/// to leave it behind, which the runtime's blocking pool would wait for.
pub async fn beat(app: Arc<App>, run: Run) -> Result<Report> {
    let live = app.settings.live();
    let url = live.get(HEARTBEAT_URL).map(|url| url.expose().to_string());
    let private_allowed = live.get(ALLOW_PRIVATE_ADDRESSES);
    let Some(url) = url.filter(|_| live.get(HEARTBEAT_ENABLED)) else {
        return Ok(Report::done(json!({ "skipped": true })));
    };
    let (answer, answered) = oneshot::channel();
    std::thread::Builder::new()
        .name("marfa-heartbeat".to_string())
        .spawn(move || {
            let _ = answer.send(request(&url, private_allowed));
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
    fn while_private_addresses_are_refused_a_receiver_on_this_machine_hears_nothing() {
        let received = Arc::new(AtomicUsize::new(0));
        let receiver = listen(received.clone());

        assert_eq!(
            request(&format!("http://127.0.0.1:{receiver}/"), false),
            None
        );
        assert_eq!(
            request(&format!("http://localhost:{receiver}/"), false),
            None
        );
        assert_eq!(received.load(Ordering::SeqCst), 0);
        assert_eq!(
            request(&format!("http://localhost:{receiver}/"), true),
            Some(200)
        );
        assert_eq!(received.load(Ordering::SeqCst), 1);
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

        assert_eq!(
            request(&format!("http://127.0.0.1:{receiver}/"), true),
            Some(200)
        );
        assert_eq!(received.load(Ordering::SeqCst), 1);
        assert_eq!(through_proxy.load(Ordering::SeqCst), 0);

        // This proxy only counts what it is asked, so it gives no answer to pass on.
        let _ = request("http://heartbeat.example.test/", true);
        assert_eq!(through_proxy.load(Ordering::SeqCst), 1);
        assert_eq!(received.load(Ordering::SeqCst), 1);
    }
}
