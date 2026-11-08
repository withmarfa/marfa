//! What crosses between parent and child. Each side is strict: an unknown field, a
//! missing one or a second document is a bad answer, not something to work around.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::kind::Kind;
use crate::media::checked_duration;
use crate::{Dimensions, Limit, OcrOptions, Options, Reading, Refusal, Sandbox};

/// The longest reason a child may give.
pub(super) const MAX_REASON_BYTES: usize = 2048;

/// The longest frame a child may write.
pub(super) const MAX_FRAME_BYTES: usize = 64;

/// The longest request a child is given, as one command-line argument.
pub(super) const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// What one reading is to do. The limits a child takes before it reads anything are
/// on its command line, not here.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) mime: String,
    /// How many bytes the file on stdin holds.
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
    /// The options the reading runs under. The time limit is the child's own and is
    /// enforced around it, so it means nothing here.
    pub(super) fn options(&self, max_memory_bytes: u64) -> Options {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        Options {
            max_text_chars: usize::try_from(self.max_text_chars).unwrap_or(usize::MAX),
            max_inflated_bytes: self.max_inflated_bytes,
            max_memory_bytes,
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

/// The first thing a child says: one line, written once it is confined and before it
/// reads a byte of the file. Until then nothing a file holds has run, so this is the one
/// thing a child says that the parent can believe, and nothing it says later changes it.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Frame {
    sandbox: Sandbox,
}

impl Frame {
    pub(super) fn line(sandbox: Sandbox) -> Vec<u8> {
        let mut line = serde_json::to_vec(&Self { sandbox }).unwrap_or_default();
        line.push(b'\n');
        line
    }

    pub(super) fn read(line: &[u8]) -> Option<Sandbox> {
        Some(serde_json::from_slice::<Self>(line).ok()?.sandbox)
    }
}

/// The child's one document, after its frame.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub(super) enum Answer {
    Reading {
        text: String,
        truncated: bool,
        cut_short: bool,
        size: Option<(u32, u32)>,
        duration: Option<f64>,
        text_refused: Option<Refused>,
    },
    Refusal(Refused),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Refused {
    kind: RefusalKind,
    reason: String,
}

/// What a child may say of a file. Whether the reading timed out or crashed is for
/// the parent to observe, so a child has no words for it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RefusalKind {
    Unsupported,
    Encrypted,
    Malformed,
    OverInflated,
    OverMemory,
    OverFixed,
    OcrUnavailable,
}

impl Refused {
    fn of(refusal: Refusal) -> Self {
        let (kind, reason) = match refusal {
            Refusal::Unsupported => (RefusalKind::Unsupported, String::new()),
            Refusal::Encrypted => (RefusalKind::Encrypted, String::new()),
            Refusal::OverLimit(Limit::Inflated, reason) => (RefusalKind::OverInflated, reason),
            Refusal::OverLimit(Limit::Memory, reason) => (RefusalKind::OverMemory, reason),
            Refusal::OverLimit(Limit::Fixed, reason) => (RefusalKind::OverFixed, reason),
            Refusal::OcrUnavailable(reason) => (RefusalKind::OcrUnavailable, reason),
            Refusal::Malformed(reason)
            | Refusal::Crashed(reason)
            | Refusal::ReaderUnavailable(reason) => (RefusalKind::Malformed, reason),
            Refusal::TimedOut => (RefusalKind::Malformed, String::new()),
        };
        Self {
            kind,
            reason: shorten(reason),
        }
    }

    /// The refusal this claims, in words fit for a log.
    fn believed(self) -> Result<Refusal, Refusal> {
        if self.reason.len() > MAX_REASON_BYTES {
            return Err(Refusal::Crashed(
                "the reader answered with too long a reason".into(),
            ));
        }
        let reason = for_a_log(&self.reason);
        Ok(match self.kind {
            RefusalKind::Unsupported => Refusal::Unsupported,
            RefusalKind::Encrypted => Refusal::Encrypted,
            RefusalKind::Malformed => Refusal::Malformed(reason),
            RefusalKind::OverInflated => Refusal::OverLimit(Limit::Inflated, reason),
            RefusalKind::OverMemory => Refusal::OverLimit(Limit::Memory, reason),
            RefusalKind::OverFixed => Refusal::OverLimit(Limit::Fixed, reason),
            RefusalKind::OcrUnavailable => Refusal::OcrUnavailable(reason),
        })
    }
}

