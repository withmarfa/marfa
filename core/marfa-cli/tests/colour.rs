//! Color is drawn for a person at a terminal and for no one else: a stream
//! that is piped, a `NO_COLOR` that is set, a `TERM` of `dumb` and `--json`
//! each leave standard output and standard error free of the escape byte. A
//! terminal is a pseudo-terminal, since a test run has none of its own, and
//! the first case shows that the escape byte is drawn there at all.

#[allow(dead_code)]
#[path = "support/terminal.rs"]
mod terminal;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::process::Command;

use terminal::Ran;

const ESCAPE: u8 = 0x1b;

/// A way to ask for no color: its name, the environment, the leading
/// arguments, and whether the streams are terminals.
type Quiet<'a> = (&'a str, Vec<(&'a str, &'a str)>, Vec<&'a str>, bool);

fn marfa(args: &[&str], env: &[(&str, &str)]) -> Command {
    let nowhere =
        std::env::temp_dir().join(format!("marfa-colour-no-keychain-{}", std::process::id()));
    let mut command = quiet::marfa();
    command
        .env_remove("NO_COLOR")
        .env_remove("MARFA_API_URL")
        .env_remove("MARFA_API_KEY")
        .env_remove("MARFA_DB")
        .env("MARFA_KEYCHAIN", nowhere)
        .env("TERM", "xterm-256color")
        .args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    command
}

/// A refusal that every platform gives: no install is in the folder.
fn refusal(extra: &[&str], env: &[(&str, &str)]) -> Command {
    let nothing =
        std::env::temp_dir().join(format!("marfa-colour-no-install-{}", std::process::id()));
    let mut args: Vec<&str> = extra.to_vec();
    args.extend(["server", "status", "--dir"]);
    let nothing = nothing.to_str().unwrap().to_string();
    let mut command = marfa(&args, env);
    command.arg(nothing);
    command
}

fn has_escape(bytes: &[u8]) -> bool {
    bytes.contains(&ESCAPE)
}

#[test]
fn a_refusal_is_colored_on_a_terminal_and_the_witness_for_every_case_below() {
    let ran = terminal::run(&mut refusal(&[], &[]), false, true);
    assert_eq!(ran.code, 2, "{}", Ran::text(&ran.stderr));
    let said = Ran::text(&ran.stderr);
    assert!(said.contains("\u{1b}[1;31mmarfa:\u{1b}[0m"), "{said:?}");
    // Colored words are still the words.
    assert!(said.contains("no install"), "{said:?}");
}

#[test]
fn nothing_is_drawn_when_the_stream_is_piped_or_the_person_asked_for_none() {
    let cases: Vec<(&str, Command, bool)> = vec![
        ("stderr piped", refusal(&[], &[]), false),
        ("NO_COLOR", refusal(&[], &[("NO_COLOR", "1")]), true),
        ("TERM=dumb", refusal(&[], &[("TERM", "dumb")]), true),
        ("--json", refusal(&["--json"], &[]), true),
    ];
    for (name, mut command, stderr_tty) in cases {
        let ran = terminal::run(&mut command, false, stderr_tty);
        assert_eq!(ran.code, 2, "{name}");
        assert!(
            !has_escape(&ran.stderr),
            "{name}: {:?}",
            Ran::text(&ran.stderr)
        );
        assert!(!has_escape(&ran.stdout), "{name}");
    }
    // An empty NO_COLOR is no NO_COLOR: the witness for the case above.
    let ran = terminal::run(&mut refusal(&[], &[("NO_COLOR", "")]), false, true);
    assert!(has_escape(&ran.stderr));
}

#[test]
fn each_stream_is_judged_alone() {
    // Standard output on a terminal and standard error piped: the refusal
    // is on standard error and stays plain.
    let ran = terminal::run(&mut refusal(&[], &[]), true, false);
    assert!(!has_escape(&ran.stderr), "{:?}", Ran::text(&ran.stderr));
    assert!(!has_escape(&ran.stdout));
}

#[test]
fn help_and_usage_errors_draw_nothing_unless_a_terminal_wants_them() {
    // The witness: clap draws help on a terminal that wants it.
    let ran = terminal::run(&mut marfa(&["--help"], &[]), true, true);
    assert!(has_escape(&ran.stdout), "{:?}", Ran::text(&ran.stdout));
    let commands: Vec<(&str, Vec<&str>)> = vec![
        ("help", vec!["--help"]),
        ("a command's help", vec!["server", "install", "--help"]),
        ("a usage error", vec!["--no-such-option"]),
        ("a missing command", vec!["server", "status", "--port"]),
    ];
    for (name, args) in &commands {
        let quiet: Vec<Quiet> = vec![
            ("piped", vec![], vec![], false),
            ("NO_COLOR", vec![("NO_COLOR", "1")], vec![], true),
            ("TERM=dumb", vec![("TERM", "dumb")], vec![], true),
            ("--json", vec![], vec!["--json"], true),
        ];
        for (how, env, front, tty) in quiet {
            let mut all: Vec<&str> = front;
            all.extend(args.iter().copied());
            let ran = terminal::run(&mut marfa(&all, &env), tty, tty);
            assert!(
                !has_escape(&ran.stdout) && !has_escape(&ran.stderr),
                "{name}, {how}: {:?} {:?}",
                Ran::text(&ran.stdout),
                Ran::text(&ran.stderr)
            );
        }
    }
}

#[test]
fn piped_output_of_the_commands_people_read_has_no_escape_byte() {
    for args in [
        vec!["--help"],
        vec!["server", "--help"],
        vec!["docs", "--help"],
    ] {
        let ran = terminal::run(&mut marfa(&args, &[]), false, false);
        assert_eq!(ran.code, 0, "{args:?}");
        assert!(!ran.stdout.is_empty(), "{args:?}");
        assert!(
            !has_escape(&ran.stdout) && !has_escape(&ran.stderr),
            "{args:?}"
        );
    }
}
