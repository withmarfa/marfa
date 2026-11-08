//! Pictures made ready for OCR: decoded within a memory limit, turned upright,
//! laid on white and reduced to gray.

use std::io::Cursor;

use image::imageops::{self, FilterType};
use image::metadata::Orientation;
use image::{DynamicImage, GrayImage, ImageDecoder, ImageFormat, ImageReader, Limits};

use crate::Refusal;

/// The most pixels OCR reads in one picture. A larger one is scaled down to it.
///
/// A letter page at 300 dpi is 8.4 million pixels and at 360 dpi 12 million. On a
/// 300 dpi scan reduced to 6 million, 26 lines of an 80-line page read differently;
/// at 12 million, and at no cap, the text was identical to the original. A larger cap
/// read nothing better and cost time and memory: a 2x upscaled scan took 645 MB
/// at 24 million against 482 MB at 12 million.
pub(crate) const MAX_OCR_PIXELS: u64 = 12_000_000;

/// The resolution OCR is told the picture has. Tesseract reads it to judge the
/// size of the text, and 300 is what it is trained for.
pub(crate) const OCR_DPI: u32 = 300;

/// What scaling a picture down holds for each pixel it has read: `imageops::resize`
/// works through a buffer of four 32-bit floats a pixel, as wide as the picture and as
/// tall as the result.
const SCALING_BYTES_PER_PIXEL: f64 = 16.0;

/// What a picture may take to decode and scale, out of the memory a reading has. The
/// file itself stays held, and the rest of the limit is left to the allocator and the
/// program.
pub(crate) fn budget(max_memory: u64, file_bytes: usize) -> u64 {
    max_memory.saturating_sub(file_bytes as u64) / 4 * 3
}

/// What a picture costs on its way to OCR: the decoded picture, its gray and alpha
/// copy, and the buffer that scales it. The sum, and not the largest step, because
/// macOS keeps a freed block of this size resident: a 48 million pixel RGB photo
/// reached 611 MB there, where the largest step holds 432 MB.
fn peak_bytes(decoded: u64, pixels: u64) -> u64 {
    let scaling = if pixels > MAX_OCR_PIXELS {
        let rows_kept = (MAX_OCR_PIXELS as f64 * pixels as f64).sqrt();
        (SCALING_BYTES_PER_PIXEL * rows_kept) as u64
    } else {
        0
    };
    decoded
        .saturating_add(pixels.saturating_mul(2))
        .saturating_add(scaling)
}

/// Decodes `bytes` for OCR. A picture that would take more than `max_bytes` on the way
/// is `OverLimit` without being decoded; one that cannot be decoded is `Malformed`.
pub(crate) fn decode(bytes: &[u8], max_bytes: u64) -> Result<GrayImage, Refusal> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| Refusal::Malformed(format!("cannot read the image: {error}")))?;
    match reader.format() {
        Some(
            ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::WebP
            | ImageFormat::Bmp
            | ImageFormat::Tiff
            | ImageFormat::Gif,
        ) => {}
        _ => {
            return Err(Refusal::Malformed(
                "the bytes are not an image this reads".into(),
            ));
        }
    }
    let mut decoder = reader.into_decoder().map_err(refusal)?;
    // A decoder may ignore `max_alloc`, so the size its header implies is checked
    // here, before anything is allocated.
    let (width, height) = decoder.dimensions();
    let needed = peak_bytes(decoder.total_bytes(), u64::from(width) * u64::from(height));
    if needed > max_bytes {
        return Err(Refusal::OverLimit(format!(
            "the image needs {needed} bytes to decode and scale, and the limit is {max_bytes}"
        )));
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(max_bytes);
    decoder.set_limits(limits).map_err(refusal)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let decoded = DynamicImage::from_decoder(decoder).map_err(refusal)?;

    let mut gray = flatten(decoded);
    if u64::from(gray.width()) * u64::from(gray.height()) > MAX_OCR_PIXELS {
        gray = scale_down(&gray);
    }
    let mut upright = DynamicImage::ImageLuma8(gray);
    upright.apply_orientation(orientation);
    Ok(upright.into_luma8())
}

fn refusal(error: image::ImageError) -> Refusal {
    match error {
        image::ImageError::Limits(error) => Refusal::OverLimit(error.to_string()),
        error => Refusal::Malformed(format!("cannot decode the image: {error}")),
    }
}

/// Gray, with any transparency laid on white. Dropping the alpha channel instead
/// leaves what a transparent picture holds under its see-through pixels, which
/// is often black: black text on black reads as nothing.
fn flatten(image: DynamicImage) -> GrayImage {
    if !image.color().has_alpha() {
        return image.into_luma8();
    }
    let with_alpha = image.into_luma_alpha8();
    let (width, height) = with_alpha.dimensions();
    let mut gray = GrayImage::new(width, height);
    for (out, pixel) in gray.pixels_mut().zip(with_alpha.pixels()) {
        let [luma, alpha] = pixel.0;
        let (luma, alpha) = (u32::from(luma), u32::from(alpha));
        out.0[0] = ((luma * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
    }
    gray
}

/// The picture reduced, with its proportions, to at most `MAX_OCR_PIXELS`.
pub(crate) fn scale_down(gray: &GrayImage) -> GrayImage {
    let pixels = f64::from(gray.width()) * f64::from(gray.height());
    let factor = (MAX_OCR_PIXELS as f64 / pixels).sqrt();
    let width = ((f64::from(gray.width()) * factor) as u32).max(1);
    let height = ((f64::from(gray.height()) * factor) as u32).max(1);
    // Averaging keeps thin strokes, which dropping pixels would lose.
    imageops::resize(gray, width, height, FilterType::Triangle)
}
