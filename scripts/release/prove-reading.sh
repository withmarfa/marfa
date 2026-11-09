#!/usr/bin/env bash
# Proves the reading of the `marfa-server` in a release archive, as a person unpacks it,
# so a signed and notarized program is the one proved. Two checks:
#
# 1. Over HTTP: it boots the server on throwaway state, claims it on its private socket,
#    mints a key, uploads three files and requires the text each one holds back, read by
#    the server's own file reader: a plain text file (the witness that the reading works
#    at all), a PDF (PDFium) and a picture (Tesseract). Automatic reading and one manual
#    sweep may each do the work, so the outcome is judged on the text the files end up
#    with, within a deadline.
# 2. Over the reader's internal protocol: the same program runs as its own reading child,
#    as the server starts it, and must report the full sandbox before it reads the picture.
#    The server does not report how far its reader was sandboxed, so the HTTP proof cannot
#    show it. This check is kept beside core/marfa-enrichment/src/isolated/wire.rs and
#    moves with it.
#
#   prove-reading.sh <archive> <fixtures-folder>
#
# <fixtures-folder> is core/marfa-enrichment/fixtures.
set -euo pipefail

archive="$1"
fixtures=$(cd "$2" && pwd -P)

# How long after the upload a last sweep may start, in real seconds; a sweep under way may run on.
READING_SECONDS=240

for tool in curl jq openssl tar; do
  command -v "$tool" > /dev/null || {
    echo "::error::$tool is needed to prove the reading."
    exit 1
  }
done

# The server refuses a socket folder reached through a symbolic link, as /tmp is on a Mac.
state=$(cd "$(mktemp -d /tmp/marfa-reading.XXXXXX)" && pwd -P)
control=$(cd "$(mktemp -d /tmp/marfa-reading-control.XXXXXX)" && pwd -P)
pid=
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then kill -KILL "$pid" 2> /dev/null || true; fi
  rm -rf "$state" "$control"
}
trap cleanup EXIT

# The server gives an unclaimed instance's setup code only on its private socket. Lines of
# its log that name one are still left out of what is printed, so no build can publish it.
fail() {
  echo "::error::$1"
  echo "--- the server's log"
  grep -iv 'setup code' "$state/log" 2> /dev/null | tail -40 || true
  exit 1
}

tar -xzf "$archive" -C "$state" marfa-server
server="$state/marfa-server"
chmod +x "$server"

