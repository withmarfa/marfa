//! Runs and supervises the tunnel connector that carries a linked instance's traffic through Marfa Cloud.
//!
//! The connector is ready when its own `/ready` on its metrics address answers 200. Unlike a line
//! in its output, `/ready` says so again each time that changes, and it does not depend on the
//! wording of a release.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::watch;
use tokio::time::Instant;

use super::client::{self, Method};
use super::store::{self, State};
use super::worker::{end_by_service, write_link};
use super::{LINK_CREDENTIAL, TUNNEL_TOKEN, announce_if_linked, seal, text_at};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::clock::Stamp;
use crate::settings::sealed::Secret;
use crate::settings::start::DatabasePath;

const PROGRAM: &str = "cloudflared";
const TOKEN_FILE: &str = "tunnel-token";
const FIRST_WAIT: Duration = Duration::from_secs(1);
const MOST_WAIT: Duration = Duration::from_secs(60);
/// How long a connector asked to end has to do so before it is killed.
const GRACE: Duration = Duration::from_secs(2);
const POLL_UNTIL_READY: Duration = Duration::from_secs(1);
const POLL_WHILE_READY: Duration = Duration::from_secs(5);
const POLL_TIMEOUT: Duration = Duration::from_secs(1);
const DRAIN_FOR: Duration = Duration::from_millis(500);
const MOST_LINE: usize = 2_000;
/// What the connector prints when the edge refuses its token or has no tunnel for it.
const REFUSALS: [&str; 2] = [
    "Unauthorized: Invalid tunnel secret",
    "Failed to get tunnel",
];
/// The only variables of the server's own environment the connector gets.
const KEPT_ENVIRONMENT: [&str; 5] = ["HOME", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Condition {
    Stopped,
    Starting,
    Connected,
    Reconnecting,
    Failed,
}

impl Condition {
    fn word(self) -> &'static str {
        match self {
            Condition::Stopped => "stopped",
            Condition::Starting => "starting",
            Condition::Connected => "connected",
            Condition::Reconnecting => "reconnecting",
            Condition::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy)]
struct Shown {
    condition: Condition,
    since: Stamp,
    reason: Option<&'static str>,
}

pub struct Connector {
    shown: Mutex<Shown>,
    /// The link the connector is to run for, if any.
    wanted: watch::Sender<Option<String>>,
    stopped: watch::Sender<bool>,
    running: watch::Sender<bool>,
}

impl Connector {
    pub fn new(since: Stamp) -> Connector {
        Connector {
            shown: Mutex::new(Shown {
                condition: Condition::Stopped,
                since,
                reason: None,
            }),
            wanted: watch::Sender::new(None),
            stopped: watch::Sender::new(false),
            running: watch::Sender::new(false),
        }
    }

    pub fn to_json(&self) -> Value {
        let shown = *self.shown.lock().unwrap_or_else(PoisonError::into_inner);
        let mut body = json!({ "state": shown.condition.word(), "since": shown.since.text() });
        if let Some(reason) = shown.reason {
            body["reason"] = reason.into();
        }
        body
    }

    /// Says which link the connector is to run for; none stops it.
    pub fn want(&self, link_id: Option<String>) {
        self.wanted.send_if_modified(|wanted| {
            let changed = *wanted != link_id;
            *wanted = link_id;
            changed
        });
    }

    pub fn stop(&self) {
        self.stopped.send_replace(true);
    }

    pub async fn idle(&self) {
        let mut running = self.running.subscribe();
        let _ = running.wait_for(|running| !*running).await;
    }

    /// Takes the state, and says whether that changed what is shown.
    fn take(&self, condition: Condition, reason: Option<&'static str>, since: Stamp) -> bool {
        let mut shown = self.shown.lock().unwrap_or_else(PoisonError::into_inner);
        if shown.condition == condition && shown.reason == reason {
            return false;
        }
        *shown = Shown {
            condition,
            since,
            reason,
        };
        true
    }
}

pub fn start(app: &Arc<App>) {
    let app = app.clone();
    app.cloud.connector.running.send_replace(true);
    let mut watching = Watching {
        wanted: app.cloud.connector.wanted.subscribe(),
        stopped: app.cloud.connector.stopped.subscribe(),
    };
    tokio::spawn(async move {
        remove_token_file(token_path(&app.settings.start.database)).await;
        while let Some(link_id) = watching.next_link().await {
            serve(&app, &mut watching, &link_id).await;
        }
        app.cloud.connector.running.send_replace(false);
    });
}

struct Watching {
    wanted: watch::Receiver<Option<String>>,
    stopped: watch::Receiver<bool>,
}

impl Watching {
    fn gone(&self, link_id: &str) -> bool {
        *self.stopped.borrow() || self.wanted.borrow().as_deref() != Some(link_id)
    }

    async fn until_gone(&mut self, link_id: &str) {
        let Watching { wanted, stopped } = self;
        tokio::select! {
            () = async { let _ = wanted.wait_for(|wanted| wanted.as_deref() != Some(link_id)).await; } => {}
            () = async { let _ = stopped.wait_for(|stopped| *stopped).await; } => {}
        }
    }

    /// The next link the connector is to run for; none once the server stops.
    async fn next_link(&mut self) -> Option<String> {
        if *self.stopped.borrow() {
            return None;
        }
        let Watching { wanted, stopped } = self;
        tokio::select! {
            link_id = async { wanted.wait_for(Option::is_some).await.ok().and_then(|link_id| link_id.clone()) } => link_id,
            () = async { let _ = stopped.wait_for(|stopped| *stopped).await; } => None,
        }
    }

    /// Waits `wait`, and says whether the link is still wanted after it.
    async fn pause(&mut self, link_id: &str, wait: Duration) -> bool {
        tokio::select! {
            () = self.until_gone(link_id) => false,
            () = tokio::time::sleep(wait) => true,
        }
    }
}

/// One wait after each failure in a row, twice the last, up to the most.
struct Backoff(Duration);

impl Backoff {
    fn new() -> Backoff {
        Backoff(FIRST_WAIT)
    }

    fn next(&mut self) -> Duration {
        let wait = self.0;
        self.0 = (self.0 * 2).min(MOST_WAIT);
        wait
    }

    fn reset(&mut self) {
        self.0 = FIRST_WAIT;
    }
}

enum Ended {
    /// The link is no longer wanted, or the server stops.
    Unwanted,
    /// The connector could not be run.
    Missing,
    /// The server has no tunnel token to give it.
    Token,
    Exited {
        connected: bool,
    },
    Refused,
}

/// Runs the connector for `link_id` until the link is no longer wanted.
async fn serve(app: &Arc<App>, watching: &mut Watching, link_id: &str) {
    let mut waits = Backoff::new();
    while !watching.gone(link_id) {
        let ended = match tunnel_token(app, link_id).await {
            Some(token) => match attempt(app, watching, link_id, &token).await {
                Ended::Refused => match renew(app, link_id, &token).await {
                    Renewed::Changed => {
                        waits.reset();
                        continue;
                    }
                    Renewed::Same | Renewed::Gone => Ended::Refused,
                },
                other => other,
            },
            None => Ended::Token,
        };
        match ended {
            Ended::Unwanted => break,
            Ended::Missing => report(app, Condition::Failed, Some("missing")).await,
            Ended::Token => report(app, Condition::Failed, Some("token")).await,
            Ended::Refused => report(app, Condition::Failed, Some("refused")).await,
            Ended::Exited { connected } => {
                if connected {
                    waits.reset();
                }
                report(app, Condition::Reconnecting, None).await;
            }
        }
        if !watching.pause(link_id, waits.next()).await {
            break;
        }
    }
    report(app, Condition::Stopped, None).await;
}

/// Records the state, and tells the stream when it changed what a linked link shows.
async fn report(app: &Arc<App>, condition: Condition, reason: Option<&'static str>) {
    if !app
        .cloud
        .connector
        .take(condition, reason, app.clock.instant())
    {
        return;
    }
    tracing::info!(
        state = condition.word(),
        "The tunnel connector changed state"
    );
    if condition == Condition::Stopped {
        return;
    }
    let writing = app.clone();
    let announced = app
        .write(&Caller::Server, "cloud.connector", move |unit| {
            announce_if_linked(unit, &writing)
        })
        .await;
    if let Err(refusal) = announced {
        tracing::warn!(
            code = refusal.code.wire(),
            "The state of the tunnel connector could not be announced"
        );
    }
}

/// The tunnel token of the link, if it is `link_id` and linked.
async fn tunnel_token(app: &Arc<App>, link_id: &str) -> Option<Secret> {
    let link = app.db.read(store::read).await.ok()??;
    if link.link_id != link_id || link.state != State::Linked {
        return None;
    }
    app.settings
        .sealer()
        .open(TUNNEL_TOKEN, link.tunnel_token.as_ref()?)
}

enum Renewed {
    /// Marfa Cloud gave another token, which is kept.
    Changed,
    Same,
    /// Marfa Cloud does not know the link, which is ended here.
    Gone,
}

/// Asks Marfa Cloud for the link's current tunnel token, after the connector was refused `refused`.
async fn renew(app: &Arc<App>, link_id: &str, refused: &Secret) -> Renewed {
    let Some(link) = app
        .db
        .read(store::read)
        .await
        .ok()
        .flatten()
        .filter(|link| link.link_id == link_id && link.state == State::Linked)
    else {
        return Renewed::Same;
    };
    let Some(credential) = link
        .link_credential
        .as_ref()
        .and_then(|sealed| app.settings.sealer().open(LINK_CREDENTIAL, sealed))
    else {
        return Renewed::Same;
    };
    let answer = client::send(
        app,
        Method::Post(json!({})),
        "/link/token",
        Some(&credential),
    )
    .await;
    match answer {
        Ok(answer) if answer.status == 200 => {
            let Some(fresh) =
                text_at(&answer.body, "tunnel_token").filter(|fresh| fresh != refused.expose())
            else {
                return Renewed::Same;
            };
            keep(app, link_id, fresh).await
        }
        Ok(answer) if answer.status == 401 => {
            if let Err(refusal) = end_by_service(app, &link, false).await {
                tracing::warn!(
                    code = refusal.code.wire(),
                    "The link Marfa Cloud ended could not be ended here"
                );
            }
            app.cloud.wake();
            Renewed::Gone
        }
        Ok(_) | Err(_) => Renewed::Same,
    }
}

/// Seals the new token in place of the old one.
async fn keep(app: &Arc<App>, link_id: &str, fresh: String) -> Renewed {
    let Ok(sealed) = seal(app.settings.sealer(), TUNNEL_TOKEN, fresh) else {
        return Renewed::Same;
    };
    let kept = write_link(app, "cloud.link_token", link_id, move |_, link| {
        if link.state == State::Linked {
            link.tunnel_token = Some(sealed);
        }
        Ok(())
    })
    .await;
    match kept {
        Ok(true) => Renewed::Changed,
        Ok(false) | Err(_) => Renewed::Same,
    }
}

/// Runs the connector once, and leaves it ended and its token file removed.
async fn attempt(app: &Arc<App>, watching: &mut Watching, link_id: &str, token: &Secret) -> Ended {
    let configured = app.settings.start.connector.clone();
    let Ok(Some(program)) =
        tokio::task::spawn_blocking(move || locate(configured.as_deref())).await
    else {
        return Ended::Missing;
    };
    let database = app.settings.start.database.clone();
    let text = token.expose().to_string();
    let written = tokio::task::spawn_blocking(move || write_token_file(&database, &text)).await;
    let file = match written {
        Ok(Ok(file)) => file,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "The file of the tunnel token could not be made");
            return Ended::Token;
        }
        Err(_) => return Ended::Token,
    };
    let ended = run(app, watching, link_id, token, &program, &file).await;
    remove_token_file(file).await;
    ended
}

