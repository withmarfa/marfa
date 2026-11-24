//! Every page in every state it can take, drawn through the real page functions on made-up data.
//!
//! The test always renders each state. With `MARFA_WRITE_PAGE_PREVIEW` set to a folder it also
//! writes one HTML file for each state and an `index.html` that shows each at desktop and phone
//! width. `README.md` beside `page.css` says how to run it and how to add a state.

use std::fmt::Write as _;
use std::path::Path;

use axum::http::StatusCode;

use super::*;
use crate::app::access::Level;
use crate::app::connector_sign_in::Failure;
use crate::app::oauth::offer::{AppShown, Choice, Held, LevelRow, Offer, Power, Reach};

const FOLDER_VARIABLE: &str = "MARFA_WRITE_PAGE_PREVIEW";

const OPEN_CONFIRM_DIALOG: &str = r#"document.getElementById("confirm-dialog").showModal();"#;
const OPEN_DETAILS: &str =
    r#"for (const details of document.querySelectorAll("details")) details.open = true;"#;
const SHOW_HANDOFF_FAILED: &str =
    r#"document.querySelector("[data-handoff-failed]").hidden = false;"#;
const SHOW_HANDOFF_WORKING: &str =
    r#"document.querySelector("[data-handoff-working]").hidden = false;"#;
const OPEN_FIRST_MENU: &str = r#"requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("more-a1").showPopover()));"#;
const OPEN_CHANGE: &str = r#"document.querySelector("[data-change-password]").click();"#;
const OPEN_ADD: &str = r#"document.querySelector('[data-passkey="add"]').click();"#;
const OPEN_RENAME: &str =
    r#"document.querySelector('[data-passkey-row="a2"] [data-passkey-rename]').click();"#;
const OPEN_REMOVE: &str =
    r#"document.querySelector('[data-passkey-row="a2"] [data-passkey-remove]').click();"#;
const ASK_PASSWORD_TO_REMOVE: &str = r#"document.querySelector("[data-confirm-fields]").hidden = false; document.getElementById("confirm-password").disabled = false; document.getElementById("confirm-text").textContent = "Enter your password to confirm it’s you."; document.getElementById("confirm-password").focus();"#;
const REMOVE_FAILED: &str = r#"const lede = document.getElementById("confirm-text"); lede.textContent = "Something went wrong. Try again."; lede.classList.add("err");"#;
const WRONG_CONFIRM_PASSWORD: &str = r#"const note = document.getElementById("confirm-note"); note.className = "err"; note.textContent = "That password isn’t right."; document.getElementById("confirm-password").setAttribute("aria-invalid", "true");"#;
const FILL_NEW_PASSWORDS: &str = r#"for (const id of ["new-password", "new-password-again"]) document.getElementById(id).value = "allotment-lewes";"#;
const WRONG_CURRENT_PASSWORD: &str = r#"const note = document.getElementById("current-note"); note.className = "err"; note.textContent = "That password isn’t right."; document.getElementById("current-password").setAttribute("aria-invalid", "true");"#;
const PASSWORDS_DIFFER: &str = r#"document.getElementById("new-password").value = "allotment-lewes"; document.getElementById("new-password-again").value = "allotment-lewis"; const note = document.getElementById("new-note"); note.className = "err"; note.textContent = "The passwords don’t match."; for (const id of ["new-password", "new-password-again"]) document.getElementById(id).setAttribute("aria-invalid", "true");"#;
const NEW_PASSWORD_TOO_SHORT: &str = r#"for (const id of ["new-password", "new-password-again"]) { const field = document.getElementById(id); field.value = "lewes"; field.setAttribute("aria-invalid", "true"); } const note = document.getElementById("new-note"); note.className = "err"; note.textContent = "Use at least 8 characters.";"#;
const TOO_MANY_PASSWORD_ATTEMPTS: &str = r#"const note = document.getElementById("new-note"); note.className = "err"; note.textContent = "Too many attempts. Try again in 2 minutes.";"#;
const DEVICE_HAS_PASSKEY: &str = r#"const note = document.getElementById("add-note"); note.className = "err"; note.textContent = "This device already has a passkey here."; document.getElementById("passkey-name").setAttribute("aria-invalid", "true");"#;
const NAME_THE_PASSKEY: &str = r#"const note = document.getElementById("rename-note"); note.className = "err"; note.textContent = "Enter a name for the passkey."; const field = document.getElementById("rename-passkey"); field.value = ""; field.setAttribute("aria-invalid", "true");"#;
const NO_PASSKEY_SUPPORT: &str =
    r#"Object.defineProperty(window, "PublicKeyCredential", { value: undefined });"#;
const NOT_A_SECURE_ADDRESS: &str =
    r#"Object.defineProperty(window, "isSecureContext", { value: false });"#;
const CHOOSE: &str = r#"const radio = document.querySelector("input[name=access][value=choose]"); radio.checked = true; radio.dispatchEvent(new Event("change"));"#;
const EACH_TYPE: &str = r#"const all = document.querySelector("select[data-types-switch]"); all.value = "choose-types"; all.dispatchEvent(new Event("change"));"#;

