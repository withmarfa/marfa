//! Client ID metadata documents (draft-ietf-oauth-client-id-metadata-document):
//! a `client_id` that is a URL, and the fetch of what it names. The URL comes
//! from whoever opens an authorization, so nothing about it is trusted, and
//! the fetch must never let them read this server's own network.
//!
//! This blocks. The door runs it off the async threads, and holds the rate
//! limits, the cache and the state of a client whose document has gone.

use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Map, Value};
use ureq::Agent;
use ureq::config::Config;
use ureq::http::{Uri, header};
use ureq::tls::TlsConfig;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use url::{Host, Url};

use super::client::{self, Registration, RegistrationError, Source};
use super::redirect;
use super::scope::ScopeSet;

/// The draft's recommended limit.
const MAX_DOCUMENT_BYTES: u64 = 5 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const TIME_LIMIT: Duration = Duration::from_secs(5);

const SYMMETRIC_METHODS: [&str; 3] = [
    "client_secret_post",
    "client_secret_basic",
    "client_secret_jwt",
];

/// Why a document could not be had. The draft treats the two differently: a
/// client already stored keeps working through `Unavailable`, and neither is
/// ever cached.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum Failure {
    /// The URL or what it answered will not do until someone changes it.
    #[error("{0}")]
    Refused(&'static str),
    /// No usable answer this time.
    #[error("{0}")]
    Unavailable(&'static str),
}

/// Whether `client_id` should be read as a document's URL. This only routes
/// a request: [`check_url`] is what accepts one.
pub fn is_url(client_id: &str) -> bool {
    client_id
        .get(..6)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https:"))
}

/// Judge a `client_id` that [`is_url`] routed here.
///
/// The draft compares client IDs as strings, so the text must already be the
/// URL's one spelling: what is checked is what is fetched, and one document
/// is never two clients. That one comparison also refuses dot segments,
/// encoded ones included, an uppercase host, a default port and an encoded
/// host, each of which the parser rewrites.
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

/// A first look at the name, before any lookup. The address check on what the
/// name resolves to is the guard; this answers early and in the same way for
/// names no public document lives at.
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

/// Whether an address is on the public internet. IPv4 refuses each range of
/// RFC 6890 and its successors that is not global.
fn is_public_v4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !matches!(
        (a, b, c),
        (0 | 10 | 127, _, _)
            | (100, 64..=127, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 0, 0 | 2)
            | (192, 88, 99)
            | (192, 168, _)
            | (198, 18..=19, _)
            | (198, 51, 100)
            | (203, 0, 113)
            | (224..=255, _, _)
    )
}

/// Global unicast is the one IPv6 block with public hosts, so this lists what
/// is allowed and not what is refused: anything IANA assigns later stays out,
/// as do IPv4-compatible, NAT64, link-local, unique-local and multicast
/// addresses. Teredo, ORCHID and the like, the 6to4 relay and both
/// documentation blocks sit inside it.
fn is_public_v6(address: Ipv6Addr) -> bool {
    let [first, second, ..] = address.segments();
    let global_unicast = first & 0xe000 == 0x2000;
    let special = (first == 0x2001 && second < 0x0200)
        || (first == 0x2001 && second == 0x0db8)
        || first == 0x2002
        || (first == 0x3fff && second < 0x1000);
    global_unicast && !special
}

pub fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => is_public_v6(v6),
        },
    }
}

