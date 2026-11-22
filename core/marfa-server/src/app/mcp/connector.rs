//! A confirmation binds deleting a connector, clearing its state or retiring an endpoint to what
//! its preview showed, and the act runs in the write that spends it.

use std::sync::Arc;

use super::confirm::{self, Bound, Opening};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::connectors::{self, Clearing, Deletion};
use crate::app::inbound::{self, Retiring};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;

pub const DELETE_TOOL: &str = "marfa_delete_connector";
pub const RETIRE_TOOL: &str = "marfa_retire_endpoint";

/// What a confirmed call did: `D` the change it made, `S` what a repeat reads of the change spent.
#[derive(Debug, PartialEq, Eq)]
pub enum Confirmed<D = i64, S = i64> {
    Done {
        total: D,
    },
    /// This credential spent the token on this target, and that change committed.
    Repeated {
        total: S,
    },
    /// The token is not this credential's for this target, or it expired. Nothing was read.
    Stale,
    /// The target is gone or not as the preview showed it.
    Changed,
}

/// The connector a delete names, or the source state a clear names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Registration,
    State,
}

impl Part {
    fn target(self, id: &str) -> String {
        let named = match self {
            Part::Registration => format!("connector {id}"),
            Part::State => format!("state {id}"),
        };
        confirm::ids_digest(&[named])
    }
}

fn endpoint_target(connector_id: &str, endpoint_id: &str) -> String {
    confirm::ids_digest(&[format!("endpoint {connector_id} {endpoint_id}")])
}

pub async fn deletion(app: &App, caller: &Caller, id: String) -> Result<Deletion> {
    connectors::reading(app, caller, move |tx, caller, _| {
        connectors::deletion(tx, caller, &id)
    })
    .await
}

pub async fn clearing(app: &App, caller: &Caller, id: String) -> Result<Clearing> {
    connectors::reading(app, caller, move |tx, caller, _| {
        connectors::clearing(tx, caller, &id)
    })
    .await
}

pub async fn retiring(
    app: &App,
    caller: &Caller,
    connector_id: String,
    endpoint_id: String,
) -> Result<Retiring> {
    connectors::reading(app, caller, move |tx, caller, _| {
        inbound::retiring(tx, caller, &connector_id, &endpoint_id)
    })
    .await
}

pub(super) fn issue(
    app: &App,
    caller: &Caller,
    tool: &str,
    target: &str,
    digest: &str,
) -> Result<confirm::Token> {
    app.mcp.signer.issue_bound(
        tool,
        &caller.credential_handle(),
        target,
        &subject(target, digest),
        app.clock.now_ms(),
    )
}

fn subject(target: &str, digest: &str) -> String {
    confirm::subject_digest(&[target.to_string()], digest)
}

pub fn deletion_token(
    app: &App,
    caller: &Caller,
    id: &str,
    deletion: &Deletion,
) -> Result<confirm::Token> {
    let target = Part::Registration.target(id);
    issue(app, caller, DELETE_TOOL, &target, deletion.digest())
}

pub fn clearing_token(
    app: &App,
    caller: &Caller,
    id: &str,
    clearing: &Clearing,
) -> Result<confirm::Token> {
    let target = Part::State.target(id);
    issue(app, caller, DELETE_TOOL, &target, clearing.digest())
}

pub fn retiring_token(
    app: &App,
    caller: &Caller,
    connector_id: &str,
    endpoint_id: &str,
    retiring: &Retiring,
) -> Result<confirm::Token> {
    let target = endpoint_target(connector_id, endpoint_id);
    issue(app, caller, RETIRE_TOOL, &target, retiring.digest())
}

/// A target that is no longer there reads as changed; a refusal of the caller stands.
pub fn read_now<T>(read: Result<T>) -> Result<Option<T>> {
    match read {
        Ok(found) => Ok(Some(found)),
        Err(Refusal {
            code: Code::ConnectorNotFound | Code::EndpointNotFound,
            ..
        }) => Ok(None),
        Err(refused) => Err(refused),
    }
}

