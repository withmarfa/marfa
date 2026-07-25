/**
 * Scheduled fleet health check.
 *
 * Run by `.github/workflows/observability.yml`. Gathers every signal, writes
 * a run summary, reconciles a single deduplicated alert issue, emits a
 * heartbeat, and exits non-zero if anything is red so the failure is visible
 * in the workflow list without opening anything.
 */

import { appendFileSync } from "node:fs";
import { SURFACES, UNREACHABLE_SURFACES } from "./surfaces.mjs";
import { checkLiveness } from "./probes.mjs";
import { checkDeployDrift } from "./drift.mjs";
import { checkTelemetry } from "./posthog.mjs";
import {
  emitHeartbeat,
  checkHeartbeatGap,
  checkFleetOscillation,
} from "./heartbeat.mjs";
import { reconcileAlert } from "./alert.mjs";

const env = process.env;
const now = new Date();

function summary(lines) {
  const text = `${lines.join("\n")}\n`;
  process.stdout.write(text);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  }
}

/**
 * A monitor nobody has seen fire is a monitor nobody should trust. This input
 * injects a surface that is guaranteed to fail, so the full path — detection,
 * issue creation, non-zero exit — can be exercised on demand against the real
 * fleet without waiting for a real outage or editing the surface list.
 */
function surfacesForRun() {
  if (env.SYNTHETIC_FAILURE !== "true") return SURFACES;
  return [
    ...SURFACES,
    {
      id: "synthetic-failure",
      label: "Synthetic failure probe",
      // A path that will never exist, on a host that is definitely up: this
      // proves the alerting path rather than any particular surface's health.
      url: "https://docs.marfa.so/__observability_synthetic_failure__",
      kind: "static",
    },
  ];
}

