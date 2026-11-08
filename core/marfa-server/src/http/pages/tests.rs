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
        authorization: None,
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
    assert_eq!(headers[header::REFERRER_POLICY], "same-origin");
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
        authorization: None,
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

#[tokio::test]
async fn a_page_over_a_refusal_keeps_its_status_and_drops_its_length() {
    let page = notice(&Notice::refusal(
        "Marfa",
        StatusCode::FORBIDDEN,
        "That is not allowed.",
    ))
    .unwrap();
    let mut response = Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, "2")
        .body(Body::from("{}"))
        .unwrap();
    page.write_over(&mut response);
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let headers = response.headers();
    assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert!(!headers.contains_key(header::CONTENT_LENGTH));
    assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("That is not allowed."));
}

#[test]
fn a_sign_in_refusal_links_to_sign_in_and_the_setup_notices_link_to_setup() {
    let refused = notice(&Notice::refusal("Marfa", StatusCode::UNAUTHORIZED, "No."))
        .unwrap()
        .html;
    assert!(refused.contains("/auth/sign-in"));
    let waiting = notice(&Notice::no_owner_yet("Marfa")).unwrap().html;
    assert!(waiting.contains("/setup"));
    let claimed = notice(&Notice::already_claimed("Marfa")).unwrap().html;
    assert!(!claimed.contains("href=\"/setup\""));
}

mod consent_pages {
    use super::*;
    use crate::app::access::Level;
    use crate::app::oauth::offer::{AppShown, Choice, Held, LevelRow, Offer, Power, Reach};

    fn row(reach: Reach, pattern: &str, label: Option<&str>, levels: &[(Level, &str)]) -> LevelRow {
        LevelRow {
            reach,
            pattern: pattern.into(),
            held: Level::None,
            choices: std::iter::once(Choice {
                level: Level::None,
                value: String::new(),
            })
            .chain(levels.iter().map(|(level, value)| Choice {
                level: *level,
                value: (*value).into(),
            }))
            .collect(),
            selected: levels.last().map(|(_, v)| (*v).into()).unwrap_or_default(),
            open_ended: pattern.contains('*'),
            types: Vec::new(),
            label: label.map(str::to_string),
            description: None,
            covers: Vec::new(),
        }
    }

    fn offer() -> Offer {
        Offer {
            app: AppShown {
                name: HOSTILE.into(),
                client_id: "client".into(),
                document_host: Some(HOSTILE.into()),
                destinations: vec![HOSTILE.into()],
                web_origins: vec![format!("https://{HOSTILE}")],
            },
            full_access_choice: true,
            data: vec![
                row(
                    Reach::Type,
                    "core.note",
                    Some(HOSTILE),
                    &[
                        (Level::Read, "core.note:read"),
                        (Level::Write, "core.note:write"),
                    ],
                ),
                {
                    let mut user =
                        row(Reach::Type, "user.*", None, &[(Level::Read, "user.*:read")]);
                    user.covers = vec![HOSTILE.into()];
                    user
                },
            ],
            profile: vec![row(
                Reach::Profile,
                "profile",
                None,
                &[(Level::Read, "profile:read")],
            )],
            powers: vec![
                Power {
                    literal: "items.purge".into(),
                    cannot_be_undone: true,
                },
                Power {
                    literal: "keys.mint".into(),
                    cannot_be_undone: false,
                },
            ],
            held: vec![Held {
                reach: Reach::Type,
                pattern: "core.task".into(),
                level: Level::Read,
                label: Some(HOSTILE.into()),
            }],
            held_powers: Vec::new(),
            mechanisms: vec!["offline_access".into()],
            confirm: true,
            offers_edit: true,
            returning: true,
        }
    }

    fn page_of(answering: Answering, offer: Offer) -> Page {
        consent(&Consent {
            instance_name: HOSTILE.into(),
            offer,
            answering,
        })
        .unwrap()
    }

