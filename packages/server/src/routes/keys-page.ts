/**
 * Console page renderer for `/auth/keys`.
 *
 * Auth-gated (Better Auth cookie session). Lets a signed-in space owner
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
 * Creating a key swaps the list out for a focused create form — name it and
 * choose what it can reach (the same soft-tile permission groups the consent
 * screen uses) in one step — then the one-time secret is shown on its own
 * screen. The chosen permissions are the whole of what the key can do: a key
 * holds one permission set and no door admits it on anything else.
 *
 * **A key an app made is listed under that app.** A key minted through a
 * sign-in records which app minted it, and this page groups by that rather
 * than mixing the two, because the two are not the same kind of thing to the
 * person reading: one is theirs and lives until they revoke it, the other
 * arrived with an app they connected and goes when they disconnect it, if
 * they ask for that. The rows carry no revoke button of a different colour
 * and no extra affordance — the grouping is the whole of the distinction.
 *
 * Uses the shared auth-page layout, wide variant.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml, confirmIcon } from "./auth-html.js";

export interface KeysPageKey {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  /**
   * The app that minted this key, when one did. Absent for a key the person
   * made themselves, which is what puts it in the first group.
   *
   * **Two fields because the grouping key and the heading are not the same
   * thing.** Registration is open and `client_name` is caller-chosen, so two
   * apps can share a display name; grouping on the name would file a second
   * app's key under the first app's heading. The id is what identifies an app
   * and the name is what a person can read, so one groups and the other
   * renders. The caller resolves the name, falling back to the id when the
   * registration is gone.
   */
  app_id?: string;
  app_name?: string;
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
  /** Dev/gallery only: render with the create form in focus instead of the
   *  list, so the create step is reviewable without driving the + button. */
  forceCreate?: boolean;
}

/**
 * The content types a self-serve key can be scoped to, with the human label
 * the picker shows. Read submits `<type>:read`, write submits `<type>:write`;
 * the POST handler projects the ticked set into the key's type permissions.
 */
