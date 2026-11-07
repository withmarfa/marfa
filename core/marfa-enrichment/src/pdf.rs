//! PDF text, through PDFium. A page that holds a picture and almost no text is
//! drawn and read with OCR when that is on.

#[cfg(feature = "native")]
pub(crate) use native::read;

#[cfg(not(feature = "native"))]
pub(crate) fn read(
    _bytes: &[u8],
    _options: &crate::Options,
    _clock: &crate::Clock,
    _sink: &mut crate::sink::Sink,
) -> Result<bool, crate::Refusal> {
    Err(crate::Refusal::Unsupported)
}

/// PDFium writes `U+0002` where a word is hyphenated at a line end, then the line
/// break. The mark and the break go, and the two halves join; any other `U+0002`
/// goes alone. Line endings become `\n`.
#[cfg_attr(not(feature = "native"), allow(dead_code))]
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{2}' => {
                if chars.peek() == Some(&'\r') {
                    chars.next();
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                } else if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(feature = "native")]
mod native {
    use pdfium_render::prelude::*;

    use super::clean;
    use crate::ocr::Session;
    use crate::pixels::MAX_OCR_PIXELS;
    use crate::{Clock, Options, Refusal, sink::Sink};

    /// The resolution a page is drawn at for OCR.
    const RENDER_DPI: f64 = 200.0;

    /// A page with fewer visible characters than this has too little text to
    /// stand for the page when it also holds a picture.
    const ALMOST_NO_TEXT: usize = 50;

    /// A picture covering at least this share of the page makes it a scan.
    const SCAN_SHARE: f32 = 0.25;

    /// The most page objects looked at to decide whether a page is a picture.
    const OBJECTS_LOOKED_AT: usize = 4096;

    /// Reads `bytes` into `sink`. Returns whether the time budget cut the
    /// reading of a scanned page short.
    pub(crate) fn read(
        bytes: &[u8],
        options: &Options,
        clock: &Clock,
        sink: &mut Sink,
    ) -> Result<bool, Refusal> {
        let bindings = Pdfium::bind_to_statically_linked_library()
            .map_err(|error| Refusal::Malformed(format!("PDFium did not start: {error:?}")))?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(opening)?;
        let mut session = options.ocr.as_ref().map(Session::new);
        let mut cut_short = false;
        let pages = document.pages();
        for index in 0..pages.len() {
            if sink.is_full() {
                break;
            }
            // A page PDFium cannot load is left out; the rest are still read.
            let Ok(page) = pages.get(index) else {
                continue;
            };
            let layer = page
                .text()
                .map(|text| clean(&text.all()))
                .unwrap_or_default();
            let visible = layer.chars().filter(|c| !c.is_whitespace()).count();
            let mut text = layer;
            if visible < ALMOST_NO_TEXT {
                if let Some(session) = session.as_mut() {
                    if looks_scanned(&page, visible) {
                        let (read, short) = ocr_page(&page, session, clock)?;
                        cut_short |= short;
                        if !read.trim().is_empty() {
                            text = read;
                        }
                    }
                }
            }
            sink.push_words(&text, true);
            sink.break_line();
        }
        Ok(cut_short)
    }

    fn opening(error: PdfiumError) -> Refusal {
        match error {
            PdfiumError::PdfiumLibraryInternalError(
                PdfiumInternalError::PasswordError | PdfiumInternalError::SecurityError,
            ) => Refusal::Encrypted,
            error => Refusal::Malformed(format!("cannot open the PDF: {error:?}")),
        }
    }

    /// Whether a page with `visible` text characters is a picture to read: it
    /// holds an image that covers a good part of it, or it holds no text and
    /// something else is drawn (text turned into outlines). A few words over a
    /// blank page are not.
    fn looks_scanned(page: &PdfPage, visible: usize) -> bool {
        let area = page.width().value * page.height().value;
        let mut drawn = false;
        for object in page.objects().iter().take(OBJECTS_LOOKED_AT) {
            drawn = true;
            if object.object_type() == PdfPageObjectType::Image
                && area > 0.0
                && object
                    .bounds()
                    .map(|bounds| bounds.width().value * bounds.height().value / area)
                    .is_ok_and(|share| share >= SCAN_SHARE)
            {
                return true;
            }
        }
        visible == 0 && drawn
    }

    /// Draws the page and reads it. A page too large for the pixel cap is drawn
    /// smaller.
    fn ocr_page(
        page: &PdfPage,
        session: &mut Session,
        clock: &Clock,
    ) -> Result<(String, bool), Refusal> {
        if clock.remaining().is_some_and(|left| left.is_zero()) {
            return Ok((String::new(), true));
        }
        let (width, height) = target_size(page.width().value, page.height().value);
        let config = PdfRenderConfig::new()
            .set_target_size(width, height)
            .set_format(PdfBitmapFormat::Gray)
            .set_clear_color(PdfColor::WHITE);
        let bitmap = page
            .render_with_config(&config)
            .map_err(|error| Refusal::Malformed(format!("cannot draw a page: {error:?}")))?;
        let gray = destride(
            &bitmap.as_raw_bytes(),
            bitmap.width() as usize,
            bitmap.height() as usize,
        )
        .ok_or_else(|| Refusal::Malformed("a drawn page has an unexpected layout".into()))?;
        drop(bitmap);
        let read = session.read(&gray, RENDER_DPI as u32, clock)?;
        Ok((read.text, read.cut_short))
    }

    /// The pixel size of a page of `width` by `height` points drawn at
    /// `RENDER_DPI`, reduced with its proportions to the pixel cap.
    fn target_size(width: f32, height: f32) -> (i32, i32) {
        let scale = RENDER_DPI / 72.0;
        let (mut w, mut h) = (f64::from(width) * scale, f64::from(height) * scale);
        if !(w.is_finite() && h.is_finite()) || w <= 0.0 || h <= 0.0 {
            return (1, 1);
        }
        let pixels = w * h;
        if pixels > MAX_OCR_PIXELS as f64 {
            let shrink = (MAX_OCR_PIXELS as f64 / pixels).sqrt();
            w *= shrink;
            h *= shrink;
        }
        // One side of a very long page may round to nothing; keep one pixel.
        (w.max(1.0) as i32, h.max(1.0) as i32)
    }

    /// The rows of a bitmap whose rows are padded to a multiple of four bytes.
    fn destride(buffer: &[u8], width: usize, height: usize) -> Option<image::GrayImage> {
        if width == 0 || height == 0 || buffer.len() % height != 0 {
            return None;
        }
        let stride = buffer.len() / height;
        if stride < width {
            return None;
        }
        let mut pixels = Vec::with_capacity(width * height);
        for row in buffer.chunks_exact(stride) {
            pixels.extend_from_slice(&row[..width]);
        }
        image::GrayImage::from_raw(width as u32, height as u32, pixels)
    }
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn a_hyphenated_line_end_joins_the_word() {
        assert_eq!(clean("inter\u{2}\r\nnational"), "international");
        assert_eq!(clean("inter\u{2}\nnational"), "international");
    }

    #[test]
    fn line_endings_become_line_feeds() {
        assert_eq!(clean("one\r\ntwo\rthree\nfour"), "one\ntwo\nthree\nfour");
    }

    #[test]
    fn a_stray_mark_goes_without_joining_anything_else() {
        assert_eq!(clean("a\u{2}b"), "ab");
        assert_eq!(clean("a\u{2}"), "a");
    }
}
