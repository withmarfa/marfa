use std::path::Path;
use std::sync::OnceLock;

use marfa_rules::pattern::{self, Line, dot_names};
use regex::{Regex, RegexSet};
use unicode_normalization::UnicodeNormalization;

use crate::Result;
use crate::error::CoreError;

/// The folder's own state, and another folder's inside it.
const STATE: &[&str] = &[".marfa"];

const JUNK: &[&str] = &[
    ".DS_Store",
    "Thumbs.db",
    "._*",
    ".Spotlight-V100",
    ".Trashes",
    // A class, because a gitignore line loses a trailing `\r` as whitespace.
    "Icon[\r]",
    "desktop.ini",
];

/// What an editor keeps beside an open file, and what a download or a copy
/// writes before its bytes are whole.
const SWAP: &[&str] = &[
    "*.swp",
    "*~",
    ".#*",
    // Escaped, because a gitignore line opening with `#` is a comment.
    "\\#*#",
    "~$*",
    "*.tmp",
    ".~lock.*#",
    "*___jb_tmp___",
    "*___jb_old___",
    "*.crswap",
    "*.crdownload",
    "*.part",
    "*.download",
];

/// Files that exist to hold a secret in a form anyone holding the file can
/// use: sent, it reaches every machine and key that reads the folder, and
/// cannot be called back.
const SECRETS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    "credentials",
    "*credentials.json",
    "credentials.db",
];

/// Directory extensions macOS shows and opens as one document or program.
const PACKAGES: &[&str] = &[
    "app",
    "bundle",
    "pages",
    "numbers",
    "key",
    "photoslibrary",
    "xcodeproj",
    "rtfd",
];

pub struct Lists {
    machine: &'static Patterns,
    secrets: &'static Patterns,
    include: Patterns,
    /// The include lines that name a dot-led name, which alone reach one.
    dotted: Patterns,
    /// Those dot-led names, so the walk enters only a directory one names.
    dotted_names: Vec<DotName>,
    ignore: Patterns,
}

struct Patterns {
    original: Lines,
    folded: Lines,
}

/// One list's gitignore lines, compiled together.
struct Lines {
    set: RegexSet,
    /// Each pattern in `set`, in order.
    lines: Vec<Line>,
}

impl Lines {
    fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// The last line that matches `path`, as gitignore reads a list.
    fn matched(&self, path: &str, is_dir: bool) -> Option<&Line> {
        self.set
            .matches(path)
            .into_iter()
            .rev()
            .map(|at| &self.lines[at])
            .find(|line| !line.is_only_dir || is_dir)
    }
}

struct DotName {
    original: Regex,
    folded: Regex,
}

impl DotName {
    fn is_match(&self, name: &str) -> bool {
        self.original.is_match(name) || self.folded.is_match(&marfa_rules::names::folded(name))
    }
}

impl Lists {
    pub fn new(include: &[String], ignore: &[String]) -> Result<Lists> {
        let owned = |lines: &[&str]| {
            lines
                .iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
        };
        let dotted: Vec<String> = include
            .iter()
            .filter(|line| line.trim_start().starts_with('!') || !dot_names(line).is_empty())
            .cloned()
            .collect();
        let mut dotted_names = Vec::new();
        // A `!` line names no directory to enter.
        for name in include
            .iter()
            .filter(|line| !line.trim_start().starts_with('!'))
            .flat_map(|line| dot_names(line))
        {
            let (original, folded) = pattern::name_regexes(&name).map_err(CoreError::Invalid)?;
            dotted_names.push(DotName { original, folded });
        }
        // Compiled once: every pass builds the folder's lists, and these
        // lines never change.
        static BUILT_IN: OnceLock<(Patterns, Patterns)> = OnceLock::new();
        let (machine, secrets) = BUILT_IN.get_or_init(|| {
            (
                built("built-in", &owned(&[STATE, JUNK, SWAP].concat()))
                    .expect("the built-in lines are patterns"),
                built("built-in", &owned(SECRETS)).expect("the built-in lines are patterns"),
            )
        });
        Ok(Lists {
            machine,
            secrets,
            include: built("include", include)?,
            dotted: built("include", &dotted)?,
            dotted_names,
            ignore: built("ignore", ignore)?,
        })
    }

    /// As wide as the built-in lists, entering the dot-led directories
    /// `include` names: a look into another folder never narrower than it.
    pub(super) fn wider(include: &[String]) -> Result<Lists> {
        let mut lines = vec!["*".to_string()];
        lines.extend(
            include
                .iter()
                .filter(|line| !line.trim_start().starts_with('!') && !dot_names(line).is_empty())
                .cloned(),
        );
        Lists::new(&lines, &[])
    }

