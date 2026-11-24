use std::collections::HashSet;

use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

use super::*;

const HOSTILE: &str = "\"><img src=x onerror=alert(1)> & 'q'";

fn sign_in_view() -> SignIn {
    SignIn {
        username: String::new(),
        return_to: "/".into(),
        authorization: None,
        app: None,
        app_address: None,
        problem: None,
        recovered: false,
        passkey: false,
    }
}

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
        "",
        Needs {
            connect: false,
            confirm_dialog: Some("Enter your password to continue."),
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
    assert!(
        signed_in_with_dialog
            .html()
            .contains("Confirm it&#39;s you")
    );
    assert!(!device.html().contains("Confirm it&#39;s you"));
}

#[test]
fn a_hostile_value_is_text_in_text_and_in_an_attribute() {
    let page = sign_in(&SignIn {
        username: HOSTILE.into(),
        return_to: HOSTILE.into(),
        authorization: None,
        app: Some(HOSTILE.into()),
        app_address: Some(HOSTILE.into()),
        problem: None,
        recovered: false,
        passkey: false,
    })
    .unwrap();
    let html = page.html();
    assert!(!html.contains("<img"));
    assert!(!html.contains(HOSTILE));
    let escaped = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;q&#39;";
    assert!(html.contains(&format!("value=\"{escaped}\"")));
    assert!(html.contains(&format!("<bdi>{escaped}</bdi> (unverified, {escaped})")));
}

