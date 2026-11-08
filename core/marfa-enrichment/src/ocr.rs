//! Tesseract, through the C++ shim in `native/`.

use std::ffi::{CStr, CString, c_char, c_int};
use std::path::Path;
use std::ptr::NonNull;

use image::GrayImage;

use crate::{Clock, OcrOptions, Refusal};

mod models {
    include!(concat!(env!("OUT_DIR"), "/models.rs"));
}

#[repr(C)]
struct Model {
    language: *const c_char,
    data: *const u8,
    len: usize,
}

#[repr(C)]
struct Raw {
    _private: [u8; 0],
}

const STATUS_MODEL_MISSING: c_int = 1;
const STATUS_MODEL_UNLOADABLE: c_int = 2;
const MESSAGE_LEN: usize = 512;

unsafe extern "C" {
    fn marfa_ocr_open(
        languages: *const c_char,
        data_dir: *const c_char,
        models: *const Model,
        model_count: usize,
        status: *mut c_int,
        message: *mut c_char,
        message_len: usize,
    ) -> *mut Raw;
    fn marfa_ocr_close(ocr: *mut Raw);
    fn marfa_ocr_read(
        ocr: *mut Raw,
        pixels: *const u8,
        width: c_int,
        height: c_int,
        dpi: c_int,
        deadline_ms: c_int,
        text: *mut *mut c_char,
        cut_short: *mut c_int,
        message: *mut c_char,
        message_len: usize,
    ) -> c_int;
    fn marfa_text_free(text: *mut c_char);
}

/// Why the engine could not start or read.
#[derive(Debug)]
pub(crate) enum Error {
    /// A language with no model, or a model that does not load. The reason is for
    /// the person who sets OCR up.
    Setup(String),
    /// The engine failed on one image.
    Failed(String),
}

/// What reading one image gave.
pub(crate) struct Recognized {
    pub(crate) text: String,
    /// The deadline passed before every line was read.
    pub(crate) cut_short: bool,
}

/// An engine with its models loaded, which reads one image at a time.
pub(crate) struct Engine {
    raw: NonNull<Raw>,
}

fn message_of(buffer: &[u8]) -> String {
    CStr::from_bytes_until_nul(buffer)
        .map(|text| text.to_string_lossy().into_owned())
        .unwrap_or_default()
}

impl Engine {
    /// Loads `languages` (names joined by `+`). A model in `data_dir`, if the folder
    /// holds one, is used in place of the program's own; a language neither has is
    /// a setup error. Nothing is written to disk.
    pub(crate) fn open(languages: &str, data_dir: Option<&Path>) -> Result<Self, Error> {
        let languages = CString::new(languages)
            .map_err(|_| Error::Setup("the OCR languages hold a NUL".into()))?;
        let data_dir = data_dir
            .map(|dir| CString::new(dir.as_os_str().as_encoded_bytes()))
            .transpose()
            .map_err(|_| Error::Setup("the OCR data folder holds a NUL".into()))?;
        let names: Vec<CString> = models::MODELS
            .iter()
            .map(|(language, _)| CString::new(*language).expect("a language name has no NUL"))
            .collect();
        let carried: Vec<Model> = models::MODELS
            .iter()
            .zip(&names)
            .map(|((_, data), name)| Model {
                language: name.as_ptr(),
                data: data.as_ptr(),
                len: data.len(),
            })
            .collect();
        let mut status: c_int = 0;
        let mut message = [0u8; MESSAGE_LEN];
        // SAFETY: every pointer is valid for the call; `carried` and `names` outlive
        // it, and the shim copies what it keeps.
        let raw = unsafe {
            marfa_ocr_open(
                languages.as_ptr(),
                data_dir
                    .as_ref()
                    .map_or(std::ptr::null(), |dir| dir.as_ptr()),
                carried.as_ptr(),
                carried.len(),
                &mut status,
                message.as_mut_ptr().cast(),
                message.len(),
            )
        };
        match NonNull::new(raw) {
            Some(raw) => Ok(Self { raw }),
            None if status == STATUS_MODEL_MISSING || status == STATUS_MODEL_UNLOADABLE => {
                Err(Error::Setup(message_of(&message)))
            }
            None => Err(Error::Failed(message_of(&message))),
        }
    }