    /// Whether the folder takes the file at `relative`, a path inside it
    /// with `/` between its names.
    pub fn takes(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        let folded = marfa_rules::names::folded(&path);
        if [self.machine, self.secrets, &self.ignore]
            .into_iter()
            .any(|list| hit(list, &path, &folded, false))
        {
            return false;
        }
        if !self.include.original.is_empty() && !hit(&self.include, &path, &folded, false) {
            return false;
        }
        // Every dot-led directory on the way is one the walk enters, or a
        // pull would write where no scan looks.
        let (name, directories) = path
            .rsplit_once('/')
            .map_or((path.as_str(), ""), |(dirs, name)| (name, dirs));
        if directories
            .split('/')
            .filter(|dir| dir.starts_with('.'))
            .any(|dir| !self.dotted_names.iter().any(|glob| glob.is_match(dir)))
        {
            return false;
        }
        !name.starts_with('.') || hit(&self.dotted, &path, &folded, false)
    }

    pub(super) fn secret(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        hit(
            self.secrets,
            &path,
            &marfa_rules::names::folded(&path),
            false,
        )
    }

    /// A secret's name is refused file by file, so a package named like one is
    /// still reported.
    pub(super) fn enters(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        let folded = marfa_rules::names::folded(&path);
        if hit(self.machine, &path, &folded, true) || hit(&self.ignore, &path, &folded, true) {
            return false;
        }
        let name = path.rsplit('/').next().unwrap_or(&path);
        !name.starts_with('.') || self.dotted_names.iter().any(|glob| glob.is_match(name))
    }
}

fn hit(list: &Patterns, path: &str, folded: &str, mut is_dir: bool) -> bool {
    let (mut path, mut folded) = (path, folded);
    loop {
        // Resolve line order across both forms before walking to a parent:
        // a direct match, including a negation, takes precedence over one there.
        let matched = [
            list.original.matched(path, is_dir),
            list.folded.matched(folded, is_dir),
        ]
        .into_iter()
        .flatten()
        .max_by_key(|line| line.index);
        if let Some(line) = matched {
            return !line.is_whitelist;
        }
        let (Some((parent, _)), Some((folded_parent, _))) =
            (path.rsplit_once('/'), folded.rsplit_once('/'))
        else {
            return false;
        };
        (path, folded, is_dir) = (parent, folded_parent, true);
    }
}

fn built(list: &str, lines: &[String]) -> Result<Patterns> {
    let compiled = pattern::compile_list(list, lines).map_err(CoreError::Invalid)?;
    let set = |form: pattern::Form| {
        pattern::regex_set(list, &form.regexes)
            .map(|set| Lines {
                set,
                lines: form.lines,
            })
            .map_err(CoreError::Invalid)
    };
    Ok(Patterns {
        original: set(compiled.original)?,
        folded: set(compiled.folded)?,
    })
}

pub(super) fn is_package_at(path: &Path, directory: &crate::directory::Directory) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    PACKAGES
        .iter()
        .any(|known| known.eq_ignore_ascii_case(extension))
        || system::marks(extension, directory.file())
}

#[cfg(all(test, target_os = "macos"))]
fn is_package(path: &Path) -> bool {
    crate::directory::Directory::open(&path.canonicalize().unwrap())
        .is_ok_and(|directory| is_package_at(path, &directory))
}

pub(super) fn in_package(root: &crate::directory::Directory, relative: &str) -> bool {
    let mut directory = root.clone();
    let mut label = std::path::PathBuf::new();
    let mut names = relative.split('/').peekable();
    while let Some(name) = names.next() {
        if names.peek().is_none() {
            break;
        }
        label.push(name);
        let Ok(child) = directory.child(Path::new(name), false) else {
            return false;
        };
        if is_package_at(&label, &child) {
            return true;
        }
        directory = child;
    }
    false
}

