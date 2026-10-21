//! Renewing a credential the server refuses, through the app: an app signed
//! in with OAuth holds a refresh token the core never sees, and exchanges it
//! when the core asks.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use marfa_core::CoreError;

use crate::MarfaError;

/// Why an app's `CredentialRenewer` could not renew, so the core can tell a
/// sign-in that ended from one the network interrupted.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum RenewalError {
    /// The server ended the sign-in, as a token endpoint's `invalid_grant`
    /// or `invalid_client` says. Renewing again cannot help: the call that
    /// asked throws `SignedOut`, and every later refusal throws it without
    /// asking the renewer again, until the app signs in again and opens the
    /// copy with the new credential.
    Ended { message: String },
    /// The renewal could not finish now, as with no network or a token
    /// endpoint that did not answer. Queued writes stay queued, the call
    /// throws `Network`, and the next refusal asks the renewer again.
    Unavailable { message: String },
    /// Any other failure. The call throws `Invalid` with `message`, queued
    /// writes stay queued, and the next refusal asks the renewer again.
    Failed { message: String },
}

impl std::fmt::Display for RenewalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenewalError::Ended { message }
            | RenewalError::Unavailable { message }
            | RenewalError::Failed { message } => f.write_str(message),
        }
    }
}

/// A renewer that throws something other than a `RenewalError`.
impl From<uniffi::UnexpectedUniFFICallbackError> for RenewalError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        RenewalError::Failed {
            message: format!("the renewer failed: {}", error.reason),
        }
    }
}

/// What an app hands `Core.open` or `Folders` with a token that can
/// expire. The core calls `renew` when the server refuses the token it sent,
/// and sends the refused request again, once, with the token `renew`
/// returns.
///
/// Within one `Core` or one `Folders`, `renew` is called once at a time:
/// calls refused together wait for one renewal and send the token it
/// answered, and a folder still sending the token renewed away gets the new
/// one without asking. Separate `Core` and `Folders` objects ask on their
/// own, so an app that opens more than one with the same sign-in must
/// serialize renewals across them.
///
/// `renew` runs on the thread that was refused: the app's own call or a
/// watch's. It must not call this `Core` or these `Folders`, which may be
/// waiting on it. A renewer must:
///
/// - Keep the new access token and refresh token before returning: a
///   refresh token is spent once the server answers.
/// - Return the access token it holds, without renewing, when `refused`
///   differs from it, as when a copy was opened with a token since renewed.
/// - Throw `Ended`, and delete the refresh token, on a token endpoint's
///   `invalid_grant` or `invalid_client`.
/// - Give the token request a time limit, and throw `Unavailable` when it
///   times out or there is no network: stopping a watch waits for a renewal
///   under way.
/// - Never wait synchronously on the main thread inside `renew`.
/// - Never log the refused token.
#[uniffi::export(with_foreign)]
pub trait CredentialRenewer: Send + Sync {
    /// `refused` is the access token the server refused, without `Bearer`.
    /// Answer the token to send instead.
    fn renew(&self, refused: String) -> Result<String, RenewalError>;
}

/// One app renewer for every copy that sends one credential, so a sign-in
/// that ended is ended for all of them.
pub(crate) struct Renewal {
    renewer: Arc<dyn CredentialRenewer>,
    origin: String,
    ended: AtomicBool,
    /// The last token a renewal answered, so a folder opened later starts
    /// with it rather than with one already refused.
    latest: Mutex<Option<String>>,
    /// Held while the app renews. Each folder has a transport of its own,
    /// whose lock covers only that folder, and a second exchange of one
    /// refresh token is a replay that can end the whole sign-in.
    ///
    /// Taken under a transport's `renewing` lock, and never the other way
    /// round: nothing here calls back into a transport, the store's
    /// connection is not taken under it (`on_renewed` runs after it is
    /// released, and only tries the connection), and `latest` is taken
    /// under it only briefly.
    asking: Mutex<()>,
}

