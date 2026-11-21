use std::io::{BufRead, IsTerminal, Write};
use std::sync::atomic::Ordering;
use std::time::Duration;

use clap::{Args, Subcommand};
use serde_json::{Value, json};

use crate::commands::login::open_browser;
use crate::error::{CliError, Exit};
use crate::interrupt;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum CloudCommand {
    /// Link this instance to Marfa Cloud: print a code and an approval page,
    /// wait for the owner to approve the link there, then show the link.
    /// Needs `config.manage`.
    ///
    /// Check that the code on the approval page matches the one printed here,
    /// and approve only if it does. The page is opened in a browser only when
    /// this command runs on the instance's own machine and reaches it through
    /// its local socket; with a key or an app sign-in it is printed and never
    /// opened, so nothing the server sends can lead a browser to approve
    /// another instance.
    ///
    /// The command waits until the link is approved, refused or has expired,
    /// as the server decides; it has no time limit of its own. Ctrl-C leaves
    /// the link pending: run `marfa cloud link` again to wait on it, or
    /// `marfa cloud unlink` to cancel it. A link that is already pending is
    /// waited on as it was started, and a link that is already made is
    /// refused.
    ///
    /// The instance's sign-in address moves to Marfa Cloud by default. A key
    /// cannot move it: the link is made, the address stays, and the command
    /// that moves it from an app sign-in or the local socket is printed. When
    /// the move needs confirming, the consequences are printed and asked
    /// about at a terminal; without one, pass --confirm-address-change to
    /// accept them, or --keep-sign-in-address to leave the address alone.
    ///
    /// Exit 0: linked, or the sign-in address move waits as printed. Exit 1:
    /// the server refused, or the link was refused, expired or ended. Exit 3:
    /// the server could not be reached for a minute. Exit 5: the credential
    /// was refused. Exit 130: ended with Ctrl-C.
    ///
    /// Under --json two records come out, one per line: the pending link as
    /// soon as it exists, then the link as the wait ended.
    Link(LinkArgs),
    /// End the link, or cancel one that is still pending. Needs
    /// `config.manage`.
    ///
    /// Where the link moved the sign-in address, unlinking puts it back,
    /// which signs everyone out. That needs an app sign-in from the last
    /// fifteen minutes or the local socket, never a key, and it needs
    /// confirming: the consequences are printed and asked about at a
    /// terminal; without one, pass --confirm-address-change.
    ///
    /// Marfa Cloud is told when the instance is unlinked. If it cannot be
    /// reached the command says so, and the instance keeps trying.
    ///
    /// Exit 0: nothing is linked any more. Exit 1: the server refused,
    /// ending nothing. Exit 5: the credential was refused.
    Unlink(UnlinkArgs),
    /// The link to Marfa Cloud: whether it is waiting for approval, made,
    /// failed or absent, with its name, address, the connector and where the
    /// sign-in address stands. Needs `config.manage`.
    ///
    /// Exit 0 whenever the link could be read, whatever its state. Exit 1:
    /// the server refused. Exit 5: the credential was refused.
    Status,
}

#[derive(Debug, Args)]
pub struct LinkArgs {
    /// Leave the sign-in address where it is instead of moving it to Marfa
    /// Cloud.
    #[arg(long, conflicts_with = "confirm_address_change")]
    keep_sign_in_address: bool,
    /// Accept moving the sign-in address, which signs everyone out and can
    /// strand passkeys and apps, without being asked.
    #[arg(long)]
    confirm_address_change: bool,
}

#[derive(Debug, Args)]
pub struct UnlinkArgs {
    /// Accept putting the sign-in address back, which signs everyone out and
    /// can strand passkeys and apps, without being asked.
    #[arg(long)]
    confirm_address_change: bool,
}

const UNCONFIRMED: &str = "sign_in_address_change_unconfirmed";

/// How often the link is read while waiting on it.
const POLL: Duration = Duration::from_secs(2);

/// How long a link that is made but whose sign-in address is still moving is
/// read before the result is printed with the move still pending.
const SETTLE: Duration = Duration::from_secs(20);

/// How long the server may fail to answer, one read after another, before the
/// wait gives up and says how to resume.
const OUTAGE: Duration = Duration::from_secs(60);

/// How often the stop is looked for between two reads.
const TICK: Duration = Duration::from_millis(100);

