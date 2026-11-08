#!/bin/bash
# Gathers what a program must carry with it, for a target, into
# $MARFA_NATIVE_ROOT/out/<target>/NOTICES.txt: for each part of the program its
# name, version, licence and where the text came from, then the licence texts.
#
#   MARFA_NATIVE_ROOT=<folder> native/licenses.sh <target> [--out <file>] [<crate>...]
#
# The crates are the programs' own, whose dependencies are listed (default
# marfa-enrichment). PDFium, Tesseract and Leptonica are named when a crate is
# marfa-enrichment or the dependencies hold pdfium-render.
#
# The texts come from the pinned sources only: PDFium's own list (made by its build),
# the Leptonica and Tesseract source archives (copied by tesseract.sh), the licence
# lines of the manifest, the Rust distribution on the builder, and the source of each
# Rust crate the program holds, as Cargo.lock pinned it. Needs cargo and python3, on
# the same Rust that native/program.sh uses.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
shift
select_root
need cargo rustc python3

CORE=$(cd "$NATIVE_DIR/../.." && pwd)
OUT="$ROOT/out/$TARGET"
mkdir -p "$OUT"
NOTICES="$OUT/NOTICES.txt"
roots=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a file"; NOTICES=$2; shift 2 ;;
    -*) die "unknown option $1" ;;
    *) roots+=("$1"); shift ;;
  esac