#[test]
fn a_hostile_value_stays_text_on_every_other_page() {
    let pages = [
        setup_details(&SetupDetails {
            name: HOSTILE.into(),
            username: HOSTILE.into(),
            errors: SetupFieldErrors {
                name: Some(HOSTILE.into()),
                username: Some(HOSTILE.into()),
                password: Some(HOSTILE.into()),
            },
            notice: Some(HOSTILE.into()),
            return_to: HOSTILE.into(),
        })
        .unwrap(),
        setup_code(&SetupCode {
            problem: None,
            return_to: HOSTILE.into(),
            app: Some(AskingApp {
                name: HOSTILE.into(),
                host: HOSTILE.into(),
            }),
        })
        .unwrap(),
        notice(&Notice::already_claimed(HOSTILE)).unwrap(),
        notice(&Notice::opening_item(HOSTILE)).unwrap(),
        notice(&Notice::not_an_item_link()).unwrap(),
        device_entry(&DeviceEntry {
            user_code: HOSTILE.into(),
            problem: None,
        })
        .unwrap(),
        notice(&Notice::refusal(StatusCode::BAD_REQUEST, HOSTILE)).unwrap(),
        signed_in(&SignedIn {
            username: HOSTILE.into(),
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
        ("/auth/consent?a=1&b=2", "/auth/consent?a=1&amp;b=2"),
        ("//evil.example", "/"),
        ("/\\evil.example", "/"),
        ("https://evil.example", "/"),
        ("javascript:alert(1)", "/"),
        ("/a\nb", "/"),
        ("", "/"),
    ] {
        let page = signed_in(&SignedIn {
            username: "owner".into(),
            continue_to: given.into(),
        })
        .unwrap();
        assert!(
            page.html()
                .contains(&format!("<a class=\"btn primary\" href=\"{link}\">")),
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
            problem: SignInProblem::from_query(Some("too_many_attempts"), retry_after, &[]),
            ..sign_in_view()
        })
        .unwrap()
    };
    assert!(
        locked(Some("61"))
            .html()
            .contains("Try again in 2 minutes.")
    );
    let none = locked(None);
    assert!(without_code(&none).contains("Too many attempts."));
    assert!(!without_code(&none).contains("minutes"));
    assert!(!without_code(&locked(Some("0"))).contains("minute"));
}

#[test]
fn a_passkey_is_offered_and_named_in_a_lockout_only_to_an_owner_who_has_one() {
    let page = |passkey, problem| {
        sign_in(&SignIn {
            problem: SignInProblem::from_query(problem, Some("61"), &[]),
            passkey,
            ..sign_in_view()
        })
        .unwrap()
    };
    let with = page(true, Some("too_many_attempts"));
    assert!(with.html().contains("data-passkey=\"sign-in\""));
    // The advice is hidden until the script that shows the button shows it.
    assert!(without_code(&with).contains(
        "Try again in 2 minutes<span data-passkey-advice hidden>, or use a passkey</span>."
    ));
    assert!(
        !without_code(&page(true, Some("invalid_credentials"))).contains("data-passkey-advice")
    );
    assert!(!without_code(&page(true, None)).contains("data-passkey-advice"));
    assert!(
        SCRIPT.contains("querySelectorAll(\"[data-passkey-advice]\")"),
        "the script that shows the button shows the advice"
    );
    let without = page(false, Some("too_many_attempts"));
    assert!(!without_code(&without).contains("passkey"));
    assert!(without.html().contains("Try again in 2 minutes."));
    assert!(!without_code(&page(false, None)).contains("passkey"));
    assert!(without_code(&page(true, None)).contains("data-passkey=\"sign-in\""));
}

#[test]
fn the_device_page_says_why_a_code_failed_and_how_long_codes_last() {
    let page = |problem| {
        device_entry(&DeviceEntry {
            user_code: String::new(),
            problem,
        })
        .unwrap()
    };
    let plain = page(None);
    assert!(plain.html().contains("A code lasts 10 minutes."));
    assert!(plain.html().contains("name=\"user_code\""));
    assert!(!without_code(&plain).contains("aria-invalid"));
    let wrong = page(DeviceProblem::from_query(Some("invalid_code"), None));
    assert!(
        wrong
            .html()
            .contains("That code isn’t right or has expired. Check your device.")
    );
    assert!(wrong.html().contains("class=\"code bad\""));
    assert!(wrong.html().contains("aria-invalid=\"true\""));
    let expired = page(DeviceProblem::from_query(Some("expired_code"), None));
    assert!(
        expired
            .html()
            .contains("That code has expired. Start again on your device.")
    );
    assert!(!without_code(&expired).contains("isn’t right"));
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
fn the_code_is_one_field_and_the_check_shows_it_to_compare() {
    let entry = device_entry(&DeviceEntry {
        user_code: "wdjb mjht".into(),
        problem: DeviceProblem::from_query(Some("invalid_code"), None),
    })
    .unwrap();
    let html = entry.html();
    assert_eq!(html.matches("<input").count(), 1, "{html}");
    assert!(html.contains("value=\"wdjb mjht\""));
    assert!(html.contains("aria-describedby=\"code-note\""));
    assert!(html.contains("<p class=\"err\" id=\"code-note\""));

    let check = device_check(&DeviceCheck {
        user_code: "WDJBMJHT".into(),
        typed: "wdjb-mjht".into(),
    })
    .unwrap();
    let html = check.html();
    assert!(html.contains("<h1>Check the code</h1>"));
    assert!(html.contains("It should match the code on your device."));
    assert!(html.contains("<span class=\"said\">WDJB-MJHT</span>"));
    let cells = html.matches("<span class=\"cell\">").count();
    assert_eq!(cells, 8, "{html}");
    assert!(html.contains(
        "<span class=\"cell\">B</span><span class=\"dash\"></span><span class=\"cell\">M</span>"
    ));
    assert!(html.contains("Don’t continue if someone sent you this code."));
    assert!(html.contains("<input type=\"hidden\" name=\"user_code\" value=\"wdjb-mjht\">"));
    assert!(html.contains("action=\"/auth/device/check\""));
    assert!(html.contains("<a class=\"btn\" href=\"/auth/device\">Cancel</a>"));
    assert!(html.contains("class=\"btn primary\">It Matches</button>"));
}

#[test]
fn an_error_code_the_page_does_not_know_is_never_shown() {
    let page = sign_in(&SignIn {
        problem: SignInProblem::from_query(Some("<script>x</script>"), None, &[]),
        ..sign_in_view()
    })
    .unwrap();
    assert!(page.html().contains("Something went wrong."));
    assert!(!page.html().contains("<script>x"));
    assert_eq!(SignInProblem::from_query(None, None, &[]), None);
    assert_eq!(SignInProblem::from_query(Some(""), None, &[]), None);
}

#[test]
fn a_specific_refusal_keeps_its_words_and_only_the_generic_ones_are_drawn() {
    let specific = [
        (StatusCode::NOT_FOUND, "This resource is not served here."),
        (StatusCode::INSUFFICIENT_STORAGE, "The disk is full."),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "The change may have completed. Read the item again before trying again.",
        ),
    ];
    for (status, words) in specific {
        let page = notice(&Notice::refusal(status, words)).unwrap();
        assert!(page.html().contains(words), "{status}");
        assert!(!page.html().contains("Check the address"), "{status}");
        assert!(!page.html().contains("Marfa couldn’t continue"), "{status}");
    }
    let missing = notice(&Notice::missing_page()).unwrap();
    assert!(missing.html().contains("There’s nothing here"));
    assert!(missing.html().contains("Check the address and try again."));
    let fault = notice(&Notice::fault()).unwrap();
    assert!(fault.html().contains("Marfa couldn’t continue."));
}

#[test]
fn a_page_the_caller_gives_a_status_answers_with_it() {
    let response = notice(&Notice::refusal(StatusCode::NOT_FOUND, "Nothing here."))
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
fn a_sign_in_refusal_and_the_claimed_notice_link_to_sign_in() {
    let refused = notice(&Notice::refusal(StatusCode::UNAUTHORIZED, "No."))
        .unwrap()
        .html;
    assert!(refused.contains("/auth/sign-in"));
    let claimed = notice(&Notice::already_claimed(
        "/oauth/authorize?client_id=a&state=b",
    ))
    .unwrap()
    .html;
    assert!(claimed.contains(
        "href=\"/auth/sign-in?return_to=%2Foauth%2Fauthorize%3Fclient_id%3Da%26state%3Db\""
    ));
    assert!(!claimed.contains("href=\"/setup\""));
}

fn code_page(return_to: &str, app: Option<AskingApp>) -> String {
    setup_code(&SetupCode {
        problem: None,
        return_to: return_to.into(),
        app,
    })
    .unwrap()
    .html
}

#[test]
fn the_setup_code_page_says_where_the_code_is_and_carries_return_to() {
    let plain = code_page("/", None);
    assert!(plain.contains("It’s in Marfa’s terminal, or its host’s log."));
    assert!(plain.contains("<input type=\"hidden\" name=\"return_to\" value=\"/\">"));
    assert!(!plain.contains("can connect"));
    let asked = code_page("/oauth/authorize?client_id=a", None);
    assert!(asked.contains("value=\"/oauth/authorize?client_id=a\""));
    assert!(asked.contains("Then the app can connect."));
    assert!(!asked.contains("unverified"));
    let device = code_page("/auth/device/check?user_code=ABCD-EFGH", None);
    assert!(device.contains("Then the app can connect."));
    let elsewhere = code_page("/oauth/authorized", None);
    assert!(!elsewhere.contains("can connect"));
}

#[test]
fn the_setup_code_page_names_an_app_only_beside_its_host() {
    let named = code_page(
        "/oauth/authorize?client_id=a",
        Some(AskingApp {
            name: "Notes".into(),
            host: "notes.example".into(),
        }),
    );
    assert!(named.contains("Then <bdi>Notes</bdi> (unverified, notes.example) can connect."));
    assert!(!named.contains("hasn't verified"));
}

#[test]
fn only_the_recovery_page_says_its_code_is_a_recovery_code() {
    let recovery = recovery_code(&RecoveryCode { problem: None }).unwrap().html;
    assert!(recovery.contains("Recovery code"));
    assert!(recovery.contains("<input type=\"hidden\" name=\"purpose\" value=\"recovery\">"));
    assert!(!recovery.contains("name=\"return_to\""));
    assert!(!code_page("/", None).contains("name=\"purpose\""));
}

#[test]
fn the_details_page_carries_return_to() {
    let details = setup_details(&SetupDetails {
        name: String::new(),
        username: String::new(),
        errors: SetupFieldErrors::default(),
        notice: None,
        return_to: "/auth/device/check?user_code=ABCD-EFGH".into(),
    })
    .unwrap()
    .html;
    assert!(details.contains("value=\"/auth/device/check?user_code=ABCD-EFGH\""));
}

fn details_page(errors: SetupFieldErrors) -> String {
    without_code(
        &setup_details(&SetupDetails {
            name: "Mira".into(),
            username: "mira".into(),
            errors,
            notice: None,
            return_to: "/".into(),
        })
        .unwrap(),
    )
}

/// The input tag of the field with this id.
fn input<'a>(html: &'a str, id: &str) -> &'a str {
    let start = html.find(&format!("<input id=\"{id}\"")).unwrap();
    &html[start..start + html[start..].find('>').unwrap()]
}