# The reader's own protocol: `wire.rs` has the request and the frame, `child.rs` the
# order of what a child does, and `parent.rs` how a parent starts one.
prove_sandbox() {
  local picture="$fixtures/sentence.png" phrase="Marfa reads this sentence upright."
  local request said code frame answer text
  request=$(jq -cn --argjson len "$(wc -c < "$picture" | tr -d ' ')" \
    '{mime: "image/png", len: $len, max_text_chars: 1000000, max_inflated_bytes: 67108864,
      time_budget_ms: 45000, ocr: {languages: "eng+deu+fra+spa", data_dir: null}}')
  # What a parent gives a child: an empty environment, `/` as the working folder, the
  # file open for reading only as standard input, a minute and a gigabyte of memory, and
  # pipes for output, read apart. The child's limit on file size is zero, so output to a
  # file would kill it: its error output goes through a pipe to `cat`, which writes it.
  said=$(
    (
      exec 0< "$picture"
      cd /
      exec env -i "$server" --marfa-enrichment-child 60000 1073741824 "$request"
    ) 2> >(cat > "$state/child-stderr")
    printf '\nexit %s' "$?"
  )
  code=${said##*$'\n'exit }
  said=${said%$'\n'exit *}

  frame=${said%%$'\n'*}
  jq -e '. == {sandbox: "full"}' <<< "$frame" > /dev/null 2>&1 ||
    fail "The reading child's first output was '${said:0:300}' (exit status $code), not the full sandbox."
  echo "sandbox: the reading child reported the full sandbox"
  [ "$code" = 0 ] || fail "The reading child exited with status $code, not 0: ${said:0:300}"
  answer=${said#*$'\n'}
  # One answer after the frame, as the parent reads it; anything more is refused there.
  text=$(jq -ser 'if length == 1 then .[0].reading.text // error("no reading") else error("\(length) answers") end' <<< "$answer" 2> /dev/null) ||
    fail "The reading child gave no reading: ${answer:0:300} (its error output: $(tail -c 300 "$state/child-stderr" 2> /dev/null))"
  grep -qF -- "$phrase" <<< "$text" || fail "The reading child read '${text:0:200}', which lacks '$phrase'. Its answer: ${answer:0:300}"
  echo "sandbox: the reading child read: ${text:0:60}"
}
prove_sandbox

sentence="$state/sentence.txt"
printf 'the quokka ledger, page one' > "$sentence"

(
  cd "$state"
  exec env -i HOME="$state" PATH="$PATH" PORT=0 MARFA_LISTEN_HOST=127.0.0.1 \
    SQLITE_PATH="$state/marfa.db" BLOB_PATH="$state/blobs" \
    MARFA_CONTROL_SOCKET="$control/marfa.sock" \
    API_KEY_SALT="$(openssl rand -hex 32)" MARFA_AUTH_SECRET="$(openssl rand -hex 32)" \
    "$server"
) > "$state/log" 2>&1 &
pid=$!

port=
for _ in $(seq 1 120); do
  port=$(awk 'match($0, /Marfa server listening on port [0-9]+/) { split(substr($0, RSTART, RLENGTH), w, " "); print w[6]; exit }' "$state/log")
  [ -n "$port" ] && break
  kill -0 "$pid" 2> /dev/null || fail "marfa-server ended before it listened."
  sleep 0.5
done
[ -n "$port" ] || fail "marfa-server did not listen within a minute."
url="http://127.0.0.1:$port"

reply="$state/reply"
request="$state/request.json"
status=

# send <what> <accepted statuses, as a pattern> <curl arguments>...: runs the request and
# keeps its body in $reply and its HTTP status in $status. Any other status, or no status
# at all, ends the proof naming the request and what the server said.
send() {
  local what=$1 accepted=$2 code=0 detail
  shift 2
  status=$(curl -sS --max-time 60 -o "$reply" -w '%{http_code}' "$@") || code=$?
  [ "$code" = 0 ] || fail "$what: curl exited with status $code and no HTTP status."
  if ! [[ $status =~ ^($accepted)$ ]]; then
    detail=$(jq -r '.error.message? // .message? // empty' "$reply" 2> /dev/null | head -c 300 || true)
    [ -n "$detail" ] || detail=$(head -c 200 "$reply" | tr -d '\000-\037')
    fail "$what: HTTP $status: $detail"
  fi
}
socket() {
  local what=$1 accepted=$2
  shift 2
  send "$what" "$accepted" --unix-socket "$control/marfa.sock" -H 'Content-Type: application/json' "$@"
}

jq -n --arg password "$(openssl rand -hex 16)" \
  '{email: "reading@example.com", password: $password}' > "$request"
socket "The claim on the private socket" '2[0-9][0-9]' -X POST --data-binary "@$request" http://localhost/_control/setup/claim

jq -n '{label: "reading", source: "reading", permissions: ["instance.maintain"],
  type_permissions: {"*": "write"}, extension_permissions: {"*": "write"},
  edge_permissions: {"*": "write"}, metadata_permissions: {"*": "write"},
  profile_permissions: {"*": "read"}}' > "$request"
socket "Minting a key on the private socket" '2[0-9][0-9]' -X POST --data-binary "@$request" http://localhost/keys
key=$(jq -er .key "$reply") || fail "The private socket minted no key."

# api <what> <accepted statuses> <curl arguments>...
api() {
  local what=$1 accepted=$2
  shift 2
  send "$what" "$accepted" -H "Authorization: Bearer $key" "$@"
}

# upload <file> <mime type> <item type> <title>: sets $uploaded to the new item's id.
upload() {
  local hash
  api "$4: the upload" '2[0-9][0-9]' -X POST -H "Content-Type: $2" --data-binary "@$1" "$url/blobs"
  hash=$(jq -er .hash "$reply") || fail "$4: the upload gave no hash."
  jq -n --arg type "$3" --arg hash "$hash" --arg mime "$2" --arg title "$4" \
    '{type: $type, tier: "library", properties: {blob_ref: $hash, mime_type: $mime, title: $title}}' > "$request"
  api "$4: the item" '2[0-9][0-9]' -X POST -H 'Content-Type: application/json' --data-binary "@$request" "$url/items"
  uploaded=$(jq -er .item.id "$reply") || fail "$4: the item came back with no id."
}

names=("text file" "PDF" "picture")
phrases=("the quokka ledger, page one" "quokkapdf" "Marfa reads this sentence upright.")
ids=()
upload "$sentence" text/plain core.file "a text file"
ids+=("$uploaded")
upload "$fixtures/sample.pdf" application/pdf core.file "a PDF"
ids+=("$uploaded")
upload "$fixtures/sentence.png" image/png core.file.image "a picture"
ids+=("$uploaded")

# Uploads bring automatic reading forward by a few seconds, and only one run of the sweep
# happens at a time, so the automatic run may read some of the files and a manual run the
# rest, or meet the other mid-run (409). What counts is the text the files end up with:
# poll them, running the sweep between looks, until all three read right or the deadline
# passes. A file whose text lacks its phrase will not improve, so that ends the proof at once.
last_sweep="no sweep ran"
deadline=$((SECONDS + READING_SECONDS))
while :; do
  pending=()
  for index in 0 1 2; do
    api "Reading the ${names[index]}" 200 "$url/items/${ids[index]}"
    text=$(jq -r '.item.properties.extracted_text // ""' "$reply")
    if [ -z "$text" ]; then
      pending+=("${names[index]}")
    elif ! grep -qF -- "${phrases[index]}" <<< "$text"; then
      fail "The ${names[index]} gave '${text:0:200}', which lacks '${phrases[index]}'."
    fi
  done
  [ ${#pending[@]} -eq 0 ] && break
  [ "$SECONDS" -lt "$deadline" ] ||
    fail "After $READING_SECONDS seconds the files without text were: ${pending[*]} (the last sweep: $last_sweep)."

  api "The reading sweep" '200|409' --max-time 240 -X POST "$url/housekeeping/enrichment-sweep/run"
  if [ "$status" = 409 ]; then
    last_sweep="a run was already in progress"
  else
    last_sweep=$(jq -c '{outcome, result, error}' "$reply")
    [ "$(jq -r .outcome "$reply")" = ok ] || fail "The reading sweep ended badly: $last_sweep"
  fi
  sleep 2
done
for index in 0 1 2; do
  api "Reading the ${names[index]}" 200 "$url/items/${ids[index]}"
  text=$(jq -r '.item.properties.extracted_text' "$reply")
  echo "the ${names[index]} read: ${text:0:60}"
done

kill -TERM "$pid"
for _ in $(seq 1 20); do
  kill -0 "$pid" 2> /dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2> /dev/null; then fail "marfa-server did not stop within ten seconds of SIGTERM."; fi
code=0
wait "$pid" || code=$?
pid=
[ "$code" = 0 ] || fail "marfa-server stopped with status $code, not 0."
echo "marfa-server read all three files and stopped with status 0"