    /// Reads an image drawn at `dpi`. A `deadline_ms` above zero cuts the reading
    /// short after that long and returns the lines read by then.
    pub(crate) fn read(
        &mut self,
        image: &GrayImage,
        dpi: u32,
        deadline_ms: u32,
    ) -> Result<Recognized, Error> {
        let width = c_int::try_from(image.width()).map_err(|_| Error::Failed("too wide".into()))?;
        let height =
            c_int::try_from(image.height()).map_err(|_| Error::Failed("too tall".into()))?;
        let mut text: *mut c_char = std::ptr::null_mut();
        let mut cut_short: c_int = 0;
        let mut message = [0u8; MESSAGE_LEN];
        // SAFETY: the image's buffer holds `width * height` bytes in rows of `width`,
        // which is what the shim reads; `raw` is open until `drop`.
        let status = unsafe {
            marfa_ocr_read(
                self.raw.as_ptr(),
                image.as_raw().as_ptr(),
                width,
                height,
                c_int::try_from(dpi).unwrap_or(300),
                c_int::try_from(deadline_ms).unwrap_or(c_int::MAX),
                &mut text,
                &mut cut_short,
                message.as_mut_ptr().cast(),
                message.len(),
            )
        };
        if status != 0 {
            return Err(Error::Failed(message_of(&message)));
        }
        let read = if text.is_null() {
            String::new()
        } else {
            // SAFETY: a non-null `text` is a NUL-terminated string the shim made.
            let read = unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned();
            // SAFETY: `text` came from the shim and is freed once.
            unsafe { marfa_text_free(text) };
            read
        };
        Ok(Recognized {
            text: read,
            cut_short: cut_short != 0,
        })
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: `raw` came from `marfa_ocr_open` and is closed once.
        unsafe { marfa_ocr_close(self.raw.as_ptr()) };
    }
}

/// The model the program carries for `language`.
#[cfg(test)]
pub(crate) fn carried(language: &str) -> Option<&'static [u8]> {
    models::MODELS
        .iter()
        .find(|(name, _)| *name == language)
        .map(|(_, data)| *data)
}

/// The OCR of one reading: the engine starts when the first picture needs it, so
/// a file with nothing to read never loads a model, and stays for the rest.
pub(crate) struct Session<'a> {
    options: &'a OcrOptions,
    engine: Option<Engine>,
}

impl<'a> Session<'a> {
    pub(crate) fn new(options: &'a OcrOptions) -> Self {
        Self {
            options,
            engine: None,
        }
    }

    /// Reads one picture within what is left of the time budget. With none left
    /// it reads nothing and says it was cut short.
    pub(crate) fn read(
        &mut self,
        image: &GrayImage,
        dpi: u32,
        clock: &Clock,
    ) -> Result<Recognized, Refusal> {
        let deadline_ms = match clock.remaining() {
            None => 0,
            Some(left) if left.is_zero() => {
                return Ok(Recognized {
                    text: String::new(),
                    cut_short: true,
                });
            }
            Some(left) => u32::try_from(left.as_millis()).unwrap_or(u32::MAX).max(1),
        };
        if self.engine.is_none() {
            let engine = Engine::open(&self.options.languages, self.options.data_dir.as_deref())
                .map_err(|error| match error {
                    Error::Setup(reason) => Refusal::OcrUnavailable(reason),
                    Error::Failed(reason) => Refusal::OcrUnavailable(reason),
                })?;
            self.engine = Some(engine);
        }
        let engine = self.engine.as_mut().expect("the engine was just opened");
        engine
            .read(image, dpi, deadline_ms)
            .map_err(|error| match error {
                Error::Setup(reason) | Error::Failed(reason) => {
                    Refusal::Malformed(format!("OCR failed on the picture: {reason}"))
                }
            })
    }
}
