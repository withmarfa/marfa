//! The command reference committed as `COMMANDS.md`, written as Markdown from
//! the clap command tree so it cannot drift from the binary.
//!
//! The docs site renders the file as MDX, where a bare `<` or `{` starts
//! markup, so every placeholder, default and value sits in a code span.

use std::fmt::Write as _;

use clap::{Arg, ArgAction, Command, CommandFactory};

use crate::Cli;
use crate::error::{
    CATCH_UP_FAILED, DRAIN_EXITS, Exit, JSON_REFUSAL, JSON_REFUSAL_CODES, JSON_REFUSAL_SHAPE,
    codes, exit_codes_help,
};

const REGENERATE: &str = "MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference";

/// What the environment can ask of a run, which no option of the command tree
/// says. It names the variables `telemetry/settings.rs` reads, and a test
/// holds the two together.
const TELEMETRY: &str = "## Telemetry

A command sends one trace to an OpenTelemetry collector when the environment names one, and nothing when it does not. The settings are the standard OpenTelemetry variables, and two for PostHog.

| Variable | Description |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector's base address, `http` or `https`. The trace is posted to `v1/traces` under it. Setting it turns telemetry on. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | The address the trace is posted to, used as written. It also turns telemetry on, and takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Headers to send, as comma-separated `key=value` pairs with percent-encoded values. The traces variable overrides the other for a header both name. |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | The longest one send may take, in milliseconds. The default is 2000. The command waits no longer than this at its end. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `always_on` (the default), `always_off`, or `traceidratio` with a ratio from 0 to 1 as the argument. The `parentbased_` forms act as the sampler they wrap. |
| `OTEL_SERVICE_NAME` | The service name on the trace. The default is `marfa-cli`. It takes precedence over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Attributes to add to the trace and the exception, as comma-separated `key=value` pairs with percent-encoded values, such as `deployment.environment=staging`. One named here replaces the command's own of the same name. A list with a pair that cannot be read is ignored whole. |
| `OTEL_SDK_DISABLED` | `true` turns off both the trace and the exception report. |
| `MARFA_POSTHOG_HOST` | The PostHog host that receives a failed command's exception, `https` or, to this machine, `http`. It needs `MARFA_POSTHOG_PROJECT_TOKEN`. |
| `MARFA_POSTHOG_PROJECT_TOKEN` | The PostHog project token for those exceptions. It needs `MARFA_POSTHOG_HOST`. |

The trace's root span is named for the command, such as `marfa items create`, and carries the exit code. The core's operations are beneath it, with their counts and outcomes. A command that fails adds an `error` event with the exit code and, for a refusal, the error code from the list above. The trace holds no argument, address, credential, item content or message. A collector that is unreachable, slow or refusing changes neither the command's output nor its exit code.

A failed command also sends one exception to PostHog's error tracking when `MARFA_POSTHOG_HOST` and `MARFA_POSTHOG_PROJECT_TOKEN` are both set, whether or not an OTLP endpoint is. The trace needs an endpoint and the exception does not, so a malformed endpoint turns off the trace only, and a malformed host the exception only. With either PostHog variable unset, no exception is sent. With only one of the two PostHog variables set, or a host that is neither `https` nor on this machine, the command prints one line on standard error that names the variable, and nothing under `--json`. The exception has the command's name, the error code, the exit code, the version, the operating system and the architecture, and a fixed sentence for the kind of error in place of its message. It names no person, and holds no argument, address, credential, item content or message. A command that Ctrl-C stopped, or that ended `canceled`, sends nothing, and one that panics sends an exception of type `panic` with no message, and `OTEL_TRACES_SAMPLER` does not change what is sent. A PostHog that is unreachable, slow or refusing changes neither the command's output nor its exit code, and the command waits no longer than the timeout above.

";

