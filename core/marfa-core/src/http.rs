use std::cell::Cell;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use ureq::Agent;
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout, Transport,
};
use url::Url;

use crate::contract::CONTRACT_VERSION;
use crate::error::{ContractRefusal, CoreError, CoreErrorKind, ServerAnswer};
use crate::model::SliceTier;
use crate::wire::{
    WireEdge, WireErrorEnvelope, WireItem, WireItemWithMetadata, WireMetadata, WirePage,
    WireReadOnly,
};
use marfa_rules::wire::{WireCatalog, WireEdgeType, WireType};

fn connection_refused(cause: &(dyn std::error::Error + 'static)) -> bool {
    std::iter::successors(Some(cause), |error| error.source()).any(|error| {
        let kind = match error.downcast_ref::<ureq::Error>() {
            Some(ureq::Error::Io(error)) => Some(error.kind()),
            _ => error
                .downcast_ref::<std::io::Error>()
                .map(std::io::Error::kind),
        };
        kind == Some(std::io::ErrorKind::ConnectionRefused)
    })
}

/// The page asked of the item listing, the most it answers
/// (`search-and-filters/limit-listing`). A hydration reads a page per round
/// trip, so a larger page fills a copy sooner over a slow link. A server
/// before v0.0.48 refuses a `limit` above 200; none is supported.
pub const ITEM_PAGE_LIMIT: u32 = 500;

/// The page asked of the edge listings, the most they answer
/// (`edges/list-limit`). A hydration reads a page per round trip, so a larger
/// page fills a copy sooner over a slow link.
pub const EDGE_PAGE_LIMIT: u32 = 500;

/// The most ids `POST /items/bulk-get` takes in one request
/// (`items/bulk-get-cap`).
pub const BULK_GET_LIMIT: usize = 100;

/// The server's cap on a request's body unless its instance names another,
/// past which it answers `413 request_too_large` and closes the connection.
/// The root says what an instance set (`store::request_limit`); this is what
/// a device goes by where it has not said.
pub const REQUEST_LIMIT: usize = 1_048_576;

/// The most values `POST /items/lookup` takes in one request
/// (`search-and-filters/lookup-values-cap`).
pub const LOOKUP_LIMIT: usize = 500;

/// The most bytes one lookup's body carries, well under the server's default
/// cap on a JSON body; a server that caps lower answers `413`, and the keys
/// are asked again in halves.
pub const LOOKUP_BODY_BYTES: usize = 256 * 1024;

/// How long a server may take to begin an answer, and to send the body of
/// one read whole.
const RESPONSE_BUDGET: Duration = Duration::from_secs(30);
const BODY_BUDGET: Duration = Duration::from_secs(60);

/// How long an upload that asked `Expect: 100-continue` waits for `100`, as RFC 9110 allows, before sending its body.
const AWAIT_100: Duration = Duration::from_secs(2);

/// The rows of an item page a body budget is set for. The budget bounds the
/// whole read of a body, so a page of more rows is given more of it in
/// proportion (`Http::page_budget`), and a page of large notes on a slow link
/// is not cut off for being larger than it used to be.
const ROWS_PER_BODY_BUDGET: u32 = 200;

thread_local! {
    static ENDS_BY: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// While held, every request its thread starts ends by the deadline: its
/// connection, its answer's headers and its body alike.
pub(crate) struct EndsBy(Option<Instant>);

impl EndsBy {
    /// An earlier deadline the thread already holds stays.
    pub(crate) fn hold(deadline: Option<Instant>) -> Self {
        let before = ENDS_BY.get();
        ENDS_BY.set(match (before, deadline) {
            (Some(held), Some(deadline)) => Some(held.min(deadline)),
            (held, deadline) => held.or(deadline),
        });
        Self(before)
    }

    /// The thread's deadline, to hold on a thread it hands a request to.
    pub(crate) fn here() -> Option<Instant> {
        ENDS_BY.get()
    }

    /// A renewal is spent when the server answers it, so it is never cut off.
    fn lifted() -> Self {
        Self(ENDS_BY.replace(None))
    }
}

impl Drop for EndsBy {
    fn drop(&mut self) {
        ENDS_BY.set(self.0);
    }
}

/// The least of `budget` and what is left of the thread's deadline.
fn global_budget(budget: Option<Duration>) -> Result<Option<Duration>, ureq::Error> {
    let Some(deadline) = ENDS_BY.get() else {
        return Ok(budget);
    };
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(ureq::Error::Timeout(ureq::Timeout::Global));
    }
    Ok(Some(budget.map_or(left, |budget| budget.min(left))))
}

/// A server's address as the core keeps it: no trailing slash, query or
/// fragment.
fn base_of(url: &str) -> Result<Url, CoreError> {
    let mut base = Url::parse(url)?;
    if base.cannot_be_a_base() {
        return Err(CoreError::Invalid(format!("not a server url: {url}")));
    }
    let path = base.path().trim_end_matches('/').to_string();
    base.set_path(&path);
    base.set_query(None);
    base.set_fragment(None);
    Ok(base)
}

fn origin_of_base(base: &Url) -> String {
    format!(
        "{}{}",
        base.origin().ascii_serialization(),
        base.path().trim_end_matches('/')
    )
}

/// What identifies a server without reaching it, as `Http::origin` answers.
pub fn origin_of(url: &str) -> Result<String, CoreError> {
    Ok(origin_of_base(&base_of(url)?))
}

#[derive(Clone)]
pub struct Http {
    agent: Agent,
    /// Builds the agent a streamed call runs on, from that call's refusal
    /// deadline, over the same connector as `agent`.
    stream_agent: StreamAgent,
    base: Url,
    authorization: Arc<RwLock<String>>,
    renew: Arc<OnceLock<Renew>>,
    renewed: Arc<OnceLock<Renewed>>,
    /// Held while a renewal runs, so two calls refused at once renew once.
    renewing: Arc<Mutex<()>>,
    /// Raised by `let_go`: no request or renewal starts after it.
    let_go: Arc<AtomicBool>,
    relocation: Arc<OnceLock<Mutex<Relocation>>>,
    /// What the relocation's `keep` writes through, the copy's writer lock
    /// among it. `keep` reaches it only while a transport holds it, so a
    /// confirmation under way keeps the writer role, and a transport made to
    /// be let go, which holds none, frees it once the copy is closed.
    keeps: Option<Arc<dyn std::any::Any + Send + Sync>>,
    reach: Option<String>,
    /// The instance a write names (`X-Marfa-Instance-Id`), so another
    /// instance at the address refuses it rather than writing it.
    instance: Option<String>,
    call_budget: Option<Duration>,
    /// How long a streamed call waits for the answer to begin, in place of the
    /// agent's response budget.
    stream_wait: Option<Duration>,
    /// What to tell a person to check when a call that waits on the server's
    /// work ends without an answer (`Http::working`).
    working: Option<String>,
    /// Whether a `401` on a kept token renews it and sends the call again.
    renews: bool,
    /// Whether a write on this transport is announced: a folder's health
    /// report, which changes no data, is not.
    announces: bool,
}

/// Called with the server's origin before each request that can change
/// data, so a command line can say which server it writes to.
static ON_WRITE: OnceLock<fn(&str)> = OnceLock::new();

/// Sets what is called before each credentialed request that can change data,
/// once for the life of the process.
pub fn on_write(hook: fn(&str)) {
    let _ = ON_WRITE.set(hook);
}

type KeepOrigin = Box<dyn Fn(&AtomicBool) -> Result<(), CoreError> + Send + Sync>;

struct Relocation {
    expected_origin: String,
    expected_instance: Option<String>,
    keep: KeepOrigin,
    verified: bool,
}

type StreamAgent = Arc<dyn Fn(Arc<RwLock<Option<std::time::Instant>>>) -> Agent + Send + Sync>;

/// Handed the refused bearer, so a caller that keeps the credential elsewhere
/// can tell whether another process has rotated it already.
pub type Renew = Box<dyn Fn(&str) -> Result<String, CoreError> + Send + Sync>;

/// Handed the header a renewal replaced and the one that replaced it.
pub(crate) type Renewed = Box<dyn Fn(&str, &str) + Send + Sync>;

type Response = ureq::http::Response<ureq::Body>;

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    Attempt,
    Renewal,
}

pub(crate) type Before<'a> = Option<&'a dyn Fn(Stage) -> Result<(), CoreError>>;

/// An environment proxy cannot reach this machine's loopback addresses.
pub fn direct_when_local(
    builder: ureq::config::ConfigBuilder<ureq::typestate::AgentScope>,
    target: &str,
) -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    if marfa_telemetry::host::may_use_proxy(target) {
        builder
    } else {
        builder.proxy(None)
    }
}

/// Proxy policy depends on each redirect's destination.
#[derive(Clone)]
pub struct Agents {
    proxied: Agent,
    direct: Agent,
}

impl Agents {
    pub fn new(
        builder: impl Fn() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope>,
    ) -> Self {
        let follow_none = |builder: ureq::config::ConfigBuilder<ureq::typestate::AgentScope>| {
            builder.max_redirects(0)
        };
        Self {
            proxied: follow_none(builder()).build().into(),
            direct: follow_none(builder()).proxy(None).build().into(),
        }
    }

    /// Follows redirects without cross-origin credentials or HTTPS downgrades.
    pub fn get(
        &self,
        url: &str,
        headers: &[(&str, String)],
        limit: u32,
    ) -> Result<Response, ureq::Error> {
        let mut at = url.to_string();
        let mut left_origin = false;
        for _ in 0..=limit {
            let agent = if marfa_telemetry::host::may_use_proxy(&at) {
                &self.proxied
            } else {
                &self.direct
            };
            let mut request = agent.get(&at);
            for (name, value) in headers {
                if left_origin && names_the_caller(name) {
                    continue;
                }
                request = request.header(*name, value.as_str());
            }
            let response = request.call()?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            let from = Url::parse(&at).ok();
            let next = response
                .headers()
                .get("location")
                .and_then(|location| location.to_str().ok())
                .and_then(|location| from.as_ref()?.join(location).ok());
            match (from, next) {
                (Some(from), Some(next)) => {
                    match hop(&from, &next) {
                        Hop::SameOrigin => {}
                        Hop::OtherOrigin => left_origin = true,
                        Hop::Downgrade => {
                            return Err(ureq::Error::Other(
                                "a redirect from https to http is refused".into(),
                            ));
                        }
                    }
                    at = next.to_string();
                }
                _ => return Ok(response),
            }
        }
        Err(ureq::Error::TooManyRedirects)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Hop {
    SameOrigin,
    OtherOrigin,
    Downgrade,
}

fn hop(from: &Url, to: &Url) -> Hop {
    if from.scheme() == "https" && to.scheme() == "http" {
        Hop::Downgrade
    } else if from.origin() == to.origin() {
        Hop::SameOrigin
    } else {
        Hop::OtherOrigin
    }
}

fn names_the_caller(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "authorization" | "proxy-authorization" | "cookie"
    ) || name.starts_with("x-marfa-")
}

/// Which of the agent's time budgets a call is held to.
#[derive(Clone)]
enum Budget {
    Whole,
    Stream(Arc<RwLock<Option<std::time::Instant>>>),
    /// A file is sent whole and the server may work on all of it before it
    /// answers, as a restore does.
    Upload,
    /// The server does its work before it answers, so there is no limit on
    /// how long the answer takes to begin.
    Working,
}

/// ureq fixes its body budget before the status is known. A stream gets its
/// own transport so only a refusal can activate a whole-body deadline, with
/// no blocked reader thread or shared connection left behind.
#[derive(Debug)]
struct RefusalDeadline(Arc<RwLock<Option<std::time::Instant>>>);

impl<T: Transport> Connector<T> for RefusalDeadline {
    type Out = RefusalTransport<T>;

    fn connect(
        &self,
        _: &ConnectionDetails,
        transport: Option<T>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        Ok(transport.map(|transport| RefusalTransport {
            transport,
            deadline: Arc::clone(&self.0),
        }))
    }
}

#[derive(Debug)]
struct RefusalTransport<T> {
    transport: T,
    deadline: Arc<RwLock<Option<std::time::Instant>>>,
}

impl<T: Transport> Transport for RefusalTransport<T> {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.transport.buffers()
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.transport.transmit_output(amount, timeout)
    }

    fn await_input(&mut self, mut timeout: NextTimeout) -> Result<bool, ureq::Error> {
        if let Some(deadline) = *self.deadline.read().expect("refusal deadline lock") {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(ureq::Error::Timeout(ureq::Timeout::RecvBody));
            }
            let after = ureq::unversioned::transport::time::Duration::Exact(remaining);
            if after < timeout.after {
                timeout = NextTimeout {
                    after,
                    reason: ureq::Timeout::RecvBody,
                    ..timeout
                };
            }
        }
        self.transport.maybe_await_input(timeout)
    }

    fn is_open(&mut self) -> bool {
        self.transport.is_open()
    }

    fn is_tls(&self) -> bool {
        self.transport.is_tls()
    }
}

pub struct ItemsQuery<'a> {
    /// `None` lists every type the key reads.
    pub r#type: Option<&'a str>,
    /// `all` lists both tiers.
    pub tier: SliceTier,
    /// A slice query's narrowing; `None` lists every state.
    pub(crate) narrowing: Option<&'a crate::slice::Listing>,
    pub cursor: Option<&'a str>,
}

/// The keys a slice query's narrowing adds to a listing or a count.
fn narrowed<'a>(params: &mut Vec<(&'a str, &'a str)>, narrowing: &'a crate::slice::Listing) {
    params.push(("state", &narrowing.state));
    if let Some(filter) = &narrowing.filter {
        params.push(("filter", filter));
    }
    if let Some(beneath) = &narrowing.beneath {
        params.push(("beneath", beneath));
    }
    if let Some(tags) = narrowing.tags {
        params.push(("tags", tags));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Put,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Patch => "PATCH",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
        }
    }
}

pub struct Outgoing<'a> {
    pub method: Method,
    pub segments: Vec<String>,
    pub params: Vec<(String, String)>,
    pub body: &'a str,
    pub idempotency_key: &'a str,
}

#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    /// The server's error code, or empty on a success.
    pub code: String,
    pub body: String,
    pub retry_after_seconds: Option<u64>,
    /// The server answered from its idempotency record rather than writing.
    pub replayed: bool,
    /// The server names its contract on every answer, so a refusal naming
    /// none came from something in front of it, a proxy or a tunnel.
    pub contract_named: bool,
}

impl Answer {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// A refusal that says nothing of the write: the network's, a rate
    /// limit, a failing server, or one naming no contract (`Http::refused`).
    pub fn is_environmental(&self) -> bool {
        !self.is_success()
            && (!self.contract_named
                || self.status == 429
                || crate::error::environmental_status(self.status))
    }

    /// Another instance at the address refused the write without applying
    /// it, so the copy it was queued against is no longer the server's.
    pub fn instance_changed(&self) -> bool {
        self.contract_named && self.status == 409 && self.code == INSTANCE_CHANGED
    }

    /// The server's answer, without the device's interpretation.
    pub(crate) fn server_answer(&self) -> Box<ServerAnswer> {
        let envelope = serde_json::from_str::<WireErrorEnvelope>(&self.body).ok();
        Box::new(ServerAnswer {
            status: self.status,
            code: envelope
                .as_ref()
                .map(|envelope| envelope.error.code.clone()),
            details: envelope.and_then(|envelope| envelope.error.details),
        })
    }

    /// The error for `instance_changed`, which carries the server's answer.
    pub(crate) fn instance_changed_error(&self) -> CoreError {
        CoreError::CopyExpired {
            reason: INSTANCE_CHANGED.into(),
            server: Some(self.server_answer()),
        }
    }
}

/// A read by id: the row, or the server's answer that it is gone.
pub(crate) enum ByIdRead<T> {
    Row(T),
    Absent(Option<Box<ServerAnswer>>),
}

impl<T> ByIdRead<T> {
    pub(crate) fn row(self) -> Option<T> {
        match self {
            ByIdRead::Row(row) => Some(row),
            ByIdRead::Absent(_) => None,
        }
    }
}

/// A blob upload streams from a `Reader` rather than buffering the file, so
/// the cap on a blob is the server's alone.
pub enum CallBody<'a> {
    None,
    Json(&'a str),
    Text(&'a str),
    Reader(Box<dyn Read + Send + 'static>),
}

pub struct Call<'a> {
    pub method: Method,
    pub segments: &'a [&'a str],
    pub params: &'a [(&'a str, &'a str)],
    pub headers: &'a [(&'a str, &'a str)],
    pub body: CallBody<'a>,
    /// A public door is called without the credential even when one is held,
    /// so it cannot be refused for a credential it never needed.
    pub credential: bool,
    /// Hand a success back as a reader. Only `fetch` does; `call` reads every
    /// answer whole.
    pub stream: bool,
}

/// Every status the server can answer with is a `Reply`; an `Err` is a
/// transport failure, a redirect, or an answer on another contract.
pub struct Reply<B = ReplyBody> {
    pub status: u16,
    pub content_type: String,
    pub retry_after_seconds: Option<u64>,
    /// Judged before a `Reply` exists, except by `fetch` with `held` false,
    /// which hands it on.
    pub contract: Option<String>,
    pub location: Option<String>,
    pub body: B,
}

/// What the instance answered to a type the app declared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Registration {
    Registered,
    Held,
    Refused { code: String, message: String },
}

/// What the instance answered to a declared type it holds that differs from
/// the declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Replacement {
    Replaced,
    Refused { code: String, message: String },
}

