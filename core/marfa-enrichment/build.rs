//! Links the native readers when the `native` feature is on: the C++ shim, which
//! is compiled here, and the static libraries and models that
//! `native/build.sh` put in the prefix named by `MARFA_NATIVE_PREFIX`. Nothing is
//! downloaded here.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    refuse_faults_in_a_release();
    #[cfg(feature = "native")]
    native::link();
}

/// A shipped program must not crash on demand. A release build has to say that it
/// means it, as the proof binary of a release does.
fn refuse_faults_in_a_release() {
    println!("cargo:rerun-if-env-changed=MARFA_ENRICHMENT_ALLOW_FAULTS");
    let faults = std::env::var_os("CARGO_FEATURE_FAULT_INJECTION").is_some();
    let release = std::env::var("PROFILE").is_ok_and(|profile| profile == "release");
    if faults && release && std::env::var_os("MARFA_ENRICHMENT_ALLOW_FAULTS").is_none() {
        eprintln!(
            "\nmarfa-enrichment: the `fault-injection` feature makes a reader crash on marked \
             bytes,\nand this is a release build. To build a proof program on purpose, set \
             MARFA_ENRICHMENT_ALLOW_FAULTS=1.\n"
        );
        std::process::exit(1);
    }
}

#[cfg(feature = "native")]
mod native {
    use std::env;
    use std::fmt::Write as _;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process;

    fn stop(message: &str) -> ! {
        eprintln!("\nmarfa-enrichment: {message}\n");
        process::exit(1);
    }

    /// The languages of the models the manifest lists.
    fn models(manifest: &Path) -> Vec<String> {
        let text = fs::read_to_string(manifest)
            .unwrap_or_else(|error| stop(&format!("cannot read {}: {error}", manifest.display())));
        let languages: Vec<String> = text
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                (fields.next() == Some("model")).then(|| fields.next().map(str::to_owned))?
            })
            .collect();
        if languages.is_empty() {
            stop(&format!("{} lists no model", manifest.display()));
        }
        languages
    }

    pub fn link() {
        println!("cargo:rerun-if-env-changed=MARFA_NATIVE_PREFIX");
        let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
        let manifest = manifest_dir.join("native/manifest.txt");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rerun-if-changed=native/shim.cc");
        println!("cargo:rerun-if-changed=native/shim.h");

        let target = env::var("TARGET").unwrap();
        let Some(prefix) = env::var_os("MARFA_NATIVE_PREFIX").map(PathBuf::from) else {
            stop(&format!(
                "the `native` feature needs MARFA_NATIVE_PREFIX, the folder that\n\
                 `native/build.sh {target}` fills with lib/, include/ and tessdata/.\n\
                 See the README of this crate, section Building the native readers."
            ));
        };
        for needed in [
            "lib/libtesseract.a",
            "lib/libleptonica.a",
            "lib/libpdfium.a",
            "include/tesseract/baseapi.h",
        ] {
            if !prefix.join(needed).is_file() {
                stop(&format!(
                    "MARFA_NATIVE_PREFIX is {}, which has no {needed}.\n\
                     Run `native/build.sh {target}` to make it.",
                    prefix.display()
                ));
            }
        }

        let languages = models(&manifest);
        let mut table = String::from("pub(crate) static MODELS: &[(&str, &[u8])] = &[\n");
        for language in &languages {
            let file = prefix
                .join("tessdata")
                .join(format!("{language}.traineddata"));
            if !file.is_file() {
                stop(&format!(
                    "the manifest lists the model {language}, and {} is missing.\n\
                     Run `native/models.sh {target}`.",
                    file.display()
                ));
            }
            println!("cargo:rerun-if-changed={}", file.display());
            writeln!(
                table,
                "    ({language:?}, include_bytes!({:?})),",
                file.display().to_string()
            )
            .unwrap();
        }
        table.push_str("];\n");
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        fs::write(out.join("models.rs"), table).unwrap();

        let mut shim = cc::Build::new();
        shim.cpp(true)
            .std("c++17")
            .file("native/shim.cc")
            .include(prefix.join("include"))
            .warnings(true)
            .extra_warnings(true)
            .flag_if_supported("-fvisibility=hidden");
        if env::var_os("CARGO_FEATURE_FAULT_INJECTION").is_some() {
            shim.define("MARFA_FAULT_INJECTION", None);
        }
        shim.compile("marfa_shim");

        println!(
            "cargo:rustc-link-search=native={}",
            prefix.join("lib").display()
        );
        // Tesseract before Leptonica, which it calls.
        println!("cargo:rustc-link-lib=static=tesseract");
        println!("cargo:rustc-link-lib=static=leptonica");
        println!("cargo:rustc-link-lib=static=pdfium");

        match env::var("CARGO_CFG_TARGET_OS").unwrap().as_str() {
            "macos" => {
                println!("cargo:rustc-link-lib=dylib=c++");
                println!("cargo:rustc-link-lib=framework=CoreGraphics");
                println!("cargo:rustc-link-lib=framework=CoreFoundation");
            }
            "linux" => {
                // The C++ library is the compiler's. A static program needs its
                // archive, which sits beside the compiler, not on a path rustc knows.
                let compiler = shim.get_compiler();
                let found = compiler
                    .to_command()
                    .arg("-print-file-name=libstdc++.a")
                    .output()
                    .ok()
                    .and_then(|output| String::from_utf8(output.stdout).ok())
                    .map(|path| PathBuf::from(path.trim()));
                if let Some(dir) = found.as_deref().and_then(Path::parent)
                    && dir.is_dir()
                {
                    println!("cargo:rustc-link-search=native={}", dir.display());
                }
                println!("cargo:rustc-link-lib=static=stdc++");
                // Rust's standard library asks for `libunwind`, the LLVM unwinder that
                // its own musl bundle carries. This program is linked with the
                // compiler's C library and C++ library, and libstdc++ throws through
                // the compiler's `libgcc_eh`; a second unwinder beside it would
                // compete for the same symbols. A linker script under the name
                // `libunwind.a` sends the request to `libgcc_eh`.
                let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
                fs::write(out.join("libunwind.a"), "INPUT(-lgcc_eh)\n").unwrap();
                println!("cargo:rustc-link-search=native={}", out.display());
            }
            other => stop(&format!(
                "the `native` feature does not support {other} yet"
            )),
        }
    }
}
