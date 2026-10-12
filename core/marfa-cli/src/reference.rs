//! The command reference committed as `COMMANDS.md`, written as Markdown from
//! the clap command tree so it cannot drift from the binary.
//!
//! The docs site renders the file as MDX, where a bare `<` or `{` starts
//! markup, so every placeholder, default and value sits in a code span.

use std::fmt::Write as _;

use clap::{Arg, ArgAction, Command, CommandFactory};

use crate::Cli;
use crate::error::{
    DRAIN_EXITS, Exit, JSON_REFUSAL, JSON_REFUSAL_CODES, JSON_REFUSAL_SHAPE, codes, exit_codes_help,
};

const REGENERATE: &str = "MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference";

/// The reference as the file holds it: what the root says of itself, its
/// options and exit codes, then every visible command in the order
/// `marfa --help` lists them, depth first.
pub fn render() -> String {
    let mut root = Cli::command();
    root.build();
    // The exit codes below are set out from the parts this text is made of.
    assert_eq!(
        root.get_after_long_help()
            .map(ToString::to_string)
            .as_deref(),
        Some(exit_codes_help()),
        "the root's after-help is not the exit codes the reference sets out"
    );

    let mut out = String::new();
    writeln!(
        out,
        "<!-- Generated from the command tree by `{REGENERATE}`. Do not edit by hand. -->\n"
    )
    .unwrap();
    out.push_str("# Command reference\n\n");
    write_blocks(&mut out, &description(&root));

    let globals: Vec<&Arg> = shown(&root).filter(|arg| arg.is_global_set()).collect();
    out.push_str("## Global options\n\nEvery command accepts these.\n\n");
    table(&mut out, "Option", &globals);
    out.push_str("## Exit codes\n\n");
    exit_codes(&mut out);

    let inherited: Vec<Inherited> = globals
        .iter()
        .map(|arg| Inherited::new(arg, None))
        .collect();
    for area in visible(&root) {
        writeln!(out, "## {}\n", area.get_name()).unwrap();
        let summary = blocks(&text(area.get_about()));
        write_blocks(&mut out, &summary);
        let path = format!("{} {}", root.get_name(), area.get_name());
        section(&mut out, area, &path, &summary, &inherited);
    }
    out.truncate(out.trim_end().len());
    out.push('\n');
    out
}

/// One command: what it does, beyond what `said` already told the reader, its
/// usage, its arguments and options, and its notes, then its subcommands.
fn section(out: &mut String, command: &Command, path: &str, said: &[Block], above: &[Inherited]) {
    writeln!(out, "### {path}\n").unwrap();
    let description = description(command);
    write_blocks(out, description.strip_prefix(said).unwrap_or(&description));
    usage(out, command);

    let (from_above, own): (Vec<&Arg>, Vec<&Arg>) =
        shown(command).partition(|arg| above.iter().any(|item| item.id == arg.get_id().as_str()));
    let positionals: Vec<&Arg> = own
        .iter()
        .copied()
        .filter(|arg| arg.is_positional())
        .collect();
    if !positionals.is_empty() {
        table(out, "Argument", &positionals);
    }
    let (shared, local): (Vec<&Arg>, Vec<&Arg>) = own
        .into_iter()
        .filter(|arg| !arg.is_positional())
        .partition(|arg| arg.is_global_set());
    let groups = headings(&local);
    for (heading, args) in &groups {
        if groups.len() > 1 {
            writeln!(out, "**{heading}**\n").unwrap();
        }
        table(out, "Option", args);
    }
    if !shared.is_empty() {
        writeln!(out, "Every `{path}` command accepts these.\n").unwrap();
        table(out, "Option", &shared);
    }

    let mut owners: Vec<(&str, Vec<String>)> = Vec::new();
    for arg in &from_above {
        let Some(owner) = above
            .iter()
            .find(|item| item.id == arg.get_id().as_str())
            .and_then(|item| item.owner.as_deref())
        else {
            continue;
        };
        let flag = format!("`{}`", name(arg));
        match owners.iter_mut().find(|(seen, _)| *seen == owner) {
            Some((_, flags)) => flags.push(flag),
            None => owners.push((owner, vec![flag])),
        }
    }
    for (owner, flags) in owners {
        writeln!(
            out,
            "Also accepts the options of `{owner}`: {}.\n",
            series(&flags)
        )
        .unwrap();
    }

    let after = command
        .get_after_long_help()
        .or_else(|| command.get_after_help());
    write_blocks(out, &blocks(&text(after)));

    let mut below: Vec<Inherited> = above.to_vec();
    below.extend(shared.iter().map(|arg| Inherited::new(arg, Some(path))));
    for child in visible(command) {
        section(
            out,
            child,
            &format!("{path} {}", child.get_name()),
            &[],
            &below,
        );
    }
}

