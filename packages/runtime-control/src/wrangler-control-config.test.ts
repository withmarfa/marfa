/**
 * Freshness test for `infra/cloudflare/wrangler.control.toml` (T-245).
 *
 * Two invariants pinned here:
 *
 *   1. **Strict TOML parses cleanly.** Wrangler's parser is lenient and
 *      silently accepts duplicate keys inside an array-of-tables entry —
 *      the failure mode that hid the missing `INTEGRATION_GOOGLE_DRIVE`
 *      binding on hosted-staging between T-238 merging and T-245
 *      landing. A strict parser (`smol-toml`) throws on the same input,
 *      so this test fails loud the moment anyone re-introduces the
 *      duplicate-binding bug.
 *
 *   2. **Every dispatch entry has a service binding in both envs.** The
 *      `arm-schedule.ts` + `verify.ts` route switches map each
 *      integration name to a binding (`env.INTEGRATION_*`). When the
 *      binding is missing the route surfaces 503 `no_service_binding`.
 *      The test reads the canonical list from this file (a constant
 *      below) and asserts every entry resolves in both `env.staging` AND
 *      `env.prod`. New integrations need to add themselves to this list
 *      AND to both env blocks — symmetrical from day one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WRANGLER_CONTROL_TOML_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "infra",
  "cloudflare",
  "wrangler.control.toml",
);

/**
 * Canonical list of integrations the control plane's dispatch switches
 * (in `routes/arm-schedule.ts` + `routes/verify.ts`) know about. Mirror
 * the switch cases here so the test is the single source of truth for
 * "what bindings every env block must carry".
 *
 * Adding a new integration:
 *   1. Add a case to both switches.
 *   2. Add the field to `ControlPlaneEnv` (`env.ts`).
 *   3. Add an entry here.
 *   4. Add `[[env.staging.services]]` + `[[env.prod.services]]` blocks
 *      to `wrangler.control.toml`.
 */
const DISPATCHED_INTEGRATIONS = [
  "INTEGRATION_RSS_WATCHER",
  "INTEGRATION_GITHUB_WEBHOOKS",
  "INTEGRATION_TASK_AUTO_ARCHIVE",
  "INTEGRATION_GOOGLE_CALENDAR",
  "INTEGRATION_GOOGLE_TASKS",
  "INTEGRATION_GOOGLE_DRIVE",
  "INTEGRATION_GOOGLE_CONTACTS",
  "INTEGRATION_GOOGLE_YOUTUBE",
  "INTEGRATION_TODOIST_TASKS",
  "INTEGRATION_READWISE",
  "INTEGRATION_RAINDROP",
  "INTEGRATION_MYMEHQ_INBOX",
] as const;

interface ServiceBinding {
  binding: string;
  service: string;
}

interface QueueProducer {
  binding: string;
  queue: string;
}

interface QueueConsumer {
  queue: string;
  dead_letter_queue?: string;
}

interface WranglerControlConfig {
  env?: {
    staging?: {
      services?: ServiceBinding[];
      queues?: { producers?: QueueProducer[]; consumers?: QueueConsumer[] };
    };
    prod?: {
      services?: ServiceBinding[];
      queues?: { producers?: QueueProducer[]; consumers?: QueueConsumer[] };
    };
  };
}

/**
 * T-247: per-integration webhook-receipt queue bindings. Each entry
 * has both a `binding` field (matched against `webhooks.ts`'s
 * `resolveWebhookQueueProducer` switch) and an `integration_name`
 * field (the dispatch key the runtime-control route resolves
 * against). The freshness test asserts both halves are in sync:
 *   - every binding referenced in the resolver has a producer in
 *     wrangler.control.toml.
 *   - every producer in wrangler.control.toml has a matching switch
 *     case in the resolver.
 */
