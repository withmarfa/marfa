//! The rows the OAuth server keeps. Nothing here decides anything: a caller
//! reads a row and judges it, inside the write that acts on the judgment.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;

use super::client::{AuthMethod, GrantType, Registration, ResponseType};
use super::redirect::AppKind;
use super::scope::ScopeSet;
use crate::app::access::printable;
use crate::app::refusal::{Refusal, Result};

/// An instant of the instance's clock, as these tables hold it.
pub fn ms_of(at: &str) -> Result<i64> {
    DateTime::parse_from_rfc3339(at)
        .map(|at| at.timestamp_millis())
        .map_err(|_| Refusal::internal("an instant did not read"))
}

/// An instant these tables hold, as every other record writes one.
pub fn stamp_of(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn json_list(text: &str) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str::<Vec<Value>>(text)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
}

fn scopes_at(row: &Row<'_>, column: &str) -> rusqlite::Result<ScopeSet> {
    let text: String = row.get(column)?;
    let literals = json_list(&text)?;
    Ok(literals.iter().map(String::as_str).collect())
}

fn list_at(row: &Row<'_>, column: &str) -> rusqlite::Result<Vec<String>> {
    json_list(&row.get::<_, String>(column)?)
}

pub fn scopes_text(scopes: &ScopeSet) -> String {
    Value::from(scopes.literals().to_vec()).to_string()
}

fn list_text(list: &[String]) -> String {
    Value::from(list.to_vec()).to_string()
}

/// A registered client, or a metadata document's copy of one.
#[derive(Clone, Debug)]
pub struct Client {
    pub id: String,
    pub registration: Registration,
    pub created_at: i64,
}

impl Client {
    /// What a person is shown this client as: the name it gave, held to what
    /// a page may show, or its ID where that leaves nothing.
    pub fn name(&self) -> String {
        let named = self
            .registration
            .client_name
            .as_deref()
            .map(printable)
            .unwrap_or_default();
        if named.trim().is_empty() {
            printable(&self.id)
        } else {
            named
        }
    }
}

fn client_of(row: &Row<'_>) -> rusqlite::Result<Client> {
    let grants = list_at(row, "grant_types")?;
    let responses = list_at(row, "response_types")?;
    let kind: String = row.get("application_type")?;
    Ok(Client {
        id: row.get("client_id")?,
        registration: Registration {
            application_type: if kind == AppKind::Native.word() {
                AppKind::Native
            } else {
                AppKind::Web
            },
            token_endpoint_auth_method: AuthMethod::None,
            grant_types: grants
                .iter()
                .filter_map(|word| GrantType::from_word(word))
                .collect(),
            response_types: responses
                .iter()
                .filter_map(|word| ResponseType::from_word(word))
                .collect(),
            redirect_uris: list_at(row, "redirect_uris")?,
            scope: scopes_at(row, "scopes")?,
            client_name: row.get("client_name")?,
            client_uri: row.get("client_uri")?,
            logo_uri: row.get("logo_uri")?,
            tos_uri: row.get("tos_uri")?,
            policy_uri: row.get("policy_uri")?,
            contacts: list_at(row, "contacts")?,
            software_id: row.get("software_id")?,
            software_version: row.get("software_version")?,
        },
        created_at: row.get("created_at")?,
    })
}

pub fn client(tx: &Connection, id: &str) -> Result<Option<Client>> {
    Ok(tx
        .query_row(
            "SELECT * FROM auth_oauth_client WHERE client_id = ?1",
            [id],
            client_of,
        )
        .optional()?)
}

