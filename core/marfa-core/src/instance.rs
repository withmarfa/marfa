use crate::{CoreError, http::Http};

/// The public JSON description at the server's root, independent of a working copy.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct InstanceDescription {
    pub name: String,
    pub version: String,
    pub release: Option<String>,
    pub instance_id: String,
    pub contract: u64,
    pub features: Vec<String>,
}

pub fn instance_description(url: &str) -> Result<InstanceDescription, CoreError> {
    Http::new(url, "")?.instance_description()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{Call, CallBody, Method};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;

    fn answer(status: u16, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let body = body.to_string();
        let serving = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(&socket);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            write!(socket, "HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            request
        });
        (url, serving)
    }

    fn description(name: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name, "version": "build-test", "release": "0.0.14",
            "instance_id": "019a1950-3b30-7000-8000-000000000001",
            "contract": 0, "features": ["items", "webhooks"]
        })
    }

    #[test]
    fn reads_names_and_fields_anonymously_under_a_prefix() {
        for name in ["Bibliothèque <notes> 𐐀", "Marfa"] {
            for suffix in ["/prefix", "/prefix/"] {
                let (url, serving) = answer(200, &description(name).to_string());
                let url = url.replacen("http://", "http://user:password@", 1);
                let http = Http::new(
                    &format!("{url}{suffix}?ignored=1#fragment"),
                    "marfa_k1_test",
                )
                .unwrap();
                let instance = http.instance_description().unwrap();
                assert_eq!(instance.name, name);
                assert_eq!(instance.version, "build-test");
                assert_eq!(instance.release.as_deref(), Some("0.0.14"));
                assert_eq!(instance.instance_id, "019a1950-3b30-7000-8000-000000000001");
                assert_eq!(instance.contract, 0);
                assert_eq!(instance.features, ["items", "webhooks"]);
                let request = serving.join().unwrap().to_ascii_lowercase();
                assert!(
                    request.starts_with("get /prefix/ http/1.1\r\n"),
                    "{request}"
                );
                assert!(request.contains("accept: application/json\r\n"));
                assert!(!request.contains("authorization:"), "{request}");
            }
        }
        // The same transport carries its key when the call asks for it.
        let (url, serving) = answer(200, "{}");
        Http::new(&url, "marfa_k1_test")
            .unwrap()
            .fetch(
                Call {
                    method: Method::Get,
                    segments: &[""],
                    params: &[],
                    headers: &[],
                    body: CallBody::None,
                    credential: true,
                    stream: false,
                },
                false,
            )
            .unwrap();
        assert!(
            serving
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .contains("authorization: bearer marfa_k1_test\r\n")
        );
    }

    #[test]
    fn accepts_a_build_without_a_release_and_another_contract() {
        let mut body = description("Marfa");
        body.as_object_mut().unwrap().remove("release");
        body["contract"] = serde_json::json!(999);
        let (url, serving) = answer(200, &body.to_string());
        let instance = instance_description(&url).unwrap();
        assert_eq!(instance.release, None);
        assert_eq!(instance.contract, 999);
        serving.join().unwrap();
    }

    #[test]
    fn refuses_malformed_descriptions() {
        let mut bodies = vec!["<html>page</html>".into(), "{}".into(), "null".into()];
        for field in ["name", "version", "instance_id", "contract", "features"] {
            let mut body = description("Marfa");
            body.as_object_mut().unwrap().remove(field);
            bodies.push(body.to_string());
            let mut body = description("Marfa");
            body[field] = serde_json::Value::Bool(false);
            bodies.push(body.to_string());
        }
        let mut empty_id = description("Marfa");
        empty_id["instance_id"] = serde_json::json!("");
        bodies.push(empty_id.to_string());
        for body in bodies {
            let (url, serving) = answer(200, &body);
            assert!(
                matches!(instance_description(&url), Err(CoreError::Decoding(_))),
                "{body}"
            );
            serving.join().unwrap();
        }
    }

    #[test]
    fn reports_connection_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        // Keep the port reserved, but close each connection before it answers.
        let serving = thread::spawn(move || {
            drop(listener.accept().unwrap());
        });
        assert!(matches!(
            instance_description(&url),
            Err(CoreError::Network { .. })
        ));
        serving.join().unwrap();
    }

    #[test]
    fn refuses_http_failure_even_with_a_valid_description() {
        for status in [302, 401, 503] {
            let (url, serving) = answer(status, &description("Marfa").to_string());
            assert!(instance_description(&url).is_err());
            serving.join().unwrap();
        }
    }
}