/// An option a command takes from an ancestor, and the command that lists it,
/// or none for the root's, which `## Global options` lists.
#[derive(Clone)]
struct Inherited {
    id: String,
    owner: Option<String>,
}

impl Inherited {
    fn new(arg: &Arg, owner: Option<&str>) -> Self {
        Self {
            id: arg.get_id().as_str().to_owned(),
            owner: owner.map(str::to_owned),
        }
    }
}

fn exit_codes(out: &mut String) {
    out.push_str("| Code | Meaning |\n| --- | --- |\n");
    for exit in Exit::ALL {
        let meaning = sentence(&capitalized(exit.meaning()));
        writeln!(out, "| {} | {} |", exit as u8, cell(&meaning)).unwrap();
    }
    out.push('\n');
    write_blocks(
        out,
        &[
            Block::Text(sentence(DRAIN_EXITS)),
            Block::Text(JSON_REFUSAL.to_owned()),
            Block::Verbatim(JSON_REFUSAL_SHAPE.to_owned()),
        ],
    );
    let codes: Vec<String> = codes().iter().map(|code| format!("`{code}`")).collect();
    writeln!(out, "{JSON_REFUSAL_CODES} {}.\n", codes.join(", ")).unwrap();
}

/// Clap's usage for the command, one line to each form, without its title.
fn usage(out: &mut String, command: &Command) {
    let usage = command.clone().render_usage().to_string();
    let usage = usage
        .strip_prefix("Usage: ")
        .expect("clap titles its usage");
    out.push_str("```text\n");
    for line in usage.lines() {
        writeln!(out, "{}", line.trim()).unwrap();
    }
    out.push_str("```\n\n");
}

fn table(out: &mut String, label: &str, args: &[&Arg]) {
    writeln!(out, "| {label} | Description |\n| --- | --- |").unwrap();
    for arg in args {
        writeln!(
            out,
            "| `{}` | {} |",
            cell(&name(arg)),
            cell(&explained(arg))
        )
        .unwrap();
    }
    out.push('\n');
}

/// The argument as `--help` names it: `<ID>`, `--name <NAME>`, `-n, --name <NAME>`.
fn name(arg: &Arg) -> String {
    match (arg.get_short(), arg.get_long()) {
        (Some(short), Some(_)) => format!("-{short}, {arg}"),
        _ => arg.to_string(),
    }
}

/// The argument's help, then the values, default and variable `--help` shows with it.
fn explained(arg: &Arg) -> String {
    let help = text(arg.get_long_help().or_else(|| arg.get_help()));
    let mut parts: Vec<String> = blocks(&help)
        .into_iter()
        .map(|block| match block {
            Block::Text(text) => text,
            Block::Verbatim(_) => panic!(
                "`{}` help holds an indented block, which a table cell cannot hold",
                arg.get_id()
            ),
        })
        .collect();
    if !arg.is_hide_possible_values_set() {
        let values: Vec<String> = arg
            .get_possible_values()
            .iter()
            .filter(|value| !value.is_hide_set())
            .map(|value| format!("`{}`", value.get_name()))
            .collect();
        if !values.is_empty() {
            parts.push(format!("One of {}.", values.join(", ")));
        }
    }
    if arg.get_action().takes_values()
        && !arg.is_hide_default_value_set()
        && !arg.get_default_values().is_empty()
    {
        let defaults: Vec<String> = arg
            .get_default_values()
            .iter()
            .map(|value| format!("`{}`", value.to_string_lossy()))
            .collect();
        parts.push(format!("Default: {}.", defaults.join(", ")));
    }
    // Never the variable's value: that is whatever the machine that ran the test held.
    if let Some(env) = arg.get_env().filter(|_| !arg.is_hide_env_set()) {
        parts.push(format!(
            "Environment variable: `{}`.",
            env.to_string_lossy()
        ));
    }
    parts.join(" ")
}

