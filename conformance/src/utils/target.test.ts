import { afterEach, describe, it, expect, vi } from "vitest";
import {
  maskInActions,
  parseEnvFile,
  redactSetupProof,
  renderEnvFile,
} from "./target.js";

const credentials = {
  apiKey: "marfa_k1_working",
  managementKey: "marfa_k1_management",
  controlSocket: "/tmp/marfa-control-fixture/control.sock",
  ownerCookie: "marfa.auth.session_token=fixture",
};

describe("redactSetupProof", () => {
  it("removes the setup proof and preserves surrounding diagnostic text", () => {
    const code = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEEE";
    const log = `starting\nMarfa setup code: ${code}\nlistening`;
    expect(redactSetupProof(log)).toBe(
      "starting\nMarfa setup code: [redacted]\nlistening",
    );
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    maskInActions("marfa_k1_one");
    expect(log).toHaveBeenCalledTimes(1);
    log.mockClear();
    vi.stubEnv("GITHUB_ACTIONS", "");
    maskInActions("marfa_k1_one");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("env file", () => {
  it("round-trips through the shell-sourceable format", () => {
    const text = renderEnvFile("http://127.0.0.1:8600", credentials);
    expect(text).toBe(
      "MARFA_API_URL=http://127.0.0.1:8600\nMARFA_API_KEY=marfa_k1_working\nMARFA_MANAGEMENT_KEY=marfa_k1_management\nMARFA_CONTROL_SOCKET=/tmp/marfa-control-fixture/control.sock\nMARFA_OWNER_COOKIE=marfa.auth.session_token=fixture\n",
    );
    expect(parseEnvFile(text)).toEqual({
      MARFA_API_URL: "http://127.0.0.1:8600",
      MARFA_API_KEY: "marfa_k1_working",
      MARFA_MANAGEMENT_KEY: "marfa_k1_management",
      MARFA_CONTROL_SOCKET: credentials.controlSocket,
      MARFA_OWNER_COOKIE: credentials.ownerCookie,
    });
  });

  it("names the protected shared session without exporting the server secret setting", () => {
    const env = parseEnvFile(
      renderEnvFile("http://127.0.0.1:8600", {
        ...credentials,
        ownerSessionFile: "/state/owner-session.json",
        authSecret: "fixture-secret",
      }),
    );
    expect(env.MARFA_OWNER_SESSION_FILE).toBe("/state/owner-session.json");
    expect(env.MARFA_FIXTURE_AUTH_SECRET).toBe("fixture-secret");
    expect(env.MARFA_AUTH_SECRET).toBeUndefined();
  });

  it("names the booted server's disk store when given one", () => {
    const text = renderEnvFile(
      "http://127.0.0.1:8600",
      credentials,
      "/state/blobs",
    );
    expect(parseEnvFile(text).MARFA_BLOB_PATH).toBe("/state/blobs");
  });

  it("names where a fixture's own server leaves its log when given one", () => {
    const text = renderEnvFile(
      "http://127.0.0.1:8600",
      credentials,
      "/state/blobs",
      "/state/fresh-server-logs",
    );
    expect(parseEnvFile(text).MARFA_STATUS_LOGS).toBe(
      "/state/fresh-server-logs",
    );
  });
});
