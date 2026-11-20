//! A digest of stored fields that keeps each field apart from the next, and an absent field apart
//! from an empty one.

use sha2::{Digest, Sha256};

pub struct Fingerprint(Sha256);

impl Fingerprint {
    pub fn new(label: &str) -> Fingerprint {
        let mut fingerprint = Fingerprint(Sha256::new());
        fingerprint.text(label);
        fingerprint
    }

    pub fn text(&mut self, value: &str) -> &mut Fingerprint {
        self.0.update(b"s");
        self.0.update((value.len() as u64).to_be_bytes());
        self.0.update(value.as_bytes());
        self
    }

    pub fn maybe(&mut self, value: Option<&str>) -> &mut Fingerprint {
        match value {
            Some(value) => self.text(value),
            None => {
                self.0.update(b"n");
                self
            }
        }
    }

    pub fn number(&mut self, value: i64) -> &mut Fingerprint {
        self.0.update(b"i");
        self.0.update(value.to_be_bytes());
        self
    }

    pub fn flag(&mut self, value: bool) -> &mut Fingerprint {
        self.0.update(if value { b"t" } else { b"f" });
        self
    }

    pub fn finish(self) -> String {
        hex::encode(self.0.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(build: impl FnOnce(&mut Fingerprint)) -> String {
        let mut fingerprint = Fingerprint::new("test");
        build(&mut fingerprint);
        fingerprint.finish()
    }

    #[test]
    fn fields_are_kept_apart_and_an_absent_field_is_not_an_empty_one() {
        assert_ne!(
            of(|f| {
                f.text("ab").text("c");
            }),
            of(|f| {
                f.text("a").text("bc");
            })
        );
        assert_ne!(
            of(|f| {
                f.maybe(None);
            }),
            of(|f| {
                f.maybe(Some(""));
            })
        );
        assert_ne!(
            of(|f| {
                f.flag(true);
            }),
            of(|f| {
                f.flag(false);
            })
        );
        assert_eq!(
            of(|f| {
                f.text("a").number(1);
            }),
            of(|f| {
                f.text("a").number(1);
            })
        );
    }
}
