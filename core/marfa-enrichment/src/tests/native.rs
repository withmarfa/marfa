//! OCR and PDF, which need the `native` feature.

use std::io::Cursor;
use std::time::Duration;

use image::codecs::gif::{GifEncoder, Repeat};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, Frame, GrayImage, ImageFormat, Luma, Rgba, RgbaImage};

use super::*;
use crate::OcrOptions;

const PNG: &str = "image/png";
const JPEG: &str = "image/jpeg";
const PDF: &str = "application/pdf";
const SAMPLE: &str = "Marfa OCR fixture quokkapng";
const UPRIGHT: &str = "Marfa reads this sentence upright.";

fn with_ocr() -> Options {
    Options {
        ocr: Some(OcrOptions::default()),
        ..options()
    }
}

fn read_ocr(bytes: &[u8], mime: &str) -> Reading {
    read_here(bytes, mime, &with_ocr()).unwrap_or_else(|refusal| panic!("refused: {refusal}"))
}

fn own(name: &str) -> Vec<u8> {
    own_fixture(name)
}

fn gray_of(name: &str) -> GrayImage {
    image::load_from_memory(&own(name)).unwrap().into_luma8()
}

fn encode(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}

fn jpeg_of(gray: &GrayImage) -> Vec<u8> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(gray)
        .unwrap();
    out
}

/// A PDF of `objects`, numbered from 1, with its cross-reference table.
fn assemble(objects: &[Vec<u8>]) -> Vec<u8> {
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend(body);
        out.extend(b"\nendobj\n");
    }
    let table = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{table}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

fn stream(dictionary: &str, data: &[u8]) -> Vec<u8> {
    let mut out = format!("<< {dictionary} /Length {} >>\nstream\n", data.len()).into_bytes();
    out.extend(data);
    out.extend(b"\nendstream");
    out
}

/// A PDF with one page for each entry of `contents`, all `media` points across and
/// down, with Helvetica as `/F1` and `image` as `/Im1` when given.
fn pdf_of(contents: &[&str], media: (f64, f64), image: Option<(&GrayImage, &[u8])>) -> Vec<u8> {
    let first_page = 5;
    let kids: String = (0..contents.len())
        .map(|n| format!("{} 0 R", first_page + 2 * n))
        .collect::<Vec<_>>()
        .join(" ");
    let mut objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        format!(
            "<< /Type /Pages /Kids [{kids}] /Count {} >>",
            contents.len()
        )
        .into_bytes(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        match image {
            Some((gray, jpeg)) => stream(
                &format!(
                    "/Type /XObject /Subtype /Image /Width {} /Height {} \
                     /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode",
                    gray.width(),
                    gray.height()
                ),
                jpeg,
            ),
            None => b"null".to_vec(),
        },
    ];
    for (n, content) in contents.iter().enumerate() {
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents {} 0 R \
                 /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> >>",
                media.0,
                media.1,
                first_page + 2 * n + 1
            )
            .into_bytes(),
        );
        objects.push(stream("", content.as_bytes()));
    }
    assemble(&objects)
}

fn text_pdf(lines: &[&str]) -> Vec<u8> {
    let content: String = lines
        .iter()
        .enumerate()
        .map(|(n, line)| format!("BT /F1 18 Tf 72 {} Td ({line}) Tj ET\n", 700 - 30 * n))
        .collect();
    pdf_of(&[&content], (612.0, 792.0), None)
}

/// A PDF of `pages` pages, each only the picture of `name` filling the page.
fn scanned_pdf(pages: usize, name: &str) -> Vec<u8> {
    let gray = gray_of(name);
    let jpeg = jpeg_of(&gray);
    let (width, height) = (
        f64::from(gray.width()) / 2.0,
        f64::from(gray.height()) / 2.0,
    );
    let content = format!("q {width} 0 0 {height} 0 0 cm /Im1 Do Q");
    pdf_of(
        &vec![content.as_str(); pages],
        (width, height),
        Some((&gray, &jpeg)),
    )
}

#[test]
fn a_transparent_picture_is_laid_on_white_before_it_is_read() {
    // The fixture's color is black everywhere and its alpha channel holds the
    // letters: dropping alpha leaves a black page.
    let picture = image::load_from_memory(&fixture("sample.png")).unwrap();
    let rgba = picture.to_rgba8();
    assert!(rgba.pixels().all(|pixel| pixel.0[..3] == [0, 0, 0]));
    assert!(rgba.pixels().any(|pixel| pixel.0[3] == 0));
    assert_eq!(read_ocr(&fixture("sample.png"), PNG).text, SAMPLE);
}