#[test]
fn the_details_page_has_two_groups_and_no_email_field() {
    let html = details_page(SetupFieldErrors::default());
    assert!(html.contains("<legend class=\"gh\">Profile</legend>"));
    assert!(html.contains("<legend class=\"gh\">Password</legend>"));
    assert!(html.contains("Name (optional)"));
    assert!(html.contains("You sign in with your username."));
    assert!(html.contains("At least 8 characters."));
    assert!(html.contains("name=\"confirm_password\""));
    assert!(!html.to_lowercase().contains("email"));
    for id in ["name", "username"] {
        assert!(input(&html, id).contains("aria-describedby=\"profile-note\""));
        assert!(!input(&html, id).contains("aria-invalid"));
    }
    for id in ["password", "confirm-password"] {
        assert!(input(&html, id).contains("aria-describedby=\"password-note\""));
    }
}

#[test]
fn a_problem_takes_the_hint_s_place_under_its_own_group_and_marks_its_own_field() {
    let username = details_page(SetupFieldErrors {
        username: Some("Use letters.".into()),
        ..SetupFieldErrors::default()
    });
    assert!(username.contains(
        "<p class=\"err\" id=\"profile-note\" role=\"alert\"><span>Use letters.</span></p>"
    ));
    assert!(!username.contains("You sign in with your username."));
    assert!(input(&username, "username").contains("aria-invalid=\"true\""));
    assert!(!input(&username, "name").contains("aria-invalid"));
    assert!(username.contains("At least 8 characters."));

    let passwords = details_page(SetupFieldErrors {
        password: Some("The passwords don’t match.".into()),
        ..SetupFieldErrors::default()
    });
    assert!(passwords.contains(
        "id=\"password-note\" role=\"alert\"><span>The passwords don’t match.</span></p>"
    ));
    assert!(!passwords.contains("At least 8 characters."));
    assert!(passwords.contains("You sign in with your username."));
    for id in ["password", "confirm-password"] {
        assert!(input(&passwords, id).contains("aria-invalid=\"true\""));
        assert!(
            !input(&passwords, id).contains("value="),
            "{id} comes back empty"
        );
    }
}

