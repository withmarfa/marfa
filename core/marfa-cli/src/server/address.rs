//! The address people sign in at, which only the server's private socket changes.

use serde_json::{Value, json};

use crate::commands::config;
use crate::error::CliError;
use crate::remote::Remote;

const KEY: &str = "sign_in_address";
const CONFIRMATION: &str = "confirm_sign_in_address_change";

/// The address written the way the server reads it.
pub fn normalise(raw: &str) -> Result<String, CliError> {
    let bad =
        |why: &str| CliError::Usage(format!("{raw} is not an address the server can use: {why}"));
    let url = url::Url::parse(raw).map_err(|_| bad("write it like https://marfa.example.com"))?;
    let host = url.host_str().unwrap_or_default();
    let here = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if here => {}
        _ => {
            return Err(bad(
                "devices sign in only over https; http works for localhost",
            ));
        }
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

/// The body that removes the address, so that the server uses its own
/// machine's.
pub fn clear_body() -> Value {
    json!({ KEY: Value::Null, CONFIRMATION: true })
}

/// The stored address in what `config get` answers.
pub fn stored(config: &Value) -> Option<&str> {
    config.get(KEY).and_then(Value::as_str)
}

/// What an install wants of the address the server holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want<'a> {
    /// This address. `asked` says that the person asked for it with this run,
    /// which is what lets it replace a different one.
    Set { address: &'a str, asked: bool },
    /// None: the server is reached only from its own machine.
    Clear { asked: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    Unchanged,
    Set,
    Cleared,
    /// The server holds a different address and nothing asked to move it.
    Left {
        held: String,
    },
}

/// An address the server holds is replaced only when the person asked.
pub fn settle_with(
    want: Want,
    read: impl FnOnce() -> Result<Value, CliError>,
    write: impl FnOnce(Value) -> Result<(), CliError>,
) -> Result<Settled, CliError> {
    let config = read()?;
    let held = stored(&config);
    match (want, held) {
        (Want::Set { address, .. }, Some(held)) if held == address => Ok(Settled::Unchanged),
        (Want::Set { address, .. }, None) => {
            write(change_body(address))?;
            Ok(Settled::Set)
        }
        (
            Want::Set {
                address,
                asked: true,
            },
            Some(_),
        ) => {
            write(change_body(address))?;
            Ok(Settled::Set)
        }
        (Want::Clear { .. }, None) => Ok(Settled::Unchanged),
        (Want::Clear { asked: true }, Some(_)) => {
            write(clear_body())?;
            Ok(Settled::Cleared)
        }
        (_, Some(held)) => Ok(Settled::Left {
            held: held.to_string(),
        }),
    }
}

/// Sets the sign-in address unless held already; returns the address held before, if it changed.
pub fn ensure(remote: &Remote, raw: &str) -> Result<Option<String>, CliError> {
    let address = normalise(raw)?;
    let settled = settle_with(
        Want::Set {
            address: &address,
            asked: true,
        },
        || remote.json(&config::get_request()),
        |body| remote.json(&config::update_request(body)).map(drop),
    )?;
    Ok((settled == Settled::Set).then_some(address))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_a_scheme_a_host_and_maybe_a_port() {
        for (raw, written) in [
            ("https://marfa.example.com/", "https://marfa.example.com"),
            (
                "https://Marfa.Example.com:8443",
                "https://marfa.example.com:8443",
            ),
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

    fn settle(want: Want, held: Value) -> (Settled, Vec<Value>) {
        let mut written = Vec::new();
        let settled = settle_with(
            want,
            || Ok(held),
            |body| {
                written.push(body);
                Ok(())
            },
        )
        .unwrap();
        (settled, written)
    }

    #[test]
    fn an_address_the_server_does_not_hold_is_set_whether_or_not_it_was_asked_for() {
        for asked in [true, false] {
            let (settled, written) = settle(
                Want::Set {
                    address: "https://a.example",
                    asked,
                },
                json!({}),
            );
            assert_eq!(settled, Settled::Set);
            assert_eq!(written, vec![change_body("https://a.example")]);
        }
    }

    #[test]
    fn an_address_the_server_holds_is_not_written_again() {
        for asked in [true, false] {
            let (settled, written) = settle(
                Want::Set {
                    address: "https://a.example",
                    asked,
                },
                json!({"sign_in_address": "https://a.example"}),
            );
            assert_eq!(settled, Settled::Unchanged);
            assert!(written.is_empty());
        }
    }

    #[test]
    fn a_different_address_moves_only_when_it_was_asked_for() {
        let held = json!({"sign_in_address": "https://b.example"});
        let want = |asked| Want::Set {
            address: "https://a.example",
            asked,
        };
        let (settled, written) = settle(want(true), held.clone());
        assert_eq!(settled, Settled::Set);
        assert_eq!(written, vec![change_body("https://a.example")]);
        let (settled, written) = settle(want(false), held);
        assert_eq!(
            settled,
            Settled::Left {
                held: "https://b.example".into()
            }
        );
        assert!(written.is_empty());
    }

    #[test]
    fn asking_for_no_address_removes_the_one_the_server_holds() {
        let held = json!({"sign_in_address": "https://b.example"});
        let (settled, written) = settle(Want::Clear { asked: true }, held.clone());
        assert_eq!(settled, Settled::Cleared);
        assert_eq!(written, vec![clear_body()]);
        let (settled, written) = settle(Want::Clear { asked: false }, held);
        assert!(matches!(settled, Settled::Left { .. }) && written.is_empty());
        for asked in [true, false] {
            let (settled, written) = settle(Want::Clear { asked }, json!({}));
            assert_eq!(settled, Settled::Unchanged);
            assert!(written.is_empty());
        }
    }

    #[test]
    fn a_refused_write_is_an_error() {
        let failed = settle_with(
            Want::Set {
                address: "https://a.example",
                asked: true,
            },
            || Ok(json!({})),
            |_| Err(CliError::Install("refused".into())),
        );
        assert!(failed.is_err());
    }

    #[test]
    fn the_body_confirms_the_move() {
        assert_eq!(
            change_body("https://a.example"),
            json!({"sign_in_address": "https://a.example", "confirm_sign_in_address_change": true})
        );
        assert_eq!(
            clear_body(),
            json!({"sign_in_address": null, "confirm_sign_in_address_change": true})
        );
        assert_eq!(
            stored(&json!({"sign_in_address": "https://a.example"})),
            Some("https://a.example")
        );
        assert_eq!(stored(&json!({"name": "x"})), None);
    }
}