/// The options under each help heading, unheaded ones first, as `--help` groups them.
fn headings<'a>(args: &[&'a Arg]) -> Vec<(&'a str, Vec<&'a Arg>)> {
    let mut groups: Vec<(&str, Vec<&Arg>)> = Vec::new();
    for arg in args {
        let heading = arg.get_help_heading().unwrap_or("Options");
        match groups.iter_mut().find(|(seen, _)| *seen == heading) {
            Some((_, group)) => group.push(arg),
            None => groups.push((heading, vec![arg])),
        }
    }
    if let Some(unheaded) = groups.iter().position(|(heading, _)| *heading == "Options") {
        let group = groups.remove(unheaded);
        groups.insert(0, group);
    }
    groups
}

/// The arguments the long help shows, in its order, without `--help` and `--version`.
fn shown(command: &Command) -> impl Iterator<Item = &Arg> {
    let mut args: Vec<&Arg> = command
        .get_arguments()
        .filter(|arg| !arg.is_hide_set() && !arg.is_hide_long_help_set())
        .filter(|arg| {
            !matches!(
                arg.get_action(),
                ArgAction::Help | ArgAction::HelpShort | ArgAction::HelpLong | ArgAction::Version
            )
        })
        .collect();
    args.sort_by_key(|arg| order(arg));
    args.into_iter()
}

/// Clap's own help order: positionals by index, then options by display order,
/// each short before its capital and before the long-only ones.
fn order(arg: &Arg) -> (bool, usize, String) {
    if arg.is_positional() {
        return (false, arg.get_index().unwrap_or(0), String::new());
    }
    let key = match (arg.get_short(), arg.get_long()) {
        (Some(short), _) => {
            let case = if short.is_ascii_lowercase() { '0' } else { '1' };
            format!("{}{case}", short.to_ascii_lowercase())
        }
        (None, Some(long)) => long.to_owned(),
        (None, None) => format!("{{{}", arg.get_id()),
    };
    (true, arg.get_display_order(), key)
}

/// Commands as `--help` lists them: no hidden ones, and not the generated `help`.
fn visible(command: &Command) -> impl Iterator<Item = &Command> {
    command
        .get_subcommands()
        .filter(|sub| !sub.is_hide_set() && sub.get_name() != "help")
}

/// The command's long about, or its about where it has none.
fn description(command: &Command) -> Vec<Block> {
    blocks(&text(
        command.get_long_about().or_else(|| command.get_about()),
    ))
}

fn text(styled: Option<&clap::builder::StyledStr>) -> String {
    styled.map(ToString::to_string).unwrap_or_default()
}

/// A run of help text: a paragraph, or lines indented under one, kept as written.
#[derive(Debug, PartialEq)]
enum Block {
    Text(String),
    Verbatim(String),
}

/// Help text as blocks: each paragraph on one line and ended as a sentence,
/// each run of indented lines without its common indent.
fn blocks(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut run: Vec<&str> = Vec::new();
    for line in text.lines() {
        let indented = line.starts_with([' ', '\t']);
        let blank = line.trim().is_empty();
        if blank
            || run
                .first()
                .is_some_and(|first| first.starts_with([' ', '\t']) != indented)
        {
            close(&mut blocks, &mut run);
        }
        if !blank {
            run.push(line);
        }
    }
    close(&mut blocks, &mut run);
    blocks
}

fn close(blocks: &mut Vec<Block>, run: &mut Vec<&str>) {
    let Some(first) = run.first() else {
        return;
    };
    if first.starts_with([' ', '\t']) {
        let indent = run
            .iter()
            .map(|line| line.len() - line.trim_start().len())
            .min()
            .unwrap_or(0);
        let lines: Vec<&str> = run.iter().map(|line| line[indent..].trim_end()).collect();
        blocks.push(Block::Verbatim(lines.join("\n")));
    } else {
        let lines: Vec<&str> = run.iter().map(|line| line.trim()).collect();
        blocks.push(Block::Text(sentence(&lines.join(" "))));
    }
    run.clear();
}

fn write_blocks(out: &mut String, blocks: &[Block]) {
    for block in blocks {
        match block {
            Block::Text(text) => writeln!(out, "{text}\n").unwrap(),
            Block::Verbatim(text) => {
                assert!(
                    !text.contains("```"),
                    "help holds a code fence, which would end its block: {text}"
                );
                writeln!(out, "```text\n{text}\n```\n").unwrap();
            }
        }
    }
}

