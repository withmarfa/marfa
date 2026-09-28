//! What a folder takes (`folders.md` 25, 26): its include and ignore lists,
//! in gitignore syntax, the built-in lists no setting reaches past, and the
//! packages its walk does not enter.

use std::path::Path;

use globset::{GlobBuilder, GlobMatcher};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use unicode_normalization::UnicodeNormalization;

use crate::Result;
use crate::error::CoreError;

/// The folder's own state, and another folder's inside it.
const STATE: &[&str] = &[".marfa"];

/// What a machine writes beside a person's files for itself.
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

/// What an editor keeps beside the file it has open: a swap, a backup, a
/// lock.
const SWAP: &[&str] = &["*.swp", "*~", ".#*", "~$*", "*.tmp", ".~lock.*#"];

/// Files that exist to hold a secret in a form anyone holding the file can
/// use: sent, it reaches every machine and key that reads the folder, and
/// cannot be called back.
const SECRETS: &[&str] = &[
    // Environment files, which hold the values a program is given.
    ".env",
    ".env.*",
    // Private keys and the bundles that carry one.
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    // SSH's own key names.
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    // Plain-text logins for a network, a registry or a database.
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    // The names cloud tools give a stored login.
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

/// A folder's lists, compared in NFC and without regard to case (27).
pub struct Lists {
    machine: Gitignore,
    secrets: Gitignore,
    include: Gitignore,
    /// The include lines that name a dot-led name, which alone reach one.
    dotted: Gitignore,
    /// Those dot-led names, so the walk enters only a directory one names.
    dotted_names: Vec<GlobMatcher>,
    ignore: Gitignore,
}

impl Lists {
    /// The lists a folder's settings name, refused where a line is not a
    /// pattern.
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
            dotted_names.push(
                GlobBuilder::new(&name)
                    .case_insensitive(true)
                    .literal_separator(true)
                    .build()
                    .map_err(|error| refused("include", &name, &error.to_string()))?
                    .compile_matcher(),
            );
        }
        Ok(Lists {
            machine: built("built-in", &owned(&[STATE, JUNK, SWAP].concat()))?,
            secrets: built("built-in", &owned(SECRETS))?,
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
        if [&self.machine, &self.secrets, &self.ignore]
            .into_iter()
            .any(|list| hit(list, &path, false))
        {
            return false;
        }
        if !self.include.is_empty() && !hit(&self.include, &path, false) {
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
        !name.starts_with('.') || hit(&self.dotted, &path, false)
    }

    /// Whether the built-in secrets list refuses the file at `relative`.
    pub(super) fn secret(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        hit(&self.secrets, &path, false)
    }

    /// Whether the walk enters the directory at `relative`: never one the
    /// ignore list or the machine's own lines name, and a dot-led one only
    /// where an include line names it. A secret's name is refused file by
    /// file, so a package named like one is still reported.
    pub(super) fn enters(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        if hit(&self.machine, &path, true) || hit(&self.ignore, &path, true) {
            return false;
        }
        let name = path.rsplit('/').next().unwrap_or(&path);
        !name.starts_with('.') || self.dotted_names.iter().any(|glob| glob.is_match(name))
    }
}

fn hit(list: &Gitignore, path: &str, is_dir: bool) -> bool {
    list.matched_path_or_any_parents(path, is_dir).is_ignore()
}

fn built(list: &str, lines: &[String]) -> Result<Gitignore> {
    let mut builder = GitignoreBuilder::new("");
    builder
        .case_insensitive(true)
        .map_err(|error| refused(list, "", &error.to_string()))?;
    for line in lines {
        let line: String = line.nfc().collect();
        builder
            .add_line(None, &line)
            .map_err(|error| refused(list, &line, &error.to_string()))?;
    }
    builder
        .build()
        .map_err(|error| refused(list, "", &error.to_string()))
}

fn refused(list: &str, line: &str, why: &str) -> CoreError {
    CoreError::Invalid(format!(
        "the folder's {list} list holds {line:?}, which is not a gitignore pattern: {why}"
    ))
}

/// The dot-led names a gitignore line names, each as a glob of one name.
fn dot_names(line: &str) -> Vec<String> {
    let line = line.trim();
    let line = line.strip_prefix('!').unwrap_or(line);
    line.nfc()
        .collect::<String>()
        .split('/')
        .filter(|name| name.starts_with('.') && *name != "." && *name != "..")
        .map(str::to_string)
        .collect()
}

/// Whether the directory at `path` is a package: named with an extension
/// macOS opens as one document or program, or one the system marks so.
pub(super) fn is_package(path: &Path) -> bool {
    // Only a name with an extension is asked of the system, which a walk
    // would otherwise ask of every directory on every pass.
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };
    PACKAGES
        .iter()
        .any(|known| known.eq_ignore_ascii_case(extension))
        || system::marks(path)
}

/// Whether a path inside the folder lies in a package, where no walk reads
/// it back.
pub(super) fn in_package(root: &Path, relative: &str) -> bool {
    let mut here = root.to_path_buf();
    let mut names = relative.split('/').peekable();
    while let Some(name) = names.next() {
        if names.peek().is_none() {
            break;
        }
        here.push(name);
        if is_package(&here) {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
mod system {
    use std::path::Path;

    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::error::CFErrorRef;
    use core_foundation::string::CFStringRef;
    use core_foundation::url::{CFURL, CFURLRef, kCFURLIsPackageKey};

    unsafe extern "C" {
        fn CFURLCopyResourcePropertyForKey(
            url: CFURLRef,
            key: CFStringRef,
            value: *mut CFTypeRef,
            error: *mut CFErrorRef,
        ) -> u8;
    }

    /// Whether the system opens the directory as one thing, by its type or
    /// by the bundle bit, as the Finder does.
    pub(super) fn marks(path: &Path) -> bool {
        let Some(url) = CFURL::from_path(path, true) else {
            return false;
        };
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: the URL outlives the call, the key is CoreFoundation's own
        // constant, and a null error pointer asks for no error.
        let found = unsafe {
            CFURLCopyResourcePropertyForKey(
                url.as_concrete_TypeRef(),
                kCFURLIsPackageKey,
                &mut value,
                std::ptr::null_mut(),
            )
        };
        if found == 0 || value.is_null() {
            return false;
        }
        // SAFETY: a Copy function hands its caller the one reference, which
        // the wrapper releases.
        let value = unsafe { CFType::wrap_under_create_rule(value) };
        value.downcast::<CFBoolean>().is_some_and(bool::from)
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    pub(super) fn marks(_path: &std::path::Path) -> bool {
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
    fn takes_everything_not_dot_led_where_no_list_names_anything() {
        let open = lists(&[], &[]);
        assert!(open.takes("note.md"));
        assert!(open.takes("deep/photo.png"));
        assert!(!open.takes(".hidden/note.md"));
        assert!(!open.takes("deep/.note.md"));
        assert!(open.enters("deep"));
        assert!(!open.enters(".git"));
    }

    #[test]
    fn an_include_narrows_and_an_ignore_removes_even_from_it() {
        let narrowed = lists(&["Notes/", "*.txt"], &["Notes/drafts/"]);
        assert!(narrowed.takes("Notes/plan.md"));
        assert!(narrowed.takes("elsewhere/list.txt"));
        assert!(!narrowed.takes("elsewhere/plan.md"));
        assert!(!narrowed.takes("Notes/drafts/plan.md"));
        assert!(!narrowed.enters("Notes/drafts"));
        // Compared without regard to case or form.
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
    fn takes_nothing_under_a_dot_led_directory_the_walk_does_not_enter() {
        let named = lists(&[".notes/"], &[]);
        assert!(named.takes(".notes/plan.md"));
        assert!(named.enters(".notes"));
        assert!(!named.enters(".notes/.hidden"));
        assert!(!named.takes(".notes/.hidden/plan.md"));
        let unwalked = lists(&["*", "!.git/"], &[]);
        assert!(!unwalked.enters(".git"));
        assert!(!unwalked.takes(".git/HEAD"));
        assert!(unwalked.takes("plan.md"));
        let both = lists(&[".notes/", ".hidden/"], &[]);
        assert!(both.enters(".notes/.hidden"));
        assert!(both.takes(".notes/.hidden/plan.md"));
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
        ] {
            assert!(!reaching.takes(path), "{path:?} was taken");
        }
        // The control: the same lists take a note, and `Icon` without its
        // carriage return is a name like any other.
        assert!(reaching.takes("note.md"));
        assert!(reaching.takes("Icon"));
    }

    #[test]
    fn refuses_a_line_that_is_not_a_pattern() {
        let bad = vec!["a{b".to_string()];
        assert!(Lists::new(&bad, &[]).is_err());
        assert!(Lists::new(&[], &bad).is_err());
    }

    #[test]
    fn a_package_is_known_by_its_extension() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["Deck.key", "Tool.APP", "Notes.rtfd"] {
            assert!(is_package(&dir.path().join(name)), "{name}");
        }
        std::fs::create_dir(dir.path().join("plain.d")).unwrap();
        assert!(!is_package(&dir.path().join("plain.d")));
        assert!(!is_package(&dir.path().join("Notes")));
        assert!(in_package(dir.path(), "Deck.key/Data/a.md"));
        assert!(!in_package(dir.path(), "Notes/Deck.key"));
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