async function main() {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const runUrl =
    env.GITHUB_SERVER_URL && repo && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : "(local run)";

  const heartbeat = await checkHeartbeatGap({ env, now });
  const liveness = await checkLiveness(surfacesForRun());
  const drift = await checkDeployDrift({
    repo,
    token,
    probeResults: liveness.results,
    now,
  });
  const telemetry = await checkTelemetry(env);
  const oscillation = await checkFleetOscillation({ env });

  const allFindings = [
    ...heartbeat.findings,
    ...oscillation.findings,
    ...liveness.findings,
    ...drift.findings,
    ...telemetry.findings,
  ];
  const red = allFindings.filter((f) => f.severity === "red");
  const warn = allFindings.filter((f) => f.severity === "warn");

  // ---- Run summary -------------------------------------------------------

  const lines = [
    `# Fleet health — ${red.length === 0 ? "healthy" : "ALERT"}`,
    "",
    `Checked at ${now.toISOString()}`,
    "",
  ];

  if (red.length > 0) {
    lines.push("## Failing", "");
    for (const f of red) lines.push(`- **${f.title}** — ${f.detail}`);
    lines.push("");
  }
  if (warn.length > 0) {
    lines.push("## Warnings", "");
    for (const f of warn) lines.push(`- **${f.title}** — ${f.detail}`);
    lines.push("");
  }

  // Every surface is sampled several times per run. Showing the pass/fail
  // split rather than a single verdict is the point: "2/3 ok" and "3/3 ok"
  // mean very different things, and collapsing them is what let an
  // intermittent surface read as healthy.
  lines.push(
    "## Liveness",
    "",
    "| Surface | State | Samples ok | Slowest | Detail |",
    "|---|---|---|---|---|",
  );
  for (const r of liveness.results) {
    const passed = r.samples - r.failed;
    lines.push(
      `| ${r.surface.label} | ${r.state} | ${String(passed)}/${String(r.samples)} | ` +
        `${r.durationMs === null ? "—" : `${String(r.durationMs)} ms`} | ` +
        `${r.ok ? "—" : r.detail} |`,
    );
  }
  lines.push("");

  lines.push(
    "## Deployed builds",
    "",
    "| Environment | Build | Behind main | Age |",
    "|---|---|---|---|",
  );
  for (const e of drift.environments) {
    lines.push(
      `| ${e.label} | \`${e.sha ?? "unknown"}\` | ` +
        `${e.behindMain === null ? "—" : `${String(e.behindMain)} commit(s)`} | ` +
        `${e.ageDays === null ? "—" : `${String(e.ageDays)} day(s)`} |`,
    );
  }
  lines.push("");

  lines.push("## Telemetry");
  lines.push("");
  if (!telemetry.configured) {
    lines.push(
      "Not checked — telemetry credentials are not configured for this repository.",
      "",
    );
  } else if (telemetry.services.length === 0) {
    lines.push(
      `No log records at all in the last ${String(telemetry.windowMinutes)} minutes.`,
      "",
    );
  } else {
    // Startups and shutdowns are shown side by side because their difference
    // is the signal, not either count alone: matched pairs are a container
    // waking on demand, unpaired startups are a process that died.
    lines.push(
      `Window: last ${String(telemetry.windowMinutes)} minutes.`,
      "",
      "| Project | Service | Errors | Startups | Clean stops | Records |",
      "|---|---|---|---|---|---|",
    );
    for (const s of telemetry.services) {
      lines.push(
        `| ${s.project} | ${s.service} | ${String(s.errors)} | ${String(s.boots)} | ` +
          `${String(s.shutdowns)} | ${String(s.total)} |`,
      );
    }
    lines.push("");
  }

  // Spell out the blind spot when it is actually biting. A surface with no
  // running instance emits nothing, so every telemetry check above goes quiet
  // — which looks exactly like health. Saying so on the run that it matters
  // stops the empty rows being read as reassurance.
  const noInstance = liveness.results.filter(
    (r) =>
      !r.ok &&
      (r.kind === "instance-not-running" ||
        r.kind === "instance-will-not-start"),
  );
  if (noInstance.length > 0) {
    lines.push(
      `> ${noInstance.map((r) => r.surface.label).join(", ")} had no running instance ` +
        "during this run. A service that is not running emits no telemetry, so the " +
        "error-rate and restart checks above are structurally blind to this outage — " +
        "their silence is a consequence of it, not evidence against it.",
      "",
    );
  }

  lines.push("## Not covered by this check", "");
  for (const s of UNREACHABLE_SURFACES) {
    lines.push(`- **${s.label}** — ${s.reason}. Covered by: ${s.covered_by}.`);
  }
  lines.push(
    "",
    "These sit behind a private network boundary with no route from a hosted",
    "runner. Their telemetry is still visible in the table above, so a restart",
    "loop on one of them is caught here even though its endpoint is not.",
    "",
  );

  // ---- Alert -------------------------------------------------------------

  const context = [
    ...warn.map((f) => `- ${f.title}: ${f.detail}`),
    ...drift.environments.map(
      (e) =>
        `- ${e.label} is running \`${e.sha ?? "unknown"}\`` +
        (e.ageDays === null ? "" : ` (${String(e.ageDays)} day(s) old)`),
    ),
  ];

  // Alert reconciliation is suppressed when this runs as a pull-request
  // validation of the checker itself. That run exists to prove the code
  // executes on a runner, and a proposed change must not be able to open,
  // edit, or close the alert issue the real schedule owns.
  const alertEnabled = env.ALERT_ENABLED !== "false";

  let alert = { action: alertEnabled ? "skipped" : "suppressed", url: null };
  if (repo && token && alertEnabled) {
    try {
      alert = await reconcileAlert({
        repo,
        token,
        findings: red,
        runUrl,
        checkedAt: now.toISOString(),
        context,
      });
    } catch (error) {
      lines.push(
        `> Alert delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        "",
      );
    }
  }
  lines.push(
    `Alert issue: ${alert.action}${alert.url ? ` — ${alert.url}` : ""}`,
  );

  // The heartbeat is emitted last and unconditionally, so its presence means
  // "a run completed", not "a run found nothing wrong".
  const beat = await emitHeartbeat({
    env,
    runId: env.GITHUB_RUN_ID ?? "local",
    healthy: red.length === 0,
  });
  lines.push(
    `Heartbeat: ${beat.emitted ? "emitted" : `not emitted (${String(beat.reason ?? beat.status)})`}` +
      (heartbeat.lastSeen
        ? `, previous ${String(heartbeat.ageMinutes)} min ago`
        : ""),
  );

  summary(lines);

  // In validation mode the question is "does this checker run?", not "is the
  // fleet healthy?" — so a genuine outage must not fail somebody's unrelated
  // pull request. The scheduled run is what turns red into a failure.
  if (red.length > 0 && alertEnabled) {
    process.exitCode = 1;
  }
}

await main();
