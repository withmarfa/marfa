//! A fault as one PostHog `$exception` event, with no person attached
//! (`$process_person_profile` false, `$geoip_disable` true). A trace does not
//! produce these, so this is a post of its own.

use serde_json::{Map, Value, json};

/// `platform` is `custom` and `resolved` says the names are final.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub function: String,
    pub module: Option<String>,
    pub filename: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub in_app: bool,
}

impl Frame {
    fn json(&self) -> Value {
        let mut frame = Map::new();
        frame.insert("platform".into(), "custom".into());
        frame.insert("lang".into(), "rust".into());
        frame.insert("function".into(), self.function.clone().into());
        if let Some(module) = &self.module {
            frame.insert("module".into(), module.clone().into());
        }
        if let Some(filename) = &self.filename {
            frame.insert("filename".into(), filename.clone().into());
        }
        if let Some(line) = self.line {
            frame.insert("lineno".into(), line.into());
        }
        if let Some(column) = self.column {
            frame.insert("colno".into(), column.into());
        }
        frame.insert("resolved".into(), true.into());
        frame.insert("in_app".into(), self.in_app.into());
        Value::Object(frame)
    }
}

pub struct Exception<'a> {
    pub kind: &'a str,
    pub value: &'a str,
    /// Innermost first; PostHog wants outermost first, so they are reversed on the way out.
    pub frames: Option<&'a [Frame]>,
    pub handled: bool,
}

pub struct Event<'a> {
    pub distinct_id: &'a str,
    pub lib: &'a str,
    pub lib_version: &'a str,
    pub exception: Exception<'a>,
    /// RFC 3339, for a report sent later than the fault; `None` lets PostHog stamp its arrival.
    pub timestamp: Option<&'a str>,
    /// Win over an attribute of the same name.
    pub properties: Vec<(&'a str, Value)>,
    /// Added unless a property has the same key.
    pub attributes: &'a [(String, String)],
}

impl Event<'_> {
    pub fn json(&self) -> Value {
        let mut exception = json!({
            "type": self.exception.kind,
            "value": self.exception.value,
            "mechanism": { "handled": self.exception.handled, "synthetic": false },
        });
        if let Some(frames) = self.exception.frames {
            exception["stacktrace"] = json!({
                "type": "raw",
                "frames": frames.iter().rev().map(Frame::json).collect::<Vec<_>>(),
            });
        }
        let mut properties = Map::new();
        properties.insert("$process_person_profile".into(), false.into());
        properties.insert("$geoip_disable".into(), true.into());
        properties.insert("$lib".into(), self.lib.into());
        properties.insert("$lib_version".into(), self.lib_version.into());
        properties.insert("$os".into(), std::env::consts::OS.into());
        properties.insert("arch".into(), std::env::consts::ARCH.into());
        properties.insert("$exception_list".into(), json!([exception]));
        properties.insert("$exception_level".into(), "error".into());
        for (key, value) in &self.properties {
            properties.insert((*key).into(), value.clone());
        }
        for (key, value) in self.attributes {
            if !properties.contains_key(key) {
                properties.insert(key.clone(), value.clone().into());
            }
        }
        let mut event = Map::new();
        event.insert("event".into(), "$exception".into());
        event.insert("distinct_id".into(), self.distinct_id.into());
        if let Some(timestamp) = self.timestamp {
            event.insert("timestamp".into(), timestamp.into());
        }
        event.insert("properties".into(), Value::Object(properties));
        Value::Object(event)
    }
}

pub fn single(token: &str, event: &Event) -> Value {
    let mut body = Map::new();
    body.insert("api_key".into(), token.into());
    if let Value::Object(fields) = event.json() {
        body.extend(fields);
    }
    Value::Object(body)
}

pub fn batch(token: &str, events: Vec<Value>) -> Value {
    json!({ "api_key": token, "batch": events })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event<'a>(frames: Option<&'a [Frame]>, attributes: &'a [(String, String)]) -> Event<'a> {
        Event {
            distinct_id: "abc",
            lib: "marfa-test",
            lib_version: "1.2.3",
            exception: Exception {
                kind: "internal",
                value: "went wrong",
                frames,
                handled: false,
            },
            timestamp: None,
            properties: vec![("command", "mine".into())],
            attributes,
        }
    }

    #[test]
    fn an_event_is_personless_and_has_no_stack_unless_it_is_given_frames() {
        let json = event(None, &[]).json();
        assert_eq!(json["event"], "$exception");
        assert_eq!(json["distinct_id"], "abc");
        assert!(json.get("timestamp").is_none());
        let properties = &json["properties"];
        assert_eq!(properties["$process_person_profile"], false);
        assert_eq!(properties["$geoip_disable"], true);
        assert_eq!(properties["$lib"], "marfa-test");
        assert_eq!(properties["$exception_level"], "error");
        let exception = &properties["$exception_list"][0];
        assert_eq!(exception["type"], "internal");
        assert_eq!(exception["value"], "went wrong");
        assert_eq!(exception["mechanism"]["handled"], false);
        assert!(exception.get("stacktrace").is_none());
    }

    #[test]
    fn frames_are_sent_outermost_first_as_posthog_reads_them() {
        let frames = [
            Frame {
                function: "inner".into(),
                module: Some("marfa_server::app".into()),
                filename: Some("src/app/mod.rs".into()),
                line: Some(10),
                column: Some(4),
                in_app: true,
            },
            Frame {
                function: "outer".into(),
                module: None,
                filename: None,
                line: None,
                column: None,
                in_app: false,
            },
        ];
        let json = event(Some(&frames), &[]).json();
        let stack = &json["properties"]["$exception_list"][0]["stacktrace"];
        assert_eq!(stack["type"], "raw");
        let listed = stack["frames"].as_array().unwrap();
        assert_eq!(listed[0]["function"], "outer");
        assert_eq!(listed[0]["in_app"], false);
        assert!(listed[0].get("lineno").is_none());
        assert_eq!(listed[1]["function"], "inner");
        assert_eq!(listed[1]["platform"], "custom");
        assert_eq!(listed[1]["lineno"], 10);
        assert_eq!(listed[1]["colno"], 4);
        assert_eq!(listed[1]["filename"], "src/app/mod.rs");
        assert_eq!(listed[1]["resolved"], true);
    }

    #[test]
    fn attributes_are_carried_but_never_over_a_property_of_the_program() {
        let attributes = [
            ("service.name".to_string(), "x".to_string()),
            ("command".to_string(), "not-the-command".to_string()),
        ];
        let json = event(None, &attributes).json();
        assert_eq!(json["properties"]["service.name"], "x");
        assert_eq!(json["properties"]["command"], "mine");
    }

    #[test]
    fn the_token_goes_in_the_body_in_both_shapes() {
        let one = single("phc_x", &event(None, &[]));
        assert_eq!(one["api_key"], "phc_x");
        assert_eq!(one["event"], "$exception");
        let many = batch("phc_x", vec![event(None, &[]).json()]);
        assert_eq!(many["api_key"], "phc_x");
        assert_eq!(many["batch"][0]["event"], "$exception");
    }
}
