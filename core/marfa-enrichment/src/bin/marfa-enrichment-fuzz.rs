//! Reads mutated copies of real files through the real reader, to find a file that
//! crashes, hangs or exhausts memory in PDFium, Tesseract, `calamine` or anything
//! else. The parent must survive every one, and each file that harms a reader is
//! kept so the fault can be reproduced. A file stopped at the memory limit is kept
//! and listed but fails no run: the limit held.
//!
//! A mutation is chosen from the seed's name and these numbers alone, so a run with
//! the same seed folder, `--seed` and `--runs` repeats exactly (a run bounded by
//! `--seconds` repeats up to where it stopped).

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use marfa_enrichment::{Limit, OcrOptions, Options, Reading, Refusal, serve_child_if_asked};

mod common;

const USAGE: &str = "usage: marfa-enrichment-fuzz <seeds> <findings> [--seconds <n> | --runs <n>] \
[--seed <n>] [--jobs <n>] [--time-limit <seconds>] [--max-memory <bytes>] [--max-seed-bytes <n>]";

struct Settings {
    seeds: PathBuf,
    findings: PathBuf,
    seconds: Option<u64>,
    runs: Option<u64>,
    seed: u64,
    jobs: usize,
    time_limit: Duration,
    max_memory: u64,
    max_seed_bytes: u64,
}

fn parse(arguments: impl Iterator<Item = String>) -> Result<Settings, String> {
    let mut arguments = arguments;
    let mut paths = Vec::new();
    let mut settings = Settings {
        seeds: PathBuf::new(),
        findings: PathBuf::new(),
        seconds: None,
        runs: None,
        seed: 1,
        jobs: 2,
        time_limit: Duration::from_secs(20),
        max_memory: Options::default().max_memory_bytes,
        max_seed_bytes: 400_000,
    };
    while let Some(argument) = arguments.next() {
        let mut number = |name: &str| -> Result<u64, String> {
            arguments
                .next()
                .ok_or_else(|| format!("{name} needs a value"))?
                .parse::<u64>()
                .map_err(|error| format!("{name}: {error}"))
        };
        match argument.as_str() {
            "--seconds" => settings.seconds = Some(number("--seconds")?),
            "--runs" => settings.runs = Some(number("--runs")?),
            "--seed" => settings.seed = number("--seed")?,
            "--jobs" => settings.jobs = usize::try_from(number("--jobs")?).unwrap_or(1).max(1),
            "--time-limit" => settings.time_limit = Duration::from_secs(number("--time-limit")?),
            "--max-memory" => settings.max_memory = number("--max-memory")?,
            "--max-seed-bytes" => settings.max_seed_bytes = number("--max-seed-bytes")?,
            flag if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            path => paths.push(PathBuf::from(path)),
        }
    }
    let [seeds, findings] = <[PathBuf; 2]>::try_from(paths).map_err(|_| "two folders needed")?;
    settings.seeds = seeds;
    settings.findings = findings;
    if settings.seconds.is_none() && settings.runs.is_none() {
        return Err("--seconds or --runs needed".into());
    }
    Ok(settings)
}

/// A small, fast generator whose sequence depends on its seed only.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // SplitMix64's constant spreads a small seed over all the bits.
        let mut rng = Self(seed.wrapping_add(0x9E37_79B9_7F4A_7C15));
        rng.next();
        rng
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            0
        } else {
            usize::try_from(self.next() % bound as u64).unwrap_or(0)
        }
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

const INTERESTING: [u8; 8] = [0x00, 0x01, 0x7f, 0x80, 0xff, b'0', b'-', b'<'];

/// A position, biased toward the start of the file, where headers, sizes and
/// directories sit.
fn position(rng: &mut Rng, length: usize) -> usize {
    if length == 0 {
        0
    } else if rng.chance(50) {
        rng.below(length.min(160))
    } else {
        rng.below(length)
    }
}