#[test]
fn several_languages_load_from_the_program_with_no_data_folder() {
    let text = read_ocr(&own("languages.png"), PNG).text;
    for word in ["Straße", "größer", "Käsebrot", "café", "comió", "mañana"] {
        assert!(text.contains(word), "{word} missing from {text:?}");
    }
    // The witness: with English alone the same picture does not read.
    let mut english = with_ocr();
    english.ocr.as_mut().unwrap().languages = "eng".into();
    let text = read_here(&own("languages.png"), PNG, &english)
        .unwrap()
        .text;
    assert!(!text.contains("Straße"), "{text:?}");
}

#[test]
fn a_language_with_no_model_is_a_refusal_naming_it() {
    let mut options = with_ocr();
    options.ocr.as_mut().unwrap().languages = "eng+tlh".into();
    let Refusal::OcrUnavailable(reason) = refusal(&fixture("sample.png"), PNG, &options) else {
        panic!("expected OcrUnavailable");
    };
    assert!(reason.contains("tlh"), "{reason}");
}

#[test]
fn a_model_in_the_data_folder_adds_a_language_and_takes_precedence() {
    let folder = tempfile::tempdir().unwrap();
    let mut options = with_ocr();
    {
        let ocr = options.ocr.as_mut().unwrap();
        ocr.data_dir = Some(folder.path().to_owned());
        // The Chinese model in place of English: the same picture reads differently.
        let chinese = crate::ocr::carried("chi_sim").unwrap();
        std::fs::write(folder.path().join("eng.traineddata"), chinese).unwrap();
        std::fs::write(
            folder.path().join("klingon.traineddata"),
            crate::ocr::carried("deu").unwrap(),
        )
        .unwrap();
        ocr.languages = "eng".into();
    }
    let owners = read_here(&fixture("sample.png"), PNG, &options).unwrap();
    assert_ne!(owners.text, SAMPLE);
    options.ocr.as_mut().unwrap().languages = "klingon".into();
    let added = read_here(&own("languages.png"), PNG, &options).unwrap();
    assert!(added.text.contains("Straße"), "{:?}", added.text);
}

#[test]
fn a_corrupt_model_in_the_data_folder_is_a_refusal_naming_the_file() {
    let folder = tempfile::tempdir().unwrap();
    std::fs::write(folder.path().join("eng.traineddata"), b"not a model").unwrap();
    let mut options = with_ocr();
    let ocr = options.ocr.as_mut().unwrap();
    ocr.data_dir = Some(folder.path().to_owned());
    ocr.languages = "eng".into();
    let Refusal::OcrUnavailable(reason) = refusal(&fixture("sample.png"), PNG, &options) else {
        panic!("expected OcrUnavailable");
    };
    assert!(reason.contains("eng"), "{reason}");
}

#[test]
fn a_missing_data_folder_leaves_the_program_models_in_use() {
    let mut options = with_ocr();
    options.ocr.as_mut().unwrap().data_dir = Some("/no/such/folder".into());
    assert_eq!(
        read_here(&fixture("sample.png"), PNG, &options)
            .unwrap()
            .text,
        SAMPLE
    );
}

#[test]
fn a_picture_that_is_no_picture_is_refused_with_ocr_on_and_gives_nothing_with_it_off() {
    let mut truncated = encode(
        &DynamicImage::ImageLuma8(gray_of("languages.png")),
        ImageFormat::Png,
    );
    truncated.truncate(truncated.len() / 2);
    assert!(matches!(
        refusal(&truncated, PNG, &with_ocr()),
        Refusal::Malformed(_)
    ));
    let off = read_here(&truncated, PNG, &options()).unwrap();
    assert!(off.text.is_empty());
}