/// The names `POST /items/titles` takes in one call.
pub(crate) const TITLE_LOOKUP_NAMES: usize = 200;

/// An item `POST /items/titles` found for a name.
#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TitledItem {
    pub id: String,
    pub r#type: String,
    /// The title as the server holds it, which the caller compares itself.
    pub title: String,
    /// Whether the item's `blob_ref` holds a blob digest.
    pub has_blob: bool,
}

/// What `POST /items/titles` answers for one name.
#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TitledName {
    pub items: Vec<TitledItem>,
    /// Whether more items matched than `items` lists.
    pub more: bool,
}

/// What `POST /types/normalize` answers, the two definitions it compares.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct NormalizedType {
    #[serde(rename = "type")]
    pub declared: serde_json::Value,
    /// `None` where the instance holds no type of the declared id.
    pub registered_type: Option<serde_json::Value>,
}

impl NormalizedType {
    /// Whether the instance holds the declaration as it stands.
    pub fn is_held(&self) -> bool {
        self.registered_type.as_ref() == Some(&self.declared)
    }
}

/// Sent on every request but the reads of the root and of `/health`, which say which contract a server speaks.
pub const CONTRACT_HEADER: &str = "X-Marfa-Contract";
pub const INSTANCE_HEADER: &str = "X-Marfa-Instance-Id";

fn names_contract(call: &Call) -> bool {
    let describes = call.method == Method::Get
        && (call.segments.iter().all(|segment| segment.is_empty()) || call.segments == ["health"]);
    !describes
}
/// The code, and the expiry reason, of a write another instance refused.
pub const INSTANCE_CHANGED: &str = "instance_changed";

/// A refusal naming no contract is readable: a proxy in front of the server
/// answers without one, and its status is still the truth.
pub fn speaks_contract(expected: u64, contract: Option<&str>, status: u16) -> bool {
    match contract {
        Some(served) => served == expected.to_string(),
        None => !(200..300).contains(&status),
    }
}

pub enum ReplyBody {
    Text(String),
    Stream(Box<dyn Read + Send>),
}

impl Http {
    pub fn new(url: &str, key: &str) -> Result<Http, CoreError> {
        Http::with_timeouts(url, key, RESPONSE_BUDGET, BODY_BUDGET)
    }

    /// `recv_response` bounds the wait for an answer to begin, counted from
    /// when the request has been sent, and `recv_body` the reading of one. A
    /// streamed answer is outside `recv_body`, and an upload's answer outside
    /// both. Sending a body has no budget, so a good upload on a slow link is
    /// not cut off.
    pub fn with_timeouts(
        url: &str,
        key: &str,
        recv_response: Duration,
        recv_body: Duration,
    ) -> Result<Http, CoreError> {
        // The platform trust store, as the binary's own client uses, so a
        // server behind a CA the machine trusts is reachable from both.
        let tls = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let config = direct_when_local(
            Agent::config_builder()
                .tls_config(tls)
                .http_status_as_error(false)
                .max_redirects(0)
                .timeout_connect(Some(Duration::from_secs(10)))
                .timeout_recv_response(Some(recv_response))
                .timeout_recv_body(Some(recv_body)),
            url,
        )
        .build();
        Self::with_connector(url, key, config, DefaultConnector::default)
    }

    /// Reaches the server through a caller-supplied connector, retaining the
    /// contract and response checks. `connector` builds one for the agent of
    /// whole reads and one for each streamed call, so a streamed call reaches
    /// the same place as every other.
    pub fn with_connector<C: Connector>(
        url: &str,
        key: &str,
        config: ureq::config::Config,
        connector: impl Fn() -> C + Send + Sync + 'static,
    ) -> Result<Http, CoreError> {
        let base = base_of(url)?;
        let agent = Agent::with_parts(
            config.clone(),
            connector(),
            ureq::unversioned::resolver::DefaultResolver::default(),
        );
        let stream_agent: StreamAgent = Arc::new(move |deadline| {
            Agent::with_parts(
                config.clone(),
                connector().chain(RefusalDeadline(deadline)),
                ureq::unversioned::resolver::DefaultResolver::default(),
            )
        });
        Ok(Http {
            agent,
            stream_agent,
            base,
            authorization: Arc::new(RwLock::new(format!("Bearer {key}"))),
            renew: Arc::new(OnceLock::new()),
            renewed: Arc::new(OnceLock::new()),
            renewing: Arc::new(Mutex::new(())),
            let_go: Arc::new(AtomicBool::new(false)),
            relocation: Arc::new(OnceLock::new()),
            keeps: None,
            reach: None,
            instance: None,
            call_budget: None,
            stream_wait: None,
            working: None,
            renews: true,
            announces: true,
        })
    }

    /// This transport for streamed calls to a door that does its work before
    /// it answers: they wait up to `wait` for the answer to begin.
    pub fn awaiting(&self, wait: Duration) -> Self {
        Self {
            stream_wait: Some(wait),
            ..self.clone()
        }
    }

    /// This transport for calls that answer only when the server's work is
    /// done: they wait as long as the connection holds, and one that ends
    /// without an answer says the work may still be running, and that
    /// `check` is how to find out.
    pub fn working(&self, check: &str) -> Self {
        Self {
            working: Some(check.to_string()),
            ..self.clone()
        }
    }

    /// This transport for a call that sends a secret the server judges, such
    /// as a password: a `401` is that secret's refusal, so it renews no token
    /// and sends nothing a second time.
    pub fn without_renewal(&self) -> Self {
        Self {
            renews: false,
            ..self.clone()
        }
    }

    pub(crate) fn for_reporting(&self) -> Result<Self, CoreError> {
        if !self.origin_admitted() {
            return Err(CoreError::Canceled);
        }
        // Content owns renewal. A report keeps its outbox on refusal and
        // uses the authorization that content later renews, without delaying
        // watch shutdown on a refresh callback.
        Ok(Self {
            call_budget: Some(Duration::from_secs(2)),
            renew: Arc::new(OnceLock::new()),
            announces: false,
            ..self.clone()
        })
    }

    /// This transport for a read its caller may stop waiting on, which
    /// `let_go` then lets go of without a credential half renewed.
    pub(crate) fn to_let_go(&self) -> Self {
        Self {
            let_go: Arc::new(AtomicBool::new(false)),
            keeps: None,
            ..self.clone()
        }
    }

