//! Pictures made ready for OCR: decoded within a memory limit, turned upright,
//! laid on white and reduced to gray.

use std::io::Cursor;

use image::imageops::{self, FilterType};
use image::metadata::Orientation;
use image::{DynamicImage, GrayImage, ImageDecoder, ImageFormat, ImageReader, Limits};

use crate::Refusal;

/// The most pixels OCR reads in one picture. A larger one is scaled down to it.
///
/// A page at 300 dpi is 8.7 million pixels, and the text on it is as readable at
/// 300 dpi as at 600, so this is a little above one page at 360 dpi. Memory grows
/// with the pixels, not with the file, so a cap keeps it bounded.
pub(crate) const MAX_OCR_PIXELS: u64 = 12_000_000;

/// The resolution OCR is told the picture has. Tesseract reads it to judge the
/// size of the text, and 300 is what it is trained for.
pub(crate) const OCR_DPI: u32 = 300;

/// Decodes `bytes` for OCR. A picture that would take more than `max_bytes` once
/// decoded is `OverLimit` without being decoded; one that cannot be decoded is
/// `Malformed`.
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
    let needed = decoder.total_bytes();
    if needed > max_bytes {
        return Err(Refusal::OverLimit(format!(
            "the image needs {needed} bytes decoded, and the limit is {max_bytes}"
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
