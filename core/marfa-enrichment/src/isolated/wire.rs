//! What crosses between parent and child. Each side is strict: an unknown field, a
//! missing one or a second document is a bad answer, not something to work around.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{Dimensions, OcrOptions, Options, Reading, Refusal, Sandbox};

/// The longest reason a child may give.
pub(super) const MAX_REASON_BYTES: usize = 2048;

/// The longest request a child reads, before the file's bytes.
pub(super) const MAX_REQUEST_BYTES: u32 = 64 * 1024;

/// What one reading is to do. The limits a child takes before it reads anything are
/// on its command line, not here.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) mime: String,
    /// How many bytes of file follow on stdin.
    pub(super) len: u64,
    pub(super) max_text_chars: u64,
    pub(super) max_inflated_bytes: u64,
    pub(super) time_budget_ms: u64,
    pub(super) ocr: Option<OcrRequest>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OcrRequest {
    pub(super) languages: String,
    /// A path's bytes, which need not be UTF-8.
    pub(super) data_dir: Option<Vec<u8>>,
}

impl Request {
    /// The options the reading runs under. The time and memory limits are the
    /// child's own and are enforced around it, so they mean nothing here.
    pub(super) fn options(&self) -> Options {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        Options {
            max_text_chars: usize::try_from(self.max_text_chars).unwrap_or(usize::MAX),
            max_inflated_bytes: self.max_inflated_bytes,
            ocr: self.ocr.as_ref().map(|ocr| OcrOptions {
                languages: ocr.languages.clone(),
                data_dir: ocr
                    .data_dir
                    .as_ref()
                    .map(|dir| PathBuf::from(OsStr::from_bytes(dir))),
            }),
            time_budget: Some(Duration::from_millis(self.time_budget_ms)),
            ..Options::default()
        }
    }
}

/// The child's one document.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub(super) enum Answer {
    Reading {
        text: String,
        truncated: bool,
        cut_short: bool,
        size: Option<(u32, u32)>,
        sandbox: Sandbox,
    },
    Refusal {
        kind: RefusalKind,
        reason: String,
    },
}

/// What a child may say of a file. Whether the reading timed out or crashed is for
/// the parent to observe, so a child has no words for it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RefusalKind {
    Unsupported,
    Encrypted,
    Malformed,
    OverLimit,
    OcrUnavailable,
}

impl Answer {
    pub(super) fn of(outcome: Result<Reading, Refusal>, sandbox: Sandbox) -> Self {
        match outcome {
            Ok(reading) => Self::Reading {
                text: reading.text,
                truncated: reading.truncated,
                cut_short: reading.cut_short,
                size: reading.dimensions.map(|size| (size.width, size.height)),
                sandbox,
            },
            Err(refusal) => {
                let (kind, reason) = match refusal {
                    Refusal::Unsupported => (RefusalKind::Unsupported, String::new()),
                    Refusal::Encrypted => (RefusalKind::Encrypted, String::new()),
                    Refusal::OverLimit(reason) => (RefusalKind::OverLimit, reason),
                    Refusal::OcrUnavailable(reason) => (RefusalKind::OcrUnavailable, reason),
                    Refusal::Malformed(reason)
                    | Refusal::Crashed(reason)
                    | Refusal::ReaderUnavailable(reason) => (RefusalKind::Malformed, reason),
                    Refusal::TimedOut => (RefusalKind::Malformed, String::new()),
                };
                Self::Refusal {
                    kind,
                    reason: shorten(reason),
                }
            }
        }
    }