    /// Starts no request or renewal after this, and returns once a renewal
    /// already under way has finished: a refresh token is spent when the
    /// server answers it, so a process that ended between that answer and
    /// keeping the new one would be signed out. A request already sent runs
    /// to its answer, which nobody reads.
    pub(crate) fn let_go(&self) {
        self.let_go.store(true, Ordering::SeqCst);
        drop(
            self.renewing
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
    }

    pub(crate) fn for_reach(&self, fence: &str) -> Self {
        Self {
            reach: Some(fence.into()),
            ..self.clone()
        }
    }

    /// This transport for writes that name `instance`: every request but a
    /// `GET` carries it.
    pub(crate) fn naming(&self, instance: &str) -> Self {
        Self {
            instance: Some(instance.into()),
            ..self.clone()
        }
    }

    /// What a `GET` of `segments` answers, whole, or `None` where it is
    /// answered `404`.
    pub(crate) fn read_whole(
        &self,
        segments: &[&str],
    ) -> Result<Option<serde_json::Value>, CoreError> {
        match self.get_json::<serde_json::Value>(segments, &[]) {
            Ok(answer) => Ok(Some(answer)),
            Err(CoreError::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn edge(&self, id: &str) -> Result<Option<WireEdge>, CoreError> {
        match self.get_json::<crate::wire::WireEdgeAnswer>(&["edges", id], &[]) {
            Ok(answer) => Ok(Some(answer.edge)),
            Err(CoreError::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Set once; a second is ignored.
    pub fn renew_with(&self, renew: Renew) {
        let _ = self.renew.set(renew);
    }

    /// Set once; a second is ignored.
    pub(crate) fn on_renewed(&self, renewed: Renewed) {
        let _ = self.renewed.set(renewed);
    }

    pub(crate) fn relocating(
        &mut self,
        expected_origin: String,
        expected_instance: Option<String>,
        keep: KeepOrigin,
        keeps: Arc<dyn std::any::Any + Send + Sync>,
    ) {
        self.keeps = Some(keeps);
        let _ = self.relocation.set(Mutex::new(Relocation {
            expected_origin,
            expected_instance,
            keep,
            verified: false,
        }));
    }

    /// Whether this origin is the copy's: the one it records, or one whose
    /// anonymous root `confirm_origin` found serving the copy's instance.
    /// Asks nothing, and answers no while a confirmation is under way.
    pub(crate) fn origin_admitted(&self) -> bool {
        self.relocation.get().is_none_or(|relocation| {
            relocation
                .try_lock()
                .map(|held| held.verified)
                .unwrap_or(false)
        })
    }

    pub(crate) fn confirm_origin(&self) -> Result<(), CoreError> {
        let Some(relocation) = self.relocation.get() else {
            return Ok(());
        };
        let mut relocation = loop {
            self.refuse_if_let_go()?;
            match relocation.try_lock() {
                Ok(held) => break held,
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(CoreError::Store(
                        "the origin confirmation was poisoned".into(),
                    ));
                }
            }
        };
        if relocation.verified {
            return Ok(());
        }
        let wrong = || CoreError::WrongServer {
            expected: relocation.expected_origin.clone(),
            got: self.origin(),
        };
        let Some(expected) = relocation.expected_instance.as_deref() else {
            return Err(wrong());
        };
        let served = self.anonymous_root()?;
        self.refuse_if_let_go()?;
        if served.instance_id != expected {
            return Err(wrong());
        }
        (relocation.keep)(&self.let_go)?;
        relocation.verified = true;
        Ok(())
    }

    /// A read run on a thread of its own, such as a hydration's next page and
    /// the edges past its rows' blocks, may send several requests; once its
    /// caller has let it go, none after the one in flight is sent.
    fn refuse_if_let_go(&self) -> Result<(), CoreError> {
        if self.let_go.load(Ordering::SeqCst) {
            Err(CoreError::Canceled)
        } else {
            Ok(())
        }
    }

    pub(crate) fn authorization(&self) -> String {
        self.authorization
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Only an attributed credential refusal leaves the original `401` as
    /// the answer. Local credential failures have no server verdict.
    fn renewed(&self, sent: &str, before: Before<'_>) -> Result<Option<String>, CoreError> {
        match self.renewal(sent, before) {
            Ok(fresh) => Ok(fresh),
            Err(CoreError::Canceled) => Err(CoreError::Canceled),
            Err(CoreError::Unauthorized { .. }) => Ok(None),
            // `not_answerable` is only the copy's word on a count, which a renewal never is.
            Err(error) if error.kind() == CoreErrorKind::NotAnswerable => {
                Err(CoreError::RenewalFailed(Box::new(CoreError::Invalid(
                    format!("the credential renewal failed: {error}"),
                ))))
            }
            Err(error) => Err(CoreError::RenewalFailed(Box::new(error))),
        }
    }

    fn renewal(&self, sent: &str, before: Before<'_>) -> Result<Option<String>, CoreError> {
        let Some(renew) = self.renew.get() else {
            return Ok(None);
        };
        let _one = self
            .renewing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.let_go.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let current = self.authorization();
        if current != sent {
            return Ok(Some(current));
        }
        // A call that waited here may have been stopped while another
        // renewal ran.
        if let Some(before) = before {
            before(Stage::Renewal)?;
        }
        let renewed = {
            let _lifted = EndsBy::lifted();
            renew(sent.strip_prefix("Bearer ").unwrap_or(sent))?
        };
        let header = format!("Bearer {renewed}");
        self.authorization
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone_from(&header);
        if let Some(renewed) = self.renewed.get() {
            renewed(sent, &header);
        }
        Ok(Some(header))
    }

    fn authorized(
        &self,
        run: impl Fn(&str) -> Result<Response, CoreError>,
    ) -> Result<Response, CoreError> {
        self.authorized_checked(None, run)
    }

    fn authorized_checked(
        &self,
        before: Before<'_>,
        run: impl Fn(&str) -> Result<Response, CoreError>,
    ) -> Result<Response, CoreError> {
        self.confirm_origin()?;
        self.refuse_if_let_go()?;
        if let Some(before) = before {
            before(Stage::Attempt)?;
        }
        let sent = self.authorization();
        let response = run(&sent)?;
        if response.status().as_u16() == 401
            && self.renews
            && header(&response, CONTRACT_HEADER).as_deref()
                == Some(CONTRACT_VERSION.to_string().as_str())
            && !asks_new_sign_in(&response)
        {
            if let Some(before) = before {
                before(Stage::Renewal)?;
            }
            if let Some(fresh) = self.renewed(&sent, before)? {
                self.refuse_if_let_go()?;
                if let Some(before) = before {
                    before(Stage::Attempt)?;
                }
                return run(&fresh);
            }
        }
        Ok(response)
    }

    /// Every refusal the core reads becomes an error here, and the one rule
    /// is that a refusal naming no contract is not the server's: a gateway's
    /// `401` is no word on the key, nor a proxy's `404` on a row.
    pub(crate) fn refused(
        &self,
        status: u16,
        named: bool,
        text: &str,
        retry_after_seconds: Option<u64>,
    ) -> CoreError {
        if named {
            let refused = refusal(status, text, retry_after_seconds);
            if self.reach.is_some() && status == 401 {
                return credential_ended(&refused);
            }
            refused
        } else {
            CoreError::Unnamed {
                origin: self.origin(),
                status,
                retry_after_seconds,
            }
        }
    }

    fn announce_write(&self) {
        if self.announces
            && let Some(hook) = ON_WRITE.get()
        {
            hook(&self.origin());
        }
    }

    /// Identifies a server without identifying a key.
    pub fn origin(&self) -> String {
        origin_of_base(&self.base)
    }

    /// A transport failure, naming the server by scheme, host and port only:
    /// a gateway's path prefix, a key or a token is never in what a person
    /// is shown. A refused connection is its own error, carrying the origin.
    fn unreached(&self, cause: impl std::error::Error + 'static) -> CoreError {
        let origin = self.base.origin().ascii_serialization();
        if connection_refused(&cause) {
            CoreError::ConnectionRefused { origin }
        } else {
            CoreError::Network(format!("request to {origin} failed: {cause}"))
        }
    }

    /// A call that waits on the server's work and ended without an answer.
    /// Only a connection that was never made is a plain failure: any other
    /// end leaves the work possibly running.
    fn unanswered(&self, cause: ureq::Error, check: &str) -> CoreError {
        if matches!(
            cause,
            ureq::Error::Timeout(ureq::Timeout::Resolve | ureq::Timeout::Connect)
        ) || connection_refused(&cause)
        {
            return self.unreached(cause);
        }
        let origin = self.base.origin().ascii_serialization();
        CoreError::Network(format!(
            "no answer from {origin} ({cause}). The server may still be working on this request, so it has not necessarily failed. {check}"
        ))
    }

    /// `GET /items/{id}/tables`, as the server answers it.
    pub(crate) fn item_tables(&self, id: &str) -> Result<serde_json::Value, CoreError> {
        self.get_json(&["items", id, "tables"], &[])
    }

    /// `GET /items/{id}/tables/{table}/rows`, as the server answers it.
    pub(crate) fn table_rows(
        &self,
        id: &str,
        table: &str,
        params: &[(&str, &str)],
        before: Before<'_>,
    ) -> Result<serde_json::Value, CoreError> {
        self.get_json_checked(&["items", id, "tables", table, "rows"], params, before)
    }

    pub(crate) fn table_row(
        &self,
        id: &str,
        table: &str,
        row: &str,
        before: Before<'_>,
    ) -> Result<serde_json::Value, CoreError> {
        self.get_json_checked(&["items", id, "tables", table, "rows", row], &[], before)
    }

    pub(crate) fn table_totals(
        &self,
        id: &str,
        table: &str,
        params: &[(&str, &str)],
        before: Before<'_>,
    ) -> Result<serde_json::Value, CoreError> {
        self.get_json_checked(&["items", id, "tables", table, "totals"], params, before)
    }

    pub fn types(&self) -> Result<Vec<WireType>, CoreError> {
        let page: WirePage<WireType> = self.get_json(&["types"], &[])?;
        self.whole_catalog(page.next_cursor, "type")?;
        Ok(page.data)
    }

    /// The catalogs answer whole: `GET /types` and `GET /edge-types` take no
    /// `cursor`, so a page that names a next one is not this contract, and
    /// reading on from it would drop the rest without saying so.
    fn whole_catalog(&self, next_cursor: Option<String>, what: &str) -> Result<(), CoreError> {
        match next_cursor {
            None => Ok(()),
            Some(_) if self.reach.is_some() => Err(crate::reach::invalid()),
            Some(_) => Err(CoreError::Decoding(format!(
                "the server paged the {what} catalog, which answers whole"
            ))),
        }
    }

    pub fn items_page(
        &self,
        query: &ItemsQuery<'_>,
    ) -> Result<WirePage<WireItemWithMetadata>, CoreError> {
        let limit = ITEM_PAGE_LIMIT.to_string();
        let mut params: Vec<(&str, &str)> = query
            .r#type
            .map(|declared| ("type", declared))
            .into_iter()
            .collect();
        params.push(("tier", query.tier.as_str()));
        match query.narrowing {
            Some(narrowing) => narrowed(&mut params, narrowing),
            None => params.push(("state", "any")),
        }
        params.extend([("include", "edges,metadata"), ("limit", &limit)]);
        if let Some(cursor) = query.cursor {
            params.push(("cursor", cursor));
        }
        self.get_page_json(&params)
    }

    /// Whether the key may list `declared` at `tier`: a one-row listing, so
    /// the answer, not the rows, is what is asked for. It asks for metadata
    /// all the same, since a listing under a reach is refused without it.
    pub fn lists(&self, declared: &str, tier: SliceTier) -> Result<(), CoreError> {
        self.get_json::<serde_json::Value>(
            &["items"],
            &[
                ("type", declared),
                ("tier", tier.as_str()),
                ("state", "any"),
                ("include", "metadata"),
                ("limit", "1"),
            ],
        )
        .map(drop)
    }

    /// `lists` for a listing narrowed by a slice query, `None` naming every
    /// type the key reads.
    pub(crate) fn lists_narrowed(
        &self,
        declared: Option<&str>,
        tier: SliceTier,
        narrowing: &crate::slice::Listing,
    ) -> Result<(), CoreError> {
        let mut params: Vec<(&str, &str)> =
            declared.map(|named| ("type", named)).into_iter().collect();
        params.push(("tier", tier.as_str()));
        narrowed(&mut params, narrowing);
        params.extend([("include", "metadata"), ("limit", "1")]);
        self.get_json::<serde_json::Value>(&["items"], &params)
            .map(drop)
    }

    /// `GET /items/stats?by=type`: the rows at `tier`, counted by type, of
    /// every state or of those `narrowing` names and filters, with
    /// `system.*` counted only where `system` asks for it. The count is not
    /// a conditional read, so a transport under a reach is refused it.
    pub(crate) fn counts_by_type(
        &self,
        tier: SliceTier,
        system: bool,
        narrowing: Option<&crate::slice::Listing>,
    ) -> Result<std::collections::HashMap<String, u64>, CoreError> {
        let mut params = vec![("by", "type"), ("tier", tier.as_str())];
        if system {
            params.push(("include", "system"));
        }
        if let Some(narrowing) = narrowing {
            narrowed(&mut params, narrowing);
        }
        self.get_json(&["items", "stats"], &params)
    }

    /// A page of the bin: `GET /items?state=trashed`, newest binned first,
    /// with each row's tags. `filter` is the listing grammar's.
    pub fn bin_page(
        &self,
        r#type: Option<&str>,
        filter: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<WirePage<WireItemWithMetadata>, CoreError> {
        let limit = limit.to_string();
        let mut params: Vec<(&str, &str)> = vec![
            ("state", "trashed"),
            ("include", "metadata"),
            ("limit", &limit),
        ];
        if let Some(declared) = r#type {
            params.push(("type", declared));
        }
        if let Some(filter) = filter {
            params.push(("filter", filter));
        }
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor));
        }
        self.get_json(&["items"], &params)
    }

    /// The row the server holds in the bin under `id`, which a read by id
    /// answers `404` as it answers a row that is gone (`items/get-missing`).
    pub fn trashed_item(&self, id: &str) -> Result<Option<WireItemWithMetadata>, CoreError> {
        let filter = format!("id eq {}", serde_json::Value::String(id.to_string()));
        Ok(self
            .bin_page(None, Some(&filter), None, 1)?
            .data
            .into_iter()
            .find(|row| row.item.id == id && row.item.state == "trashed"))
    }

    pub fn item_edges_page(
        &self,
        id: &str,
        edge_type: &str,
        cursor: Option<&str>,
    ) -> Result<WirePage<WireEdge>, CoreError> {
        let limit = EDGE_PAGE_LIMIT.to_string();
        let mut params: Vec<(&str, &str)> = vec![("edge_type", edge_type), ("limit", &limit)];
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor));
        }
        self.get_json(&["items", id, "edges"], &params)
    }

    pub fn edges_page(
        &self,
        edge_type: &str,
        cursor: Option<&str>,
    ) -> Result<WirePage<WireEdge>, CoreError> {
        let limit = EDGE_PAGE_LIMIT.to_string();
        let mut params: Vec<(&str, &str)> = vec![("edge_type", edge_type), ("limit", &limit)];
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor));
        }
        self.get_json(&["edges"], &params)
    }

    pub fn edge_types(&self) -> Result<Vec<serde_json::Value>, CoreError> {
        let page: WirePage<serde_json::Value> = self.get_json(&["edge-types"], &[])?;
        for (index, row) in page.data.iter().enumerate() {
            serde_json::from_value::<WireEdgeType>(row.clone()).map_err(|error| {
                if self.reach.is_some() {
                    crate::reach::invalid()
                } else {
                    crate::error::unreadable(
                        &format!("edge type {index} the server listed"),
                        &error,
                    )
                }
            })?;
        }
        self.whole_catalog(page.next_cursor, "edge type")?;
        Ok(page.data)
    }

    /// `POST /items/{id}/purge` at the version the caller read
    /// (`items/purge-version`), so a row that moved since is refused `409`
    /// rather than destroyed.
    pub fn purge_item(&self, id: &str, version: i64) -> Result<(), CoreError> {
        let version = version.to_string();
        let reply = self.call(Call {
            method: Method::Post,
            segments: &["items", id, "purge"],
            params: &[("version", &version)],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        })?;
        if (200..300).contains(&reply.status) {
            return Ok(());
        }
        Err(self.refused(
            reply.status,
            reply.contract.is_some(),
            &reply.body,
            reply.retry_after_seconds,
        ))
    }

    /// Readable on another contract, so a client can identify the server before opening a copy.
    pub fn instance_description(&self) -> Result<crate::InstanceDescription, CoreError> {
        let mut anonymous = self.clone();
        // ureq derives Basic authorization from URL userinfo even without a header.
        let _ = anonymous.base.set_username("");
        let _ = anonymous.base.set_password(None);
        let reply = anonymous.fetch(
            Call {
                method: Method::Get,
                segments: &[""],
                params: &[],
                headers: &[],
                body: CallBody::None,
                credential: false,
                stream: false,
            },
            false,
        )?;
        let ReplyBody::Text(body) = reply.body else {
            return Err(CoreError::Decoding(
                "the root answered with a stream".into(),
            ));
        };
        if !(200..300).contains(&reply.status) {
            return Err(anonymous.refused(
                reply.status,
                reply.contract.is_some(),
                &body,
                reply.retry_after_seconds,
            ));
        }
        let description: crate::InstanceDescription = serde_json::from_str(&body)?;
        if description.instance_id.is_empty() {
            return Err(CoreError::Decoding("the root names no instance".into()));
        }
        Ok(description)
    }

    /// The instance the server says it is, which its root answers to anyone.
    pub fn instance_id(&self) -> Result<String, CoreError> {
        self.served().map(|served| served.instance_id)
    }

    /// What the server's root answers to anyone about the instance.
    pub(crate) fn served(&self) -> Result<Served, CoreError> {
        self.confirm_origin()?;
        self.refuse_if_let_go()?;
        self.anonymous_root()
    }

    fn anonymous_root(&self) -> Result<Served, CoreError> {
        // ureq derives Basic authorization from URL userinfo even when no
        // Authorization header was supplied.
        let mut url = self.url(&[], &[]);
        let _ = url.set_username("");
        let _ = url.set_password(None);
        let global = global_budget(None).map_err(|error| self.unreached(error))?;
        let response = self
            .agent
            .get(url.as_str())
            .header("Accept", "application/json")
            .config()
            .max_redirects(0)
            .timeout_global(global)
            .build()
            .call()
            .map_err(|error| self.unreached(error))?;
        let status = response.status().as_u16();
        self.hold(&response, status, false)?;
        let named = header(&response, CONTRACT_HEADER).is_some();
        let retry_after = retry_after(&response);
        let body = response
            .into_body()
            .read_to_string()
            .map_err(|error| self.unreached(error))?;
        if !(200..300).contains(&status) {
            return Err(if named {
                unconfirmed(refusal(status, &body, retry_after))
            } else {
                CoreError::Unnamed {
                    origin: self.origin(),
                    status,
                    retry_after_seconds: retry_after,
                }
            });
        }
        let root: Served = serde_json::from_str(&body)?;
        if root.instance_id.is_empty() {
            return Err(CoreError::Decoding("the root names no instance".into()));
        }
        Ok(root)
    }

    pub fn catalog(&self) -> Result<WireCatalog, CoreError> {
        Ok(WireCatalog {
            types: self.types()?,
            edge_types: self.edge_types()?,
        })
    }

    /// `POST /items/titles` for at most `TITLE_LOOKUP_NAMES` names: for each,
    /// in the order asked, the active and archived items the key reads whose
    /// folded title is the name's, and whether more than the server lists
    /// matched. The answer is read, not conditional, so it is asked of no
    /// reach.
    pub(crate) fn item_titles(&self, names: &[String]) -> Result<Vec<TitledName>, CoreError> {
        #[derive(serde::Deserialize)]
        struct Answer {
            data: Vec<TitledName>,
        }
        if names.len() > TITLE_LOOKUP_NAMES {
            return Err(CoreError::Invalid(format!(
                "a title lookup takes at most {TITLE_LOOKUP_NAMES} names, not {}",
                names.len()
            )));
        }
        let body = serde_json::json!({ "names": names }).to_string();
        let plain = Self {
            reach: None,
            ..self.clone()
        };
        let answer: Answer = plain.read_json(&["items", "titles"], &[], Some(&body))?;
        if answer.data.len() != names.len() {
            return Err(CoreError::Decoding(format!(
                "/items/titles: {} results for {} names",
                answer.data.len(),
                names.len()
            )));
        }
        Ok(answer.data)
    }

    /// `None` for a credential that is not a key, which that door refuses
    /// `403`.
    pub fn current_key(&self) -> Result<Option<serde_json::Value>, CoreError> {
        match self.get_json::<serde_json::Value>(&["keys", "current"], &[]) {
            Ok(key) => Ok(Some(key)),
            Err(CoreError::Forbidden { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The row with its edges and metadata, or the server's `404` for it.
    pub(crate) fn item_with_edges(
        &self,
        id: &str,
    ) -> Result<ByIdRead<WireItemWithMetadata>, CoreError> {
        match self
            .get_json::<WireItemWithMetadata>(&["items", id], &[("include", "edges,metadata")])
        {
            Ok(item) => Ok(ByIdRead::Row(item)),
            Err(absent @ CoreError::NotFound { .. }) => {
                Ok(ByIdRead::Absent(absent.answer().map(Box::new)))
            }
            Err(error) => Err(error),
        }
    }

    pub fn item(&self, id: &str) -> Result<Option<WireItemWithMetadata>, CoreError> {
        Ok(self.item_answered(id)?.row())
    }

    pub(crate) fn item_checked(
        &self,
        id: &str,
        before: Before<'_>,
    ) -> Result<Option<WireItemWithMetadata>, CoreError> {
        Ok(self.item_answered_checked(id, before)?.row())
    }

    /// `item`, keeping the server's `404` where the row is gone.
    pub(crate) fn item_answered(
        &self,
        id: &str,
    ) -> Result<ByIdRead<WireItemWithMetadata>, CoreError> {
        self.item_answered_checked(id, None)
    }

    fn item_answered_checked(
        &self,
        id: &str,
        before: Before<'_>,
    ) -> Result<ByIdRead<WireItemWithMetadata>, CoreError> {
        match self.get_json_checked::<WireItemWithMetadata>(
            &["items", id],
            &[("include", "metadata")],
            before,
        ) {
            Ok(item) => Ok(ByIdRead::Row(item)),
            Err(absent @ CoreError::NotFound { .. }) => {
                Ok(ByIdRead::Absent(absent.answer().map(Box::new)))
            }
            Err(error) => Err(error),
        }
    }

    /// `POST /items/bulk-get` for at most `BULK_GET_LIMIT` ids, each row with
    /// its metadata, the first page of its edges of each type and, under a
    /// reach, `listed`. It asks for `system` because a pin can name a
    /// `system.*` row, which the door otherwise leaves out
    /// (`items/bulk-get-system`). An id the answer leaves out names no row
    /// the key may read outside the bin (`items/bulk-get-omits`).
    pub(crate) fn items_by_id(
        &self,
        ids: &[String],
    ) -> Result<Vec<WireItemWithMetadata>, CoreError> {
        Ok(self
            .items_by_id_whole(ids)?
            .into_iter()
            .map(|(row, _)| row)
            .collect())
    }

    /// Reads counts for distinct IDs in request order.
    pub(crate) fn item_counts(
        &self,
        ids: &[&String],
        counted: &crate::counts::Counted,
    ) -> Result<Vec<(i64, Option<crate::counts::StatusGroups>)>, CoreError> {
        use crate::counts::Counted;
        let (field, name, linked) = match counted {
            Counted::Backref(name) => ("backref", name, true),
            Counted::Edge(name) => ("edge", name, true),
            Counted::Table(name) => ("table", name, false),
        };
        let mut body = serde_json::Map::new();
        body.insert("ids".into(), serde_json::json!(ids));
        body.insert(field.into(), serde_json::json!(name));
        let body = serde_json::Value::Object(body).to_string();
        let answer: serde_json::Value = self.read_json(&["items", "counts"], &[], Some(&body))?;
        decode_item_counts(&answer, ids, linked)
    }

    /// `POST /items/bulk-get` for at most `BULK_GET_LIMIT` ids, answering only
    /// what each row says of `read_only`.
    pub(crate) fn read_only_of(&self, ids: &[String]) -> Result<Vec<WireReadOnly>, CoreError> {
        #[derive(serde::Deserialize)]
        struct Answer {
            data: Vec<WireReadOnly>,
        }
        let body = serde_json::json!({
            "ids": ids,
            "include": ["system"],
        })
        .to_string();
        let answer: Answer = self.read_json(&["items", "bulk-get"], &[], Some(&body))?;
        Ok(answer.data)
    }

    /// `items_by_id`, with each item as the server wrote it beside it.
    pub(crate) fn items_by_id_whole(
        &self,
        ids: &[String],
    ) -> Result<Vec<(WireItemWithMetadata, serde_json::Value)>, CoreError> {
        #[derive(serde::Deserialize)]
        struct Metadata {
            item_id: String,
            #[serde(default)]
            tags: Vec<String>,
        }
        #[derive(serde::Deserialize)]
        struct Answer {
            data: Vec<serde_json::Value>,
            metadata: Vec<Metadata>,
            #[serde(default)]
            listed: Option<Vec<bool>>,
        }
        if ids.len() > BULK_GET_LIMIT {
            return Err(CoreError::Invalid(format!(
                "a bulk read takes at most {BULK_GET_LIMIT} ids, not {}",
                ids.len()
            )));
        }
        let body = serde_json::json!({
            "ids": ids,
            "include": ["edges", "metadata", "system"],
        })
        .to_string();
        let answer: Answer = self.read_json(&["items", "bulk-get"], &[], Some(&body))?;
        let unreadable = |why: &str| {
            if self.reach.is_some() {
                crate::reach::invalid()
            } else {
                CoreError::Decoding(format!("/items/bulk-get: {why}"))
            }
        };
        let answered = answer.data.len();
        if answer.metadata.len() != answered {
            return Err(unreadable("the metadata does not pair with the items"));
        }
        let listed = match answer.listed {
            Some(listed) if listed.len() == answered => listed.into_iter().map(Some).collect(),
            Some(_) => return Err(unreadable("`listed` does not pair with the items")),
            None if self.reach.is_some() => return Err(unreadable("no `listed` under a reach")),
            None => vec![None; answered],
        };
        let mut seen = std::collections::HashSet::new();
        let mut rows = Vec::with_capacity(answered);
        for ((whole, metadata), listed) in answer.data.into_iter().zip(answer.metadata).zip(listed)
        {
            let item = serde_json::from_value::<WireItem>(whole.clone())
                .map_err(|error| unreadable(&error.to_string()))?;
            if !ids.contains(&item.id) || !seen.insert(item.id.clone()) {
                return Err(unreadable(
                    "an item the request did not name, or named twice",
                ));
            }
            if metadata.item_id != item.id {
                return Err(unreadable("the metadata does not pair with the items"));
            }
            rows.push((
                WireItemWithMetadata {
                    listed,
                    item,
                    metadata: WireMetadata {
                        tags: metadata.tags,
                    },
                },
                whole,
            ));
        }
        Ok(rows)
    }

    /// Which of `source_ids` under `source` name a row on the server, in any
    /// state, by `POST /items/lookup`. A row of a type the credential may not
    /// read, and a `system.*` row, are left out of the answer
    /// (`search-and-filters/lookup-unreadable-left-out` and
    /// `search-and-filters/lookup-system-left-out`).
    pub(crate) fn keys_held(
        &self,
        r#type: &str,
        source: &str,
        source_ids: &[String],
    ) -> Result<std::collections::HashSet<String>, CoreError> {
        #[derive(serde::Deserialize)]
        struct Found {
            source: Option<String>,
            source_id: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Answer {
            data: Vec<Found>,
        }
        if source_ids.len() > LOOKUP_LIMIT {
            return Err(CoreError::Invalid(format!(
                "a lookup takes at most {LOOKUP_LIMIT} keys, not {}",
                source_ids.len()
            )));
        }
        let body = serde_json::json!({
            "type": r#type,
            "source": source,
            "source_ids": source_ids,
        })
        .to_string();
        let answer: Answer = self.read_json(&["items", "lookup"], &[], Some(&body))?;
        Ok(answer
            .data
            .into_iter()
            .filter(|found| found.source.as_deref() == Some(source))
            .filter_map(|found| found.source_id)
            .collect())
    }

    /// Redirects, contract mismatches, transport or renewal failures and a
    /// refusal from another instance than the one named are errors. Other
    /// responses retain their status and code together for the drain to
    /// classify; `refusal()` drops the status.
    pub fn send(&self, outgoing: &Outgoing<'_>) -> Result<Answer, CoreError> {
        self.write(outgoing, Some(outgoing.idempotency_key))
    }

    /// A page of writes to a bulk door, which takes no `Idempotency-Key`
    /// (`items/idempotency-operations`), answered as `send` answers one.
    pub(crate) fn send_page(&self, segments: &[&str], body: &str) -> Result<Answer, CoreError> {
        self.write(
            &Outgoing {
                method: Method::Post,
                segments: segments.iter().map(|segment| segment.to_string()).collect(),
                params: Vec::new(),
                body,
                idempotency_key: "",
            },
            None,
        )
    }

    fn write(&self, outgoing: &Outgoing<'_>, key: Option<&str>) -> Result<Answer, CoreError> {
        self.announce_write();
        let segments: Vec<&str> = outgoing.segments.iter().map(String::as_str).collect();
        let params: Vec<(&str, &str)> = outgoing
            .params
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let url = self.url(&segments, &params);
        // Not the agent's per-method builders: those split at the type level
        // on whether a method carries a body, which would mean one header
        // list per method.
        let response = self.authorized(|authorization| {
            let mut request = ureq::http::Request::builder()
                .method(outgoing.method.as_str())
                .uri(url.as_str())
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header(CONTRACT_HEADER, CONTRACT_VERSION.to_string())
                .header("Authorization", authorization);
            if let Some(key) = key {
                request = request.header("Idempotency-Key", key);
            }
            if let Some(instance) = &self.instance {
                request = request.header(INSTANCE_HEADER, instance);
            }
            let request = request.body(outgoing.body).map_err(|error| {
                CoreError::Invalid(format!("this write cannot be sent: {error}"))
            })?;
            let global = global_budget(None).map_err(|error| self.unreached(error))?;
            self.agent
                .run(
                    self.agent
                        .configure_request(request)
                        .timeout_global(global)
                        .build(),
                )
                .map_err(|error| self.unreached(error))
        })?;
        let status = response.status().as_u16();
        self.hold(&response, status, true)?;
        let contract_named = header(&response, CONTRACT_HEADER).is_some();
        let retry_after_seconds = retry_after(&response);
        let replayed = response
            .headers()
            .get("Idempotency-Replayed")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        // A body that will not read is a transport failure, not an answer,
        // but for a `413`: the server closes that connection as it answers,
        // and the status alone says what it refused.
        let body = match self.whole(response.into_body()) {
            Err(_) if status == 413 && contract_named => {
                r#"{"error":{"code":"request_too_large"}}"#.to_string()
            }
            body => body?,
        };
        let code = match serde_json::from_str::<WireErrorEnvelope>(&body) {
            Ok(envelope) => envelope.error.code,
            Err(_) => String::new(),
        };
        let answer = Answer {
            status,
            code,
            body,
            retry_after_seconds,
            replayed,
            contract_named,
        };
        // Not the write's answer: the instance that gave it never had the
        // rows the write was made against.
        if answer.instance_changed() {
            return Err(answer.instance_changed_error());
        }
        Ok(answer)
    }

    /// Registers a type the app declared, as `POST /types` takes one. A type
    /// the instance holds already is held, whatever its shape: the caller
    /// compares it with `normalized_type` and replaces it with
    /// `replace_type`. A refusal the server names is the answer, where one
    /// that names no contract, or a failure to reach it, is an error the
    /// caller can try again.
    pub fn register_type(&self, definition: &str) -> Result<Registration, CoreError> {
        let reply = self.call(Call {
            method: Method::Post,
            segments: &["types"],
            params: &[],
            headers: &[],
            body: CallBody::Json(definition),
            credential: true,
            stream: false,
        })?;
        if (200..300).contains(&reply.status) {
            return Ok(Registration::Registered);
        }
        let refused = self.refused(
            reply.status,
            reply.contract.is_some(),
            &reply.body,
            reply.retry_after_seconds,
        );
        if matches!(
            &refused,
            CoreError::Server { status: 409, code, .. } if code == "type_exists"
        ) {
            return Ok(Registration::Held);
        }
        let (code, message) = Self::type_refusal(refused)?;
        Ok(Registration::Refused { code, message })
    }

    /// Replaces a registered type with the app's declaration, as
    /// `PUT /types/{id}` takes one. A refusal the server names leaves the
    /// type as the server holds it and is the answer; one that names no
    /// contract, or a failure to reach the server, is an error the caller can
    /// try again.
    pub fn replace_type(&self, id: &str, definition: &str) -> Result<Replacement, CoreError> {
        let reply = self.call(Call {
            method: Method::Put,
            segments: &["types", id],
            params: &[],
            headers: &[],
            body: CallBody::Json(definition),
            credential: true,
            stream: false,
        })?;
        if (200..300).contains(&reply.status) {
            return Ok(Replacement::Replaced);
        }
        let (code, message) = Self::type_refusal(self.refused(
            reply.status,
            reply.contract.is_some(),
            &reply.body,
            reply.retry_after_seconds,
        ))?;
        Ok(Replacement::Refused { code, message })
    }

    /// `POST /types/normalize`: a declaration and the registered type of its
    /// id, each as the server normalizes it, so that two definitions which
    /// mean the same compare equal. A read sent as a `POST`, asked of no
    /// reach.
    pub fn normalized_type(&self, definition: &str) -> Result<NormalizedType, CoreError> {
        let plain = Self {
            reach: None,
            ..self.clone()
        };
        plain.read_json(&["types", "normalize"], &[], Some(definition))
    }

    /// The code and message of a refusal the server named, or the error the
    /// caller can try again: a server that failed or asked to be tried later
    /// has not refused the type.
    fn type_refusal(refused: CoreError) -> Result<(String, String), CoreError> {
        match refused {
            error if error.is_environmental() => Err(error),
            CoreError::Validation { code, message, .. }
            | CoreError::Forbidden { code, message, .. }
            | CoreError::NotFound { code, message, .. }
            | CoreError::Server { code, message, .. } => Ok((code, message)),
            other => Err(other),
        }
    }

    pub fn open_events(
        &self,
        last_event_id: Option<&str>,
        body_timeout: Duration,
    ) -> Result<Box<dyn Read + Send>, CoreError> {
        let url = self.url(&["events"], &[("edges", "all"), ("copy", "true")]);
        let response = self.authorized(|authorization| {
            let global = global_budget(None).map_err(|error| self.unreached(error))?;
            let mut request = self
                .agent
                .get(url.as_str())
                .header("Accept", "text/event-stream")
                .header(CONTRACT_HEADER, CONTRACT_VERSION.to_string())
                .config()
                .timeout_recv_body(Some(body_timeout))
                .timeout_global(global)
                .build()
                .header("Authorization", authorization);
            if let Some(cursor) = last_event_id {
                request = request.header("Last-Event-ID", cursor);
                if let Some(reach) = &self.reach {
                    request = request.header("X-Marfa-Reach", reach);
                }
            }
            request.call().map_err(|error| self.unreached(error))
        })?;
        let status = response.status().as_u16();
        self.hold(&response, status, false)?;
        if !(200..300).contains(&status) {
            let named = header(&response, CONTRACT_HEADER).is_some();
            let retry_after = retry_after(&response);
            let text = response.into_body().read_to_string().unwrap_or_default();
            if status == 401 && named {
                return Err(credential_ended(&refusal(status, &text, retry_after)));
            }
            return Err(self.refused(status, named, &text, retry_after));
        }
        Ok(Box::new(response.into_body().into_reader()))
    }

    /// A call refused `401` is sent again under a renewed credential, except
    /// one whose body is a reader, which the first send spent: the credential
    /// is renewed for the calls after it, and its caller sends it again.
    /// Every answer is read whole, a streamed call's included.
    pub fn call(&self, mut call: Call<'_>) -> Result<Reply<String>, CoreError> {
        call.stream = false;
        if call.credential && call.method != Method::Get {
            self.announce_write();
        }
        let reply = self.fetch(call, true)?;
        let body = match reply.body {
            ReplyBody::Text(text) => text,
            ReplyBody::Stream(mut reader) => {
                let mut text = String::new();
                reader
                    .read_to_string(&mut text)
                    .map_err(|error| self.unreached(error))?;
                text
            }
        };
        Ok(Reply {
            status: reply.status,
            content_type: reply.content_type,
            retry_after_seconds: reply.retry_after_seconds,
            contract: reply.contract,
            location: reply.location,
            body,
        })
    }

    /// `call`, with a streamed call's success handed back as a reader, and
    /// with `held` false for the one read that must see an answer on another
    /// contract: the root and the health door are what say a server speaks
    /// one. A redirect is an error either way. Every other door is read held,
    /// so an answer this build cannot read is never decoded.
    pub fn fetch(&self, call: Call<'_>, held: bool) -> Result<Reply, CoreError> {
        self.confirm_origin()?;
        self.refuse_if_let_go()?;
        let url = self.url(call.segments, call.params);
        let json = matches!(call.body, CallBody::Json(_));
        let deadline = Arc::new(RwLock::new(None));
        let budget = if call.stream {
            Budget::Stream(Arc::clone(&deadline))
        } else if matches!(call.body, CallBody::Reader(_)) {
            Budget::Upload
        } else if self.working.is_some() {
            Budget::Working
        } else {
            Budget::Whole
        };
        let names_contract = names_contract(&call);
        let builder = |authorization: Option<&str>| {
            let mut builder = ureq::http::Request::builder()
                .method(call.method.as_str())
                .uri(url.as_str())
                .header(
                    "Accept",
                    if call.stream {
                        "*/*"
                    } else {
                        "application/json"
                    },
                );
            if let Some(authorization) = authorization {
                builder = builder.header("Authorization", authorization);
            }
            if json {
                builder = builder.header("Content-Type", "application/json");
            }
            if names_contract {
                builder = builder.header(CONTRACT_HEADER, CONTRACT_VERSION.to_string());
            }
            if let Some(instance) = self
                .instance
                .as_deref()
                .filter(|_| call.credential && call.method != Method::Get)
            {
                builder = builder.header(INSTANCE_HEADER, instance);
            }
            for (name, value) in call.headers {
                builder = builder.header(*name, *value);
            }
            builder
        };
        let cannot_send = |error: ureq::http::Error| {
            CoreError::Invalid(format!("this call cannot be sent: {error}"))
        };
        let waits = matches!(budget, Budget::Working);
        let network = |error: ureq::Error| match &self.working {
            Some(check) if waits => self.unanswered(error, check),
            _ => self.unreached(error),
        };
        let send = |authorization: Option<&str>, text: Option<&str>| {
            let builder = builder(authorization);
            match text {
                Some(text) => {
                    self.dispatch(builder.body(text).map_err(cannot_send)?, budget.clone())
                }
                None => self.dispatch(builder.body(()).map_err(cannot_send)?, budget.clone()),
            }
            .map_err(network)
        };
        let text = match &call.body {
            CallBody::None => None,
            CallBody::Json(text) | CallBody::Text(text) => Some(*text),
            CallBody::Reader(_) => None,
        };
        let response = match call.body {
            CallBody::Reader(reader) => {
                let sent = call.credential.then(|| self.authorization());
                let response = self
                    .dispatch(
                        builder(sent.as_deref())
                            .body(ureq::SendBody::from_owned_reader(reader))
                            .map_err(cannot_send)?,
                        budget,
                    )
                    .map_err(network)?;
                // The reader is spent, so the caller sends again, with a
                // reader it opens afresh, once the credential is renewed.
                if let Some(sent) = &sent
                    && response.status().as_u16() == 401
                    && header(&response, CONTRACT_HEADER).as_deref()
                        == Some(CONTRACT_VERSION.to_string().as_str())
                {
                    self.renewed(sent, None)?;
                }
                response
            }
            _ if call.credential => {
                self.authorized(|authorization| send(Some(authorization), text))?
            }
            _ => send(None, text)?,
        };
        let status = response.status().as_u16();
        let write_sent = call.method != Method::Get;
        if held {
            self.hold(&response, status, write_sent)?;
        } else {
            self.refuse_redirect(&response, status)?;
        }
        let retry_after_seconds = retry_after(&response);
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let contract = header(&response, CONTRACT_HEADER);
        let location = header(&response, "Location");
        if call.stream && !(200..300).contains(&status) {
            let duration = self
                .agent
                .config()
                .timeouts()
                .recv_body
                .unwrap_or(BODY_BUDGET);
            *deadline.write().expect("refusal deadline lock") =
                Some(std::time::Instant::now() + duration);
        }
        // A refusal is read whole even on a streamed call, so its envelope
        // reaches the classification.
        let body = if call.stream && (200..300).contains(&status) {
            ReplyBody::Stream(Box::new(response.into_body().into_reader()))
        } else {
            ReplyBody::Text(self.whole(response.into_body())?)
        };
        Ok(Reply {
            status,
            content_type,
            retry_after_seconds,
            contract,
            location,
            body,
        })
    }

    /// The agent's budgets are for an answer read whole. A streamed answer
    /// lasts as long as the server keeps it, and a caller that must not wait
    /// on a stream gone silent bounds its reads itself. An upload's answer
    /// waits on the server's work.
    fn dispatch<S: ureq::AsSendBody>(
        &self,
        request: ureq::http::Request<S>,
        budget: Budget,
    ) -> Result<Response, ureq::Error> {
        match budget {
            Budget::Whole => self.agent.run(
                self.agent
                    .configure_request(request)
                    .timeout_global(global_budget(self.call_budget)?)
                    .build(),
            ),
            Budget::Stream(deadline) => {
                let agent = (self.stream_agent)(deadline);
                let mut configured = agent
                    .configure_request(request)
                    .timeout_recv_body(None)
                    .timeout_global(global_budget(None)?);
                if let Some(wait) = self.stream_wait {
                    configured = configured.timeout_recv_response(Some(wait));
                }
                agent.run(configured.build())
            }
            Budget::Working => self.agent.run(
                self.agent
                    .configure_request(request)
                    .timeout_recv_response(None)
                    .timeout_global(global_budget(None)?)
                    .build(),
            ),
            Budget::Upload => self.agent.run(
                self.agent
                    .configure_request(request)
                    .timeout_recv_response(None)
                    .timeout_recv_body(None)
                    .timeout_await_100(Some(AWAIT_100))
                    .timeout_global(global_budget(None)?)
                    .build(),
            ),
        }
    }

    /// A redirect is never followed, since a followed one could carry the
    /// credential to another host, and is refused whole.
    fn refuse_redirect<B>(
        &self,
        response: &ureq::http::Response<B>,
        status: u16,
    ) -> Result<(), CoreError> {
        if (300..400).contains(&status) {
            return Err(CoreError::Redirected {
                origin: self.origin(),
                status,
                location: header(response, "Location"),
            });
        }
        Ok(())
    }

    /// Runs before anything reads the body. A write refused here was sent.
    fn hold<B>(
        &self,
        response: &ureq::http::Response<B>,
        status: u16,
        write_sent: bool,
    ) -> Result<(), CoreError> {
        self.refuse_redirect(response, status)?;
        let served = header(response, CONTRACT_HEADER);
        if speaks_contract(CONTRACT_VERSION, served.as_deref(), status) {
            return Ok(());
        }
        // The server's own refusal of the contract names its code in a
        // header, so it is told apart without waiting on the body.
        let declined = status == 412
            && header(response, "X-Error-Code").as_deref() == Some("contract_mismatch");
        Err(CoreError::ContractMismatch {
            origin: self.origin(),
            served,
            expected: CONTRACT_VERSION,
            status: Some(status),
            write_sent: write_sent && !declined,
            refusal: if declined {
                ContractRefusal::Declined
            } else {
                ContractRefusal::Unread
            },
        })
    }

    fn url(&self, segments: &[&str], params: &[(&str, &str)]) -> Url {
        let mut url = self.base.clone();
        {
            let mut path = url.path_segments_mut().expect("a server url has a path");
            path.pop_if_empty();
            path.extend(segments);
        }
        if !params.is_empty() {
            let mut query = url.query_pairs_mut();
            for (key, value) in params {
                query.append_pair(key, value);
            }
        }
        url
    }

    fn get_json<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        params: &[(&str, &str)],
    ) -> Result<T, CoreError> {
        self.get_json_checked(segments, params, None)
    }

    fn get_json_checked<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        params: &[(&str, &str)],
        before: Before<'_>,
    ) -> Result<T, CoreError> {
        self.read_json_within(segments, params, None, None, before)
    }

    /// The time a page of `ITEM_PAGE_LIMIT` rows may take to arrive: this
    /// connection's body budget, set for `ROWS_PER_BODY_BUDGET` rows, scaled
    /// to the page.
    fn page_budget(&self) -> Option<Duration> {
        self.agent
            .config()
            .timeouts()
            .recv_body
            .map(|budget| budget * ITEM_PAGE_LIMIT / ROWS_PER_BODY_BUDGET)
    }

    /// `get_json` for a page of the item listing, given `page_budget`.
    fn get_page_json<T: DeserializeOwned>(&self, params: &[(&str, &str)]) -> Result<T, CoreError> {
        self.read_json_within(&["items"], params, None, self.page_budget(), None)
    }

    /// A read, sent as a `GET`, or as a `POST` of `body` for a read whose
    /// question is a body. Under a reach it is a conditional read: the
    /// answer has to carry the reach back.
    fn read_json<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        params: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<T, CoreError> {
        self.read_json_within(segments, params, body, None, None)
    }

    /// `read_json`, with `budget` in place of the connection's body budget.
    fn read_json_within<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        params: &[(&str, &str)],
        body: Option<&str>,
        budget: Option<Duration>,
        before: Before<'_>,
    ) -> Result<T, CoreError> {
        let url = self.url(segments, params);
        let conditional = self.reach.as_deref().filter(|_| !segments.is_empty());
        // The server refuses a listing under a reach that does not ask for
        // metadata, so a request that forgets it fails only for a bound
        // credential, which most tests do not hold.
        debug_assert!(
            conditional.is_none()
                || body.is_some()
                || segments != ["items"]
                || params.iter().any(|(name, value)| *name == "include"
                    && value.split(',').any(|part| part.trim() == "metadata")),
            "a listing under a reach asks for include=metadata: {params:?}"
        );
        let response = self.authorized_checked(before, |authorization| {
            let global = global_budget(None).map_err(|error| self.unreached(error))?;
            let sent = match body {
                None => {
                    let mut request = self
                        .agent
                        .get(url.as_str())
                        .header("Accept", "application/json")
                        .header(CONTRACT_HEADER, CONTRACT_VERSION.to_string())
                        .header("Authorization", authorization);
                    if let Some(reach) = conditional {
                        request = request.header("X-Marfa-Reach", reach);
                    }
                    request
                        .config()
                        .timeout_recv_body(budget.or(self.agent.config().timeouts().recv_body))
                        .timeout_global(global)
                        .build()
                        .call()
                }
                Some(body) => {
                    let mut request = self
                        .agent
                        .post(url.as_str())
                        .header("Accept", "application/json")
                        .header("Content-Type", "application/json")
                        .header(CONTRACT_HEADER, CONTRACT_VERSION.to_string())
                        .header("Authorization", authorization);
                    if let Some(reach) = conditional {
                        request = request.header("X-Marfa-Reach", reach);
                    }
                    if let Some(instance) = &self.instance {
                        request = request.header(INSTANCE_HEADER, instance);
                    }
                    request.config().timeout_global(global).build().send(body)
                }
            };
            sent.map_err(|error| self.unreached(error))
        })?;
        let status = response.status().as_u16();
        self.hold(&response, status, false)?;
        let named = header(&response, CONTRACT_HEADER).is_some();
        let retry_after = retry_after(&response);
        let proof = response
            .headers()
            .get_all("X-Marfa-Reach")
            .iter()
            .collect::<Vec<_>>();
        let certified = conditional
            .is_none_or(|expected| proof.len() == 1 && proof[0].to_str().ok() == Some(expected));
        let text = self.whole(response.into_body())?;
        if !(200..300).contains(&status) {
            let error = self.refused(status, named, &text, retry_after);
            if conditional.is_some() && named && matches!(status, 403 | 404) && !certified {
                return Err(crate::reach::invalid());
            }
            return Err(error);
        }
        if !certified {
            return Err(crate::reach::invalid());
        }
        // A body that does not parse as JSON says nothing against the copy's
        // reach, and reading it again fails the same way. A body that
        // parses and does not fit what a certified answer carries is a proof
        // the copy cannot accept.
        if conditional.is_none() {
            return serde_json::from_str(&text)
                .map_err(|error| crate::error::unreadable(url.path(), &error));
        }
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|error| crate::error::unreadable(url.path(), &error))?;
        if body.is_none()
            && segments.first() == Some(&"items")
            && (segments.len() == 1 || segments.len() == 2)
        {
            let valid =
                |row: &serde_json::Value| row.get("listed").and_then(|v| v.as_bool()).is_some();
            if segments.len() == 1 {
                if !value
                    .get("data")
                    .and_then(|v| v.as_array())
                    .is_some_and(|rows| rows.iter().all(|row| valid(row) && row["listed"] == true))
                {
                    return Err(crate::reach::invalid());
                }
            } else if !valid(&value) {
                return Err(crate::reach::invalid());
            }
        }
        serde_json::from_value(value).map_err(|_| crate::reach::invalid())
    }
}