#[test]
fn a_wrong_password_marks_the_password_alone_and_keeps_the_username() {
    let page = |problem, username: &str, missing: &[&str]| {
        without_code(
            &sign_in(&SignIn {
                username: username.into(),
                problem: SignInProblem::from_query(Some(problem), None, missing),
                ..sign_in_view()
            })
            .unwrap(),
        )
    };
    let wrong = page("invalid_credentials", "mira", &[]);
    assert!(input(&wrong, "password").contains("aria-invalid=\"true\""));
    assert!(input(&wrong, "password").contains("aria-describedby=\"sign-in-problem\""));
    assert!(!input(&wrong, "username").contains("aria-invalid"));
    assert!(input(&wrong, "username").contains("value=\"mira\""));
    assert!(wrong.contains("That username or password isn’t right."));
    assert!(wrong.contains("href=\"/auth/forgot-password\">Forgot password?</a>"));

    for problem in ["too_many_attempts", "anything else"] {
        let line_only = page(problem, "mira", &[]);
        assert!(!line_only.contains("aria-invalid"), "{problem}");
        assert!(line_only.contains("class=\"btn primary\">Sign In</button>"));
        assert!(!line_only.contains("disabled"));
    }

    let both = page("missing_field", "", &["username", "password"]);
    assert!(input(&both, "username").contains("aria-invalid=\"true\""));
    assert!(input(&both, "password").contains("aria-invalid=\"true\""));
    assert!(both.contains("Enter your username and your password."));
    let password_only = page("missing_field", "mira", &["password"]);
    assert!(!input(&password_only, "username").contains("aria-invalid"));
    assert!(input(&password_only, "password").contains("aria-invalid=\"true\""));
    let username_only = page("missing_field", "", &["username"]);
    assert!(input(&username_only, "username").contains("aria-invalid=\"true\""));
    assert!(!input(&username_only, "password").contains("aria-invalid"));
    let unnamed = page("missing_field", "", &[]);
    assert!(!unnamed.contains("aria-invalid"));
    assert!(unnamed.contains("Enter your username and your password."));
}

