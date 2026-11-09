#!/usr/bin/env bash
# Installs the release's programs as a person does, behind HTTPS, and checks the result.
#
#   install-proof.sh <folder holding the release's files> <version> <mode>...
#
# Each mode is a clean install of its own:
#
#   native-user  a launchd agent on a Mac, a systemd user unit on Linux
#   native-root  Linux, as root: a system unit run by the `marfa` account
#   docker       Linux: an image built from the same archives
#
# Settings, all optional:
#   MARFA_PROOF_NAME        the install's name, "proof"; the Docker one adds "-docker"
#   MARFA_PROOF_ROOT        where a non-root install's programs and folders go, "$HOME/marfa-proof"
#   MARFA_PROOF_HTTPS_PORT  the port Caddy listens on, 8443
#   MARFA_PROOF_HOSTS       "edit" maps the host names in /etc/hosts, which needs sudo;
#                           "resolve" leaves the file alone and has curl map them
#
# The single-quoted programs handed to jq use jq's variables, not the shell's.
# shellcheck disable=SC2016
set -euo pipefail
# The server refuses a group-writable folder above its private socket.
umask 022
if [ "$#" -lt 3 ]; then
  echo "usage: install-proof.sh <folder holding the release's files> <version> <mode>..." >&2
  exit 2
fi
archives=$(cd "$1" && pwd)
version=$2
shift 2
modes=("$@")

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
base=${MARFA_PROOF_NAME:-proof}
root=${MARFA_PROOF_ROOT:-$HOME/marfa-proof}
https_port=${MARFA_PROOF_HTTPS_PORT:-8443}
hosts=${MARFA_PROOF_HOSTS:-edit}
hosts_mark="# marfa install proof"
image=ghcr.io/withmarfa/marfa-server

# A Caddy release and the SHA-256 of each archive; move them together.
caddy_version=2.11.9
caddy_sha_mac_arm64=d075afc620376679a77b453399bf7ada264cab3280b2833e4ed1372abc0c1c13
caddy_sha_linux_amd64=5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb
caddy_sha_linux_arm64=5e377cff994fc9362a6fcf695c53f226cfca3a3ef85bd3a3687cf252d6310165

work=$(mktemp -d /tmp/marfa-proof.XXXXXX)
password=$(openssl rand -hex 24)
caddy_pid=
marfa=
current=
# The modes that are installed and not yet uninstalled, each between spaces.
installed=" "
ports=()
hosts_edited=

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "::error::$*"
  exit 1
}

case "$hosts" in
  edit | resolve) ;;
  *) fail "MARFA_PROOF_HOSTS is '$hosts', not edit or resolve." ;;
esac
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}$ ]]; then
  fail "'$version' is not a version such as 0.0.70."
fi
for tool in curl jq openssl tar; do
  command -v "$tool" > /dev/null || fail "$tool is not installed."
done
os=$(uname -s)
for mode in "${modes[@]}"; do
  case "$mode:$os" in
    native-user:Darwin | native-user:Linux | native-root:Linux | docker:Linux) ;;
    *) fail "$mode cannot be proved on $os (the modes are native-user, native-root and docker; the last two are for Linux)." ;;
  esac
done

# ---- naming: everything about one mode in one place --------------------------

# Sets name, host, address, port, dir, sock and the arguments of every `marfa server` command.
configure() {
  current=$1
  case $current in
    docker)
      name="${base}-docker"
      host="marfa-docker.test"
      dir=$root/docker
      sock=/data/control/marfa.sock
      ;;
    native-root)
      name=$base
      host=marfa.test
      dir=
      sock=/var/lib/marfa-server/data/control/marfa.sock
      ;;
    native-user)
      name=$base
      host=marfa.test
      dir=$root/native
      sock=$dir/data/control/marfa.sock
      ;;
  esac
  address=https://$host:$https_port
  dir_args=()
  [ -z "$dir" ] || dir_args=(--dir "$dir")
}

# ---- running the programs as the install's own account ------------------------

# The root install keeps its state where only root and the `marfa` account can read.
server() {
  if [ "$current" = native-root ]; then
    sudo "$marfa" server "$@"
  else
    "$marfa" server "$@"
  fi
}

# The root install's socket answers only its own account, so the call becomes that account.
socket() {
  case $current in
    docker)
      docker exec -i "$name" marfa --socket "$sock" --json "$@"
      ;;
    native-root)
      sudo -u marfa sh -c 'cd "$1" && shift && exec env -i PATH=/usr/bin:/bin HOME="$PWD" MARFA_NO_KEYCHAIN=1 "$@"' \
        _ /var/lib/marfa-server "$marfa" --socket "$sock" --json "$@"
      ;;
    *)
      MARFA_NO_KEYCHAIN=1 "$marfa" --socket "$sock" --json "$@"
      ;;
  esac
}