impl Http {
    /// An answer read whole, past ureq's default 10 MiB, which a page of 500
    /// rows, a bulk read of 100 or an export can pass. A text answer that is
    /// not UTF-8, such as a proxy's page, is read with its bad bytes
    /// replaced, so its status still reaches the caller; JSON is read
    /// strictly. The body budget still bounds how long the read may take.
    fn whole(&self, body: ureq::Body) -> Result<String, CoreError> {
        body.into_with_config()
            .limit(u64::MAX)
            .lossy_utf8(true)
            .read_to_string()
            .map_err(|error| self.unreached(error))
    }
}

/// RFC 9470: a renewed token keeps the sign-in it came from, so renewing cannot meet this.
fn asks_new_sign_in<B>(response: &ureq::http::Response<B>) -> bool {
    header(response, "www-authenticate")
        .is_some_and(|challenge| challenge.contains("insufficient_user_authentication"))
}

fn header<B>(response: &ureq::http::Response<B>, name: &str) -> Option<String> {
    header_value(
        response
            .headers()
            .get_all(name)
            .iter()
            .map(|value| value.as_bytes()),
    )
}

/// Lines that disagree are joined, so the value matches none of them: an
/// answer naming its contract as both `1` and `2` speaks neither, and its
/// first line alone is whichever a proxy happened to put first.
pub fn header_value<'a>(lines: impl IntoIterator<Item = &'a [u8]>) -> Option<String> {
    let mut values: Vec<String> = Vec::new();
    for line in lines {
        let value = String::from_utf8_lossy(line).into_owned();
        if !values.contains(&value) {
            values.push(value);
        }
    }
    if values.is_empty() {
        None
    } else {
        Some(values.join(" and "))
    }
}

