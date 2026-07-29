/**
 * Soak harness for the reactive-run bridge fanout.
 *
 * Drives realistic load against a deployed Marfa instance: registers a
 * synthetic Integration manifest, installs ≥50 subscribing connections,
 * publishes a representative event burst, and captures publish-side
 * timings. The bridge's `[reactive-run-bridge]` log lines on the server
 * are the source of truth for end-to-end fanout health (see "Inspect on
 * the server" output at the end of the run).
 *
 * Pre-requirements (verify before running):
 *   - The reactive-run bridge is wired in `packages/server/src/index.ts`.
 *   - The deployment carries the JSON install endpoint
 *     `POST /connections/install`.
 *   - The server's CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS +
 *     CLOUDFLARE_QUEUES_API_TOKEN are set (JSON map of
 *     integration_name → producer URL); on boot the server logs
 *     "Reactive-run bridge started".
 *
 * Usage (against staging):
 *   MARFA_API_URL=https://staging.marfa.so \
 *   MARFA_API_KEY=<admin-key> \
 *   pnpm --filter @withmarfa/server exec tsx scripts/soak-fanout.ts \
 *     [--connections 50] [--events 100]
 *
 * Implementation note: this script uses raw `fetch` rather than depending
 * on `@withmarfa/sdk` so it doesn't drag SDK build state into the server
 * package's devDependencies. The wire shapes are stable; the explicit
 * fetch is honest about what's going on the wire.
 */
import { setTimeout as sleep } from "node:timers/promises";

interface SoakConfig {
  url: string;
  key: string;
  connectionCount: number;
  eventCount: number;
}

interface PublishSample {
  index: number;
  latencyMs: number;
  status: "ok" | "error";
  error?: string;
}

function parseArgs(): SoakConfig {
  const url = process.env.MARFA_API_URL;
  const key = process.env.MARFA_API_KEY;
  if (!url || !key) {
    throw new Error("MARFA_API_URL and MARFA_API_KEY must be set");
  }
  let connectionCount = 50;
  let eventCount = 100;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--connections") {
      const next = argv[i + 1];
      if (!next) throw new Error("--connections expects a value");
      connectionCount = Number.parseInt(next, 10);
      i++;
    } else if (argv[i] === "--events") {
      const next = argv[i + 1];
      if (!next) throw new Error("--events expects a value");
      eventCount = Number.parseInt(next, 10);
      i++;
    }
  }
  if (!Number.isFinite(connectionCount) || connectionCount < 1) {
    throw new Error("--connections must be a positive integer");
  }
  if (!Number.isFinite(eventCount) || eventCount < 1) {
    throw new Error("--events must be a positive integer");
  }
  return { url, key, connectionCount, eventCount };
}

