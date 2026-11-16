//! Asks a new sign-in address, at a fixed path and following no redirect, whether it answers as this instance.

use std::io::Read;
use std::net::SocketAddr;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Semaphore;
use ureq::Agent;
use ureq::http::header;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::transport::DefaultConnector;
use url::Url;

use super::App;
use super::addresses::Address;
use super::outbound::{self, Asker, Pinned, Reach};
use super::refusal::{Code, Refusal};
use crate::settings::registry::ALLOW_PRIVATE_ADDRESSES;

const TIME: Duration = Duration::from_secs(5);
const MOST_ADDRESSES: usize = 16;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: u64 = 64 * 1024;

static IN_FLIGHT: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failed {
    Unreachable,
    TimedOut,
    NotThisInstance,
}

impl Failed {
    fn word(self) -> &'static str {
        match self {
            Failed::Unreachable => "unreachable",
            Failed::TimedOut => "timed_out",
            Failed::NotThisInstance => "not_this_instance",
        }
    }

    pub fn refusal(self) -> Refusal {
        let message = match self {
            Failed::Unreachable => {
                "Nothing answered at the new sign-in address, so it was not changed."
            }
            Failed::TimedOut => {
                "The new sign-in address did not answer in time, so it was not changed."
            }
            Failed::NotThisInstance => {
                "The new sign-in address did not answer as this instance, so it was not changed."
            }
        };
        Refusal::new(Code::SignInAddressCheckFailed, message).with_detail("reason", self.word())
    }
}

/// The address check's own answer.
pub fn to_json(checked: Result<(), Failed>) -> Value {
    match checked {
        Ok(()) => json!({ "passed": true }),
        Err(failed) => json!({ "passed": false, "reason": failed.word() }),
    }
}

/// Without `allow_private_addresses`, an address that is not public tells only whether this
/// instance answered.
pub async fn check(app: &App, address: &Address) -> Result<(), Failed> {
    let Ok(url) = Url::parse(address.origin()).and_then(|origin| origin.join("/")) else {
        return Err(Failed::Unreachable);
    };
    let Some(port) = url.port_or_known_default() else {
        return Err(Failed::Unreachable);
    };
    let Ok(_held) = IN_FLIGHT.acquire().await else {
        return Err(Failed::Unreachable);
    };
    let targets = match outbound::reach(&app.faults, &url, true, Asker::SignInAddress).await {
        Reach::Targets(targets) => targets,
        Reach::Unresolved | Reach::NoSlot | Reach::NotPublic => return Err(Failed::Unreachable),
    };
    let private = targets
        .iter()
        .any(|target| !outbound::address::is_public(target.checked));
    let told = !private || app.settings.live().get(ALLOW_PRIVATE_ADDRESSES);
    let pinned: Vec<SocketAddr> = targets
        .into_iter()
        .take(MOST_ADDRESSES)
        .map(|target| SocketAddr::new(target.connected, port))
        .collect();
    let instance_id = app.instance_id.clone();
    let asked = tokio::task::spawn_blocking(move || ask(&url, pinned, &instance_id));
    let answered = match tokio::time::timeout(TIME + Duration::from_secs(1), asked).await {
        Ok(Ok(answered)) => answered,
        Ok(Err(_)) => Err(Failed::Unreachable),
        Err(_) => Err(Failed::TimedOut),
    };
    answered.map_err(|failed| {
        if told {
            failed
        } else {
            Failed::NotThisInstance
        }
    })
}

fn ask(url: &Url, pinned: Vec<SocketAddr>, instance_id: &str) -> Result<(), Failed> {
    let tls = TlsConfig::builder()
        .root_certs(RootCerts::PlatformVerifier)
        .build();
    let config = Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(TIME))
        .max_response_header_size(MAX_HEADER_BYTES)
        .tls_config(tls)
        .user_agent("marfa-server")
        .build();
    let agent = Agent::with_parts(config, DefaultConnector::default(), Pinned(pinned));
    let mut response = agent
        .get(url.as_str())
        .header(header::ACCEPT, "application/json")
        .header(header::ACCEPT_ENCODING, "identity")
        .call()
        .map_err(|error| match error {
            ureq::Error::Timeout(_) => Failed::TimedOut,
            _ => Failed::Unreachable,
        })?;
    if response.status().as_u16() != 200 {
        return Err(Failed::NotThisInstance);
    }
    let mut body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_BODY_BYTES)
        .read_to_end(&mut body)
        .map_err(|_| Failed::NotThisInstance)?;
    let answered = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|root| root.get("instance_id")?.as_str().map(str::to_string));
    if answered.as_deref() == Some(instance_id) {
        Ok(())
    } else {
        Err(Failed::NotThisInstance)
    }
}
