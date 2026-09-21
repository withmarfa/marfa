use std::path::PathBuf;

use serde_json::Value;

pub use marfa_core::http::Method;

/// What a call sends as its body.
#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    None,
    Json(Value),
    /// Streamed from the file rather than read whole, under this type.
    File {
        path: PathBuf,
        content_type: String,
    },
}

/// One call from the direct surface, before it is sent: the shape a command
/// builds and the tests hold, with nothing about the server or the credential
/// in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: Method,
    pub segments: Vec<String>,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    /// Whether the door needs a credential. The root document and the
    /// health door answer without one.
    pub credential: bool,
    /// Hand the body back as a reader rather than reading it as text: the
    /// stream, an export, a blob's bytes.
    pub stream: bool,
}

impl Request {
    pub fn new(method: Method, segments: &[&str]) -> Request {
        Request {
            method,
            segments: segments.iter().map(|part| part.to_string()).collect(),
            query: Vec::new(),
            headers: Vec::new(),
            body: Body::None,
            credential: true,
            stream: false,
        }
    }

    pub fn get(segments: &[&str]) -> Request {
        Request::new(Method::Get, segments)
    }

    pub fn post(segments: &[&str]) -> Request {
        Request::new(Method::Post, segments)
    }

    pub fn put(segments: &[&str]) -> Request {
        Request::new(Method::Put, segments)
    }

    pub fn patch(segments: &[&str]) -> Request {
        Request::new(Method::Patch, segments)
    }

    pub fn delete(segments: &[&str]) -> Request {
        Request::new(Method::Delete, segments)
    }

    pub fn query(mut self, key: &str, value: impl Into<String>) -> Request {
        self.query.push((key.to_string(), value.into()));
        self
    }

    /// A query parameter that rides only when the caller gave it.
    pub fn query_opt(self, key: &str, value: Option<impl Into<String>>) -> Request {
        match value {
            Some(value) => self.query(key, value),
            None => self,
        }
    }

    /// A flag that rides as `key=true` only when set.
    pub fn query_flag(self, key: &str, set: bool) -> Request {
        if set { self.query(key, "true") } else { self }
    }

    /// A repeatable value joined with commas, the way the listing grammar
    /// takes `tags` and `include`.
    pub fn query_list(self, key: &str, values: &[String]) -> Request {
        if values.is_empty() {
            self
        } else {
            self.query(key, values.join(","))
        }
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Request {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    pub fn json(mut self, value: Value) -> Request {
        self.body = Body::Json(value);
        self
    }

    pub fn file(mut self, path: PathBuf, content_type: impl Into<String>) -> Request {
        self.body = Body::File {
            path,
            content_type: content_type.into(),
        };
        self
    }

    pub fn public(mut self) -> Request {
        self.credential = false;
        self
    }

    pub fn streamed(mut self) -> Request {
        self.stream = true;
        self
    }

    /// The path as it will appear on the wire, for messages and tests.
    pub fn path(&self) -> String {
        format!("/{}", self.segments.join("/"))
    }
}
