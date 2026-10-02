use std::path::PathBuf;

use serde_json::Value;

pub use marfa_core::http::Method;

#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    None,
    Json(Value),
    File { path: PathBuf, content_type: String },
    Form(Vec<(String, String)>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: Method,
    pub segments: Vec<String>,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    pub credential: bool,
    pub stream: bool,
    pub mints: bool,
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
            mints: false,
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

    pub fn query_opt(self, key: &str, value: Option<impl Into<String>>) -> Request {
        match value {
            Some(value) => self.query(key, value),
            None => self,
        }
    }

    pub fn query_flag(self, key: &str, set: bool) -> Request {
        if set { self.query(key, "true") } else { self }
    }

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

    pub fn form(mut self, pairs: &[(&str, &str)]) -> Request {
        self.body = Body::Form(
            pairs
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        );
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

    pub fn minting(mut self) -> Request {
        self.mints = true;
        self
    }

    pub fn path(&self) -> String {
        format!("/{}", self.segments.join("/"))
    }
}
