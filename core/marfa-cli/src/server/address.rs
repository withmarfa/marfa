//! The address people sign in at. The server holds it as a stored setting
//! that only its private socket changes, and refuses every caller off the
//! machine until it is set. `setup open`, `setup claim` and the installer
//! all set it through here.

use serde_json::{Value, json};

use crate::commands::config;
use crate::error::CliError;
use crate::remote::Remote;

const KEY: &str = "sign_in_address";
const CONFIRMATION: &str = "confirm_sign_in_address_change";

/// The address written the way the server reads it: scheme, host and a port
/// only if it is not the scheme's own. Devices sign in over https, and a
/// machine signs in to itself over http.
pub fn normalise(raw: &str) -> Result<String, CliError> {
    let bad =
        |why: &str| CliError::Usage(format!("{raw} is not an address the server can use: {why}"));
    let url = url::Url::parse(raw).map_err(|_| bad("write it like https://marfa.example.com"))?;
    let host = url.host_str().unwrap_or_default();
    let here = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if here => {}
        _ => return Err(bad("devices sign in only over https; http works for localhost")),
    }
    if host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(bad(
            "it takes a host, and a port if needed, and nothing else",
        ));
    }
    Ok(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// The body that sets the address. Asking for the address is the person's
/// confirmation of what it moves.
pub fn change_body(address: &str) -> Value {
    json!({ KEY: address, CONFIRMATION: true })
}

/// The stored address in what `config get` answers.
pub fn stored(config: &Value) -> Option<&str> {
    config.get(KEY).and_then(Value::as_str)
}

/// Sets the address through `read` and `write`, which reach the server's
/// private socket, unless it holds the address already. Whether it was set.
/// `address` is written as [`normalise`] writes it.
pub fn ensure_with(
    address: &str,
    read: impl FnOnce() -> Result<Value, CliError>,
    write: impl FnOnce(Value) -> Result<(), CliError>,
) -> Result<bool, CliError> {
    if stored(&read()?) == Some(address) {
        return Ok(false);
    }
    write(change_body(address))?;
    Ok(true)
}

/// Sets the sign-in address on the private socket unless it holds it already.
/// The address it holds now, if it changed.
pub fn ensure(remote: &Remote, raw: &str) -> Result<Option<String>, CliError> {
    let address = normalise(raw)?;
    let changed = ensure_with(
        &address,
        || remote.json(&config::get_request()),
        |body| remote.json(&config::update_request(body)).map(drop),
    )?;
    Ok(changed.then_some(address))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_a_scheme_a_host_and_maybe_a_port() {
        for (raw, written) in [
            ("https://marfa.example.com/", "https://marfa.example.com"),
            ("https://Marfa.Example.com:8443", "https://marfa.example.com:8443"),
            ("https://marfa.example.com:443", "https://marfa.example.com"),
            ("http://localhost:8600", "http://localhost:8600"),
            ("http://localhost:80", "http://localhost"),
            ("http://127.0.0.1:8600/", "http://127.0.0.1:8600"),
            ("http://[::1]:8600", "http://[::1]:8600"),
        ] {
            assert_eq!(normalise(raw).unwrap(), written, "{raw}");
        }
    }

    #[test]
    fn what_the_server_would_refuse_is_refused_first() {
        for bad in [
            "http://marfa.example.com",
            "http://192.168.1.4:8600",
            "marfa.example.com",
            "ftp://marfa.example.com",
            "https://marfa.example.com/path",
            "https://marfa.example.com/?a=1",
            "https://user:pw@marfa.example.com",
            "https://marfa.example.com/#x",
            "",
        ] {
            assert!(normalise(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_address_is_written_only_when_the_server_holds_another() {
        let held = |value: Value| move || Ok(value);
        let mut written = Vec::new();
        let set = ensure_with(
            "https://a.example",
            held(json!({"sign_in_address": "https://a.example"})),
            |body| Ok(written.push(body)),
        )
        .unwrap();
        assert!(!set && written.is_empty());
        for current in [json!({}), json!({"sign_in_address": "https://b.example"})] {
            let set = ensure_with("https://a.example", held(current), |body| {
                Ok(written.push(body))
            })
            .unwrap();
            assert!(set);
        }
        assert_eq!(written, vec![change_body("https://a.example"); 2]);
        let failed = ensure_with("https://a.example", held(json!({})), |_| {
            Err(CliError::Install("refused".into()))
        });
        assert!(failed.is_err());
    }

    #[test]
    fn the_body_confirms_the_move() {
        assert_eq!(
            change_body("https://a.example"),
            json!({"sign_in_address": "https://a.example", "confirm_sign_in_address_change": true})
        );
        assert_eq!(
            stored(&json!({"sign_in_address": "https://a.example"})),
            Some("https://a.example")
        );
        assert_eq!(stored(&json!({"name": "x"})), None);
    }
}
