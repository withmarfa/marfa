//! Telemetry shared by the command line and the server: the `OTEL_*` settings, the hosts a
//! PostHog project token may travel to, the exception event, and the process's own CPU and
//! memory. Sends nothing and starts no thread.

pub mod environment;
pub mod exception;
pub mod host;
pub mod identity;
pub mod otlp;
pub mod process;
pub mod sampler;