/// Judges the token, reads the target as the act will find it, does the act and spends the token
/// in one write, so a failure anywhere leaves the target and the token as they were.
pub(super) async fn confirmed<R, A>(
    app: &Arc<App>,
    caller: &Caller,
    named: (&'static str, &'static str, String),
    bound: Bound,
    read: R,
    act: A,
) -> Result<Confirmed>
where
    R: FnOnce(&Unit<'_, '_>) -> Result<Option<String>> + Send + 'static,
    A: FnOnce(&Unit<'_, '_>) -> Result<i64> + Send + 'static,
{
    confirmed_as(
        app,
        caller,
        named,
        bound,
        read,
        move |unit| act(unit).map(|total| (total, total)),
        |_, total| Ok(total),
    )
    .await
}

/// [`confirmed`], answering the act's own result, and on a repeat what `repeat` reads in the write.
pub(super) async fn confirmed_as<R, A, P, D, S>(
    app: &Arc<App>,
    caller: &Caller,
    (tool, action, target): (&'static str, &'static str, String),
    bound: Bound,
    read: R,
    act: A,
    repeat: P,
) -> Result<Confirmed<D, S>>
where
    R: FnOnce(&Unit<'_, '_>) -> Result<Option<String>> + Send + 'static,
    A: FnOnce(&Unit<'_, '_>) -> Result<(i64, D)> + Send + 'static,
    P: FnOnce(&Unit<'_, '_>, i64) -> Result<S> + Send + 'static,
    D: Send + 'static,
    S: Send + 'static,
{
    let credential = caller.credential_handle();
    let signer = app.mcp.signer.clone();
    app.write(caller, action, move |unit| {
        match signer.open(unit.tx(), tool, &credential, &target, &bound, unit.instant)? {
            Opening::Stale => return Ok(Confirmed::Stale),
            Opening::Spent { total } => {
                return Ok(Confirmed::Repeated {
                    total: repeat(unit, total)?,
                });
            }
            Opening::Open => {}
        }
        let Some(digest) = read(unit)? else {
            return Ok(Confirmed::Changed);
        };
        if !signer.holds_subject(tool, &credential, &subject(&target, &digest), &bound)? {
            return Ok(Confirmed::Changed);
        }
        let (total, done) = act(unit)?;
        confirm::spend_bound(unit.tx(), &bound, &credential, &target, total)?;
        Ok(Confirmed::Done { total: done })
    })
    .await
}

/// Deletes the registration, and answers how many runs went with it.
pub async fn delete_confirmed(
    app: &Arc<App>,
    caller: &Caller,
    id: String,
    bound: Bound,
) -> Result<Confirmed> {
    let target = Part::Registration.target(&id);
    let reading = id.clone();
    confirmed(
        app,
        caller,
        (DELETE_TOOL, connectors::DELETED, target),
        bound,
        move |unit| {
            let deletion = connectors::deletion(unit.tx(), &unit.caller, &reading);
            Ok(read_now(deletion)?.map(|deletion| deletion.digest().to_string()))
        },
        move |unit| connectors::remove_in(unit, &id),
    )
    .await
}

/// Clears the source's state and agreements, and answers how many agreements went.
pub async fn clear_confirmed(
    app: &Arc<App>,
    caller: &Caller,
    id: String,
    bound: Bound,
) -> Result<Confirmed> {
    let target = Part::State.target(&id);
    let reading = id.clone();
    confirmed(
        app,
        caller,
        (DELETE_TOOL, connectors::STATE_CLEARED, target),
        bound,
        move |unit| {
            let clearing = connectors::clearing(unit.tx(), &unit.caller, &reading);
            Ok(read_now(clearing)?.map(|clearing| clearing.digest().to_string()))
        },
        move |unit| {
            let agreements = connectors::clear_in(unit, &id)?;
            Ok(i64::try_from(agreements).unwrap_or(i64::MAX))
        },
    )
    .await
}

/// Retires the endpoint.
pub async fn retire_confirmed(
    app: &Arc<App>,
    caller: &Caller,
    connector_id: String,
    endpoint_id: String,
    bound: Bound,
) -> Result<Confirmed> {
    let target = endpoint_target(&connector_id, &endpoint_id);
    let (reading, endpoint) = (connector_id.clone(), endpoint_id.clone());
    confirmed(
        app,
        caller,
        (RETIRE_TOOL, inbound::RETIRED, target),
        bound,
        move |unit| {
            let retiring = inbound::retiring(unit.tx(), &unit.caller, &reading, &endpoint);
            Ok(read_now(retiring)?.map(|retiring| retiring.digest().to_string()))
        },
        move |unit| {
            inbound::retire_in(unit, &connector_id, &endpoint_id)?;
            Ok(1)
        },
    )
    .await
}
