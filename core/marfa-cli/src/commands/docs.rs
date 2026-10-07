//! `marfa docs`: the public docs site, read over plain HTTP.
//!
//! The site is not a Marfa instance, so nothing here uses `Remote` or
//! `marfa_core::http::Http`: both send a credential and check the contract
//! header, and the site has neither.

use std::time::Duration;

use clap::builder::NonEmptyStringValueParser;
use clap::{Args, Subcommand};
use marfa_core::CoreError;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use url::Url;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Named;

pub const DEFAULT_SITE: &str = "https://docs.marfa.so";
pub const SITE_VARIABLE: &str = "MARFA_DOCS_URL";

const CONNECT_BUDGET: Duration = Duration::from_secs(10);
const RESPONSE_BUDGET: Duration = Duration::from_secs(30);
const BODY_BUDGET: Duration = Duration::from_secs(30);
/// The most of an answer the command reads: a page or a list of pages is far
/// smaller.
const BODY_LIMIT: u64 = 10 * 1024 * 1024;

/// Read Marfa's public docs: search them, list their pages, or print one.
///
/// Reads the docs site at https://docs.marfa.so, or at the address in
/// MARFA_DOCS_URL. It needs no server, store or key, and sends no credential.
///
/// A page is its path on the site. `get-started/files`, `/get-started/files`,
/// `get-started/files.md` and `https://docs.marfa.so/get-started/files` name
/// the same page. `search`, `topics` and `help` are commands, so a page with
/// one of those names takes a leading slash, such as `/search`.
///
/// `--url` and `--key` name a Marfa server, so this command refuses them.
#[derive(Debug, Args)]
#[command(
    args_conflicts_with_subcommands = true,
    arg_required_else_help = true,
    after_long_help = "Examples:\n  marfa docs search \"restore an archive\" --limit 5\n  marfa docs topics\n  marfa docs get-started/files"
)]
pub struct DocsArgs {
    /// The page to print, as Markdown: its path on the docs site, or its address.
    #[arg(value_name = "PAGE")]
    pub page: Option<String>,
    #[command(subcommand)]
    pub command: Option<DocsCommand>,
}

#[derive(Debug, Subcommand)]
pub enum DocsCommand {
    /// Search the docs, best match first: each page's title, address and a snippet.
    Search {
        /// What to look for.
        #[arg(allow_hyphen_values = true, value_parser = NonEmptyStringValueParser::new())]
        query: String,
        /// How many pages at most, 1 to 50. Unset takes the site's own default.
        #[arg(long, value_name = "N", value_parser = clap::value_parser!(u8).range(1..=50))]
        limit: Option<u8>,
    },
    /// Every docs page: its title, address and description.
    Topics,
}

#[derive(Debug, Deserialize)]
struct Hit {
    title: String,
    url: String,
    #[serde(default)]
    snippets: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Hits {
    hits: Vec<Hit>,
}

#[derive(Debug, Deserialize)]
struct Topic {
    title: String,
    url: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Topics {
    pages: Vec<Topic>,
}

/// A page read: where it came from, and its Markdown as served, read as
/// UTF-8.
#[derive(Debug, PartialEq, Eq)]
pub struct Page {
    pub path: String,
    pub url: String,
    pub markdown: String,
}

struct Answer {
    status: u16,
    content_type: String,
    body: String,
}

/// The docs site and a client that holds no credential.
pub struct Site {
    base: String,
    agent: ureq::Agent,
    body_limit: u64,
}

impl Site {
    /// `MARFA_DOCS_URL` where it is set and not empty, else the public site.
    pub fn from_environment() -> Result<Site, CliError> {
        match std::env::var(SITE_VARIABLE) {
            Ok(address) if !address.trim().is_empty() => Site::at(&address),
            _ => Site::at(DEFAULT_SITE),
        }
    }

    pub fn at(address: &str) -> Result<Site, CliError> {
        Site::with_budgets(address, RESPONSE_BUDGET, BODY_BUDGET)
    }