impl Renewal {
    /// Refused with `Invalid` where there is no server to renew with.
    pub(crate) fn of(
        renewer: Option<Arc<dyn CredentialRenewer>>,
        server: Option<&marfa_core::Server>,
    ) -> Result<Option<Arc<Renewal>>, MarfaError> {
        match (renewer, server) {
            (None, _) => Ok(None),
            (Some(_), None) => Err(MarfaError::Invalid {
                message: "a renewer needs a url and a key to renew".into(),
            }),
            (Some(renewer), Some(server)) => Ok(Some(Arc::new(Renewal {
                renewer,
                origin: marfa_core::http::origin_of(&server.url)?,
                ended: AtomicBool::new(false),
                latest: Mutex::default(),
                asking: Mutex::default(),
            }))),
        }
    }

    /// `server` with the token the last renewal answered, where there was one.
    pub(crate) fn sending(&self, server: &marfa_core::Server) -> marfa_core::Server {
        let latest = self
            .latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        marfa_core::Server {
            url: server.url.clone(),
            key: latest.clone().unwrap_or_else(|| server.key.clone()),
        }
    }

    /// The core's renewal callback for one copy.
    pub(crate) fn renew(self: &Arc<Self>) -> marfa_core::http::Renew {
        let renewal = Arc::clone(self);
        Box::new(move |refused| renewal.renewed(refused))
    }

    /// The core wraps each error as `RenewalFailed`, which keeps the queued
    /// writes: one it takes as environmental leaves them for the next pass,
    /// any other ends the pass.
    fn renewed(&self, refused: &str) -> Result<String, CoreError> {
        let _one = self
            .asking
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.ended.load(Ordering::SeqCst) {
            return Err(self.signed_out());
        }
        if let Some(latest) = self
            .latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .filter(|latest| latest != refused)
        {
            return Ok(latest);
        }
        match self.renewer.renew(refused.to_string()) {
            Ok(token) if token.is_empty() => {
                Err(CoreError::Invalid("the renewer answered no token".into()))
            }
            Ok(token) => {
                *self
                    .latest
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(token.clone());
                Ok(token)
            }
            Err(RenewalError::Ended { .. }) => {
                self.ended.store(true, Ordering::SeqCst);
                Err(self.signed_out())
            }
            Err(RenewalError::Unavailable { message }) => Err(CoreError::Network(message)),
            Err(RenewalError::Failed { message }) => Err(CoreError::Invalid(message)),
        }
    }