/// Every client some person's standing consent names.
pub fn consented_clients(tx: &Connection) -> Result<Vec<Client>> {
    let mut query = tx.prepare(
        "SELECT * FROM auth_oauth_client WHERE client_id IN \
         (SELECT client_id FROM auth_oauth_consent WHERE withdrawn_at IS NULL)",
    )?;
    let rows = query.query_map([], client_of)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Holds `registration` as `id`, in place of any copy already there, which
/// keeps its first date and when it was last offered.
pub fn put_client(tx: &Connection, id: &str, registration: &Registration, now: i64) -> Result<()> {
    let words = |list: Vec<&'static str>| Value::from(list).to_string();
    tx.execute(
        "INSERT INTO auth_oauth_client (client_id, auth_method, application_type, redirect_uris, \
         grant_types, response_types, scopes, client_name, client_uri, logo_uri, tos_uri, \
         policy_uri, contacts, software_id, software_version, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
         ON CONFLICT (client_id) DO UPDATE SET \
         auth_method = excluded.auth_method, application_type = excluded.application_type, \
         redirect_uris = excluded.redirect_uris, grant_types = excluded.grant_types, \
         response_types = excluded.response_types, scopes = excluded.scopes, \
         client_name = excluded.client_name, client_uri = excluded.client_uri, \
         logo_uri = excluded.logo_uri, tos_uri = excluded.tos_uri, \
         policy_uri = excluded.policy_uri, contacts = excluded.contacts, \
         software_id = excluded.software_id, software_version = excluded.software_version",
        params![
            id,
            registration.token_endpoint_auth_method.word(),
            registration.application_type.word(),
            list_text(&registration.redirect_uris),
            words(
                registration
                    .grant_types
                    .iter()
                    .map(|grant| grant.word())
                    .collect()
            ),
            words(
                registration
                    .response_types
                    .iter()
                    .map(|kind| kind.word())
                    .collect()
            ),
            scopes_text(&registration.scope),
            registration.client_name,
            registration.client_uri,
            registration.logo_uri,
            registration.tos_uri,
            registration.policy_uri,
            list_text(&registration.contacts),
            registration.software_id,
            registration.software_version,
            now,
        ],
    )?;
    Ok(())
}

pub fn set_client_scopes(tx: &Connection, id: &str, scopes: &ScopeSet) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_client SET scopes = ?2 WHERE client_id = ?1",
        params![id, scopes_text(scopes)],
    )?;
    Ok(())
}

pub fn note_offered(tx: &Connection, id: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_client SET offered_at = ?2 WHERE client_id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// The instant a stored document's copy goes stale, if `id` came from one.
pub fn document_fresh_until(tx: &Connection, id: &str) -> Result<Option<i64>> {
    Ok(tx
        .query_row(
            "SELECT fresh_until FROM auth_oauth_client_document WHERE client_id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn note_document(tx: &Connection, id: &str, now: i64, fresh_until: i64) -> Result<()> {
    tx.execute(
        "INSERT INTO auth_oauth_client_document (client_id, fetched_at, fresh_until) \
         VALUES (?1, ?2, ?3) ON CONFLICT (client_id) DO UPDATE SET \
         fetched_at = excluded.fetched_at, fresh_until = excluded.fresh_until",
        params![id, now, fresh_until],
    )?;
    Ok(())
}

/// A person's consent to an app.
#[derive(Clone, Debug)]
pub struct Consent {
    pub client_id: String,
    pub user_id: String,
    pub grant_id: String,
    pub scopes: ScopeSet,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub withdrawn_at: Option<i64>,
}

impl Consent {
    pub fn stands(&self) -> bool {
        self.withdrawn_at.is_none()
    }
}

fn consent_of(row: &Row<'_>) -> rusqlite::Result<Consent> {
    Ok(Consent {
        client_id: row.get("client_id")?,
        user_id: row.get("user_id")?,
        grant_id: row.get("grant_id")?,
        scopes: scopes_at(row, "scopes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_used_at: row.get("last_used_at")?,
        withdrawn_at: row.get("withdrawn_at")?,
    })
}

pub fn consent(tx: &Connection, client_id: &str, user_id: &str) -> Result<Option<Consent>> {
    Ok(tx
        .query_row(
            "SELECT * FROM auth_oauth_consent WHERE client_id = ?1 AND user_id = ?2",
            [client_id, user_id],
            consent_of,
        )
        .optional()?)
}

/// What a person's consent to `client_id` covers, which is nothing while it
/// is withdrawn.
pub fn held_scopes(tx: &Connection, client_id: &str, user_id: &str) -> Result<ScopeSet> {
    Ok(consent(tx, client_id, user_id)?
        .filter(Consent::stands)
        .map(|consent| consent.scopes)
        .unwrap_or_default())
}

pub fn insert_consent(tx: &Connection, consent: &Consent) -> Result<()> {
    tx.execute(
        "INSERT INTO auth_oauth_consent (client_id, user_id, grant_id, scopes, created_at, \
         updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            consent.client_id,
            consent.user_id,
            consent.grant_id,
            scopes_text(&consent.scopes),
            consent.created_at,
        ],
    )?;
    Ok(())
}

/// Stands `consent` again, or changes what it covers.
pub fn renew_consent(
    tx: &Connection,
    client_id: &str,
    user_id: &str,
    scopes: &ScopeSet,
    now: i64,
) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_consent SET scopes = ?3, updated_at = ?4, withdrawn_at = NULL \
         WHERE client_id = ?1 AND user_id = ?2",
        params![client_id, user_id, scopes_text(scopes), now],
    )?;
    Ok(())
}

pub fn withdraw_consent(tx: &Connection, client_id: &str, user_id: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_consent SET withdrawn_at = ?3, updated_at = ?3 \
         WHERE client_id = ?1 AND user_id = ?2",
        params![client_id, user_id, now],
    )?;
    Ok(())
}