/// Reads `bytes` as a file that exists only for the reading: the reader is given a
/// file, and the name is gone before it starts.
fn read_bytes(bytes: &[u8], mime: &str, options: &Options) -> Result<Reading, Refusal> {
    static NEXT: AtomicU64 = AtomicU64::new(0);

    let unavailable = |error: std::io::Error| Refusal::ReaderUnavailable(error.to_string());
    let path = std::env::temp_dir().join(format!(
        "marfa-enrichment-fuzz-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&path, bytes).map_err(unavailable)?;
    let file = std::fs::File::open(&path);
    let _ = std::fs::remove_file(&path);
    marfa_enrichment::read(&file.map_err(unavailable)?, mime, options)
}

/// One to eight stacked changes to the bytes.
fn mutate_bytes(rng: &mut Rng, bytes: &mut Vec<u8>, other: &[u8]) {
    for _ in 0..=rng.below(8) {
        let length = bytes.len();
        match rng.below(10) {
            0 | 1 => {
                if length > 0 {
                    let at = position(rng, length);
                    bytes[at] ^= 1 << rng.below(8);
                }
            }
            2 | 3 => {
                if length > 0 {
                    let at = position(rng, length);
                    bytes[at] = INTERESTING[rng.below(INTERESTING.len())];
                }
            }
            4 => {
                // A run of one byte, as an overlong count or a flood of padding.
                let at = position(rng, length);
                let run = 1 + rng.below(64);
                let byte = INTERESTING[rng.below(INTERESTING.len())];
                let end = (at + run).min(length);
                bytes[at..end].fill(byte);
            }
            5 => {
                // Delete a range.
                if length > 1 {
                    let at = position(rng, length);
                    let end = (at + 1 + rng.below(256)).min(length);
                    bytes.drain(at..end);
                }
            }
            6 => {
                // Repeat a range, which grows a table or a stream.
                if length > 1 {
                    let at = position(rng, length);
                    let end = (at + 1 + rng.below(256)).min(length);
                    let piece = bytes[at..end].to_vec();
                    for _ in 0..=rng.below(4) {
                        bytes.splice(at..at, piece.iter().copied());
                    }
                }
            }
            7 => {
                // Truncate.
                if length > 1 {
                    bytes.truncate(1 + rng.below(length - 1));
                }
            }
            8 => {
                // Splice in a piece of another seed.
                if !other.is_empty() {
                    let from = rng.below(other.len());
                    let to = (from + 1 + rng.below(512)).min(other.len());
                    let at = position(rng, bytes.len());
                    bytes.splice(at..at.min(bytes.len()), other[from..to].iter().copied());
                }
            }
            _ => {
                // A number made huge or negative: the byte becomes a digit run.
                if length > 8 {
                    let at = position(rng, length - 8);
                    let digits: &[u8] =
                        [&b"99999999"[..], b"-1", b"4294967295", b"2147483648"][rng.below(4)];
                    let end = (at + digits.len()).min(length);
                    bytes[at..end].copy_from_slice(&digits[..end - at]);
                }
            }
        }
    }
}

/// A zip seed is mutated inside: one part is changed and the package is written
/// again, so the damage reaches the XML and the spreadsheet parsers, not only the
/// deflate decoder. Returns `None` when the bytes are not a zip.
fn mutate_zip(rng: &mut Rng, bytes: &[u8], other: &[u8]) -> Option<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut parts = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).ok()?;
        if file.is_dir() {
            continue;
        }
        let mut data = Vec::new();
        file.by_ref().take(8 << 20).read_to_end(&mut data).ok()?;
        parts.push((file.name().ok()?.into_owned(), data));
    }
    if parts.is_empty() {
        return None;
    }
    let victim = rng.below(parts.len());
    mutate_bytes(rng, &mut parts[victim].1, other);
    if rng.chance(10) {
        parts.remove(rng.below(parts.len()));
    }
    let mut out = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in &parts {
            writer.start_file(name.as_str(), options).ok()?;
            writer.write_all(data).ok()?;
        }
        writer.finish().ok()?;
    }
    Some(out.into_inner())
}