done
[ ${#roots[@]} -gt 0 ] || roots=(marfa-enrichment)
STAGE="$WORK/licenses"
rm -rf "$STAGE"
mkdir -p "$STAGE"

[ -d "$PREFIX/licenses/pdfium" ] || die "no PDFium licences in $PREFIX; run native/pdfium.sh $TARGET first"
[ -f "$PREFIX/licenses/tesseract.txt" ] || die "no Tesseract licence in $PREFIX; run native/tesseract.sh $TARGET first"

sysroot_docs="$(rustc --print sysroot)/share/doc/rust"
[ -f "$sysroot_docs/COPYRIGHT-library.html" ] || die "the Rust on PATH has no $sysroot_docs/COPYRIGHT-library.html"

licence_into tessdata_fast "$STAGE/tessdata_fast.txt"
if [ -n "$MUSL_TOOLCHAIN" ]; then
  licence_into musl "$STAGE/musl.txt"
  licence_into gcc-copying3 "$STAGE/gcc-copying3.txt"
  licence_into gcc-runtime-exception "$STAGE/gcc-runtime-exception.txt"
fi

# The crates the program holds: the normal dependencies of the program's crate for
# this target and its features, never the build tools or the tests.
metadata="$STAGE/metadata.json"
(cd "$CORE" && cargo metadata --format-version 1 --locked --filter-platform "$TARGET" \
  --features native >"$metadata") || die "cargo metadata failed"

python3 -I - "$metadata" "$NOTICES" "$PREFIX" "$STAGE" "$sysroot_docs" "$TARGET" "$MUSL_TOOLCHAIN" "${roots[@]}" <<'PY'
import json, os, sys

metadata, notices, prefix, stage, rust_docs, target, linux = sys.argv[1:8]
root_names = sys.argv[8:]
data = json.load(open(metadata))
packages = {p["id"]: p for p in data["packages"]}
nodes = {n["id"]: n for n in data["resolve"]["nodes"]}
by_name = {p["name"]: p["id"] for p in data["packages"] if p["source"] is None}
roots = [by_name[name] for name in root_names]

# Normal dependencies only (dep kind null); build and dev dependencies do not ship.
seen, todo = set(), list(roots)
while todo:
    current = todo.pop()
    if current in seen:
        continue
    seen.add(current)
    for dep in nodes[current]["deps"]:
        if any(kind["kind"] is None for kind in dep["dep_kinds"]):
            todo.append(dep["pkg"])
# The workspace's own crates are the programs, not what they hold.
seen = {i for i in seen if packages[i]["source"] is not None}
native = "marfa-enrichment" in root_names or any(packages[i]["name"] == "pdfium-render" for i in seen)

def read(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read().rstrip() + "\n"

out = []
def section(title, source, body):
    out.append("=" * 78)
    out.append(title)
    out.append("Source of the text: " + source)
    out.append("=" * 78)
    out.append(body)

out.append("Licences of what this program holds.\n"
           "Each section names a part, its licence and where the text came from.\n")

parts = []
if native:
    parts += [
        ("PDFium", "BSD-3-Clause and the licences of its bundled libraries",
         "the licence list of the PDFium build (staging/licenses of bblanchon/pdfium-binaries)"),
        ("Tesseract 5.5.4", "Apache-2.0", "the Tesseract source archive pinned in manifest.txt"),
        ("Leptonica 1.87.0", "BSD-2-Clause style (Leptonica licence)", "the Leptonica source archive pinned in manifest.txt"),
        ("tessdata_fast models (eng, deu, fra, spa, jpn, chi_sim)", "Apache-2.0", "tesseract-ocr/tessdata_fast at the pinned commit"),
    ]
parts.append(("The Rust standard library", "MIT OR Apache-2.0, with the licences of its own parts", "the Rust distribution that built the program"))
if linux:
    parts.append(("musl libc 1.2.2-git-50-gb76f37fd", "MIT", "the COPYRIGHT file of musl at that commit"))
    gcc = "libstdc++ and libgcc" if native else "libgcc"
    parts.append((f"{gcc} from GCC 11.2.1", "GPL-3.0-or-later WITH GCC-exception-3.1", "COPYING3 and COPYING.RUNTIME of GCC 11.2.0"))
for name, licence, source in parts:
    out.append(f"- {name}: {licence}. Text: {source}.")
out.append(f"- {len(seen)} Rust crates (listed below with their licences).")
out.append("")

if native:
    pdfium_dir = os.path.join(prefix, "licenses", "pdfium")
    for name in sorted(os.listdir(pdfium_dir)):
        section(f"PDFium: {name}", f"licenses/pdfium/{name} from the PDFium build", read(os.path.join(pdfium_dir, name)))
    section("Tesseract", "Tesseract source archive, LICENSE", read(os.path.join(prefix, "licenses", "tesseract.txt")))
    section("Leptonica", "Leptonica source archive, leptonica-license.txt", read(os.path.join(prefix, "licenses", "leptonica.txt")))
    section("tessdata_fast models", "tessdata_fast LICENSE (manifest.txt)", read(os.path.join(stage, "tessdata_fast.txt")))
section("Rust standard library", "share/doc/rust/COPYRIGHT-library.html of the Rust distribution", read(os.path.join(rust_docs, "COPYRIGHT-library.html")))
for name in ("MIT.txt", "Apache-2.0.txt"):
    section(f"Rust standard library: {name}", "share/doc/rust/licenses/" + name + " of the Rust distribution", read(os.path.join(rust_docs, "licenses", name)))
if linux:
    section("musl libc", "COPYRIGHT of musl (manifest.txt)", read(os.path.join(stage, "musl.txt")))
    section(f"{gcc}: GNU GPL version 3", "COPYING3 of GCC 11.2.0 (manifest.txt)", read(os.path.join(stage, "gcc-copying3.txt")))
    section(f"{gcc}: GCC Runtime Library Exception 3.1", "COPYING.RUNTIME of GCC 11.2.0 (manifest.txt)", read(os.path.join(stage, "gcc-runtime-exception.txt")))

# A crate's licence files are its own, from the source Cargo.lock pinned.
names = ("LICENSE", "LICENCE", "COPYING", "UNLICENSE", "NOTICE", "COPYRIGHT")
missing = []
for pid in sorted(seen, key=lambda i: (packages[i]["name"], packages[i]["version"])):
    package = packages[pid]
    folder = os.path.dirname(package["manifest_path"])
    files = sorted(
        f for f in os.listdir(folder)
        if os.path.isfile(os.path.join(folder, f)) and f.upper().startswith(names)
    )
    title = f"Rust crate {package['name']} {package['version']}: {package.get('license') or 'see its files'}"
    if not files:
        missing.append(title)
        out.append("=" * 78)
        out.append(title)
        out.append("Its package holds no licence file; the licence is the one in its Cargo.toml.")
        out.append("=" * 78)
        out.append("")
        continue
    for f in files:
        section(f"{title} ({f})", f"{package['name']}-{package['version']}/{f}, from the crate source", read(os.path.join(folder, f)))

open(notices, "w", encoding="utf-8").write("\n".join(out))
print(f"licenses: {len(seen)} crates, {len(missing)} with no licence file in the package")
for title in missing:
    print("  no file: " + title)
PY
echo "licenses: wrote $NOTICES ($(wc -c <"$NOTICES") bytes)"