/// The reference as the file holds it: what the root says of itself, its
/// options and exit codes, then every visible command in the order
/// `marfa --help` lists them, depth first.
pub fn render() -> String {
    let mut root = Cli::command();
    root.build();
    // The exit codes below are set out from the parts this text is made of.
    assert!(
        root.get_after_long_help()
            .is_some_and(|help| help.to_string().ends_with(exit_codes_help())),
        "the root's after-help does not end with the exit codes the reference sets out"
    );

    let mut out = String::new();
    writeln!(
        out,
        "<!-- Generated from the command tree by `{REGENERATE}`. Do not edit by hand. -->\n"
    )
    .unwrap();
    out.push_str("# Command reference\n\n");
    modeled(&root, root.get_name());
    write_blocks(&mut out, &description(&root));

    let (globals, own): (Vec<&Arg>, Vec<&Arg>) = shown(&root).partition(|arg| arg.is_global_set());
    assert!(
        own.iter().all(|arg| !arg.is_positional()),
        "the root takes an argument, which the reference does not show"
    );
    out.push_str("## Global options\n\nEvery command accepts these.\n\n");
    table(&mut out, "Option", &globals);
    if !own.is_empty() {
        writeln!(out, "`{}` itself also accepts these.\n", root.get_name()).unwrap();
        table(&mut out, "Option", &own);
    }
    out.push_str("## Exit codes\n\n");
    exit_codes(&mut out);
    out.push_str(TELEMETRY);

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
    modeled(command, path);
    let description = description(command);
    write_blocks(out, description.strip_prefix(said).unwrap_or(&description));
    usage(out, command);

    let (from_above, own): (Vec<&Arg>, Vec<&Arg>) =
        shown(command).partition(|arg| above.iter().any(|item| item.is(arg)));
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
            .find(|item| item.is(arg))
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
    row: String,
    owner: Option<String>,
}

impl Inherited {
    fn new(arg: &Arg, owner: Option<&str>) -> Self {
        Self {
            id: arg.get_id().as_str().to_owned(),
            row: row(arg),
            owner: owner.map(str::to_owned),
        }
    }

    /// Whether `arg` is this option as clap passed it down. Clap passes none
    /// to a command with an argument of the same id, which is then the
    /// command's own, and so is a global it declares itself.
    fn is(&self, arg: &Arg) -> bool {
        arg.is_global_set() && self.id == arg.get_id().as_str() && self.row == row(arg)
    }
}

/// Refuses what `--help` shows and the reference does not, so its first use
/// fails the test instead of going missing from the file.
fn modeled(command: &Command, path: &str) {
    assert!(
        command.get_visible_aliases().next().is_none()
            && command.get_visible_short_flag_aliases().next().is_none()
            && command.get_visible_long_flag_aliases().next().is_none(),
        "`{path}` has a visible alias, which the reference does not show"
    );
    assert!(
        command.get_short_flag().is_none() && command.get_long_flag().is_none(),
        "`{path}` has a flag of its own, which the reference does not show"
    );
    assert!(
        command.get_before_help().is_none() && command.get_before_long_help().is_none(),
        "`{path}` has help before its usage, which the reference does not show"
    );
    for arg in shown(command) {
        let flag = match (arg.get_long(), arg.get_short()) {
            (Some(long), _) => format!("--{long}"),
            (None, Some(short)) => format!("-{short}"),
            (None, None) => arg.to_string(),
        };
        assert!(
            arg.is_hide_possible_values_set()
                || arg
                    .get_possible_values()
                    .iter()
                    .all(|value| value.is_hide_set() || value.get_help().is_none()),
            "`{path} {flag}` names a value with help of its own, which the reference does not show"
        );
        assert!(
            arg.get_visible_aliases()
                .is_none_or(|aliases| aliases.is_empty())
                && arg
                    .get_visible_short_aliases()
                    .is_none_or(|aliases| aliases.is_empty()),
            "`{path} {flag}` has a visible alias, which the reference does not show"
        );
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
            Block::Text(sentence(CATCH_UP_FAILED)),
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
        writeln!(out, "{}", row(arg)).unwrap();
    }
    out.push('\n');
}