const KEY_CONTENT_TYPES: readonly { label: string; type: string }[] = [
  { label: "Notes", type: "core.note" },
  { label: "Messages", type: "core.message" },
  { label: "Tasks", type: "core.task" },
  { label: "Bookmarks", type: "core.bookmark" },
  { label: "Highlights", type: "core.highlight" },
  { label: "Calendar", type: "core.event" },
  { label: "Contacts", type: "core.entity.person" },
  // Subtree, not the bare identifier. `core.file` alone is an exact match, so
  // it would grant nothing on `core.file.image` while reading to the person
  // ticking it as though it covered every file. `core.file.*` matches the
  // parent and its descendants both.
  { label: "Files", type: "core.file.*" },
];

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
  if (!iso) return "Unknown";
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
      ${confirmIcon("check")}
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
    return renderAuthLayout({
      title: "Your key is ready",
      bodyHtml: reveal,
      wide: true,
      centered: true,
    });
  }

  const noticeHtml = params.notice
    ? `<div class="banner banner--${params.notice.kind === "success" ? "success" : "error"}" role="${
        params.notice.kind === "success" ? "status" : "alert"
      }">${escapeHtml(params.notice.text)}</div>`
    : "";

  const keyRow = (k: KeysPageKey): string => {
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
  };

  // Own keys first, then one group per app that minted one. The apps are
  // ordered by name so the page does not reshuffle between loads on nothing
  // more than the order the store happened to return rows in.
  const ownKeys = params.keys.filter((k) => k.app_id === undefined);
  const byApp = new Map<string, { name: string; keys: KeysPageKey[] }>();
  for (const k of params.keys) {
    if (k.app_id === undefined) continue;
    const name = k.app_name ?? k.app_id;
    const group = byApp.get(k.app_id);
    if (group) group.keys.push(k);
    else byApp.set(k.app_id, { name, keys: [k] });
  }
  const apps = [...byApp.values()].sort((a, b) => a.name.localeCompare(b.name));

  // The headings appear only once there are two groups to tell apart: a person
  // with no connected apps sees exactly the list they saw before, with no
  // section label inviting them to wonder what the other section is.
  const parts: string[] = [];
  if (ownKeys.length === 0 && apps.length === 0) {
    parts.push(
      `<p class="field__hint">You have no API keys yet. Create one with the + button.</p>`,
    );
  } else {
    if (ownKeys.length > 0) {
      if (apps.length > 0) parts.push(`<p class="lsec">Your keys</p>`);
      parts.push(...ownKeys.map(keyRow));
    }
    for (const app of apps) {
      parts.push(`<p class="lsec">Made by ${escapeHtml(app.name)}</p>`);
      parts.push(...app.keys.map(keyRow));
    }
  }
  const keysList = parts.join("\n");

  // Focused create view. The + button swaps the list out for this form (a
  // single step — name + permissions together, no mid-page stepper); Cancel
  // swaps back. With no JS both views render, so the form stays reachable and
  // submits the default (all content) in one POST. `forceCreate` (gallery only)
  // opens straight into this view.
  const createView = `
    <div id="create-panel" data-create-view${params.forceCreate ? ' data-start-open="1"' : ""}>
      <p class="sub">Name your key and choose what it can reach.</p>
      <form method="POST" action="/auth/keys" class="form" data-key-form novalidate>
        <label class="field">
          <span class="field__label">Label</span>
          <input type="text" name="label" required maxlength="200" placeholder="e.g. Laptop CLI" autocomplete="off">
          <span class="field__hint">Name it so you can recognize it later.</span>
        </label>
        <div>
          <p class="lsec" style="margin-top:2px">What content can this key reach?</p>
          <p class="field__hint" style="margin:0 0 10px">A key acts on your behalf over the content you pick. Your profile and account stay private.</p>
          <div class="t-soft">
            ${permissionGroup("read", "Read your content", "Your notes, tasks, bookmarks, and more.", "read")}
            ${permissionGroup("write", "Write your content", "Add, edit, and organize what's in your space.", "write")}
          </div>
        </div>
        <div>
          <p class="lsec" style="margin-top:2px">Everything in your space</p>
          <p class="field__hint" style="margin:0 0 10px">For moving a whole space in or out: importing an existing library, migrating between instances, or restoring a backup. Covers every kind of content and every connection between them, including any added later. Leave it off for a key you are giving to an app.</p>
          <div class="t-soft">
            <div class="subrow">
              <span>Full access</span>
              <label class="sw"><input type="checkbox" name="full_access"><span class="tk"></span></label>
            </div>
          </div>
        </div>
        <div class="actions">
          <button type="submit" class="btn btn--primary" data-create data-loading-label="Creating key...">Create key</button>
          <button type="button" class="btn btn--ghost" data-cancel>Cancel</button>
        </div>
      </form>
    </div>
  `;

  const listView = `
    <div data-list-view${params.forceCreate ? " hidden" : ""}>
      <p class="sub">Keys let the Marfa API and command line act on your behalf. Signed in as <strong>${safeEmail}</strong>.</p>
      ${noticeHtml}
      ${keysList}
    </div>
  `;

  const bodyHtml = `
    <div class="head">
      <h1 class="title">API keys</h1>
      <button type="button" class="iconbtn" id="new-key-btn" aria-label="New key" aria-expanded="false">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    ${listView}
    ${createView}

    <script src="/auth/static/submit-state.js"></script>
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

/* Swaps the key list out for the create form (and back), and links each
   permission group's master toggle to its members. The create form is a single
   step — name + permissions together, no stepper. With no JS both views render,
   so the form stays reachable and submits the default (all content) in one
   POST. Validation runs through window.MarfaForm (submit-state.js), never the
   native bubble. Minified with `replace(/\\s+/g, " ")`, so NO `//` comments. */
const CREATE_FLOW_SCRIPT = `
(function () {
  var openBtn = document.getElementById('new-key-btn');
  var listView = document.querySelector('[data-list-view]');
  var createView = document.querySelector('[data-create-view]');
  var form = createView ? createView.querySelector('[data-key-form]') : null;
  if (!openBtn || !listView || !createView || !form) return;

  function setCreating(on) {
    listView.hidden = on;
    createView.hidden = !on;
    openBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { var f = form.querySelector('input'); if (f) f.focus(); }
  }
  openBtn.addEventListener('click', function () { setCreating(createView.hidden); });
  var cancel = form.querySelector('[data-cancel]');
  if (cancel) cancel.addEventListener('click', function () { setCreating(false); });

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

  setCreating(createView.getAttribute('data-start-open') === '1');
})();
`
  .trim()
  .replace(/\s+/g, " ");
