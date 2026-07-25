/**
 * Alert delivery: one deduplicated issue, opened on red and closed on
 * recovery.
 *
 * A monitor that runs every few minutes must never create an issue every few
 * minutes. The contract here is:
 *
 *   - **One issue at a time.** Located by a fixed title, so the lookup does
 *     not depend on any state the workflow would have to persist between
 *     runs. Nothing accumulates and nothing needs cleaning up.
 *   - **Edited, not re-commented.** Each run rewrites the issue body with the
 *     current state, so the issue always reflects what is wrong *now* rather
 *     than a scroll of history.
 *   - **A comment only when the picture changes.** A fingerprint over the set
 *     of findings is embedded in the body; a new comment is posted only when
 *     that fingerprint moves. An incident that persists unchanged stays
 *     quiet; an incident that spreads or shifts speaks up.
 *   - **Closed on recovery,** with a comment recording it, so an open issue
 *     always means a live problem.
 */

import { createHash } from "node:crypto";

const ISSUE_TITLE = "Fleet health alert";
const ISSUE_LABEL = "observability";
const FINGERPRINT_PREFIX = "<!-- observability-fingerprint:";

async function githubApi(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${String(response.status)}: ${detail.slice(0, 300)}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

function fingerprint(findings) {
  const stable = findings
    .map((f) => `${f.area}:${f.title}`)
    .sort()
    .join("|");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function readFingerprint(body) {
  const match = /<!-- observability-fingerprint:([a-f0-9]+) -->/.exec(
    body ?? "",
  );
  return match ? match[1] : null;
}

function renderBody({ findings, runUrl, checkedAt, fp, context }) {
  const lines = [
    `${FINGERPRINT_PREFIX}${fp} -->`,
    "",
    "This issue is maintained automatically by the scheduled observability",
    "workflow. It is rewritten in place on each run and closed when the fleet",
    "recovers, so its contents always describe the current state.",
    "",
    `**Last checked:** ${checkedAt}`,
    `**Run:** ${runUrl}`,
    "",
    "## What is wrong",
    "",
  ];

  for (const finding of findings) {
    lines.push(`### ${finding.title}`, "", finding.detail, "");
  }

  if (context.length > 0) {
    lines.push("## Context", "", ...context, "");
  }

  lines.push(
    "---",
    "",
    "Closing this issue by hand will not stop the alert: the next run will",
    "reopen it while the underlying condition persists.",
  );

  return lines.join("\n");
}

async function findOpenIssue(repo, token) {
  const issues = await githubApi(
    `/repos/${repo}/issues?state=open&per_page=100`,
    token,
  );
  return (
    issues.find(
      (issue) => issue.title === ISSUE_TITLE && !issue.pull_request,
    ) ?? null
  );
}

async function ensureLabel(repo, token) {
  try {
    await githubApi(`/repos/${repo}/labels/${ISSUE_LABEL}`, token);
  } catch {
    // Missing label, or no permission to read labels. Either way, try to
    // create it and carry on if that fails too — a missing label must never
    // be the reason an alert goes undelivered.
    try {
      await githubApi(`/repos/${repo}/labels`, token, {
        method: "POST",
        body: {
          name: ISSUE_LABEL,
          color: "b60205",
          description: "Raised by the scheduled fleet health check",
        },
      });
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Reconcile the alert issue against the current findings.
 *
 * @returns {Promise<{action: string, url: string|null}>}
 */
export async function reconcileAlert({
  repo,
  token,
  findings,
  runUrl,
  checkedAt,
  context = [],
}) {
  const existing = await findOpenIssue(repo, token);

  if (findings.length === 0) {
    if (!existing) return { action: "none", url: null };

    await githubApi(
      `/repos/${repo}/issues/${String(existing.number)}/comments`,
      token,
      {
        method: "POST",
        body: {
          body:
            `Recovered at ${checkedAt}. All monitored surfaces are healthy and ` +
            `no thresholds are breached.\n\nRun: ${runUrl}`,
        },
      },
    );
    await githubApi(`/repos/${repo}/issues/${String(existing.number)}`, token, {
      method: "PATCH",
      body: { state: "closed", state_reason: "completed" },
    });
    return { action: "closed", url: existing.html_url };
  }

  const fp = fingerprint(findings);
  const body = renderBody({ findings, runUrl, checkedAt, fp, context });

  if (!existing) {
    await ensureLabel(repo, token);
    const created = await githubApi(`/repos/${repo}/issues`, token, {
      method: "POST",
      body: { title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] },
    });
    return { action: "opened", url: created.html_url };
  }

  const previousFp = readFingerprint(existing.body);
  await githubApi(`/repos/${repo}/issues/${String(existing.number)}`, token, {
    method: "PATCH",
    body: { body },
  });

  if (previousFp !== fp) {
    await githubApi(
      `/repos/${repo}/issues/${String(existing.number)}/comments`,
      token,
      {
        method: "POST",
        body: {
          body:
            `The set of failing checks changed at ${checkedAt}:\n\n` +
            findings.map((f) => `- ${f.title}`).join("\n") +
            `\n\nRun: ${runUrl}`,
        },
      },
    );
    return { action: "updated-changed", url: existing.html_url };
  }

  return { action: "updated-quiet", url: existing.html_url };
}