fn row(arg: &Arg) -> String {
    format!("| `{}` | {} |", cell(&name(arg)), cell(&explained(arg)))
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

/// The arguments the long help shows, in its order, without `--help`.
fn shown(command: &Command) -> impl Iterator<Item = &Arg> {
    let mut args: Vec<&Arg> = command
        .get_arguments()
        .filter(|arg| !arg.is_hide_set() && !arg.is_hide_long_help_set())
        .filter(|arg| {
            !matches!(
                arg.get_action(),
                ArgAction::Help | ArgAction::HelpShort | ArgAction::HelpLong
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

    /// Each heading of the reference with the table rows under it.
    fn rows_by_heading(reference: &str) -> Vec<(&str, Vec<&str>)> {
        let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
        for line in reference.lines() {
            if line.starts_with('#') {
                sections.push((line, Vec::new()));
            } else if let (true, Some((_, rows))) = (line.starts_with("| `"), sections.last_mut()) {
                rows.push(line);
            }
        }
        sections
    }

    #[test]
    fn the_reference_and_the_readme_name_every_variable_the_binary_reads() {
        let settings = [
            include_str!("telemetry/settings.rs"),
            include_str!("telemetry/posthog.rs"),
        ];
        let readme = include_str!("../../README.md");
        let mut variables: Vec<&str> = settings
            .iter()
            .flat_map(|source| source.split('"'))
            .filter(|text| {
                (text.starts_with("OTEL_") || text.starts_with("MARFA_POSTHOG_"))
                    && text.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
            })
            .collect();
        variables.sort_unstable();
        variables.dedup();
        // The witness that the source is read: the list is not empty.
        assert!(variables.len() >= 12, "{variables:?}");
        for variable in variables {
            assert!(
                TELEMETRY.contains(&format!("`{variable}`")),
                "the reference lacks {variable}"
            );
            assert!(
                readme.contains(&format!("`{variable}`")),
                "core/README.md lacks {variable}"
            );
        }
    }

    #[test]
    fn the_global_options_are_listed_once_and_in_no_command() {
        let reference = render();
        let sections = rows_by_heading(&reference);
        let mut root = Cli::command();
        root.build();
        let globals: Vec<String> = root
            .get_arguments()
            .filter(|arg| arg.is_global_set())
            .map(row)
            .collect();
        assert!(
            globals.iter().any(|row| row.starts_with("| `--url ")),
            "{globals:?}"
        );

        let listed = sections
            .iter()
            .find(|(heading, _)| *heading == "## Global options")
            .map(|(_, rows)| rows.clone())
            .expect("a global options section");
        for global in &globals {
            assert!(
                listed.contains(&global.as_str()),
                "## Global options lacks {global}"
            );
        }
        assert!(
            listed
                .iter()
                .any(|row| row.starts_with("| `-V, --version` |")),
            "the root's own -V, --version is listed: {listed:?}"
        );

        let items = root.find_subcommand("items").expect("an items command");
        assert!(
            items
                .get_arguments()
                .any(|arg| arg.is_global_set() && globals.contains(&row(arg))),
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
        assert!(commands.iter().any(|(_, rows)| !rows.is_empty()));
        for (heading, rows) in commands {
            for line in rows {
                assert!(
                    !globals.iter().any(|global| global == line)
                        && !line.starts_with("| `-h, --help` |"),
                    "{heading} lists {line}"
                );
            }
        }
    }

    /// The sections of every command below the root of `root`, as `render`
    /// writes them.
    fn sections(mut root: Command) -> String {
        root.build();
        let above: Vec<Inherited> = shown(&root)
            .filter(|arg| arg.is_global_set())
            .map(|arg| Inherited::new(arg, None))
            .collect();
        let mut out = String::new();
        for area in visible(&root) {
            let path = format!("{} {}", root.get_name(), area.get_name());
            section(&mut out, area, &path, &[], &above);
        }
        out
    }

    fn sample(local: Command) -> Command {
        Command::new("x")
            .arg(
                Arg::new("key")
                    .long("key")
                    .global(true)
                    .value_name("KEY")
                    .help("The key every command sends"),
            )
            .subcommand(Command::new("plain").about("Takes only the globals"))
            .subcommand(local)
    }

    /// The section under `### {heading}` in `out`.
    fn section_of<'a>(out: &'a str, heading: &str) -> &'a str {
        let start = out
            .find(&format!("### {heading}\n"))
            .unwrap_or_else(|| panic!("no section {heading} in {out}"));
        let rest = &out[start + 4..];
        &out[start..start + 4 + rest.find("\n### ").unwrap_or(rest.len())]
    }

    #[test]
    fn an_option_of_a_commands_own_is_listed_though_it_shares_a_globals_id() {
        let out = sections(
            sample(
                Command::new("own").arg(
                    Arg::new("key")
                        .long("key")
                        .value_name("NAME")
                        .help("The name this command looks up"),
                ),
            )
            .subcommand(
                Command::new("nested")
                    .arg(
                        Arg::new("key")
                            .long("key")
                            .global(true)
                            .value_name("TOKEN")
                            .help("The token every nested command sends"),
                    )
                    .subcommand(Command::new("leaf")),
            ),
        );
        assert!(
            !section_of(&out, "x plain").contains("--key"),
            "the root's global is left to the global options: {out}"
        );
        assert!(
            section_of(&out, "x own")
                .contains("| `--key <NAME>` | The name this command looks up. |"),
            "{out}"
        );
        assert!(
            section_of(&out, "x nested")
                .contains("| `--key <TOKEN>` | The token every nested command sends. |"),
            "{out}"
        );
        assert!(
            section_of(&out, "x nested leaf")
                .contains("Also accepts the options of `x nested`: `--key <TOKEN>`."),
            "{out}"
        );
    }

    #[test]
    #[should_panic(expected = "`x own --tier` names a value with help of its own")]
    fn a_possible_value_with_help_is_refused() {
        sections(sample(Command::new("own").arg(
            Arg::new("tier").long("tier").value_parser([
                clap::builder::PossibleValue::new("library").help("Kept"),
                clap::builder::PossibleValue::new("feed"),
            ]),
        )));
    }

    #[test]
    #[should_panic(expected = "`x own --name` has a visible alias")]
    fn an_options_visible_alias_is_refused() {
        sections(sample(
            Command::new("own").arg(Arg::new("name").long("name").visible_alias("title")),
        ));
    }

    #[test]
    #[should_panic(expected = "`x own -n` has a visible alias")]
    fn an_options_visible_short_alias_is_refused() {
        sections(sample(
            Command::new("own").arg(Arg::new("name").short('n').visible_short_alias('t')),
        ));
    }

    #[test]
    #[should_panic(expected = "`x own` has a visible alias")]
    fn a_commands_visible_alias_is_refused() {
        sections(sample(Command::new("own").visible_alias("mine")));
    }

    #[test]
    #[should_panic(expected = "`x own` has a flag of its own")]
    fn a_commands_flag_is_refused() {
        sections(sample(Command::new("own").long_flag("own")));
    }

    #[test]
    #[should_panic(expected = "`x own` has help before its usage")]
    fn help_before_the_usage_is_refused() {
        sections(sample(Command::new("own").before_help("Read this first.")));
    }

    #[test]
    fn a_command_with_none_of_those_renders() {
        let out = sections(sample(
            Command::new("own").arg(
                Arg::new("name")
                    .long("name")
                    .alias("title")
                    .value_parser(["a", "b"]),
            ),
        ));
        assert!(
            section_of(&out, "x own").contains("| `--name <name>` | One of `a`, `b`. |"),
            "{out}"
        );
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
