//! The two addresses an answered item carries, read once for a response.

/// The sign-in origin and the instance id a response stamps onto every item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Links {
    origin: String,
    instance_id: String,
}

impl Links {
    pub fn of(origin: &str, instance_id: &str) -> Links {
        Links {
            origin: origin.to_string(),
            instance_id: instance_id.to_string(),
        }
    }

    /// The item's page: the sign-in origin, `/i/`, then the item's id.
    pub fn url(&self, id: &str) -> String {
        format!("{}/i/{id}", self.origin)
    }

    /// `marfa://`, the instance's id, then the item's id.
    pub fn app_url(&self, id: &str) -> String {
        format!("marfa://{}/{id}", self.instance_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_value_names_every_item_from_the_same_origin() {
        let links = Links::of(
            "https://marfa.example",
            "01a1011e-87bd-7ab7-bbab-538453d75381",
        );
        assert_eq!(links.url("a"), "https://marfa.example/i/a");
        assert_eq!(links.url("b"), "https://marfa.example/i/b");
        assert_eq!(
            links.app_url("a"),
            "marfa://01a1011e-87bd-7ab7-bbab-538453d75381/a"
        );
        assert_eq!(
            links.app_url("b"),
            "marfa://01a1011e-87bd-7ab7-bbab-538453d75381/b"
        );
    }

    #[test]
    fn a_port_stays_and_the_instance_id_does_not_move_with_the_origin() {
        let links = Links::of("http://marfa.example:8600", "inst");
        assert_eq!(links.url("a"), "http://marfa.example:8600/i/a");
        let moved = Links::of("https://xn--bcher-kva.example", "inst");
        assert_eq!(moved.url("a"), "https://xn--bcher-kva.example/i/a");
        assert_eq!(moved.app_url("a"), links.app_url("a"));
    }
}