#[test]
fn a_form_that_may_be_sent_empty_is_never_stopped_by_the_browser() {
    let sign_in = without_code(&sign_in(&sign_in_view()).unwrap());
    let setup = without_code(
        &setup_code(&SetupCode {
            problem: None,
            return_to: "/".into(),
            app: None,
        })
        .unwrap(),
    );
    let recovery = without_code(&recovery_code(&RecoveryCode { problem: None }).unwrap());
    for (page, field) in [(sign_in, "username"), (setup, "code"), (recovery, "code")] {
        let form = &page[page.find("<form").unwrap()..];
        let tag = &form[..form.find('>').unwrap()];
        assert!(tag.contains(" novalidate"), "{tag}");
        assert!(
            input(&page, field).contains(" required"),
            "{field} keeps its attribute"
        );
    }
}

#[test]
fn a_wrong_recovery_code_may_have_been_used_or_have_expired() {
    let recovery = recovery_code(&RecoveryCode {
        problem: Some(SetupCodeProblem::WrongCode),
    })
    .unwrap()
    .html;
    assert!(recovery.contains("That code isn’t right, or it was used or has expired."));
    let setup = setup_code(&SetupCode {
        problem: Some(SetupCodeProblem::WrongCode),
        return_to: "/".into(),
        app: None,
    })
    .unwrap()
    .html;
    assert!(setup.contains("That code isn’t right. Use the newest code Marfa printed."));
}

#[test]
fn the_forgot_password_page_names_both_ways_and_never_prints_a_path() {
    let page = forgot_password().unwrap();
    let html = without_code(&page);
    assert!(html.contains("marfa --socket PATH owner recover"));
    assert!(html.contains("MARFA_OWNER_RECOVERY=true"));
    assert!(html.contains("href=\"/setup\">Enter Recovery Code</a>"));
    assert!(!html.contains(".sock"));
    assert!(!html.contains("/run/"));
    assert_eq!(
        directive(page.policy().to_str().unwrap(), "connect-src"),
        None
    );
}

