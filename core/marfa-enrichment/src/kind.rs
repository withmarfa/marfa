//! Which reader takes a file, by its MIME type.

/// The family of a spreadsheet, which decides how `calamine` opens it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sheet {
    Xlsx,
    Xlsb,
    Xls,
    Ods,
}

/// A document in a zip package, read part by part.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Document {
    Docx,
    Pptx,
    Odt,
    Odp,
    Epub,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Text,
    Html {
        xhtml: bool,
    },
    Document(Document),
    Sheet(Sheet),
    /// Any `image/*` type: the bytes, not the label, say which image it is. `ocr`
    /// is whether OCR reads this type, which it does for the types `image` decodes.
    Image {
        ocr: bool,
    },
    Pdf,
    /// A sound or a video, read for its length and picture size and for no text.
    /// `matroska` is whether the file is WebM or Matroska, which this crate reads
    /// itself; every other container goes to Symphonia.
    Media {
        matroska: bool,
    },
}

impl Kind {
    /// Whether the reader holds the whole file in memory. A media reader reads
    /// headers and steps over the rest.
    pub(crate) fn loads_whole_file(self) -> bool {
        !matches!(self, Self::Media { .. })
    }

    pub(crate) fn of(mime: &str) -> Option<Self> {
        let bare = mime
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        Some(match bare.as_str() {
            "text/html" => Self::Html { xhtml: false },
            "application/xhtml+xml" => Self::Html { xhtml: true },
            // Markup that is not the content: RTF's control words would be
            // searched as if they were words.
            "text/rtf" | "text/richtext" | "text/enriched" => return None,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.wordprocessingml.template"
            | "application/vnd.ms-word.document.macroenabled.12"
            | "application/vnd.ms-word.template.macroenabled.12" => Self::Document(Document::Docx),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            | "application/vnd.openxmlformats-officedocument.presentationml.slideshow"
            | "application/vnd.openxmlformats-officedocument.presentationml.template"
            | "application/vnd.ms-powerpoint.presentation.macroenabled.12"
            | "application/vnd.ms-powerpoint.slideshow.macroenabled.12"
            | "application/vnd.ms-powerpoint.template.macroenabled.12" => {
                Self::Document(Document::Pptx)
            }
            "application/vnd.oasis.opendocument.text"
            | "application/vnd.oasis.opendocument.text-template" => Self::Document(Document::Odt),
            "application/vnd.oasis.opendocument.presentation"
            | "application/vnd.oasis.opendocument.presentation-template" => {
                Self::Document(Document::Odp)
            }
            "application/epub+zip" => Self::Document(Document::Epub),
            "application/pdf" => Self::Pdf,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.template"
            | "application/vnd.ms-excel.sheet.macroenabled.12"
            | "application/vnd.ms-excel.template.macroenabled.12" => Self::Sheet(Sheet::Xlsx),
            "application/vnd.ms-excel.sheet.binary.macroenabled.12" => Self::Sheet(Sheet::Xlsb),
            "application/vnd.ms-excel" => Self::Sheet(Sheet::Xls),
            "application/vnd.oasis.opendocument.spreadsheet"
            | "application/vnd.oasis.opendocument.spreadsheet-template" => Self::Sheet(Sheet::Ods),
            "audio/mpeg" | "audio/mp3" | "audio/wav" | "audio/x-wav" | "audio/wave"
            | "audio/vnd.wave" | "audio/flac" | "audio/x-flac" | "audio/ogg" | "audio/opus"
            | "audio/vorbis" | "application/ogg" | "video/ogg" | "audio/mp4" | "audio/x-m4a"
            | "audio/m4a" | "audio/x-m4b" | "audio/3gpp" | "audio/3gpp2" | "video/mp4"
            | "video/x-m4v" | "video/quicktime" | "video/3gpp" | "video/3gpp2" => {
                Self::Media { matroska: false }
            }
            "video/webm" | "audio/webm" | "video/x-matroska" | "audio/x-matroska"
            | "video/matroska" | "audio/matroska" => Self::Media { matroska: true },
            "image/png" | "image/jpeg" | "image/webp" | "image/bmp" | "image/tiff"
            | "image/gif" => Self::Image { ocr: true },
            _ if bare.starts_with("image/") => Self::Image { ocr: false },
            // Anything else that is text to read: a person searches a source
            // file, a log or a data file by the words in it.
            "application/json"
            | "application/xml"
            | "application/yaml"
            | "application/x-yaml"
            | "application/toml"
            | "application/x-ndjson" => Self::Text,
            _ if bare.starts_with("text/") || bare.ends_with("+json") || bare.ends_with("+xml") => {
                Self::Text
            }
            _ => return None,
        })
    }
}
