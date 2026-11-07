//! Reads one file the way the server does, through a process of its own, and prints
//! what it read. It is the proof that a build of this crate works.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use marfa_enrichment::{OcrOptions, Options, read, serve_child_if_asked};

const USAGE: &str = "usage: marfa-enrichment-read read <file> [--type <mime>] \
[--languages <a+b>] [--data-dir <folder>] [--no-ocr] [--time-limit <seconds>] \
[--max-memory <bytes>]";

/// Exit code of a file that was refused.
const REFUSED: u8 = 1;
/// Exit code of a command this program cannot follow.
const MISUSED: u8 = 2;

struct Command {
    file: PathBuf,
    mime: Option<String>,
    options: Options,
}

fn parse(arguments: impl Iterator<Item = String>) -> Result<Command, String> {
    let mut arguments = arguments;
    if arguments.next().as_deref() != Some("read") {
        return Err("the command is `read`".into());
    }
    let mut file = None;
    let mut mime = None;
    let mut ocr = Some(OcrOptions::default());
    let mut options = Options::default();
    while let Some(argument) = arguments.next() {
        let mut value = || {
            arguments
                .next()
                .ok_or_else(|| format!("{argument} needs a value"))
        };
        match argument.as_str() {
            "--type" => mime = Some(value()?),
            "--languages" => {
                let languages = value()?;
                if let Some(ocr) = ocr.as_mut() {
                    ocr.languages = languages;
                }
            }
            "--data-dir" => {
                let folder = value()?;
                if let Some(ocr) = ocr.as_mut() {
                    ocr.data_dir = Some(folder.into());
                }
            }
            "--no-ocr" => ocr = None,
            "--time-limit" => {
                let seconds: f64 = value()?
                    .parse()
                    .map_err(|error| format!("--time-limit: {error}"))?;
                options.time_limit = Duration::try_from_secs_f64(seconds)
                    .map_err(|error| format!("--time-limit: {error}"))?;
            }
            "--max-memory" => {
                options.max_memory_bytes = value()?
                    .parse()
                    .map_err(|error| format!("--max-memory: {error}"))?;
            }
            flag if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            path if file.is_none() => file = Some(PathBuf::from(path)),
            other => return Err(format!("unexpected {other}")),
        }
    }
    options.ocr = ocr;
    Ok(Command {
        file: file.ok_or("no file named")?,
        mime,
        options,
    })
}

/// The type a file's extension stands for.
fn guess_type(file: &Path) -> Option<&'static str> {
    let extension = file.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xhtml" => "application/xhtml+xml",
        "json" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsb" => "application/vnd.ms-excel.sheet.binary.macroenabled.12",
        "xls" => "application/vnd.ms-excel",
        "odt" => "application/vnd.oasis.opendocument.text",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "epub" => "application/epub+zip",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "avif" => "image/avif",
        _ => return None,
    })
}

fn main() -> ExitCode {
    serve_child_if_asked();

    let command = match parse(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(problem) => {
            eprintln!("{problem}\n{USAGE}");
            return ExitCode::from(MISUSED);
        }
    };
    let Some(mime) = command
        .mime
        .as_deref()
        .or_else(|| guess_type(&command.file))
    else {
        eprintln!(
            "cannot tell the type of {}: use --type",
            command.file.display()
        );
        return ExitCode::from(MISUSED);
    };
    let bytes = match std::fs::read(&command.file) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("cannot read {}: {error}", command.file.display());
            return ExitCode::from(MISUSED);
        }
    };
    match read(&bytes, mime, &command.options) {
        Ok(reading) => {
            println!("{}", reading.text);
            if let Some(size) = reading.dimensions {
                eprintln!("size: {} x {}", size.width, size.height);
            }
            if reading.truncated {
                eprintln!("truncated: the file holds more text");
            }
            if reading.cut_short {
                eprintln!("cut short: the time budget ran out");
            }
            eprintln!("sandbox: {:?}", reading.sandbox);
            ExitCode::SUCCESS
        }
        Err(refusal) => {
            eprintln!("refused: {refusal}");
            ExitCode::from(REFUSED)
        }
    }
}