struct Seed {
    name: String,
    mime: &'static str,
    bytes: Vec<u8>,
}

fn load_seeds(folder: &Path, max_bytes: u64) -> Result<Vec<Seed>, String> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(folder)
        .map_err(|error| format!("cannot read {}: {error}", folder.display()))?
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| path.is_file())
        .collect();
    paths.sort();
    let mut seeds = Vec::new();
    for path in paths {
        let Some(mime) = common::guess_type(&path) else {
            continue;
        };
        let bytes = std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        if bytes.len() as u64 > max_bytes {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        seeds.push(Seed { name, mime, bytes });
    }
    if seeds.is_empty() {
        return Err(format!("{} holds no seed file", folder.display()));
    }
    Ok(seeds)
}

#[derive(Default)]
struct Tally {
    runs: u64,
    outcomes: BTreeMap<String, u64>,
    findings: Vec<String>,
    slowest: Duration,
    slowest_seed: String,
}

fn kind_of(result: &Result<marfa_enrichment::Reading, Refusal>) -> &'static str {
    let refusal = match result {
        Ok(reading) => match &reading.text_refused {
            Some(refusal) => refusal,
            None => return "read",
        },
        Err(refusal) => refusal,
    };
    match refusal {
        Refusal::Unsupported => "unsupported",
        Refusal::Encrypted => "encrypted",
        Refusal::Malformed(_) => "malformed",
        Refusal::OverLimit(Limit::Memory, _) => "MEMORY",
        Refusal::OverLimit(..) => "over-limit",
        Refusal::OcrUnavailable(_) => "ocr-unavailable",
        Refusal::TimedOut => "HANG",
        Refusal::Crashed(_) => "CRASH",
        Refusal::ReaderUnavailable(_) => "READER-UNAVAILABLE",
    }
}