/// A name lookup, kept apart so that the one answer the checks saw is the one
/// the connection uses.
pub trait Lookup: Send + Sync {
    fn lookup(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>>;
}

/// The system's resolver. It has no time limit of its own, so it runs on a
/// thread of its own, which a hung lookup leaves behind until the system
/// gives up.
struct SystemLookup {
    limit: Duration,
}

impl Lookup for SystemLookup {
    fn lookup(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        let (send, receive) = mpsc::channel();
        let host = host.to_string();
        std::thread::spawn(move || {
            let answers = (host.as_str(), port)
                .to_socket_addrs()
                .map(Iterator::collect);
            let _ = send.send(answers);
        });
        receive
            .recv_timeout(self.limit)
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
    }
}

/// Answers every name with the one checked address, so that nothing between
/// the check and the connection can look the name up again.
#[derive(Debug)]
struct Pinned(SocketAddr);

impl Resolver for Pinned {
    fn resolve(
        &self,
        _uri: &Uri,
        _config: &Config,
        _timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut answers = self.empty();
        answers.push(self.0);
        Ok(answers)
    }
}

pub struct Fetcher {
    lookup: Box<dyn Lookup>,
    allow: fn(IpAddr) -> bool,
    tls: TlsConfig,
    limit: Duration,
}

impl Default for Fetcher {
    fn default() -> Fetcher {
        Fetcher {
            lookup: Box::new(SystemLookup { limit: TIME_LIMIT }),
            allow: is_public,
            tls: TlsConfig::default(),
            limit: TIME_LIMIT,
        }
    }
}

impl Fetcher {
    /// Fetch the document a `client_id` names.
    pub fn fetch(&self, client_id: &str) -> Result<Vec<u8>, Failure> {
        let url = check_url(client_id)?;
        let address = self.one_address(&url)?;
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
        let agent = Agent::with_parts(config, DefaultConnector::default(), Pinned(address));
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
        // ureq's own limit counts bytes before it decompresses them, and hides
        // that it has, so the limit goes on what comes out.
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

    /// Resolve once, and judge every answer: a name that also answers an
    /// internal address is not trusted for the sake of its public one.
    fn one_address(&self, url: &Url) -> Result<SocketAddr, Failure> {
        let unavailable = Failure::Unavailable("The client's host could not be resolved.");
        let port = url.port_or_known_default().ok_or(unavailable)?;
        let answers = match url.host() {
            Some(Host::Ipv4(v4)) => vec![SocketAddr::new(IpAddr::V4(v4), port)],
            Some(Host::Ipv6(v6)) => vec![SocketAddr::new(IpAddr::V6(v6), port)],
            Some(Host::Domain(name)) => self.lookup.lookup(name, port).map_err(|_| unavailable)?,
            None => Vec::new(),
        };
        let first = *answers.first().ok_or(unavailable)?;
        if answers.iter().all(|answer| (self.allow)(answer.ip())) {
            Ok(first)
        } else {
            Err(Failure::Refused(
                "The client's host resolves to an address that is not public.",
            ))
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

/// `application/json`, or the `+json` of any `application/` type, with any
/// parameters.
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

fn named_methods<'a>(
    object: &'a Map<String, Value>,
    name: &str,
) -> Result<Vec<&'a str>, RegistrationError> {
    let not_a_list = || RegistrationError::metadata(format!("{name} must be a list of strings."));
    match object.get(name) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => value
            .as_array()
            .ok_or_else(not_a_list)?
            .iter()
            .map(|entry| entry.as_str().ok_or_else(not_a_list))
            .collect(),
    }
}

/// Read a fetched document as the client `client_id`. Every error here is
/// `invalid_client` to whoever asked, so the door uses the description only
/// for its log.
pub fn parse_document(
    client_id: &str,
    body: &[u8],
    allowed: &ScopeSet,
) -> Result<Registration, RegistrationError> {
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
    let supported = named_methods(object, "token_endpoint_auth_methods_supported")?;
    if let Some(method) = supported
        .iter()
        .find(|method| SYMMETRIC_METHODS.contains(method))
    {
        return Err(RegistrationError::metadata(format!(
            "A metadata document must not offer {method}."
        )));
    }
    let registration = client::read(object, Source::Document, allowed)?;
    if !supported.is_empty()
        && object.contains_key("token_endpoint_auth_method")
        && !supported.contains(&registration.token_endpoint_auth_method.word())
    {
        return Err(RegistrationError::metadata(
            "token_endpoint_auth_method must be among token_endpoint_auth_methods_supported.",
        ));
    }
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
    use std::collections::VecDeque;
    use std::io::Write;
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use proptest::prelude::*;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use serde_json::json;
    use ureq::tls::{Certificate, RootCerts};

    use super::super::client::{GrantType, ResponseType};
    use super::super::redirect::AppKind;
    use super::*;

    const ID: &str = "https://metadata.example.com/client.json";
    const NAME: &str = "metadata.example.com";

    /// One TLS listener on the loopback that writes one fixed response.
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

    /// Answers each lookup with the next list, and the last one from then on.
    struct Script {
        answers: Mutex<VecDeque<Vec<SocketAddr>>>,
        calls: Arc<AtomicUsize>,
    }

    impl Script {
        fn new(answers: Vec<Vec<SocketAddr>>) -> (Script, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            let script = Script {
                answers: Mutex::new(answers.into()),
                calls: calls.clone(),
            };
            (script, calls)
        }
    }

    impl Lookup for Script {
        fn lookup(&self, _host: &str, _port: u16) -> io::Result<Vec<SocketAddr>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut answers = self.answers.lock().expect("the script");
            if answers.len() > 1 {
                return Ok(answers.pop_front().expect("an answer"));
            }
            answers
                .front()
                .cloned()
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }
    }