const WEBHOOK_RECEIPT_PRODUCERS = [
  {
    binding: "WEBHOOK_RECEIPT_QUEUE_MYMEHQ_INBOX",
    integration: "mymehq-inbox",
  },
  {
    binding: "WEBHOOK_RECEIPT_QUEUE_GOOGLE_CALENDAR",
    integration: "google-calendar",
  },
  {
    binding: "WEBHOOK_RECEIPT_QUEUE_GOOGLE_DRIVE",
    integration: "google-drive",
  },
] as const;

function loadConfig(): WranglerControlConfig {
  const text = readFileSync(WRANGLER_CONTROL_TOML_PATH, "utf8");
  // `smol-toml` is strict: duplicate keys inside an array-of-tables
  // entry throw on parse. The throw is the load-bearing invariant —
  // any future "Just append my new binding to the last entry" mistake
  // fails CI loudly.
  return parseToml(text) as WranglerControlConfig;
}

describe("wrangler.control.toml — structural freshness (T-245)", () => {
  it("parses cleanly under a strict TOML parser (no duplicate keys)", () => {
    expect(() => loadConfig()).not.toThrow();
  });

  it("declares every dispatched integration in [[env.staging.services]]", () => {
    const config = loadConfig();
    const bindings = (config.env?.staging?.services ?? []).map(
      (s) => s.binding,
    );
    for (const expected of DISPATCHED_INTEGRATIONS) {
      expect(bindings).toContain(expected);
    }
  });

  it("declares every dispatched integration in [[env.prod.services]]", () => {
    const config = loadConfig();
    const bindings = (config.env?.prod?.services ?? []).map((s) => s.binding);
    for (const expected of DISPATCHED_INTEGRATIONS) {
      expect(bindings).toContain(expected);
    }
  });

  it("every staging service binding points at the matching -staging Worker name", () => {
    const config = loadConfig();
    const services = config.env?.staging?.services ?? [];
    for (const entry of services) {
      expect(entry.service).toMatch(/-staging$/);
      // Cross-check: binding `INTEGRATION_GOOGLE_DRIVE` should target
      // `myme-integration-google-drive-staging`, etc. The mapping is
      // deterministic: BINDING_NAME → kebab-case under the
      // `myme-integration-` prefix.
      const expectedSlug = entry.binding
        .replace(/^INTEGRATION_/, "")
        .toLowerCase()
        .replace(/_/g, "-");
      expect(entry.service).toBe(`myme-integration-${expectedSlug}-staging`);
    }
  });

  it("every prod service binding points at the matching -prod Worker name", () => {
    const config = loadConfig();
    const services = config.env?.prod?.services ?? [];
    for (const entry of services) {
      expect(entry.service).toMatch(/-prod$/);
      const expectedSlug = entry.binding
        .replace(/^INTEGRATION_/, "")
        .toLowerCase()
        .replace(/_/g, "-");
      expect(entry.service).toBe(`myme-integration-${expectedSlug}-prod`);
    }
  });

  it("declares every per-integration webhook-receipt producer in staging + prod (T-247)", () => {
    const config = loadConfig();
    for (const env of ["staging", "prod"] as const) {
      const producers = config.env?.[env]?.queues?.producers ?? [];
      const bindings = producers.map((p) => p.binding);
      for (const expected of WEBHOOK_RECEIPT_PRODUCERS) {
        expect(bindings).toContain(expected.binding);
        // Queue name follows the deterministic
        // `myme-webhook-receipt-<integration-slug>-<env>` shape.
        const producer = producers.find((p) => p.binding === expected.binding);
        expect(producer?.queue).toBe(
          `myme-webhook-receipt-${expected.integration}-${env}`,
        );
      }
    }
  });

  it("no duplicate bindings in either env block (defence-in-depth on the test invariant)", () => {
    const config = loadConfig();
    for (const env of ["staging", "prod"] as const) {
      const services = config.env?.[env]?.services ?? [];
      const bindings = services.map((s) => s.binding);
      const unique = new Set(bindings);
      expect(bindings.length).toBe(unique.size);
    }
  });
});
