//! An HTML page as the text a person would read in it.
//!
//! The page goes through `html5ever`'s tokenizer alone, with no tree built. The
//! stack of open elements is kept here, so the limits on it are ours: a page
//! that nests too deep is left unread past that point, and a closing tag that
//! matches nothing costs nothing.

use std::cell::RefCell;
use std::collections::HashMap;

use html5ever::LocalName;
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{
    BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};

use crate::decode;
use crate::sink::Sink;

/// The most bytes of a page that are read. A page past it is read up to here.
const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;

/// Open elements held before the rest of the page is left unread. The text
/// found before that point is kept.
const MAX_DEPTH: usize = 512;

/// Bytes of the page decoded and tokenized between checks that the text has
/// room for more.
const CHUNK: usize = 64 * 1024;

/// Elements whose content is never shown as text.
const SKIPPED: &[&str] = &[
    "script", "style", "noscript", "template", "iframe", "object", "embed",
];

/// Elements that start and end a line, so words either side never run together.
const BLOCKS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "br",
    "caption",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "option",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "textarea",
    "title",
    "tr",
    "ul",
];

/// Elements whose line breaks are kept as written.
const PREFORMATTED: &[&str] = &["pre", "textarea"];

/// Elements with no content, closed as soon as they open.
const VOID: &[&str] = &[
    "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img", "input",
    "isindex", "keygen", "link", "meta", "param", "source", "track", "wbr",
];

/// Whether opening `opening` ends the `open` element on top of the stack, as a
/// browser does for `<p>` before a second `<p>` or `<li>` before the next.
fn implies_close(opening: &str, open: &str) -> bool {
    match opening {
        "tr" => matches!(open, "tr" | "th" | "td"),
        "th" => open == "th",
        "td" => matches!(open, "thead" | "th" | "td"),
        "body" => matches!(open, "head" | "link" | "script"),
        "li" | "option" => open == opening,
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "address" | "article" | "aside"
        | "blockquote" | "details" | "div" | "dl" | "fieldset" | "figcaption" | "figure"
        | "footer" | "form" | "header" | "hr" | "main" | "nav" | "ol" | "pre" | "section"
        | "table" | "ul" => open == "p",
        "select" | "input" | "output" | "button" | "datalist" | "textarea" => matches!(
            open,
            "input" | "option" | "optgroup" | "select" | "button" | "datalist" | "textarea"
        ),
        "optgroup" => matches!(open, "optgroup" | "option"),
        "dd" | "dt" => matches!(open, "dd" | "dt"),
        "rt" | "rp" => matches!(open, "rt" | "rp"),
        "tbody" | "tfoot" => matches!(open, "thead" | "tbody"),
        _ => false,
    }
}

/// How the tokenizer reads what follows a start tag: elements whose content is
/// text, not markup.
fn raw_kind(name: &str) -> Option<RawKind> {
    match name {
        "script" => Some(RawKind::ScriptData),
        "style" | "iframe" | "noembed" | "noframes" | "xmp" => Some(RawKind::Rawtext),
        "textarea" | "title" => Some(RawKind::Rcdata),
        _ => None,
    }
}

/// The stack of open elements, and the text collected from them.
struct Page<'a> {
    sink: &'a mut Sink,
    xhtml: bool,
    open: Vec<LocalName>,
    /// How many of each name are open, so a closing tag with no match is known
    /// at once.
    counts: HashMap<LocalName, usize>,
    /// The stack's depth where an element with skipped content opened.
    skipping_from: Option<usize>,
    preformatted: usize,
    too_deep: bool,
}

