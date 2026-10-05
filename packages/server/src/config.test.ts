import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONNECTOR_HOLD_MS,
  SETTING_NAMES,
  SettingsError,
  defaultTessdataDir,
  loadConfig,
} from "./config.js";

/** What a refusal says, or the empty string when the settings load. */
function refusal(env: Record<string, string>): string {
  try {
    loadConfig(env);
    return "";
  } catch (err) {
    expect(err).toBeInstanceOf(SettingsError);
    return (err as Error).message;
  }
}

const STRONG = () => randomBytes(32).toString("hex");

/** Settings whose value is free text, so a word is a value rather than a typo. */
const FREE_TEXT = [
  "SQLITE_PATH",
  "BLOB_PATH",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_PREFIX",
  "MARFA_ENRICHMENT_TESSDATA_DIR",
  "TRUSTED_PROXY_HEADER",
  "API_KEY_SALT",
  "MARFA_PLACEMENT_REGION",
  "MARFA_PLACEMENT_LOCATION",
  "MARFA_PLACEMENT_COUNTRY",
  "OTEL_SERVICE_NAME",
  // Its pair is checked only while telemetry is on.
  "MARFA_POSTHOG_PROJECT_TOKEN",
];

describe("the settings schema", () => {
  it("boots on an empty environment, every setting at its default", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8600);
    expect(config.isProduction).toBe(false);
    expect(config.versionRecentDays).toBe(30);
    expect(config.rateLimitEnabled).toBe(true);
    expect(config.enableHsts).toBe(false);
    expect(config.connectorHoldMs).toBe(DEFAULT_CONNECTOR_HOLD_MS);
    expect(config.authBaseUrl).toBe("http://localhost:8600");
    expect(config.authSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("treats a blank value as unset", () => {
    expect(loadConfig({ PORT: "", VERSION_RECENT_DAYS: " " }).port).toBe(8600);
  });

  // A typo here used to read as NaN, and the thinning job then deleted every
  // version of every item but the latest.
  it("refuses a version-history setting that is not a whole number", () => {
    for (const name of [
      "VERSION_RECENT_DAYS",
      "VERSION_DAILY_SNAPSHOT_DAYS",
      "VERSION_WEEKLY_SNAPSHOT_DAYS",
      "VERSION_MAX_VERSIONS",
      "VERSION_THINNING_INTERVAL_MS",
    ]) {
      for (const raw of ["30 days", "-5", "1.5", "1e2"]) {
        expect(refusal({ [name]: raw }), `${name}=${raw}`).toContain(
          `${name} must be a whole number`,
        );
      }
    }
    expect(loadConfig({ VERSION_RECENT_DAYS: "7" }).versionRecentDays).toBe(7);
  });

  it("refuses a word in every setting that is not free text, naming it", () => {
    const accepted = SETTING_NAMES.filter(
      (name) => refusal({ [name]: "banana" }) === "",
    );
    expect(accepted.sort()).toEqual([...FREE_TEXT].sort());
    for (const name of SETTING_NAMES.filter((n) => !FREE_TEXT.includes(n))) {
      expect(refusal({ [name]: "banana" }), name).toMatch(
        new RegExp(`^  ${name} `, "m"),
      );
    }
  });

  it("refuses a negative number in every numeric setting", () => {
    const numeric = SETTING_NAMES.filter(
      (name) => refusal({ [name]: "5" }) === "" && !FREE_TEXT.includes(name),
    );
    // The witness: these settings take a number at all.
    expect(numeric).toContain("RATE_LIMIT_REQUESTS");
    expect(numeric).toContain("SQLITE_BUSY_BUDGET_MS");
    for (const name of numeric) {
      expect(refusal({ [name]: "-5" }), name).toContain(name);
    }
  });

  // A daily window shorter than the recent one, or a weekly one shorter
  // than the daily, sends versions straight past their window to deletion.
  it("refuses version windows out of order", () => {
    expect(
      refusal({ VERSION_RECENT_DAYS: "30", VERSION_DAILY_SNAPSHOT_DAYS: "10" }),
    ).toContain(
      "VERSION_DAILY_SNAPSHOT_DAYS must be at least VERSION_RECENT_DAYS",
    );
    expect(refusal({ VERSION_WEEKLY_SNAPSHOT_DAYS: "0" })).toContain(
      "VERSION_WEEKLY_SNAPSHOT_DAYS must be at least VERSION_DAILY_SNAPSHOT_DAYS",
    );
    expect(
      refusal({
        VERSION_RECENT_DAYS: "7",
        VERSION_DAILY_SNAPSHOT_DAYS: "7",
        VERSION_WEEKLY_SNAPSHOT_DAYS: "7",
      }),
    ).toBe("");
  });

  it("warns about an unknown MARFA_ name close to a setting's, and refuses none", () => {
    const config = loadConfig({
      MARFA_AUTH_SECRT: "x",
      MARFA_BLOB_MINCOPIES: "2",
      MARFA_API_URL: "http://localhost:8600",
      MARFA_TEST_OCR: "1",
    });
    expect(config.settingWarnings).toEqual([
      "MARFA_AUTH_SECRT is not a setting and is ignored; did you mean MARFA_AUTH_SECRET?",
      "MARFA_BLOB_MINCOPIES is not a setting and is ignored; did you mean MARFA_BLOB_MIN_COPIES?",
    ]);
    expect(loadConfig({ MARFA_AUTH_SECRET: STRONG() }).settingWarnings).toBe(
      undefined,
    );
  });

  it("names every bad setting at once", () => {
    const message = refusal({
      PORT: "abc",
      RATE_LIMIT_REQUESTS: "NaN",
      MARFA_MAX_REQUEST_BYTES: "0",
    });
    expect(message).toContain(
      'PORT must be a whole number, from 1 to 65535 (got "abc")',
    );
    expect(message).toContain("RATE_LIMIT_REQUESTS");
    expect(message).toContain("MARFA_MAX_REQUEST_BYTES");
  });

  it("reads the usual boolean spellings and refuses others", () => {
    for (const raw of ["false", "0", "no", "off", "FALSE"]) {
      expect(
        loadConfig({ RATE_LIMIT_ENABLED: raw }).rateLimitEnabled,
        raw,
      ).toBe(false);
    }
    for (const raw of ["true", "1", "yes", "on", "True"]) {
      expect(loadConfig({ ENABLE_HSTS: raw }).enableHsts, raw).toBe(true);
    }
    expect(refusal({ ENABLE_HSTS: "enabled" })).toContain(
      "ENABLE_HSTS must be true or false",
    );
  });

  it("refuses an environment it does not know", () => {
    expect(refusal({ NODE_ENV: "staging" })).toContain(
      "NODE_ENV must be production, development or test",
    );
  });

  it("refuses an origin the exact comparison could never match", () => {
    expect(
      loadConfig({ CORS_ORIGINS: "https://app.example, http://localhost:5173" })
        .corsOrigins,
    ).toEqual(["https://app.example", "http://localhost:5173"]);
    expect(refusal({ CORS_ORIGINS: "https://app.example/" })).toContain(
      "CORS_ORIGINS",
    );
  });

  it("refuses a malformed permission bundle override, naming the entry", () => {
    const message = refusal({
      MARFA_PERMISSION_BUNDLES: JSON.stringify([
        { id: "read", scopes: ["core.note:read"] },
      ]),
    });
    expect(message).toContain("MARFA_PERMISSION_BUNDLES");
    expect(message).toContain("offending entries: read");
    expect(refusal({ MARFA_PERMISSION_BUNDLES: "{not json" })).toContain(
      "MARFA_PERMISSION_BUNDLES must be a JSON array",
    );
  });

  // A secret read from a file often ends in a newline. Trimmed, it would
  // be a different salt or key than the one that was set, and every key
  // hash, session and blob link would stop matching without a word.
  it("refuses a secret with surrounding whitespace, and reads one that is all whitespace as unset", () => {
    for (const name of [
      "API_KEY_SALT",
      "MARFA_AUTH_SECRET",
      "S3_SECRET_ACCESS_KEY",
      "MARFA_POSTHOG_PROJECT_TOKEN",
    ]) {
      for (const raw of [`${STRONG()}\n`, ` ${STRONG()}`]) {
        expect(refusal({ [name]: raw }), name).toContain(
          `${name} has whitespace around it`,
        );
      }
    }
    const secret = STRONG();
    expect(loadConfig({ MARFA_AUTH_SECRET: secret }).authSecret).toBe(secret);
    expect(loadConfig({ API_KEY_SALT: " \n" }).apiKeySalt).toBe(
      loadConfig({}).apiKeySalt,
    );
  });

  it("never echoes a secret's value into a refusal", () => {
    const message = refusal({ MARFA_AUTH_SECRET: "short-secret" });
    expect(message).toContain("MARFA_AUTH_SECRET must be at least 32");
    expect(message).not.toContain("short-secret");
  });

  it("refuses a bulk poll ceiling under its floor", () => {
    expect(
      refusal({
        MARFA_BULK_ACTION_POLL_INTERVAL_MS: "1000",
        MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS: "500",
      }),
    ).toContain("MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS");
  });

  it("takes the connector hold window from a second to an hour", () => {
    expect(
      loadConfig({ MARFA_CONNECTOR_HOLD_MS: " 60000 " }).connectorHoldMs,
    ).toBe(60_000);
    for (const raw of ["999", "3600001", "1.5e3", "2s"]) {
      expect(refusal({ MARFA_CONNECTOR_HOLD_MS: raw }), raw).toContain(
        "MARFA_CONNECTOR_HOLD_MS must be a whole number, from 1000 to 3600000",
      );
    }
  });

  it("refuses a minimum copy count that would let the last copy go", () => {
    expect(loadConfig({ MARFA_BLOB_MIN_COPIES: "2" }).blobMinCopies).toBe(2);
    expect(refusal({ MARFA_BLOB_MIN_COPIES: "0" })).toContain(
      "MARFA_BLOB_MIN_COPIES",
    );
  });

  it("caches the OCR model beside the database unless told otherwise", () => {
    expect(
      loadConfig({ SQLITE_PATH: "/data/marfa.db" }).enrichmentTessdataDir,
    ).toBe("/data/tessdata");
    expect(loadConfig({}).enrichmentTessdataDir).toBe("data/tessdata");
    expect(
      loadConfig({
        SQLITE_PATH: "/data/marfa.db",
        MARFA_ENRICHMENT_TESSDATA_DIR: "/models",
      }).enrichmentTessdataDir,
    ).toBe("/models");
    expect(defaultTessdataDir(":memory:")).toBe("./data/tessdata");
    expect(defaultTessdataDir("file:marfa.db?mode=ro")).toBe("./data/tessdata");
  });
});

describe("production boot", () => {
  const production = (extra: Record<string, string> = {}) => ({
    NODE_ENV: "production",
    API_KEY_SALT: STRONG(),
    MARFA_AUTH_SECRET: STRONG(),
    MARFA_AUTH_BASE_URL: "https://marfa.example",
    ...extra,
  });

  it("boots with generated secrets and the public address", () => {
    const config = loadConfig(production());
    expect(config.isProduction).toBe(true);
    expect(config.authBaseUrl).toBe("https://marfa.example");
  });

  it("refuses the example's placeholder secrets", () => {
    const placeholder = "change-me-run-openssl-rand-hex-32";
    for (const name of ["API_KEY_SALT", "MARFA_AUTH_SECRET"]) {
      expect(refusal(production({ [name]: placeholder })), name).toContain(
        `${name} is a placeholder anyone can read`,
      );
    }
    // The built-in development salt is one too.
    expect(refusal(production({ API_KEY_SALT: "" }))).toContain(
      "API_KEY_SALT must be set in production",
    );
  });

  it("refuses the placeholder however it is spelled", () => {
    for (const placeholder of [
      "change_me_run_openssl_rand_hex_32",
      "change.me.run.openssl.rand.hex.32",
      "CHANGE ME RUN OPENSSL RAND HEX 32 !",
      "dev_salt_change_in_production_abcdefg",
      `${STRONG()}OpenSSL-Rand`,
    ]) {
      expect(
        refusal(production({ API_KEY_SALT: placeholder })),
        placeholder,
      ).toContain("API_KEY_SALT is a placeholder anyone can read");
    }
  });

  it("refuses a secret with too little entropy", () => {
    for (const weak of [
      "a".repeat(64),
      "ab".repeat(32),
      "0123456789".repeat(4),
    ]) {
      expect(refusal(production({ MARFA_AUTH_SECRET: weak }))).toContain(
        "MARFA_AUTH_SECRET is too predictable",
      );
    }
  });

  it("refuses a missing secret or public address", () => {
    expect(refusal(production({ MARFA_AUTH_SECRET: "" }))).toContain(
      "MARFA_AUTH_SECRET must be set in production",
    );
    expect(refusal(production({ MARFA_AUTH_BASE_URL: "" }))).toContain(
      "MARFA_AUTH_BASE_URL must be set in production",
    );
    expect(
      refusal(production({ MARFA_AUTH_BASE_URL: "marfa.example" })),
    ).toContain("MARFA_AUTH_BASE_URL must be an absolute http or https URL");
  });

  it("lets development boot with none of them", () => {
    expect(refusal({ NODE_ENV: "development" })).toBe("");
  });
});

describe("OpenTelemetry settings", () => {
  const exporting = (extra: Record<string, string>) =>
    loadConfig({
      MARFA_OTEL_ENABLED: "true",
      ...extra,
    }).otel;

  it("posts each signal to its own path under the general endpoint", () => {
    for (const base of ["http://collector:4318", "http://collector:4318/"]) {
      const otel = exporting({ OTEL_EXPORTER_OTLP_ENDPOINT: base });
      expect(otel?.tracesEndpoint).toBe("http://collector:4318/v1/traces");
      expect(otel?.logsEndpoint).toBe("http://collector:4318/v1/logs");
    }
  });

  it("uses a signal's own endpoint as written", () => {
    const otel = exporting({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example/i/v1/logs",
    });
    expect(otel?.logsEndpoint).toBe("https://logs.example/i/v1/logs");
    expect(otel?.tracesEndpoint).toBe("http://collector:4318/v1/traces");
  });

  it("gives each signal its own headers over the general ones", () => {
    const otel = exporting({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "X-Shared=1,Authorization=general",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=traces",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer%20logs",
    });
    expect(otel?.tracesHeaders).toEqual({
      "X-Shared": "1",
      Authorization: "traces",
    });
    expect(otel?.logsHeaders).toEqual({
      "X-Shared": "1",
      Authorization: "Bearer logs",
    });
  });

  it("checks the PostHog pair only while telemetry is on", () => {
    expect(refusal({ MARFA_POSTHOG_HOST: "https://eu.i.posthog.com" })).toBe(
      "",
    );
    expect(
      refusal({
        MARFA_OTEL_ENABLED: "true",
        MARFA_POSTHOG_HOST: "https://eu.i.posthog.com",
      }),
    ).toContain("MARFA_POSTHOG_HOST needs MARFA_POSTHOG_PROJECT_TOKEN set too");
  });

  it("loads an exporting endpoint with no environment name, and has no setting for one", () => {
    const otel = exporting({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    expect(otel?.tracesEndpoint).toBe("http://collector:4318/v1/traces");
    expect(otel).not.toHaveProperty("environment");
    expect(SETTING_NAMES).not.toContain("MARFA_OTEL_ENVIRONMENT");
    // A leftover value is not read: it names nothing the server holds.
    const left = loadConfig({
      MARFA_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      MARFA_OTEL_ENVIRONMENT: "staging",
    }).otel;
    expect(left).not.toHaveProperty("environment");
  });

  it("refuses malformed headers and an out-of-range ratio", () => {
    expect(refusal({ OTEL_EXPORTER_OTLP_HEADERS: "novalue" })).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS must be comma-separated key=value pairs",
    );
    expect(refusal({ MARFA_OTEL_SAMPLE_RATIO: "5" })).toContain(
      "MARFA_OTEL_SAMPLE_RATIO must be a number from 0 to 1",
    );
  });
});

describe("version.json", () => {
  function inDirectoryHolding(text: string, run: () => void): void {
    const dir = mkdtempSync(join(tmpdir(), "marfa-version-"));
    const previous = process.cwd();
    writeFileSync(join(dir, "version.json"), text);
    process.chdir(dir);
    try {
      run();
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("is read with the settings", () => {
    inDirectoryHolding('{"sha":"abc123","deployed_at":"2026-01-01"}', () => {
      const config = loadConfig({});
      expect(config.versionSha).toBe("abc123");
      expect(config.versionFile?.deployed_at).toBe("2026-01-01");
    });
  });

  it("stops boot naming the file when it is not a JSON object", () => {
    for (const text of ["{not json", "[1]"]) {
      inDirectoryHolding(text, () => {
        expect(refusal({}), text).toMatch(/^ {2}version\.json /m);
      });
    }
  });
});

describe("inbound retained capacity settings", () => {
  it("uses bounded retained defaults and a minute cleanup cadence", () => {
    expect(loadConfig({}).inbound).toMatchObject({
      retainedDeliveries: 10000,
      retainedBytes: 1073741824,
      cleanupIntervalMs: 60000,
    });
  });
  it("loads explicit safe capacities, while zero retention leaves them enforced", () => {
    expect(
      loadConfig({
        MARFA_INBOUND_RETAINED_DELIVERIES: "2",
        MARFA_INBOUND_RETAINED_BYTES: "4096",
        MARFA_INBOUND_CLEANUP_INTERVAL_MS: "1000",
        MARFA_INBOUND_HANDLED_RETENTION_DAYS: "0",
        MARFA_INBOUND_PENDING_RETENTION_DAYS: "0",
      }).inbound,
    ).toMatchObject({
      retainedDeliveries: 2,
      retainedBytes: 4096,
      cleanupIntervalMs: 1000,
      handledRetentionDays: 0,
      pendingRetentionDays: 0,
    });
    for (const name of [
      "MARFA_INBOUND_RETAINED_DELIVERIES",
      "MARFA_INBOUND_RETAINED_BYTES",
      "MARFA_INBOUND_CLEANUP_INTERVAL_MS",
    ]) {
      for (const value of ["0", "-1", "1.5", "9007199254740992"])
        expect(refusal({ [name]: value })).toContain(name);
    }
  });
});

it("bounds inbound date horizons and the native timer interval", () => {
  const maximum = loadConfig({
    MARFA_INBOUND_HANDLED_RETENTION_DAYS: "36500",
    MARFA_INBOUND_PENDING_RETENTION_DAYS: "36500",
    MARFA_INBOUND_CLEANUP_INTERVAL_MS: "2147483647",
  });
  expect(maximum.inbound).toMatchObject({
    handledRetentionDays: 36500,
    pendingRetentionDays: 36500,
    cleanupIntervalMs: 2147483647,
  });
  for (const name of [
    "MARFA_INBOUND_HANDLED_RETENTION_DAYS",
    "MARFA_INBOUND_PENDING_RETENTION_DAYS",
  ])
    expect(refusal({ [name]: "36501" })).toContain(name);
  expect(
    refusal({ MARFA_INBOUND_CLEANUP_INTERVAL_MS: "2147483648" }),
  ).toContain("MARFA_INBOUND_CLEANUP_INTERVAL_MS");
});

it.each([
  ["AUDIT_RETENTION_DAYS", 36500, "auditRetentionDays"],
  ["MARFA_REVOKED_GRANT_RETENTION_DAYS", 36500, "revokedGrantRetentionDays"],
  ["MARFA_GRANT_INACTIVITY_DAYS", 36500, "grantInactivityDays"],
  ["MARFA_EVENT_LOG_RETENTION_HOURS", 876000, "eventLogRetentionHours"],
  ["TRASH_RETENTION_DAYS", 36500, "trashRetentionDays"],
  ["MARFA_DCR_CLIENT_RETENTION_DAYS", 36500, "dcrClientRetentionDays"],
  [
    "MARFA_BULK_ACTION_JOB_RETENTION_MS",
    3153600000000,
    "bulkActionJobRetentionMs",
  ],
])("bounds %s while preserving disabled expiry", (name, maximum, field) => {
  expect(loadConfig({ [name]: String(maximum) })).toHaveProperty(
    field,
    maximum,
  );
  expect(refusal({ [name]: String(maximum + 1) })).toContain(name);
  expect(loadConfig({ [name]: "0" })).toHaveProperty(field, 0);
});