/// Clap's derive drops the full stop that ends a short help.
fn sentence(text: &str) -> String {
    let text = text.trim_end();
    if text.is_empty() || text.ends_with(['.', ':', '!', '?']) {
        text.to_owned()
    } else {
        format!("{text}.")
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// `a`, `a and b`, `a, b, and c`.
fn series(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [one, two] => format!("{one} and {two}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

/// A table cell's text: one line, with its pipes escaped so they stay text.
fn cell(text: &str) -> String {
    assert!(
        !text.contains('\n'),
        "a table cell holds a line break: {text}"
    );
    text.replace('|', "\\|")
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

    /// Each heading of the reference with the long flags its tables list.
    fn flags_by_heading(reference: &str) -> Vec<(&str, Vec<&str>)> {
        let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
        for line in reference.lines() {
            if line.starts_with('#') {
                sections.push((line, Vec::new()));
            } else if let (Some(row), Some((_, flags))) =
                (line.strip_prefix("| `"), sections.last_mut())
            {
                let first_cell = row.split('`').next().unwrap_or_default();
                flags.extend(
                    first_cell
                        .split([' ', ','])
                        .filter(|word| word.starts_with("--")),
                );
            }
        }
        sections
    }

    #[test]
    fn the_global_options_are_listed_once_and_in_no_command() {
        let reference = render();
        let sections = flags_by_heading(&reference);
        let globals: Vec<String> = Cli::command()
            .get_arguments()
            .filter(|arg| arg.is_global_set())
            .map(|arg| format!("--{}", arg.get_long().expect("a global option is a flag")))
            .collect();
        assert!(globals.contains(&"--url".to_owned()), "{globals:?}");

        let listed = sections
            .iter()
            .find(|(heading, _)| *heading == "## Global options")
            .map(|(_, flags)| flags.clone())
            .expect("a global options section");
        assert_eq!(
            listed, globals,
            "the global options section lists the root's globals"
        );

        let mut root = Cli::command();
        root.build();
        let items = root.find_subcommand("items").expect("an items command");
        assert!(
            items
                .get_arguments()
                .any(|arg| arg.get_long() == Some("url")),
            "a command carries the root's globals for its help"
        );
        assert!(
            items
                .get_arguments()
                .any(|arg| arg.get_long() == Some("help")),
            "a command carries its own --help"
        );
        let commands: Vec<_> = sections
            .iter()
            .filter(|(heading, _)| heading.starts_with("### "))
            .collect();
        assert!(commands.iter().any(|(_, flags)| !flags.is_empty()));
        for (heading, flags) in commands {
            for flag in flags {
                assert!(
                    !globals.iter().any(|global| global == flag) && *flag != "--help",
                    "{heading} lists {flag}"
                );
            }
        }
    }

    /// Each `<`, `>`, `{` or `}` outside a code span or a fenced block, which
    /// MDX would read as markup, by line number.
    fn bare_markup(markdown: &str) -> Vec<(usize, char)> {
        let mut found = Vec::new();
        let mut fenced = false;
        for (number, line) in markdown.lines().enumerate() {
            if line.starts_with("```") {
                fenced = !fenced;
                continue;
            }
            if fenced || line.starts_with("<!-- Generated ") {
                continue;
            }
            let chars: Vec<char> = line.chars().collect();
            let mut at = 0;
            while at < chars.len() {
                if chars[at] == '`' {
                    let start = at;
                    while chars.get(at) == Some(&'`') {
                        at += 1;
                    }
                    let opening = at - start;
                    let mut end = at;
                    while end < chars.len() {
                        let run = end;
                        while chars.get(end) == Some(&'`') {
                            end += 1;
                        }
                        if end - run == opening {
                            at = end;
                            break;
                        }
                        end = end.max(run + 1);
                    }
                    continue;
                }
                if matches!(chars[at], '<' | '>' | '{' | '}') {
                    found.push((number + 1, chars[at]));
                }
                at += 1;
            }
        }
        found
    }

    #[test]
    fn the_reference_holds_no_bare_angle_bracket_or_brace() {
        let sample = "a <URL> and `<URL>` and ``{`}`` and `{\n```text\n{}\n```\n";
        assert_eq!(
            bare_markup(sample),
            [(1, '<'), (1, '>'), (1, '{')],
            "the check finds what it must"
        );
        let reference = render();
        assert!(reference.contains("`<"), "the reference has placeholders");
        let found = bare_markup(&reference);
        assert!(found.is_empty(), "markup outside code, by line: {found:?}");
    }
}
