//! Client ID metadata documents; the URL is untrusted input.

use crate::app::faults::Faults;
use crate::app::outbound::address::is_public;
use crate::app::outbound::{self, Pinned, Reach};
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::runtime::Handle;
use ureq::Agent;
use ureq::http::header;
use ureq::tls::TlsConfig;
use ureq::unversioned::transport::DefaultConnector;
use url::{Host, Url};

use super::client::{self, Registration, RegistrationError, Source};
use super::redirect;

/// The draft's recommended limit.
const MAX_DOCUMENT_BYTES: u64 = 5 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

const MOST_ADDRESSES: usize = 16;
const TIME_LIMIT: Duration = Duration::from_secs(5);

const SYMMETRIC_METHODS: [&str; 3] = [
    "client_secret_post",
    "client_secret_basic",
    "client_secret_jwt",
];

/// A client already stored keeps working through `Unavailable`, and neither is ever cached.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum Failure {
    #[error("{0}")]
    Refused(&'static str),
    #[error("{0}")]
    Unavailable(&'static str),
}

/// Only routes a request: [`check_url`] is what accepts one.
pub fn is_url(client_id: &str) -> bool {
    client_id
        .get(..6)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https:"))
}

/// The text must be the URL's one spelling, so what is checked is what is fetched.
pub fn check_url(client_id: &str) -> Result<Url, Failure> {
    let refused = |why| Err(Failure::Refused(why));
    if !redirect::is_plain(client_id) {
        return refused("The client ID is not a valid URL.");
    }
    let Ok(url) = Url::parse(client_id) else {
        return refused("The client ID is not a valid URL.");
    };
    if url.scheme() != "https" {
        return refused("A client ID URL must use https.");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return refused("A client ID URL must not carry credentials.");
    }
    if client_id.contains('#') {
        return refused("A client ID URL must not carry a fragment.");
    }
    if url.as_str() != client_id {
        return refused("A client ID URL must be in its normal form.");
    }
    if url.path() == "/" {
        return refused("A client ID URL must have a path.");
    }
    if !host_may_be_public(&url) {
        return refused("A client ID URL must name a public host.");
    }
    Ok(url)
}

/// An early look at the name; the address check on what it resolves to is the guard.
fn host_may_be_public(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(v4)) => is_public(IpAddr::V4(v4)),
        Some(Host::Ipv6(v6)) => is_public(IpAddr::V6(v6)),
        Some(Host::Domain(name)) => {
            let reserved = [".localhost", ".local", ".internal"]
                .iter()
                .any(|suffix| name.ends_with(suffix));
            name.contains('.')
                && !name.ends_with('.')
                && !reserved
                && !name.eq_ignore_ascii_case("metadata.goog")
        }
        None => false,
    }
}