/// A PNG whose header says `width` by `height` and whose data is not there.
fn header_of(width: u32, height: u32) -> Vec<u8> {
    let mut png = encode(
        &DynamicImage::ImageLuma8(GrayImage::new(1, 1)),
        ImageFormat::Png,
    );
    png[16..20].copy_from_slice(&width.to_be_bytes());
    png[20..24].copy_from_slice(&height.to_be_bytes());
    let mut crc = 0xffff_ffffu32;
    for byte in &png[12..29] {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                0xedb8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    png[29..33].copy_from_slice(&(!crc).to_be_bytes());
    png
}

#[test]
fn a_header_claiming_a_billion_pixels_is_over_the_limit_without_being_decoded() {
    let bomb = header_of(100_000, 100_000);
    assert!(matches!(
        refusal(&bomb, PNG, &with_ocr()),
        Refusal::OverLimit(_)
    ));
}

#[test]
fn a_one_pixel_picture_reads_as_no_text() {
    let one = encode(
        &DynamicImage::ImageLuma8(GrayImage::from_pixel(1, 1, Luma([255]))),
        ImageFormat::Png,
    );
    let reading = read_ocr(&one, PNG);
    assert_eq!(reading.text, "");
    assert_eq!(
        reading.dimensions.map(|d| (d.width, d.height)),
        Some((1, 1))
    );
}

#[test]
fn a_sixteen_bit_gray_picture_a_gray_jpeg_and_a_cmyk_jpeg_are_read() {
    let gray = gray_of("sentence.png");
    let sixteen =
        image::ImageBuffer::<Luma<u16>, _>::from_fn(gray.width(), gray.height(), |x, y| {
            Luma([u16::from(gray.get_pixel(x, y).0[0]) * 257])
        });
    let sixteen = encode(&DynamicImage::ImageLuma16(sixteen), ImageFormat::Png);
    assert_eq!(read_ocr(&sixteen, PNG).text, UPRIGHT);
    assert_eq!(read_ocr(&jpeg_of(&gray), JPEG).text, UPRIGHT);
    let cmyk = read_ocr(&own("cmyk.jpg"), JPEG);
    assert_eq!(cmyk.text, UPRIGHT);
}

#[test]
fn the_exif_orientation_of_a_photo_is_applied() {
    assert_eq!(read_ocr(&own("rotated.jpg"), JPEG).text, UPRIGHT);
}

#[test]
fn an_animated_gif_reads_its_first_frame() {
    let first = gray_of("sentence.png");
    let rgba = |gray: &GrayImage| {
        RgbaImage::from_fn(gray.width(), gray.height(), |x, y| {
            let v = gray.get_pixel(x, y).0[0];
            Rgba([v, v, v, 255])
        })
    };
    let mut out = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut out);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        encoder.encode_frame(Frame::new(rgba(&first))).unwrap();
        encoder
            .encode_frame(Frame::new(RgbaImage::from_pixel(
                first.width(),
                first.height(),
                Rgba([255, 255, 255, 255]),
            )))
            .unwrap();
    }
    assert_eq!(read_ocr(&out, "image/gif").text, UPRIGHT);
}

#[test]
fn a_multi_page_tiff_reads_its_first_page() {
    assert_eq!(read_ocr(&own("pages.tiff"), "image/tiff").text, UPRIGHT);
}

#[test]
fn a_text_pdf_is_read_without_ocr() {
    let pdf = text_pdf(&["First line of text", "Second line"]);
    assert_eq!(text(&pdf, PDF), "First line of text\nSecond line");
}

#[test]
fn a_hyphen_mark_at_a_line_end_joins_the_word() {
    let pdf = text_pdf(&["An inter-", "national word"]);
    let read = text(&pdf, PDF);
    assert!(!read.contains('\u{2}'));
    assert!(read.contains("international"), "{read:?}");
}

#[test]
fn a_scanned_pdf_is_read_with_ocr_and_left_unread_without() {
    let pdf = scanned_pdf(1, "sentence.png");
    assert_eq!(read_ocr(&pdf, PDF).text, UPRIGHT);
    assert_eq!(text(&pdf, PDF), "");
}

#[test]
fn a_few_words_on_an_otherwise_blank_page_are_not_read_as_a_picture() {
    let pdf = text_pdf(&["Page 3"]);
    let witness = read_ocr(&pdf, PDF);
    assert_eq!(witness.text, "Page 3");
    assert!(!witness.cut_short);
}

#[test]
fn a_few_words_over_a_picture_are_read_as_a_picture() {
    let gray = gray_of("sentence.png");
    let jpeg = jpeg_of(&gray);
    let (width, height) = (
        f64::from(gray.width()) / 2.0,
        f64::from(gray.height()) / 2.0,
    );
    let content =
        format!("q {width} 0 0 {height} 0 0 cm /Im1 Do Q BT /F1 12 Tf 10 10 Td (Page 3) Tj ET");
    let pdf = pdf_of(&[&content], (width, height), Some((&gray, &jpeg)));
    assert!(read_ocr(&pdf, PDF).text.starts_with(UPRIGHT));
    assert_eq!(text(&pdf, PDF), "Page 3");
}

