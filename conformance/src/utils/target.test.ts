import { afterEach, describe, it, expect, vi } from "vitest";
import {
  chooseCredentials,
  maskInActions,
  parseEnvFile,
  readBootstrapSecret,
  redactBootstrapSecret,
  renderEnvFile,
} from "./target.js";

const SECRET = "a".repeat(64);
const BOOT_LINE = JSON.stringify({
  level: "warn",
  message: `This instance holds no credential yet. Mint the first one with: curl -X POST <url>/keys -H "Authorization: Bearer ${SECRET}" -H 'Content-Type: application/json' -d '{"label":"operator","source":"operator"}'. This secret works once and is not shown again after that mint.`,
});

describe("readBootstrapSecret", () => {
  it("reads the secret out of the JSON log line the server prints", () => {
    const log = `{"level":"info","message":"starting"}\n${BOOT_LINE}\n`;
    expect(readBootstrapSecret(log)).toBe(SECRET);
  });

  it("answers undefined for a log with no bootstrap line", () => {
    expect(
      readBootstrapSecret('{"level":"info","message":"listening"}\n'),
    ).toBeUndefined();
  });

  it("does not mistake a shorter hex run for the secret", () => {
    expect(
      readBootstrapSecret(`Authorization: Bearer ${"b".repeat(40)}`),
    ).toBeUndefined();
  });
});

describe("redactBootstrapSecret", () => {
  it("leaves no secret in a log that held one", () => {
    const log = `{"level":"info","message":"starting"}\n${BOOT_LINE}\n`;
    expect(readBootstrapSecret(log)).toBe(SECRET);
    const redacted = redactBootstrapSecret(log);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("Bearer [redacted]");
    expect(readBootstrapSecret(redacted)).toBeUndefined();
  });
});

describe("maskInActions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers each value as a secret inside GitHub Actions", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    maskInActions("marfa_k1_one", "", "s3-secret", "marfa_k1_one");
    expect(log.mock.calls).toEqual([
      ["::add-mask::marfa_k1_one"],
      ["::add-mask::s3-secret"],
    ]);
  });

  it("prints nothing outside GitHub Actions", () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    maskInActions("marfa_k1_one");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("chooseCredentials", () => {
  it("runs as the one key the mint returns", () => {
    const creds = chooseCredentials({ key: "marfa_k1_only" });
    expect(creds).toEqual({
      apiKey: "marfa_k1_only",
      operatorKey: "marfa_k1_only",
    });
  });

  it("refuses a response with no key at all", () => {
    expect(() => chooseCredentials({ key: "" })).toThrow(/no usable key/);
  });
});

describe("env file", () => {
  it("round-trips through the shell-sourceable format", () => {
    const text = renderEnvFile("http://127.0.0.1:8600", {
      apiKey: "marfa_k1_working",
      operatorKey: "marfa_k1_operator",
    });
    expect(text).toBe(
      "MARFA_API_URL=http://127.0.0.1:8600\nMARFA_API_KEY=marfa_k1_working\nMARFA_OPERATOR_KEY=marfa_k1_operator\n",
    );
    expect(parseEnvFile(text)).toEqual({
      MARFA_API_URL: "http://127.0.0.1:8600",
      MARFA_API_KEY: "marfa_k1_working",
      MARFA_OPERATOR_KEY: "marfa_k1_operator",
    });
  });

  it("names the booted server's disk store when given one", () => {
    const text = renderEnvFile(
      "http://127.0.0.1:8600",
      { apiKey: "marfa_k1_working", operatorKey: "marfa_k1_operator" },
      "/state/blobs",
    );
    expect(parseEnvFile(text).MARFA_BLOB_PATH).toBe("/state/blobs");
  });

  it("names where a fixture's own server leaves its log when given one", () => {
    const text = renderEnvFile(
      "http://127.0.0.1:8600",
      { apiKey: "marfa_k1_working", operatorKey: "marfa_k1_operator" },
      "/state/blobs",
      "/state/fresh-server-logs",
    );
    expect(parseEnvFile(text).MARFA_STATUS_LOGS).toBe(
      "/state/fresh-server-logs",
    );
  });
});
