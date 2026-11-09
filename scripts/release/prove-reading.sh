#!/usr/bin/env bash
# Boots the `marfa-server` of a release archive on throwaway state, claims it on its private
# socket, mints a key, uploads three files and requires the text each one holds back, read
# by the server's own file reader: a plain text file (the witness that the reading works at
# all), a PDF (PDFium) and a picture (Tesseract). It runs the program as a person unpacks it,
# so a signed and notarized program is the one proved.
#
#   prove-reading.sh <archive> <fixtures-folder>
#
# <fixtures-folder> is core/marfa-enrichment/fixtures. The server does not report how far
# the reader was sandboxed, so this does not prove the sandbox.
set -euo pipefail

archive="$1"
fixtures="$2"

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

fail() {
  echo "::error::$1"
  echo "--- the server's log"
  tail -40 "$state/log" 2> /dev/null || true
  exit 1
}

tar -xzf "$archive" -C "$state" marfa-server
server="$state/marfa-server"
chmod +x "$server"
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
  port=$(sed -nE 's/.*Marfa server listening on port ([0-9]+).*/\1/p' "$state/log" | head -1)
  [ -n "$port" ] && break
  kill -0 "$pid" 2> /dev/null || fail "marfa-server ended before it listened."
  sleep 0.5
done
[ -n "$port" ] || fail "marfa-server did not listen within a minute."
url="http://127.0.0.1:$port"

socket() {
  curl -fsS --max-time 20 --unix-socket "$control/marfa.sock" -H 'Content-Type: application/json' "$@"
}

jq -n --arg password "$(openssl rand -hex 16)" \
  '{email: "reading@example.com", password: $password}' |
  socket -X POST --data-binary @- http://localhost/_control/setup/claim > /dev/null ||
  fail "The claim on the private socket failed."

key=$(jq -n '{label: "reading", source: "reading", permissions: ["instance.maintain"],
  type_permissions: {"*": "write"}, extension_permissions: {"*": "write"},
  edge_permissions: {"*": "write"}, metadata_permissions: {"*": "write"},
  profile_permissions: {"*": "read"}}' |
  socket -X POST --data-binary @- http://localhost/keys | jq -er .key) ||
  fail "The private socket minted no key."

api() {
  curl -fsS --max-time 60 -H "Authorization: Bearer $key" "$@"
}

# upload <file> <mime type> <item type> <title>: prints the new item's id.
upload() {
  local hash
  hash=$(api -X POST -H "Content-Type: $2" --data-binary "@$1" "$url/blobs" | jq -er .hash) ||
    fail "$4: the upload was refused."
  jq -n --arg type "$3" --arg hash "$hash" --arg mime "$2" --arg title "$4" \
    '{type: $type, tier: "library", properties: {blob_ref: $hash, mime_type: $mime, title: $title}}' |
    api -X POST -H 'Content-Type: application/json' --data-binary @- "$url/items" | jq -er .item.id ||
    fail "$4: the item was refused."
}

text_id=$(upload "$sentence" text/plain core.file "a text file")
pdf_id=$(upload "$fixtures/sample.pdf" application/pdf core.file "a PDF")
picture_id=$(upload "$fixtures/sentence.png" image/png core.file.image "a picture")

sweep=$(api --max-time 240 -X POST"$url/housekeeping/enrichment-sweep/run") || fail "The reading sweep could not run."
echo "sweep: $(jq -c '{outcome, result}' <<< "$sweep")"
jq -e '.outcome == "ok" and .result == {extracted: 3, skipped: 0, failed: 0}' <<< "$sweep" > /dev/null ||
  fail "The reading sweep did not read all three files."

# expect <name> <item id> <phrase>: the text the sweep wrote onto the item holds the phrase.
expect() {
  local text=
  for _ in $(seq 1 60); do
    text=$(api "$url/items/$2" | jq -r '.item.properties.extracted_text // ""')
    [ -n "$text" ] && break
    sleep 1
  done
  [ -n "$text" ] || fail "The $1 gave no text within a minute of the sweep."
  grep -qF -- "$3" <<< "$text" || fail "The $1 gave '$text', which lacks '$3'."
  echo "the $1 read: ${text:0:60}"
}
expect "text file" "$text_id" "the quokka ledger, page one"
expect "PDF" "$pdf_id" "quokkapdf"
expect "picture" "$picture_id" "Marfa reads this sentence upright."

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