#[test]
fn metadata_uses_the_shared_public_address_policy() {
    for address in ["64:ff9b::808:808", "::8.8.8.8", "2001:1::1", "192.0.0.9"] {
        let address: IpAddr = address.parse().unwrap();
        let authority = match address {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        assert_eq!(
            check_url(&format!("https://{authority}/client.json")).is_ok(),
            crate::app::outbound::address::is_public(address),
            "{address}"
        );
    }
}

pub struct Fetcher {
    faults: Arc<Faults>,
    runtime: Handle,
    tls: TlsConfig,
    limit: Duration,
}

impl Fetcher {
    /// Built inside the runtime; [`Fetcher::fetch`] runs on a blocking thread of it.
    pub fn new(faults: Arc<Faults>) -> Fetcher {
        Fetcher {
            faults,
            runtime: Handle::current(),
            tls: TlsConfig::default(),
            limit: TIME_LIMIT,
        }
    }

    pub fn fetch(&self, client_id: &str) -> Result<Vec<u8>, Failure> {
        let url = check_url(client_id)?;
        let addresses = self.checked_addresses(&url)?;
        let config = Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(self.limit))
            .max_response_header_size(MAX_HEADER_BYTES)
            .tls_config(self.tls.clone())
            .user_agent("marfa-server")
            .build();
        let agent = Agent::with_parts(config, DefaultConnector::default(), Pinned(addresses));
        let mut response = agent
            .get(url.as_str())
            .header(header::ACCEPT, "application/json")
            .header(header::ACCEPT_ENCODING, "identity")
            .call()
            .map_err(failed_transport)?;
        let status = response.status().as_u16();
        match status {
            200 => {}
            408 | 429 | 500..=599 => {
                return Err(Failure::Unavailable(
                    "The client's metadata document could not be fetched just now.",
                ));
            }
            _ => {
                return Err(Failure::Refused(
                    "The client's metadata document did not answer 200.",
                ));
            }
        }
        let media_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !is_json_media_type(media_type) {
            return Err(Failure::Refused(
                "The client's metadata document is not JSON.",
            ));
        }
        // ureq's limit counts bytes before decompression and hides that it has, so the limit goes on
        // the output.
        let mut document = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut document)
            .map_err(|_| {
                Failure::Unavailable("The client's metadata document could not be read.")
            })?;
        if document.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(Failure::Refused(
                "The client's metadata document is too large.",
            ));
        }
        Ok(document)
    }

    /// Resolved once by the outbound path, which judges every answer: a name that also answers an
    /// internal address is not trusted for the sake of its public one.
    fn checked_addresses(&self, url: &Url) -> Result<Vec<SocketAddr>, Failure> {
        let port = url.port_or_known_default().ok_or(Failure::Unavailable(
            "The client's host could not be resolved.",
        ))?;
        match self
            .runtime
            .block_on(outbound::reach(&self.faults, url, false))
        {
            Reach::Targets(targets) => Ok(targets
                .into_iter()
                .take(MOST_ADDRESSES)
                .map(|target| SocketAddr::new(target.connected, port))
                .collect()),
            Reach::Unresolved => Err(Failure::Unavailable(
                "The client's host could not be resolved.",
            )),
            Reach::NotPublic => Err(Failure::Refused(
                "The client's host resolves to an address that is not public.",
            )),
        }
    }
}

fn failed_transport(error: ureq::Error) -> Failure {
    match error {
        ureq::Error::Http(_) | ureq::Error::BadUri(_) | ureq::Error::RequireHttpsOnly(_) => {
            Failure::Refused("The client ID is not a URL this server can fetch.")
        }
        _ => Failure::Unavailable("The client's metadata document could not be fetched."),
    }
}

/// `application/json` or the `+json` of any `application/` type, parameters allowed.
fn is_json_media_type(value: &str) -> bool {
    let essence = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence == "application/json"
        || essence
            .strip_prefix("application/")
            .and_then(|subtype| subtype.strip_suffix("+json"))
            .is_some_and(|name| !name.is_empty())
}

