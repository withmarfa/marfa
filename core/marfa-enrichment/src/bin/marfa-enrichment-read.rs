//! Reads one file the way the server does, through a process of its own, and prints
//! what it read. It is the proof that a build of this crate works.

use std::path::{Path, PathBuf};

mod common;
use std::process::ExitCode;
use std::time::Duration;

use marfa_enrichment::{OcrOptions, Options, read, serve_child_if_asked};

const USAGE: &str = "usage: marfa-enrichment-read read <file>... [--type <mime>] \
[--languages <a+b>] [--data-dir <folder>] [--no-ocr] [--time-limit <seconds>] \
[--max-memory <bytes>]";

/// Exit code of a file that was refused.
const REFUSED: u8 = 1;
/// Exit code of a command this program cannot follow.
const MISUSED: u8 = 2;

struct Command {
    files: Vec<PathBuf>,
    mime: Option<String>,
    options: Options,
}

fn parse(arguments: impl Iterator<Item = String>) -> Result<Command, String> {
    let mut arguments = arguments;
    if arguments.next().as_deref() != Some("read") {
        return Err("the command is `read`".into());
    }
    let mut files = Vec::new();
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
            path => files.push(PathBuf::from(path)),
        }
    }
    options.ocr = ocr;
    if files.is_empty() {
        return Err("no file named".into());
    }
    Ok(Command {
        files,
        mime,
        options,
    })
}

/// Reads one file and prints what it read. Returns whether the file was read.
fn read_one(file: &Path, mime: Option<&str>, options: &Options) -> Result<bool, u8> {
    let Some(mime) = mime.or_else(|| common::guess_type(file)) else {
        eprintln!("cannot tell the type of {}: use --type", file.display());
        return Err(MISUSED);
    };
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("cannot read {}: {error}", file.display());
            return Err(MISUSED);
        }
    };
    match read(&bytes, mime, options) {
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
            Ok(true)
        }
        Err(refusal) => {
            eprintln!("refused: {refusal}");
            Ok(false)
        }
    }
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
    // Several files are read one after another by this one parent, so a file that
    // kills its reader shows that the parent goes on with the next.
    let several = command.files.len() > 1;
    let mut code = ExitCode::SUCCESS;
    for file in &command.files {
        if several {
            println!("== {}", file.display());
            eprintln!("== {}", file.display());
        }
        match read_one(file, command.mime.as_deref(), &command.options) {
            Ok(true) => {}
            Ok(false) => code = ExitCode::from(REFUSED),
            Err(misused) => return ExitCode::from(misused),
        }
    }
    code
}
