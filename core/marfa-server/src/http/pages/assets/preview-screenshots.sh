#!/usr/bin/env bash
# Takes a headless Chrome screenshot of every page in a preview folder at desktop and phone width.
# Usage: preview-screenshots.sh <preview folder> [light|dark]
# The folder is the one MARFA_WRITE_PAGE_PREVIEW wrote. Set CHROME to a browser to use another.
set -euo pipefail

folder="${1:?usage: preview-screenshots.sh <preview folder> [light|dark]}"
scheme="${2:-light}"
case "$scheme" in
  light) blink_scheme=1 ;;
  dark) blink_scheme=0 ;;
  *) echo "the second argument is light or dark" >&2; exit 2 ;;
esac

chrome="${CHROME:-}"
if [ -z "$chrome" ]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then chrome="$candidate"; break; fi
  done
fi
[ -n "$chrome" ] || { echo "no Chrome found; set CHROME" >&2; exit 1; }

folder="$(cd "$folder" && pwd)"

# Headless Chrome will not lay a page out narrower than 500 px, so a phone is an iframe of its width.
cat > "$folder/frame.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<body style="margin:0">
<script>
  const query = new URLSearchParams(location.search);
  const frame = document.createElement("iframe");
  frame.src = query.get("src");
  frame.style.cssText = `border:0;display:block;width:${query.get("width")}px;height:${query.get("height")}px`;
  document.body.append(frame);
</script>
HTML

shoot() {
  local file="$1" width="$2" height="$3" label="$4"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --blink-settings=preferredColorScheme="$blink_scheme" \
    --window-size="$width,$height" --virtual-time-budget=3000 \
    --screenshot="$folder/${file%.html}-$label.png" \
    "file://$folder/frame.html?src=$file&width=$width&height=$height" >/dev/null 2>&1
}

for path in "$folder"/*.html; do
  file="$(basename "$path")"
  case "$file" in index.html | frame.html) continue ;; esac
  shoot "$file" 1280 900 desktop
  shoot "$file" 390 844 phone
done
echo "Screenshots are in $folder"
