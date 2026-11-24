import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepStatusLog } from "./fresh-server.js";
import { tempFolder } from "./temp-folder.js";

const CODE = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
const LOG = [
  `Claim this Marfa at /setup with setup code: ${CODE}. Or open this link, which works once, for 5 minutes: http://127.0.0.1:1/setup#handoff=0f9a`,
  `Recover this Marfa's owner at /setup with recovery code: ${CODE}. It works once, for 60 minutes.`,
  "Marfa server listening on port 1",
].join("\n");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("keepStatusLog", () => {
  it("keeps the log for the run without the setup proof or its link", () => {
    const state = tempFolder("marfa-status-log-state-");
    const kept = tempFolder("marfa-status-log-kept-");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "server.log"), LOG);
    vi.stubEnv("MARFA_STATUS_LOGS", kept);
    keepStatusLog(state);
    const copy = readFileSync(
      join(kept, `${state.split("/").at(-1)!}.log`),
      "utf8",
    );
    // The witness: the log held the proof, and only the proof is gone.
    expect(LOG).toContain(CODE);
    expect(LOG).toContain("0f9a");
    expect(copy).not.toContain(CODE);
    expect(copy).not.toContain("0f9a");
    expect(copy).toContain("setup code: [redacted]");
    expect(copy).toContain("recovery code: [redacted]");
    expect(copy).toContain("handoff=[redacted]");
    expect(copy).toContain("Marfa server listening on port 1");
  });
});