# What `marfa server status --json` says, as one JSON object.
status() { server status ${dir_args[@]+"${dir_args[@]}"} --json; }

# Fails with `$2` unless the JSON on standard input satisfies the jq test `$1`.
holds() {
  local test=$1 said=$2 body
  body=$(cat)
  if ! jq -e --arg version "$version" --arg address "$address" "$test" <<< "$body" > /dev/null; then
    echo "$body" | jq -c 'del(.log)' || echo "$body"
    fail "$said"
  fi
}

# ---- the machine -------------------------------------------------------------

sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# A port nothing listens on, from `$1` upward.
free_port() {
  local port
  for port in $(seq "$1" "$(($1 + 200))"); do
    if ! (exec 3<> "/dev/tcp/127.0.0.1/$port") 2> /dev/null; then
      echo "$port"
      return
    fi
  done
  fail "No free port from $1 to $(($1 + 200))."
}

listening() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }

# systemd runs a logged-out account's unit only while it lingers.
prepare_user_systemd() {
  [ "$os" = Linux ] || return 0
  sudo loginctl enable-linger "$USER"
  XDG_RUNTIME_DIR=/run/user/$(id -u)
  export XDG_RUNTIME_DIR
  export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
  for _ in $(seq 1 60); do
    [ -S "$XDG_RUNTIME_DIR/bus" ] && return 0
    sleep 0.5
  done
  fail "systemd's user manager did not start for $USER: $XDG_RUNTIME_DIR/bus is missing."
}

# ---- Caddy -------------------------------------------------------------------

fetch_caddy() {
  local platform sha archive
  case "$os-$(uname -m)" in
    Darwin-arm64) platform=mac_arm64 sha=$caddy_sha_mac_arm64 ;;
    Linux-x86_64) platform=linux_amd64 sha=$caddy_sha_linux_amd64 ;;
    Linux-aarch64 | Linux-arm64) platform=linux_arm64 sha=$caddy_sha_linux_arm64 ;;
    *) fail "No pinned Caddy for $os $(uname -m)." ;;
  esac
  archive=$work/caddy.tar.gz
  curl -fsSL --retry 3 -o "$archive" \
    "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/caddy_${caddy_version}_$platform.tar.gz"
  [ "$(sha256_of "$archive")" = "$sha" ] || fail "The Caddy $caddy_version archive for $platform does not match its pinned SHA-256."
  mkdir "$work/caddy-bin"
  tar -xzf "$archive" -C "$work/caddy-bin" caddy
  say "Caddy $("$work/caddy-bin/caddy" version | cut -d' ' -f1) for $platform, checked against its pinned SHA-256"
}

# One site for each mode, with a certificate authority of Caddy's own.
start_caddy() {
  local mode
  {
    printf '{\n\tadmin off\n\tauto_https disable_redirects\n\tskip_install_trust\n\tstorage file_system %s\n}\n' "$work/caddy-data"
    for mode in "${modes[@]}"; do
      configure "$mode"
      printf '%s:%s {\n\ttls internal\n\treverse_proxy 127.0.0.1:%s\n}\n' "$host" "$https_port" "$(port_of "$mode")"
    done
  } > "$work/Caddyfile"
  XDG_CONFIG_HOME=$work/caddy-config XDG_DATA_HOME=$work/caddy-share \
    "$work/caddy-bin/caddy" run --config "$work/Caddyfile" --adapter caddyfile > "$work/caddy.log" 2>&1 &
  caddy_pid=$!
  ca=$work/caddy-data/pki/authorities/local/root.crt
  for _ in $(seq 1 60); do
    [ -s "$ca" ] && listening "$https_port" && return 0
    kill -0 "$caddy_pid" 2> /dev/null || fail "Caddy ended before it listened: $(tail -5 "$work/caddy.log")"
    sleep 0.5
  done
  fail "Caddy did not listen on port $https_port within thirty seconds."
}

# A request through Caddy, trusting Caddy's authority and no other.
through_caddy() {
  local resolve=()
  [ "$hosts" = resolve ] && resolve=(--resolve "$host:$https_port:127.0.0.1")
  curl -sS --max-time 20 --cacert "$ca" ${resolve[@]+"${resolve[@]}"} "$@"
}

# The same request with the system's own authorities, which do not hold Caddy's.
without_caddy_authority() {
  local resolve=()
  [ "$hosts" = resolve ] && resolve=(--resolve "$host:$https_port:127.0.0.1")
  curl -sS --max-time 20 ${resolve[@]+"${resolve[@]}"} "$@"
}

# ---- leaving nothing behind --------------------------------------------------

