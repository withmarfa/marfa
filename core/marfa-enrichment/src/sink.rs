//! Where a reader puts the text it finds.

/// Characters read past the text limit, so that whitespace trimmed from the end
/// never leaves the text short of the limit.
const MARGIN: usize = 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pending {
    Nothing,
    Space,
    Newline,
}

/// Collects text up to a little past the limit, and tells its reader when to
/// stop.
pub(crate) struct Sink {
    text: String,
    length: usize,
    cap: usize,
    pending: Pending,
    overflowed: bool,
}

impl Sink {
    pub(crate) fn new(max_text_chars: usize) -> Self {
        Self {
            text: String::new(),
            length: 0,
            cap: max_text_chars.saturating_add(MARGIN),
            pending: Pending::Nothing,
            overflowed: false,
        }
    }

    /// Whether more text would be dropped. A reader stops reading when this is
    /// true.
    pub(crate) fn is_full(&self) -> bool {
        self.overflowed
    }

    fn put(&mut self, c: char) {
        if self.length == self.cap {
            self.overflowed = true;
            return;
        }
        self.length += 1;
        self.text.push(c);
    }

    fn flush_pending(&mut self) {
        // Nothing goes before the first word.
        if !self.text.is_empty() {
            match self.pending {
                Pending::Nothing => {}
                Pending::Space => self.put(' '),
                Pending::Newline => self.put('\n'),
            }
        }
        self.pending = Pending::Nothing;
    }

    /// Text as written, whitespace and all, for a file that is itself text.
    /// Control characters other than tab and line breaks are dropped.
    pub(crate) fn push_raw(&mut self, text: &str) {
        for c in text.chars() {
            if self.overflowed {
                return;
            }
            if self.text.is_empty() && c.is_whitespace() {
                continue;
            }
            if c.is_control() && !matches!(c, '\t' | '\n' | '\r') {
                continue;
            }
            self.put(c);
        }
    }

    /// Words: each run of whitespace becomes one space, or one line break when
    /// it holds a line break and `keep_lines` is set.
    pub(crate) fn push_words(&mut self, text: &str, keep_lines: bool) {
        for c in text.chars() {
            if self.overflowed {
                return;
            }
            if c.is_whitespace() {
                if keep_lines && c == '\n' {
                    self.pending = Pending::Newline;
                } else if self.pending == Pending::Nothing {
                    self.pending = Pending::Space;
                }
            } else if !c.is_control() {
                self.flush_pending();
                self.put(c);
            }
        }
    }

    /// Ends a line, once however many times it is called.
    pub(crate) fn break_line(&mut self) {
        self.pending = Pending::Newline;
    }

    /// Puts a space between what comes before and after, unless a line break
    /// already does.
    pub(crate) fn separate(&mut self) {
        if self.pending == Pending::Nothing {
            self.pending = Pending::Space;
        }
    }

    /// The text trimmed and cut to `max_text_chars` characters, and whether anything
    /// was cut off.
    pub(crate) fn finish(self, max_text_chars: usize) -> (String, bool) {
        let mut text = self.text;
        let end = text.trim_end().len();
        text.truncate(end);
        let start = text.len() - text.trim_start().len();
        text.drain(..start);

        let cut = text
            .char_indices()
            .nth(max_text_chars)
            .map(|(index, _)| index);
        let truncated = self.overflowed || cut.is_some();
        if let Some(index) = cut {
            text.truncate(index);
            let end = text.trim_end().len();
            text.truncate(end);
        }
        (text, truncated)
    }
}