/// Every error here is `invalid_client` to whoever asked; the description is only for the log.
pub fn parse_document(client_id: &str, body: &[u8]) -> Result<Registration, RegistrationError> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| RegistrationError::metadata("The document is not valid JSON."))?;
    let object = value
        .as_object()
        .ok_or_else(|| RegistrationError::metadata("The document must be a JSON object."))?;
    if object.get("client_id").and_then(Value::as_str) != Some(client_id) {
        return Err(RegistrationError::metadata(
            "The document's client_id must be the URL it was fetched from.",
        ));
    }
    for secret in ["client_secret", "client_secret_expires_at"] {
        if object.contains_key(secret) {
            return Err(RegistrationError::metadata(format!(
                "A metadata document must not hold {secret}."
            )));
        }
    }
    if object.contains_key("jwks") && object.contains_key("jwks_uri") {
        return Err(RegistrationError::metadata(
            "A metadata document must not hold both jwks and jwks_uri.",
        ));
    }
    let supported = client::texts(object, "token_endpoint_auth_methods_supported")?;
    if let Some(method) = supported
        .iter()
        .flatten()
        .find(|method| SYMMETRIC_METHODS.contains(method))
    {
        return Err(RegistrationError::metadata(format!(
            "A metadata document must not offer {method}."
        )));
    }
    let stated = client::text(object, "token_endpoint_auth_method")?;
    let registration = match supported {
        None => client::read(object, Source::Document)?,
        Some(methods) => {
            if let Some(method) = stated
                && !methods.contains(&method)
            {
                return Err(RegistrationError::metadata(
                    "token_endpoint_auth_method must be among token_endpoint_auth_methods_supported.",
                ));
            }
            // The list is authoritative; the singular is only a preference (MCP SEP-3149).
            if !methods.contains(&"none") {
                return Err(RegistrationError::metadata(
                    "token_endpoint_auth_methods_supported must include none.",
                ));
            }
            let mut public = object.clone();
            public.remove("token_endpoint_auth_method");
            client::read(&public, Source::Document)?
        }
    };
    if registration
        .client_name
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        return Err(RegistrationError::metadata(
            "A metadata document must name its client.",
        ));
    }
    if registration.redirect_uris.is_empty() {
        return Err(RegistrationError::metadata(
            "A metadata document must list its redirect URIs.",
        ));
    }
    Ok(registration)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, LazyLock};

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use proptest::prelude::*;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use serde_json::json;
    use ureq::tls::{Certificate, RootCerts};

    use super::super::client::{AuthMethod, GrantType, ResponseType};
    use super::super::redirect::AppKind;
    use super::*;

    const ID: &str = "https://metadata.example.com/client.json";
    const NAME: &str = "metadata.example.com";

    struct Listener {
        address: SocketAddr,
        accepted: Arc<AtomicUsize>,
        certificate: Vec<u8>,
    }

    fn listen(cert_name: &str, response: Vec<u8>) -> Listener {
        let certified =
            rcgen::generate_simple_self_signed(vec![cert_name.to_string()]).expect("a certificate");
        let certificate = certified.cert.der().to_vec();
        let key = PrivateKeyDer::try_from(certified.signing_key.serialize_der()).expect("a key");
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(certificate.clone())], key)
        .expect("a server config");
        let config = Arc::new(config);
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let address = listener.local_addr().expect("an address");
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                counter.fetch_add(1, Ordering::SeqCst);
                let config = config.clone();
                let response = response.clone();
                std::thread::spawn(move || answer(stream, config, &response));
            }
        });
        Listener {
            address,
            accepted,
            certificate,
        }
    }

    fn answer(stream: TcpStream, config: Arc<rustls::ServerConfig>, response: &[u8]) {
        let Ok(connection) = rustls::ServerConnection::new(config) else {
            return;
        };
        let mut tls = rustls::StreamOwned::new(connection, stream);
        let mut seen = Vec::new();
        let mut buffer = [0u8; 1024];
        while !seen.windows(4).any(|window| window == b"\r\n\r\n") {
            match tls.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(count) => seen.extend_from_slice(&buffer[..count]),
            }
        }
        let _ = tls.write_all(response);
        let _ = tls.flush();
        tls.conn.send_close_notify();
        let _ = tls.conn.complete_io(&mut tls.sock);
        let _ = tls.sock.shutdown(Shutdown::Both);
    }

    fn reply(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a runtime")
    });

    /// The guard judges the first address of each entry and the connection goes to the second.
    fn scripted(lookups: &str) -> Arc<Faults> {
        let faults = Arc::new(Faults::default());
        faults
            .set(&format!("resolve:{NAME}"), Some(lookups))
            .expect("a resolve fault");
        faults
    }

    fn fetcher(faults: Arc<Faults>, trusted: &[u8]) -> Fetcher {
        Fetcher {
            faults,
            runtime: RUNTIME.handle().clone(),
            tls: TlsConfig::builder()
                .root_certs(RootCerts::new_with_certs(&[
                    Certificate::from_der(trusted).to_owned()
                ]))
                .build(),
            limit: TIME_LIMIT,
        }
    }

    fn id_at(listener: &Listener) -> String {
        format!("https://{NAME}:{}/client.json", listener.address.port())
    }

    fn get(listener: &Listener) -> Result<Vec<u8>, Failure> {
        let faults = scripted("8.8.8.8>127.0.0.1");
        fetcher(faults, &listener.certificate).fetch(&id_at(listener))
    }

    fn document() -> Value {
        json!({
            "client_id": ID,
            "client_name": "An app",
            "redirect_uris": ["https://app.example/callback"],
        })
    }

    fn with(mut base: Value, name: &str, value: Value) -> Value {
        base[name] = value;
        base
    }

    fn parse(body: &Value) -> Result<Registration, RegistrationError> {
        parse_document(ID, body.to_string().as_bytes())
    }

    #[test]
    fn a_rebinding_name_cannot_turn_the_connection_inward() {
        let public = listen(NAME, reply("200 OK", "application/json", b"public"));
        let faults = scripted("8.8.8.8>127.0.0.1;10.0.0.1>127.0.0.1");
        let fetcher = fetcher(faults.clone(), &public.certificate);
        let id = id_at(&public);

        assert_eq!(fetcher.fetch(&id).expect("a document"), b"public");
        assert_eq!(faults.list()[0].fired, 1);
        assert_eq!(public.accepted.load(Ordering::SeqCst), 1);

        assert!(matches!(fetcher.fetch(&id), Err(Failure::Refused(_))));
        assert_eq!(faults.list()[0].fired, 2);
        assert_eq!(public.accepted.load(Ordering::SeqCst), 1);
    }

    /// Entries that are judged public and connect to a port nothing listens on.
    fn unreachable_answers(count: usize) -> String {
        vec!["8.8.8.8>::1"; count].join(",")
    }

    #[test]
    fn every_checked_address_is_tried_until_one_answers() {
        let live = listen(NAME, reply("200 OK", "application/json", b"{}"));
        let lookups = format!("{},8.8.4.4>127.0.0.1", unreachable_answers(2));
        let fetcher = fetcher(scripted(&lookups), &live.certificate);
        assert_eq!(fetcher.fetch(&id_at(&live)).expect("a document"), b"{}");
        assert_eq!(live.accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn more_answers_than_can_be_tried_are_all_judged_and_only_sixteen_used() {
        let live = listen(NAME, reply("200 OK", "application/json", b"{}"));
        let lookups = format!("{},8.8.4.4>127.0.0.1", unreachable_answers(16));
        assert!(matches!(
            fetcher(scripted(&lookups), &live.certificate).fetch(&id_at(&live)),
            Err(Failure::Unavailable(_))
        ));
        assert_eq!(live.accepted.load(Ordering::SeqCst), 0);

        let lookups = format!("{},10.0.0.1>127.0.0.1", vec!["8.8.8.8"; 16].join(","));
        assert!(matches!(
            fetcher(scripted(&lookups), &live.certificate).fetch(&id_at(&live)),
            Err(Failure::Refused(_))
        ));
        assert_eq!(live.accepted.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn one_answer_that_is_not_public_refuses_the_name() {
        let live = listen(NAME, reply("200 OK", "application/json", b"{}"));
        for private in ["10.0.0.1", "127.0.0.1", "::1", "fe80::1"] {
            for lookups in [
                format!("8.8.8.8>127.0.0.1,{private}>127.0.0.1"),
                format!("{private}>127.0.0.1,8.8.8.8>127.0.0.1"),
                format!("{private}>127.0.0.1"),
            ] {
                let fetcher = fetcher(scripted(&lookups), &live.certificate);
                assert_eq!(
                    fetcher.fetch(&id_at(&live)),
                    Err(Failure::Refused(
                        "The client's host resolves to an address that is not public."
                    )),
                    "{lookups}"
                );
            }
        }
        assert_eq!(live.accepted.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_name_that_does_not_resolve_is_unavailable() {
        let fetcher = fetcher(Arc::new(Faults::default()), &[]);
        assert!(matches!(
            fetcher.fetch("https://nothing.invalid/client.json"),
            Err(Failure::Unavailable(_))
        ));
    }

    #[test]
    fn a_url_that_is_refused_is_never_looked_up() {
        let faults = Arc::new(Faults::default());
        faults
            .set("resolve:localhost", Some("8.8.8.8>127.0.0.1"))
            .expect("a resolve fault");
        let fetcher = fetcher(faults.clone(), &[]);
        assert!(matches!(
            fetcher.fetch("https://localhost/client.json"),
            Err(Failure::Refused(_))
        ));
        assert_eq!(faults.list()[0].fired, 0);
    }

    #[test]
    fn tls_is_checked_against_the_name_and_not_the_address() {
        let right = listen(NAME, reply("200 OK", "application/json", b"{}"));
        assert_eq!(get(&right).expect("a document"), b"{}");

        let wrong = listen(
            "other.example.com",
            reply("200 OK", "application/json", b"{}"),
        );
        assert!(matches!(get(&wrong), Err(Failure::Unavailable(_))));

        let unknown = listen(NAME, Vec::new());
        assert!(matches!(
            fetcher(scripted("8.8.8.8>127.0.0.1"), &unknown.certificate).fetch(&id_at(&right)),
            Err(Failure::Unavailable(_))
        ));
    }

    #[test]
    fn a_redirect_is_not_followed() {
        let target = listen(NAME, reply("200 OK", "application/json", b"{}"));
        let location = format!("https://{}/client.json", target.address);
        let redirecting = listen(
            NAME,
            format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
        );
        assert!(matches!(get(&redirecting), Err(Failure::Refused(_))));
        assert_eq!(redirecting.accepted.load(Ordering::SeqCst), 1);
        assert_eq!(target.accepted.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_status_says_refused_or_unavailable() {
        for status in [
            "404 Not Found",
            "403 Forbidden",
            "204 No Content",
            "410 Gone",
        ] {
            let listener = listen(NAME, reply(status, "application/json", b""));
            assert!(
                matches!(get(&listener), Err(Failure::Refused(_))),
                "{status}"
            );
        }
        for status in [
            "500 Internal Server Error",
            "503 Service Unavailable",
            "429 Too Many Requests",
            "408 Request Timeout",
        ] {
            let listener = listen(NAME, reply(status, "application/json", b""));
            assert!(
                matches!(get(&listener), Err(Failure::Unavailable(_))),
                "{status}"
            );
        }
    }

    #[test]
    fn only_json_is_read() {
        for content_type in [
            "application/json",
            "application/json; charset=utf-8",
            "Application/JSON",
            "application/oauth-client+json",
        ] {
            let listener = listen(NAME, reply("200 OK", content_type, b"{}"));
            assert!(get(&listener).is_ok(), "{content_type}");
        }
        for content_type in ["text/html", "text/json", "application/+json", ""] {
            let listener = listen(NAME, reply("200 OK", content_type, b"{}"));
            assert!(
                matches!(get(&listener), Err(Failure::Refused(_))),
                "{content_type}"
            );
        }
    }

    #[test]
    fn a_document_stops_at_the_size_limit() {
        let most = vec![b'a'; MAX_DOCUMENT_BYTES as usize];
        let listener = listen(NAME, reply("200 OK", "application/json", &most));
        assert_eq!(get(&listener).expect("a document").len(), most.len());

        let over = vec![b'a'; MAX_DOCUMENT_BYTES as usize + 1];
        let listener = listen(NAME, reply("200 OK", "application/json", &over));
        assert_eq!(
            get(&listener),
            Err(Failure::Refused(
                "The client's metadata document is too large."
            ))
        );

        let mut unstated =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n"
                .to_vec();
        unstated.extend_from_slice(&over);
        let listener = listen(NAME, unstated);
        assert_eq!(
            get(&listener),
            Err(Failure::Refused(
                "The client's metadata document is too large."
            ))
        );
    }

    fn gzipped(body: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(body).expect("compressed");
        let compressed = encoder.finish().expect("compressed");
        let mut out = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            compressed.len()
        )
        .into_bytes();
        out.extend_from_slice(&compressed);
        out
    }

    #[test]
    fn the_limit_is_on_a_document_after_it_is_decompressed() {
        let small = listen(NAME, gzipped(b"{}"));
        assert_eq!(get(&small).expect("a document"), b"{}");

        let bomb = gzipped(&vec![b' '; 1024 * 1024]);
        assert!((bomb.len() as u64) < MAX_DOCUMENT_BYTES);
        assert_eq!(
            get(&listen(NAME, bomb)),
            Err(Failure::Refused(
                "The client's metadata document is too large."
            ))
        );
    }

    #[test]
    fn a_server_that_says_nothing_runs_out_of_time() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let id = format!(
            "https://{NAME}:{}/client.json",
            listener.local_addr().expect("an address").port()
        );
        let certificate = listen(NAME, Vec::new()).certificate;
        let impatient = Fetcher {
            limit: Duration::from_millis(300),
            ..fetcher(scripted("8.8.8.8>127.0.0.1"), &certificate)
        };
        let started = std::time::Instant::now();
        assert!(matches!(impatient.fetch(&id), Err(Failure::Unavailable(_))));
        assert!(started.elapsed() < TIME_LIMIT);
        drop(listener);
    }

    #[test]
    fn the_fixtures_private_hosts_are_refused() {
        for id in [
            "https://127.0.0.1/client.json",
            "https://10.0.0.1/client.json",
            "https://169.254.169.254/client.json",
            "https://[::1]/client.json",
            "https://localhost/client.json",
        ] {
            assert!(is_url(id));
            assert_eq!(
                check_url(id),
                Err(Failure::Refused("A client ID URL must name a public host.")),
                "{id}"
            );
        }
    }

    #[test]
    fn a_client_id_url_has_the_shape_the_draft_gives() {
        for id in [
            ID,
            "https://metadata.example.com:8443/client.json",
            "https://metadata.example.com/a/b",
            "https://metadata.example.com/client?v=1",
            "https://8.8.8.8/client.json",
        ] {
            let url = check_url(id).expect("accepted");
            assert_eq!(url.as_str(), id);
        }
        for id in [
            "https://metadata.example.com",
            "https://metadata.example.com/",
            "https://metadata.example.com/a/../b",
            "https://metadata.example.com/a/./b",
            "https://metadata.example.com/%2e%2e/b",
            "https://metadata.example.com/a/%2E/b",
            "https://metadata.example.com/client#x",
            "https://metadata.example.com/client#",
            "https://user@metadata.example.com/client",
            "https://user:pw@metadata.example.com/client",
            "https://metadata.example.com\\@evil.example/client",
            "https://METADATA.example.com/client",
            "HTTPS://metadata.example.com/client",
            "https://metadata.example.com:443/client",
            "https://metadata.example.com./client",
            "https://metadata/client",
            "https://metadata.google.internal/client",
            "https://metadata.goog/client",
            "https://instance-data/client",
            "https://printer.local/client",
            "https://a.localhost/client",
            "https://[fe80::1%25en0]/client",
            "https://0x7f.0.0.1/client",
            "https://2130706433/client",
            "https://[::ffff:127.0.0.1]/client",
            "https://[::ffff:7f00:1]/client",
            "https://[::7f00:1]/client",
            "http://metadata.example.com/client",
            " https://metadata.example.com/client",
            "https://metadata.example.com/cl ient",
            "https://metadata.example.com/cl\tient",
            "https://metadata.example.com/caf\u{e9}",
            "",
        ] {
            assert!(check_url(id).is_err(), "{id}");
        }
    }

    #[test]
    fn only_https_text_routes_here() {
        assert!(is_url(ID));
        assert!(is_url("HTTPS://x"));
        for id in [
            "",
            "abc",
            "http://x",
            "https",
            "0123456789abcdef",
            "\u{e9}\u{e9}\u{e9}\u{e9}",
        ] {
            assert!(!is_url(id), "{id}");
        }
    }

    #[test]
    fn a_document_registers_as_a_client_of_its_url() {
        let registered = parse(&document()).expect("registered");
        assert_eq!(registered.client_name.as_deref(), Some("An app"));
        assert_eq!(registered.application_type, AppKind::Web);
        assert_eq!(registered.grant_types, [GrantType::AuthorizationCode]);
        assert_eq!(
            registered.scope.to_text(),
            "content:read content:write edge.*:read edge.*:write offline_access"
        );
    }

    #[test]
    fn a_document_leaves_out_an_optional_value_past_its_bound_and_still_registers() {
        let long_uri = format!("https://app.example/{}", "a".repeat(600));
        let mut body = document();
        for name in ["client_uri", "logo_uri", "tos_uri", "policy_uri"] {
            body = with(body, name, json!(long_uri));
        }
        let body = with(body, "software_id", json!("i".repeat(101)));
        let body = with(body, "software_version", json!("v".repeat(101)));
        let body = with(body, "scope", json!(vec!["core.note:read"; 80].join(" ")));
        let body = with(body, "contacts", json!(vec!["ops@app.example"; 6]));
        let registered = parse(&body).expect("registered");
        assert_eq!(registered.client_name.as_deref(), Some("An app"));
        assert_eq!(registered.client_uri, None);
        assert_eq!(registered.logo_uri, None);
        assert_eq!(registered.tos_uri, None);
        assert_eq!(registered.policy_uri, None);
        assert_eq!(registered.software_id, None);
        assert_eq!(registered.software_version, None);
        assert!(registered.contacts.is_empty());
        assert_eq!(
            registered.scope.to_text(),
            "content:read content:write edge.*:read edge.*:write offline_access"
        );

        let at_bound = with(
            document(),
            "client_uri",
            json!(format!("https://app.example/{}", "a".repeat(492))),
        );
        assert!(parse(&at_bound).expect("registered").client_uri.is_some());
        let named_long = with(document(), "client_name", json!("n".repeat(101)));
        assert!(parse(&named_long).is_err());
    }

    #[test]
    fn a_document_says_nothing_of_its_kind_and_its_redirects_decide() {
        for uri in ["http://127.0.0.1/callback", "com.example.app:/callback"] {
            let body = with(document(), "redirect_uris", json!([uri]));
            assert_eq!(
                parse(&body).expect("registered").application_type,
                AppKind::Native,
                "{uri}"
            );
        }
        let stated = with(document(), "application_type", json!("web"));
        let stated = with(
            stated,
            "redirect_uris",
            json!(["http://127.0.0.1/callback"]),
        );
        assert!(parse(&stated).is_err());
    }

    #[test]
    fn a_document_must_name_the_url_it_came_from_exactly() {
        for id in [
            json!("https://metadata.example.com/other.json"),
            json!("https://METADATA.example.com/client.json"),
            json!(1),
            json!(null),
        ] {
            assert!(parse(&with(document(), "client_id", id)).is_err());
        }
        let mut without = document();
        without
            .as_object_mut()
            .expect("an object")
            .remove("client_id");
        assert!(parse(&without).is_err());
    }

    #[test]
    fn a_document_holds_no_secret_and_no_shared_key_method() {
        for (name, value) in [
            ("client_secret", json!("x")),
            ("client_secret", json!(null)),
            ("client_secret_expires_at", json!(0)),
            ("token_endpoint_auth_method", json!("client_secret_basic")),
            ("token_endpoint_auth_method", json!("client_secret_post")),
            ("token_endpoint_auth_method", json!("client_secret_jwt")),
            ("token_endpoint_auth_method", json!("private_key_jwt")),
            (
                "token_endpoint_auth_methods_supported",
                json!(["none", "client_secret_basic"]),
            ),
            (
                "token_endpoint_auth_methods_supported",
                json!(["client_secret_jwt"]),
            ),
            ("token_endpoint_auth_methods_supported", json!("none")),
        ] {
            assert!(
                parse(&with(document(), name, value.clone())).is_err(),
                "{name} {value}"
            );
        }
    }

    #[test]
    fn a_stated_method_must_be_among_those_it_supports() {
        let stated = with(document(), "token_endpoint_auth_method", json!("none"));
        let among = with(
            stated.clone(),
            "token_endpoint_auth_methods_supported",
            json!(["none"]),
        );
        assert!(parse(&among).is_ok());
        let outside = with(
            stated,
            "token_endpoint_auth_methods_supported",
            json!(["tls_client_auth"]),
        );
        assert!(parse(&outside).is_err());
        let unstated = with(
            document(),
            "token_endpoint_auth_methods_supported",
            json!(["tls_client_auth"]),
        );
        assert!(parse(&unstated).is_err());
        let empty = with(
            document(),
            "token_endpoint_auth_methods_supported",
            json!([]),
        );
        assert!(parse(&empty).is_err());
        let public = with(
            document(),
            "token_endpoint_auth_methods_supported",
            json!(["tls_client_auth", "none"]),
        );
        assert_eq!(
            parse(&public)
                .expect("registered")
                .token_endpoint_auth_method,
            AuthMethod::None
        );
    }

    #[test]
    fn a_document_that_can_use_none_registers_public_whatever_it_prefers() {
        // ChatGPT's published document, under this test's URL.
        let published = json!({
            "client_id": ID,
            "client_uri": "https://chatgpt.com/",
            "client_name": "ChatGPT",
            "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
            "token_endpoint_auth_method": "private_key_jwt",
            "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
            "grant_types": [
                "authorization_code",
                "refresh_token",
                "urn:ietf:params:oauth:grant-type:jwt-bearer"
            ],
            "response_types": ["code"],
            "token_endpoint_auth_signing_alg": "RS256",
            "jwks_uri": "https://chatgpt.com/jwks.json",
        });
        let registered = parse(&published).expect("registered");
        assert_eq!(registered.token_endpoint_auth_method, AuthMethod::None);
        let without_none = with(
            published,
            "token_endpoint_auth_methods_supported",
            json!(["private_key_jwt"]),
        );
        assert!(parse(&without_none).is_err());
    }

    #[test]
    fn a_stated_method_that_is_not_text_is_refused() {
        let listed = with(
            document(),
            "token_endpoint_auth_methods_supported",
            json!(["none"]),
        );
        assert!(parse(&listed).is_ok());
        let stated = with(listed, "token_endpoint_auth_method", json!(5));
        assert!(parse(&stated).is_err());
    }

    #[test]
    fn a_document_holds_one_kind_of_key_at_most() {
        let keys = with(document(), "jwks", json!({ "keys": [] }));
        assert!(parse(&keys).is_ok());
        let both = with(keys, "jwks_uri", json!("https://app.example/jwks"));
        assert!(parse(&both).is_err());
    }

    #[test]
    fn a_document_needs_a_name_and_redirect_uris() {
        for value in [json!(""), json!(null)] {
            assert!(parse(&with(document(), "client_name", value)).is_err());
        }
        let no_uris = with(document(), "redirect_uris", json!([]));
        assert!(parse(&no_uris).is_err());
        let device_only = with(
            no_uris,
            "grant_types",
            json!(["urn:ietf:params:oauth:grant-type:device_code"]),
        );
        assert!(parse(&device_only).is_err());
    }

    #[test]
    fn what_this_server_lacks_is_filtered_and_nothing_left_is_refused() {
        let wider = with(
            document(),
            "grant_types",
            json!(["authorization_code", "client_credentials", "refresh_token"]),
        );
        let wider = with(wider, "response_types", json!(["code", "token"]));
        let registered = parse(&wider).expect("registered");
        assert_eq!(
            registered.grant_types,
            [GrantType::AuthorizationCode, GrantType::RefreshToken]
        );
        assert_eq!(registered.response_types, [ResponseType::Code]);

        let none = with(document(), "grant_types", json!(["client_credentials"]));
        assert!(parse(&none).is_err());
        let none = with(document(), "response_types", json!(["token"]));
        assert!(parse(&none).is_err());
    }

    #[test]
    fn a_document_cannot_slip_past_the_redirect_rules() {
        for uri in [
            "https://user@app.example/cb",
            "https://app.example/cb#x",
            "javascript:alert(1)",
            "http://app.example/cb",
        ] {
            let body = with(document(), "redirect_uris", json!([uri]));
            assert!(parse(&body).is_err(), "{uri}");
        }
    }

    fn address_text() -> impl Strategy<Value = (IpAddr, Vec<String>)> {
        any::<[u8; 4]>().prop_map(|octets| {
            let v4 = std::net::Ipv4Addr::from(octets);
            let number = u32::from(v4);
            let [a, b, c, d] = octets;
            let spellings = vec![
                format!("https://{number}/client.json"),
                format!("https://0x{number:x}/client.json"),
                format!("https://0{a:o}.0{b:o}.0{c:o}.0{d:o}/client.json"),
                format!("https://0x{a:x}.0x{b:x}.0x{c:x}.0x{d:x}/client.json"),
                format!("https://[::ffff:{v4}]/client.json"),
                format!("https://[::{v4}]/client.json"),
                format!("https://{v4}./client.json"),
            ];
            (IpAddr::V4(v4), spellings)
        })
    }

    proptest! {
        #[test]
        fn nothing_panics_on_any_text(text in any::<String>()) {
            let _ = is_url(&text);
            let _ = check_url(&text);
            let _ = is_json_media_type(&text);
            let _ = parse_document(&text, text.as_bytes());
        }

        #[test]
        fn no_other_spelling_of_an_address_passes(
            (_, spellings) in address_text(),
        ) {
            for spelling in spellings {
                prop_assert!(check_url(&spelling).is_err(), "{}", spelling);
            }
        }

        #[test]
        fn what_passes_is_its_own_one_spelling(
            host in "[a-zA-Z0-9.-]{1,16}",
            path in "/[a-zA-Z0-9./%\\\\-]{0,12}",
        ) {
            let id = format!("https://{host}{path}");
            if let Ok(url) = check_url(&id) {
                prop_assert_eq!(url.as_str(), id.as_str());
                prop_assert!(url.host_str().is_some_and(|name| !name.ends_with('.')));
                prop_assert!(!id.contains('\\'));
                prop_assert!(!url.path().split('/').any(|part| part == ".."));
            }
        }

        #[test]
        fn a_document_named_for_another_url_stays_refused(tail in "[a-z]{1,8}") {
            let body = with(document(), "client_id", json!(format!("{ID}{tail}")));
            prop_assert!(parse(&body).is_err());
        }
    }
}
