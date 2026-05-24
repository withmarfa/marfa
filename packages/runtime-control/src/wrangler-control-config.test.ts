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
] as const;

interface ServiceBinding {
  binding: string;
  service: string;
}

interface WranglerControlConfig {
  env?: {
    staging?: { services?: ServiceBinding[] };
    prod?: { services?: ServiceBinding[] };
  };
}

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