impl Page<'_> {
    fn done(&self) -> bool {
        self.too_deep || self.sink.is_full()
    }

    fn open_tag(&mut self, name: LocalName, self_closing: bool) {
        while self
            .open
            .last()
            .is_some_and(|top| implies_close(&name, top))
        {
            self.close_top();
        }
        *self.counts.entry(name.clone()).or_default() += 1;
        self.open.push(name.clone());
        if self.open.len() > MAX_DEPTH {
            self.too_deep = true;
            return;
        }
        if self.skipping_from.is_none() && SKIPPED.contains(&&*name) {
            self.skipping_from = Some(self.open.len());
        }
        if PREFORMATTED.contains(&&*name) {
            self.preformatted += 1;
        }
        if self.skipping_from.is_none() {
            if BLOCKS.contains(&&*name) {
                self.sink.break_line();
            } else if matches!(&*name, "td" | "th") {
                self.sink.separate();
            }
        }
        if VOID.contains(&&*name) || (self.xhtml && self_closing) {
            self.close_top();
        }
    }

    fn close_top(&mut self) {
        let Some(name) = self.open.pop() else { return };
        if let Some(count) = self.counts.get_mut(&name) {
            *count -= 1;
        }
        if PREFORMATTED.contains(&&*name) && self.preformatted > 0 {
            self.preformatted -= 1;
        }
        if let Some(from) = self.skipping_from {
            if from > self.open.len() {
                self.skipping_from = None;
            }
        } else if BLOCKS.contains(&&*name) {
            self.sink.break_line();
        }
    }

    fn close_tag(&mut self, name: LocalName) {
        if self.counts.get(&name).copied().unwrap_or(0) > 0 {
            while let Some(top) = self.open.last() {
                let found = *top == name;
                self.close_top();
                if found || self.too_deep {
                    break;
                }
            }
        } else if &*name == "p" {
            // A browser opens a paragraph for a closing tag with none open.
            self.open_tag(name, false);
            self.close_top();
        } else if &*name == "br" {
            self.open_tag(name, false);
        }
    }

    fn text(&mut self, text: &str) {
        if self.skipping_from.is_none() {
            self.sink.push_words(text, self.preformatted > 0);
        }
    }
}

struct Tokens<'a>(RefCell<Page<'a>>);

impl TokenSink for Tokens<'_> {
    type Handle = ();

    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        let mut page = self.0.borrow_mut();
        if page.done() {
            return TokenSinkResult::Continue;
        }
        match token {
            Token::CharacterTokens(text) => page.text(&text),
            Token::TagToken(tag) => match tag.kind {
                TagKind::StartTag => {
                    let raw = raw_kind(&tag.name);
                    let self_closing = tag.self_closing;
                    let xhtml = page.xhtml;
                    page.open_tag(tag.name, self_closing);
                    // A self-closing tag in XHTML has no content to read raw.
                    if let Some(kind) = raw
                        && !(xhtml && self_closing)
                    {
                        return TokenSinkResult::RawData(kind);
                    }
                }
                TagKind::EndTag => page.close_tag(tag.name),
            },
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

/// Reads `bytes` as a page into `sink`. `xhtml` is for a page written as XML,
/// whose self-closing tags close.
pub(crate) fn read(bytes: &[u8], mime: &str, xhtml: bool, sink: &mut Sink) {
    let bytes = &bytes[..bytes.len().min(MAX_INPUT_BYTES)];
    let declared = decode::declared_charset(mime).or_else(|| decode::declared_in_markup(bytes));
    let (encoding, skip) = decode::choose(bytes, declared);
    let bytes = &bytes[skip..];

    let tokenizer = Tokenizer::new(
        Tokens(RefCell::new(Page {
            sink,
            xhtml,
            open: Vec::new(),
            counts: HashMap::new(),
            skipping_from: None,
            preformatted: 0,
            too_deep: false,
        })),
        TokenizerOpts::default(),
    );
    let input = BufferQueue::default();
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut chunks = bytes.chunks(CHUNK).peekable();
    let mut text = String::new();
    while let Some(chunk) = chunks.next() {
        let last = chunks.peek().is_none();
        text.clear();
        text.reserve(decoder.max_utf8_buffer_length(chunk.len()).unwrap_or(0));
        let _ = decoder.decode_to_string(chunk, &mut text, last);
        input.push_back(StrTendril::from_slice(&text));
        let _ = tokenizer.feed(&input);
        if tokenizer.sink.0.borrow().done() {
            return;
        }
    }
    tokenizer.end();
}
