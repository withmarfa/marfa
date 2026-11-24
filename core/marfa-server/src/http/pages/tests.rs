use std::collections::HashSet;

use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

use super::*;

const HOSTILE: &str = "\"><img src=x onerror=alert(1)> & 'q'";

fn sign_in_view() -> SignIn {
    SignIn {
        instance_name: "Marfa".into(),
        username: String::new(),
        return_to: "/".into(),
        authorization: None,
        app: None,
        problem: None,
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
        username: HOSTILE.into(),
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
            username: HOSTILE.into(),
            email: HOSTILE.into(),
            errors: SetupFieldErrors {
                name: Some(HOSTILE.into()),
                username: Some(HOSTILE.into()),
                email: Some(HOSTILE.into()),
                password: Some(HOSTILE.into()),
            },
            notice: Some(HOSTILE.into()),
            return_to: HOSTILE.into(),
        })
        .unwrap(),
        setup_code(&SetupCode {
            instance_name: HOSTILE.into(),
            problem: None,
            return_to: HOSTILE.into(),
            app: Some(AskingApp {
                name: HOSTILE.into(),
                host: HOSTILE.into(),
            }),
        })
        .unwrap(),
        notice(&Notice::already_claimed(HOSTILE, HOSTILE)).unwrap(),
        notice(&Notice::opening_item(HOSTILE, HOSTILE)).unwrap(),
        notice(&Notice::not_an_item_link(HOSTILE)).unwrap(),
        device_entry(&DeviceEntry {
            instance_name: HOSTILE.into(),
            user_code: HOSTILE.into(),
            problem: None,
        })
        .unwrap(),
        notice(&Notice::refusal("x", StatusCode::BAD_REQUEST, HOSTILE)).unwrap(),
        signed_in(&SignedIn {
            instance_name: HOSTILE.into(),
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
            instance_name: "Marfa".into(),
            username: "owner".into(),
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
fn a_sign_in_refusal_and_the_claimed_notice_link_to_sign_in() {
    let refused = notice(&Notice::refusal("Marfa", StatusCode::UNAUTHORIZED, "No."))
        .unwrap()
        .html;
    assert!(refused.contains("/auth/sign-in"));
    let claimed = notice(&Notice::already_claimed(
        "Marfa",
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
        instance_name: "Marfa".into(),
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
    assert!(plain.contains("in its terminal, or in its host's log"));
    assert!(plain.contains("<input type=\"hidden\" name=\"return_to\" value=\"/\">"));
    assert!(!plain.contains("choose what the app can access"));
    let asked = code_page("/oauth/authorize?client_id=a", None);
    assert!(asked.contains("value=\"/oauth/authorize?client_id=a\""));
    assert!(asked.contains("you choose what the app can access"));
    assert!(!asked.contains("is asking to connect"));
    let device = code_page("/auth/device/consent?user_code=ABCD-EFGH", None);
    assert!(device.contains("you choose what the app can access"));
    let elsewhere = code_page("/oauth/authorized", None);
    assert!(!elsewhere.contains("choose what the app can access"));
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
    assert!(named.contains("Notes</bdi> at <bdi>notes.example</bdi> is asking to connect"));
    assert!(named.contains("Marfa hasn't verified this app."));
}

#[test]
fn only_the_recovery_page_says_its_code_is_a_recovery_code() {
    let recovery = recovery_code(&RecoveryCode {
        instance_name: "Marfa".into(),
        problem: None,
    })
    .unwrap()
    .html;
    assert!(recovery.contains("Recovery code"));
    assert!(recovery.contains("<input type=\"hidden\" name=\"purpose\" value=\"recovery\">"));
    assert!(!recovery.contains("name=\"return_to\""));
    assert!(!code_page("/", None).contains("name=\"purpose\""));
}

#[test]
fn the_details_page_carries_return_to() {
    let details = setup_details(&SetupDetails {
        instance_name: "Marfa".into(),
        name: String::new(),
        username: String::new(),
        email: String::new(),
        errors: SetupFieldErrors::default(),
        notice: None,
        return_to: "/auth/device/consent?user_code=ABCD-EFGH".into(),
    })
    .unwrap()
    .html;
    assert!(details.contains("value=\"/auth/device/consent?user_code=ABCD-EFGH\""));
    assert!(details.contains("Next, you choose what the app can access"));
}

mod consent_pages {
    use super::*;
    use crate::app::access::{Level, Permission};
    use crate::app::oauth::offer::{
        Admin, AdminLevel, AppShown, Choice, Held, LevelRow, Offer, Reach,
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
            admin: Some(Admin {
                powers: vec![Permission::ItemsPurge, Permission::KeysMint],
                levels: vec![AdminLevel::Full, AdminLevel::None, AdminLevel::Custom],
                selected: AdminLevel::Full,
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
            let words = html[from..to].replace('\n', " ");
            let mut form = html[to..after].to_owned();
            if let Some(start) = form.find("<section class=\"device-check\"")
                && let Some(end) = form[start..].find("</section>")
            {
                form.replace_range(start..start + end + "</section>\n".len(), "");
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
        assert!(device_head.contains("An app showing the code below is asking"));
        assert!(!browser_head.contains("code below"));
    }

    #[test]
    fn the_device_page_shows_its_code_and_warns_beside_approve() {
        let device = without_code(&page_of(Answering::Device("ABCD2345".into()), offer()));
        let check = device.find("class=\"device-check\"").unwrap();
        let approve = device.find("class=\"actions\"").unwrap();
        assert!(check < approve);
        let block = &device[check..approve];
        assert!(block.contains("ABCD-2345"), "{block}");
        assert!(block.contains("the app you're using shows this same code"));
        assert!(block.contains("Don't approve a link or code that someone sent you."));
        let browser = without_code(&page_of(Answering::Authorization("q".into()), offer()));
        assert!(!browser.contains("device-check"));
    }

    fn options_of<'a>(html: &'a str, name: &str) -> Vec<&'a str> {
        html.match_indices(&format!("name=\"{name}\""))
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
        assert!(html.contains("name=\"access\" value=\"full\" checked"));
        assert!(html.contains("name=\"access\" value=\"choose\">"));
        assert_eq!(
            options_of(&html, "admin"),
            ["<option value=\"full\" selected>Full access</option>\
              <option value=\"none\">No access</option>\
              <option value=\"custom\">Custom</option>"]
        );
        assert_eq!(
            options_of(&html, "powers"),
            [
                "<option value=\"\">Don't allow</option>\
                 <option value=\"keys.mint\" selected>Allow</option>",
                "<option value=\"\">Don't allow</option>\
                 <option value=\"items.purge\" selected>Allow</option>",
            ]
        );
        assert!(html.contains("data-shown-by=\"admin-level\" data-shown-at=\"custom\""));
        assert!(html.contains("They hold no more than this app does."));
        assert!(html.contains("Settings, keys and more: make keys; empty the trash"));
        assert!(!html.contains("role=\"switch\""));
        assert!(html.contains("Changes like this need a sign-in from the last 15 minutes."));
    }

    #[test]
    fn the_profile_alone_is_allow_or_not() {
        let html = without_code(&page_of(Answering::Authorization("q".into()), offer()))
            .replace("&#39;", "'");
        assert!(html.contains(
            "<option value=\"\">Don't allow</option><option value=\"profile:read\" selected>Allow</option>"
        ));
    }

    #[test]
    fn the_app_name_is_marked_unverified_with_where_it_sends_you() {
        let mut view = offer();
        view.app = AppShown {
            name: "Cardigan".into(),
            client_id: "https://cardigan.dev/app.json".into(),
            document_host: None,
            destinations: Vec::new(),
            web_origins: Vec::new(),
        };
        let bare = without_code(&page_of(Answering::Authorization("q".into()), view.clone()));
        assert!(bare.contains("<bdi>Cardigan</bdi> (unverified) wants to connect"));
        assert!(!bare.contains("class=\"facts\""));
        view.app.destinations = vec!["cardigan.app".into(), "login.cardigan.app".into()];
        view.app.document_host = Some("cardigan.dev".into());
        view.app.web_origins = vec!["https://cardigan.app".into()];
        let html = without_code(&page_of(Answering::Authorization("q".into()), view));
        assert!(html.contains("<bdi>Cardigan</bdi> (unverified, cardigan.app) wants to connect"));
        assert!(html.contains(
            "<p class=\"facts\">It sends you back to cardigan.app and login.cardigan.app. \
             Its details come from cardigan.dev. \
             Allowing it also lets cardigan.app reach Marfa from your browser.</p>"
        ));
    }

    #[test]
    fn a_page_with_nothing_to_choose_offers_no_choice_of_access() {
        let mut view = offer();
        view.full_access_choice = false;
        view.admin = None;
        view.confirm = false;
        let html = without_code(&page_of(Answering::Authorization("q".into()), view));
        assert!(!html.contains("name=\"access\""));
        assert!(!html.contains("Choose access"));
        assert!(!html.contains("Confirm it's you"));
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
    let opening = notice(&Notice::opening_item("Marfa", url)).unwrap();
    assert!(opening.html().contains(&format!("<a href=\"{url}\">")));
    assert!(opening.html().contains(&format!(
        "<meta http-equiv=\"refresh\" content=\"0;url={url}\">"
    )));
    for other in [
        Notice::not_an_item_link("Marfa"),
        Notice::signed_out("Marfa"),
    ] {
        assert!(!notice(&other).unwrap().html().contains("http-equiv"));
    }
    let hostile = notice(&Notice::opening_item("Marfa", "\"><img src=x>")).unwrap();
    assert!(!hostile.html().contains("<img"));
}