#[cfg(target_os = "macos")]
mod system {
    use core_foundation::{base::TCFType, string::CFString};
    use std::ffi::{c_char, c_void};
    use xattr::FileExt;
    type Object = *const c_void;
    #[link(name = "UniformTypeIdentifiers", kind = "framework")]
    unsafe extern "C" {
        static UTTypePackage: Object;
        static UTTypeDirectory: Object;
    }
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Object;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    pub(super) fn marks(extension: &str, directory: &std::fs::File) -> bool {
        if directory
            .get_xattr("com.apple.FinderInfo")
            .ok()
            .flatten()
            .is_some_and(|info| info.len() >= 10 && info[8] & 0x20 != 0)
        {
            return true;
        }
        let extension = CFString::new(extension);
        // SAFETY: these are the Objective-C signatures declared by UTType.h.
        // CFString is toll-free bridged to NSString, and all autoreleased
        // objects stay inside this thread's pool until the conformance check.
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let type_for: unsafe extern "C" fn(Object, Object, Object, Object) -> Object =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let conforms: unsafe extern "C" fn(Object, Object, Object) -> bool =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let kind = type_for(
                objc_getClass(c"UTType".as_ptr()),
                sel_registerName(c"typeWithFilenameExtension:conformingToType:".as_ptr()),
                extension.as_concrete_TypeRef().cast(),
                UTTypeDirectory,
            );
            let package = !kind.is_null()
                && conforms(
                    kind,
                    sel_registerName(c"conformsToType:".as_ptr()),
                    UTTypePackage,
                );
            objc_autoreleasePoolPop(pool);
            package
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    pub(super) fn marks(_extension: &str, _directory: &std::fs::File) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lists(include: &[&str], ignore: &[&str]) -> Lists {
        let owned = |lines: &[&str]| {
            lines
                .iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
        };
        Lists::new(&owned(include), &owned(ignore)).unwrap()
    }

    #[test]
    fn an_include_narrows_and_an_ignore_removes_even_from_it() {
        let narrowed = lists(&["Notes/", "*.txt"], &["Notes/drafts/"]);
        assert!(narrowed.takes("Notes/plan.md"));
        assert!(narrowed.takes("elsewhere/list.txt"));
        assert!(!narrowed.takes("elsewhere/plan.md"));
        assert!(!narrowed.takes("Notes/drafts/plan.md"));
        assert!(!narrowed.enters("Notes/drafts"));
        assert!(narrowed.takes("notes/Plan.md"));
        assert!(lists(&["Caf\u{e9}/"], &[]).takes("Cafe\u{301}/menu.md"));
    }

    #[test]
    fn an_include_reaches_a_dot_led_path_only_where_it_names_one() {
        let dotted = lists(&[".notes/", "*.md"], &[]);
        assert!(dotted.enters(".notes"));
        assert!(dotted.takes(".notes/a.md"));
        assert!(dotted.takes(".notes/deep/a.md"));
        assert!(!dotted.enters(".git"));
        assert!(!dotted.takes(".git/a.md"));
        assert!(!dotted.enters(".marfa"));
        assert!(!lists(&[".marfa/"], &[]).takes(".marfa/folder.yaml"));
    }

    #[test]
    fn a_wider_look_enters_what_the_folder_includes_and_everything_else() {
        let wider = Lists::wider(&["*.md".into(), ".notes/".into(), "!.notes/x".into()]).unwrap();
        assert!(wider.enters(".notes"));
        assert!(wider.takes(".notes/plan.md"));
        assert!(wider.takes(".notes/x"));
        assert!(wider.takes("photo.png"));
        assert!(!wider.enters(".git"));
        assert!(!wider.takes(".env"));
    }

    #[test]
    fn a_built_in_line_stands_whatever_the_lists_say() {
        let reaching = lists(&[".env", "*.pem", ".DS_Store", "*.swp", "*"], &[]);
        for path in [
            ".env",
            "deep/.env.local",
            "server.pem",
            "Server.PEM",
            "ssh/id_ed25519",
            "id_rsa.pub",
            "Deep/credentials",
            "gcloud/application_default_credentials.json",
            ".DS_Store",
            "._photo.jpg",
            "Icon\r",
            "desktop.ini",
            "note.md.swp",
            "note.md~",
            "~$report.docx",
            ".~lock.sheet.ods#",
            "draft.tmp",
            "#note.md#",
            "Deep/#note.md#",
            "notes.txt___jb_tmp___",
            "notes.txt___jb_old___",
            "page.html.crswap",
            "report.pdf.crdownload",
            "archive.zip.part",
            "movie.mov.download",
            "image.png.download/image.png",
        ] {
            assert!(!reaching.takes(path), "{path:?} was taken");
        }
        assert!(reaching.takes("note.md"));
        assert!(reaching.takes("Icon"));
        assert!(reaching.takes("#hashtag.md"));
        assert!(!reaching.enters("image.png.download"));
    }

    #[test]
    fn refuses_a_line_that_is_not_a_pattern() {
        let bad = vec!["a{b".to_string()];
        assert!(Lists::new(&bad, &[]).is_err());
        assert!(Lists::new(&[], &bad).is_err());
    }

    #[test]
    fn literal_folding_preserves_classes_and_escaped_metacharacters() {
        for pattern in ["[A-z]CAFÉ.md", "[Z-a]CAFÉ.md"] {
            let included = lists(&[pattern], &[]);
            assert!(included.takes("_Cafe\u{301}.md"));
            assert!(!included.takes("5Café.md"));
        }
        for (pattern, name) in [
            ("[]A-Z]CAFÉ.md", "]café.md"),
            ("[!A-Z]CAFÉ.md", "5café.md"),
            ("[CAFÉ.md", "[café.md"),
            (r"\[CAFÉ\].md", "[café].md"),
            (r"\?CAFÉ.md", "?café.md"),
            (r"\!CAFÉ.md", "!café.md"),
            (r"\#CAFÉ.md", "#café.md"),
            (r"\{CAFÉ\}.md", "{café}.md"),
            (r"\\CAFÉ.md", "\\café.md"),
            (r"CAFÉ.md\ ", "café.md "),
            ("\\J\u{30c}.md", "ǰ.md"),
            ("J\\\u{30c}.md", "ǰ.md"),
            ("{CAFÉ,ÉTÉ}.md", "été.md"),
        ] {
            assert!(lists(&[pattern], &[]).takes(name), "{pattern:?}, {name:?}");
        }
        assert!(Lists::new(&["[z-a]".into()], &[]).is_err());
        assert!(Lists::new(&[], &["[z-a]".into()]).is_err());
    }

    #[test]
    fn a_class_or_a_question_mark_matches_one_character_outside_ascii() {
        for (pattern, name, matches) in [
            ("caf[\u{e9}\u{e8}].md", "caf\u{e9}.md", true),
            ("caf[\u{e9}\u{e8}].md", "caf\u{e8}.md", true),
            ("caf[\u{e9}\u{e8}].md", "cafe.md", false),
            ("caf[\u{e0}-\u{ea}].md", "caf\u{e9}.md", true),
            ("caf[\u{e0}-\u{ea}].md", "caf\u{eb}.md", false),
            ("CAF[\u{c9}].md", "caf\u{e9}.md", true),
            ("caf[\u{e9}].md", "cafe\u{301}.md", true),
            ("caf[!\u{e9}].md", "caf\u{e8}.md", true),
            ("caf[!\u{e9}].md", "caf\u{e9}.md", false),
            ("caf?.md", "caf\u{e9}.md", true),
            ("caf?.md", "caf.md", false),
            (
                "\u{65e5}[\u{672c}]?.md",
                "\u{65e5}\u{672c}\u{8a9e}.md",
                true,
            ),
        ] {
            assert_eq!(
                !lists(&[], &[pattern]).takes(name),
                matches,
                "{pattern:?}, {name:?}"
            );
        }
        assert!(lists(&[".caf[\u{e9}]/"], &[]).enters(".caf\u{e9}"));
    }

    #[test]
    fn a_wildcard_crosses_a_newline_in_a_name() {
        let bare = lists(&[], &[]);
        assert!(!bare.takes("keys\n/id_rsa"));
        assert!(!bare.takes("a\nb/server.pem"));
        assert!(!bare.takes("}\n/k~~"));
        assert!(lists(&["docs/**"], &[]).takes("docs/a\nb.md"));
        assert!(!lists(&[], &["drafts/**"]).takes("drafts/a\nb.md"));
        assert!(lists(&[".a*/"], &[]).enters(".a\nb"));
    }

    #[test]
    fn case_is_ignored_as_names_compare_and_no_further() {
        // Unicode's own case pairs that the name comparison does not fold.
        assert!(lists(&[], &["S"]).takes("\u{17f}"));
        assert!(lists(&[], &["*\u{3c3}.md"]).takes("\u{3bb}\u{3cc}\u{3b3}\u{3bf}\u{3c2}.md"));
        // What it does fold, through the folded form.
        assert!(!lists(&[], &["k"]).takes("\u{212a}"));
        assert!(!lists(&[], &["CAF\u{c9}.md"]).takes("caf\u{e9}.md"));
        // ASCII case in classes and literals alike.
        assert!(!lists(&[], &["[a-c]*.MD"]).takes("B.md"));
        assert!(!lists(&[], &["[!a-c]*.md"]).takes("D.md"));
        assert!(lists(&[], &["[!a-c]*.md"]).takes("C.md"));
        // A negated class outside ASCII, either case on either side.
        assert!(lists(&[], &["[!\u{c9}]*.md"]).takes("\u{e9}.md"));
        assert!(lists(&[], &["[!\u{c9}]*.md"]).takes("\u{c9}.md"));
        assert!(lists(&[], &["[!\u{e9}]*.md"]).takes("\u{c9}.md"));
        assert!(lists(&[], &["[!\u{c0}-\u{de}]x"]).takes("\u{e0}x"));
        assert!(!lists(&[], &["[!\u{c9}]*.md"]).takes("\u{e8}.md"));
        // Letters whose other case is more than one step away.
        assert!(lists(&[], &["[!\u{df}]x"]).takes("\u{1e9e}x"));
        for name in ["\u{1c4}x", "\u{1c5}x", "\u{1c6}x"] {
            assert!(lists(&[], &["[!\u{1c5}]x"]).takes(name), "{name:?}");
            assert!(!lists(&[], &["[\u{1c5}]x"]).takes(name), "{name:?}");
        }
        assert!(lists(&[], &["[!\u{3b8}]x"]).takes("\u{3f4}x"));
        assert!(lists(&[], &["[!\u{1f80}]x"]).takes("\u{1f88}x"));
    }

    #[test]
    fn a_long_list_compiles_when_each_of_its_lines_does() {
        let long: Vec<String> = (0..4000).map(|i| format!("*cache{i}*")).collect();
        let lists = Lists::new(&[], &long).unwrap();
        assert!(!lists.takes("a/xcache3999y.md"));
        assert!(lists.takes("a/notes.md"));
    }

    #[test]
    fn a_line_naming_only_directories_never_names_the_folder_itself() {
        assert!(!lists(&["*/"], &[]).takes("top.md"));
        assert!(lists(&["*/"], &[]).takes("deep/top.md"));
        assert!(!lists(&["/"], &[]).takes("top.md"));
        assert!(lists(&[], &["**/"]).takes("top.md"));
    }

    #[test]
    fn wildcard_matching_keeps_the_original_name_alongside_its_folded_form() {
        assert!(lists(&["??.md"], &[]).takes("İ.md"));
        assert!(!lists(&[], &["??.md"]).takes("İ.md"));
        let dotted = lists(&[".??/**"], &[]);
        assert!(dotted.enters(".İ"));
        assert!(dotted.takes(".İ/note.md"));
    }

    #[test]
    fn line_order_is_shared_by_original_and_folded_matches() {
        assert!(!lists(&["??.md", "!i\u{307}.md"], &[]).takes("İ.md"));
        assert!(lists(&["!i\u{307}.md", "??.md"], &[]).takes("İ.md"));
        assert!(lists(&[], &["??.md", "!i\u{307}.md"]).takes("İ.md"));
        assert!(!lists(&[], &["!i\u{307}.md", "??.md"]).takes("İ.md"));

        // More than ten lines distinguish numeric from unpadded string order.
        let mut ignore = vec![""; 12];
        ignore[2] = "??.md";
        ignore[10] = "!i\u{307}.md";
        assert!(lists(&[], &ignore).takes("İ.md"));
        ignore.swap(2, 10);
        assert!(!lists(&[], &ignore).takes("İ.md"));
    }

    #[test]
    fn both_forms_match_the_path_before_considering_its_parents() {
        assert!(!lists(&["!i\u{307}/keep.md", "??/"], &[]).takes("İ/keep.md"));
        assert!(lists(&["i\u{307}/keep.md", "!??/"], &[]).takes("İ/keep.md"));
        assert!(!lists(&[], &["i\u{307}/keep.md", "!??/"]).takes("İ/keep.md"));
        assert!(lists(&[], &["!i\u{307}/keep.md", "??/"]).takes("İ/keep.md"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_directory_the_system_marks_is_a_package() {
        let dir = tempfile::tempdir().unwrap();
        let marked = dir.path().join("Thing.mystery");
        std::fs::create_dir(&marked).unwrap();
        assert!(
            !is_package(&marked),
            "an unmarked directory read as a package"
        );
        // The Finder's bundle bit, in the Finder info's flags.
        let mut info = [0u8; 32];
        info[8] = 0x20;
        let set = std::process::Command::new("xattr")
            .args(["-wx", "com.apple.FinderInfo"])
            .arg(
                info.iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            )
            .arg(&marked)
            .status()
            .unwrap();
        assert!(set.success());
        assert!(
            is_package(&marked),
            "a directory the system marks was not read as a package"
        );
    }
}