mod consent_pages {
    use super::*;
    use crate::app::access::{Level, Permission};
    use crate::app::oauth::offer::{
        Admin, AdminLevel, AppShown, CHOOSE_TYPES, Choice, Held, LevelRow, Offer, Post, Reach,
    };

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
            yes_or_no: reach == Reach::Profile && levels.len() == 1,
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
            asks_new: true,
            fingerprint: "seen".into(),
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
            admin: Some(Admin {
                powers: vec![Permission::ItemsPurge, Permission::KeysMint],
                levels: vec![AdminLevel::Full, AdminLevel::None, AdminLevel::Custom],
            }),
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
            offer,
            answering,
            again: None,
        })
        .unwrap()
    }

    fn drawn_again(offer: Offer, posted: Post) -> String {
        without_code(
            &consent(&Consent {
                offer,
                answering: Answering::Authorization("q".into()),
                again: Some(posted),
            })
            .unwrap(),
        )
        .replace("&#39;", "'")
    }

    fn values(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn a_page_drawn_again_opens_its_choices_where_the_post_left_them() {
        let first = without_code(&page_of(Answering::Authorization("q".into()), offer()))
            .replace("&#39;", "'");
        assert!(first.contains("<details class=\"choose\">"));
        assert_eq!(
            options_of(&first, "admin"),
            ["<option value=\"full\" selected>Full Access</option>\
              <option value=\"none\">No Access</option>\
              <option value=\"custom\">Custom…</option>"]
        );
        let html = drawn_again(
            offer(),
            Post {
                held: "before".into(),
                scopes: values(&["core.note:read", "", "offline_access"]),
                types: Vec::new(),
                admin: Some("custom".into()),
                powers: values(&["", "items.purge"]),
            },
        );
        assert!(html.contains("<details class=\"choose\" open>"), "{html}");
        let scopes = options_of(&html, "scopes");
        assert_eq!(
            scopes[0],
            "<option value=\"core.note:write\">Read and Edit</option>\
             <option value=\"core.note:read\" selected>Read Only</option>\
             <option value=\"\">No Access</option>"
        );
        for at in [1, 2] {
            assert!(
                scopes[at].contains("<option value=\"\" selected>"),
                "{}",
                scopes[at]
            );
        }
        assert_eq!(
            options_of(&html, "admin"),
            ["<option value=\"full\">Full Access</option>\
              <option value=\"none\">No Access</option>\
              <option value=\"custom\" selected>Custom…</option>"]
        );
        assert_eq!(
            options_of(&html, "powers"),
            [
                "<option value=\"keys.mint\">Allow</option>\
                 <option value=\"\" selected>Don't Allow</option>",
                "<option value=\"items.purge\" selected>Allow</option>\
                 <option value=\"\">Don't Allow</option>",
            ]
        );
    }

    #[test]
    fn a_page_drawn_again_starts_what_the_post_did_not_choose_at_the_least() {
        let mut wide = offer();
        wide.data[1].types = vec![row(
            Reach::Type,
            "core.bookmark",
            None,
            &[(Level::Read, "core.bookmark:read")],
        )];
        let html = drawn_again(
            wide.clone(),
            Post {
                held: "before".into(),
                scopes: values(&["core.note:write", CHOOSE_TYPES]),
                types: values(&["core.bookmark:read"]),
                admin: Some("limited".into()),
                powers: Vec::new(),
            },
        );
        let scopes = options_of(&html, "scopes");
        assert!(
            scopes[0].contains("value=\"core.note:write\" selected"),
            "{}",
            scopes[0]
        );
        assert!(scopes[1].contains(&format!("value=\"{CHOOSE_TYPES}\" selected")));
        assert!(options_of(&html, "types")[0].contains("value=\"core.bookmark:read\" selected"));
        assert!(options_of(&html, "admin")[0].contains("value=\"none\" selected"));
        let unsaid = drawn_again(
            wide,
            Post {
                held: "before".into(),
                ..Post::default()
            },
        );
        for (name, at) in [("scopes", 0), ("scopes", 1), ("types", 0), ("powers", 0)] {
            assert!(
                options_of(&unsaid, name)[at].contains("<option value=\"\" selected>"),
                "{name} {at}: {unsaid}"
            );
        }
        assert!(options_of(&unsaid, "admin")[0].contains("value=\"none\" selected"));
    }

    #[test]
    fn rows_under_a_level_say_without_scripts_which_level_counts_them_after_the_rows() {
        let mut wide = offer();
        wide.data[1].types = vec![
            row(
                Reach::Type,
                "core.bookmark",
                None,
                &[(Level::Read, "core.bookmark:read")],
            ),
            row(
                Reach::Type,
                "core.link",
                None,
                &[(Level::Read, "core.link:read")],
            ),
        ];
        let html = without_code(&page_of(Answering::Authorization("q".into()), wide));
        let line = |words: &str| {
            format!("<li class=\"sub hint without-script\"><span class=\"t\">{words}</span></li>")
        };
        let types = html
            .find(&line(
                "These count when Your custom types is set to Each Type.",
            ))
            .unwrap();
        let last_type = html.rfind("name=\"types\" aria-label=").unwrap();
        assert!(last_type < types, "{html}");
        let powers = html
            .find(&line(
                "These count when Settings, keys and more is set to Custom.",
            ))
            .unwrap();
        let last_power = html.rfind("name=\"powers\" aria-label=").unwrap();
        assert!(last_power < powers, "{html}");
        assert!(include_str!("assets/page.css").contains(".js .without-script"));
    }

    #[test]
    fn the_line_under_the_items_names_the_levels_that_reach_types_added_later() {
        let mut wide = offer();
        wide.data[1].types = vec![row(
            Reach::Type,
            "core.bookmark",
            None,
            &[(Level::Read, "core.bookmark:read")],
        )];
        let html = without_code(&page_of(Answering::Authorization("q".into()), wide.clone()));
        // The sentence for scripts shows only at the levels that grant, never at No Access.
        assert!(
            html.contains("data-shown-at=\"user.*:read\">Types added later are included.</span>")
        );
        assert!(html.contains(&format!(
            "data-shown-at=\"{CHOOSE_TYPES}\">Types added later aren&#39;t included."
        )));
        assert!(html.contains(
            "<span class=\"without-script\">Read Only includes types added later. Each Type does not.</span>"
        ));
        assert!(!html.contains("unless Each Type"));
        // Two levels are offered, and both are named.
        wide.data[1].choices.push(Choice {
            level: Level::Write,
            value: "user.*:write".into(),
        });
        let both = without_code(&page_of(Answering::Authorization("q".into()), wide.clone()));
        assert!(both.contains(
            "Read Only and Read and Edit include types added later. Each Type does not."
        ));
        assert!(both.contains("data-shown-at=\"user.*:read|user.*:write\""));
        // An app that holds the read already is at it when it keeps the held choice.
        wide.data[1].held = Level::Read;
        wide.data[1].choices[0].level = Level::Read;
        let held = without_code(&page_of(Answering::Authorization("q".into()), wide));
        assert!(
            held.contains("data-shown-at=\"|user.*:read|user.*:write\">Types added later are"),
            "{held}"
        );
    }

    #[test]
    fn limited_is_defined_without_scripts_wherever_it_is_offered() {
        let mut limited = offer();
        limited.admin = Some(Admin {
            powers: vec![Permission::InstanceRead, Permission::KeysMint],
            levels: vec![
                AdminLevel::Full,
                AdminLevel::Limited,
                AdminLevel::None,
                AdminLevel::Custom,
            ],
        });
        let html = without_code(&page_of(Answering::Authorization("q".into()), limited));
        assert!(html.contains(
            "<span class=\"without-script\">Limited lets the app only see server health.</span>"
        ));
        // The witness: where Limited is not offered, nothing defines it.
        let plain = without_code(&page_of(Answering::Authorization("q".into()), offer()));
        assert!(!plain.contains("Limited lets"));
    }

    #[test]
    fn a_page_drawn_again_keeps_what_the_app_already_holds_beside_the_open_choices() {
        let html = drawn_again(offer(), Post::default());
        let held = html.find("<h2>Already allowed</h2>").unwrap();
        let choose = html.find("<details class=\"choose\" open>").unwrap();
        assert!(held < choose, "{html}");
        let css = include_str!("assets/page.css");
        assert!(css.contains(".consent:has(.choose[open]) .glance {"));
        assert!(!css.contains(".already"));
    }

    #[test]
    fn the_form_posts_the_held_access_it_was_drawn_on() {
        let html = without_code(&page_of(Answering::Device("q".into()), offer()));
        assert!(html.contains("<input type=\"hidden\" name=\"held\" value=\"seen\">"));
    }

    #[test]
    fn a_page_drawn_again_after_access_changed_says_so() {
        let line = "This app's access changed after this page opened.";
        let quiet = without_code(&page_of(Answering::Authorization("q".into()), offer()));
        assert!(!quiet.contains(line));
        let changed = drawn_again(offer(), Post::default());
        assert!(changed.contains(line.replace("&#39;", "'").as_str()));
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
            let words = html[from..to].replace('\n', " ");
            let rest = html[to..after]
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
        assert!(device_head.contains("Allow this device?"));
        assert!(!browser_head.contains("Allow this device?"));
    }

    #[test]
    fn the_device_page_carries_its_code_and_shows_no_second_check_of_it() {
        let device = without_code(&page_of(Answering::Device("ABCD2345".into()), offer()));
        // The witness: the page has the code to post, and does not draw it.
        assert!(device.contains("<input type=\"hidden\" name=\"user_code\" value=\"ABCD2345\">"));
        assert!(!device.contains("Check the code"), "{device}");
        assert!(!device.contains("ABCD-2345"), "{device}");
    }

    fn options_of<'a>(html: &'a str, name: &str) -> Vec<&'a str> {
        html.match_indices(&format!("name=\"{name}\" aria-label="))
            .map(|(at, _)| {
                let from = at + html[at..].find('>').unwrap() + 1;
                &html[from..from + html[from..].find("</select>").unwrap()]
            })
            .collect()
    }

    #[test]
    fn admin_is_one_level_starting_at_full_access_with_custom_rows_at_allow() {
        let html = without_code(&page_of(Answering::Authorization("q".into()), offer()))
            .replace("&#39;", "'");
        let choose = html
            .find("<details class=\"choose\">\n<summary class=\"btn\">Choose…</summary>")
            .unwrap();
        assert!(html[choose..].contains("name=\"admin\""));
        assert!(!html.contains("name=\"access\""));
        assert_eq!(
            options_of(&html, "admin"),
            ["<option value=\"full\" selected>Full Access</option>\
              <option value=\"none\">No Access</option>\
              <option value=\"custom\">Custom…</option>"]
        );
        assert_eq!(
            options_of(&html, "powers"),
            [
                "<option value=\"keys.mint\" selected>Allow</option>\
                 <option value=\"\">Don't Allow</option>",
                "<option value=\"items.purge\" selected>Allow</option>\
                 <option value=\"\">Don't Allow</option>",
            ]
        );
        assert!(html.contains("data-shown-by=\"admin-level\" data-shown-at=\"custom\""));
        assert!(html.contains("They hold no more than this app does."));
        assert!(html.contains("Admin access: make keys, empty the trash"));
        assert!(!html.contains("role=\"switch\""));
        assert!(html.contains("id=\"confirm-dialog\""));
        assert!(!html.contains("15 minutes"));
    }

    #[test]
    fn the_profile_alone_is_allow_or_not() {
        let html = without_code(&page_of(Answering::Authorization("q".into()), offer()))
            .replace("&#39;", "'");
        assert!(html.contains(
            "<option value=\"profile:read\" selected>Allow</option><option value=\"\">Don't Allow</option>"
        ));
    }

    #[test]
    fn the_app_name_is_marked_unverified_with_where_it_sends_you() {
        let mut view = offer();
        view.returning = false;
        view.app = AppShown {
            name: "Cardigan".into(),
            client_id: "https://cardigan.dev/app.json".into(),
            document_host: None,
            destinations: Vec::new(),
            web_origins: Vec::new(),
        };
        let bare = without_code(&page_of(Answering::Authorization("q".into()), view.clone()));
        assert!(bare.contains("<bdi>Cardigan</bdi> (unverified) wants to connect"));
        assert!(!bare.contains("class=\"note\""));
        view.app.destinations = vec!["cardigan.app".into(), "login.cardigan.app".into()];
        view.app.document_host = Some("cardigan.dev".into());
        view.app.web_origins = vec!["https://cardigan.app".into()];
        let html = without_code(&page_of(Answering::Authorization("q".into()), view));
        assert!(html.contains("<bdi>Cardigan</bdi> (unverified, cardigan.app) wants to connect"));
        assert!(html.contains(
            "<p class=\"note\">It sends you back to cardigan.app and login.cardigan.app. \
             Its details come from cardigan.dev. \
             Allowing it also lets cardigan.app reach Marfa from your browser.</p>"
        ));
    }

    #[test]
    fn a_page_with_nothing_to_choose_offers_no_choice_of_access() {
        let mut view = offer();
        let witness = without_code(&page_of(Answering::Authorization("q".into()), offer()));
        assert!(witness.contains("<summary class=\"btn\">Choose…</summary>"));
        view.asks_new = false;
        view.admin = None;
        view.confirm = false;
        let html = without_code(&page_of(Answering::Authorization("q".into()), view));
        assert!(!html.contains("<summary class=\"btn\">Choose…</summary>"));
        assert!(!html.contains("name=\"admin\""));
        assert!(!html.contains("Confirm it&#39;s you"));
        assert!(!html.contains("15 minutes"));
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

#[test]
fn only_the_page_that_opens_an_item_refreshes_to_its_link() {
    let url = "marfa://a/b";
    let opening = notice(&Notice::opening_item(url)).unwrap();
    assert!(opening.html().contains(&format!(
        "<a class=\"btn primary\" href=\"{url}\">Open in Marfa</a>"
    )));
    assert!(opening.html().contains(&format!(
        "<meta http-equiv=\"refresh\" content=\"0;url={url}\">"
    )));
    for other in [Notice::not_an_item_link(), Notice::signed_out()] {
        assert!(!notice(&other).unwrap().html().contains("http-equiv"));
    }
    let hostile = notice(&Notice::opening_item("\"><img src=x>")).unwrap();
    assert!(!hostile.html().contains("<img"));
}
