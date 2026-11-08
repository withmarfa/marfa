const NAME_LIMIT: usize = 40;
const MOST_NAME_CHARS: usize = 200;

pub fn usable(name: Option<&str>) -> Option<&str> {
    let name = name?.trim();
    let shown = !name.is_empty()
        && name.chars().count() <= MOST_NAME_CHARS
        && !name.chars().any(super::owner::is_hidden);
    shown.then_some(name)
}

fn says(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        !text[..at]
            .chars()
            .next_back()
            .is_some_and(|before| before.is_alphanumeric() || before == '_')
    })
}

fn says_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|word| says(text, word))
}

/// Edge, Opera and every Chromium browser also say `Chrome/`, and Chrome also
/// says `Safari/`, so the more particular names are asked first.
fn browser(text: &str) -> Option<&'static str> {
    [
        (&["Edg/", "Edge/", "EdgA/", "EdgiOS/"][..], "Edge"),
        (&["OPR/", "Opera"][..], "Opera"),
        (&["Firefox/", "FxiOS/"][..], "Firefox"),
        (&["Chrome/", "CriOS/"][..], "Chrome"),
        (&["Safari/"][..], "Safari"),
    ]
    .into_iter()
    .find(|(words, _)| says_any(text, words))
    .map(|(_, name)| name)
}

/// An iPhone's and an iPad's browser say `like Mac OS X`, and Android's say
/// `Linux`, so those are asked first.
fn system(text: &str) -> Option<&'static str> {
    [
        (&["iPad"][..], "iPadOS"),
        (&["iPhone", "iPod"][..], "iOS"),
        (&["Android"][..], "Android"),
        (&["CrOS"][..], "ChromeOS"),
        (&["Macintosh", "Mac OS X"][..], "macOS"),
        (&["Windows"][..], "Windows"),
        (&["Linux", "X11"][..], "Linux"),
    ]
    .into_iter()
    .find(|(words, _)| says_any(text, words))
    .map(|(_, name)| name)
}

fn product(text: &str) -> Option<String> {
    let name: String = text
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(NAME_LIMIT)
        .collect();
    let starts_well = name.starts_with(|c: char| c.is_ascii_alphabetic());
    (starts_well && name != "Mozilla").then_some(name)
}

pub fn browser_name(user_agent: Option<&str>) -> String {
    const NO_NAME: &str = "A browser";
    let text = user_agent.unwrap_or("").trim();
    if text.is_empty() || text.chars().any(super::owner::is_hidden) {
        return NO_NAME.to_string();
    }
    let named = browser(text)
        .map(str::to_string)
        .or_else(|| product(text))
        .unwrap_or_else(|| NO_NAME.to_string());
    match system(text) {
        Some(system) => format!("{named} on {system}"),
        None => named,
    }
}

#[cfg(test)]
mod tests {
    use super::browser_name;

    #[test]
    fn names_a_browser_or_the_product_that_stands_for_one() {
        let safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                      (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
        assert_eq!(browser_name(Some(safari)), "Safari on macOS");
        assert_eq!(browser_name(Some("curl/8.7.1")), "curl");
        assert_eq!(browser_name(Some("Mozilla/5.0")), "A browser");
        assert_eq!(browser_name(Some("bad\u{7}agent")), "A browser");
        assert_eq!(browser_name(None), "A browser");
    }
}