/// One page in one state. `board` is the Round 4 board it is compared with, such as `U1`.
struct State {
    board: Option<&'static str>,
    slug: &'static str,
    title: &'static str,
    page: Page,
    /// Runs before the page's own script, for a state that needs the browser to lack something.
    before: &'static [&'static str],
    /// Runs after the page's own script, for a state that needs a click: a dialog open, a detail opened.
    after: &'static [&'static str],
    without_javascript: bool,
}

impl State {
    fn new(
        board: Option<&'static str>,
        slug: &'static str,
        title: &'static str,
        page: Result<Page>,
    ) -> State {
        State {
            board,
            slug,
            title,
            page: page.expect("a preview state did not render"),
            before: &[],
            after: &[],
            without_javascript: false,
        }
    }

    fn before(mut self, scripts: &'static [&'static str]) -> State {
        self.before = scripts;
        self
    }

    fn after(mut self, scripts: &'static [&'static str]) -> State {
        self.after = scripts;
        self
    }

    fn without_javascript(mut self) -> State {
        self.without_javascript = true;
        self
    }

    fn file(&self) -> String {
        match self.board {
            Some(board) => format!("{board}-{}.html", self.slug),
            None => format!("{}.html", self.slug),
        }
    }

    /// The page as the server sends it, with only what a browser needs to show it from a file:
    /// no refresh to a `marfa://` address, and the preview's own script, if the state has one.
    fn document(&self) -> String {
        let mut html = self.page.html().to_owned();
        if let Some(start) = html.find("<meta http-equiv=\"refresh\"")
            && let Some(length) = html[start..].find('>')
        {
            html.replace_range(start..=start + length, "");
        }
        if self.without_javascript {
            if let Some(start) = html.find("<script nonce=")
                && let Some(length) = html[start..].find("</script>")
            {
                html.replace_range(start..start + length + "</script>".len(), "");
            }
        } else {
            if !self.before.is_empty()
                && let Some(at) = html.find("<script nonce=")
            {
                html.insert_str(
                    at,
                    &format!("<script>{}</script>\n", self.before.join("\n")),
                );
            }
            if !self.after.is_empty()
                && let Some(at) = html.rfind("</body>")
            {
                html.insert_str(at, &format!("<script>{}</script>\n", self.after.join("\n")));
            }
        }
        html
    }
}

const LONG_NAME: &str = "Cardigan Notes Sync and Backup Helper for the Whole Family, including the Shed Inventory, the Seed Catalogue and the Garden Planner Version Two";
const RIGHT_TO_LEFT: &str = "تطبيق الملاحظات";

fn sign_in_view() -> SignIn {
    SignIn {
        username: String::new(),
        return_to: "/".into(),
        authorization: None,
        app: None,
        problem: None,
    }
}

fn level_row(
    reach: Reach,
    pattern: &str,
    label: Option<&str>,
    levels: &[(Level, &str)],
    held: Level,
) -> LevelRow {
    let mut choices = vec![Choice {
        level: held,
        value: String::new(),
    }];
    choices.extend(
        levels
            .iter()
            .filter(|(level, _)| *level > held)
            .map(|(level, value)| Choice {
                level: *level,
                value: (*value).into(),
            }),
    );
    LevelRow {
        reach,
        pattern: pattern.into(),
        held,
        selected: choices
            .last()
            .map(|choice| choice.value.clone())
            .unwrap_or_default(),
        choices,
        open_ended: pattern.contains('*'),
        types: Vec::new(),
        label: label.map(str::to_owned),
        description: None,
        covers: Vec::new(),
    }
}

fn all_data() -> LevelRow {
    let mut row = level_row(
        Reach::Type,
        "*",
        None,
        &[(Level::Read, "*:read"), (Level::Write, "*:write")],
        Level::None,
    );
    row.types = vec![
        level_row(
            Reach::Type,
            "core.note",
            Some("Notes"),
            &[
                (Level::Read, "core.note:read"),
                (Level::Write, "core.note:write"),
            ],
            Level::None,
        ),
        level_row(
            Reach::Type,
            "core.task",
            Some("Tasks"),
            &[
                (Level::Read, "core.task:read"),
                (Level::Write, "core.task:write"),
            ],
            Level::None,
        ),
        level_row(
            Reach::Type,
            "user.recipe",
            Some("Recipes"),
            &[
                (Level::Read, "user.recipe:read"),
                (Level::Write, "user.recipe:write"),
            ],
            Level::None,
        ),
    ];
    row
}

fn links() -> LevelRow {
    level_row(
        Reach::Edge,
        "edge.*",
        None,
        &[(Level::Read, "edge.*:read"), (Level::Write, "edge.*:write")],
        Level::None,
    )
}

fn definitions() -> LevelRow {
    level_row(
        Reach::Metadata,
        "metadata",
        None,
        &[
            (Level::Read, "metadata:read"),
            (Level::Write, "metadata:write"),
        ],
        Level::None,
    )
}

fn profile_row() -> LevelRow {
    level_row(
        Reach::Profile,
        "profile",
        None,
        &[
            (Level::Read, "profile:read"),
            (Level::Write, "profile:write"),
        ],
        Level::None,
    )
}

