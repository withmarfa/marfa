//! A reader that cannot confine itself must not parse the file. The fault asks every
//! child to report that nothing holds it, and the file asks a child that reads it to
//! write a file.

use std::fs::File;
use std::io::Write;
use std::process::{Command, Stdio};

use libtest_mimic::{Arguments, Failed, Trial};
use marfa_enrichment::{Options, Refusal, read, serve_child_if_asked};

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
    if !reading.text.starts_with("refused") && !reading.text.contains("Err") {
        return Err(format!("the witness was not read as a fault: {:?}", reading.text).into());
    }
    Ok(())
}

/// The child on its own, started as a parent starts it: the gate is the child's, so the
/// parent's refusal above cannot vouch for it.
fn a_child_that_is_not_confined_ends_after_its_first_line() -> Result<(), Failed> {
    let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
    let target = folder.path().join("written");
    let bytes = writes(&target);
    let request = format!(
        "{{\"mime\":\"text/plain\",\"len\":{},\"max_text_chars\":1000,\
         \"max_inflated_bytes\":1000000,\"time_budget_ms\":1000,\"ocr\":null}}",
        bytes.len()
    );
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    let run = |weakened: bool| -> Result<(Option<i32>, String), Failed> {
        let mut command = Command::new(&program);
        command
            .args(["--marfa-enrichment-child", "60000", "1073741824", &request])
            .stdin(Stdio::from(file_of(&bytes)))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .current_dir("/");
        if weakened {
            command.env(UNCONFINED, "1");
        }
        let output = command.output().map_err(|error| error.to_string())?;
        Ok((
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
        ))
    };

    let (code, said) = run(true)?;
    if code != Some(75) {
        return Err(format!("an unconfined child ended with {code:?}").into());
    }
    if said != "{\"sandbox\":\"off\"}\n" {
        return Err(format!("an unconfined child said more than its first line: {said:?}").into());
    }

    // The witness: the same start, confined, goes on to answer after its first line.
    let (code, said) = run(false)?;
    if code != Some(0) || said.lines().count() != 2 || !said.starts_with("{\"sandbox\":\"full\"}\n")
    {
        return Err(format!("the witness child ended with {code:?}: {said:?}").into());
    }
    Ok(())
}

fn main() {
    serve_child_if_asked();
    let trials = vec![
        Trial::test(
            "a_file_is_not_parsed_by_a_reader_that_is_not_confined",
            a_file_is_not_parsed_by_a_reader_that_is_not_confined,
        ),
        Trial::test(
            "a_child_that_is_not_confined_ends_after_its_first_line",
            a_child_that_is_not_confined_ends_after_its_first_line,
        ),
    ];
    libtest_mimic::run(&Arguments::from_args(), trials).exit();
}