async fn run(
    app: &Arc<App>,
    watching: &mut Watching,
    link_id: &str,
    token: &Secret,
    program: &Path,
    file: &Path,
) -> Ended {
    let Some(port) = free_port().await else {
        return Ended::Exited { connected: false };
    };
    let mut child = match spawn(program, port, file) {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(error = %error, "The tunnel connector could not be run");
            return Ended::Missing;
        }
    };
    report(app, Condition::Starting, None).await;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        stop(&mut child).await;
        return Ended::Exited { connected: false };
    };
    let mut output = Output::new(stdout, stderr, token);
    let mut connected = false;
    let mut ever = false;
    let mut poll_at = Instant::now() + POLL_UNTIL_READY;
    let ended = loop {
        tokio::select! {
            () = watching.until_gone(link_id) => break Ended::Unwanted,
            line = output.next() => {
                if let Some(refused) = line && refused {
                    break Ended::Refused;
                }
            }
            status = child.wait() => {
                output.drain().await;
                match status {
                    Ok(status) => tracing::warn!(exit = %status, "The tunnel connector ended"),
                    Err(_) => tracing::warn!("The tunnel connector could not be waited for"),
                }
                break if output.refused {
                    Ended::Refused
                } else {
                    Ended::Exited { connected: ever }
                };
            }
            () = tokio::time::sleep_until(poll_at) => {
                let ready = ready(port).await;
                let next = match (connected, ready) {
                    (false, true) => Some(Condition::Connected),
                    (true, false) => Some(Condition::Reconnecting),
                    _ => None,
                };
                connected = ready;
                ever |= ready;
                if let Some(condition) = next {
                    report(app, condition, None).await;
                }
                poll_at = Instant::now() + if connected { POLL_WHILE_READY } else { POLL_UNTIL_READY };
            }
        }
    };
    stop(&mut child).await;
    ended
}