    fn with_budgets(
        address: &str,
        recv_response: Duration,
        recv_body: Duration,
    ) -> Result<Site, CliError> {
        let base = address.trim().trim_end_matches('/').to_string();
        let parsed = Url::parse(&base).ok().filter(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.query().is_none()
                && url.fragment().is_none()
        });
        if parsed.is_none() {
            return Err(CliError::Invalid(format!(
                "{SITE_VARIABLE} is {address:?}, which is not an http or https address with a host and no query or fragment"
            )));
        }
        // The platform trust store, as the rest of the binary uses.
        let tls = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .http_status_as_error(false)
            .max_redirects(5)
            .timeout_connect(Some(CONNECT_BUDGET))
            .timeout_recv_response(Some(recv_response))
            .timeout_recv_body(Some(recv_body))
            .user_agent(concat!("marfa/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Ok(Site {
            base,
            agent,
            body_limit: BODY_LIMIT,
        })
    }

    fn unreachable(&self, reason: impl Into<String>) -> CliError {
        CliError::DocsUnreachable {
            address: self.base.clone(),
            reason: reason.into(),
        }
    }

    fn get(&self, path: &str, query: &[(&str, String)]) -> Result<(Url, Answer), CliError> {
        let mut url = Url::parse(&format!("{}{path}", self.base))
            .map_err(|error| CliError::Invalid(format!("{path} is not an address: {error}")))?;
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (name, value) in query {
                pairs.append_pair(name, value);
            }
        }
        let mut response = self
            .agent
            .get(url.as_str())
            .header("Accept", "application/json, text/markdown;q=0.9, */*;q=0.1")
            .call()
            .map_err(|error| self.unreachable(error.to_string()))?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        // Only a success is read: the status says what a refusal is, whatever
        // its body holds.
        let body = if (200..300).contains(&status) {
            self.read(path, response.body_mut())?
        } else {
            String::new()
        };
        Ok((
            url,
            Answer {
                status,
                content_type,
                body,
            },
        ))
    }

    /// A body as text. A body the command will not read, because it is
    /// larger than it reads or is not UTF-8, is an answer it cannot decode,
    /// which a retry does not change; one that fails part way is the network.
    fn read(&self, path: &str, body: &mut ureq::Body) -> Result<String, CliError> {
        let cannot = |what: String| {
            CliError::Core(CoreError::Decoding(format!(
                "the docs site at {} answered {path} with a body the command cannot read: {what}",
                self.base
            )))
        };
        let bytes = body
            .with_config()
            // The reader refuses when the limit is spent before the end, so a
            // body of exactly the limit needs one byte more than it.
            .limit(self.body_limit + 1)
            .read_to_vec()
            .map_err(|error| match error {
                ureq::Error::BodyExceedsLimit(_) => {
                    cannot(format!("it is larger than {} bytes", self.body_limit))
                }
                other => self.unreachable(other.to_string()),
            })?;
        String::from_utf8(bytes).map_err(|_| cannot("it is not UTF-8".into()))
    }

    /// What a status other than the one a call expects says.
    fn refused(&self, path: &str, status: u16) -> CliError {
        self.unreachable(format!("answered {status} for {path}"))
    }

    fn json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<(Value, T), CliError> {
        let (_, answer) = self.get(path, query)?;
        if !(200..300).contains(&answer.status) {
            return Err(self.refused(path, answer.status));
        }
        let malformed = |what: String| {
            CliError::Core(CoreError::Decoding(format!(
                "the docs site at {} did not answer {path} with the JSON expected: {what}",
                self.base
            )))
        };
        let value: Value =
            serde_json::from_str(&answer.body).map_err(|error| malformed(error.to_string()))?;
        let typed =
            serde_json::from_value(value.clone()).map_err(|error| malformed(error.to_string()))?;
        Ok((value, typed))
    }

    /// The answer as the site sent it: `{ "hits": [...] }`.
    pub fn search(&self, query: &str, limit: Option<u8>) -> Result<Value, CliError> {
        let mut parameters = vec![("q", query.to_string())];
        if let Some(limit) = limit {
            parameters.push(("limit", limit.to_string()));
        }
        Ok(self.json::<Hits>("/api/docs/search", &parameters)?.0)
    }

    /// The answer as the site sent it: `{ "pages": [...] }`.
    pub fn topics(&self) -> Result<Value, CliError> {
        Ok(self.json::<Topics>("/api/docs/topics", &[])?.0)
    }

