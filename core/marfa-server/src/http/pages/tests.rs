use std::collections::HashSet;

use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

use super::*;

const HOSTILE: &str = "\"><img src=x onerror=alert(1)> & 'q'";

fn sign_in_view() -> SignIn {
    SignIn {
        instance_name: "Marfa".into(),
        email: String::new(),
        return_to: "/".into(),
        app: None,
        problem: None,
    }
}

/// The page without its script and style, which a person does not read.
fn without_code(page: &Page) -> String {
    let mut html = page.html().to_owned();
    for tag in ["script", "style"] {
        let open = format!("<{tag} nonce=");
        let close = format!("</{tag}>");
        let start = html.find(&open).unwrap();
        let end = html.find(&close).unwrap() + close.len();
        html.replace_range(start..end, "");
    }
    html
}

fn nonce_of(page: &Page) -> String {
    let policy = page.policy().to_str().unwrap();
    let script = policy
        .split("; ")
        .find_map(|part| part.strip_prefix("script-src 'nonce-"))
        .unwrap();
    script.trim_end_matches('\'').to_owned()
}

fn directive<'a>(policy: &'a str, name: &str) -> Option<&'a str> {
    policy
        .split("; ")
        .find_map(|part| part.strip_prefix(name)?.strip_prefix(' '))
}