pub fn note_consent_used(tx: &Connection, client_id: &str, user_id: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_consent SET last_used_at = ?3 \
         WHERE client_id = ?1 AND user_id = ?2 AND withdrawn_at IS NULL",
        params![client_id, user_id, now],
    )?;
    Ok(())
}

/// A code, from the moment it is issued to the exchange that takes it.
#[derive(Clone, Debug)]
pub struct Code {
    pub digest: String,
    pub client_id: String,
    pub user_id: String,
    pub session_id: String,
    pub grant_id: String,
    pub redirect_uri: String,
    pub scopes: ScopeSet,
    pub challenge: String,
    pub resources: Vec<String>,
    pub expires_at: i64,
}

pub fn insert_code(tx: &Connection, code: &Code) -> Result<()> {
    tx.execute(
        "INSERT INTO auth_oauth_code (digest, client_id, user_id, session_id, grant_id, \
         redirect_uri, scopes, challenge, resources, expires_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            code.digest,
            code.client_id,
            code.user_id,
            code.session_id,
            code.grant_id,
            code.redirect_uri,
            scopes_text(&code.scopes),
            code.challenge,
            list_text(&code.resources),
            code.expires_at,
        ],
    )?;
    Ok(())
}

/// Removes the code and answers what it held, so that of two exchanges in
/// flight only one finds it.
pub fn take_code(tx: &Connection, digest: &str) -> Result<Option<Code>> {
    Ok(tx
        .query_row(
            "DELETE FROM auth_oauth_code WHERE digest = ?1 RETURNING *",
            [digest],
            |row| {
                Ok(Code {
                    digest: row.get("digest")?,
                    client_id: row.get("client_id")?,
                    user_id: row.get("user_id")?,
                    session_id: row.get("session_id")?,
                    grant_id: row.get("grant_id")?,
                    redirect_uri: row.get("redirect_uri")?,
                    scopes: scopes_at(row, "scopes")?,
                    challenge: row.get("challenge")?,
                    resources: list_at(row, "resources")?,
                    expires_at: row.get("expires_at")?,
                })
            },
        )
        .optional()?)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceStatus {
    Pending,
    Approved,
    Denied,
    Spent,
}

impl DeviceStatus {
    const fn word(self) -> &'static str {
        match self {
            DeviceStatus::Pending => "pending",
            DeviceStatus::Approved => "approved",
            DeviceStatus::Denied => "denied",
            DeviceStatus::Spent => "spent",
        }
    }

    fn from_word(word: &str) -> DeviceStatus {
        match word {
            "approved" => DeviceStatus::Approved,
            "denied" => DeviceStatus::Denied,
            "spent" => DeviceStatus::Spent,
            _ => DeviceStatus::Pending,
        }
    }
}

