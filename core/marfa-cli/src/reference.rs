//! The CLI reference committed as `COMMANDS.md`, rendered from the clap
//! command tree so it cannot drift from the binary.

use std::fmt::Write as _;

use clap::{Command, CommandFactory};

use crate::Cli;

const WIDTH: usize = 100;
const REGENERATE: &str = "MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference";

/// The reference as the file holds it: every visible command's long help in
/// the order `marfa --help` lists them, at a fixed width and without color.
pub fn render() -> String {
    let mut root = fixed(Cli::command());
    root.build();

    let mut out = String::new();
    writeln!(
        out,
        "<!-- Generated from the command tree by `{REGENERATE}`. Do not edit by hand. -->"
    )
    .unwrap();
    out.push('\n');
    out.push_str("# marfa CLI reference\n\n");
    out.push_str("Global options, which every command accepts, and the exit codes:\n\n");
    // Hiding the commands leaves the options and exit codes the root's long help carries.
    let globals = root
        .clone()
        .mut_subcommands(|command| command.hide(true))
        .override_usage("marfa [OPTIONS] <COMMAND>");
    block(&mut out, &globals);

    for command in visible(&root) {
        write!(out, "\n## {}\n", command.get_name()).unwrap();
        let path = format!("{} {}", root.get_name(), command.get_name());
        section(&mut out, command, &path);
    }
    out
}

fn section(out: &mut String, command: &Command, path: &str) {
    write!(out, "\n### {path}\n\n").unwrap();
    block(out, command);
    for child in visible(command) {
        section(out, child, &format!("{path} {}", child.get_name()));
    }
}

fn block(out: &mut String, command: &Command) {
    let help = command.clone().render_long_help().to_string();
    assert!(
        !help.contains("```"),
        "`{}` help holds a code fence, which would end its block",
        command.get_name()
    );
    out.push_str("```text\n");
    for line in help.trim_end().lines() {
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out.push_str("```\n");
}

/// Commands as `--help` lists them: no hidden ones, and not the generated `help`.
fn visible(command: &Command) -> impl Iterator<Item = &Command> {
    command
        .get_subcommands()
        .filter(|sub| !sub.is_hide_set() && sub.get_name() != "help")
}

/// Without a set width, `wrap_help` wraps to the terminal that ran the test.
fn fixed(command: Command) -> Command {
    command.term_width(WIDTH).mut_subcommands(fixed)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn committed() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("COMMANDS.md")
    }

    #[test]
    fn the_command_reference_is_current() {
        let rendered = render();
        assert_eq!(rendered, render(), "the reference is not deterministic");
        if std::env::var_os("MARFA_WRITE_COMMANDS").is_some() {
            std::fs::write(committed(), &rendered).expect("write COMMANDS.md");
            return;
        }
        let held = std::fs::read_to_string(committed()).unwrap_or_default();
        assert!(
            held == rendered,
            "core/marfa-cli/COMMANDS.md is out of date. Regenerate it with `{REGENERATE}` and commit it."
        );
    }
}
