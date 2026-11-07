#!/bin/bash
# Runs the finished programs of a target on real files, with nothing else installed,
# and says what each run showed.
#
#   MARFA_NATIVE_ROOT=<folder> native/verify.sh <target> [--users nobody,root]
#   MARFA_NATIVE_ROOT=<folder> native/verify.sh compare <target-a> <target-b>
#
# On Linux the programs run in a container made `FROM scratch` that holds only the two
# programs and the test files: no shell, no libraries, no /tmp, and the root file
# system read-only. The container runs as an unprivileged user and then as root. On
# macOS the program runs under `env -i`. The programs are the ones native/program.sh
# put in $MARFA_NATIVE_ROOT/out/<target>/.
#
# Cases are of three kinds. Formats: one file of each kind the reader takes, read for
# its known text, and OCR in every language the program carries. Refusals: encrypted,
# damaged and unsupported files. Faults: the proof program, made with fault injection,
# is asked for a real crash, hang, spin, memory blow-up and output flood, each read
# with a good file after it by the same parent, which must survive.
#
# Needs python3 (and Pillow, for the scanned PDF and the memory test's picture) and, on
# Linux, docker. Under `uv`, `uv run --with pillow` finds Pillow. A target other than
# the machine's own runs emulated; the report says which.
#
# MARFA_VERIFY_CORPUS   a folder of real PDFs and pictures, read as well, and kept
#                       with their text so targets can be compared.
# MARFA_VERIFY_MEMORY   a memory limit in bytes added to every run that sets none, and
#                       the least for a run that sets a real one. Needed
#                       to run linux/amd64 on an Apple silicon machine: Rosetta cannot
#                       start a program whose address space is limited to the default
#                       1 GiB (it stops with "rosetta error: mmap_anonymous_rw"), and
#                       2 GiB is enough. Native machines leave it unset.
# MARFA_VERIFY_IMAGE    the name of the container image to make (default
#                       marfa-enrichment-verify). The script removes it at the end.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The OCR text of every case, from every user of the second target, against the first
# user's of the first (the user's name is not part of the comparison: a Mac has one).
compare_targets() {
  local a=$1 b=$2 differ=0 total=0 file other
  select_target "$a"
  select_root
  local dir_a="$ROOT/out/$a/verify/results" dir_b="$ROOT/out/$b/verify/results"
  [ -d "$dir_a" ] && [ -d "$dir_b" ] || die "run verify.sh for both targets first"
  local first_a
  first_a=$(ls "$dir_a" | head -1)
  for file in "$dir_a/$first_a"/ocr-*.stdout "$dir_a/$first_a"/corpus-*.stdout; do
    [ -e "$file" ] || continue
    local name
    name=$(basename "$file")
    for other in "$dir_b"/*/"$name"; do
      total=$((total + 1))
      if [ ! -e "$other" ]; then
        echo "compare: $name is missing for $b"
        differ=$((differ + 1))
      elif ! cmp -s "$file" "$other"; then
        echo "compare: $name differs between $a and $b ($other)"
        diff <(cat "$file") <(cat "$other") | head -10
        differ=$((differ + 1))
      fi
    done
  done
  echo "compare: $total OCR outputs, $((total - differ)) the same byte for byte, $differ different"
  [ "$differ" -eq 0 ]
}

if [ "${1:-}" = compare ]; then
  compare_targets "${2:?two targets}" "${3:?two targets}"
  exit $?
fi

select_target "${1:-}"
shift
users=nobody,root
while [ $# -gt 0 ]; do
  case "$1" in
    --users) users=$2; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
select_root
need python3

CRATE=$(cd "$NATIVE_DIR/.." && pwd)
OUT="$ROOT/out/$TARGET"
V="$OUT/verify"
SERVER_FIXTURES="$CRATE/../../packages/server/src/enrichment/fixtures"
[ -x "$OUT/marfa-enrichment-read" ] && [ -x "$OUT/marfa-enrichment-read-proof" ] \
  || die "no programs in $OUT; run native/program.sh $TARGET first"

case "$TARGET" in
  aarch64-apple-darwin) KIND=mac ;;
  aarch64-unknown-linux-musl) KIND=linux PLATFORM=linux/arm64 ;;
  x86_64-unknown-linux-musl) KIND=linux PLATFORM=linux/amd64 ;;
esac
if [ "$KIND" = linux ]; then
  need docker
  IMAGE=${MARFA_VERIFY_IMAGE:-marfa-enrichment-verify}-${TARGET%%-*}
  # The machine's own architecture runs natively; the other is emulated.
  case "$(uname -m):$PLATFORM" in
    arm64:linux/arm64 | aarch64:linux/arm64 | x86_64:linux/amd64) EMULATED=no ;;
    *) EMULATED="yes (the machine is $(uname -m))" ;;
  esac
else
  EMULATED=no
fi

# The test files.
chmod -R u+w "$V/models" "$V/context" 2>/dev/null || true
rm -rf "$V/context" "$V/results" "$V/models"
FILES_DIR="$V/context/files"
mkdir -p "$FILES_DIR/faults" "$V/models" "$V/results"
cp "$CRATE/fixtures/"* "$FILES_DIR/"
for name in compressed.pdf multipage.pdf sample-extended.webp sample-lossless.webp sample.docx \
  sample.gif sample.jpg sample.mp3 sample.pdf sample.png sample.txt sample.webp sample.xlsx; do
  cp "$SERVER_FIXTURES/$name" "$FILES_DIR/"
done
if python3 -c 'import PIL' 2>/dev/null; then
  python3 -I "$NATIVE_DIR/verify/make-fixtures.py" "$FILES_DIR" "$CRATE/fixtures"
elif command -v uv >/dev/null 2>&1; then
  uv run --quiet --with pillow python3 -I "$NATIVE_DIR/verify/make-fixtures.py" "$FILES_DIR" "$CRATE/fixtures"
else
  python3 -I "$NATIVE_DIR/verify/make-fixtures.py" "$FILES_DIR" "$CRATE/fixtures"
fi
head -c 700 "$FILES_DIR/sample.pdf" >"$FILES_DIR/truncated.pdf"
HAVE_PILLOW=
[ -f "$FILES_DIR/big-text.png" ] && HAVE_PILLOW=1

if [ -n "${MARFA_VERIFY_CORPUS:-}" ]; then
  mkdir -p "$FILES_DIR/corpus"
  cp "$MARFA_VERIFY_CORPUS"/* "$FILES_DIR/corpus/"
fi

if [ "$KIND" = linux ]; then
  FILES=/files
  MODELS=/models
  SCRATCH=/scratch
else
  FILES="$FILES_DIR"
  MODELS="$V/models"
  SCRATCH="$V/scratch"
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH"
fi

fault() { printf 'MARFA-ENRICHMENT-FAULT:%s\nand the rest of the file' "$2" >"$FILES_DIR/faults/$1.txt"; }
for name in segfault abort stack-overflow hang spin eat-memory rust-alloc-fails cpp-new-fails \
  flood-stdout flood-stderr garbage silent close-stdin orphan stopped report fork; do
  fault "$name" "$name"
done
fault too-much-text "too-much-text 100000000"
fault write-file "write-file $SCRATCH/written.txt"
fault open-file "open $FILES/sample.txt"
fault connect "connect 1.1.1.1:80"
fault tcp-loopback "connect 127.0.0.1:9"
fault udp "udp 127.0.0.1:9"
printf 'a good file\n' >"$FILES_DIR/good.txt"

# The owner's model: a copy of the English model under a name of the owner's own, in a
# folder that is read-only.
cp "$DOWNLOADS/eng.traineddata" "$V/models/owner.traineddata"
chmod 444 "$V/models/owner.traineddata"
chmod 555 "$V/models"

if [ "$KIND" = linux ]; then
  cp "$OUT/marfa-enrichment-read" "$OUT/marfa-enrichment-read-proof" "$V/context/"
  printf 'FROM scratch\nCOPY marfa-enrichment-read marfa-enrichment-read-proof /\nCOPY files /files\n' >"$V/context/Dockerfile"
  docker build --quiet --platform "$PLATFORM" -t "$IMAGE" "$V/context" >/dev/null \
    || die "could not build the image $IMAGE"
  trap 'docker rmi "$IMAGE" >/dev/null 2>&1 || true' EXIT
fi

# prog <binary> <args...>, as the user in RUN_USER.
prog() {
  local bin=$1
  shift
  if [ -n "${MARFA_VERIFY_MEMORY:-}" ]; then
    # A limit below this one (but not a token one, which is decided before a child
    # starts) is raised to it, so the runs that set their own still start.
    local args=() previous=
    for arg in "$@"; do
      if [ "$previous" = --max-memory ] && [ "$arg" -ge 100000000 ] && [ "$arg" -lt "$MARFA_VERIFY_MEMORY" ]; then
        arg=$MARFA_VERIFY_MEMORY
      fi
      args+=("$arg")
      previous=$arg
    done
    case " $* " in *" --max-memory "*) ;; *) args+=(--max-memory "$MARFA_VERIFY_MEMORY") ;; esac
    set -- "${args[@]}"
  fi
  if [ "$KIND" = mac ]; then
    env -i "$OUT/$bin" "$@"
  else
    # shellcheck disable=SC2086
    docker run --rm --platform "$PLATFORM" --read-only --user "$RUN_USER" ${DOCKER_EXTRA:-} \
      -v "$V/models:/models:ro" "$IMAGE" "/$bin" "$@"
  fi
}

PASSED=0
FAILED=0
REPORT="$V/report.txt"
: >"$REPORT"

# check <name> <exit code> <text that must appear, words joined by '|'> <binary> <args...>
# The text is looked for in what the program printed to stdout and stderr together.
check() {
  local name=$1 want=$2 needles=$3 bin=$4
  shift 4
  local dir="$V/results/${RUN_USER//:/-}"
  mkdir -p "$dir"
  local started=$SECONDS code
  prog "$bin" "$@" >"$dir/$name.stdout" 2>"$dir/$name.stderr" </dev/null && code=0 || code=$?
  local elapsed=$((SECONDS - started)) ok=1 needle
  [ "$code" -eq "$want" ] || ok=0
  local IFS='|'
  for needle in $needles; do
    cat "$dir/$name.stdout" "$dir/$name.stderr" | grep -qF -- "$needle" || ok=0
  done
  if [ "$ok" -eq 1 ]; then
    PASSED=$((PASSED + 1))
    echo "PASS $RUN_USER $name (${elapsed}s)" | tee -a "$REPORT"
  else
    FAILED=$((FAILED + 1))
    echo "FAIL $RUN_USER $name (${elapsed}s): exit $code, wanted $want and '$needles'" | tee -a "$REPORT"
    head -c 600 "$dir/$name.stdout" "$dir/$name.stderr" | sed 's/^/    /' | tee -a "$REPORT"
  fi
}

read_cases() {
  local f=$FILES R=marfa-enrichment-read
  # Every format the reader takes.
  check text-txt 0 "quokkatxt" $R read "$f/sample.txt"
  check text-html 0 "quokkahtml" $R read "$f/generated.html"
  check text-md 0 "quokkamd" $R read "$f/generated.md"
  check text-csv 0 "quokkacsv" $R read "$f/generated.csv"
  check text-json 0 "quokkajson" $R read "$f/generated.json"
  check text-xml 0 "quokkaxml" $R read "$f/generated.xml"
  check text-yaml 0 "quokkayaml" $R read "$f/generated.yaml"
  check office-docx 0 "quokkadocx" $R read "$f/sample.docx"
  check office-xlsx 0 "quokkaxlsx" $R read "$f/sample.xlsx"
  check office-xls 0 "Quokka ledger 42.5|2018-09-20|quokkasecondsheet" $R read "$f/sample.xls"
  check office-pptx 0 "quokkapptxsecond" $R read "$f/generated.pptx"
  check office-odt 0 "quokkaodt" $R read "$f/generated.odt"
  check office-odp 0 "quokkaodp" $R read "$f/generated.odp"
  check office-ods 0 "quokkaods" $R read "$f/generated.ods"
  check office-epub 0 "quokkaepubtwo" $R read "$f/generated.epub"
  check pdf-text 0 "quokkapdf" $R read "$f/sample.pdf"
  check pdf-pages 0 "quokkapdf page one|quokkapdf page two marker|quokkapdf page three" $R read "$f/multipage.pdf"
  check pdf-compressed 0 "quokkapdf compressed stream marker" $R read "$f/compressed.pdf"
  check size-jpg 0 "size: 30 x 20" $R read "$f/sample.jpg"
  check size-gif 0 "size: 30 x 20" $R read "$f/sample.gif"
  check size-webp 0 "size: 30 x 20" $R read "$f/sample.webp"
  check size-webp-extended 0 "size: 30 x 20" $R read "$f/sample-extended.webp"
  check size-webp-lossless 0 "size: 30 x 20" $R read "$f/sample-lossless.webp"
  check size-bmp 0 "size: 30 x 20" $R read "$f/generated.bmp"
  # OCR, in the default four languages from memory.
  check ocr-png 0 "Marfa OCR fixture quokkapng|size: 1700 x 2200" $R read "$f/sample.png"
  check ocr-sentence 0 "Marfa reads this sentence upright." $R read "$f/sentence.png"
  check ocr-languages 0 "Die Straße ist größer als das Käsebrot.|Ou est le café déja ouvert a Noél ?|El niño comió mañana en el jardin." $R read "$f/languages.png"
  check ocr-rotated 0 "Marfa reads this sentence upright." $R read "$f/rotated.jpg"
  check ocr-cmyk 0 "Marfa reads this sentence upright." $R read "$f/cmyk.jpg"
  check ocr-tiff 0 "Marfa reads this sentence upright." $R read "$f/pages.tiff"
  check ocr-japanese 0 "日本語の文章を読み取ります。|吾間は猫である。名前はまだ無い。" $R read "$f/japanese.png" --languages jpn
  check ocr-chinese 0 "这是一个中文文字识别测试。" $R read "$f/chinese.png" --languages chi_sim
  check ocr-owner-model 0 "Marfa OCR fixture quokkapng" $R read "$f/sample.png" --languages owner --data-dir "$MODELS"
  check ocr-missing-language 1 "refused: OCR cannot start" $R read "$f/sample.png" --languages klingon
  [ -f "$FILES_DIR/scanned.pdf" ] && check ocr-scanned-pdf 0 "Die Straße ist größer als das Käsebrot.|El niño comió" $R read "$f/scanned.pdf"
  if [ -d "$FILES_DIR/corpus" ]; then
    local file name
    for file in "$FILES_DIR"/corpus/*; do
      name=$(basename "$file")
      case "$name" in
        arxiv-resnet.pdf) needle="Deep Residual Learning" ;;
        ocrmypdf-linn.* | ocrmypdf-ccitt.pdf | ocrmypdf-skew.pdf) needle="LinnSequencer" ;;
        ocrmypdf-multipage.pdf) needle="Miss Watson" ;;
        *) needle="" ;;
      esac
      check "corpus-$name" 0 "$needle" $R read "$f/corpus/$name"
    done
  fi
  # Files the reader must refuse, and say why.
  check refuse-encrypted 1 "refused: the file is password-protected" $R read "$f/encrypted.pdf"
  check refuse-unsupported 1 "refused: no reader takes this type of file" $R read "$f/sample.mp3" --type audio/mpeg
  check refuse-empty-pdf 1 "refused: the file is malformed" $R read "$f/empty.pdf"
  check refuse-not-a-pdf 1 "refused: the file is malformed" $R read "$f/not-a-pdf.pdf"
  check refuse-truncated-pdf 1 "refused: the file is malformed" $R read "$f/truncated.pdf"
  check refuse-random-png 1 "refused: the file is malformed" $R read "$f/random.png"
  check refuse-not-a-zip 1 "refused: the file is malformed" $R read "$f/not-a-zip.docx"
  check refuse-truncated-docx 1 "refused: the file is malformed" $R read "$f/truncated-package.docx"
  check refuse-not-a-workbook 1 "refused: the file is malformed" $R read "$f/not-a-workbook.xls"
  check refuse-over-limit 1 "refused: the file is past a limit" $R read "$f/sample.txt" --max-memory 100
  # What the child holds, from the proof program: the limits the parent set.
  # An emulator may run a program without honoring its filter, and then says so.
  local sandbox_wants="sandbox: Full"
  [ "$EMULATED" = no ] || sandbox_wants="sandbox: "
  check sandbox-state 0 "$sandbox_wants" marfa-enrichment-read-proof read "$f/faults/report.txt"
}

# Faults: one file after another by the same parent, and the good file must read.
fault_case() { # name, wanted text
  local name=$1 needle=$2
  check "fault-$name" 1 "$needle|a good file" marfa-enrichment-read-proof read "$FILES/faults/$name.txt" "$FILES/good.txt" \
    --time-limit 4 --max-memory 536870912
}

fault_cases() {
  fault_case segfault "SIGSEGV"
  fault_case abort "SIGABRT"
  fault_case stack-overflow "SIGSEGV"
  fault_case hang "took too long"
  fault_case spin "took too long"
  fault_case stopped "took too long"
  fault_case eat-memory "past a limit"
  fault_case rust-alloc-fails "past a limit"
  fault_case cpp-new-fails "past a limit"
  fault_case flood-stdout "wrote more than it may"
  fault_case flood-stderr "refused:"
  fault_case garbage "the reader's answer is bad"
  fault_case silent "the reader's answer is bad"
  fault_case close-stdin "the reader's answer is bad"
  fault_case too-much-text "wrote more than it may"
  fault_case orphan "the reader's answer is bad"
  # A reader that has been taken over: what the sandbox lets it do. Each prints what
  # happened as the file's text, and the report keeps it.
  # A folder that is writable, so that only the sandbox stands between the reader and it.
  DOCKER_EXTRA="--tmpfs $SCRATCH:rw,mode=1777"
  check fault-write-file 0 "Err(" marfa-enrichment-read-proof read "$FILES/faults/write-file.txt"
  check fault-open-file 0 "refused" marfa-enrichment-read-proof read "$FILES/faults/open-file.txt"
  check fault-connect 0 "refused" marfa-enrichment-read-proof read "$FILES/faults/connect.txt"
  check fault-udp 0 "refused" marfa-enrichment-read-proof read "$FILES/faults/udp.txt"
  check fault-fork 0 "refused" marfa-enrichment-read-proof read "$FILES/faults/fork.txt"
  DOCKER_EXTRA=''
  [ -e "$SCRATCH/written.txt" ] && echo "NOTE the reader wrote $SCRATCH/written.txt" | tee -a "$REPORT"
  # macOS adds __CF_USER_TEXT_ENCODING to every process's environment, and its sandbox
  # denies even the working directory's name.
  if [ "$KIND" = mac ]; then report_wants="descriptors=0,1,2"; else report_wants="descriptors=0,1,2|environment= |directory=/"; fi
  check fault-report 0 "$report_wants" marfa-enrichment-read-proof read "$FILES/faults/report.txt"
}

# The memory limit against real pages.
memory_cases() {
  local f=$FILES R=marfa-enrichment-read
  if [ -n "$HAVE_PILLOW" ]; then
    check memory-dense-page 0 "size: 8000 x 8000" $R read "$f/big-text.png"
    check memory-dense-page-under-limit 1 "refused: the file is past a limit" $R read "$f/big-text.png" --max-memory 268435456
  else
    echo "SKIP $RUN_USER memory-dense-page (Pillow is missing)" | tee -a "$REPORT"
  fi
  # What the readers hold against the address-space limit they were given (Linux).
  if [ "$KIND" = linux ] && [ "$RUN_USER" = 65534:65534 ] && docker image inspect alpine >/dev/null 2>&1; then
    local what
    for what in "sample.png" "big-text.png" "corpus/ocrmypdf-multipage.pdf" "corpus/arxiv-resnet.pdf"; do
      [ -e "$FILES_DIR/$what" ] || continue
      echo "PEAK $what: $("$NATIVE_DIR/verify/peak-memory.sh" "$IMAGE" "$PLATFORM" /marfa-enrichment-read read "$f/$what")" | tee -a "$REPORT"
    done
  fi
}

echo "verify: $TARGET, emulated: $EMULATED" | tee -a "$REPORT"
for RUN_USER in ${users//,/ }; do
  case "$RUN_USER" in
    nobody) RUN_USER=65534:65534 ;;
    root) RUN_USER=0:0 ;;
  esac
  [ "$KIND" = mac ] && RUN_USER=$(id -un)
  echo "verify: user $RUN_USER" | tee -a "$REPORT"
  read_cases
  fault_cases
  memory_cases
  [ "$KIND" = mac ] && break
done
echo "verify: sandbox states the programs reported:" | tee -a "$REPORT"
cat "$V"/results/*/*.stderr | grep '^sandbox:' | sort | uniq -c | tee -a "$REPORT"
echo "verify: $PASSED passed, $FAILED failed ($REPORT)" | tee -a "$REPORT"
[ "$FAILED" -eq 0 ]