pub fn status_request() -> Request {
    Request::get(&["cloud", "link"])
}

pub fn start_request(keep: bool, confirmed: bool) -> Request {
    let mut body = json!({ "sign_in_address": if keep { "keep" } else { "move" } });
    if confirmed {
        body["confirm_sign_in_address_change"] = true.into();
    }
    Request::post(&["cloud", "link"]).json(body)
}

pub fn unlink_request(confirmed: bool) -> Request {
    Request::delete(&["cloud", "link"]).query_flag("confirm_sign_in_address_change", confirmed)
}

/// What the wait needs of the process: arming the stop once the wait begins,
/// and pausing between two reads.
trait Waiter {
    fn arm(&mut self);
    /// Pauses, and says whether the person stopped the command meanwhile.
    fn stopped_after(&mut self, pause: Duration) -> bool;
}

struct Live;

impl Waiter for Live {
    fn arm(&mut self) {
        interrupt::stop_on_interrupt();
    }

    fn stopped_after(&mut self, pause: Duration) -> bool {
        let mut left = pause;
        while !left.is_zero() {
            if interrupt::stop().load(Ordering::Relaxed) {
                return true;
            }
            let step = left.min(TICK);
            std::thread::sleep(step);
            left -= step;
        }
        interrupt::stop().load(Ordering::Relaxed)
    }
}

pub fn run(command: CloudCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        CloudCommand::Link(args) => link(&args, remote, out, &mut Live),
        CloudCommand::Unlink(args) => unlink(&args, remote, out),
        CloudCommand::Status => {
            let answer = remote.json(&status_request())?;
            out.report(&answer, status_text)
        }
    }
}