#[test]
fn a_password_protected_pdf_is_encrypted_and_a_damaged_one_is_malformed() {
    assert!(matches!(
        refusal(&own("encrypted.pdf"), PDF, &options()),
        Refusal::Encrypted
    ));
    assert!(matches!(
        refusal(b"%PDF-1.4\nnothing else", PDF, &options()),
        Refusal::Malformed(_)
    ));
}

#[test]
fn the_time_budget_stops_the_reading_of_a_long_scan_and_says_so() {
    let pdf = scanned_pdf(40, "sentence.png");
    let full = read_ocr(&pdf, PDF);
    assert!(!full.cut_short);
    assert_eq!(full.text.matches("upright").count(), 40);
    let mut hurried = with_ocr();
    hurried.time_budget = Some(Duration::from_millis(100));
    let cut = read_here(&pdf, PDF, &hurried).unwrap();
    assert!(cut.cut_short);
    assert!(cut.text.matches("upright").count() < 40);
}

#[test]
fn the_time_budget_also_stops_a_single_picture() {
    let mut hurried = with_ocr();
    hurried.time_budget = Some(Duration::from_millis(1));
    let cut = read_here(&own("languages.png"), PNG, &hurried).unwrap();
    assert!(cut.cut_short);
    assert!(cut.text.len() < read_ocr(&own("languages.png"), PNG).text.len());
}

#[test]
fn a_page_as_large_as_a_pdf_allows_is_drawn_within_the_pixel_cap() {
    let gray = gray_of("sentence.png");
    let jpeg = jpeg_of(&gray);
    let tall = 14_400.0 * f64::from(gray.height()) / f64::from(gray.width());
    let content = format!("q 14400 0 0 {tall} 0 0 cm /Im1 Do Q");
    let pdf = pdf_of(&[&content], (14_400.0, tall), Some((&gray, &jpeg)));
    let read = read_ocr(&pdf, PDF).text;
    assert!(read.contains("sentence upright"), "{read:?}");
    let absurd = pdf_of(&[&content], (1e9, 1e9), Some((&gray, &jpeg)));
    assert!(read_here(&absurd, PDF, &with_ocr()).is_ok());
}

#[test]
fn thousands_of_pages_are_read_until_the_text_limit() {
    let pages = vec!["BT /F1 12 Tf 72 700 Td (word) Tj ET"; 4000];
    let pdf = pdf_of(&pages, (612.0, 792.0), None);
    let mut small = with_ocr();
    small.max_text_chars = 50;
    let reading = read_here(&pdf, PDF, &small).unwrap();
    assert!(reading.truncated);
    let blank = pdf_of(&vec![""; 4000], (612.0, 792.0), None);
    assert_eq!(read_ocr(&blank, PDF).text, "");
}

/// Reads the file named by `MARFA_MEASURE_FILE` and prints what came out. Run it
/// under `/usr/bin/time -l` to see the peak memory of one reading.
#[test]
#[ignore = "a measurement, not a check"]
fn measure() {
    let path = std::env::var("MARFA_MEASURE_FILE").expect("MARFA_MEASURE_FILE");
    let mime = match path.rsplit('.').next().unwrap_or("") {
        "pdf" => PDF,
        "png" => PNG,
        "jpg" | "jpeg" => JPEG,
        "tif" | "tiff" => "image/tiff",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        other => panic!("no type for .{other}"),
    };
    let mut measured = options();
    measured.max_text_chars = 10_000_000;
    if std::env::var_os("MARFA_MEASURE_OCR_OFF").is_none() {
        measured.ocr = Some(OcrOptions {
            languages: std::env::var("MARFA_MEASURE_LANGS")
                .unwrap_or_else(|_| crate::DEFAULT_OCR_LANGUAGES.into()),
            data_dir: None,
        });
    }
    measured.time_budget = std::env::var("MARFA_MEASURE_BUDGET_MS")
        .ok()
        .map(|ms| Duration::from_millis(ms.parse().unwrap()));
    let bytes = std::fs::read(&path).unwrap();
    let started = std::time::Instant::now();
    let result = read_here(&bytes, mime, &measured);
    let took = started.elapsed();
    match result {
        Ok(reading) => println!(
            "MEASURE took={took:?} chars={} cut_short={} truncated={} dims={:?}\n---\n{}\n---",
            reading.text.chars().count(),
            reading.cut_short,
            reading.truncated,
            reading.dimensions,
            reading.text
        ),
        Err(refusal) => println!("MEASURE took={took:?} refused: {refusal}"),
    }
}
