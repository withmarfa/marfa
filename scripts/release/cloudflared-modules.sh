#!/usr/bin/env bash
# Reads the output of `go version -m <program>`. Sourced by the scripts that gather and check the
# licences of the Go modules in `cloudflared`, never run.

# go_modules: the modules the program is built from, one `<module> <version>` a line. A module
# the build replaced is named by what replaced it, since that is the code in the program.
go_modules() {
  awk -F'\t' '
    function flush() { if (path != "") print path " " version; path = "" }
    $2 == "dep" { flush(); path = $3; version = $4; next }
    $2 == "=>" { path = $3; version = $4; next }
    END { flush() }
  '
}

# go_release: the Go release the program was built with, such as go1.27.4.
go_release() {
  awk 'NR == 1 { print $NF }'
}

# licences_entries <bundle>: the entries a licence bundle opens, one `<module> <version>` a line.
licences_entries() {
  awk '/^=== .* ===$/ { print $2 " " $3 }' "$1"
}
