//! Signed links: an authorization's query, carried through the sign-in and
//! consent pages so that none of it can be changed on the way.

use std::collections::HashSet;

use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use url::form_urlencoded;

use super::scope::ScopeSet;
use crate::app::refusal::{Refusal, Result};

const SIG: &str = "sig";
const EXP: &str = "exp";
const SCOPE: &str = "scope";

/// RFC 8707 lets a request name several audiences. RFC 6749 section 3.1 lets
/// no other parameter repeat, and two readers of a repeat can each take a
/// different value.
const MAY_REPEAT: &str = "resource";

/// The sign-in page adds where to go next beside a link it was given.
const UNSIGNED: &str = "return_to";

/// Keeps a signature made here from meaning anything to whatever else uses
/// the instance's secret.
const CONTEXT: &str = "marfa-signed-link\n";

/// The parameters of a link, in order.
pub type Params = Vec<(String, String)>;

/// Why a link is not honored. The pages say different things for each, so an
/// edited link must never read as a merely old one.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refused {
    /// `keys-and-oauth/link-unverified`: not ours, or edited.
    Unverified,
    /// `keys-and-oauth/link-expired`: ours, unedited, and too old.
    Expired,
}

/// A link that passed: its signed parameters, without `sig`, `exp` or any
/// parameter added after signing, and when it ends. Read the authorization
/// from here and never from the query again.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Verified {
    pub params: Params,
    pub exp: i64,
}

impl Verified {
    /// The one value of a parameter. A parameter with two has none.
    pub fn get(&self, name: &str) -> Option<&str> {
        match self
            .params
            .iter()
            .filter(|(key, _)| key == name)
            .collect::<Vec<_>>()[..]
        {
            [(_, value)] => Some(value),
            _ => None,
        }
    }