    #[test]
    fn nothing_from_an_app_or_a_registry_is_markup() {
        for answering in [
            Answering::Authorization(HOSTILE.into()),
            Answering::Device(HOSTILE.into()),
        ] {
            let page = page_of(answering, offer());
            let html = without_code(&page);
            assert!(!html.contains("<img"), "{html}");
            assert!(!html.contains("onerror=alert(1)>"), "{html}");
            assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        }
    }

    #[test]
    fn both_pages_say_a_grant_in_the_same_words() {
        let body = |answering| {
            let html = without_code(&page_of(answering, offer()));
            let from = html.find("<h1>").unwrap();
            let to = html.find("<form").unwrap();
            let after = html.find("</form>").unwrap();
            // Past the code line and the form's own fields, the words are one.
            let words = html[from..to].replace('\n', " ");
            let mut form = html[to..after].to_owned();
            // The device's own check sits beside Approve; the rest is shared.
            if let (Some(start), Some(end)) = (
                form.find("<section class=\"device-check\""),
                form.find("</section>"),
            ) {
                form.replace_range(start..end + "</section>\n".len(), "");
            }
            let rest = form
                .lines()
                .filter(|line| !line.starts_with("<form") && !line.contains("type=\"hidden\""))
                .filter(|line| !line.starts_with("<button"))
                .collect::<Vec<_>>()
                .join("\n");
            (words, rest)
        };
        let (browser_head, browser_rest) = body(Answering::Authorization("q".into()));
        let (device_head, device_rest) = body(Answering::Device("q".into()));
        assert_eq!(browser_rest, device_rest);
        assert!(device_head.contains("An app on another device is asking"));
        assert!(!browser_head.contains("another device"));
    }

    #[test]
    fn the_device_page_shows_its_code_and_warns_beside_approve() {
        let device = without_code(&page_of(Answering::Device("ABCD2345".into()), offer()));
        let check = device.find("class=\"device-check\"").unwrap();
        let approve = device.find("class=\"actions\"").unwrap();
        assert!(check < approve);
        let block = &device[check..approve];
        assert!(block.contains("ABCD-2345"), "{block}");
        assert!(block.contains("same code is showing on a device you are holding"));
        assert!(block.contains("Don't approve a link or code that someone sent you."));
        let browser = without_code(&page_of(Answering::Authorization("q".into()), offer()));
        assert!(!browser.contains("device-check"));
    }

    #[test]
    fn choices_are_controls_and_powers_are_switches_that_start_off() {
        let html = without_code(&page_of(Answering::Authorization("q".into()), offer()))
            .replace("&#39;", "'");
        assert!(html.contains("name=\"access\" value=\"full\" checked"));
        assert!(html.contains("name=\"access\" value=\"choose\">"));
        assert!(html.contains("role=\"switch\""));
        assert!(!html.contains(
            "role=\"switch\" id=\"power-0\" name=\"scopes\" value=\"items.purge\" checked"
        ));
        // The powers keep the order every page lists them in.
        assert!(html.find("keys.mint").unwrap() < html.find("items.purge").unwrap());
        assert!(html.contains("Can't be undone: delete items in the trash for good"));
        assert!(html.contains("Changes like this need a sign-in from the last 5 minutes."));
    }

    #[test]
    fn a_page_with_nothing_to_choose_offers_no_choice_of_access() {
        let mut view = offer();
        view.full_access_choice = false;
        view.powers.clear();
        view.confirm = false;
        let html = without_code(&page_of(Answering::Authorization("q".into()), view));
        assert!(!html.contains("name=\"access\""));
        assert!(!html.contains("Choose access"));
        assert!(!html.contains("Confirm it's you"));
        assert!(!html.contains("5 minutes"));
    }

    #[test]
    fn the_page_may_post_its_own_form_and_runs_no_markup_of_an_app() {
        let page = page_of(Answering::Authorization("q".into()), offer());
        let policy = page.policy().to_str().unwrap();
        assert_eq!(directive(policy, "connect-src"), Some("'self'"));
        assert_eq!(directive(policy, "img-src"), Some("data:"));
        assert_eq!(directive(policy, "form-action"), None);
    }
}