/// A device code, by the digests of both its codes.
#[derive(Clone, Debug)]
pub struct DeviceCode {
    pub digest: String,
    pub user_code_digest: String,
    pub client_id: String,
    pub scopes: ScopeSet,
    pub status: DeviceStatus,
    pub user_id: Option<String>,
    pub interval_seconds: i64,
    pub last_polled_at: Option<i64>,
    pub expires_at: i64,
}

fn device_code_of(row: &Row<'_>) -> rusqlite::Result<DeviceCode> {
    Ok(DeviceCode {
        digest: row.get("device_code")?,
        user_code_digest: row.get("user_code")?,
        client_id: row.get("client_id")?,
        scopes: scopes_at(row, "scopes")?,
        status: DeviceStatus::from_word(&row.get::<_, String>("status")?),
        user_id: row.get("user_id")?,
        interval_seconds: row.get("interval_seconds")?,
        last_polled_at: row.get("last_polled_at")?,
        expires_at: row.get("expires_at")?,
    })
}

pub fn insert_device_code(tx: &Connection, code: &DeviceCode) -> Result<()> {
    tx.execute(
        "INSERT INTO auth_oauth_device_code (device_code, user_code, client_id, scopes, status, \
         interval_seconds, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            code.digest,
            code.user_code_digest,
            code.client_id,
            scopes_text(&code.scopes),
            code.status.word(),
            code.interval_seconds,
            code.expires_at,
        ],
    )?;
    Ok(())
}

pub fn device_code(tx: &Connection, digest: &str) -> Result<Option<DeviceCode>> {
    Ok(tx
        .query_row(
            "SELECT * FROM auth_oauth_device_code WHERE device_code = ?1",
            [digest],
            device_code_of,
        )
        .optional()?)
}

pub fn device_code_by_user_code(tx: &Connection, digest: &str) -> Result<Option<DeviceCode>> {
    Ok(tx
        .query_row(
            "SELECT * FROM auth_oauth_device_code WHERE user_code = ?1",
            [digest],
            device_code_of,
        )
        .optional()?)
}

/// Decides a pending code, and clears its polls so the first one after the
/// decision never waits.
pub fn decide_device_code(
    tx: &Connection,
    digest: &str,
    status: DeviceStatus,
    user_id: &str,
    scopes: &ScopeSet,
) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_device_code SET status = ?2, user_id = ?3, scopes = ?4, \
         last_polled_at = NULL WHERE device_code = ?1",
        params![digest, status.word(), user_id, scopes_text(scopes)],
    )?;
    Ok(())
}

pub fn note_device_poll(tx: &Connection, digest: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_device_code SET last_polled_at = ?2 WHERE device_code = ?1",
        params![digest, now],
    )?;
    Ok(())
}

pub fn spend_device_code(tx: &Connection, digest: &str) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_device_code SET status = 'spent' WHERE device_code = ?1",
        [digest],
    )?;
    Ok(())
}

#[derive(Clone, Debug)]
pub struct AccessToken {
    pub id: String,
    pub digest: String,
    pub client_id: String,
    pub user_id: String,
    pub chain_id: String,
    pub scopes: ScopeSet,
    pub audience: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

pub fn insert_access_token(tx: &Connection, token: &AccessToken) -> Result<()> {
    tx.execute(
        "INSERT INTO auth_oauth_access_token (id, digest, client_id, user_id, chain_id, scopes, \
         audience, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            token.id,
            token.digest,
            token.client_id,
            token.user_id,
            token.chain_id,
            scopes_text(&token.scopes),
            token.audience,
            token.created_at,
            token.expires_at,
        ],
    )?;
    Ok(())
}

fn access_token_of(row: &Row<'_>) -> rusqlite::Result<AccessToken> {
    Ok(AccessToken {
        id: row.get("id")?,
        digest: row.get("digest")?,
        client_id: row.get("client_id")?,
        user_id: row.get("user_id")?,
        chain_id: row.get("chain_id")?,
        scopes: scopes_at(row, "scopes")?,
        audience: row.get("audience")?,
        created_at: row.get("created_at")?,
        expires_at: row.get("expires_at")?,
    })
}

