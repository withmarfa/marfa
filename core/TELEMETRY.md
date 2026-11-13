# Telemetry in the core and the `marfa` binary

This page describes what the Rust core records, and what the `marfa` binary sends and where, for an app developer who turns telemetry on and for a person who points the binary at a collector. Nothing is sent unless the environment asks for it. The command reference summarizes the variables in its Telemetry section (`marfa-cli/COMMANDS.md`). The server's own telemetry settings are in `conformance/spec/instance.md`.

## In the core

The core can report its own work and sends it nowhere itself. It records through the [`tracing`](https://docs.rs/tracing) crate, and the host decides where the records go by installing a subscriber, such as an OpenTelemetry layer. Telemetry is off until a host turns it on in two steps:

1. Enable the `telemetry` Cargo feature of `marfa-core`. Without it, no tracing code or dependency is built. The Swift and Node bindings leave it off.

   ```toml
   marfa-core = { path = "marfa-core", features = ["telemetry"] }
   ```

2. Install a `tracing` subscriber in the host process. Until one is installed, `tracing` drops every record.

Cargo builds a package with a feature when any package in the same build asks for it. A command such as `cargo build --workspace` therefore builds the Node module's copy of `marfa-core` with the feature too, because the `marfa` binary enables it. Build the Node module from its own folder, as `pnpm run build` does.

### Spans

| Span         | Covers                                                          | Fields                                                           |
| ------------ | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `drain`      | One drain pass, called or started by a follow                   | `outcome`, `answered`, `held`, `undelivered`, `unsent`, `unmade` |
| `catch_up`   | One `Core::catch_up`                                            | `outcome`, `applied`, `skipped`                                  |
| `write`      | One queued write sent to the server, inside a `drain`           | `outcome`, `kind`, `status`                                      |
| `write_page` | One page of queued creates sent to the server, inside a `drain` | `outcome`, `kind`, `entries`, `status`                           |
| `search`     | One `Core::search` or `Core::search_shown`                      | `outcome`, `hits`                                                |

`outcome` says how the operation ended:

- A `catch_up` ends `ok`, `error` or `canceled`.
- A `search` ends `ok` or `error`.
- A `drain` ends as a `catch_up` does, or `unavailable` where the server could not be reached or asked for time, or `credential_refused`.
- A `write` or a `write_page` ends `answered`, `unavailable`, `error`, or `canceled` where a stop left it in flight.

`kind` is the queued write's kind, such as `create_item`, and `entries` is the number of writes in the page.

### Events

Two events carry `code`, the word `CoreError::code` gives everywhere else:

- An `ERROR` event when an operation returns an error.
- A `WARN` event when a request the `drain` makes gets no answer or cannot get through, and the drain leaves the work for a later pass.

A failure is recorded once: a write error that ends the drain is only the drain's `ERROR`. A write the server answers, even with a `5xx` or a `429`, records no event; its `write` span ends `unavailable` with the `status`. A stop the caller raises ends the span `canceled` and records no event.

### What is never recorded

The core records only an operation's name, a count, an `outcome`, a write's kind, an HTTP status and an error `code`. It never records an item's content, title, tag, id, key or natural key, a credential, an address, a header, a path, a query or an error message.

## In the `marfa` binary

The binary enables the feature and installs a subscriber that exports a trace over OTLP, but only when the environment names a collector. With none named, it installs nothing and sends no trace, though a failed command can still send one exception to PostHog. With neither asked for, it starts no thread and sends nothing, and its output and exit codes are what they would be without telemetry.

### Variables

| Variable                                                          | How the binary reads it                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                     | The collector's base address, `http` or `https`. The trace goes to `v1/traces` under it, and a query stays a query: `http://host:4318/?token=abc` posts to `/v1/traces?token=abc`. Setting it turns traces on.                          |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                              | The address the trace goes to, as written. It also turns traces on and takes precedence.                                                                                                                                                |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Headers as comma-separated `key=value` pairs, values percent-encoded. The traces variable wins for a header both name.                                                                                                                  |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | Milliseconds one send may take; 2000 by default. The binary waits no longer than this at exit.                                                                                                                                          |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`                  | `always_on` (the default), `always_off`, or `traceidratio` with a ratio from 0 to 1. A `parentbased_` form acts as the sampler it wraps. It does not apply to the PostHog exception.                                                    |
| `OTEL_SERVICE_NAME`                                               | The service name on the trace and the exception; `marfa-cli` by default. It takes precedence over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.                                                                                       |
| `OTEL_RESOURCE_ATTRIBUTES`                                        | Attributes added to the trace and the exception, as comma-separated `key=value` pairs with percent-encoded values. One named here replaces the command's own of the same name. A list with a pair that cannot be read is ignored whole. |
| `OTEL_SDK_DISABLED`                                               | `true` turns off both the trace and the exception.                                                                                                                                                                                      |
| `MARFA_POSTHOG_HOST`                                              | The PostHog host for a failed run's exception. It needs `MARFA_POSTHOG_PROJECT_TOKEN`.                                                                                                                                                  |
| `MARFA_POSTHOG_PROJECT_TOKEN`                                     | The PostHog project token for those exceptions. It needs `MARFA_POSTHOG_HOST`.                                                                                                                                                          |

A malformed `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` turns off the trace for that run and leaves the exception as it was. Without `--json`, the binary prints one line on standard error that names the variable, never its value; with `--json`, it prints nothing. A header, timeout, sampler or ratio that cannot be used is left out, and the default applies.

`folders autostart on` carries the telemetry settings of the shell that runs it to the watch at login, as `conformance/spec/folders.md` states.

### The trace

Each run is one trace. Its root span is named for the command path, such as `marfa items create`, and carries `exit_code`. The core's spans are beneath it, including those made on other threads.

- A command that fails adds an `error` event to the root with `code`, the CLI's error code, and `exit_code`.
- A command that exits 3 or 5 after printing a drain report has an `error` event with `exit_code` only.
- A command that Ctrl-C stopped, including a `canceled` hydration, catch-up, drain or served read, or whose output was closed, is not a failure. It keeps its `exit_code` and adds no event and no error status.
- A command line that clap refuses is not a run and exports nothing.

The binary exports only the command path, `exit_code`, `dropped_spans`, the core's span names, counts, outcomes, kinds, statuses and error codes, durations, and `error` and `warning` events with `code`. `marfa-cli/src/telemetry/layer.rs` lists the field names it keeps and drops every other field, and any value that is not a short plain word. Its list leaves out `entries`, so a `write_page` span reaches the collector without it. An error message, an argument, an address, a key, a path and an item's content are never sent, even where a message would echo them.

### How the trace is sent

The binary posts OTLP/HTTP JSON with the HTTP client it already uses, so it adds no second HTTP stack and no async runtime. It does not send protobuf, gzip, gRPC, metrics or logs, does not retry, and ignores `OTEL_EXPORTER_OTLP_PROTOCOL`. A collector that accepts only protobuf receives nothing useful. A redirect is not followed, so a header reaches only the address named. A proxy named by `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` carries the post to a collector on another host and is not used for one on this machine.

Spans are sent from a thread of their own, in batches of at most 512 every 5 seconds, so a long-lived command such as `folders watch` reports while it runs. At most 2048 spans wait for a send; past that a span is dropped, and the root's `dropped_spans` counts it. At the end of a run the binary sends what is left and waits up to the timeout. A collector that is unreachable, slow or refusing never changes the output or the exit code, and the binary reports none of those failures.

`folders watch`, `events` and `device changes` run until they are stopped, and the `device` commands that stop on Ctrl-C (`hydrate`, `follow`, `catch-up`, `drain` and the `served` reads) end when stopped. Ctrl-C ends each of these through its normal exit, so the trace is sent first. `folders watch` of one folder, `events` and `device changes` take Ctrl-C only once they are open; before then, and on a second Ctrl-C, the process ends at once and sends nothing. A watch of every folder takes Ctrl-C from the start. `SIGTERM` stops `folders watch` as the first Ctrl-C does. A command with no stop of its own, such as one whose request is in flight, is ended by Ctrl-C and sends nothing, and so is a process that is killed.

## Exceptions to PostHog

A command that ends in a fault can also reach PostHog's error tracking, which groups `$exception` events that a trace does not produce. The binary sends one when `MARFA_POSTHOG_HOST` and `MARFA_POSTHOG_PROJECT_TOKEN` are both set and `OTEL_SDK_DISABLED` is not `true`, whether or not an OTLP endpoint is set.

- The host must be an `https` address, or an `http` address on this machine (`localhost`, `127.0.0.0/8` or `::1`), because the project token travels in the request body. `--allow-http` does not widen that. A query or fragment in the host is dropped.
- With exactly one of the two variables set, a host of another kind, or a host that carries a user name or password, the binary sends nothing and prints one line on standard error that names the variable, never its value, and nothing under `--json`.

A fault is something the command line or the core itself got wrong: a panic, including one the core caught and ended with the code `fault` (`CoreError::Fault`), the local store failing for a reason of its own, an answer that cannot be read, or an answer status that the command line should never cause and that names no refusal, such as `405` or `415`. Nothing the server or the environment did is a fault, and it sends nothing: a refusal by design (a `4xx` answer that names a refusal, a usage error, a missing credential or docs page), a command that Ctrl-C stopped or that ended `canceled`, and anything `CoreError::is_environmental` counts (offline, a timeout, a rate limit, a `408` or `425` answer, any `5xx` answer, which the server reports itself, or full local storage).

A command that panics ends its trace as failed with status 101, sends one event of type `panic`, and lets the panic go on, so its message and exit status are what they would be without telemetry. The panic's message and location are never sent, since either can carry content.

The binary posts one event to `/i/v0/e/` under the host, once, with no retry, no redirect and no reading of the answer past its status. It posts beside the trace's last send, within the same timeout, so a PostHog that is unreachable, slow or refusing changes neither the output nor the exit code and holds the exit no longer than the timeout. A proxy is used as for the trace.

The event names no person. Its distinct ID is random and new for each process, `$process_person_profile` is `false`, `$geoip_disable` is `true`, and the binary stores no ID. Its properties are:

- **The exception:** `$exception_list` with one entry, whose `type` is the CLI's error code and whose `value` is a fixed sentence for that kind of error, and `$exception_level` set to `error`. It has no stack trace.
- **The run:** `command`, the command's names without any argument (`items create`), `error_code` where there is an error, `exit_code`, `service.name` as the trace's, `service.version`, `$os`, `arch`, `$lib` and `$lib_version`.

The `value` is never the error's message, which can echo a field name, an ID, a path or an address. The project token is in the request body's `api_key` field and nowhere else.