/// The connector's output, read a line at a time, with the token kept out of what is logged.
struct Output<'a> {
    stdout: Option<Lines<BufReader<ChildStdout>>>,
    stderr: Option<Lines<BufReader<ChildStderr>>>,
    token: &'a Secret,
    refused: bool,
}

impl<'a> Output<'a> {
    fn new(stdout: ChildStdout, stderr: ChildStderr, token: &'a Secret) -> Output<'a> {
        Output {
            stdout: Some(BufReader::new(stdout).lines()),
            stderr: Some(BufReader::new(stderr).lines()),
            token,
            refused: false,
        }
    }

    /// Logs the next line either stream gives, and says whether it refuses the token. Waits for ever once both end.
    async fn next(&mut self) -> Option<bool> {
        let Output { stdout, stderr, .. } = self;
        let line = tokio::select! {
            line = next_line(stdout) => line,
            line = next_line(stderr) => line,
        };
        let text = line?;
        let refused = self.note(&text);
        Some(refused)
    }

    fn note(&mut self, text: &str) -> bool {
        let line = tidy(text, self.token.expose());
        if REFUSALS.iter().any(|text| line.contains(text)) {
            self.refused = true;
        }
        if line.contains(" ERR ") || line.contains(" WRN ") {
            tracing::warn!(line = %line, "The tunnel connector printed a line");
        } else {
            tracing::info!(line = %line, "The tunnel connector printed a line");
        }
        self.refused
    }

    /// Logs what the connector printed before it ended.
    async fn drain(&mut self) {
        let _ = tokio::time::timeout(DRAIN_FOR, async {
            while let Some(refused) = self.next_or_end().await {
                let _ = refused;
            }
        })
        .await;
    }

    async fn next_or_end(&mut self) -> Option<bool> {
        if self.stdout.is_none() && self.stderr.is_none() {
            return None;
        }
        self.next().await
    }
}

/// The next line of `lines`, never after it ends or fails: that stream is closed and the other goes on.
async fn next_line<R: tokio::io::AsyncRead + Unpin>(
    lines: &mut Option<Lines<BufReader<R>>>,
) -> Option<String> {
    let Some(open) = lines else {
        return std::future::pending().await;
    };
    match open.next_line().await {
        Ok(Some(line)) => Some(line),
        Ok(None) | Err(_) => {
            *lines = None;
            std::future::pending().await
        }
    }
}

/// A line as it is logged: no control characters, no longer than it need be, and no token.
fn tidy(text: &str, token: &str) -> String {
    let mut line: String = text
        .chars()
        .filter(|character| !character.is_control() || *character == '\t')
        .take(MOST_LINE)
        .collect();
    if !token.is_empty() {
        line = line.replace(token, "[token]");
    }
    line
}

fn spawn(program: &Path, port: u16, file: &Path) -> io::Result<Child> {
    let mut command = Command::new(program);
    command
        .args(["tunnel", "--no-autoupdate", "--metrics"])
        .arg(format!("127.0.0.1:{port}"))
        .args(["run", "--token-file"])
        .arg(file)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in KEPT_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.spawn()
}

/// A loopback port that was free.
async fn free_port() -> Option<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.ok()?;
    listener.local_addr().ok().map(|address| address.port())
}

