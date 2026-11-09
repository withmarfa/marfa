//! A reader that cannot confine itself must not parse the file. The fault asks every
//! child to report that nothing holds it, and the file asks a child that reads it to
//! write a file.

use std::fs::File;
use std::io::Write;

use libtest_mimic::{Arguments, Failed, Trial};
use marfa_enrichment::{Options, Refusal, Sandbox, read, serve_child_if_asked};

const UNCONFINED: &str = "MARFA_FAULT_UNCONFINED";

fn file_of(bytes: &[u8]) -> File {
    let mut named = tempfile::NamedTempFile::new().expect("a temporary file");
    named.write_all(bytes).expect("a write to it");
    File::open(named.path()).expect("the file, open for reading")
}

fn writes(path: &std::path::Path) -> Vec<u8> {
    format!(
        "MARFA-ENRICHMENT-FAULT:write-file {}\nwords",
        path.display()
    )
    .into_bytes()
}

fn a_file_is_not_parsed_by_a_reader_that_is_not_confined() -> Result<(), Failed> {
    let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
    let target = folder.path().join("written");
    let options = Options::default();

    // SAFETY: this program is single-threaded here, and the only test.
    unsafe { std::env::set_var(UNCONFINED, "1") };
    let outcome = read(&file_of(&writes(&target)), "text/plain", &options);
    // SAFETY: as above.
    unsafe { std::env::remove_var(UNCONFINED) };
    if !matches!(outcome, Err(Refusal::ReaderUnavailable(_))) {
        return Err(format!("an unconfined reader answered {outcome:?}").into());
    }
    if target.exists() {
        return Err("the unconfined reader parsed the file and wrote".into());
    }

    // The witness: the same file, confined, is read.
    let reading = read(&file_of(&writes(&target)), "text/plain", &options)
        .map_err(|refusal| refusal.to_string())?;
    if reading.sandbox != Sandbox::Full {
        return Err(format!("the witness read under {:?}", reading.sandbox).into());
    }
    if !reading.text.starts_with("refused") && !reading.text.contains("Err") {
        return Err(format!("the witness was not read as a fault: {:?}", reading.text).into());
    }
    Ok(())
}

fn main() {
    serve_child_if_asked();
    let trial = Trial::test(
        "a_file_is_not_parsed_by_a_reader_that_is_not_confined",
        a_file_is_not_parsed_by_a_reader_that_is_not_confined,
    );
    libtest_mimic::run(&Arguments::from_args(), vec![trial]).exit();
}