function syntheticManifest(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    publisher: "Marfa",
    description: "soak harness — synthetic subscriber",
    direction: "read",
    triggers: [{ type: "item-event" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "ignore",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo] ?? 0;
  const wlo = sorted[lo] ?? 0;
  const whi = sorted[hi] ?? 0;
  return wlo + (whi - wlo) * (rank - lo);
}

async function postJson(
  url: string,
  key: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${path} failed (${String(res.status)}): ${text.slice(0, 200)}`,
    );
  }
  return await res.json();
}

async function main(): Promise<void> {
  const config = parseArgs();
  const startedAt = Date.now();
  // Manifest names follow `<publisher>.<lowercase-alphanumeric-hyphens>`;
  // `marfa` is a reserved root, so use `acme` for the synthetic publisher
  // and lowercase the timestamp to satisfy the grammar.
  const runTag = `${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
  const manifestName = `acme.soak-fanout-${runTag}`;

  console.log("======================================================");
  console.log("Reactive-run bridge soak harness");
  console.log("======================================================");
  console.log(`URL:                ${config.url}`);
  console.log(`Connections:        ${String(config.connectionCount)}`);
  console.log(`Events to publish:  ${String(config.eventCount)}`);
  console.log(`Run tag:            ${runTag}`);
  console.log("");

  console.log("[1/4] Registering synthetic integration manifest...");
  const integrationResp = (await postJson(
    config.url,
    config.key,
    "/integrations",
    { manifest: syntheticManifest(manifestName) },
  )) as { id: string };
  const integrationId = integrationResp.id;
  console.log(`        integration_id = ${integrationId}`);

  console.log(
    `[2/4] Installing ${String(config.connectionCount)} subscribing connections...`,
  );
  const installStart = Date.now();
  const connectionIds: string[] = [];
  for (let i = 0; i < config.connectionCount; i++) {
    const installed = (await postJson(
      config.url,
      config.key,
      "/connections/install",
      {
        integration_id: integrationId,
        label: `${manifestName} #${String(i + 1)}`,
      },
    )) as { connection_id: string };
    connectionIds.push(installed.connection_id);
    if ((i + 1) % 10 === 0) {
      console.log(
        `        ${String(i + 1)}/${String(config.connectionCount)} installed (elapsed ${String(Date.now() - installStart)}ms)`,
      );
    }
  }
  console.log(
    `        all ${String(config.connectionCount)} installed in ${String(Date.now() - installStart)}ms`,
  );

  // The subscription cache is invalidated on connection lifecycle events;
  // allow a moment for the in-process listener to absorb every install.
  console.log("[3/4] Letting bridge subscription cache settle (3s)...");
  await sleep(3000);

  console.log(
    `[4/4] Publishing ${String(config.eventCount)} item-events (creating core.note items)...`,
  );
  const samples: PublishSample[] = [];
  const publishStart = Date.now();
  for (let i = 0; i < config.eventCount; i++) {
    const t0 = Date.now();
    try {
      await postJson(config.url, config.key, "/items", {
        type: "core.note",
        properties: { body: `soak-${runTag}-${String(i)}` },
      });
      samples.push({
        index: i,
        latencyMs: Date.now() - t0,
        status: "ok",
      });
    } catch (err) {
      samples.push({
        index: i,
        latencyMs: Date.now() - t0,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const publishElapsed = Date.now() - publishStart;
  console.log(
    `        ${String(samples.filter((s) => s.status === "ok").length)}/${String(config.eventCount)} OK; ${String(publishElapsed)}ms total`,
  );

  // ---- Summary ----
  const okSamples = samples.filter((s) => s.status === "ok");
  const sortedLatencies = okSamples
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);
  const errCount = samples.length - okSamples.length;

  console.log("");
  console.log("======================================================");
  console.log("Publish-side latency (HTTP POST /items round-trip):");
  console.log(`  p50: ${percentile(sortedLatencies, 50).toFixed(1)}ms`);
  console.log(`  p95: ${percentile(sortedLatencies, 95).toFixed(1)}ms`);
  console.log(`  p99: ${percentile(sortedLatencies, 99).toFixed(1)}ms`);
  console.log(
    `  min: ${(sortedLatencies[0] ?? 0).toFixed(1)}ms / max: ${(sortedLatencies[sortedLatencies.length - 1] ?? 0).toFixed(1)}ms`,
  );
  console.log(`  errors: ${String(errCount)} of ${String(samples.length)}`);
  if (errCount > 0) {
    const firstErr = samples.find((s) => s.status === "error");
    console.log(`  first error: ${firstErr?.error ?? ""}`);
  }
  console.log("");
  console.log("NOTE: this measures publish-side latency only. The bridge's");
  console.log("fanout to all subscribers is async after the publish returns.");
  console.log("");
  console.log("Inspect server logs (adapt the path/host for your deploy):");
  console.log("  tail -200 /path/to/marfa/logs/stderr.log \\");
  console.log("    | grep -E '\\[reactive-run-bridge\\]'");
  console.log("");
  console.log("Look for:");
  console.log(
    "  - 'subscriber <id> fanout failed:' — per-subscriber producer errors",
  );
  console.log(
    "  - 'non-retryable <status> from queue' — 4xx from CF Queues producer",
  );
  console.log(
    "  - 'send attempt N:' followed by 'giving up after M attempts' — 5xx burst",
  );
  console.log(
    "  - 'loaded N subscription(s)' — confirms the bridge sees all installed connections",
  );
  console.log("");
  console.log("Cloudflare dashboard → Queues → marfa-reactive-run-staging:");
  console.log(
    `  - Messages received should be ~${String(config.eventCount * config.connectionCount)} after the burst`,
  );
  console.log(
    `    (one queue message per (event × subscriber) pair = ${String(config.eventCount)} * ${String(config.connectionCount)})`,
  );
  console.log("");
  console.log(
    `Total run time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  console.log("");
  console.log(
    "Cleanup: the script does not uninstall its connections — leave them",
  );
  console.log("for inspection, then `my connections uninstall <id>`");
  console.log(
    "or revoke the seed admin credentials manually if rotating staging.",
  );
}

main().catch((err: unknown) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