pub fn access_token_by_digest(tx: &Connection, digest: &str) -> Result<Option<AccessToken>> {
    Ok(tx
        .query_row(
            "SELECT * FROM auth_oauth_access_token WHERE digest = ?1",
            [digest],
            access_token_of,
        )
        .optional()?)
}

pub fn access_token_by_id(tx: &Connection, id: &str) -> Result<Option<AccessToken>> {
    Ok(tx
        .query_row(
            "SELECT * FROM auth_oauth_access_token WHERE id = ?1",
            [id],
            access_token_of,
        )
        .optional()?)
}

pub fn delete_access_token(tx: &Connection, id: &str) -> Result<()> {
    tx.execute("DELETE FROM auth_oauth_access_token WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Clone, Debug)]
pub struct RefreshToken {
    pub id: String,
    pub digest: String,
    pub client_id: String,
    pub user_id: String,
    pub chain_id: String,
    pub scopes: ScopeSet,
    pub audience: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub rotated_at: Option<i64>,
    pub ended_at: Option<i64>,
}

pub fn insert_refresh_token(tx: &Connection, token: &RefreshToken) -> Result<()> {
    tx.execute(
        "INSERT INTO auth_oauth_refresh_token (id, digest, client_id, user_id, chain_id, scopes, \
         audience, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            token.id,
            token.digest,
            token.client_id,
            token.user_id,
            token.chain_id,
            scopes_text(&token.scopes),
            token.audience,
            token.created_at,
            token.expires_at,
        ],
    )?;
    Ok(())
}

pub fn refresh_token_by_digest(tx: &Connection, digest: &str) -> Result<Option<RefreshToken>> {
    Ok(tx
        .query_row(
            "SELECT * FROM auth_oauth_refresh_token WHERE digest = ?1",
            [digest],
            |row| {
                Ok(RefreshToken {
                    id: row.get("id")?,
                    digest: row.get("digest")?,
                    client_id: row.get("client_id")?,
                    user_id: row.get("user_id")?,
                    chain_id: row.get("chain_id")?,
                    scopes: scopes_at(row, "scopes")?,
                    audience: row.get("audience")?,
                    created_at: row.get("created_at")?,
                    expires_at: row.get("expires_at")?,
                    rotated_at: row.get("rotated_at")?,
                    ended_at: row.get("ended_at")?,
                })
            },
        )
        .optional()?)
}

pub fn rotate_refresh_token(tx: &Connection, id: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE auth_oauth_refresh_token SET rotated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// Ends every token of one chain.
pub fn end_chain(tx: &Connection, chain_id: &str, now: i64) -> Result<()> {
    tx.execute(
        "DELETE FROM auth_oauth_access_token WHERE chain_id = ?1",
        [chain_id],
    )?;
    tx.execute(
        "UPDATE auth_oauth_refresh_token SET ended_at = ?2 \
         WHERE chain_id = ?1 AND ended_at IS NULL",
        params![chain_id, now],
    )?;
    Ok(())
}

/// Ends what an app holds for a person: every token and every code. An
/// approved device code nobody has polled ends with them, as spent.
pub fn end_grant_credentials(
    tx: &Connection,
    client_id: &str,
    user_id: &str,
    now: i64,
) -> Result<()> {
    tx.execute(
        "DELETE FROM auth_oauth_access_token WHERE client_id = ?1 AND user_id = ?2",
        [client_id, user_id],
    )?;
    tx.execute(
        "UPDATE auth_oauth_refresh_token SET ended_at = ?3 \
         WHERE client_id = ?1 AND user_id = ?2 AND ended_at IS NULL",
        params![client_id, user_id, now],
    )?;
    tx.execute(
        "DELETE FROM auth_oauth_code WHERE client_id = ?1 AND user_id = ?2",
        [client_id, user_id],
    )?;
    tx.execute(
        "UPDATE auth_oauth_device_code SET status = 'spent' \
         WHERE client_id = ?1 AND user_id = ?2 AND status = 'approved'",
        [client_id, user_id],
    )?;
    Ok(())
}