fn power(literal: &str, cannot_be_undone: bool) -> Power {
    Power {
        literal: literal.into(),
        cannot_be_undone,
    }
}

fn app(name: &str) -> AppShown {
    AppShown {
        name: name.into(),
        client_id: "https://cardigan.example/client.json".into(),
        document_host: Some("cardigan.example".into()),
        destinations: vec!["cardigan.example".into()],
        web_origins: Vec::new(),
    }
}

/// An app asking for everything the page can offer.
fn offer() -> Offer {
    Offer {
        app: app("Cardigan"),
        full_access_choice: true,
        data: vec![all_data(), links(), definitions()],
        profile: vec![profile_row()],
        powers: vec![
            power("keys.mint", false),
            power("instance.read", false),
            power("items.purge", true),
            power("audit.read", false),
        ],
        held: Vec::new(),
        held_powers: Vec::new(),
        mechanisms: vec!["offline_access".into()],
        confirm: false,
        offers_edit: true,
        returning: false,
    }
}

fn consent_page(offer: Offer) -> Result<Page> {
    consent(&Consent {
        offer,
        answering: Answering::Authorization("client_id=cardigan&state=1".into()),
    })
}

fn device_consent_page(offer: Offer) -> Result<Page> {
    consent(&Consent {
        offer,
        answering: Answering::Device("K7MP2XDV".into()),
    })
}

fn only_some_things() -> Offer {
    Offer {
        app: AppShown {
            web_origins: vec!["https://cardigan.example".into()],
            ..app("Cardigan")
        },
        full_access_choice: false,
        data: vec![level_row(
            Reach::Type,
            "core.note",
            Some("Notes"),
            &[(Level::Read, "core.note:read")],
            Level::None,
        )],
        profile: Vec::new(),
        powers: Vec::new(),
        mechanisms: Vec::new(),
        offers_edit: false,
        ..offer()
    }
}

fn asking_for_more() -> Offer {
    Offer {
        data: vec![level_row(
            Reach::Type,
            "core.task",
            Some("Tasks"),
            &[
                (Level::Read, "core.task:read"),
                (Level::Write, "core.task:write"),
            ],
            Level::Read,
        )],
        profile: Vec::new(),
        powers: vec![power("audit.read", false)],
        held: vec![Held {
            reach: Reach::Type,
            pattern: "core.note".into(),
            level: Level::Write,
            label: Some("Notes".into()),
        }],
        held_powers: vec![power("instance.read", false)],
        returning: true,
        ..offer()
    }
}

fn passkey(
    id: &str,
    name: &str,
    added: &str,
    last_used: Option<&str>,
    made_for: Option<&str>,
) -> OwnerPasskey {
    OwnerPasskey {
        id: id.into(),
        name: name.into(),
        added: added.into(),
        last_used: last_used.map(str::to_owned),
        made_for: made_for.map(str::to_owned),
    }
}

/// The two passkeys drawn on the boards.
fn passkey_rows() -> Vec<OwnerPasskey> {
    vec![
        passkey(
            "a1",
            "iCloud Keychain",
            "Sep 3, 2026",
            Some("Nov 21, 2026"),
            None,
        ),
        passkey("a2", "YubiKey 5C NFC", "Oct 21, 2026", None, None),
    ]
}

fn other_address_row() -> OwnerPasskey {
    passkey(
        "a3",
        "Old MacBook",
        "Aug 9, 2026",
        None,
        Some("castell.local"),
    )
}

fn passkeys_view(rows: Vec<OwnerPasskey>) -> OwnerPasskeys {
    OwnerPasskeys {
        username: "mira".into(),
        rows,
        changed: false,
        problem: None,
    }
}

fn passkeys_page(rows: Vec<OwnerPasskey>) -> Result<Page> {
    owner_passkeys(&passkeys_view(rows))
}

fn password_problem_page(problem: PasswordProblem) -> Result<Page> {
    owner_passkeys(&OwnerPasskeys {
        problem: Some(problem),
        ..passkeys_view(passkey_rows())
    })
}

fn many_passkeys() -> Vec<OwnerPasskey> {
    (1..=8)
        .map(|number| {
            passkey(
                &format!("m{number}"),
                &format!("Passkey {number}"),
                "Oct 21, 2026",
                (number % 2 == 0).then_some("Nov 21, 2026"),
                None,
            )
        })
        .collect()
}

fn claim_view() -> SetupCode {
    SetupCode {
        problem: None,
        return_to: "/".into(),
        app: None,
    }
}

fn claim_for_an_app() -> SetupCode {
    SetupCode {
        return_to: "/oauth/authorize?client_id=cardigan".into(),
        app: Some(AskingApp {
            name: "Cardigan".into(),
            host: "cardigan.example".into(),
        }),
        ..claim_view()
    }
}

fn details_view() -> SetupDetails {
    SetupDetails {
        name: String::new(),
        username: String::new(),
        email: String::new(),
        errors: SetupFieldErrors::default(),
        notice: None,
        return_to: "/".into(),
    }
}

fn device_view(problem: Option<DeviceProblem>) -> DeviceEntry {
    DeviceEntry {
        user_code: String::new(),
        problem,
    }
}