show_logs() {
  echo "--- the end of the log of $name ($current)"
  server status ${dir_args[@]+"${dir_args[@]}"} 2>&1 | tail -30 || true
  case $current in
    docker) docker logs --tail 40 "$name" 2>&1 || true ;;
    native-root) sudo journalctl -u "marfa-$name.service" -n 40 --no-pager 2>&1 || true ;;
    native-user)
      if [ "$os" = Darwin ]; then
        tail -n 40 "$HOME/Library/Logs/Marfa/"*"$name"* 2>&1 || true
      else
        journalctl --user -u "marfa-$name.service" -n 40 --no-pager 2>&1 || true
        # A runner keeps user services' output in the system journal.
        sudo journalctl "_SYSTEMD_USER_UNIT=marfa-$name.service" -n 40 --no-pager 2>&1 || true
      fi
      ;;
  esac
}

cleanup() {
  local code=$?
  set +e
  if [ "$code" -ne 0 ]; then
    if [ -n "$current" ] && [ -n "$marfa" ]; then
      configure "$current"
      show_logs
    fi
    [ -f "$work/caddy.log" ] && {
      echo "--- Caddy's log"
      tail -20 "$work/caddy.log"
    }
  fi
  local mode
  for mode in $installed; do
    configure "$mode"
    server uninstall ${dir_args[@]+"${dir_args[@]}"} --delete-data --yes > /dev/null 2>&1
  done
  [ -z "$caddy_pid" ] || kill "$caddy_pid" 2> /dev/null
  if [ -n "$hosts_edited" ]; then
    grep -v "$hosts_mark" /etc/hosts > "$work/hosts" && sudo cp "$work/hosts" /etc/hosts
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT

# ---- the proof ---------------------------------------------------------------

install_programs() {
  local dir=$root/bin
  step "Install the programs through scripts/install.sh"
  if grep -qx native-root <<<"$(printf '%s\n' "${modes[@]}")"; then
    dir=/usr/local/bin
    sudo env MARFA_DOWNLOAD_BASE="file://$archives" MARFA_VERSION="$version" MARFA_INSTALL_DIR="$dir" \
      sh "$repo/scripts/install.sh"
  else
    MARFA_DOWNLOAD_BASE="file://$archives" MARFA_VERSION="$version" MARFA_INSTALL_DIR="$dir" \
      sh "$repo/scripts/install.sh"
  fi
  marfa=$dir/marfa
  [ "$("$marfa" --version)" = "marfa $version" ] || fail "The installed marfa does not report $version."
  [ "$("$dir/marfa-server" --version)" = "marfa-server $version" ] || fail "The installed marfa-server does not report $version."
}

# Tagged as the install names it, so the installer pulls nothing.
build_image() {
  step "Build the server image from the release's Linux archives"
  image_context=$work/image-context
  bash "$here/image-context.sh" "$archives" "$version" "$image_context" > /dev/null
  docker build --quiet -f "$repo/deploy/Dockerfile" \
    --build-arg "VERSION=$version" --build-arg "REVISION=${GITHUB_SHA:-unknown}" \
    -t "$image:$version" "$image_context" > /dev/null
  docker image inspect "$image:$version" > /dev/null
}

# The loopback port picked for a mode, which lines up with the modes asked for.
port_of() {
  local index
  for index in "${!modes[@]}"; do
    [ "${modes[$index]}" != "$1" ] || { echo "${ports[$index]}"; return; }
  done
}

prove() {
  configure "$1"
  local port
  port=$(port_of "$1")
  step "$current: install $name at $address"
  local claim='{"email":"proof@example.com","password":"%s","name":"Install proof"}'

  local runtime=()
  [ "$current" != docker ] || runtime=(--docker)
  # Counted before the install runs: a failure halfway still leaves something to remove.
  installed="$installed$current "
  server install ${dir_args[@]+"${dir_args[@]}"} --yes --name "$name" --access proxy --address "$address" --port "$port" \
    ${runtime[@]+"${runtime[@]}"} > "$work/install.log" 2>&1 ||
    {
      cat "$work/install.log"
      fail "marfa server install failed."
    }
  # The setup link carries a one-time code: the log shows everything but it.
  sed -E 's#(handoff=)[0-9A-Za-z_-]+#\1<code>#' "$work/install.log"

  status | holds '.running == true and .healthy == true and .claimed == false' \
    "The new install is not running and healthy, unclaimed."

  step "$current: claim the instance on the private socket"
  # shellcheck disable=SC2059  # the format is this function's own, the password its one argument
  if ! printf "$claim" "$password" | socket setup claim --stdin > "$work/claim.log" 2>&1; then
    cat "$work/claim.log"
    fail "The claim on the private socket failed."
  fi

  step "$current: status, and the stored sign-in address"
  status | holds '.running == true and .healthy == true and .claimed == true
    and .running_release == $version and .release == $version and .address == $address' \
    "status does not report a running, healthy, claimed server of release $version at $address."
  socket config get | holds '.sign_in_address == $address' \
    "The stored sign_in_address is not exactly $address."
  say "running, healthy, claimed, release $version, sign_in_address $address"

  step "$current: through HTTPS at $address"
  local code
  code=$(through_caddy -o /dev/null -w '%{http_code}' "$address/health") || fail "$address/health could not be reached through Caddy."
  [ "$code" = 200 ] || fail "$address/health answered $code, not 200."
  through_caddy "$address/" | holds '.version == $version' "GET $address/ does not report version $version."
  # The witness: the system does not trust Caddy's authority, so the success above was checked.
  if without_caddy_authority -o /dev/null "$address/health" 2> /dev/null; then
    fail "$address/health answered without Caddy's authority being trusted, so the check above proved nothing."
  fi
  say "/health answered 200 and GET / reports $version, with Caddy's authority the only one trusted"

  step "$current: stop, start"
  server stop ${dir_args[@]+"${dir_args[@]}"} > /dev/null
  status | holds '.running == false' "The server still runs after stop."
  ! listening "$port" || fail "Port $port still answers after stop."
  server start ${dir_args[@]+"${dir_args[@]}"} > /dev/null
  status | holds '.running == true and .healthy == true and .claimed == true and .running_release == $version and .address == $address' \
    "The server is not running, healthy, claimed and at $address after start."
  code=$(through_caddy -o /dev/null -w '%{http_code}' "$address/health") || fail "$address/health could not be reached after start."
  [ "$code" = 200 ] || fail "$address/health answered $code, not 200, after start."
  say "stopped, then started again with the owner and the address still held"

  step "$current: uninstall --delete-data"
  local holders=
  command -v lsof > /dev/null && holders=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2> /dev/null || true)
  server uninstall ${dir_args[@]+"${dir_args[@]}"} --delete-data --yes > /dev/null
  installed=${installed/ $current / }
  gone
  # shellcheck disable=SC2086  # the listing is process IDs, one a line
  for holder in $holders; do
    ! kill -0 "$holder" 2> /dev/null || fail "Process $holder, the server's, still runs after uninstall."
  done
  say "no service, process or container is left"
}