/// RFC 9110 allows a count of seconds or an HTTP-date. The date form is read
/// against the response's own `Date` header where it has one, so a local
/// clock that disagrees with the server's does not turn a short wait into a
/// long one.
fn retry_after<B>(response: &ureq::http::Response<B>) -> Option<u64> {
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    retry_after_seconds(header("Retry-After"), header("Date"))
}

pub fn retry_after_seconds(retry_after: Option<&str>, date: Option<&str>) -> Option<u64> {
    let raw = retry_after?.trim();
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(seconds);
    }
    let until = http_date(raw)?;
    let from = date.and_then(http_date).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_secs() as i64)
            .unwrap_or(0)
    });
    Some(until.saturating_sub(from).max(0) as u64)
}

/// Only the IMF-fixdate form RFC 9110 requires a sender to produce; the two
/// obsolete forms are not parsed. An unreadable header is absent rather than
/// zero, because a wait of zero is a device asking again at once.
fn http_date(raw: &str) -> Option<i64> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let number = |text: &str, most: usize| -> Option<i64> {
        (!text.is_empty() && text.len() <= most && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
    };
    let day = number(parts[1], 2)?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| *name == parts[2])? as i64
        + 1;
    let year = number(parts[3], 4)?;
    let clock: Vec<&str> = parts[4].split(':').collect();
    if clock.len() != 3 {
        return None;
    }
    let (hour, minute, second) = (
        number(clock[0], 2)?,
        number(clock[1], 2)?,
        number(clock[2], 2)?,
    );
    let days = marfa_rules::time::days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// What a device reads from the root each time it confirms the instance.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct Served {
    pub instance_id: String,
    /// `None` from a server that publishes no limit, or none a device can use,
    /// which says nothing of what it takes.
    #[serde(default, deserialize_with = "published_limit")]
    pub max_request_bytes: Option<usize>,
}

fn published_limit<'de, D: serde::Deserializer<'de>>(from: D) -> Result<Option<usize>, D::Error> {
    let value = <Option<serde_json::Value> as serde::Deserialize>::deserialize(from)?;
    Ok(value
        .and_then(|value| value.as_u64())
        .filter(|limit| *limit > 0)
        .and_then(|limit| usize::try_from(limit).ok()))
}

/// A missing root cannot establish that an item is absent.
fn unconfirmed(error: CoreError) -> CoreError {
    match error {
        CoreError::NotFound {
            code,
            message,
            server,
        } => CoreError::Server {
            status: 404,
            code,
            message,
            details: server.and_then(|answer| answer.details).map(Box::new),
        },
        other => other,
    }
}

/// Only for an answer that names the server's contract.
fn refusal(status: u16, text: &str, retry_after_seconds: Option<u64>) -> CoreError {
    let (code, message, details, read) = match serde_json::from_str::<WireErrorEnvelope>(text) {
        Ok(envelope) => (
            envelope.error.code,
            envelope.error.message.unwrap_or_default(),
            envelope.error.details,
            true,
        ),
        Err(_) => (
            crate::error::UNREAD_CODE.to_string(),
            text.chars().take(200).collect(),
            None,
            false,
        ),
    };
    let server = Some(Box::new(ServerAnswer {
        status,
        code: read.then(|| code.clone()),
        details: details.clone(),
    }));
    match status {
        409 if code == "reach_changed" => CoreError::CopyExpired {
            reason: "reach_changed".into(),
            server,
        },
        409 if code == INSTANCE_CHANGED => CoreError::CopyExpired {
            reason: INSTANCE_CHANGED.into(),
            server,
        },
        400 if code == "unknown_type" => CoreError::UnknownType { message, server },
        400 | 422 => CoreError::Validation {
            code,
            message,
            details: None,
            server,
        },
        401 => CoreError::Unauthorized {
            code,
            message,
            server,
        },
        403 => CoreError::Forbidden {
            code,
            message,
            server,
        },
        404 => CoreError::NotFound {
            code,
            message,
            server,
        },
        429 => CoreError::RateLimited {
            code,
            message,
            retry_after_seconds,
            details: details.map(Box::new),
        },
        _ => CoreError::Server {
            status,
            code,
            message,
            details: details.map(Box::new),
        },
    }
}

/// The copy's credential ended, said by the server's own `401`.
fn credential_ended(refused: &CoreError) -> CoreError {
    CoreError::CopyExpired {
        reason: "credential_ended".into(),
        server: refused.answer().map(Box::new),
    }
}