/// Add a state here when a page gains a view or a state; the README says how.
#[allow(
    clippy::too_many_lines,
    reason = "one list of every state is easier to read than several"
)]
fn states() -> Vec<State> {
    let wait = Wait::from_query(Some("900"));
    let long_wait = Some(Wait::from_query(Some("61")).expect("a wait"));
    let mut states = vec![
        // Sign in
        State::new(Some("U1"), "sign-in", "Sign in", sign_in(&sign_in_view())),
        State::new(
            Some("U2"),
            "sign-in-for-an-app",
            "Sign in, on the way to an app",
            sign_in(&SignIn {
                app: Some("Cardigan".into()),
                authorization: Some("client_id=cardigan&state=1".into()),
                return_to: "/oauth/authorize?client_id=cardigan".into(),
                ..sign_in_view()
            }),
        ),
        State::new(
            Some("U3"),
            "sign-in-too-many",
            "Sign in, too many attempts",
            sign_in(&SignIn {
                problem: Some(SignInProblem::TooManyAttempts(wait)),
                ..sign_in_view()
            }),
        ),
        State::new(
            Some("U31"),
            "sign-in-wrong",
            "Sign in, a wrong password",
            sign_in(&SignIn {
                username: "mira".into(),
                problem: Some(SignInProblem::InvalidCredentials),
                ..sign_in_view()
            }),
        ),
        State::new(
            None,
            "sign-in-empty-field",
            "Sign in, a field left empty",
            sign_in(&SignIn {
                problem: Some(SignInProblem::MissingField),
                ..sign_in_view()
            }),
        ),
        State::new(
            None,
            "sign-in-failed",
            "Sign in, something went wrong",
            sign_in(&SignIn {
                problem: Some(SignInProblem::Other),
                ..sign_in_view()
            }),
        ),
        State::new(
            None,
            "sign-in-too-many-no-wait",
            "Sign in, too many attempts with no wait given",
            sign_in(&SignIn {
                problem: Some(SignInProblem::TooManyAttempts(None)),
                ..sign_in_view()
            }),
        ),
        State::new(
            None,
            "sign-in-long-names",
            "Sign in, an app with a 100-character name and a right-to-left username",
            sign_in(&SignIn {
                username: RIGHT_TO_LEFT.into(),
                app: Some(LONG_NAME.into()),
                ..sign_in_view()
            }),
        ),
        State::new(
            Some("U4"),
            "signed-in",
            "Signed in already, or just after claiming",
            signed_in(&SignedIn {
                username: "mira".into(),
                continue_to: "/".into(),
            }),
        ),
        State::new(
            Some("U25"),
            "its-address-signed-in",
            "Its address in a browser, signed in",
            running(&Running {
                username: "mira".into(),
            }),
        ),
        // Recovery
        State::new(
            Some("U26"),
            "recover-code",
            "Recover: the recovery code",
            recovery_code(&RecoveryCode { problem: None }),
        )
        .after(&[OPEN_DETAILS]),
        State::new(
            None,
            "recover-code-wrong",
            "Recover: a wrong recovery code",
            recovery_code(&RecoveryCode {
                problem: Some(SetupCodeProblem::WrongCode),
            }),
        ),
        State::new(
            Some("U27"),
            "recover-new-password",
            "Recover: a new password",
            recover_password(&RecoverPassword {
                error: None,
                notice: None,
            }),
        ),
        State::new(
            None,
            "recover-new-password-short",
            "Recover: a password the server refuses",
            recover_password(&RecoverPassword {
                error: Some("Use at least 8 characters.".into()),
                notice: None,
            }),
        ),
        // Claiming
        State::new(
            Some("U33"),
            "claim",
            "Claim, the setup code",
            setup_code(&claim_view()),
        ),
        State::new(
            Some("U6"),
            "claim-for-an-app",
            "Claim, on the way to an app",
            setup_code(&claim_for_an_app()),
        ),
        State::new(
            Some("U7"),
            "claim-wrong-code",
            "Claim, a wrong setup code",
            setup_code(&SetupCode {
                problem: Some(SetupCodeProblem::WrongCode),
                ..claim_view()
            }),
        ),
        State::new(
            Some("U34"),
            "claim-help",
            "Claim, Can't find it? opened",
            setup_code(&claim_view()),
        )
        .after(&[OPEN_DETAILS]),
        State::new(
            Some("U35"),
            "claim-link-expired",
            "Claim, a setup link that expired or was used",
            setup_code(&claim_view()),
        )
        .after(&[SHOW_HANDOFF_FAILED]),
        State::new(
            None,
            "claim-checking-link",
            "Claim, checking a setup link",
            setup_code(&claim_view()),
        )
        .after(&[SHOW_HANDOFF_WORKING]),
        State::new(
            None,
            "claim-no-code",
            "Claim, nothing typed",
            setup_code(&SetupCode {
                problem: Some(SetupCodeProblem::MissingCode),
                ..claim_view()
            }),
        ),
        State::new(
            None,
            "claim-session-ended",
            "Claim, the setup session ended",
            setup_code(&SetupCode {
                problem: Some(SetupCodeProblem::SessionEnded),
                ..claim_view()
            }),
        ),
        State::new(
            None,
            "claim-too-many",
            "Claim, too many attempts",
            setup_code(&SetupCode {
                problem: Some(SetupCodeProblem::TooManyAttempts(wait)),
                ..claim_view()
            }),
        ),
        State::new(
            Some("U8"),
            "create-account",
            "Create your account",
            setup_details(&details_view()),
        ),
        State::new(
            None,
            "create-account-for-an-app",
            "Create your account, on the way to an app",
            setup_details(&SetupDetails {
                return_to: "/oauth/authorize?client_id=cardigan".into(),
                ..details_view()
            }),
        ),
        State::new(
            Some("U9"),
            "create-account-username-problem",
            "Create your account, a username Marfa can't use",
            setup_details(&SetupDetails {
                name: "Mira Castell".into(),
                username: "mira castell".into(),
                errors: SetupFieldErrors {
                    username: Some(
                        "Use letters a to z, numbers, dots, dashes and underscores.".into(),
                    ),
                    ..SetupFieldErrors::default()
                },
                ..details_view()
            }),
        ),
        State::new(
            None,
            "create-account-every-problem",
            "Create your account, a problem in every field and a notice",
            setup_details(&SetupDetails {
                name: "Mira".into(),
                username: "mira castell".into(),
                email: "not an address".into(),
                errors: SetupFieldErrors {
                    name: Some("That name is too long.".into()),
                    username: Some(
                        "Use letters a to z, numbers, dots, dashes and underscores.".into(),
                    ),
                    email: Some("That doesn't look like an email address.".into()),
                    password: Some("Use at least 8 characters.".into()),
                },
                notice: Some("Something went wrong. Try again.".into()),
                ..details_view()
            }),
        ),
        // A device
        State::new(
            Some("U36"),
            "device-enter-code",
            "A device, typing its code",
            device_entry(&device_view(None)),
        ),
        State::new(
            Some("U18"),
            "device-wrong-code",
            "A device, a wrong code",
            device_entry(&DeviceEntry {
                user_code: "ABCD-2345".into(),
                ..device_view(Some(DeviceProblem::InvalidCode))
            }),
        ),
        State::new(
            None,
            "device-expired-code",
            "A device, a code known to have expired",
            device_entry(&device_view(Some(DeviceProblem::ExpiredCode))),
        ),
        State::new(
            None,
            "device-too-many",
            "A device, too many codes",
            device_entry(&device_view(Some(DeviceProblem::TooManyAttempts(
                long_wait,
            )))),
        ),
        State::new(
            None,
            "device-failed",
            "A device, something went wrong",
            device_entry(&device_view(Some(DeviceProblem::Other))),
        ),
        State::new(
            Some("U19"),
            "device-allow",
            "A device, allowing it",
            device_consent_page(offer()),
        ),
        // Allowing an app
        State::new(Some("U10"), "allow", "Allow an app", consent_page(offer())),
        State::new(
            Some("U11"),
            "allow-choosing",
            "Allow an app, choosing",
            consent_page(offer()),
        )
        .after(&[CHOOSE]),
        State::new(
            Some("U12"),
            "allow-each-type",
            "Allow an app, choosing a level for each type",
            consent_page(offer()),
        )
        .after(&[CHOOSE, EACH_TYPE]),
        State::new(
            Some("U13"),
            "allow-admin-custom",
            "Allow an app, choosing: every power",
            consent_page(offer()),
        )
        .after(&[CHOOSE, OPEN_DETAILS]),
        State::new(
            Some("U14"),
            "allow-less",
            "A web app asking for only some things",
            consent_page(only_some_things()),
        ),
        State::new(
            Some("U15"),
            "allow-more",
            "An app asking for more than it has",
            consent_page(asking_for_more()),
        ),
        State::new(
            Some("U16"),
            "allow-confirm",
            "Allowing admin access more than 15 minutes after signing in",
            consent_page(Offer {
                confirm: true,
                ..offer()
            }),
        )
        .after(&[OPEN_CONFIRM_DIALOG]),
        State::new(
            Some("U42"),
            "allow-addresses",
            "A web app with more than one address",
            consent_page(Offer {
                app: AppShown {
                    destinations: vec!["cardigan.example".into(), "app.cardigan.example".into()],
                    web_origins: vec![
                        "https://cardigan.example".into(),
                        "https://app.cardigan.example".into(),
                    ],
                    ..app("Cardigan")
                },
                ..only_some_things()
            }),
        ),
        State::new(
            None,
            "allow-nothing-to-choose",
            "Allow an app, with nothing to choose between",
            consent_page(Offer {
                full_access_choice: false,
                powers: Vec::new(),
                ..only_some_things()
            }),
        ),
        State::new(
            None,
            "allow-long-names",
            "Allow an app with a 100-character name, and a right-to-left one",
            consent_page(Offer {
                app: app(LONG_NAME),
                data: vec![
                    level_row(
                        Reach::Type,
                        "core.note",
                        Some(RIGHT_TO_LEFT),
                        &[
                            (Level::Read, "core.note:read"),
                            (Level::Write, "core.note:write"),
                        ],
                        Level::None,
                    ),
                    level_row(
                        Reach::Type,
                        "user.long",
                        Some(LONG_NAME),
                        &[
                            (Level::Read, "user.long:read"),
                            (Level::Write, "user.long:write"),
                        ],
                        Level::None,
                    ),
                ],
                ..only_some_things()
            }),
        ),
        State::new(
            None,
            "allow-without-javascript",
            "Allow an app, without JavaScript",
            consent_page(offer()),
        )
        .without_javascript(),
        // Passkeys and password
        State::new(
            Some("U21"),
            "passkeys-none",
            "Passkeys and password, no passkey yet",
            passkeys_page(Vec::new()),
        ),
        State::new(
            None,
            "passkeys-list",
            "Passkeys and password, two passkeys",
            passkeys_page(passkey_rows()),
        ),
        State::new(
            Some("U22"),
            "passkeys-menu",
            "Passkeys and password, a passkey's menu and one made for another address",
            passkeys_page({
                let mut rows = passkey_rows();
                rows.push(other_address_row());
                rows
            }),
        )
        .after(&[OPEN_FIRST_MENU]),
        State::new(
            None,
            "passkeys-many",
            "Passkeys and password, eight passkeys",
            passkeys_page(many_passkeys()),
        ),
        State::new(
            None,
            "passkeys-long-names",
            "Passkeys and password, a 100-character name and a right-to-left one",
            passkeys_page(vec![
                passkey("a1", LONG_NAME, "Oct 21, 2026", Some("Nov 21, 2026"), None),
                passkey("a2", RIGHT_TO_LEFT, "Oct 21, 2026", None, None),
            ]),
        ),
        State::new(
            None,
            "passkeys-long-name-menu",
            "Passkeys and password, a long name's menu",
            passkeys_page(vec![
                passkey("a1", LONG_NAME, "Oct 21, 2026", Some("Nov 21, 2026"), None),
                passkey("a2", RIGHT_TO_LEFT, "Oct 21, 2026", None, None),
            ]),
        )
        .after(&[OPEN_FIRST_MENU]),
        State::new(
            Some("U37"),
            "passkeys-address",
            "Passkeys and password, where passkeys don't work",
            passkeys_page(passkey_rows()),
        )
        .before(&[NOT_A_SECURE_ADDRESS]),
        State::new(
            None,
            "passkeys-no-browser-support",
            "Passkeys and password, a browser that can't make passkeys",
            passkeys_page(passkey_rows()),
        )
        .before(&[NO_PASSKEY_SUPPORT]),
        State::new(
            None,
            "passkeys-none-address",
            "Passkeys and password, no passkey where passkeys don't work",
            passkeys_page(Vec::new()),
        )
        .before(&[NOT_A_SECURE_ADDRESS]),
        State::new(
            Some("U23"),
            "change-password",
            "Changing the password",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_CHANGE]),
        State::new(
            Some("U41"),
            "change-password-wrong",
            "Changing the password, the current one isn't right",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_CHANGE, FILL_NEW_PASSWORDS, WRONG_CURRENT_PASSWORD]),
        State::new(
            None,
            "change-password-differ",
            "Changing the password, the two new ones differ",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_CHANGE, PASSWORDS_DIFFER]),
        State::new(
            None,
            "change-password-short",
            "Changing the password, the new one is too short",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_CHANGE, NEW_PASSWORD_TOO_SHORT]),
        State::new(
            None,
            "change-password-too-many",
            "Changing the password, too many attempts",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_CHANGE, FILL_NEW_PASSWORDS, TOO_MANY_PASSWORD_ATTEMPTS]),
        State::new(
            Some("U43"),
            "password-changed",
            "The password, changed",
            owner_passkeys(&OwnerPasskeys {
                changed: true,
                ..passkeys_view(passkey_rows())
            }),
        ),
        State::new(
            Some("U38"),
            "passkey-add",
            "Adding a passkey, before the browser asks",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_ADD]),
        State::new(
            None,
            "passkey-add-device-has-one",
            "Adding a passkey, this device already has one",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_ADD, DEVICE_HAS_PASSKEY]),
        State::new(
            Some("U39"),
            "passkey-rename",
            "Renaming a passkey",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_RENAME]),
        State::new(
            None,
            "passkey-rename-empty",
            "Renaming a passkey, no name",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_RENAME, NAME_THE_PASSKEY]),
        State::new(
            None,
            "passkey-rename-long-name",
            "Renaming a passkey with a 100-character name",
            passkeys_page(vec![passkey("a2", LONG_NAME, "Oct 21, 2026", None, None)]),
        )
        .after(&[OPEN_RENAME]),
        State::new(
            Some("U40"),
            "passkey-remove-recent",
            "Removing a passkey within 15 minutes of signing in",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_REMOVE]),
        State::new(
            None,
            "passkey-remove-long-name",
            "Removing a passkey with a 100-character name",
            passkeys_page(vec![passkey("a2", LONG_NAME, "Oct 21, 2026", None, None)]),
        )
        .after(&[OPEN_REMOVE]),
        State::new(
            None,
            "passkey-remove-failed",
            "Removing a passkey, something went wrong",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_REMOVE, REMOVE_FAILED]),
        State::new(
            Some("U24"),
            "passkey-remove",
            "Removing a passkey, confirm it's you",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_REMOVE, ASK_PASSWORD_TO_REMOVE]),
        State::new(
            None,
            "passkey-remove-wrong-password",
            "Removing a passkey, a wrong password",
            passkeys_page(passkey_rows()),
        )
        .after(&[OPEN_REMOVE, ASK_PASSWORD_TO_REMOVE, WRONG_CONFIRM_PASSWORD]),
        State::new(
            None,
            "passkeys-without-javascript",
            "Passkeys and password, without JavaScript",
            passkeys_page(passkey_rows()),
        )
        .without_javascript(),
        State::new(
            None,
            "passkeys-none-without-javascript",
            "Passkeys and password, no passkey, without JavaScript",
            passkeys_page(Vec::new()),
        )
        .without_javascript(),
        State::new(
            None,
            "password-changed-without-javascript",
            "The password, changed, without JavaScript",
            owner_passkeys(&OwnerPasskeys {
                changed: true,
                ..passkeys_view(passkey_rows())
            }),
        )
        .without_javascript(),
        State::new(
            None,
            "password-wrong-without-javascript",
            "Changing the password, the current one isn't right, without JavaScript",
            password_problem_page(PasswordProblem::CurrentNotRight),
        )
        .without_javascript(),
        State::new(
            None,
            "password-short-without-javascript",
            "Changing the password, the new one is too short, without JavaScript",
            password_problem_page(PasswordProblem::NewTooShort),
        )
        .without_javascript(),
        State::new(
            None,
            "password-differ-without-javascript",
            "Changing the password, the two new ones differ, without JavaScript",
            password_problem_page(PasswordProblem::NotTheSame),
        )
        .without_javascript(),
        State::new(
            None,
            "password-too-many-without-javascript",
            "Changing the password, too many attempts, without JavaScript",
            password_problem_page(PasswordProblem::TooManyAttempts(Wait::from_query(Some(
                "120",
            )))),
        )
        .without_javascript(),
    ];

    // Notices: the first fifteen are the ones drawn on U28.
    let board = Some("U28");
    let notices: Vec<(Option<&'static str>, &'static str, &'static str, Notice)> = vec![
        (
            board,
            "notice-running",
            "A running Marfa, signed out",
            Notice::running(),
        ),
        (
            board,
            "notice-device-not-connected",
            "A device that was not allowed",
            Notice::device_denied(),
        ),
        (
            board,
            "notice-request-expired",
            "An app's request that expired",
            Notice::expired_request(),
        ),
        (
            board,
            "notice-request-unverified",
            "An app's request that could not be checked",
            Notice::unverified_request(),
        ),
        (
            board,
            "notice-connector-signed-in",
            "A connector's sign-in that finished",
            Notice::connector_signed_in(),
        ),
        (
            board,
            "notice-sign-in-unfinished",
            "A connector's sign-in that did not finish",
            Notice::connector_sign_in_unfinished(None),
        ),
        (
            board,
            "notice-opening-item",
            "An item link, opening in an app",
            Notice::opening_item(
                "marfa://0194f2a0-1111-7000-8000-000000000001/0194f2a0-2222-7000-8000-000000000002",
            ),
        ),
        (
            board,
            "notice-not-an-item-link",
            "An item link that is not a Marfa link",
            Notice::not_an_item_link(),
        ),
        (
            board,
            "notice-signed-out",
            "Signed out",
            Notice::signed_out(),
        ),
        (
            board,
            "notice-already-claimed",
            "A Marfa that already has an owner",
            Notice::already_claimed("/"),
        ),
        (
            board,
            "notice-nothing-here",
            "A page that does not exist",
            Notice::missing_page(),
        ),
        (
            board,
            "notice-something-went-wrong",
            "A server fault",
            Notice::fault(),
        ),
        (
            Some("U20"),
            "device-connected",
            "A device, connected",
            Notice::device_approved(),
        ),
        (
            None,
            "notice-sign-in-failed",
            "A connector's sign-in the service refused",
            Notice::connector_sign_in_failed(&Failure::TokenError("invalid_grant")),
        ),
        (
            None,
            "notice-sign-in-unfinished-reason",
            "A connector's sign-in that did not finish, with a reason",
            Notice::connector_sign_in_unfinished(Some(&Failure::Timeout)),
        ),
        (
            None,
            "notice-sign-in-needed",
            "A refusal that needs a sign-in",
            Notice::refusal(StatusCode::UNAUTHORIZED, "Sign in to continue."),
        ),
        (
            None,
            "notice-not-allowed",
            "A refusal, not allowed",
            Notice::refusal(StatusCode::FORBIDDEN, "This key can't do that."),
        ),
        (
            None,
            "notice-too-many-requests",
            "A refusal, too many requests",
            Notice::refusal(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests. Try again later.",
            ),
        ),
        (
            None,
            "notice-not-accepted",
            "A refusal, request not accepted",
            Notice::refusal(StatusCode::BAD_REQUEST, "The request wasn't valid."),
        ),
    ];
    for (board, slug, title, view) in notices {
        states.push(State::new(board, slug, title, notice(&view)));
    }

    // Notices for an app's request that could not go on, one for each code.
    for (board, slug, title, code) in [
        (
            board,
            "notice-app-cant-continue",
            "An app that can't continue: a redirect it did not register",
            AuthErrorCode::InvalidRedirect,
        ),
        (
            board,
            "notice-unknown-app",
            "An app Marfa does not know",
            AuthErrorCode::InvalidClient,
        ),
        (
            board,
            "notice-app-needs-approval",
            "An app that needs approval",
            AuthErrorCode::ConsentRequired,
        ),
        (
            None,
            "notice-app-incomplete-request",
            "An app's request that was incomplete",
            AuthErrorCode::InvalidRequest,
        ),
        (
            None,
            "notice-app-unsupported-sign-in",
            "An app that asked to sign in a way Marfa does not allow",
            AuthErrorCode::UnauthorizedClient,
        ),
        (
            None,
            "notice-app-too-much",
            "An app that asked for access Marfa can't give",
            AuthErrorCode::InvalidScope,
        ),
        (
            None,
            "notice-app-wrong-server",
            "An app that asked for something this Marfa does not serve",
            AuthErrorCode::InvalidTarget,
        ),
        (
            None,
            "notice-app-needs-sign-in",
            "An app that needs the owner to sign in",
            AuthErrorCode::LoginRequired,
        ),
        (
            None,
            "notice-app-unknown-error",
            "An app's request that failed for another reason",
            AuthErrorCode::Other,
        ),
    ] {
        states.push(State::new(
            board,
            slug,
            title,
            auth_error(&AuthError { code }),
        ));
    }
    states
}