#[test]
fn each_answer_carries_a_nonce_of_its_own_and_only_that_one() {
    let mut seen = HashSet::new();
    for _ in 0..20 {
        let page = sign_in(&sign_in_view()).unwrap();
        let nonce = nonce_of(&page);
        assert!(seen.insert(nonce.clone()), "a nonce came twice");
        let carried: HashSet<&str> = page
            .html()
            .split("nonce=\"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap())
            .collect();
        assert_eq!(carried, HashSet::from([nonce.as_str()]));
    }
}

#[test]
fn the_answer_carries_the_headers_a_page_needs() {
    let page = sign_in(&sign_in_view()).unwrap();
    let nonce = format!("'nonce-{}'", nonce_of(&page));
    let response = page.into_response();
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers();
    assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    let policy = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert_eq!(directive(policy, "default-src"), Some("'none'"));
    assert_eq!(directive(policy, "script-src"), Some(nonce.as_str()));
    assert_eq!(directive(policy, "style-src"), Some(nonce.as_str()));
    assert_eq!(directive(policy, "img-src"), Some("data:"));
    assert_eq!(directive(policy, "connect-src"), Some("'self'"));
    assert!(!policy.contains("unsafe-inline"));
}

#[test]
fn only_a_page_that_asks_the_server_for_something_may_connect() {
    let device = device_entry(&DeviceEntry {
        instance_name: "Marfa".into(),
        user_code: String::new(),
        problem: None,
    })
    .unwrap();
    assert_eq!(
        directive(device.policy().to_str().unwrap(), "connect-src"),
        None
    );
    let signed_in_with_dialog = document(
        "T",
        "Marfa",
        "",
        Needs {
            connect: false,
            confirm_dialog: true,
        },
    )
    .unwrap();
    assert_eq!(
        directive(
            signed_in_with_dialog.policy().to_str().unwrap(),
            "connect-src"
        ),
        Some("'self'")
    );
    assert!(signed_in_with_dialog.html().contains("Confirm it's you"));
    assert!(!device.html().contains("Confirm it's you"));
}

#[test]
fn a_hostile_value_is_text_in_text_and_in_an_attribute() {
    let page = sign_in(&SignIn {
        instance_name: HOSTILE.into(),
        email: HOSTILE.into(),
        return_to: HOSTILE.into(),
        app: Some(HOSTILE.into()),
        problem: None,
    })
    .unwrap();
    let html = page.html();
    assert!(!html.contains("<img"));
    assert!(!html.contains(HOSTILE));
    let escaped = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;q&#39;";
    assert!(html.contains(&format!("value=\"{escaped}\"")));
    assert!(html.contains(&format!("<bdi class=\"app-name\">{escaped}</bdi>")));
    assert!(html.contains(&format!("<header class=\"brand\">{escaped}</header>")));
}

#[test]
fn a_hostile_value_stays_text_on_every_other_page() {
    let pages = [
        setup_details(&SetupDetails {
            instance_name: HOSTILE.into(),
            name: HOSTILE.into(),
            email: HOSTILE.into(),
            errors: SetupFieldErrors {
                name: Some(HOSTILE.into()),
                email: Some(HOSTILE.into()),
                password: Some(HOSTILE.into()),
            },
            notice: Some(HOSTILE.into()),
        })
        .unwrap(),
        device_entry(&DeviceEntry {
            instance_name: HOSTILE.into(),
            user_code: HOSTILE.into(),
            problem: None,
        })
        .unwrap(),
        notice(&Notice::refusal("x", StatusCode::BAD_REQUEST, HOSTILE)).unwrap(),
        signed_in(&SignedIn {
            instance_name: HOSTILE.into(),
            email: HOSTILE.into(),
            continue_to: format!("/{HOSTILE}"),
        })
        .unwrap(),
    ];
    for page in pages {
        assert!(!page.html().contains("<img"), "{}", page.html());
        assert!(!page.html().contains("onerror=alert(1)>"));
    }
}

#[test]
fn a_continue_link_goes_only_to_a_path_on_the_instance() {
    for (given, link) in [
        ("/owner", "/owner"),
        ("/auth/authorize?a=1&b=2", "/auth/authorize?a=1&amp;b=2"),
        ("//evil.example", "/"),
        ("/\\evil.example", "/"),
        ("https://evil.example", "/"),
        ("javascript:alert(1)", "/"),
        ("/a\nb", "/"),
        ("", "/"),
    ] {
        let page = signed_in(&SignedIn {
            instance_name: "Marfa".into(),
            email: "owner@example.test".into(),
            continue_to: given.into(),
        })
        .unwrap();
        assert!(
            page.html()
                .contains(&format!("<a class=\"button primary\" href=\"{link}\">")),
            "{given:?}"
        );
    }
}

#[test]
fn a_wait_is_whole_minutes_rounded_up() {
    for (seconds, said) in [
        ("1", "1 minute"),
        ("60", "1 minute"),
        ("61", "2 minutes"),
        ("900", "15 minutes"),
        ("3599", "60 minutes"),
        ("86400", "1440 minutes"),
    ] {
        let wait = Wait::from_query(Some(seconds)).unwrap();
        assert_eq!(wait.to_string(), said, "{seconds}");
    }
    for refused in [
        "",
        "0",
        "86401",
        "-5",
        "+5",
        "1.5",
        "5s",
        " 5",
        "99999999999",
    ] {
        assert_eq!(Wait::from_query(Some(refused)), None, "{refused:?}");
    }
    assert_eq!(Wait::from_query(None), None);
}

#[test]
fn a_lockout_names_the_wait_only_when_it_was_given_one() {
    let locked = |retry_after| {
        sign_in(&SignIn {
            problem: SignInProblem::from_query(Some("too_many_attempts"), retry_after),
            ..sign_in_view()
        })
        .unwrap()
    };
    assert!(
        locked(Some("61"))
            .html()
            .contains("Try again in 2 minutes, or sign in with a passkey.")
    );
    let none = locked(None);
    assert!(none.html().contains("Too many attempts."));
    assert!(!without_code(&none).contains("minutes"));
    // The witness for the device page below: a wait given and ignored.
    assert!(!without_code(&locked(Some("0"))).contains("minute"));
}

#[test]
fn the_device_page_says_why_a_code_failed_and_how_long_codes_last() {
    let page = |problem| {
        device_entry(&DeviceEntry {
            instance_name: "Marfa".into(),
            user_code: String::new(),
            problem,
        })
        .unwrap()
    };
    let plain = page(None);
    assert!(plain.html().contains("Codes end after 10 minutes."));
    assert!(plain.html().contains("name=\"user_code\""));
    let wrong = page(DeviceProblem::from_query(Some("invalid_code"), None));
    assert!(wrong.html().contains(
        "That code isn&#39;t right or has expired. Check it against your device, or start again \
         there to get a new one."
    ));
    let expired = page(DeviceProblem::from_query(Some("expired_code"), None));
    assert!(expired.html().contains("That code has expired."));
    assert!(!expired.html().contains("right"));
    let locked = page(DeviceProblem::from_query(
        Some("too_many_attempts"),
        Some("61"),
    ));
    assert!(
        locked
            .html()
            .contains("Too many codes. Try again in 2 minutes.")
    );
    let locked_without_wait = page(DeviceProblem::from_query(Some("too_many_attempts"), None));
    assert!(locked_without_wait.html().contains("Too many codes."));
    assert!(!without_code(&locked_without_wait).contains("minute"));
}

#[test]
fn an_error_code_the_page_does_not_know_is_never_shown() {
    let page = sign_in(&SignIn {
        problem: SignInProblem::from_query(Some("<script>x</script>"), None),
        ..sign_in_view()
    })
    .unwrap();
    assert!(page.html().contains("Something went wrong."));
    assert!(!page.html().contains("<script>x"));
    assert_eq!(SignInProblem::from_query(None, None), None);
    assert_eq!(SignInProblem::from_query(Some(""), None), None);
}

#[test]
fn a_page_the_caller_gives_a_status_answers_with_it() {
    let response = notice(&Notice::refusal(
        "Marfa",
        StatusCode::NOT_FOUND,
        "Nothing here.",
    ))
    .unwrap()
    .into_response();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(
        response
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY)
    );
}
