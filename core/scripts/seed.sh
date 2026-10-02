#!/usr/bin/env bash
#   seed.sh note  <title> <body> [tag,tag]   prints the new item's id
#   seed.sh file  <title> <description>      prints the new item's id
#   seed.sh trash <id>                       soft-deletes
#   seed.sh purge <id>                       removes for good
#
# Reads MARFA_TEST_URL and MARFA_TEST_KEY, or MARFA_API_URL and MARFA_API_KEY.
set -euo pipefail

url="${MARFA_TEST_URL:-${MARFA_API_URL:-}}"
key="${MARFA_TEST_KEY:-${MARFA_API_KEY:-}}"
[[ -n "${url}" && -n "${key}" ]] || { echo "seed: set MARFA_TEST_URL and MARFA_TEST_KEY" >&2; exit 2; }

python3 - "${url}" "${key}" "$@" <<'PY'
import hashlib
import json
import sys
import urllib.error
import urllib.request

url, key, command, *args = sys.argv[1:]
url = url.rstrip("/")


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        f"{url}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            text = response.read().decode()
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        sys.stderr.write(f"seed: {method} {path} answered {error.code}: {error.read().decode()}\n")
        sys.exit(1)


def create(item_type, properties, tags=None):
    body = {"type": item_type, "properties": properties, "tier": "library"}
    if tags:
        body["tags"] = tags
    return call("POST", "/items", body)["item"]["id"]


def note(title, body, tags=None):
    return create("core.note", {"title": title, "body": body}, tags)


def file_item(title, description):
    digest = hashlib.sha256(description.encode()).hexdigest()
    return create(
        "core.file",
        {
            "title": title,
            "description": description,
            "blob_ref": f"sha256:{digest}",
            "mime_type": "text/plain",
        },
    )


if command == "note":
    title, body, *rest = args
    tags = rest[0].split(",") if rest and rest[0] else None
    print(note(title, body, tags))
elif command == "file":
    title, description = args
    print(file_item(title, description))
elif command == "trash":
    call("DELETE", f"/items/{args[0]}")
elif command == "purge":
    call("DELETE", f"/items/{args[0]}/purge")
else:
    sys.stderr.write(f"seed: unknown command {command!r}\n")
    sys.exit(2)
PY
