//! The server's HTML pages. Each carries the nonce of its own policy, which
//! allows nothing else to run or style it.

use axum::http::HeaderValue;

use crate::app::refusal::{Refusal, Result};

const STYLE: &str = "body{font-family:system-ui,sans-serif;margin:4rem auto;max-width:36rem;\
                     padding:0 1rem}";

pub struct Page {
    pub html: String,
    pub policy: HeaderValue,
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

fn new_nonce() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(hex::encode(bytes))
}

pub fn render(title: &str, text: &str) -> Result<Page> {
    let nonce = new_nonce()?;
    let (title, text) = (escape(title), escape(text));
    let policy = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; \
         img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    Ok(Page {
        html: format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <title>{title}</title><style nonce=\"{nonce}\">{STYLE}</style></head>\
             <body><h1>{title}</h1><p>{text}</p></body></html>"
        ),
        policy: HeaderValue::from_str(&policy)
            .map_err(|_| Refusal::internal("a page policy was not a header"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn what_a_page_shows_cannot_become_markup() {
        let page = render("<b>", "a\"'&").unwrap();
        assert!(page.html.contains("&lt;b&gt;"));
        assert!(page.html.contains("a&quot;&#39;&amp;"));
    }
}
