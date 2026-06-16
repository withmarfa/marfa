/**
 * Console page renderer for `/auth/keys`.
 *
 * Auth-gated (Better Auth cookie session). Lets a signed-in tenant owner
 * mint, view, and revoke their own long-lived `marfa_k1_` API keys without
 * dropping to the bearer-only data plane — the self-serve credential path a
 * brand-new hosted user needs after sign-up + verification.
 *
 * The data plane (`/items`, `/keys`, …) stays strictly bearer-only by
 * design; this surface lives in the `/auth/*` zone where the session cookie
 * is the authenticator. The freshly-minted plaintext key is shown exactly
 * once, in the POST response body (never via a redirect query), since it is
 * unrecoverable afterwards.
 *
 * Creating a key is a short stepped flow: name it, choose what it can reach
 * (the same soft-tile permission groups the consent screen uses), then copy
 * the one-time secret. The chosen permissions are real — a scoped key is a
 * `member` key carrying the selected per-type permissions, not a blanket
 * admin credential.
 *
 * Uses the shared auth-page layout, wide variant.
 */

import { renderAuthLayout } from "./auth-layout.js";

export interface KeysPageKey {
  id: string;
  label: string;
  source: string;
  created_at: string;
  last_used_at: string | null;
}

export interface KeysPageNotice {
  kind: "success" | "error";
  text: string;
}

export interface KeysPageParams {
  email: string;
  keys: KeysPageKey[];
  /** Plaintext of a key minted on this request — shown once, never stored. */
  newKey?: string;
  /** Label of the just-minted key, shown on the reveal step. */
  newKeyLabel?: string;
  /** Plain-English summary of what the new key can do (e.g. "read your
   *  content"), shown on the reveal step. */
  newKeyAccess?: string;
  notice?: KeysPageNotice;
}

/**
 * The content types a self-serve key can be scoped to, with the human label
 * the picker shows. Read submits `<type>:read`, write submits `<type>:write`;
 * the POST handler projects the ticked set into the key's type permissions.
 */
const KEY_CONTENT_TYPES: ReadonlyArray<{ label: string; type: string }> = [
  { label: "Notes", type: "core.note" },
  { label: "Tasks", type: "core.task" },
  { label: "Bookmarks", type: "core.bookmark" },
  { label: "Highlights", type: "core.highlight" },
  { label: "Calendar", type: "core.event" },
  { label: "Contacts", type: "core.entity.person" },
  { label: "Files", type: "core.file" },
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Friendly calendar date, e.g. "11 May 2026". */
function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = MONTHS[d.getUTCMonth()] ?? "";
  return `${String(d.getUTCDate())} ${month} ${String(d.getUTCFullYear())}`;
}

/** A permission group (Read / Write) as a collapsed soft tile with per-type
 *  toggles. The master toggle has no `name` — it only drives the members via
 *  the enhancement script; the per-type checkboxes are the real submitters,
 *  checked by default so the no-JS path grants the full content set. */
function permissionGroup(
  groupId: "read" | "write",
  label: string,
  desc: string,
  verb: "read" | "write",
): string {
  const rows = KEY_CONTENT_TYPES.map(
    (t) =>
      `<div class="subrow"><span>${t.label}</span><label class="sw"><input type="checkbox" name="scopes" value="${t.type}:${verb}" data-group="${groupId}" checked><span class="tk"></span></label></div>`,
  ).join("");
  return `<details class="grp">
    <summary>
      <span class="gmain">
        <span class="gtop"><span class="glabel">${label}</span><svg class="gchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
        <span class="gdesc">${desc}</span>
      </span>
      <label class="sw" onclick="event.stopPropagation()"><input type="checkbox" data-master="${groupId}" checked aria-label="${escapeHtml(label)}"><span class="tk"></span></label>
    </summary>
    <div class="gsub">${rows}</div>
  </details>`;
}