    pub fn page(&self, named: &str) -> Result<Page, CliError> {
        let path = page_path(named)?;
        let (url, answer) = self.get(&format!("/{path}.md"), &[])?;
        match answer.status {
            200..300 => {}
            404 => return Err(CliError::DocsPageNotFound { path }),
            status => return Err(self.refused(&format!("/{path}.md"), status)),
        }
        // A site that answers an unknown address with its own page, rather
        // than a 404, would otherwise print HTML as though it were the page.
        if answer.content_type.starts_with("text/html") {
            return Err(CliError::Core(CoreError::Decoding(format!(
                "the docs site at {} answered /{path}.md with HTML, not Markdown",
                self.base
            ))));
        }
        Ok(Page {
            path,
            url: url.to_string(),
            markdown: answer.body,
        })
    }
}

/// One path for every way a page is named: `get-started/files`, with a
/// leading slash, a leading `docs/`, a trailing `.md`, or the whole address
/// of the page.
pub fn page_path(named: &str) -> Result<String, CliError> {
    let refused = || {
        CliError::Invalid(format!(
            "{named:?} is not a docs page: give its path, such as get-started/files, or its address"
        ))
    };
    let named = named.trim();
    let path = if named.starts_with("http://") || named.starts_with("https://") {
        Url::parse(named).map_err(|_| refused())?.path().to_string()
    } else {
        named
            .split(['?', '#'])
            .next()
            .unwrap_or_default()
            .to_string()
    };
    let path = path.trim_matches('/');
    let path = path.strip_prefix("docs/").unwrap_or(path);
    let path = path.strip_suffix(".md").unwrap_or(path);
    let valid = !path.is_empty()
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~'))
        });
    if valid {
        Ok(path.to_string())
    } else {
        Err(refused())
    }
}