# After an uninstall: nothing of the install is left that a machine runs.
gone() {
  ! listening "$port" || fail "Port $port still answers after uninstall."
  case $current in
    docker)
      local left
      left=$(docker ps -a --filter "name=^$name\$" --format '{{.Names}}') || fail "Docker could not list containers."
      [ -z "$left" ] || fail "The container $name is left."
      left=$(docker volume ls --filter "name=^$name-data\$" --format '{{.Name}}') || fail "Docker could not list volumes."
      [ -z "$left" ] || fail "The volume $name-data is left."
      left=$(docker network ls --filter "name=^$name-net\$" --format '{{.Name}}') || fail "Docker could not list networks."
      [ -z "$left" ] || fail "The network $name-net is left."
      ;;
    native-root)
      ! systemctl cat "marfa-$name.service" > /dev/null 2>&1 || fail "The system unit marfa-$name.service is left."
      # The folder is root:marfa 0750, so only root can see whether it is gone.
      ! sudo test -e /var/lib/marfa-server || fail "The install folder /var/lib/marfa-server is left."
      ;;
    native-user)
      if [ "$os" = Darwin ]; then
        ! launchctl print "gui/$(id -u)/so.marfa.server.$name" > /dev/null 2>&1 || fail "The launchd agent so.marfa.server.$name is left."
        [ ! -e "$HOME/Library/LaunchAgents/so.marfa.server.$name.plist" ] || fail "The agent's plist is left."
      else
        ! systemctl --user cat "marfa-$name.service" > /dev/null 2>&1 || fail "The user unit marfa-$name.service is left."
      fi
      [ ! -e "$dir/data" ] && [ ! -e "$dir/marfa.env" ] || fail "The data or the settings are left in $dir."
      ;;
  esac
}

# ---- run ---------------------------------------------------------------------

next=18600
for mode in "${modes[@]}"; do
  ports+=("$(free_port "$next")")
  next=$((${ports[${#ports[@]} - 1]} + 1))
done

install_programs
for mode in "${modes[@]}"; do
  [ "$mode" != native-user ] || prepare_user_systemd
  [ "$mode" != docker ] || build_image
done

step "Caddy in front, on port $https_port"
fetch_caddy
configure "${modes[0]}"
if [ "$hosts" = edit ]; then
  names=
  for mode in "${modes[@]}"; do
    configure "$mode"
    names="$names $host"
  done
  printf '127.0.0.1%s %s\n' "$names" "$hosts_mark" | sudo tee -a /etc/hosts > /dev/null
  hosts_edited=1
fi
start_caddy

for mode in "${modes[@]}"; do
  prove "$mode"
done
step "The install proof passed: ${modes[*]}"