fn state(link: &Value) -> &str {
    link.get("state").and_then(Value::as_str).unwrap_or("")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn sign_in_state(link: &Value) -> &str {
    link.get("sign_in_address")
        .map_or("", |address| text(address, "state"))
}

/// Whether the answer is the server's refusal to move the sign-in address
/// until it is confirmed.
fn is_unconfirmed(error: &CliError) -> bool {
    matches!(error, CliError::Refused { status: 409, code, .. } if code == UNCONFIRMED)
}

/// The consequences a refusal lists, one sentence each.
fn consequences(error: &CliError) -> Vec<String> {
    let CliError::Refused {
        details: Some(details),
        ..
    } = error
    else {
        return Vec::new();
    };
    details
        .get("consequences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|consequence| consequence.get("sentence").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn at_terminal() -> bool {
    std::io::stdin().is_terminal() && crate::output::stderr_is_terminal()
}

fn agrees(answer: &str) -> bool {
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

fn ask(sentences: &[String], question: &str) -> Result<bool, CliError> {
    crate::errln!("Making the change:");
    for sentence in sentences {
        crate::errln!("  - {sentence}");
    }
    {
        let mut err = crate::output::stderr();
        write!(err, "{question} [y/N] ")?;
        err.flush()?;
    }
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(agrees(&answer))
}

/// Sends the request, and where the server wants the sign-in address change
/// confirmed asks the person at a terminal and sends it again confirmed.
/// Without a terminal the server's refusal stands, and carries the
/// consequences.
fn confirming(
    remote: &Remote,
    confirmed: bool,
    request: impl Fn(bool) -> Request,
    question: &str,
    declined: &str,
) -> Result<Value, CliError> {
    if confirmed {
        return remote.json(&request(true));
    }
    let refused = match remote.json(&request(false)) {
        Err(error) => error,
        answered => return answered,
    };
    if !is_unconfirmed(&refused) || !at_terminal() {
        return Err(refused);
    }
    if !ask(&consequences(&refused), question)? {
        return Err(CliError::Invalid(declined.into()));
    }
    remote.json(&request(true))
}

fn link(
    args: &LinkArgs,
    remote: &Remote,
    out: &Printer,
    waiter: &mut impl Waiter,
) -> Result<(), CliError> {
    let seen = remote.json(&status_request())?;
    let (pending, fresh) = match state(&seen) {
        "linking" => {
            if args.keep_sign_in_address && sign_in_state(&seen) != "kept" {
                return Err(CliError::Invalid(
                    "the link that is waiting for approval was started to move the sign-in address: run `marfa cloud unlink` to cancel it, then `marfa cloud link --keep-sign-in-address` to start another".into(),
                ));
            }
            crate::errln!("A link is already waiting for approval; waiting on it.");
            (seen, false)
        }
        "linked" => {
            return Err(CliError::Invalid(format!(
                "this instance is already linked to Marfa Cloud as {} ({}): `marfa cloud status` shows the link, and `marfa cloud unlink` ends it",
                text(&seen, "name"),
                text(&seen, "address")
            )));
        }
        _ => {
            let started = confirming(
                remote,
                args.confirm_address_change,
                |confirmed| start_request(args.keep_sign_in_address, confirmed),
                "Move the sign-in address to Marfa Cloud?",
                "the sign-in address change was not confirmed, so no link was started: run `marfa cloud link --keep-sign-in-address` to link without moving it",
            )?;
            (started, true)
        }
    };
    let local = remote.is_local();
    out.record(&pending, approval_text)?;
    if fresh && local {
        open_approval(&pending);
    }
    follow(remote, out, waiter)
}

/// The approval page is opened for a link this command started, on the
/// instance's own machine, and only where it is a web page.
fn open_approval(link: &Value) {
    let page = link
        .get("linking")
        .map_or("", |linking| text(linking, "approval_url"));
    if url::Url::parse(page).is_ok_and(|page| matches!(page.scheme(), "http" | "https")) {
        open_browser(page);
    }
}

fn approval_text(link: &Value) -> String {
    let linking = link.get("linking").cloned().unwrap_or(Value::Null);
    let mut lines = vec![
        "Approve the link on this page:".to_string(),
        format!("  {}", text(&linking, "approval_url")),
        format!(
            "The code on that page must read: {}",
            crate::style::bold(crate::style::Stream::Out, text(&linking, "user_code"))
        ),
        "Approve it only if the code matches; if it differs, the page is not for this link."
            .to_string(),
    ];
    if let Some(line) = sign_in_line(link) {
        lines.push(line);
    }
    lines.join("\n")
}

fn sign_in_line(link: &Value) -> Option<String> {
    let address = link.get("sign_in_address")?;
    let held = text(address, "address");
    Some(match text(address, "state") {
        "moved" => format!("Sign-in address: moved to Marfa Cloud, now {held}."),
        "kept" => format!("Sign-in address: kept as {held}."),
        "pending" => format!(
            "Sign-in address: {held} for now. This instance moves it once the Marfa Cloud address answers as this instance, and keeps trying."
        ),
        "waiting" => match address.get("next_step") {
            Some(step) => format!(
                "Sign-in address: kept as {held}, not moved. To move it, from an app sign-in or the local socket, run:\n  {}",
                text(step, "command")
            ),
            None => format!(
                "Sign-in address: stays {held} until it is moved, which a key cannot do; the command that moves it is printed once the link is made."
            ),
        },
        _ => return None,
    })
}

fn failure_sentence(failure: &Value) -> String {
    let reason = match text(failure, "reason") {
        "denied" => "the link was refused on the approval page",
        "expired" => "the link expired before it was approved",
        "refused" => "Marfa Cloud refused the link",
        "unlinked" => "the link was ended",
        "unreadable" => "the link could not be read",
        other => other,
    };
    match failure.get("message").and_then(Value::as_str) {
        Some(message) if !message.is_empty() => format!("{reason}: {message}"),
        _ => reason.to_string(),
    }
}

pub fn status_text(link: &Value) -> String {
    let mut lines = Vec::new();
    match state(link) {
        "not_linked" => {
            lines.push("Not linked to Marfa Cloud.".to_string());
            if let Some(ended) = link.get("ended") {
                lines.push(match text(ended, "reason") {
                    "unlinked_by_service" => {
                        format!("Marfa Cloud ended the link at {}.", text(ended, "ended_at"))
                    }
                    other => format!("The last link ended: {other}."),
                });
            }
        }
        "linking" => {
            lines.push("Waiting for the link to be approved.".to_string());
            lines.push(approval_text(link));
            if let Some(expires) = link
                .get("linking")
                .map(|linking| text(linking, "expires_at"))
            {
                lines.push(format!("The code expires at {expires}."));
            }
            return lines.join("\n");
        }
        "linked" => {
            lines.push(format!("Linked to Marfa Cloud as {}.", text(link, "name")));
            lines.push(format!("  Address:   {}", text(link, "address")));
            lines.push(format!("  Linked at: {}", text(link, "linked_at")));
            if let Some(connector) = link.get("connector") {
                let since = text(connector, "since");
                lines.push(if since.is_empty() {
                    format!("  Connector: {}", text(connector, "state"))
                } else {
                    format!("  Connector: {} since {since}", text(connector, "state"))
                });
            }
        }
        "failed" => {
            let failure = link.get("failure").cloned().unwrap_or(Value::Null);
            lines.push(format!("The link failed: {}.", failure_sentence(&failure)));
        }
        other => lines.push(format!("The link is {other}.")),
    }
    if let Some(line) = sign_in_line(link) {
        lines.push(line);
    }
    lines.join("\n")
}

/// Whether a failure is the server or the network being away, which reading
/// again can clear.
fn transient(error: &CliError) -> bool {
    error.exit() == Exit::Environment
}

fn follow(remote: &Remote, out: &Printer, waiter: &mut impl Waiter) -> Result<(), CliError> {
    waiter.arm();
    crate::errln!(
        "Waiting for approval. Ctrl-C leaves the link pending; `marfa cloud link` waits on it again."
    );
    let mut settled = Duration::ZERO;
    let mut away = Duration::ZERO;
    loop {
        match remote.json(&status_request()) {
            Ok(link) => {
                away = Duration::ZERO;
                match state(&link) {
                    "linked" => {
                        if sign_in_state(&link) != "pending" || settled >= SETTLE {
                            return out.record(&link, status_text);
                        }
                        settled += POLL;
                    }
                    "failed" => {
                        if out.json {
                            out.record(&link, |_| String::new())?;
                        }
                        let failure = link.get("failure").cloned().unwrap_or(Value::Null);
                        let mut message =
                            format!("the link failed: {}", failure_sentence(&failure));
                        if sign_in_state(&link) == "moved" {
                            message.push_str(
                                "; the sign-in address is still moved, and `marfa cloud unlink` puts it back",
                            );
                        }
                        return Err(CliError::CloudLinkFailed(message));
                    }
                    "not_linked" => {
                        if out.json {
                            out.record(&link, |_| String::new())?;
                        }
                        return Err(CliError::CloudLinkFailed(
                            "the link was cancelled or ended before it was made".into(),
                        ));
                    }
                    _ => {}
                }
            }
            Err(error) if transient(&error) => {
                away += POLL;
                if away > OUTAGE {
                    crate::errln!(
                        "The link stays pending. Run `marfa cloud link` to wait on it again, or `marfa cloud status` to read it."
                    );
                    return Err(error);
                }
            }
            Err(error) => {
                if matches!(error, CliError::Refused { status: 401, .. }) {
                    crate::errln!(
                        "The sign-in ended while waiting. Moving the sign-in address ends every sign-in: run `marfa login` again, then `marfa cloud status` to read the link."
                    );
                }
                return Err(error);
            }
        }
        if waiter.stopped_after(POLL) {
            interrupt::ended_by_interrupt();
            crate::errln!(
                "The link stays pending. Run `marfa cloud link` to wait on it again, or `marfa cloud unlink` to cancel it."
            );
            return Ok(());
        }
    }
}

fn unlink(args: &UnlinkArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let before = remote.json(&status_request())?;
    let answer = confirming(
        remote,
        args.confirm_address_change,
        unlink_request,
        "Put the sign-in address back and unlink?",
        "the sign-in address change was not confirmed, so nothing was changed",
    )?;
    out.report(&answer, |answer| unlinked_text(&before, answer))
}

fn unlinked_text(before: &Value, answer: &Value) -> String {
    let mut lines = vec![match state(before) {
        "linking" => "Cancelled the link that was waiting for approval.".to_string(),
        "linked" => format!("Unlinked from Marfa Cloud ({}).", text(before, "name")),
        "failed" => "Cleared the link that failed.".to_string(),
        _ => "Nothing was linked.".to_string(),
    }];
    if sign_in_state(before) == "moved" {
        lines.push("The sign-in address is put back; every sign-in ended with the move.".into());
    }
    if answer.get("service_told") == Some(&Value::Bool(false)) {
        lines.push(
            "Marfa Cloud could not be told, so it may still list this instance; this instance keeps trying."
                .into(),
        );
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::door::{Answer, Door};

    struct Scripted {
        stops_after: Option<usize>,
        pauses: usize,
    }

    impl Scripted {
        fn never_stopped() -> Scripted {
            Scripted {
                stops_after: None,
                pauses: 0,
            }
        }
    }

    impl Waiter for Scripted {
        fn arm(&mut self) {}
        fn stopped_after(&mut self, _: Duration) -> bool {
            self.pauses += 1;
            self.stops_after == Some(self.pauses)
        }
    }

    fn ok(body: Value) -> Answer {
        Answer::json("200 OK", &body.to_string())
    }

    fn created(body: Value) -> Answer {
        Answer::json("201 Created", &body.to_string())
    }

    fn refused(status: &'static str, code: &str) -> Answer {
        Answer::json(
            status,
            &json!({"error": {"code": code, "message": "no", "details": {"consequences": [
                {"code": "everyone_signed_out", "sentence": "Everyone is signed out.", "count": 2}
            ]}}})
            .to_string(),
        )
    }

    fn linking(sign_in: &str) -> Value {
        json!({
            "state": "linking",
            "linking": {"user_code": "ABCD-1234", "approval_url": "https://cloud.example/link/abc", "expires_at": "2026-01-01T00:00:00Z"},
            "sign_in_address": {"state": sign_in, "address": "https://home.example"},
        })
    }

    fn linked(sign_in: &str) -> Value {
        json!({
            "state": "linked", "name": "Home", "address": "https://home.cloud.example",
            "linked_at": "2026-01-01T00:00:00Z",
            "connector": {"state": "stopped", "since": "2026-01-01T00:00:00Z"},
            "sign_in_address": {"state": sign_in, "address": "https://home.example"},
        })
    }

    fn args(keep: bool, confirm: bool) -> LinkArgs {
        LinkArgs {
            keep_sign_in_address: keep,
            confirm_address_change: confirm,
        }
    }

    fn by_key(door: &Door) -> Remote {
        Remote::keyed(&door.url, "marfa_k1_x").unwrap()
    }

    fn seen(door: Door) -> Vec<String> {
        door.received()
            .iter()
            .map(|request| format!("{} {}", request.method(), request.path()))
            .collect()
    }

    #[test]
    fn requests_name_the_move_and_the_confirmation() {
        assert_eq!(start_request(false, false).segments, ["cloud", "link"]);
        let body = |request: Request| match request.body {
            crate::remote::request::Body::Json(body) => body,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            body(start_request(false, false)),
            json!({"sign_in_address": "move"})
        );
        assert_eq!(
            body(start_request(true, false)),
            json!({"sign_in_address": "keep"})
        );
        assert_eq!(
            body(start_request(false, true)),
            json!({"sign_in_address": "move", "confirm_sign_in_address_change": true})
        );
    }

    #[test]
    fn only_a_plain_yes_confirms() {
        for yes in ["y", "Y\n", " yes ", "YES"] {
            assert!(agrees(yes), "{yes:?}");
        }
        for no in ["", "n", "no", "\n", "yep", "ok"] {
            assert!(!agrees(no), "{no:?}");
        }
    }

    #[test]
    fn a_pending_link_is_waited_on_and_no_other_is_started() {
        let door = Door::open(vec![
            ok(linking("pending")),
            ok(linking("pending")),
            ok(linked("moved")),
        ]);
        link(
            &args(false, false),
            &by_key(&door),
            &Printer { json: true },
            &mut Scripted::never_stopped(),
        )
        .unwrap();
        assert_eq!(
            seen(door),
            ["GET /cloud/link", "GET /cloud/link", "GET /cloud/link"]
        );
    }

    #[test]
    fn a_pending_link_that_moves_is_not_waited_on_for_a_keep() {
        let door = Door::open(vec![ok(linking("pending"))]);
        let error = link(
            &args(true, false),
            &by_key(&door),
            &Printer { json: true },
            &mut Scripted::never_stopped(),
        )
        .unwrap_err();
        assert!(matches!(error, CliError::Invalid(_)), "{error:?}");
        assert_eq!(seen(door), ["GET /cloud/link"]);
    }

    #[test]
    fn a_made_link_is_refused_and_nothing_is_started() {
        let door = Door::open(vec![ok(linked("moved"))]);
        let error = link(
            &args(false, false),
            &by_key(&door),
            &Printer { json: true },
            &mut Scripted::never_stopped(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("already linked"), "{error}");
        assert_eq!(error.exit(), Exit::Refused);
        assert_eq!(seen(door), ["GET /cloud/link"]);
    }

    #[test]
    fn a_start_without_a_terminal_stands_on_the_servers_refusal() {
        let door = Door::open(vec![
            ok(json!({"state": "not_linked"})),
            refused("409 Conflict", UNCONFIRMED),
        ]);
        let error = link(
            &args(false, false),
            &by_key(&door),
            &Printer { json: true },
            &mut Scripted::never_stopped(),
        )
        .unwrap_err();
        assert!(is_unconfirmed(&error), "{error:?}");
        assert_eq!(consequences(&error), ["Everyone is signed out."]);
        assert_eq!(seen(door), ["GET /cloud/link", "POST /cloud/link"]);
    }

    #[test]
    fn a_confirmed_start_sends_the_confirmation_with_the_first_request() {
        let door = Door::open(vec![
            ok(json!({"state": "failed", "failure": {"reason": "expired"}})),
            created(linking("pending")),
            ok(linked("moved")),
        ]);
        link(
            &args(false, true),
            &by_key(&door),
            &Printer { json: true },
            &mut Scripted::never_stopped(),
        )
        .unwrap();
        let received = door.received();
        let body: Value = serde_json::from_str(&received[1].body).unwrap();
        assert_eq!(
            body,
            json!({"sign_in_address": "move", "confirm_sign_in_address_change": true})
        );
    }

    #[test]
    fn a_link_that_fails_ends_in_an_error_naming_why() {
        let door = Door::open(vec![
            ok(json!({"state": "not_linked"})),
            created(linking("waiting")),
            ok(json!({"state": "failed", "failure": {"reason": "denied"}})),
        ]);
        let error = link(
            &args(false, false),
            &by_key(&door),
            &Printer { json: true },
            &mut Scripted::never_stopped(),
        )
        .unwrap_err();
        assert!(matches!(error, CliError::CloudLinkFailed(_)), "{error:?}");
        assert!(error.to_string().contains("refused on the approval page"));
        assert_eq!(error.exit(), Exit::Refused);
    }

    #[test]
    fn an_interrupt_leaves_the_link_pending_and_asks_nothing_more() {
        let door = Door::open(vec![
            ok(json!({"state": "not_linked"})),
            created(linking("waiting")),
            ok(linking("waiting")),
        ]);
        let mut waiter = Scripted {
            stops_after: Some(1),
            pauses: 0,
        };
        link(
            &args(false, false),
            &by_key(&door),
            &Printer { json: true },
            &mut waiter,
        )
        .unwrap();
        assert_eq!(
            seen(door),
            ["GET /cloud/link", "POST /cloud/link", "GET /cloud/link"]
        );
    }

    #[test]
    fn an_outage_longer_than_the_allowance_ends_the_wait_with_the_link_pending() {
        let door = Door::open(vec![ok(linking("waiting"))]);
        let remote = by_key(&door);
        let mut waiter = Scripted::never_stopped();
        let error = link(
            &args(false, false),
            &remote,
            &Printer { json: true },
            &mut waiter,
        )
        .unwrap_err();
        assert_eq!(error.exit(), Exit::Environment, "{error:?}");
        let allowed = (OUTAGE.as_secs() / POLL.as_secs()) as usize;
        assert_eq!(waiter.pauses, allowed, "one pause per failed read");
    }

    #[test]
    fn a_move_that_never_settles_is_reported_pending_once_the_window_ends() {
        let mut answers = vec![
            ok(json!({"state": "not_linked"})),
            created(linking("pending")),
        ];
        // One read per pause, then the read that ends the window.
        let reads = (SETTLE.as_secs() / POLL.as_secs()) as usize + 1;
        answers.extend((0..reads).map(|_| ok(linked("pending"))));
        let door = Door::open(answers);
        link(
            &args(false, false),
            &by_key(&door),
            &Printer { json: true },
            &mut Scripted::never_stopped(),
        )
        .unwrap();
        assert_eq!(seen(door).len(), 2 + reads);
    }

    #[test]
    fn a_waiting_move_names_the_command_that_makes_it() {
        let mut waiting = linked("waiting");
        waiting["sign_in_address"]["next_step"] = json!({
            "request": {"method": "PATCH", "path": "/config", "body": {}},
            "command": "marfa config set sign_in_address https://home.cloud.example --confirm-address-change",
        });
        let said = status_text(&waiting);
        assert!(said.contains("Linked to Marfa Cloud as Home."), "{said}");
        assert!(
            said.contains("marfa config set sign_in_address https://home.cloud.example"),
            "{said}"
        );
    }

    #[test]
    fn status_says_each_state_in_words() {
        let said = |link: Value| status_text(&link);
        assert!(said(json!({"state": "not_linked"})).starts_with("Not linked"));
        assert!(
            said(json!({"state": "not_linked", "ended": {"reason": "unlinked_by_service", "ended_at": "2026-01-01T00:00:00Z"}}))
                .contains("Marfa Cloud ended the link at 2026-01-01T00:00:00Z.")
        );
        let pending = said(linking("kept"));
        assert!(pending.contains("ABCD-1234"), "{pending}");
        assert!(
            pending.contains("https://cloud.example/link/abc"),
            "{pending}"
        );
        assert!(
            said(
                json!({"state": "failed", "failure": {"reason": "refused", "message": "no room"}})
            )
            .contains("Marfa Cloud refused the link: no room.")
        );
        let made = said(linked("moved"));
        assert!(made.contains("Connector: stopped since"), "{made}");
        assert!(
            made.contains("moved to Marfa Cloud, now https://home.example"),
            "{made}"
        );
    }

    #[test]
    fn unlinking_says_what_it_did_and_when_the_service_was_not_told() {
        let said = unlinked_text(
            &linked("moved"),
            &json!({"state": "not_linked", "service_told": false}),
        );
        assert!(said.contains("Unlinked from Marfa Cloud (Home)."), "{said}");
        assert!(said.contains("sign-in address is put back"), "{said}");
        assert!(said.contains("could not be told"), "{said}");
        let told = unlinked_text(
            &linked("kept"),
            &json!({"state": "not_linked", "service_told": true}),
        );
        assert!(
            !told.contains("could not be told") && !told.contains("put back"),
            "{told}"
        );
        let cancelled = unlinked_text(&linking("waiting"), &json!({"state": "not_linked"}));
        assert!(cancelled.starts_with("Cancelled"), "{cancelled}");
    }

    #[test]
    fn unlinking_without_a_terminal_stands_on_the_refusal_and_changes_nothing() {
        let door = Door::open(vec![
            ok(linked("moved")),
            refused("409 Conflict", UNCONFIRMED),
        ]);
        let error = unlink(
            &UnlinkArgs {
                confirm_address_change: false,
            },
            &by_key(&door),
            &Printer { json: true },
        )
        .unwrap_err();
        assert!(is_unconfirmed(&error), "{error:?}");
        assert_eq!(seen(door), ["GET /cloud/link", "DELETE /cloud/link"]);
    }

    #[test]
    fn each_request_is_one_the_document_publishes() {
        let door = Door::open(vec![
            ok(json!({"state": "not_linked"})),
            created(linking("kept")),
            ok(linked("kept")),
            ok(linked("kept")),
            ok(json!({"state": "not_linked", "service_told": true})),
        ]);
        let remote = by_key(&door);
        let out = Printer { json: true };
        link(
            &args(true, false),
            &remote,
            &out,
            &mut Scripted::never_stopped(),
        )
        .unwrap();
        unlink(
            &UnlinkArgs {
                confirm_address_change: true,
            },
            &remote,
            &out,
        )
        .unwrap();
        let document = crate::commands::driven::Document::read();
        let mut held = Vec::new();
        for request in door.received() {
            held.push(document.held(&request, true).unwrap());
        }
        let operations: Vec<&str> = held
            .iter()
            .map(|line| line.split(' ').next().unwrap())
            .collect();
        assert_eq!(
            operations,
            [
                "getCloudLink",
                "startCloudLink",
                "getCloudLink",
                "getCloudLink",
                "unlinkCloud"
            ]
        );
    }

    #[test]
    fn a_confirmed_unlink_sends_the_confirmation_in_the_query() {
        let door = Door::open(vec![
            ok(linked("moved")),
            ok(json!({"state": "not_linked", "service_told": true})),
        ]);
        unlink(
            &UnlinkArgs {
                confirm_address_change: true,
            },
            &by_key(&door),
            &Printer { json: true },
        )
        .unwrap();
        assert_eq!(
            seen(door),
            [
                "GET /cloud/link",
                "DELETE /cloud/link?confirm_sign_in_address_change=true"
            ]
        );
    }
}