    /// The real checks, and only the listeners' loopback let through by name
    /// of the test: the guard itself has its own tests below.
    fn fetcher(lookup: impl Lookup + 'static, trusted: &[u8]) -> Fetcher {
        Fetcher {
            lookup: Box::new(lookup),
            allow: |address| address.is_loopback(),
            tls: TlsConfig::builder()
                .root_certs(RootCerts::new_with_certs(&[
                    Certificate::from_der(trusted).to_owned()
                ]))
                .build(),
            limit: Duration::from_millis(1500),
        }
    }

    fn at(listener: &Listener) -> Fetcher {
        let (script, _) = Script::new(vec![vec![listener.address]]);
        fetcher(script, &listener.certificate)
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

    fn allowed() -> ScopeSet {
        ScopeSet::parse("core.note:read offline_access")
    }

    fn parse(body: &Value) -> Result<Registration, RegistrationError> {
        parse_document(ID, body.to_string().as_bytes(), &allowed())
    }

    #[test]
    fn a_rebinding_name_cannot_turn_the_connection_inward() {
        let public = listen(NAME, reply("200 OK", "application/json", b"public"));
        let internal = listen(NAME, reply("200 OK", "application/json", b"internal"));
        let (script, lookups) = Script::new(vec![vec![public.address], vec![internal.address]]);
        let fetcher = fetcher(script, &public.certificate);

        assert_eq!(fetcher.fetch(ID).expect("a document"), b"public");
        assert_eq!(lookups.load(Ordering::SeqCst), 1);
        assert_eq!(public.accepted.load(Ordering::SeqCst), 1);
        assert_eq!(internal.accepted.load(Ordering::SeqCst), 0);

        // The witness: the name really does rebind, on the next lookup.
        assert!(fetcher.fetch(ID).is_err());
        assert_eq!(lookups.load(Ordering::SeqCst), 2);
        assert_eq!(internal.accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn one_answer_that_is_not_public_refuses_the_name() {
        let public: SocketAddr = "8.8.8.8:443".parse().expect("an address");
        for private in [
            "10.0.0.1:443",
            "127.0.0.1:443",
            "[::1]:443",
            "[fe80::1]:443",
        ] {
            let private: SocketAddr = private.parse().expect("an address");
            for answers in [vec![public, private], vec![private, public], vec![private]] {
                let (script, _) = Script::new(vec![answers]);
                let fetcher = Fetcher {
                    lookup: Box::new(script),
                    ..Fetcher::default()
                };
                assert_eq!(
                    fetcher.fetch(ID),
                    Err(Failure::Refused(
                        "The client's host resolves to an address that is not public."
                    )),
                    "{private}"
                );
            }
        }
    }

    #[test]
    fn a_failed_or_empty_lookup_is_unavailable() {
        let (empty, _) = Script::new(vec![vec![]]);
        let (failed, _) = Script::new(vec![]);
        for lookup in [empty, failed] {
            let fetcher = Fetcher {
                lookup: Box::new(lookup),
                ..Fetcher::default()
            };
            assert!(matches!(fetcher.fetch(ID), Err(Failure::Unavailable(_))));
        }
    }

    #[test]
    fn a_url_that_is_refused_is_never_looked_up() {
        let (script, lookups) = Script::new(vec![vec!["8.8.8.8:443".parse().expect("an address")]]);
        let fetcher = Fetcher {
            lookup: Box::new(script),
            ..Fetcher::default()
        };
        assert!(matches!(
            fetcher.fetch("https://localhost/client.json"),
            Err(Failure::Refused(_))
        ));
        assert_eq!(lookups.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn tls_is_checked_against_the_name_and_not_the_address() {
        let right = listen(NAME, reply("200 OK", "application/json", b"{}"));
        assert_eq!(at(&right).fetch(ID).expect("a document"), b"{}");

        let wrong = listen(
            "other.example.com",
            reply("200 OK", "application/json", b"{}"),
        );
        assert!(matches!(at(&wrong).fetch(ID), Err(Failure::Unavailable(_))));

        let (script, _) = Script::new(vec![vec![right.address]]);
        let unknown = listen(NAME, Vec::new());
        assert!(matches!(
            fetcher(script, &unknown.certificate).fetch(ID),
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
        assert!(matches!(
            at(&redirecting).fetch(ID),
            Err(Failure::Refused(_))
        ));
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
                matches!(at(&listener).fetch(ID), Err(Failure::Refused(_))),
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
                matches!(at(&listener).fetch(ID), Err(Failure::Unavailable(_))),
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
            assert!(at(&listener).fetch(ID).is_ok(), "{content_type}");
        }
        for content_type in ["text/html", "text/json", "application/+json", ""] {
            let listener = listen(NAME, reply("200 OK", content_type, b"{}"));
            assert!(
                matches!(at(&listener).fetch(ID), Err(Failure::Refused(_))),
                "{content_type}"
            );
        }
    }

    #[test]
    fn a_document_stops_at_the_size_limit() {
        let most = vec![b'a'; MAX_DOCUMENT_BYTES as usize];
        let listener = listen(NAME, reply("200 OK", "application/json", &most));
        assert_eq!(
            at(&listener).fetch(ID).expect("a document").len(),
            most.len()
        );

        let over = vec![b'a'; MAX_DOCUMENT_BYTES as usize + 1];
        let listener = listen(NAME, reply("200 OK", "application/json", &over));
        assert_eq!(
            at(&listener).fetch(ID),
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
            at(&listener).fetch(ID),
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
        assert_eq!(at(&small).fetch(ID).expect("a document"), b"{}");

        let bomb = gzipped(&vec![b' '; 1024 * 1024]);
        assert!((bomb.len() as u64) < MAX_DOCUMENT_BYTES);
        assert_eq!(
            at(&listen(NAME, bomb)).fetch(ID),
            Err(Failure::Refused(
                "The client's metadata document is too large."
            ))
        );
    }

    #[test]
    fn a_server_that_says_nothing_runs_out_of_time() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let address = listener.local_addr().expect("an address");
        let certificate = listen(NAME, Vec::new()).certificate;
        let (script, _) = Script::new(vec![vec![address]]);
        let started = std::time::Instant::now();
        assert!(matches!(
            fetcher(script, &certificate).fetch(ID),
            Err(Failure::Unavailable(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(4));
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
    fn every_special_ipv4_range_is_refused_at_both_of_its_ends() {
        for (first, last) in [
            ("0.0.0.0", "0.255.255.255"),
            ("10.0.0.0", "10.255.255.255"),
            ("100.64.0.0", "100.127.255.255"),
            ("127.0.0.0", "127.255.255.255"),
            ("169.254.0.0", "169.254.255.255"),
            ("172.16.0.0", "172.31.255.255"),
            ("192.0.0.0", "192.0.0.255"),
            ("192.0.2.0", "192.0.2.255"),
            ("192.88.99.0", "192.88.99.255"),
            ("192.168.0.0", "192.168.255.255"),
            ("198.18.0.0", "198.19.255.255"),
            ("198.51.100.0", "198.51.100.255"),
            ("203.0.113.0", "203.0.113.255"),
            ("224.0.0.0", "239.255.255.255"),
            ("240.0.0.0", "255.255.255.255"),
        ] {
            for text in [first, last] {
                let address: IpAddr = text.parse().expect("an address");
                assert!(!is_public(address), "{text}");
            }
        }
        for text in [
            "1.1.1.1",
            "8.8.8.8",
            "9.255.255.255",
            "11.0.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "126.255.255.255",
            "128.0.0.0",
            "169.253.255.255",
            "169.255.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.0.1.0",
            "192.167.255.255",
            "192.169.0.0",
            "198.17.255.255",
            "198.20.0.0",
            "223.255.255.255",
        ] {
            let address: IpAddr = text.parse().expect("an address");
            assert!(is_public(address), "{text}");
        }
    }

    #[test]
    fn ipv6_is_public_only_in_global_unicast() {
        for text in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "::127.0.0.1",
            "::10.0.0.1",
            "::8.8.8.8",
            "64:ff9b::7f00:1",
            "100::1",
            "2001::1",
            "2001:0:4136:e378::1",
            "2001:1ff:ffff::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "3fff::1",
            "3fff:fff:ffff::1",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
        ] {
            let address: IpAddr = text.parse().expect("an address");
            assert!(!is_public(address), "{text}");
        }
        for text in [
            "::ffff:8.8.8.8",
            "2001:200::1",
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
            "2a00:1450:4009::1",
            "3ffe::1",
        ] {
            let address: IpAddr = text.parse().expect("an address");
            assert!(is_public(address), "{text}");
        }
    }

    #[test]
    fn a_document_registers_as_a_client_of_its_url() {
        let registered = parse(&document()).expect("registered");
        assert_eq!(registered.client_name.as_deref(), Some("An app"));
        assert_eq!(registered.application_type, AppKind::Web);
        assert_eq!(registered.grant_types, [GrantType::AuthorizationCode]);
        assert_eq!(registered.scope, allowed());
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
        assert!(parse(&unstated).is_ok());
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
            let v4 = Ipv4Addr::from(octets);
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
            let _ = parse_document(&text, text.as_bytes(), &allowed());
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
        fn a_mapped_address_is_judged_as_the_ipv4_address_it_holds(octets in any::<[u8; 4]>()) {
            let v4 = Ipv4Addr::from(octets);
            let mapped = IpAddr::V6(v4.to_ipv6_mapped());
            prop_assert_eq!(is_public(mapped), is_public(IpAddr::V4(v4)));
        }

        #[test]
        fn an_ipv4_compatible_address_is_never_public(octets in any::<[u8; 4]>()) {
            prop_assert!(!is_public(IpAddr::V6(Ipv4Addr::from(octets).to_ipv6_compatible())));
        }

        #[test]
        fn what_is_public_in_ipv6_is_global_unicast(segments in any::<[u16; 8]>()) {
            let address = Ipv6Addr::from(segments);
            if is_public(IpAddr::V6(address)) && address.to_ipv4_mapped().is_none() {
                prop_assert_eq!(segments[0] & 0xe000, 0x2000);
                prop_assert!(!address.is_loopback() && !address.is_multicast());
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