/// Members the device does not know are ignored; anything else off the declared shape is refused.
fn decode_item_counts(
    answer: &serde_json::Value,
    ids: &[&String],
    linked: bool,
) -> Result<Vec<(i64, Option<crate::counts::StatusGroups>)>, CoreError> {
    let wrong = |what: &str| CoreError::Decoding(format!("the server's counts {what}"));
    let counts = answer
        .as_object()
        .and_then(|answer| answer.get("counts"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| wrong("are not an object holding a list of counts"))?;
    if counts.len() != ids.len() {
        return Err(wrong(
            "are not the asked ids, once each and in the order asked",
        ));
    }
    let number = |count: &serde_json::Map<String, serde_json::Value>, name: &str| {
        count
            .get(name)
            .and_then(serde_json::Value::as_i64)
            .filter(|number| *number >= 0)
            .ok_or_else(|| {
                wrong(&format!(
                    "do not give `{name}` as a whole number of zero or more"
                ))
            })
    };
    counts
        .iter()
        .zip(ids)
        .map(|(count, id)| {
            let count = count
                .as_object()
                .ok_or_else(|| wrong("hold a count that is not an object"))?;
            if count.get("id").and_then(serde_json::Value::as_str) != Some(id.as_str()) {
                return Err(wrong(
                    "are not the asked ids, once each and in the order asked",
                ));
            }
            let total = number(count, "total")?;
            let groups = match (linked, count.get("status_groups")) {
                (false, None) => None,
                (false, Some(_)) => return Err(wrong("of rows carry status groups")),
                (true, None) => return Err(wrong("of links carry no status groups")),
                (true, Some(groups)) => {
                    let groups = groups
                        .as_object()
                        .ok_or_else(|| wrong("give status groups that are not an object"))?;
                    let groups = crate::counts::StatusGroups {
                        not_started: number(groups, "not_started")?,
                        in_progress: number(groups, "in_progress")?,
                        completed: number(groups, "completed")?,
                        canceled: number(groups, "canceled")?,
                    };
                    let grouped = [
                        groups.not_started,
                        groups.in_progress,
                        groups.completed,
                        groups.canceled,
                    ]
                    .iter()
                    .try_fold(0_i64, |sum, group| sum.checked_add(*group));
                    if grouped.is_none_or(|grouped| grouped > total) {
                        return Err(wrong("give status groups that sum to more than the total"));
                    }
                    Some(groups)
                }
            };
            Ok((total, groups))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether the server answers this write, sent again under its key, from
    /// its record of the first: its operation takes an `Idempotency-Key` in the
    /// document the server is described by. A drain lets go at a stop of every
    /// write it sends, so each door it sends to has to be one.
    fn answered_by_key(method: Method, segments: &[String]) -> bool {
        crate::contract::KEYED_WRITES
            .iter()
            .any(|(keyed, template)| {
                let parts: Vec<&str> = template.trim_start_matches('/').split('/').collect();
                *keyed == method.as_str()
                    && parts.len() == segments.len()
                    && parts.iter().zip(segments).all(|(part, segment)| {
                        (part.starts_with('{') && part.ends_with('}')) || part == segment
                    })
            })
    }

    fn call<'a>(method: Method, segments: &'a [&'a str]) -> Call<'a> {
        Call {
            method,
            segments,
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        }
    }

    #[test]
    fn a_call_names_its_contract_except_a_read_of_the_root_or_of_health() {
        for (method, segments) in [
            (Method::Get, vec!["items"]),
            (Method::Get, vec!["health", "x"]),
            (Method::Post, vec![""]),
            (Method::Post, vec!["health"]),
            (Method::Post, vec!["items"]),
        ] {
            assert!(
                names_contract(&call(method, &segments)),
                "{method:?} {segments:?}"
            );
        }
        for segments in [vec![], vec![""], vec!["health"]] {
            assert!(
                !names_contract(&call(Method::Get, &segments)),
                "{segments:?}"
            );
        }
    }

    #[test]
    fn every_door_a_drain_sends_to_takes_a_key() {
        let keyed = |method, path: &str| {
            let segments: Vec<String> = path.split('/').map(str::to_string).collect();
            answered_by_key(method, &segments)
        };
        for (method, path) in [
            (Method::Post, "items"),
            (Method::Patch, "items/n1"),
            (Method::Delete, "items/n1"),
            (Method::Post, "items/n1/restore"),
            (Method::Post, "items/n1/transition"),
            (Method::Post, "edges"),
            (Method::Patch, "edges/e1"),
            (Method::Delete, "edges/e1"),
            (Method::Post, "items/n1/tags"),
            (Method::Delete, "items/n1/tags/x"),
            (Method::Put, "items/n1/tags"),
            (Method::Put, "items/n1/extensions/app.cursor"),
            (Method::Delete, "items/n1/extensions/app.cursor"),
        ] {
            assert!(keyed(method, path), "{method:?} {path}");
        }
        for (method, path) in [
            (Method::Post, "items/lookup"),
            (Method::Post, "blobs"),
            (Method::Put, "items/n1"),
        ] {
            assert!(!keyed(method, path), "{method:?} {path}");
        }
    }

    #[test]
    fn redirects_are_not_followed_and_keep_the_original_response() {
        for status in [301, 302, 303, 307, 308] {
            for location in [Some("/next"), None] {
                let server = crate::scripted::Scripted::start();
                let headers = location
                    .into_iter()
                    .map(|value| ("Location".into(), value.into()))
                    .chain([(CONTRACT_HEADER.into(), (CONTRACT_VERSION + 1).to_string())])
                    .collect();
                let answer = crate::scripted::Answer::Json {
                    status,
                    body: "{}".into(),
                    headers,
                };
                for path in ["/items/x", "/events", "/blobs"] {
                    server.on(path, vec![answer.clone()]);
                }
                let http = Http::new(&server.url(), "k").unwrap();
                let read = http.item("x").unwrap_err();
                let write = http
                    .send(&Outgoing {
                        method: Method::Patch,
                        segments: vec!["items".into(), "x".into()],
                        params: vec![],
                        body: "{}",
                        idempotency_key: "fixture",
                    })
                    .unwrap_err();
                let stream = match http.open_events(None, Duration::from_secs(1)) {
                    Err(error) => error,
                    Ok(_) => panic!("a redirect opened an event stream"),
                };
                let upload = match http.call(Call {
                    method: Method::Post,
                    segments: &["blobs"],
                    params: &[],
                    headers: &[],
                    body: CallBody::Reader(Box::new(std::io::Cursor::new(b"fixture"))),
                    credential: true,
                    stream: false,
                }) {
                    Err(error) => error,
                    Ok(_) => panic!("a redirect accepted an upload"),
                };
                for error in [read, write, stream, upload] {
                    assert_eq!(
                        error,
                        CoreError::Redirected {
                            origin: server.url(),
                            status,
                            location: location.map(str::to_owned),
                        }
                    );
                }
                assert_eq!(server.asked(), 4);
                assert!(server.seen("/next").is_empty());
            }
        }
    }

    #[test]
    fn a_call_without_renewal_sends_a_refused_secret_once() {
        for renews in [true, false] {
            let server = crate::scripted::Scripted::start();
            server.on(
                "/items/x",
                vec![
                    crate::scripted::refusal(401, "unauthorized"),
                    crate::scripted::refusal(401, "unauthorized"),
                ],
            );
            let http = Http::new(&server.url(), "old").unwrap();
            let renewals = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = Arc::clone(&renewals);
            http.renew_with(Box::new(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok("new".into())
            }));
            let http = if renews { http } else { http.without_renewal() };
            assert!(http.item("x").is_err());
            // The witness is the transport that renews: it renews and sends again.
            let (sent, renewed) = if renews { (2, 1) } else { (1, 0) };
            assert_eq!(server.seen("/items/x").len(), sent, "renews: {renews}");
            assert_eq!(renewals.load(Ordering::SeqCst), renewed, "renews: {renews}");
        }
    }

    #[test]
    fn an_unnamed_or_other_contract_401_cannot_invoke_local_renewal() {
        for other_contract in [false, true] {
            let server = crate::scripted::Scripted::start();
            let mut answer = crate::scripted::unnamed(401, "denied");
            if other_contract && let crate::scripted::Answer::Json { headers, .. } = &mut answer {
                headers.push((CONTRACT_HEADER.into(), (CONTRACT_VERSION + 1).to_string()));
            }
            for path in ["/items/x", "/events", "/blobs"] {
                server.on(path, vec![answer.clone()]);
            }
            let http = Http::new(&server.url(), "k").unwrap();
            http.renew_with(Box::new(|_| panic!("an untrusted refusal invoked renewal")));
            let read = http.item("x").unwrap_err();
            let stream = match http.open_events(Some("1"), Duration::from_secs(1)) {
                Err(error) => error,
                Ok(_) => panic!("a refused stream opened"),
            };
            let upload = http.call(Call {
                method: Method::Post,
                segments: &["blobs"],
                params: &[],
                headers: &[],
                body: CallBody::Reader(Box::new(std::io::Cursor::new(b"fixture"))),
                credential: true,
                stream: false,
            });
            for error in [read, stream] {
                assert!(if other_contract {
                    matches!(
                        error,
                        CoreError::ContractMismatch {
                            status: Some(401),
                            ..
                        }
                    )
                } else {
                    matches!(error, CoreError::Unnamed { status: 401, .. })
                });
            }
            if other_contract {
                assert!(matches!(
                    upload,
                    Err(CoreError::ContractMismatch {
                        status: Some(401),
                        ..
                    })
                ));
            } else {
                let reply = upload.unwrap();
                assert_eq!(reply.status, 401);
                assert_eq!(reply.contract, None);
            }
        }
    }

    #[test]
    fn renewal_preserves_local_failures_and_real_server_refusal() {
        for error in [
            CoreError::SignedOut {
                origin: "https://marfa.example".into(),
            },
            CoreError::NoKeychain("locked".into()),
        ] {
            let server = crate::scripted::Scripted::start();
            server.on(
                "/items/x",
                vec![crate::scripted::refusal(401, "unauthorized")],
            );
            let http = Http::new(&server.url(), "k").unwrap();
            let expected = error.clone();
            http.renew_with(Box::new(move |_| Err(error.clone())));
            assert_eq!(
                http.item("x").unwrap_err(),
                CoreError::RenewalFailed(Box::new(expected))
            );
        }
    }

    #[test]
    fn a_step_up_challenge_is_answered_without_renewing_the_token() {
        let server = crate::scripted::Scripted::start();
        let mut challenged = crate::scripted::refusal(401, "insufficient_user_authentication");
        if let crate::scripted::Answer::Json { headers, .. } = &mut challenged {
            headers.push((
                "WWW-Authenticate".into(),
                "Bearer error=\"insufficient_user_authentication\", max_age=\"300\"".into(),
            ));
        }
        server.on("/items/x", vec![challenged]);
        let http = Http::new(&server.url(), "k").unwrap();
        let renewals = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = renewals.clone();
        http.renew_with(Box::new(move |_| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok("renewed".into())
        }));
        assert!(matches!(
            http.item("x"),
            Err(CoreError::Unauthorized { code, .. }) if code == "insufficient_user_authentication"
        ));
        assert_eq!(renewals.load(std::sync::atomic::Ordering::SeqCst), 0);
        // The witness: a plain 401 is renewed.
        server.on(
            "/items/x",
            vec![crate::scripted::refusal(401, "unauthorized")],
        );
        let _ = http.item("x");
        assert_eq!(renewals.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_refusal_naming_no_contract_is_the_network_on_every_read() {
        let server = crate::scripted::Scripted::start();
        let http = Http::new(&server.url(), "k").unwrap();
        for (status, code) in [
            (401, "access_denied"),
            (404, "not_found"),
            (403, "forbidden"),
        ] {
            for path in ["/items/x", "/types", "/events"] {
                server.on(path, vec![crate::scripted::unnamed(status, code)]);
            }
            let read = match http.item("x") {
                Ok(found) => panic!("an unnamed {status} read as an answer: {found:?}"),
                Err(error) => error,
            };
            let catalog = http.types().unwrap_err();
            let stream = match http.open_events(Some("1"), std::time::Duration::from_secs(5)) {
                Ok(_) => panic!("an unnamed {status} opened a stream"),
                Err(error) => error,
            };
            for refused in [read, catalog, stream] {
                assert!(
                    matches!(refused, CoreError::Unnamed { status: said, .. } if said == status),
                    "an unnamed {status} was read as the server's word: {refused:?}"
                );
                assert!(refused.is_environmental());
            }
        }
        // The witness: the same refusals naming the contract are the server's.
        server.on(
            "/items/x",
            vec![crate::scripted::refusal(401, "unauthorized")],
        );
        assert!(matches!(
            http.item("x"),
            Err(CoreError::Unauthorized { .. })
        ));
        server.on(
            "/items/x",
            vec![crate::scripted::refusal(404, "item_not_found")],
        );
        assert!(matches!(http.item("x"), Ok(None)));
    }

    #[test]
    fn unnamed_rate_limits_keep_the_wait_without_trusting_the_refusal() {
        let http = Http::new("https://marfa.example", "k").unwrap();
        for (seconds, expected) in [(None, None), (Some(7), Some(7)), (Some(86_400), Some(300))] {
            let error = http.refused(429, false, "slow down", seconds);
            assert!(matches!(error, CoreError::Unnamed { status: 429, .. }));
            assert!(error.is_environmental());
            assert_eq!(error.retry_after().map(|wait| wait.as_secs()), expected);
        }
        assert_eq!(
            http.refused(401, false, "no key", Some(7)).retry_after(),
            None
        );
    }

    #[test]
    fn origin_drops_the_key_the_query_and_a_trailing_slash() {
        let http = Http::new("HTTP://Localhost:8600/?x=1#f", "marfa_k1_secret").unwrap();
        assert_eq!(http.origin(), "http://localhost:8600");
        let gateway = Http::new("https://gw.example/TenantA/", "k").unwrap();
        assert_eq!(gateway.origin(), "https://gw.example/TenantA");
        assert_eq!(
            gateway
                .url(&["items", "a b"], &[("type", "core.note")])
                .as_str(),
            "https://gw.example/TenantA/items/a%20b?type=core.note"
        );
    }

    #[test]
    fn an_answer_is_read_only_on_the_contract_it_names() {
        assert!(speaks_contract(3, Some("3"), 200));
        assert!(speaks_contract(3, Some("3"), 404));
        assert!(!speaks_contract(3, Some("4"), 200));
        assert!(!speaks_contract(3, Some("4"), 404));
        assert!(!speaks_contract(3, None, 200));
        assert!(speaks_contract(3, None, 502));
        assert!(!speaks_contract(3, Some("03"), 200));
        assert!(!speaks_contract(1, Some("10"), 200));
        assert!(!speaks_contract(3, None, 299));
        assert!(speaks_contract(3, None, 300));
    }

    #[test]
    fn a_contract_refusal_names_both_contracts_and_whether_a_write_went() {
        let read = CoreError::ContractMismatch {
            origin: "https://marfa.example".into(),
            served: Some("4".into()),
            expected: 3,
            status: Some(200),
            write_sent: false,
            refusal: ContractRefusal::Unread,
        }
        .to_string();
        assert!(read.contains("answered 200 on contract 4"), "{read}");
        assert!(read.contains("speaks contract 3"), "{read}");
        assert!(!read.contains("may have taken effect"), "{read}");
        let write = CoreError::ContractMismatch {
            origin: "https://marfa.example".into(),
            served: None,
            expected: 3,
            status: Some(201),
            write_sent: true,
            refusal: ContractRefusal::Unread,
        }
        .to_string();
        assert!(write.contains("answered 201 naming no contract"), "{write}");
        assert!(write.contains("check the URL"), "{write}");
        assert!(write.contains("may have taken effect"), "{write}");
        for (refusal, earlier) in [
            (ContractRefusal::Declined, false),
            (ContractRefusal::DeclinedAfterEarlierAttempt, true),
        ] {
            let declined = CoreError::ContractMismatch {
                origin: "https://marfa.example".into(),
                served: Some("4".into()),
                expected: 3,
                status: Some(412),
                write_sent: false,
                refusal,
            }
            .to_string();
            assert!(
                declined.contains("refused this attempt before it acted"),
                "{declined}"
            );
            assert!(!declined.contains("may have taken effect"), "{declined}");
            assert_eq!(
                declined.contains("an earlier attempt"),
                earlier,
                "{declined}"
            );
        }
    }

    #[test]
    fn a_wait_is_read_in_either_form_the_standard_allows() {
        assert_eq!(
            http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777)
        );
        assert_eq!(http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(http_date("Sunday, 06-Nov-94 08:49:37 GMT"), None);
        assert_eq!(http_date("nonsense"), None);
        assert_eq!(
            http_date("Sun, 06 Nov 99999999999999999 08:49:37 GMT"),
            None
        );
        assert_eq!(
            http_date("Sun, 06 Nov 1994 9999999999999999:00:00 GMT"),
            None
        );
        assert_eq!(
            http_date("Sun, 9999999999999999 Nov 1994 08:49:37 GMT"),
            None
        );
    }

    #[test]
    fn a_refusal_keeps_the_details_the_server_sent_whatever_its_status() {
        let details = serde_json::json!({ "errors": [{ "field": "title" }] });
        let body = r#"{"error":{"code":"validation_error","message":"no","details":{"errors":[{"field":"title"}]}}}"#;
        for status in [400u16, 401, 403, 404, 409, 422, 429, 500] {
            let answer = refusal(status, body, None)
                .answer()
                .unwrap_or_else(|| panic!("{status} carries no answer"));
            assert_eq!(answer.status, status);
            assert_eq!(answer.code.as_deref(), Some("validation_error"));
            assert_eq!(answer.details.as_ref(), Some(&details), "{status}");
        }
        let unread = refusal(502, "<html>", None).answer().unwrap();
        assert_eq!(
            (unread.status, unread.code, unread.details),
            (502, None, None)
        );
    }

    #[test]
    fn a_credential_the_server_ended_expires_the_copy_and_names_its_answer() {
        let body =
            r#"{"error":{"code":"unauthorized","message":"no","details":{"why":"expired"}}}"#;
        let ended = credential_ended(&refusal(401, body, None));
        let answer = ended.answer().unwrap();
        assert!(
            matches!(&ended, CoreError::CopyExpired { reason, .. } if reason == "credential_ended")
        );
        assert_eq!(
            (answer.status, answer.code.as_deref(), answer.details),
            (
                401,
                Some("unauthorized"),
                Some(serde_json::json!({ "why": "expired" }))
            )
        );
        let instance = Answer {
            status: 409,
            code: INSTANCE_CHANGED.into(),
            body: r#"{"error":{"code":"instance_changed","details":{"a":1}}}"#.into(),
            retry_after_seconds: None,
            replayed: false,
            contract_named: true,
        }
        .instance_changed_error();
        let answer = instance.answer().unwrap();
        assert_eq!(answer.status, 409);
        assert_eq!(answer.details, Some(serde_json::json!({ "a": 1 })));
    }

    #[test]
    fn refusals_keep_the_server_code() {
        let body = r#"{"error":{"code":"unknown_type","message":"no such type"}}"#;
        assert_eq!(
            refusal(400, body, None),
            CoreError::UnknownType {
                server: Some(Box::new(ServerAnswer {
                    status: 400,
                    code: Some("unknown_type".into()),
                    details: None,
                })),
                message: "no such type".into()
            }
        );
        assert_eq!(
            refusal(
                404,
                r#"{"error":{"code":"item_not_found","message":"gone"}}"#,
                None
            ),
            CoreError::NotFound {
                server: Some(Box::new(ServerAnswer {
                    status: 404,
                    code: Some("item_not_found".into()),
                    details: None,
                })),
                code: "item_not_found".into(),
                message: "gone".into()
            }
        );
        assert!(matches!(
            refusal(
                429,
                r#"{"error":{"code":"rate_limited","message":"slow"}}"#,
                Some(7)
            ),
            CoreError::RateLimited {
                retry_after_seconds: Some(7),
                ..
            }
        ));
        assert!(matches!(
            refusal(502, "<html>", None),
            CoreError::Server { status: 502, .. }
        ));
    }

    /// An answer sent a byte at a time, each inside the response budget and
    /// the whole outside the body budget.
    fn trickling(stream: bool) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::Write;
            if let Ok((mut socket, _)) = listener.accept() {
                crate::scripted::read_request(&mut socket);
                let body = "0123456789";
                let _ = write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    if stream {
                        "text/plain"
                    } else {
                        "application/json"
                    },
                    body.len()
                );
                for byte in body.bytes() {
                    std::thread::sleep(Duration::from_millis(150));
                    let _ = socket.write_all(&[byte]);
                }
            }
        });
        url
    }

    fn get<'a>(segments: &'a [&'a str], stream: bool) -> Call<'a> {
        Call {
            method: Method::Get,
            segments,
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream,
        }
    }

    #[test]
    fn a_large_list_is_read_whole_with_a_length_or_in_chunks() {
        let note = serde_json::json!({"body": "x".repeat(100_000)});
        let body = serde_json::json!({"data": vec![note; 110]}).to_string();
        assert!(body.len() > 10 * 1024 * 1024);
        for chunked in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let sent = body.clone();
            let serving = std::thread::spawn(move || {
                use std::io::Write;
                let (mut socket, _) = listener.accept().unwrap();
                crate::scripted::read_request(&mut socket);
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nConnection: close\r\n{}\r\n",
                    if chunked {
                        "Transfer-Encoding: chunked\r\n".into()
                    } else {
                        format!("Content-Length: {}\r\n", sent.len())
                    }
                )
                .unwrap();
                if chunked {
                    for chunk in sent.as_bytes().chunks(65_536) {
                        write!(socket, "{:x}\r\n", chunk.len())?;
                        socket.write_all(chunk)?;
                        socket.write_all(b"\r\n")?;
                    }
                    socket.write_all(b"0\r\n\r\n")?;
                } else {
                    socket.write_all(sent.as_bytes())?;
                }
                Ok::<_, std::io::Error>(())
            });
            let reply = Http::new(&url, "k")
                .unwrap()
                .fetch(get(&["items"], false), true)
                .unwrap();
            assert!(matches!(reply.body, ReplyBody::Text(text) if text == body));
            serving.join().unwrap().unwrap();
        }
    }

    /// Reads a request's head, answers `413` and closes with the rest of the
    /// body unread, as the server does for a body over its cap.
    fn serve_closing_early() -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            use std::io::Write;
            let (mut socket, _) = listener.accept().unwrap();
            crate::scripted::read_head(&mut socket);
            let body = r#"{"error":{"code":"request_too_large"}}"#;
            let _ = write!(
                socket,
                "HTTP/1.1 413 Payload Too Large\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
        });
        (url, serving)
    }

    /// Far past what the system's socket buffers take without the peer reading.
    const LONG_BODY: usize = 32 * 1024 * 1024;

    fn post_items(body: &str) -> Call<'_> {
        Call {
            method: Method::Post,
            segments: &["items"],
            params: &[],
            headers: &[],
            body: CallBody::Json(body),
            credential: true,
            stream: false,
        }
    }

    #[test]
    fn a_connection_closed_while_sending_a_body_over_the_limit_claims_no_answer() {
        let (url, serving) = serve_closing_early();
        let body = "x".repeat(LONG_BODY);
        let sent = Http::new(&url, "k").unwrap().send(&Outgoing {
            method: Method::Post,
            segments: vec!["items".into()],
            params: Vec::new(),
            body: &body,
            idempotency_key: "key",
        });
        serving.join().unwrap();
        assert!(matches!(&sent, Err(CoreError::Network(_))), "{sent:?}");

        let (url, serving) = serve_closing_early();
        let fetched = Http::new(&url, "k")
            .unwrap()
            .fetch(post_items(&body), true)
            .map(|_| "answered");
        serving.join().unwrap();
        assert!(
            matches!(&fetched, Err(CoreError::Network(_))),
            "{fetched:?}"
        );
    }

    #[test]
    fn a_file_the_server_refuses_before_reading_it_is_answered_not_broken_off() {
        let (url, serving) = serve_closing_early();
        let reader = Read::take(std::io::repeat(b'x'), LONG_BODY as u64);
        let reply = Http::new(&url, "k")
            .unwrap()
            .fetch(
                Call {
                    method: Method::Post,
                    segments: &["blobs"],
                    params: &[],
                    headers: &[("Expect", "100-continue")],
                    body: CallBody::Reader(Box::new(reader)),
                    credential: true,
                    stream: false,
                },
                true,
            )
            .unwrap();
        serving.join().unwrap();
        assert_eq!(reply.status, 413);
    }

    /// The chunked body that follows a request's head, read to its end.
    fn read_chunked_body(socket: &mut std::net::TcpStream) -> String {
        let mut body = Vec::new();
        let mut chunk = [0u8; 4096];
        while !body.ends_with(b"0\r\n\r\n") {
            let read = Read::read(socket, &mut chunk).unwrap();
            assert!(read > 0, "the connection closed before the body ended");
            body.extend_from_slice(&chunk[..read]);
        }
        String::from_utf8_lossy(&body).into_owned()
    }

    /// Reads one request's head, then, never sending `100 Continue`, waits for
    /// its body and answers `201`. Hands back when the body arrived.
    fn serve_without_continue() -> (String, std::thread::JoinHandle<std::time::Duration>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            use std::io::Write;
            let (mut socket, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut chunk = [0u8; 4096];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = Read::read(&mut socket, &mut chunk).unwrap();
                head.extend_from_slice(&chunk[..read]);
            }
            let started = std::time::Instant::now();
            read_chunked_body(&mut socket);
            let waited = started.elapsed();
            let _ = write!(
                socket,
                "HTTP/1.1 201 Created\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: 0\r\n\r\n"
            );
            waited
        });
        (url, serving)
    }

    #[test]
    fn a_server_that_never_sends_100_gets_the_body_after_a_short_wait() {
        let (url, serving) = serve_without_continue();
        let reply =
            Http::with_timeouts(&url, "k", Duration::from_secs(90), Duration::from_secs(90))
                .unwrap()
                .fetch(
                    Call {
                        method: Method::Post,
                        segments: &["blobs"],
                        params: &[],
                        headers: &[("Expect", "100-continue")],
                        body: CallBody::Reader(Box::new(std::io::Cursor::new(b"file".to_vec()))),
                        credential: true,
                        stream: false,
                    },
                    true,
                )
                .unwrap();
        let waited = serving.join().unwrap();
        assert_eq!(reply.status, 201);
        assert!(waited < Duration::from_secs(6), "{waited:?}");
    }

    #[test]
    fn an_upload_refused_401_before_its_body_renews_once_and_is_sent_again() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for answer in ["401 Unauthorized", "201 Created"] {
                let (mut socket, _) = listener.accept().unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 4096];
                while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = Read::read(&mut socket, &mut chunk).unwrap();
                    bytes.extend_from_slice(&chunk[..read]);
                }
                let head = String::from_utf8_lossy(&bytes).into_owned();
                let body = if answer.starts_with("201") {
                    socket.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap();
                    read_chunked_body(&mut socket)
                } else {
                    String::new()
                };
                let reply = r#"{"error":{"code":"unauthorized","message":"expired"}}"#;
                let reply = if answer.starts_with("401") {
                    reply
                } else {
                    "{}"
                };
                let _ = write!(
                    socket,
                    "HTTP/1.1 {answer}\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let authorization = head
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                    .unwrap_or_default()
                    .to_string();
                seen.push((authorization, body));
            }
            seen
        });
        let http = Http::new(&url, "old").unwrap();
        let renewals = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&renewals);
        http.renew_with(Box::new(move |_| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok("new".into())
        }));
        let upload = || Call {
            method: Method::Post,
            segments: &["blobs"],
            params: &[],
            headers: &[("Expect", "100-continue")],
            body: CallBody::Reader(Box::new(std::io::Cursor::new(b"file".to_vec()))),
            credential: true,
            stream: false,
        };
        let first = http.fetch(upload(), true).unwrap();
        assert_eq!(first.status, 401);
        let second = http.fetch(upload(), true).unwrap();
        assert_eq!(second.status, 201);
        assert_eq!(renewals.load(std::sync::atomic::Ordering::SeqCst), 1);
        let seen = serving.join().unwrap();
        assert_eq!(seen[0].1, "", "the refused send carried no body");
        assert!(seen[0].0.ends_with("Bearer old"), "{seen:?}");
        assert!(seen[1].0.ends_with("Bearer new"), "{seen:?}");
        assert!(seen[1].1.contains("file"), "{seen:?}");
    }

    #[test]
    fn a_refused_connection_names_its_origin_and_another_failure_does_not() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let refused = Http::new(&url, "k")
            .unwrap()
            .fetch(post_items("{}"), true)
            .map(|_| "answered")
            .unwrap_err();
        assert!(
            matches!(&refused, CoreError::ConnectionRefused { origin } if origin == &url),
            "{refused}"
        );
        assert_eq!(
            refused.to_string(),
            format!("request to {url} failed: the connection was refused")
        );

        let (url, serving) = serve(Vec::new());
        let hung_up = Http::new(&url, "k")
            .unwrap()
            .fetch(post_items("{}"), true)
            .map(|_| "answered")
            .unwrap_err();
        serving.join().unwrap().unwrap();
        assert!(matches!(&hung_up, CoreError::Network(_)), "{hung_up}");
    }

    #[test]
    fn a_413_heard_whose_body_cannot_be_read_stays_a_refusal() {
        let (url, serving) = serve(
            format!(
                "HTTP/1.1 413 Payload Too Large\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: 100\r\n\r\n{{"
            )
            .into_bytes(),
        );
        let answer = Http::new(&url, "k")
            .unwrap()
            .send(&Outgoing {
                method: Method::Post,
                segments: vec!["items".into()],
                params: Vec::new(),
                body: "{}",
                idempotency_key: "key",
            })
            .unwrap();
        serving.join().unwrap().unwrap();
        assert_eq!(
            (answer.status, answer.code.as_str(), answer.contract_named),
            (413, "request_too_large", true)
        );

        // The witness: the same cut in any other answer stays a failure.
        let (url, serving) = serve(
            format!(
                "HTTP/1.1 200 OK\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: 100\r\n\r\n{{"
            )
            .into_bytes(),
        );
        let sent = Http::new(&url, "k").unwrap().send(&Outgoing {
            method: Method::Post,
            segments: vec!["items".into()],
            params: Vec::new(),
            body: "{}",
            idempotency_key: "key",
        });
        serving.join().unwrap().unwrap();
        assert!(matches!(&sent, Err(CoreError::Network(_))), "{sent:?}");
    }

    /// Answers one request with `answer`, written as it is, once the request
    /// has been read whole, and hands back the address and the server.
    fn serve(answer: Vec<u8>) -> (String, std::thread::JoinHandle<std::io::Result<()>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            use std::io::Write;
            let (mut socket, _) = listener.accept()?;
            let mut reader = std::io::BufReader::new(socket.try_clone()?);
            let mut length = 0;
            loop {
                let mut line = String::new();
                std::io::BufRead::read_line(&mut reader, &mut line)?;
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            std::io::Read::read_exact(&mut reader, &mut vec![0; length])?;
            socket.write_all(&answer)?;
            Ok(())
        });
        (url, serving)
    }

    /// Serves `body` once as a `200` naming the contract, with its length or
    /// in chunks.
    fn serve_once(
        body: String,
        chunked: bool,
    ) -> (String, std::thread::JoinHandle<std::io::Result<()>>) {
        let mut answer = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nConnection: close\r\n{}\r\n",
            if chunked {
                "Transfer-Encoding: chunked\r\n".into()
            } else {
                format!("Content-Length: {}\r\n", body.len())
            }
        )
        .into_bytes();
        if chunked {
            for chunk in body.as_bytes().chunks(65_536) {
                answer.extend(format!("{:x}\r\n", chunk.len()).into_bytes());
                answer.extend(chunk);
                answer.extend(b"\r\n");
            }
            answer.extend(b"0\r\n\r\n");
        } else {
            answer.extend(body.into_bytes());
        }
        serve(answer)
    }

    /// A proxy in front of the server answers in its own words, which need
    /// not be UTF-8, and its status and wait are still the answer.
    #[test]
    fn a_proxy_page_that_is_not_utf8_keeps_its_status_and_wait() {
        let page = || {
            let body = b"<html>Service indisponible \xe0 cette heure</html>".to_vec();
            let mut answer = format!(
                "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=iso-8859-1\r\nRetry-After: 120\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            answer.extend(body);
            serve(answer)
        };
        let (url, serving) = page();
        let read = Http::new(&url, "k").unwrap().items_page(&ItemsQuery {
            r#type: None,
            tier: SliceTier::All,
            narrowing: None,
            cursor: None,
        });
        assert!(
            matches!(
                read,
                Err(CoreError::Unnamed {
                    status: 503,
                    retry_after_seconds: Some(120),
                    ..
                })
            ),
            "a read: {read:?}"
        );
        serving.join().unwrap().unwrap();

        let (url, serving) = page();
        let sent = Http::new(&url, "k")
            .unwrap()
            .send(&Outgoing {
                method: Method::Post,
                segments: vec!["items".into()],
                params: Vec::new(),
                body: "{}",
                idempotency_key: "key",
            })
            .unwrap();
        assert_eq!(
            (sent.status, sent.retry_after_seconds, sent.contract_named),
            (503, Some(120), false),
            "a write's answer"
        );
        assert!(sent.is_environmental());
        serving.join().unwrap().unwrap();

        let (url, serving) = page();
        let reply = Http::new(&url, "k")
            .unwrap()
            .call(get(&["items"], false))
            .unwrap();
        assert_eq!((reply.status, reply.retry_after_seconds), (503, Some(120)));
        assert!(reply.body.contains("indisponible"), "{}", reply.body);
        serving.join().unwrap().unwrap();

        // JSON is read strictly: a byte that is not UTF-8 is no answer.
        let body = b"{\"data\":[],\"next_cursor\":\"\xe0\"}".to_vec();
        let mut answer = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        answer.extend(body);
        let (url, serving) = serve(answer);
        let read = Http::new(&url, "k").unwrap().items_page(&ItemsQuery {
            r#type: None,
            tier: SliceTier::All,
            narrowing: None,
            cursor: None,
        });
        assert!(matches!(read, Err(CoreError::Network(_))), "{read:?}");
        serving.join().unwrap().unwrap();
    }

    /// A page of 500 rows, a bulk read of 100 and a write's answer can each
    /// be larger than ureq's default 10 MiB, and an answer cut off there
    /// would fail every hydration that holds such rows.
    #[test]
    fn every_whole_read_takes_an_answer_over_ten_mib() {
        let row = |at: usize| {
            let mut item: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
                "item.updated",
                &format!("row-{at}"),
                "core.note",
                1,
            ))
            .unwrap();
            item["item"]["properties"]["body"] = "x".repeat(1_000_000).into();
            item
        };
        let rows: Vec<serde_json::Value> = (0..11).map(row).collect();
        let ids: Vec<String> = (0..11).map(|at| format!("row-{at}")).collect();
        let page = serde_json::json!({
            "data": rows.iter().map(|row| serde_json::json!({"item": row["item"], "metadata": {"tags": []}})).collect::<Vec<_>>(),
            "next_cursor": null,
        })
        .to_string();
        let bulk = serde_json::json!({
            "data": rows.iter().map(|row| row["item"].clone()).collect::<Vec<_>>(),
            "metadata": ids.iter().map(|id| serde_json::json!({"item_id": id, "tags": []})).collect::<Vec<_>>(),
        })
        .to_string();
        let answer =
            serde_json::json!({"item": rows[0]["item"], "padding": "y".repeat(11_000_000)})
                .to_string();
        for body in [&page, &bulk, &answer] {
            assert!(body.len() > 10 * 1024 * 1024);
        }
        for chunked in [false, true] {
            let (url, serving) = serve_once(page.clone(), chunked);
            let read = Http::new(&url, "k")
                .unwrap()
                .items_page(&ItemsQuery {
                    r#type: None,
                    tier: SliceTier::All,
                    narrowing: None,
                    cursor: None,
                })
                .unwrap();
            assert_eq!(read.data.len(), 11, "a listing page");
            serving.join().unwrap().unwrap();

            let (url, serving) = serve_once(bulk.clone(), chunked);
            let read = Http::new(&url, "k").unwrap().items_by_id(&ids).unwrap();
            assert_eq!(read.len(), 11, "a bulk read");
            serving.join().unwrap().unwrap();

            let (url, serving) = serve_once(answer.clone(), chunked);
            let sent = Http::new(&url, "k")
                .unwrap()
                .send(&Outgoing {
                    method: Method::Post,
                    segments: vec!["items".into()],
                    params: Vec::new(),
                    body: "{}",
                    idempotency_key: "key",
                })
                .unwrap();
            assert_eq!(sent.body, answer, "a write's answer");
            serving.join().unwrap().unwrap();
        }
    }

    #[test]
    fn a_streamed_answer_outlasts_the_body_budget_and_a_read_one_does_not() {
        let budgets = |url: &str| {
            Http::with_timeouts(
                url,
                "k",
                Duration::from_millis(2_000),
                Duration::from_millis(600),
            )
            .unwrap()
        };
        let reply = budgets(&trickling(true))
            .fetch(get(&["export"], true), true)
            .unwrap();
        let ReplyBody::Stream(mut reader) = reply.body else {
            panic!("a streamed success was read whole");
        };
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(text, "0123456789");
        // The witness: the same trickle, read whole, runs out of its budget.
        assert!(matches!(
            budgets(&trickling(false)).call(get(&["items"], false)),
            Err(CoreError::Network(_))
        ));
    }

    #[test]
    fn a_page_of_items_is_given_a_body_budget_in_proportion_to_its_rows() {
        let http = Http::with_timeouts(
            "http://127.0.0.1:1",
            "k",
            Duration::from_millis(2_000),
            Duration::from_millis(1_000),
        )
        .unwrap();
        assert_eq!(
            http.page_budget(),
            Some(Duration::from_millis(1_000) * ITEM_PAGE_LIMIT / ROWS_PER_BODY_BUDGET)
        );
    }

    #[test]
    fn a_server_that_never_answers_is_given_up_on_even_for_a_stream() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let held = listener.accept();
            std::thread::sleep(Duration::from_secs(10));
            drop(held);
        });
        let http = Http::with_timeouts(&url, "k", Duration::from_millis(500), BODY_BUDGET).unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(
            http.fetch(get(&["export"], true), true),
            Err(CoreError::Network(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// A server that reads the request, then answers after `pause` or, with
    /// `answer` false, hangs up without answering.
    fn works_for(pause: Duration, answer: bool) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            use std::io::Write;
            let (mut socket, _) = listener.accept().unwrap();
            crate::scripted::read_request(&mut socket);
            std::thread::sleep(pause);
            if answer {
                let body = "{}";
                let _ = write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (url, serving)
    }

    #[test]
    fn a_call_that_waits_on_the_servers_work_outlasts_the_answer_budget() {
        let budgets = |url: &str| {
            Http::with_timeouts(
                url,
                "k",
                Duration::from_millis(300),
                Duration::from_millis(300),
            )
            .unwrap()
        };
        let post = |segments| Call {
            method: Method::Post,
            segments,
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        };
        let (url, serving) = works_for(Duration::from_millis(1_200), true);
        let waited = budgets(&url)
            .working("Check.")
            .fetch(post(&["restore"]), true);
        assert_eq!(waited.unwrap().status, 200);
        serving.join().unwrap();
        // The witness: the same slow answer, on a call that is not marked, runs out of its budget.
        let (url, serving) = works_for(Duration::from_millis(1_200), true);
        assert!(matches!(
            budgets(&url).fetch(post(&["restore"]), true),
            Err(CoreError::Network(_))
        ));
        serving.join().unwrap();
    }

    #[test]
    fn a_waiting_call_that_ends_without_an_answer_does_not_say_it_failed() {
        let post = |segments| Call {
            method: Method::Post,
            segments,
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        };
        let (url, serving) = works_for(Duration::from_millis(100), false);
        let Err(CoreError::Network(said)) = Http::new(&url, "k")
            .unwrap()
            .working("Check with the check.")
            .fetch(post(&["restore"]), true)
        else {
            panic!("a hung-up call was not a network error");
        };
        serving.join().unwrap();
        assert!(said.contains("may still be working"), "{said}");
        assert!(said.ends_with("Check with the check."), "{said}");
        // The witness: a call never marked says only that the request failed.
        let (url, serving) = works_for(Duration::from_millis(100), false);
        let Err(CoreError::Network(plain)) = Http::new(&url, "k")
            .unwrap()
            .fetch(post(&["restore"]), true)
        else {
            panic!("a hung-up call was not a network error");
        };
        serving.join().unwrap();
        assert!(!plain.contains("may still be working"), "{plain}");
    }

    #[test]
    fn a_streamed_refusal_cannot_leave_its_body_open_forever() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            use std::io::Write;
            let (mut socket, _) = listener.accept().unwrap();
            crate::scripted::read_request(&mut socket);
            write!(
                socket,
                "HTTP/1.1 401 Unauthorized\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: 100\r\n\r\n"
            )
            .unwrap();
            std::thread::sleep(Duration::from_secs(2));
        });
        let http = Http::with_timeouts(
            &url,
            "k",
            Duration::from_secs(1),
            Duration::from_millis(100),
        )
        .unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(
            http.fetch(get(&["events"], true), true),
            Err(CoreError::Network(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        serving.join().unwrap();
    }

    /// Reads a byte at a time, slowly.
    struct Slow(std::ops::Range<u8>);

    impl Read for Slow {
        fn read(&mut self, into: &mut [u8]) -> std::io::Result<usize> {
            std::thread::sleep(Duration::from_millis(150));
            match self.0.next() {
                Some(byte) => {
                    into[0] = byte;
                    Ok(1)
                }
                None => Ok(0),
            }
        }
    }

    #[test]
    fn an_upload_is_not_cut_off_while_it_sends_or_while_the_server_works_on_it() {
        let serving = |wait: Duration| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            std::thread::spawn(move || {
                use std::io::Write;
                if let Ok((mut socket, _)) = listener.accept() {
                    // The whole request, a chunked body included, so the
                    // answer is not cut off by unread bytes when it closes.
                    let mut seen = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let sent = |seen: &[u8]| {
                        seen.windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .is_some_and(|head| seen[head + 4..].ends_with(b"0\r\n\r\n"))
                    };
                    while !sent(&seen) {
                        match Read::read(&mut socket, &mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => seen.extend_from_slice(&chunk[..n]),
                        }
                    }
                    std::thread::sleep(wait);
                    let body = r#"{"hash":"sha256:h"}"#;
                    let _ = write!(
                        socket,
                        "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            });
            Http::with_timeouts(
                &url,
                "k",
                Duration::from_millis(500),
                Duration::from_millis(500),
            )
            .unwrap()
        };
        let upload = |http: &Http| {
            http.call(Call {
                method: Method::Post,
                segments: &["blobs"],
                params: &[],
                headers: &[],
                body: CallBody::Reader(Box::new(Slow(0..10))),
                credential: true,
                stream: false,
            })
        };
        // Sending takes 1.5 seconds against budgets of half of one.
        assert_eq!(upload(&serving(Duration::ZERO)).unwrap().status, 201);
        // A server that works on the file as long again before it answers.
        assert_eq!(
            upload(&serving(Duration::from_millis(1_500)))
                .unwrap()
                .status,
            201
        );
        // The witness: the same late answer to a call that sends no file runs out.
        let late = serving(Duration::from_millis(1_500));
        assert!(matches!(
            late.call(Call {
                method: Method::Post,
                segments: &["blobs"],
                params: &[],
                headers: &[],
                body: CallBody::Json("{}"),
                credential: true,
                stream: false,
            }),
            Err(CoreError::Network(_))
        ));
    }

    #[test]
    fn an_answer_on_another_contract_is_held_unless_the_caller_asks_to_see_it() {
        let server = crate::scripted::Scripted::start();
        let other = || {
            let mut answer = crate::scripted::Answer::Json {
                status: 200,
                body: r#"{"name":"marfa"}"#.into(),
                headers: Vec::new(),
            };
            if let crate::scripted::Answer::Json { headers, .. } = &mut answer {
                headers.push((CONTRACT_HEADER.into(), (CONTRACT_VERSION + 1).to_string()));
            }
            answer
        };
        server.on("/", vec![other(), other()]);
        let http = Http::new(&server.url(), "k").unwrap();
        assert!(matches!(
            http.fetch(get(&[], false), true),
            Err(CoreError::ContractMismatch { .. })
        ));
        let seen = http.fetch(get(&[], false), false).unwrap();
        assert_eq!(seen.contract, Some((CONTRACT_VERSION + 1).to_string()));
        assert!(matches!(seen.body, ReplyBody::Text(text) if text.contains("marfa")));
    }
    #[test]
    fn the_catalogs_are_read_whole_and_send_no_query() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/types",
            vec![crate::scripted::types(&[("core.note", None)])],
        );
        server.on(
            "/edge-types",
            vec![crate::scripted::json(
                200,
                r#"{"data":[],"next_cursor":null}"#,
            )],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        assert_eq!(http.types().unwrap().len(), 1);
        assert!(http.edge_types().unwrap().is_empty());
        assert_eq!(server.seen("/types")[0].query, "");
        assert_eq!(server.seen("/edge-types")[0].query, "");
    }

    #[test]
    fn a_title_lookup_sends_the_names_and_pairs_each_answer_with_its_name() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/titles",
            vec![crate::scripted::json(
                200,
                r#"{"data":[
                    {"name":"Ada","items":[{"id":"a1","type":"core.note","title":"ADA","has_blob":false}],"more":false},
                    {"name":"Many","items":[],"more":true}
                ]}"#,
            )],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        let names = vec!["Ada".to_string(), "Many".to_string()];
        let answers = http.item_titles(&names).unwrap();
        assert_eq!(answers[0].items[0].id, "a1");
        assert_eq!(answers[0].items[0].title, "ADA");
        assert!(!answers[0].items[0].has_blob);
        assert!(answers[1].more && answers[1].items.is_empty());
        let seen = server.seen("/items/titles");
        assert_eq!(seen.len(), 1);
        let sent: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(sent, serde_json::json!({ "names": ["Ada", "Many"] }));
    }

    #[test]
    fn a_title_lookup_refuses_more_names_than_a_call_takes_before_sending() {
        let server = crate::scripted::Scripted::start();
        let http = Http::new(&server.url(), "k").unwrap();
        let names = vec!["a".to_string(); TITLE_LOOKUP_NAMES + 1];
        assert!(matches!(
            http.item_titles(&names),
            Err(CoreError::Invalid(_))
        ));
        assert_eq!(server.asked(), 0);
    }

    #[test]
    fn a_title_lookup_answered_with_too_few_results_is_not_read() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/titles",
            vec![crate::scripted::json(200, r#"{"data":[]}"#)],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        assert!(matches!(
            http.item_titles(&["Ada".to_string()]),
            Err(CoreError::Decoding(_))
        ));
    }

    #[test]
    fn each_listing_asks_for_the_most_a_page_holds() {
        let server = crate::scripted::Scripted::start();
        let empty = || {
            vec![crate::scripted::json(
                200,
                r#"{"data":[],"next_cursor":null}"#,
            )]
        };
        for path in ["/items", "/edges", "/items/n1/edges"] {
            server.on(path, empty());
        }
        let http = Http::new(&server.url(), "k").unwrap();
        http.items_page(&ItemsQuery {
            r#type: None,
            tier: SliceTier::All,
            narrowing: None,
            cursor: None,
        })
        .unwrap();
        http.edges_page("parent-of", None).unwrap();
        http.item_edges_page("n1", "parent-of", None).unwrap();
        let limits = |path: &str| -> Vec<String> {
            server
                .seen(path)
                .iter()
                .map(|seen| {
                    url::form_urlencoded::parse(seen.query.as_bytes())
                        .find(|(name, _)| name == "limit")
                        .map(|(_, value)| value.into_owned())
                        .unwrap_or_default()
                })
                .collect()
        };
        assert_eq!(limits("/items"), ["500"]);
        assert_eq!(limits("/edges"), ["500"]);
        assert_eq!(limits("/items/n1/edges"), ["500"]);
    }

    #[test]
    fn a_listing_of_an_edge_type_without_labels_is_read() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/edge-types",
            vec![crate::scripted::json(
                200,
                r#"{"data":[{"id":"acme.list-member","cardinality":"many-to-many","from_type_constraints":["*"],"to_type_constraints":["*"],"cascade_on_delete":"orphan","property_schema":{},"written_from":"from","shipped":false}],"next_cursor":null}"#,
            )],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        assert_eq!(http.edge_types().unwrap().len(), 1);
    }

    #[test]
    fn a_catalog_that_names_a_next_page_is_refused_not_cut_short() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/types",
            vec![crate::scripted::json(
                200,
                r#"{"data":[{"id":"core.note"}],"next_cursor":"more"}"#,
            )],
        );
        server.on(
            "/edge-types",
            vec![crate::scripted::json(
                200,
                r#"{"data":[],"next_cursor":"more"}"#,
            )],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        assert!(matches!(http.types(), Err(CoreError::Decoding(_))));
        assert!(matches!(http.edge_types(), Err(CoreError::Decoding(_))));
        // Neither read went on to ask for a page the doors do not have.
        assert_eq!(server.seen("/types").len(), 1);
        assert_eq!(server.seen("/edge-types").len(), 1);
    }

    fn recording_listener(
        reply: impl Fn(&str) -> String + Send + 'static,
    ) -> (u16, Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let head = |reader: &mut BufReader<std::net::TcpStream>| {
                    let mut first = String::new();
                    reader.read_line(&mut first).ok()?;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).ok()?;
                        if line.trim().is_empty() {
                            break;
                        }
                    }
                    Some(first.trim().to_string())
                };
                let Some(mut first) = head(&mut reader) else {
                    continue;
                };
                record.lock().unwrap().push(first.clone());
                if first.starts_with("CONNECT ") {
                    if reply(&first).is_empty() {
                        continue;
                    }
                    stream
                        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                        .unwrap();
                    let Some(inner) = head(&mut reader) else {
                        continue;
                    };
                    first = inner;
                    record.lock().unwrap().push(first.clone());
                }
                let _ = stream.write_all(reply(&first).as_bytes());
            }
        });
        (port, seen)
    }

    #[test]
    fn each_redirect_is_sent_through_the_proxy_or_not_by_where_it_goes() {
        let (target, reached) = recording_listener(|_| {
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into()
        });
        let local = format!("http://127.0.0.1:{target}/landed");
        let (proxy, via_proxy) = recording_listener({
            let local = local.clone();
            move |line| {
                if line.starts_with("CONNECT 127.0.0.1") {
                    String::new()
                } else {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: {local}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                }
            }
        });
        // SAFETY: One process for each test, so nothing else reads the environment.
        unsafe {
            std::env::set_var("HTTP_PROXY", format!("http://127.0.0.1:{proxy}"));
            std::env::set_var("http_proxy", format!("http://127.0.0.1:{proxy}"));
            std::env::remove_var("NO_PROXY");
            std::env::remove_var("no_proxy");
        }
        let agents = Agents::new(Agent::config_builder);
        let start = "http://redirect.example.test:9/start";

        // First prove that the proxy can observe a request for the local address.
        let witness = agents.proxied.get(&local).call();
        assert!(witness.is_err(), "the proxy refused the local address");
        assert!(
            via_proxy
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.starts_with("CONNECT 127.0.0.1")),
            "{:?}",
            via_proxy.lock().unwrap()
        );
        via_proxy.lock().unwrap().clear();

        let mut response = agents
            .get(start, &[("Accept", "text/plain".into())], 3)
            .unwrap();
        assert_eq!(response.body_mut().read_to_string().unwrap(), "ok");
        let sent = via_proxy.lock().unwrap().clone();
        assert!(
            sent.iter()
                .any(|line| line.starts_with("CONNECT redirect.example.test:9")),
            "{sent:?}"
        );
        assert!(
            sent.iter().all(|line| !line.contains("127.0.0.1")),
            "{sent:?}"
        );
        let landed = reached.lock().unwrap().clone();
        assert_eq!(landed, vec!["GET /landed HTTP/1.1".to_string()]);
    }

    fn heads_listener(
        reply: impl Fn(&str) -> String + Send + 'static,
    ) -> (u16, Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if line.trim().is_empty() {
                        break;
                    }
                    head.push_str(&line);
                }
                if head.is_empty() {
                    continue;
                }
                let first = head.lines().next().unwrap_or_default().to_string();
                record.lock().unwrap().push(head.to_ascii_lowercase());
                let _ = stream.write_all(reply(&first).as_bytes());
            }
        });
        (port, seen)
    }

    fn redirect(to: &str) -> String {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

    fn who_is_asking() -> Vec<(&'static str, String)> {
        vec![
            ("Accept", "text/plain".into()),
            ("Authorization", "Bearer secret".into()),
            ("Cookie", "session=secret".into()),
            ("Proxy-Authorization", "Basic secret".into()),
            ("X-Marfa-Instance-Id", "secret".into()),
        ]
    }

    fn carries_credentials(head: &str) -> bool {
        head.contains("authorization:") || head.contains("cookie:") || head.contains("x-marfa-")
    }

    fn direct_agents() -> Agents {
        // SAFETY: One process for each test, so nothing else reads the environment.
        unsafe {
            std::env::remove_var("HTTP_PROXY");
            std::env::remove_var("http_proxy");
            std::env::remove_var("ALL_PROXY");
            std::env::remove_var("all_proxy");
        }
        Agents::new(Agent::config_builder)
    }

    #[test]
    fn a_redirect_to_another_host_leaves_the_credentials_behind() {
        let (port, seen) = heads_listener(move |line| {
            if line.contains("/start") {
                redirect(&format!("http://localhost:{}/landed", PORT.get().unwrap()))
            } else {
                OK.into()
            }
        });
        PORT.set(port).unwrap();
        let mut response = direct_agents()
            .get(
                &format!("http://127.0.0.1:{port}/start"),
                &who_is_asking(),
                3,
            )
            .unwrap();
        assert_eq!(response.body_mut().read_to_string().unwrap(), "ok");
        let heads = seen.lock().unwrap().clone();
        assert_eq!(heads.len(), 2, "{heads:?}");
        assert!(
            heads[0].contains("authorization: bearer secret"),
            "{heads:?}"
        );
        assert!(heads[0].contains("cookie: session=secret"), "{heads:?}");
        assert!(!carries_credentials(&heads[1]), "{heads:?}");
        assert!(heads[1].contains("accept: text/plain"), "{heads:?}");
    }

    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

    #[test]
    fn a_redirect_to_another_port_leaves_the_credentials_behind() {
        let (other, landed) = heads_listener(|_| OK.into());
        let (port, first) =
            heads_listener(move |_| redirect(&format!("http://127.0.0.1:{other}/landed")));
        let mut response = direct_agents()
            .get(
                &format!("http://127.0.0.1:{port}/start"),
                &who_is_asking(),
                3,
            )
            .unwrap();
        assert_eq!(response.body_mut().read_to_string().unwrap(), "ok");
        assert!(first.lock().unwrap()[0].contains("authorization: bearer secret"));
        let heads = landed.lock().unwrap().clone();
        assert_eq!(heads.len(), 1, "{heads:?}");
        assert!(!carries_credentials(&heads[0]), "{heads:?}");
        assert!(heads[0].contains("accept: text/plain"), "{heads:?}");
    }

    #[test]
    fn a_redirect_within_the_origin_keeps_the_credentials() {
        let (port, seen) = heads_listener(|line| {
            if line.contains("/start") {
                redirect("/landed")
            } else {
                OK.into()
            }
        });
        direct_agents()
            .get(
                &format!("http://127.0.0.1:{port}/start"),
                &who_is_asking(),
                3,
            )
            .unwrap();
        let heads = seen.lock().unwrap().clone();
        assert_eq!(heads.len(), 2, "{heads:?}");
        assert!(
            heads[1].contains("authorization: bearer secret"),
            "{heads:?}"
        );
        assert!(
            heads[1].contains("x-marfa-instance-id: secret"),
            "{heads:?}"
        );
    }

    #[test]
    fn credentials_left_behind_stay_behind_when_a_chain_returns_to_the_origin() {
        static BACK: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
        static OUT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
        let (origin, seen) = heads_listener(|line| {
            if line.contains("/start") {
                redirect(&format!("http://127.0.0.1:{}/away", OUT.get().unwrap()))
            } else {
                OK.into()
            }
        });
        let (out, _) =
            heads_listener(|_| redirect(&format!("http://127.0.0.1:{}/back", BACK.get().unwrap())));
        BACK.set(origin).unwrap();
        OUT.set(out).unwrap();
        direct_agents()
            .get(
                &format!("http://127.0.0.1:{origin}/start"),
                &who_is_asking(),
                5,
            )
            .unwrap();
        let heads = seen.lock().unwrap().clone();
        assert_eq!(heads.len(), 2, "{heads:?}");
        assert!(
            heads[0].contains("authorization: bearer secret"),
            "{heads:?}"
        );
        assert!(!carries_credentials(&heads[1]), "{heads:?}");
    }

    #[test]
    fn a_redirect_from_https_to_http_is_refused_and_what_leaves_the_origin_is_told_apart() {
        let at = |text: &str| Url::parse(text).unwrap();
        assert_eq!(
            hop(&at("https://a.test/x"), &at("http://a.test/x")),
            Hop::Downgrade
        );
        assert_eq!(
            hop(&at("https://a.test/x"), &at("http://b.test/x")),
            Hop::Downgrade
        );
        assert_eq!(
            hop(&at("http://a.test/x"), &at("https://a.test/x")),
            Hop::OtherOrigin
        );
        assert_eq!(
            hop(&at("https://a.test/x"), &at("https://b.test/x")),
            Hop::OtherOrigin
        );
        assert_eq!(
            hop(&at("https://a.test/x"), &at("https://a.test:8443/x")),
            Hop::OtherOrigin
        );
        assert_eq!(
            hop(&at("https://a.test/x"), &at("https://a.test:443/y")),
            Hop::SameOrigin
        );
        assert_eq!(
            hop(&at("http://a.test/x"), &at("http://a.test/y")),
            Hop::SameOrigin
        );
    }

    #[test]
    fn redirects_stop_at_the_limit() {
        let (target, _) = recording_listener(|_| {
            "HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
        });
        let agents = Agents::new(Agent::config_builder);
        let url = format!("http://127.0.0.1:{target}/");
        assert!(matches!(
            agents.get(&url, &[], 2),
            Err(ureq::Error::TooManyRedirects)
        ));
    }

    #[test]
    fn a_request_started_while_a_deadline_is_held_ends_by_it_while_it_waits_for_the_answer() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            let mut held = Vec::new();
            for _ in 0..3 {
                if let Ok((socket, _)) = listener.accept() {
                    held.push(socket);
                }
            }
            std::thread::sleep(Duration::from_secs(3));
        });
        let http = Http::new(&url, "k").unwrap();
        let soon = || EndsBy::hold(Some(Instant::now() + Duration::from_millis(300)));
        let started = Instant::now();
        {
            let _ends_by = soon();
            assert!(matches!(
                http.open_events(None, Duration::from_secs(60)),
                Err(CoreError::Network(_))
            ));
        }
        {
            let _ends_by = soon();
            assert!(matches!(http.item_tables("i"), Err(CoreError::Network(_))));
        }
        {
            let _ends_by = soon();
            let _later = EndsBy::hold(Some(Instant::now() + Duration::from_secs(60)));
            assert!(matches!(
                http.fetch(get(&["events"], true), true),
                Err(CoreError::Network(_))
            ));
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(EndsBy::here(), None);
        let _passed = EndsBy::hold(Some(Instant::now()));
        assert!(matches!(http.item_tables("i"), Err(CoreError::Network(_))));
        serving.join().unwrap();
    }
}
