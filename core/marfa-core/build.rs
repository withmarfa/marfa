use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=sqlite/directory.c");
    println!("cargo:rerun-if-changed=sqlite/register.c");
    if env::var_os("CARGO_CFG_UNIX").is_none() {
        return;
    }
    let source = PathBuf::from(env::var_os("DEP_SQLITE3_INCLUDE").expect("bundled SQLite source"));
    let bytes = fs::read(source.join("sqlite3.c")).expect("read pinned SQLite amalgamation");
    assert_eq!(
        hex::encode(Sha256::digest(&bytes)),
        "0a409f1633283fa31a9126b11fbfd64a1991c5d30defad07e5745d4667f5e23d",
        "review the directory extension before changing SQLite"
    );
    let text = String::from_utf8(bytes).unwrap();
    let start = text.find("/************** Begin file os_unix.c").unwrap();
    let end = text.find("/************** End of os_unix.c").unwrap();
    let mut unix = text[start..end].to_string();
    for (from, to) in [
        ("osStat(", "marfaStat("),
        ("osLstat(", "marfaLstat("),
        ("osAccess(", "marfaAccess("),
        ("osUnlink(", "marfaUnlink("),
        ("osOpenDirectory(", "marfaOpenDirectory("),
        ("osOpen(z,", "marfaOpen(z,"),
    ] {
        unix = unix.replace(from, to);
    }
    unix = unix.replace(
        "typedef struct unixFile unixFile;",
        "typedef struct MarfaDirectory MarfaDirectory;\ntypedef struct unixFile unixFile;",
    );
    unix = unix.replace("sqlite3_io_methods const *pMethod;  /* Always the first entry */", "sqlite3_io_methods const *pMethod;  /* Always the first entry */\n  MarfaDirectory *marfaDirectory;");
    unix = unix.replace(
        "  memset(pFile, 0, sizeof(unixFile));",
        "  marfaRelease(pFile->marfaDirectory);\n  memset(pFile, 0, sizeof(unixFile));",
    );
    unix = unix.replacen("  switch( op ){", "  if( pFile->marfaDirectory && (op==SQLITE_FCNTL_SET_LOCKPROXYFILE || op==SQLITE_FCNTL_GET_LOCKPROXYFILE) ) return SQLITE_NOTFOUND;\n  switch( op ){", 1);
    unix = unix.replace(
        "struct unixShmNode {",
        "struct unixShmNode {\n  MarfaDirectory *marfaDirectory;\n  char *marfaFilename;",
    );
    unix = unix.replace("    p->pInode->pShmNode = 0;", "    p->pInode->pShmNode = 0;\n    sqlite3_free(p->marfaFilename);\n    marfaRelease(p->marfaDirectory);");
    unix = unix.replace("  /* Make the new connection a child of the unixShmNode */", "  if( !pShmNode->marfaDirectory ){\n    MarfaDirectory *directory = marfaRetain(pDbFd->zPath);\n    if( directory ){\n      char *anchored = sqlite3_mprintf(\"%s-shm\", pDbFd->zPath);\n      if( !anchored ){ marfaRelease(directory); rc=SQLITE_NOMEM; goto shm_open_err; }\n      pShmNode->marfaDirectory = directory;\n      pShmNode->marfaFilename = anchored;\n      pShmNode->zFilename = anchored;\n    }\n  }\n  /* Make the new connection a child of the unixShmNode */");
    unix = unix.replace(
        "unixGetTempname(pVfs->mxPathname, zTmpname)",
        "marfaTempname(pVfs, pVfs->mxPathname, zTmpname)",
    );
    unix = unix.replace(
        "unixGetTempname(pFile->pVfs->mxPathname, zTFile)",
        "marfaTempname(pFile->pVfs, pFile->pVfs->mxPathname, zTFile)",
    );
    unix = unix.replace("statfs(filePath, &fsInfo)", "fstatfs(pNew->h, &fsInfo)");
    let insert = unix.find("static int robust_open(").unwrap();
    unix.insert_str(insert, &fs::read_to_string("sqlite/directory.c").unwrap());
    unix.push_str(&fs::read_to_string("sqlite/register.c").unwrap());
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let extended = out.join("directory-sqlite.c");
    fs::write(
        &extended,
        format!("{}{}{}", &text[..start], unix, &text[end..]),
    )
    .unwrap();
    let mut build = cc::Build::new();
    build.file(extended).include(&source).warnings(false);
    for option in [
        "SQLITE_CORE",
        "SQLITE_DEFAULT_FOREIGN_KEYS=1",
        "SQLITE_ENABLE_API_ARMOR",
        "SQLITE_ENABLE_COLUMN_METADATA",
        "SQLITE_ENABLE_DBSTAT_VTAB",
        "SQLITE_ENABLE_FTS3",
        "SQLITE_ENABLE_FTS3_PARENTHESIS",
        "SQLITE_ENABLE_FTS5",
        "SQLITE_ENABLE_JSON1",
        "SQLITE_ENABLE_LOAD_EXTENSION=1",
        "SQLITE_ENABLE_MEMORY_MANAGEMENT",
        "SQLITE_ENABLE_RTREE",
        "SQLITE_ENABLE_STAT4",
        "SQLITE_SOUNDEX",
        "SQLITE_THREADSAFE=1",
        "SQLITE_USE_URI",
        "HAVE_USLEEP=1",
        "HAVE_ISNAN",
        "HAVE_LOCALTIME_R",
        "_POSIX_THREAD_SAFE_FUNCTIONS",
    ] {
        build.flag(format!("-D{option}"));
    }
    for name in [
        "SQLITE_MAX_VARIABLE_NUMBER",
        "SQLITE_MAX_EXPR_DEPTH",
        "SQLITE_MAX_COLUMN",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        if let Ok(value) = env::var(name) {
            assert!(
                value.bytes().all(|byte| byte.is_ascii_digit()),
                "{name} must be an integer"
            );
            build.flag(format!("-D{name}={value}"));
            println!("cargo:rustc-env=MARFA_EXPECT_{name}={value}");
        }
    }
    println!("cargo:rerun-if-env-changed=LIBSQLITE3_FLAGS");
    if let Ok(flags) = env::var("LIBSQLITE3_FLAGS") {
        for option in flags.split_whitespace() {
            let name = option.trim_start_matches("-D").trim_start_matches("-U");
            assert!(
                ![
                    "SQLITE_OS_OTHER",
                    "SQLITE_OMIT_WAL",
                    "SQLITE_OMIT_COMPILEOPTION_DIAGS",
                    "SQLITE_SHM_DIRECTORY",
                    "SQLITE_THREADSAFE"
                ]
                .iter()
                .any(|unsupported| name.split('=').next() == Some(*unsupported)),
                "{option} changes a required directory-storage invariant"
            );
            if option.starts_with("-D") || option.starts_with("-U") {
                build.flag(option);
            } else if option.starts_with("SQLITE_") {
                build.flag(format!("-D{option}"));
            } else {
                panic!("unsupported LIBSQLITE3_FLAGS input: {option}");
            }
        }
    }
    // The linked dependency has already built, so its actual option strings
    // also cover Cargo feature unification outside this crate.
    let native = PathBuf::from(env::var_os("DEP_SQLITE3_LIB_DIR").expect("bundled SQLite archive"));
    let archive =
        fs::read(native.join("libsqlite3.a")).expect("read bundled SQLite compile options");
    for option in [
        "ENABLE_UNLOCK_NOTIFY",
        "ENABLE_PREUPDATE_HOOK",
        "ENABLE_SESSION",
    ] {
        let needle = format!("{option}\0");
        if archive
            .windows(needle.len())
            .any(|bytes| bytes == needle.as_bytes())
        {
            build.flag(format!("-DSQLITE_{option}"));
        }
    }
    build.compile("marfa_directory_sqlite");
}
