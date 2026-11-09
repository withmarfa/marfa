use serde_json::Value;

use crate::error::CliError;
use crate::output::{Printer, printable};
use crate::remote::Remote;
use crate::remote::request::Request;

pub fn request() -> Request {
    Request::get(&["attention"])
}

pub fn run(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let answer = remote.json(&request())?;
    out.report(&answer, || describe(&answer))
}

fn text<'a>(concern: &'a Value, field: &str) -> &'a str {
    concern
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Each concern as its kind and title, with what is wrong and what it refers to beneath.
fn describe(answer: &Value) -> String {
    let concerns = answer
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if concerns.is_empty() {
        return "nothing needs attention".to_string();
    }
    concerns
        .iter()
        .map(|concern| {
            format!(
                "{}  {}\n  {}\n  {}",
                printable(text(concern, "kind")),
                printable(text(concern, "title")),
                printable(text(concern, "description")),
                printable(text(concern, "reference")),
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_empty_list_says_so_and_a_concern_takes_three_lines() {
        assert_eq!(describe(&json!({ "data": [] })), "nothing needs attention");
        let answer = json!({ "data": [
            { "kind": "key", "reference": "k1", "title": "Backup expires soon", "description": "It expires soon." },
            { "kind": "job", "reference": "audit-cleanup", "title": "audit-cleanup failed", "description": "The last run failed." },
        ] });
        assert_eq!(
            describe(&answer),
            "key  Backup expires soon\n  It expires soon.\n  k1\n\n\
             job  audit-cleanup failed\n  The last run failed.\n  audit-cleanup"
        );
    }

    #[test]
    fn a_title_that_would_move_the_cursor_is_escaped() {
        let answer = json!({ "data": [
            { "kind": "connector", "reference": "c", "title": "x\u{1b}[2K", "description": "d" },
        ] });
        assert!(!describe(&answer).contains('\u{1b}'));
    }
}