/// A snippet or description on one line, however the site wrapped it.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn describe_hits(query: &str, hits: &Hits) -> String {
    if hits.hits.is_empty() {
        return format!("no docs page matches {query:?}");
    }
    hits.hits
        .iter()
        .map(|hit| {
            let mut entry = format!("{}  {}", hit.title, hit.url);
            if let Some(snippet) = hit.snippets.first() {
                entry.push_str(&format!("\n  {}", one_line(snippet)));
            }
            entry
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn describe_topics(topics: &Topics) -> String {
    topics
        .pages
        .iter()
        .map(|page| {
            let mut entry = format!("{}  {}", page.title, page.url);
            if let Some(description) = page.description.as_deref().map(one_line)
                && !description.is_empty()
            {
                entry.push_str(&format!("\n  {description}"));
            }
            entry
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn run(args: DocsArgs, named: &Named, out: &Printer) -> Result<(), CliError> {
    if named.url.is_some() || named.key.is_some() {
        return Err(CliError::Usage(format!(
            "docs reads the docs site and takes neither --url nor --key; {SITE_VARIABLE} names another site"
        )));
    }
    let site = Site::from_environment()?;
    match (args.command, args.page) {
        (Some(DocsCommand::Search { query, limit }), _) => {
            let answer = site.search(&query, limit)?;
            let hits: Hits = serde_json::from_value(answer.clone())?;
            out.report(&answer, || describe_hits(&query, &hits))
        }
        (Some(DocsCommand::Topics), _) => {
            let answer = site.topics()?;
            let topics: Topics = serde_json::from_value(answer.clone())?;
            out.report(&answer, || describe_topics(&topics))
        }
        (None, Some(page)) => {
            let page = site.page(&page)?;
            if out.json {
                out.value(&json!({
                    "path": page.path,
                    "url": page.url,
                    "markdown": page.markdown,
                }))
            } else {
                out.raw(&page.markdown)
            }
        }
        // clap refuses a bare `docs` and prints the help.
        (None, None) => Err(CliError::Usage(
            "a page or a subcommand is required; --help lists them".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::door::{Answer, Door};

    fn answer(status: &'static str, content_type: &'static str, body: &str) -> Answer {
        Answer {
            status,
            content_type,
            body: body.to_string(),
            headers: Vec::new(),
        }
    }

    fn markdown(status: &'static str, body: &str) -> Answer {
        answer(status, "text/markdown; charset=utf-8", body)
    }

    fn json(body: &str) -> Answer {
        answer("200 OK", "application/json", body)
    }

    const HITS: &str = r#"{"hits":[
        {"title":"Files","url":"https://docs.marfa.so/get-started/files","snippets":["a  folder\nof files","second"]},
        {"title":"Bare","url":"https://docs.marfa.so/bare","snippets":[]}]}"#;

    const PAGES: &str = r#"{"pages":[
        {"title":"Files","url":"https://docs.marfa.so/get-started/files","description":"Keep files.","breadcrumbs":["Get started"]},
        {"title":"Bare","url":"https://docs.marfa.so/bare","description":null,"breadcrumbs":[]}]}"#;

    fn closed_port() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    }

    #[test]
    fn every_way_to_name_a_page_is_one_path() {
        for named in [
            "get-started/files",
            "/get-started/files",
            "get-started/files/",
            "get-started/files.md",
            "/get-started/files.md",
            "docs/get-started/files",
            "/docs/get-started/files.md",
            "get-started/files#a-heading",
            "get-started/files?x=1",
            "  get-started/files  ",
            "https://docs.marfa.so/get-started/files",
            "https://docs.marfa.so/get-started/files.md",
            "https://docs.marfa.so/docs/get-started/files/",
            "http://localhost:3000/get-started/files?q=1#top",
        ] {
            assert_eq!(page_path(named).unwrap(), "get-started/files", "{named}");
        }
        assert_eq!(page_path("get-started").unwrap(), "get-started");
        assert_eq!(page_path("docs").unwrap(), "docs");
        assert_eq!(page_path("v1.2/a_b~c").unwrap(), "v1.2/a_b~c");
    }

    #[test]
    fn a_name_that_is_not_a_path_is_refused_before_anything_is_sent() {
        for named in [
            "",
            "/",
            ".md",
            "https://docs.marfa.so/",
            "../etc/passwd",
            "a/../b",
            "a//b",
            "a b",
            "a%2Fb",
            "https://",
        ] {
            let error = page_path(named).unwrap_err();
            assert!(matches!(error, CliError::Invalid(_)), "{named:?}");
        }
    }

    #[test]
    fn a_search_asks_the_site_with_the_query_encoded_and_no_credential() {
        let door = Door::open(vec![json(HITS), json(HITS)]);
        let site = Site::at(&format!("{}/", door.url)).unwrap();
        let value = site.search("files & folders/é", Some(7)).unwrap();
        assert_eq!(value["hits"][0]["title"], "Files");
        site.search("plain", None).unwrap();
        let received = door.received();
        assert_eq!(received[0].method(), "GET");
        assert_eq!(
            received[0].path(),
            "/api/docs/search?q=files+%26+folders%2F%C3%A9&limit=7"
        );
        assert_eq!(received[1].path(), "/api/docs/search?q=plain");
        for request in received {
            assert_eq!(request.header("authorization"), None);
            assert_eq!(request.header("cookie"), None);
            assert!(
                request.header("user-agent").unwrap().starts_with("marfa/"),
                "{:?}",
                request.header("user-agent")
            );
        }
    }

    #[test]
    fn the_topics_are_read_from_their_own_door() {
        let door = Door::open(vec![json(PAGES)]);
        let site = Site::at(&door.url).unwrap();
        let value = site.topics().unwrap();
        assert_eq!(value["pages"][1]["description"], Value::Null);
        let received = door.received();
        assert_eq!(received[0].path(), "/api/docs/topics");
        assert_eq!(received[0].header("authorization"), None);
    }

    #[test]
    fn a_page_is_read_from_its_markdown_address_whichever_way_it_is_named() {
        let body = "# Files\n\nKeep files.\n\n\n";
        let door = Door::open(vec![
            markdown("200 OK", body),
            markdown("200 OK", body),
            markdown("200 OK", body),
            markdown("200 OK", body),
        ]);
        let site = Site::at(&door.url).unwrap();
        let url = format!("{}/get-started/files.md", door.url);
        for named in [
            "get-started/files",
            "/get-started/files",
            "get-started/files.md",
            "https://docs.marfa.so/docs/get-started/files",
        ] {
            let page = site.page(named).unwrap();
            assert_eq!(
                page,
                Page {
                    path: "get-started/files".into(),
                    url: url.clone(),
                    markdown: body.into()
                },
                "{named}"
            );
        }
        let received = door.received();
        assert!(received.iter().all(|request| {
            request.path() == "/get-started/files.md" && request.header("authorization").is_none()
        }));
    }

    #[test]
    fn a_page_is_read_without_checking_a_contract() {
        // The answer names none, as the real site's does not.
        let door = Door::open(vec![markdown("200 OK", "# Files\n")]);
        let page = Site::at(&door.url).unwrap().page("files").unwrap();
        assert_eq!(page.markdown, "# Files\n");
        door.received();
    }

    #[test]
    fn a_missing_page_is_named_and_refused() {
        let door = Door::open(vec![answer("404 Not Found", "text/plain", "not found")]);
        let error = Site::at(&door.url)
            .unwrap()
            .page("/docs/nope.md")
            .unwrap_err();
        assert_eq!(error.code(), "docs_page_not_found");
        assert_eq!(error.exit(), crate::error::Exit::Refused);
        let message = error.to_string();
        assert!(message.contains("nope"), "{message}");
        assert!(message.contains("marfa docs search"), "{message}");
        door.received();
    }

    #[test]
    fn a_site_that_answers_with_a_server_fault_or_nothing_useful_is_unreachable() {
        for status in [
            "500 Internal Server Error",
            "503 Service Unavailable",
            "429 Too Many Requests",
            "403 Forbidden",
        ] {
            let door = Door::open(vec![
                answer(status, "text/plain", "no"),
                answer(status, "text/plain", "no"),
                answer(status, "text/plain", "no"),
            ]);
            let site = Site::at(&door.url).unwrap();
            let errors = [
                site.page("files").unwrap_err(),
                site.search("x", None).unwrap_err(),
                site.topics().unwrap_err(),
            ];
            for error in errors {
                assert_eq!(error.code(), "docs_unreachable", "{status}");
                assert_eq!(error.exit(), crate::error::Exit::Environment);
                assert!(error.to_string().contains(&door.url), "{error}");
            }
            door.received();
        }
    }

    #[test]
    fn a_site_that_is_not_listening_is_unreachable() {
        let address = closed_port();
        let error = Site::at(&address).unwrap().page("files").unwrap_err();
        assert_eq!(error.code(), "docs_unreachable");
        assert_eq!(error.exit(), crate::error::Exit::Environment);
        assert!(error.to_string().contains(&address), "{error}");
        let envelope = error.envelope();
        assert_eq!(envelope["exit"], 3);
        assert!(envelope["error"]["server"].is_null());
    }

    #[test]
    fn a_site_that_never_answers_is_unreachable_once_the_budget_is_spent() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let site = Site::with_budgets(
            &address,
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .unwrap();
        let started = std::time::Instant::now();
        let error = site.topics().unwrap_err();
        assert_eq!(error.code(), "docs_unreachable", "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(listener);
    }

    #[test]
    fn an_answer_that_is_not_the_json_expected_is_a_decoding_error() {
        let door = Door::open(vec![
            json("not json"),
            json(r#"{"hits":"none"}"#),
            json(r#"{"pages":[{"url":"u"}]}"#),
            answer("200 OK", "text/html", "<html></html>"),
        ]);
        let site = Site::at(&door.url).unwrap();
        let errors = [
            site.search("x", None).unwrap_err(),
            site.search("x", None).unwrap_err(),
            site.topics().unwrap_err(),
            site.page("files").unwrap_err(),
        ];
        for error in errors {
            assert_eq!(error.code(), "decoding", "{error}");
            assert_eq!(error.exit(), crate::error::Exit::Environment);
            assert!(error.to_string().contains(&door.url), "{error}");
        }
        door.received();
    }

    fn redirect(to: &str) -> Answer {
        answer("302 Found", "text/plain", "").with_header("Location", to)
    }

    /// A site that answers each connection with these bytes, whole, and
    /// closes it.
    fn raw_site(reply: &'static [u8]) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut head = [0u8; 4096];
                let _ = stream.read(&mut head);
                let _ = stream.write_all(reply);
            }
        });
        address
    }

    #[test]
    fn up_to_five_redirects_in_a_row_are_followed_and_the_page_keeps_the_address_asked_for() {
        let door = Door::open_at(|url| {
            vec![
                redirect("/a.md"),
                redirect("/b.md"),
                redirect(&format!("{url}/c.md")),
                redirect("/d.md"),
                redirect("/e.md"),
                markdown("200 OK", "# Moved\n"),
            ]
        });
        let page = Site::at(&door.url).unwrap().page("moved").unwrap();
        assert_eq!(page.markdown, "# Moved\n");
        assert_eq!(page.url, format!("{}/moved.md", door.url));
        let received = door.received();
        let paths: Vec<&str> = received.iter().map(|r| r.path()).collect();
        assert_eq!(
            paths,
            ["/moved.md", "/a.md", "/b.md", "/c.md", "/d.md", "/e.md"]
        );
        assert!(received.iter().all(|r| r.header("authorization").is_none()));
    }

    #[test]
    fn a_sixth_redirect_in_a_row_is_the_site_failing() {
        let door = Door::open((0..6).map(|n| redirect(&format!("/{n}.md"))).collect());
        let error = Site::at(&door.url).unwrap().page("moved").unwrap_err();
        assert_eq!(error.code(), "docs_unreachable", "{error}");
        assert!(error.to_string().contains("too many redirects"), "{error}");
        assert_eq!(error.exit(), crate::error::Exit::Environment);
        assert_eq!(door.received().len(), 6);
    }

    #[test]
    fn a_body_larger_than_the_command_reads_is_a_decoding_error_whatever_the_status_says_after() {
        let door = Door::open(vec![
            markdown("200 OK", &"a".repeat(16)),
            markdown("200 OK", &"a".repeat(17)),
            answer("404 Not Found", "text/plain", &"a".repeat(17)),
        ]);
        let mut site = Site::at(&door.url).unwrap();
        site.body_limit = 16;
        // The witness: a body at the limit is read.
        assert_eq!(site.page("files").unwrap().markdown.len(), 16);
        let error = site.page("files").unwrap_err();
        assert_eq!(error.code(), "decoding", "{error}");
        assert_eq!(error.exit(), crate::error::Exit::Environment);
        assert!(
            error.to_string().contains("larger than 16 bytes"),
            "{error}"
        );
        // A refusal is read from its status, not its body.
        assert_eq!(
            site.page("files").unwrap_err().code(),
            "docs_page_not_found"
        );
        door.received();
    }

    #[test]
    fn a_body_that_is_not_utf8_is_a_decoding_error_but_a_refusal_is_still_a_refusal() {
        let page = raw_site(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/markdown\r\nContent-Length: 3\r\nConnection: close\r\n\r\n\xff\xfe\xfd",
        );
        let error = Site::at(&page).unwrap().page("files").unwrap_err();
        assert_eq!(error.code(), "decoding", "{error}");
        assert!(error.to_string().contains("not UTF-8"), "{error}");
        let missing = raw_site(
            b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\n\xff\xfe\xfd",
        );
        assert_eq!(
            Site::at(&missing)
                .unwrap()
                .page("files")
                .unwrap_err()
                .code(),
            "docs_page_not_found"
        );
    }

    #[test]
    fn the_address_must_be_http_or_https() {
        for address in [
            "docs.marfa.so",
            "ftp://docs.marfa.so",
            "https://",
            "x?y=1",
            "https://docs.marfa.so?q=1",
            "https://docs.marfa.so/#top",
        ] {
            assert!(
                matches!(Site::at(address), Err(CliError::Invalid(_))),
                "{address}"
            );
        }
        assert!(Site::at("https://docs.marfa.so///").is_ok());
    }

    #[test]
    fn a_hit_is_its_title_and_address_with_its_first_snippet_under_it() {
        let hits: Hits = serde_json::from_str(HITS).unwrap();
        assert_eq!(
            describe_hits("files", &hits),
            "Files  https://docs.marfa.so/get-started/files\n  a folder of files\n\
             Bare  https://docs.marfa.so/bare"
        );
        let none: Hits = serde_json::from_str(r#"{"hits":[]}"#).unwrap();
        assert_eq!(describe_hits("zzz", &none), "no docs page matches \"zzz\"");
    }

    #[test]
    fn a_topic_is_its_title_and_address_with_its_description_under_it() {
        let topics: Topics = serde_json::from_str(PAGES).unwrap();
        assert_eq!(
            describe_topics(&topics),
            "Files  https://docs.marfa.so/get-started/files\n  Keep files.\n\
             Bare  https://docs.marfa.so/bare"
        );
    }
}
