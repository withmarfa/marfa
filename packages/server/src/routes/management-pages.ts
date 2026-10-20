import type { Storage } from "../storage/interface.js";
import { readInstanceName } from "../instance-name.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { Hono } from "hono";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { renderAuthLayout } from "./auth-layout.js";
import { confirmDialogMarkup } from "./confirm-host.js";
import { signInLeft } from "./confirm-gate.js";
import { escapeHtml } from "./auth-html.js";

/** These pages call the API's own documented operations, as the owner's browser. */
export function managementPages(storage: Storage) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    requireDirectAuthority(c);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    await next();
  });
  router.get("/manage", async (c) => {
    const instanceName = await readInstanceName(storage.settings);
    return c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: `Manage ${instanceName}`,
        wide: true,
        bodyHtml: `<h1>Manage ${escapeHtml(instanceName)}</h1>
<p><a href="/auth/owner/keys">API keys</a> | <a href="/auth/owner/apps">Connected apps</a> | <a href="/auth/owner/browsers">Browsers</a> | <a href="/auth/owner/passkeys">Password and passkeys</a> | <a href="/auth/owner/restore">Restore an archive</a></p>
<p id="status" role="status"></p>
<h2>Server</h2><pre id="health">Loading…</pre>
<h2>Maintenance</h2><p>Maintenance can permanently delete data that is eligible for removal.</p><ul id="jobs"></ul>
<h2>Connectors</h2><ul id="connectors"></ul>
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
    try { await run(); status.textContent = 'Done.'; await refresh(); }
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
  const [health, jobs, connectors] = await Promise.all([
    request('/health'), request('/housekeeping'), request('/connectors')
  ]);
  document.getElementById('health').textContent = 'Status: ' + health.status;
  rows('jobs', jobs.data, (li, row) => { li.textContent = row.name;
    action(li, 'Run maintenance', async () => {
      if (!confirm('Run this maintenance job? It may permanently remove eligible data.')) return;
      const result = await request('/housekeeping/' + encodeURIComponent(row.name) + '/run', {method:'POST'});
      if (result.outcome === 'error') throw new Error(result.error || 'Maintenance failed.');
    });
  });
  rows('connectors', connectors.data, (li, row) => { li.textContent = row.name;
    action(li, 'Remove', async () => { if (confirm('Remove this connector registration?')) await request('/connectors/' + encodeURIComponent(row.id), {method:'DELETE'}); });
  });
}
refresh().catch(error => {status.textContent = error.message;});
</script>`,
      }),
    );
  });
  router.get("/restore", (c) => {
    // A restore is usually large, so the page asks the owner to confirm before
    // the upload starts rather than after the server has refused it.
    const left = signInLeft(c);
    return c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: "Restore an archive",
        bodyHtml: `<h1>Restore an archive</h1><p>Restore a Marfa archive into this instance. Existing items stay as they are. The archive can also restore server-managed records.</p>
<form id="restore"${left === undefined ? "" : ` data-confirm-left="${String(Math.max(0, Math.round(left)))}"`}><label for="archive">Marfa archive</label><input id="archive" type="file" accept=".gz,.tgz,application/gzip" required><button>Restore archive</button></form>
<p id="result" role="status"></p><a href="/auth/owner/manage">Back to settings</a>
${confirmDialogMarkup(c.var.cspNonce)}
<script nonce="${escapeHtml(c.var.cspNonce)}">
const gate = { left: Number(document.getElementById('restore').dataset.confirmLeft), rendered: Date.now() };
document.getElementById('restore').addEventListener('submit', async (event) => {
  event.preventDefault(); const file = document.getElementById('archive').files[0]; if (!file) return;
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  const result = document.getElementById('result'); result.textContent = 'Restoring…';
  try { const response = await window.marfaConfirm.send(() => fetch('/restore', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/gzip'}, body:file}), 'Restoring adds to your data.', button, Number.isFinite(gate.left) ? gate : undefined);
    if (response === null) { result.textContent = 'Nothing was restored.'; return; }
    const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || 'The archive could not be restored.');
    const lacking = body.blobs_missing.length; const missing = lacking ? ' ' + lacking + (lacking === 1 ? ' file is' : ' files are') + ' missing from both the archive and this instance.' : '';
    result.textContent = 'Restored ' + body.imported + ' items and ' + body.blobs_imported + ' files. Skipped ' + body.duplicates + ' existing items.' + missing;
  } catch(error) { result.textContent = error.message; } finally { button.disabled = false; }
});
</script>`,
      }),
    );
  });
  return router;
}