    fn signed_out(&self) -> CoreError {
        CoreError::SignedOut {
            origin: self.origin.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Answering(Mutex<Vec<Result<String, RenewalError>>>, Mutex<Vec<String>>);

    impl CredentialRenewer for Answering {
        fn renew(&self, refused: String) -> Result<String, RenewalError> {
            self.1.lock().unwrap().push(refused);
            self.0.lock().unwrap().remove(0)
        }
    }

    fn renewal(answers: Vec<Result<String, RenewalError>>) -> (Arc<Renewal>, Arc<Answering>) {
        let renewer = Arc::new(Answering(Mutex::new(answers), Mutex::default()));
        let server = marfa_core::Server {
            url: "https://marfa.example/".into(),
            key: "k".into(),
        };
        let renewal = Renewal::of(Some(renewer.clone()), Some(&server))
            .unwrap()
            .unwrap();
        (renewal, renewer)
    }

    #[test]
    fn each_failure_reaches_the_core_as_a_cause_it_tells_apart() {
        let message = || "said".to_string();
        let (renewal, _) = renewal(vec![
            Err(RenewalError::Unavailable { message: message() }),
            Err(RenewalError::Failed { message: message() }),
            Err(uniffi::UnexpectedUniFFICallbackError::new("thrown").into()),
            Ok(String::new()),
            Ok("fresh".into()),
        ]);
        let unavailable = renewal.renewed("stale").unwrap_err();
        assert_eq!(unavailable, CoreError::Network(message()));
        assert!(CoreError::RenewalFailed(Box::new(unavailable)).is_environmental());
        let failed = renewal.renewed("stale").unwrap_err();
        assert_eq!(failed, CoreError::Invalid(message()));
        assert!(!CoreError::RenewalFailed(Box::new(failed)).is_environmental());
        assert!(matches!(
            renewal.renewed("stale"),
            Err(CoreError::Invalid(said)) if said.contains("thrown")
        ));
        assert!(matches!(
            renewal.renewed("stale"),
            Err(CoreError::Invalid(_))
        ));
        assert_eq!(renewal.renewed("stale"), Ok("fresh".into()));
    }

    #[test]
    fn a_folder_opened_after_a_renewal_sends_the_renewed_token() {
        let (renewal, _) = renewal(vec![Ok("fresh".into())]);
        let server = marfa_core::Server {
            url: "https://marfa.example/".into(),
            key: "stale".into(),
        };
        assert_eq!(renewal.sending(&server).key, "stale");
        renewal.renewed("stale").unwrap();
        let sent = renewal.sending(&server);
        assert_eq!(
            (sent.url.as_str(), sent.key.as_str()),
            ("https://marfa.example/", "fresh")
        );
    }

    #[test]
    fn an_ended_sign_in_is_never_renewed_again() {
        let (renewal, renewer) = renewal(vec![
            Err(RenewalError::Ended {
                message: "invalid_grant".into(),
            }),
            Ok("fresh".into()),
        ]);
        let signed_out = CoreError::SignedOut {
            origin: "https://marfa.example".into(),
        };
        assert_eq!(renewal.renewed("stale"), Err(signed_out.clone()));
        assert!(!CoreError::RenewalFailed(Box::new(signed_out.clone())).is_environmental());
        // The witness: the renewer still has a token to answer.
        assert_eq!(renewal.renewed("stale"), Err(signed_out));
        assert_eq!(*renewer.1.lock().unwrap(), vec!["stale".to_string()]);
    }

    /// Answers `fresh` to every call after a pause, so a second refusal
    /// arrives while the first renewal is under way.
    struct Slow(Mutex<Vec<String>>);

    impl CredentialRenewer for Slow {
        fn renew(&self, refused: String) -> Result<String, RenewalError> {
            self.0.lock().unwrap().push(refused);
            std::thread::sleep(std::time::Duration::from_millis(100));
            Ok("fresh".into())
        }
    }

    #[test]
    fn folders_refused_at_once_ask_the_renewer_once() {
        let renewer = Arc::new(Slow(Mutex::default()));
        let server = marfa_core::Server {
            url: "https://marfa.example/".into(),
            key: "stale".into(),
        };
        let renewal = Renewal::of(Some(renewer.clone()), Some(&server))
            .unwrap()
            .unwrap();
        let start = Arc::new(std::sync::Barrier::new(2));
        let refused: Vec<_> = (0..2)
            .map(|_| {
                let renewal = Arc::clone(&renewal);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    renewal.renewed("stale")
                })
            })
            .collect();
        for folder in refused {
            assert_eq!(folder.join().unwrap(), Ok("fresh".into()));
        }
        assert_eq!(*renewer.0.lock().unwrap(), vec!["stale".to_string()]);
    }

    #[test]
    fn a_folder_holding_the_old_token_gets_the_renewed_one_without_asking() {
        let (renewal, renewer) = renewal(vec![Ok("fresh".into()), Ok("fresher".into())]);
        assert_eq!(renewal.renewed("stale"), Ok("fresh".into()));
        assert_eq!(renewal.renewed("stale"), Ok("fresh".into()));
        assert_eq!(*renewer.1.lock().unwrap(), vec!["stale".to_string()]);
        // The witness: a refusal of the renewed token itself asks again.
        assert_eq!(renewal.renewed("fresh"), Ok("fresher".into()));
        assert_eq!(
            *renewer.1.lock().unwrap(),
            vec!["stale".to_string(), "fresh".to_string()]
        );
    }

    #[test]
    fn a_renewer_without_a_server_is_refused() {
        let renewer: Arc<dyn CredentialRenewer> =
            Arc::new(Answering(Mutex::default(), Mutex::default()));
        assert!(matches!(
            Renewal::of(Some(renewer), None),
            Err(MarfaError::Invalid { .. })
        ));
    }
}
