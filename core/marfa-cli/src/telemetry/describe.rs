//! What a failed run says of itself to PostHog: one fixed sentence for each
//! kind of error, never the error's own message, which can echo a field name,
//! an id, a path, an address or a server's words.
//!
//! The return type is `&'static str`, so no value from the run can reach a
//! sentence. Each match names every variant, so a new one fails to compile
//! until a sentence is chosen for it.

use marfa_core::CoreError;

use crate::error::{CliError, Exit, refused_code};

pub fn error(error: &CliError) -> &'static str {
    match error {
        CliError::Core(core) => core_error(core),
        CliError::CatchUp { error, .. } => self::error(error),
        CliError::Io(_) => "reading or writing a file or a stream failed",
        CliError::NotHeld(_) => "the item asked for is not in the local working copy",
        CliError::FolderHeld(_) => "another process is working the folder",
        CliError::FolderNotHandedOver(_) => {
            "another process is working the folder, and did not let it go when asked"
        }
        CliError::Watch(_) => "the folder watch failed",
        CliError::ClosedOutput => "the output was closed",
        CliError::Refused { status, .. } => refused(refused_code(*status)),
        CliError::Usage(_) => "the command line was wrong",
        CliError::Install(_) => "Docker or Tailscale did not do what the server install needs",
        CliError::NoStoreNamed | CliError::NoStoreAt(_) => {
            "no working copy was named, or none exists where it was named"
        }
        CliError::NoServerNamed | CliError::NoServerForKey => "no server was named",
        CliError::NoCredential { .. } => "no credential was available for the server",
        CliError::KeyCommand(_) => "a profile's key command gave no key",
        CliError::NoKeychain(_) => "the system's credential storage is unavailable",
        CliError::SignedOut { .. } => "the sign-in has ended",
        CliError::CredentialEnded => "the credential that held the stream has ended",
        CliError::Invalid(_) => "a value was not accepted",
        CliError::ArchiveLacksBlobs(_) | CliError::ArchiveKeptApart { .. } => {
            "the export archive lacks blobs its manifest names"
        }
        CliError::RestoreLacksBlobs(_) => {
            "the restored archive lacks blobs this instance does not hold"
        }
        CliError::ContractMismatch { .. } => {
            "the server speaks a different contract than this build"
        }
        CliError::DocsPageNotFound { .. } => "the docs page asked for does not exist",
        CliError::DocsSectionNotFound { .. } => "the docs page has no section of that name",
        CliError::DocsUnreachable { .. } => "the docs site could not be read",
        CliError::Redirected { .. } => "the server answered with a redirect, which is not followed",
    }
}

/// By the code a status is named by, since the server's own words are not
/// used.
fn refused(code: &str) -> &'static str {
    match code {
        "validation" => "the server rejected the request as invalid",
        "unauthorized" => "the server did not accept the credential",
        "forbidden" => "the server refused the request because the credential lacks a permission",
        "not_found" => "the server has nothing at what the request named",
        "conflict" => "the server refused the request as in conflict with what it holds",
        "too_large" => "the server refused the request as too large",
        "rate_limited" => "the server rate limited the request",
        _ => "the server failed to complete the request",
    }
}