/// Asks the connector whether it is ready; any other answer, or none, is no.
async fn ready(port: u16) -> bool {
    let asked = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        stream
            .write_all(b"GET /ready HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .ok()?;
        let mut start = [0u8; 12];
        stream.read_exact(&mut start).await.ok()?;
        Some(is_ok(&start))
    };
    tokio::time::timeout(POLL_TIMEOUT, asked)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

fn is_ok(start: &[u8]) -> bool {
    start.starts_with(b"HTTP/1.") && start.get(8..12) == Some(b" 200")
}

/// Asks the connector to end, and kills it if it has not by the end of the grace.
async fn stop(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let pid = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .and_then(rustix::process::Pid::from_raw);
    if let Some(pid) = pid {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
    }
    if tokio::time::timeout(GRACE, child.wait()).await.is_err()
        && let Err(error) = child.kill().await
    {
        tracing::warn!(error = %error, "The tunnel connector could not be killed");
    }
}

/// The file to run, which is only ever one the owner or the installation put in place.
fn locate(configured: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = configured {
        return Some(path.to_path_buf());
    }
    let executable = std::env::current_exe().and_then(fs::canonicalize).ok()?;
    Some(executable.parent()?.join(PROGRAM))
}

/// Where the token's file is: in a folder of its own beside the database, which only the server's account reaches.
fn token_folder(database: &DatabasePath) -> PathBuf {
    match database.file() {
        Some(file) => file
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .join("connector"),
        None => std::env::temp_dir().join(format!("marfa-connector-{}", std::process::id())),
    }
}

fn token_path(database: &DatabasePath) -> PathBuf {
    token_folder(database).join(TOKEN_FILE)
}

fn write_token_file(database: &DatabasePath, token: &str) -> io::Result<PathBuf> {
    let folder = std::path::absolute(token_folder(database))?;
    match DirBuilder::new().mode(0o700).create(&folder) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let found = fs::symlink_metadata(&folder)?;
    if !found.is_dir()
        || found.uid() != rustix::process::geteuid().as_raw()
        || found.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "the folder is not the server's alone",
        ));
    }
    let path = folder.join(TOKEN_FILE);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(token.as_bytes())?;
    Ok(path)
}