export function renderKeysPage(params: KeysPageParams): string {
  const safeEmail = escapeHtml(params.email);

  // One-time reveal step. Rendered into the POST response body directly so the
  // plaintext never lands in URL history or server access logs. It's a
  // focused step-3 screen — full key on one line, caution below, no list.
  if (params.newKey) {
    const access = params.newKeyAccess
      ? ` can ${escapeHtml(params.newKeyAccess)}`
      : " is ready to use";
    const label = params.newKeyLabel
      ? `<b>${escapeHtml(params.newKeyLabel)}</b>`
      : "Your key";
    const reveal = `
      <div class="steps" aria-hidden="true">
        <span class="steps__seg steps__seg--on"></span>
        <span class="steps__seg steps__seg--on"></span>
        <span class="steps__seg steps__seg--on"></span>
      </div>
      <h1 class="title">Your key is ready</h1>
      <p class="sub">${label}${access}.</p>
      <div class="copyfield">
        <span class="copyfield__val" id="new-key-value">${escapeHtml(params.newKey)}</span>
        <button type="button" class="copyfield__copy" id="copy-key" aria-label="Copy key" data-copy-target="new-key-value">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <p class="caution">Copy it now. You won't be able to see this key again.</p>
      <div class="actions">
        <a href="/auth/keys" class="btn btn--primary">Done</a>
      </div>
      <script>${COPY_SCRIPT}</script>
    `;
    return renderAuthLayout({ title: "Your key is ready", bodyHtml: reveal, wide: true });
  }

  const noticeHtml = params.notice
    ? `<div class="banner banner--${params.notice.kind === "success" ? "success" : "error"}" role="${
        params.notice.kind === "success" ? "status" : "alert"
      }">${escapeHtml(params.notice.text)}</div>`
    : "";

  const keysList =
    params.keys.length === 0
      ? `<p class="field__hint">You have no API keys yet. Create one with the + button.</p>`
      : params.keys
          .map((k) => {
            const safeId = escapeHtml(k.id);
            const safeLabel = escapeHtml(k.label);
            const activity = k.last_used_at
              ? `Last used ${escapeHtml(formatDate(k.last_used_at))}`
              : "Not used yet";
            return `<div class="row">
              <div class="row__main">
                <div class="row__title">${safeLabel}</div>
                <div class="row__meta">Added ${escapeHtml(formatDate(k.created_at))}</div>
                <div class="row__meta row__meta--faint">${activity}</div>
              </div>
              <form method="POST" action="/auth/keys/${safeId}/revoke" class="row__action">
                <button type="submit" class="btn btn--outline btn--sm">Revoke</button>
              </form>
            </div>`;
          })
          .join("\n");

  // The stepped create flow. One form; the enhancement script reveals it from
  // the + button and walks step 1 (name) → step 2 (permissions). With no JS
  // the whole form is visible and submits the default (all content) in one go.
  const createPanel = `
    <div id="create-panel">
      <form method="POST" action="/auth/keys" class="form" data-key-form novalidate>
        <div class="steps" data-steps aria-hidden="true">
          <span class="steps__seg steps__seg--on"></span>
          <span class="steps__seg"></span>
          <span class="steps__seg"></span>
        </div>
        <div data-panel="1">
          <label class="field">
            <span class="field__label">Label</span>
            <input type="text" name="label" required maxlength="200" placeholder="e.g. Laptop CLI" autocomplete="off">
            <span class="field__hint">Name it so you can recognize it later.</span>
          </label>
        </div>
        <div data-panel="2">
          <p class="lsec" style="margin-top:0">What can this key do?</p>
          <div class="t-soft">
            ${permissionGroup("read", "Read your content", "Your notes, tasks, bookmarks, and more.", "read")}
            ${permissionGroup("write", "Write your content", "Add, edit, and organize what's in your space.", "write")}
          </div>
        </div>
        <div class="actions">
          <button type="button" class="btn btn--primary" data-next>Continue</button>
          <button type="submit" class="btn btn--primary" data-create>Create key</button>
          <button type="button" class="btn btn--ghost" data-back>Back</button>
        </div>
      </form>
    </div>
  `;

  const bodyHtml = `
    <div class="head">
      <h1 class="title">API keys</h1>
      <button type="button" class="iconbtn" id="new-key-btn" aria-label="New key" aria-expanded="false">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
    <p class="sub">Keys let the Marfa API and command line act on your behalf. Signed in as <strong>${safeEmail}</strong>.</p>

    ${noticeHtml}
    ${createPanel}
    ${keysList}

    <script>${CREATE_FLOW_SCRIPT}</script>
  `;

  return renderAuthLayout({
    title: "API keys",
    bodyHtml,
    wide: true,
  });
}

/* Copies the revealed key to the clipboard, with a brief confirmation. Carries
   no interpolated values, so it needs no escaping. */
const COPY_SCRIPT = `
(function () {
  var btn = document.getElementById('copy-key');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var el = document.getElementById(btn.getAttribute('data-copy-target'));
    if (!el) return;
    var text = el.textContent || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        btn.setAttribute('aria-label', 'Copied');
      });
    }
  });
})();
`.trim();

/* Reveals the create panel from the + button, walks the two client-side
   steps, and links each permission group's master toggle to its members.
   With no JS the panel stays visible and every member checkbox is real +
   checked, so the form is a working single-step create. Minified with
   `replace(/\\s+/g, " ")`, so NO `//` line comments. */
const CREATE_FLOW_SCRIPT = `
(function () {
  var panel = document.getElementById('create-panel');
  var openBtn = document.getElementById('new-key-btn');
  var form = panel ? panel.querySelector('[data-key-form]') : null;
  if (!panel || !openBtn || !form) return;

  var steps = form.querySelector('[data-steps]');
  var segs = steps ? steps.querySelectorAll('.steps__seg') : [];
  var panel1 = form.querySelector('[data-panel="1"]');
  var panel2 = form.querySelector('[data-panel="2"]');
  var next = form.querySelector('[data-next]');
  var create = form.querySelector('[data-create]');
  var back = form.querySelector('[data-back]');

  function step(n) {
    panel1.style.display = n === 1 ? 'block' : 'none';
    panel2.style.display = n === 2 ? 'block' : 'none';
    next.style.display = n === 1 ? 'inline-flex' : 'none';
    create.style.display = n === 2 ? 'inline-flex' : 'none';
    back.style.display = n === 2 ? 'inline-flex' : 'none';
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('steps__seg--on', i < n);
    }
  }

  panel.hidden = true;
  function setOpen(open) {
    panel.hidden = !open;
    openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { step(1); var f = panel1.querySelector('input'); if (f) f.focus(); }
  }
  openBtn.addEventListener('click', function () { setOpen(panel.hidden); });

  next.addEventListener('click', function () {
    var label = panel1.querySelector('input[name="label"]');
    if (label && !label.reportValidity()) return;
    step(2);
  });
  back.addEventListener('click', function () { step(1); });

  form.querySelectorAll('[data-master]').forEach(function (master) {
    var id = master.getAttribute('data-master');
    var members = form.querySelectorAll('input[data-group="' + id + '"]');
    master.addEventListener('change', function () {
      members.forEach(function (m) { m.checked = master.checked; });
    });
    function sync() {
      var any = false, all = true;
      members.forEach(function (m) { if (m.checked) any = true; else all = false; });
      master.checked = any; master.indeterminate = any && !all;
    }
    members.forEach(function (m) { m.addEventListener('change', sync); });
    sync();
  });

  step(1);
})();
`
  .trim()
  .replace(/\s+/g, " ");