    /// Every value of a parameter a link may repeat.
    pub fn values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
        self.params
            .iter()
            .filter(move |(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Whether a parameter other than `resource` appears twice.
pub fn has_repeat(params: &[(String, String)]) -> bool {
    let mut seen = HashSet::new();
    params
        .iter()
        .any(|(key, _)| key != MAY_REPEAT && !seen.insert(key.as_str()))
}

fn serialize<'a>(params: impl IntoIterator<Item = &'a (String, String)>) -> String {
    let mut out = form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        out.append_pair(key, value);
    }
    out.finish()
}

/// Sorted, so that a proxy reordering a query breaks nothing.
fn signature(params: &[(String, String)], secret: &str) -> Result<String> {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| Refusal::internal("the link signature refused its secret"))?;
    mac.update(CONTEXT.as_bytes());
    mac.update(serialize(sorted).as_bytes());
    Ok(BASE64_URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// The query of a link good until `exp`, in seconds since the epoch. A
/// parameter named `sig`, `exp` or `return_to` among `params` is left out.
pub fn sign(params: &[(String, String)], exp: i64, secret: &str) -> Result<String> {
    let mut signed: Params = params
        .iter()
        .filter(|(key, _)| ![SIG, EXP, UNSIGNED].contains(&key.as_str()))
        .cloned()
        .collect();
    if has_repeat(&signed) {
        return Err(Refusal::validation("A link names a parameter twice."));
    }
    signed.push((EXP.to_string(), exp.to_string()));
    let sig = signature(&signed, secret)?;
    signed.push((SIG.to_string(), sig));
    Ok(serialize(&signed))
}

/// Judge a link's query at `now`, in seconds since the epoch.
///
/// The signature comes first: a link edited to look expired reads as edited,
/// not as old, and nothing about its `exp` is trusted before then.
pub fn verify(query: &str, now: i64, secret: &str) -> std::result::Result<Verified, Refused> {
    let mut sigs = Vec::new();
    let mut signed = Params::new();
    for (key, value) in form_urlencoded::parse(query.as_bytes()).into_owned() {
        match key.as_str() {
            SIG => sigs.push(value),
            UNSIGNED => {}
            _ => signed.push((key, value)),
        }
    }
    let [sig] = sigs.as_slice() else {
        return Err(Refused::Unverified);
    };
    let expected = signature(&signed, secret).map_err(|_| Refused::Unverified)?;
    if !bool::from(expected.as_bytes().ct_eq(sig.as_bytes())) {
        return Err(Refused::Unverified);
    }
    if has_repeat(&signed) {
        return Err(Refused::Unverified);
    }
    let Some((_, exp)) = signed.iter().find(|(key, _)| key == EXP) else {
        return Err(Refused::Unverified);
    };
    let exp: i64 = exp.parse().map_err(|_| Refused::Unverified)?;
    if exp < now {
        return Err(Refused::Expired);
    }
    signed.retain(|(key, _)| key != EXP);
    Ok(Verified {
        params: signed,
        exp,
    })
}

/// The same link naming `scopes` in place of what it named, good until the
/// same moment. The caller has already held `scopes` to what the link allows
/// (`scope::chosen_within`): nothing here widens or checks them.
pub fn with_scope(link: &Verified, scopes: &ScopeSet, secret: &str) -> Result<String> {
    let mut params: Params = link
        .params
        .iter()
        .filter(|(key, _)| key != SCOPE)
        .cloned()
        .collect();
    params.push((SCOPE.to_string(), scopes.to_text()));
    sign(&params, link.exp, secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const SECRET: &str = "a-secret-long-enough-for-the-test";
    const NOW: i64 = 1_800_000_000;

    fn params() -> Params {
        [
            ("client_id", "abc"),
            ("redirect_uri", "https://app.example/cb?x=1&y=2"),
            ("scope", "core.note:read offline_access"),
            ("state", "a b+c/d=e"),
            ("resource", "https://marfa.example/mcp"),
            ("resource", "https://marfa.example"),
        ]
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .to_vec()
    }

    fn link() -> String {
        sign(&params(), NOW + 600, SECRET).expect("a signature")
    }

    fn pairs(query: &str) -> Params {
        form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect()
    }

    #[test]
    fn a_link_verifies_and_carries_what_was_signed() {
        let verified = verify(&link(), NOW, SECRET).expect("verified");
        assert_eq!(verified.params, params());
        assert_eq!(verified.exp, NOW + 600);
        assert_eq!(verified.get("state"), Some("a b+c/d=e"));
        assert_eq!(verified.get("exp"), None);
        assert_eq!(verified.get("sig"), None);
        assert_eq!(verified.get("nothing"), None);
    }

    #[test]
    fn a_reordered_link_still_verifies() {
        let mut reordered = pairs(&link());
        reordered.reverse();
        assert!(verify(&serialize(&reordered), NOW, SECRET).is_ok());
    }

    #[test]
    fn return_to_rides_beside_the_signature() {
        let beside = format!("{}&return_to=%2Fauth%2Fauthorize", link());
        let verified = verify(&beside, NOW, SECRET).expect("verified");
        assert_eq!(verified.get("return_to"), None);
        assert_eq!(verified.params, params());
    }

    #[test]
    fn a_link_past_its_time_is_expired_and_at_its_last_second_is_not() {
        assert!(verify(&link(), NOW + 600, SECRET).is_ok());
        assert_eq!(verify(&link(), NOW + 601, SECRET), Err(Refused::Expired));
    }

    #[test]
    fn an_edited_link_is_unverified_even_where_it_reads_as_expired() {
        let edit = |name: &str, value: &str| {
            let changed: Params = pairs(&link())
                .into_iter()
                .map(|(key, old)| {
                    let new = if key == name { value.to_string() } else { old };
                    (key, new)
                })
                .collect();
            serialize(&changed)
        };
        for query in [
            edit("exp", &(NOW - 60).to_string()),
            edit("exp", &(NOW + 60_000).to_string()),
            edit("scope", "*:write"),
            edit("redirect_uri", "https://evil.example/cb"),
            edit("sig", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            edit("sig", ""),
        ] {
            assert_eq!(
                verify(&query, NOW, SECRET),
                Err(Refused::Unverified),
                "{query}"
            );
        }
    }

    #[test]
    fn a_forged_first_four_characters_are_unverified() {
        let mut forged = pairs(&link());
        for (key, value) in &mut forged {
            if key == "sig" {
                *value = format!("AAAA{}", &value[4..]);
            }
        }
        assert_eq!(
            verify(&serialize(&forged), NOW, SECRET),
            Err(Refused::Unverified)
        );
    }

    #[test]
    fn a_link_with_no_sig_two_sigs_or_an_added_parameter_is_unverified() {
        let good = link();
        let sig = pairs(&good)
            .into_iter()
            .find(|(key, _)| key == "sig")
            .expect("a sig")
            .1;
        let no_sig: Params = pairs(&good)
            .into_iter()
            .filter(|(k, _)| k != "sig")
            .collect();
        for query in [
            serialize(&no_sig),
            format!("{good}&sig={sig}"),
            format!("{good}&prompt=none"),
            format!("{good}&scope=keys.mint"),
            format!("{good}&exp={}", NOW + 9),
            String::new(),
        ] {
            assert_eq!(
                verify(&query, NOW, SECRET),
                Err(Refused::Unverified),
                "{query}"
            );
        }
    }

    #[test]
    fn a_repeated_parameter_other_than_resource_is_refused_on_both_sides() {
        let mut repeated = params();
        repeated.push(("state".to_string(), "another".to_string()));
        assert!(sign(&repeated, NOW + 600, SECRET).is_err());

        let exp = (EXP.to_string(), (NOW + 600).to_string());
        let mut signed = repeated.clone();
        signed.push(exp);
        let sig = signature(&signed, SECRET).expect("a signature");
        signed.push((SIG.to_string(), sig));
        assert_eq!(
            verify(&serialize(&signed), NOW, SECRET),
            Err(Refused::Unverified)
        );

        // The witness: the same forge with `resource` repeated verifies.
        let mut resources = params();
        resources.push((
            "resource".to_string(),
            "https://marfa.example/mcp/admin".to_string(),
        ));
        let query = sign(&resources, NOW + 600, SECRET).expect("a signature");
        let verified = verify(&query, NOW, SECRET).expect("verified");
        assert_eq!(verified.values("resource").count(), 3);
        assert_eq!(verified.get("resource"), None);
    }

    #[test]
    fn another_secret_verifies_nothing() {
        assert_eq!(
            verify(&link(), NOW, "another-secret"),
            Err(Refused::Unverified)
        );
    }

    #[test]
    fn a_signed_exp_that_is_no_number_is_unverified() {
        let mut signed = params();
        signed.push(("exp".to_string(), "soon".to_string()));
        let sig = signature(&signed, SECRET).expect("a signature");
        signed.push(("sig".to_string(), sig));
        assert_eq!(
            verify(&serialize(&signed), NOW, SECRET),
            Err(Refused::Unverified)
        );
    }

    #[test]
    fn signing_ignores_a_stale_sig_exp_and_return_to() {
        let mut stale = params();
        stale.extend(
            [("sig", "old"), ("exp", "1"), ("return_to", "/x")]
                .map(|(key, value)| (key.to_string(), value.to_string())),
        );
        let query = sign(&stale, NOW + 600, SECRET).expect("a signature");
        let verified = verify(&query, NOW, SECRET).expect("verified");
        assert_eq!(verified.params, params());
        assert_eq!(verified.exp, NOW + 600);
    }

    #[test]
    fn a_narrowing_signs_again_with_the_same_end() {
        let verified = verify(&link(), NOW, SECRET).expect("verified");
        let narrowed =
            with_scope(&verified, &ScopeSet::parse("core.note:read"), SECRET).expect("a signature");
        let again = verify(&narrowed, NOW, SECRET).expect("verified");
        assert_eq!(again.exp, verified.exp);
        assert_eq!(again.get("scope"), Some("core.note:read"));
        assert_eq!(again.get("client_id"), Some("abc"));
        assert_eq!(
            again
                .params
                .iter()
                .filter(|(key, _)| key == "scope")
                .count(),
            1
        );
    }

    proptest! {
        #[test]
        fn nothing_panics_on_any_text(query in any::<String>()) {
            prop_assert!(verify(&query, NOW, SECRET).is_err());
        }

        #[test]
        fn what_is_signed_comes_back_whatever_it_holds(
            pairs in proptest::collection::btree_map("[a-z_]{1,8}", any::<String>(), 0..6),
        ) {
            let params: Params = pairs
                .into_iter()
                .filter(|(key, _)| ![SIG, EXP, UNSIGNED].contains(&key.as_str()))
                .collect();
            let query = sign(&params, NOW, SECRET).expect("a signature");
            let verified = verify(&query, NOW, SECRET).expect("verified");
            prop_assert_eq!(verified.params, params);
        }

        #[test]
        fn changing_any_one_character_of_the_sig_fails(at in 0usize..43) {
            let query = link();
            let mut changed = pairs(&query);
            for (key, value) in &mut changed {
                if key == "sig" {
                    let mut bytes = value.clone().into_bytes();
                    bytes[at] = if bytes[at] == b'A' { b'B' } else { b'A' };
                    *value = String::from_utf8(bytes).expect("ascii");
                }
            }
            prop_assert_eq!(verify(&serialize(&changed), NOW, SECRET), Err(Refused::Unverified));
        }
    }
}