fn main() -> ExitCode {
    serve_child_if_asked();

    let settings = match parse(std::env::args().skip(1)) {
        Ok(settings) => settings,
        Err(problem) => {
            eprintln!("{problem}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let seeds = match load_seeds(&settings.seeds, settings.max_seed_bytes) {
        Ok(seeds) => Arc::new(seeds),
        Err(problem) => {
            eprintln!("{problem}");
            return ExitCode::from(2);
        }
    };
    if let Err(error) = std::fs::create_dir_all(&settings.findings) {
        eprintln!("cannot make {}: {error}", settings.findings.display());
        return ExitCode::from(2);
    }

    let options = Arc::new(Options {
        ocr: Some(OcrOptions::default()),
        time_limit: settings.time_limit,
        max_memory_bytes: settings.max_memory,
        ..Options::default()
    });

    // Each seed is read once unchanged first. One that does not read would turn
    // every finding into noise.
    for seed in seeds.iter() {
        let result = read_bytes(&seed.bytes, seed.mime, &options);
        if let Err(refusal) = &result
            && !matches!(refusal, Refusal::Encrypted | Refusal::Unsupported)
        {
            eprintln!("seed {} does not read unchanged: {refusal}", seed.name);
        }
    }

    let started = Instant::now();
    let deadline = settings
        .seconds
        .map(|seconds| started + Duration::from_secs(seconds));
    let counter = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let tally = Arc::new(Mutex::new(Tally::default()));
    let settings = Arc::new(settings);

    let handles: Vec<_> = (0..settings.jobs)
        .map(|job| {
            let (seeds, options, counter, stop, tally, settings) = (
                Arc::clone(&seeds),
                Arc::clone(&options),
                Arc::clone(&counter),
                Arc::clone(&stop),
                Arc::clone(&tally),
                Arc::clone(&settings),
            );
            std::thread::spawn(move || {
                loop {
                    if stop.load(Ordering::Relaxed) || deadline.is_some_and(|d| Instant::now() >= d)
                    {
                        break;
                    }
                    let iteration = counter.fetch_add(1, Ordering::Relaxed);
                    if settings.runs.is_some_and(|runs| iteration >= runs) {
                        break;
                    }
                    let mut rng =
                        Rng::new(settings.seed ^ iteration.wrapping_mul(0x1000_0000_01B3));
                    let seed = &seeds[rng.below(seeds.len())];
                    let other = &seeds[rng.below(seeds.len())].bytes;
                    let mutated = if rng.chance(70)
                        && let Some(inside) = mutate_zip(&mut rng, &seed.bytes, other)
                    {
                        inside
                    } else {
                        let mut bytes = seed.bytes.clone();
                        mutate_bytes(&mut rng, &mut bytes, other);
                        bytes
                    };
                    let began = Instant::now();
                    let result = read_bytes(&mutated, seed.mime, &options);
                    let took = began.elapsed();
                    let kind = kind_of(&result);
                    let harmful = kind.chars().all(|c| c.is_ascii_uppercase() || c == '-');
                    if harmful {
                        let extension = Path::new(&seed.name)
                            .extension()
                            .map_or(String::new(), |e| e.to_string_lossy().into_owned());
                        let name = format!(
                            "{}-seed{}-run{iteration}-{}.{extension}",
                            kind.to_ascii_lowercase(),
                            settings.seed,
                            seed.name.trim_end_matches(&format!(".{extension}")),
                        );
                        let why = match &result {
                            Err(refusal) => refusal.to_string(),
                            Ok(_) => String::new(),
                        };
                        let saved = std::fs::write(settings.findings.join(&name), &mutated)
                            .and_then(|()| {
                                std::fs::write(
                                    settings.findings.join(format!("{name}.txt")),
                                    format!(
                                        "{kind} after {took:?}\nseed file {}\ntype {}\n{why}\n",
                                        seed.name, seed.mime
                                    ),
                                )
                            });
                        tally
                            .lock()
                            .unwrap()
                            .findings
                            .push(format!("{name} ({kind}, {took:?}) {why} {saved:?}"));
                        // The parent must still read an ordinary file afterwards.
                        if let Err(refusal) = read_bytes(&seed.bytes, seed.mime, &options)
                            && !matches!(refusal, Refusal::Encrypted)
                        {
                            tally.lock().unwrap().findings.push(format!(
                                "AFTER {name}: the unchanged seed {} no longer reads: {refusal}",
                                seed.name
                            ));
                        }
                        if kind == "READER-UNAVAILABLE" {
                            stop.store(true, Ordering::Relaxed);
                        }
                    }
                    let mut tally = tally.lock().unwrap();
                    tally.runs += 1;
                    *tally.outcomes.entry(kind.to_owned()).or_default() += 1;
                    if took > tally.slowest {
                        tally.slowest = took;
                        tally.slowest_seed = format!("{} run {iteration}", seed.name);
                    }
                    if job == 0 && tally.runs % 500 == 0 {
                        eprintln!(
                            "{} runs in {:?}; findings {}",
                            tally.runs,
                            started.elapsed(),
                            tally.findings.len()
                        );
                    }
                }
            })
        })
        .collect();
    for handle in handles {
        let _ = handle.join();
    }

    let tally = tally.lock().unwrap();
    println!(
        "runs {} in {:?} with {} job(s), seed {}, {} seed file(s)",
        tally.runs,
        started.elapsed(),
        settings.jobs,
        settings.seed,
        seeds.len()
    );
    for (kind, count) in &tally.outcomes {
        println!("  {kind}: {count}");
    }
    println!("slowest read {:?} ({})", tally.slowest, tally.slowest_seed);
    println!("findings: {}", tally.findings.len());
    for finding in &tally.findings {
        println!("  {finding}");
    }
    if tally
        .findings
        .iter()
        .all(|finding| finding.starts_with("memory-"))
    {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
