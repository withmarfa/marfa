import { contentSecurityPolicy } from "./content-security-policy.js";
import { Hono } from "hono";
import { PERMISSIONS } from "@withmarfa/shared";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";
import { PERMISSION_LABELS } from "./permission-labels.js";

/** These pages call the API's own documented operations, as the owner's browser. */
export function managementPages() {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    requireDirectAuthority(c);
    c.header(
      "Content-Security-Policy",
      `${contentSecurityPolicy(c.var.cspNonce)}; connect-src 'self'; form-action 'self'`,
    );
    await next();
  });
  router.get("/manage", (c) => {
    const permissions = PERMISSIONS.map(
      (permission) =>
        `<label><input type="checkbox" name="permission" value="${escapeHtml(permission)}"> ${escapeHtml(PERMISSION_LABELS[permission])}</label>`,
    ).join("");
    return c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: "Manage Marfa",
        wide: true,
        bodyHtml: `<h1>Manage Marfa</h1>
<p><a href="/auth/owner/password">Change password</a> | <a href="/auth/owner/restore">Restore an archive</a></p>
<p id="status" role="status"></p>
<h2>Server</h2><pre id="health">Loading…</pre>
<h2>Maintenance</h2><p>Maintenance can permanently delete data that is eligible for removal.</p><ul id="jobs"></ul>
<h2>Signed-in browsers</h2><p>A browser stays signed in until it goes unused for seven days. To sign a browser out, sign in within the last five minutes. <a href="/auth/sign-in?prompt=login&amp;return_to=%2Fauth%2Fowner%2Fmanage">Sign in again</a></p><ul id="browsers"></ul>
<h2>Connected apps</h2><ul id="apps"></ul>
<h2>Connectors</h2><ul id="connectors"></ul>
<h2>Keys</h2><p>To create or change a key, sign in within the last five minutes. <a href="/auth/sign-in?prompt=login&amp;return_to=%2Fauth%2Fowner%2Fmanage">Sign in again</a></p><ul id="keys"></ul>
<details><summary>Create a key</summary><p>A key keeps access until you revoke it. Choose only the access it needs.</p>
<form id="mint"><label for="label">Name</label><input id="label" name="label" required maxlength="200"><label for="source">Source name</label><input id="source" name="source" required maxlength="200">
<label><input type="checkbox" name="content"> Read and write all content</label>
<fieldset><legend>Additional permissions</legend>${permissions}</fieldset><button>Create key</button></form>
<p id="new-key" role="status"></p></details>
<script nonce="${escapeHtml(c.var.cspNonce)}">
const status = document.getElementById('status');
async function request(path, init = {}) {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'This operation could not be completed.');
  return body;
}
function action(parent, label, run) {
  const button = document.createElement('button'); button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true; status.textContent = '';
    try { if ((await run()) === 'left') return; status.textContent = 'Done.'; await refresh(); }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  }); parent.append(' ', button);
}
function rows(id, data, render) {
  const list = document.getElementById(id); list.replaceChildren();
  for (const row of data) { const li = document.createElement('li'); render(li, row); list.append(li); }
  if (!data.length) { const li = document.createElement('li'); li.textContent = 'None'; list.append(li); }
}
async function refresh() {
  const [health, jobs, keys, connectors, apps, signIns] = await Promise.all([
    request('/health'), request('/housekeeping'), request('/keys'), request('/connectors'), request('/auth/grants'), request('/owner/sign-ins')
  ]);
  document.getElementById('health').textContent = 'Status: ' + health.status;
  rows('jobs', jobs.data, (li, row) => { li.textContent = row.name;
    action(li, 'Run maintenance', async () => {
      if (!confirm('Run this maintenance job? It may permanently remove eligible data.')) return;
      const result = await request('/housekeeping/' + encodeURIComponent(row.name) + '/run', {method:'POST'});
      if (result.outcome === 'error') throw new Error(result.error || 'Maintenance failed.');
    });
  });
  rows('keys', keys.data, (li, row) => { li.textContent = row.label + ' (' + row.source + ')';
    action(li, 'Revoke', async () => { if (confirm('Revoke this key? Anything using it will lose access.')) await request('/keys/' + encodeURIComponent(row.id), {method:'DELETE'}); });
  });
  rows('connectors', connectors.data, (li, row) => { li.textContent = row.name;
    action(li, 'Remove', async () => { if (confirm('Remove this connector registration?')) await request('/connectors/' + encodeURIComponent(row.id), {method:'DELETE'}); });
  });
  rows('browsers', signIns.data.filter((row) => row.kind === 'browser'), (li, row) => {
    li.textContent = row.name + (row.ip_address ? ', from ' + row.ip_address : '') + ', last used ' + new Date(row.last_used_at).toLocaleString() + (row.current ? ' (this browser)' : '');
    action(li, 'Sign out', async () => {
      if (!confirm(row.current ? 'Sign out this browser?' : 'Sign out this browser? It will need to sign in again. Connected apps keep their access.')) return;
      await request('/owner/sign-ins/' + encodeURIComponent(row.id), {method:'DELETE'});
      if (row.current) { location.assign('/auth/sign-in'); return 'left'; }
    });
  });
  rows('apps', apps.data, (li, row) => { li.textContent = row.client_name || row.client_id || row.id;
    action(li, 'Disconnect', async () => { if (confirm('Disconnect this app? Its ordinary keys keep their access.')) await request('/auth/grants/' + encodeURIComponent(row.id), {method:'DELETE'}); });
    action(li, 'Disconnect and revoke keys', async () => { if (confirm('Disconnect this app and revoke all keys it created, including descendant keys?')) await request('/auth/grants/' + encodeURIComponent(row.id) + '?revoke_keys=true', {method:'DELETE'}); });
  });
}
document.getElementById('mint').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  document.getElementById('new-key').textContent = ''; const data = new FormData(form);
  const body = {label:data.get('label'), source:data.get('source'), permissions:data.getAll('permission')};
  if (data.has('content')) for (const field of ['type_permissions','edge_permissions','extension_permissions','metadata_permissions','profile_permissions']) body[field] = {'*':'write'};
  try { const key = await request('/keys', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    document.getElementById('new-key').textContent = 'Copy this key now. It will not be shown again: ' + key.key; await refresh();
  } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
});
refresh().catch(error => {status.textContent = error.message;});
</script>`,
      }),
    );
  });
  router.get("/restore", (c) =>
    c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: "Restore an archive",
        bodyHtml: `<h1>Restore an archive</h1><p>Restore a Marfa archive into this instance. Existing items stay as they are. The archive can also restore server-managed records.</p>
<p>You must have signed in within the last five minutes. <a href="/auth/sign-in?prompt=login&amp;return_to=%2Fauth%2Fowner%2Frestore">Sign in again</a></p>
<form id="restore"><label for="archive">Marfa archive</label><input id="archive" type="file" accept=".gz,.tgz,application/gzip" required><button>Restore archive</button></form>
<p id="result" role="status"></p><a href="/auth/owner/manage">Back to settings</a>
<script nonce="${escapeHtml(c.var.cspNonce)}">
document.getElementById('restore').addEventListener('submit', async (event) => {
  event.preventDefault(); const file = document.getElementById('archive').files[0]; if (!file) return;
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  const result = document.getElementById('result'); result.textContent = 'Restoring…';
  try { const response = await fetch('/restore', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/gzip'}, body:file});
    const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || 'The archive could not be restored.');
    result.textContent = 'Restored ' + body.imported + ' items and ' + body.blobs_imported + ' files. Skipped ' + body.duplicates + ' existing items.';
  } catch(error) { result.textContent = error.message; } finally { button.disabled = false; }
});
</script>`,
      }),
    ),
  );
  return router;
}