/// What the parent asked for, and so what an answer may hold. A child that has read a
/// hostile file can say anything, so what can be told from the request is not left to
/// it.
#[derive(Clone, Copy, Debug)]
pub(super) struct Asked {
    pub(super) kind: Kind,
    /// Whether the reading runs OCR at all.
    pub(super) ocr: bool,
    pub(super) max_text_chars: usize,
    /// What the child's frame said.
    pub(super) sandbox: Sandbox,
}

impl Asked {
    fn reads_pictures(&self) -> bool {
        self.ocr && matches!(self.kind, Kind::Image { ocr: true } | Kind::Pdf)
    }

    /// Only a package, a workbook or a PDF has a password, and the parent has already
    /// turned away what no reader takes.
    fn may_refuse(&self, kind: RefusalKind) -> bool {
        match kind {
            RefusalKind::Unsupported => false,
            RefusalKind::Encrypted => {
                matches!(self.kind, Kind::Document(_) | Kind::Sheet(_) | Kind::Pdf)
            }
            RefusalKind::Malformed
            | RefusalKind::OverInflated
            | RefusalKind::OverMemory
            | RefusalKind::OverFixed => true,
            RefusalKind::OcrUnavailable => self.reads_pictures(),
        }
    }

    fn may_refuse_text_of_an_image(&self, kind: RefusalKind) -> bool {
        self.reads_pictures()
            && matches!(self.kind, Kind::Image { .. })
            && matches!(
                kind,
                RefusalKind::Malformed
                    | RefusalKind::OverInflated
                    | RefusalKind::OverMemory
                    | RefusalKind::OverFixed
                    | RefusalKind::OcrUnavailable
            )
    }
}

fn not_believed(what: &str) -> Refusal {
    Refusal::Crashed(format!("the reader answered with {what}"))
}

impl Answer {
    pub(super) fn of(outcome: Result<Reading, Refusal>) -> Self {
        match outcome {
            Ok(reading) => Self::Reading {
                text: reading.text,
                truncated: reading.truncated,
                cut_short: reading.cut_short,
                size: reading.dimensions.map(|size| (size.width, size.height)),
                duration: reading.duration,
                text_refused: reading.text_refused.map(Refused::of),
            },
            Err(refusal) => Self::Refusal(Refused::of(refusal)),
        }
    }

    /// Reads the bytes a child wrote after its frame. Anything but one well-formed
    /// document that keeps to what was asked is `Crashed`: the child that wrote it is
    /// not to be believed.
    pub(super) fn judge(said: &[u8], asked: &Asked) -> Result<Reading, Refusal> {
        let answer: Self = serde_json::from_slice(said).map_err(|error| {
            Refusal::Crashed(shorten(for_a_log(&format!(
                "the reader's answer is bad: {error}"
            ))))
        })?;
        match answer {
            Self::Reading {
                text,
                truncated,
                cut_short,
                size,
                duration,
                text_refused,
            } => {
                if text.len() > asked.max_text_chars.saturating_mul(3)
                    || text.encode_utf16().count() > asked.max_text_chars
                {
                    return Err(not_believed("more text than it may"));
                }
                if size.is_some_and(|(width, height)| width == 0 || height == 0) {
                    return Err(not_believed("an empty image size"));
                }
                if size.is_some() && !matches!(asked.kind, Kind::Image { .. } | Kind::Media { .. })
                {
                    return Err(not_believed("a size for a file that is no image or video"));
                }
                if duration.is_some() && !matches!(asked.kind, Kind::Media { .. }) {
                    return Err(not_believed(
                        "a duration for a file that is no sound or video",
                    ));
                }
                if duration.is_some_and(|seconds| checked_duration(seconds).is_err()) {
                    return Err(not_believed("a duration that cannot be real"));
                }
                if !text.is_empty() && matches!(asked.kind, Kind::Media { .. }) {
                    return Err(not_believed("text from a sound or a video"));
                }
                if !text.is_empty()
                    && matches!(asked.kind, Kind::Image { .. })
                    && !asked.reads_pictures()
                {
                    return Err(not_believed("text from an image it was not to read"));
                }
                if cut_short && !asked.reads_pictures() {
                    return Err(not_believed("pictures cut short where it read none"));
                }
                let text_refused = text_refused
                    .map(|refused| {
                        if size.is_none()
                            || !text.is_empty()
                            || cut_short
                            || !asked.may_refuse_text_of_an_image(refused.kind)
                        {
                            return Err(not_believed("a refusal it may not give beside a size"));
                        }
                        refused.believed()
                    })
                    .transpose()?;
                Ok(Reading {
                    text,
                    truncated,
                    cut_short,
                    dimensions: size.map(|(width, height)| Dimensions { width, height }),
                    duration,
                    text_refused,
                    sandbox: asked.sandbox,
                })
            }
            Self::Refusal(refused) => {
                if !asked.may_refuse(refused.kind) {
                    return Err(not_believed("a refusal this file cannot earn"));
                }
                Err(refused.believed()?)
            }
        }
    }
}