    /// Reads the bytes a child wrote. Anything but one well-formed document that keeps
    /// to the limits is `Crashed`: the child that wrote it is not to be believed.
    pub(super) fn judge(said: &[u8], max_text_chars: usize) -> Result<Reading, Refusal> {
        let answer: Self = serde_json::from_slice(said)
            .map_err(|error| Refusal::Crashed(format!("the reader's answer is bad: {error}")))?;
        match answer {
            Self::Reading {
                text,
                truncated,
                cut_short,
                size,
                sandbox,
            } => {
                if text.len() > max_text_chars.saturating_mul(3)
                    || text.encode_utf16().count() > max_text_chars
                {
                    return Err(Refusal::Crashed(
                        "the reader answered with more text than it may".into(),
                    ));
                }
                if size.is_some_and(|(width, height)| width == 0 || height == 0) {
                    return Err(Refusal::Crashed(
                        "the reader answered with an empty image size".into(),
                    ));
                }
                Ok(Reading {
                    text,
                    truncated,
                    cut_short,
                    dimensions: size.map(|(width, height)| Dimensions { width, height }),
                    sandbox,
                })
            }
            Self::Refusal { kind, reason } => {
                if reason.len() > MAX_REASON_BYTES {
                    return Err(Refusal::Crashed(
                        "the reader answered with too long a reason".into(),
                    ));
                }
                Err(match kind {
                    RefusalKind::Unsupported => Refusal::Unsupported,
                    RefusalKind::Encrypted => Refusal::Encrypted,
                    RefusalKind::Malformed => Refusal::Malformed(reason),
                    RefusalKind::OverLimit => Refusal::OverLimit(reason),
                    RefusalKind::OcrUnavailable => Refusal::OcrUnavailable(reason),
                })
            }
        }
    }
}

fn shorten(mut reason: String) -> String {
    if reason.len() > MAX_REASON_BYTES {
        let mut end = MAX_REASON_BYTES;
        while !reason.is_char_boundary(end) {
            end -= 1;
        }
        reason.truncate(end);
    }
    reason
}

#[cfg(test)]
mod tests {
    use super::*;

    fn judged(said: &str) -> Result<Reading, Refusal> {
        Answer::judge(said.as_bytes(), 10)
    }

    const GOOD: &str = r#"{"reading":{"text":"hi","truncated":false,"cut_short":false,"size":[3,4],"sandbox":"full"}}"#;

    #[test]
    fn a_whole_answer_is_believed() {
        let reading = judged(GOOD).unwrap();
        assert_eq!(reading.text, "hi");
        assert_eq!(
            reading.dimensions,
            Some(Dimensions {
                width: 3,
                height: 4
            })
        );
        assert_eq!(reading.sandbox, Sandbox::Full);
    }

    #[test]
    fn a_refusal_a_child_may_give_is_passed_on() {
        assert_eq!(
            judged(r#"{"refusal":{"kind":"over_limit","reason":"big"}}"#),
            Err(Refusal::OverLimit("big".into()))
        );
    }

    #[test]
    fn every_bad_answer_is_a_crash() {
        let second_document = format!("{GOOD}{GOOD}");
        let unknown_field = GOOD.replace("\"truncated\"", "\"extra\":1,\"truncated\"");
        let duplicate_field = GOOD.replace("\"text\":\"hi\"", "\"text\":\"a\",\"text\":\"b\"");
        let long_reason = format!(
            r#"{{"refusal":{{"kind":"malformed","reason":"{}"}}}}"#,
            "x".repeat(MAX_REASON_BYTES + 1)
        );
        for bad in [
            "",
            "not json",
            "[]",
            "null",
            &GOOD[..GOOD.len() - 1],
            &second_document,
            &unknown_field,
            &duplicate_field,
            &long_reason,
            r#"{"reading":{"text":"hi"}}"#,
            r#"{"refusal":{"kind":"crashed","reason":""}}"#,
            r#"{"refusal":{"kind":"timed_out","reason":""}}"#,
            r#"{"reading":{"text":"hi","truncated":false,"cut_short":false,"size":[0,4],"sandbox":"full"}}"#,
            r#"{"reading":{"text":"hi","truncated":false,"cut_short":false,"size":null,"sandbox":"maybe"}}"#,
            r#"{"reading":{"text":"12345678901","truncated":false,"cut_short":false,"size":null,"sandbox":"full"}}"#,
        ] {
            assert!(
                matches!(judged(bad), Err(Refusal::Crashed(_))),
                "believed: {bad}"
            );
        }
    }

    #[test]
    fn a_long_reason_is_cut_between_characters() {
        let reason = shorten("é".repeat(MAX_REASON_BYTES));
        assert!(reason.len() <= MAX_REASON_BYTES);
        assert!(reason.chars().all(|c| c == 'é'));
    }
}
