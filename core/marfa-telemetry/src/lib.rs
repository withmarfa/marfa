//! Telemetry shared by the command line and the server: the `OTEL_*` settings, the PostHog
//! hosts a project token may travel to, and the exception event. Sends nothing and starts
//! no thread.

pub mod environment;
pub mod exception;
pub mod host;
pub mod identity;
pub mod otlp;
pub mod sampler;