fn core_error(error: &CoreError) -> &'static str {
    match error {
        CoreError::NotFound { .. } => "the server has nothing at what the request named",
        CoreError::Unauthorized { .. } => "the server did not accept the credential",
        CoreError::Forbidden { .. } => {
            "the server refused the request because the credential lacks a permission"
        }
        CoreError::Validation { .. } => "the server rejected the request as invalid",
        CoreError::UnknownType { .. } => "the server does not know the type that was named",
        CoreError::RateLimited { .. } => "the server rate limited the request",
        CoreError::Server { .. } => "the server failed to complete the request",
        CoreError::Io(_) => "reading or writing a file or a stream failed",
        CoreError::Network(_) => "the server could not be reached, or did not answer in time",
        CoreError::Unnamed { .. } => "the answer did not come from a Marfa server",
        CoreError::Decoding(_) => "an answer could not be decoded",
        CoreError::RenewalFailed(cause) => core_error(cause),
        CoreError::SignedOut { .. } => "the sign-in has ended",
        CoreError::NoKeychain(_) => "the system's credential storage is unavailable",
        CoreError::StorageFull(_) => "local storage is full",
        CoreError::Store(_) => "the local working copy reported a fault",
        CoreError::Redirected { .. } => {
            "the server answered with a redirect, which is not followed"
        }
        CoreError::NoServer => "no server was named",
        CoreError::NoCursor => "the working copy has no event cursor yet",
        CoreError::HydrationIncomplete => "the working copy's hydration did not complete",
        CoreError::NoCatalog => "the working copy has never held the server's type catalog",
        CoreError::ReadingHandle => "another process holds the working copy's writer handle",
        CoreError::WrongSchema { .. } => "the working copy was made by another build",
        CoreError::UnsentDiffers { .. } => {
            "the working copy holds other writes than the ones agreed to lose"
        }
        CoreError::CopyExpired { .. } => "the working copy can no longer be kept current",
        CoreError::StreamIncomplete { .. } => "the event stream ended early",
        CoreError::WrongServer { .. } => "the working copy belongs to a different server",
        CoreError::BytesAbsent { .. } => {
            "a blob's bytes are not held here and could not be fetched"
        }
        CoreError::NoRoom { .. } => "a file does not fit in the space free",
        CoreError::ContractMismatch { .. } => {
            "the server speaks a different contract than this build"
        }
        CoreError::Canceled => "the operation was stopped before it finished",
        CoreError::FirstSyncWaiting => "a folder's first sync waits for confirmation",
        CoreError::Invalid(_) => "a value was not accepted",
    }
}

pub fn panic() -> &'static str {
    "the command stopped on an internal fault"
}

/// For a run that failed with an exit status and no error to describe, as a
/// drain does after printing its report.
pub fn exit(status: u8) -> &'static str {
    Exit::ALL
        .iter()
        .find(|exit| **exit as u8 == status)
        .map_or("the command ended with a failure status", |exit| {
            exit.meaning()
        })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::error::REFUSED_CODES;

    #[test]
    fn every_status_a_refusal_is_named_by_has_a_sentence_of_its_own() {
        let sentences: HashSet<_> = REFUSED_CODES.iter().map(|code| refused(code)).collect();
        assert_eq!(sentences.len(), REFUSED_CODES.len(), "{sentences:?}");
    }

    #[test]
    fn a_sentence_carries_nothing_from_the_error_it_describes() {
        let secret = "s3cr3t-planted-value";
        let refused = CliError::Refused {
            status: 422,
            code: secret.into(),
            message: secret.into(),
            retry_after_seconds: None,
            details: Some(Box::new(serde_json::json!({ "field": secret }))),
        };
        let echoed = CliError::NotHeld(format!("item-{secret}"));
        let renewal = CliError::from(CoreError::RenewalFailed(Box::new(CoreError::Network(
            secret.into(),
        ))));
        let stopped = CliError::CatchUp {
            error: Box::new(CliError::Core(CoreError::Store(secret.into()))),
            catalog_changed: true,
        };
        for error in [refused, echoed, renewal, stopped] {
            // The witness: the error's own text does carry it.
            assert!(error.to_string().contains(secret), "{error}");
            assert!(!self::error(&error).contains(secret));
        }
    }

    #[test]
    fn an_error_wrapped_by_another_is_described_as_the_error_inside() {
        let network = CoreError::Network("x".into());
        assert_eq!(
            core_error(&CoreError::RenewalFailed(Box::new(CoreError::Network(
                "y".into()
            )))),
            core_error(&network)
        );
        assert_eq!(
            error(&CliError::CatchUp {
                error: Box::new(CliError::Core(network.clone())),
                catalog_changed: false,
            }),
            core_error(&network)
        );
    }

    #[test]
    fn an_exit_with_no_error_is_described_by_what_the_exit_means() {
        assert_eq!(exit(3), Exit::Environment.meaning());
        assert_eq!(exit(5), Exit::Credential.meaning());
        assert_eq!(exit(99), "the command ended with a failure status");
    }
}
