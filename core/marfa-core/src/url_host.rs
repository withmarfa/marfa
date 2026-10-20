//! Where the `url` crate and the WHATWG URL standard part on the authority of
//! a URL, which the server judges as the standard does.
//!
//! The crate refuses a host that is ASCII once percent-decoded and has an
//! `xn--` label that is not Punycode. The standard lowercases such a host and
//! does not judge its labels. The crate takes two authorities of a scheme that
//! is not special that the standard refuses: an empty host after credentials,
//! and a port followed by a backslash.

const SPECIAL: [&str; 5] = ["http", "https", "ftp", "ws", "wss"];

/// Whether `text`, which `url::Url::parse` refuses, is refused only because of
/// an ASCII host with an `xn--` label: the URL is judged again with that host
/// replaced by a plain one.
pub(crate) fn ascii_host_is_taken(text: &str) -> bool {
    let text = text.trim_matches(|ch: char| ch <= ' ');
    let Some((span, host)) = host_span(text) else {
        return false;
    };
    let Some(host) = ascii_host(host) else {
        return false;
    };
    if !host.split('.').any(|label| {
        label
            .get(..4)
            .is_some_and(|start| start.eq_ignore_ascii_case("xn--"))
    }) || forbidden(&host)
        || ends_in_a_number(&host)
    {
        return false;
    }
    let replaced = format!("{}x{}", &text[..span.0], &text[span.1..]);
    url::Url::parse(&replaced).is_ok()
}

/// Where the host sits in `text`, and the host as written, for a special
/// scheme with a domain host. Tabs and line breaks are already gone from
/// `text`.
fn host_span(text: &str) -> Option<((usize, usize), &str)> {
    let colon = text.find(':')?;
    let scheme = &text[..colon];
    if !scheme.starts_with(|ch: char| ch.is_ascii_alphabetic())
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let after = colon + 1;
    let rest = &text[after..];
    let slash = |ch: char| matches!(ch, '/' | '\\');
    let end_of = |from: usize, stops: &[char]| {
        text[from..]
            .find(|ch: char| stops.contains(&ch))
            .map_or(text.len(), |at| from + at)
    };
    let (start, end) = if scheme == "file" {
        let mut slashes = rest.chars();
        if !slashes.next().is_some_and(slash) || !slashes.next().is_some_and(slash) {
            return None;
        }
        let start = after + 2;
        (start, end_of(start, &['/', '\\', '?', '#']))
    } else if SPECIAL.contains(&scheme.as_str()) {
        let start = after + (rest.len() - rest.trim_start_matches(slash).len());
        let authority_end = end_of(start, &['/', '\\', '?', '#']);
        let host_start = text[start..authority_end]
            .rfind('@')
            .map_or(start, |at| start + at + 1);
        if text[host_start..].starts_with('[') {
            return None;
        }
        let host_end = text[host_start..authority_end]
            .find(':')
            .map_or(authority_end, |at| host_start + at);
        (host_start, host_end)
    } else {
        return None;
    };
    (start < end).then(|| ((start, end), &text[start..end]))
}

/// The host percent-decoded, where that is ASCII.
fn ascii_host(host: &str) -> Option<String> {
    let bytes = host.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let pair = bytes
            .get(at + 1..at + 3)
            .filter(|hex| bytes[at] == b'%' && hex.iter().all(u8::is_ascii_hexdigit))
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match pair {
            Some(byte) => {
                decoded.push(byte);
                at += 3;
            }
            None => {
                decoded.push(bytes[at]);
                at += 1;
            }
        }
    }
    decoded
        .is_ascii()
        .then(|| String::from_utf8(decoded).ok())
        .flatten()
}

/// Whether the standard refuses the decoded host for a code point in it.
fn forbidden(host: &str) -> bool {
    host.bytes().any(|b| {
        b <= b' '
            || b == 0x7f
            || matches!(
                b,
                b'#' | b'%'
                    | b'/'
                    | b':'
                    | b'<'
                    | b'>'
                    | b'?'
                    | b'@'
                    | b'['
                    | b'\\'
                    | b']'
                    | b'^'
                    | b'|'
            )
    })
}

/// Whether the standard reads the host as an IPv4 address, which an `xn--`
/// label never is, so the host is refused.
fn ends_in_a_number(host: &str) -> bool {
    let mut labels: Vec<&str> = host.split('.').collect();
    if labels.last() == Some(&"") && labels.len() > 1 {
        labels.pop();
    }
    let last = labels.last().copied().unwrap_or("");
    let hex = last
        .strip_prefix("0x")
        .or_else(|| last.strip_prefix("0X"))
        .is_some_and(|digits| digits.bytes().all(|b| b.is_ascii_hexdigit()));
    !last.is_empty() && (last.bytes().all(|b| b.is_ascii_digit()) || hex)
}

/// Whether `text`, which `url::Url::parse` takes, has an authority that the
/// standard refuses.
pub(crate) fn authority_is_refused(text: &str) -> bool {
    let text = text.trim_matches(|ch: char| ch <= ' ');
    let Some((scheme, rest)) = text.split_once(':') else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme == "file" || SPECIAL.contains(&scheme.as_str()) {
        return false;
    }
    let Some(rest) = rest.strip_prefix("//") else {
        return false;
    };
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let host = authority.rfind('@').map_or(authority, |at| {
        if at + 1 == authority.len() {
            ""
        } else {
            &authority[at + 1..]
        }
    });
    if host.is_empty() {
        return authority.contains('@');
    }
    let after_address = host.rfind(']').map_or(0, |closing| closing + 1);
    host[after_address..]
        .split_once(':')
        .is_some_and(|(_, port)| port.contains('\\'))
}