fn index(states: &[State]) -> String {
    let mut cards = String::new();
    for state in states {
        let file = state.file();
        let board = state.board.map_or(String::new(), |board| {
            format!("<span class=\"board\">{board}</span>")
        });
        let _ = writeln!(
            cards,
            "<section id=\"{slug}\"><h2>{board}{title}</h2>\
             <p><a href=\"{file}\">{file}</a></p>\
             <div class=\"pair\">\
             <div class=\"view desktop\"><iframe src=\"{file}\" title=\"{title}, desktop\" loading=\"lazy\"></iframe></div>\
             <div class=\"view phone\"><iframe src=\"{file}\" title=\"{title}, phone\" loading=\"lazy\"></iframe></div>\
             </div></section>",
            slug = state.slug,
            title = state.title,
        );
    }
    let mut contents = String::new();
    for state in states {
        let _ = write!(
            contents,
            "<li><a href=\"#{}\">{}{}</a></li>",
            state.slug,
            state
                .board
                .map_or(String::new(), |board| format!("{board} ")),
            state.title,
        );
    }
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
         <title>Marfa pages, every state</title>\
         <style>\
         body{{margin:0;padding:24px;font:15px/1.4 system-ui,sans-serif;background:#eee;color:#111}}\
         h1{{font-size:22px}}h2{{font-size:17px;margin:32px 0 4px}}\
         .board{{display:inline-block;margin-right:8px;padding:1px 7px;border-radius:9px;background:#111;color:#fff;font-size:13px}}\
         .pair{{display:flex;gap:24px;align-items:flex-start}}\
         .view{{flex:none;overflow:hidden;background:#fff;box-shadow:0 0 0 1px #0002}}\
         .desktop{{width:calc(1280px * var(--scale));height:calc(800px * var(--scale))}}\
         .phone{{width:calc(390px * var(--scale));height:calc(800px * var(--scale));border-radius:16px}}\
         iframe{{border:0;height:800px;transform:scale(var(--scale));transform-origin:0 0}}\
         .desktop iframe{{width:1280px}}.phone iframe{{width:390px}}\
         :root{{--scale:.5}}\
         </style></head><body>\
         <h1>Marfa pages, every state</h1>\
         <p>Each state at desktop (1280) and phone (390) width, drawn by the server's own page functions. \
         A badge names the Round 4 board to compare it with. Open a file for the page at full size.</p>\
         <details><summary>{count} states</summary><ul>{contents}</ul></details>\
         {cards}</body></html>\n",
        count = states.len(),
    )
}

fn write_preview(folder: &Path, states: &[State]) {
    std::fs::create_dir_all(folder).expect("the preview folder could not be made");
    for state in states {
        std::fs::write(folder.join(state.file()), state.document())
            .expect("a preview file could not be written");
    }
    std::fs::write(folder.join("index.html"), index(states))
        .expect("the preview index could not be written");
}

#[test]
fn every_page_renders_in_every_state_and_is_written_when_asked() {
    let states = states();
    let mut seen = std::collections::HashSet::new();
    for state in &states {
        assert!(seen.insert(state.file()), "{} is named twice", state.file());
        let html = state.page.html();
        assert!(html.starts_with("<!doctype html>"), "{}", state.file());
        assert!(html.contains("<main"), "{}", state.file());
    }
    if let Some(folder) = std::env::var_os(FOLDER_VARIABLE) {
        write_preview(Path::new(&folder), &states);
    }
}