/// `text`, safe to put in a log: a child chooses these characters, so none may start a
/// line, move a terminal's cursor or turn the text around.
pub(super) fn for_a_log(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{200e}' | '\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_owned()
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
    use crate::kind::Document;

    const IMAGE: Asked = Asked {
        kind: Kind::Image { ocr: true },
        ocr: true,
        max_text_chars: 10,
        sandbox: Sandbox::Partial,
    };
    const TEXT: Asked = Asked {
        kind: Kind::Text,
        ocr: true,
        ..IMAGE
    };
    const MEDIA: Asked = Asked {
        kind: Kind::Media { matroska: false },
        ocr: false,
        ..IMAGE
    };
    const WORD: Asked = Asked {
        kind: Kind::Document(Document::Docx),
        ..TEXT
    };

    fn judged(said: &str) -> Result<Reading, Refusal> {
        Answer::judge(said.as_bytes(), &IMAGE)
    }

    const GOOD: &str = r#"{"reading":{"text":"hi","truncated":false,"cut_short":false,"size":[3,4],"text_refused":null}}"#;

    fn reading(fields: &str) -> String {
        format!(r#"{{"reading":{{"text":"","truncated":false,{fields}}}}}"#)
    }

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
    }

    fn media(fields: &str) -> String {
        format!(
            r#"{{"reading":{{"text":"","truncated":false,"cut_short":false,{fields},"text_refused":null}}}}"#
        )
    }

    #[test]
    fn a_length_and_a_picture_size_are_believed_for_a_video() {
        let said = media(r#""size":[640,360],"duration":12.5"#);
        let reading = Answer::judge(said.as_bytes(), &MEDIA).unwrap();
        assert_eq!(reading.duration, Some(12.5));
        assert_eq!(reading.dimensions.map(|size| size.height), Some(360));
        let sound = media(r#""size":null,"duration":0.0"#);
        assert_eq!(
            Answer::judge(sound.as_bytes(), &MEDIA).unwrap().duration,
            Some(0.0)
        );
    }

    #[test]
    fn a_length_nobody_could_have_is_a_crash() {
        for seconds in ["-1.0", "1e11", "1e300"] {
            let said = media(&format!(r#""size":null,"duration":{seconds}"#));
            assert!(
                matches!(
                    Answer::judge(said.as_bytes(), &MEDIA),
                    Err(Refusal::Crashed(_))
                ),
                "believed: {seconds}"
            );
        }
        let said = media(r#""size":null,"duration":3.0"#);
        for asked in [&IMAGE, &TEXT, &WORD] {
            assert!(
                matches!(
                    Answer::judge(said.as_bytes(), asked),
                    Err(Refusal::Crashed(_))
                ),
                "{asked:?}"
            );
        }
    }

    #[test]
    fn text_from_a_sound_is_a_crash() {
        let said = r#"{"reading":{"text":"hi","truncated":false,"cut_short":false,"size":null,"duration":1.0,"text_refused":null}}"#;
        assert!(matches!(
            Answer::judge(said.as_bytes(), &MEDIA),
            Err(Refusal::Crashed(_))
        ));
    }

    #[test]
    fn the_sandbox_is_what_the_frame_said() {
        assert_eq!(judged(GOOD).unwrap().sandbox, Sandbox::Partial);
    }

    #[test]
    fn a_frame_says_what_it_was_given() {
        for sandbox in [Sandbox::Full, Sandbox::Partial, Sandbox::Off] {
            let line = Frame::line(sandbox);
            assert!(line.len() <= MAX_FRAME_BYTES);
            assert_eq!(line.iter().filter(|byte| **byte == b'\n').count(), 1);
            assert_eq!(Frame::read(&line), Some(sandbox));
        }
        assert_eq!(Frame::read(b"{\"sandbox\":\"maybe\"}"), None);
        assert_eq!(Frame::read(b"not the reader"), None);
    }

    #[test]
    fn a_refusal_a_child_may_give_is_passed_on() {
        assert_eq!(
            judged(r#"{"refusal":{"kind":"over_limit","reason":"big"}}"#),
            Err(Refusal::OverLimit(Limit::Memory, "big".into()))
        );
    }

    #[test]
    fn a_refusal_beside_a_size_is_kept() {
        let said = reading(
            r#""cut_short":false,"size":[3,4],"text_refused":{"kind":"malformed","reason":"cut"}"#,
        );
        let reading = judged(&said).unwrap();
        assert_eq!(reading.text_refused, Some(Refusal::Malformed("cut".into())));
        assert_eq!(reading.dimensions.map(|size| size.width), Some(3));
    }

    #[test]
    fn a_reason_reaches_a_log_with_nothing_a_child_could_steer_it_by() {
        let said =
            r#"{"refusal":{"kind":"malformed","reason":"a\nb\u001b[31mc\u202ed\u2028e\u0000"}}"#;
        assert_eq!(
            judged(said),
            Err(Refusal::Malformed("a b [31mc d e".into()))
        );
        let beside = reading(
            r#""cut_short":false,"size":[3,4],"text_refused":{"kind":"over_limit","reason":"a\nb"}"#,
        );
        assert_eq!(
            judged(&beside).unwrap().text_refused,
            Some(Refusal::OverLimit(Limit::Inflated, "a b".into()))
        );
    }

    #[test]
    fn a_bad_answer_cannot_steer_a_log_through_the_parsers_words() {
        let said = r#"{"reading":{"a\nb":1}}"#;
        let Err(Refusal::Crashed(why)) = judged(said) else {
            panic!("believed: {said}");
        };
        assert!(!why.contains('\n'), "{why}");
    }

    #[test]
    fn what_the_request_rules_out_is_a_crash() {
        let encrypted = r#"{"refusal":{"kind":"encrypted","reason":""}}"#;
        let ocr_off = r#"{"refusal":{"kind":"ocr_unavailable","reason":"x"}}"#;
        let size = r#"{"reading":{"text":"","truncated":false,"cut_short":false,"size":[3,4],"text_refused":null}}"#;
        let short = reading(r#""cut_short":true,"size":null,"text_refused":null"#);
        let beside = reading(
            r#""cut_short":false,"size":[3,4],"text_refused":{"kind":"malformed","reason":""}"#,
        );
        let no_ocr = Asked {
            ocr: false,
            ..IMAGE
        };
        for (said, asked) in [
            (r#"{"refusal":{"kind":"unsupported","reason":""}}"#, &TEXT),
            (encrypted, &TEXT),
            (encrypted, &IMAGE),
            (ocr_off, &TEXT),
            (ocr_off, &no_ocr),
            (size, &TEXT),
            (short.as_str(), &TEXT),
            (short.as_str(), &no_ocr),
            (GOOD, &no_ocr),
            (beside.as_str(), &TEXT),
            (beside.as_str(), &no_ocr),
        ] {
            assert!(
                matches!(
                    Answer::judge(said.as_bytes(), asked),
                    Err(Refusal::Crashed(_))
                ),
                "believed: {said} for {asked:?}"
            );
        }
        assert_eq!(
            Answer::judge(encrypted.as_bytes(), &WORD),
            Err(Refusal::Encrypted)
        );
    }

    #[test]
    fn every_bad_answer_is_a_crash() {
        let second_document = format!("{GOOD}{GOOD}");
        let unknown_field = GOOD.replace("\"truncated\"", "\"extra\":1,\"truncated\"");
        let duplicate_field = GOOD.replace("\"text\":\"hi\"", "\"text\":\"a\",\"text\":\"b\"");
        let a_claim = GOOD.replace(
            "\"text_refused\":null",
            "\"text_refused\":null,\"sandbox\":\"full\"",
        );
        let long_reason = format!(
            r#"{{"refusal":{{"kind":"malformed","reason":"{}"}}}}"#,
            "x".repeat(MAX_REASON_BYTES + 1)
        );
        let refused_with_text = GOOD.replace(
            "\"text_refused\":null",
            r#""text_refused":{"kind":"malformed","reason":""}"#,
        );
        let refused_with_no_size = reading(
            r#""cut_short":false,"size":null,"text_refused":{"kind":"malformed","reason":""}"#,
        );
        let encrypted_beside = reading(
            r#""cut_short":false,"size":[3,4],"text_refused":{"kind":"encrypted","reason":""}"#,
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
            &a_claim,
            &long_reason,
            &refused_with_text,
            &refused_with_no_size,
            &encrypted_beside,
            r#"{"reading":{"text":"hi"}}"#,
            r#"{"refusal":{"kind":"crashed","reason":""}}"#,
            r#"{"refusal":{"kind":"timed_out","reason":""}}"#,
            r#"{"reading":{"text":"hi","truncated":false,"cut_short":false,"size":[0,4],"text_refused":null}}"#,
            r#"{"reading":{"text":"12345678901","truncated":false,"cut_short":false,"size":null,"text_refused":null}}"#,
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
