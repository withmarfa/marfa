import { describe, it, expect } from "vitest";
import {
  chooseCredentials,
  parseEnvFile,
  readBootstrapSecret,
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
    const text = renderEnvFile(
      "http://127.0.0.1:8600",
      {
        apiKey: "marfa_k1_working",
        operatorKey: "marfa_k1_operator",
      },
      "/state/blobs",
    );
    expect(text).toBe(
      "MARFA_API_URL=http://127.0.0.1:8600\nMARFA_API_KEY=marfa_k1_working\nMARFA_OPERATOR_KEY=marfa_k1_operator\nMARFA_BLOB_PATH=/state/blobs\n",
    );
    expect(parseEnvFile(text)).toEqual({
      MARFA_API_URL: "http://127.0.0.1:8600",
      MARFA_API_KEY: "marfa_k1_working",
      MARFA_OPERATOR_KEY: "marfa_k1_operator",
      MARFA_BLOB_PATH: "/state/blobs",
    });
  });
});
