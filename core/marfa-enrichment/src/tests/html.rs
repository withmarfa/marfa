use super::*;

fn page(html: &str) -> String {
    text(html.as_bytes(), "text/html")
}

#[test]
fn a_page_gives_its_visible_text_and_no_markup() {
    let shown = page(
        "<!doctype html><html><head><title>Quarterly &amp; yearly</title>\
         <style>.quokkacss { color: red }</style></head>\
         <body><h1>Report</h1><p>Sales rose &pound;5 &#x2014; <b>quokkahtml</b>.</p>\
         <script>var quokkascript = \"<p>not text</p>\";</script>\
         <noscript>enable scripts</noscript><!-- quokkacomment --></body></html>",
    );
    assert_eq!(
        shown,
        "Quarterly & yearly\nReport\nSales rose £5 \u{2014} quokkahtml."
    );
}

#[test]
fn block_elements_keep_words_apart_and_pre_keeps_its_lines() {
    assert_eq!(
        page(
            "<div>one</div><div>two</div><ul><li>three<li>four</ul>a<br>b<table><tr><td>c<td>d</table>"
        ),
        "one\ntwo\nthree\nfour\na\nb\nc d"
    );
    assert_eq!(page("<pre>a\n\n\nb</pre><p>c</p>"), "a\nb\nc");
}

#[test]
fn self_closing_tags_close_in_xhtml_only() {
    let source = "<div/><p>after</p><br/>end";
    assert_eq!(
        text(source.as_bytes(), "application/xhtml+xml"),
        "after\nend"
    );
    // In HTML the slash is ignored, and the open div holds all of it.
    assert_eq!(page("<div/>a<p>b</p>"), "a\nb");
}

#[test]
fn a_page_of_scripts_gives_the_text_between_them() {
    let script = "x();".repeat(100_000);
    assert_eq!(
        page(&format!(
            "<script>{script}</script><p>quokkaburied</p><script>y()</script>"
        )),
        "quokkaburied"
    );
    assert_eq!(page("<p>unterminated <script>quokka"), "unterminated");
}

#[test]
fn malformed_markup_gives_what_the_tokenizer_recovers() {
    let shown = page(
        "<div><p>first <b>bold <i>italic</div></span></p>second</b> <a href='x' <p>third &bogus; &amp",
    );
    for word in ["first", "second", "&bogus;"] {
        assert!(shown.contains(word), "{word} in {shown:?}");
    }
}

#[test]
fn a_page_declares_its_own_encoding() {
    let page = b"<meta charset=windows-1252><p>caf\xe9</p>";
    assert_eq!(text(page, "text/html"), "café");
    assert_eq!(
        text(b"<p>caf\xe9</p>", "text/html; charset=iso-8859-1"),
        "café"
    );
}

#[test]
fn deep_and_stray_markup_costs_no_more_than_its_size() {
    // Unclosed elements, then closing tags that match none of them.
    let flood = format!(
        "<p>quokkadeep</p>{}{}",
        "<div>".repeat(200_000),
        "</x>".repeat(200_000)
    );
    let started = std::time::Instant::now();
    assert_eq!(page(&flood), "quokkadeep");
    assert!(started.elapsed().as_secs() < 5, "{:?}", started.elapsed());
}

#[test]
fn text_below_the_depth_limit_is_not_read() {
    let down = |depth: usize, word: &str| format!("{}{word}", "<div>".repeat(depth));
    assert_eq!(page(&down(512, "quokkaatlimit")), "quokkaatlimit");
    assert_eq!(
        page(&format!(
            "<p>quokkabefore</p>{}<p>quokkaafter</p>",
            down(513, "quokkabelow")
        )),
        "quokkabefore"
    );
    // 600 open elements, as a real page that forgot its closing tags.
    assert_eq!(page(&down(600, "quokkadeepest")), "");
}

#[test]
fn a_page_far_past_the_limit_is_read_only_as_far_as_it_needs() {
    let source = format!(
        "<body>{}</body>",
        "<p>quokka quokka quokka</p>".repeat(300_000)
    );
    let mut limits = options();
    limits.max_text_chars = 1000;
    let reading = read_here(source.as_bytes(), "text/html", &limits).unwrap();
    assert_eq!(reading.text.chars().count(), 1000);
    assert!(reading.truncated);
    assert!(reading.text.starts_with("quokka quokka quokka\nquokka"));
}
