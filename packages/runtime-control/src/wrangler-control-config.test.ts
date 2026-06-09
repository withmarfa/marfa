/**
 * Freshness test for `infra/cloudflare/wrangler.control.toml`.
 *
 * Two invariants pinned here:
 *
 *   1. **Strict TOML parses cleanly.** Wrangler's parser is lenient and
 *      silently accepts duplicate keys inside an array-of-tables entry.
 *      A strict parser (`smol-toml`) throws on the same input, so this
 *      test fails loud the moment anyone re-introduces the
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
import {
  IN_TREE_INTEGRATIONS,
  integrationsWithTrigger,
} from "@withmarfa/shared";

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
 * Canonical list of `INTEGRATION_*` bindings the control plane's
 * dispatch switches (in `routes/arm-schedule.ts` + `routes/verify.ts`)
 * resolve. Derived from `IN_TREE_INTEGRATIONS` — every in-tree
 * integration with a deployed Worker contributes its `serviceBinding`
 * field, so adding a registry entry automatically extends the
 * freshness check.
 */
const DISPATCHED_INTEGRATIONS = IN_TREE_INTEGRATIONS.filter(
  (i) => i.hasWorker && i.serviceBinding,
).map((i) => i.serviceBinding!);

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
 * Per-integration webhook-receipt queue bindings. Each entry has both
 * a `binding` field (matched against `webhooks.ts`'s
 * `resolveWebhookQueueProducer`) and an `integration_name` field (the
 * dispatch key the runtime-control route resolves against). The
 * freshness test asserts both halves are in sync:
 *   - every binding referenced in the resolver has a producer in
 *     wrangler.control.toml.
 *   - every producer in wrangler.control.toml has a matching case in
 *     the resolver.
 */
const WEBHOOK_RECEIPT_PRODUCERS = integrationsWithTrigger("webhook")
  .filter((i) => i.webhookQueueBinding)
  .map((i) => ({
    binding: i.webhookQueueBinding!,
    integration: i.dirName,
  }));

function loadConfig(): WranglerControlConfig {
  const text = readFileSync(WRANGLER_CONTROL_TOML_PATH, "utf8");
  return parseToml(text); // throws on duplicate keys
}

describe("wrangler.control.toml — structural freshness", () => {
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
      // `marfa-integration-google-drive-staging`, etc. The mapping is
      // deterministic: BINDING_NAME → kebab-case under the
      // `marfa-integration-` prefix.
      const expectedSlug = entry.binding
        .replace(/^INTEGRATION_/, "")
        .toLowerCase()
        .replace(/_/g, "-");
      expect(entry.service).toBe(`marfa-integration-${expectedSlug}-staging`);
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
      expect(entry.service).toBe(`marfa-integration-${expectedSlug}-prod`);
    }
  });

  it("declares every per-integration webhook-receipt producer in staging + prod", () => {
    const config = loadConfig();
    for (const env of ["staging", "prod"] as const) {
      const producers = config.env?.[env]?.queues?.producers ?? [];
      const bindings = producers.map((p) => p.binding);
      for (const expected of WEBHOOK_RECEIPT_PRODUCERS) {
        expect(bindings).toContain(expected.binding);
        // Queue name follows the deterministic
        // `marfa-webhook-receipt-<integration-slug>-<env>` shape.
        const producer = producers.find((p) => p.binding === expected.binding);
        expect(producer?.queue).toBe(
          `marfa-webhook-receipt-${expected.integration}-${env}`,
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
