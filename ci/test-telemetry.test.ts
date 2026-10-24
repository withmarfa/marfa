import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { silenceTelemetry } from "../vitest.shared.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("a test run sends no telemetry", () => {
  it("clears the telemetry settings a shell names and turns the SDK off", () => {
    const shell: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer planted",
      OTEL_SERVICE_NAME: "shell",
      OTEL_SDK_DISABLED: "false",
      MARFA_POSTHOG_HOST: "https://posthog.example",
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_planted",
    };
    silenceTelemetry(shell);
    expect(shell).toEqual({ PATH: "/usr/bin", OTEL_SDK_DISABLED: "true" });
  });

  it("holds in this very run, which Vitest started from the root config", () => {
    expect(process.env.OTEL_SDK_DISABLED).toBe("true");
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(process.env.MARFA_POSTHOG_HOST).toBeUndefined();
  });

  it("is called by every Vitest config in the tree", () => {
    const configs = [
      "vitest.config.ts",
      "conformance/vitest.config.ts",
      ...readdirSync(join(ROOT, "packages")).map(
        (name) => `packages/${name}/vitest.config.ts`,
      ),
    ];
    expect(configs.length).toBeGreaterThan(5);
    for (const config of configs) {
      expect(
        readFileSync(join(ROOT, config), "utf8"),
        `${config} must call silenceTelemetry()`,
      ).toMatch(/^silenceTelemetry\(\);$/m);
    }
  });

  it("is called by the script that boots a server for the conformance run", () => {
    expect(
      readFileSync(join(ROOT, "conformance/scripts/marfa-server.ts"), "utf8"),
    ).toContain("silenceTelemetry(env);");
  });
});