async fn remove_token_file(path: PathBuf) {
    let removed = tokio::task::spawn_blocking(move || fs::remove_file(&path)).await;
    if let Ok(Err(error)) = removed
        && error.kind() != ErrorKind::NotFound
    {
        tracing::warn!(error = %error, "The file of the tunnel token could not be removed");
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn a_failure_waits_twice_as_long_each_time_up_to_a_minute_and_a_good_run_starts_over() {
        let mut waits = Backoff::new();
        let seconds: Vec<u64> = (0..9).map(|_| waits.next().as_secs()).collect();
        assert_eq!(seconds, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
        waits.reset();
        assert_eq!(waits.next().as_secs(), 1);
    }

    #[test]
    fn a_line_loses_its_token_and_its_control_characters_and_is_cut_short() {
        let token = "eyJhIjoiYWNjb3VudCJ9";
        assert_eq!(
            tidy(&format!("INF token {token} used {token}"), token),
            "INF token [token] used [token]"
        );
        assert_eq!(tidy("one\u{1b}[31m\ttwo\r", token), "one[31m\ttwo");
        assert_eq!(tidy(&"x".repeat(5_000), token).len(), MOST_LINE);
        assert_eq!(tidy("anything", ""), "anything");
    }

    #[test]
    fn only_a_200_from_the_connector_reads_as_ready() {
        assert!(is_ok(b"HTTP/1.1 200 "));
        assert!(is_ok(b"HTTP/1.0 200 "));
        assert!(!is_ok(b"HTTP/1.1 503 "));
        assert!(!is_ok(b"HTTP/1.1 204 "));
        assert!(!is_ok(b"SSH-2.0-open"));
        assert!(!is_ok(b""));
    }

    #[test]
    fn the_connector_beside_the_server_is_found_through_every_link_and_one_that_is_named_is_used_as_named()
     {
        let named = PathBuf::from("/opt/connector/cloudflared");
        assert_eq!(locate(Some(&named)), Some(named));
        // Not through PATH: the test program's own folder holds no such file, and none is returned.
        let found = locate(None).unwrap();
        assert_eq!(found.file_name().unwrap(), PROGRAM);
        assert!(found.is_absolute());

        let dir = TempDir::new().unwrap();
        let real = dir.path().join("libexec");
        fs::create_dir(&real).unwrap();
        fs::create_dir(dir.path().join("bin")).unwrap();
        fs::write(real.join("marfa-server"), "").unwrap();
        std::os::unix::fs::symlink(
            "../libexec/marfa-server",
            dir.path().join("bin").join("marfa"),
        )
        .unwrap();
        let through = fs::canonicalize(dir.path().join("bin").join("marfa")).unwrap();
        assert_eq!(
            through.parent().unwrap().join(PROGRAM),
            fs::canonicalize(&real).unwrap().join(PROGRAM)
        );
    }

    #[test]
    fn the_token_is_written_to_a_file_only_the_server_reads_and_replaces_one_left_behind() {
        let dir = TempDir::new().unwrap();
        let database = DatabasePath::File(dir.path().join("marfa.db"));
        let first = write_token_file(&database, "first").unwrap();
        assert_eq!(first, token_path(&database).canonicalize().unwrap());
        assert_eq!(fs::read_to_string(&first).unwrap(), "first");
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&first), 0o600);
        assert_eq!(mode(first.parent().unwrap()), 0o700);
        let second = write_token_file(&database, "second").unwrap();
        assert_eq!(fs::read_to_string(&second).unwrap(), "second");
    }

    #[test]
    fn a_folder_others_can_reach_is_not_one_the_token_is_written_in() {
        let dir = TempDir::new().unwrap();
        let database = DatabasePath::File(dir.path().join("marfa.db"));
        let folder = dir.path().join("connector");
        fs::create_dir(&folder).unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        let refused = write_token_file(&database, "token").unwrap_err();
        assert_eq!(refused.kind(), ErrorKind::PermissionDenied);
        assert!(!folder.join(TOKEN_FILE).exists());
    }
}
